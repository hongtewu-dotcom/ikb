import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImprovementCandidates, extractFailureObservations } from "../src/outer-loop.ts";
import type { EventRecord } from "../src/types.ts";

function gateEvent(runId: string, eventId: string, reasonCode: string): EventRecord {
  return { eventId, aggregateType: "run", aggregateId: runId, sequence: 1, eventType: "run.gate_evaluated", actor: "test", occurredAt: "2026-07-20T00:00:00.000Z", causationId: null, payload: { gateId: "G3", decision: "block", reasonCode, evidenceRefs: [], gateVersion: "gates.v1" }, payloadHash: "a".repeat(64), previousHash: null, eventHash: "a".repeat(64) };
}

test("Outer Loop clusters repeated failures into a pending, traceable candidate", () => {
  const events = [gateEvent("run-1", "event-1", "missing_verifier"), gateEvent("run-2", "event-2", "missing_verifier"), gateEvent("run-3", "event-3", "missing_verifier")];
  const observations = extractFailureObservations(events, new Map([["run-1", "personal"], ["run-2", "personal"], ["run-3", "personal"]]));
  const [candidate] = buildImprovementCandidates(observations);
  assert.ok(candidate);
  assert.equal(candidate.status, "pending_review");
  assert.equal(candidate.sampleCount, 3);
  assert.equal(candidate.humanApprovalRequired, true);
  assert.deepEqual(candidate.automaticChanges, []);
  assert.deepEqual(candidate.regressionCaseIds, ["M1-quality-needs-verifier", "M2-terminal-success-is-not-quality"]);
  assert.doesNotMatch(JSON.stringify(candidate), /event-1|run-1/);
});

test("Outer Loop does not propose a rule for insufficient or mixed samples", () => {
  const observations = extractFailureObservations([
    gateEvent("run-1", "event-1", "timeout"),
    gateEvent("run-2", "event-2", "scope_mismatch"),
  ]);
  assert.deepEqual(buildImprovementCandidates(observations), []);
});

test("Outer Loop treats partial evaluation as a repeatable process failure", () => {
  const events: EventRecord[] = [1, 2, 3].map((sequence) => ({
    eventId: `evaluation-${sequence}`, aggregateType: "run", aggregateId: `run-${sequence}`, sequence,
    eventType: "run.evaluation_completed", actor: "test", occurredAt: "2026-07-20T00:00:00.000Z",
    causationId: null, payload: { evalVersion: "harness-eval.v1", suiteId: "synthetic-12", result: "partial", totalCases: 12, passedCases: 10, failedCases: 2, failedCaseRefs: ["M2", "M4"], artifactRefs: ["artifact-1"] }, payloadHash: "a".repeat(64), previousHash: null, eventHash: "a".repeat(64),
  }));
  const observations = extractFailureObservations(events, new Map([["run-1", "personal"], ["run-2", "personal"], ["run-3", "personal"]]));
  assert.equal(observations.every((item) => item.reasonCode === "evaluation_incomplete"), true);
  assert.equal(buildImprovementCandidates(observations)[0]?.sampleCount, 3);
});

test("Outer Loop preserves Case-level evaluation reason codes", () => {
  const event: EventRecord = {
    eventId: "evaluation-reasons", aggregateType: "run", aggregateId: "run-reasons", sequence: 1,
    eventType: "run.evaluation_completed", actor: "test", occurredAt: "2026-07-20T00:00:00.000Z", causationId: null,
    payload: { evalVersion: "eval-plane.v1", suiteId: "ikb-run-quality", result: "blocked", reasonCodes: ["verifier_not_passed", "artifact_link_missing"], totalCases: 8, passedCases: 6, failedCases: 2, failedCaseRefs: [], artifactRefs: [] },
    payloadHash: "a".repeat(64), previousHash: null, eventHash: "a".repeat(64),
  };
  assert.deepEqual(extractFailureObservations([event]).map((item) => item.reasonCode), ["verifier_not_passed", "artifact_link_missing"]);
});
