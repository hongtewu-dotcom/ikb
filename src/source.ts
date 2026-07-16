import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { SourceContext, SourceKind, SourceMessage, SourceRecord } from "./types.ts";

export function importSource(
  home: string,
  source: string,
  options: { kind: SourceKind; title?: string; scope?: string; sensitivity?: string },
): { source: SourceRecord; records: SourceMessage[] } {
  const originalPath = resolve(source);
  if (!existsSync(originalPath) || !statSync(originalPath).isFile()) throw new Error(`Source file not found: ${source}`);
  const content = readFileSync(originalPath);
  const sourceId = `src-${randomUUID().slice(0, 12)}`;
  const format = isJsonl(originalPath) ? "jsonl" : "markdown";
  const sourceDir = join(resolve(home), "sources", sourceId);
  const rawDir = join(sourceDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, basename(originalPath));
  copyFileSync(originalPath, rawPath);
  const records = format === "jsonl"
    ? parseJsonl(content.toString("utf8"), sourceId, options.kind)
    : [markdownRecord(content.toString("utf8"), sourceId, originalPath, options.kind)];
  const recordsPath = join(sourceDir, "records.jsonl");
  writeFileSync(recordsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const importedAt = new Date().toISOString();
  const record: SourceRecord = {
    id: sourceId,
    title: options.title ?? basename(originalPath, extname(originalPath)),
    kind: options.kind,
    scope: options.scope ?? "personal",
    sensitivity: options.sensitivity ?? (options.scope === "work" ? "work-internal" : "private"),
    format,
    originalPath,
    rawPath,
    recordsPath,
    contentHash: sha256(content),
    recordCount: records.length,
    importedAt,
  };
  writeFileSync(join(sourceDir, "source.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { source: record, records };
}

export function listSources(home: string): SourceRecord[] {
  const root = join(resolve(home), "sources");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "source.json"))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as SourceRecord)
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
}

export function findSource(home: string, id: string): SourceRecord | null {
  return listSources(home).find((source) => source.id === id) ?? null;
}

export function readSourceRecords(home: string, id: string): SourceMessage[] {
  const source = findSource(home, id);
  if (!source) throw new Error(`Source not found: ${id}`);
  if (!existsSync(source.recordsPath)) throw new Error(`Normalized records missing for Source ${id}: ${source.recordsPath}`);
  const text = readFileSync(source.recordsPath, "utf8");
  if (!text.trim()) return [];
  return text.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as SourceMessage;
    } catch (error) {
      throw new Error(`Invalid normalized record at ${source.recordsPath}:${index + 1}: ${(error as Error).message}`);
    }
  });
}

export function buildSourceContext(home: string, id: string, limit = 100): SourceContext {
  const source = findSource(home, id);
  if (!source) throw new Error(`Source not found: ${id}`);
  const records = readSourceRecords(home, id).slice(0, limit);
  const markdown = [
    `# Source Context: ${source.title}`,
    "",
    `- Source ID: ${source.id}`,
    `- Kind: ${source.kind}`,
    `- Scope: ${source.scope}`,
    `- Sensitivity: ${source.sensitivity}`,
    `- Imported: ${source.importedAt}`,
    `- Content hash: ${source.contentHash}`,
    `- Records: ${records.length}/${source.recordCount}`,
    "",
    ...records.flatMap((record) => [
      `## ${record.id}`,
      `- Conversation: ${record.conversationId}`,
      `- Role: ${record.role}`,
      `- Actor: ${record.actor}`,
      `- Timestamp: ${record.timestamp || "unknown"}`,
      `- Refs: ${record.refs.join(", ") || "none"}`,
      "",
      record.content.trim(),
      "",
    ]),
  ].join("\n");
  return { source, records, markdown };
}

function parseJsonl(text: string, sourceId: string, kind: SourceKind): SourceMessage[] {
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid source JSONL at line ${index + 1}: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Source JSONL line ${index + 1} must be an object`);
    return [normalizeMessage(value as Record<string, unknown>, sourceId, kind, index + 1)];
  });
}

function normalizeMessage(row: Record<string, unknown>, sourceId: string, kind: SourceKind, line: number): SourceMessage {
  const conversationId = firstString(row, ["conversation_id", "conversationId", "session_id", "sessionId", "thread_id", "threadId"]) ?? `${sourceId}:conversation`;
  const messageId = firstString(row, ["message_id", "messageId", "turn_id", "turnId", "id"]) ?? `line-${line}`;
  const role = firstString(row, ["role", "message_role", "messageRole"]) ?? (kind === "ai_conversation" ? "unknown" : kind);
  const actor = firstString(row, ["actor", "author", "user", "sender", "name"]) ?? role;
  const content = firstString(row, ["content", "text", "message", "body", "comment"]) ?? JSON.stringify(row);
  return {
    id: `${sourceId}:${messageId}`,
    sourceId,
    conversationId,
    role,
    actor,
    timestamp: firstString(row, ["timestamp", "sent_at", "sentAt", "created_at", "createdAt", "updated_at", "updatedAt"]) ?? "",
    content,
    refs: collectStrings(row, ["refs", "source_refs", "sourceRefs", "files", "urls", "url", "path", "file"]),
    participants: collectStrings(row, ["participants", "participant_ids", "participantIds"]),
  };
}

function markdownRecord(content: string, sourceId: string, originalPath: string, kind: SourceKind): SourceMessage {
  return {
    id: `${sourceId}:document-1`,
    sourceId,
    conversationId: `${sourceId}:document`,
    role: kind === "review_comment" ? "review_comment" : "document",
    actor: "unknown",
    timestamp: "",
    content,
    refs: [originalPath],
    participants: [],
  };
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function collectStrings(row: Record<string, unknown>, keys: string[]): string[] {
  const result: string[] = [];
  for (const key of keys) {
    const value = row[key];
    if (Array.isArray(value)) result.push(...value.filter((item) => typeof item === "string").map(String));
    else if (typeof value === "string" && value.trim()) result.push(value);
  }
  return [...new Set(result)];
}

function isJsonl(path: string): boolean {
  return [".jsonl", ".ndjson"].includes(extname(path).toLowerCase());
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
