import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { importIncrementalExternalRecords, inspectIncrementalState, type IncrementalImportResult, type IncrementalState } from "./incremental.ts";
import { findSourceByOriginAndHash, hashSourceContent, hashSourceFile, importExternalSourceRecords, listSources, normalizeSourceScope } from "./source.ts";
import type { SourceKind, SourceMessage, SourceRecord } from "./types.ts";

export type HistoryAdapter = "claude" | "codex" | "desk" | "elephant";
export type HistoryAdapterSelection = HistoryAdapter | "all";

export interface HistoryCandidate {
  id: string;
  adapter: HistoryAdapter;
  kind: SourceKind;
  path: string;
  title: string;
  scope: string;
  sensitivity: string;
  size: number;
  modifiedAt: string;
}

export interface HistoryImportResult {
  candidate: HistoryCandidate;
  source: SourceRecord | null;
  recordCount: number;
  skipped: boolean;
  reason?: string;
  error?: string;
  deltaCount?: number;
  duplicateCount?: number;
  changedCount?: number;
  incrementalState?: IncrementalState;
  readBytes?: number;
}

export interface HistoryScanResult {
  scanId: string;
  adapter: HistoryAdapterSelection;
  scope: string;
  includeTools: boolean;
  incremental: boolean;
  discovered: number;
  imported: number;
  skipped: number;
  failed: number;
  results: HistoryImportResult[];
}

interface HistoryOptions {
  root?: string;
  scope?: string;
  sensitivity?: string;
  limit?: number;
  includeTools?: boolean;
  from?: string;
  to?: string;
  incremental?: boolean;
  previousSources?: SourceRecord[];
  previousStates?: IncrementalState[];
}

interface CodexMessageCheckpoint {
  role: string;
  conversationId: string;
  contentHash: string;
  origin: string;
}

interface CodexParseCheckpoint {
  conversationId: string;
  cwd: string;
  subagent: { id: string; parentThreadId: string; agentPath: string } | null;
  lastMessage: CodexMessageCheckpoint | null;
}

interface HistoryCursorV2 {
  version: 2;
  modifiedAt: string;
  size: number;
  byteOffset: number;
  lineNumber: number;
  endedWithNewline: boolean;
  anchorBytes: number;
  anchorHash: string;
  codex: CodexParseCheckpoint | null;
}

const ADAPTERS: HistoryAdapter[] = ["claude", "codex", "desk", "elephant"];

export function discoverHistoryCandidates(selection: HistoryAdapterSelection = "all", options: HistoryOptions = {}): HistoryCandidate[] {
  if (selection === "all" && options.root) throw new Error("--root requires a specific --adapter");
  if (selection === "elephant" && !options.root) throw new Error("--root is required for elephant export");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) throw new Error("History limit must be a non-negative integer");
  const boundaries = historyBoundaries(options.from, options.to);
  const scope = normalizeSourceScope(options.scope, "work");
  const adapters = selection === "all" ? ADAPTERS : [selection];
  const candidates: HistoryCandidate[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    const roots = options.root ? [expandHome(options.root)] : defaultRoots(adapter);
    for (const root of roots) {
      if (!existsSync(root)) {
        if (options.root) throw new Error(`History root does not exist: ${root}`);
        continue;
      }
      if (!statSync(root).isDirectory()) {
        if (options.root) throw new Error(`History root is not a directory: ${root}`);
        continue;
      }
      for (const path of walkJsonl(root, adapter)) {
        const absolutePath = resolve(path);
        if (seen.has(absolutePath)) continue;
        seen.add(absolutePath);
        const file = statSync(absolutePath);
        if (!inHistoryTimeRange(file.mtimeMs, boundaries.from, boundaries.to)) continue;
        candidates.push({
          id: `hist-${hashSourceContent(absolutePath).slice(0, 12)}`,
          adapter,
          kind: adapter === "elephant" ? "elephant" : "ai_conversation",
          path: absolutePath,
          title: `${adapter}: ${basename(absolutePath, extname(absolutePath))}`,
          scope,
          sensitivity: options.sensitivity ?? (scope === "personal" ? "private" : "work-internal"),
          size: file.size,
          modifiedAt: file.mtime.toISOString(),
        });
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return options.limit && options.limit > 0 ? candidates.slice(0, options.limit) : candidates;
}

function historyBoundaries(fromValue: string | undefined, toValue: string | undefined): { from?: number; to?: number } {
  const from = parseHistoryBoundary(fromValue, false);
  const to = parseHistoryBoundary(toValue, true);
  if (from !== undefined && to !== undefined && from > to) throw new Error("History --from must be less than or equal to --to");
  return { from, to };
}

function parseHistoryBoundary(value: string | undefined, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error("History time boundary must not be empty");
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(normalized);
  const timestamp = dateOnly
    ? Date.parse(`${normalized}T00:00:00.000Z`)
    : Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid history time boundary: ${value}`);
  if (!endOfDay || !dateOnly) return timestamp;
  return timestamp + 24 * 60 * 60 * 1000;
}

function inHistoryTimeRange(timestamp: number, from: number | undefined, to: number | undefined): boolean {
  return (from === undefined || timestamp >= from) && (to === undefined || timestamp < to);
}

export function ingestHistory(home: string, selection: HistoryAdapterSelection = "all", options: HistoryOptions = {}): HistoryScanResult {
  const scope = normalizeSourceScope(options.scope, "work");
  const candidates = discoverHistoryCandidates(selection, options);
  const previousSources = options.incremental === false ? undefined : listSources(home, { includeQuarantined: true });
  const previousStates = options.incremental === false ? undefined : inspectIncrementalState(home).entries;
  const results = candidates.map((candidate) => importHistoryCandidate(home, candidate, { ...options, previousSources, previousStates }));
  return {
    scanId: `scan-${randomUUID().slice(0, 12)}`,
    adapter: selection,
    scope,
    includeTools: options.includeTools === true,
    incremental: options.incremental !== false,
    discovered: candidates.length,
    imported: results.filter((result) => !result.skipped && !result.error).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => Boolean(result.error)).length,
    results,
  };
}

export function importHistoryCandidate(home: string, candidate: HistoryCandidate, options: HistoryOptions = {}): HistoryImportResult {
  let admittedRawPath: string | null = null;
  try {
    const scope = normalizeSourceScope(options.scope ?? candidate.scope, "work");
    const sensitivity = options.sensitivity ?? candidate.sensitivity;
    const includeTools = options.includeTools === true;
    const incremental = options.incremental !== false;
    if (incremental) {
      const quick = unchangedHistoryResult(candidate, scope, sensitivity, includeTools, options.previousSources ?? listSources(home, { includeQuarantined: true }), options.previousStates ?? inspectIncrementalState(home).entries);
      if (quick) return quick;
    }
    const previousStates = options.previousStates ?? inspectIncrementalState(home).entries;
    const resume = incremental ? resumableHistoryCursor(candidate, includeTools, previousStates) : null;
    const sourceId = `src-${randomUUID().slice(0, 12)}`;
    const admitted = streamAdmittedHistory(home, candidate, sourceId, includeTools, resume);
    admittedRawPath = admitted.path;
    const records = admitted.records;
    const contentHash = hashSourceFile(admitted.path);
    if (!incremental) {
      const existing = findSourceByOriginAndHash(home, candidate.path, contentHash, { adapter: candidate.adapter, scope, sensitivity, includeTools });
      if (existing) return { candidate, source: existing, recordCount: existing.recordCount, skipped: true, reason: "unchanged", readBytes: admitted.readBytes };
    }

    if (incremental) {
      const result = importIncrementalExternalRecords(home, candidate.path, contentHash, {
        kind: candidate.kind,
        adapter: candidate.adapter,
        includeTools,
        title: candidate.title,
        scope,
        sensitivity,
        logicalKey: historyLogicalKey(candidate, includeTools),
        cursor: admitted.cursor,
        originBytes: candidate.size,
        originModifiedAt: candidate.modifiedAt,
        previousSources: options.previousSources,
      }, records);
      return historyResult(candidate, result, admitted.readBytes);
    }
    if (records.length === 0) return { candidate, source: null, recordCount: 0, skipped: true, reason: "no messages", readBytes: admitted.readBytes };
    const result = importExternalSourceRecords(home, candidate.path, contentHash, {
      kind: candidate.kind,
      adapter: candidate.adapter,
      includeTools,
      title: candidate.title,
      scope,
      sensitivity,
      originBytes: candidate.size,
      originModifiedAt: candidate.modifiedAt,
    }, records, sourceId);
    return { candidate, source: result.source, recordCount: result.records.length, skipped: false, deltaCount: result.records.length, duplicateCount: 0, changedCount: 0, readBytes: admitted.readBytes };
  } catch (error) {
    return { candidate, source: null, recordCount: 0, skipped: false, error: (error as Error).message };
  } finally {
    if (admittedRawPath) rmSync(admittedRawPath, { force: true });
  }
}

function unchangedHistoryResult(candidate: HistoryCandidate, scope: "personal" | "work", sensitivity: string, includeTools: boolean, sources: SourceRecord[], states: IncrementalState[]): HistoryImportResult | null {
  const logicalKey = historyLogicalKey(candidate, includeTools);
  const matchingSources = sources.filter((source) => source.originalPath === candidate.path
    && source.scope === scope
    && source.sensitivity === sensitivity
    && source.kind === candidate.kind
    && source.adapter === candidate.adapter
    && Boolean(source.includeTools) === includeTools)
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  const sourceById = new Map(matchingSources.map((source) => [source.id, source] as const));
  const legacyLogicalKey = `history:${candidate.adapter}:${candidate.path}`;
  const matchingStates = states.filter((state) => state.logicalKey === logicalKey || (!includeTools && state.logicalKey === legacyLogicalKey)).sort((left, right) => right.scannedAt.localeCompare(left.scannedAt));
  const latestState = matchingStates[0];
  if (latestState && sameHistoryCursor(latestState.cursor, candidate)) {
    const source = latestState.sourceId ? sourceById.get(latestState.sourceId) ?? matchingSources[0] ?? null : null;
    return {
      candidate,
      source,
      recordCount: source?.recordCount ?? 0,
      skipped: true,
      reason: source ? "unchanged-cursor" : "no messages",
      deltaCount: 0,
      duplicateCount: source?.recordCount ?? 0,
      changedCount: 0,
      incrementalState: latestState,
      readBytes: 0,
    };
  }
  const candidateModifiedAt = Date.parse(candidate.modifiedAt);
  if (latestState && Date.parse(latestState.scannedAt) >= candidateModifiedAt) {
    const source = latestState.sourceId ? sourceById.get(latestState.sourceId) ?? matchingSources[0] ?? null : null;
    return {
      candidate,
      source,
      recordCount: source?.recordCount ?? 0,
      skipped: true,
      reason: source ? "unchanged-since-scan" : "no messages",
      deltaCount: 0,
      duplicateCount: source?.recordCount ?? 0,
      changedCount: 0,
      incrementalState: latestState,
      readBytes: 0,
    };
  }
  const source = matchingSources.find((item) => Date.parse(item.importedAt) >= candidateModifiedAt);
  if (!source) return null;
  return {
    candidate,
    source,
    recordCount: source.recordCount,
    skipped: true,
    reason: "unchanged-since-import",
    deltaCount: 0,
    duplicateCount: source.recordCount,
    changedCount: 0,
    readBytes: 0,
  };
}

function historyLogicalKey(candidate: HistoryCandidate, includeTools: boolean): string {
  return `history:${candidate.adapter}:${includeTools ? "with-tools" : "visible"}:${candidate.path}`;
}

function sameHistoryCursor(value: unknown, candidate: HistoryCandidate): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return cursor.modifiedAt === candidate.modifiedAt && cursor.size === candidate.size;
}

function resumableHistoryCursor(candidate: HistoryCandidate, includeTools: boolean, states: IncrementalState[]): HistoryCursorV2 | null {
  const logicalKey = historyLogicalKey(candidate, includeTools);
  const legacyLogicalKey = `history:${candidate.adapter}:${candidate.path}`;
  const latest = states
    .filter((state) => state.logicalKey === logicalKey || (!includeTools && state.logicalKey === legacyLogicalKey))
    .sort((left, right) => right.scannedAt.localeCompare(left.scannedAt))[0];
  if (!latest?.cursor || typeof latest.cursor !== "object" || Array.isArray(latest.cursor)) return null;
  const cursor = latest.cursor as Partial<HistoryCursorV2>;
  if (cursor.version !== 2
    || !Number.isInteger(cursor.byteOffset)
    || !Number.isInteger(cursor.lineNumber)
    || !Number.isInteger(cursor.anchorBytes)
    || cursor.endedWithNewline !== true
    || typeof cursor.anchorHash !== "string"
    || cursor.byteOffset! < 0
    || cursor.byteOffset! > candidate.size
    || cursor.anchorBytes! < 0
    || cursor.anchorBytes! > cursor.byteOffset!) return null;
  const anchor = readFileRange(candidate.path, cursor.byteOffset! - cursor.anchorBytes!, cursor.anchorBytes!);
  if (hashSourceContent(anchor) !== cursor.anchorHash) return null;
  return cursor as HistoryCursorV2;
}

function readFileRange(path: string, start: number, length: number): Buffer {
  if (length === 0) return Buffer.alloc(0);
  const descriptor = openSync(path, "r");
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  try {
    while (offset < length) {
      const bytesRead = readSync(descriptor, output, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error(`History source changed while reading anchor: ${path}`);
      offset += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return output;
}

function historyResult(candidate: HistoryCandidate, result: IncrementalImportResult, readBytes: number): HistoryImportResult {
  return {
    candidate,
    source: result.source,
    recordCount: result.recordCount,
    skipped: result.skipped,
    reason: result.reason === "no-records" ? "no messages" : result.reason,
    deltaCount: result.deltaCount,
    duplicateCount: result.duplicateCount,
    changedCount: result.changedCount,
    incrementalState: result.state,
    readBytes,
  };
}

function streamAdmittedHistory(home: string, candidate: HistoryCandidate, sourceId: string, includeTools: boolean, resume: HistoryCursorV2 | null): { path: string; records: SourceMessage[]; cursor: HistoryCursorV2; readBytes: number } {
  const directory = join(resolve(home), "staging", "history-admitted");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${candidate.id}-${randomUUID().slice(0, 12)}.jsonl`);
  const input = openSync(candidate.path, "r");
  const output = openSync(path, "wx", 0o600);
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const records: SourceMessage[] = [];
  const codexState = candidate.adapter === "codex" ? createCodexParseState(candidate, resume?.codex ?? null) : null;
  let pending = "";
  let lineNumber = resume?.lineNumber ?? 0;
  let position = resume?.byteOffset ?? 0;
  const startOffset = position;
  let endedWithNewline = resume?.endedWithNewline ?? true;
  let inputClosed = false;
  let outputClosed = false;
  const consume = (line: string): void => {
    lineNumber += 1;
    if (!line.trim()) return;
    let row: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row must be an object");
      row = value as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid ${candidate.adapter} history JSONL at line ${lineNumber}: ${(error as Error).message}`);
    }
    let admitted: SourceMessage[] = [];
    let retainRaw = false;
    if (codexState) {
      retainRaw = consumeCodexRow(codexState, row, lineNumber, candidate, sourceId, includeTools);
    } else if (candidate.adapter === "desk") {
      admitted = parseDesk([{ row, line: lineNumber }], candidate, sourceId, includeTools);
      retainRaw = admitted.length > 0;
    } else if (candidate.adapter === "elephant") {
      admitted = parseElephant([{ row, line: lineNumber }], candidate, sourceId);
      retainRaw = admitted.length > 0;
    } else {
      admitted = parseClaude([{ row, line: lineNumber }], candidate, sourceId, includeTools);
      retainRaw = admitted.length > 0;
    }
    records.push(...admitted);
    if (retainRaw) writeSync(output, `${line}\n`);
  };
  try {
    while (true) {
      if (position >= candidate.size) break;
      const bytesRead = readSync(input, buffer, 0, Math.min(buffer.length, candidate.size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      endedWithNewline = buffer[bytesRead - 1] === 0x0a;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        consume(line);
      }
    }
    pending += decoder.end();
    if (pending) consume(pending.replace(/\r$/, ""));
    closeSync(input);
    inputClosed = true;
    closeSync(output);
    outputClosed = true;
    chmodSync(path, 0o600);
    const anchorBytes = Math.min(candidate.size, 64 * 1024);
    const cursor: HistoryCursorV2 = {
      version: 2,
      modifiedAt: candidate.modifiedAt,
      size: candidate.size,
      byteOffset: candidate.size,
      lineNumber,
      endedWithNewline,
      anchorBytes,
      anchorHash: hashSourceContent(readFileRange(candidate.path, candidate.size - anchorBytes, anchorBytes)),
      codex: codexState ? codexCheckpoint(codexState) : null,
    };
    return {
      path,
      records: codexState ? finishCodexParse(codexState) : records,
      cursor,
      readBytes: candidate.size - startOffset,
    };
  } catch (error) {
    if (!inputClosed) closeSync(input);
    if (!outputClosed) closeSync(output);
    rmSync(path, { force: true });
    throw error;
  }
}

export function parseHistoryContent(candidate: HistoryCandidate, sourceId: string, text: string, includeTools = false): SourceMessage[] {
  const rows = text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ row: JSON.parse(line) as Record<string, unknown>, line: index + 1 }];
    } catch (error) {
      throw new Error(`Invalid ${candidate.adapter} history JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
  });
  if (candidate.adapter === "codex") return parseCodex(rows, candidate, sourceId, includeTools);
  if (candidate.adapter === "desk") return parseDesk(rows, candidate, sourceId, includeTools);
  if (candidate.adapter === "elephant") return parseElephant(rows, candidate, sourceId);
  return parseClaude(rows, candidate, sourceId, includeTools);
}

function parseClaude(rows: Array<{ row: Record<string, unknown>; line: number }>, candidate: HistoryCandidate, sourceId: string, includeTools: boolean): SourceMessage[] {
  return rows.flatMap(({ row, line }) => {
    const type = stringValue(row.type);
    const message = objectValue(row.message);
    const value = message?.content ?? row.content;
    if (row.isMeta === true || row.isCompactSummary === true || message?.isMeta === true || message?.isCompactSummary === true) return [];
    const control = type === "user" && !contentHasType(value, "tool_result") ? claudeControlDisposition(row, message, value) : null;
    if (control === "skip" || (control === "tool" && !includeTools)) return [];
    if (control === "tool") {
      const content = textFromContent(value, true);
      return content ? [makeMessage(sourceId, candidate, row, line, "tool", content, stringValue(row.sessionId) ?? candidate.id, "tool", ["user", "assistant", "tool"], "tool")] : [];
    }
    if (row.isSidechain === true) {
      if (!includeTools) return [];
      return claudeSidechainMessages(sourceId, candidate, row, line, type, value);
    }
    const isMessage = type === "user" || type === "assistant" || (includeTools && type === "tool");
    if (!isMessage) return [];
    return attributedMessages(sourceId, candidate, row, line, type!, value, stringValue(row.sessionId) ?? candidate.id, includeTools);
  });
}

function claudeSidechainMessages(sourceId: string, candidate: HistoryCandidate, row: Record<string, unknown>, line: number, type: string | null, value: unknown): SourceMessage[] {
  if (type !== "user" && type !== "assistant" && type !== "tool") return [];
  const agentId = stringValue(row.agentId) ?? "unknown";
  const actor = `agent:${agentId}`;
  const conversationId = `${stringValue(row.sessionId) ?? candidate.id}:sidechain:${agentId}`;
  if (type === "tool") {
    const content = textFromContent(value, true);
    return content ? [makeMessage(sourceId, candidate, row, line, "tool", content, conversationId, actor, [actor], "sidechain-tool")] : [];
  }
  const content = textFromContent(value, false);
  const toolContent = toolTextFromContent(value);
  return [
    ...(content ? [makeMessage(sourceId, candidate, row, line, type === "assistant" ? "assistant" : "agent_prompt", content, conversationId, actor, [actor], "sidechain")] : []),
    ...(toolContent ? [makeMessage(sourceId, candidate, row, line, "tool", toolContent, conversationId, actor, [actor], "sidechain-tool")] : []),
  ];
}

function claudeControlDisposition(row: Record<string, unknown>, message: Record<string, unknown> | null, value: unknown): "skip" | "tool" | null {
  const text = textFromContent(value, true).trimStart();
  if (/^<local-command-(?:stdout|stderr)>/i.test(text)) return "tool";
  const promptSource = (stringValue(row.promptSource) ?? stringValue(message?.promptSource))?.toLowerCase();
  if (promptSource === "system") return "skip";
  if (/^(?:<task-notification>|<command-name>|<command-message>|<command-args>|<local-command-caveat>|<system-reminder>|\[Request interrupted by user\b)/i.test(text)) return "skip";
  return null;
}

function parseDesk(rows: Array<{ row: Record<string, unknown>; line: number }>, candidate: HistoryCandidate, sourceId: string, includeTools: boolean): SourceMessage[] {
  return rows.flatMap(({ row, line }) => {
    const type = stringValue(row.type);
    const isMessage = type === "user" || type === "assistant" || (includeTools && type === "tool");
    if (!isMessage) return [];
    const message = objectValue(row.message);
    return attributedMessages(sourceId, candidate, row, line, type!, message?.content ?? row.content, stringValue(row.conversationId) ?? candidate.id, includeTools);
  });
}

function parseElephant(rows: Array<{ row: Record<string, unknown>; line: number }>, candidate: HistoryCandidate, sourceId: string): SourceMessage[] {
  return rows.flatMap(({ row, line }) => {
    const content = firstNonEmptyText(row, ["content", "text", "message", "body"]);
    if (!content) return [];
    const conversationId = stringValue(row.conversation_id) ?? stringValue(row.conversationId) ?? stringValue(row.session_id) ?? candidate.id;
    const role = stringValue(row.role) ?? "human";
    const actor = actorValue(row) ?? role;
    const participants = firstNonEmptyStringList(row, ["participants", "participant_ids"]);
    return [makeMessage(sourceId, candidate, row, line, role, content, conversationId, actor, participants.length > 0 ? participants : [actor])];
  });
}

function firstNonEmptyText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = textFromContent(row[key], false);
    if (text) return text;
  }
  return "";
}

function firstNonEmptyStringList(row: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = stringList(row[key]);
    if (values.length > 0) return values;
  }
  return [];
}

interface CodexParseState {
  conversationId: string;
  cwd: string;
  subagent: { id: string; parentThreadId: string; agentPath: string } | null;
  messages: Array<{ message: SourceMessage; origin: string }>;
  previous: CodexMessageCheckpoint | null;
}

function createCodexParseState(candidate: HistoryCandidate, checkpoint: CodexParseCheckpoint | null = null): CodexParseState {
  return {
    conversationId: checkpoint?.conversationId ?? candidate.id,
    cwd: checkpoint?.cwd ?? "",
    subagent: checkpoint?.subagent ?? null,
    messages: [],
    previous: checkpoint?.lastMessage ?? null,
  };
}

function finishCodexParse(state: CodexParseState): SourceMessage[] {
  return state.messages.map(({ message }) => message);
}

function codexCheckpoint(state: CodexParseState): CodexParseCheckpoint {
  const latest = state.messages.at(-1);
  const lastMessage = latest ? {
    role: latest.message.role,
    conversationId: latest.message.conversationId,
    contentHash: hashSourceContent(latest.message.content),
    origin: latest.origin,
  } : state.previous;
  return {
    conversationId: state.conversationId,
    cwd: state.cwd,
    subagent: state.subagent,
    lastMessage,
  };
}

function parseCodex(rows: Array<{ row: Record<string, unknown>; line: number }>, candidate: HistoryCandidate, sourceId: string, includeTools: boolean): SourceMessage[] {
  const state = createCodexParseState(candidate);
  for (const { row, line } of rows) consumeCodexRow(state, row, line, candidate, sourceId, includeTools);
  return finishCodexParse(state);
}

function consumeCodexRow(state: CodexParseState, row: Record<string, unknown>, line: number, candidate: HistoryCandidate, sourceId: string, includeTools: boolean): boolean {
  const payload = objectValue(row.payload);
  if (!payload) return false;
  const type = stringValue(payload.type) ?? stringValue(row.type);
  if (type === "session_meta") {
    state.conversationId = stringValue(payload.session_id) ?? stringValue(payload.id) ?? state.conversationId;
    state.cwd = stringValue(payload.cwd) ?? state.cwd;
    state.subagent = codexSubagentMetadata(payload);
    return true;
  }
  let role: string | null = null;
  let content: unknown;
  let origin = type ?? "unknown";
  if (type === "user_message") {
    role = "user";
    content = payload.message;
  } else if (type === "agent_message") {
    role = "assistant";
    content = payload.message;
  } else if (type === "message" && stringValue(payload.role) === "assistant" && (stringValue(payload.phase) ?? stringValue(row.phase)) === "final_answer") {
    role = "assistant";
    content = payload.content ?? payload.message;
    origin = "response_final";
  } else if (includeTools && ["custom_tool_call_output", "function_call_output", "mcp_tool_call_end", "patch_apply_end", "web_search_end"].includes(type ?? "")) {
    role = "tool";
    content = payload.output ?? payload.result ?? payload.stdout ?? payload.message ?? payload.query;
  } else {
    return false;
  }
  if (!role || (state.subagent && !includeTools)) return false;
  const text = textFromContent(content, includeTools);
  if (!text) return false;
  const currentConversationId = state.subagent ? `${state.conversationId}:subagent:${state.subagent.id}` : state.conversationId;
  const currentActor = state.subagent ? `agent:${state.subagent.id}` : role;
  const currentRole = state.subagent && role === "user" ? "agent_prompt" : role;
  const enriched = { ...row, cwd: state.cwd || row.cwd, parentThreadId: state.subagent?.parentThreadId, agentPath: state.subagent?.agentPath };
  const message = makeMessage(sourceId, candidate, enriched, line, currentRole, text, currentConversationId, currentActor, state.subagent ? [currentActor] : ["user", "assistant"]);
  const currentPrevious = state.messages.at(-1);
  const previous = currentPrevious ? {
    role: currentPrevious.message.role,
    conversationId: currentPrevious.message.conversationId,
    contentHash: hashSourceContent(currentPrevious.message.content),
    origin: currentPrevious.origin,
  } : state.previous;
  const isExactAssistantMirror = previous
    && previous.role === "assistant"
    && message.role === "assistant"
    && previous.conversationId === message.conversationId
    && previous.contentHash === hashSourceContent(message.content)
    && new Set([previous.origin, origin]).has("response_final")
    && new Set([previous.origin, origin]).has("agent_message");
  if (isExactAssistantMirror) {
    if (origin === "response_final" && currentPrevious) state.messages[state.messages.length - 1] = { message, origin };
    state.previous = { role: message.role, conversationId: message.conversationId, contentHash: hashSourceContent(message.content), origin };
    return true;
  }
  state.messages.push({ message, origin });
  state.previous = null;
  return true;
}

function codexSubagentMetadata(payload: Record<string, unknown>): { id: string; parentThreadId: string; agentPath: string } | null {
  const source = objectValue(payload.source);
  const subagentValue = source?.subagent;
  const subagent = objectValue(subagentValue);
  const threadSpawn = objectValue(subagent?.thread_spawn);
  const parentThreadId = firstString(payload, ["parent_thread_id", "parentThreadId"]) ?? firstString(threadSpawn ?? {}, ["parent_thread_id", "parentThreadId"]) ?? firstString(source ?? {}, ["parent_thread_id", "parentThreadId"]) ?? "";
  const agentPath = firstString(payload, ["agent_path", "agentPath"]) ?? firstString(threadSpawn ?? {}, ["agent_path", "agentPath"]) ?? firstString(source ?? {}, ["agent_path", "agentPath"]) ?? "";
  const isSubagent = Boolean(source && Object.prototype.hasOwnProperty.call(source, "subagent")) || Boolean(parentThreadId) || Boolean(agentPath);
  if (!isSubagent) return null;
  const id = firstString(payload, ["agent_nickname", "agentNickname"])
    ?? firstString(threadSpawn ?? {}, ["agent_nickname", "agentNickname", "agent_role", "agentRole"])
    ?? (subagent ? firstString(subagent, ["agent_id", "agentId", "id", "name", "role", "other"]) : stringValue(subagentValue))
    ?? (agentPath ? basename(agentPath) : "unknown");
  return { id, parentThreadId, agentPath };
}

function attributedMessages(sourceId: string, candidate: HistoryCandidate, row: Record<string, unknown>, line: number, rowType: string, value: unknown, conversationId: string, includeTools: boolean): SourceMessage[] {
  if (rowType === "tool") {
    const content = textFromContent(value, true);
    return content ? [makeMessage(sourceId, candidate, row, line, "tool", content, conversationId, "tool", ["user", "assistant", "tool"], "tool")] : [];
  }
  const role = rowType === "assistant" ? "assistant" : "user";
  const content = textFromContent(value, false);
  const toolContent = includeTools ? toolTextFromContent(value) : "";
  return [
    ...(content ? [makeMessage(sourceId, candidate, row, line, role, content, conversationId)] : []),
    ...(toolContent ? [makeMessage(sourceId, candidate, row, line, "tool", toolContent, conversationId, "tool", ["user", "assistant", "tool"], "tool")] : []),
  ];
}

function makeMessage(sourceId: string, candidate: HistoryCandidate, row: Record<string, unknown>, line: number, role: string, content: string, conversationId: string, actor = role, participants = ["user", "assistant"], part = ""): SourceMessage {
  const messageId = stringValue(row.uuid) ?? stringValue(row.messageId) ?? stringValue(row.id) ?? stringValue(row.call_id) ?? `line-${line}`;
  const refs = [candidate.path, stringValue(row.cwd), stringValue(row.gitBranch), stringValue(row.parentThreadId), stringValue(row.agentPath)].filter((value): value is string => Boolean(value));
  return {
    id: `${sourceId}:${messageId}:${line}${part ? `:${part}` : ""}`,
    sourceId,
    conversationId,
    role,
    actor,
    timestamp: firstString(row, ["timestamp", "sent_at", "sentAt", "created_at", "createdAt"]) ?? "",
    content,
    refs: [...new Set(refs)],
    participants,
  };
}

function toolTextFromContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(toolTextFromContent).filter(Boolean).join("\n\n").trim();
  if (!value || typeof value !== "object") return "";
  const block = value as Record<string, unknown>;
  const type = stringValue(block.type);
  if (type === "tool_use") {
    const name = stringValue(block.name) ?? stringValue(block.toolName) ?? "unknown";
    const toolInput = block.input ?? block.toolParams;
    const input = toolInput === undefined ? "" : `\n${typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput)}`;
    return `tool use: ${name}${input}`.trim();
  }
  if (type === "tool_result") {
    return stripLeadingSystemReminder(textFromContent(block.content ?? block.toolResult ?? block.tool_result ?? block.output ?? block.result, true));
  }
  if (block.toolResult !== undefined) return textFromContent(block.toolResult, true);
  if (block.tool_result !== undefined) return textFromContent(block.tool_result, true);
  return block.content !== undefined ? toolTextFromContent(block.content) : "";
}

function contentHasType(value: unknown, expectedType: string): boolean {
  if (Array.isArray(value)) return value.some((item) => contentHasType(item, expectedType));
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return stringValue(block.type) === expectedType || (block.content !== undefined && contentHasType(block.content, expectedType));
}

function stripLeadingSystemReminder(value: string): string {
  return value.replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, "").trim();
}

function textFromContent(value: unknown, includeTools: boolean): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((block) => textFromContent(block, includeTools)).filter(Boolean).join("\n\n").trim();
  }
  if (!value || typeof value !== "object") return "";
  const block = value as Record<string, unknown>;
  const type = stringValue(block.type);
  if (type === "thinking" || type === "reasoning" || type === "signature") return "";
  if (type === "tool_use" && !includeTools) return "";
  if (type === "tool_use") return `tool: ${stringValue(block.name) ?? stringValue(block.toolName) ?? "unknown"}`;
  if (type === "tool_result" && !includeTools) return "";
  if (typeof block.text === "string") return block.text.trim();
  if (typeof block.message === "string") return block.message.trim();
  if (typeof block.content === "string") return block.content.trim();
  if (block.content !== undefined) return textFromContent(block.content, includeTools);
  if (typeof block.body === "string") return block.body.trim();
  if (typeof block.output === "string") return block.output.trim();
  if (typeof block.result === "string") return block.result.trim();
  if (block.toolResult !== undefined) return textFromContent(block.toolResult, includeTools);
  if (block.tool_result !== undefined) return textFromContent(block.tool_result, includeTools);
  return includeTools ? JSON.stringify(block) : "";
}

function defaultRoots(adapter: HistoryAdapter): string[] {
  const home = homedir();
  if (adapter === "claude") return [join(home, ".claude", "projects")];
  if (adapter === "codex") return [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
  if (adapter === "elephant") return [];
  return [join(home, ".catpaw", "projects")];
}

function walkJsonl(root: string, adapter: HistoryAdapter): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (adapter === "codex" && entry.name.startsWith("backup-")) continue;
        visit(path);
      } else if (entry.isFile() && [".jsonl", ".ndjson"].includes(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item.trim() : objectValue(item) ? firstString(objectValue(item)!, ["id", "user_id", "uid", "name", "display_name"]) : null)
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function actorValue(row: Record<string, unknown>): string | null {
  for (const key of ["actor", "author", "sender", "user", "from", "sender_id"]) {
    const value = row[key];
    const scalar = stringValue(value);
    if (scalar) return scalar;
    const object = objectValue(value);
    if (object) {
      const nested = firstString(object, ["id", "user_id", "uid", "name", "display_name"]);
      if (nested) return nested;
    }
  }
  return null;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}
