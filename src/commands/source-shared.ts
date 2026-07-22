import { LedgerStore } from "../store.ts";
import { candidateEventType, discoverCitadelCandidates } from "../candidates.ts";
import type { Candidate, SourceRecord } from "../types.ts";

export const CITADEL_RATE_LIMIT_MAX = 10;
const CITADEL_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;

export function citadelRateLimit(store: LedgerStore, nowMs = Date.now()): { used: number; remaining: number; resetAt: string | null } {
  const cutoff = nowMs - CITADEL_RATE_LIMIT_WINDOW_MS;
  const recent = store.listEvents()
    .filter((event) => (event.aggregateType === "candidate" && event.eventType === "candidate.resolve_started")
      || (event.aggregateType === "source" && event.eventType === "source.citadel_read_started"))
    .map((event) => Date.parse(event.occurredAt))
    .filter((occurredAt) => Number.isFinite(occurredAt) && occurredAt >= cutoff && occurredAt <= nowMs)
    .sort((left, right) => left - right);
  const used = recent.length;
  const oldest = recent[0];
  return {
    used,
    remaining: Math.max(0, CITADEL_RATE_LIMIT_MAX - used),
    resetAt: oldest === undefined ? null : new Date(oldest + CITADEL_RATE_LIMIT_WINDOW_MS).toISOString(),
  };
}

export function sourceEventPayload(source: SourceRecord): Record<string, unknown> {
  return { ...source };
}

export function discoverCandidatesForSource(store: LedgerStore, home: string, sourceId: string, options: { cache?: Map<string, Candidate>; existingSources?: SourceRecord[]; source?: SourceRecord } = {}): { sourceId: string; created: number; updated: number; candidateIds: string[] } {
  const result = discoverCitadelCandidates(home, sourceId, options);
  if (result.created > 0 || result.updated > 0) {
    store.recordSourceEvent(result.sourceId, "source.candidate_discovery", {
      sourceId: result.sourceId,
      scannedRecords: result.scannedRecords,
      foundLocators: result.foundLocators,
      created: result.created,
      updated: result.updated,
      candidateIds: result.candidates.map((candidate) => candidate.id),
    });
    for (const candidate of result.candidates) {
      if (result.createdIds.includes(candidate.id)) store.recordCandidateEvent(candidate.id, candidateEventType(candidate.status, true), { candidate, reason: "automatic source reference discovery" });
      else if (result.updatedIds.includes(candidate.id)) store.recordCandidateEvent(candidate.id, "candidate.updated", { candidate, reason: "automatic source reference discovery" });
    }
  }
  return { sourceId: result.sourceId, created: result.created, updated: result.updated, candidateIds: result.candidates.map((candidate) => candidate.id) };
}
