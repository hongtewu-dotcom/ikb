import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  detectIkbCliOperations,
  hasValidIkbCliResult,
  IKB_RECALL_CORRECTION_SCHEMA,
  projectCorrections,
  projectIkbUsageV2Corrections,
  readIkbUsageV2Activation,
  scanUserCorrections,
  type UserCorrectionRecord,
} from "./ikb-recall.ts";

export const PI_CORRECTION_COLLECTION_SCHEMA = "ikb-recall-pi-correction-collection-v1";

const MAX_JSONL_LINE_LENGTH = 8 * 1024 * 1024;

export interface PiCorrectionCollectionReport {
  schema: typeof PI_CORRECTION_COLLECTION_SCHEMA;
  status: "ready" | "unavailable";
  scannedFiles: number;
  scannedUserMessages: number;
  correctionsFound: number;
  correctionsAdded: number;
}

interface PiSessionFacts {
  sessionId: string;
  hasIkbCalls: boolean;
  userMessages: Array<{ id: string; timestamp: string; text: string }>;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join(" ")
    .trim();
}

async function loadPiSessionFacts(path: string): Promise<PiSessionFacts | null> {
  const facts: PiSessionFacts = { sessionId: "", hasIkbCalls: false, userMessages: [] };
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
    if (row.type === "session" && typeof row.id === "string") {
      facts.sessionId = row.id;
      continue;
    }
    if (row.type !== "message") continue;
    sawMessage = true;
    const message = row.message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown; is_error?: unknown } | undefined;
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const row = block as { type?: unknown; name?: unknown; id?: unknown; callId?: unknown; arguments?: unknown; input?: unknown };
        const name = typeof row.name === "string" ? row.name : "";
        if (row.type !== "toolCall" && row.type !== "tool_call") continue;
        if (name === "ikb_search_cards" || name === "ikb_get_card") {
          // Historical Pi MCP records did not always retain a structured result.
          // Keep their call marker compatible with the old collector.
          facts.hasIkbCalls = true;
          continue;
        }
        if (!/^(?:bash|Bash|shell|exec|exec_command)$/.test(name)) continue;
        const operations = detectIkbCliOperations(row.arguments ?? row.input);
        const callId = typeof row.id === "string" ? row.id : typeof row.callId === "string" ? row.callId : "";
        if (operations.length > 0 && callId) {
          pendingCalls.set(callId, operations);
          onlyPendingCallId = callId;
        }
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolName === "string") {
      if (message.toolName.startsWith("ikb_")) facts.hasIkbCalls = true;
      const callId = typeof (message as { toolCallId?: unknown }).toolCallId === "string"
        ? (message as { toolCallId: string }).toolCallId
        : typeof (message as { callId?: unknown }).callId === "string"
          ? (message as { callId: string }).callId
          : onlyPendingCallId;
      const operations = callId ? pendingCalls.get(callId) : undefined;
      if (operations && message.isError !== true && message.is_error !== true && operations.some((operation) => hasValidIkbCliResult(message.content, operation))) facts.hasIkbCalls = true;
      if (callId) {
        pendingCalls.delete(callId);
        if (onlyPendingCallId === callId) onlyPendingCallId = null;
      }
      continue;
    }
    if (message.role !== "user") continue;
    const text = textFromContent(message.content);
    const timestamp = typeof row.timestamp === "string" ? row.timestamp : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (text && timestamp) facts.userMessages.push({ id, timestamp, text });
  }
  if (!sawMessage) return null;
  if (!facts.sessionId) facts.sessionId = path;
  return facts;
}

function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
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

export async function collectPiUserCorrections(options: {
  sessionRoots?: string[];
  activeDataRoot: string;
  from?: string;
  to?: string;
}): Promise<PiCorrectionCollectionReport> {
  const roots = (options.sessionRoots && options.sessionRoots.length > 0
    ? options.sessionRoots
    : [resolve(homedir(), ".pi", "agent", "sessions")]
  ).map((root) => resolve(root));
  const existing = roots.filter((root) => isAbsolute(root) && existsSync(root));
  const report: PiCorrectionCollectionReport = {
    schema: PI_CORRECTION_COLLECTION_SCHEMA,
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
      const facts = await loadPiSessionFacts(file);
      if (!facts) continue;
      report.scannedFiles += 1;
      report.scannedUserMessages += facts.userMessages.length;
      for (const message of facts.userMessages) {
        if (message.timestamp < effectiveFrom || message.timestamp > to) continue;
        // pi 会话没有显式 turn 边界：每条用户消息合成一个“turn”，
        // hadIkbCall 只精确到会话级（pi 日志里 ikb 调用无法归属到具体消息）。
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
            subjectRef: record.subjectRef.replace("run://codex/", "run://pi/"),
            sourceEventRef: record.sourceEventRef?.replace("run://codex/", "run://pi/"),
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
