import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ikbPaths } from "./layout.ts";

export const INBOX_ITEM_SCHEMA = "ikb-inbox-item.v1";

export interface InboxItem {
  schema: typeof INBOX_ITEM_SCHEMA;
  id: string;
  scope: "personal" | "work";
  trigger: "source_uncovered" | "zero_result" | "partial_feedback" | "incorrect_feedback" | "principle_confirmation" | "source_changed";
  subject: string;
  goal: string | null;
  sourceRefs: string[];
  knowledgeIds: string[];
  usageId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

export type InboxItemInput = Omit<InboxItem, "schema" | "id" | "createdAt" | "lastSeenAt" | "occurrenceCount">;

export function inboxRoot(home: string, scope: "personal" | "work"): string {
  return join(ikbPaths(home).inbox, scope);
}

export function upsertInboxItem(
  home: string,
  input: InboxItemInput,
): InboxItem & { path: string } {
  const id = inboxItemId(input);
  const sourceRefs = unique(input.sourceRefs);
  const knowledgeIds = unique(input.knowledgeIds);
  const path = join(inboxRoot(home, input.scope), `${id}.json`);
  const now = new Date().toISOString();
  let existing: InboxItem | null = null;
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as InboxItem;
    if (parsed.schema !== INBOX_ITEM_SCHEMA || parsed.id !== id) throw new Error(`Inbox item is invalid: ${path}`);
    existing = parsed;
  }
  const item: InboxItem = {
    schema: INBOX_ITEM_SCHEMA,
    id,
    scope: input.scope,
    trigger: input.trigger,
    subject: input.subject.trim(),
    goal: input.goal?.trim() || null,
    sourceRefs,
    knowledgeIds,
    usageId: input.usageId,
    details: input.details,
    createdAt: existing?.createdAt ?? now,
    lastSeenAt: now,
    occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return { ...item, path };
}

export function inboxItemId(input: InboxItemInput): string {
  const key = JSON.stringify({
    scope: input.scope,
    trigger: input.trigger,
    subject: input.subject.trim(),
    sourceRefs: unique(input.sourceRefs),
    knowledgeIds: unique(input.knowledgeIds),
    usageId: input.usageId,
  });
  return `inbox-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function archivedInboxItemPath(home: string, scope: "personal" | "work", id: string): string {
  if (!/^inbox-[a-f0-9]{16}$/.test(id)) throw new Error(`Inbox id is invalid: ${id}`);
  return join(ikbPaths(home).archive, "inbox", scope, `${id}.json`);
}

export function listInboxItems(home: string, scope?: "personal" | "work"): Array<InboxItem & { path: string }> {
  const scopes: Array<"personal" | "work"> = scope ? [scope] : ["personal", "work"];
  return scopes.flatMap((currentScope) => {
    const directory = inboxRoot(home, currentScope);
    if (!existsSync(directory)) return [];
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`Inbox root must be a real directory: ${directory}`);
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Inbox item must not be a symlink: ${path}`);
      const item = JSON.parse(readFileSync(path, "utf8")) as InboxItem;
      if (item.schema !== INBOX_ITEM_SCHEMA || item.scope !== currentScope || `${item.id}.json` !== entry.name) {
        throw new Error(`Inbox item is invalid: ${path}`);
      }
      return [{ ...item, path }];
    });
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function findInboxItem(home: string, id: string): (InboxItem & { path: string }) | null {
  if (!/^inbox-[a-f0-9]{16}$/.test(id)) throw new Error(`Inbox id is invalid: ${id}`);
  return listInboxItems(home).find((item) => item.id === id) ?? null;
}

export function archiveInboxItem(home: string, id: string): { id: string; from: string; to: string } {
  const item = findInboxItem(home, id);
  if (!item) throw new Error(`Inbox item not found: ${id}`);
  const directory = join(ikbPaths(home).archive, "inbox", item.scope);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = join(directory, `${item.id}.json`);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") !== readFileSync(item.path, "utf8")) throw new Error(`Archived Inbox item differs: ${target}`);
    unlinkSync(item.path);
  } else {
    renameSync(item.path, target);
  }
  chmodSync(target, 0o600);
  return { id: item.id, from: item.path, to: target };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}
