import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import type { Artifact, EventRecord } from "./types.ts";
import type { LedgerStore } from "./store.ts";

export const KNOWLEDGE_USAGE_CONTRACT_VERSION = "knowledge-usage.v1";

export const KNOWLEDGE_USE_PURPOSES = ["decision", "paragraph", "check", "action", "code", "review", "other"] as const;
export type KnowledgeUsePurpose = typeof KNOWLEDGE_USE_PURPOSES[number];

export interface KnowledgeUsageStatus {
  contractVersion: typeof KNOWLEDGE_USAGE_CONTRACT_VERSION;
  runId: string;
  activated: boolean;
  complete: boolean;
  queryCount: number;
  referenceCount: number;
  useCount: number;
  feedbackCount: number;
  referencedKnowledgeIds: string[];
  usedKnowledgeIds: string[];
  resolvedKnowledgeIds: string[];
  unresolvedKnowledgeIds: string[];
  reviewedIncorrectUnadoptedKnowledgeIds: string[];
  reviewedIncorrectUnadoptedKnowledgeCount: number;
  outcomes: Record<string, number>;
}

export function buildKnowledgeUsageStatus(store: LedgerStore, runId: string): KnowledgeUsageStatus {
  store.requireRun(runId);
  const events = store.listEvents();
  const queries = events.filter((event) => event.eventType === "knowledge.query_executed"
    && event.payload.runId === runId
    && event.payload.contractVersion === KNOWLEDGE_USAGE_CONTRACT_VERSION);
  const references = knowledgeEventsForRun(events, runId, "knowledge.referenced");
  const uses = knowledgeEventsForRun(events, runId, "knowledge.used");
  const feedback = knowledgeEventsForRun(events, runId, "knowledge.feedback_recorded");
  const referencedKnowledgeIds = uniqueSorted(references.map((event) => event.aggregateId));
  const usedKnowledgeIds = uniqueSorted(uses.map((event) => event.aggregateId));
  const resolvedKnowledgeIds = uniqueSorted(feedback.map((event) => event.aggregateId));
  const reviewedIncorrectUnadoptedKnowledgeIds = uniqueSorted(feedback
    .filter((event) => event.payload.outcome === "unused" && event.payload.reviewFinding === "incorrect")
    .map((event) => event.aggregateId));
  const activated = queries.length > 0 || uses.length > 0;
  const expected = uniqueSorted([...referencedKnowledgeIds, ...usedKnowledgeIds]);
  const resolved = new Set(resolvedKnowledgeIds);
  const unresolvedKnowledgeIds = activated ? expected.filter((id) => !resolved.has(id)) : [];
  return {
    contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
    runId,
    activated,
    complete: !activated || unresolvedKnowledgeIds.length === 0,
    queryCount: queries.length,
    referenceCount: references.length,
    useCount: uses.length,
    feedbackCount: feedback.length,
    referencedKnowledgeIds,
    usedKnowledgeIds,
    resolvedKnowledgeIds,
    unresolvedKnowledgeIds,
    reviewedIncorrectUnadoptedKnowledgeIds,
    reviewedIncorrectUnadoptedKnowledgeCount: reviewedIncorrectUnadoptedKnowledgeIds.length,
    outcomes: countBy(feedback.map((event) => String(event.payload.outcome ?? "unknown"))),
  };
}

export function knowledgeEventsForRun(events: EventRecord[], runId: string, eventType: string, knowledgeId?: string): EventRecord[] {
  return events.filter((event) => event.aggregateType === "knowledge"
    && event.eventType === eventType
    && event.payload.runId === runId
    && (!knowledgeId || event.aggregateId === knowledgeId));
}

export function retrySuppressedKnowledgeIds(store: LedgerStore, runId: string): string[] {
  const run = store.requireRun(runId);
  const ancestorRunIds = new Set<string>();
  const visited = new Set([run.id]);
  let ancestorId = run.retryOf;
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = store.getRun(ancestorId);
    if (!ancestor || ancestor.taskId !== run.taskId) break;
    ancestorRunIds.add(ancestor.id);
    ancestorId = ancestor.retryOf;
  }
  if (ancestorRunIds.size === 0) return [];

  const latestFeedback = new Map<string, EventRecord>();
  for (const event of store.listEvents()) {
    if (event.aggregateType !== "knowledge" || event.eventType !== "knowledge.feedback_recorded") continue;
    if (!ancestorRunIds.has(String(event.payload.runId ?? ""))) continue;
    latestFeedback.set(event.aggregateId, event);
  }
  return [...latestFeedback.values()]
    .filter((event) => event.payload.outcome === "unused" && explicitlyUnrelatedReason(String(event.payload.reasonCode ?? "")))
    .map((event) => event.aggregateId)
    .sort();
}

function explicitlyUnrelatedReason(reasonCode: string): boolean {
  const normalized = reasonCode.trim().toLowerCase().replace(/[_\s]+/g, "-");
  return normalized === "unrelated-domain"
    || normalized.startsWith("unrelated-")
    || normalized === "not-applicable"
    || normalized === "retrieved-but-not-applicable"
    || normalized === "retrieved-but-not-relevant";
}

export function requireIntegrityCheckedRunArtifact(store: LedgerStore, runId: string, reference: string, label: string): Artifact {
  const artifactId = reference.replace(/^artifact:\/\//, "");
  if (!/^artifact-[A-Za-z0-9._-]+$/.test(artifactId)) throw new Error(`${label} must be an Artifact id: ${reference}`);
  const artifact = store.getArtifact(artifactId);
  if (!artifact) throw new Error(`${label} Artifact not found: ${artifactId}`);
  if (artifact.runId !== runId) throw new Error(`${label} Artifact ${artifactId} does not belong to Run ${runId}`);
  if (!artifact.contentHash) throw new Error(`${label} Artifact ${artifactId} has no content hash`);
  if (!existsSync(artifact.path)) throw new Error(`${label} Artifact file is missing: ${artifactId}`);
  const stat = lstatSync(artifact.path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} Artifact ${artifactId} must be a regular file`);
  const currentHash = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
  if (currentHash !== artifact.contentHash) throw new Error(`${label} Artifact ${artifactId} content hash mismatch`);
  return artifact;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
