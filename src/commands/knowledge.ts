import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import {
  archiveRetiredKnowledge,
  applyKnowledgeCandidate,
  applyPreparedKnowledgeRevision,
  applyQv5KnowledgeRevisionBatch,
  applyReviewedQv5KnowledgeRevision,
  buildContextPack,
  captureKnowledge,
  completeKnowledgeMigration,
  findKnowledge,
  ingestKnowledge,
  inspectKnowledgeQuality,
  inspectPrincipleConfirmation,
  parseQv5KnowledgeRevisionBatchPlan,
  findKnowledgeRevision,
  listKnowledge,
  listKnowledgeRevisions,
  migrateLegacyKnowledge,
  rebuildKnowledgeViews,
  relateKnowledge,
  reviewKnowledge,
  requestKnowledgeCorrection,
  requestPrincipleAdmission,
  resolveQv5KnowledgeCorrectionHold,
  searchKnowledge,
  updateKnowledgeStatus,
  checkPrincipleProjections,
  writePrincipleProjectionReport,
} from "../knowledge.ts";
import {
  inspectMemoryTopicMigration,
  migrateMemoryTopicBatch,
  reviseMemoryTopicBatch,
  writeMemoryTopicMigrationReport,
} from "../memory-topic-migration.ts";
import { addCandidate, candidateEventType, updateCandidate } from "../candidates.ts";
import {
  buildKnowledgeUsageStatus,
  KNOWLEDGE_USAGE_CONTRACT_VERSION,
  KNOWLEDGE_USE_PURPOSES,
  knowledgeEventsForRun,
  requireIntegrityCheckedRunArtifact,
  retrySuppressedKnowledgeIds,
} from "../knowledge-usage.ts";
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
  optionalBoundedInteger,
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
    canonicalKey: optionalOption(parsed, "canonical-key"),
    compilationSchema: optionalOption(parsed, "compilation-schema"),
    compilationCaseId: optionalOption(parsed, "compilation-case-id"),
    compilationProductId: optionalOption(parsed, "compilation-product-id"),
    extractionManifestRef: optionalOption(parsed, "extraction-manifest-ref"),
    compilationRef: optionalOption(parsed, "compilation-ref"),
    informationLossRef: optionalOption(parsed, "information-loss-ref"),
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

export function handleSearch(store: LedgerStore, home: string, query: string, parsed: ParsedArgs): void {
  assertValue(query, "Usage: ikb search <query>");
  const scope = optionalOption(parsed, "scope");
  const status = optionalOption(parsed, "status");
  const limit = optionalBoundedInteger(parsed, "limit", 1, 50);
  const results = searchKnowledge(home, query, { scope, status, limit });
  store.recordKnowledgeQueryEvent({
    contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
    mode: "search",
    query,
    queryHash: createHash("sha256").update(query).digest("hex"),
    scope: scope ?? "all",
    statusFilter: status ?? "verified,draft",
    limit: limit ?? 20,
    taskId: null,
    runId: null,
    contextArtifactId: null,
    resultCount: results.length,
    zeroResult: results.length === 0,
    results: results.map((result) => ({ knowledgeId: result.id, status: result.status, score: result.score })),
  });
  printValue(results, outputFormat(parsed));
}

export function buildContextCommandResult(store: LedgerStore, home: string, taskId: string | undefined, parsed: ParsedArgs): Record<string, unknown> {
  const task = store.requireTask(requiredValue(taskId, "task id"));
  assertValue(task.scope === "personal" || task.scope === "work", `Task ${task.id} has unsupported scope ${task.scope}`);
  const requestedScope = optionalOption(parsed, "scope");
  assertValue(!requestedScope || requestedScope === task.scope, `Context scope ${requestedScope} does not match Task scope ${task.scope}`);
  const includeDrafts = parsed.options["verified-only"] !== true;
  const runId = optionalOption(parsed, "run");
  const run = runId ? store.requireRun(runId) : null;
  if (run) assertValue(run.taskId === task.id, `Run ${runId} does not belong to Task ${task.id}`);
  const suppressedKnowledgeIds = run ? retrySuppressedKnowledgeIds(store, run.id) : [];
  const context = buildContextPack(home, {
    taskId: task.id,
    taskType: task.type,
    title: task.title,
    goal: task.goal,
    acceptance: task.acceptance,
    scope: task.scope,
    limit: optionalBoundedInteger(parsed, "limit", 1, 50),
    includeDrafts,
    suppressedKnowledgeIds,
  });
  let contextArtifact = null;
  let queryEvent = null;
  if (run) {
    const contextHash = createHash("sha256").update(context.markdown).digest("hex");
    const immutableContextPath = join(run.runDir, `context-pack-${contextHash.slice(0, 16)}.md`);
    if (existsSync(immutableContextPath)) {
      assertValue(readFileSync(immutableContextPath, "utf8") === context.markdown, `Immutable Context Pack hash collision: ${immutableContextPath}`);
    } else {
      writeFileSync(immutableContextPath, context.markdown, { mode: 0o600 });
      chmodSync(immutableContextPath, 0o600);
    }
    const contextPath = join(run.runDir, "context-pack.md");
    writeFileSync(contextPath, context.markdown, { mode: 0o600 });
    chmodSync(contextPath, 0o600);
    contextArtifact = store.listArtifacts({ runId: run.id })
      .find((artifact) => artifact.kind === "context-pack" && artifact.contentHash === contextHash)
      ?? store.createArtifact({ runId: run.id, kind: "context-pack", label: `Context Pack：${task.title}`, path: immutableContextPath });
    const contextArtifactLinked = store.listEvents().some((event) => event.aggregateType === "run"
      && event.aggregateId === run.id
      && event.eventType === "run.artifact_linked"
      && event.payload.artifactId === contextArtifact.id
      && event.payload.relation === "produced");
    if (!contextArtifactLinked) {
      store.recordHarnessEvent(run.id, "run.artifact_linked", {
        artifactId: contextArtifact.id,
        relation: "produced",
        lineageRefs: [`run://${run.id}`],
      });
    }
    queryEvent = store.recordKnowledgeQueryEvent({
      contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
      mode: "context",
      query: context.query,
      queryHash: createHash("sha256").update(context.query).digest("hex"),
      scope: task.scope,
      statusFilter: includeDrafts ? "verified,draft" : "verified",
      limit: optionalBoundedInteger(parsed, "limit", 1, 50) ?? 8,
      taskId: task.id,
      runId: run.id,
      contextArtifactId: contextArtifact.id,
      resultCount: context.results.length,
      zeroResult: context.results.length === 0,
      retrieval: context.retrieval,
      results: context.results.map((result) => ({ knowledgeId: result.id, status: result.status, score: result.score })),
      units: context.units.map((unit) => ({ unitId: unit.unitId, knowledgeId: unit.knowledgeId, kind: unit.kind, score: unit.score, truncated: unit.truncated === true })),
    });
    for (const result of context.results) {
      const selectedUnits = context.units.filter((unit) => unit.knowledgeId === result.id);
      const alreadyReferenced = store.listEvents().some((event) => event.aggregateType === "knowledge"
        && event.aggregateId === result.id
        && event.eventType === "knowledge.referenced"
        && event.payload.runId === run.id
        && event.payload.contextHash === contextHash);
      if (alreadyReferenced) continue;
      store.recordKnowledgeEvent(result.id, "knowledge.referenced", {
        contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
        taskId: task.id,
        runId: run.id,
        contextArtifactId: contextArtifact.id,
        contextHash,
        queryId: queryEvent.aggregateId,
        queryEventId: queryEvent.eventId,
        status: result.status,
        verification: result.status === "verified" ? "trusted" : "advisory",
        path: result.path,
        query: context.query,
        selectedUnitIds: selectedUnits.map((unit) => unit.unitId),
        selectedUnitKinds: [...new Set(selectedUnits.map((unit) => unit.kind))],
      });
    }
  } else {
    queryEvent = store.recordKnowledgeQueryEvent({
      contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
      mode: "context",
      query: context.query,
      queryHash: createHash("sha256").update(context.query).digest("hex"),
      scope: task.scope,
      statusFilter: includeDrafts ? "verified,draft" : "verified",
      limit: optionalBoundedInteger(parsed, "limit", 1, 50) ?? 8,
      taskId: task.id,
      runId: null,
      contextArtifactId: null,
      resultCount: context.results.length,
      zeroResult: context.results.length === 0,
      retrieval: context.retrieval,
      results: context.results.map((result) => ({ knowledgeId: result.id, status: result.status, score: result.score })),
      units: context.units.map((unit) => ({ unitId: unit.unitId, knowledgeId: unit.knowledgeId, kind: unit.kind, score: unit.score, truncated: unit.truncated === true })),
    });
  }
  const format = outputFormat(parsed);
  const output = format === "json"
    ? {
      taskId: context.taskId,
      query: context.query,
      questions: context.questions,
      results: context.results.map(({ id, title, type, collection, scope, status, score }) => ({ id, title, type, collection, scope, status, score })),
      units: context.units.map(({ unitId, knowledgeId, kind, score, truncated }) => ({ unitId, knowledgeId, kind, score, truncated })),
      retrieval: { ...context.retrieval, priorFeedbackExcludedIds: suppressedKnowledgeIds },
      markdown: context.markdown,
      contextArtifact,
      queryId: queryEvent.aggregateId,
      queryEventId: queryEvent.eventId,
    }
    : { ...context, contextArtifact, queryId: queryEvent.aggregateId, queryEventId: queryEvent.eventId };
  return output;
}

export function handleContext(store: LedgerStore, home: string, taskId: string | undefined, parsed: ParsedArgs): void {
  printValue(buildContextCommandResult(store, home, taskId, parsed), outputFormat(parsed));
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
      const reviewFinding = optionalOption(parsed, "review-finding")?.trim();
      const note = optionalOption(parsed, "note");
      if (reviewFinding !== undefined) {
        assertValue(reviewFinding === "incorrect", "--review-finding must be incorrect");
        assertValue(outcome === "unused", "--review-finding incorrect requires --outcome unused");
        assertValue(Boolean(note?.trim()), "--review-finding incorrect requires a non-empty --note");
      }
      const events = store.listEvents();
      const references = knowledgeEventsForRun(events, run.id, "knowledge.referenced", record.id);
      assertValue(references.length > 0, `Knowledge ${record.id} was not referenced by Run ${run.id}`);
      const existingFeedback = knowledgeEventsForRun(events, run.id, "knowledge.feedback_recorded", record.id);
      if (existingFeedback.length === 0) {
        const uses = knowledgeEventsForRun(events, run.id, "knowledge.used", record.id);
        if (outcome === "unused") assertValue(uses.length === 0, `unused Knowledge feedback is invalid because ${record.id} was actually used by Run ${run.id}`);
        else assertValue(uses.length > 0, `${outcome} Knowledge feedback requires a prior knowledge use in Run ${run.id}`);
      }
      let evidenceRefs = splitOptionValues(optionalOption(parsed, "evidence"));
      assertValue(evidenceRefs.length > 0, `${outcome} Knowledge feedback requires at least one --evidence Artifact from the same Run`);
      evidenceRefs = evidenceRefs.map((reference) => requireIntegrityCheckedRunArtifact(store, run.id, reference, "Knowledge feedback").id);
      const event = store.recordKnowledgeFeedbackEvent(record.id, {
        contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
        taskId: task.id,
        runId: run.id,
        outcome,
        reasonCode,
        note: note ?? null,
        evidenceRefs,
        knowledgeStatus: record.status,
        knowledgeVerification: record.verification ?? "unverified",
        ...(reviewFinding === undefined ? {} : { reviewFinding }),
      });
      printValue({ knowledgeId: record.id, runId: run.id, outcome, reasonCode, ...(reviewFinding === undefined ? {} : { reviewFinding }), eventId: event.eventId }, outputFormat(parsed));
      break;
    }
    case "use": {
      const knowledgeId = requiredArg(args, 0, "knowledge id");
      const record = findKnowledge(home, knowledgeId);
      assertValue(record, `Knowledge not found: ${knowledgeId}`);
      const runId = requiredOption(parsed, "run");
      const run = store.requireRun(runId);
      const task = store.requireTask(run.taskId);
      assertValue(record.scope === task.scope, `Knowledge scope ${record.scope} does not match Task scope ${task.scope}`);
      const purpose = requiredOption(parsed, "purpose");
      assertValue(KNOWLEDGE_USE_PURPOSES.includes(purpose as typeof KNOWLEDGE_USE_PURPOSES[number]), `--purpose must be ${KNOWLEDGE_USE_PURPOSES.join(", ")}`);
      const note = requiredOption(parsed, "note").trim();
      assertValue(note.length > 0 && note.length <= 1000, "--note must be a non-empty explanation of at most 1000 characters");
      const artifact = requireIntegrityCheckedRunArtifact(store, run.id, requiredOption(parsed, "artifact"), "Knowledge use");
      const references = knowledgeEventsForRun(store.listEvents(), run.id, "knowledge.referenced", record.id);
      assertValue(references.length > 0, `Knowledge ${record.id} was not referenced by Run ${run.id}`);
      const reference = references.at(-1)!;
      const event = store.recordKnowledgeUsageEvent(record.id, {
        contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
        taskId: task.id,
        runId: run.id,
        artifactId: artifact.id,
        artifactHash: artifact.contentHash,
        purpose,
        note,
        referenceEventId: reference.eventId,
        queryId: reference.payload.queryId ?? null,
        contextArtifactId: reference.payload.contextArtifactId ?? null,
        knowledgeStatus: record.status,
        knowledgeVerification: record.verification ?? "unverified",
      });
      printValue({ knowledgeId: record.id, runId: run.id, artifactId: artifact.id, purpose, eventId: event.eventId }, outputFormat(parsed));
      break;
    }
    case "usage-status":
      printValue(buildKnowledgeUsageStatus(store, requiredOption(parsed, "run")), outputFormat(parsed));
      break;
    case "correction-request": {
      const knowledgeId = requiredArg(args, 0, "knowledge id");
      printValue(requestKnowledgeCorrection(home, store, {
        knowledgeId,
        runId: requiredOption(parsed, "run"),
        artifactId: requiredOption(parsed, "artifact"),
        action: requiredOption(parsed, "action") as "revise" | "retire",
        reason: requiredOption(parsed, "reason"),
      }), outputFormat(parsed));
      break;
    }
    case "principle-request": {
      printValue(requestPrincipleAdmission(home, store, {
        runId: requiredOption(parsed, "run"),
        manifestArtifactId: requiredOption(parsed, "manifest-artifact"),
        compilationArtifactId: requiredOption(parsed, "compilation-artifact"),
        fidelityArtifactId: requiredOption(parsed, "fidelity-artifact"),
        caseId: requiredOption(parsed, "case"),
        productId: requiredOption(parsed, "product"),
      }), outputFormat(parsed));
      break;
    }
    case "principle-projection-check": {
      const result = checkPrincipleProjections(home, requiredOption(parsed, "manifest"));
      const paths = parsed.options.write === true ? writePrincipleProjectionReport(home, result) : null;
      printValue({ ...result, paths }, outputFormat(parsed));
      if (!result.ok) process.exitCode = 2;
      break;
    }
    case "apply-candidate": {
      const candidateId = requiredArg(args, 0, "experience candidate id");
      printValue(applyKnowledgeCandidate(home, store, candidateId, {
        replacementPath: optionalOption(parsed, "file"),
        primaryKnowledgeId: optionalOption(parsed, "primary"),
      }), outputFormat(parsed));
      break;
    }
    case "revision-list":
      printValue(listKnowledgeRevisions(home), outputFormat(parsed));
      break;
    case "revision-show": {
      const id = requiredArg(args, 0, "knowledge revision id");
      const revision = findKnowledgeRevision(home, id);
      assertValue(revision, `Knowledge revision not found: ${id}`);
      printValue(revision, outputFormat(parsed));
      break;
    }
    case "revision-recover":
      printValue(applyPreparedKnowledgeRevision(home, store, requiredArg(args, 0, "knowledge revision id")), outputFormat(parsed));
      break;
    case "qv5-revise": {
      const knowledgeId = requiredArg(args, 0, "knowledge id");
      printValue(applyReviewedQv5KnowledgeRevision(home, store, {
        knowledgeId,
        replacementArtifactId: requiredOption(parsed, "replacement-artifact"),
        validationArtifactId: requiredOption(parsed, "validation-artifact"),
        manifestArtifactId: requiredOption(parsed, "manifest-artifact"),
        compilationArtifactId: requiredOption(parsed, "compilation-artifact"),
        fidelityArtifactId: requiredOption(parsed, "fidelity-artifact"),
      }), outputFormat(parsed));
      break;
    }
    case "qv5-resolve-hold": {
      const candidateId = requiredArg(args, 0, "experience candidate id");
      printValue(resolveQv5KnowledgeCorrectionHold(home, store, {
        candidateId,
        revisionId: requiredOption(parsed, "revision"),
      }), outputFormat(parsed));
      break;
    }
    case "qv5-batch": {
      const planPath = resolve(requiredOption(parsed, "plan"));
      assertValue(existsSync(planPath) && statSync(planPath).isFile(), `QV5 batch plan must be a file: ${planPath}`);
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(planPath, "utf8")); } catch { throw new Error(`QV5 batch plan is not valid JSON: ${planPath}`); }
      printValue(applyQv5KnowledgeRevisionBatch(home, store, parseQv5KnowledgeRevisionBatchPlan(raw), {
        dryRun: parsed.options["dry-run"] === true,
        resume: parsed.options.resume === true,
        limit: optionalBoundedInteger(parsed, "limit", 1, 500),
      }), outputFormat(parsed));
      break;
    }
    case "memory-topic-audit": {
      const report = inspectMemoryTopicMigration(home, requiredOption(parsed, "index"));
      const paths = parsed.options.write === true ? writeMemoryTopicMigrationReport(home, report) : null;
      const attention = report.entries.filter((entry) => !["ready", "current"].includes(entry.status));
      printValue({ ok: attention.length === 0, ...report, paths }, outputFormat(parsed));
      if (attention.length > 0) process.exitCode = 2;
      break;
    }
    case "memory-topic-sync": {
      const result = migrateMemoryTopicBatch(home, store, {
        indexPath: requiredOption(parsed, "index"),
        runId: requiredOption(parsed, "run"),
        offset: optionalBoundedInteger(parsed, "offset", 0, 100_000),
        limit: optionalBoundedInteger(parsed, "limit", 1, 3),
      });
      for (const record of result.created) store.recordKnowledgeEvent(record.id, "knowledge.created", knowledgeEventPayload(record));
      printValue(result, outputFormat(parsed));
      if (result.disposition === "needs_review") process.exitCode = 2;
      break;
    }
    case "memory-topic-revise": {
      const result = reviseMemoryTopicBatch(home, store, {
        indexPath: requiredOption(parsed, "index"),
        analystRunId: requiredOption(parsed, "analyst-run"),
        curatorRunId: requiredOption(parsed, "curator-run"),
        offset: optionalBoundedInteger(parsed, "offset", 0, 100_000),
        limit: optionalBoundedInteger(parsed, "limit", 1, 3),
      });
      printValue(result, outputFormat(parsed));
      if (result.disposition === "needs_review") process.exitCode = 2;
      break;
    }
    case "lint": {
      const id = args[0];
      const records = id
        ? [findKnowledge(home, id)].filter(Boolean)
        : listKnowledge(home, optionalOption(parsed, "scope")).filter((record) => !optionalOption(parsed, "status") || record.status === optionalOption(parsed, "status"));
      if (id) assertValue(records.length === 1, `Knowledge not found: ${id}`);
      const results = records.map((record) => {
        const issues = inspectKnowledgeQuality(record!);
        if (record!.status === "verified") {
          const problem = inspectPrincipleConfirmation(home, record!, "retrieval");
          if (problem) issues.push({ knowledgeId: record!.id, path: record!.path, code: problem.code, detail: problem.detail });
        }
        return { knowledgeId: record!.id, path: record!.path, issues };
      });
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

function knowledgeEventPayload(record: { path: string; title: string; type: string; collection: string; sourceKind: string; scope: string; status: string; revision: number; revisionHistory: string[]; supersededBy?: string; sourceRefs: string[]; validFrom: string; reviewAfter: string; tags: string[]; aliases: string[]; related: string[]; derivedFrom: string[]; contradicts: string[]; qualityVersion: number; productType?: string; canonicalKey?: string; compilationSchema?: string; compilationCaseId?: string; compilationProductId?: string; extractionManifestRef?: string; compilationRef?: string; informationLossRef?: string; factRefs?: string[]; questionsAnswered?: string[]; admissionReason: string; applicability: string; boundary: string; useWhen?: string; useInputs?: string[]; useOutputs?: string[]; useSteps?: string[]; useChecks?: string[]; useStopConditions?: string[]; confidence?: string; confidenceBasis?: string[]; temporalState?: string; verification?: string; identityConfidence?: string; patternConfidence?: string; independentEpisodeCount?: number; independentSourceCount?: number; distinctDateCount?: number; counterevidenceRefs?: string[]; counterevidenceSearch?: string; doNotUseFor?: string[] }): Record<string, unknown> {
  return {
    path: record.path,
    title: record.title,
    type: record.type,
    collection: record.collection,
    sourceKind: record.sourceKind,
    scope: record.scope,
    status: record.status,
    revision: record.revision,
    revisionHistory: record.revisionHistory,
    supersededBy: record.supersededBy ?? null,
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
    canonicalKey: record.canonicalKey,
    compilationSchema: record.compilationSchema,
    compilationCaseId: record.compilationCaseId,
    compilationProductId: record.compilationProductId,
    extractionManifestRef: record.extractionManifestRef,
    compilationRef: record.compilationRef,
    informationLossRef: record.informationLossRef,
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
