import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeHome } from "../src/commands/system.ts";
import { captureKnowledge, findKnowledge, searchKnowledge } from "../src/knowledge.ts";
import { ikbPaths, resolveLedgerPath, resolveRunsRoot, resolveSourcesRoot, resolveVault } from "../src/layout.ts";
import { importSource, inspectSourceIntegrity, listSources } from "../src/source.ts";
import { migrateStorageLayout } from "../src/storage-layout-migration.ts";
import { LedgerStore } from "../src/store.ts";

test("storage layout migration moves durable roots without rewriting immutable Run evidence", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ikb-layout-migration-"));
  const home = join(projectRoot, "ikb-data");
  const paths = ikbPaths(home);
  mkdirSync(paths.compatibility.ledger, { recursive: true });
  writeFileSync(join(paths.compatibility.ledger, "events.jsonl"), "");
  initializeHome(home);

  const input = join(projectRoot, "input.md");
  writeFileSync(input, "# Durable source\n\nKeep this evidence across layout migration.\n");
  const imported = importSource(home, input, { kind: "document", scope: "work", title: "Durable source" });
  const knowledge = captureKnowledge(home, {
    title: "Durable migration knowledge",
    body: "Keep ids, content and retrieval stable while storage paths move.",
    scope: "work",
    status: "verified",
    sourceRefs: [imported.source.id],
    verification: "task_validated",
    applicability: "Storage layout migration",
    boundary: "Synthetic migration fixture",
  });
  const store = new LedgerStore({ home, actor: "migration-test" });
  store.recordSourceIngestEvents([{ id: imported.source.id, payload: imported.source }]);
  const task = store.createTask({ title: "layout migration", goal: "move durable roots", acceptance: "all consumers still resolve", scope: "work" });
  const run = store.createRun(task.id, "test-agent");
  const artifactPath = join(run.runDir, "result.md");
  writeFileSync(artifactPath, "result\n");
  const artifact = store.createArtifact({ runId: run.id, kind: "result", label: "result", path: artifactPath });

  const result = migrateStorageLayout(home, store, projectRoot);
  assert.equal(result.after.migrationReady, true);
  assert.equal(result.after.deletionReady, false);
  assert.equal(result.verification.brokenChains.length, 0);
  assert.equal(existsSync(result.backup.manifestPath), true);
  assert.equal(existsSync(paths.compatibility.sources), false);
  assert.equal(existsSync(paths.compatibility.ledger), false);
  assert.equal(existsSync(paths.compatibility.runs), false);
  assert.equal(existsSync(paths.compatibility.backups), false);
  assert.equal(resolveSourcesRoot(home), paths.sources);
  assert.equal(resolveLedgerPath(home), join(paths.ledger, "events.jsonl"));
  assert.equal(resolveRunsRoot(home), paths.runs);
  assert.equal(resolveVault(home, "work"), join(paths.knowledge, "work"));

  const sources = listSources(home, { includeQuarantined: true });
  const migratedSource = sources.find((source) => source.id === imported.source.id)!;
  assert.equal(migratedSource.recordsPath.startsWith(paths.sources), true);
  assert.deepEqual(inspectSourceIntegrity(home, migratedSource), []);
  assert.equal(findKnowledge(home, knowledge.id)?.path.startsWith(paths.knowledge), true);
  assert.equal(searchKnowledge(home, knowledge.title, { scope: "work", status: "verified" })[0]?.id, knowledge.id);

  const reopened = new LedgerStore({ home, actor: "migration-test" });
  assert.equal(reopened.requireRun(run.id).runDir.startsWith(paths.runs), true);
  assert.equal(reopened.requireArtifact(artifact.id).path.startsWith(paths.runs), true);
  assert.equal(readFileSync(reopened.requireArtifact(artifact.id).path, "utf8"), "result\n");
  const rawRun = reopened.listEvents().find((event) => event.eventType === "run.queued" && event.aggregateId === run.id)!;
  assert.equal(String(rawRun.payload.runDir).startsWith(paths.compatibility.runs), true);
  const postAudit = JSON.parse(readFileSync(result.after.path, "utf8"));
  assert.equal(postAudit.references.runPathRefs.rawCount, 1);
  assert.equal(postAudit.references.runPathRefs.count, 0);
  assert.equal(postAudit.references.artifactPathRefs.rawCount, 1);
  assert.equal(postAudit.references.artifactPathRefs.count, 0);
  const resumed = migrateStorageLayout(home, reopened, projectRoot);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.migrationId, result.migrationId);
  assert.equal(resumed.after.migrationReady, true);
  reopened.close();
});
