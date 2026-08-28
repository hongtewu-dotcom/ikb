import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { LedgerStore } from "./store.ts";
import type { ExperienceRecord, ExperienceScope } from "./experience.ts";
import {
  KNOWLEDGE_CANDIDATE_TYPES,
  KNOWLEDGE_DIRECTORIES,
  type KnowledgeCandidateType,
  type KnowledgeDirectory,
} from "./knowledge/contracts.ts";
import { findKnowledge } from "./knowledge/records.ts";

export const EXPERIENCE_ANALYSIS_VERSION = "ikb-experience-analysis.v1";

export type ExperienceAnalysisDisposition = "candidate" | "skip" | "gap";
export type ExperienceFindingKind = "fact" | "inference" | "unknown";

export interface ExperienceFinding {
  id: string;
  kind: ExperienceFindingKind;
  statement: string;
  evidenceRecordIds: string[];
  evidenceEventIds: string[];
}

export interface ExperienceCandidateProposal {
  changeType: "new" | "revise" | "retire";
  targetKnowledgeIds: string[];
  patternKey: string;
  patternLabel: string;
  knowledgeType: KnowledgeCandidateType;
  collection: KnowledgeDirectory;
  canonicalClaim: string;
  applicability: string;
  boundary: string;
  useWhen: string;
  steps: string[];
  checks: string[];
  stopConditions: string[];
  validationPlan: string;
}

export interface ExperienceAnalysisInput {
  experienceId: string;
  title: string;
  summary: string;
  disposition: ExperienceAnalysisDisposition;
  reason: string;
  findings: ExperienceFinding[];
  candidate: ExperienceCandidateProposal | null;
  counterevidence: {
    searched: boolean;
    scope: string;
    evidenceRecordIds: string[];
    result: string;
  };
  unknowns: string[];
}

export interface ExperienceAnalysis extends ExperienceAnalysisInput {
  schema: typeof EXPERIENCE_ANALYSIS_VERSION;
  id: string;
  scope: ExperienceScope;
  sourceOriginHash: string;
  sourceIds: string[];
  runIds: string[];
  validationRefs: string[];
  revisionRef: string;
  createdAt: string;
}

export interface ExperienceQueueItem {
  experienceId: string;
  scope: ExperienceScope;
  sourceTitle: string;
  lastSeenAt: string;
  signalCodes: string[];
  evidenceRecords: number;
  linkedRuns: number;
  linkedVerificationEvents: number;
  priority: number;
  priorityReasons: string[];
}

export interface ExperienceValidation {
  schema: "ikb-experience-validation.v1";
  id: string;
  experienceId: string;
  analysisId: string;
  scope: ExperienceScope;
  result: "pass" | "fail";
  method: string;
  note: string;
  artifactId: string;
  artifactHash: string;
  runId: string;
  createdAt: string;
}

export interface ExperienceAnalysisResult {
  analysis: ExperienceAnalysis;
  record: ExperienceRecord;
  outcome: "created" | "unchanged";
}

export function rankExperienceQueue(records: ExperienceRecord[], scope?: ExperienceScope, limit = 100): ExperienceQueueItem[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Experience queue limit must be a non-negative integer");
  const items = records
    .filter((record) => record.triageDisposition !== "ignored" && record.status === "queued")
    .filter((record) => !scope || record.scope === scope)
    .map((record) => {
      const reasons: string[] = [];
      const matchedScores: number[] = [];
      const add = (code: string, score: number, label: string): void => {
        if (!record.signalCodes.includes(code as ExperienceRecord["signalCodes"][number])) return;
        matchedScores.push(score);
        reasons.push(label);
      };
      add("knowledge_feedback", 100, "知识反馈指出 partial/incorrect");
      add("manual_correction", 60, "存在人工纠偏");
      add("verifier_rejection", 50, "Verifier 曾驳回或部分通过");
      add("non_obvious_fix", 40, "包含非显然修复");
      add("failure_or_block", 25, "包含失败或阻断");
      add("decision_or_rule", 20, "包含明确决策或规则");
      add("retry", 10, "包含重试");
      let priority = (matchedScores.sort((left, right) => right - left)[0] ?? 0) + Math.max(0, matchedScores.length - 1) * 5;
      if (record.runIds.length > 0) {
        reasons.push(`关联 ${record.runIds.length} 个 IKB 流程 Run（不作为独立经验或内容验证）`);
      }
      if (record.validationRefs.length > 0) {
        reasons.push(`关联 ${record.validationRefs.length} 条流程验证事件（不作为内容验证）`);
      }
      const evidencePenalty = Math.min(40, Math.max(0, record.evidenceRecordIds.length - 20));
      priority -= evidencePenalty;
      if (evidencePenalty > 0) reasons.push(`长会话先扣 ${evidencePenalty} 分，避免噪声挤占短而明确的纠偏`);
      return {
        experienceId: record.id,
        scope: record.scope,
        sourceTitle: record.sourceTitle,
        lastSeenAt: record.lastSeenAt,
        signalCodes: record.signalCodes,
        evidenceRecords: record.evidenceRecordIds.length,
        linkedRuns: record.runIds.length,
        linkedVerificationEvents: record.validationRefs.length,
        priority,
        priorityReasons: reasons,
      };
    })
    .sort((left, right) => right.priority - left.priority || right.lastSeenAt.localeCompare(left.lastSeenAt) || left.experienceId.localeCompare(right.experienceId));
  return limit === 0 ? items : items.slice(0, limit);
}

export function recordExperienceValidation(
  home: string,
  store: LedgerStore,
  record: ExperienceRecord,
  input: { result: "pass" | "fail"; method: string; note: string; artifactId: string },
): ExperienceValidation {
  if (record.status !== "analyzed" || record.analysisDisposition !== "candidate" || !record.analysisId || !record.analysisRef) {
    throw new Error(`Experience ${record.id} must have a current candidate analysis before validation`);
  }
  if (input.result !== "pass" && input.result !== "fail") throw new Error("Experience validation result must be pass or fail");
  requireText(input.method, "validation.method");
  requireText(input.note, "validation.note");
  const artifact = store.getArtifact(input.artifactId);
  if (!artifact || !artifact.contentHash) throw new Error(`Experience validation requires a registered, hashed Artifact: ${input.artifactId}`);
  if (!existsSync(artifact.path) || lstatSync(artifact.path).isSymbolicLink() || !lstatSync(artifact.path).isFile()) {
    throw new Error(`Experience validation Artifact is not a current regular file: ${artifact.path}`);
  }
  const actualHash = sha256(readFileSync(artifact.path));
  if (actualHash !== artifact.contentHash) throw new Error(`Experience validation Artifact hash changed: ${artifact.id}`);
  const stable = {
    schema: "ikb-experience-validation.v1" as const,
    experienceId: record.id,
    analysisId: record.analysisId,
    scope: record.scope,
    result: input.result,
    method: input.method.trim(),
    note: input.note.trim(),
    artifactId: artifact.id,
    artifactHash: artifact.contentHash,
    runId: artifact.runId,
  };
  const id = `exp-validation-${sha256(JSON.stringify(stable)).slice(0, 12)}`;
  const validation: ExperienceValidation = { ...stable, id, createdAt: new Date().toISOString() };
  const ref = join("experiences", "validation", record.scope, record.id, `${id}.json`);
  const path = safeAnalysisPath(home, ref);
  if (existsSync(path)) {
    const existing = readJson<ExperienceValidation>(path);
    if (!isExperienceValidation(existing) || existing.id !== id) throw new Error(`Invalid existing Experience Validation: ${ref}`);
    return existing;
  }
  writeJson(path, validation);
  store.recordExperienceEvent(record.id, "experience.validation_recorded", {
    schema: validation.schema,
    validationId: validation.id,
    analysisId: validation.analysisId,
    result: validation.result,
    method: validation.method,
    artifactId: validation.artifactId,
    artifactHash: validation.artifactHash,
    runId: validation.runId,
  });
  return validation;
}

export function listExperienceValidations(home: string, record: ExperienceRecord): ExperienceValidation[] {
  const directory = safeAnalysisPath(home, join("experiences", "validation", record.scope, record.id));
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`Experience validation directory must be a real directory: ${directory}`);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson<ExperienceValidation>(join(directory, entry.name)))
    .filter((value) => isExperienceValidation(value) && value.analysisId === record.analysisId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function analyzeExperience(
  home: string,
  store: LedgerStore,
  record: ExperienceRecord,
  input: ExperienceAnalysisInput,
  markAnalyzed: (analysis: ExperienceAnalysis) => ExperienceRecord,
): ExperienceAnalysisResult {
  validateAnalysisInput(home, store, record, input);
  const normalized = normalizeAnalysisInput(input);
  const stable = {
    schema: EXPERIENCE_ANALYSIS_VERSION,
    experienceId: record.id,
    scope: record.scope,
    sourceOriginHash: record.sourceOriginHash,
    sourceIds: record.sourceIds,
    runIds: record.runIds,
    validationRefs: record.validationRefs,
    ...normalized,
  };
  const digest = sha256(JSON.stringify(stable));
  const id = `exp-analysis-${digest.slice(0, 12)}`;
  const revisionRef = join("experiences", "analysis", record.scope, record.id, "revisions", `${id}.json`);
  let analysis: ExperienceAnalysis = {
    ...stable,
    id,
    revisionRef,
    createdAt: new Date().toISOString(),
  };
  const absoluteRevision = safeAnalysisPath(home, revisionRef);
  const outcome = existsSync(absoluteRevision) ? "unchanged" : "created";
  if (outcome === "created") writeJson(absoluteRevision, analysis);
  else {
    const existing = readJson<ExperienceAnalysis>(absoluteRevision);
    if (!isExperienceAnalysis(existing) || existing.id !== id) throw new Error(`Invalid existing Experience Analysis revision: ${revisionRef}`);
    analysis = existing;
  }
  const latestRef = join("experiences", "analysis", record.scope, record.id, "latest.json");
  writeJson(safeAnalysisPath(home, latestRef), analysis);
  const updatedRecord = markAnalyzed(analysis);
  if (outcome === "created") {
    store.recordExperienceEvent(record.id, "experience.analyzed", {
      schema: EXPERIENCE_ANALYSIS_VERSION,
      analysisId: analysis.id,
      analysisRef: analysis.revisionRef,
      disposition: analysis.disposition,
      patternKey: analysis.candidate?.patternKey ?? null,
      changeType: analysis.candidate?.changeType ?? null,
      targetKnowledgeIds: analysis.candidate?.targetKnowledgeIds ?? [],
      evidenceRecordIds: unique(analysis.findings.flatMap((finding) => finding.evidenceRecordIds)),
      evidenceEventIds: unique(analysis.findings.flatMap((finding) => finding.evidenceEventIds)),
    });
  }
  return { analysis, record: updatedRecord, outcome };
}

export function readExperienceAnalysis(home: string, revisionRef: string): ExperienceAnalysis {
  const value = readJson<ExperienceAnalysis>(safeAnalysisPath(home, revisionRef));
  if (!isExperienceAnalysis(value)) throw new Error(`Invalid Experience Analysis: ${revisionRef}`);
  return value;
}

export function findLatestExperienceAnalysis(home: string, record: ExperienceRecord): ExperienceAnalysis | null {
  if (!record.analysisRef) return null;
  const analysis = readExperienceAnalysis(home, record.analysisRef);
  if (analysis.experienceId !== record.id) throw new Error(`Experience Analysis ${analysis.id} belongs to ${analysis.experienceId}, not ${record.id}`);
  if (analysis.sourceOriginHash !== record.sourceOriginHash) throw new Error(`Experience Analysis ${analysis.id} is stale for ${record.id}`);
  return analysis;
}

export function parseExperienceAnalysisInput(path: string): ExperienceAnalysisInput {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) throw new Error(`Experience analysis input must be a regular file: ${absolute}`);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Experience analysis input must be a JSON object");
  return value as ExperienceAnalysisInput;
}

function validateAnalysisInput(home: string, store: LedgerStore, record: ExperienceRecord, input: ExperienceAnalysisInput): void {
  if (record.triageDisposition === "ignored") throw new Error(`Ignored Experience cannot be analyzed: ${record.id}`);
  if (input.experienceId !== record.id) throw new Error(`Experience analysis input targets ${input.experienceId}, expected ${record.id}`);
  requireText(input.title, "title");
  requireText(input.summary, "summary");
  requireText(input.reason, "reason");
  if (!["candidate", "skip", "gap"].includes(input.disposition)) throw new Error("Experience analysis disposition must be candidate, skip, or gap");
  if (!Array.isArray(input.findings) || input.findings.length === 0) throw new Error("Experience analysis requires at least one finding");
  const findingIds = new Set<string>();
  const referencedRecords = new Set<string>();
  for (const finding of input.findings) {
    requireText(finding.id, "finding.id");
    if (findingIds.has(finding.id)) throw new Error(`Duplicate Experience finding id: ${finding.id}`);
    findingIds.add(finding.id);
    if (!["fact", "inference", "unknown"].includes(finding.kind)) throw new Error(`Invalid Experience finding kind: ${finding.kind}`);
    requireText(finding.statement, `finding ${finding.id} statement`);
    assertStringArray(finding.evidenceRecordIds, `finding ${finding.id} evidenceRecordIds`);
    assertStringArray(finding.evidenceEventIds, `finding ${finding.id} evidenceEventIds`);
    for (const id of finding.evidenceRecordIds) {
      if (!record.sourceRecordIds.includes(id)) throw new Error(`Finding ${finding.id} references a record outside Experience ${record.id}: ${id}`);
      referencedRecords.add(id);
    }
    for (const id of finding.evidenceEventIds) {
      if (!record.evidenceEventIds.includes(id) && !record.validationRefs.includes(id)) throw new Error(`Finding ${finding.id} references an event outside Experience ${record.id}: ${id}`);
    }
    if (finding.kind !== "unknown" && finding.evidenceRecordIds.length + finding.evidenceEventIds.length === 0) {
      throw new Error(`Finding ${finding.id} must cite evidence`);
    }
  }
  if (!input.counterevidence || typeof input.counterevidence !== "object") throw new Error("Experience analysis requires counterevidence metadata");
  if (typeof input.counterevidence.searched !== "boolean") throw new Error("counterevidence.searched must be boolean");
  requireText(input.counterevidence.scope, "counterevidence.scope");
  requireText(input.counterevidence.result, "counterevidence.result");
  assertStringArray(input.counterevidence.evidenceRecordIds, "counterevidence.evidenceRecordIds");
  for (const id of input.counterevidence.evidenceRecordIds) {
    if (!record.sourceRecordIds.includes(id)) throw new Error(`Counterevidence references a record outside Experience ${record.id}: ${id}`);
  }
  assertStringArray(input.unknowns, "unknowns");
  if (input.disposition === "candidate") {
    if (!input.candidate) throw new Error("Candidate disposition requires a candidate proposal");
    validateCandidateProposal(home, input.candidate);
    if (![...referencedRecords].some((id) => record.evidenceRecordIds.includes(id))) validateEventBackedKnowledgeCorrection(store, record, input);
    if (!input.findings.some((finding) => finding.kind === "fact")) throw new Error("Candidate analysis requires at least one fact finding");
    if (!input.counterevidence.searched) throw new Error("Candidate analysis requires an explicit counterevidence search");
  } else if (input.candidate !== null) {
    throw new Error(`${input.disposition} disposition must not include a candidate proposal`);
  }
  if (input.disposition === "gap" && input.unknowns.length === 0) throw new Error("Gap disposition requires at least one unknown");
}

function validateEventBackedKnowledgeCorrection(store: LedgerStore, record: ExperienceRecord, input: ExperienceAnalysisInput): void {
  const candidate = input.candidate!;
  if (!record.signalCodes.includes("knowledge_feedback")) throw new Error("Candidate analysis must cite at least one Triage evidence record");
  if (candidate.changeType === "new") throw new Error("An event-backed Knowledge feedback can only revise or retire its target Knowledge");
  const citedEventIds = unique(input.findings.flatMap((finding) => finding.evidenceEventIds));
  const feedbackEvents = store.listEvents().filter((event) => (
    citedEventIds.includes(event.eventId)
    && event.aggregateType === "knowledge"
    && event.eventType === "knowledge.feedback_recorded"
    && ["partial", "incorrect"].includes(String(event.payload.outcome))
  ));
  if (feedbackEvents.length === 0) throw new Error("Event-backed Knowledge correction requires a partial or incorrect feedback Event");
  const feedbackTargets = unique(feedbackEvents.map((event) => event.aggregateId)).sort();
  const candidateTargets = [...candidate.targetKnowledgeIds].sort();
  if (JSON.stringify(feedbackTargets) !== JSON.stringify(candidateTargets)) {
    throw new Error("Event-backed Knowledge correction targets must exactly match the feedback target Knowledge");
  }
  for (const event of feedbackEvents) {
    const runId = typeof event.payload.runId === "string" ? event.payload.runId : "";
    if (!runId || !record.runIds.includes(runId)) throw new Error("Event-backed Knowledge correction must use the feedback Run recorded by Triage");
    const evidenceRefs = Array.isArray(event.payload.evidenceRefs) ? event.payload.evidenceRefs : [];
    const artifactIds = evidenceRefs.flatMap((value) => {
      if (typeof value !== "string") return [];
      const normalized = value.replace(/^artifact:\/\//, "");
      return /^artifact-[A-Za-z0-9._-]+$/.test(normalized) ? [normalized] : [];
    });
    if (!artifactIds.some((id) => store.getArtifact(id)?.runId === runId)) {
      throw new Error("Event-backed Knowledge correction requires a registered Artifact from the feedback Run");
    }
  }
}

function validateCandidateProposal(home: string, candidate: ExperienceCandidateProposal): void {
  if (!["new", "revise", "retire"].includes(candidate.changeType)) throw new Error("candidate.changeType must be new, revise, or retire");
  assertStringArray(candidate.targetKnowledgeIds, "candidate.targetKnowledgeIds");
  if (candidate.changeType === "new" && candidate.targetKnowledgeIds.length > 0) throw new Error("A new candidate must not target existing Knowledge");
  if (candidate.changeType !== "new" && candidate.targetKnowledgeIds.length === 0) throw new Error(`${candidate.changeType} candidate requires targetKnowledgeIds`);
  const targets = [];
  const targetScopes = new Set<string>();
  for (const id of candidate.targetKnowledgeIds) {
    if (!/^kb-[A-Za-z0-9-]+$/.test(id)) throw new Error(`Invalid target Knowledge id: ${id}`);
    const target = findKnowledge(home, id);
    if (!target) throw new Error(`Target Knowledge not found: ${id}`);
    targets.push(target);
    targetScopes.add(target.scope);
  }
  if (targetScopes.size > 1) throw new Error(`A revise or retire Candidate cannot target Knowledge across scopes: ${[...targetScopes].join(", ")}`);
  if (!/^[a-z0-9][a-z0-9._/-]{2,119}$/.test(candidate.patternKey)) throw new Error("candidate.patternKey must be a stable lowercase key using a-z, 0-9, dot, slash, underscore, or dash");
  requireText(candidate.patternLabel, "candidate.patternLabel");
  if (!(KNOWLEDGE_CANDIDATE_TYPES as readonly string[]).includes(candidate.knowledgeType)) {
    throw new Error(`candidate.knowledgeType must be one of: ${KNOWLEDGE_CANDIDATE_TYPES.join(", ")}`);
  }
  if (!(KNOWLEDGE_DIRECTORIES as readonly string[]).includes(candidate.collection)) {
    throw new Error(`candidate.collection must be one of: ${KNOWLEDGE_DIRECTORIES.join(", ")}`);
  }
  if (candidate.changeType === "revise") {
    const targetShapes = unique(targets.map((target) => `${target.type}|${target.collection}`));
    if (targetShapes.length !== 1) {
      throw new Error("A revise Candidate requires all target Knowledge to have the same type and collection");
    }
    const [target] = targets;
    if (target.type !== candidate.knowledgeType || target.collection !== candidate.collection) {
      throw new Error(`A revise Candidate type and collection must match its target Knowledge: ${target.type}/${target.collection}`);
    }
  }
  for (const [name, value] of Object.entries({
    canonicalClaim: candidate.canonicalClaim,
    applicability: candidate.applicability,
    boundary: candidate.boundary,
    useWhen: candidate.useWhen,
    validationPlan: candidate.validationPlan,
  })) requireText(value, `candidate.${name}`);
  assertNonEmptyStringArray(candidate.steps, "candidate.steps");
  assertNonEmptyStringArray(candidate.checks, "candidate.checks");
  assertNonEmptyStringArray(candidate.stopConditions, "candidate.stopConditions");
}

function normalizeAnalysisInput(input: ExperienceAnalysisInput): ExperienceAnalysisInput {
  const candidate = input.candidate ? {
    ...input.candidate,
    targetKnowledgeIds: unique(input.candidate.targetKnowledgeIds),
    patternKey: input.candidate.patternKey.trim(),
    patternLabel: input.candidate.patternLabel.trim(),
    canonicalClaim: input.candidate.canonicalClaim.trim(),
    applicability: input.candidate.applicability.trim(),
    boundary: input.candidate.boundary.trim(),
    useWhen: input.candidate.useWhen.trim(),
    steps: uniquePreserve(input.candidate.steps.map((value) => value.trim())),
    checks: uniquePreserve(input.candidate.checks.map((value) => value.trim())),
    stopConditions: uniquePreserve(input.candidate.stopConditions.map((value) => value.trim())),
    validationPlan: input.candidate.validationPlan.trim(),
  } : null;
  return {
    experienceId: input.experienceId,
    title: input.title.trim(),
    summary: input.summary.trim(),
    disposition: input.disposition,
    reason: input.reason.trim(),
    findings: input.findings.map((finding) => ({
      id: finding.id.trim(),
      kind: finding.kind,
      statement: finding.statement.trim(),
      evidenceRecordIds: unique(finding.evidenceRecordIds),
      evidenceEventIds: unique(finding.evidenceEventIds),
    })),
    candidate,
    counterevidence: {
      searched: input.counterevidence.searched,
      scope: input.counterevidence.scope.trim(),
      evidenceRecordIds: unique(input.counterevidence.evidenceRecordIds),
      result: input.counterevidence.result.trim(),
    },
    unknowns: uniquePreserve(input.unknowns.map((value) => value.trim())),
  };
}

function isExperienceAnalysis(value: unknown): value is ExperienceAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === EXPERIENCE_ANALYSIS_VERSION
    && typeof row.id === "string"
    && typeof row.experienceId === "string"
    && (row.scope === "personal" || row.scope === "work")
    && typeof row.sourceOriginHash === "string"
    && Array.isArray(row.sourceIds)
    && Array.isArray(row.findings)
    && ["candidate", "skip", "gap"].includes(String(row.disposition))
    && typeof row.revisionRef === "string"
    && typeof row.createdAt === "string";
}

function isExperienceValidation(value: unknown): value is ExperienceValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.schema === "ikb-experience-validation.v1"
    && typeof row.id === "string"
    && typeof row.experienceId === "string"
    && typeof row.analysisId === "string"
    && (row.scope === "personal" || row.scope === "work")
    && (row.result === "pass" || row.result === "fail")
    && typeof row.artifactId === "string"
    && typeof row.artifactHash === "string"
    && typeof row.runId === "string"
    && typeof row.createdAt === "string";
}

function safeAnalysisPath(home: string, relativeRef: string): string {
  const root = resolve(home);
  const absolute = resolve(root, relativeRef);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || rel.includes("../")) throw new Error(`Experience analysis path escapes IKB home: ${relativeRef}`);
  return absolute;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson<T>(path: string): T {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`Experience analysis file must be a regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Experience analysis ${name} must be non-empty text`);
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Experience analysis ${name} must be an array of non-empty strings`);
}

function assertNonEmptyStringArray(value: unknown, name: string): asserts value is string[] {
  assertStringArray(value, name);
  if (value.length === 0) throw new Error(`Experience analysis ${name} must not be empty`);
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function uniquePreserve(values: string[]): string[] { return [...new Set(values)]; }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
