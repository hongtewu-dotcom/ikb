import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { importIncrementalRecords, type IncrementalImportResult } from "./incremental.ts";
import { findSourceByOriginAndHash, hashSourceContent, importSourceRecords, listSources, readSourceRecords } from "./source.ts";
import type { SourceMessage, SourceRecord } from "./types.ts";

export type ExternalJsonRunner = (command: string, args: string[], timeoutMs: number) => unknown;

export interface CitadelIngestOptions {
  scope?: string;
  sensitivity?: string;
  includeComments?: boolean;
  command?: string;
  timeoutMs?: number;
  runner?: ExternalJsonRunner;
  incremental?: boolean;
}

export interface CitadelIngestResult {
  contentId: string;
  title: string;
  document: {
    source: SourceRecord;
    imported: boolean;
    incremental?: IncrementalImportResult;
  };
  comments: {
    source: SourceRecord;
    imported: boolean;
    count: number;
    incremental?: IncrementalImportResult;
  } | null;
  metadata: Record<string, unknown>;
}

export interface CitadelSearchOptions {
  keyword: string;
  searchTitle?: boolean;
  offset?: number;
  limit?: number;
  spaceUrl?: string;
  spaceId?: string;
  parentUrls?: string;
  parentIds?: string;
  command?: string;
  timeoutMs?: number;
  runner?: ExternalJsonRunner;
}

export interface CitadelSearchHit {
  contentId: string;
  title: string;
  url: string;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface CitadelSearchResult {
  searchId: string;
  request: Record<string, string | number | boolean>;
  hits: CitadelSearchHit[];
  response: unknown;
}

export interface ElephantIngestOptions {
  uid?: string;
  gid?: string;
  pid?: string;
  name?: string;
  mis?: string;
  type?: string;
  keyword?: string;
  from?: string;
  to?: string;
  cursorMsg?: string;
  limit?: number;
  scope?: string;
  sensitivity?: string;
  command?: string;
  cdpUrl?: string;
  timeoutMs?: number;
  runner?: ExternalJsonRunner;
  incremental?: boolean;
}

export interface ElephantIngestResult {
  operation: typeof ELEPHANT_READ_ONLY_OPERATION;
  readOnly: true;
  request: Record<string, string | number>;
  source: SourceRecord | null;
  imported: boolean;
  skipped: boolean;
  reason?: string;
  recordCount: number;
  deltaCount?: number;
  duplicateCount?: number;
  changedCount?: number;
  incremental?: IncrementalImportResult;
}

/**
 * The Elephant bridge is intentionally a read-only surface. Keep this as a
 * named contract so new callers cannot silently add a write-capable action.
 */
export const ELEPHANT_READ_ONLY_OPERATION = "history" as const;

const ELEPHANT_WRITE_OPERATIONS = new Set([
  "send",
  "reply",
  "forward",
  "like",
  "react",
  "create",
  "update",
  "delete",
  "group",
]);

const defaultRunner: ExternalJsonRunner = (command, args, timeoutMs) => {
  let stdout: string;
  try {
    stdout = execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} failed: ${detail}`);
  }
  return parseJsonOutput(stdout, command);
};

export function ingestCitadelDocument(home: string, contentIdValue: string, options: CitadelIngestOptions = {}): CitadelIngestResult {
  const contentId = normalizeContentId(contentIdValue);
  const scope = normalizeScope(options.scope);
  const sensitivity = options.sensitivity ?? (scope === "personal" ? "private" : "work-internal");
  const runner = options.runner ?? defaultRunner;
  const command = options.command ?? citadelCommand();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const documentEnvelope = asObject(runner(command, ["citadel", "getSimpleMarkdown", "--contentId", contentId, "--raw"], timeoutMs));
  const metadata = asObject(runner(command, ["citadel", "getDocumentMetaInfo", "--contentId", contentId, "--raw"], timeoutMs));
  const title = firstString(documentEnvelope, ["title"]) ?? firstString(metadata, ["title"]) ?? `学城文档 ${contentId}`;
  const content = firstString(documentEnvelope, ["content"]);
  if (!content) throw new Error(`Citadel document ${contentId} returned empty content`);

  const documentPath = writeStaging(home, join("citadel", `${contentId}.md`), content);
  const documentSource = importSnapshot(home, documentPath, content, {
    kind: "document",
    adapter: "citadel",
    title,
    scope,
    sensitivity,
    incremental: options.incremental !== false,
    logicalKey: `citadel:document:${contentId}`,
  }, [makeDocumentMessage(documentPath, contentId, title, content, metadata)], "citadel");

  let comments: CitadelIngestResult["comments"] = null;
  if (options.includeComments !== false) {
    const commentsEnvelope = asObject(runner(command, ["citadel", "getAllComments", "--contentId", contentId, "--raw"], timeoutMs));
    const rows = flattenCitadelComments(commentsEnvelope, contentId, title);
    if (rows.length > 0) {
      const rawComments = `${JSON.stringify({ contentId, title, comments: commentsEnvelope }, null, 2)}\n`;
      const commentsPath = writeStaging(home, join("citadel", `${contentId}.comments.jsonl`), rawComments);
      const commentSource = importSnapshot(home, commentsPath, rawComments, {
        kind: "review_comment",
        adapter: "citadel",
        title: `${title} - 评论`,
        scope,
        sensitivity,
        incremental: options.incremental !== false,
        logicalKey: `citadel:comments:${contentId}`,
      }, rows.map((row, index) => makeCommentMessage(commentsPath, contentId, row, index)), "citadel");
      comments = { source: commentSource.source, imported: commentSource.imported, count: rows.length, incremental: commentSource.incremental };
    }
  }

  return {
    contentId,
    title,
    document: { source: documentSource.source, imported: documentSource.imported, incremental: documentSource.incremental },
    comments,
    metadata,
  };
}

export function searchCitadel(options: CitadelSearchOptions): CitadelSearchResult {
  const keyword = String(options.keyword ?? "").trim();
  if (!keyword) throw new Error("Citadel search requires a keyword");
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Citadel search --offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Citadel search --limit must be an integer between 1 and 200");
  if (options.spaceUrl && options.spaceId) throw new Error("Citadel search accepts either --space-url or --space-id, not both");
  if (options.parentUrls && options.parentIds) throw new Error("Citadel search accepts either --parent-urls or --parent-ids, not both");
  const request: Record<string, string | number | boolean> = { keyword, offset, limit };
  if (options.searchTitle) request.searchTitle = true;
  if (options.spaceUrl) request.spaceUrl = options.spaceUrl;
  if (options.spaceId) request.spaceId = options.spaceId;
  if (options.parentUrls) request.parentUrls = options.parentUrls;
  if (options.parentIds) request.parentIds = options.parentIds;
  const command = options.command ?? citadelCommand();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const runner = options.runner ?? defaultRunner;
  const args = ["citadel", "searchContent", "--keyword", keyword, ...(options.searchTitle ? ["--searchTitle"] : []), "--offset", String(offset), "--limit", String(limit)];
  if (options.spaceUrl) args.push("--space-url", options.spaceUrl);
  if (options.spaceId) args.push("--space-id", options.spaceId);
  if (options.parentUrls) args.push("--parent-urls", options.parentUrls);
  if (options.parentIds) args.push("--parent-ids", options.parentIds);
  args.push("--raw");
  const response = runner(command, args, timeoutMs);
  const hits = normalizeCitadelSearchHits(response);
  const searchId = `search-${hashSourceContent(JSON.stringify(request)).slice(0, 16)}`;
  return { searchId, request, hits, response };
}

function citadelCommand(): string {
  const configured = process.env.IKB_CITADEL_COMMAND?.trim();
  if (configured) return configured;
  const adjacentGlobalBin = resolve(dirname(process.execPath), "../lib/node_modules/@it/oa-skills/dist/cli.js");
  return existsSync(adjacentGlobalBin) ? adjacentGlobalBin : "oa-skills";
}

export function snapshotCitadelSearch(home: string, result: CitadelSearchResult): { path: string; hash: string } {
  const content = `${JSON.stringify({ searchId: result.searchId, request: result.request, response: result.response }, null, 2)}\n`;
  const path = writeStaging(home, join("citadel", "search", `${result.searchId}.json`), content);
  return { path, hash: hashSourceContent(content) };
}

export function ingestElephantHistory(home: string, options: ElephantIngestOptions = {}): ElephantIngestResult {
  const request = normalizeElephantRequest(options);
  const scope = normalizeScope(options.scope);
  const sensitivity = options.sensitivity ?? (scope === "personal" ? "private" : "work-internal");
  const runner = options.runner ?? defaultRunner;
  const command = options.command ?? process.env.IKB_ELEPHANT_COMMAND ?? "dx";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const args = elephantCommandArgs(request, options.cdpUrl ?? process.env.IKB_ELEPHANT_CDP_URL);
  const response = asObject(runner(command, args, timeoutMs));
  const rawMessages = arrayValue(response.messages);
  const targetKey = elephantTargetKey(request);
  if (rawMessages.length === 0) {
    return { operation: ELEPHANT_READ_ONLY_OPERATION, readOnly: true, request, source: null, imported: false, skipped: true, reason: "no messages", recordCount: 0 };
  }

  const sourceId = makeSourceId();
  const records = rawMessages.flatMap((row, index) => normalizeElephantMessage(row, sourceId, request, targetKey, index));
  if (records.length === 0) {
    return { operation: ELEPHANT_READ_ONLY_OPERATION, readOnly: true, request, source: null, imported: false, skipped: true, reason: "no user-visible messages", recordCount: 0 };
  }
  const rawContent = `${JSON.stringify({ normalizerVersion: 3, request, response }, null, 2)}\n`;
  const requestHash = hashSourceContent(JSON.stringify(request)).slice(0, 20);
  const rawPath = writeStaging(home, join("elephant", `${requestHash}.jsonl`), rawContent);
  const imported = importSnapshot(home, rawPath, rawContent, {
    kind: "elephant",
    adapter: "elephant",
    title: `大象：${targetKey}`,
    scope,
    sensitivity,
    incremental: options.incremental !== false,
    logicalKey: elephantLogicalKey(request, targetKey),
  }, records, "elephant", true);
  return {
    operation: ELEPHANT_READ_ONLY_OPERATION,
    readOnly: true,
    request,
    source: imported.source,
    imported: imported.imported,
    skipped: !imported.imported,
    reason: imported.imported ? undefined : (imported.incremental?.reason ?? "unchanged"),
    recordCount: records.length,
    deltaCount: imported.incremental?.deltaCount,
    duplicateCount: imported.incremental?.duplicateCount,
    changedCount: imported.incremental?.changedCount,
    incremental: imported.incremental,
  };
}

function importSnapshot(
  home: string,
  originalPath: string,
  content: string,
  options: { kind: string; adapter: string; title: string; scope: string; sensitivity: string; incremental?: boolean; logicalKey?: string },
  records: SourceMessage[],
  adapter: string,
  dedupeByNormalizedRecords = false,
): { source: SourceRecord; imported: boolean; incremental?: IncrementalImportResult } {
  if (options.incremental) {
    const result = importIncrementalRecords(home, originalPath, content, {
      kind: options.kind,
      adapter: options.adapter,
      title: options.title,
      scope: options.scope,
      sensitivity: options.sensitivity,
      logicalKey: options.logicalKey,
    }, records);
    if (!result.source) throw new Error(`Incremental source ${options.title} produced no source`);
    return { source: result.source, imported: result.imported, incremental: result };
  }
  const contentHash = hashSourceContent(content);
  const existing = findSourceByOriginAndHash(home, originalPath, contentHash, {
    adapter,
    scope: options.scope,
    sensitivity: options.sensitivity,
  });
  if (existing) return { source: existing, imported: false };
  if (dedupeByNormalizedRecords) {
    const normalizedHash = hashNormalizedRecords(records);
    const normalizedExisting = listSources(home).find((candidate) => (
      candidate.originalPath === resolve(originalPath)
      && candidate.adapter === options.adapter
      && candidate.scope === options.scope
      && candidate.sensitivity === options.sensitivity
      && hashNormalizedRecords(readSourceRecords(home, candidate.id, { verifyRaw: false, source: candidate })) === normalizedHash
    ));
    if (normalizedExisting) return { source: normalizedExisting, imported: false };
  }
  const sourceId = records[0]?.sourceId ?? makeSourceId();
  const result = importSourceRecords(home, originalPath, content, {
    kind: options.kind,
    adapter: options.adapter,
    scope: options.scope,
    sensitivity: options.sensitivity,
    title: options.title,
  }, records.map((record) => ({ ...record, sourceId, id: record.id.replace(record.sourceId, sourceId) })), sourceId);
  return { source: result.source, imported: true };
}

function elephantLogicalKey(request: Record<string, string | number>, targetKey: string): string {
  const stable = ["type", "keyword", "from", "to"]
    .filter((key) => request[key] !== undefined)
    .map((key) => `${key}=${String(request[key])}`)
    .join("&");
  return `elephant:${targetKey}${stable ? `?${stable}` : ""}`;
}

function hashNormalizedRecords(records: SourceMessage[]): string {
  const normalized = records.map((record) => {
    const { id: _id, sourceId: _sourceId, ...stableRecord } = record;
    return stableSerialize(stableRecord);
  }).join("\n");
  return hashSourceContent(normalized);
}

function normalizeCitadelSearchHits(value: unknown): CitadelSearchHit[] {
  const rows = collectSearchRows(value);
  const seen = new Set<string>();
  const hits: CitadelSearchHit[] = [];
  for (const row of rows) {
    const url = firstString(row, ["url", "link", "href", "contentUrl", "pageUrl"]) ?? "";
    const contentId = firstString(row, ["contentId", "content_id", "docId", "documentId", "id"]) ?? url.match(/(?:page|collabpage)\/(\d{1,32})/)?.[1] ?? "";
    if (!/^\d{1,32}$/.test(contentId) || seen.has(contentId)) continue;
    seen.add(contentId);
    const title = firstString(row, ["title", "docTitle", "name"]) ?? `学城文档 ${contentId}`;
    const snippet = firstString(row, ["summary", "excerpt", "highlight", "description", "content", "text"]) ?? "";
    hits.push({ contentId, title, url: url || `https://km.sankuai.com/page/${contentId}`, snippet, metadata: row });
  }
  return hits;
}

function collectSearchRows(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    const objectRows = value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    if (objectRows.length > 0) return objectRows.flatMap((row) => isSearchRow(row) ? [row] : collectSearchRows(row, depth + 1));
    return [];
  }
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const preferred = ["data", "results", "result", "list", "items", "contents", "contentList", "documents", "records"];
  for (const key of preferred) {
    if (object[key] !== undefined) {
      const rows = collectSearchRows(object[key], depth + 1);
      if (rows.length > 0) return rows;
    }
  }
  return Object.values(object).flatMap((item) => collectSearchRows(item, depth + 1));
}

function isSearchRow(row: Record<string, unknown>): boolean {
  return ["contentId", "content_id", "docId", "documentId", "id", "url", "link", "href"].some((key) => row[key] !== undefined);
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

function makeDocumentMessage(originalPath: string, contentId: string, title: string, content: string, metadata: Record<string, unknown>): SourceMessage {
  const sourceId = makeSourceId();
  const url = `https://km.sankuai.com/page/${contentId}`;
  const metadataIdentities = [
    ["creator", firstString(metadata, ["creator", "creatorMis", "creatorUid", "creatorName"])],
    ["owner", firstString(metadata, ["owner", "ownerMis", "ownerUid", "ownerName"])],
    ["modifier", firstString(metadata, ["modifier", "modifierMis", "modifierUid", "modifierName"])],
    ["author", firstString(metadata, ["author", "authorMis", "authorUid", "authorName"])],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const participants = [...new Set(metadataIdentities.map(([, value]) => value))];
  return {
    id: `${sourceId}:document:${contentId}`,
    sourceId,
    conversationId: `citadel:${contentId}`,
    role: "document",
    actor: firstString(metadata, ["modifier", "owner", "creator"]) ?? "unknown",
    timestamp: toIsoTimestamp(metadata.modifyTime ?? metadata.modify_time),
    content,
    refs: [url, `contentId:${contentId}`, `title:${title}`, originalPath, ...metadataIdentities.map(([key, value]) => `${key}:${value}`)],
    participants: participants.length > 0 ? participants : ["unknown"],
  };
}

interface CitadelCommentRow {
  commentId: string;
  type: "discussion" | "full_text";
  parentCommentId: string;
  rootCommentId: string;
  quoteId: string;
  quoteContent: string;
  content: string;
  creator: string;
  createTime: unknown;
  resolved: unknown;
}

function flattenCitadelComments(envelope: Record<string, unknown>, contentId: string, _title: string): CitadelCommentRow[] {
  const rows: CitadelCommentRow[] = [];
  for (const type of ["discussion", "full_text"] as const) {
    const key = type === "discussion" ? "discussionComments" : "fullTextComments";
    for (const value of arrayValue(envelope[key])) {
      const root = asObject(value);
      const rootId = firstString(root, ["commentId", "id"]) ?? `${type}-root-${rows.length + 1}`;
      appendCommentRow(rows, root, type, contentId, rootId, "");
      for (const reply of arrayValue(root.replies)) {
        appendCommentRow(rows, asObject(reply), type, contentId, rootId, rootId);
      }
    }
  }
  return rows;
}

function appendCommentRow(rows: CitadelCommentRow[], value: Record<string, unknown>, type: "discussion" | "full_text", _contentId: string, rootId: string, parentCommentId: string): void {
  const content = firstString(value, ["content", "text", "comment", "body"]);
  if (!content) return;
  rows.push({
    commentId: firstString(value, ["commentId", "id"]) ?? `${type}-${rows.length + 1}`,
    type,
    parentCommentId,
    rootCommentId: rootId,
    quoteId: firstString(value, ["quoteId", "quote_id"]) ?? "",
    quoteContent: firstString(value, ["quoteContent", "quote_content"]) ?? "",
    content,
    creator: firstString(value, ["creator", "author", "user", "sender"]) ?? "unknown",
    createTime: value.createTime ?? value.createdAt ?? value.created_at,
    resolved: value.resolved,
  });
}

function makeCommentMessage(originalPath: string, contentId: string, row: CitadelCommentRow, index: number): SourceMessage {
  const sourceId = makeSourceId();
  const url = `https://km.sankuai.com/page/${contentId}`;
  const quote = row.quoteContent ? `引用：${row.quoteContent}\n` : "";
  const status = row.resolved === undefined ? "" : `\n状态：${row.resolved ? "已解决" : "未解决"}`;
  return {
    id: `${sourceId}:comment:${row.commentId}:${index + 1}`,
    sourceId,
    conversationId: `citadel:${contentId}:comment:${row.rootCommentId}`,
    role: row.parentCommentId ? "review_reply" : "review_comment",
    actor: row.creator,
    timestamp: toIsoTimestamp(row.createTime),
    content: `${quote}评论：${row.content}${status}`,
    refs: [url, `contentId:${contentId}`, `commentId:${row.commentId}`, `rootCommentId:${row.rootCommentId}`, ...(row.parentCommentId ? [`parentCommentId:${row.parentCommentId}`] : []), ...(row.quoteId ? [`quoteId:${row.quoteId}`] : []), originalPath],
    participants: [row.creator],
  };
}

function normalizeElephantRequest(options: ElephantIngestOptions): Record<string, string | number> {
  const targets = ["uid", "gid", "pid", "name", "mis"] as const;
  const selected = targets.filter((key) => String(options[key] ?? "").trim());
  if (selected.length !== 1) throw new Error("Elephant intake requires exactly one of --uid, --gid, --pid, --name, or --mis");
  const request: Record<string, string | number> = { [selected[0]]: String(options[selected[0]]).trim() };
  const type = String(options.type ?? "").trim();
  if (type && !["chat", "group", "pub"].includes(type)) throw new Error("Elephant --type must be chat, group, or pub");
  if (type) request.type = type;
  for (const key of ["keyword", "from", "to", "cursorMsg"] as const) {
    const value = String(options[key] ?? "").trim();
    if (value) request[key] = value;
  }
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Elephant --limit must be an integer between 1 and 500");
  request.limit = limit;
  return request;
}

function elephantCommandArgs(request: Record<string, string | number>, cdpUrl?: string): string[] {
  const targetKey = ["uid", "gid", "pid", "name", "mis"].find((key) => request[key] !== undefined);
  if (!targetKey) throw new Error("Elephant target is missing");
  const args = ["--json", ...(cdpUrl ? ["--cdp-url", cdpUrl] : []), ELEPHANT_READ_ONLY_OPERATION, `--${targetKey}`, String(request[targetKey]), "--limit", String(request.limit), "--raw-payload"];
  for (const key of ["type", "keyword", "from", "to", "cursorMsg"] as const) {
    if (request[key] !== undefined) args.push(`--${key === "cursorMsg" ? "cursor-msg" : key}`, String(request[key]));
  }
  assertElephantReadOnlyArgs(args);
  return args;
}

function assertElephantReadOnlyArgs(args: string[]): void {
  let index = 0;
  while (index < args.length && args[index]?.startsWith("--")) {
    index += 1;
    if (args[index - 1] === "--cdp-url") index += 1;
  }
  const operation = args[index];
  if (operation !== ELEPHANT_READ_ONLY_OPERATION) {
    throw new Error(`Elephant bridge only permits the read-only ${ELEPHANT_READ_ONLY_OPERATION} operation`);
  }
  if (ELEPHANT_WRITE_OPERATIONS.has(operation)) {
    throw new Error(`Elephant bridge rejected write operation: ${operation}`);
  }
}

function normalizeElephantMessage(row: Record<string, unknown>, sourceId: string, request: Record<string, string | number>, targetKey: string, index: number): SourceMessage[] {
  const content = elephantContent(row);
  if (!content) return [];
  const target = splitTargetKey(targetKey);
  const actor = firstString(row, ["name", "actor", "author", "sender", "from"]) ?? "unknown";
  const messageId = firstString(row, ["id", "mid", "uuid", "messageId"]) ?? `line-${index + 1}`;
  const conversationId = firstString(row, ["conversationId", "conversation_id", "sessionId", "session_id"]) ?? `${target.key}:${target.value}`;
  const timestamp = toIsoTimestamp(firstValue(row, ["time", "timestamp", "sentAt", "sent_at", "createdAt", "created_at"]));
  const participants = stringList(row.participants);
  const refs = [`daxiang:${target.key}:${target.value}`, `messageId:${messageId}`];
  const rowRefs = stringList(row.refs);
  refs.push(...rowRefs);
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw as Record<string, unknown> : null;
  const senderUid = firstString(row, ["senderUid", "senderId", "fromUid"]) ?? firstString(raw ?? {}, ["fromUid", "from", "senderId"]);
  const senderMis = firstString(row, ["senderMis", "fromMis"]) ?? firstString(raw ?? {}, ["senderMis", "fromMis", "mis"]);
  if (senderUid) refs.push(`senderUid:${senderUid}`);
  if (senderMis) refs.push(`senderMis:${senderMis}`);
  for (const key of ["mid", "uuid"] as const) {
    const value = firstString(raw ?? {}, [key]);
    if (value) refs.push(`${key}:${value}`);
  }
  return [{
    id: `${sourceId}:message:${messageId}:${index + 1}`,
    sourceId,
    conversationId,
    role: firstString(row, ["role", "messageRole"]) ?? "human",
    actor,
    timestamp,
    content,
    refs: [...new Set(refs)],
    participants: participants.length > 0 ? participants : [actor],
  }];
}

function elephantContent(row: Record<string, unknown>): string {
  const direct = firstString(row, ["content", "text", "searchText", "message", "body"]);
  if (direct) return direct;
  const raw = row.raw && typeof row.raw === "object" && !Array.isArray(row.raw) ? row.raw as Record<string, unknown> : null;
  const data = raw?.data;
  if (typeof data !== "string" || !data.trim()) return "";
  try {
    const payload = JSON.parse(data) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const nodes = (payload as Record<string, unknown>).nodes;
      if (Array.isArray(nodes)) {
        return nodes.map((node) => {
          if (!node || typeof node !== "object" || Array.isArray(node)) return "";
          const item = node as Record<string, unknown>;
          const type = firstString(item, ["t", "type"]) ?? "";
          const text = rawNodeText(item);
          if (type === "at" && text) return text;
          if (type === "image") return text ? `[图片] ${text}` : "[图片]";
          if (type === "file") return text ? `[文件] ${text}` : "[文件]";
          if (type === "link") return text ? `[链接] ${text}` : "[链接]";
          return text ?? "";
        }).filter(Boolean).join("").trim();
      }
    }
  } catch {
    return data.trim();
  }
  return data.trim();
}

function rawNodeText(node: Record<string, unknown>): string {
  for (const key of ["c", "text", "content", "name"]) {
    const value = node[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function writeStaging(home: string, relativePath: string, content: string): string {
  const stagingRoot = join(resolve(home), "staging");
  ensurePrivateDirectory(stagingRoot);
  const destination = resolve(stagingRoot, relativePath);
  const relativePathCheck = relative(stagingRoot, destination);
  if (!relativePathCheck || relativePathCheck === ".." || relativePathCheck.startsWith("../")) throw new Error(`Staging path escapes ${stagingRoot}`);
  ensurePrivateDirectory(dirname(destination));
  writeFileSync(destination, content, { mode: 0o600 });
  chmodSync(destination, 0o600);
  return destination;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Private staging path must be a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function normalizeContentId(value: string): string {
  const contentId = String(value ?? "").trim();
  if (!/^\d{1,32}$/.test(contentId)) throw new Error(`Citadel contentId must be numeric: ${contentId}`);
  return contentId;
}

function normalizeScope(scope: string | undefined): "personal" | "work" {
  const value = scope ?? "work";
  if (value !== "personal" && value !== "work") throw new Error(`Source scope must be personal or work: ${value}`);
  return value;
}

function makeSourceId(): string {
  return `src-${randomUUID().slice(0, 12)}`;
}

function parseJsonOutput(stdout: string, command: string): unknown {
  const text = String(stdout).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error(`${command} returned empty output`);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${(error as Error).message}; output=${text.slice(0, 500)}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("External source response must be a JSON object");
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstString(value as Record<string, unknown>, ["name", "displayName", "display_name", "id", "uid", "mis"]);
      if (nested) return nested;
    }
  }
  return null;
}

function firstValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = firstString(item as Record<string, unknown>, ["id", "uid", "mis", "name", "displayName"]);
      return nested ? [nested] : [];
    }
    return [];
  });
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return toIsoTimestamp(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return "";
}

function elephantTargetKey(request: Record<string, string | number>): string {
  const key = ["uid", "gid", "pid", "name", "mis"].find((item) => request[item] !== undefined);
  return key ? `${key}=${request[key]}` : "unknown";
}

function splitTargetKey(value: string): { key: string; value: string } {
  const separator = value.indexOf("=");
  return separator < 0 ? { key: value, value: "" } : { key: value.slice(0, separator), value: value.slice(separator + 1) };
}
