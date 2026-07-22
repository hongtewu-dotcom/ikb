import { LedgerStore } from "../store.ts";
import { resolve } from "node:path";
import { assertValue, printValue } from "../format.ts";
import { evaluateHarnessCase, evaluateHarnessSuite, harnessEvaluationCases } from "../../projects/eval-plane/src/harness-eval.ts";
import { createDefaultEvalRegistry } from "../../projects/eval-plane/src/eval-registry.ts";
import { compareEvalResults, runEvalSuite } from "../../projects/eval-plane/src/eval-runner.ts";
import { coordinateRunEvaluation, loadLatestRunEvaluation, repairRunEvaluations } from "../../projects/eval-plane/src/evaluation-coordinator.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "../../projects/eval-plane/src/run-assessment.ts";
import { coordinateWorkRunEvaluation, loadLatestWorkRunEvaluation } from "../../projects/eval-plane/src/work-evaluation-coordinator.ts";
import { buildImprovementCandidates, extractFailureObservations, type OuterScope } from "../outer-loop.ts";
import { evalPlaneRoot, persistEvalReport, readEvalResults } from "./evaluation.ts";
import { type ParsedArgs, optionalOption, outputFormat, requiredOption } from "./shared.ts";

export function handleHarness(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  const registry = createDefaultEvalRegistry();
  if (action === "suite") {
    if (args[0] !== "list") throw new Error(`Unknown harness suite action: ${args[0] ?? ""}`);
    printValue(registry.listSuites().map((suite) => ({
      ...suite,
      cases: registry.getCases(suite.suiteId, suite.suiteVersion).map((testCase) => ({ caseId: testCase.caseId, level: testCase.level, title: testCase.title, adapter: testCase.adapter })),
    })), outputFormat(parsed));
    return;
  }
  if (action === "patterns") {
    const requested = Number(optionalOption(parsed, "min-samples") ?? "3");
    assertValue(Number.isInteger(requested) && requested >= 2, "--min-samples must be an integer >= 2");
    const scopeByRun = new Map(store.listRuns().map((run) => {
      const scope = store.requireTask(run.taskId).scope;
      return [run.id, scope === "personal" || scope === "work" ? scope : "unknown"] as [string, OuterScope];
    }));
    const observations = extractFailureObservations(store.listEvents(), scopeByRun);
    printValue({ version: "ikb-outer-loop.v1", observations: observations.length, candidates: buildImprovementCandidates(observations, requested) }, outputFormat(parsed));
    return;
  }
  if (action === "repair") {
    const suiteId = optionalOption(parsed, "suite") ?? IKB_RUN_QUALITY_SUITE_ID;
    const suite = registry.getSuite(suiteId);
    if (suite.adapter === "work-harness") throw new Error("Work Harness repair is task-directory scoped; run harness eval --task-dir for each terminal task");
    const limit = Number(optionalOption(parsed, "limit") ?? "100");
    printValue(repairRunEvaluations(store, registry, { projectRoot: evalPlaneRoot(), suiteId, limit }), outputFormat(parsed));
    return;
  }
  if (action === "report") {
    const suiteId = requiredOption(parsed, "suite");
    const suite = registry.getSuite(suiteId);
    const beforePath = optionalOption(parsed, "before");
    const afterPath = optionalOption(parsed, "after");
    if (Boolean(beforePath) !== Boolean(afterPath)) throw new Error("--before and --after must be provided together");
    if (beforePath && afterPath) {
      const before = readEvalResults(beforePath);
      const after = readEvalResults(afterPath);
      const comparison = compareEvalResults(before, after);
      if (comparison.suiteId !== suiteId) throw new Error(`Eval comparison suite mismatch: expected ${suiteId}, got ${comparison.suiteId}`);
      printValue(comparison, outputFormat(parsed));
      return;
    }
    const runId = optionalOption(parsed, "run");
    const taskDir = optionalOption(parsed, "task-dir");
    if (suite.kind === "run_assessment") {
      if (suite.adapter === "work-harness") {
        if (!taskDir) throw new Error(`Work Run Assessment report ${suiteId} requires --task-dir <path>`);
        if (runId) throw new Error("Work Run Assessment uses --task-dir, not --run");
        const persisted = loadLatestWorkRunEvaluation(resolve(taskDir), registry, suiteId);
        if (!persisted) throw new Error(`Work task ${taskDir} has no persisted ${suiteId} assessment`);
        printValue(persisted.report, outputFormat(parsed));
        return;
      }
      if (!runId) throw new Error(`Run Assessment report ${suiteId} requires --run <run-id>`);
      if (taskDir) throw new Error("IKB Run Assessment uses --run, not --task-dir");
      const persisted = loadLatestRunEvaluation(store, registry, runId, suiteId);
      if (!persisted) throw new Error(`Run ${runId} has no persisted ${suiteId} assessment`);
      printValue(persisted.report, outputFormat(parsed));
      return;
    }
    if (runId || taskDir) throw new Error(`Regression Suite ${suiteId} cannot be reported as a real Run assessment`);
    const projectRoot = evalPlaneRoot();
    const output = runEvalSuite(registry, suiteId, { projectRoot });
    printValue(output.report, outputFormat(parsed));
    return;
  }
  if (action !== "eval") throw new Error(`Unknown harness action: ${action ?? ""}`);
  const caseId = optionalOption(parsed, "case");
  const suiteId = optionalOption(parsed, "suite");
  if (suiteId) {
    const projectRoot = evalPlaneRoot();
    const runId = optionalOption(parsed, "run");
    const taskDir = optionalOption(parsed, "task-dir");
    const suite = registry.getSuite(suiteId);
    if (suite.kind === "run_assessment") {
      if (caseId) throw new Error("A persisted Run Assessment must execute the complete Suite; omit --case");
      if (suite.adapter === "work-harness") {
        if (!taskDir) throw new Error(`Work Run Assessment Suite ${suiteId} requires --task-dir <path>`);
        if (runId) throw new Error("Work Run Assessment uses --task-dir, not --run");
        printValue(coordinateWorkRunEvaluation(resolve(taskDir), registry, { projectRoot, suiteId }), outputFormat(parsed));
        return;
      }
      if (!runId) throw new Error(`Run Assessment Suite ${suiteId} requires --run <run-id>`);
      if (taskDir) throw new Error("IKB Run Assessment uses --run, not --task-dir");
      printValue(coordinateRunEvaluation(store, registry, runId, { projectRoot, suiteId }), outputFormat(parsed));
      return;
    }
    if (runId || taskDir) throw new Error(`Regression Suite ${suiteId} cannot write an evaluation to a real Run`);
    const output = runEvalSuite(registry, suiteId, { projectRoot, caseId });
    const artifact = persistEvalReport(store.home, output.report);
    printValue({ ...output, artifact, evaluationEvent: null }, outputFormat(parsed));
    return;
  }
  if (!caseId) {
    printValue(evaluateHarnessSuite(), outputFormat(parsed));
    return;
  }
  const testCase = harnessEvaluationCases().find((item) => item.caseId === caseId);
  if (!testCase) throw new Error(`Harness evaluation case not found: ${caseId}`);
  printValue(evaluateHarnessCase(testCase), outputFormat(parsed));
}
