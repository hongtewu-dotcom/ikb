import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { assertValue, printValue } from "../format.ts";
import { upsertInboxItem } from "../inbox.ts";
import { importIncrementalRecords } from "../incremental.ts";
import { findKnowledge, updateKnowledgeStatus } from "../knowledge.ts";
import {
  KNOWLEDGE_USAGE_CONTRACT_VERSION,
  knowledgeEventsForRun,
  requireIntegrityCheckedRunArtifact,
} from "../knowledge-usage.ts";
import { writeReceipt, type ReceiptOperation } from "../receipt.ts";
import {
  buildSourceContext,
  hashSourceContent,
  listSources,
  makeSourceId,
  parseSourceRecords,
} from "../source.ts";
import { buildSourceReceipt, lookupSources } from "../source-query.ts";
import { LedgerStore } from "../store.ts";
import type { Artifact } from "../types.ts";
import { resolveSourcesRoot } from "../layout.ts";
import { buildContextCommandResult } from "./knowledge.ts";
import { sourceEventPayload } from "./source-shared.ts";
import {
  type ParsedArgs,
  optionalOption,
  outputFormat,
  requiredArg,
  requiredOption,
} from "./shared.ts";

export function handleRemember(store: LedgerStore, home: string, value: string | undefined, parsed: ParsedArgs): void {
  const startedAt = new Date().toISOString();
  const scope = requiredScope(parsed);
  const input = requiredValue(value, "Usage: ikb remember <path|url|text> --scope personal|work");
  const materialized = materializeRememberInput(home, input);
  const content = readFileSync(materialized.path);
  const provisionalSourceId = makeSourceId();
  const records = parseSourceRecords(content.toString("utf8"), provisionalSourceId, materialized.kind, materialized.path);
  const imported = importIncrementalRecords(home, materialized.path, content, {
    kind: materialized.kind,
    title: materialized.title,
    scope,
    logicalKey: materialized.logicalKey,
  }, records);
  store.recordSourceEvent(imported.logicalKey, "source.incremental_scan", imported.state as unknown as Record<string, unknown>);
  const source = imported.source;
  assertValue(source, "remember did not produce or reuse a Source");
  if (imported.imported) store.recordSourceIngestEvents([{ id: source.id, payload: sourceEventPayload(source) }]);
  const coverage = buildSourceReceipt(home, source);
  const inbox = coverage.knowledgeStatus === "default_eligible" ? null : upsertInboxItem(home, {
    scope,
    trigger: "source_uncovered",
    subject: source.title,
    goal: "判断该 Source 是否包含未来任务可直接复用的 Knowledge",
    sourceRefs: [source.id],
    knowledgeIds: coverage.linkedKnowledgeIds,
    usageId: null,
    details: {
      knowledgeStatus: coverage.knowledgeStatus,
      imported: imported.imported,
      reason: imported.reason,
    },
  });
  const receipt = writeReceipt(home, store, {
    kind: "remember",
    scope,
    command: "remember",
    startedAt,
    outcome: "succeeded",
    operations: [{
      action: "remember",
      subjectRef: `source://${source.id}`,
      inputRefs: [materialized.inputRef],
      outputRefs: [`source://${source.id}`, ...(inbox ? [`inbox://${inbox.id}`] : [])],
      sourceRefs: [source.id],
      beforeHash: imported.previousSourceIds.length > 0 ? sourceVersionHash(home, imported.previousSourceIds[0]) : null,
      afterHash: source.contentHash,
      applicability: null,
      boundary: "Source intake preserves evidence and does not promote Knowledge",
      validation: {
        status: "passed",
        checks: ["Source stored or reused", "Knowledge coverage inspected"],
        issues: [],
      },
      outcome: imported.imported ? "stored" : "reused",
      confirmation: null,
    }],
  });
  printValue({
    sourceId: source.id,
    source,
    version: coverage.version,
    knowledgeCoverage: {
      status: coverage.knowledgeStatus,
      linkedKnowledgeIds: coverage.linkedKnowledgeIds,
      defaultEligibleKnowledgeIds: coverage.defaultEligibleKnowledgeIds,
    },
    inbox: inbox ? { id: inbox.id, path: inbox.path } : null,
    receipt: receiptSummary(receipt),
  }, outputFormat(parsed));
}

export function handleUse(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  const startedAt = new Date().toISOString();
  const scope = requiredScope(parsed);
  const goal = requiredOption(parsed, "goal").trim();
  const acceptance = requiredOption(parsed, "accept", "acceptance").trim();
  assertValue(goal, "--goal must not be empty");
  assertValue(acceptance, "--accept must not be empty");
  const task = store.createTask({
    title: optionalOption(parsed, "title")?.trim() || goal.slice(0, 72),
    goal,
    acceptance,
    type: optionalOption(parsed, "type") ?? "knowledge-use",
    risk: optionalOption(parsed, "risk") ?? "low",
    scope,
  });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const contextParsed: ParsedArgs = {
    positionals: [],
    options: {
      ...parsed.options,
      run: run.id,
      output: "json",
      "verified-only": true,
    },
  };
  const context = buildContextCommandResult(store, home, task.id, contextParsed) as {
    query: string;
    results: Array<{ id: string; status: string }>;
    markdown: string;
    contextArtifact: Artifact | null;
    queryId: string;
    queryEventId: string;
  };
  const knowledgeIds = context.results.map((result) => result.id);
  const sourceFallback = knowledgeIds.length > 0
    ? null
    : buildSourceFallback(store, home, run.id, scope, [context.query, goal, acceptance]);
  const sourceRefs = knowledgeIds.length > 0
    ? knowledgeIds.flatMap((id) => findKnowledge(home, id)?.sourceRefs ?? [])
    : sourceFallback?.sources.map((source) => source.id) ?? [];
  const inbox = knowledgeIds.length > 0 ? null : upsertInboxItem(home, {
    scope,
    trigger: "zero_result",
    subject: goal,
    goal,
    sourceRefs,
    knowledgeIds: [],
    usageId: run.id,
    details: { acceptance, queryId: context.queryId },
  });
  const contextHash = context.contextArtifact?.contentHash
    ?? createHash("sha256").update(context.markdown).digest("hex");
  const receipt = writeReceipt(home, store, {
    kind: "usage",
    scope,
    command: "use",
    startedAt,
    outcome: knowledgeIds.length > 0 ? "succeeded" : "partial",
    operations: [{
      action: "use",
      subjectRef: `usage://${run.id}`,
      inputRefs: [`task://${task.id}`],
      outputRefs: [
        `run://${run.id}`,
        ...(context.contextArtifact ? [`artifact://${context.contextArtifact.id}`] : []),
        ...(sourceFallback ? [`artifact://${sourceFallback.artifact.id}`] : []),
        ...knowledgeIds.map((id) => `knowledge://${id}`),
        ...(inbox ? [`inbox://${inbox.id}`] : []),
      ],
      sourceRefs,
      beforeHash: null,
      afterHash: contextHash,
      applicability: goal,
      boundary: acceptance,
      validation: {
        status: "passed",
        checks: ["Task scope fixed", "verified-only Context recorded", "local Source fallback inspected"],
        issues: knowledgeIds.length > 0
          ? []
          : sourceFallback
            ? ["verified_knowledge_zero_result", "source_fallback_is_unadmitted_evidence"]
            : ["verified_knowledge_zero_result", "source_fallback_zero_result"],
      },
      outcome: knowledgeIds.length > 0 ? "context_ready" : "zero_result",
      confirmation: null,
    }],
  });
  printValue({
    usageId: run.id,
    taskId: task.id,
    runId: run.id,
    goal,
    acceptance,
    context: { ...context, sourceFallback },
    inbox: inbox ? { id: inbox.id, path: inbox.path } : null,
    receipt: receiptSummary(receipt),
  }, outputFormat(parsed));
}

export function handleFeedback(store: LedgerStore, home: string, usageId: string | undefined, parsed: ParsedArgs): void {
  const startedAt = new Date().toISOString();
  const run = store.requireRun(requiredValue(usageId, "Usage: ikb feedback <usage-id> --outcome helpful|partial|incorrect|unused"));
  assertValue(run.status === "running", `Usage ${run.id} is already ${run.status}`);
  const task = store.requireTask(run.taskId);
  assertValue(task.scope === "personal" || task.scope === "work", `Task ${task.id} has unsupported scope ${task.scope}`);
  const scope = task.scope as "personal" | "work";
  const outcome = requiredOption(parsed, "outcome");
  assertValue(["helpful", "partial", "incorrect", "unused"].includes(outcome), "--outcome must be helpful, partial, incorrect, or unused");
  const referenceEvents = knowledgeEventsForRun(store.listEvents(), run.id, "knowledge.referenced");
  const referencedIds = unique(referenceEvents.map((event) => event.aggregateId));
  const requestedIds = splitValues(optionalOption(parsed, "knowledge"));
  const knowledgeIds = requestedIds.length > 0 ? requestedIds : referencedIds;
  for (const id of knowledgeIds) assertValue(referencedIds.includes(id), `Knowledge ${id} was not returned by usage ${run.id}`);
  const sourceRefs = unique(store.listEvents()
    .filter((event) => event.aggregateType === "source"
      && event.eventType === "source.context_built"
      && event.payload.runId === run.id)
    .map((event) => event.aggregateId));
  if (outcome !== "unused") {
    assertValue(knowledgeIds.length > 0 || sourceRefs.length > 0, `${outcome} feedback requires Knowledge or Source evidence returned by usage ${run.id}`);
  }
  const artifact = feedbackArtifact(store, run.id, outcome, optionalOption(parsed, "result"));
  requireIntegrityCheckedRunArtifact(store, run.id, artifact.id, "Agent feedback");
  const reasonCode = optionalOption(parsed, "reason-code")?.trim() || `agent_${outcome}`;
  const note = optionalOption(parsed, "note")?.trim() || `Agent recorded ${outcome} for usage ${run.id}`;
  const operations: ReceiptOperation[] = [];
  const inboxItems: Array<{ id: string; path: string }> = [];
  for (const knowledgeId of knowledgeIds) {
    const record = findKnowledge(home, knowledgeId);
    assertValue(record, `Knowledge not found: ${knowledgeId}`);
    assertValue(record.scope === scope, `Knowledge scope ${record.scope} does not match usage scope ${scope}`);
    const beforeText = readFileSync(record.path, "utf8");
    const beforeHash = createHash("sha256").update(beforeText).digest("hex");
    if (outcome !== "unused") {
      const reference = referenceEvents.filter((event) => event.aggregateId === knowledgeId).at(-1)!;
      store.recordKnowledgeUsageEvent(knowledgeId, {
        contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
        taskId: task.id,
        runId: run.id,
        artifactId: artifact.id,
        artifactHash: artifact.contentHash,
        purpose: "other",
        note,
        referenceEventId: reference.eventId,
        queryId: reference.payload.queryId ?? null,
        contextArtifactId: reference.payload.contextArtifactId ?? null,
        knowledgeStatus: record.status,
        knowledgeVerification: record.verification ?? "unverified",
      });
    }
    store.recordKnowledgeFeedbackEvent(knowledgeId, {
      contractVersion: KNOWLEDGE_USAGE_CONTRACT_VERSION,
      taskId: task.id,
      runId: run.id,
      outcome,
      reasonCode,
      note,
      evidenceRefs: [artifact.id],
      knowledgeStatus: record.status,
      knowledgeVerification: record.verification ?? "unverified",
    });
    let after = record;
    if (outcome === "incorrect" && record.status !== "draft") {
      after = updateKnowledgeStatus(home, record.id, "draft");
      store.recordKnowledgeEvent(record.id, "knowledge.revised", {
        reason: "incorrect_feedback",
        runId: run.id,
        beforeStatus: record.status,
        afterStatus: "draft",
        sourceRefs: record.sourceRefs,
      });
    }
    const afterHash = createHash("sha256").update(readFileSync(after.path)).digest("hex");
    if (outcome === "partial" || outcome === "incorrect") {
      const item = upsertInboxItem(home, {
        scope,
        trigger: outcome === "incorrect" ? "incorrect_feedback" : "partial_feedback",
        subject: record.title,
        goal: task.goal,
        sourceRefs: record.sourceRefs,
        knowledgeIds: [record.id],
        usageId: run.id,
        details: { outcome, reasonCode, resultArtifactId: artifact.id },
      });
      inboxItems.push({ id: item.id, path: item.path });
    }
    operations.push({
      action: outcome === "incorrect" ? "update" : "feedback",
      subjectRef: `knowledge://${record.id}`,
      inputRefs: [`usage://${run.id}`, `artifact://${artifact.id}`],
      outputRefs: [
        `knowledge://${record.id}`,
        ...inboxItems.filter((item) => item.id).slice(-1).map((item) => `inbox://${item.id}`),
      ],
      sourceRefs: record.sourceRefs.length > 0 ? record.sourceRefs : ["unknown:source-ref-missing"],
      beforeHash,
      afterHash,
      applicability: record.applicability || null,
      boundary: record.boundary || null,
      validation: {
        status: record.sourceRefs.length > 0 ? "passed" : "failed",
        checks: ["Result Artifact integrity checked", "Knowledge was present in Context"],
        issues: record.sourceRefs.length > 0 ? [] : ["source_refs_missing"],
      },
      outcome,
      confirmation: null,
    });
  }
  if (operations.length === 0) {
    if (outcome === "partial" || outcome === "incorrect") {
      const item = upsertInboxItem(home, {
        scope,
        trigger: outcome === "incorrect" ? "incorrect_feedback" : "partial_feedback",
        subject: task.title,
        goal: task.goal,
        sourceRefs,
        knowledgeIds: [],
        usageId: run.id,
        details: { outcome, reasonCode, resultArtifactId: artifact.id, sourceFallback: true },
      });
      inboxItems.push({ id: item.id, path: item.path });
    }
    operations.push({
      action: "feedback",
      subjectRef: `usage://${run.id}`,
      inputRefs: [`artifact://${artifact.id}`],
      outputRefs: inboxItems.map((item) => `inbox://${item.id}`),
      sourceRefs,
      beforeHash: null,
      afterHash: artifact.contentHash,
      applicability: task.goal,
      boundary: task.acceptance,
      validation: { status: "passed", checks: ["zero-result usage closed"], issues: [] },
      outcome,
      confirmation: null,
    });
  }
  const receipt = writeReceipt(home, store, {
    kind: "feedback",
    scope,
    command: "feedback",
    startedAt,
    outcome: outcome === "partial" || outcome === "incorrect" ? "partial" : "succeeded",
    operations,
  });
  store.finishRun(run.id, "succeeded", `Knowledge feedback: ${outcome}`);
  store.transitionTask(task.id, "done", `Knowledge feedback: ${outcome}`, artifact.id);
  printValue({
    usageId: run.id,
    taskId: task.id,
    outcome,
    knowledgeIds,
    resultArtifact: artifact,
    inbox: inboxItems,
    receipt: receiptSummary(receipt),
  }, outputFormat(parsed));
}

function buildSourceFallback(
  store: LedgerStore,
  home: string,
  runId: string,
  scope: "personal" | "work",
  queries: string[],
): {
  notice: string;
  sources: Array<{ id: string; title: string; score: number; matches: string[]; contentHash: string }>;
  markdown: string;
  artifact: Artifact;
} | null {
  const candidates = new Map<string, ReturnType<typeof lookupSources>[number]>();
  for (const query of unique(queries)) {
    for (const result of lookupSources(home, query, { scope, limit: 3 })) {
      const existing = candidates.get(result.source.id);
      if (!existing || result.score > existing.score) candidates.set(result.source.id, result);
    }
  }
  if (candidates.size < 3) {
    const tokens = fallbackTokens(queries.join(" "));
    for (const source of listSources(home).filter((item) => item.scope === scope)) {
      if (candidates.has(source.id)) continue;
      const haystack = `${source.title} ${basename(source.originalPath)}`.toLocaleLowerCase("zh-CN");
      const matched = tokens.filter((token) => haystack.includes(token));
      if (matched.length < Math.min(2, tokens.length)) continue;
      candidates.set(source.id, {
        source,
        score: matched.length * 10,
        matches: ["title"],
        aliases: [],
        quarantined: false,
        quarantineReason: null,
      });
    }
  }
  const selected = [...candidates.values()]
    .sort((left, right) => right.score - left.score || right.source.importedAt.localeCompare(left.source.importedAt))
    .slice(0, 3);
  if (selected.length === 0) return null;

  const notice = "原始材料，尚未整理为 verified Knowledge；使用前必须回读 Source 定位并自行判断。";
  const sections = selected.map((result) => {
    const context = buildSourceContext(home, result.source.id, 5);
    store.recordSourceEvent(result.source.id, "source.context_built", {
      runId,
      records: context.records.length,
      mode: "agent_use_fallback",
    });
    return truncateText(context.markdown, 6_000);
  });
  const markdown = truncateText([
    "# IKB Source Fallback",
    "",
    `> ${notice}`,
    "",
    ...sections,
  ].join("\n"), 18_000);
  const run = store.requireRun(runId);
  const hash = createHash("sha256").update(markdown).digest("hex");
  const path = join(run.runDir, `source-fallback-${hash.slice(0, 16)}.md`);
  writeFileSync(path, markdown, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  const artifact = store.createArtifact({ runId, kind: "source-fallback", label: "Source fallback Context", path });
  store.recordHarnessEvent(runId, "run.artifact_linked", {
    artifactId: artifact.id,
    relation: "produced",
    lineageRefs: selected.map((result) => `source://${result.source.id}`),
  });
  return {
    notice,
    sources: selected.map((result) => ({
      id: result.source.id,
      title: result.source.title,
      score: result.score,
      matches: result.matches,
      contentHash: result.source.contentHash,
    })),
    markdown,
    artifact,
  };
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Source Context truncated; reopen the Source by the ID above.]\n`;
}

function fallbackTokens(value: string): string[] {
  return unique((value.toLocaleLowerCase("zh-CN").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 2));
}

function feedbackArtifact(store: LedgerStore, runId: string, outcome: string, resultPath?: string): Artifact {
  if (resultPath) {
    const path = resolve(resultPath);
    assertValue(existsSync(path), `Result file not found: ${resultPath}`);
    const stat = lstatSync(path);
    assertValue(!stat.isSymbolicLink() && stat.isFile(), `Result must be a regular file: ${resultPath}`);
    return store.createArtifact({ runId, path, kind: "consumer-result", label: "Agent consumer result" });
  }
  const run = store.requireRun(runId);
  const path = join(run.runDir, `usage-feedback-${randomUUID().slice(0, 12)}.json`);
  writeFileSync(path, `${JSON.stringify({ usageId: runId, outcome, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return store.createArtifact({ runId, path, kind: "feedback-assertion", label: "Agent feedback assertion" });
}

function materializeRememberInput(home: string, value: string): {
  path: string;
  kind: "document" | "manual";
  title: string;
  logicalKey: string;
  inputRef: string;
} {
  const possiblePath = !value.includes("\n") && value.length < 4096 ? resolve(value) : "";
  if (possiblePath && existsSync(possiblePath)) {
    assertValue(statSync(possiblePath).isFile(), `remember path must be a file: ${value}`);
    return {
      path: possiblePath,
      kind: "document",
      title: basename(possiblePath, extname(possiblePath)),
      logicalKey: `file:${possiblePath}`,
      inputRef: possiblePath,
    };
  }
  const content = value.endsWith("\n") ? value : `${value}\n`;
  const hash = hashSourceContent(content);
  const directory = join(resolve(home), ".system", "remember-inputs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${hash}.md`);
  if (existsSync(path)) assertValue(readFileSync(path, "utf8") === content, `remember input hash collision: ${path}`);
  else writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  const isUrl = /^https?:\/\//i.test(value.trim());
  return {
    path,
    kind: "manual",
    title: isUrl ? value.trim().slice(0, 120) : value.trim().split("\n", 1)[0].slice(0, 120) || "Agent input",
    logicalKey: `remember:${hash}`,
    inputRef: isUrl ? value.trim() : `text:sha256:${hash}`,
  };
}

function sourceVersionHash(home: string, sourceId: string): string | null {
  try {
    const path = join(resolveSourcesRoot(home), sourceId, "source.json");
    const value = JSON.parse(readFileSync(path, "utf8")) as { contentHash?: string };
    return value.contentHash ?? null;
  } catch {
    return null;
  }
}

function requiredScope(parsed: ParsedArgs): "personal" | "work" {
  const scope = requiredOption(parsed, "scope");
  assertValue(scope === "personal" || scope === "work", "--scope must be personal or work");
  return scope;
}

function requiredValue(value: string | undefined, message: string): string {
  assertValue(value?.trim(), message);
  return value!;
}

function splitValues(value?: string): string[] {
  return unique((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function receiptSummary(receipt: { id: string; path: string; contentHash: string; kind: string; outcome: string }) {
  return { id: receipt.id, kind: receipt.kind, outcome: receipt.outcome, path: receipt.path, contentHash: receipt.contentHash };
}
