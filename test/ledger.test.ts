import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerStore } from "../src/store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-test-"));
}

test("ledger persists a task, run, approval, artifact and retry history", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "test" });
  const task = store.createTask({ title: "Test task", goal: "Trace a workflow", acceptance: "All artifacts are visible", type: "document" });
  const run = store.createRun(task.id, "document-agent", ["draft"]);
  store.checkpointRun(run.id, "draft");
  const approval = store.requestApproval({ runId: run.id, action: "publish", target: "doc-1", payload: { version: 1 } });
  assert.equal(store.getRun(run.id)?.status, "awaiting_approval");
  store.decideApproval(approval.id, "rejected", "missing source");
  assert.equal(store.getRun(run.id)?.status, "failed");
  const retry = store.retryRun(run.id);
  assert.equal(retry.retryOf, run.id);

  const artifactPath = join(home, "draft.md");
  writeFileSync(artifactPath, "# draft\n");
  const artifact = store.createArtifact({ runId: retry.id, kind: "document", label: "draft", path: artifactPath });
  store.finishRun(retry.id, "succeeded", "draft accepted");
  store.transitionTask(task.id, "done", undefined, artifact.id);
  store.close();

  const reopened = new LedgerStore({ home, actor: "test" });
  assert.equal(reopened.getTask(task.id)?.status, "done");
  assert.equal(reopened.listRuns({ taskId: task.id }).length, 2);
  assert.equal(reopened.listArtifacts({ taskId: task.id }).length, 1);
  assert.equal(reopened.verify().brokenChains.length, 0);
  assert.ok(reopened.listEvents().length >= 12);
  reopened.close();
});

test("doctor detects a tampered event hash", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  store.createTask({ title: "Integrity", goal: "Detect tampering", acceptance: "doctor fails" });
  store.close();
  const path = join(home, "ledger", "events.jsonl");
  const event = JSON.parse(readFileSync(path, "utf8").trim());
  event.payload.title = "tampered";
  writeFileSync(path, `${JSON.stringify(event)}\n`);
  const reopened = new LedgerStore({ home });
  assert.equal(reopened.verify().brokenChains.length, 1);
  reopened.close();
});

test("task transitions reject impossible state changes", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "State", goal: "Check states", acceptance: "Terminal task stays terminal" });
  store.transitionTask(task.id, "done");
  assert.throws(() => store.transitionTask(task.id, "active"), /cannot move/);
  store.close();
});
