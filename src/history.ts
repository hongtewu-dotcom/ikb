import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { importIncrementalRecords, type IncrementalImportResult, type IncrementalState } from "./incremental.ts";
import { findSourceByOriginAndHash, hashSourceContent, importSourceRecords, normalizeSourceScope } from "./source.ts";
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
  const results = candidates.map((candidate) => importHistoryCandidate(home, candidate, options));
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
  try {
    const content = readFileSync(candidate.path);
    const contentHash = hashSourceContent(content);
    const scope = normalizeSourceScope(options.scope ?? candidate.scope, "work");
    const sensitivity = options.sensitivity ?? candidate.sensitivity;
    const includeTools = options.includeTools === true;
    const incremental = options.incremental !== false;
    if (!incremental) {
      const existing = findSourceByOriginAndHash(home, candidate.path, contentHash, { adapter: candidate.adapter, scope, sensitivity, includeTools });
      if (existing) return { candidate, source: existing, recordCount: existing.recordCount, skipped: true, reason: "unchanged" };
    }

    const sourceId = `src-${randomUUID().slice(0, 12)}`;
    const records = parseHistoryContent(candidate, sourceId, content.toString("utf8"), includeTools);
    if (records.length === 0) return { candidate, source: null, recordCount: 0, skipped: true, reason: "no messages" };
    if (incremental) {
      const result = importIncrementalRecords(home, candidate.path, content, {
        kind: candidate.kind,
        adapter: candidate.adapter,
        includeTools,
        title: candidate.title,
        scope,
        sensitivity,
        logicalKey: `history:${candidate.adapter}:${candidate.path}`,
      }, records);
      return historyResult(candidate, result);
    }
    const result = importSourceRecords(home, candidate.path, content, {
      kind: candidate.kind,
      adapter: candidate.adapter,
      includeTools,
      title: candidate.title,
      scope,
      sensitivity,
    }, records, sourceId);
    return { candidate, source: result.source, recordCount: result.records.length, skipped: false, deltaCount: result.records.length, duplicateCount: 0, changedCount: 0 };
  } catch (error) {
    return { candidate, source: null, recordCount: 0, skipped: false, error: (error as Error).message };
  }
}

function historyResult(candidate: HistoryCandidate, result: IncrementalImportResult): HistoryImportResult {
  return {
    candidate,
    source: result.source,
    recordCount: result.recordCount,
    skipped: result.skipped,
    reason: result.reason,
    deltaCount: result.deltaCount,
    duplicateCount: result.duplicateCount,
    changedCount: result.changedCount,
    incrementalState: result.state,
  };
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

function parseCodex(rows: Array<{ row: Record<string, unknown>; line: number }>, candidate: HistoryCandidate, sourceId: string, includeTools: boolean): SourceMessage[] {
  let conversationId = candidate.id;
  let cwd = "";
  let subagent: { id: string; parentThreadId: string; agentPath: string } | null = null;
  const messages: Array<{ message: SourceMessage; origin: string }> = [];
  for (const { row, line } of rows) {
    const payload = objectValue(row.payload);
    if (!payload) continue;
    const type = stringValue(payload.type) ?? stringValue(row.type);
    if (type === "session_meta") {
      conversationId = stringValue(payload.session_id) ?? stringValue(payload.id) ?? conversationId;
      cwd = stringValue(payload.cwd) ?? cwd;
      subagent = codexSubagentMetadata(payload);
      continue;
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
      continue;
    }
    if (!role || (subagent && !includeTools)) continue;
    const text = textFromContent(content, includeTools);
    if (!text) continue;
    const currentConversationId = subagent ? `${conversationId}:subagent:${subagent.id}` : conversationId;
    const currentActor = subagent ? `agent:${subagent.id}` : role;
    const currentRole = subagent && role === "user" ? "agent_prompt" : role;
    const enriched = { ...row, cwd: cwd || row.cwd, parentThreadId: subagent?.parentThreadId, agentPath: subagent?.agentPath };
    const message = makeMessage(sourceId, candidate, enriched, line, currentRole, text, currentConversationId, currentActor, subagent ? [currentActor] : ["user", "assistant"]);
    const previous = messages.at(-1);
    const isExactAssistantMirror = previous
      && previous.message.role === "assistant"
      && message.role === "assistant"
      && previous.message.conversationId === message.conversationId
      && previous.message.content === message.content
      && new Set([previous.origin, origin]).has("response_final")
      && new Set([previous.origin, origin]).has("agent_message");
    if (isExactAssistantMirror) {
      if (origin === "response_final") messages[messages.length - 1] = { message, origin };
      continue;
    }
    messages.push({ message, origin });
  }
  return messages.map(({ message }) => message);
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
