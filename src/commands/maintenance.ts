import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertValue, printValue } from "../format.ts";
import { archiveInboxItem, archivedInboxItemPath, inboxItemId, listInboxItems, upsertInboxItem, type InboxItemInput } from "../inbox.ts";
import { archiveResolvedHumanConfirmationFiles } from "../human-confirmation.ts";
import { listExperienceCandidates } from "../experience.ts";
import { knowledgeRetrievalEligibilityAtHome, listKnowledge } from "../knowledge.ts";
import { heldKnowledgeIds } from "../knowledge/holds.ts";
import { receiptRoot, writeReceipt, type Receipt } from "../receipt.ts";
import { applySemanticMaintenance, SEMANTIC_MAINTENANCE_SCHEMA, type SemanticMaintenanceInput } from "../semantic-maintenance.ts";
import { scanPrincipleConfirmationConflicts } from "../principle-review.ts";
import { listSources } from "../source.ts";
import type { LedgerStore } from "../store.ts";
import type { KnowledgeRecord, SourceRecord } from "../types.ts";
import { resolveBackupsRoot } from "../layout.ts";
import { type ParsedArgs, optionalBoundedInteger, optionalOption, outputFormat, requiredOption } from "./shared.ts";

export function handleMaintenance(store: LedgerStore, home: string, action: string | undefined, parsed: ParsedArgs): void {
  switch (action) {
    case "refresh-inbox":
      printValue(refreshInboxFromSignals(store, home, optionalOption(parsed, "since")), outputFormat(parsed));
      break;
    case "semantic-select":
      printValue(selectSemanticInbox(home, optionalOption(parsed, "scope"), optionalBoundedInteger(parsed, "limit", 1, 3) ?? 3), outputFormat(parsed));
      break;
    case "semantic-apply": {
      const value = readJsonFile(requiredOption(parsed, "file"), "Semantic maintenance decisions") as SemanticMaintenanceInput;
      assertValue(value.schema === SEMANTIC_MAINTENANCE_SCHEMA, `Semantic maintenance decisions must use ${SEMANTIC_MAINTENANCE_SCHEMA}`);
      printValue(applySemanticMaintenance(home, store, value), outputFormat(parsed));
      break;
    }
    case "write-receipt": {
      const value = readJsonFile(requiredOption(parsed, "file"), "Receipt input") as Omit<Receipt, "schema" | "id" | "finishedAt"> & { finishedAt?: string };
      printValue(writeReceipt(home, store, value), outputFormat(parsed));
      break;
    }
    case "weekly-snapshot":
      printValue(buildWeeklySnapshot(store, home), outputFormat(parsed));
      break;
    case "principle-conflict-scan": {
      const scope = optionalOption(parsed, "scope") ?? "work";
      assertValue(scope === "personal" || scope === "work", "--scope must be personal or work");
      printValue(scanPrincipleConfirmationConflicts(home, store, scope, optionalBoundedInteger(parsed, "limit", 1, 3) ?? 3), outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown maintenance action: ${action ?? ""}`);
  }
}

export function refreshInboxFromSignals(store: LedgerStore, home: string, since?: string) {
  const boundary = since ?? latestReceiptBoundary(store, "source_sync") ?? "1970-01-01T00:00:00.000Z";
  const boundaryMs = Date.parse(boundary);
  assertValue(Number.isFinite(boundaryMs), `--since must be an ISO timestamp: ${boundary}`);
  const allEvents = store.listEvents();
  const events = allEvents.filter((event) => Date.parse(event.occurredAt) > boundaryMs);
  const sourcesById = new Map(listSources(home, { includeQuarantined: true }).map((source) => [source.id, source]));
  const knowledge = listKnowledge(home);
  const knowledgeById = new Map(knowledge.map((record) => [record.id, record]));
  const holds = heldKnowledgeIds(home);
  const coverageBySource = new Map<string, { linked: string[]; eligible: string[] }>();
  for (const record of knowledge) {
    for (const ref of record.sourceRefs) {
      const sourceId = normalizedSourceId(ref);
      if (!sourceId) continue;
      const coverage = coverageBySource.get(sourceId) ?? { linked: [], eligible: [] };
      coverage.linked.push(record.id);
      if (record.status === "verified" && !holds.has(record.id) && knowledgeRetrievalEligibilityAtHome(home, record).eligible) coverage.eligible.push(record.id);
      coverageBySource.set(sourceId, coverage);
    }
  }
  const candidateStatuses = new Map(listExperienceCandidates(home).map((candidate) => [candidate.id, candidate.status] as const));
  const archivedConfirmations = ["personal", "work"].flatMap((scope) => archiveResolvedHumanConfirmationFiles(home, scope as "personal" | "work", candidateStatuses));
  const reconciled = reconcileExistingInbox(home, sourcesById, coverageBySource, knowledge, holds);
  const activeIds = new Set(listInboxItems(home).map((item) => item.id));
  const items: Array<{ id: string; path: string; trigger: string }> = [];
  const addSignal = (input: InboxItemInput): void => {
    const id = inboxItemId(input);
    if (activeIds.has(id) || existsSync(archivedInboxItemPath(home, input.scope, id))) return;
    const item = upsertInboxItem(home, input);
    activeIds.add(item.id);
    items.push({ id: item.id, path: item.path, trigger: item.trigger });
  };
  for (const event of events) {
    if (event.aggregateType === "source" && event.eventType === "source.ingested") {
      const source = sourcesById.get(event.aggregateId);
      if (!source) continue;
      const coverage = coverageBySource.get(source.id) ?? { linked: [], eligible: [] };
      if (coverage.eligible.length > 0 || !sourceNeedsSemanticInbox(source, coverage)) continue;
      addSignal({
        scope: source.scope as "personal" | "work",
        trigger: "source_changed",
        subject: source.title,
        goal: "判断新增或变化的 Source 是否需要 new、update、keep 或 retire Knowledge",
        sourceRefs: [source.id],
        knowledgeIds: coverage.linked,
        usageId: null,
        details: { sourceEventId: event.eventId, knowledgeStatus: coverage.linked.length > 0 ? "draft_only" : "none" },
      });
      continue;
    }
    if (event.aggregateType === "knowledge_query" && event.eventType === "knowledge.query_executed" && event.payload.zeroResult === true) {
      const scope = event.payload.scope;
      if (scope !== "personal" && scope !== "work") continue;
      const usageId = typeof event.payload.runId === "string" ? event.payload.runId : null;
      const subject = String(event.payload.query ?? "Knowledge zero result");
      if (zeroResultResolved(subject, knowledge, holds, home)) continue;
      addSignal({
        scope,
        trigger: "zero_result",
        subject,
        goal: subject || null,
        sourceRefs: [],
        knowledgeIds: [],
        usageId,
        details: { queryId: event.aggregateId, queryEventId: event.eventId },
      });
    }
  }
  for (const event of unresolvedKnowledgeFeedback(allEvents)) {
    const record = knowledgeById.get(event.aggregateId);
    if (!record || record.status === "retired") continue;
    const outcome = event.payload.outcome;
    if (outcome !== "partial" && outcome !== "incorrect") continue;
    addSignal({
      scope: record.scope as "personal" | "work",
      trigger: outcome === "incorrect" ? "incorrect_feedback" : "partial_feedback",
      subject: record.title,
      goal: "根据真实消费者反馈更新或退役 Knowledge",
      sourceRefs: record.sourceRefs,
      knowledgeIds: [record.id],
      usageId: typeof event.payload.runId === "string" ? event.payload.runId : null,
      details: { feedbackEventId: event.eventId, outcome, reasonCode: event.payload.reasonCode ?? null },
    });
  }
  return {
    since: boundary,
    scannedEvents: events.length,
    feedbackEventsScanned: allEvents.filter((event) => event.eventType === "knowledge.feedback_recorded").length,
    createdOrRefreshed: unique(items.map((item) => item.id)).length,
    byTrigger: countBy(items.map((item) => item.trigger)),
    items: uniqueById(items),
    archived: {
      inbox: reconciled,
      confirmations: archivedConfirmations,
    },
  };
}

function reconcileExistingInbox(
  home: string,
  sourcesById: ReadonlyMap<string, SourceRecord>,
  coverageBySource: ReadonlyMap<string, { linked: string[]; eligible: string[] }>,
  knowledge: KnowledgeRecord[],
  holds: ReadonlySet<string>,
) {
  const archived: Array<{ id: string; from: string; to: string; reason: string }> = [];
  for (const item of listInboxItems(home)) {
    let reason: string | null = null;
    if (item.trigger === "source_changed") {
      const sourceId = item.sourceRefs.map(normalizedSourceId).find(Boolean) ?? null;
      const source = sourceId ? sourcesById.get(sourceId) : null;
      const coverage = sourceId ? (coverageBySource.get(sourceId) ?? { linked: [], eligible: [] }) : { linked: [], eligible: [] };
      if (source && coverage.eligible.length > 0) reason = "source_already_covered";
      else if (source && !sourceNeedsSemanticInbox(source, coverage)) reason = "source_routes_to_evidence_analysis";
    } else if (item.trigger === "zero_result" && zeroResultResolved(item.goal ?? item.subject, knowledge, holds, home)) {
      reason = "query_now_resolved";
    }
    if (!reason) continue;
    archived.push({ ...archiveInboxItem(home, item.id), reason });
  }
  return archived;
}

function sourceNeedsSemanticInbox(source: SourceRecord, coverage: { linked: string[]; eligible: string[] }): boolean {
  if (coverage.linked.length > 0) return true;
  return source.kind === "document" || source.kind === "review_comment";
}

function zeroResultResolved(query: string, knowledge: KnowledgeRecord[], holds: ReadonlySet<string>, home: string): boolean {
  const normalized = normalizeLookup(query);
  if (!normalized) return false;
  return knowledge.some((record) => record.status === "verified"
    && !holds.has(record.id)
    && knowledgeRetrievalEligibilityAtHome(home, record).eligible
    && [record.title, ...record.aliases].some((value) => normalizeLookup(value) === normalized));
}

function normalizeLookup(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replaceAll(/\s+/g, " ");
}

function unresolvedKnowledgeFeedback(events: ReturnType<LedgerStore["listEvents"]>) {
  const unresolved = new Map<string, ReturnType<LedgerStore["listEvents"]>[number]>();
  for (const event of events) {
    if (event.aggregateType !== "knowledge") continue;
    if (["knowledge.created", "knowledge.verified", "knowledge.migrated", "knowledge.retired", "knowledge.archived"].includes(event.eventType)
      || (event.eventType === "knowledge.revised" && event.payload.reason !== "incorrect_feedback")) {
      unresolved.delete(event.aggregateId);
      continue;
    }
    if (event.eventType === "knowledge.feedback_recorded" && (event.payload.outcome === "partial" || event.payload.outcome === "incorrect")) {
      unresolved.set(event.aggregateId, event);
    }
  }
  return [...unresolved.values()];
}

function normalizedSourceId(ref: string): string | null {
  const value = ref.trim().replace(/^source:\/\//, "").replace(/^source:/, "");
  return /^src-[A-Za-z0-9-]+$/.test(value) ? value : null;
}

export function selectSemanticInbox(home: string, scopeValue?: string, limit = 3) {
  const scope = scopeValue === undefined ? "work" : scopeValue;
  assertValue(scope === "personal" || scope === "work", "--scope must be personal or work");
  const priority: Record<string, number> = {
    incorrect_feedback: 0,
    partial_feedback: 1,
    principle_confirmation: 2,
    zero_result: 3,
    source_changed: 4,
    source_uncovered: 5,
  };
  const eligible = listInboxItems(home, scope)
    .filter((item) => Boolean(item.goal?.trim()) || item.trigger === "incorrect_feedback" || item.trigger === "partial_feedback")
    .sort((left, right) => (priority[left.trigger] ?? 99) - (priority[right.trigger] ?? 99)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
  return {
    scope,
    limit,
    available: eligible.length,
    selected: eligible.slice(0, limit).map((item) => ({
      id: item.id,
      trigger: item.trigger,
      subject: item.subject,
      goal: item.goal,
      sourceRefs: item.sourceRefs,
      knowledgeIds: item.knowledgeIds,
      usageId: item.usageId,
      path: item.path,
    })),
  };
}

function buildWeeklySnapshot(store: LedgerStore, home: string) {
  const receipts = store.listEvents().filter((event) => event.eventType === "receipt.written");
  const failed = receipts.filter((event) => event.payload.outcome === "failed" || event.payload.outcome === "partial");
  const backupRoot = resolveBackupsRoot(home);
  const backups = safeFiles(backupRoot);
  return {
    generatedAt: new Date().toISOString(),
    receipts: receipts.length,
    failedOrPartialReceipts: failed.length,
    recentFailureKinds: countBy(failed.slice(-100).map((event) => String(event.payload.kind ?? "unknown"))),
    inbox: {
      personal: listInboxItems(home, "personal").length,
      work: listInboxItems(home, "work").length,
    },
    backups: { count: backups.length, candidates: backups.slice(0, Math.max(0, backups.length - 3)) },
    receiptFiles: safeFiles(receiptRoot(home)).length,
  };
}

function latestReceiptBoundary(store: LedgerStore, kind: string): string | null {
  return store.listEvents().filter((event) => event.eventType === "receipt.written" && event.payload.kind === kind).at(-1)?.occurredAt ?? null;
}

function readJsonFile(pathValue: string, label: string): unknown {
  const path = resolve(pathValue);
  assertValue(existsSync(path), `${label} file not found: ${pathValue}`);
  const stat = lstatSync(path);
  assertValue(!stat.isSymbolicLink() && stat.isFile(), `${label} must be a regular file: ${pathValue}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${(error as Error).message}`);
  }
}

function safeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isFile() ? [join(root, entry.name)] : []);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
