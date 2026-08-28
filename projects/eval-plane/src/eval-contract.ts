/**
 * Versioned, deterministic evaluation contract shared by IKB and external
 * Harness adapters.  The contract is deliberately metadata-only: prompts,
 * model output, local paths, URLs and approval payloads are not valid fields.
 */

export const EVAL_SUITE_SCHEMA = "ikb-eval-suite-v1";
export const EVAL_CASE_SCHEMA = "ikb-eval-case-v1";
export const EVAL_RESULT_SCHEMA = "ikb-eval-result-v1";
export const EVAL_REPORT_SCHEMA = "ikb-eval-report-v1";
export const EVAL_VERSION = "v1";
export const DETERMINISTIC_GRADER_VERSION = "deterministic-v1";

export type EvalLevel = "L1" | "L2" | "L3";
export type EvalStatus = "pass" | "fail" | "inconclusive";
export type EvalDiagnosis = "subject" | "grader" | "ground_truth" | "environment" | "unknown";
export type EvalAdapterId = "ikb" | "work-harness" | "specx" | "pipeline";
export type EvalSuiteKind = "regression" | "run_assessment";

export interface EvalSuite {
  schema: typeof EVAL_SUITE_SCHEMA;
  kind: EvalSuiteKind;
  suiteId: string;
  suiteVersion: string;
  harnessId: string;
  levels: EvalLevel[];
  graderVersion: string;
  cases: string[];
  requiredCaseIds?: string[];
  thresholds: Record<string, number>;
  adapter: EvalAdapterId;
}

export interface EvalExpected {
  outcome: string;
  invariants: string[];
}

export interface EvalGrader {
  type: "deterministic" | "llm-judge";
  version: string;
}

export interface EvalCase {
  schema: typeof EVAL_CASE_SCHEMA;
  caseId: string;
  suiteId: string;
  suiteVersion: string;
  level: EvalLevel;
  title: string;
  description: string;
  inputRefs: string[];
  expected: EvalExpected;
  grader: EvalGrader;
  tags: string[];
  adapter: EvalAdapterId;
  legacyCaseId?: string;
}

export interface EvalResult {
  schema: typeof EVAL_RESULT_SCHEMA;
  evalVersion: typeof EVAL_VERSION;
  suiteId: string;
  suiteVersion: string;
  caseId: string;
  harnessId: string;
  runId: string;
  subjectVersion: string;
  graderVersion: string;
  level: EvalLevel;
  expected: string;
  observed: string;
  status: EvalStatus;
  reasonCodes: string[];
  metrics: Record<string, number | boolean | string>;
  evidenceRefs: string[];
  artifactRefs: string[];
  diagnosis: EvalDiagnosis;
}

export interface EvalLevelReport {
  level: EvalLevel;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  failedCaseIds: string[];
  inconclusiveCases?: number;
  inconclusiveCaseIds?: string[];
  reasonCodes: Record<string, number>;
}

export interface EvalReport {
  schema: typeof EVAL_REPORT_SCHEMA;
  evalVersion: typeof EVAL_VERSION;
  kind: EvalSuiteKind;
  suiteId: string;
  suiteVersion: string;
  harnessId: string;
  graderVersion: string;
  runId: string;
  subjectVersion?: string;
  subjectHash?: string;
  evaluationKey?: string;
  hardGatePassed: boolean;
  levels: EvalLevelReport[];
  results: EvalResult[];
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REFERENCE_PATTERN = /^(?:artifact|source|node|run|case|fixture|knowledge|candidate):\/\/[A-Za-z0-9._~:/-]+$/;
const FORBIDDEN_REFERENCE_PATTERN = /^(?:https?:|file:|\/|~|[A-Za-z]:[\\/])/i;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function version(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!VERSION_PATTERN.test(result)) throw new Error(`${label} has an invalid version`);
  return result;
}

function identifier(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!ID_PATTERN.test(result)) throw new Error(`${label} has an invalid identifier`);
  return result;
}

function stringArray(value: unknown, label: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be an array of non-empty strings`);
  const result = value.map((item) => String(item).trim());
  if (!allowEmpty && result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function assertAllowedKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported or unsafe fields: ${unknown.join(",")}`);
}

export function validateReference(value: unknown, label = "reference"): string {
  const reference = requiredString(value, label);
  if (FORBIDDEN_REFERENCE_PATTERN.test(reference) || !REFERENCE_PATTERN.test(reference)) {
    throw new Error(`${label} must be a safe versioned reference, not a path, URL, prompt, output or payload`);
  }
  return reference;
}

export function validateEvalSuite(value: unknown): EvalSuite {
  const row = objectValue(value, "EvalSuite");
  assertAllowedKeys(row, ["schema", "kind", "suiteId", "suiteVersion", "harnessId", "levels", "graderVersion", "cases", "requiredCaseIds", "thresholds", "adapter"], "EvalSuite");
  if (row.schema !== EVAL_SUITE_SCHEMA) throw new Error(`EvalSuite.schema must be ${EVAL_SUITE_SCHEMA}`);
  const suite: EvalSuite = {
    schema: EVAL_SUITE_SCHEMA,
    // v1 suites created before the run-assessment split did not carry kind.
    // Keep those fixtures readable, but normalize them to the conservative
    // regression class at the boundary so every downstream report is typed.
    kind: (row.kind === undefined ? "regression" : requiredString(row.kind, "EvalSuite.kind")) as EvalSuiteKind,
    suiteId: identifier(row.suiteId, "EvalSuite.suiteId"),
    suiteVersion: version(row.suiteVersion, "EvalSuite.suiteVersion"),
    harnessId: identifier(row.harnessId, "EvalSuite.harnessId"),
    levels: stringArray(row.levels, "EvalSuite.levels", false) as EvalLevel[],
    graderVersion: version(row.graderVersion, "EvalSuite.graderVersion"),
    cases: stringArray(row.cases, "EvalSuite.cases", false).map((item) => identifier(item, "EvalSuite.cases[]")),
    thresholds: {},
    adapter: requiredString(row.adapter, "EvalSuite.adapter") as EvalAdapterId,
  };
  if (!["regression", "run_assessment"].includes(suite.kind)) throw new Error("EvalSuite.kind is unsupported");
  if (suite.levels.some((level) => !["L1", "L2", "L3"].includes(level))) throw new Error("EvalSuite.levels contains an unsupported level");
  if (!["ikb", "work-harness", "specx", "pipeline"].includes(suite.adapter)) throw new Error("EvalSuite.adapter is unsupported");
  const thresholds = objectValue(row.thresholds ?? {}, "EvalSuite.thresholds");
  for (const [key, threshold] of Object.entries(thresholds)) {
    if (!ID_PATTERN.test(key) || typeof threshold !== "number" || !Number.isFinite(threshold)) throw new Error("EvalSuite.thresholds must contain finite numeric values");
    suite.thresholds[key] = threshold;
  }
  if (new Set(suite.cases).size !== suite.cases.length) throw new Error("EvalSuite.cases must not contain duplicates");
  if (row.requiredCaseIds !== undefined) {
    const requiredCaseIds = stringArray(row.requiredCaseIds, "EvalSuite.requiredCaseIds", false).map((item) => identifier(item, "EvalSuite.requiredCaseIds[]"));
    if (new Set(requiredCaseIds).size !== requiredCaseIds.length) throw new Error("EvalSuite.requiredCaseIds must not contain duplicates");
    if (requiredCaseIds.some((caseId) => !suite.cases.includes(caseId))) throw new Error("EvalSuite.requiredCaseIds must belong to EvalSuite.cases");
    suite.requiredCaseIds = requiredCaseIds;
  }
  return suite;
}

export function validateEvalCase(value: unknown): EvalCase {
  const row = objectValue(value, "EvalCase");
  assertAllowedKeys(row, ["schema", "caseId", "suiteId", "suiteVersion", "level", "title", "description", "inputRefs", "expected", "grader", "tags", "adapter", "legacyCaseId"], "EvalCase");
  if (row.schema !== EVAL_CASE_SCHEMA) throw new Error(`EvalCase.schema must be ${EVAL_CASE_SCHEMA}`);
  const expected = objectValue(row.expected, "EvalCase.expected");
  const grader = objectValue(row.grader, "EvalCase.grader");
  assertAllowedKeys(expected, ["outcome", "invariants"], "EvalCase.expected");
  assertAllowedKeys(grader, ["type", "version"], "EvalCase.grader");
  const result: EvalCase = {
    schema: EVAL_CASE_SCHEMA,
    caseId: identifier(row.caseId, "EvalCase.caseId"),
    suiteId: identifier(row.suiteId, "EvalCase.suiteId"),
    suiteVersion: version(row.suiteVersion, "EvalCase.suiteVersion"),
    level: requiredString(row.level, "EvalCase.level") as EvalLevel,
    title: requiredString(row.title, "EvalCase.title"),
    description: requiredString(row.description, "EvalCase.description"),
    inputRefs: stringArray(row.inputRefs, "EvalCase.inputRefs", false).map((item) => validateReference(item, "EvalCase.inputRefs[]")),
    expected: {
      outcome: requiredString(expected.outcome, "EvalCase.expected.outcome"),
      invariants: stringArray(expected.invariants ?? [], "EvalCase.expected.invariants"),
    },
    grader: {
      type: requiredString(grader.type, "EvalCase.grader.type") as EvalGrader["type"],
      version: version(grader.version, "EvalCase.grader.version"),
    },
    tags: stringArray(row.tags ?? [], "EvalCase.tags"),
    adapter: requiredString(row.adapter, "EvalCase.adapter") as EvalAdapterId,
    legacyCaseId: row.legacyCaseId === undefined ? undefined : identifier(row.legacyCaseId, "EvalCase.legacyCaseId"),
  };
  if (!["L1", "L2", "L3"].includes(result.level)) throw new Error("EvalCase.level is unsupported");
  if (!["deterministic", "llm-judge"].includes(result.grader.type)) throw new Error("EvalCase.grader.type is unsupported");
  if (!["ikb", "work-harness", "specx", "pipeline"].includes(result.adapter)) throw new Error("EvalCase.adapter is unsupported");
  return result;
}

export function validateEvalResult(value: unknown): EvalResult {
  const row = objectValue(value, "EvalResult");
  assertAllowedKeys(row, ["schema", "evalVersion", "suiteId", "suiteVersion", "caseId", "harnessId", "runId", "subjectVersion", "graderVersion", "level", "expected", "observed", "status", "reasonCodes", "metrics", "evidenceRefs", "artifactRefs", "diagnosis"], "EvalResult");
  if (row.schema !== EVAL_RESULT_SCHEMA) throw new Error(`EvalResult.schema must be ${EVAL_RESULT_SCHEMA}`);
  const metricsRow = objectValue(row.metrics ?? {}, "EvalResult.metrics");
  const metrics: Record<string, number | boolean | string> = {};
  for (const [key, metric] of Object.entries(metricsRow)) {
    // Approval presence is a safe quality metric; only raw approval objects or
    // payload-like fields are forbidden from the derived result contract.
    const unsafeKey = /(?:prompt|output|path|url|payload)/i.test(key) || /^(?:approval|approvalPayload|approvalRequest|approvalDecision)$/i.test(key);
    if (!ID_PATTERN.test(key) || unsafeKey || (typeof metric !== "string" && typeof metric !== "number" && typeof metric !== "boolean") || (typeof metric === "number" && !Number.isFinite(metric)) || (typeof metric === "string" && /^(?:https?:|file:|\/|~)/i.test(metric))) {
      throw new Error("EvalResult.metrics must contain scalar finite values");
    }
    metrics[key] = metric;
  }
  const result: EvalResult = {
    schema: EVAL_RESULT_SCHEMA,
    evalVersion: row.evalVersion === EVAL_VERSION ? EVAL_VERSION : version(row.evalVersion, "EvalResult.evalVersion") as typeof EVAL_VERSION,
    suiteId: identifier(row.suiteId, "EvalResult.suiteId"),
    suiteVersion: version(row.suiteVersion, "EvalResult.suiteVersion"),
    caseId: identifier(row.caseId, "EvalResult.caseId"),
    harnessId: identifier(row.harnessId, "EvalResult.harnessId"),
    runId: requiredString(row.runId, "EvalResult.runId"),
    subjectVersion: version(row.subjectVersion, "EvalResult.subjectVersion"),
    graderVersion: version(row.graderVersion, "EvalResult.graderVersion"),
    level: requiredString(row.level, "EvalResult.level") as EvalLevel,
    expected: requiredString(row.expected, "EvalResult.expected"),
    observed: requiredString(row.observed, "EvalResult.observed"),
    status: requiredString(row.status, "EvalResult.status") as EvalStatus,
    reasonCodes: stringArray(row.reasonCodes ?? [], "EvalResult.reasonCodes"),
    metrics,
    evidenceRefs: stringArray(row.evidenceRefs ?? [], "EvalResult.evidenceRefs").map((item) => validateReference(item, "EvalResult.evidenceRefs[]")),
    artifactRefs: stringArray(row.artifactRefs ?? [], "EvalResult.artifactRefs").map((item) => validateReference(item, "EvalResult.artifactRefs[]")),
    diagnosis: requiredString(row.diagnosis, "EvalResult.diagnosis") as EvalDiagnosis,
  };
  if (!["L1", "L2", "L3"].includes(result.level)) throw new Error("EvalResult.level is unsupported");
  if (!["pass", "fail", "inconclusive"].includes(result.status)) throw new Error("EvalResult.status is unsupported");
  if (!["subject", "grader", "ground_truth", "environment", "unknown"].includes(result.diagnosis)) throw new Error("EvalResult.diagnosis is unsupported");
  return result;
}

export function assertUniqueSuiteKey(suite: EvalSuite, existing: Iterable<EvalSuite>): void {
  const key = `${suite.suiteId}@${suite.suiteVersion}`;
  for (const item of existing) if (`${item.suiteId}@${item.suiteVersion}` === key) throw new Error(`EvalSuite already registered: ${key}`);
}
