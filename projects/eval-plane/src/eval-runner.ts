import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { evaluateHarnessCase, harnessEvaluationCases } from "./harness-eval.ts";
import type { EvalCase, EvalLevel, EvalReport, EvalResult, EvalSuite } from "./eval-contract.ts";
import { EVAL_REPORT_SCHEMA, EVAL_RESULT_SCHEMA, EVAL_VERSION, validateEvalResult } from "./eval-contract.ts";
import { getEvalAdapter } from "./eval-adapters.ts";
import type { EvalSubject } from "./eval-adapters.ts";
import type { EvalRegistry } from "./eval-registry.ts";

export interface EvalRunOptions {
  projectRoot: string;
  runId?: string;
  caseId?: string;
  subject?: EvalSubject;
}

export interface EvalRunOutput {
  suite: EvalSuite;
  results: EvalResult[];
  report: EvalReport;
}

function safeArtifactRef(caseId: string): string {
  return `artifact://eval/${caseId}`;
}

function fixturePath(projectRoot: string, reference: string): string {
  const prefix = "fixture://";
  if (!reference.startsWith(prefix)) throw new Error(`Eval fixture reference must start with ${prefix}`);
  const relativePath = normalize(reference.slice(prefix.length));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`Unsafe Eval fixture reference: ${reference}`);
  const root = resolve(projectRoot, "fixtures");
  const candidate = resolve(root, relativePath);
  if (relative(root, candidate).startsWith("..")) throw new Error(`Eval fixture escapes evals directory: ${reference}`);
  return candidate;
}

function readFixture(projectRoot: string, testCase: EvalCase): unknown {
  const reference = testCase.inputRefs.find((item) => item.startsWith("fixture://"));
  if (!reference) throw new Error(`EvalCase ${testCase.caseId} has no fixture reference`);
  return JSON.parse(readFileSync(fixturePath(projectRoot, reference), "utf8"));
}

function legacyResult(testCase: EvalCase, runId: string): EvalResult {
  const legacyId = testCase.legacyCaseId ?? testCase.caseId;
  const legacy = harnessEvaluationCases().find((item) => item.caseId === legacyId);
  if (!legacy) throw new Error(`Legacy Harness case not found: ${legacyId}`);
  const evaluated = evaluateHarnessCase(legacy);
  return validateEvalResult({
    schema: EVAL_RESULT_SCHEMA,
    evalVersion: EVAL_VERSION,
    suiteId: testCase.suiteId,
    suiteVersion: testCase.suiteVersion,
    caseId: testCase.caseId,
    harnessId: "ikb",
    runId,
    subjectVersion: "harness-eval.v1",
    graderVersion: testCase.grader.version,
    level: testCase.level,
    expected: testCase.expected.outcome,
    observed: evaluated.observed,
    status: evaluated.passed ? "pass" : "fail",
    reasonCodes: evaluated.failedInvariants,
    metrics: evaluated.metrics,
    evidenceRefs: [`case://${testCase.caseId}`],
    artifactRefs: [safeArtifactRef(testCase.caseId)],
    diagnosis: evaluated.passed ? "subject" : "subject",
  });
}

function adapterResult(testCase: EvalCase, suite: EvalSuite, runId: string, projectRoot: string, suppliedSubject?: EvalSubject): EvalResult {
  const adapter = getEvalAdapter(testCase.adapter);
  const subject = suppliedSubject ?? adapter.load(readFixture(projectRoot, testCase));
  if (subject.adapter !== testCase.adapter) throw new Error(`EvalSubject adapter mismatch: expected ${testCase.adapter}, got ${subject.adapter}`);
  const evaluated = adapter.evaluate(testCase, subject, suite.thresholds);
  const status = evaluated.status ?? (evaluated.passed ? "pass" : "fail");
  return validateEvalResult({
    schema: EVAL_RESULT_SCHEMA,
    evalVersion: EVAL_VERSION,
    suiteId: testCase.suiteId,
    suiteVersion: testCase.suiteVersion,
    caseId: testCase.caseId,
    harnessId: testCase.adapter,
    runId,
    subjectVersion: subject.subjectVersion,
    graderVersion: testCase.grader.version,
    level: testCase.level,
    expected: testCase.expected.outcome,
    observed: evaluated.observed,
    status,
    reasonCodes: evaluated.reasonCodes,
    metrics: evaluated.metrics,
    evidenceRefs: evaluated.evidenceRefs,
    artifactRefs: evaluated.artifactRefs,
    diagnosis: evaluated.diagnosis,
  });
}

export function buildEvalReport(suite: EvalSuite, results: EvalResult[], runId: string, subject?: EvalSubject): EvalReport {
  const levels: EvalLevel[] = ["L1", "L2", "L3"];
  const levelReports = levels.filter((level) => suite.levels.includes(level)).map((level) => {
    const levelResults = results.filter((result) => result.level === level);
    const reasonCodes: Record<string, number> = {};
    for (const result of levelResults.filter((item) => item.status !== "pass")) {
      for (const code of result.reasonCodes) reasonCodes[code] = (reasonCodes[code] ?? 0) + 1;
    }
    return {
      level,
      totalCases: levelResults.length,
      passedCases: levelResults.filter((result) => result.status === "pass").length,
      failedCases: levelResults.filter((result) => result.status === "fail").length,
      failedCaseIds: levelResults.filter((result) => result.status === "fail").map((result) => result.caseId),
      ...(levelResults.some((result) => result.status === "inconclusive") ? {
        inconclusiveCases: levelResults.filter((result) => result.status === "inconclusive").length,
        inconclusiveCaseIds: levelResults.filter((result) => result.status === "inconclusive").map((result) => result.caseId),
      } : {}),
      reasonCodes,
    };
  });
  const hasRequiredCases = suite.requiredCaseIds !== undefined;
  const requiredResultsPassed = hasRequiredCases
    ? suite.requiredCaseIds!.length > 0 && suite.requiredCaseIds!.every((caseId) => {
      const matches = results.filter((result) => result.caseId === caseId);
      return matches.length === 1 && matches[0].status === "pass";
    })
    : undefined;
  const levelOnePassed = results.filter((result) => result.level === "L1").every((result) => result.status === "pass");
  const requiredDomainGatesPassed = results
    .filter((result) => result.caseId === "work-run-domain-result" && result.metrics.required === true)
    .every((result) => result.status === "pass");
  const hardGatePassed = hasRequiredCases ? requiredResultsPassed === true : levelOnePassed && requiredDomainGatesPassed;
  return {
    schema: EVAL_REPORT_SCHEMA,
    evalVersion: EVAL_VERSION,
    kind: suite.kind,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    harnessId: suite.harnessId,
    graderVersion: suite.graderVersion,
    runId,
    ...(subject?.subjectVersion ? { subjectVersion: subject.subjectVersion } : {}),
    ...(subject?.subjectHash ? { subjectHash: subject.subjectHash } : {}),
    hardGatePassed,
    levels: levelReports,
    results,
  };
}

export function runEvalSuite(registry: EvalRegistry, suiteId: string, options: EvalRunOptions): EvalRunOutput {
  const suite = registry.getSuite(suiteId);
  if (suite.kind === "run_assessment" && !options.subject) throw new Error(`Run Assessment Suite ${suite.suiteId} requires a real RunSubject`);
  if (suite.kind === "regression" && options.subject) throw new Error(`Regression Suite ${suite.suiteId} does not accept a real RunSubject`);
  if (options.subject?.runId && options.runId && options.subject.runId !== options.runId) throw new Error(`Eval RunSubject mismatch: expected ${options.runId}, got ${options.subject.runId}`);
  const runId = options.subject?.runId ?? options.runId ?? `replay:${suite.suiteId}@${suite.suiteVersion}`;
  const cases = registry.getCases(suite.suiteId, suite.suiteVersion).filter((testCase) => !options.caseId || testCase.caseId === options.caseId);
  if (cases.length === 0) throw new Error(`EvalCase not found in suite ${suite.suiteId}: ${options.caseId}`);
  const results = cases.map((testCase) => testCase.legacyCaseId
    ? legacyResult(testCase, runId)
    : adapterResult(testCase, suite, runId, options.projectRoot, options.subject));
  return { suite, results, report: buildEvalReport(suite, results, runId, options.subject) };
}

export interface EvalComparison {
  schema: "ikb-eval-comparison-v1";
  suiteId: string;
  beforeRunId: string;
  afterRunId: string;
  changedCases: Array<{ caseId: string; before: EvalResult["status"] | "missing"; after: EvalResult["status"]; beforeReasons: string[]; afterReasons: string[] }>;
  newlyPassing: string[];
  newlyFailing: string[];
  unchanged: string[];
}

export function compareEvalResults(before: EvalResult[], after: EvalResult[]): EvalComparison {
  const beforeById = new Map(before.map((result) => [result.caseId, result]));
  const afterById = new Map(after.map((result) => [result.caseId, result]));
  const changedCases: EvalComparison["changedCases"] = [];
  const newlyPassing: string[] = [];
  const newlyFailing: string[] = [];
  const unchanged: string[] = [];
  for (const [caseId, next] of afterById) {
    const previous = beforeById.get(caseId);
    if (!previous) {
      changedCases.push({ caseId, before: "missing", after: next.status, beforeReasons: ["case_not_in_before"], afterReasons: next.reasonCodes });
      if (next.status === "pass") newlyPassing.push(caseId);
      continue;
    }
    if (previous.status === next.status && previous.reasonCodes.join("|") === next.reasonCodes.join("|")) unchanged.push(caseId);
    else {
      changedCases.push({ caseId, before: previous.status, after: next.status, beforeReasons: previous.reasonCodes, afterReasons: next.reasonCodes });
      if (previous.status !== "pass" && next.status === "pass") newlyPassing.push(caseId);
      if (previous.status !== "fail" && next.status === "fail") newlyFailing.push(caseId);
    }
  }
  const first = after[0] ?? before[0];
  return { schema: "ikb-eval-comparison-v1", suiteId: first?.suiteId ?? "unknown", beforeRunId: before[0]?.runId ?? "unknown", afterRunId: after[0]?.runId ?? "unknown", changedCases, newlyPassing, newlyFailing, unchanged };
}
