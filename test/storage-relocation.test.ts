import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleDoctor, initializeHome } from "../src/commands/system.ts";
import { readHealthSnapshot } from "../src/health.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";
import { normalizeRelocation, StoragePathResolver } from "../src/storage-relocation.ts";

function projectRoot(label: string): string {
  return join(mkdtempSync(join(tmpdir(), "ikb-storage-relocation-")), label);
}

function doctorOutput(store: LedgerStore, home: string, options: Record<string, string | boolean>) {
  const output: string[] = [];
  const previousLog = console.log;
  const previousExitCode = process.exitCode;
  console.log = (value?: unknown) => { output.push(String(value)); };
  try {
    handleDoctor(store, home, { positionals: [], options: { json: true, output: "json", ...options } });
  } finally {
    console.log = previousLog;
    process.exitCode = previousExitCode;
  }
  return JSON.parse(output.join("\n"));
}

test("storage relocation keeps Ledger events raw while Run and Artifact consumers resolve moved paths", () => {
  const oldRoot = projectRoot("old-project");
  const oldHome = join(oldRoot, "ikb-data");
  const store = new LedgerStore({ home: oldHome, actor: "test" });
  const task = store.createTask({ title: "move", goal: "move project root", acceptance: "old files remain readable" });
  const run = store.createRun(task.id, "test-agent");
  const artifactPath = join(run.runDir, "result.md");
  writeFileSync(artifactPath, "result\n");
  const artifact = store.createArtifact({ runId: run.id, kind: "document", label: "result", path: artifactPath });
  store.close();

  const newRoot = projectRoot("new-project");
  // Rename the actual project directory, exactly as the historical migration did.
  renameSync(oldRoot, newRoot);
  const newHome = join(newRoot, "ikb-data");
  const reopened = new LedgerStore({ home: newHome, actor: "test" });
  const rawRunEvent = reopened.listEvents().find((event) => event.eventType === "run.queued")!;
  const rawArtifactEvent = reopened.listEvents().find((event) => event.eventType === "artifact.created")!;
  assert.equal((rawRunEvent.payload as any).runDir, run.runDir);
  assert.equal((rawArtifactEvent.payload as any).path, artifact.path);

  const relocation = reopened.recordStorageRootRelocation({ fromRoot: oldRoot, toRoot: newRoot });
  assert.equal(relocation.eventType, "system.storage_root_relocated");
  assert.equal(reopened.recordStorageRootRelocation({ fromRoot: oldRoot, toRoot: newRoot }).eventId, relocation.eventId);
  assert.equal(reopened.requireRun(run.id).runDir, join(newHome, "runs", run.runDir.split("/").at(-1)!));
  assert.equal(reopened.requireArtifact(artifact.id).path, join(newHome, "runs", run.runDir.split("/").at(-1)!, "result.md"));
  assert.equal(readFileSync(reopened.requireArtifact(artifact.id).path, "utf8"), "result\n");
  assert.equal((reopened.listEvents().find((event) => event.eventType === "run.queued")!.payload as any).runDir, run.runDir);
  assert.equal((reopened.eventsFor(task.id).find((event) => event.eventType === "artifact.created")!.payload as any).path, artifact.path);
  assert.equal(reopened.verify().brokenChains.length, 0);
  reopened.close();
});

test("doctor compares Source paths after relocation and sees neither missing nor orphan Runs", () => {
  const oldRoot = projectRoot("old-project");
  const oldHome = join(oldRoot, "ikb-data");
  const store = new LedgerStore({ home: oldHome, actor: "test" });
  initializeHome(oldHome);
  const sourceInput = join(oldRoot, "input.md");
  writeFileSync(sourceInput, "# source\n");
  const imported = importSource(oldHome, sourceInput, { kind: "document", scope: "work", title: "relocation source" });
  store.recordSourceIngestEvents([{ id: imported.source.id, payload: imported.source }]);
  const task = store.createTask({ title: "move", goal: "move project root", acceptance: "doctor resolves paths" });
  const run = store.createRun(task.id, "test-agent");
  store.close();

  const newRoot = projectRoot("new-project");
  renameSync(oldRoot, newRoot);
  const newHome = join(newRoot, "ikb-data");
  const sourcePath = join(newHome, "sources", imported.source.id, "source.json");
  const currentSource = JSON.parse(readFileSync(sourcePath, "utf8"));
  for (const field of ["originalPath", "rawPath", "recordsPath"]) currentSource[field] = currentSource[field].replace(oldRoot, newRoot);
  writeFileSync(sourcePath, `${JSON.stringify(currentSource, null, 2)}\n`);

  const reopened = new LedgerStore({ home: newHome, actor: "test" });
  reopened.recordStorageRootRelocation({ fromRoot: oldRoot, toRoot: newRoot });
  const doctor = doctorOutput(reopened, newHome, {});
  assert.equal(doctor.sourceIssues.filter((issue: any) => issue.code === "source_metadata_ledger_mismatch").length, 0);
  assert.deepEqual(doctor.missingRunDirs, []);
  assert.deepEqual(doctor.orphanRunDirs, []);
  assert.equal(reopened.requireRun(run.id).runDir.startsWith(newRoot), true);
  reopened.close();
});

test("doctor compact output removes detail bodies without changing full doctor or health summary", () => {
  const home = join(projectRoot("project"), "ikb-data");
  const store = new LedgerStore({ home, actor: "test" });
  initializeHome(home);
  const full = doctorOutput(store, home, {});
  const compact = doctorOutput(store, home, { compact: true, "write-summary": true });
  assert.equal(Array.isArray(full.sourceIssues), true);
  assert.equal("incrementalState" in full, true);
  assert.equal("incrementalState" in compact, false);
  assert.equal(typeof compact.sourceIssues, "number");
  assert.equal(typeof compact.candidateIssues, "number");
  assert.equal(readHealthSnapshot(home).doctor?.sourceIssues, full.sourceIssues.length);
  store.close();
});

test("storage relocation only maps the current project root and rejects traversal or cycles", () => {
  assert.throws(() => normalizeRelocation({ fromRoot: "/old/../escape", toRoot: "/new" }), /must not contain '\.\.'/);
  const currentProjectRoot = projectRoot("new-project");
  const home = join(currentProjectRoot, "ikb-data");
  const store = new LedgerStore({ home, actor: "test" });
  assert.throws(() => store.recordStorageRootRelocation({ fromRoot: "/old-project", toRoot: "/other-project" }), /current project root/);
  store.recordStorageRootRelocation({ fromRoot: "/old-project", toRoot: currentProjectRoot });
  assert.equal(store.resolveStoragePath("/old-project/ikb-data/runs/a"), `${currentProjectRoot}/ikb-data/runs/a`);
  assert.equal(store.resolveStoragePath("/old-projectish/ikb-data/runs/a"), "/old-projectish/ikb-data/runs/a");
  assert.throws(() => new StoragePathResolver([
    { fromRoot: "/old-project", toRoot: "/middle-project" },
    { fromRoot: "/middle-project", toRoot: "/old-project" },
  ]), /cycle/);
  store.close();
});
