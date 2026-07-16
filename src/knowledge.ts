import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { KnowledgeRecord, KnowledgeRelationResult, KnowledgeRelationType, KnowledgeSearchResult } from "./types.ts";

interface KnowledgeInput {
  title: string;
  type?: string;
  scope?: string;
  sensitivity?: string;
  status?: "draft" | "verified" | "retired";
  sourceRefs?: string[];
  tags?: string[];
  aliases?: string[];
  related?: string[];
  derivedFrom?: string[];
  contradicts?: string[];
  body: string;
}

export function resolveVault(home: string, scope = "personal"): string {
  const config = readConfig(home);
  const envKey = scope === "work" ? "IKB_WORK_VAULT" : "IKB_PERSONAL_VAULT";
  return resolve(String(process.env[envKey] ?? config[scope === "work" ? "work_vault" : "personal_vault"] ?? join(home, "vaults", scope)));
}

export function captureKnowledge(home: string, input: KnowledgeInput): KnowledgeRecord {
  const scope = input.scope ?? "personal";
  const id = `kb-${randomUUID().slice(0, 12)}`;
  const record: KnowledgeRecord = {
    id,
    title: input.title,
    type: input.type ?? "fact",
    scope,
    sensitivity: input.sensitivity ?? (scope === "work" ? "work-internal" : "private"),
    status: input.status ?? "draft",
    sourceRefs: input.sourceRefs ?? [],
    validFrom: today(),
    reviewAfter: addMonths(today(), 3),
    tags: input.tags ?? [],
    aliases: [...new Set([id, ...(input.aliases ?? [])])],
    related: asRelationIds(input.related),
    derivedFrom: asRelationIds(input.derivedFrom),
    contradicts: asRelationIds(input.contradicts),
    path: "",
    body: input.body.trim() + "\n",
  };
  const directory = join(resolveVault(home, scope), "entries");
  mkdirSync(directory, { recursive: true });
  record.path = join(directory, `${today()}-${record.id}.md`);
  writeFileSync(record.path, renderKnowledge(record));
  return record;
}

export function ingestKnowledge(home: string, source: string, options: { scope?: string; title?: string } = {}): KnowledgeRecord {
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Knowledge source file not found: ${source}`);
  const text = readFileSync(sourcePath, "utf8");
  const parsed = parseKnowledge(text, sourcePath);
  return captureKnowledge(home, {
    title: options.title ?? parsed.title ?? basename(sourcePath, extname(sourcePath)),
    type: parsed.type,
    scope: options.scope ?? parsed.scope,
    sensitivity: parsed.sensitivity,
    sourceRefs: [...new Set([...(parsed.sourceRefs ?? []), sourcePath])],
    tags: parsed.tags,
    aliases: parsed.aliases.filter((alias) => alias !== parsed.id),
    related: parsed.related,
    derivedFrom: parsed.derivedFrom,
    contradicts: parsed.contradicts,
    body: parsed.body || text,
  });
}

export function searchKnowledge(home: string, query: string, options: { scope?: string; status?: string; limit?: number } = {}): KnowledgeSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const records = listKnowledge(home, options.scope);
  return records
    .filter((record) => !options.status || record.status === options.status)
    .map((record) => {
      const title = record.title.toLowerCase();
      const body = record.body.toLowerCase();
      const tags = record.tags.join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 5 : 0) + (tags.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || right.record.validFrom.localeCompare(left.record.validFrom))
    .slice(0, options.limit ?? 20)
    .map(({ record, score }) => ({
      id: record.id,
      title: record.title,
      type: record.type,
      scope: record.scope,
      status: record.status,
      path: record.path,
      score,
      snippet: makeSnippet(record.body, terms),
    }));
}

export function listKnowledge(home: string, scope?: string): KnowledgeRecord[] {
  const scopes = scope ? [scope] : ["personal", "work"];
  return scopes.flatMap((currentScope) => {
    const root = resolveVault(home, currentScope);
    if (!existsSync(root)) return [];
    return walk(root).filter((path) => path.endsWith(".md")).map((path) => parseKnowledge(readFileSync(path, "utf8"), path));
  });
}

export function reviewKnowledge(home: string, scope?: string): KnowledgeRecord[] {
  const todayValue = today();
  return listKnowledge(home, scope).filter((record) => record.status === "draft" || record.reviewAfter <= todayValue);
}

export function findKnowledge(home: string, id: string): KnowledgeRecord | null {
  return listKnowledge(home).find((record) => record.id === id) ?? null;
}

export function relateKnowledge(
  home: string,
  sourceId: string,
  targetId: string,
  relationType: KnowledgeRelationType,
  options: { allowCrossScope?: boolean } = {},
): KnowledgeRelationResult {
  if (sourceId === targetId) throw new Error("A knowledge entry cannot relate to itself");
  const source = findKnowledge(home, sourceId);
  const target = findKnowledge(home, targetId);
  if (!source) throw new Error(`Knowledge not found: ${sourceId}`);
  if (!target) throw new Error(`Knowledge not found: ${targetId}`);
  if (!options.allowCrossScope && source.scope !== target.scope) {
    throw new Error(`Cross-scope relation is blocked (${source.scope} -> ${target.scope}); add --allow-cross-scope to confirm`);
  }

  const reciprocal = relationType !== "derived_from";
  const sourceResult = addKnowledgeRelation(source, relationType, target);
  const targetResult = reciprocal
    ? addKnowledgeRelation(target, relationType, source)
    : { record: target, changed: false };
  return {
    relationType,
    changed: sourceResult.changed || targetResult.changed,
    reciprocal,
    source: sourceResult.record,
    target: targetResult.record,
  };
}

export function updateKnowledgeStatus(home: string, id: string, status: "verified" | "retired"): KnowledgeRecord {
  const record = findKnowledge(home, id);
  if (!record) throw new Error(`Knowledge not found: ${id}`);
  if (status === "verified" && record.sourceRefs.length === 0) {
    throw new Error(`Knowledge ${id} cannot be verified without source_refs`);
  }
  const text = readFileSync(record.path, "utf8");
  const updated = /^status:\s*.*$/m.test(text)
    ? text.replace(/^status:\s*.*$/m, `status: ${status}`)
    : text.replace(/^---\n/, `---\nstatus: ${status}\n`);
  writeFileSync(record.path, updated);
  return parseKnowledge(updated, record.path);
}

export function buildContextPack(home: string, input: { taskId: string; title: string; goal: string; acceptance: string; scope?: string; limit?: number }): { taskId: string; query: string; results: KnowledgeSearchResult[]; markdown: string } {
  const query = `${input.title} ${input.goal} ${input.acceptance}`;
  const results = searchKnowledge(home, query, { scope: input.scope, status: "verified", limit: input.limit ?? 8 });
  const markdown = [
    `# Context Pack: ${input.taskId}`,
    "",
    `- Query: ${query}`,
    `- Knowledge results: ${results.length}`,
    "",
    ...results.flatMap((result) => [`## ${result.title}`, `- ID: ${result.id}`, `- Scope: ${result.scope}`, `- Status: ${result.status}`, `- Source: ${result.path}`, "", result.snippet, ""]),
  ].join("\n");
  return { taskId: input.taskId, query, results, markdown };
}

function parseKnowledge(text: string, path: string): KnowledgeRecord {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fields = match ? parseFrontmatter(match[1]) : {};
  const body = match ? match[2].trim() + "\n" : text.trim() + "\n";
  return {
    id: String(fields.id ?? `kb-file-${randomUUID().slice(0, 8)}`),
    title: String(fields.title ?? basename(path, extname(path))),
    type: String(fields.type ?? "fact"),
    scope: String(fields.scope ?? "personal"),
    sensitivity: String(fields.sensitivity ?? "private"),
    status: (fields.status === "verified" || fields.status === "retired" ? fields.status : "draft") as KnowledgeRecord["status"],
    sourceRefs: asStringArray(fields.source_refs),
    validFrom: String(fields.valid_from ?? today()),
    reviewAfter: String(fields.review_after ?? addMonths(today(), 3)),
    tags: asStringArray(fields.tags),
    aliases: asStringArray(fields.aliases),
    related: asRelationIds(fields.related),
    derivedFrom: asRelationIds(fields.derived_from),
    contradicts: asRelationIds(fields.contradicts),
    path,
    body,
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let arrayKey: string | null = null;
  for (const line of text.split("\n")) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && arrayKey) {
      const current = Array.isArray(result[arrayKey]) ? result[arrayKey] as unknown[] : [];
      current.push(unquote(item[1].trim()));
      result[arrayKey] = current;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    arrayKey = raw === "" ? key : null;
    if (raw === "") {
      result[key] = [];
      continue;
    }
    if (raw.startsWith("[") || raw.startsWith("\"")) {
      try { result[key] = JSON.parse(raw); continue; } catch { /* keep scalar */ }
    }
    result[key] = unquote(raw);
  }
  return result;
}

function renderKnowledge(record: KnowledgeRecord): string {
  return [
    "---",
    `id: ${record.id}`,
    `type: ${record.type}`,
    `scope: ${record.scope}`,
    `sensitivity: ${record.sensitivity}`,
    `status: ${record.status}`,
    `title: ${JSON.stringify(record.title)}`,
    `source_refs: ${JSON.stringify(record.sourceRefs)}`,
    `valid_from: ${record.validFrom}`,
    `review_after: ${record.reviewAfter}`,
    `tags: ${JSON.stringify(record.tags)}`,
    `aliases: ${JSON.stringify(record.aliases.length > 0 ? record.aliases : [record.id])}`,
    `related: ${JSON.stringify(record.related.map(relationLink))}`,
    `derived_from: ${JSON.stringify(record.derivedFrom.map(relationLink))}`,
    `contradicts: ${JSON.stringify(record.contradicts.map(relationLink))}`,
    "---",
    record.body,
  ].join("\n");
}

function addKnowledgeRelation(record: KnowledgeRecord, relationType: KnowledgeRelationType, target: KnowledgeRecord): { record: KnowledgeRecord; changed: boolean } {
  const relationKey = relationField(relationType);
  const existing = record[relationKey];
  const aliasValues = record.aliases.includes(record.id) ? record.aliases : [record.id, ...record.aliases];
  const original = readFileSync(record.path, "utf8");
  let updated = setFrontmatterArray(original, "aliases", aliasValues);
  if (!existing.includes(target.id)) {
    const relationKeyName = relationFieldName(relationType);
    const currentLinks = readFrontmatterArray(updated, relationKeyName);
    const preservedLinks = currentLinks.length > 0 ? currentLinks : existing.map(relationLink);
    updated = setFrontmatterArray(updated, relationKeyName, [...preservedLinks, relationLink(target.id, target.title)]);
  }
  if (updated !== original) writeFileSync(record.path, updated);
  return { record: parseKnowledge(updated, record.path), changed: updated !== original };
}

function relationField(type: KnowledgeRelationType): "related" | "derivedFrom" | "contradicts" {
  if (type === "derived_from") return "derivedFrom";
  return type;
}

function relationFieldName(type: KnowledgeRelationType): string {
  if (type === "derived_from") return "derived_from";
  return type;
}

function relationLink(id: string, title?: string): string {
  const display = title?.replaceAll("]", "").replaceAll("|", "/").trim();
  return display ? `[[${id}|${display}]]` : `[[${id}]]`;
}

function asRelationIds(value: unknown): string[] {
  return asStringArray(value).map((item) => {
    const match = item.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
    return (match?.[1] ?? item).trim();
  }).filter(Boolean);
}

function setFrontmatterArray(text: string, key: string, values: string[]): string {
  const match = text.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/);
  const serialized = `${key}: ${JSON.stringify([...new Set(values)])}`;
  if (!match) return `---\n${serialized}\n---\n${text}`;
  const lines = match[1].split("\n");
  const index = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line));
  if (index < 0) {
    lines.push(serialized);
  } else {
    let end = index + 1;
    while (end < lines.length && /^\s+-\s*/.test(lines[end])) end += 1;
    lines.splice(index, end - index, serialized);
  }
  return `---\n${lines.join("\n")}\n---${match[2]}`;
}

function readFrontmatterArray(text: string, key: string): string[] {
  const match = text.match(/^---\n([\s\S]*?)\n---[\s\S]*$/);
  return match ? asStringArray(parseFrontmatter(match[1])[key]) : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function makeSnippet(body: string, terms: string[]): string {
  const normalized = body.replaceAll(/\s+/g, " ").trim();
  if (!terms.length || !normalized) return normalized.slice(0, 240);
  const index = Math.max(0, normalized.toLowerCase().indexOf(terms.find((term) => normalized.toLowerCase().includes(term)) ?? ""));
  return normalized.slice(Math.max(0, index - 80), index + 240);
}

function walk(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

function readConfig(home: string): Record<string, string> {
  const path = join(home, "config.yaml");
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : null;
  }).filter(Boolean) as [string, string][]);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}
