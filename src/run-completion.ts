import { createDefaultEvalRegistry } from "../projects/eval-plane/src/eval-registry.ts";
import { coordinateRunEvaluation, recordEvaluationFailure } from "../projects/eval-plane/src/evaluation-coordinator.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "../projects/eval-plane/src/run-assessment.ts";
import { evalPlaneRoot } from "./evaluation-paths.ts";
import type { LedgerStore } from "./store.ts";

export function finishRunAndAssess(
  store: LedgerStore,
  runId: string,
  status: "succeeded" | "failed" | "canceled",
  summary?: string,
): ReturnType<LedgerStore["finishRun"]> {
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
