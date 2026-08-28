import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeRecord, KnowledgeSearchResult } from "../types.ts";
import { resolveVault } from "../layout.ts";
import { KNOWLEDGE_DIRECTORIES } from "./contracts.ts";
import { knowledgeScopes } from "./catalog.ts";
import { hasStableKnowledgeId, today, tryParseKnowledge } from "./codec.ts";
import { knowledgeRetrievalEligibilityAtHome } from "./eligibility.ts";
import { compareKnowledge, knowledgeMarkdownFiles, LEGACY_KNOWLEDGE_DIRECTORY } from "./storage.ts";
import { heldKnowledgeIds } from "./holds.ts";

export function listKnowledge(home: string, scope?: string): KnowledgeRecord[] {
  return knowledgeScopes(scope).flatMap((currentScope) => {
    const vault = resolveVault(home, currentScope);
    return [
      ...knowledgeMarkdownFiles(join(vault, LEGACY_KNOWLEDGE_DIRECTORY), true),
      ...KNOWLEDGE_DIRECTORIES.flatMap((directory) => knowledgeMarkdownFiles(join(vault, directory))),
    ].flatMap((path) => {
      const text = readFileSync(path, "utf8");
      if (!hasStableKnowledgeId(text)) return [];
      const record = tryParseKnowledge(text, path);
      if (!record) return [];
      return record.scope === currentScope ? [record] : [];
    });
  }).sort(compareKnowledge);
}

export function findKnowledge(home: string, id: string): KnowledgeRecord | null {
  const matches = listKnowledge(home).filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`Duplicate knowledge id ${id}: ${matches.map((record) => record.path).join(", ")}`);
  return matches[0] ?? null;
}

export function reviewKnowledge(home: string, scope?: string): KnowledgeRecord[] {
  const todayValue = today();
  return listKnowledge(home, scope).filter((record) => record.status === "draft" || record.reviewAfter <= todayValue);
}

export function searchKnowledge(home: string, query: string, options: { scope?: string; status?: string; limit?: number; includeHeld?: boolean; taskType?: string; requireRoutingMatch?: boolean; peopleMode?: "auto" | "include" } = {}): KnowledgeSearchResult[] {
  const terms = tokenizeKnowledgeQuery(query);
  const holds = options.includeHeld ? new Set<string>() : heldKnowledgeIds(home);
  const statuses = options.status
    ? options.status.split(",").map((item) => item.trim()).filter(Boolean)
    : ["verified", "draft"];
  return listKnowledge(home, options.scope)
    .filter((record) => statuses.includes(record.status))
    .filter((record) => !holds.has(record.id))
    .filter((record) => knowledgeRetrievalEligibilityAtHome(home, record).eligible)
    .filter((record) => record.collection !== "people" || peopleKnowledgeAllowed(record, query, options))
    .map((record) => {
      const title = record.title.toLowerCase();
      const body = record.body.toLowerCase();
      const tags = record.tags.join(" ").toLowerCase();
      const useText = [
        record.useWhen ?? "",
        ...(record.useInputs ?? []),
        ...(record.useOutputs ?? []),
        ...(record.useSteps ?? []),
        ...(record.questionsAnswered ?? []),
        ...(record.doNotUseFor ?? []),
      ].join(" ").toLowerCase();
      const routingText = [record.useWhen ?? "", ...(record.questionsAnswered ?? []), productTypeRoutingText(record.productType)].join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 8 : 0) + (tags.includes(term) ? 4 : 0) + (useText.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      const routingScore = terms.reduce((total, term) => total + (title.includes(term) ? 8 : 0) + (tags.includes(term) ? 4 : 0) + (routingText.includes(term) ? 3 : 0), 0);
      return { record, score, routingScore };
    })
    .filter((item) => terms.length === 0 || item.score > 0)
    .filter((item) => !options.requireRoutingMatch || terms.length === 0 || item.routingScore > 0)
    .sort((left, right) => right.score - left.score || right.record.validFrom.localeCompare(left.record.validFrom))
    .slice(0, options.limit ?? 20)
    .map(({ record, score }) => ({
      id: record.id,
      title: record.title,
      type: record.type,
      collection: record.collection,
      scope: record.scope,
      status: record.status,
      path: record.path,
      score,
      snippet: makeSnippet(record.body, terms),
      productType: record.productType,
      canonicalKey: record.canonicalKey,
      compilationSchema: record.compilationSchema,
      compilationCaseId: record.compilationCaseId,
      compilationProductId: record.compilationProductId,
      extractionManifestRef: record.extractionManifestRef,
      compilationRef: record.compilationRef,
      informationLossRef: record.informationLossRef,
      factRefs: record.factRefs,
      questionsAnswered: record.questionsAnswered,
      doNotUseFor: record.doNotUseFor,
      useWhen: record.useWhen,
      useInputs: record.useInputs,
      useOutputs: record.useOutputs,
      useSteps: record.useSteps,
      useChecks: record.useChecks,
      useStopConditions: record.useStopConditions,
    }));
}

function productTypeRoutingText(productType?: string): string {
  if (!productType) return "";
  const normalized = productType.toLowerCase();
  if (normalized.includes("architecture")) return `${normalized} 架构 系统 拓扑 组件 依赖`;
  if (normalized.includes("person")) return `${normalized} 人物 沟通 协作`;
  if (normalized.includes("playbook")) return `${normalized} 作业 步骤 执行 检查`;
  if (normalized.includes("decision")) return `${normalized} 决策 选择 边界`;
  if (normalized.includes("domain")) return `${normalized} 领域 业务 实体 规则`;
  if (normalized.includes("project")) return `${normalized} 项目 状态 里程碑 风险`;
  return normalized;
}

function peopleKnowledgeAllowed(record: KnowledgeRecord, query: string, options: { taskType?: string; peopleMode?: "auto" | "include" }): boolean {
  if (options.peopleMode === "include") return true;
  if (options.taskType === "communication" || options.taskType === "upward-management") return true;
  const normalized = query.toLowerCase();
  if (personIdentityTerms(record).some((identity) => normalized.includes(identity))) return true;
  if (options.taskType) return false;
  return normalized.replaceAll("非人物", "").includes("人物") || /\b(?:person|people)\b/.test(normalized);
}

function personIdentityTerms(record: KnowledgeRecord): string[] {
  const terms = new Set<string>();
  const titleIdentity = record.title.split(/[：:]/, 1)[0]?.trim().toLowerCase();
  if (titleIdentity && titleIdentity.length >= 2 && titleIdentity.length <= 32) terms.add(titleIdentity);
  const canonicalSegments = (record.canonicalKey ?? "").toLowerCase().split(":");
  const peopleIndex = canonicalSegments.indexOf("people");
  const canonicalIdentity = peopleIndex >= 0 ? canonicalSegments[peopleIndex + 1] : "";
  if (canonicalIdentity && canonicalIdentity.length >= 2) terms.add(canonicalIdentity);
  return [...terms];
}

function makeSnippet(body: string, terms: string[]): string {
  const normalized = body.replaceAll(/\s+/g, " ").trim();
  if (!terms.length || !normalized) return normalized.slice(0, 240);
  const index = Math.max(0, normalized.toLowerCase().indexOf(terms.find((term) => normalized.toLowerCase().includes(term)) ?? ""));
  return normalized.slice(Math.max(0, index - 80), index + 240);
}

export function tokenizeKnowledgeQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const stopwords = new Set(["task", "source", "knowledge", "draft", "evidence", "use", "when", "status", "current", "context", "run", "check", "acceptance", "scope", "work", "must", "with", "from", "that", "this", "into"]);
  const tokens = new Set<string>(normalized.split(/[\s,，。；;:：/|()[\]{}<>《》“”"'`]+/).map((item) => item.trim()).filter((item) => item.length >= 2 && !stopwords.has(item)));
  for (const run of normalized.match(/[\u3400-\u9fff]{4,}/g) ?? []) {
    for (let length = 4; length <= Math.min(8, run.length); length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) tokens.add(run.slice(start, start + length));
    }
  }
  return [...tokens];
}
