import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EventRecord, SourceMessage, SourceRecord } from "./types.ts";
import { listSources, readSourceRecords } from "./source.ts";
import type { LedgerStore } from "./store.ts";

/**
 * Session Triage is intentionally a small, deterministic filter.  It scans
 * normalized human/assistant messages (never tool output by default), keeps
 * only signal counts and evidence references, and does not write Knowledge.
 */
export const EXPERIENCE_VERSION = "ikb-experience.v1";
export const TRIAGE_VERSION = "ikb-experience-triage.v1";
export const CLUSTER_VERSION = "ikb-experience-cluster.v1";

export type ExperienceSignalCode =
  | "failure_or_block"
  | "retry"
  | "manual_correction"
  | "verifier_rejection"
  | "non_obvious_fix"
  | "knowledge_feedback"
  | "decision_or_rule";

export type ExperienceStatus = "queued" | "analyzed";
export type ExperienceCandidateStatus = "pending_review";
export type ExperienceAdapter = "claude" | "codex" | "desk" | "elephant";
export type ExperienceAdapterSelection = ExperienceAdapter | "all";
export type ExperienceScope = "personal" | "work";

export interface ExperienceRecord {
  schema: typeof EXPERIENCE_VERSION;
  id: string;
  scope: ExperienceScope;
  adapter: ExperienceAdapter | null;
  sourceTitle: string;
  sourceIds: string[];
  sourceOriginHash: string;
  sessionKeyHash: string;
  conversationIdHash: string;
  sourceRecordIds: string[];
  evidenceRecordIds: string[];
  evidenceEventIds: string[];
  runIds: string[];
  validationRefs: string[];
  signalCodes: ExperienceSignalCode[];
  signalCounts: Record<ExperienceSignalCode, number>;
  status: ExperienceStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceKnowledgeCandidate {
  schema: "ikb-knowledge-candidate.v1";
  id: string;
  scope: ExperienceScope;
  status: ExperienceCandidateStatus;
  title: string;
  patternKey: string;
  signalCodes: ExperienceSignalCode[];
  experienceIds: string[];
  sourceIds: string[];
  sourceRecordRefs: string[];
  evidenceEventIds: string[];
  runIds: string[];
  validationRefs: string[];
  independentRunCount: number;
  independentSourceCount: number;
  humanApprovalRequired: true;
  candidateKnowledge: {
    claim: null;
    type: "lesson" | "playbook" | "fact";
    collection: "lessons" | "playbooks" | "syntheses";
    requiredSections: string[];
    evidenceRefs: string[];
    applicability: "待分析";
    boundary: "待分析";
    useContract: "待分析";
    validationPlan: "待分析";
    confidence: "unknown";
    temporalState: "unknown";
  };
  nextAction: "analyst_extract_claim_and_complete_card";
  createdAt: string;
  updatedAt: string;
}

export interface TriageOptions {
  scope?: ExperienceScope;
  adapter?: ExperienceAdapterSelection;
  from?: string;
  to?: string;
  limit?: number;
}

export interface TriageResult {
  schema: typeof TRIAGE_VERSION;
  scope: ExperienceScope | "all";
  adapter: ExperienceAdapterSelection;
  scannedSources: number;
  scannedSessions: number;
  selected: number;
  created: number;
  updated: number;
  unchanged: number;
  skippedToolRecords: number;
  unmappedFeedbackEvents: number;
  records: Array<Pick<ExperienceRecord, "id" | "sourceTitle" | "adapter" | "signalCodes" | "runIds" | "status">>;
}

export interface ClusterOptions {
  scope?: ExperienceScope;
  minimumSamples?: number;
}

export interface ClusterResult {
  schema: typeof CLUSTER_VERSION;
  scope: ExperienceScope | "all";
  minimumSamples: number;
  clusters: number;
  eligible: number;
  created: number;
  updated: number;
  unchanged: number;
  pending: Array<{
    patternKey: string;
    signalCodes: ExperienceSignalCode[];
    experienceIds: string[];
    sourceIds: string[];
    runIds: string[];
    validationRefs: string[];
    independentRunCount: number;
    required: string;
  }>;
  candidates: ExperienceKnowledgeCandidate[];
}

const SIGNAL_ORDER: ExperienceSignalCode[] = [
  "failure_or_block",
  "retry",
  "manual_correction",
  "verifier_rejection",
  "non_obvious_fix",
  "knowledge_feedback",
  "decision_or_rule",
];

const FAILURE_RE = /(?:\bfail(?:ed|ure)?\b|\berror\b|\bexception\b|\bblocked?\b|\btimeout\b|失败|报错|错误|异常|阻断|超时|不通过|失败路径)/iu;
const RETRY_RE = /(?:\bre-?try\b|\bre-?run\b|\brerun\b|\brework\b|重试|重跑|再跑|重做|重来)/iu;
const CORRECTION_RE = /(?:纠正|纠偏|修正|改为|改成|不对|失真|不要.*(?:这样|硬搞|直接)|应该.*(?:而不是|改成)|补充|重写|重新搞|不应该)/iu;
const VERIFIER_RE = /(?:\bverifier\b|\bverify\b|验收|校验|质量门禁|\blint\b|\bdoctor\b|验证)/iu;
const REJECTION_RE = /(?:\breject(?:ed|ion)?\b|\bpartial\b|\bincorrect\b|\bblock(?:ed)?\b|驳回|拒绝|不通过|未通过|阻断)/iu;
const FIX_RE = /(?:修复|\bfix(?:ed|es)?\b|根因|兼容|回归|幂等|边界|补.*校验|补.*检查|收敛|落地|修好)/iu;
const DECISION_RE = /(?:明确要求|决定|决策|必须|禁止|只允许|边界|规则|原则|准入|停止条件|采用|不采用|统一|以后(?:都|要)|只查|只能|不得)/iu;

export function triageSessions(home: string, store: LedgerStore, options: TriageOptions = {}): TriageResult {
  const scope = options.scope ?? "all";
  const adapter = options.adapter ?? "all";
  validateTimeRange(options.from, options.to);
  const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : validateLimit(options.limit);
  const sources = listSources(home)
    .filter((source) => source.kind === "ai_conversation" || source.kind === "elephant")
    .filter((source) => scope === "all" || source.scope === scope)
    .filter((source) => adapter === "all" || source.adapter === adapter)
    .sort((left, right) => left.importedAt.localeCompare(right.importedAt));
  const events = store.listEvents();
  const eventIndex = buildEventIndex(events);
  const sessions = new Map<string, SessionAccumulator>();
  let skippedToolRecords = 0;
  for (const source of sources) {
    const records = readSourceRecords(home, source.id, { verifyRaw: false, source });
    for (const record of records) {
      if (isToolRecord(record)) {
        skippedToolRecords += 1;
        continue;
      }
      if (!inTimeRange(record.timestamp, options.from, options.to)) continue;
      const sessionKey = stableSessionKey(source, record.conversationId);
      const current = sessions.get(sessionKey) ?? newSession(source, record.conversationId, sessionKey);
      current.sources.add(source.id);
      current.sourceTitles.add(source.title);
      current.sourceOriginHashes.add(source.contentHash);
      current.sourceRecordIds.add(record.id);
      current.records.push(record);
      current.firstSeenAt = earlier(current.firstSeenAt, record.timestamp || source.importedAt);
      current.lastSeenAt = later(current.lastSeenAt, record.timestamp || source.importedAt);
      sessions.set(sessionKey, current);
    }
  }

  const selected: ExperienceRecord[] = [];
  for (const session of sessions.values()) {
    const triaged = triageSession(session, eventIndex);
    if (!triaged.signalCodes.length) continue;
    selected.push(triaged);
  }
  selected.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.id.localeCompare(right.id));
  const limited = selected.slice(0, limit);
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const records: TriageResult["records"] = [];
  for (const record of limited) {
    const outcome = writeExperienceRecord(home, record);
    if (outcome === "created") {
      created += 1;
      store.recordExperienceEvent(record.id, "experience.queued", experienceEventPayload(record));
    } else if (outcome === "updated") {
      updated += 1;
      store.recordExperienceEvent(record.id, "experience.updated", experienceEventPayload(record));
    } else unchanged += 1;
    records.push({ id: record.id, sourceTitle: record.sourceTitle, adapter: record.adapter, signalCodes: record.signalCodes, runIds: record.runIds, status: record.status });
  }
  const unmappedFeedbackEvents = eventIndex.unmappedFeedbackEvents;
  return {
    schema: TRIAGE_VERSION,
    scope,
    adapter,
    scannedSources: sources.length,
    scannedSessions: sessions.size,
    selected: limited.length,
    created,
    updated,
    unchanged,
    skippedToolRecords,
    unmappedFeedbackEvents,
    records,
  };
}

export function listExperienceRecords(home: string, scope?: ExperienceScope): ExperienceRecord[] {
  return readJsonRecords<ExperienceRecord>(experienceRoot(home), scope, isExperienceRecord);
}

export function findExperienceRecord(home: string, id: string): ExperienceRecord | null {
  return listExperienceRecords(home).find((record) => record.id === id) ?? null;
}

export function listExperienceCandidates(home: string, scope?: ExperienceScope): ExperienceKnowledgeCandidate[] {
  const root = candidateRoot(home);
  if (!existsSync(root)) return [];
  assertDirectory(root);
  const candidates: ExperienceKnowledgeCandidate[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(root, entry.name);
    const value = readJsonFile<ExperienceKnowledgeCandidate>(path);
    if (!isExperienceCandidate(value)) throw new Error(`Invalid Experience Candidate: ${path}`);
    if (!scope || value.scope === scope) candidates.push(value);
  }
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function findExperienceCandidate(home: string, id: string): ExperienceKnowledgeCandidate | null {
  return listExperienceCandidates(home).find((candidate) => candidate.id === id) ?? null;
}

export function clusterExperienceRecords(home: string, store: LedgerStore, options: ClusterOptions = {}): ClusterResult {
  const scope = options.scope ?? "all";
  const minimumSamples = options.minimumSamples ?? 3;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 2) throw new Error("Experience cluster minimumSamples must be an integer >= 2");
  const activeSourceIds = new Set(listSources(home).map((source) => source.id));
  const records = listExperienceRecords(home, scope === "all" ? undefined : scope)
    .filter((record) => record.sourceIds.length === 0 || record.sourceIds.every((sourceId) => activeSourceIds.has(sourceId)));
  const groups = new Map<string, ExperienceRecord[]>();
  for (const record of records) {
    const patternKey = patternKeyFor(record.signalCodes);
    const list = groups.get(`${record.scope}|${patternKey}`) ?? [];
    list.push(record);
    groups.set(`${record.scope}|${patternKey}`, list);
  }
  const pending: ClusterResult["pending"] = [];
  const candidates: ExperienceKnowledgeCandidate[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [groupKey, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [groupScope, patternKey] = groupKey.split("|", 2) as [ExperienceScope, string];
    const runIds = unique(group.flatMap((record) => record.runIds));
    const sourceIds = unique(group.flatMap((record) => record.sourceIds));
    const validationRefs = unique(group.flatMap((record) => record.validationRefs));
    const experienceIds = unique(group.map((record) => record.id));
    const signalCodes = signalCodesFromPattern(patternKey);
    const eligible = runIds.length >= minimumSamples || (runIds.length >= 2 && validationRefs.length > 0);
    if (!eligible) {
      pending.push({
        patternKey,
        signalCodes,
        experienceIds,
        sourceIds,
        runIds,
        validationRefs,
        independentRunCount: runIds.length,
        required: `${minimumSamples} independent Runs, or 2 independent Runs + 1 real validation`,
      });
      continue;
    }
    const candidate = makeKnowledgeCandidate(groupScope, patternKey, group, runIds, sourceIds, validationRefs);
    const outcome = writeExperienceCandidate(home, candidate);
    if (outcome === "created") {
      created += 1;
      store.recordExperienceEvent(candidate.id, "experience.candidate_created", candidateEventPayload(candidate));
    } else if (outcome === "updated") {
      updated += 1;
      store.recordExperienceEvent(candidate.id, "experience.candidate_updated", candidateEventPayload(candidate));
    } else unchanged += 1;
    candidates.push(candidate);
  }
  return {
    schema: CLUSTER_VERSION,
    scope,
    minimumSamples,
    clusters: groups.size,
    eligible: candidates.length,
    created,
    updated,
    unchanged,
    pending,
    candidates,
  };
}

interface SessionAccumulator {
  scope: ExperienceScope;
  adapter: ExperienceAdapter | null;
  sessionKey: string;
  conversationId: string;
  sourceTitles: Set<string>;
  sources: Set<string>;
  sourceOriginHashes: Set<string>;
  sourceRecordIds: Set<string>;
  records: SourceMessage[];
  firstSeenAt: string;
  lastSeenAt: string;
}

interface EventIndex {
  bySourceId: Map<string, EventRecord[]>;
  runToSources: Map<string, Set<string>>;
  unmappedFeedbackEvents: number;
}

function triageSession(session: SessionAccumulator, eventIndex: EventIndex): ExperienceRecord {
  const signalCounts = emptySignalCounts();
  const evidenceRecordIds: string[] = [];
  const evidenceEventIds = new Set<string>();
  for (const record of session.records) {
    const content = record.content ?? "";
    const human = isHumanRecord(record);
    let found = false;
    if (FAILURE_RE.test(content)) found = increment(signalCounts, "failure_or_block");
    if (RETRY_RE.test(content)) found = increment(signalCounts, "retry");
    if (human && CORRECTION_RE.test(content)) found = increment(signalCounts, "manual_correction");
    if (VERIFIER_RE.test(content) && REJECTION_RE.test(content)) found = increment(signalCounts, "verifier_rejection");
    if (FIX_RE.test(content) && (signalCounts.failure_or_block > 0 || signalCounts.manual_correction > 0 || signalCounts.verifier_rejection > 0)) found = increment(signalCounts, "non_obvious_fix");
    if (human && DECISION_RE.test(content)) found = increment(signalCounts, "decision_or_rule");
    if (found && evidenceRecordIds.length < 100) evidenceRecordIds.push(record.id);
  }
  const sourceIds = unique([...session.sources]);
  const events = sourceIds.flatMap((sourceId) => eventIndex.bySourceId.get(sourceId) ?? []);
  const runIds = unique(events.filter((event) => event.aggregateType === "run").map((event) => event.aggregateId)
    .concat(sourceIds.flatMap((sourceId) => eventsForRunMapping(sourceId, eventIndex))));
  const validationRefs = unique(events.filter(isRealValidation).map((event) => event.eventId));
  for (const event of events) {
    if (event.eventType === "knowledge.feedback_recorded" && ["partial", "incorrect"].includes(String(event.payload.outcome))) increment(signalCounts, "knowledge_feedback");
    if (isStructuredFailure(event)) increment(signalCounts, failureCodeForEvent(event));
    if (isStructuredRetry(event)) increment(signalCounts, "retry");
    if (isStructuredVerifierRejection(event)) increment(signalCounts, "verifier_rejection");
    if (isRelevantEvent(event) && evidenceEventIds.size < 100) evidenceEventIds.add(event.eventId);
  }
  const signalCodes = SIGNAL_ORDER.filter((code) => signalCounts[code] > 0);
  const sourceOriginHash = sha256([...session.sourceOriginHashes].sort().join("|"));
  const id = `exp-${sha256(session.sessionKey).slice(0, 12)}`;
  const now = new Date().toISOString();
  return {
    schema: EXPERIENCE_VERSION,
    id,
    scope: session.scope,
    adapter: session.adapter,
    sourceTitle: [...session.sourceTitles].sort()[0] ?? "未命名会话",
    sourceIds,
    sourceOriginHash,
    sessionKeyHash: sha256(session.sessionKey).slice(0, 32),
    conversationIdHash: sha256(session.conversationId).slice(0, 32),
    sourceRecordIds: [...session.sourceRecordIds].sort(),
    evidenceRecordIds: unique(evidenceRecordIds),
    evidenceEventIds: [...evidenceEventIds].sort(),
    runIds,
    validationRefs,
    signalCodes,
    signalCounts,
    status: "queued",
    firstSeenAt: session.firstSeenAt,
    lastSeenAt: session.lastSeenAt,
    createdAt: now,
    updatedAt: now,
  };
}

function makeKnowledgeCandidate(
  scope: ExperienceScope,
  patternKey: string,
  group: ExperienceRecord[],
  runIds: string[],
  sourceIds: string[],
  validationRefs: string[],
): ExperienceKnowledgeCandidate {
  const experienceIds = unique(group.map((record) => record.id));
  const evidenceEventIds = unique(group.flatMap((record) => record.evidenceEventIds));
  const sourceRecordRefs = unique(group.flatMap((record) => record.evidenceRecordIds.map((recordId) => `${record.sourceIds[0] ?? "source-unknown"}:${recordId}`)));
  const signalCodes = signalCodesFromPattern(patternKey);
  const candidateId = `exp-cand-${sha256(`${scope}|${patternKey}`).slice(0, 12)}`;
  const now = new Date().toISOString();
  return {
    schema: "ikb-knowledge-candidate.v1",
    id: candidateId,
    scope,
    status: "pending_review",
    title: `待分析经验模式：${signalCodes.join("、")}`,
    patternKey,
    signalCodes,
    experienceIds,
    sourceIds,
    sourceRecordRefs,
    evidenceEventIds,
    runIds,
    validationRefs,
    independentRunCount: runIds.length,
    independentSourceCount: sourceIds.length,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: null,
      type: signalCodes.includes("decision_or_rule") ? "lesson" : "playbook",
      collection: signalCodes.includes("decision_or_rule") ? "lessons" : "playbooks",
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan", "confidence", "temporal state"],
      evidenceRefs: [...sourceRecordRefs, ...evidenceEventIds],
      applicability: "待分析",
      boundary: "待分析",
      useContract: "待分析",
      validationPlan: "待分析",
      confidence: "unknown",
      temporalState: "unknown",
    },
    nextAction: "analyst_extract_claim_and_complete_card",
    createdAt: now,
    updatedAt: now,
  };
}

function buildEventIndex(events: EventRecord[]): EventIndex {
  const bySourceId = new Map<string, EventRecord[]>();
  const runToSources = new Map<string, Set<string>>();
  let unmappedFeedbackEvents = 0;
  const directSources = new Map<EventRecord, Set<string>>();
  // First establish the explicit Run -> Source edges.  A verification event
  // often carries only its Run aggregate id; indexing it in a second pass
  // prevents us from losing the validation evidence for that session.
  for (const event of events) {
    const sourceIds = new Set<string>(extractSourceIds(event.payload));
    if (event.aggregateType === "source" && /^src-/.test(event.aggregateId)) sourceIds.add(event.aggregateId);
    directSources.set(event, sourceIds);
    const runIds: string[] = [];
    if (event.aggregateType === "run") runIds.push(event.aggregateId);
    const payloadRunId = stringValue(event.payload.runId);
    if (payloadRunId) runIds.push(payloadRunId);
    for (const runId of runIds) {
      const set = runToSources.get(runId) ?? new Set<string>();
      for (const sourceId of sourceIds) set.add(sourceId);
      runToSources.set(runId, set);
    }
  }
  for (const event of events) {
    const sourceIds = new Set(directSources.get(event) ?? []);
    const runIds: string[] = [];
    if (event.aggregateType === "run") runIds.push(event.aggregateId);
    const payloadRunId = stringValue(event.payload.runId);
    if (payloadRunId) runIds.push(payloadRunId);
    for (const runId of runIds) {
      for (const sourceId of runToSources.get(runId) ?? []) sourceIds.add(sourceId);
    }
    if (event.eventType === "knowledge.feedback_recorded" && ["partial", "incorrect"].includes(String(event.payload.outcome)) && sourceIds.size === 0) {
      unmappedFeedbackEvents += 1;
    }
    for (const sourceId of sourceIds) {
      const list = bySourceId.get(sourceId) ?? [];
      list.push(event);
      bySourceId.set(sourceId, list);
    }
  }
  return { bySourceId, runToSources, unmappedFeedbackEvents };
}

function eventsForRunMapping(sourceId: string, eventIndex: EventIndex): string[] {
  const events = eventIndex.bySourceId.get(sourceId) ?? [];
  return unique(events.flatMap((event) => {
    const runIds: string[] = [];
    if (event.aggregateType === "run") runIds.push(event.aggregateId);
    const payloadRunId = stringValue(event.payload.runId);
    if (payloadRunId) runIds.push(payloadRunId);
    return runIds;
  }));
}

function isRealValidation(event: EventRecord): boolean {
  return (event.eventType === "run.verification_completed" || event.eventType === "run.evaluation_completed") && event.payload.result === "pass";
}

function isStructuredFailure(event: EventRecord): boolean {
  if (event.eventType === "run.gate_evaluated") return event.payload.decision === "block";
  if (event.eventType === "run.verification_completed" || event.eventType === "run.evaluation_completed") return event.payload.result === "blocked" || event.payload.result === "partial";
  return ["run.step_finished", "run.loop_finished", "run.action_executed", "run.failed"].includes(event.eventType) && ["failed", "blocked"].includes(String(event.payload.status));
}

function isStructuredVerifierRejection(event: EventRecord): boolean {
  return event.eventType === "run.verification_completed" && ["blocked", "partial"].includes(String(event.payload.result));
}

function isStructuredRetry(event: EventRecord): boolean {
  return event.eventType.includes("retry") || (event.eventType === "run.queued" && typeof event.payload.retryOf === "string" && Boolean(event.payload.retryOf));
}

function isRelevantEvent(event: EventRecord): boolean {
  return event.eventType === "knowledge.feedback_recorded" || isStructuredFailure(event) || isStructuredRetry(event) || isRealValidation(event);
}

function failureCodeForEvent(event: EventRecord): ExperienceSignalCode {
  if (event.eventType === "run.verification_completed" || event.eventType === "run.gate_evaluated") return "verifier_rejection";
  return "failure_or_block";
}

function patternKeyFor(codes: ExperienceSignalCode[]): string {
  const filtered = codes.filter((code) => code !== "decision_or_rule");
  return (filtered.length ? filtered : ["decision_or_rule"]).sort().join("+");
}

function signalCodesFromPattern(patternKey: string): ExperienceSignalCode[] {
  return patternKey.split("+").filter((value): value is ExperienceSignalCode => SIGNAL_ORDER.includes(value as ExperienceSignalCode)).sort((left, right) => SIGNAL_ORDER.indexOf(left) - SIGNAL_ORDER.indexOf(right));
}

function writeExperienceRecord(home: string, record: ExperienceRecord): "created" | "updated" | "unchanged" {
  const path = join(experienceRoot(home), record.scope, `${record.id}.json`);
  ensureDirectory(join(experienceRoot(home), record.scope));
  const existing = existsSync(path) ? readJsonFile<ExperienceRecord>(path) : null;
  if (existing && !isExperienceRecord(existing)) throw new Error(`Invalid Experience Record: ${path}`);
  if (existing && stableRecordFingerprint(existing) === stableRecordFingerprint(record)) return "unchanged";
  if (existing) record.createdAt = existing.createdAt;
  writeJson(path, record);
  return existing ? "updated" : "created";
}

function writeExperienceCandidate(home: string, candidate: ExperienceKnowledgeCandidate): "created" | "updated" | "unchanged" {
  ensureDirectory(candidateRoot(home));
  const path = join(candidateRoot(home), `${candidate.id}.json`);
  const existing = existsSync(path) ? readJsonFile<ExperienceKnowledgeCandidate>(path) : null;
  if (existing && !isExperienceCandidate(existing)) throw new Error(`Invalid Experience Candidate: ${path}`);
  if (existing && stableCandidateFingerprint(existing) === stableCandidateFingerprint(candidate)) return "unchanged";
  if (existing) {
    candidate.createdAt = existing.createdAt;
    if (existing.status !== "pending_review") candidate.status = existing.status;
  }
  writeJson(path, candidate);
  return existing ? "updated" : "created";
}

function experienceEventPayload(record: ExperienceRecord): Record<string, unknown> {
  return {
    schema: EXPERIENCE_VERSION,
    scope: record.scope,
    adapter: record.adapter,
    sourceIds: record.sourceIds,
    evidenceRecordIds: record.evidenceRecordIds.slice(0, 100),
    evidenceEventIds: record.evidenceEventIds.slice(0, 100),
    signalCodes: record.signalCodes,
    runIds: record.runIds,
  };
}

function candidateEventPayload(candidate: ExperienceKnowledgeCandidate): Record<string, unknown> {
  return {
    schema: candidate.schema,
    scope: candidate.scope,
    patternKey: candidate.patternKey,
    experienceIds: candidate.experienceIds,
    sourceIds: candidate.sourceIds,
    evidenceEventIds: candidate.evidenceEventIds,
    runIds: candidate.runIds,
    validationRefs: candidate.validationRefs,
    independentRunCount: candidate.independentRunCount,
    nextAction: candidate.nextAction,
  };
}

function newSession(source: SourceRecord, conversationId: string, sessionKey: string): SessionAccumulator {
  return {
    scope: source.scope as ExperienceScope,
    adapter: source.adapter && isAdapter(source.adapter) ? source.adapter : null,
    sessionKey,
    conversationId,
    sourceTitles: new Set(),
    sources: new Set(),
    sourceOriginHashes: new Set(),
    sourceRecordIds: new Set(),
    records: [],
    firstSeenAt: source.importedAt,
    lastSeenAt: source.importedAt,
  };
}

function stableSessionKey(source: SourceRecord, conversationId: string): string {
  return `${source.adapter ?? source.kind}|${source.originalPath}|${conversationId}`;
}

function isToolRecord(record: SourceMessage): boolean {
  const role = `${record.role}|${record.actor}`.toLowerCase();
  return Boolean(record.role === "tool" || /(?:^|[|:_-])tool(?:$|[|:_-])/.test(role) || role.includes("tool_result") || role.includes("function_call"));
}

function isHumanRecord(record: SourceMessage): boolean {
  const role = `${record.role}|${record.actor}`.toLowerCase();
  return /(?:^|[|:_-])(?:user|human|reviewer|owner|customer)(?:$|[|:_-])/.test(role) || record.role === "user" || record.role === "human";
}

function extractSourceIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(/src-[A-Za-z0-9][A-Za-z0-9._-]{0,127}/g)) result.add(match[0]);
      return;
    }
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...result];
}

function readJsonRecords<T>(root: string, scope: ExperienceScope | undefined, validator: (value: unknown) => value is T): T[] {
  if (!existsSync(root)) return [];
  assertDirectory(root);
  const scopes = scope ? [scope] : (["personal", "work"] as ExperienceScope[]);
  const records: T[] = [];
  for (const item of scopes) {
    const directory = join(root, item);
    if (!existsSync(directory)) continue;
    assertDirectory(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const value = readJsonFile<T>(path);
      if (!validator(value)) throw new Error(`Invalid Experience JSON: ${path}`);
      records.push(value);
    }
  }
  return records.sort((left, right) => String((right as Record<string, unknown>).updatedAt ?? "").localeCompare(String((left as Record<string, unknown>).updatedAt ?? "")));
}

function isExperienceRecord(value: unknown): value is ExperienceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === EXPERIENCE_VERSION && typeof row.id === "string" && /^exp-[A-Za-z0-9]+$/.test(row.id)
    && (row.scope === "personal" || row.scope === "work") && Array.isArray(row.sourceIds) && Array.isArray(row.signalCodes)
    && Array.isArray(row.runIds) && Array.isArray(row.evidenceRecordIds) && Array.isArray(row.evidenceEventIds)
    && typeof row.createdAt === "string" && typeof row.updatedAt === "string";
}

function isExperienceCandidate(value: unknown): value is ExperienceKnowledgeCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === "ikb-knowledge-candidate.v1" && typeof row.id === "string" && /^exp-cand-[A-Za-z0-9]+$/.test(row.id)
    && (row.scope === "personal" || row.scope === "work") && row.status === "pending_review"
    && Array.isArray(row.experienceIds) && Array.isArray(row.sourceIds) && Array.isArray(row.runIds)
    && typeof row.createdAt === "string" && typeof row.updatedAt === "string";
}

function stableRecordFingerprint(record: ExperienceRecord): string {
  return sha256(JSON.stringify({ ...record, createdAt: null, updatedAt: null }));
}

function stableCandidateFingerprint(candidate: ExperienceKnowledgeCandidate): string {
  return sha256(JSON.stringify({ ...candidate, createdAt: null, updatedAt: null }));
}

function emptySignalCounts(): Record<ExperienceSignalCode, number> {
  return Object.fromEntries(SIGNAL_ORDER.map((code) => [code, 0])) as Record<ExperienceSignalCode, number>;
}

function increment(counts: Record<ExperienceSignalCode, number>, code: ExperienceSignalCode): boolean {
  counts[code] += 1;
  return true;
}

function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("Experience triage limit must be a non-negative integer");
  return value === 0 ? Number.POSITIVE_INFINITY : value;
}

function inTimeRange(value: string, from: string | undefined, to: string | undefined): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  return (!from || timestamp >= Date.parse(from)) && (!to || timestamp <= Date.parse(to));
}

function validateTimeRange(from: string | undefined, to: string | undefined): void {
  const fromTimestamp = from ? Date.parse(from) : undefined;
  const toTimestamp = to ? Date.parse(to) : undefined;
  if (fromTimestamp !== undefined && !Number.isFinite(fromTimestamp)) throw new Error(`Invalid Experience --from time: ${from}`);
  if (toTimestamp !== undefined && !Number.isFinite(toTimestamp)) throw new Error(`Invalid Experience --to time: ${to}`);
  if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp > toTimestamp) throw new Error("Experience --from must be less than or equal to --to");
}

function earlier(left: string, right: string): string { return left && left < right ? left : right; }
function later(left: string, right: string): string { return left > right ? left : right; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function isAdapter(value: string): value is ExperienceAdapter { return ["claude", "codex", "desk", "elephant"].includes(value); }

function experienceRoot(home: string): string { return join(resolve(home), "experiences"); }
function candidateRoot(home: string): string { return join(experienceRoot(home), "candidates"); }
function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function assertDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Experience directory must be a real directory: ${path}`);
}
function readJsonFile<T>(path: string): T {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Experience file must be a regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
