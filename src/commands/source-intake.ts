import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import { discoverHistoryCandidates, ingestHistory } from "../history.ts";
import { ingestCitadelDocument, ingestElephantHistory, searchCitadel, snapshotCitadelSearch } from "../external.ts";
import { importIncrementalRecords } from "../incremental.ts";
import { compactSourceRaw } from "../source-raw.ts";
import { addCandidate } from "../candidates.ts";
import { buildElephantPersonView, type PersonViewResult } from "../person.ts";
import {
  buildSourceContext,
  findSource,
  findSourceByOriginAndHash,
  hashSourceContent,
  importSource,
  listSources,
  makeSourceId,
  parseSourceRecords,
  readSourceRecords,
} from "../source.ts";
import type { SourceRecord } from "../types.ts";
import { citadelRateLimit, discoverCandidatesForSource, sourceEventPayload } from "./source-shared.ts";
import {
  type ParsedArgs,
  historyAdapterSelection,
  incrementalOption,
  optionalOption,
  outputFormat,
  requiredArg,
  requiredOption,
} from "./shared.ts";

export function handleSource(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "ingest": {
      const kind = requiredOption(parsed, "kind");
      assertValue(["elephant", "ai_conversation", "document", "review_comment", "artifact", "manual"].includes(kind), "--kind must be elephant, ai_conversation, document, review_comment, artifact, or manual");
      const sourcePath = requiredArg(args, 0, "source file");
      const adapter = optionalOption(parsed, "adapter");
      const scope = optionalOption(parsed, "scope");
      const sensitivity = optionalOption(parsed, "sensitivity");
      const incremental = incrementalOption(parsed);
      if (incremental) {
        const resolvedSourcePath = resolve(sourcePath);
        const content = readFileSync(resolvedSourcePath);
        const sourceId = makeSourceId();
        const records = parseSourceRecords(content.toString("utf8"), sourceId, kind, resolvedSourcePath);
        const result = importIncrementalRecords(home, resolvedSourcePath, content, {
          kind,
          adapter,
          title: optionalOption(parsed, "title"),
          scope,
          sensitivity,
          logicalKey: optionalOption(parsed, "source-key"),
        }, records);
        store.recordSourceEvent(result.logicalKey, "source.incremental_scan", result.state as unknown as Record<string, unknown>);
        if (!result.source) {
          printValue({ source: null, recordCount: 0, deltaCount: result.deltaCount, duplicateCount: result.duplicateCount, changedCount: result.changedCount, previousSourceIds: result.previousSourceIds, logicalKey: result.logicalKey, skipped: true, reason: result.reason, candidateDiscovery: null }, outputFormat(parsed));
          break;
        }
        store.recordSourceIngestEvents([{ id: result.source.id, payload: sourceEventPayload(result.source) }]);
        const candidateDiscovery = discoverCandidatesForSource(store, home, result.source.id);
        printValue({
          source: result.source,
          recordCount: result.recordCount,
          deltaCount: result.deltaCount,
          duplicateCount: result.duplicateCount,
          changedCount: result.changedCount,
          previousSourceIds: result.previousSourceIds,
          logicalKey: result.logicalKey,
          skipped: result.skipped,
          reason: result.reason,
          candidateDiscovery,
        }, outputFormat(parsed));
        break;
      }
      const existing = findSourceByOriginAndHash(home, sourcePath, hashSourceContent(readFileSync(resolve(sourcePath))), { adapter, scope, sensitivity });
      if (existing) {
        store.recordSourceIngestEvents([{ id: existing.id, payload: sourceEventPayload(existing) }]);
        const candidateDiscovery = discoverCandidatesForSource(store, home, existing.id);
        printValue({ source: existing, recordCount: existing.recordCount, recordIds: [], truncated: false, skipped: true, reason: "unchanged", candidateDiscovery }, outputFormat(parsed));
        break;
      }
      const result = importSource(home, sourcePath, {
        kind,
        adapter,
        title: optionalOption(parsed, "title"),
        scope,
        sensitivity,
      });
      store.recordSourceIngestEvents([{ id: result.source.id, payload: sourceEventPayload(result.source) }]);
      const candidateDiscovery = discoverCandidatesForSource(store, home, result.source.id);
      printValue({ source: result.source, recordCount: result.records.length, recordIds: result.records.slice(0, 20).map((record) => record.id), truncated: result.records.length > 20, candidateDiscovery }, outputFormat(parsed));
      break;
    }
    case "discover": {
      const adapter = historyAdapterSelection(optionalOption(parsed, "adapter"));
      const candidates = discoverHistoryCandidates(adapter, {
        root: optionalOption(parsed, "root"),
        scope: optionalOption(parsed, "scope"),
        sensitivity: optionalOption(parsed, "sensitivity"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : 100,
      });
      printValue(candidates, outputFormat(parsed));
      break;
    }
    case "ingest-history": {
      const adapter = historyAdapterSelection(optionalOption(parsed, "adapter"));
      const scan = ingestHistory(home, adapter, {
        root: optionalOption(parsed, "root"),
        scope: optionalOption(parsed, "scope") ?? "work",
        sensitivity: optionalOption(parsed, "sensitivity"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : 20,
        includeTools: parsed.options["include-tools"] === true,
        incremental: incrementalOption(parsed),
      });
      store.recordSourceEvent(scan.scanId, "source.history_scan", {
        adapter: scan.adapter,
        scope: scan.scope,
        includeTools: scan.includeTools,
        incremental: scan.incremental,
        discovered: scan.discovered,
        imported: scan.imported,
        skipped: scan.skipped,
        failed: scan.failed,
      });
      for (const result of scan.results) {
        if (result.incrementalState) store.recordSourceEvent(result.incrementalState.logicalKey, "source.incremental_scan", result.incrementalState as unknown as Record<string, unknown>);
      }
      store.recordSourceIngestEvents(scan.results.flatMap((result) => result.source ? [{ id: result.source.id, payload: sourceEventPayload(result.source) }] : []));
      const candidateDiscoveries = scan.results.flatMap((result) => result.source ? [discoverCandidatesForSource(store, home, result.source.id)] : []);
      printValue({
        ...scan,
        results: scan.results.map((result) => ({
          candidate: result.candidate,
          sourceId: result.source?.id ?? null,
          recordCount: result.recordCount,
          skipped: result.skipped,
          reason: result.reason,
          error: result.error,
          deltaCount: result.deltaCount,
          duplicateCount: result.duplicateCount,
          changedCount: result.changedCount,
          incrementalState: result.incrementalState,
        })),
        candidateDiscoveries,
      }, outputFormat(parsed));
      break;
    }
    case "ingest-citadel": {
      const contentId = requiredArg(args, 0, "Citadel content id");
      const rate = citadelRateLimit(store);
      assertValue(rate.remaining > 0, `Citadel rate limit reached: 10 reads per 30 minutes; retry after ${rate.resetAt ?? "the current window"}`);
      store.recordSourceEvent(`citadel:${contentId}`, "source.citadel_read_started", {
        adapter: "citadel",
        contentId,
        scope: optionalOption(parsed, "scope") ?? "work",
        reason: "explicit Citadel document read",
      });
      const result = ingestCitadelDocument(home, contentId, {
        scope: optionalOption(parsed, "scope"),
        sensitivity: optionalOption(parsed, "sensitivity"),
        includeComments: parsed.options["no-comments"] !== true,
        incremental: incrementalOption(parsed),
      });
      const sources = [result.document.source, result.comments?.source].filter((source): source is SourceRecord => Boolean(source));
      if (result.document.incremental) store.recordSourceEvent(result.document.incremental.logicalKey, "source.incremental_scan", result.document.incremental.state as unknown as Record<string, unknown>);
      if (result.comments?.incremental) store.recordSourceEvent(result.comments.incremental.logicalKey, "source.incremental_scan", result.comments.incremental.state as unknown as Record<string, unknown>);
      store.recordSourceIngestEvents(sources.map((source) => ({ id: source.id, payload: sourceEventPayload(source) })));
      const candidateDiscoveries = sources.map((source) => discoverCandidatesForSource(store, home, source.id));
      printValue({
        contentId: result.contentId,
        title: result.title,
        documentSourceId: result.document.source.id,
        documentImported: result.document.imported,
        commentSourceId: result.comments?.source.id ?? null,
        commentCount: result.comments?.count ?? 0,
        commentsImported: result.comments?.imported ?? false,
        metadata: result.metadata,
        candidateDiscoveries,
      }, outputFormat(parsed));
      break;
    }
    case "search-citadel": {
      const result = searchCitadel({
        keyword: requiredOption(parsed, "keyword"),
        searchTitle: parsed.options["search-title"] === true || parsed.options.searchTitle === true,
        offset: optionalOption(parsed, "offset") ? Number(parsed.options.offset) : undefined,
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
        spaceUrl: optionalOption(parsed, "space-url"),
        spaceId: optionalOption(parsed, "space-id"),
        parentUrls: optionalOption(parsed, "parent-urls"),
        parentIds: optionalOption(parsed, "parent-ids"),
      });
      const snapshot = snapshotCitadelSearch(home, result);
      store.recordSourceEvent(result.searchId, "source.citadel_search", {
        searchId: result.searchId,
        request: result.request,
        scope: optionalOption(parsed, "scope") ?? "work",
        sensitivity: optionalOption(parsed, "sensitivity") ?? (optionalOption(parsed, "scope") === "personal" ? "private" : "work-internal"),
        hitCount: result.hits.length,
        snapshotPath: snapshot.path,
        snapshotHash: snapshot.hash,
      });
      const enqueueResults = parsed.options.enqueue === true ? result.hits.map((hit) => addCandidate(home, {
          kind: "citadel_document",
          title: hit.title,
          scope: optionalOption(parsed, "scope") ?? "work",
          sensitivity: optionalOption(parsed, "sensitivity"),
          locator: { adapter: "citadel", contentId: hit.contentId, url: hit.url, query: result.request.keyword as string },
          origin: {
            sourceIds: optionalOption(parsed, "source-id") ? [String(parsed.options["source-id"])] : [],
            recordIds: optionalOption(parsed, "record-id") ? [String(parsed.options["record-id"])] : [],
            searchId: result.searchId,
            searchSnapshotPath: snapshot.path,
            searchSnapshotHash: snapshot.hash,
          },
          nextAction: "review candidate and queue before reading",
        })) : [];
      const enqueued = enqueueResults.map((item) => item.candidate);
      for (const item of enqueueResults) {
        if (item.created) store.recordCandidateEvent(item.candidate.id, "candidate.discovered", { candidate: item.candidate, reason: "citadel search result" });
        else if (item.changed) store.recordCandidateEvent(item.candidate.id, "candidate.updated", { candidate: item.candidate, reason: "citadel search result" });
      }
      printValue({ searchId: result.searchId, request: result.request, snapshot, hits: result.hits, enqueued }, outputFormat(parsed));
      break;
    }
    case "ingest-elephant": {
      const result = ingestElephantHistory(home, {
        uid: optionalOption(parsed, "uid"),
        gid: optionalOption(parsed, "gid"),
        pid: optionalOption(parsed, "pid"),
        name: optionalOption(parsed, "name"),
        mis: optionalOption(parsed, "mis"),
        type: optionalOption(parsed, "type"),
        keyword: optionalOption(parsed, "keyword"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        cursorMsg: optionalOption(parsed, "cursor-msg"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
        scope: optionalOption(parsed, "scope"),
        sensitivity: optionalOption(parsed, "sensitivity"),
        cdpUrl: optionalOption(parsed, "cdp-url"),
        incremental: incrementalOption(parsed),
      });
      if (result.source) {
        if (result.incremental) store.recordSourceEvent(result.incremental.logicalKey, "source.incremental_scan", result.incremental.state as unknown as Record<string, unknown>);
        store.recordSourceIngestEvents([{ id: result.source.id, payload: sourceEventPayload(result.source) }]);
        const candidateDiscovery = discoverCandidatesForSource(store, home, result.source.id);
        printValue({
          request: result.request,
          sourceId: result.source.id,
          imported: result.imported,
          skipped: result.skipped,
          reason: result.reason,
          recordCount: result.recordCount,
          candidateDiscovery,
        }, outputFormat(parsed));
        break;
      }
      printValue({
        request: result.request,
        sourceId: result.source?.id ?? null,
        imported: result.imported,
        skipped: result.skipped,
        reason: result.reason,
        recordCount: result.recordCount,
        deltaCount: result.deltaCount,
        duplicateCount: result.duplicateCount,
        changedCount: result.changedCount,
      }, outputFormat(parsed));
      break;
    }
    case "person": {
      const view = buildElephantPersonView(home, {
        name: optionalOption(parsed, "name"),
        uid: optionalOption(parsed, "uid"),
        mis: optionalOption(parsed, "mis"),
        sourceId: optionalOption(parsed, "source-id"),
        scope: optionalOption(parsed, "scope"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        contextWindow: optionalOption(parsed, "context-window") ? Number(parsed.options["context-window"]) : undefined,
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
      });
      if (outputFormat(parsed) === "json") printValue(view, "json");
      else printPersonView(view);
      break;
    }
    case "list":
      printValue(listSources(home, { includeQuarantined: parsed.options["include-quarantined"] === true }), outputFormat(parsed));
      break;
    case "show": {
      const id = requiredArg(args, 0, "source id");
      const source = findSource(home, id);
      assertValue(source, `Source not found: ${id}`);
      printValue({ source, records: readSourceRecords(home, id) }, outputFormat(parsed));
      break;
    }
    case "context": {
      const id = requiredArg(args, 0, "source id");
      const context = buildSourceContext(home, id, optionalOption(parsed, "limit") ? Number(parsed.options.limit) : 100);
      const runId = optionalOption(parsed, "run");
      if (runId) {
        const run = store.requireRun(runId);
        const contextPath = join(run.runDir, `source-${id}-context.md`);
        writeFileSync(contextPath, context.markdown, { mode: 0o600 });
        chmodSync(contextPath, 0o600);
        store.recordSourceEvent(id, "source.context_built", { runId, records: context.records.length });
      }
      printValue(context, outputFormat(parsed));
      break;
    }
    case "compact-raw": {
      const scope = optionalOption(parsed, "scope");
      assertValue(!scope || scope === "personal" || scope === "work", "--scope must be personal or work");
      printValue(compactSourceRaw(home, {
        scope: scope as "personal" | "work" | undefined,
        dryRun: parsed.options["dry-run"] === true,
      }), outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown source action: ${action ?? ""}`);
  }
}

function printPersonView(view: PersonViewResult): void {
  console.log(`Elephant person view: ${view.selector.kind}=${view.selector.value}`);
  console.log(`scope=${view.scope} sources=${view.sourceCount} scanned=${view.scannedRecordCount} matched=${view.matchedCount} duplicates=${view.duplicateCount}`);
  if (view.matches.length === 0) {
    console.log("(empty)");
    return;
  }
  for (const match of view.matches) {
    const record = match.record;
    console.log(`\n[${record.timestamp || "unknown"}] ${record.actor} · ${match.sourceId}`);
    console.log(record.content);
    if (view.contextWindow > 0) {
      console.log("Context:");
      for (const context of match.context) {
        const marker = context.id === record.id ? "*" : " ";
        console.log(`${marker} [${context.timestamp || "unknown"}] ${context.actor}: ${context.content.replaceAll("\n", "\\n")}`);
      }
    }
    console.log(`Refs: ${record.refs.join(", ") || "none"}`);
  }
}
