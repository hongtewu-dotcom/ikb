import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunQualityProjection } from "../src/run-quality.ts";
import { harnessEvaluationCases } from "../projects/eval-plane/src/harness-eval.ts";
import type { EventRecord, Run } from "../src/types.ts";

const HASH = "a".repeat(64);

function run(status: Run["status"] = "succeeded"): Run {
  return { id: "run-real-1", taskId: "task-real-1", agentId: "ikb-harness", skillIds: "ikb-knowledge-curator", status, retryOf: null, startedAt: "2026-07-20T00:00:00.000Z", finishedAt: "2026-07-20T00:01:00.000Z", checkpoint: null, failureReason: null, runDir: "/Users/htwu/projects/ikb/ikb-data/runs/private" };
}

function event(eventType: string, payload: Record<string, unknown>, sequence: number): EventRecord {
  return { eventId: `event-${sequence}`, aggregateType: "run", aggregateId: "run-real-1", sequence, eventType, actor: "human", occurredAt: "2026-07-20T00:00:00.000Z", causationId: null, payload, payloadHash: HASH, previousHash: null, eventHash: HASH };
}

test("local run-quality projection is metadata/hash-only and marks quality separately from terminal state", () => {
  const projected = buildRunQualityProjection(run(), [
    event("run.finished", { status: "succeeded", finishedAt: "2026-07-20T00:01:00.000Z", summary: "private summary" }, 1),
    event("run.step_finished", { stepId: "step-1", stepName: "读取私密文档", status: "succeeded", inputRefs: ["src-private"], outputRefs: ["artifact-private"], inputHash: HASH, outputHash: HASH }, 2),
    event("run.gate_evaluated", { gateId: "G3", decision: "pass", reasonCode: "evidence_complete", evidenceRefs: ["artifact-private"], gateVersion: "gates.v1" }, 3),
    event("run.artifact_linked", { artifactId: "artifact-private", relation: "produced", lineageRefs: ["src-private"] }, 4),
    event("run.verification_completed", { result: "pass", checks: [{ id: "secret-check", decision: "pass", evidenceRefs: ["artifact-private"] }], artifactRefs: ["artifact-private"] }, 5),
    event("run.evaluation_completed", { evalVersion: "harness-eval.v1", suiteId: "synthetic-12", result: "pass", totalCases: 12, passedCases: 12, failedCases: 0, artifactRefs: ["artifact-private"] }, 6),
  ]);
  assert.equal(projected.quality.terminalState, "succeeded");
  assert.equal(projected.quality.qualityState, "pass");
  assert.equal(projected.quality.evaluationResult, "pass");
  assert.equal(projected.trace.metadata.quality_state, "pass");
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /private summary|读取私密文档|\/Users\/htwu|src-private|artifact-private|secret-check/);
  assert.match(serialized, /input_hash|output_hash|event_id_hash/);
});

test("local projection keeps malformed structured events visible without trusting their payload", () => {
  const projected = buildRunQualityProjection(run("running"), [
    event("run.step_finished", { stepId: "bad", stepName: "x", status: "succeeded", content: "raw output" }, 1),
  ]);
  assert.equal(projected.spans.length, 1);
  assert.equal(projected.spans[0].metadata.invalid_event, true);
  assert.doesNotMatch(JSON.stringify(projected), /raw output/);
});

test("the local quality contract is represented by the deterministic twelve-case suite", () => {
  assert.equal(harnessEvaluationCases().length, 12);
});
