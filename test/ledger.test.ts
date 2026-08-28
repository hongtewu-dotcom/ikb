import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  assert.equal(statSync(join(home, "ledger")).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "ledger", "events.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(run.runDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(run.runDir, "input.json")).mode & 0o777, 0o600);
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

test("a terminal-succeeded Run can retry only after quality is explicitly blocked", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "test" });
  const task = store.createTask({ title: "Quality retry", goal: "repair quality", acceptance: "quality pass", type: "general" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  store.finishRun(run.id, "succeeded", "runtime finished");
  assert.throws(() => store.retryRun(run.id), /blocked\/partial Evaluation/);
  store.recordHarnessEvent(run.id, "run.evaluation_completed", {
    evalVersion: "eval-plane.v1",
    suiteId: "ikb-run-quality",
    result: "blocked",
    reasonCodes: ["context_retrieval_noise"],
    totalCases: 1,
    passedCases: 0,
    failedCases: 1,
    failedCaseRefs: ["case://context-relevance"],
    artifactRefs: ["artifact://evaluation"],
  });
  const retry = store.retryRun(run.id);
  assert.equal(retry.retryOf, run.id);
  assert.equal(retry.skillIds, "ikb-use-knowledge");
  store.close();
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

test("ledger read projection refreshes when another process appends events", () => {
  const home = freshHome();
  const reader = new LedgerStore({ home, actor: "reader" });
  assert.equal(reader.listTasks().length, 0);
  const writer = new LedgerStore({ home, actor: "writer" });
  const task = writer.createTask({ title: "External update", goal: "Refresh the read model", acceptance: "Reader sees it" });
  writer.close();
  assert.equal(reader.getTask(task.id)?.title, "External update");
  assert.equal(reader.listTasks().length, 1);
  reader.close();
});

test("source scan events can be appended as one verified batch", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "intake" });
  const events = store.recordSourceEvents([
    { id: "history:codex:a", eventType: "source.incremental_scan", payload: { status: "imported", deltaCount: 2 } },
    { id: "history:codex:a", eventType: "source.incremental_scan", payload: { status: "imported", deltaCount: 1 } },
    { id: "history:claude:b", eventType: "source.incremental_scan", payload: { status: "imported", deltaCount: 1 } },
  ]);

  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 1]);
  assert.equal(readFileSync(store.eventsPath, "utf8").trim().split("\n").length, 3);
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});

test("task transitions reject impossible state changes", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "State", goal: "Check states", acceptance: "Terminal task stays terminal" });
  store.transitionTask(task.id, "done");
  assert.throws(() => store.transitionTask(task.id, "active"), /cannot move/);
  store.close();
});

test("approval payload hash uses the same JSON-normalized value as the ledger", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "Approval hash", goal: "Keep hashes reproducible", acceptance: "Persisted payload matches" });
  const run = store.createRun(task.id, "test-agent");
  const when = new Date("2026-07-16T08:00:00.000Z");
  const approval = store.requestApproval({ runId: run.id, action: "publish", target: "doc", payload: { when, omitted: undefined } });
  const event = store.listEvents().find((item) => item.eventType === "approval.requested");
  assert.ok(event);
  assert.deepEqual(event.payload.payload, { when: when.toISOString() });
  assert.equal(approval.payloadHash, createHash("sha256").update(JSON.stringify({ when: when.toISOString() })).digest("hex"));
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});

test("knowledge migration events append atomically and idempotently", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const items = [
    { id: "kb-one", payload: { from: "/legacy/one.md", to: "/concepts/one.md" } },
    { id: "kb-two", payload: { from: "/legacy/two.md", to: "/decisions/two.md" } },
  ];
  assert.equal(store.recordKnowledgeMigrationEvents(items).length, 2);
  assert.equal(store.recordKnowledgeMigrationEvents(items).length, 0);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.migrated").length, 2);
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});

test("source ingest events append idempotently for crash reconciliation", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const item = { id: "src-recover", payload: { id: "src-recover", contentHash: "raw", recordsHash: "records" } };
  assert.equal(store.recordSourceIngestEvents([item]).length, 1);
  assert.equal(store.recordSourceIngestEvents([item]).length, 0);
  assert.equal(store.listEvents().filter((event) => event.eventType === "source.ingested").length, 1);
  store.close();
});

test("publication lifecycle events are idempotent for the same release state", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const payload = { channel: "personal-github", bundleHash: "a".repeat(64), outputHash: "b".repeat(64) };
  const first = store.recordPublicationEvent("release-test", "publication.built", payload);
  const repeated = store.recordPublicationEvent("release-test", "publication.built", payload);
  const changed = store.recordPublicationEvent("release-test", "publication.built", { ...payload, outputHash: "c".repeat(64) });
  assert.equal(repeated.eventId, first.eventId);
  assert.notEqual(changed.eventId, first.eventId);
  assert.equal(store.listEvents().filter((event) => event.aggregateId === "release-test" && event.eventType === "publication.built").length, 2);
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});

test("Harness events are typed, redacted and included in the Run snapshot", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "harness-test" });
  const task = store.createTask({ title: "Harness contract", goal: "Record a trace", acceptance: "Every transition is auditable" });
  const run = store.createRun(task.id, "task-manager", ["harness"]);
  const hash = "a".repeat(64);

  store.recordHarnessEvent(run.id, "run.loop_started", {
    loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: [], contextHash: hash,
  });
  store.recordHarnessEvent(run.id, "run.step_started", {
    stepId: "step-1", stepName: "读取证据", loopId: "inner", iteration: 0,
    roleId: "知识分析员", skillId: "ikb-conversation-analysis", inputRefs: ["src-1"], outputRefs: [], inputHash: hash,
  });
  store.recordHarnessEvent(run.id, "run.step_finished", {
    stepId: "step-1", stepName: "读取证据", loopId: "inner", iteration: 0,
    inputRefs: ["src-1"], outputRefs: ["artifact-1"], inputHash: hash, outputHash: hash, status: "succeeded",
  });
  store.recordHarnessEvent(run.id, "run.handoff", {
    handoffId: "handoff-1", stepId: "step-1", fromRole: "知识分析员", toRole: "知识整理员",
    inputRefs: ["artifact-1"], outputRefs: ["artifact-2"], contractVersion: "harness-events.v1",
  });
  store.recordHarnessEvent(run.id, "run.gate_evaluated", {
    gateId: "G3", decision: "pass", reasonCode: "evidence_complete", evidenceRefs: ["artifact-1"], gateVersion: "gates.v1",
  });
  store.recordHarnessEvent(run.id, "run.artifact_linked", {
    artifactId: "artifact-2", relation: "produced", lineageRefs: ["artifact-1"],
  });
  store.recordHarnessEvent(run.id, "run.verification_completed", {
    result: "pass", checks: [{ id: "evidence", decision: "pass", evidenceRefs: ["artifact-2"] }], artifactRefs: ["artifact-2"],
  });
  store.recordHarnessEvent(run.id, "run.evaluation_completed", {
    evalVersion: "harness-eval.v1", suiteId: "synthetic-12", result: "pass", totalCases: 12, passedCases: 12, failedCases: 0, artifactRefs: ["artifact-2"],
  });
  store.recordHarnessEvent(run.id, "run.approval_checked", {
    approvalId: "approval-1", approvalDecision: "not_required", action: "write_draft", targetHash: hash, payloadHash: hash,
  });
  store.recordHarnessEvent(run.id, "run.action_executed", {
    actionId: "action-1", action: "write_draft", sideEffectLevel: "L1", targetHash: hash, payloadHash: hash,
    status: "succeeded", executedAt: "2026-07-20T00:00:00.000Z",
  });
  store.recordHarnessEvent(run.id, "run.loop_finished", {
    loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: ["artifact-2"], contextHash: hash,
    status: "succeeded", nextAction: "handoff",
  });

  const beforeRejected = store.listEvents().length;
  assert.throws(() => store.recordHarnessEvent(run.id, "run.step_finished", {
    stepId: "step-unsafe", stepName: "bad", status: "succeeded", content: "raw model output",
  }), /unsafe Harness event field/);
  assert.throws(() => store.recordHarnessEvent(run.id, "run.step_started", {
    stepId: "step-url", stepName: "读取", inputRefs: ["https://example.com/private"], outputRefs: [],
  }), /safe references/);
  assert.throws(() => store.recordHarnessEvent(run.id, "run.step_started", {
    stepId: "step-path", stepName: "/Users/private/raw.txt", inputRefs: [], outputRefs: [],
  }), /not a URL, path, Prompt or raw output/);
  assert.throws(() => store.recordHarnessEvent(run.id, "run.step_finished", {
    stepId: "step-prompt", stepName: "安全标签", status: "failed", nextAction: "read the raw output and rewrite it",
  }), /bounded metadata token/);
  assert.throws(() => store.recordHarnessEvent(run.id, "run.verification_completed", {
    result: "pass", checks: [], artifactRefs: [],
  }), /at least one check/);
  assert.equal(store.listEvents().length, beforeRejected);

  const runEvents = store.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === run.id);
  assert.equal(runEvents.filter((event) => event.eventType.startsWith("run.")).length, 13);
  assert.equal(runEvents.find((event) => event.eventType === "run.verification_completed")?.payload.result, "pass");
  assert.equal(store.verify().brokenChains.length, 0);
  const snapshot = readFileSync(join(run.runDir, "events.jsonl"), "utf8");
  assert.match(snapshot, /run\.handoff/);
  assert.doesNotMatch(snapshot, /raw model output/);
  store.close();
});
