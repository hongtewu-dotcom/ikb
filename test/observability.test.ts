import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildObservabilityReport } from "../src/observability.ts";
import { LedgerStore } from "../src/store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-observability-"));
}

test("observability report separates terminal state, quality and knowledge feedback", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "observability-test" });
  const task = store.createTask({ title: "观测", goal: "验证报告", acceptance: "可对账", scope: "personal" });
  const run = store.createRun(task.id, "ikb-harness", ["ikb-verifier"]);
  store.recordHarnessEvent(run.id, "run.gate_evaluated", { gateId: "G3", decision: "pass", reasonCode: "evidence_complete", evidenceRefs: ["source-1"], gateVersion: "gates.v1" });
  store.recordHarnessEvent(run.id, "run.artifact_linked", { artifactId: "artifact-1", relation: "produced", lineageRefs: ["source-1"] });
  store.recordHarnessEvent(run.id, "run.verification_completed", { result: "pass", checks: [{ id: "evidence", decision: "pass", evidenceRefs: ["artifact-1"] }], artifactRefs: ["artifact-1"] });
  store.recordHarnessEvent(run.id, "run.evaluation_completed", { evalVersion: "harness-eval.v1", suiteId: "synthetic-12", result: "pass", totalCases: 12, passedCases: 12, failedCases: 0, artifactRefs: ["artifact-1"] });
  store.recordKnowledgeEvent("kb-test", "knowledge.referenced", { taskId: task.id, runId: run.id, status: "draft", verification: "advisory", path: "/private/kb.md", query: "验证" });
  store.finishRun(run.id, "succeeded", "done");
  store.recordKnowledgeEvent("kb-test", "knowledge.feedback_recorded", { taskId: task.id, runId: run.id, outcome: "incorrect", reasonCode: "boundary_missing" });

  const report = buildObservabilityReport(store, "weekly", new Date(Date.now() + 1000));
  assert.equal(report.runs.total, 1);
  assert.equal(report.runs.quality.pass, 1);
  assert.equal(report.runs.evaluation.eligible, 1);
  assert.equal(report.runs.evaluation.assessed, 1);
  assert.equal(report.runs.evaluation.coverageRate, 1);
  assert.equal(report.runs.evaluation.qualityPassRate, 1);
  assert.equal(report.knowledgeUsage.references, 1);
  assert.equal(report.knowledgeUsage.distinctKnowledge, 1);
  assert.equal(report.knowledgeUsage.feedback.incorrect, 1);
  assert.equal(report.knowledgeUsage.feedbackByReason.boundary_missing, 1);
  assert.equal(report.failures.observations, 1);
  store.close();
});
