import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { KnowledgeRecord, KnowledgeRelationResult, KnowledgeRelationType, KnowledgeSearchResult } from "../types.ts";
import { resolveVault } from "../layout.ts";
import type { KnowledgeInput } from "./contracts.ts";
import { knowledgeScopes, resolveKnowledgeDirectory } from "./catalog.ts";
import { assertKnowledgeQuality, isSourceDerived } from "./quality.ts";
import {
  addMonths,
  asRelationIds,
  normalizeUseItems,
  parseKnowledge,
  readFrontmatterArray,
  relationLink,
  renderKnowledge,
  setFrontmatterArray,
  today,
} from "./codec.ts";
import { ensurePrivateDirectory } from "./storage.ts";
import { findKnowledge, searchKnowledge } from "./records.ts";
import { rebuildKnowledgeViews } from "./views.ts";

export function captureKnowledge(home: string, input: KnowledgeInput): KnowledgeRecord {
  const scope = knowledgeScopes(input.scope ?? "personal")[0];
  const id = `kb-${randomUUID().slice(0, 12)}`;
  const record: KnowledgeRecord = {
    id,
    title: input.title,
    type: input.type ?? "fact",
    collection: resolveKnowledgeDirectory(input.type ?? "fact", input.collection),
    sourceKind: input.sourceKind ?? "manual",
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
    qualityVersion: input.qualityVersion ?? 1,
    admissionReason: String(input.admissionReason ?? "").trim(),
    applicability: String(input.applicability ?? "").trim(),
    boundary: String(input.boundary ?? "").trim(),
    useWhen: String(input.useWhen ?? "").trim(),
    useInputs: normalizeUseItems(input.useInputs),
    useOutputs: normalizeUseItems(input.useOutputs),
    useSteps: normalizeUseItems(input.useSteps),
    useChecks: normalizeUseItems(input.useChecks),
    useStopConditions: normalizeUseItems(input.useStopConditions),
    confidence: input.confidence ?? (input.status === "verified" ? "high" : "medium"),
    confidenceBasis: [...new Set((input.confidenceBasis ?? []).map((item) => String(item).trim()).filter(Boolean))],
    temporalState: input.temporalState ?? "unknown",
    verification: input.verification ?? (input.status === "verified" ? "source_confirmed" : "unverified"),
    identityConfidence: input.identityConfidence,
    patternConfidence: input.patternConfidence,
    independentEpisodeCount: input.independentEpisodeCount,
    path: "",
    body: input.body.trim() + "\n",
  };
  assertKnowledgeQuality(record, { requireAdmission: isSourceDerived(record) });
  const directory = join(resolveVault(home, scope), resolveKnowledgeDirectory(record.type, record.collection));
  ensurePrivateDirectory(directory);
  record.path = join(directory, knowledgeFilename(directory, record.title, record.id));
  writeFileSync(record.path, renderKnowledge(record), { mode: 0o600 });
  rebuildKnowledgeViews(home, scope);
  return record;
}

/**
 * Human-facing Vault filenames use the note title. The stable kb-* id remains
 * in frontmatter and the ledger; it is only appended when a same-day title
 * collision would otherwise overwrite another note.
 */
function knowledgeFilename(directory: string, title: string, id: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96) || "knowledge";
  const preferred = `${today()}-${slug}.md`;
  return existsSync(join(directory, preferred)) ? `${today()}-${slug}-${id}.md` : preferred;
}

export function ingestKnowledge(home: string, source: string, options: { scope?: string; title?: string; sourceKind?: string; collection?: string; admissionReason?: string; applicability?: string; boundary?: string } = {}): KnowledgeRecord {
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error(`Knowledge source file not found: ${source}`);
  const text = readFileSync(sourcePath, "utf8");
  const parsed = parseKnowledge(text, sourcePath);
  return captureKnowledge(home, {
    title: options.title ?? parsed.title ?? basename(sourcePath, extname(sourcePath)),
    type: parsed.type,
    collection: options.collection ?? parsed.collection,
    sourceKind: options.sourceKind ?? parsed.sourceKind ?? "document",
    scope: options.scope ?? parsed.scope,
    sensitivity: parsed.sensitivity,
    status: parsed.status,
    sourceRefs: [...new Set([...(parsed.sourceRefs ?? []), sourcePath])],
    tags: parsed.tags,
    aliases: parsed.aliases.filter((alias) => alias !== parsed.id),
    related: parsed.related,
    derivedFrom: parsed.derivedFrom,
    contradicts: parsed.contradicts,
    admissionReason: options.admissionReason ?? parsed.admissionReason,
    applicability: options.applicability ?? parsed.applicability,
    boundary: options.boundary ?? parsed.boundary,
    useWhen: parsed.useWhen,
    useInputs: parsed.useInputs,
    useOutputs: parsed.useOutputs,
    useSteps: parsed.useSteps,
    useChecks: parsed.useChecks,
    useStopConditions: parsed.useStopConditions,
    qualityVersion: parsed.qualityVersion,
    confidence: parsed.confidence,
    confidenceBasis: parsed.confidenceBasis,
    temporalState: parsed.temporalState,
    verification: parsed.verification,
    identityConfidence: parsed.identityConfidence,
    patternConfidence: parsed.patternConfidence,
    independentEpisodeCount: parsed.independentEpisodeCount,
    body: parsed.body || text,
  });
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
  const targetResult = reciprocal ? addKnowledgeRelation(target, relationType, source) : { record: target, changed: false };
  if (sourceResult.changed || targetResult.changed) {
    for (const scope of new Set([source.scope, target.scope])) rebuildKnowledgeViews(home, scope);
  }
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
  assertKnowledgeQuality({ ...record, status }, { requireAdmission: status === "verified" && isSourceDerived(record) });
  const text = readFileSync(record.path, "utf8");
  const updated = /^status:\s*.*$/m.test(text)
    ? text.replace(/^status:\s*.*$/m, `status: ${status}`)
    : text.replace(/^---\n/, `---\nstatus: ${status}\n`);
  writeFileSync(record.path, updated, { mode: 0o600 });
  chmodSync(record.path, 0o600);
  const result = parseKnowledge(updated, record.path);
  rebuildKnowledgeViews(home, result.scope);
  return result;
}

export function buildContextPack(home: string, input: { taskId: string; title: string; goal: string; acceptance: string; scope?: string; limit?: number; includeDrafts?: boolean }): { taskId: string; query: string; results: KnowledgeSearchResult[]; markdown: string } {
  const query = `${input.title} ${input.goal} ${input.acceptance}`;
  const status = input.includeDrafts === false ? "verified" : "verified,draft";
  const results = searchKnowledge(home, query, { scope: input.scope, status, limit: input.limit ?? 8 });
  const markdown = [
    `# Context Pack: ${input.taskId}`,
    "",
    `- Query: ${query}`,
    `- Knowledge results: ${results.length}`,
    `- Use policy: ${input.includeDrafts === false ? "verified only" : "verified + draft (drafts are advisory and must be checked before relying on them)"}`,
    "",
    ...results.flatMap((result) => {
      const record = findKnowledge(home, result.id);
      const body = record?.body.trim() || result.snippet;
      const contract = [
        result.useWhen ? `- Use when: ${result.useWhen}` : "- Use when: not defined; treat this card as evidence, not an execution recipe",
        ...(result.useInputs ?? []).length > 0 ? [`- Inputs: ${(result.useInputs ?? []).join("; ")}`] : ["- Inputs: not defined"],
        ...(result.useOutputs ?? []).length > 0 ? [`- Outputs: ${(result.useOutputs ?? []).join("; ")}`] : ["- Outputs: not defined"],
        ...(result.useSteps ?? []).length > 0 ? ["- Steps:", ...(result.useSteps ?? []).map((item, index) => `  ${index + 1}. ${item}`)] : ["- Steps: not defined"],
        ...(result.useChecks ?? []).length > 0 ? ["- Checks:", ...(result.useChecks ?? []).map((item) => `  - ${item}`)] : ["- Checks: not defined"],
        ...(result.useStopConditions ?? []).length > 0 ? ["- Stop conditions:", ...(result.useStopConditions ?? []).map((item) => `  - ${item}`)] : ["- Stop conditions: not defined"],
      ];
      return [`## ${result.title}`, `- ID: ${result.id}`, `- Collection: ${result.collection}`, `- Scope: ${result.scope}`, `- Status: ${result.status}`, `- Verification: ${record?.verification ?? "unknown"}`, `- Source: ${result.path}`, "", "### Use contract", ...contract, "", "### Knowledge", body, ""];
    }),
  ].join("\n");
  return { taskId: input.taskId, query, results, markdown };
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
  if (updated !== original) {
    writeFileSync(record.path, updated, { mode: 0o600 });
    chmodSync(record.path, 0o600);
  }
  return { record: parseKnowledge(updated, record.path), changed: updated !== original };
}

function relationField(type: KnowledgeRelationType): "related" | "derivedFrom" | "contradicts" {
  return type === "derived_from" ? "derivedFrom" : type;
}

function relationFieldName(type: KnowledgeRelationType): string {
  return type === "derived_from" ? "derived_from" : type;
}
