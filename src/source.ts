import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { SourceContext, SourceKind, SourceMessage, SourceRecord } from "./types.ts";

export interface SourceImportOptions {
  kind: SourceKind;
  adapter?: string;
  includeTools?: boolean;
  title?: string;
  scope?: string;
  sensitivity?: string;
}

export interface SourceListOptions {
  includeQuarantined?: boolean;
}

export interface SourceIntegrityOptions {
  verifyRaw?: boolean;
}

export interface ReadSourceRecordsOptions {
  verifyRaw?: boolean;
  source?: SourceRecord;
}

/** Historical tool/project sessions remain auditable but do not feed the
 * default analysis plane. */
export function sourceQuarantineReason(source: Pick<SourceRecord, "title" | "originalPath">): string | null {
  const marker = `${source.title} ${source.originalPath}`.toLocaleLowerCase("en-US");
  if (marker.includes("specx") || marker.includes("openspec")) return "SpecX/OpenSpec 已明确不纳入当前 IKB";
  if (marker.includes("multica")) return "Multica 当前暂不纳入 IKB";
  if (marker.includes("km-get-rich")) return "km-get-rich 项目不属于当前 IKB 输入范围";
  return null;
}

export interface SourceIntegrityIssue {
  sourceId: string;
  code: "source_root_symlink" | "source_root_not_directory" | "source_directory_symlink" | "source_metadata_missing" | "source_metadata_symlink" | "source_metadata_malformed" | "source_id_directory_mismatch" | "source_ledger_event_missing" | "source_metadata_ledger_mismatch" | "path_outside_source" | "path_is_symlink" | "raw_missing" | "raw_not_file" | "raw_hash_mismatch" | "records_missing" | "records_not_file" | "records_hash_mismatch" | "records_malformed" | "record_count_mismatch";
  path: string;
  detail: string;
}

export interface SourceRegistryInspection {
  sources: SourceRecord[];
  issues: SourceIntegrityIssue[];
}

export function normalizeSourceScope(scope: string | undefined, fallback: "personal" | "work" = "personal"): "personal" | "work" {
  const value = scope ?? fallback;
  if (value !== "personal" && value !== "work") throw new Error(`Source scope must be personal or work: ${value}`);
  return value;
}

export function importSource(
  home: string,
  source: string,
  options: SourceImportOptions,
): { source: SourceRecord; records: SourceMessage[] } {
  const originalPath = resolve(source);
  if (!existsSync(originalPath) || !statSync(originalPath).isFile()) throw new Error(`Source file not found: ${source}`);
  const content = readFileSync(originalPath);
  const sourceId = makeSourceId();
  const records = parseSourceRecords(content.toString("utf8"), sourceId, options.kind, originalPath);
  return importSourceRecords(home, originalPath, content, options, records, sourceId);
}

export function parseSourceRecords(content: string, sourceId: string, kind: SourceKind, originalPath = ""): SourceMessage[] {
  return isJsonl(originalPath)
    ? parseJsonl(content, sourceId, kind)
    : [markdownRecord(content, sourceId, originalPath, kind)];
}

export function importSourceRecords(
  home: string,
  source: string,
  content: string | Uint8Array,
  options: SourceImportOptions,
  records: SourceMessage[],
  sourceId = makeSourceId(),
): { source: SourceRecord; records: SourceMessage[] } {
  const originalPath = resolve(source);
  if (!existsSync(originalPath) || !statSync(originalPath).isFile()) throw new Error(`Source file not found: ${source}`);
  const scope = normalizeSourceScope(options.scope);
  const format = isJsonl(originalPath) ? "jsonl" : "markdown";
  const sourceRoot = join(resolve(home), "sources");
  if (!isSafeSourceId(sourceId)) throw new Error(`Source id must use the safe src-* form: ${sourceId}`);
  validateSourceRecords(records, sourceId);
  assertSourceRoot(home, sourceRoot);
  const sourceDir = resolve(sourceRoot, sourceId);
  if (dirname(sourceDir) !== sourceRoot) throw new Error(`Source directory escapes the source root: ${sourceDir}`);
  if (existsSync(sourceDir)) throw new Error(`Source id already exists: ${sourceId}`);
  const rawDir = join(sourceDir, "raw");
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  assertSourceRoot(home, sourceRoot);
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  chmodSync(sourceRoot, 0o700);
  chmodSync(sourceDir, 0o700);
  chmodSync(rawDir, 0o700);
  const rawPath = join(rawDir, basename(originalPath));
  writeFileSync(rawPath, content, { mode: 0o600 });
  const recordsPath = join(sourceDir, "records.jsonl");
  const recordsContent = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeFileSync(recordsPath, recordsContent, { mode: 0o600 });
  const importedAt = new Date().toISOString();
  const record: SourceRecord = {
    id: sourceId,
    title: options.title ?? basename(originalPath, extname(originalPath)),
    kind: options.kind,
    adapter: options.adapter,
    includeTools: options.includeTools,
    scope,
    sensitivity: options.sensitivity ?? (scope === "work" ? "work-internal" : "private"),
    format,
    originalPath,
    rawPath,
    recordsPath,
    contentHash: hashSourceContent(content),
    recordsHash: hashSourceContent(recordsContent),
    recordCount: records.length,
    importedAt,
  };
  writeFileSync(join(sourceDir, "source.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { source: record, records };
}

export function findSourceByOriginAndHash(home: string, source: string, contentHash: string, options: { adapter?: string; scope?: string; sensitivity?: string; includeTools?: boolean } = {}): SourceRecord | null {
  const originalPath = resolve(source);
  return listSources(home, { includeQuarantined: true }).find((record) => (
    record.originalPath === originalPath
    && record.contentHash === contentHash
    && (!options.adapter || record.adapter === options.adapter)
    && (!options.scope || record.scope === options.scope)
    && (!options.sensitivity || record.sensitivity === options.sensitivity)
    && (options.includeTools === undefined || Boolean(record.includeTools) === options.includeTools)
    && Boolean(record.recordsHash)
    && inspectSourceIntegrity(home, record).length === 0
  )) ?? null;
}

export function inspectSourceIntegrity(home: string, source: SourceRecord, options: SourceIntegrityOptions = {}): SourceIntegrityIssue[] {
  const issues: SourceIntegrityIssue[] = [];
  const sourceDirectory = join(resolve(home), "sources", source.id);
  const realSourceDirectory = existsSync(sourceDirectory) ? realpathSync(sourceDirectory) : sourceDirectory;
  const inspectPath = (path: string, kind: "raw" | "records"): boolean => {
    const absolutePath = resolve(path);
    const relativePath = relative(sourceDirectory, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      issues.push({ sourceId: source.id, code: "path_outside_source", path: absolutePath, detail: `${kind} path is outside ${sourceDirectory}` });
      return false;
    }
    if (!existsSync(absolutePath)) {
      issues.push({ sourceId: source.id, code: kind === "raw" ? "raw_missing" : "records_missing", path: absolutePath, detail: `${kind} file is missing` });
      return false;
    }
    if (lstatSync(absolutePath).isSymbolicLink()) {
      issues.push({ sourceId: source.id, code: "path_is_symlink", path: absolutePath, detail: `${kind} path must not be a symlink` });
      return false;
    }
    const realPath = realpathSync(absolutePath);
    const realRelativePath = relative(realSourceDirectory, realPath);
    if (!realRelativePath || realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
      issues.push({ sourceId: source.id, code: "path_outside_source", path: absolutePath, detail: `${kind} real path is outside ${realSourceDirectory}` });
      return false;
    }
    if (!lstatSync(absolutePath).isFile()) {
      issues.push({ sourceId: source.id, code: kind === "raw" ? "raw_not_file" : "records_not_file", path: absolutePath, detail: `${kind} path is not a file` });
      return false;
    }
    return true;
  };

  if (options.verifyRaw !== false && inspectPath(source.rawPath, "raw")) {
    const actualHash = hashSourceContent(readFileSync(source.rawPath));
    if (actualHash !== source.contentHash) {
      issues.push({ sourceId: source.id, code: "raw_hash_mismatch", path: source.rawPath, detail: `expected ${source.contentHash}, got ${actualHash}` });
    }
  }

  if (inspectPath(source.recordsPath, "records")) {
    const text = readFileSync(source.recordsPath, "utf8");
    if (source.recordsHash) {
      const actualHash = hashSourceContent(text);
      if (actualHash !== source.recordsHash) {
        issues.push({ sourceId: source.id, code: "records_hash_mismatch", path: source.recordsPath, detail: `expected ${source.recordsHash}, got ${actualHash}` });
      }
    }
    const lines = text.split("\n").filter((line) => line.trim());
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const value = JSON.parse(lines[index]);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
      } catch (error) {
        issues.push({ sourceId: source.id, code: "records_malformed", path: source.recordsPath, detail: `line ${index + 1}: ${(error as Error).message}` });
      }
    }
    if (lines.length !== source.recordCount) {
      issues.push({ sourceId: source.id, code: "record_count_mismatch", path: source.recordsPath, detail: `expected ${source.recordCount}, got ${lines.length}` });
    }
  }
  return issues;
}

export function listSources(home: string, options: SourceListOptions = {}): SourceRecord[] {
  const inspection = inspectSourceRegistry(home);
  if (inspection.issues.length > 0) {
    throw new Error(`Source registry has integrity issues: ${inspection.issues.map((issue) => `${issue.code}:${issue.sourceId}`).join(", ")}`);
  }
  return options.includeQuarantined === true ? inspection.sources : inspection.sources.filter((source) => !sourceQuarantineReason(source));
}

export function inspectSourceRegistry(home: string): SourceRegistryInspection {
  const root = join(resolve(home), "sources");
  if (!existsSync(root)) return { sources: [], issues: [] };
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) return { sources: [], issues: [{ sourceId: "sources", code: "source_root_symlink", path: root, detail: "sources root must not be a symlink" }] };
  if (!rootStat.isDirectory()) return { sources: [], issues: [{ sourceId: "sources", code: "source_root_not_directory", path: root, detail: "sources root must be a directory" }] };
  const sources: SourceRecord[] = [];
  const issues: SourceIntegrityIssue[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      issues.push({ sourceId: entry.name, code: "source_directory_symlink", path: join(root, entry.name), detail: "source directory must not be a symlink" });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const metadataPath = join(root, entry.name, "source.json");
    if (!existsSync(metadataPath)) {
      issues.push({ sourceId: entry.name, code: "source_metadata_missing", path: metadataPath, detail: "source directory has no source.json" });
      continue;
    }
    if (lstatSync(metadataPath).isSymbolicLink()) {
      issues.push({ sourceId: entry.name, code: "source_metadata_symlink", path: metadataPath, detail: "source.json must not be a symlink" });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch (error) {
      issues.push({ sourceId: entry.name, code: "source_metadata_malformed", path: metadataPath, detail: (error as Error).message });
      continue;
    }
    if (!isSourceRecord(value)) {
      issues.push({ sourceId: entry.name, code: "source_metadata_malformed", path: metadataPath, detail: "source.json is missing required fields or has invalid field types" });
      continue;
    }
    if (value.id !== entry.name) {
      issues.push({ sourceId: entry.name, code: "source_id_directory_mismatch", path: metadataPath, detail: `metadata id is ${value.id}` });
      continue;
    }
    sources.push(value);
  }
  sources.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  return { sources, issues };
}

function isSourceRecord(value: unknown): value is SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const stringFields = ["id", "title", "kind", "scope", "sensitivity", "format", "originalPath", "rawPath", "recordsPath", "contentHash", "importedAt"];
  return stringFields.every((field) => typeof record[field] === "string" && Boolean((record[field] as string).trim()))
    && isSafeSourceId(String(record.id))
    && (record.scope === "personal" || record.scope === "work")
    && (record.format === "jsonl" || record.format === "markdown")
    && Number.isInteger(record.recordCount)
    && Number(record.recordCount) >= 0
    && (record.recordsHash === undefined || typeof record.recordsHash === "string");
}

function isSafeSourceId(value: string): boolean {
  return /^src-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertSourceRoot(home: string, root: string): void {
  if (!existsSync(root)) return;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Sources root must not be a symlink: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Sources root must be a directory: ${root}`);
  const realHome = realpathSync(resolve(home));
  const realRoot = realpathSync(root);
  if (dirname(realRoot) !== realHome) throw new Error(`Sources root escapes the home directory: ${root}`);
}

export function findSource(home: string, id: string): SourceRecord | null {
  return listSources(home, { includeQuarantined: true }).find((source) => source.id === id) ?? null;
}

export function readSourceRecords(home: string, id: string, options: ReadSourceRecordsOptions = {}): SourceMessage[] {
  const source = options.source?.id === id ? options.source : findSource(home, id);
  if (!source) throw new Error(`Source not found: ${id}`);
  const integrityIssues = inspectSourceIntegrity(home, source, options);
  if (integrityIssues.length > 0) throw new Error(`Source ${id} failed integrity checks: ${integrityIssues.map((issue) => issue.code).join(", ")}`);
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
    `- Adapter: ${source.adapter ?? "direct"}`,
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
      `- Participants: ${record.participants.join(", ") || "unknown"}`,
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
  const actor = actorFromRow(row) ?? role;
  const content = contentFromRow(row) ?? JSON.stringify(row);
  return {
    id: `${sourceId}:${conversationId}:${messageId}:${line}`,
    sourceId,
    conversationId,
    role,
    actor,
    timestamp: firstString(row, ["timestamp", "sent_at", "sentAt", "created_at", "createdAt", "updated_at", "updatedAt"]) ?? "",
    content,
    refs: collectStrings(row, ["refs", "source_refs", "sourceRefs", "files", "urls", "url", "path", "file"]),
    participants: participantsFromRow(row),
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

function actorFromRow(row: Record<string, unknown>): string | null {
  for (const key of ["actor", "author", "user", "sender", "name", "from", "sender_id"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstString(value as Record<string, unknown>, ["id", "user_id", "uid", "name", "display_name"]);
      if (nested) return nested;
    }
  }
  return null;
}

function contentFromRow(row: Record<string, unknown>): string | null {
  for (const key of ["content", "text", "message", "body", "comment"]) {
    const value = textFromValue(row[key]);
    if (value) return value;
  }
  return null;
}

function textFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const text = value.map(textFromValue).filter((item): item is string => Boolean(item)).join("\n\n").trim();
    return text || null;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return textFromValue(object.text ?? object.content ?? object.message ?? object.body);
  }
  return null;
}

function participantsFromRow(row: Record<string, unknown>): string[] {
  const participants: string[] = [];
  for (const key of ["participants", "participant_ids", "participantIds"]) {
    const value = row[key];
    if (!Array.isArray(value)) {
      if (typeof value === "string" && value.trim()) participants.push(value);
      continue;
    }
    for (const item of value) {
      if (typeof item === "string" && item.trim()) participants.push(item);
      else if (item && typeof item === "object" && !Array.isArray(item)) {
        const nested = firstString(item as Record<string, unknown>, ["id", "user_id", "uid", "name", "display_name"]);
        if (nested) participants.push(nested);
      }
    }
  }
  return [...new Set(participants)];
}

function isJsonl(path: string): boolean {
  return [".jsonl", ".ndjson"].includes(extname(path).toLowerCase());
}

function validateSourceRecords(records: SourceMessage[], sourceId: string): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.sourceId !== sourceId) throw new Error(`Normalized record ${record.id} belongs to ${record.sourceId}, expected ${sourceId}`);
    if (!record.id || seen.has(record.id)) throw new Error(`Normalized records contain duplicate or empty id: ${record.id}`);
    seen.add(record.id);
  }
}

export function hashSourceContent(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function makeSourceId(): string {
  return `src-${randomUUID().slice(0, 12)}`;
}
