import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { SourceRecord } from "./types.ts";
import { resolveSourcesRoot } from "./layout.ts";
import { listKnowledge } from "./knowledge/records.ts";
import { knowledgeRetrievalEligibilityAtHome } from "./knowledge/eligibility.ts";
import { heldKnowledgeIds } from "./knowledge/holds.ts";
import { findSource, inspectSourceRegistry, listSources, sourceQuarantineReason } from "./source.ts";

export const SOURCE_ALIAS_REGISTRY_VERSION = "ikb-source-alias-registry.v1";

export interface SourceAliasEntry {
  alias: string;
  sourceId: string;
  createdAt: string;
}

export interface SourceAliasRegistry {
  schema: typeof SOURCE_ALIAS_REGISTRY_VERSION;
  aliases: SourceAliasEntry[];
}

export interface SourceAliasIssue {
  sourceId: string;
  code: "source_alias_registry_invalid" | "source_alias_target_missing" | "source_alias_duplicate";
  path: string;
  detail: string;
}

export interface SourceLookupResult {
  source: SourceRecord;
  score: number;
  matches: Array<"id" | "title" | "original_path" | "content_id" | "alias">;
  aliases: string[];
  quarantined: boolean;
  quarantineReason: string | null;
}

export interface SourceIntakeReceipt {
  schema: "ikb-source-intake-receipt.v1";
  sourceId: string;
  title: string;
  originalPath: string;
  contentHash: string;
  importedAt: string;
  scope: string;
  aliases: string[];
  intakeStatus: "stored";
  knowledgeStatus: "none" | "draft_only" | "default_eligible";
  linkedKnowledgeIds: string[];
  defaultEligibleKnowledgeIds: string[];
  notice: string;
  version: {
    isLatest: boolean;
    latestSourceId: string;
    previousSourceIds: string[];
  };
}

export function sourceAliasRegistryPath(home: string): string {
  return join(resolveSourcesRoot(home), "aliases.json");
}

export function inspectSourceAliasRegistry(home: string): { registry: SourceAliasRegistry; issues: SourceAliasIssue[] } {
  const path = sourceAliasRegistryPath(home);
  if (!existsSync(path)) return { registry: { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases: [] }, issues: [] };
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    return { registry: { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases: [] }, issues: [{ sourceId: "aliases", code: "source_alias_registry_invalid", path, detail: "Source alias registry must be a regular file" }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { registry: { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases: [] }, issues: [{ sourceId: "aliases", code: "source_alias_registry_invalid", path, detail: (error as Error).message }] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as Record<string, unknown>).schema !== SOURCE_ALIAS_REGISTRY_VERSION
    || !Array.isArray((value as Record<string, unknown>).aliases)) {
    return { registry: { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases: [] }, issues: [{ sourceId: "aliases", code: "source_alias_registry_invalid", path, detail: `Source alias registry must use ${SOURCE_ALIAS_REGISTRY_VERSION}` }] };
  }
  const rows = (value as SourceAliasRegistry).aliases;
  const aliases: SourceAliasEntry[] = [];
  const issues: SourceAliasIssue[] = [];
  const sources = new Set(inspectSourceRegistry(home).sources.map((source) => source.id));
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row.alias !== "string" || !normalizeAlias(row.alias) || typeof row.sourceId !== "string" || typeof row.createdAt !== "string") {
      issues.push({ sourceId: String(row?.sourceId ?? "aliases"), code: "source_alias_registry_invalid", path, detail: "Source alias entry is missing alias, sourceId or createdAt" });
      continue;
    }
    const key = normalizeAlias(row.alias);
    const owner = owners.get(key);
    if (owner && owner !== row.sourceId) {
      issues.push({ sourceId: row.sourceId, code: "source_alias_duplicate", path, detail: `Alias ${row.alias} is also owned by ${owner}` });
      continue;
    }
    owners.set(key, row.sourceId);
    if (!sources.has(row.sourceId)) {
      issues.push({ sourceId: row.sourceId, code: "source_alias_target_missing", path, detail: `Alias ${row.alias} points to a missing Source` });
    }
    aliases.push({ alias: row.alias.trim(), sourceId: row.sourceId, createdAt: row.createdAt });
  }
  return { registry: { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases }, issues };
}

export function addSourceAliases(home: string, sourceId: string, values: string[]): { source: SourceRecord; added: string[]; aliases: string[] } {
  const source = findSource(home, sourceId);
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  const aliases = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (aliases.length === 0) throw new Error("At least one non-empty Source alias is required");
  const inspection = inspectSourceAliasRegistry(home);
  if (inspection.issues.length > 0) throw new Error(`Source alias registry has integrity issues: ${inspection.issues.map((item) => item.code).join(", ")}`);
  const entries = [...inspection.registry.aliases];
  const byAlias = new Map(entries.map((entry) => [normalizeAlias(entry.alias), entry] as const));
  const added: string[] = [];
  for (const alias of aliases) {
    const existing = byAlias.get(normalizeAlias(alias));
    if (existing && existing.sourceId !== sourceId) throw new Error(`Source alias already belongs to ${existing.sourceId}: ${alias}`);
    if (existing) continue;
    const entry = { alias, sourceId, createdAt: new Date().toISOString() };
    entries.push(entry);
    byAlias.set(normalizeAlias(alias), entry);
    added.push(alias);
  }
  if (added.length > 0) writeAliasRegistry(home, { schema: SOURCE_ALIAS_REGISTRY_VERSION, aliases: entries });
  return { source, added, aliases: entries.filter((entry) => entry.sourceId === sourceId).map((entry) => entry.alias).sort() };
}

export function listSourceAliases(home: string, sourceId?: string): SourceAliasEntry[] {
  const inspection = inspectSourceAliasRegistry(home);
  if (inspection.issues.length > 0) throw new Error(`Source alias registry has integrity issues: ${inspection.issues.map((item) => item.code).join(", ")}`);
  return inspection.registry.aliases
    .filter((entry) => !sourceId || entry.sourceId === sourceId)
    .sort((left, right) => left.alias.localeCompare(right.alias) || left.sourceId.localeCompare(right.sourceId));
}

export function lookupSources(home: string, query: string, options: { scope?: string; includeQuarantined?: boolean; allVersions?: boolean; limit?: number } = {}): SourceLookupResult[] {
  const normalized = normalizeLookupQuery(query);
  if (!normalized.text) throw new Error("Source lookup query must not be empty");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Source lookup limit must be between 1 and 100");
  const aliases = listSourceAliases(home);
  const aliasesBySource = new Map<string, string[]>();
  for (const entry of aliases) aliasesBySource.set(entry.sourceId, [...(aliasesBySource.get(entry.sourceId) ?? []), entry.alias]);
  const candidates = listSources(home, { includeQuarantined: true })
    .filter((source) => !options.scope || source.scope === options.scope)
    .filter((source) => options.includeQuarantined === true || !sourceQuarantineReason(source))
    .flatMap((source) => {
      const result = scoreSource(source, normalized, aliasesBySource.get(source.id) ?? []);
      return result.score > 0 ? [{
        source,
        score: result.score,
        matches: result.matches,
        aliases: aliasesBySource.get(source.id) ?? [],
        quarantined: Boolean(sourceQuarantineReason(source)),
        quarantineReason: sourceQuarantineReason(source),
      }] : [];
    })
    .sort((left, right) => right.score - left.score || right.source.importedAt.localeCompare(left.source.importedAt) || left.source.id.localeCompare(right.source.id));
  const deduplicated = options.allVersions === true ? candidates : latestOriginVersions(candidates);
  return deduplicated.slice(0, limit);
}

export function buildSourceReceipt(home: string, sourceOrId: SourceRecord | string): SourceIntakeReceipt {
  const source = typeof sourceOrId === "string" ? findSource(home, sourceOrId) : sourceOrId;
  if (!source) throw new Error(`Source not found: ${sourceOrId}`);
  const aliases = listSourceAliases(home, source.id).map((entry) => entry.alias);
  const held = heldKnowledgeIds(home);
  const linked = listKnowledge(home, source.scope).filter((record) => record.sourceRefs.some((ref) => sourceRefMatches(ref, source.id)));
  const eligible = linked.filter((record) => record.status === "verified" && !held.has(record.id) && knowledgeRetrievalEligibilityAtHome(home, record).eligible);
  const versions = listSources(home, { includeQuarantined: true })
    .filter((candidate) => sameOrigin(candidate, source))
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt) || right.id.localeCompare(left.id));
  const latest = versions[0] ?? source;
  const knowledgeStatus = eligible.length > 0 ? "default_eligible" : linked.length > 0 ? "draft_only" : "none";
  return {
    schema: "ikb-source-intake-receipt.v1",
    sourceId: source.id,
    title: source.title,
    originalPath: source.originalPath,
    contentHash: source.contentHash,
    importedAt: source.importedAt,
    scope: source.scope,
    aliases,
    intakeStatus: "stored",
    knowledgeStatus,
    linkedKnowledgeIds: linked.map((record) => record.id).sort(),
    defaultEligibleKnowledgeIds: eligible.map((record) => record.id).sort(),
    notice: knowledgeStatus === "none"
      ? "仅 Source，未准入为知识"
      : knowledgeStatus === "draft_only"
        ? "已有 Knowledge 草稿，但尚未进入默认检索"
        : "已有可进入默认检索的 Knowledge",
    version: {
      isLatest: latest.id === source.id,
      latestSourceId: latest.id,
      previousSourceIds: versions.filter((candidate) => candidate.id !== latest.id).map((candidate) => candidate.id),
    },
  };
}

function scoreSource(source: SourceRecord, query: ReturnType<typeof normalizeLookupQuery>, aliases: string[]) {
  let score = 0;
  const matches: SourceLookupResult["matches"] = [];
  const title = normalizeAlias(source.title);
  const path = normalizeAlias(source.originalPath);
  const filename = normalizeAlias(basename(source.originalPath, extname(source.originalPath)));
  if (normalizeAlias(source.id) === query.text) { score += 120; matches.push("id"); }
  if (aliases.some((alias) => normalizeAlias(alias) === query.text)) { score += 110; matches.push("alias"); }
  if (query.contentId && sourceContentId(source) === query.contentId) { score += 100; matches.push("content_id"); }
  if (title === query.text) { score += 90; matches.push("title"); }
  else if (title.includes(query.text) || query.text.includes(title)) { score += 60; matches.push("title"); }
  if (path === query.text || filename === query.text) { score += 80; matches.push("original_path"); }
  else if (path.includes(query.text)) { score += 35; matches.push("original_path"); }
  return { score, matches: [...new Set(matches)] };
}

function normalizeLookupQuery(query: string): { text: string; contentId: string | null } {
  const trimmed = query.trim();
  const contentId = /(?:collabpage|page)\/(\d+)/i.exec(trimmed)?.[1] ?? (/^\d{6,}$/.test(trimmed) ? trimmed : null);
  return { text: normalizeAlias(trimmed), contentId };
}

function sourceContentId(source: SourceRecord): string | null {
  const filename = basename(source.originalPath, extname(source.originalPath));
  return /^\d{6,}$/.test(filename) ? filename : /(?:collabpage|page)[/_-](\d+)/i.exec(source.originalPath)?.[1] ?? null;
}

function latestOriginVersions(items: SourceLookupResult[]): SourceLookupResult[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = originKey(item.source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameOrigin(left: SourceRecord, right: SourceRecord): boolean { return originKey(left) === originKey(right); }
function originKey(source: SourceRecord): string { return `${source.scope}|${source.adapter ?? source.kind}|${resolve(source.originalPath)}`; }
function normalizeAlias(value: string): string { return value.trim().toLocaleLowerCase("zh-CN").replaceAll(/\s+/g, " "); }
function sourceRefMatches(ref: string, sourceId: string): boolean { return [sourceId, `source:${sourceId}`, `source://${sourceId}`].includes(ref.trim()); }

function writeAliasRegistry(home: string, registry: SourceAliasRegistry): void {
  const path = sourceAliasRegistryPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
