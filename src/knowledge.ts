import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { KnowledgeRecord, KnowledgeSearchResult } from "./types.ts";

interface KnowledgeInput {
  title: string;
  type?: string;
  scope?: string;
  sensitivity?: string;
  status?: "draft" | "verified" | "retired";
  sourceRefs?: string[];
  tags?: string[];
  body: string;
}

export function resolveVault(home: string, scope = "personal"): string {
  const config = readConfig(home);
  const envKey = scope === "work" ? "IKB_WORK_VAULT" : "IKB_PERSONAL_VAULT";
  return resolve(String(process.env[envKey] ?? config[scope === "work" ? "work_vault" : "personal_vault"] ?? join(home, "vaults", scope)));
}

export function captureKnowledge(home: string, input: KnowledgeInput): KnowledgeRecord {
  const scope = input.scope ?? "personal";
  const record: KnowledgeRecord = {
    id: `kb-${randomUUID().slice(0, 12)}`,
    title: input.title,
    type: input.type ?? "fact",
    scope,
    sensitivity: input.sensitivity ?? (scope === "work" ? "work-internal" : "private"),
    status: input.status ?? "draft",
    sourceRefs: input.sourceRefs ?? [],
    validFrom: today(),
    reviewAfter: addMonths(today(), 3),
    tags: input.tags ?? [],
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
    path,
    body,
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw.startsWith("[") || raw.startsWith("\"")) {
      try { result[key] = JSON.parse(raw); continue; } catch { /* keep scalar */ }
    }
    result[key] = raw.replace(/^['"]|['"]$/g, "");
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
    "---",
    record.body,
  ].join("\n");
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
