import { createDefaultEvalRegistry } from "../projects/eval-plane/src/eval-registry.ts";
import { coordinateRunEvaluation, recordEvaluationFailure } from "../projects/eval-plane/src/evaluation-coordinator.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "../projects/eval-plane/src/run-assessment.ts";
import { evalPlaneRoot } from "./evaluation-paths.ts";
import { buildKnowledgeUsageStatus } from "./knowledge-usage.ts";
import type { LedgerStore } from "./store.ts";

export function finishRunAndAssess(
  store: LedgerStore,
  runId: string,
  status: "succeeded" | "failed" | "canceled",
  summary?: string,
): ReturnType<LedgerStore["finishRun"]> {
  if (status === "succeeded") {
    const usage = buildKnowledgeUsageStatus(store, runId);
    if (usage.activated && !usage.complete) {
      recordKnowledgeUsageGate(store, runId, "block", "knowledge_feedback_missing", usage.unresolvedKnowledgeIds);
      throw new Error(`Run ${runId} 尚有 ${usage.unresolvedKnowledgeIds.length} 条 Knowledge 未记录最终效果：${usage.unresolvedKnowledgeIds.join(", ")}`);
    }
    if (usage.activated) recordKnowledgeUsageGate(store, runId, "pass", "knowledge_feedback_complete", usage.resolvedKnowledgeIds);
  }
  const run = store.finishRun(runId, status, summary);
  const registry = createDefaultEvalRegistry();
  try {
    coordinateRunEvaluation(store, registry, run.id, {
      projectRoot: evalPlaneRoot(),
      suiteId: IKB_RUN_QUALITY_SUITE_ID,
    });
  } catch {
    recordEvaluationFailure(store, registry, run.id, IKB_RUN_QUALITY_SUITE_ID);
  }
  return run;
}

function recordKnowledgeUsageGate(
  store: LedgerStore,
  runId: string,
  decision: "pass" | "block",
  reasonCode: string,
  knowledgeIds: string[],
): void {
  const evidenceRefs = knowledgeIds.map((id) => `knowledge://${id}`);
  const latest = store.listEvents().filter((event) => event.aggregateType === "run"
    && event.aggregateId === runId
    && event.eventType === "run.gate_evaluated"
    && event.payload.gateId === "G6"
    && event.payload.reasonCode === reasonCode).at(-1);
  if (latest?.payload.decision === decision && JSON.stringify(latest.payload.evidenceRefs) === JSON.stringify(evidenceRefs)) return;
  store.recordHarnessEvent(runId, "run.gate_evaluated", {
    gateId: "G6",
    decision,
    reasonCode,
    evidenceRefs,
    gateVersion: "knowledge-usage.v1",
  });
}
