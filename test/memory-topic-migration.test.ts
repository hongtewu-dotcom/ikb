import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../src/knowledge.ts";
import {
  inspectMemoryTopicMigration,
  migrateMemoryTopicBatch,
  parseMemoryTopicIndex,
  reviseMemoryTopicBatch,
} from "../src/memory-topic-migration.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";

test("Memory Topic parser merges every active Topic Index section and ignores other tables", () => {
  const rows = parseMemoryTopicIndex([
    "## Topic Index",
    "| 文件 | 关键词 | 摘要 |",
    "| --- | --- | --- |",
    "| alpha.md | alpha/key | Alpha topic |",
    "## Archive Index",
    "| archive/old.md | old | archived |",
    "### Topic Index",
    "| beta.md | beta/key | Beta topic |",
  ].join("\n"));
  assert.deepEqual(rows.map((row) => row.file), ["alpha.md", "beta.md"]);
});

test("Memory Topic migration creates bounded review-only QV5 cards without entering default Context Pack", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-memory-topic-"));
  const home = join(root, "ikb-data");
  const memory = join(root, "memory");
  mkdirSync(memory, { recursive: true });
  const topics = [
    { file: "alpha.md", keywords: "alpha/route-key", summary: "Alpha access guide", content: "# Alpha\n\nUse the alpha endpoint with route-key.\n" },
    { file: "beta.md", keywords: "beta/cache-key", summary: "Beta cache guide", content: "# Beta\n\nUse the beta cache with cache-key.\n" },
    { file: "gamma.md", keywords: "gamma/trace-key", summary: "Gamma trace guide", content: "# Gamma\n\nUse trace-key to find the request.\n" },
    { file: "delta.md", keywords: "delta/retry-key", summary: "Delta retry guide", content: "# Delta\n\nUse retry-key only after checking the boundary.\n\nLiteral prose: \\n\n\n```text\nline-one\\r\\nline-two\n```\n" },
  ];
  const indexPath = join(memory, "MEMORY.md");
  writeFileSync(indexPath, [
    "# Memory",
    "",
    "## Topic Index",
    "| 文件 | 关键词 | 摘要 |",
    "| --- | --- | --- |",
    ...topics.slice(0, 3).map((topic) => `| ${topic.file} | ${topic.keywords} | ${topic.summary} |`),
    "",
    "## Other",
    "",
    "### Topic Index",
    `| ${topics[3].file} | ${topics[3].keywords} | ${topics[3].summary} |`,
    "",
  ].join("\n"));
  for (const topic of topics) writeFileSync(join(memory, topic.file), topic.content);
  for (const path of [indexPath, ...topics.map((topic) => join(memory, topic.file))]) {
    importSource(home, path, { kind: "manual", adapter: "catpaw-memory-local", scope: "work" });
  }

  const store = new LedgerStore({ home });
  try {
    const task = store.createTask({
      title: "Migrate Memory Topics",
      goal: "Make indexed Memory topics retrievable in IKB",
      acceptance: "Every selected topic has a QV5 draft Knowledge card",
      scope: "work",
    });
    const run = store.createRun(task.id, "ikb-curator", ["ikb-knowledge-curator"]);
    assert.throws(() => migrateMemoryTopicBatch(home, store, { indexPath, runId: run.id, limit: 4 }), /limit must be from 1 to 3/);

    const result = migrateMemoryTopicBatch(home, store, { indexPath, runId: run.id, offset: 0, limit: 3 });
    assert.equal(result.disposition, "changed");
    assert.equal(result.created.length, 3);
    for (const record of result.created) {
      assert.equal(record.status, "draft");
      assert.equal(record.qualityVersion, 5);
      assert.equal(record.productType, "synthesis");
      assert.equal(record.verification, "source_confirmed");
      assert.match(record.boundary, /不会自动激活为 Principle 或 policy/);
      assert.equal(readFileSync(record.path, "utf8").includes("source_confirmed_advisory"), true);
    }

    const audit = inspectMemoryTopicMigration(home, indexPath);
    assert.equal(audit.topicCount, 4);
    assert.equal(audit.counts.current, 3);
    assert.equal(audit.counts.ready, 1);

    const context = buildContextPack(home, {
      taskId: "task-alpha-consumer",
      title: "Alpha endpoint",
      goal: "Use route-key to access Alpha",
      acceptance: "The current access guide is present",
      scope: "work",
    });
    assert.equal(context.results.some((record) => result.created.some((created) => created.id === record.id)), false);
    assert.doesNotMatch(context.markdown, /Use the alpha endpoint with route-key/);

    const repeated = migrateMemoryTopicBatch(home, store, { indexPath, runId: run.id, offset: 0, limit: 3 });
    assert.equal(repeated.disposition, "no_change");
    assert.equal(repeated.created.length, 0);

    const secondRun = store.createRun(task.id, "ikb-curator", ["ikb-knowledge-curator"]);
    const escaped = migrateMemoryTopicBatch(home, store, { indexPath, runId: secondRun.id, offset: 3, limit: 1 });
    assert.equal(escaped.created.length, 1);
    const escapedBody = readFileSync(escaped.created[0].path, "utf8");
    assert.match(escapedBody, /Literal prose: &#92;n/);
    assert.match(escapedBody, /line-one&#92;r&#92;nline-two/);

    writeFileSync(join(memory, "alpha.md"), "# Alpha\n\nUse the revised alpha endpoint with route-key-v2.\n");
    importSource(home, join(memory, "alpha.md"), { kind: "manual", adapter: "catpaw-memory-local", scope: "work" });
    const stale = inspectMemoryTopicMigration(home, indexPath);
    assert.equal(stale.entries[0].status, "revision_required");

    const analystTask = store.createTask({ title: "Analyze revised Memory Topic", goal: "Compile the current Source", acceptance: "QV5 package is valid", type: "analysis", scope: "work" });
    const analystRun = store.createRun(analystTask.id, "ikb-analyst", ["ikb-conversation-analysis"]);
    const curatorTask = store.createTask({ title: "Revise Memory Topic Knowledge", goal: "Apply the current Source", acceptance: "Knowledge keeps its id and advances revision", type: "knowledge", scope: "work" });
    const curatorRun = store.createRun(curatorTask.id, "ikb-curator", ["ikb-knowledge-curator"]);
    const revised = reviseMemoryTopicBatch(home, store, { indexPath, analystRunId: analystRun.id, curatorRunId: curatorRun.id, offset: 0, limit: 1 });
    assert.equal(revised.disposition, "changed");
    assert.deepEqual(revised.revised.map((item) => item.knowledgeId), [result.created[0].id]);
    assert.equal(revised.revised[0].revision, 2);
    assert.equal(inspectMemoryTopicMigration(home, indexPath).entries[0].status, "current");
    assert.match(readFileSync(result.created[0].path, "utf8"), /route-key-v2/);
  } finally {
    store.close();
  }
});
