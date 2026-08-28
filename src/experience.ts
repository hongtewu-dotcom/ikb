import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { EventRecord, SourceMessage, SourceRecord } from "./types.ts";
import { listSources, readSourceRecords } from "./source.ts";
import type { LedgerStore } from "./store.ts";
import { findLatestExperienceAnalysis, listExperienceValidations, type ExperienceAnalysis, type ExperienceAnalysisDisposition } from "./experience-analysis.ts";
import type { KnowledgeCandidateType, KnowledgeDirectory } from "./knowledge/contracts.ts";
import { findKnowledge, listKnowledge } from "./knowledge/records.ts";
import { validateExtractionBatch, verifyExtractionBatch } from "./extraction-result.ts";

/**
 * Session Triage is intentionally a small, deterministic filter.  It scans
 * normalized human/assistant messages (never tool output by default), keeps
 * only signal counts and evidence references, and does not write Knowledge.
 */
export const EXPERIENCE_VERSION = "ikb-experience.v1";
export const TRIAGE_VERSION = "ikb-experience-triage.v1";
export const CLUSTER_VERSION = "ikb-experience-cluster.v1";
export const EXPERIENCE_SEGMENTATION_VERSION = "ikb-experience-episode.v2";

export type ExperienceSignalCode =
  | "failure_or_block"
  | "retry"
  | "manual_correction"
  | "verifier_rejection"
  | "non_obvious_fix"
  | "knowledge_feedback"
  | "decision_or_rule";

export type ExperienceStatus = "queued" | "analyzed";
export type ExperienceTriageDisposition = "selected" | "ignored";
export type ExperienceExclusionReason = "no_semantic_signal_after_filtering" | "source_outside_active_plane" | "segmentation_superseded";
export type ExperienceCandidateStatus = "pending_review" | "accepted" | "rejected" | "applied";
export type ExperienceAdapter = "claude" | "codex" | "desk" | "elephant";
export type ExperienceAdapterSelection = ExperienceAdapter | "all";
export type ExperienceScope = "personal" | "work";
export type KnowledgeCorrectionAction = "revise" | "retire";

export interface KnowledgeCorrectionRequestInput {
  knowledgeId: string;
  runId: string;
  artifactId: string;
  action: KnowledgeCorrectionAction;
  reason: string;
}

export interface PrincipleAdmissionRequestInput {
  runId: string;
  manifestArtifactId: string;
  compilationArtifactId: string;
  fidelityArtifactId: string;
  caseId: string;
  productId: string;
}

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
  segmentationVersion?: typeof EXPERIENCE_SEGMENTATION_VERSION;
  sourceRecordIds: string[];
  evidenceRecordIds: string[];
  evidenceEventIds: string[];
  runIds: string[];
  validationRefs: string[];
  signalCodes: ExperienceSignalCode[];
  signalCounts: Record<ExperienceSignalCode, number>;
  triageDisposition?: ExperienceTriageDisposition;
  exclusionReasons?: ExperienceExclusionReason[];
  status: ExperienceStatus;
  analysisId?: string;
  analysisRef?: string;
  analysisDisposition?: ExperienceAnalysisDisposition;
  semanticPatternKey?: string | null;
  analyzedAt?: string;
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
  /** Hash of semantic evidence and the proposed use contract, excluding review state. */
  contentHash: string;
  title: string;
  patternKey: string;
  signalCodes: ExperienceSignalCode[];
  analysisIds: string[];
  patternLabel: string;
  claimVariants: string[];
  changeTypes: Array<"new" | "revise" | "retire">;
  targetKnowledgeIds: string[];
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
    claim: string | null;
    type: KnowledgeCandidateType;
    collection: KnowledgeDirectory;
    requiredSections: string[];
    evidenceRefs: string[];
    applicability: string;
    boundary: string;
    useContract: string;
    validationPlan: string;
    confidence: "unknown";
    temporalState: "unknown";
  };
  decision?: {
    outcome: "accepted" | "rejected";
    reason: string;
    candidateContentHash: string;
    /** Exact full draft the user reviewed for a create or revision Candidate. */
    reviewedArtifact?: {
      sourceRef: string;
      ref: string;
      contentHash: string;
    };
    decidedAt: string;
  };
  resolution?: {
    knowledgeIds: string[];
    revisionId: string | null;
    appliedAt: string;
  };
  nextAction: "curator_review_evidence_and_publish_or_reject" | "curate_accepted_candidate_and_apply" | "none";
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
  matchedSessions: number;
  selected: number;
  remainingSelected: number;
  created: number;
  updated: number;
  unchanged: number;
  ignoredSessions: number;
  ignoredUpdated: number;
  inactiveSourceRecords: number;
  skippedToolRecords: number;
  skippedNonEventRecords: number;
  feedbackSelected: number;
  feedbackCreated: number;
  feedbackUpdated: number;
  feedbackUnchanged: number;
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
    independentRunKeys: string[];
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

const FAILURE_RE = /(?:\bfailed\b|\bblocked\b|\btimed?\s*out\b|\bexception\b|\b(?:an?|the)\s+error\b|\berror\s*(?:code|message|[:=]|\d)|(?:当前|本次|刚才|实际|仍然|已经|结果|执行|运行|构建|编译|测试|请求|调用|命令|部署|读取|写入|解析|安装|登录|鉴权|接口|服务|任务|步骤|返回|出现|发生|确认|导致|验收|校验|门禁)[^，。；;\n]{0,20}(?:失败|报错|错误|异常|阻断|超时|不通过|不可用|挂了|找不到|未部署|无权限)|(?:失败|报错|错误|异常|阻断|超时|不通过)[^，。；;\n]{0,12}(?:了|中|原因|根因|发生|出现|返回|导致|当前|本次)|[\w./-]{2,30}\s+失败|(?:错误|异常)(?:码|信息)[:：]?\s*[\w-]+|找不到|未找到|不存在|未部署|无权限|不可用|挂了)/iu;
const RETRY_RE = /(?:\bretried\b|\bretrying\b|\bre-?ran\b|\brerun(?:ning)?\b|正在重试|再次重试|重试(?:了|后|中|一下|一次)|重新(?:运行|执行|跑|构建|部署)|重跑(?:了|后|中|一下|一次)|再跑一次|重做(?:了|后|一次)|(?:恢复后|稍后|之后|下个[^，。；;\n]{0,8})重试)/iu;
const CORRECTION_RE = /(?:纠正|纠偏|修正|不对|失真|不要.*(?:这样|硬搞|直接)|应该.*(?:而不是|改成)|重写|重新搞|不应该)/iu;
const VERIFIER_RE = /(?:\bverifier\b|\bverify\b|验收|校验|质量门禁|\blint\b|\bdoctor\b|验证)/iu;
const REJECTION_RE = /(?:\breject(?:ed|ion)?\b|\bpartial\b|\bincorrect\b|\bblock(?:ed)?\b|驳回|拒绝|不通过|未通过|阻断)/iu;
const FIX_RE = /(?:修复|\bfix(?:ed|es)?\b|根因|兼容|回归|幂等|边界|补.*校验|补.*检查|收敛|落地|修好)/iu;
const DECISION_RE = /(?:我(?:们)?决定|已决定|确认采用|最终采用|最终方案|后续(?:都|统一)|以后(?:都|要)|统一(?:使用|改为|按|收口)|明确要求|禁止|不得|不允许|只允许|只能|只读|不采用|准入(?:标准|条件)|停止条件)/iu;

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
  const existingById = new Map(listExperienceRecords(home).map((record) => [record.id, record]));
  const sourceIndex = new Map(sources.map((source) => [source.id, source]));
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

  const episodes = [...sessions.values()].flatMap((session) => segmentSession(session, sourceIndex));
  const selected: ExperienceRecord[] = [];
  const ignored: ExperienceRecord[] = [];
  let skippedNonEventRecords = 0;
  for (const session of episodes) {
    const triaged = triageSession(session, eventIndex);
    skippedNonEventRecords += triaged.skippedNonEventRecords;
    if (triaged.record.triageDisposition === "selected") selected.push(triaged.record);
    else ignored.push(triaged.record);
  }
  selected.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.id.localeCompare(right.id));
  const limited = selected.slice(0, limit);
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let ignoredUpdated = 0;
  const experienceEvents: Array<{ id: string; eventType: "experience.queued" | "experience.updated" | "experience.ignored" | "experience.analysis_invalidated"; payload: Record<string, unknown> }> = [];
  const records: TriageResult["records"] = [];
  for (const record of limited) {
    const outcome = writeExperienceRecord(home, record);
    if (outcome.analysisInvalidated) {
      experienceEvents.push({ id: record.id, eventType: "experience.analysis_invalidated", payload: {
        previousAnalysisId: outcome.previousAnalysisId,
        reason: "source_or_triage_changed",
        sourceOriginHash: record.sourceOriginHash,
      } });
    }
    if (outcome.state === "created") {
      created += 1;
      experienceEvents.push({ id: record.id, eventType: "experience.queued", payload: experienceEventPayload(record) });
    } else if (outcome.state === "updated") {
      updated += 1;
      experienceEvents.push({ id: record.id, eventType: "experience.updated", payload: experienceEventPayload(record) });
    } else unchanged += 1;
    records.push({ id: record.id, sourceTitle: record.sourceTitle, adapter: record.adapter, signalCodes: record.signalCodes, runIds: record.runIds, status: record.status });
  }
  for (const record of ignored) {
    if (!existingById.has(record.id)) continue;
    const outcome = writeExperienceRecord(home, record);
    if (outcome.analysisInvalidated) {
      experienceEvents.push({ id: record.id, eventType: "experience.analysis_invalidated", payload: {
        previousAnalysisId: outcome.previousAnalysisId,
        reason: "triage_disposition_changed",
        sourceOriginHash: record.sourceOriginHash,
      } });
    }
    if (outcome.state === "updated") {
      ignoredUpdated += 1;
      experienceEvents.push({ id: record.id, eventType: "experience.ignored", payload: experienceEventPayload(record) });
    }
  }
  const activeSourceIds = new Set(sources.map((source) => source.id));
  const activeSessionIds = new Set([...selected, ...ignored].map((record) => record.id));
  const inactiveRecords = options.from === undefined && options.to === undefined
    ? [...existingById.values()].filter((record) => (
      (scope === "all" || record.scope === scope)
      && (adapter === "all" || record.adapter === adapter)
      && !activeSessionIds.has(record.id)
      && (
        record.segmentationVersion !== EXPERIENCE_SEGMENTATION_VERSION
        || (record.sourceIds.length > 0 && record.sourceIds.every((sourceId) => !activeSourceIds.has(sourceId)))
      )
    ))
    : [];
  for (const existing of inactiveRecords) {
    const sourceLeftActivePlane = existing.sourceIds.length > 0 && existing.sourceIds.every((sourceId) => !activeSourceIds.has(sourceId));
    const record: ExperienceRecord = {
      ...existing,
      evidenceRecordIds: [],
      signalCodes: [],
      signalCounts: emptySignalCounts(),
      triageDisposition: "ignored",
      exclusionReasons: sourceLeftActivePlane ? ["source_outside_active_plane"] : ["segmentation_superseded"],
      updatedAt: new Date().toISOString(),
    };
    const outcome = writeExperienceRecord(home, record);
    if (outcome.analysisInvalidated) {
      experienceEvents.push({ id: record.id, eventType: "experience.analysis_invalidated", payload: {
        previousAnalysisId: outcome.previousAnalysisId,
        reason: "source_left_active_plane",
        sourceOriginHash: record.sourceOriginHash,
      } });
    }
    if (outcome.state === "updated") {
      ignoredUpdated += 1;
      experienceEvents.push({ id: record.id, eventType: "experience.ignored", payload: experienceEventPayload(record) });
    }
  }
  let feedbackSelected = 0;
  let feedbackCreated = 0;
  let feedbackUpdated = 0;
  let feedbackUnchanged = 0;
  let unmappedFeedbackEvents = 0;
  if (adapter === "all") {
    for (const event of eventIndex.orphanFeedbackEvents) {
      const record = feedbackExperienceRecord(home, store, event, scope);
      if (!record) {
        unmappedFeedbackEvents += 1;
        continue;
      }
      feedbackSelected += 1;
      const outcome = writeExperienceRecord(home, record);
      if (outcome.analysisInvalidated) {
        experienceEvents.push({ id: record.id, eventType: "experience.analysis_invalidated", payload: {
          previousAnalysisId: outcome.previousAnalysisId,
          reason: "feedback_evidence_changed",
          sourceOriginHash: record.sourceOriginHash,
        } });
      }
      if (outcome.state === "created") {
        created += 1;
        feedbackCreated += 1;
        experienceEvents.push({ id: record.id, eventType: "experience.queued", payload: experienceEventPayload(record) });
      } else if (outcome.state === "updated") {
        updated += 1;
        feedbackUpdated += 1;
        experienceEvents.push({ id: record.id, eventType: "experience.updated", payload: experienceEventPayload(record) });
      } else {
        unchanged += 1;
        feedbackUnchanged += 1;
      }
      records.push({ id: record.id, sourceTitle: record.sourceTitle, adapter: record.adapter, signalCodes: record.signalCodes, runIds: record.runIds, status: record.status });
    }
  }
  store.recordExperienceEvents(experienceEvents);
  return {
    schema: TRIAGE_VERSION,
    scope,
    adapter,
    scannedSources: sources.length,
    scannedSessions: episodes.length,
    matchedSessions: selected.length,
    selected: limited.length + feedbackSelected,
    remainingSelected: Math.max(0, selected.length - limited.length),
    created,
    updated,
    unchanged,
    ignoredSessions: ignored.length,
    ignoredUpdated,
    inactiveSourceRecords: inactiveRecords.length,
    skippedToolRecords,
    skippedNonEventRecords,
    feedbackSelected,
    feedbackCreated,
    feedbackUpdated,
    feedbackUnchanged,
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

export function markExperienceAnalyzed(home: string, analysis: ExperienceAnalysis): ExperienceRecord {
  const record = findExperienceRecord(home, analysis.experienceId);
  if (!record) throw new Error(`Experience Record not found: ${analysis.experienceId}`);
  if (record.triageDisposition === "ignored") throw new Error(`Ignored Experience cannot be marked analyzed: ${record.id}`);
  if (record.sourceOriginHash !== analysis.sourceOriginHash) throw new Error(`Experience Analysis ${analysis.id} is stale for ${record.id}`);
  const updated: ExperienceRecord = {
    ...record,
    status: "analyzed",
    analysisId: analysis.id,
    analysisRef: analysis.revisionRef,
    analysisDisposition: analysis.disposition,
    semanticPatternKey: analysis.candidate?.patternKey ?? null,
    analyzedAt: analysis.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeExperienceRecord(home, updated, { preserveAnalysis: false });
  return updated;
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

/**
 * Creates the existing fail-closed Candidate hold from an explicit, immutable
 * correction request. It intentionally leaves the target Knowledge untouched:
 * only review/application may revise or retire it later.
 */
export function requestKnowledgeCorrection(
  home: string,
  store: LedgerStore,
  input: KnowledgeCorrectionRequestInput,
): { outcome: "created" | "updated" | "unchanged"; candidate: ExperienceKnowledgeCandidate } {
  if (input.action !== "revise" && input.action !== "retire") {
    throw new Error("Knowledge correction action must be revise or retire");
  }
  const reason = input.reason.trim();
  if (!reason) throw new Error("Knowledge correction reason must not be empty");
  const target = findKnowledge(home, input.knowledgeId);
  if (!target) throw new Error(`Knowledge not found: ${input.knowledgeId}`);
  const run = store.requireRun(input.runId);
  const task = store.requireTask(run.taskId);
  if (task.scope !== target.scope) {
    throw new Error(`Knowledge scope ${target.scope} does not match Task scope ${task.scope}`);
  }
  const artifact = requireCompleteRunArtifact(store, run.id, input.artifactId);
  const sourceIds = [...new Set(target.sourceRefs
    .map((reference) => reference.match(/^(src-[A-Za-z0-9-]+)/)?.[1] ?? null)
    .filter((sourceId): sourceId is string => sourceId !== null))].sort();
  const candidateId = `exp-cand-${sha256([target.id, run.id, artifact.id, artifact.contentHash, input.action, reason].join("|")) .slice(0, 12)}`;
  const now = new Date().toISOString();
  const artifactRef = `artifact:${artifact.id}`;
  const candidate: ExperienceKnowledgeCandidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: candidateId,
    scope: target.scope,
    status: "pending_review",
    contentHash: "",
    title: `待复核知识${input.action === "revise" ? "修订" : "退役"}：${target.title}`,
    patternKey: `knowledge.correction.${target.id.toLowerCase()}.${input.action}`,
    signalCodes: ["manual_correction", "knowledge_feedback"],
    analysisIds: [],
    patternLabel: `显式纠错请求：${target.id}`,
    claimVariants: [reason],
    changeTypes: [input.action],
    targetKnowledgeIds: [target.id],
    experienceIds: [],
    sourceIds,
    sourceRecordRefs: [artifactRef],
    evidenceEventIds: [],
    runIds: [run.id],
    validationRefs: [artifact.id],
    independentRunCount: 1,
    independentSourceCount: Math.max(1, sourceIds.length),
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: reason,
      type: target.type as KnowledgeCandidateType,
      collection: target.collection as KnowledgeDirectory,
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan", "confidence", "temporal state"],
      evidenceRefs: [...sourceIds, artifactRef],
      applicability: `复核 ${target.id} 是否应${input.action === "revise" ? "修订" : "退役"}。`,
      boundary: `仅隔离目标 Knowledge；原因：${reason}`,
      useContract: "P0 correction review。",
      validationPlan: "核验同 Run Artifact、评审结论与默认检索 hold。",
      confidence: "unknown",
      temporalState: "unknown",
    },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: now,
    updatedAt: now,
  };
  candidate.contentHash = candidateContentHash(candidate);
  const outcome = writeExperienceCandidate(home, candidate);
  const stored = findExperienceCandidate(home, candidate.id);
  if (!stored) throw new Error(`Knowledge correction Candidate was not persisted: ${candidate.id}`);
  if (outcome === "created") store.recordExperienceEvent(stored.id, "experience.candidate_created", candidateEventPayload(stored));
  else if (outcome === "updated") store.recordExperienceEvent(stored.id, "experience.candidate_updated", candidateEventPayload(stored));
  return { outcome, candidate: stored };
}

/**
 * Creates a review-only Principle Candidate from one publishable QV5 product.
 *
 * Source intake and Principle admission are deliberately separate. This entry
 * point accepts only an immutable manifest/result/fidelity triple from one Run,
 * recomputes both validation and information loss, and leaves the result in
 * pending_review. It never writes Knowledge or grants user_confirmed status.
 */
export function requestPrincipleAdmission(
  home: string,
  store: LedgerStore,
  input: PrincipleAdmissionRequestInput,
): { outcome: "created" | "updated" | "unchanged"; candidate: ExperienceKnowledgeCandidate } {
  const run = store.requireRun(input.runId);
  const task = store.requireTask(run.taskId);
  const manifestArtifact = requireCompleteRunArtifact(store, run.id, input.manifestArtifactId, "Principle manifest");
  const compilationArtifact = requireCompleteRunArtifact(store, run.id, input.compilationArtifactId, "Principle compilation");
  const fidelityArtifact = requireCompleteRunArtifact(store, run.id, input.fidelityArtifactId, "Principle fidelity");
  if (manifestArtifact.kind !== "knowledge-extraction-manifest") throw new Error("Principle manifest Artifact has the wrong kind");
  if (compilationArtifact.kind !== "knowledge-extraction-result") throw new Error("Principle compilation Artifact has the wrong kind");
  if (fidelityArtifact.kind !== "knowledge-extraction-fidelity") throw new Error("Principle fidelity Artifact has the wrong kind");

  const manifest = readJsonFile<unknown>(manifestArtifact.path);
  const compilation = readJsonFile<unknown>(compilationArtifact.path);
  const results = normalizeExtractionResults(compilation);
  const validation = validateExtractionBatch(manifest, results);
  if (!validation.valid) throw new Error("Principle QV5 extraction validation is not valid");
  const fidelity = verifyExtractionBatch(manifest, results);
  const storedFidelity = readJsonFile<unknown>(fidelityArtifact.path);
  if (stableJson(storedFidelity) !== stableJson(fidelity)) {
    throw new Error("Principle stored information loss report does not match recomputed fidelity");
  }
  const verdict = fidelity.verdicts.find((item) => item.caseId === input.caseId);
  if (!fidelity.valid || !verdict || verdict.legacy || !verdict.publishable || verdict.disposition !== "admit") {
    throw new Error(`Principle extraction case is not publishable: ${input.caseId}`);
  }

  const manifestCase = objectArray(objectValue(manifest)?.cases)
    .find((value) => stringValue(value.case_id) === input.caseId);
  const result = objectArray(results)
    .find((value) => stringValue(value.case_id) === input.caseId);
  if (!manifestCase || !result) throw new Error(`Principle extraction case not found: ${input.caseId}`);
  const product = objectArray(result.products)
    .find((value) => stringValue(value.product_id) === input.productId);
  if (!product) throw new Error(`Principle compilation product not found: ${input.productId}`);
  if (stringValue(product.product_type) !== "principle_card") throw new Error("Principle admission requires product_type=principle_card");
  if (stringValue(product.operation) !== "new") throw new Error("Principle admission currently accepts only new products");
  const principle = objectValue(product.principle);
  const statement = stringValue(principle?.statement);
  const canonicalKey = stringValue(product.canonical_key);
  if (!principle || !statement || !canonicalKey) throw new Error("Principle product is missing statement or canonical_key");
  if (!canonicalKey.startsWith(`${task.scope}:principle:`)) throw new Error(`Principle canonical_key must start with ${task.scope}:principle:`);
  const duplicate = listKnowledge(home, task.scope)
    .find((knowledge) => knowledge.status !== "retired" && knowledge.canonicalKey === canonicalKey);
  if (duplicate) throw new Error(`Active Principle canonical_key already exists: ${duplicate.id}`);

  const sourceIds = stringArray(manifestCase.source_ids);
  if (sourceIds.length === 0) throw new Error("Principle extraction case has no Source ids");
  for (const sourceId of sourceIds) {
    const source = listSources(home).find((value) => value.id === sourceId);
    if (!source) throw new Error(`Principle Source not found: ${sourceId}`);
    if (source.scope !== task.scope) throw new Error(`Principle Source ${sourceId} scope does not match Task scope ${task.scope}`);
  }

  const triggers = stringArray(principle.triggers);
  const scopes = stringArray(principle.scope);
  const exceptions = stringArray(principle.exceptions);
  const validationPlan = stringArray(product.verification_plan);
  const evidenceRecordIds = unique(objectArray(result.evidence_units)
    .map((value) => stringValue(value.record_id) ?? "")
    .filter(Boolean));
  const candidateId = `exp-cand-${sha256(`${task.scope}|principle|${canonicalKey}`).slice(0, 12)}`;
  const now = new Date().toISOString();
  const candidate: ExperienceKnowledgeCandidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: candidateId,
    scope: task.scope as ExperienceScope,
    status: "pending_review",
    contentHash: "",
    title: `待复核原则：${stringValue(product.title) ?? statement}`,
    patternKey: canonicalKey,
    signalCodes: ["decision_or_rule"],
    analysisIds: [],
    patternLabel: stringValue(product.title) ?? statement,
    claimVariants: [statement],
    changeTypes: ["new"],
    targetKnowledgeIds: [],
    experienceIds: [],
    sourceIds,
    sourceRecordRefs: evidenceRecordIds,
    evidenceEventIds: [],
    runIds: [run.id],
    validationRefs: [fidelityArtifact.id],
    independentRunCount: 1,
    independentSourceCount: sourceIds.length,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: statement,
      type: "principle",
      collection: "principles",
      requiredSections: ["claim", "evidence", "triggers", "applicability", "boundary", "exceptions", "use contract", "validation plan", "retirement signals", "relations", "confidence", "temporal state"],
      evidenceRefs: [...sourceIds, ...evidenceRecordIds, `artifact:${manifestArtifact.id}`, `artifact:${compilationArtifact.id}`, `artifact:${fidelityArtifact.id}`],
      applicability: [...triggers, ...scopes].join("；"),
      boundary: [...stringArray(product.boundaries), ...exceptions].join("；"),
      useContract: triggers.join("；"),
      validationPlan: validationPlan.join("；"),
      confidence: "unknown",
      temporalState: "unknown",
    },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: now,
    updatedAt: now,
  };
  candidate.contentHash = candidateContentHash(candidate);
  const outcome = writeExperienceCandidate(home, candidate);
  const stored = findExperienceCandidate(home, candidate.id);
  if (!stored) throw new Error(`Principle Candidate was not persisted: ${candidate.id}`);
  if (outcome === "created") store.recordExperienceEvent(stored.id, "experience.candidate_created", candidateEventPayload(stored));
  else if (outcome === "updated") store.recordExperienceEvent(stored.id, "experience.candidate_updated", candidateEventPayload(stored));
  return { outcome, candidate: stored };
}

export function decideExperienceCandidate(
  home: string,
  store: LedgerStore,
  id: string,
  input: { decision: "accept" | "reject"; reason: string; reviewedArtifactPath?: string },
): { outcome: "updated" | "unchanged"; candidate: ExperienceKnowledgeCandidate } {
  const candidate = findExperienceCandidate(home, id);
  if (!candidate) throw new Error(`Experience Candidate not found: ${id}`);
  const reason = input.reason.trim();
  if (!reason) throw new Error("Experience Candidate decision requires a non-empty reason");
  const status = input.decision === "accept" ? "accepted" : "rejected";
  const needsReviewedArtifact = status === "accepted"
    && candidate.changeTypes.some((changeType) => changeType === "new" || changeType === "revise");
  const reviewedArtifact = input.reviewedArtifactPath
    ? reviewedArtifactForDecision(home, candidate.id, input.reviewedArtifactPath)
    : undefined;
  if (candidate.status !== "pending_review") {
    if (candidate.status === status && candidate.decision?.reason === reason) {
      if (reviewedArtifact && (
        candidate.decision?.reviewedArtifact?.ref !== reviewedArtifact.ref
        || candidate.decision.reviewedArtifact.contentHash !== reviewedArtifact.contentHash
      )) throw new Error(`Experience Candidate ${id} was accepted against a different reviewed artifact`);
      ensureCandidateLifecycleEvent(store, candidate, status === "accepted" ? "experience.candidate_accepted" : "experience.candidate_rejected");
      return { outcome: "unchanged", candidate };
    }
    throw new Error(`Experience Candidate ${id} is already ${candidate.status}`);
  }
  if (needsReviewedArtifact && !reviewedArtifact) {
    throw new Error(`Experience Candidate ${id} creates or revises Knowledge; acceptance requires --file with the complete reviewed Knowledge draft`);
  }
  if (status === "rejected" && reviewedArtifact) throw new Error("A rejected Experience Candidate does not accept --file");
  const now = new Date().toISOString();
  const updated: ExperienceKnowledgeCandidate = {
    ...candidate,
    contentHash: candidate.contentHash || candidateContentHash(candidate),
    status,
    decision: {
      outcome: status,
      reason,
      candidateContentHash: candidate.contentHash || candidateContentHash(candidate),
      reviewedArtifact,
      decidedAt: now,
    },
    nextAction: status === "accepted" ? "curate_accepted_candidate_and_apply" : "none",
    updatedAt: now,
  };
  writeJson(join(candidateRoot(home), `${id}.json`), updated);
  ensureCandidateLifecycleEvent(store, updated, status === "accepted" ? "experience.candidate_accepted" : "experience.candidate_rejected");
  return { outcome: "updated", candidate: updated };
}

export function markExperienceCandidateApplied(
  home: string,
  store: LedgerStore,
  id: string,
  resolution: { knowledgeIds: string[]; revisionId: string | null },
): { outcome: "updated" | "unchanged"; candidate: ExperienceKnowledgeCandidate } {
  const candidate = findExperienceCandidate(home, id);
  if (!candidate) throw new Error(`Experience Candidate not found: ${id}`);
  const knowledgeIds = unique(resolution.knowledgeIds);
  if (knowledgeIds.length === 0) throw new Error("Applied Experience Candidate requires at least one Knowledge id");
  if (candidate.status === "applied") {
    const same = JSON.stringify(candidate.resolution?.knowledgeIds ?? []) === JSON.stringify(knowledgeIds)
      && (candidate.resolution?.revisionId ?? null) === resolution.revisionId;
    if (same) {
      ensureCandidateLifecycleEvent(store, candidate, "experience.candidate_applied");
      return { outcome: "unchanged", candidate };
    }
    throw new Error(`Experience Candidate ${id} is already applied with a different resolution`);
  }
  if (candidate.status !== "accepted") throw new Error(`Experience Candidate ${id} must be accepted before it can be applied`);
  if (candidate.decision?.candidateContentHash !== candidate.contentHash) throw new Error(`Experience Candidate ${id} decision is stale`);
  const now = new Date().toISOString();
  const updated: ExperienceKnowledgeCandidate = {
    ...candidate,
    status: "applied",
    resolution: { knowledgeIds, revisionId: resolution.revisionId, appliedAt: now },
    nextAction: "none",
    updatedAt: now,
  };
  writeJson(join(candidateRoot(home), `${id}.json`), updated);
  ensureCandidateLifecycleEvent(store, updated, "experience.candidate_applied");
  return { outcome: "updated", candidate: updated };
}

export function clusterExperienceRecords(home: string, store: LedgerStore, options: ClusterOptions = {}): ClusterResult {
  const scope = options.scope ?? "all";
  const minimumSamples = options.minimumSamples ?? 3;
  if (!Number.isInteger(minimumSamples) || minimumSamples < 2) throw new Error("Experience cluster minimumSamples must be an integer >= 2");
  const activeSourceIds = new Set(listSources(home).map((source) => source.id));
  const records = listExperienceRecords(home, scope === "all" ? undefined : scope)
    .filter((record) => record.triageDisposition !== "ignored")
    .filter((record) => record.status === "analyzed" && record.analysisDisposition === "candidate" && Boolean(record.semanticPatternKey))
    .filter((record) => record.sourceIds.length === 0 || record.sourceIds.every((sourceId) => activeSourceIds.has(sourceId)));
  const groups = new Map<string, Array<{ record: ExperienceRecord; analysis: ExperienceAnalysis }>>();
  for (const record of records) {
    const analysis = findLatestExperienceAnalysis(home, record);
    if (!analysis || analysis.disposition !== "candidate" || !analysis.candidate) continue;
    const patternKey = analysis.candidate.patternKey;
    const list = groups.get(`${record.scope}|${patternKey}`) ?? [];
    list.push({ record, analysis });
    groups.set(`${record.scope}|${patternKey}`, list);
  }
  const pending: ClusterResult["pending"] = [];
  const candidates: ExperienceKnowledgeCandidate[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [groupKey, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [groupScope, patternKey] = groupKey.split("|", 2) as [ExperienceScope, string];
    const runIds = unique(group.flatMap(({ record }) => record.runIds));
    // A time-bounded Episode is an analysis unit, not an independent reproduction.
    // Imported Agent history uses the top-level conversation as the Run identity;
    // event-backed Experiences derive conversationIdHash from the real IKB Run id.
    // Counting sessionKeyHash here would let one long conversation satisfy the
    // promotion gate merely because Triage split it into several Episodes.
    const independentRunKeys = unique(group.map(({ record }) => record.conversationIdHash));
    const independentSourceKeys = unique(group.map(({ record }) => record.sourceOriginHash));
    const sourceIds = unique(group.flatMap(({ record }) => record.sourceIds));
    const validationRefs = unique(group.flatMap(({ record }) => listExperienceValidations(home, record)
      .filter((validation) => validation.result === "pass")
      .map((validation) => validation.id)));
    const experienceIds = unique(group.map(({ record }) => record.id));
    const signalCodes = SIGNAL_ORDER.filter((code) => group.some(({ record }) => record.signalCodes.includes(code)));
    const candidateShapes = unique(group.map(({ analysis }) => `${analysis.candidate!.knowledgeType}|${analysis.candidate!.collection}`));
    if (candidateShapes.length !== 1) {
      pending.push({
        patternKey,
        signalCodes,
        experienceIds,
        sourceIds,
        runIds,
        independentRunKeys,
        validationRefs,
        independentRunCount: independentRunKeys.length,
        required: `同一模式的分析必须收敛到同一种 Knowledge 类型和目录；当前为 ${candidateShapes.join(", ")}`,
      });
      continue;
    }
    const correctionCandidate = group.every(({ analysis }) => analysis.candidate?.changeType === "revise" || analysis.candidate?.changeType === "retire");
    const eligible = correctionCandidate || independentRunKeys.length >= minimumSamples || (independentRunKeys.length >= 2 && validationRefs.length > 0);
    if (!eligible) {
      pending.push({
        patternKey,
        signalCodes,
        experienceIds,
        sourceIds,
        runIds,
        independentRunKeys,
        validationRefs,
        independentRunCount: independentRunKeys.length,
        required: correctionCandidate
          ? "one direct counterexample with an existing Knowledge target and human review"
          : `${minimumSamples} independent agent Runs, or 2 independent agent Runs + 1 analysis-specific Artifact validation`,
      });
      continue;
    }
    const targetScopes = unique(group.flatMap(({ analysis }) => analysis.candidate?.targetKnowledgeIds ?? [])
      .map((knowledgeId) => findKnowledge(home, knowledgeId)?.scope ?? ""));
    if (targetScopes.length > 1) throw new Error(`Experience correction Candidate ${patternKey} targets Knowledge across scopes: ${targetScopes.join(", ")}`);
    const candidateScope = correctionCandidate && targetScopes.length === 1 ? targetScopes[0] as ExperienceScope : groupScope;
    const candidate = makeKnowledgeCandidate(candidateScope, groupScope, patternKey, group, runIds, sourceIds, validationRefs, independentRunKeys.length, independentSourceKeys.length);
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
  orphanFeedbackEvents: EventRecord[];
}

function triageSession(session: SessionAccumulator, eventIndex: EventIndex): { record: ExperienceRecord; skippedNonEventRecords: number } {
  const signalCounts = emptySignalCounts();
  const evidenceRecordIds: string[] = [];
  const evidenceEventIds = new Set<string>();
  const automatedPromptOnly = isAutomatedPromptOnlySession(session.records);
  let skippedNonEventRecords = 0;
  for (const record of session.records) {
    const content = automatedPromptOnly ? null : signalContent(record);
    if (content === null) {
      skippedNonEventRecords += 1;
      continue;
    }
    const human = isHumanRecord(record);
    let found = false;
    if (hasFailureSignal(content)) found = increment(signalCounts, "failure_or_block");
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
  const triageDisposition: ExperienceTriageDisposition = signalCodes.length > 0 ? "selected" : "ignored";
  const sourceOriginHash = sha256([...session.sourceOriginHashes].sort().join("|"));
  const id = `exp-${sha256(session.sessionKey).slice(0, 12)}`;
  const now = new Date().toISOString();
  return {
    record: {
      schema: EXPERIENCE_VERSION,
      id,
      scope: session.scope,
      adapter: session.adapter,
      sourceTitle: [...session.sourceTitles].sort()[0] ?? "未命名会话",
      sourceIds,
      sourceOriginHash,
      sessionKeyHash: sha256(session.sessionKey).slice(0, 32),
      conversationIdHash: sha256(session.conversationId).slice(0, 32),
      segmentationVersion: EXPERIENCE_SEGMENTATION_VERSION,
      sourceRecordIds: [...session.sourceRecordIds].sort(),
      evidenceRecordIds: triageDisposition === "selected" ? unique(evidenceRecordIds) : [],
      evidenceEventIds: [...evidenceEventIds].sort(),
      runIds,
      validationRefs,
      signalCodes: triageDisposition === "selected" ? signalCodes : [],
      signalCounts: triageDisposition === "selected" ? signalCounts : emptySignalCounts(),
      triageDisposition,
      exclusionReasons: triageDisposition === "ignored" ? ["no_semantic_signal_after_filtering"] : [],
      status: "queued",
      firstSeenAt: session.firstSeenAt,
      lastSeenAt: session.lastSeenAt,
      createdAt: now,
      updatedAt: now,
    },
    skippedNonEventRecords,
  };
}

function makeKnowledgeCandidate(
  scope: ExperienceScope,
  idScope: ExperienceScope,
  patternKey: string,
  group: Array<{ record: ExperienceRecord; analysis: ExperienceAnalysis }>,
  runIds: string[],
  sourceIds: string[],
  validationRefs: string[],
  independentRunCount: number,
  independentSourceCount: number,
): ExperienceKnowledgeCandidate {
  const experienceIds = unique(group.map(({ record }) => record.id));
  const evidenceEventIds = unique(group.flatMap(({ analysis }) => analysis.findings.flatMap((finding) => finding.evidenceEventIds)));
  const sourceRecordRefs = unique(group.flatMap(({ record, analysis }) => analysis.findings.flatMap((finding) => finding.evidenceRecordIds.map((recordId) => sourceRecordRef(recordId, record.sourceIds)))));
  const signalCodes = SIGNAL_ORDER.filter((code) => group.some(({ record }) => record.signalCodes.includes(code)));
  const analysisIds = unique(group.map(({ analysis }) => analysis.id));
  const patternLabels = unique(group.map(({ analysis }) => analysis.candidate?.patternLabel ?? patternKey));
  const claimVariants = unique(group.map(({ analysis }) => analysis.candidate?.canonicalClaim ?? "").filter(Boolean));
  const changeTypes = unique(group.map(({ analysis }) => analysis.candidate?.changeType ?? "new")) as Array<"new" | "revise" | "retire">;
  const targetKnowledgeIds = unique(group.flatMap(({ analysis }) => analysis.candidate?.targetKnowledgeIds ?? []));
  const applicabilityVariants = unique(group.map(({ analysis }) => analysis.candidate?.applicability ?? "").filter(Boolean));
  const boundaryVariants = unique(group.map(({ analysis }) => analysis.candidate?.boundary ?? "").filter(Boolean));
  const useWhenVariants = unique(group.map(({ analysis }) => analysis.candidate?.useWhen ?? "").filter(Boolean));
  const validationPlanVariants = unique(group.map(({ analysis }) => analysis.candidate?.validationPlan ?? "").filter(Boolean));
  const knowledgeTypes = unique(group.map(({ analysis }) => analysis.candidate?.knowledgeType ?? "lesson"));
  const collections = unique(group.map(({ analysis }) => analysis.candidate?.collection ?? "lessons"));
  if (knowledgeTypes.length !== 1 || collections.length !== 1) {
    throw new Error(`Experience Candidate ${patternKey} has conflicting Knowledge shapes`);
  }
  // Keep the id tied to the originating Experience group so correcting an
  // older scope classification updates one Candidate instead of duplicating it.
  const candidateId = `exp-cand-${sha256(`${idScope}|${patternKey}`).slice(0, 12)}`;
  const now = new Date().toISOString();
  const candidate: ExperienceKnowledgeCandidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: candidateId,
    scope,
    status: "pending_review",
    contentHash: "",
    title: `${changeTypes.some((value) => value !== "new") ? "待复核知识修订" : "待复核经验模式"}：${patternLabels.join(" / ")}`,
    patternKey,
    signalCodes,
    analysisIds,
    patternLabel: patternLabels.join(" / "),
    claimVariants,
    changeTypes,
    targetKnowledgeIds,
    experienceIds,
    sourceIds,
    sourceRecordRefs,
    evidenceEventIds,
    runIds,
    validationRefs,
    independentRunCount,
    independentSourceCount,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: claimVariants.length === 1 ? claimVariants[0] : null,
      type: knowledgeTypes[0] as KnowledgeCandidateType,
      collection: collections[0] as KnowledgeDirectory,
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan", "confidence", "temporal state"],
      evidenceRefs: [...sourceRecordRefs, ...evidenceEventIds],
      applicability: applicabilityVariants.length === 1 ? applicabilityVariants[0] : `需合并 ${applicabilityVariants.length} 个适用范围变体`,
      boundary: boundaryVariants.length === 1 ? boundaryVariants[0] : `需合并 ${boundaryVariants.length} 个边界变体`,
      useContract: useWhenVariants.length === 1 ? useWhenVariants[0] : `需合并 ${useWhenVariants.length} 个使用触发变体`,
      validationPlan: validationPlanVariants.length === 1 ? validationPlanVariants[0] : `需合并 ${validationPlanVariants.length} 个验证方案变体`,
      confidence: "unknown",
      temporalState: "unknown",
    },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: now,
    updatedAt: now,
  };
  candidate.contentHash = candidateContentHash(candidate);
  return candidate;
}

function buildEventIndex(events: EventRecord[]): EventIndex {
  const bySourceId = new Map<string, EventRecord[]>();
  const runToSources = new Map<string, Set<string>>();
  const orphanFeedbackEvents: EventRecord[] = [];
  const directSources = new Map<EventRecord, Set<string>>();
  const latestFeedbackByKnowledgeRun = new Map<string, EventRecord>();
  // First establish the explicit Run -> Source edges.  A verification event
  // often carries only its Run aggregate id; indexing it in a second pass
  // prevents us from losing the validation evidence for that session.
  for (const event of events) {
    if (event.aggregateType === "knowledge" && event.eventType === "knowledge.feedback_recorded") {
      const runId = stringValue(event.payload.runId);
      latestFeedbackByKnowledgeRun.set(`${event.aggregateId}|${runId ?? event.eventId}`, event);
    }
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
    if (event.aggregateType === "knowledge" && event.eventType === "knowledge.feedback_recorded") {
      const runId = stringValue(event.payload.runId);
      const latest = latestFeedbackByKnowledgeRun.get(`${event.aggregateId}|${runId ?? event.eventId}`);
      if (latest?.eventId !== event.eventId) continue;
    }
    const sourceIds = new Set(directSources.get(event) ?? []);
    const runIds: string[] = [];
    if (event.aggregateType === "run") runIds.push(event.aggregateId);
    const payloadRunId = stringValue(event.payload.runId);
    if (payloadRunId) runIds.push(payloadRunId);
    for (const runId of runIds) {
      for (const sourceId of runToSources.get(runId) ?? []) sourceIds.add(sourceId);
    }
    if (event.eventType === "knowledge.feedback_recorded" && ["partial", "incorrect"].includes(String(event.payload.outcome)) && sourceIds.size === 0) {
      orphanFeedbackEvents.push(event);
    }
    for (const sourceId of sourceIds) {
      const list = bySourceId.get(sourceId) ?? [];
      list.push(event);
      bySourceId.set(sourceId, list);
    }
  }
  return { bySourceId, runToSources, orphanFeedbackEvents };
}

function feedbackExperienceRecord(
  home: string,
  store: LedgerStore,
  event: EventRecord,
  requestedScope: ExperienceScope | "all",
): ExperienceRecord | null {
  if (event.aggregateType !== "knowledge" || event.eventType !== "knowledge.feedback_recorded") return null;
  if (!["partial", "incorrect"].includes(String(event.payload.outcome))) return null;
  const knowledge = findKnowledge(home, event.aggregateId);
  if (!knowledge || (requestedScope !== "all" && knowledge.scope !== requestedScope)) return null;
  const runId = stringValue(event.payload.runId);
  const taskId = stringValue(event.payload.taskId);
  if (!runId || !taskId) return null;
  const run = store.getRun(runId);
  const task = store.getTask(taskId);
  if (!run || !task || run.taskId !== task.id || task.scope !== knowledge.scope) return null;
  const artifacts = feedbackArtifactIds(event.payload)
    .map((id) => store.getArtifact(id))
    .filter((artifact) => artifact && artifact.runId === run.id);
  if (artifacts.length === 0) return null;
  const key = `knowledge-feedback|${event.eventId}`;
  const now = new Date().toISOString();
  return {
    schema: EXPERIENCE_VERSION,
    id: `exp-${sha256(key).slice(0, 12)}`,
    scope: knowledge.scope as ExperienceScope,
    adapter: null,
    sourceTitle: `Knowledge feedback：${knowledge.title}`,
    sourceIds: [],
    sourceOriginHash: sha256(JSON.stringify({
      eventId: event.eventId,
      eventHash: event.eventHash,
      knowledgeId: knowledge.id,
      runId,
      artifactHashes: artifacts.map((artifact) => artifact!.contentHash).sort(),
    })),
    sessionKeyHash: sha256(key).slice(0, 32),
    conversationIdHash: sha256(runId).slice(0, 32),
    segmentationVersion: EXPERIENCE_SEGMENTATION_VERSION,
    sourceRecordIds: [],
    evidenceRecordIds: [],
    evidenceEventIds: [event.eventId],
    runIds: [runId],
    validationRefs: [],
    signalCodes: ["knowledge_feedback"],
    signalCounts: { ...emptySignalCounts(), knowledge_feedback: 1 },
    triageDisposition: "selected",
    exclusionReasons: [],
    status: "queued",
    firstSeenAt: event.occurredAt,
    lastSeenAt: event.occurredAt,
    createdAt: now,
    updatedAt: now,
  };
}

function feedbackArtifactIds(payload: Record<string, unknown>): string[] {
  const refs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
  return unique(refs.flatMap((value) => {
    if (typeof value !== "string") return [];
    const normalized = value.replace(/^artifact:\/\//, "");
    return /^artifact-[A-Za-z0-9._-]+$/.test(normalized) ? [normalized] : [];
  }));
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

interface WriteExperienceOutcome {
  state: "created" | "updated" | "unchanged";
  analysisInvalidated: boolean;
  previousAnalysisId: string | null;
}

function writeExperienceRecord(home: string, record: ExperienceRecord, options: { preserveAnalysis?: boolean } = {}): WriteExperienceOutcome {
  const path = join(experienceRoot(home), record.scope, `${record.id}.json`);
  ensureDirectory(join(experienceRoot(home), record.scope));
  const existing = existsSync(path) ? readJsonFile<ExperienceRecord>(path) : null;
  if (existing && !isExperienceRecord(existing)) throw new Error(`Invalid Experience Record: ${path}`);
  const previousAnalysisId = existing?.analysisId ?? null;
  let analysisInvalidated = false;
  if (existing) {
    record.createdAt = existing.createdAt;
    const canPreserve = options.preserveAnalysis !== false
      && existing.status === "analyzed"
      && record.triageDisposition !== "ignored"
      && existing.sourceOriginHash === record.sourceOriginHash
      && Boolean(existing.analysisId && existing.analysisRef);
    if (canPreserve) {
      record.status = "analyzed";
      record.analysisId = existing.analysisId;
      record.analysisRef = existing.analysisRef;
      record.analysisDisposition = existing.analysisDisposition;
      record.semanticPatternKey = existing.semanticPatternKey;
      record.analyzedAt = existing.analyzedAt;
    } else if (existing.status === "analyzed" && options.preserveAnalysis !== false) {
      analysisInvalidated = true;
      delete record.analysisId;
      delete record.analysisRef;
      delete record.analysisDisposition;
      delete record.semanticPatternKey;
      delete record.analyzedAt;
      record.status = "queued";
    }
  }
  if (existing && stableRecordFingerprint(existing) === stableRecordFingerprint(record)) return { state: "unchanged", analysisInvalidated: false, previousAnalysisId };
  writeJson(path, record);
  return { state: existing ? "updated" : "created", analysisInvalidated, previousAnalysisId };
}

function writeExperienceCandidate(home: string, candidate: ExperienceKnowledgeCandidate): "created" | "updated" | "unchanged" {
  ensureDirectory(candidateRoot(home));
  const path = join(candidateRoot(home), `${candidate.id}.json`);
  const existing = existsSync(path) ? readJsonFile<ExperienceKnowledgeCandidate>(path) : null;
  if (existing && !isExperienceCandidate(existing)) throw new Error(`Invalid Experience Candidate: ${path}`);
  candidate.contentHash = candidateContentHash(candidate);
  if (existing) {
    candidate.createdAt = existing.createdAt;
    const existingContentHash = existing.contentHash || candidateContentHash(existing);
    if (existing.status !== "pending_review" && existingContentHash === candidate.contentHash) {
      candidate.status = existing.status;
      candidate.decision = existing.decision;
      candidate.resolution = existing.resolution;
      candidate.nextAction = existing.nextAction;
    }
    if (stableCandidateFingerprint(existing) === stableCandidateFingerprint(candidate)) return "unchanged";
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
    triageDisposition: record.triageDisposition ?? "selected",
    exclusionReasons: record.exclusionReasons ?? [],
    runIds: record.runIds,
  };
}

function candidateEventPayload(candidate: ExperienceKnowledgeCandidate): Record<string, unknown> {
  return {
    schema: candidate.schema,
    status: candidate.status,
    contentHash: candidate.contentHash,
    scope: candidate.scope,
    patternKey: candidate.patternKey,
    changeTypes: candidate.changeTypes,
    targetKnowledgeIds: candidate.targetKnowledgeIds,
    experienceIds: candidate.experienceIds,
    sourceIds: candidate.sourceIds,
    evidenceEventIds: candidate.evidenceEventIds,
    runIds: candidate.runIds,
    validationRefs: candidate.validationRefs,
    independentRunCount: candidate.independentRunCount,
    decision: candidate.decision ?? null,
    resolution: candidate.resolution ?? null,
    nextAction: candidate.nextAction,
  };
}

function requireCompleteRunArtifact(store: LedgerStore, runId: string, artifactId: string, label = "Correction") {
  const artifact = store.requireArtifact(artifactId);
  if (artifact.runId !== runId) {
    throw new Error(`${label} Artifact ${artifact.id} must belong to the same Run ${runId}`);
  }
  if (!artifact.contentHash || !existsSync(artifact.path)) {
    throw new Error(`${label} Artifact ${artifact.id} is incomplete`);
  }
  const stat = lstatSync(artifact.path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} Artifact ${artifact.id} must be a regular file`);
  }
  const currentHash = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
  if (currentHash !== artifact.contentHash) {
    throw new Error(`${label} Artifact ${artifact.id} bytes changed after registration`);
  }
  return artifact;
}

function ensureCandidateLifecycleEvent(
  store: LedgerStore,
  candidate: ExperienceKnowledgeCandidate,
  eventType: "experience.candidate_accepted" | "experience.candidate_rejected" | "experience.candidate_applied",
): void {
  const exists = store.listEvents().some((event) => event.aggregateType === "experience"
    && event.aggregateId === candidate.id
    && event.eventType === eventType
    && event.payload.contentHash === candidate.contentHash
    && event.payload.status === candidate.status);
  if (!exists) store.recordExperienceEvent(candidate.id, eventType, candidateEventPayload(candidate));
}

function reviewedArtifactForDecision(home: string, candidateId: string, path: string): { sourceRef: string; ref: string; contentHash: string } {
  const root = resolve(home);
  const absolute = resolve(path);
  const sourceRef = relative(root, absolute).split("\\").join("/");
  if (!sourceRef || sourceRef.startsWith("..") || isAbsolute(sourceRef)) {
    throw new Error(`Reviewed Candidate artifact must be inside IKB home: ${path}`);
  }
  if (!existsSync(absolute)) throw new Error(`Reviewed Candidate artifact not found: ${absolute}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Reviewed Candidate artifact must be a regular file: ${absolute}`);
  const content = readFileSync(absolute, "utf8");
  const contentHash = sha256(content);
  const ref = `experiences/reviews/${candidateId}/${contentHash}.md`;
  const snapshot = resolve(root, ref);
  if (existsSync(snapshot)) {
    const snapshotStat = lstatSync(snapshot);
    if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile() || readFileSync(snapshot, "utf8") !== content) {
      throw new Error(`Reviewed Candidate snapshot is invalid: ${snapshot}`);
    }
  } else {
    ensureDirectory(dirname(snapshot));
    const temporary = `${snapshot}.tmp-${randomUUID().slice(0, 8)}`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, snapshot);
    chmodSync(snapshot, 0o600);
  }
  return { sourceRef, ref, contentHash };
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
  const identity = conversationId.trim() || source.originalPath;
  return `${source.adapter ?? source.kind}|${identity}`;
}

function segmentSession(session: SessionAccumulator, sourceIndex: Map<string, SourceRecord>): SessionAccumulator[] {
  const canonical = new Map<string, SourceMessage>();
  const byImportTime = session.records.slice().sort((left, right) => {
    const leftImported = sourceIndex.get(left.sourceId)?.importedAt ?? "";
    const rightImported = sourceIndex.get(right.sourceId)?.importedAt ?? "";
    return leftImported.localeCompare(rightImported) || left.id.localeCompare(right.id);
  });
  for (const record of byImportTime) canonical.set(messageFingerprint(record), record);
  const records = [...canonical.values()].sort((left, right) => {
    const leftTime = Date.parse(left.timestamp);
    const rightTime = Date.parse(right.timestamp);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
  if (records.length === 0) return [];
  const groups: SourceMessage[][] = [];
  let current: SourceMessage[] = [];
  let previousTimestamp: number | null = null;
  for (const record of records) {
    const timestamp = Date.parse(record.timestamp);
    if (current.length > 0 && previousTimestamp !== null && Number.isFinite(timestamp) && timestamp - previousTimestamp > 6 * 60 * 60 * 1000) {
      groups.push(current);
      current = [];
    }
    current.push(record);
    if (Number.isFinite(timestamp)) previousTimestamp = timestamp;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group) => {
    const first = group[0];
    const episodeKey = `${session.sessionKey}|episode:${sha256(messageFingerprint(first)).slice(0, 16)}`;
    const episode: SessionAccumulator = {
      scope: session.scope,
      adapter: session.adapter,
      sessionKey: episodeKey,
      conversationId: session.conversationId,
      sourceTitles: new Set(),
      sources: new Set(),
      sourceOriginHashes: new Set(),
      sourceRecordIds: new Set(),
      records: group,
      firstSeenAt: first.timestamp,
      lastSeenAt: group.at(-1)?.timestamp ?? first.timestamp,
    };
    for (const record of group) {
      const source = sourceIndex.get(record.sourceId);
      episode.sources.add(record.sourceId);
      episode.sourceRecordIds.add(record.id);
      if (source) {
        episode.sourceTitles.add(source.title);
        episode.sourceOriginHashes.add(source.contentHash);
      }
    }
    return episode;
  });
}

function messageFingerprint(record: SourceMessage): string {
  return sha256(JSON.stringify({
    conversationId: record.conversationId,
    role: record.role,
    actor: record.actor,
    timestamp: record.timestamp,
    content: record.content,
    refs: record.refs,
    participants: record.participants,
  }));
}

function isToolRecord(record: SourceMessage): boolean {
  const role = `${record.role}|${record.actor}`.toLowerCase();
  const content = String(record.content ?? "").trim();
  return Boolean(
    record.role === "tool"
    || /(?:^|[|:_-])tool(?:$|[|:_-])/.test(role)
    || role.includes("tool_result")
    || role.includes("function_call")
    || /^\[external_agent_tool_(?:call|result)\b/iu.test(content)
    || /^<EXTERNAL SESSION IMPORTED>/iu.test(content)
  );
}

function isHumanRecord(record: SourceMessage): boolean {
  const role = `${record.role}|${record.actor}`.toLowerCase();
  return /(?:^|[|:_-])(?:user|human|reviewer|owner|customer)(?:$|[|:_-])/.test(role) || record.role === "user" || record.role === "human";
}

function signalContent(record: SourceMessage): string | null {
  const content = stripLeadingRuntimeContext(String(record.content ?? ""));
  if (!content) return null;
  if (isHumanRecord(record) && looksLikeDelegatedPrompt(content)) return null;
  return content;
}

function hasFailureSignal(content: string): boolean {
  const buildNormalized = /\bBUILD SUCCESS\b/iu.test(content) ? content.replace(/\[ERROR\]/giu, "") : content;
  const withoutExplicitNegations = buildNormalized
    .replace(/失败后/gu, "之后")
    .replace(/\b(?:after|on)\s+(?:a\s+)?failure\b/giu, "")
    .replace(/((?:如果|若|假如|一旦|当)[^，。；;\n]{0,40})(?:失败|错误|异常|报错|阻断|超时)/giu, "$1")
    .replace(/(?:没有|未|无|不存在|非|不是|并非)[^，。；;\n]{0,16}(?:错误|异常|失败|报错|阻断|超时|不通过|冲突)/giu, "")
    .replace(/(?:did\s+not|didn't|has\s+not|hasn't|have\s+not|haven't|no|without)\s+(?:any\s+)?(?:errors?|exceptions?|failures?|timeouts?|blocks?)/giu, "");
  return FAILURE_RE.test(withoutExplicitNegations);
}

function stripLeadingRuntimeContext(value: string): string {
  let result = value.trim();
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result
      .replace(/^<sandbox_context\b[^>]*\/>\s*/iu, "")
      .replace(/^<(sandbox_context|memory_context|attachment_context)\b[^>]*>[\s\S]*?<\/\1>\s*/iu, "")
      .trim();
  }
  return result;
}

function looksLikeDelegatedPrompt(content: string): boolean {
  const text = content.trim();
  if (/^<automation_context\b/iu.test(text)) return true;
  if (/^#\s*System(?:\s|$)/iu.test(text)) return true;
  if (/^#\s*知识质量(?:第.+轮)?检查/iu.test(text)) return true;
  if (/^你要完成一个[^。\n]{0,120}任务[:：]?/u.test(text) && /(?:你需要执行的步骤|输出要求|收录标准|执行步骤)/u.test(text)) return true;
  if (/^#\s*OpenSpec\b/iu.test(text) && /输出格式|产出\s*`?prd_/iu.test(text)) return true;
  if (/^You are running as a local coding agent\b/iu.test(text) && /assigned issue ID|Start by running/iu.test(text)) return true;
  if (/^<SystemPrompt>/iu.test(text) || /<SystemPrompt>[\s\S]*(?:MULTICA_AGENT_ID|assigned issue ID)/iu.test(text)) return true;
  if (/^用户提供了[\s\S]{0,1000}请你[:：]/iu.test(text)) return true;
  const assignedRole = /^(?:你是)\s*[^。\n]{0,120}(?:(?:助手|引擎|评审员|分析员|总管)(?:[，。；：:\s]|$)|(?:agent|judge|expert)\b)/iu.test(text)
    || /^(?:You are)\s*[^.\n]{0,120}(?:agent|assistant|judge|expert)\b/iu.test(text);
  return assignedRole && /(?:输出|报告|调用方式|只读|只输出|input|prompt|格式|步骤)/iu.test(text);
}

function isAutomatedPromptOnlySession(records: SourceMessage[]): boolean {
  const humanContents = records
    .filter(isHumanRecord)
    .map((record) => stripLeadingRuntimeContext(String(record.content ?? "")))
    .filter(Boolean);
  return humanContents.length > 0 && humanContents.every(looksLikeDelegatedPrompt);
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
    && (row.triageDisposition === undefined || row.triageDisposition === "selected" || row.triageDisposition === "ignored")
    && (row.exclusionReasons === undefined || Array.isArray(row.exclusionReasons))
    && (row.status === "queued" || row.status === "analyzed")
    && (row.status !== "analyzed" || (typeof row.analysisId === "string" && typeof row.analysisRef === "string" && ["candidate", "skip", "gap"].includes(String(row.analysisDisposition))))
    && typeof row.createdAt === "string" && typeof row.updatedAt === "string";
}

function isExperienceCandidate(value: unknown): value is ExperienceKnowledgeCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === "ikb-knowledge-candidate.v1" && typeof row.id === "string" && /^exp-cand-[A-Za-z0-9]+$/.test(row.id)
    && (row.scope === "personal" || row.scope === "work") && ["pending_review", "accepted", "rejected", "applied"].includes(String(row.status))
    && (row.contentHash === undefined || typeof row.contentHash === "string")
    && Array.isArray(row.experienceIds) && Array.isArray(row.sourceIds) && Array.isArray(row.runIds)
    && typeof row.createdAt === "string" && typeof row.updatedAt === "string";
}

function stableRecordFingerprint(record: ExperienceRecord): string {
  return sha256(JSON.stringify({ ...record, createdAt: null, updatedAt: null }));
}

function stableCandidateFingerprint(candidate: ExperienceKnowledgeCandidate): string {
  return sha256(JSON.stringify({ ...candidate, createdAt: null, updatedAt: null }));
}

function candidateContentHash(candidate: ExperienceKnowledgeCandidate): string {
  return sha256(JSON.stringify({
    schema: candidate.schema,
    id: candidate.id,
    scope: candidate.scope,
    title: candidate.title,
    patternKey: candidate.patternKey,
    signalCodes: candidate.signalCodes,
    analysisIds: candidate.analysisIds,
    patternLabel: candidate.patternLabel,
    claimVariants: candidate.claimVariants,
    changeTypes: candidate.changeTypes,
    targetKnowledgeIds: candidate.targetKnowledgeIds,
    experienceIds: candidate.experienceIds,
    sourceIds: candidate.sourceIds,
    sourceRecordRefs: candidate.sourceRecordRefs,
    evidenceEventIds: candidate.evidenceEventIds,
    runIds: candidate.runIds,
    validationRefs: candidate.validationRefs,
    independentRunCount: candidate.independentRunCount,
    independentSourceCount: candidate.independentSourceCount,
    candidateKnowledge: candidate.candidateKnowledge,
  }));
}

function sourceIdForRecord(recordId: string, sourceIds: string[]): string {
  return sourceIds.find((sourceId) => recordId.includes(sourceId)) ?? sourceIds[0] ?? "source-unknown";
}

function sourceRecordRef(recordId: string, sourceIds: string[]): string {
  const sourceId = sourceIdForRecord(recordId, sourceIds);
  return recordId === sourceId || recordId.startsWith(`${sourceId}:`) ? recordId : `${sourceId}:${recordId}`;
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
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(stringValue).filter((item): item is string => item !== null) : []; }
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function objectArray(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.map(objectValue).filter((item): item is Record<string, unknown> => item !== null) : []; }
function normalizeExtractionResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  return object && Array.isArray(object.results) ? object.results : [value];
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
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
  ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
