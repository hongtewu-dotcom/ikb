import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeRecord, KnowledgeSearchResult } from "../types.ts";
import { resolveVault } from "../layout.ts";
import { KNOWLEDGE_DIRECTORIES } from "./contracts.ts";
import { knowledgeScopes } from "./catalog.ts";
import { hasStableKnowledgeId, today, tryParseKnowledge } from "./codec.ts";
import { compareKnowledge, knowledgeMarkdownFiles, LEGACY_KNOWLEDGE_DIRECTORY } from "./storage.ts";

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

export function searchKnowledge(home: string, query: string, options: { scope?: string; status?: string; limit?: number } = {}): KnowledgeSearchResult[] {
  const terms = tokenizeQuery(query);
  const statuses = options.status
    ? options.status.split(",").map((item) => item.trim()).filter(Boolean)
    : ["verified", "draft"];
  return listKnowledge(home, options.scope)
    .filter((record) => statuses.includes(record.status))
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
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 8 : 0) + (tags.includes(term) ? 4 : 0) + (useText.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter((item) => terms.length === 0 || item.score > 0)
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
      compilationRef: record.compilationRef,
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

function makeSnippet(body: string, terms: string[]): string {
  const normalized = body.replaceAll(/\s+/g, " ").trim();
  if (!terms.length || !normalized) return normalized.slice(0, 240);
  const index = Math.max(0, normalized.toLowerCase().indexOf(terms.find((term) => normalized.toLowerCase().includes(term)) ?? ""));
  return normalized.slice(Math.max(0, index - 80), index + 240);
}

function tokenizeQuery(query: string): string[] {
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
