import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExperienceRecord } from "./experience.ts";
import { findKnowledge } from "./knowledge/records.ts";
import { findSource, readSourceRecords } from "./source.ts";
import type { LedgerStore } from "./store.ts";
import type { Artifact, SourceMessage, SourceRecord } from "./types.ts";

export const EXPERIENCE_CONTEXT_VERSION = "ikb-experience-context.v1";

export interface ExperienceContextMessage extends SourceMessage {
  sourceTitle: string;
  triageEvidence: boolean;
  equivalentRecordIds: string[];
  equivalentSourceIds: string[];
  triageEvidenceRecordIds: string[];
}

export interface ExperienceContextEvent {
  eventId: string;
  knowledgeId: string;
  taskId: string;
  runId: string;
  outcome: "partial" | "incorrect";
  reasonCode: string;
  note: string | null;
  artifactIds: string[];
  occurredAt: string;
}

export interface ExperienceContextArtifact {
  id: string;
  runId: string;
  kind: string;
  label: string;
  path: string;
  contentHash: string;
}

export interface ExperienceContextKnowledgeTarget {
  id: string;
  title: string;
  scope: "personal" | "work";
  status: string;
  verification: string;
  path: string;
}

export interface ExperienceContext {
  schema: typeof EXPERIENCE_CONTEXT_VERSION;
  experienceId: string;
  scope: "personal" | "work";
  sourceOriginHash: string;
  sourceIds: string[];
  evidenceRecordIds: string[];
  sourceRecordCount: number;
  totalRecords: number;
  truncated: boolean;
  records: ExperienceContextMessage[];
  events: ExperienceContextEvent[];
  artifacts: ExperienceContextArtifact[];
  knowledgeTargets: ExperienceContextKnowledgeTarget[];
  markdown: string;
}

export interface MaterializedExperienceContext extends ExperienceContext {
  contextArtifact: Artifact;
}

interface LocatedMessage {
  source: SourceRecord;
  message: SourceMessage;
  sourceIndex: number;
  recordIndex: number;
}

interface LogicalMessage {
  canonical: LocatedMessage;
  copies: LocatedMessage[];
}

/**
 * Expand only the records frozen into one Experience episode. A Source can
 * contain an entire long-running session, so reading the whole Source here
 * would silently widen the analyst's evidence boundary.
 */
export function buildExperienceContext(home: string, experience: ExperienceRecord, limit?: number, store?: LedgerStore): ExperienceContext {
  if (experience.triageDisposition === "ignored") throw new Error(`Ignored Experience cannot build context: ${experience.id}`);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
    throw new Error("Experience context limit must be an integer from 1 to 500");
  }
  const requestedIds = new Set(experience.sourceRecordIds);
  if (requestedIds.size !== experience.sourceRecordIds.length) throw new Error(`Experience ${experience.id} contains duplicate Source record ids`);
  if (requestedIds.size === 0) {
    if (experience.evidenceEventIds.length === 0) throw new Error(`Experience ${experience.id} has no Source records or evidence Events`);
    if (!store) throw new Error(`Event-backed Experience ${experience.id} requires a LedgerStore`);
    return buildEventExperienceContext(home, store, experience, limit);
  }

  const located: LocatedMessage[] = [];
  const resolvedIds = new Set<string>();
  const sources = experience.sourceIds.map((sourceId, sourceIndex) => {
    const source = findSource(home, sourceId);
    if (!source) throw new Error(`Experience ${experience.id} references missing Source: ${sourceId}`);
    if (source.scope !== experience.scope) {
      throw new Error(`Source ${source.id} scope ${source.scope} does not match Experience scope ${experience.scope}`);
    }
    readSourceRecords(home, source.id, { source }).forEach((message, recordIndex) => {
      if (!requestedIds.has(message.id)) return;
      if (resolvedIds.has(message.id)) throw new Error(`Experience ${experience.id} resolves Source record more than once: ${message.id}`);
      resolvedIds.add(message.id);
      located.push({ source, message, sourceIndex, recordIndex });
    });
    return source;
  });
  const unresolved = experience.sourceRecordIds.filter((id) => !resolvedIds.has(id));
  if (unresolved.length > 0) throw new Error(`Experience ${experience.id} could not resolve Source records: ${unresolved.join(", ")}`);

  located.sort(compareLocatedMessages);
  const logicalMessages = groupMirroredMessages(located);
  const selected = limit === undefined ? logicalMessages : logicalMessages.slice(0, limit);
  const evidenceIds = new Set(experience.evidenceRecordIds);
  const records: ExperienceContextMessage[] = selected.map(({ canonical, copies }) => {
    const equivalentRecordIds = copies.map(({ message }) => message.id);
    const triageEvidenceRecordIds = equivalentRecordIds.filter((id) => evidenceIds.has(id));
    return {
      ...canonical.message,
      sourceTitle: canonical.source.title,
      triageEvidence: triageEvidenceRecordIds.length > 0,
      equivalentRecordIds,
      equivalentSourceIds: unique(copies.map(({ source }) => source.id)),
      triageEvidenceRecordIds,
    };
  });
  const markdown = renderExperienceContext(experience, sources, records, logicalMessages.length, located.length);
  return {
    schema: EXPERIENCE_CONTEXT_VERSION,
    experienceId: experience.id,
    scope: experience.scope,
    sourceOriginHash: experience.sourceOriginHash,
    sourceIds: [...experience.sourceIds],
    evidenceRecordIds: [...experience.evidenceRecordIds],
    sourceRecordCount: located.length,
    totalRecords: logicalMessages.length,
    truncated: records.length < logicalMessages.length,
    records,
    events: [],
    artifacts: [],
    knowledgeTargets: [],
    markdown,
  };
}

/**
 * Bind an exact episode context to a real Run. The immutable file and
 * Artifact are content-addressed; retries reuse the same Artifact and repair
 * missing lineage events without creating a second truth.
 */
export function materializeExperienceContext(
  home: string,
  store: LedgerStore,
  experience: ExperienceRecord,
  runId: string,
  limit?: number,
): MaterializedExperienceContext {
  const run = store.requireRun(runId);
  const task = store.requireTask(run.taskId);
  if (task.scope !== experience.scope) {
    throw new Error(`Task ${task.id} scope ${task.scope} does not match Experience scope ${experience.scope}`);
  }
  const context = buildExperienceContext(home, experience, limit, store);
  const hash = sha256(context.markdown);
  if (!/^exp-[A-Za-z0-9-]+$/.test(experience.id)) throw new Error(`Unsafe Experience id: ${experience.id}`);
  const immutablePath = join(run.runDir, `experience-${experience.id}-context-${hash.slice(0, 16)}.md`);
  writeImmutableFile(immutablePath, context.markdown);
  const latestPath = join(run.runDir, `experience-${experience.id}-context.md`);
  writeFileSync(latestPath, context.markdown, { mode: 0o600 });
  chmodSync(latestPath, 0o600);

  const contextArtifact = store.listArtifacts({ runId: run.id })
    .find((artifact) => artifact.kind === "experience-context"
      && artifact.contentHash === hash
      && resolve(artifact.path) === resolve(immutablePath))
    ?? store.createArtifact({
      runId: run.id,
      kind: "experience-context",
      label: `Experience Context：${experience.sourceTitle}`,
      path: immutablePath,
    });
  if (contextArtifact.contentHash !== hash) throw new Error(`Experience Context Artifact hash mismatch: ${contextArtifact.id}`);

  const events = store.listEvents();
  const alreadyLinked = events.some((event) => event.aggregateType === "run"
    && event.aggregateId === run.id
    && event.eventType === "run.artifact_linked"
    && event.payload.artifactId === contextArtifact.id
    && event.payload.relation === "produced");
  if (!alreadyLinked) {
    store.recordHarnessEvent(run.id, "run.artifact_linked", {
      artifactId: contextArtifact.id,
      relation: "produced",
      lineageRefs: [
        experience.id,
        ...experience.sourceIds,
        ...context.events.map((event) => event.eventId),
        ...context.knowledgeTargets.map((knowledge) => `knowledge://${knowledge.id}`),
        ...context.artifacts.map((artifact) => `artifact://${artifact.id}`),
      ],
    });
  }

  const refreshedEvents = store.listEvents();
  const alreadyRecorded = refreshedEvents.some((event) => event.aggregateType === "experience"
    && event.aggregateId === experience.id
    && event.eventType === "experience.context_built"
    && event.payload.artifactId === contextArtifact.id);
  if (!alreadyRecorded) {
    store.recordExperienceEvent(experience.id, "experience.context_built", {
      schema: EXPERIENCE_CONTEXT_VERSION,
      taskId: task.id,
      runId: run.id,
      artifactId: contextArtifact.id,
      contentHash: hash,
      sourceIds: experience.sourceIds,
      sourceRecordIds: context.records.flatMap((record) => record.equivalentRecordIds),
      logicalRecordIds: context.records.map((record) => record.id),
      evidenceRecordIds: experience.evidenceRecordIds,
      evidenceEventIds: context.events.map((event) => event.eventId),
      artifactIds: context.artifacts.map((artifact) => artifact.id),
      targetKnowledgeIds: context.knowledgeTargets.map((knowledge) => knowledge.id),
      totalRecords: context.totalRecords,
      sourceRecordCount: context.sourceRecordCount,
      truncated: context.truncated,
    });
  }
  for (const sourceId of experience.sourceIds) {
    const sourceAlreadyRecorded = store.listEvents().some((event) => event.aggregateType === "source"
      && event.aggregateId === sourceId
      && event.eventType === "source.context_built"
      && event.payload.artifactId === contextArtifact.id);
    if (sourceAlreadyRecorded) continue;
    store.recordSourceEvent(sourceId, "source.context_built", {
      experienceId: experience.id,
      runId: run.id,
      artifactId: contextArtifact.id,
      contentHash: hash,
      records: context.records.filter((record) => record.equivalentSourceIds.includes(sourceId)).length,
      sourceRecordRefs: context.records.flatMap((record) => record.equivalentRecordIds)
        .filter((recordId) => recordId.startsWith(`${sourceId}:`)).length,
      truncated: context.truncated,
    });
  }
  return { ...context, contextArtifact };
}

function buildEventExperienceContext(
  home: string,
  store: LedgerStore,
  experience: ExperienceRecord,
  limit?: number,
): ExperienceContext {
  const requestedEventIds = new Set(experience.evidenceEventIds);
  if (requestedEventIds.size !== experience.evidenceEventIds.length) throw new Error(`Experience ${experience.id} contains duplicate evidence Event ids`);
  const resolved = store.listEvents().filter((event) => requestedEventIds.has(event.eventId));
  const unresolved = experience.evidenceEventIds.filter((id) => !resolved.some((event) => event.eventId === id));
  if (unresolved.length > 0) throw new Error(`Experience ${experience.id} could not resolve evidence Events: ${unresolved.join(", ")}`);
  const selected = limit === undefined ? resolved : resolved.slice(0, limit);
  const artifacts = new Map<string, ExperienceContextArtifact>();
  const knowledgeTargets = new Map<string, ExperienceContextKnowledgeTarget>();
  const events: ExperienceContextEvent[] = selected.map((event) => {
    if (event.aggregateType !== "knowledge" || event.eventType !== "knowledge.feedback_recorded") {
      throw new Error(`Event-backed Experience ${experience.id} has unsupported evidence Event: ${event.eventId}`);
    }
    const outcome = String(event.payload.outcome);
    if (outcome !== "partial" && outcome !== "incorrect") throw new Error(`Event-backed Experience ${experience.id} has non-corrective feedback: ${event.eventId}`);
    const knowledge = findKnowledge(home, event.aggregateId);
    if (!knowledge) throw new Error(`Feedback Event ${event.eventId} targets missing Knowledge: ${event.aggregateId}`);
    if (knowledge.scope !== experience.scope) throw new Error(`Knowledge ${knowledge.id} scope ${knowledge.scope} does not match Experience scope ${experience.scope}`);
    knowledgeTargets.set(knowledge.id, {
      id: knowledge.id,
      title: knowledge.title,
      scope: knowledge.scope,
      status: knowledge.status,
      verification: knowledge.verification ?? "unverified",
      path: knowledge.path,
    });
    const runId = textValue(event.payload.runId);
    const taskId = textValue(event.payload.taskId);
    const run = store.getRun(runId);
    const task = store.getTask(taskId);
    if (!run || !task || run.taskId !== task.id || task.scope !== experience.scope) {
      throw new Error(`Feedback Event ${event.eventId} has an invalid Task or Run binding`);
    }
    if (!experience.runIds.includes(runId)) throw new Error(`Feedback Event ${event.eventId} Run is outside Experience ${experience.id}`);
    const artifactIds = evidenceArtifactIds(event.payload);
    if (artifactIds.length === 0) throw new Error(`Feedback Event ${event.eventId} has no registered Artifact reference`);
    for (const artifactId of artifactIds) {
      const artifact = store.getArtifact(artifactId);
      if (!artifact || artifact.runId !== runId) throw new Error(`Feedback Event ${event.eventId} references an invalid Artifact: ${artifactId}`);
      artifacts.set(artifact.id, {
        id: artifact.id,
        runId: artifact.runId,
        kind: artifact.kind,
        label: artifact.label,
        path: artifact.path,
        contentHash: artifact.contentHash,
      });
    }
    return {
      eventId: event.eventId,
      knowledgeId: knowledge.id,
      taskId,
      runId,
      outcome,
      reasonCode: textValue(event.payload.reasonCode),
      note: typeof event.payload.note === "string" ? bounded(event.payload.note, 2_000) : null,
      artifactIds,
      occurredAt: event.occurredAt,
    };
  });
  const artifactList = [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id));
  const knowledgeList = [...knowledgeTargets.values()].sort((left, right) => left.id.localeCompare(right.id));
  const markdown = renderEventExperienceContext(experience, events, artifactList, knowledgeList, resolved.length);
  return {
    schema: EXPERIENCE_CONTEXT_VERSION,
    experienceId: experience.id,
    scope: experience.scope,
    sourceOriginHash: experience.sourceOriginHash,
    sourceIds: [],
    evidenceRecordIds: [],
    sourceRecordCount: 0,
    totalRecords: resolved.length,
    truncated: events.length < resolved.length,
    records: [],
    events,
    artifacts: artifactList,
    knowledgeTargets: knowledgeList,
    markdown,
  };
}

function compareLocatedMessages(left: LocatedMessage, right: LocatedMessage): number {
  const leftTime = timestampNumber(left.message.timestamp);
  const rightTime = timestampNumber(right.message.timestamp);
  return leftTime - rightTime
    || left.sourceIndex - right.sourceIndex
    || left.recordIndex - right.recordIndex
    || left.message.id.localeCompare(right.message.id);
}

function timestampNumber(value: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function groupMirroredMessages(messages: LocatedMessage[]): LogicalMessage[] {
  const groups = new Map<string, LogicalMessage>();
  for (const located of messages) {
    const relativeRecordId = located.message.id.startsWith(`${located.source.id}:`)
      ? located.message.id.slice(located.source.id.length + 1)
      : located.message.id;
    const key = sha256(JSON.stringify({
      relativeRecordId,
      conversationId: located.message.conversationId,
      role: located.message.role,
      actor: located.message.actor,
      timestamp: located.message.timestamp,
      content: located.message.content,
      participants: [...located.message.participants].sort(),
    }));
    const existing = groups.get(key);
    if (existing) existing.copies.push(located);
    else groups.set(key, { canonical: located, copies: [located] });
  }
  return [...groups.values()];
}

function renderExperienceContext(
  experience: ExperienceRecord,
  sources: SourceRecord[],
  records: ExperienceContextMessage[],
  totalRecords: number,
  sourceRecordCount: number,
): string {
  return [
    `# Experience Context: ${experience.sourceTitle}`,
    "",
    `- Schema: ${EXPERIENCE_CONTEXT_VERSION}`,
    `- Experience ID: ${experience.id}`,
    `- Scope: ${experience.scope}`,
    `- Source origin hash: ${experience.sourceOriginHash}`,
    `- Sources: ${sources.map((source) => `${source.id} (${source.title})`).join(", ")}`,
    `- Signals: ${experience.signalCodes.join(", ") || "none"}`,
    `- Logical records: ${records.length}/${totalRecords}`,
    `- Source record refs: ${records.reduce((count, record) => count + record.equivalentRecordIds.length, 0)}/${sourceRecordCount}`,
    `- Triage evidence records: ${experience.evidenceRecordIds.length}`,
    `- Truncated: ${records.length < totalRecords ? "yes" : "no"}`,
    "",
    ...records.flatMap((record, index) => [
      `## ${index + 1}. ${record.id}`,
      `- Source: ${record.sourceId} (${record.sourceTitle})`,
      `- Equivalent sources: ${record.equivalentSourceIds.join(", ")}`,
      `- Equivalent record refs: ${record.equivalentRecordIds.join(", ")}`,
      `- Conversation: ${record.conversationId}`,
      `- Role: ${record.role}`,
      `- Actor: ${record.actor}`,
      `- Timestamp: ${record.timestamp || "unknown"}`,
      `- Triage evidence: ${record.triageEvidence ? "yes" : "no"}`,
      `- Triage evidence refs: ${record.triageEvidenceRecordIds.join(", ") || "none"}`,
      `- Participants: ${record.participants.join(", ") || "unknown"}`,
      `- Refs: ${record.refs.join(", ") || "none"}`,
      "",
      record.content.trim(),
      "",
    ]),
  ].join("\n");
}

function renderEventExperienceContext(
  experience: ExperienceRecord,
  events: ExperienceContextEvent[],
  artifacts: ExperienceContextArtifact[],
  knowledgeTargets: ExperienceContextKnowledgeTarget[],
  totalEvents: number,
): string {
  return [
    `# Experience Context: ${experience.sourceTitle}`,
    "",
    `- Schema: ${EXPERIENCE_CONTEXT_VERSION}`,
    `- Experience ID: ${experience.id}`,
    `- Scope: ${experience.scope}`,
    `- Source origin hash: ${experience.sourceOriginHash}`,
    "- Sources: none (event-backed Knowledge feedback)",
    `- Signals: ${experience.signalCodes.join(", ") || "none"}`,
    `- Evidence Events: ${events.length}/${totalEvents}`,
    `- Truncated: ${events.length < totalEvents ? "yes" : "no"}`,
    "",
    "## Target Knowledge",
    "",
    ...knowledgeTargets.flatMap((knowledge) => [
      `- ${knowledge.id} · ${knowledge.title}`,
      `  - Scope/status/verification: ${knowledge.scope} / ${knowledge.status} / ${knowledge.verification}`,
      `  - Local path: ${knowledge.path}`,
    ]),
    "",
    "## Registered evidence Artifacts",
    "",
    ...artifacts.flatMap((artifact) => [
      `- ${artifact.id} · ${artifact.label}`,
      `  - Run/kind: ${artifact.runId} / ${artifact.kind}`,
      `  - SHA-256: ${artifact.contentHash}`,
      `  - Local path: ${artifact.path}`,
    ]),
    "",
    "## Feedback Events",
    "",
    ...events.flatMap((event, index) => [
      `### ${index + 1}. ${event.eventId}`,
      `- Knowledge: ${event.knowledgeId}`,
      `- Task / Run: ${event.taskId} / ${event.runId}`,
      `- Outcome: ${event.outcome}`,
      `- Reason code: ${event.reasonCode}`,
      `- Evidence Artifacts: ${event.artifactIds.join(", ")}`,
      `- Occurred at: ${event.occurredAt}`,
      `- Note: ${event.note ?? "none"}`,
      "",
    ]),
    "Artifact正文没有复制进 Context；需要语义分析时按上面的本机路径读取，并核对 SHA-256。",
  ].join("\n");
}

function evidenceArtifactIds(payload: Record<string, unknown>): string[] {
  const refs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
  return unique(refs.flatMap((value) => {
    if (typeof value !== "string") return [];
    const normalized = value.replace(/^artifact:\/\//, "");
    return /^artifact-[A-Za-z0-9._-]+$/.test(normalized) ? [normalized] : [];
  }));
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function writeImmutableFile(path: string, content: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Experience Context path must be a regular file: ${path}`);
    if (readFileSync(path, "utf8") !== content) throw new Error(`Immutable Experience Context hash collision: ${path}`);
    return;
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
