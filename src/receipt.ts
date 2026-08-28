import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerStore } from "./store.ts";
import { ikbPaths } from "./layout.ts";

export const RECEIPT_SCHEMA = "ikb-receipt.v1";

export const RECEIPT_KINDS = [
  "remember",
  "usage",
  "feedback",
  "knowledge_maintenance",
  "source_sync",
  "semantic_maintenance",
  "weekly",
] as const;

export type ReceiptKind = typeof RECEIPT_KINDS[number];

export interface ReceiptValidation {
  status: "passed" | "failed" | "skipped";
  checks: string[];
  issues: string[];
}

export interface ReceiptOperation {
  action: string;
  subjectRef: string | null;
  inputRefs: string[];
  outputRefs: string[];
  sourceRefs: string[];
  beforeHash: string | null;
  afterHash: string | null;
  applicability: string | null;
  boundary: string | null;
  validation: ReceiptValidation;
  outcome: string;
  confirmation: {
    actor: string;
    confirmedAt: string;
    exactTextHash: string;
  } | null;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  id: string;
  kind: ReceiptKind;
  scope: "personal" | "work" | "all";
  command: string;
  startedAt: string;
  finishedAt: string;
  outcome: "succeeded" | "partial" | "failed";
  operations: ReceiptOperation[];
}

export interface WrittenReceipt extends Receipt {
  path: string;
  contentHash: string;
}

export function receiptRoot(home: string): string {
  return ikbPaths(home).receipts;
}

export function writeReceipt(
  home: string,
  store: LedgerStore,
  input: Omit<Receipt, "schema" | "id" | "finishedAt"> & { finishedAt?: string },
): WrittenReceipt {
  if (!RECEIPT_KINDS.includes(input.kind)) throw new Error(`Unsupported Receipt kind: ${input.kind}`);
  if (!input.command.trim()) throw new Error("Receipt command must not be empty");
  const operations = input.operations.map(normalizeOperation);
  const id = `receipt-${new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA,
    id,
    kind: input.kind,
    scope: input.scope,
    command: input.command.trim(),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    outcome: input.outcome,
    operations,
  };
  const directory = receiptRoot(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${id}.json`);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  const contentHash = createHash("sha256").update(content).digest("hex");
  store.recordReceiptEvent(id, {
    schema: RECEIPT_SCHEMA,
    kind: receipt.kind,
    scope: receipt.scope,
    command: receipt.command,
    outcome: receipt.outcome,
    operationCount: receipt.operations.length,
    path,
    contentHash,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
  });
  return { ...receipt, path, contentHash };
}

function normalizeOperation(operation: ReceiptOperation): ReceiptOperation {
  const result: ReceiptOperation = {
    action: operation.action.trim(),
    subjectRef: cleanNullable(operation.subjectRef),
    inputRefs: unique(operation.inputRefs),
    outputRefs: unique(operation.outputRefs),
    sourceRefs: unique(operation.sourceRefs),
    beforeHash: cleanNullable(operation.beforeHash),
    afterHash: cleanNullable(operation.afterHash),
    applicability: cleanNullable(operation.applicability),
    boundary: cleanNullable(operation.boundary),
    validation: {
      status: operation.validation.status,
      checks: unique(operation.validation.checks),
      issues: unique(operation.validation.issues),
    },
    outcome: operation.outcome.trim(),
    confirmation: operation.confirmation,
  };
  if (!result.action || !result.outcome) throw new Error("Receipt operation requires action and outcome");
  if (["new", "update", "retire"].includes(result.action)) {
    if (result.sourceRefs.length === 0) throw new Error(`${result.action} Receipt operation requires Source refs`);
    if (result.afterHash === null) throw new Error(`${result.action} Receipt operation requires an after hash`);
    if (result.action !== "new" && result.beforeHash === null) throw new Error(`${result.action} Receipt operation requires a before hash`);
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function cleanNullable(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
