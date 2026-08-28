import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { KnowledgeRecord, KnowledgeRelationResult, KnowledgeRelationType, KnowledgeRetrievalUnit, KnowledgeRetrievalUnitKind, KnowledgeSearchResult } from "../types.ts";
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
import { findKnowledge, listKnowledge, searchKnowledge, tokenizeKnowledgeQuery } from "./records.ts";
import { rebuildKnowledgeViews } from "./views.ts";
import { assertPrincipleActivationReady } from "./principle-admission.ts";

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
    revision: 1,
    revisionHistory: [],
    sourceRefs: input.sourceRefs ?? [],
    validFrom: today(),
    reviewAfter: addMonths(today(), 3),
    tags: input.tags ?? [],
    aliases: [...new Set([id, ...(input.aliases ?? [])])],
    related: asRelationIds(input.related),
    derivedFrom: asRelationIds(input.derivedFrom),
    contradicts: asRelationIds(input.contradicts),
    qualityVersion: input.qualityVersion ?? 1,
    productType: String(input.productType ?? "").trim(),
    canonicalKey: String(input.canonicalKey ?? "").trim(),
    compilationSchema: String(input.compilationSchema ?? "").trim(),
    compilationCaseId: String(input.compilationCaseId ?? "").trim(),
    compilationProductId: String(input.compilationProductId ?? "").trim(),
    extractionManifestRef: String(input.extractionManifestRef ?? "").trim(),
    compilationRef: String(input.compilationRef ?? "").trim(),
    informationLossRef: String(input.informationLossRef ?? "").trim(),
    factRefs: normalizeUseItems(input.factRefs),
    questionsAnswered: normalizeUseItems(input.questionsAnswered),
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
    independentSourceCount: input.independentSourceCount,
    distinctDateCount: input.distinctDateCount,
    counterevidenceRefs: normalizeUseItems(input.counterevidenceRefs),
    counterevidenceSearch: String(input.counterevidenceSearch ?? "").trim(),
    doNotUseFor: normalizeUseItems(input.doNotUseFor),
    path: "",
    body: input.body.trim() + "\n",
  };
  assertKnowledgeQuality(record, { requireAdmission: isSourceDerived(record) });
  if (record.type.trim().toLowerCase() === "principle" && record.status === "verified") {
    throw new Error("principle_confirmation_chain_invalid: verified Principles must be installed from an accepted review Candidate");
  }
  assertActiveCanonicalKeyAvailable(home, record);
  const directory = join(resolveVault(home, scope), resolveKnowledgeDirectory(record.type, record.collection));
  ensurePrivateDirectory(directory);
  record.path = join(directory, knowledgeFilename(directory, record.title, record.id));
  writeFileSync(record.path, renderKnowledge(record), { mode: 0o600 });
  rebuildKnowledgeViews(home, scope);
  return record;
}

/**
 * Install the exact bytes of a complete Knowledge draft that a human already
 * reviewed. Candidate governance owns the decision; the repository owns the
 * Vault path, collision checks and crash-safe materialization.
 */
export function installReviewedKnowledge(
  home: string,
  text: string,
  sourcePath: string,
): { record: KnowledgeRecord; recovered: boolean } {
  const parsed = parseKnowledge(text, resolve(sourcePath));
  if (parsed.status !== "draft") throw new Error("A reviewed new Knowledge record must have status draft");
  if (parsed.revision !== 1 || parsed.revisionHistory.length > 0) {
    throw new Error("A reviewed new Knowledge record must start at revision 1 without revision history");
  }
  assertKnowledgeQuality(parsed, { requireAdmission: isSourceDerived(parsed) });
  assertActiveCanonicalKeyAvailable(home, parsed);

  const directory = join(resolveVault(home, parsed.scope), resolveKnowledgeDirectory(parsed.type, parsed.collection));
  ensurePrivateDirectory(directory);
  const existing = findKnowledge(home, parsed.id);
  if (existing) {
    if (resolve(dirname(existing.path)) !== resolve(directory)) {
      throw new Error(`Existing Knowledge ${parsed.id} is outside its expected collection`);
    }
    const stat = lstatSync(existing.path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Existing Knowledge ${parsed.id} must be a regular file`);
    if (readFileSync(existing.path, "utf8") !== text) {
      throw new Error(`Existing Knowledge ${parsed.id} has different bytes; refusing to overwrite it`);
    }
    rebuildKnowledgeViews(home, parsed.scope);
    return { record: parseKnowledge(text, existing.path), recovered: true };
  }

  const path = join(directory, knowledgeFilename(directory, parsed.title, parsed.id, parsed.validFrom));
  if (existsSync(path)) throw new Error(`Reviewed Knowledge destination already exists: ${path}`);
  writeExclusivePrivate(path, text);
  const record = parseKnowledge(text, path);
  if (record.id !== parsed.id || record.scope !== parsed.scope) {
    throw new Error("Reviewed Knowledge changed while it was installed");
  }
  rebuildKnowledgeViews(home, record.scope);
  return { record, recovered: false };
}

/**
 * Human-facing Vault filenames use the note title. The stable kb-* id remains
 * in frontmatter and the ledger; it is only appended when a same-day title
 * collision would otherwise overwrite another note.
 */
function knowledgeFilename(directory: string, title: string, id: string, date = today()): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96) || "knowledge";
  const preferred = `${date}-${slug}.md`;
  return existsSync(join(directory, preferred)) ? `${date}-${slug}-${id}.md` : preferred;
}

function writeExclusivePrivate(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    // link is an atomic no-replace publication within the same directory.
    // A concurrent writer therefore causes EEXIST instead of being overwritten.
    linkSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
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
    productType: parsed.productType,
    canonicalKey: parsed.canonicalKey,
    compilationSchema: parsed.compilationSchema,
    compilationCaseId: parsed.compilationCaseId,
    compilationProductId: parsed.compilationProductId,
    extractionManifestRef: parsed.extractionManifestRef,
    compilationRef: parsed.compilationRef,
    informationLossRef: parsed.informationLossRef,
    factRefs: parsed.factRefs,
    questionsAnswered: parsed.questionsAnswered,
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
    independentSourceCount: parsed.independentSourceCount,
    distinctDateCount: parsed.distinctDateCount,
    counterevidenceRefs: parsed.counterevidenceRefs,
    counterevidenceSearch: parsed.counterevidenceSearch,
    doNotUseFor: parsed.doNotUseFor,
    body: parsed.body || text,
  });
}

export function assertActiveCanonicalKeyAvailable(home: string, record: KnowledgeRecord): void {
  if (record.qualityVersion < 5 || record.status === "retired" || !record.canonicalKey) return;
  const collision = listKnowledge(home, record.scope).find((existing) => existing.status !== "retired"
    && existing.id !== record.id
    && existing.canonicalKey === record.canonicalKey);
  if (collision) {
    throw new Error(`Knowledge active canonical_key already belongs to ${collision.id}: ${record.canonicalKey}`);
  }
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

export function updateKnowledgeStatus(home: string, id: string, status: "draft" | "verified" | "retired"): KnowledgeRecord {
  const record = findKnowledge(home, id);
  if (!record) throw new Error(`Knowledge not found: ${id}`);
  assertKnowledgeQuality({ ...record, status }, { requireAdmission: status === "verified" && isSourceDerived(record) });
  if (status === "verified") assertPrincipleActivationReady(home, record);
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

interface ContextPackInput {
  taskId: string;
  taskType?: string;
  title: string;
  goal: string;
  acceptance: string;
  scope?: string;
  limit?: number;
  includeDrafts?: boolean;
  bodyBudgetChars?: number;
  totalBudgetChars?: number;
  suppressedKnowledgeIds?: string[];
}

interface RankedKnowledgeUnit extends KnowledgeRetrievalUnit {
  candidate: KnowledgeSearchResult;
  questionScores: Map<string, number>;
}

const DEFAULT_CONTEXT_PACK_TOTAL_BUDGET = 12_000;
const MAX_CONTEXT_UNIT_TEXT = 2_400;
const MIN_CONTEXT_UNIT_TEXT = 160;
const CONTEXT_ANCHOR_SCORE = 4;
const WEAK_UNIT_ONLY_TERMS = new Set([
  "召回", "验证", "闭环", "改造", "方案", "任务", "问题", "知识", "结果", "系统", "流程",
]);
const GENERIC_PARENT_ROUTE_CJK_TERMS = [
  "代码架构图", "架构图", "使用定位", "向上汇报",
  "代码", "架构", "模型", "验证", "评审", "任务", "文档", "方案", "系统", "流程", "工具", "知识", "测试", "生成", "实现", "修改", "修复", "问题", "结果", "当前", "说明", "核对", "链路", "依赖", "组件", "项目", "技术", "沟通", "同步", "能力", "接入", "检查", "相关", "召回",
].sort((left, right) => right.length - left.length);
const GENERIC_PARENT_ROUTE_ASCII_TERMS = new Set([
  "agent", "skill", "api", "code", "task", "run", "work", "source", "draft", "current", "result",
]);
const STRUCTURAL_SECTION_HEADINGS = new Set([
  "使用定位", "state", "nodes", "context", "choice", "options", "impact", "product view", "产品视角", "实体", "状态", "规则",
]);

function contextCandidateQuery(value: string): string {
  return value
    .replace(/([A-Za-z0-9])([\u3400-\u9fff])/g, "$1 $2")
    .replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, "$1 $2");
}

export function buildContextPack(home: string, input: ContextPackInput) {
  const query = `${input.title} ${input.goal} ${input.acceptance}`;
  const questions = buildContextQuestions(input);
  const titleFacets = contextTitleFacets(input.title);
  const titleHasDocumentIntent = hasDocumentTitleIntent(input.title);
  const titleAnchorFacets = titleHasDocumentIntent ? documentSpecificTitleFacets(titleFacets) : titleFacets;
  const routeFacets = [...titleFacets, ...splitContextClauses(input.goal)];
  const status = input.includeDrafts === false ? "verified" : "verified,draft";
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Context Pack limit must be a positive integer");
  const bodyBudgetChars = input.bodyBudgetChars ?? 24_000;
  if (!Number.isInteger(bodyBudgetChars) || bodyBudgetChars < 2_000) throw new Error("Context Pack bodyBudgetChars must be an integer >= 2000");
  const totalBudgetChars = input.totalBudgetChars ?? DEFAULT_CONTEXT_PACK_TOTAL_BUDGET;
  if (!Number.isInteger(totalBudgetChars) || totalBudgetChars < 2_000) throw new Error("Context Pack totalBudgetChars must be an integer >= 2000");
  const budgetedLimit = Math.min(limit, Math.max(1, Math.floor(bodyBudgetChars / 800)));
  const candidateLimit = Math.max(20, limit * 4);
  const candidateQuery = contextCandidateQuery(`${input.title} ${input.goal}`);
  const allCandidates = searchKnowledge(home, candidateQuery, { scope: input.scope, status, limit: candidateLimit, peopleMode: "include" });
  const unroutedCandidates = searchKnowledge(home, candidateQuery, { scope: input.scope, status, limit: candidateLimit, requireRoutingMatch: true, peopleMode: "include" });
  const rawBroadCandidates = searchKnowledge(home, candidateQuery, { scope: input.scope, status, limit: candidateLimit, taskType: input.taskType, requireRoutingMatch: true });
  const queryAnchors = specificQueryAnchors(`${input.title} ${input.goal}`);
  const eligibleRaw = rawBroadCandidates.filter((candidate) => candidate.productType === "person_observation"
    || matchesSpecificCandidate(candidate, queryAnchors));
  const rawBroadIds = new Set(rawBroadCandidates.map((candidate) => candidate.id));
  const legacyTitleReentry = allCandidates.filter((candidate) => !rawBroadIds.has(candidate.id)
    && candidate.productType !== "person_observation"
    && matchesLegacyTitleReentry(candidate, queryAnchors));
  const routedCandidates = stableCandidateUnion(eligibleRaw, legacyTitleReentry);
  const suppressedKnowledgeIds = new Set(input.suppressedKnowledgeIds ?? []);
  const excludedByPriorFeedbackIds = routedCandidates.filter((candidate) => suppressedKnowledgeIds.has(candidate.id)).map((candidate) => candidate.id);
  const broadCandidates = routedCandidates.filter((candidate) => !suppressedKnowledgeIds.has(candidate.id));
  const broadCandidateIds = new Set(routedCandidates.map((candidate) => candidate.id));
  const excludedByRoutingIds = unroutedCandidates.filter((candidate) => !broadCandidateIds.has(candidate.id)).map((candidate) => candidate.id);
  const intentEligibleCandidates = broadCandidates.filter((candidate) => !titleHasDocumentIntent || hasDocumentIntent(candidate));
  const anchorScores = new Map(intentEligibleCandidates.map((candidate) => [candidate.id, scoreKnowledgeAnchor(candidate, titleAnchorFacets)]));
  const anchoredCandidates = intentEligibleCandidates.filter((candidate) => (anchorScores.get(candidate.id) ?? 0) >= CONTEXT_ANCHOR_SCORE);
  const anchorApplied = anchoredCandidates.length > 0;
  const fallbackCandidates = anchorApplied ? [] : intentEligibleCandidates;
  const typedLegacyCandidates = intentEligibleCandidates.filter((candidate) => legacyTitleReentry.some((legacy) => legacy.id === candidate.id)
    && Boolean(candidate.productType)
    && matchesExplicitTitleFacet(candidate, titleFacets));
  const candidates = anchorApplied
    ? stableCandidateUnion(anchoredCandidates, typedLegacyCandidates)
    : fallbackCandidates;
  const rankedUnits = candidates.flatMap((candidate) => {
    const record = findKnowledge(home, candidate.id);
    if (!record) return [];
    return materializeKnowledgeUnits(record, candidate)
      .map((unit) => rankKnowledgeUnit(unit, candidate, questions))
      .filter((unit): unit is RankedKnowledgeUnit => unit !== null);
  }).sort(compareRankedUnits);
  const maxUnits = Math.min(12, Math.max(3, Math.min(limit, 8) * 2));
  const selectedUnits = selectKnowledgeUnits(rankedUnits, questions, budgetedLimit, maxUnits);
  const selectedResultIds = [...new Set(selectedUnits.map((unit) => unit.knowledgeId))];
  const selectedResults = selectedResultIds.flatMap((id) => candidates.find((candidate) => candidate.id === id) ?? []);
  const rendered = renderContextUnits({
    home,
    input,
    query,
    questions,
    results: selectedResults,
    units: selectedUnits,
    allCandidateCount: allCandidates.length,
    excludedByRoutingCount: excludedByRoutingIds.length,
    anchorApplied,
    anchorMatches: anchoredCandidates.length,
    fallbackMatches: fallbackCandidates.length,
    bodyBudgetChars,
    totalBudgetChars,
  });
  const renderedIds = new Set(rendered.results.map((result) => result.id));
  const cutoffScore = anchorApplied ? CONTEXT_ANCHOR_SCORE : 2;
  return {
    taskId: input.taskId,
    query,
    questions,
    results: rendered.results,
    units: rendered.units,
    retrieval: {
      candidates: allCandidates.length,
      selected: rendered.results.length,
      selectedUnitCount: rendered.units.length,
      cutoffScore,
      anchorApplied,
      anchorMatches: anchoredCandidates.length,
      fallbackMatches: fallbackCandidates.length,
      excludedByRoutingIds,
      priorFeedbackExcludedIds: excludedByPriorFeedbackIds,
      excludedLowScoreIds: allCandidates.filter((candidate) => !excludedByRoutingIds.includes(candidate.id)
        && !excludedByPriorFeedbackIds.includes(candidate.id)
        && !renderedIds.has(candidate.id)).map((candidate) => candidate.id),
      bodyBudgetChars,
      totalBudgetChars,
      truncatedIds: rendered.truncatedIds,
      truncatedUnitIds: rendered.truncatedUnitIds,
    },
    markdown: rendered.markdown,
  };
}

function buildContextQuestions(input: Pick<ContextPackInput, "title" | "goal">): string[] {
  const values = [
    ...contextTitleFacets(input.title),
    ...splitContextClauses(input.goal),
  ];
  const questions = values.map((value) => value.trim()).filter((value) => value.length >= 2);
  for (const value of [...questions]) {
    const requested = explicitKnowledgeUnitKinds(value);
    for (const kind of requested) questions.push(`${value} ${kind === "fact" ? "Fact" : "Claim"}`);
  }
  return [...new Set(questions)];
}

function explicitKnowledgeUnitKinds(question: string): Array<"fact" | "claim"> {
  const normalized = question.toLowerCase();
  const result: Array<"fact" | "claim"> = [];
  if (/\bfact\b/.test(normalized)) result.push("fact");
  if (/\bclaim\b/.test(normalized)) result.push("claim");
  return result;
}

function contextTitleFacets(title: string): string[] {
  const trimmed = title.trim();
  if (!trimmed) return [];
  const facets = trimmed.split(/\s*(?:与|及|、)\s*/).map((item) => item.trim()).filter((item) => item.length >= 2);
  return facets.length > 1 ? facets : [trimmed];
}

function hasDocumentTitleIntent(title: string): boolean {
  return /文档|写作/.test(title);
}

function documentSpecificTitleFacets(titleFacets: string[]): string[] {
  return titleFacets
    .map((facet) => facet.replace(/文档|写作/g, " ").replace(/\s+/g, " ").trim())
    .filter((facet) => facet.length >= 2);
}

function splitContextClauses(value: string): string[] {
  return value.split(/[；;。.!！?？\n]+/).map((item) => item.trim()).filter((item) => item.length >= 2);
}

function scoreKnowledgeAnchor(candidate: KnowledgeSearchResult, titleFacets: string[]): number {
  const routingText = [candidate.title, candidate.useWhen ?? "", ...(candidate.questionsAnswered ?? []), candidate.productType ?? ""].join(" ").toLowerCase();
  return Math.max(0, ...titleFacets.map((facet) => scoreContextText(routingText, contextWeightedTerms(facet))));
}

function specificQueryAnchors(value: string): string[] {
  const normalized = value.toLowerCase();
  const ascii = (normalized.match(/[a-z][a-z0-9_-]{1,}/g) ?? []).filter((term) => !GENERIC_PARENT_ROUTE_ASCII_TERMS.has(term));
  let cjkOnly = normalized;
  for (const generic of GENERIC_PARENT_ROUTE_CJK_TERMS) cjkOnly = cjkOnly.split(generic).join(" ");
  const cjk = (cjkOnly.match(/[\u3400-\u9fff]{2,}/g) ?? []).flatMap((run) => {
    const values = [run];
    for (let length = 2; length <= Math.min(6, run.length); length += 1) {
      for (let index = 0; index + length <= run.length; index += 1) values.push(run.slice(index, index + length));
    }
    return values;
  });
  return [...new Set([...ascii, ...cjk].filter((anchor) => anchor.length >= 2))];
}

function candidateRoutingText(candidate: KnowledgeSearchResult): string {
  return `${candidate.title}\n${candidate.useWhen ?? ""}\n${(candidate.questionsAnswered ?? []).join("\n")}`.toLowerCase();
}

function matchesExplicitTitleFacet(candidate: KnowledgeSearchResult, titleFacets: string[]): boolean {
  const normalizedTitle = candidate.title.trim().toLowerCase();
  return titleFacets.some((facet) => {
    const normalizedFacet = facet.trim().toLowerCase();
    return normalizedFacet.length >= 2 && normalizedTitle.includes(normalizedFacet);
  });
}

function matchesSpecificCandidate(candidate: KnowledgeSearchResult, anchors: string[]): boolean {
  if (anchors.length === 0) return false;
  const routing = candidateRoutingText(candidate);
  if (anchors.some((anchor) => routing.includes(anchor))) return true;
  return Boolean(candidate.productType) && anchors.some((anchor) => candidate.snippet.toLowerCase().includes(anchor));
}

function matchesLegacyTitleReentry(candidate: KnowledgeSearchResult, anchors: string[]): boolean {
  if (anchors.length === 0) return false;
  if (anchors.some((anchor) => candidate.title.toLowerCase().includes(anchor))) return true;
  return Boolean(candidate.productType) && anchors.some((anchor) => candidate.snippet.toLowerCase().includes(anchor));
}

function hasDocumentIntent(candidate: KnowledgeSearchResult): boolean {
  const routing = candidateRoutingText(candidate);
  return /文档|写作|说明/.test(routing) && /事实|边界|阶段效果/.test(routing);
}

function stableCandidateUnion(...groups: KnowledgeSearchResult[][]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  return groups.flat().filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function materializeKnowledgeUnits(record: KnowledgeRecord, candidate: KnowledgeSearchResult): KnowledgeRetrievalUnit[] {
  const units: KnowledgeRetrievalUnit[] = [];
  units.push(...factKnowledgeUnits(record));
  const sections = splitMarkdownSections(record.body);
  sections.forEach((section, index) => {
    if (sameSectionHeading(section.heading, record.title, candidate.productType) || sameSectionHeading(section.heading, candidate.title, candidate.productType)) return;
    if (section.heading === "直接可用事实" || section.text.replace(/^#{1,4}\s+.+$/m, "").trim().length === 0) return;
    const factRefs = claimFactRefs(section.text);
    const kind = knowledgeSectionKind(section.heading, section.text);
    units.push({
      unitId: `${record.id}:${kind}:${index}`,
      knowledgeId: record.id,
      kind,
      label: section.heading,
      text: section.text,
      score: 0,
      matchedQuestion: "",
      ...(factRefs.length > 0 ? { factRefs } : {}),
    });
  });
  addContractUnits(units, record.id, "step", "执行步骤", candidate.useSteps);
  addContractUnits(units, record.id, "check", "检查项", candidate.useChecks);
  addContractUnits(units, record.id, "stop_condition", "停止条件", candidate.useStopConditions);
  addContractUnits(units, record.id, "boundary", "禁止用途", candidate.doNotUseFor);
  if (units.length === 0) {
    const excerpt = contextBodyExcerpt(record.body.trim() || candidate.snippet, candidate.title, MAX_CONTEXT_UNIT_TEXT);
    units.push({
      unitId: `${record.id}:card:0`,
      knowledgeId: record.id,
      kind: "card",
      label: candidate.title,
      text: excerpt.text,
      score: 0,
      matchedQuestion: "",
      ...(candidate.factRefs?.length ? { factRefs: candidate.factRefs } : {}),
      ...(excerpt.truncated ? { truncated: true } : {}),
    });
  }
  return deduplicateKnowledgeUnits(units);
}

function factKnowledgeUnits(record: KnowledgeRecord): KnowledgeRetrievalUnit[] {
  const units: KnowledgeRetrievalUnit[] = [];
  let inFacts = false;
  for (const line of record.body.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      inFacts = heading[1].trim() === "直接可用事实";
      continue;
    }
    if (!inFacts || !line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Fact" || /^-+$/.test(cells[0])) continue;
    const [factId, temporalState, importance, fact, evidence] = cells;
    if (!factId || !fact) continue;
    units.push({
      unitId: `${record.id}:fact:${safeUnitSegment(factId)}`,
      knowledgeId: record.id,
      kind: "fact",
      label: factId,
      text: `${fact}\n\n- 时间状态：${temporalState}\n- 重要性：${importance}\n- Evidence：${evidence}`,
      score: 0,
      matchedQuestion: "",
      factRefs: [factId],
    });
  }
  return units;
}

function addContractUnits(units: KnowledgeRetrievalUnit[], knowledgeId: string, kind: KnowledgeRetrievalUnitKind, label: string, values?: string[]): void {
  for (const [index, value] of (values ?? []).entries()) {
    units.push({
      unitId: `${knowledgeId}:${kind}:${index}`,
      knowledgeId,
      kind,
      label: `${label} ${index + 1}`,
      text: value,
      score: 0,
      matchedQuestion: "",
    });
  }
}

function knowledgeSectionKind(heading: string, text: string): KnowledgeRetrievalUnitKind {
  if (/主张[：:]/.test(text)) return "claim";
  if (/边界|未知|缺口|例外/.test(heading)) return "boundary";
  if (/验证|检查/.test(heading)) return "check";
  if (/步骤|流程|实施|迁移/.test(heading)) return "step";
  return "section";
}

function claimFactRefs(text: string): string[] {
  const line = text.split("\n").find((item) => /事实引用[：:]/.test(item));
  if (!line) return [];
  const quoted = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
  if (quoted.length > 0) return quoted;
  return line.replace(/^.*?事实引用[：:]\s*/, "").split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
}

function safeUnitSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unit";
}

function deduplicateKnowledgeUnits(units: KnowledgeRetrievalUnit[]): KnowledgeRetrievalUnit[] {
  const seen = new Set<string>();
  return units.filter((unit) => {
    const signature = unit.text.replaceAll(/\s+/g, " ").trim().toLowerCase();
    if (!signature || seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function rankKnowledgeUnit(unit: KnowledgeRetrievalUnit, candidate: KnowledgeSearchResult, questions: string[]): RankedKnowledgeUnit | null {
  if (isStructuralSectionHeading(unit.label) && !questions.some((question) => explicitlyRequestsSection(question, unit.label))) return null;
  const questionScores = new Map<string, number>();
  const searchableText = unit.kind === "fact"
    ? unit.text.split("\n").filter((line) => !/^-\s*(?:时间状态|重要性|Evidence)[：:]/i.test(line.trim())).join("\n")
    : `${unit.label}\n${unit.text}`;
  const unitText = searchableText.toLowerCase();
  const answerText = unit.kind === "fact"
    ? unitText
    : unit.text.replace(/^#{1,4}\s+.+$/gm, "").toLowerCase();
  const routingText = [candidate.title, candidate.useWhen ?? "", ...(candidate.questionsAnswered ?? [])].join(" ").toLowerCase();
  for (const question of questions) {
    const terms = contextWeightedTerms(question);
    const directScore = scoreContextText(unitText, terms);
    const routingScore = scoreContextText(routingText, terms);
    const answerDirectScore = scoreContextText(answerText, terms);
    const requestedKinds = explicitKnowledgeUnitKinds(question);
    const explicitKindRequested = requestedKinds.includes(unit.kind as "fact" | "claim");
    if (!answerableKnowledgeUnit(answerText, question, terms, answerDirectScore)
      && !(explicitKindRequested && answerDirectScore >= 2)) continue;
    const explicitKindBoost = /\bfact\b/i.test(question) && unit.kind === "fact"
      ? 4
      : /\bclaim\b/i.test(question) && unit.kind === "claim"
        ? 4
        : 0;
    const score = directScore * 3 + Math.min(12, routingScore) + knowledgeUnitKindBoost(unit.kind) + explicitKindBoost;
    questionScores.set(question, score);
  }
  const best = [...questionScores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  if (!best) return null;
  return { ...unit, score: best[1], matchedQuestion: best[0], candidate, questionScores };
}

function knowledgeUnitKindBoost(kind: KnowledgeRetrievalUnitKind): number {
  if (kind === "fact") return 5;
  if (kind === "claim") return 4;
  if (kind === "step" || kind === "check" || kind === "stop_condition" || kind === "boundary") return 3;
  if (kind === "section") return 2;
  return 1;
}

function compareRankedUnits(left: RankedKnowledgeUnit, right: RankedKnowledgeUnit): number {
  return right.score - left.score || right.candidate.score - left.candidate.score || left.unitId.localeCompare(right.unitId);
}

function selectKnowledgeUnits(ranked: RankedKnowledgeUnit[], questions: string[], maxCards: number, maxUnits: number): RankedKnowledgeUnit[] {
  const selected: RankedKnowledgeUnit[] = [];
  const selectedIds = new Set<string>();
  const selectedCards = new Set<string>();
  const add = (unit: RankedKnowledgeUnit): void => {
    if (selectedIds.has(unit.unitId) || selected.length >= maxUnits) return;
    if (!selectedCards.has(unit.knowledgeId) && selectedCards.size >= maxCards) return;
    selected.push(unit);
    selectedIds.add(unit.unitId);
    selectedCards.add(unit.knowledgeId);
  };
  for (const question of questions) {
    const matches = ranked
      .filter((unit) => unit.questionScores.has(question))
      .map((unit) => ({ ...unit, score: unit.questionScores.get(question)!, matchedQuestion: question }))
      .sort(compareRankedUnits);
    const topScore = matches[0]?.score ?? 0;
    const eligible = matches.filter((unit) => unit.score >= Math.max(6, Math.ceil(topScore * 0.6)) && !selectedIds.has(unit.unitId));
    const primary = eligible.find((unit) => !selectedCards.has(unit.knowledgeId)) ?? eligible[0];
    if (!primary) continue;
    add(primary);
  }
  return selected;
}

function sameSectionHeading(left: string, right: string, productType?: string): boolean {
  const normalizedLeft = normalizedSectionHeading(left);
  const normalizedRight = normalizedSectionHeading(right);
  return normalizedLeft === normalizedRight
    || Boolean(productType) && normalizedLeft === normalizedSectionHeading(`${right} ${productType}`);
}

function isStructuralSectionHeading(label: string): boolean {
  const normalized = normalizedSectionHeading(label);
  return [...STRUCTURAL_SECTION_HEADINGS].some((heading) => normalized === heading || normalized.startsWith(`${heading} `));
}

function explicitlyRequestsSection(question: string, label: string): boolean {
  const normalizedQuestion = normalizedSectionHeading(question);
  const normalizedLabel = normalizedSectionHeading(label);
  return [...STRUCTURAL_SECTION_HEADINGS].some((heading) => (normalizedLabel === heading || normalizedLabel.startsWith(`${heading} `))
    && normalizedQuestion.includes(heading));
}

function normalizedSectionHeading(value: string): string {
  return value.toLowerCase().replace(/[（）()【】\[\]：:]/g, " ").replace(/\s+/g, " ").trim();
}

function renderContextUnits(options: {
  home: string;
  input: ContextPackInput;
  query: string;
  questions: string[];
  results: KnowledgeSearchResult[];
  units: RankedKnowledgeUnit[];
  allCandidateCount: number;
  excludedByRoutingCount: number;
  anchorApplied: boolean;
  anchorMatches: number;
  fallbackMatches: number;
  bodyBudgetChars: number;
  totalBudgetChars: number;
}): { results: KnowledgeSearchResult[]; units: KnowledgeRetrievalUnit[]; truncatedIds: string[]; truncatedUnitIds: string[]; markdown: string } {
  const estimatedHeader = contextPackHeader(options, options.results.length, options.units.length);
  let remainingPackBudget = Math.max(0, options.totalBudgetChars - estimatedHeader.length - 2);
  let remainingBodyBudget = options.bodyBudgetChars;
  let remainingUnitCount = options.units.length;
  const truncatedIds = new Set<string>();
  const truncatedUnitIds = new Set<string>();
  const renderedUnits: KnowledgeRetrievalUnit[] = [];
  const renderedResults: KnowledgeSearchResult[] = [];
  const cardBlocks: string[] = [];
  for (const result of options.results) {
    const record = findKnowledge(options.home, result.id);
    const cardUnits = options.units.filter((unit) => unit.knowledgeId === result.id);
    const selectedFactRefs = [...new Set(cardUnits.flatMap((unit) => unit.factRefs ?? []))];
    const displayedFactRefs = selectedFactRefs.length > 0 ? selectedFactRefs : (result.factRefs ?? []);
    const cardHeader = [
      `## ${result.title}`,
      `- ID: ${result.id}`,
      `- Collection: ${result.collection}`,
      `- Scope: ${result.scope}`,
      `- Status: ${result.status}`,
      `- Verification: ${record?.verification ?? "unknown"}`,
      `- Product type: ${result.productType ?? `legacy ${result.type}`}`,
      ...(displayedFactRefs.length > 0 ? [`- Fact refs: ${displayedFactRefs.join("; ")}`] : []),
      `- Source: ${result.path}`,
      "- Body: query-focused excerpt by knowledge unit; open Source for the complete card",
      "",
    ].join("\n");
    if (cardHeader.length + MIN_CONTEXT_UNIT_TEXT + 2 > remainingPackBudget) {
      for (const unit of cardUnits) {
        truncatedUnitIds.add(unit.unitId);
        remainingUnitCount -= 1;
      }
      truncatedIds.add(result.id);
      continue;
    }
    remainingPackBudget -= cardHeader.length + 2;
    const unitBlocks: string[] = [];
    for (const unit of cardUnits) {
      const metadata = [
        `### [${unit.kind}] ${unit.label}`,
        `- Unit ID: ${unit.unitId}`,
        `- Matched task question: ${unit.matchedQuestion}`,
        ...(unit.factRefs?.length ? [`- Fact refs: ${unit.factRefs.join("; ")}`] : []),
        "",
      ].join("\n");
      const reservedForLaterUnits = Math.max(0, remainingUnitCount - 1) * MIN_CONTEXT_UNIT_TEXT;
      const textBudget = Math.max(0, Math.min(MAX_CONTEXT_UNIT_TEXT, remainingBodyBudget - reservedForLaterUnits, remainingPackBudget - metadata.length - 2));
      remainingUnitCount -= 1;
      if (textBudget < MIN_CONTEXT_UNIT_TEXT) {
        truncatedIds.add(result.id);
        truncatedUnitIds.add(unit.unitId);
        continue;
      }
      const shortened = truncateContextUnitText(unit.text, textBudget);
      const { candidate: _candidate, ...publicUnit } = unit;
      const renderedUnit: KnowledgeRetrievalUnit = { ...publicUnit, text: shortened.text, truncated: unit.truncated === true || shortened.truncated };
      const block = `${metadata}${shortened.text}`;
      if (block.length + 2 > remainingPackBudget) {
        truncatedIds.add(result.id);
        truncatedUnitIds.add(unit.unitId);
        continue;
      }
      if (renderedUnit.truncated) {
        truncatedIds.add(result.id);
        truncatedUnitIds.add(unit.unitId);
      }
      unitBlocks.push(block);
      renderedUnits.push(renderedUnit);
      remainingPackBudget -= block.length + 2;
      remainingBodyBudget = Math.max(0, remainingBodyBudget - shortened.text.length);
    }
    if (unitBlocks.length === 0) {
      remainingPackBudget += cardHeader.length + 2;
      continue;
    }
    cardBlocks.push(`${cardHeader}${unitBlocks.join("\n\n")}`);
    renderedResults.push(result);
  }
  const renderedHeader = contextPackHeader(options, renderedResults.length, renderedUnits.length);
  const markdown = [renderedHeader, ...cardBlocks].join("\n\n");
  return {
    results: renderedResults,
    units: renderedUnits.filter((unit) => renderedResults.some((result) => result.id === unit.knowledgeId)),
    truncatedIds: [...truncatedIds],
    truncatedUnitIds: [...truncatedUnitIds],
    markdown: markdown.length <= options.totalBudgetChars ? markdown : markdown.slice(0, options.totalBudgetChars),
  };
}

function contextPackHeader(options: {
  input: ContextPackInput;
  query: string;
  questions: string[];
  allCandidateCount: number;
  excludedByRoutingCount: number;
  anchorApplied: boolean;
  anchorMatches: number;
  fallbackMatches: number;
  bodyBudgetChars: number;
  totalBudgetChars: number;
}, resultCount: number, unitCount: number): string {
  const cutoffScore = options.anchorApplied ? CONTEXT_ANCHOR_SCORE : 2;
  return [
    `# Context Pack: ${options.input.taskId}`,
    "",
    `- Query: ${options.query}`,
    `- Task questions: ${options.questions.join("; ")}`,
    `- Knowledge results: ${resultCount}`,
    `- Knowledge units: ${unitCount}`,
    `- Retrieval: ${options.allCandidateCount} broad candidates; ${options.excludedByRoutingCount} excluded by task/people routing; title anchor ${options.anchorApplied ? `retained ${options.anchorMatches}` : `had no match, explicit goal fallback retained ${options.fallbackMatches}`}; ${options.anchorApplied ? "absolute anchor" : "relative"} cutoff score ${cutoffScore}; ${Math.max(0, options.allCandidateCount - options.excludedByRoutingCount - resultCount)} excluded by answerability/relevance`,
    `- Body budget: ${options.bodyBudgetChars} characters; only matched units are materialized`,
    `- Total pack budget: ${options.totalBudgetChars} characters`,
    `- Use policy: ${options.input.includeDrafts === false ? "verified only" : "verified + draft (drafts are advisory and must be checked before relying on them)"}`,
  ].join("\n");
}

function truncateContextUnitText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n\n[…知识单元已按 Context Pack 总预算截断…]";
  return { text: `${text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`, truncated: true };
}

interface WeightedContextTerm {
  value: string;
  weight: number;
}

const GENERIC_CONTEXT_TERMS = new Set([
  "具体", "问题", "具体问题", "当前", "任务", "改造", "实现", "通过", "返回", "需要", "支持", "结果", "完成", "验证", "相关", "内容", "知识", "单元", "具体知识", "任务问题", "进行", "方案",
  "task", "source", "draft", "evidence", "status", "current", "run", "acceptance", "scope", "work", "must", "with", "from", "that", "this", "into",
]);

function contextWeightedTerms(value: string): WeightedContextTerm[] {
  const normalized = value.toLowerCase();
  const terms = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    const trimmed = term.trim();
    if (trimmed.length < 2 || genericContextTerm(trimmed)) return;
    terms.set(trimmed, Math.max(terms.get(trimmed) ?? 0, weight));
  };
  for (const match of normalized.match(/[a-z][a-z0-9_-]{1,}/g) ?? []) add(match, 6);
  for (const run of normalized.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 3) add(run, 4);
    for (let length = 2; length <= Math.min(8, run.length); length += 1) {
      const weight = length >= 5 ? 6 : length >= 4 ? 4 : length;
      for (let start = 0; start + length <= run.length; start += 1) add(run.slice(start, start + length), weight);
    }
  }
  return [...terms].map(([value, weight]) => ({ value, weight })).sort((left, right) => right.weight - left.weight || right.value.length - left.value.length);
}

function genericContextTerm(term: string): boolean {
  if (GENERIC_CONTEXT_TERMS.has(term)) return true;
  if (term.length > 4) return false;
  return [...GENERIC_CONTEXT_TERMS].some((generic) => generic.length >= term.length && generic.includes(term));
}

function scoreContextText(text: string, terms: WeightedContextTerm[]): number {
  const normalized = text.toLowerCase();
  const weights = matchedContextTerms(normalized, terms).map((term) => term.weight);
  return weights.slice(0, 3).reduce((total, weight) => total + weight, 0);
}

function answerableKnowledgeUnit(unitText: string, question: string, terms: WeightedContextTerm[], directScore: number): boolean {
  if (directScore < 2) return false;
  if (directScore >= 4) return true;
  const matchedTerms = matchedContextTerms(unitText, terms).slice(0, 3);
  if (matchedTerms.some((term) => !WEAK_UNIT_ONLY_TERMS.has(term.value))) return true;
  return sharedCjkPhrase(question, unitText) || sharedAsciiIdentifier(question, unitText);
}

function matchedContextTerms(text: string, terms: WeightedContextTerm[]): WeightedContextTerm[] {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term.value)).sort((left, right) => right.weight - left.weight || right.value.length - left.value.length);
}

function sharedCjkPhrase(question: string, unitText: string): boolean {
  const normalizedUnit = unitText.toLowerCase();
  for (const run of question.toLowerCase().match(/[\u3400-\u9fff]{3,}/g) ?? []) {
    for (let length = 3; length <= run.length; length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) {
        if (normalizedUnit.includes(run.slice(start, start + length))) return true;
      }
    }
  }
  return false;
}

function sharedAsciiIdentifier(question: string, unitText: string): boolean {
  const normalizedUnit = unitText.toLowerCase();
  return (question.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? []).some((identifier) => normalizedUnit.includes(identifier));
}

function contextBodyExcerpt(body: string, query: string, maxChars: number): { text: string; truncated: boolean } {
  if (body.length <= maxChars) return { text: body, truncated: false };
  const sections = splitMarkdownSections(body);
  const terms = contextTerms(query);
  const ranked = sections.map((section, index) => ({
    section,
    index,
    score: terms.reduce((total, term) => total + (section.heading.toLowerCase().includes(term) ? 6 : 0) + (section.text.toLowerCase().includes(term) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Set<number>([0]);
  let used = sections[0]?.text.length ?? 0;
  for (const item of ranked) {
    if (selected.has(item.index)) continue;
    if (item.score === 0 && selected.size > 1) continue;
    if (used + item.section.text.length > maxChars && selected.size > 1) continue;
    selected.add(item.index);
    used += item.section.text.length;
    if (used >= maxChars) break;
  }
  let text = sections.filter((_, index) => selected.has(index)).map((section) => section.text).join("\n\n[…中间非相关章节已省略；完整正文见 Source 路径…]\n\n");
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 80)).trimEnd()}\n\n[…正文已按 Context Pack 预算截断…]`;
  return { text, truncated: true };
}

function splitMarkdownSections(body: string): Array<{ heading: string; text: string }> {
  const lines = body.split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "导言", lines: [] }];
  for (const line of lines) {
    const match = /^#{1,4}\s+(.+)$/.exec(line);
    if (match) sections.push({ heading: match[1].trim(), lines: [line] });
    else sections.at(-1)!.lines.push(line);
  }
  return sections.map((section) => ({ heading: section.heading, text: section.lines.join("\n").trim() })).filter((section) => section.text);
}

function contextTerms(query: string): string[] {
  return contextWeightedTerms(query).map((term) => term.value);
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
