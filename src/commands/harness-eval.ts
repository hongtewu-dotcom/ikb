import { LedgerStore } from "../store.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertValue, printValue } from "../format.ts";
import { evaluateHarnessCase, evaluateHarnessSuite, harnessEvaluationCases } from "../../projects/eval-plane/src/harness-eval.ts";
import { createDefaultEvalRegistry } from "../../projects/eval-plane/src/eval-registry.ts";
import { compareEvalResults, runEvalSuite } from "../../projects/eval-plane/src/eval-runner.ts";
import { coordinateRunEvaluation, loadLatestRunEvaluation, repairRunEvaluations } from "../../projects/eval-plane/src/evaluation-coordinator.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "../../projects/eval-plane/src/run-assessment.ts";
import { coordinateWorkRunEvaluation, loadLatestWorkRunEvaluation } from "../../projects/eval-plane/src/work-evaluation-coordinator.ts";
import { evaluateCampaignFiles } from "../../projects/eval-plane/src/campaign-cli.ts";
import {
  AGENT_TEAM_ROLLOUT_COLLECTION_SCHEMA,
  collectAgentTeamRollouts,
  runAgentTeamCampaign,
  type AgentTeamCollectionReport,
} from "../../projects/eval-plane/src/agent-team-rollout.ts";
import { buildImprovementCandidates, extractFailureObservations, type OuterScope } from "../outer-loop.ts";
import { evalPlaneRoot, persistEvalReport, readEvalResults } from "./evaluation.ts";
import { type ParsedArgs, optionalOption, outputFormat, requiredOption } from "./shared.ts";

export function handleHarness(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (action === "agent-team") {
    const operation = args[0];
    const requestedRoots = optionalOption(parsed, "sessions-root");
    const sessionRoots = requestedRoots
      ? requestedRoots.split(",").map((value) => resolve(value.trim())).filter(Boolean)
      : [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")];
    if (operation === "collect") {
      try {
        printValue(collectAgentTeamRollouts({
          sessionRoots,
          outputRoot: resolve(store.home, "evaluations", "agent-team-rollouts"),
          from: optionalOption(parsed, "from"),
          to: optionalOption(parsed, "to"),
          skillFilter: "installed",
          expectedInstallation: { marketplace: "ikb-agent-team", plugin: "agent-teams", version: "2.0.0" },
        }), outputFormat(parsed));
      } catch (error) {
        if (parsed.options["fail-open"] !== true) throw error;
        const unavailable: AgentTeamCollectionReport = {
          schema: AGENT_TEAM_ROLLOUT_COLLECTION_SCHEMA,
          status: "unavailable",
          window: { from: optionalOption(parsed, "from") ?? "unknown", to: optionalOption(parsed, "to") ?? "unknown" },
          scannedFiles: 0,
          completedRootTurns: 0,
          matchedRootTurns: 0,
          persisted: 0,
          reused: 0,
          skippedIncomplete: 0,
          issues: [{ reasonCode: "collector_unavailable", count: 1 }],
          artifacts: [],
        };
        printValue(unavailable, outputFormat(parsed));
      }
      return;
    }
    if (operation === "campaign") {
      printValue(runAgentTeamCampaign({
        manifestPath: resolve(requiredOption(parsed, "manifest")),
        samplesPath: resolve(requiredOption(parsed, "samples")),
        sessionRoots,
        telemetryRoot: resolve(store.home, "evaluations", "agent-team-rollouts"),
        resultRoot: resolve(store.home, "evaluations", "agent-team-campaign-results"),
        observationsRoot: resolve(store.home, "evaluations", "agent-team-campaign-inputs"),
        campaignReportRoot: resolve(store.home, "evaluations", "campaigns"),
      }), outputFormat(parsed));
      return;
    }
    throw new Error(`Unknown harness agent-team action: ${operation ?? ""}`);
  }
  if (action === "campaign") {
    const manifestPath = resolve(requiredOption(parsed, "manifest"));
    const observationsPath = resolve(requiredOption(parsed, "observations"));
    const requestedReportRoot = optionalOption(parsed, "report-dir");
    const reportRoot = requestedReportRoot ? resolve(requestedReportRoot) : resolve(store.home, "evaluations", "campaigns");
    printValue(evaluateCampaignFiles(manifestPath, observationsPath, reportRoot), outputFormat(parsed));
    return;
  }
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
