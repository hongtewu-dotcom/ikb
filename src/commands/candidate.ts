import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import { ingestCitadelDocument } from "../external.ts";
import {
  addCandidate,
  candidateEventType,
  discoverCitadelCandidates,
  listCandidates,
  requireCandidate,
  updateCandidate,
  type CandidateInput,
} from "../candidates.ts";
import { listSources } from "../source.ts";
import type { SourceRecord } from "../types.ts";
import { CITADEL_RATE_LIMIT_MAX, citadelRateLimit, discoverCandidatesForSource, sourceEventPayload } from "./source-shared.ts";
import {
  type ParsedArgs,
  optionalOption,
  outputFormat,
  requiredArg,
  requiredOption,
  sleepMs,
} from "./shared.ts";

export function handleCandidate(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "add": {
      const kind = requiredOption(parsed, "kind") as CandidateInput["kind"];
      const locator = {
        adapter: optionalOption(parsed, "adapter") ?? (kind === "citadel_document" ? "citadel" : "manual"),
        contentId: optionalOption(parsed, "content-id"),
        url: optionalOption(parsed, "url"),
        query: optionalOption(parsed, "query"),
      };
      const result = addCandidate(home, {
        kind,
        title: requiredOption(parsed, "title"),
        scope: optionalOption(parsed, "scope"),
        sensitivity: optionalOption(parsed, "sensitivity"),
        locator,
        origin: {
          sourceIds: optionalOption(parsed, "source-id") ? [String(parsed.options["source-id"])] : [],
          recordIds: optionalOption(parsed, "record-id") ? [String(parsed.options["record-id"])] : [],
        },
        status: optionalOption(parsed, "status") as CandidateInput["status"],
        nextAction: optionalOption(parsed, "next-action"),
      });
      if (result.created || result.changed) store.recordCandidateEvent(result.candidate.id, candidateEventType(result.candidate.status, result.created), { candidate: result.candidate });
      printValue(result, outputFormat(parsed));
      break;
    }
    case "discover-all": {
      const sources = listSources(home).filter((source) => !optionalOption(parsed, "scope") || source.scope === optionalOption(parsed, "scope"));
      const existingSources = sources.filter((source) => source.adapter === "citadel");
      const candidateCache = new Map(listCandidates(home, optionalOption(parsed, "scope")).map((candidate) => [candidate.fingerprint, candidate] as const));
      const results = sources.map((source) => discoverCandidatesForSource(store, home, source.id, { cache: candidateCache, existingSources, source }));
      printValue({ sources: sources.length, discovered: results.reduce((total, result) => total + result.created, 0), updated: results.reduce((total, result) => total + result.updated, 0), results }, outputFormat(parsed));
      break;
    }
    case "list": {
      const candidates = listCandidates(home, optionalOption(parsed, "scope"))
        .filter((candidate) => !optionalOption(parsed, "kind") || candidate.kind === optionalOption(parsed, "kind"))
        .filter((candidate) => !optionalOption(parsed, "status") || candidate.status === optionalOption(parsed, "status"));
      printValue(candidates, outputFormat(parsed));
      break;
    }
    case "show":
      printValue(requireCandidate(home, requiredArg(args, 0, "candidate id")), outputFormat(parsed));
      break;
    case "update": {
      const id = requiredArg(args, 0, "candidate id");
      const candidate = updateCandidate(home, id, {
        status: optionalOption(parsed, "status") as CandidateInput["status"],
        reason: optionalOption(parsed, "reason"),
        nextAction: optionalOption(parsed, "next-action"),
        resolution: optionalOption(parsed, "resolved-source") ? { sourceIds: [String(parsed.options["resolved-source"])], ingestedAt: new Date().toISOString() } : undefined,
      });
      store.recordCandidateEvent(candidate.id, candidateEventType(candidate.status, false), { candidate });
      printValue(candidate, outputFormat(parsed));
      break;
    }
    case "discover": {
      const result = discoverCitadelCandidates(home, requiredArg(args, 0, "source id"), {
        status: optionalOption(parsed, "status") as CandidateInput["status"],
        sensitivity: optionalOption(parsed, "sensitivity"),
      });
      store.recordSourceEvent(result.sourceId, "source.candidate_discovery", {
        sourceId: result.sourceId,
        scannedRecords: result.scannedRecords,
        foundLocators: result.foundLocators,
        created: result.created,
        updated: result.updated,
        candidateIds: result.candidates.map((candidate) => candidate.id),
      });
      for (const candidate of result.candidates) {
        if (result.createdIds.includes(candidate.id)) store.recordCandidateEvent(candidate.id, candidateEventType(candidate.status, true), { candidate, reason: "source reference discovery" });
        else if (result.updatedIds.includes(candidate.id)) store.recordCandidateEvent(candidate.id, "candidate.updated", { candidate, reason: "source reference discovery" });
      }
      printValue(result, outputFormat(parsed));
      break;
    }
    case "resolve": {
      const id = requiredArg(args, 0, "candidate id");
      const candidate = requireCandidate(home, id);
      if (candidate.kind !== "citadel_document" || candidate.locator.adapter !== "citadel" || !candidate.locator.contentId) throw new Error(`Candidate ${id} is not a resolvable Citadel document`);
      if (candidate.status !== "queued") throw new Error(`Candidate ${id} must be queued before resolve (current: ${candidate.status})`);
      const rate = citadelRateLimit(store);
      assertValue(rate.remaining > 0, `Citadel rate limit reached: 10 reads per 30 minutes; retry after ${rate.resetAt ?? "the current window"}`);
      store.recordCandidateEvent(id, "candidate.resolve_started", {
        adapter: "citadel",
        contentId: candidate.locator.contentId,
        scope: candidate.scope,
        reason: "explicit Citadel document read",
      });
      const result = ingestCitadelDocument(home, candidate.locator.contentId, {
        scope: candidate.scope,
        sensitivity: candidate.sensitivity,
        includeComments: parsed.options["no-comments"] !== true,
      });
      const sources = [result.document.source, result.comments?.source].filter((source): source is SourceRecord => Boolean(source));
      store.recordSourceIngestEvents(sources.map((source) => ({ id: source.id, payload: sourceEventPayload(source) })));
      const updated = updateCandidate(home, id, {
        status: "ingested",
        resolution: {
          sourceIds: sources.map((source) => source.id),
          commentSourceId: result.comments?.source.id,
          ingestedAt: new Date().toISOString(),
        },
        nextAction: "build Source Context and analyze; do not auto-promote to verified",
      });
      store.recordCandidateEvent(updated.id, "candidate.ingested", { candidate: updated, sourceIds: sources.map((source) => source.id) });
      printValue({ candidate: updated, contentId: result.contentId, title: result.title, documentSourceId: result.document.source.id, commentSourceId: result.comments?.source.id ?? null, commentCount: result.comments?.count ?? 0 }, outputFormat(parsed));
      break;
    }
    case "resolve-all": {
      const scope = optionalOption(parsed, "scope");
      const limitText = optionalOption(parsed, "limit");
      const delayText = optionalOption(parsed, "delay-ms");
      const limit = Number(limitText ?? "10");
      const delayMs = Number(delayText ?? "30000");
      const dryRun = parsed.options["dry-run"] === true;
      assertValue(Number.isInteger(limit) && limit >= 0, "--limit must be an integer >= 0 (0 means drain pending candidates within the rate window)");
      assertValue(Number.isInteger(delayMs) && delayMs >= 0, "--delay-ms must be an integer >= 0");
      const allCandidates = listCandidates(home, scope)
        .filter((candidate) => candidate.kind === "citadel_document")
        .filter((candidate) => candidate.status === "discovered" || candidate.status === "queued")
        .filter((candidate) => candidate.locator.adapter === "citadel" && Boolean(candidate.locator.contentId));
      const requestedCandidates = limit === 0 ? allCandidates : allCandidates.slice(0, limit);
      if (dryRun) {
        const rate = citadelRateLimit(store);
        printValue({ scope: scope ?? "all", limit, delayMs, dryRun: true, rateLimit: { max: CITADEL_RATE_LIMIT_MAX, windowMinutes: 30, used: rate.used, remaining: rate.remaining, resetAt: rate.resetAt }, requested: requestedCandidates.length, processed: 0, discovered: allCandidates.length, ingested: 0, blocked: 0, remaining: allCandidates.length }, outputFormat(parsed));
        break;
      }
      const results: Array<Record<string, unknown>> = [];
      let lastStartedAt = 0;
      for (const candidate of requestedCandidates) {
        if (lastStartedAt > 0) sleepMs(Math.max(0, delayMs - (Date.now() - lastStartedAt)));
        const rate = citadelRateLimit(store);
        if (rate.remaining <= 0) break;
        lastStartedAt = Date.now();
        let current = candidate;
        try {
          if (current.status === "discovered") {
            current = updateCandidate(home, current.id, {
              status: "queued",
              nextAction: "auto-resolve: read the document and comments through the official read-only Citadel adapter",
            });
            store.recordCandidateEvent(current.id, "candidate.queued", { candidate: current, reason: "authorized automatic Citadel read" });
          }
          store.recordCandidateEvent(current.id, "candidate.resolve_started", {
            adapter: "citadel",
            contentId: current.locator.contentId,
            scope: current.scope,
            reason: "authorized automatic Citadel read",
          });
          const result = ingestCitadelDocument(home, current.locator.contentId!, {
            scope: current.scope,
            sensitivity: current.sensitivity,
            includeComments: parsed.options["no-comments"] !== true,
          });
          const sources = [result.document.source, result.comments?.source].filter((source): source is SourceRecord => Boolean(source));
          store.recordSourceIngestEvents(sources.map((source) => ({ id: source.id, payload: sourceEventPayload(source) })));
          const updated = updateCandidate(home, current.id, {
            status: "ingested",
            resolution: {
              sourceIds: sources.map((source) => source.id),
              commentSourceId: result.comments?.source.id,
              ingestedAt: new Date().toISOString(),
            },
            nextAction: "build Source Context and analyze; do not auto-promote to verified",
          });
          store.recordCandidateEvent(updated.id, "candidate.ingested", { candidate: updated, sourceIds: sources.map((source) => source.id), reason: "authorized automatic Citadel read" });
          results.push({
            candidateId: updated.id,
            contentId: result.contentId,
            status: updated.status,
            title: result.title,
            imported: result.document.imported || Boolean(result.comments?.imported),
            documentSourceId: result.document.source.id,
            commentSourceId: result.comments?.source.id ?? null,
            commentCount: result.comments?.count ?? 0,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const blocked = updateCandidate(home, current.id, {
            status: "blocked",
            reason: `automatic Citadel read failed: ${detail}`,
            nextAction: "retry after access, scope or document availability changes",
          });
          store.recordCandidateEvent(blocked.id, "candidate.blocked", { candidate: blocked, reason: "automatic Citadel read failed" });
          results.push({ candidateId: blocked.id, contentId: current.locator.contentId ?? null, status: blocked.status, error: detail });
        }
      }
      const rate = citadelRateLimit(store);
      printValue({
        scope: scope ?? "all",
        limit,
        delayMs,
        rateLimit: { max: CITADEL_RATE_LIMIT_MAX, windowMinutes: 30, used: rate.used, remaining: rate.remaining, resetAt: rate.resetAt },
        requested: requestedCandidates.length,
        discovered: results.length,
        remaining: Math.max(0, allCandidates.length - results.length),
        skippedByRateLimit: Math.max(0, requestedCandidates.length - results.length),
        ingested: results.filter((item) => item.status === "ingested").length,
        blocked: results.filter((item) => item.status === "blocked").length,
        results,
      }, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown candidate action: ${action ?? ""}`);
  }
}
