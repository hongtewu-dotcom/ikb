import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EvalLevel, EvalReport } from "./eval-contract.ts";
import { validateReference } from "./eval-contract.ts";

export const EVAL_RECEIPT_SCHEMA = "ikb-eval-receipt-v1";
export type EvalQualityOutcome = "pass" | "partial" | "blocked" | "inconclusive";

export interface EvalReceiptLevelSummary {
  level: EvalLevel;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  inconclusiveCases: number;
}

export interface EvalReceipt {
  schema: typeof EVAL_RECEIPT_SCHEMA;
  harnessId: string;
  suiteId: string;
  suiteVersion: string;
  graderVersion: string;
  subjectRef: string;
  subjectHash: string;
  evaluationKey: string;
  evaluatedAt: string;
  qualityOutcome: EvalQualityOutcome;
  hardGatePassed: boolean;
  levels: EvalReceiptLevelSummary[];
  reasonCodes: Record<string, number>;
  metrics: Record<string, number | boolean>;
  reportRef: string;
  reportHash: string;
}

export interface PersistedEvalReceipt {
  receipt: EvalReceipt;
  receiptRef: string;
  path: string;
  contentHash: string;
  reused: boolean;
}

export interface BuildEvalReceiptOptions {
  subjectRef: string;
  subjectHash: string;
  evaluationKey?: string;
  evaluatedAt?: string;
  reportRef: string;
  reportHash: string;
  metrics?: Record<string, number | boolean>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_METRIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function buildEvalReceipt(report: EvalReport, options: BuildEvalReceiptOptions): EvalReceipt {
  const evaluationKey = options.evaluationKey ?? report.evaluationKey;
  if (!evaluationKey) throw new Error("EvalReceipt requires an evaluationKey");
  const statuses = report.results.map((result) => result.status);
  const qualityOutcome: EvalQualityOutcome = report.hardGatePassed
    ? (statuses.every((status) => status === "pass") ? "pass" : "partial")
    : (statuses.includes("fail") ? "blocked" : "inconclusive");
  const reasonCodes: Record<string, number> = {};
  for (const result of report.results) {
    if (result.status === "pass") continue;
    for (const reasonCode of result.reasonCodes) reasonCodes[reasonCode] = (reasonCodes[reasonCode] ?? 0) + 1;
  }
  return validateEvalReceipt({
    schema: EVAL_RECEIPT_SCHEMA,
    harnessId: report.harnessId,
    suiteId: report.suiteId,
    suiteVersion: report.suiteVersion,
    graderVersion: report.graderVersion,
    subjectRef: options.subjectRef,
    subjectHash: options.subjectHash,
    evaluationKey,
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    qualityOutcome,
    hardGatePassed: report.hardGatePassed,
    levels: report.levels.map((level) => ({
      level: level.level,
      totalCases: level.totalCases,
      passedCases: level.passedCases,
      failedCases: level.failedCases,
      inconclusiveCases: level.inconclusiveCases ?? 0,
    })),
    reasonCodes,
    metrics: options.metrics ?? {},
    reportRef: options.reportRef,
    reportHash: options.reportHash,
  });
}

export function validateEvalReceipt(value: unknown): EvalReceipt {
  const row = objectValue(value, "EvalReceipt");
  exactKeys(row, [
    "schema", "harnessId", "suiteId", "suiteVersion", "graderVersion", "subjectRef", "subjectHash",
    "evaluationKey", "evaluatedAt", "qualityOutcome", "hardGatePassed", "levels", "reasonCodes", "metrics",
    "reportRef", "reportHash",
  ], "EvalReceipt");
  if (row.schema !== EVAL_RECEIPT_SCHEMA) throw new Error(`EvalReceipt.schema must be ${EVAL_RECEIPT_SCHEMA}`);
  if (typeof row.hardGatePassed !== "boolean") throw new Error("EvalReceipt.hardGatePassed must be boolean");
  if (!Array.isArray(row.levels) || row.levels.length === 0) throw new Error("EvalReceipt.levels must not be empty");
  const levels = row.levels.map((value, index): EvalReceiptLevelSummary => {
    const level = objectValue(value, `EvalReceipt.levels[${index}]`);
    exactKeys(level, ["level", "totalCases", "passedCases", "failedCases", "inconclusiveCases"], `EvalReceipt.levels[${index}]`);
    const result = {
      level: enumValue(level.level, ["L1", "L2", "L3"] as const, `EvalReceipt.levels[${index}].level`),
      totalCases: nonNegativeInteger(level.totalCases, `EvalReceipt.levels[${index}].totalCases`),
      passedCases: nonNegativeInteger(level.passedCases, `EvalReceipt.levels[${index}].passedCases`),
      failedCases: nonNegativeInteger(level.failedCases, `EvalReceipt.levels[${index}].failedCases`),
      inconclusiveCases: nonNegativeInteger(level.inconclusiveCases, `EvalReceipt.levels[${index}].inconclusiveCases`),
    };
    if (result.passedCases + result.failedCases + result.inconclusiveCases !== result.totalCases) {
      throw new Error(`EvalReceipt.levels[${index}] case counts must equal totalCases`);
    }
    return result;
  });
  if (new Set(levels.map((level) => level.level)).size !== levels.length) throw new Error("EvalReceipt.levels must not contain duplicates");
  const reasonCodes = countMap(row.reasonCodes, "EvalReceipt.reasonCodes");
  const metricsRow = objectValue(row.metrics, "EvalReceipt.metrics");
  const metrics: Record<string, number | boolean> = {};
  for (const [key, metric] of Object.entries(metricsRow)) {
    if (!SAFE_METRIC_PATTERN.test(key) || unsafeField(key) || (typeof metric !== "number" && typeof metric !== "boolean") || (typeof metric === "number" && !Number.isFinite(metric))) {
      throw new Error("EvalReceipt.metrics must contain safe finite numeric or boolean scalars");
    }
    metrics[key] = metric;
  }
  return {
    schema: EVAL_RECEIPT_SCHEMA,
    harnessId: identifier(row.harnessId, "EvalReceipt.harnessId"),
    suiteId: identifier(row.suiteId, "EvalReceipt.suiteId"),
    suiteVersion: version(row.suiteVersion, "EvalReceipt.suiteVersion"),
    graderVersion: version(row.graderVersion, "EvalReceipt.graderVersion"),
    subjectRef: validateReference(row.subjectRef, "EvalReceipt.subjectRef"),
    subjectHash: hashValue(row.subjectHash, "EvalReceipt.subjectHash"),
    evaluationKey: hashValue(row.evaluationKey, "EvalReceipt.evaluationKey"),
    evaluatedAt: timestamp(row.evaluatedAt, "EvalReceipt.evaluatedAt"),
    qualityOutcome: enumValue(row.qualityOutcome, ["pass", "partial", "blocked", "inconclusive"] as const, "EvalReceipt.qualityOutcome"),
    hardGatePassed: row.hardGatePassed,
    levels,
    reasonCodes,
    metrics,
    reportRef: validateReference(row.reportRef, "EvalReceipt.reportRef"),
    reportHash: hashValue(row.reportHash, "EvalReceipt.reportHash"),
  };
}

export function persistEvalReceipt(home: string, value: EvalReceipt): PersistedEvalReceipt {
  const receipt = validateEvalReceipt(value);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  const contentHash = sha256(serialized);
  const path = evalReceiptPath(home, receipt.harnessId, receipt.evaluationKey);
  if (existsSync(path)) {
    const existing = readRegularFile(path, "EvalReceipt");
    if (existing !== serialized) throw new Error(`EvalReceipt key collision at ${path}`);
    return { receipt, receiptRef: receiptReference(receipt), path, contentHash, reused: true };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return { receipt, receiptRef: receiptReference(receipt), path, contentHash, reused: false };
}

export function listPendingEvalReceipts(home: string): PersistedEvalReceipt[] {
  const root = evalReceiptPendingRoot(home);
  if (!existsSync(root)) return [];
  const rootEntries = readdirSync(root, { withFileTypes: true });
  const result: PersistedEvalReceipt[] = [];
  for (const harnessEntry of rootEntries) {
    if (!harnessEntry.isDirectory() || !IDENTIFIER_PATTERN.test(harnessEntry.name)) continue;
    const harnessRoot = join(root, harnessEntry.name);
    for (const entry of readdirSync(harnessRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(harnessRoot, entry.name);
      const serialized = readRegularFile(path, "EvalReceipt");
      const receipt = validateEvalReceipt(JSON.parse(serialized));
      if (receipt.harnessId !== harnessEntry.name || `${receipt.evaluationKey}.json` !== entry.name) throw new Error(`EvalReceipt path identity mismatch: ${path}`);
      result.push({ receipt, receiptRef: receiptReference(receipt), path, contentHash: sha256(serialized), reused: true });
    }
  }
  return result.sort((left, right) => left.receipt.evaluatedAt.localeCompare(right.receipt.evaluatedAt) || left.receiptRef.localeCompare(right.receiptRef));
}

export function evalReceiptPendingRoot(home: string): string {
  return resolve(home, "evaluations", "receipts", "pending");
}

export function evalReceiptPath(home: string, harnessId: string, evaluationKey: string): string {
  return resolve(evalReceiptPendingRoot(home), identifier(harnessId, "EvalReceipt.harnessId"), `${hashValue(evaluationKey, "EvalReceipt.evaluationKey")}.json`);
}

export function receiptReference(receipt: Pick<EvalReceipt, "harnessId" | "evaluationKey">): string {
  return validateReference(`artifact://eval-receipt/${receipt.harnessId}/${receipt.evaluationKey}`, "EvalReceipt.ref");
}

function readRegularFile(path: string, label: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function countMap(value: unknown, label: string): Record<string, number> {
  const row = objectValue(value, label);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(row)) {
    if (!IDENTIFIER_PATTERN.test(key) || unsafeField(key) || !Number.isInteger(count) || Number(count) < 1) throw new Error(`${label} must contain positive integer counts`);
    result[key] = Number(count);
  }
  return result;
}

function unsafeField(value: string): boolean {
  return /(?:prompt|output|path|url|payload)/i.test(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in row));
  if (extras.length > 0 || missing.length > 0) throw new Error(`${label} fields do not match the contract`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!IDENTIFIER_PATTERN.test(result)) throw new Error(`${label} has an invalid identifier`);
  return result;
}

function version(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!VERSION_PATTERN.test(result)) throw new Error(`${label} has an invalid version`);
  return result;
}

function hashValue(value: unknown, label: string): string {
  const result = stringValue(value, label).toLowerCase();
  if (!HASH_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  return new Date(Date.parse(result)).toISOString();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const result = stringValue(value, label);
  if (!(allowed as readonly string[]).includes(result)) throw new Error(`${label} has an unsupported value`);
  return result as T[number];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
