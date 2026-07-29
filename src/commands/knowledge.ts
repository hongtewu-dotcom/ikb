import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import {
  archiveRetiredKnowledge,
  buildContextPack,
  captureKnowledge,
  completeKnowledgeMigration,
  findKnowledge,
  ingestKnowledge,
  inspectKnowledgeQuality,
  listKnowledge,
  migrateLegacyKnowledge,
  rebuildKnowledgeViews,
  relateKnowledge,
  reviewKnowledge,
  searchKnowledge,
  updateKnowledgeStatus,
} from "../knowledge.ts";
import { addCandidate, candidateEventType, updateCandidate } from "../candidates.ts";
import { findSource, readSourceRecords } from "../source.ts";
import type {
  KnowledgeConfidence,
  KnowledgeRelationType,
  KnowledgeTemporalState,
  KnowledgeVerification,
  SourceRecord,
} from "../types.ts";
import {
  type ParsedArgs,
  optionalOption,
  outputFormat,
  requiredArg,
  requiredOption,
  requiredValue,
} from "./shared.ts";

export function handleReview(home: string, parsed: ParsedArgs): void {
  printValue(reviewKnowledge(home, optionalOption(parsed, "scope")), outputFormat(parsed));
}

export function handleCapture(store: LedgerStore, home: string, source: string | undefined, args: string[], parsed: ParsedArgs): void {
  const sourceValue = source ?? requiredOption(parsed, "content");
  const sourcePath = resolve(sourceValue);
  const fromFile = existsSync(sourcePath) && statSync(sourcePath).isFile();
  const body = fromFile ? readFileSync(sourcePath, "utf8") : sourceValue;
  const record = captureKnowledge(home, {
    title: requiredOption(parsed, "title"),
    body,
    type: optionalOption(parsed, "type"),
    collection: optionalOption(parsed, "collection"),
    sourceKind: optionalOption(parsed, "source-kind") ?? (fromFile ? "document" : "manual"),
    scope: optionalOption(parsed, "scope"),
    sensitivity: optionalOption(parsed, "sensitivity"),
    sourceRefs: fromFile
      ? [...new Set([sourcePath, ...splitOptionValues(optionalOption(parsed, "source"))])]
      : splitOptionValues(optionalOption(parsed, "source")),
    tags: optionalOption(parsed, "tags")?.split(",").filter(Boolean),
    qualityVersion: optionalOption(parsed, "quality-version") === undefined ? undefined : Number(optionalOption(parsed, "quality-version")),
    productType: optionalOption(parsed, "product-type"),
    compilationRef: optionalOption(parsed, "compilation-ref"),
    factRefs: splitOptionValues(optionalOption(parsed, "fact-refs")),
    questionsAnswered: splitOptionValues(optionalOption(parsed, "questions-answered")),
    admissionReason: optionalOption(parsed, "admission-reason"),
    applicability: optionalOption(parsed, "applicability"),
    boundary: optionalOption(parsed, "boundary"),
    useWhen: optionalOption(parsed, "use-when"),
    useInputs: splitOptionValues(optionalOption(parsed, "use-inputs")),
    useOutputs: splitOptionValues(optionalOption(parsed, "use-outputs")),
    useSteps: splitOptionValues(optionalOption(parsed, "use-steps")),
    useChecks: splitOptionValues(optionalOption(parsed, "use-checks")),
    useStopConditions: splitOptionValues(optionalOption(parsed, "use-stop-conditions")),
    confidence: optionalOption(parsed, "confidence") as KnowledgeConfidence | undefined,
    confidenceBasis: splitOptionValues(optionalOption(parsed, "confidence-basis")),
    temporalState: optionalOption(parsed, "temporal-state") as KnowledgeTemporalState | undefined,
    verification: optionalOption(parsed, "verification") as KnowledgeVerification | undefined,
    identityConfidence: optionalOption(parsed, "identity-confidence") as KnowledgeConfidence | undefined,
    patternConfidence: optionalOption(parsed, "pattern-confidence") as KnowledgeConfidence | undefined,
    independentEpisodeCount: optionalOption(parsed, "independent-episode-count") === undefined ? undefined : Number(optionalOption(parsed, "independent-episode-count")),
    independentSourceCount: optionalOption(parsed, "independent-source-count") === undefined ? undefined : Number(optionalOption(parsed, "independent-source-count")),
    distinctDateCount: optionalOption(parsed, "distinct-date-count") === undefined ? undefined : Number(optionalOption(parsed, "distinct-date-count")),
    counterevidenceRefs: splitOptionValues(optionalOption(parsed, "counterevidence-refs")),
    counterevidenceSearch: optionalOption(parsed, "counterevidence-search"),
    doNotUseFor: splitOptionValues(optionalOption(parsed, "do-not-use-for")),
  });
  store.recordKnowledgeEvent(record.id, "knowledge.created", knowledgeEventPayload(record));
  printValue(record, outputFormat(parsed));
}

export function handleIngest(store: LedgerStore, home: string, source: string | undefined, parsed: ParsedArgs): void {
  const record = ingestKnowledge(home, requiredValue(source, "markdown source"), {
    scope: optionalOption(parsed, "scope"),
    title: optionalOption(parsed, "title"),
    sourceKind: optionalOption(parsed, "source-kind"),
    collection: optionalOption(parsed, "collection"),
    admissionReason: optionalOption(parsed, "admission-reason"),
    applicability: optionalOption(parsed, "applicability"),
    boundary: optionalOption(parsed, "boundary"),
  });
  store.recordKnowledgeEvent(record.id, "knowledge.created", knowledgeEventPayload(record));
  printValue(record, outputFormat(parsed));
}

export function handleSearch(home: string, query: string, parsed: ParsedArgs): void {
  assertValue(query, "Usage: ikb search <query>");
  printValue(searchKnowledge(home, query, { scope: optionalOption(parsed, "scope"), status: optionalOption(parsed, "status"), limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined }), outputFormat(parsed));
}

export function handleContext(store: LedgerStore, home: string, taskId: string | undefined, parsed: ParsedArgs): void {
  const task = store.requireTask(requiredValue(taskId, "task id"));
  const includeDrafts = parsed.options["verified-only"] !== true;
  const context = buildContextPack(home, { taskId: task.id, title: task.title, goal: task.goal, acceptance: task.acceptance, scope: optionalOption(parsed, "scope"), limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined, includeDrafts });
  const runId = optionalOption(parsed, "run");
  if (runId) {
    const run = store.requireRun(runId);
    assertValue(run.taskId === task.id, `Run ${runId} does not belong to Task ${task.id}`);
    const contextPath = join(run.runDir, "context-pack.md");
    writeFileSync(contextPath, context.markdown, { mode: 0o600 });
    chmodSync(contextPath, 0o600);
    for (const result of context.results) {
      store.recordKnowledgeEvent(result.id, "knowledge.referenced", {
        taskId: task.id,
        runId: run.id,
        status: result.status,
        verification: result.status === "verified" ? "trusted" : "advisory",
        path: result.path,
        query: context.query,
      });
    }
  }
  printValue(context, outputFormat(parsed));
}

export function handleKnowledge(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "list":
      printValue(listKnowledge(home, optionalOption(parsed, "scope")).filter((record) => !optionalOption(parsed, "status") || record.status === optionalOption(parsed, "status")), outputFormat(parsed));
      break;
    case "show": {
      const record = findKnowledge(home, requiredArg(args, 0, "knowledge id"));
      assertValue(record, `Knowledge not found: ${args[0]}`);
      printValue(record, outputFormat(parsed));
      break;
    }
    case "verify":
      printValue(verifyKnowledge(store, home, requiredArg(args, 0, "knowledge id")), outputFormat(parsed));
      break;
    case "retire":
      printValue(retireKnowledge(store, home, requiredArg(args, 0, "knowledge id")), outputFormat(parsed));
      break;
    case "archive": {
      const result = archiveRetiredKnowledge(home, optionalOption(parsed, "scope"));
      for (const scopeResult of result) {
        for (const item of scopeResult.archived) {
          store.recordKnowledgeEvent(item.id, "knowledge.archived", {
            scope: scopeResult.scope,
            title: item.title,
            from: item.from,
            to: item.to,
            manifestPath: scopeResult.manifestPath,
          });
        }
      }
      printValue(result, outputFormat(parsed));
      break;
    }
    case "review":
      printValue(reviewKnowledge(home, optionalOption(parsed, "scope")), outputFormat(parsed));
      break;
    case "feedback": {
      const knowledgeId = requiredArg(args, 0, "knowledge id");
      const record = findKnowledge(home, knowledgeId);
      assertValue(record, `Knowledge not found: ${knowledgeId}`);
      const runId = requiredOption(parsed, "run");
      const run = store.requireRun(runId);
      const task = store.requireTask(run.taskId);
      assertValue(record.scope === task.scope, `Knowledge scope ${record.scope} does not match Task scope ${task.scope}`);
      const outcome = requiredOption(parsed, "outcome");
      assertValue(["helpful", "partial", "incorrect", "unused"].includes(outcome), "--outcome must be helpful, partial, incorrect, or unused");
      const reasonCode = requiredOption(parsed, "reason-code").trim();
      assertValue(reasonCode, "--reason-code must not be empty");
      const event = store.recordKnowledgeEvent(record.id, "knowledge.feedback_recorded", {
        taskId: task.id,
        runId: run.id,
        outcome,
        reasonCode,
        note: optionalOption(parsed, "note") ?? null,
        evidenceRefs: splitOptionValues(optionalOption(parsed, "evidence")),
        knowledgeStatus: record.status,
        knowledgeVerification: record.verification ?? "unverified",
      });
      printValue({ knowledgeId: record.id, runId: run.id, outcome, reasonCode, eventId: event.eventId }, outputFormat(parsed));
      break;
    }
    case "lint": {
      const id = args[0];
      const records = id
        ? [findKnowledge(home, id)].filter(Boolean)
        : listKnowledge(home, optionalOption(parsed, "scope")).filter((record) => !optionalOption(parsed, "status") || record.status === optionalOption(parsed, "status"));
      if (id) assertValue(records.length === 1, `Knowledge not found: ${id}`);
      const results = records.map((record) => ({ knowledgeId: record!.id, path: record!.path, issues: inspectKnowledgeQuality(record!) }));
      const result = { ok: results.every((item) => item.issues.length === 0), checked: results.length, results };
      printValue(result, outputFormat(parsed));
      if (!result.ok) process.exitCode = 2;
      break;
    }
    case "skip": {
      const title = requiredOption(parsed, "title").trim();
      const reason = requiredOption(parsed, "reason").trim();
      assertValue(title, "knowledge skip requires a non-empty --title");
      assertValue(reason, "knowledge skip requires a non-empty --reason");
      const sourceIds = splitOptionValues(optionalOption(parsed, "source-id"));
      const recordIds = splitOptionValues(optionalOption(parsed, "record-id"));
      assertValue(sourceIds.length > 0 || recordIds.length > 0, "knowledge skip requires --source-id or --record-id evidence");
      const evidenceSources = new Map<string, SourceRecord>();
      for (const sourceId of sourceIds) {
        const source = findSource(home, sourceId);
        assertValue(source, `Source not found: ${sourceId}`);
        evidenceSources.set(sourceId, source);
      }
      for (const recordId of recordIds) {
        const sourceId = recordId.split(":")[0];
        const source = findSource(home, sourceId);
        assertValue(source, `Source for record not found: ${recordId}`);
        assertValue(readSourceRecords(home, sourceId, { verifyRaw: false }).some((record) => record.id === recordId), `Source record not found: ${recordId}`);
        evidenceSources.set(sourceId, source);
      }
      const normalizedSourceIds = [...evidenceSources.keys()].sort();
      const normalizedRecordIds = [...new Set(recordIds)].sort();
      const sourceScopes = [...new Set([...evidenceSources.values()].map((source) => source.scope))];
      assertValue(sourceScopes.length === 1, `knowledge skip evidence must use one scope, found: ${sourceScopes.join(", ")}`);
      const requestedScope = optionalOption(parsed, "scope");
      assertValue(!requestedScope || requestedScope === sourceScopes[0], `knowledge skip scope ${requestedScope} does not match evidence scope ${sourceScopes[0]}`);
      const scope = requestedScope ?? sourceScopes[0];
      const query = `knowledge-skip:${createHash("sha256").update(JSON.stringify({ title, sourceIds: normalizedSourceIds, recordIds: normalizedRecordIds })).digest("hex")}`;
      let result = addCandidate(home, {
        kind: "knowledge",
        title,
        scope,
        sensitivity: optionalOption(parsed, "sensitivity"),
        locator: { adapter: "ikb-curator", query },
        origin: { sourceIds: normalizedSourceIds, recordIds: normalizedRecordIds },
        status: "rejected",
        reason,
        nextAction: null,
      });
      if (result.candidate.reason !== reason) {
        const candidate = updateCandidate(home, result.candidate.id, { reason });
        result = { candidate, created: result.created, changed: true };
      }
      if (result.created || result.changed) store.recordCandidateEvent(result.candidate.id, candidateEventType(result.candidate.status, result.created), { candidate: result.candidate, reason: "no durable knowledge admitted" });
      printValue({ decision: "skip", knowledge: null, candidate: result.candidate, created: result.created, changed: result.changed }, outputFormat(parsed));
      break;
    }
    case "rebuild":
      printValue(rebuildKnowledgeViews(home, optionalOption(parsed, "scope")), outputFormat(parsed));
      break;
    case "migrate": {
      const result = migrateLegacyKnowledge(home, optionalOption(parsed, "scope"), { deferCompletion: true });
      store.recordKnowledgeMigrationEvents(result.moved.map((item) => ({ id: item.id, payload: { scope: item.scope, type: item.type, collection: item.collection, from: item.from, to: item.to } })));
      if (result.journalPath) completeKnowledgeMigration(result.journalPath);
      printValue(result, outputFormat(parsed));
      break;
    }
    case "relate": {
      const relationType = requiredOption(parsed, "type");
      assertValue(["related", "derived_from", "contradicts"].includes(relationType), "--type must be related, derived_from, or contradicts");
      const result = relateKnowledge(
        home,
        requiredArg(args, 0, "source knowledge id"),
        requiredArg(args, 1, "target knowledge id"),
        relationType as KnowledgeRelationType,
        { allowCrossScope: parsed.options["allow-cross-scope"] === true },
      );
      if (result.changed) {
        const relationPayload = (sourceId: string, targetId: string) => ({
          relationType: result.relationType,
          sourceId,
          targetId,
          reciprocal: result.reciprocal,
          sourcePath: result.source.path,
          targetPath: result.target.path,
        });
        store.recordKnowledgeEvent(result.source.id, "knowledge.related", relationPayload(result.source.id, result.target.id));
        if (result.reciprocal) store.recordKnowledgeEvent(result.target.id, "knowledge.related", relationPayload(result.target.id, result.source.id));
      }
      printValue(result, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown knowledge action: ${action ?? ""}`);
  }
}

function verifyKnowledge(store: LedgerStore, home: string, id: string) {
  const record = updateKnowledgeStatus(home, id, "verified");
  store.recordKnowledgeEvent(record.id, "knowledge.verified", knowledgeEventPayload(record));
  return record;
}

function retireKnowledge(store: LedgerStore, home: string, id: string) {
  const record = updateKnowledgeStatus(home, id, "retired");
  store.recordKnowledgeEvent(record.id, "knowledge.retired", knowledgeEventPayload(record));
  return record;
}

function knowledgeEventPayload(record: { path: string; title: string; type: string; collection: string; sourceKind: string; scope: string; status: string; sourceRefs: string[]; validFrom: string; reviewAfter: string; tags: string[]; aliases: string[]; related: string[]; derivedFrom: string[]; contradicts: string[]; qualityVersion: number; productType?: string; compilationRef?: string; factRefs?: string[]; questionsAnswered?: string[]; admissionReason: string; applicability: string; boundary: string; useWhen?: string; useInputs?: string[]; useOutputs?: string[]; useSteps?: string[]; useChecks?: string[]; useStopConditions?: string[]; confidence?: string; confidenceBasis?: string[]; temporalState?: string; verification?: string; identityConfidence?: string; patternConfidence?: string; independentEpisodeCount?: number; independentSourceCount?: number; distinctDateCount?: number; counterevidenceRefs?: string[]; counterevidenceSearch?: string; doNotUseFor?: string[] }): Record<string, unknown> {
  return {
    path: record.path,
    title: record.title,
    type: record.type,
    collection: record.collection,
    sourceKind: record.sourceKind,
    scope: record.scope,
    status: record.status,
    sourceRefs: record.sourceRefs,
    validFrom: record.validFrom,
    reviewAfter: record.reviewAfter,
    tags: record.tags,
    aliases: record.aliases,
    related: record.related,
    derivedFrom: record.derivedFrom,
    contradicts: record.contradicts,
    qualityVersion: record.qualityVersion,
    productType: record.productType,
    compilationRef: record.compilationRef,
    factRefs: record.factRefs ?? [],
    questionsAnswered: record.questionsAnswered ?? [],
    admissionReason: record.admissionReason,
    applicability: record.applicability,
    boundary: record.boundary,
    useWhen: record.useWhen,
    useInputs: record.useInputs ?? [],
    useOutputs: record.useOutputs ?? [],
    useSteps: record.useSteps ?? [],
    useChecks: record.useChecks ?? [],
    useStopConditions: record.useStopConditions ?? [],
    confidence: record.confidence ?? "medium",
    confidenceBasis: record.confidenceBasis ?? [],
    temporalState: record.temporalState ?? "unknown",
    verification: record.verification ?? (record.status === "verified" ? "source_confirmed" : "unverified"),
    identityConfidence: record.identityConfidence,
    patternConfidence: record.patternConfidence,
    independentEpisodeCount: record.independentEpisodeCount,
    independentSourceCount: record.independentSourceCount,
    distinctDateCount: record.distinctDateCount,
    counterevidenceRefs: record.counterevidenceRefs ?? [],
    counterevidenceSearch: record.counterevidenceSearch,
    doNotUseFor: record.doNotUseFor ?? [],
  };
}

function splitOptionValues(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}
