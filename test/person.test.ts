import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKeyPerson } from "../src/people.ts";
import { buildElephantPersonView, writePersonDossier, writePersonDossiers } from "../src/person.ts";
import { importSourceRecords, readSourceRecords } from "../src/source.ts";
import type { SourceMessage } from "../src/types.ts";

test("Elephant person view filters by actor and keeps cited context", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-view-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "group.jsonl");
  const content = "{\"id\":\"m1\",\"content\":\"first\"}\n{\"id\":\"m2\",\"content\":\"second\"}\n{\"id\":\"m3\",\"content\":\"third\"}\n";
  writeFileSync(input, content);
  const sourceId = "src-person-view";
  const records: SourceMessage[] = [
    { id: `${sourceId}:m1`, sourceId, conversationId: "gid:g1", role: "human", actor: "李四", timestamp: "2026-07-16T00:00:00.000Z", content: "first", refs: ["senderUid:u2"], participants: ["李四", "张三"] },
    { id: `${sourceId}:m2`, sourceId, conversationId: "gid:g1", role: "human", actor: "张三", timestamp: "2026-07-16T00:01:00.000Z", content: "second", refs: ["senderUid:u1"], participants: ["李四", "张三"] },
    { id: `${sourceId}:m3`, sourceId, conversationId: "gid:g1", role: "human", actor: "王五", timestamp: "2026-07-16T00:02:00.000Z", content: "third", refs: ["senderUid:u3"], participants: ["李四", "张三", "王五"] },
  ];
  importSourceRecords(home, input, content, { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群" }, records, sourceId);
  const duplicateSourceId = "src-person-view-2";
  importSourceRecords(home, input, content, { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群旧快照" }, records.map((record) => ({ ...record, id: record.id.replace(sourceId, duplicateSourceId), sourceId: duplicateSourceId })), duplicateSourceId);

  const byName = buildElephantPersonView(home, { name: "张三", contextWindow: 1, scope: "work" });
  assert.equal(byName.sourceCount, 2);
  assert.equal(byName.scannedRecordCount, 6);
  assert.equal(byName.matchedCount, 1);
  assert.equal(byName.duplicateCount, 1);
  assert.equal(byName.matches[0]?.record.content, "second");
  assert.deepEqual(byName.matches[0]?.context.map((record) => record.content), ["first", "second", "third"]);

  const byUid = buildElephantPersonView(home, { uid: "u1", contextWindow: 0, from: "2026-07-16", to: "2026-07-16" });
  assert.equal(byUid.matchedCount, 1);
  assert.match(byUid.matches[0]?.record.id ?? "", /:m2$/);
  assert.equal(byUid.matches[0]?.context.length, 1);
});

test("Elephant person view requires an explicit speaker selector", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-person-selector-"));
  assert.throws(() => buildElephantPersonView(home), /exactly one/);
  assert.throws(() => buildElephantPersonView(home, { name: "a", uid: "u1" }), /exactly one/);
});

test("person dossier aggregates Citadel, review, Elephant and Agent evidence without crossing scope", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-dossier-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "source.jsonl");
  writeFileSync(input, "synthetic\n");
  addKeyPerson(home, "alice", { mis: "alice", name: "Alice", aliases: ["A"], scope: "work" });

  const addSource = (sourceId: string, kind: string, title: string, records: SourceMessage[], scope = "work") => importSourceRecords(
    home,
    input,
    `${sourceId}\n`,
    { kind, adapter: kind === "document" || kind === "review_comment" ? "citadel" : kind === "elephant" ? "elephant" : "codex", scope, title },
    records,
    sourceId,
  );
  addSource("src-dossier-doc", "document", "KM 方案", [{ id: "src-dossier-doc:doc", sourceId: "src-dossier-doc", conversationId: "citadel:km-1", role: "document", actor: "Alice", timestamp: "2026-07-16T01:00:00Z", content: "Alice authored this document.", refs: ["contentId:km-1", "creator:alice"], participants: ["Alice"] }]);
  addSource("src-dossier-comment", "review_comment", "KM 方案 - 评论", [{ id: "src-dossier-comment:c1", sourceId: "src-dossier-comment", conversationId: "citadel:km-1:comment:c1", role: "review_comment", actor: "Alice", timestamp: "2026-07-16T02:00:00Z", content: "Please keep the evidence.", refs: ["contentId:km-1", "commentId:c1"], participants: ["Alice"] }]);
  const elephantRecords: SourceMessage[] = [{ id: "src-dossier-elephant:m1", sourceId: "src-dossier-elephant", conversationId: "gid:g1", role: "human", actor: "Alice", timestamp: "2026-07-16T03:00:00Z", content: "Decision in Elephant.", refs: ["messageId:m1", "senderMis:alice"], participants: ["Alice", "Bob"] }];
  addSource("src-dossier-elephant", "elephant", "大象群", elephantRecords);
  addSource("src-dossier-elephant-copy", "elephant", "大象群旧快照", elephantRecords.map((record) => ({ ...record, id: record.id.replace("src-dossier-elephant", "src-dossier-elephant-copy"), sourceId: "src-dossier-elephant-copy" })));
  addSource("src-dossier-agent", "ai_conversation", "Codex 会话", [{ id: "src-dossier-agent:a1", sourceId: "src-dossier-agent", conversationId: "codex:c1", role: "assistant", actor: "assistant", timestamp: "2026-07-16T04:00:00Z", content: "The agent recorded Alice's decision.", refs: ["personId:alice"], participants: ["Alice", "assistant"] }]);
  addSource("src-dossier-personal", "document", "Personal note", [{ id: "src-dossier-personal:p1", sourceId: "src-dossier-personal", conversationId: "personal:p1", role: "document", actor: "Alice", timestamp: "2026-07-16T05:00:00Z", content: "Must not cross scope.", refs: ["creator:alice"], participants: ["Alice"] }], "personal");

  const dossier = writePersonDossier(home, "alice", { limit: 20 });
  assert.equal(dossier.scope, "work");
  assert.equal(dossier.sourceCount, 5);
  assert.equal(dossier.matchedSourceCount, 5);
  assert.equal(dossier.matchedCount, 4);
  assert.equal(dossier.directMatchedCount, 3);
  assert.equal(dossier.contextMatchedCount, 1);
  assert.equal(dossier.duplicateCount, 1);
  assert.deepEqual(new Set(dossier.entries.map((entry) => entry.sourceKind)), new Set(["document", "review_comment", "elephant", "ai_conversation"]));
  assert.equal(existsSync(dossier.path), true);
  const markdown = readFileSync(dossier.path, "utf8");
  assert.match(markdown, /KM 方案/);
  assert.match(markdown, /Please keep the evidence/);
  assert.match(markdown, /src-dossier-agent/);
  assert.doesNotMatch(markdown, /Must not cross scope/);
});

test("person dossier keeps creator, owner and modifier attribution separate", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-attribution-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "document.md");
  writeFileSync(input, "# Architecture\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  addKeyPerson(home, "reviewer", { mis: "reviewer", name: "修改者", scope: "work" });
  const sourceId = "src-attribution";
  importSourceRecords(home, input, "# Architecture\n", { kind: "document", adapter: "citadel", scope: "work", title: "架构文档" }, [{
    id: `${sourceId}:document:1`,
    sourceId,
    conversationId: "citadel:1",
    role: "document",
    actor: "reviewer",
    timestamp: "2026-07-16T01:00:00Z",
    content: "A versioned architecture document.",
    refs: ["contentId:1", "creator:author", "owner:author", "modifier:reviewer"],
    participants: ["author", "reviewer"],
  }], sourceId);

  const author = writePersonDossier(home, "author");
  assert.deepEqual(author.entries[0]?.attributionKinds, ["creator", "owner"]);
  assert.equal(author.attributionCounts.creator, 1);
  assert.equal(author.attributionCounts.owner, 1);
  assert.equal(author.attributionCounts.modifier, 0);

  const reviewer = writePersonDossier(home, "reviewer");
  assert.deepEqual(reviewer.entries[0]?.attributionKinds, ["modifier"]);
  assert.equal(reviewer.attributionCounts.modifier, 1);
  assert.equal(reviewer.attributionCounts.creator, 0);
  const markdown = readFileSync(reviewer.path, "utf8");
  assert.match(markdown, /Attribution: modifier/);
  assert.doesNotMatch(markdown, /direct attribution or speech/);
});

test("person dossier shows authored evidence before speech and context when truncated", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-priority-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "records.jsonl");
  writeFileSync(input, "synthetic\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  const addSource = (sourceId: string, kind: string, records: SourceMessage[]) => importSourceRecords(
    home,
    input,
    `${sourceId}\n`,
    { kind, adapter: kind === "document" ? "citadel" : "elephant", scope: "work", title: sourceId },
    records,
    sourceId,
  );
  addSource("src-priority-doc", "document", [{
    id: "src-priority-doc:1",
    sourceId: "src-priority-doc",
    conversationId: "citadel:1",
    role: "document",
    actor: "reviewer",
    timestamp: "2026-07-01T00:00:00Z",
    content: "Older authored document.",
    refs: ["creator:author"],
    participants: ["author"],
  }]);
  addSource("src-priority-chat", "elephant", [
    {
      id: "src-priority-chat:1",
      sourceId: "src-priority-chat",
      conversationId: "gid:1",
      role: "human",
      actor: "author",
      timestamp: "2026-07-22T00:00:00Z",
      content: "Newer direct speech.",
      refs: ["senderMis:author"],
      participants: ["author", "other"],
    },
    {
      id: "src-priority-chat:2",
      sourceId: "src-priority-chat",
      conversationId: "gid:1",
      role: "human",
      actor: "other",
      timestamp: "2026-07-23T00:00:00Z",
      content: "Newest context-only message.",
      refs: ["senderMis:other"],
      participants: ["author", "other"],
    },
  ]);

  const dossier = writePersonDossier(home, "author", { limit: 1 });
  assert.equal(dossier.returnedCount, 1);
  assert.equal(dossier.entries[0]?.content, "Older authored document.");
  assert.deepEqual(dossier.entries[0]?.attributionKinds, ["creator"]);
});

test("person dossier persists every direct episode even when the readable view is truncated", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-episode-index-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "records.jsonl");
  writeFileSync(input, "synthetic\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  const sourceId = "src-episode-index";
  importSourceRecords(home, input, "episode index\n", { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群" }, [
    {
      id: `${sourceId}:1`, sourceId, conversationId: "gid:1", role: "human", actor: "author",
      timestamp: "2026-07-22T00:00:00Z", content: "直接证据一", refs: ["messageId:1", "senderMis:author"], participants: ["author", "other"],
    },
    {
      id: `${sourceId}:2`, sourceId, conversationId: "gid:1", role: "human", actor: "other",
      timestamp: "2026-07-22T00:10:00Z", content: "只是在同一群里的上下文", refs: ["messageId:2", "senderMis:other"], participants: ["author", "other"],
    },
    {
      id: `${sourceId}:3`, sourceId, conversationId: "gid:1", role: "human", actor: "author",
      timestamp: "2026-07-22T01:00:00Z", content: "直接证据二", refs: ["messageId:3", "senderMis:author"], participants: ["author", "other"],
    },
    {
      id: `${sourceId}:4`, sourceId, conversationId: "gid:1", role: "human", actor: "author",
      timestamp: "2026-07-22T02:00:00Z", content: "直接证据三", refs: ["messageId:4", "senderMis:author"], participants: ["author", "other"],
    },
  ], sourceId);

  const dossier = writePersonDossier(home, "author", { limit: 1 });
  assert.equal(dossier.returnedCount, 1);
  assert.equal(dossier.truncated, true);
  assert.equal(dossier.episodeCount, 3);
  assert.equal(existsSync(dossier.episodeIndexPath), true);
  const index = JSON.parse(readFileSync(dossier.episodeIndexPath, "utf8"));
  assert.equal(index.schema, "ikb-person-episode-index.v1");
  assert.equal(index.directRecordCount, 3);
  assert.equal(index.episodeCount, 3);
  assert.deepEqual(new Set(index.episodes.flatMap((episode: { records: Array<{ recordId: string }> }) => episode.records.map((record) => record.recordId))), new Set([
    `${sourceId}:1`, `${sourceId}:3`, `${sourceId}:4`,
  ]));
  assert.equal(JSON.stringify(index).includes("只是在同一群里的上下文"), false);
});

test("person dossier keeps full evidence in Source and writes only a bounded readable excerpt", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-excerpt-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "document.md");
  writeFileSync(input, "# Long document\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  const sourceId = "src-long-person-document";
  const tailMarker = "TAIL-MARKER-MUST-ONLY-LIVE-IN-SOURCE";
  const content = `${"可用正文。".repeat(300)}${tailMarker}`;
  importSourceRecords(home, input, content, { kind: "document", adapter: "citadel", scope: "work", title: "长文档" }, [{
    id: `${sourceId}:document:1`, sourceId, conversationId: "citadel:1", role: "document", actor: "author",
    timestamp: "2026-07-16T01:00:00Z", content, refs: ["contentId:1", "creator:author"], participants: ["author"],
  }], sourceId);

  const dossier = writePersonDossier(home, "author");
  assert.equal(dossier.entries[0].content.includes(tailMarker), true);
  const markdown = readFileSync(dossier.path, "utf8");
  assert.match(markdown, /摘录已截断/);
  assert.doesNotMatch(markdown, new RegExp(tailMarker));
  assert.equal(readFileSync(dossier.sources[0].recordsPath, "utf8").includes(tailMarker), true);
});

test("person dossier repairs quoted-reply browser rows before attributing direct speech", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-quoted-reply-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "browser-group.ndjson");
  const sourceId = "src-person-quoted-reply";
  const rawRows = [
    {
      id: "m1",
      actor: "陈小康",
      content: "需要你复盘一期并给出二期节奏",
      raw_text: "陈小康\n何樑：需要你复盘一期并给出二期节奏\n好的，我会在一期结束后复盘，再同步二期节奏。",
    },
    {
      id: "m2",
      actor: "陈小康",
      content: "只有被引用人的原话",
      raw_text: "陈小康\n何樑：只有被引用人的原话",
    },
  ];
  const rawContent = `${rawRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(input, rawContent);
  addKeyPerson(home, "chenxiaokang02", { mis: "chenxiaokang02", name: "陈小康", scope: "work" });
  importSourceRecords(home, input, rawContent, { kind: "elephant", adapter: "elephant-browser", scope: "work", title: "机票用户架构群" }, [
    {
      id: `${sourceId}:gid:g1:m1:1`, sourceId, conversationId: "gid:g1", role: "human", actor: "陈小康",
      timestamp: "2026-06-24T14:14:00+08:00", content: rawRows[0].content, refs: ["messageId:m1", "senderUid:1372888222"], participants: ["陈小康", "何樑"],
    },
    {
      id: `${sourceId}:gid:g1:m2:2`, sourceId, conversationId: "gid:g1", role: "human", actor: "陈小康",
      timestamp: "2026-06-24T14:15:00+08:00", content: rawRows[1].content, refs: ["messageId:m2", "senderUid:1372888222"], participants: ["陈小康", "何樑"],
    },
  ], sourceId);

  const dossier = writePersonDossier(home, "chenxiaokang02");
  const episodeIndex = JSON.parse(readFileSync(dossier.episodeIndexPath, "utf8"));
  const records = episodeIndex.episodes.flatMap((episode: { records: unknown[] }) => episode.records) as Array<{ contentExcerpt: string; refs: string[] }>;
  assert.equal(records.length, 1);
  assert.equal(records[0]?.contentExcerpt, "好的，我会在一期结束后复盘，再同步二期节奏。");
  assert.equal(records[0]?.refs.includes("person-attribution:quoted-reply-suffix"), true);
  assert.equal(JSON.stringify(episodeIndex).includes("需要你复盘一期并给出二期节奏"), false);
  assert.equal(readSourceRecords(home, sourceId)[0]?.content, "需要你复盘一期并给出二期节奏");
});

test("person episode excerpts remove Citadel read-only boilerplate without changing Source", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-citadel-boilerplate-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "document.md");
  const sourceId = "src-person-citadel-boilerplate";
  const content = [
    "> ⚠️ **注意（仅供阅读）**：此内容为简化版 Markdown，仅供阅读和总结，",
    "> **不可直接用于 createDocument --content 或 updateDocumentByXml**。",
    "> 直接使用会丢失样式宏。",
    "",
    "---",
    "",
    "# 报价架构方案",
    "正文说明模型分责与迁移边界。",
  ].join("\n");
  writeFileSync(input, content);
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  importSourceRecords(home, input, content, { kind: "document", adapter: "citadel", scope: "work", title: "报价架构方案" }, [{
    id: `${sourceId}:document:1`, sourceId, conversationId: "citadel:1", role: "document", actor: "author",
    timestamp: "2026-07-16T01:00:00Z", content, refs: ["contentId:1", "creator:author"], participants: ["author"],
  }], sourceId);

  const dossier = writePersonDossier(home, "author");
  const episodeIndex = JSON.parse(readFileSync(dossier.episodeIndexPath, "utf8"));
  const excerpt = episodeIndex.episodes[0].records[0].contentExcerpt as string;
  assert.match(excerpt, /^# 报价架构方案/);
  assert.doesNotMatch(excerpt, /不可直接用于 createDocument/);
  assert.match(readSourceRecords(home, sourceId)[0]?.content ?? "", /不可直接用于 createDocument/);
});

test("person episode indexes are immutable evidence-fingerprint versions", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-versioned-episodes-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "records.jsonl");
  writeFileSync(input, "synthetic\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  const firstSourceId = "src-person-versioned-first";
  importSourceRecords(home, input, "first\n", { kind: "elephant", adapter: "elephant", scope: "work", title: "项目群" }, [{
    id: `${firstSourceId}:1`, sourceId: firstSourceId, conversationId: "gid:1", role: "human", actor: "author",
    timestamp: "2026-07-16T01:00:00Z", content: "第一条直接证据", refs: ["messageId:1", "senderMis:author"], participants: ["author"],
  }], firstSourceId);

  const first = writePersonDossier(home, "author");
  const firstContent = readFileSync(first.episodeIndexPath, "utf8");
  assert.match(first.episodeIndexPath, /\/episodes\/[a-f0-9]{64}\.json$/);
  const repeated = writePersonDossier(home, "author");
  assert.equal(repeated.episodeIndexPath, first.episodeIndexPath);
  assert.equal(readFileSync(first.episodeIndexPath, "utf8"), firstContent);

  const secondSourceId = "src-person-versioned-second";
  importSourceRecords(home, input, "second\n", { kind: "elephant", adapter: "elephant", scope: "work", title: "另一个项目群" }, [{
    id: `${secondSourceId}:2`, sourceId: secondSourceId, conversationId: "gid:2", role: "human", actor: "author",
    timestamp: "2026-07-17T01:00:00Z", content: "第二条独立证据", refs: ["messageId:2", "senderMis:author"], participants: ["author"],
  }], secondSourceId);
  const changed = writePersonDossier(home, "author");
  assert.notEqual(changed.episodeIndexPath, first.episodeIndexPath);
  assert.equal(readFileSync(first.episodeIndexPath, "utf8"), firstContent);
});

test("batch person dossier rebuild scans each normalized Source only once", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-person-batch-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "document.md");
  writeFileSync(input, "# Architecture\n");
  addKeyPerson(home, "author", { mis: "author", name: "作者", scope: "work" });
  addKeyPerson(home, "reviewer", { mis: "reviewer", name: "修改者", scope: "work" });
  const sourceId = "src-person-batch";
  importSourceRecords(home, input, "# Architecture\n", { kind: "document", adapter: "citadel", scope: "work", title: "架构文档" }, [{
    id: `${sourceId}:document:1`,
    sourceId,
    conversationId: "citadel:1",
    role: "document",
    actor: "reviewer",
    timestamp: "2026-07-16T01:00:00Z",
    content: "A versioned architecture document.",
    refs: ["contentId:1", "creator:author", "modifier:reviewer"],
    participants: ["author", "reviewer"],
  }], sourceId);

  const batch = writePersonDossiers(home, ["author", "reviewer", "author"], { scope: "work" });
  assert.equal(batch.personCount, 2);
  assert.equal(batch.sourceCount, 1);
  assert.equal(batch.sourceReadCount, 1);
  assert.equal(batch.scannedRecordCount, 1);
  assert.equal(batch.results.length, 2);
  assert.deepEqual(batch.results.find((result) => result.person.id === "author")?.entries[0]?.attributionKinds, ["creator"]);
  assert.deepEqual(batch.results.find((result) => result.person.id === "reviewer")?.entries[0]?.attributionKinds, ["modifier"]);
});
