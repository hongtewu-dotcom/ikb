import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  detectIkbCliOperations,
  hasValidIkbCliResult,
  projectIkbUsageV2Corrections,
  projectCorrections,
  readIkbUsageV2Activation,
  scanUserCorrections,
  type UserCorrectionRecord,
} from "./ikb-recall.ts";

export const CLAUDE_CORRECTION_COLLECTION_SCHEMA = "ikb-recall-claude-correction-collection-v1";

const MAX_JSONL_LINE_LENGTH = 8 * 1024 * 1024;

export interface ClaudeCorrectionCollectionReport {
  schema: typeof CLAUDE_CORRECTION_COLLECTION_SCHEMA;
  status: "ready" | "unavailable";
  scannedFiles: number;
  scannedUserMessages: number;
  correctionsFound: number;
  correctionsAdded: number;
}

interface ClaudeSessionFacts {
  sessionId: string;
  hasIkbCalls: boolean;
  userMessages: Array<{ id: string; timestamp: string; text: string }>;
}

function userTextFromContent(content: unknown): string {
  // Claude 日志：user 消息的 content 是字符串或 block 数组；
  // block 数组里只有 type=text 是用户亲口说的话，tool_result 是工具回执（不算）。
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join(" ")
    .trim();
}

async function loadClaudeSessionFacts(path: string): Promise<ClaudeSessionFacts | null> {
  const facts: ClaudeSessionFacts = { sessionId: "", hasIkbCalls: false, userMessages: [] };
  const pendingCalls = new Map<string, ReturnType<typeof detectIkbCliOperations>>();
  let onlyPendingCallId: string | null = null;
  const reader = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  let sawMessage = false;
  for await (const line of reader) {
    if (!line || line.length > MAX_JSONL_LINE_LENGTH) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof row.sessionId === "string" && !facts.sessionId) facts.sessionId = row.sessionId;
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;
    sawMessage = true;
    const message = row.message as { role?: unknown; content?: unknown; isError?: unknown; is_error?: unknown } | undefined;
    if (!message || typeof message !== "object") continue;
    if (type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block && typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_use" &&
          typeof (block as { name?: unknown }).name === "string" &&
          ((block as { name: string }).name.includes("ikb_search_cards") || (block as { name: string }).name.includes("ikb_get_card"))
        ) {
          facts.hasIkbCalls = true;
          continue;
        }
        if (
          block && typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_use" &&
          /^(?:bash|Bash|shell|exec|exec_command)$/.test(String((block as { name?: unknown }).name ?? ""))
        ) {
          const row = block as { id?: unknown; input?: unknown; arguments?: unknown };
          const operations = detectIkbCliOperations(row.input ?? row.arguments);
          const callId = typeof row.id === "string" ? row.id : "";
          if (operations.length > 0 && callId) {
            pendingCalls.set(callId, operations);
            onlyPendingCallId = callId;
          }
        }
      }
      continue;
    }
    if (type === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_result") continue;
        const row = block as { tool_use_id?: unknown; content?: unknown };
        const callId = typeof row.tool_use_id === "string" ? row.tool_use_id : onlyPendingCallId;
        const operations = callId ? pendingCalls.get(callId) : undefined;
        if (operations && message.isError !== true && message.is_error !== true && operations.some((operation) => hasValidIkbCliResult(row.content, operation))) facts.hasIkbCalls = true;
        if (callId) {
          pendingCalls.delete(callId);
          if (onlyPendingCallId === callId) onlyPendingCallId = null;
        }
      }
    }
    const text = userTextFromContent(message.content);
    const timestamp = typeof row.timestamp === "string" ? row.timestamp : "";
    const id = typeof row.uuid === "string" ? row.uuid : "";
    if (text && timestamp) facts.userMessages.push({ id, timestamp, text });
  }
  if (!sawMessage) return null;
  if (!facts.sessionId) facts.sessionId = path;
  return facts;
}

function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (entry.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root, 0);
  return files.sort();
}

export async function collectClaudeUserCorrections(options: {
  sessionRoots?: string[];
  activeDataRoot: string;
  from?: string;
  to?: string;
}): Promise<ClaudeCorrectionCollectionReport> {
  const roots = (options.sessionRoots && options.sessionRoots.length > 0
    ? options.sessionRoots
    : [resolve(homedir(), ".claude", "projects")]
  ).map((root) => resolve(root));
  const existing = roots.filter((root) => isAbsolute(root) && existsSync(root));
  const report: ClaudeCorrectionCollectionReport = {
    schema: CLAUDE_CORRECTION_COLLECTION_SCHEMA,
    status: existing.length === 0 ? "unavailable" : "ready",
    scannedFiles: 0,
    scannedUserMessages: 0,
    correctionsFound: 0,
    correctionsAdded: 0,
  };
  if (existing.length === 0) return report;

  const from = options.from ?? "";
  const to = options.to ?? "9999";
  const activation = readIkbUsageV2Activation(resolve(options.activeDataRoot));
  const effectiveFrom = activation && activation.activatedAt > from ? activation.activatedAt : from;
  const corrections: UserCorrectionRecord[] = [];
  for (const root of existing) {
    for (const file of listSessionFiles(root)) {
      const facts = await loadClaudeSessionFacts(file);
      if (!facts) continue;
      report.scannedFiles += 1;
      report.scannedUserMessages += facts.userMessages.length;
      for (const message of facts.userMessages) {
        if (message.timestamp < effectiveFrom || message.timestamp > to) continue;
        // Claude 日志没有显式 turn 边界：每条用户消息合成一个"turn"，
        // hadIkbCall 只精确到会话级。
        const synthesizedTurn = {
          turnId: message.id || message.timestamp,
          startedAt: message.timestamp,
          completedAt: message.timestamp,
          finalText: "",
          userMessages: [message.text],
          feedbackTexts: [],
          searches: [],
          reads: [],
          ikbCalls: facts.hasIkbCalls ? 1 : 0,
          issues: [],
        };
        for (const record of scanUserCorrections(facts.sessionId, synthesizedTurn)) {
          corrections.push({
            ...record,
            subjectRef: record.subjectRef.replace("run://codex/", "run://claude/"),
            sourceEventRef: record.sourceEventRef?.replace("run://codex/", "run://claude/"),
          });
        }
      }
    }
  }
  report.correctionsFound = corrections.length;
  report.correctionsAdded = activation
    ? projectIkbUsageV2Corrections(resolve(options.activeDataRoot), corrections as unknown as Array<Record<string, unknown>>)
    : projectCorrections(resolve(options.activeDataRoot), corrections);
  return report;
}
