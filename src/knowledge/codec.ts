import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type {
  KnowledgeConfidence,
  KnowledgeRecord,
  KnowledgeTemporalState,
  KnowledgeVerification,
} from "../types.ts";
import { resolveKnowledgeDirectory } from "./catalog.ts";

export function parseKnowledge(text: string, path: string): KnowledgeRecord {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fields = match ? parseFrontmatter(match[1]) : {};
  const body = match ? match[2].trim() + "\n" : text.trim() + "\n";
  const type = String(fields.type ?? "fact");
  return {
    id: String(fields.id ?? `kb-file-${randomUUID().slice(0, 8)}`),
    title: String(fields.title ?? basename(path, extname(path))),
    type,
    collection: resolveKnowledgeDirectory(type, typeof fields.collection === "string" ? fields.collection : undefined),
    sourceKind: String(fields.source_kind ?? "manual"),
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
    qualityVersion: Number(fields.quality_version ?? 0) || 0,
    productType: String(fields.product_type ?? "").trim(),
    compilationRef: String(fields.compilation_ref ?? "").trim(),
    factRefs: asStringArray(fields.fact_refs),
    questionsAnswered: asStringArray(fields.questions_answered),
    admissionReason: String(fields.admission_reason ?? "").trim(),
    applicability: String(fields.applicability ?? "").trim(),
    boundary: String(fields.boundary ?? "").trim(),
    useWhen: String(fields.use_when ?? "").trim(),
    useInputs: normalizeUseItems(fields.use_inputs),
    useOutputs: normalizeUseItems(fields.use_outputs),
    useSteps: normalizeUseItems(fields.use_steps),
    useChecks: normalizeUseItems(fields.use_checks),
    useStopConditions: normalizeUseItems(fields.use_stop_conditions),
    confidence: parseConfidence(fields.confidence),
    confidenceBasis: asStringArray(fields.confidence_basis),
    temporalState: parseTemporalState(fields.temporal_state),
    verification: parseVerification(fields.verification, fields.status),
    identityConfidence: parseConfidenceOptional(fields.identity_confidence),
    patternConfidence: parseConfidenceOptional(fields.pattern_confidence),
    independentEpisodeCount: parseEpisodeCount(fields.independent_episode_count),
    independentSourceCount: parseEpisodeCount(fields.independent_source_count),
    distinctDateCount: parseEpisodeCount(fields.distinct_date_count),
    counterevidenceRefs: asStringArray(fields.counterevidence_refs),
    counterevidenceSearch: String(fields.counterevidence_search ?? "").trim(),
    doNotUseFor: asStringArray(fields.do_not_use_for),
    path,
    body,
  };
}

export function tryParseKnowledge(text: string, path: string): KnowledgeRecord | null {
  try {
    return parseKnowledge(text, path);
  } catch {
    return null;
  }
}

export function renderKnowledge(record: KnowledgeRecord): string {
  const personFields = record.collection === "people" ? [
    `identity_confidence: ${record.identityConfidence ?? ""}`,
    `pattern_confidence: ${record.patternConfidence ?? ""}`,
  ] : [];
  const evidenceFields = [
    ...(record.independentEpisodeCount === undefined ? [] : [`independent_episode_count: ${record.independentEpisodeCount}`]),
    ...(record.independentSourceCount === undefined ? [] : [`independent_source_count: ${record.independentSourceCount}`]),
    ...(record.distinctDateCount === undefined ? [] : [`distinct_date_count: ${record.distinctDateCount}`]),
    ...(record.counterevidenceRefs?.length ? [`counterevidence_refs: ${JSON.stringify(record.counterevidenceRefs)}`] : []),
    ...(record.counterevidenceSearch ? [`counterevidence_search: ${JSON.stringify(record.counterevidenceSearch)}`] : []),
    ...(record.doNotUseFor?.length ? [`do_not_use_for: ${JSON.stringify(record.doNotUseFor)}`] : []),
  ];
  return [
    "---",
    `id: ${record.id}`,
    `type: ${JSON.stringify(record.type)}`,
    `collection: ${record.collection}`,
    `source_kind: ${JSON.stringify(record.sourceKind)}`,
    `scope: ${record.scope}`,
    `sensitivity: ${JSON.stringify(record.sensitivity)}`,
    `status: ${record.status}`,
    `title: ${JSON.stringify(record.title)}`,
    `source_refs: ${JSON.stringify(record.sourceRefs)}`,
    `valid_from: ${record.validFrom}`,
    `review_after: ${record.reviewAfter}`,
    `tags: ${JSON.stringify(record.tags)}`,
    `aliases: ${JSON.stringify(record.aliases.length > 0 ? record.aliases : [record.id])}`,
    `related: ${JSON.stringify(record.related.map((id) => relationLink(id)))}`,
    `derived_from: ${JSON.stringify(record.derivedFrom.map((id) => relationLink(id)))}`,
    `contradicts: ${JSON.stringify(record.contradicts.map((id) => relationLink(id)))}`,
    `quality_version: ${record.qualityVersion}`,
    `product_type: ${JSON.stringify(record.productType ?? "")}`,
    `compilation_ref: ${JSON.stringify(record.compilationRef ?? "")}`,
    `fact_refs: ${JSON.stringify(record.factRefs ?? [])}`,
    `questions_answered: ${JSON.stringify(record.questionsAnswered ?? [])}`,
    `admission_reason: ${JSON.stringify(record.admissionReason)}`,
    `applicability: ${JSON.stringify(record.applicability)}`,
    `boundary: ${JSON.stringify(record.boundary)}`,
    `use_when: ${JSON.stringify(record.useWhen ?? "")}`,
    `use_inputs: ${JSON.stringify(record.useInputs ?? [])}`,
    `use_outputs: ${JSON.stringify(record.useOutputs ?? [])}`,
    `use_steps: ${JSON.stringify(record.useSteps ?? [])}`,
    `use_checks: ${JSON.stringify(record.useChecks ?? [])}`,
    `use_stop_conditions: ${JSON.stringify(record.useStopConditions ?? [])}`,
    `confidence: ${record.confidence ?? "medium"}`,
    `confidence_basis: ${JSON.stringify(record.confidenceBasis ?? [])}`,
    `temporal_state: ${record.temporalState ?? "unknown"}`,
    `verification: ${record.verification ?? (record.status === "verified" ? "source_confirmed" : "unverified")}`,
    ...personFields,
    ...evidenceFields,
    "---",
    record.body,
  ].join("\n");
}

export function setFrontmatterArray(text: string, key: string, values: string[]): string {
  const match = text.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/);
  const serialized = `${key}: ${JSON.stringify([...new Set(values)])}`;
  if (!match) return `---\n${serialized}\n---\n${text}`;
  const lines = match[1].split("\n");
  const index = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line));
  if (index < 0) lines.push(serialized);
  else {
    let end = index + 1;
    while (end < lines.length && /^\s+-\s*/.test(lines[end])) end += 1;
    lines.splice(index, end - index, serialized);
  }
  return `---\n${lines.join("\n")}\n---${match[2]}`;
}

export function setFrontmatterScalar(text: string, key: string, value: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---([\s\S]*)$/);
  if (!match) throw new Error(`Knowledge file is missing YAML frontmatter while setting ${key}`);
  const lines = match[1].split("\n");
  const serialized = `${key}: ${value}`;
  const index = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(line));
  if (index < 0) lines.splice(Math.min(2, lines.length), 0, serialized);
  else lines[index] = serialized;
  return `---\n${lines.join("\n")}\n---${match[2]}`;
}

export function readFrontmatterArray(text: string, key: string): string[] {
  const match = text.match(/^---\n([\s\S]*?)\n---[\s\S]*$/);
  return match ? asStringArray(parseFrontmatter(match[1])[key]) : [];
}

export function relationLink(id: string, title?: string): string {
  const display = title?.replaceAll("]", "").replaceAll("|", "/").trim();
  return display ? `[[${id}|${display}]]` : `[[${id}]]`;
}

export function hasStableKnowledgeId(text: string): boolean {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return false;
  const id = parseFrontmatter(match[1]).id;
  return typeof id === "string" && id.trim().length > 0;
}

export function normalizeUseItems(value: unknown): string[] {
  return [...new Set(asStringArray(value).map((item) => item.trim()).filter(Boolean))];
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
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

function parseConfidence(value: unknown): KnowledgeConfidence {
  return (value === undefined || value === null || value === "" ? "medium" : String(value)) as KnowledgeConfidence;
}

function parseConfidenceOptional(value: unknown): KnowledgeConfidence | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value) as KnowledgeConfidence;
}

function parseEpisodeCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseTemporalState(value: unknown): KnowledgeTemporalState {
  return (value === undefined || value === null || value === "" ? "unknown" : String(value)) as KnowledgeTemporalState;
}

function parseVerification(value: unknown, status: unknown): KnowledgeVerification {
  if (value === undefined || value === null || value === "") return status === "verified" ? "source_confirmed" : "unverified";
  return String(value) as KnowledgeVerification;
}

export function asRelationIds(value: unknown): string[] {
  return asStringArray(value).map((item) => {
    const match = item.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
    return (match?.[1] ?? item).trim();
  }).filter(Boolean);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
