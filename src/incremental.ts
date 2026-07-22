import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  hashSourceContent,
  importSourceRecords,
  inspectSourceIntegrity,
  listSources,
  normalizeSourceScope,
  readSourceRecords,
  type SourceImportOptions,
} from "./source.ts";
import type { SourceMessage, SourceRecord } from "./types.ts";

export interface IncrementalImportOptions extends SourceImportOptions {
  /** Stable logical source identity. If omitted, it is derived from refs/path. */
  logicalKey?: string;
  /** Adapter-specific checkpoint (cursor, latest message id, revision, etc.). */
  cursor?: unknown;
}

export interface IncrementalState {
  scanId: string;
  logicalKey: string;
  sourceId: string | null;
  previousSourceIds: string[];
  originalPath: string;
  contentHash: string;
  scannedAt: string;
  status: "imported" | "skipped";
  reason: string;
  recordCount: number;
  deltaCount: number;
  duplicateCount: number;
  changedCount: number;
  cursor: unknown;
}

export interface IncrementalImportResult {
  source: SourceRecord | null;
  imported: boolean;
  skipped: boolean;
  reason: string;
  recordCount: number;
  deltaCount: number;
  duplicateCount: number;
  changedCount: number;
  logicalKey: string;
  previousSourceIds: string[];
  state: IncrementalState;
}

export interface IncrementalStateIssue {
  scope: "personal" | "work";
  path: string;
  code: "incremental_state_symlink" | "incremental_state_not_file" | "incremental_state_malformed";
  detail: string;
}

export interface IncrementalStateInspection {
  entries: IncrementalState[];
  issues: IncrementalStateIssue[];
}

/**
 * Import only records that are new or changed since the last logical source
 * snapshot. Every imported delta remains an immutable Source; the full raw
 * input is copied into that Source so the evidence boundary is preserved.
 */
export function importIncrementalRecords(
  home: string,
  originalPath: string,
  content: string | Uint8Array,
  options: IncrementalImportOptions,
  records: SourceMessage[],
): IncrementalImportResult {
  const scope = normalizeSourceScope(options.scope);
  const sensitivity = options.sensitivity ?? (scope === "personal" ? "private" : "work-internal");
  const resolvedPath = resolve(originalPath);
  const logicalKey = options.logicalKey?.trim() || inferLogicalKey(options, resolvedPath, records);
  const previous = findPreviousSources(home, logicalKey, resolvedPath, options);
  const previousSourceIds = previous.map((source) => source.id);
  const contentHash = hashSourceContent(content);
  const exact = previous.find((source) => source.contentHash === contentHash && inspectSourceIntegrity(home, source).length === 0);
  if (exact) {
    const state = writeState(home, scope, {
      logicalKey,
      sourceId: exact.id,
      previousSourceIds,
      originalPath: resolvedPath,
      contentHash,
      status: "skipped",
      reason: "unchanged",
      recordCount: records.length,
      deltaCount: 0,
      duplicateCount: records.length,
      changedCount: 0,
      cursor: options.cursor ?? null,
    });
    return {
      source: exact,
      imported: false,
      skipped: true,
      reason: "unchanged",
      recordCount: exact.recordCount,
      deltaCount: 0,
      duplicateCount: records.length,
      changedCount: 0,
      logicalKey,
      previousSourceIds,
      state,
    };
  }

  const previousRecords = previous.flatMap((source) => {
    try {
      return readSourceRecords(home, source.id, { verifyRaw: false, source });
    } catch {
      return [];
    }
  });
  const previousFingerprints = new Map<string, string>();
  for (const record of previousRecords) previousFingerprints.set(recordIdentity(record), recordFingerprint(record));

  const currentFingerprints = new Map<string, string>();
  const delta: SourceMessage[] = [];
  let duplicateCount = 0;
  let changedCount = 0;
  for (const record of records) {
    const identity = recordIdentity(record);
    const fingerprint = recordFingerprint(record);
    const current = currentFingerprints.get(identity);
    if (current === fingerprint) {
      duplicateCount += 1;
      continue;
    }
    currentFingerprints.set(identity, fingerprint);
    const prior = previousFingerprints.get(identity);
    if (prior === fingerprint) {
      duplicateCount += 1;
      continue;
    }
    if (prior !== undefined) changedCount += 1;
    delta.push(record);
  }

  if (delta.length === 0) {
    const fallback = previous[0] ?? null;
    const reason = previous.length > 0 ? "no-new-records" : "no-records";
    const state = writeState(home, scope, {
      logicalKey,
      sourceId: fallback?.id ?? null,
      previousSourceIds,
      originalPath: resolvedPath,
      contentHash,
      status: "skipped",
      reason,
      recordCount: records.length,
      deltaCount: 0,
      duplicateCount,
      changedCount,
      cursor: options.cursor ?? null,
    });
    return {
      source: fallback,
      imported: false,
      skipped: true,
      reason,
      recordCount: fallback?.recordCount ?? 0,
      deltaCount: 0,
      duplicateCount,
      changedCount,
      logicalKey,
      previousSourceIds,
      state,
    };
  }

  const sourceId = makeSourceId();
  const deltaRecords = delta.map((record) => ({
    ...record,
    sourceId,
    id: rewriteRecordId(record.id, record.sourceId, sourceId),
  }));
  const imported = importSourceRecords(home, resolvedPath, content, {
    kind: options.kind,
    adapter: options.adapter,
    includeTools: options.includeTools,
    title: options.title,
    scope,
    sensitivity,
  }, deltaRecords, sourceId);
  const state = writeState(home, scope, {
    logicalKey,
    sourceId: imported.source.id,
    previousSourceIds,
    originalPath: resolvedPath,
    contentHash,
    status: "imported",
    reason: previous.length === 0 ? "initial" : "delta",
    recordCount: records.length,
    deltaCount: deltaRecords.length,
    duplicateCount,
    changedCount,
    cursor: options.cursor ?? null,
  });
  return {
    source: imported.source,
    imported: true,
    skipped: false,
    reason: previous.length === 0 ? "initial" : "delta",
    recordCount: imported.records.length,
    deltaCount: deltaRecords.length,
    duplicateCount,
    changedCount,
    logicalKey,
    previousSourceIds,
    state,
  };
}

export function inspectIncrementalState(home: string): IncrementalStateInspection {
  const entries: IncrementalState[] = [];
  const issues: IncrementalStateIssue[] = [];
  for (const scope of ["personal", "work"] as const) {
    const path = join(resolve(home), "governance", scope, "incremental", "state.jsonl");
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      issues.push({ scope, path, code: "incremental_state_symlink", detail: "incremental state must not be a symlink" });
      continue;
    }
    if (!statSync(path).isFile()) {
      issues.push({ scope, path, code: "incremental_state_not_file", detail: "incremental state must be a regular file" });
      continue;
    }
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const value = JSON.parse(lines[index]) as IncrementalState;
        if (!value || typeof value !== "object" || !value.scanId || !value.logicalKey || !value.scannedAt || !value.status) throw new Error("missing required state fields");
        entries.push(value);
      } catch (error) {
        issues.push({ scope, path, code: "incremental_state_malformed", detail: `line ${index + 1}: ${(error as Error).message}` });
      }
    }
  }
  return { entries, issues };
}

export function inferLogicalKey(options: Pick<IncrementalImportOptions, "kind" | "adapter">, originalPath: string, records: SourceMessage[]): string {
  const marker = records
    .flatMap((record) => record.refs ?? [])
    .find((ref) => /^(?:daxiang|contentId|commentId|conversationId|memoryId):/.test(ref));
  const adapter = options.adapter ?? "direct";
  return `${adapter}:${options.kind}:${marker ?? originalPath}`;
}

export function recordIdentity(record: SourceMessage): string {
  const stableRefs = (record.refs ?? [])
    .filter((ref) => /^(?:messageId|mid|uuid|turnId|revisionId|commentId|contentId|memoryId):/.test(ref))
    .sort();
  let id = record.id;
  if (record.sourceId && id.startsWith(`${record.sourceId}:`)) id = id.slice(record.sourceId.length + 1);
  id = id.replace(/:\d+$/, "");
  return `${record.conversationId}|${stableRefs.join(",")}|${id}`;
}

export function recordFingerprint(record: SourceMessage): string {
  return hashSourceContent(stableSerialize({
    conversationId: record.conversationId,
    role: record.role,
    actor: record.actor,
    timestamp: record.timestamp,
    content: record.content,
    refs: (record.refs ?? []).filter((ref) => !ref.startsWith("/") && !ref.includes("/staging/")).sort(),
    participants: record.participants ?? [],
  }));
}

function findPreviousSources(home: string, logicalKey: string, originalPath: string, options: IncrementalImportOptions): SourceRecord[] {
  const scope = normalizeSourceScope(options.scope);
  const sensitivity = options.sensitivity ?? (scope === "personal" ? "private" : "work-internal");
  const candidates = listSources(home, { includeQuarantined: true }).filter((source) => source.scope === scope
    && source.sensitivity === sensitivity
    && source.kind === options.kind
    && source.adapter === options.adapter
    && Boolean(source.includeTools) === Boolean(options.includeTools));
  const matches: SourceRecord[] = [];
  for (const source of candidates) {
    if (source.originalPath === originalPath || inferSourceLogicalKey(home, source) === logicalKey) matches.push(source);
  }
  return matches.sort((left, right) => left.importedAt.localeCompare(right.importedAt));
}

function inferSourceLogicalKey(home: string, source: SourceRecord): string {
  try {
    return inferLogicalKey(source, source.originalPath, readSourceRecords(home, source.id, { verifyRaw: false, source }));
  } catch {
    return `${source.adapter ?? "direct"}:${source.kind}:${source.originalPath}`;
  }
}

function rewriteRecordId(id: string, oldSourceId: string, newSourceId: string): string {
  const prefix = `${oldSourceId}:`;
  return id.startsWith(prefix) ? `${newSourceId}:${id.slice(prefix.length)}` : `${newSourceId}:${id}`;
}

function makeSourceId(): string {
  return `src-${randomUUID().slice(0, 12)}`;
}

function writeState(home: string, scope: "personal" | "work", input: Omit<IncrementalState, "scanId" | "scannedAt">): IncrementalState {
  const directory = join(resolve(home), "governance", scope, "incremental");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "state.jsonl");
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Incremental state must not be a symlink: ${path}`);
  const state: IncrementalState = { scanId: `scan-${randomUUID().slice(0, 12)}`, scannedAt: new Date().toISOString(), ...input };
  appendFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return state;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
