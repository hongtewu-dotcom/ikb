import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureKnowledge } from "../src/knowledge.ts";
import { importSource } from "../src/source.ts";
import { auditStorageLayout, createFullBackup } from "../src/storage-audit.ts";
import { LedgerStore } from "../src/store.ts";

test("full backup and storage audit preserve recovery evidence before migration", () => {
  const projectRoot = resolve(new URL("..", import.meta.url).pathname);
  const home = mkdtempSync(join(tmpdir(), "ikb-storage-audit-"));
  const input = join(home, "input.md");
  writeFileSync(input, "# Source\n\nStorage audit fixture.\n");
  const source = importSource(home, input, { kind: "document", scope: "work", title: "Storage audit Source" });
  const knowledge = captureKnowledge(home, {
    title: "Storage audit Knowledge",
    body: "Storage audit Knowledge remains retrievable across a future migration.",
    scope: "work",
    status: "verified",
    sourceRefs: [source.source.id],
    verification: "task_validated",
    applicability: "Storage migration audit",
    boundary: "Synthetic fixture",
  });
  const store = new LedgerStore({ home });
  store.recordSourceIngestEvents([{ id: source.source.id, payload: source.source }]);
  const task = store.createTask({ title: "Storage audit Knowledge", goal: "Audit legacy path references", acceptance: "No deletion without references", scope: "work" });
  const run = store.createRun(task.id, "test-agent");
  const resultPath = join(run.runDir, "result.md");
  writeFileSync(resultPath, "result\n");
  store.createArtifact({ runId: run.id, kind: "result", label: "result", path: resultPath });

  const backup = createFullBackup(home);
  assert.equal(backup.schema, "ikb-full-backup.v1");
  assert.equal(existsSync(backup.manifestPath), true);
  assert.equal(existsSync(join(backup.backupDir, "ledger", "events.jsonl")), true);
  assert.equal(backup.knowledge.records.some((record) => record.id === knowledge.id), true);
  assert.equal(JSON.parse(readFileSync(backup.manifestPath, "utf8")).sources.count, 1);

  const audit = auditStorageLayout(home, store, projectRoot);
  assert.equal(audit.schema, "ikb-storage-layout-audit.v1");
  assert.equal(audit.knowledge.records.some((record) => record.id === knowledge.id), true);
  assert.equal(audit.retrieval.some((item) => item.expectedKnowledgeId === knowledge.id && item.results.some((result) => result.id === knowledge.id)), true);
  assert.equal(audit.references.runPathRefs.count, 1);
  assert.equal(audit.references.artifactPathRefs.count, 1);
  assert.equal(audit.migrationReady, false);
  assert.equal(audit.deletionReady, false);
  assert.equal(existsSync(audit.path), true);
  store.close();
});
