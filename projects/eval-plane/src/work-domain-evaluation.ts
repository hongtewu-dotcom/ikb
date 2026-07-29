import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const WORK_DOMAIN_EVALUATION_SCHEMA = "work-harness-domain-evaluation-v1";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_REFERENCE_PATTERN = /^(?:artifact|source|node|run|case|knowledge|candidate):\/\/[A-Za-z0-9._~:/-]+$/;
const ISO_8601_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DOMAIN_EVALUATION_KEYS = new Set([
  "schema",
  "task_id",
  "run_id",
  "suite_id",
  "suite_version",
  "grader_version",
  "required",
  "hard_gate_passed",
  "result",
  "report_ref",
  "report_hash",
  "metrics",
  "evidence_refs",
  "evaluated_at",
]);

type Row = Record<string, unknown>;
export type WorkDomainMetric = string | number | boolean;

export interface WorkDomainEvaluationSubject {
  registered: boolean;
  valid: boolean;
  taskId: string | null;
  runId: string | null;
  suiteId: string | null;
  suiteVersion: string | null;
  graderVersion: string | null;
  required: boolean;
  hardGatePassed: boolean;
  result: "pass" | "blocked" | "invalid" | "not_applicable";
  reportRef: string | null;
  reportHash: string | null;
  reportContentHash: string | null;
  metrics: Record<string, WorkDomainMetric>;
  evidenceRefs: string[];
  evaluatedAt: string | null;
  contentHash: string | null;
  reasonCodes: string[];
}

export function loadWorkDomainEvaluation(taskDir: string, expectedTaskId: string, expectedRunId: string): WorkDomainEvaluationSubject {
  const path = resolve(taskDir, "domain-evaluation.json");
  if (!existsSync(path)) return notRegistered();
  const reasonCodes: string[] = [];
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return invalidProjection(["domain_evaluation_file_invalid"]);
  }
  const bytes = readFileSync(path);
  const contentHash = sha256(bytes);
  let row: Row;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidProjection(["domain_evaluation_json_invalid"], contentHash);
    }
    row = value as Row;
  } catch {
    return invalidProjection(["domain_evaluation_json_invalid"], contentHash);
  }

  if (Object.keys(row).some((key) => !DOMAIN_EVALUATION_KEYS.has(key)) || [...DOMAIN_EVALUATION_KEYS].some((key) => !(key in row))) {
    reasonCodes.push("domain_evaluation_contract_invalid");
  }
  if (row.schema !== WORK_DOMAIN_EVALUATION_SCHEMA) reasonCodes.push("domain_evaluation_schema_invalid");

  const taskId = safeIdentifier(row.task_id);
  const runId = safeIdentifier(row.run_id);
  const suiteId = safeIdentifier(row.suite_id);
  const suiteVersion = safeVersion(row.suite_version);
  const graderVersion = safeVersion(row.grader_version);
  if (!taskId) reasonCodes.push("domain_evaluation_task_id_invalid");
  else if (taskId !== expectedTaskId) reasonCodes.push("domain_evaluation_task_id_mismatch");
  if (!runId) reasonCodes.push("domain_evaluation_run_id_invalid");
  else if (runId !== expectedRunId) reasonCodes.push("domain_evaluation_run_id_mismatch");
  if (!suiteId) reasonCodes.push("domain_evaluation_suite_id_invalid");
  if (!suiteVersion) reasonCodes.push("domain_evaluation_suite_version_invalid");
  if (!graderVersion) reasonCodes.push("domain_evaluation_grader_version_invalid");

  const required = typeof row.required === "boolean" ? row.required : true;
  const hardGatePassed = typeof row.hard_gate_passed === "boolean" ? row.hard_gate_passed : false;
  if (typeof row.required !== "boolean") reasonCodes.push("domain_evaluation_required_invalid");
  if (typeof row.hard_gate_passed !== "boolean") reasonCodes.push("domain_evaluation_hard_gate_invalid");
  const result = row.result === "pass" || row.result === "blocked" ? row.result : "invalid";
  if (result === "invalid") reasonCodes.push("domain_evaluation_result_invalid");
  else if ((result === "pass") !== hardGatePassed) reasonCodes.push("domain_evaluation_result_mismatch");

  const reportRef = safeFileReference(row.report_ref);
  const reportHash = typeof row.report_hash === "string" && SHA256_PATTERN.test(row.report_hash) ? row.report_hash : null;
  if (!reportRef) reasonCodes.push("domain_evaluation_report_ref_invalid");
  if (!reportHash) reasonCodes.push("domain_evaluation_report_hash_invalid");
  const report = validateReport(taskDir, reportRef, reportHash, reasonCodes);

  const metrics = safeMetrics(row.metrics);
  if (!metrics) reasonCodes.push("domain_evaluation_metrics_invalid");
  const evidenceRefs = safeEvidenceRefs(row.evidence_refs);
  if (!evidenceRefs) reasonCodes.push("domain_evaluation_evidence_refs_invalid");
  const evaluatedAt = safeEvaluatedAt(row.evaluated_at);
  if (!evaluatedAt) reasonCodes.push("domain_evaluation_evaluated_at_invalid");

  return {
    registered: true,
    valid: reasonCodes.length === 0,
    taskId,
    runId,
    suiteId,
    suiteVersion,
    graderVersion,
    required,
    hardGatePassed,
    result,
    reportRef,
    reportHash,
    reportContentHash: report.contentHash,
    metrics: metrics ?? {},
    evidenceRefs: evidenceRefs ?? [],
    evaluatedAt,
    contentHash,
    reasonCodes: unique(reasonCodes),
  };
}

function validateReport(
  taskDir: string,
  reportRef: string | null,
  reportHash: string | null,
  reasonCodes: string[],
): { contentHash: string | null } {
  if (!reportRef) return { contentHash: null };
  const referencePath = reportRef.slice("file://".length);
  const path = isAbsolute(referencePath) ? resolve(referencePath) : resolve(taskDir, referencePath);
  let descriptor: number | null = null;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      reasonCodes.push("domain_evaluation_report_file_invalid");
      return { contentHash: null };
    }
    const contentHash = sha256(readFileSync(descriptor));
    if (reportHash && contentHash !== reportHash) reasonCodes.push("domain_evaluation_report_hash_mismatch");
    return { contentHash };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    reasonCodes.push(code === "ENOENT" ? "domain_evaluation_report_missing" : "domain_evaluation_report_file_invalid");
    return { contentHash: null };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function safeMetrics(value: unknown): Record<string, WorkDomainMetric> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metrics: Record<string, WorkDomainMetric> = {};
  for (const [key, metric] of Object.entries(value as Row)) {
    const unsafeKey = /(?:prompt|output|path|url|payload)/i.test(key) || /^(?:approval|approvalPayload|approvalRequest|approvalDecision)$/i.test(key);
    if (!ID_PATTERN.test(key) || unsafeKey) return null;
    if (typeof metric === "string") {
      const normalized = metric.trim();
      if (!normalized || /^(?:https?:|file:|\/|~)/i.test(normalized)) return null;
      metrics[key] = normalized;
      continue;
    }
    if (typeof metric === "number" && Number.isFinite(metric)) {
      metrics[key] = metric;
      continue;
    }
    if (typeof metric === "boolean") {
      metrics[key] = metric;
      continue;
    }
    return null;
  }
  return metrics;
}

function safeEvidenceRefs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return null;
    const reference = item.trim();
    if (!SAFE_REFERENCE_PATTERN.test(reference) && !safeFileReference(reference)) return null;
    result.push(reference);
  }
  return result;
}

function safeFileReference(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("file://")) return null;
  const reference = value.trim();
  const path = reference.slice("file://".length);
  return path && !path.includes("\0") ? reference : null;
}

function safeEvaluatedAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_8601_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return null;
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

function notRegistered(): WorkDomainEvaluationSubject {
  return {
    registered: false,
    valid: true,
    taskId: null,
    runId: null,
    suiteId: null,
    suiteVersion: null,
    graderVersion: null,
    required: false,
    hardGatePassed: false,
    result: "not_applicable",
    reportRef: null,
    reportHash: null,
    reportContentHash: null,
    metrics: {},
    evidenceRefs: [],
    evaluatedAt: null,
    contentHash: null,
    reasonCodes: [],
  };
}

function invalidProjection(reasonCodes: string[], contentHash: string | null = null): WorkDomainEvaluationSubject {
  return {
    ...notRegistered(),
    registered: true,
    valid: false,
    required: true,
    result: "invalid",
    contentHash,
    reasonCodes,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
