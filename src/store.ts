import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Approval, Artifact, EventRecord, Run, StoreOptions, Task } from "./types.ts";
import { normalizeHarnessEvent, type HarnessEventType } from "../projects/eval-plane/src/harness-events.ts";
import { STORAGE_ROOT_AGGREGATE_ID, STORAGE_ROOT_RELOCATED_EVENT, StoragePathResolver, normalizeRelocation, storageRootRelocations, type StorageRootRelocation } from "./storage-relocation.ts";
import { resolveLedgerPath, resolveLedgerRoot, resolveRunsRoot } from "./layout.ts";

type Row = Record<string, any>;
type EventPayload = Record<string, unknown>;

interface Projection {
  tasks: Map<string, Task>;
  runs: Map<string, Run>;
  approvals: Map<string, Approval>;
  artifacts: Map<string, Artifact>;
}

const TASK_TRANSITIONS: Record<string, string[]> = {
  open: ["active", "waiting", "done", "canceled"],
  active: ["waiting", "done", "canceled"],
  waiting: ["open", "active", "done", "canceled"],
  done: [],
  canceled: [],
};

export class LedgerStore {
  readonly home: string;
  readonly ledgerDir: string;
  readonly eventsPath: string;
  readonly runsDir: string;
  private readonly lockPath: string;
  private readonly actor: string;
  private events: EventRecord[] = [];
  private pendingEvents: EventRecord[] | null = null;
  private eventsSignature = "";
  private projectionCache: Projection | null = null;

  constructor(options: StoreOptions) {
    this.home = resolve(options.home);
    this.ledgerDir = resolveLedgerRoot(this.home);
    this.eventsPath = resolveLedgerPath(this.home);
    this.runsDir = resolveRunsRoot(this.home);
    this.lockPath = join(this.ledgerDir, "events.lock");
    this.actor = options.actor ?? process.env.IKB_ACTOR ?? "human";
    mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.ledgerDir, 0o700);
    chmodSync(this.runsDir, 0o700);
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "", { mode: 0o600 });
    chmodSync(this.eventsPath, 0o600);
    this.reload(true);
  }

  close(): void {
    this.events = [];
    this.eventsSignature = "";
    this.projectionCache = null;
  }

  reload(force = true): void {
    const signature = fileSignature(this.eventsPath);
    if (!force && signature === this.eventsSignature) return;
    this.events = readEventsFile(this.eventsPath);
    this.eventsSignature = signature;
    this.projectionCache = null;
  }

  createTask(input: {
    title: string;
    goal: string;
    acceptance: string;
    type?: string;
    priority?: string;
    risk?: string;
    scope?: string;
  }): Task {
    const timestamp = now();
    const task: Task = {
      id: makeId("task"),
      title: input.title,
      goal: input.goal,
      acceptance: input.acceptance,
      type: input.type ?? "general",
      priority: input.priority ?? "normal",
      risk: input.risk ?? "low",
      scope: input.scope ?? "personal",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      evidenceArtifactId: null,
    };
    this.transact(() => {
      this.appendEventInternal("task", task.id, "task.created", taskPayload(task), null);
    });
    return task;
  }

  updateTask(taskId: string, fields: Partial<Pick<Task, "title" | "goal" | "acceptance" | "type" | "priority" | "risk" | "scope">>): Task {
    this.requireTask(taskId);
    this.transact(() => {
      this.appendEventInternal("task", taskId, "task.updated", { ...fields, updatedAt: now() }, null);
    });
    return this.requireTask(taskId);
  }

  transitionTask(taskId: string, status: Task["status"], reason?: string, evidenceArtifactId?: string): Task {
    const task = this.requireTask(taskId);
    if (!TASK_TRANSITIONS[task.status]?.includes(status)) {
      throw new Error(`Task ${taskId} cannot move from ${task.status} to ${status}`);
    }
    if (status === "done" && evidenceArtifactId) {
      const artifact = this.requireArtifact(evidenceArtifactId);
      if (artifact.taskId !== taskId) throw new Error(`Artifact ${evidenceArtifactId} does not belong to Task ${taskId}`);
    }
    this.transact(() => {
      this.appendEventInternal("task", taskId, `task.${status}`, {
        status,
        reason: reason ?? null,
        evidenceArtifactId: evidenceArtifactId ?? null,
        updatedAt: now(),
      }, null);
    });
    return this.requireTask(taskId);
  }

  createRun(taskId: string, agentId: string, skillIds: string[] = [], retryOf: string | null = null): Run {
    const task = this.requireTask(taskId);
    const timestamp = now();
    const runId = makeId("run");
    const run: Run = {
      id: runId,
      taskId,
      agentId,
      skillIds: skillIds.join(","),
      status: "queued",
      retryOf,
      startedAt: null,
      finishedAt: null,
      checkpoint: null,
      failureReason: null,
      runDir: join(this.runsDir, makeRunDirName(taskId, runId)),
    };
    mkdirSync(run.runDir, { recursive: true, mode: 0o700 });
    chmodSync(run.runDir, 0o700);
    writeFileSync(join(run.runDir, "input.json"), `${JSON.stringify({ task, run }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify({ status: "planned", steps: [] }, null, 2)}\n`, { mode: 0o600 });
    this.transact(() => {
      if (task.status === "open") this.appendEventInternal("task", taskId, "task.started", { status: "active", updatedAt: timestamp }, null);
      this.appendEventInternal("run", runId, "run.queued", runPayload(run), null);
      this.appendEventInternal("run", runId, "run.started", { status: "running", startedAt: timestamp }, null);
    });
    this.writeRunSnapshot(runId);
    return this.requireRun(runId);
  }

  finishRun(runId: string, status: Extract<Run["status"], "succeeded" | "failed" | "canceled">, summary?: string): Run {
    const run = this.requireRun(runId);
    if (!["queued", "running", "awaiting_approval"].includes(run.status)) {
      throw new Error(`Run ${runId} cannot finish from ${run.status}`);
    }
    if (run.status === "awaiting_approval" && status === "succeeded") {
      throw new Error(`Run ${runId} is waiting for Approval and cannot succeed yet`);
    }
    const eventType = status === "failed" ? "run.failed" : status === "canceled" ? "run.canceled" : "run.finished";
    const payload = {
      status,
      finishedAt: now(),
      summary: summary ?? null,
      failureReason: status === "failed" ? (summary ?? "unspecified failure") : null,
    };
    this.transact(() => {
      this.appendEventInternal("run", runId, eventType, payload, null);
    });
    this.writeRunSnapshot(runId, payload);
    return this.requireRun(runId);
  }

  checkpointRun(runId: string, checkpoint: string): Run {
    this.requireRun(runId);
    this.transact(() => {
      this.appendEventInternal("run", runId, "run.checkpointed", { checkpoint }, null);
    });
    this.writeRunSnapshot(runId);
    return this.requireRun(runId);
  }

  /**
   * Append a typed Harness event to the Run aggregate.
   *
   * The normalizer is intentionally strict: a Run may expose references and
   * hashes to observers, but never prompts, model output, local paths or raw
   * tool payloads.  The ledger remains the source of truth; projections such
   * as local reports consume these events after the fact.
   */
  recordHarnessEvent(runId: string, eventType: HarnessEventType, payload: unknown): EventRecord {
    this.requireRun(runId);
    const normalized = normalizeHarnessEvent(eventType, payload) as EventPayload;
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("run", runId, eventType, normalized, null);
    });
    this.writeRunSnapshot(runId);
    return event!;
  }

  resumeRun(runId: string): Run {
    const run = this.requireRun(runId);
    if (!["awaiting_approval", "failed", "queued"].includes(run.status)) {
      throw new Error(`Run ${runId} cannot resume from ${run.status}`);
    }
    this.transact(() => {
      this.appendEventInternal("run", runId, "run.resumed", { status: "running", resumedAt: now() }, null);
    });
    this.writeRunSnapshot(runId);
    return this.requireRun(runId);
  }

  retryRun(runId: string, agentId?: string): Run {
    const run = this.requireRun(runId);
    const latestEvaluation = this.events.filter((event) => event.aggregateType === "run" && event.aggregateId === runId && event.eventType === "run.evaluation_completed").at(-1);
    const qualityBlocked = run.status === "succeeded" && ["partial", "blocked"].includes(String(latestEvaluation?.payload.result ?? ""));
    if (!["failed", "canceled"].includes(run.status) && !qualityBlocked) {
      throw new Error(`Run ${runId} must be failed, canceled, or terminal-succeeded with a blocked/partial Evaluation before retry`);
    }
    return this.createRun(run.taskId, agentId ?? run.agentId, run.skillIds ? run.skillIds.split(",").filter(Boolean) : [], runId);
  }

  requestApproval(input: { runId: string; action: string; target: string; payload?: unknown; risk?: string }): Approval {
    const run = this.requireRun(input.runId);
    const actionPayload = normalizeJsonValue(input.payload ?? {});
    const approval: Approval = {
      id: makeId("approval"),
      taskId: run.taskId,
      runId: run.id,
      action: input.action,
      target: input.target,
      payloadHash: sha256(stableStringify(actionPayload)),
      risk: input.risk ?? "high",
      status: "pending",
      requestedAt: now(),
      decidedAt: null,
      decisionNote: null,
    };
    this.transact(() => {
      this.appendEventInternal("approval", approval.id, "approval.requested", { ...approval, payload: actionPayload }, null);
      this.appendEventInternal("run", run.id, "run.awaiting_approval", { status: "awaiting_approval", approvalId: approval.id }, approval.id);
    });
    this.writeRunSnapshot(run.id);
    return this.requireApproval(approval.id);
  }

  decideApproval(approvalId: string, status: Extract<Approval["status"], "approved" | "rejected">, note?: string): Approval {
    const approval = this.requireApproval(approvalId);
    if (approval.status !== "pending") throw new Error(`Approval ${approvalId} is already ${approval.status}`);
    this.transact(() => {
      this.appendEventInternal("approval", approvalId, `approval.${status}`, { status, decidedAt: now(), decisionNote: note ?? null }, null);
      if (status === "rejected") {
        this.appendEventInternal("run", approval.runId, "run.failed", { status: "failed", finishedAt: now(), summary: note ?? "approval rejected", failureReason: note ?? "approval rejected" }, approvalId);
      }
    });
    this.writeRunSnapshot(approval.runId);
    return this.requireApproval(approvalId);
  }

  createArtifact(input: { runId: string; kind: string; label: string; path: string }): Artifact {
    const run = this.requireRun(input.runId);
    const path = resolve(input.path);
    const artifact: Artifact = {
      id: makeId("artifact"),
      taskId: run.taskId,
      runId: run.id,
      kind: input.kind,
      label: input.label,
      path,
      contentHash: existsSync(path) ? sha256(readFileSync(path)) : null,
      createdAt: now(),
    };
    this.transact(() => {
      this.appendEventInternal("artifact", artifact.id, "artifact.created", artifact, null);
    });
    this.writeRunSnapshot(run.id);
    return this.requireArtifact(artifact.id);
  }

  recordKnowledgeEvent(knowledgeId: string, eventType: "knowledge.created" | "knowledge.verified" | "knowledge.revised" | "knowledge.retired" | "knowledge.archived" | "knowledge.related" | "knowledge.migrated" | "knowledge.referenced" | "knowledge.used" | "knowledge.feedback_recorded", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("knowledge", knowledgeId, eventType, payload, null);
    });
    return event!;
  }

  recordKnowledgeQueryEvent(payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("knowledge_query", makeId("query"), "knowledge.query_executed", payload, null);
    });
    return event!;
  }

  recordKnowledgeUsageEvent(knowledgeId: string, payload: EventPayload): EventRecord {
    const normalized = normalizeJsonValue(payload) as EventPayload;
    const payloadHash = sha256(stableStringify(normalized));
    let event: EventRecord;
    this.transact(() => {
      const events = [...this.events, ...(this.pendingEvents ?? [])];
      const existing = events.find((candidate) => candidate.aggregateType === "knowledge"
        && candidate.aggregateId === knowledgeId
        && candidate.eventType === "knowledge.used"
        && candidate.payloadHash === payloadHash);
      event = existing ?? this.appendEventInternal("knowledge", knowledgeId, "knowledge.used", normalized, null);
    });
    return event!;
  }

  recordKnowledgeFeedbackEvent(knowledgeId: string, payload: EventPayload): EventRecord {
    const normalized = normalizeJsonValue(payload) as EventPayload;
    const payloadHash = sha256(stableStringify(normalized));
    const runId = String(normalized.runId ?? "");
    let event: EventRecord;
    this.transact(() => {
      const events = [...this.events, ...(this.pendingEvents ?? [])];
      const existing = events.find((candidate) => candidate.aggregateType === "knowledge"
        && candidate.aggregateId === knowledgeId
        && candidate.eventType === "knowledge.feedback_recorded"
        && candidate.payload.runId === runId);
      if (existing && existing.payloadHash !== payloadHash) {
        throw new Error(`Knowledge ${knowledgeId} already has final feedback for Run ${runId}: ${String(existing.payload.outcome ?? "unknown")}`);
      }
      event = existing ?? this.appendEventInternal("knowledge", knowledgeId, "knowledge.feedback_recorded", normalized, null);
    });
    return event!;
  }

  recordReceiptEvent(receiptId: string, payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("receipt", receiptId, "receipt.written", payload, null);
    });
    return event!;
  }

  recordPublicationEvent(
    releaseId: string,
    eventType: "publication.built" | "publication.verified" | "publication.approved" | "publication.released" | "publication.withdrawn",
    payload: EventPayload,
  ): EventRecord {
    const normalized = normalizeJsonValue(payload) as EventPayload;
    const payloadHash = sha256(stableStringify(normalized));
    let event: EventRecord;
    this.transact(() => {
      const events = [...this.events, ...(this.pendingEvents ?? [])];
      const existing = events.find((candidate) => candidate.aggregateType === "publication"
        && candidate.aggregateId === releaseId
        && candidate.eventType === eventType
        && candidate.payloadHash === payloadHash);
      event = existing ?? this.appendEventInternal("publication", releaseId, eventType, normalized, null);
    });
    return event!;
  }

  recordKnowledgeMigrationEvents(items: Array<{ id: string; payload: EventPayload }>): EventRecord[] {
    const recorded: EventRecord[] = [];
    this.transact(() => {
      for (const item of items) {
        const events = [...this.events, ...(this.pendingEvents ?? [])];
        const exists = events.some((event) => event.eventType === "knowledge.migrated"
          && event.aggregateId === item.id
          && event.payload.from === item.payload.from
          && event.payload.to === item.payload.to);
        if (!exists) recorded.push(this.appendEventInternal("knowledge", item.id, "knowledge.migrated", item.payload, null));
      }
    });
    return recorded;
  }

  recordSourceEvent(sourceId: string, eventType: "source.ingested" | "source.context_built" | "source.history_scan" | "source.file_scan" | "source.citadel_search" | "source.citadel_read_started" | "source.candidate_discovery" | "source.incremental_scan" | "source.aliases_updated", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("source", sourceId, eventType, payload, null);
    });
    return event!;
  }

  recordSourceEvents(items: Array<{ id: string; eventType: "source.ingested" | "source.context_built" | "source.history_scan" | "source.file_scan" | "source.citadel_search" | "source.citadel_read_started" | "source.candidate_discovery" | "source.incremental_scan" | "source.aliases_updated"; payload: EventPayload }>): EventRecord[] {
    const recorded: EventRecord[] = [];
    this.transact(() => {
      for (const item of items) recorded.push(this.appendEventInternal("source", item.id, item.eventType, item.payload, null));
    });
    return recorded;
  }

  recordCandidateEvent(candidateId: string, eventType: "candidate.discovered" | "candidate.queued" | "candidate.resolve_started" | "candidate.ingested" | "candidate.rejected" | "candidate.blocked" | "candidate.updated", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("candidate", candidateId, eventType, payload, null);
    });
    return event!;
  }

  recordExperienceEvent(experienceId: string, eventType: "experience.queued" | "experience.updated" | "experience.ignored" | "experience.context_built" | "experience.analyzed" | "experience.analysis_invalidated" | "experience.validation_recorded" | "experience.candidate_created" | "experience.candidate_updated" | "experience.candidate_accepted" | "experience.candidate_rejected" | "experience.candidate_applied", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("experience", experienceId, eventType, payload, null);
    });
    return event!;
  }

  recordExperienceEvents(items: Array<{ id: string; eventType: "experience.queued" | "experience.updated" | "experience.ignored" | "experience.analysis_invalidated"; payload: EventPayload }>): EventRecord[] {
    const recorded: EventRecord[] = [];
    if (items.length === 0) return recorded;
    this.transact(() => {
      for (const item of items) recorded.push(this.appendEventInternal("experience", item.id, item.eventType, item.payload, null));
    });
    return recorded;
  }

  recordReasoningEvent(reasoningId: string, eventType: "reasoning.generated", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("reasoning", reasoningId, eventType, payload, null);
    });
    return event!;
  }

  recordPersonEvent(personId: string, eventType: "person.added" | "person.updated" | "person.removed" | "person.view_built" | "person.analysis_checkpointed", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("person", personId, eventType, payload, null);
    });
    return event!;
  }

  recordSourceIngestEvents(items: Array<{ id: string; payload: EventPayload }>): EventRecord[] {
    const recorded: EventRecord[] = [];
    this.transact(() => {
      const existingSourceIds = new Set([...this.events, ...(this.pendingEvents ?? [])]
        .filter((event) => event.aggregateType === "source" && event.eventType === "source.ingested")
        .map((event) => event.aggregateId));
      for (const item of items) {
        if (existingSourceIds.has(item.id)) continue;
        recorded.push(this.appendEventInternal("source", item.id, "source.ingested", item.payload, null));
        existingSourceIds.add(item.id);
      }
    });
    return recorded;
  }

  /** Records a project-root or in-home layout move without rewriting history. */
  recordStorageRootRelocation(input: StorageRootRelocation): EventRecord {
    return this.recordStorageRootRelocations([input])[0];
  }

  recordStorageRootRelocations(inputs: StorageRootRelocation[]): EventRecord[] {
    if (inputs.length === 0) return [];
    const relocations = inputs.map((input) => normalizeRelocation(input));
    for (const relocation of relocations) this.assertStorageRelocationAllowed(relocation);
    const recorded: EventRecord[] = [];
    this.transact(() => {
      const events = [...this.events, ...(this.pendingEvents ?? [])];
      const existingRelocations = storageRootRelocations(events);
      new StoragePathResolver([...existingRelocations, ...relocations]);
      for (const relocation of relocations) {
        const existing = existingRelocations.find((candidate) => candidate.fromRoot === relocation.fromRoot);
        if (existing && existing.toRoot !== relocation.toRoot) {
          throw new Error(`Storage relocation already maps ${relocation.fromRoot} to ${existing.toRoot}`);
        }
        const priorEvent = events.find((candidate) => candidate.aggregateType === "system"
          && candidate.eventType === STORAGE_ROOT_RELOCATED_EVENT
          && candidate.payload.fromRoot === relocation.fromRoot
          && candidate.payload.toRoot === relocation.toRoot);
        recorded.push(priorEvent ?? this.appendEventInternal("system", STORAGE_ROOT_AGGREGATE_ID, STORAGE_ROOT_RELOCATED_EVENT, relocation, null));
      }
    });
    return recorded;
  }

  resolveStoragePath(path: string): string {
    return new StoragePathResolver(storageRootRelocations(this.listEvents())).resolve(path);
  }

  private assertStorageRelocationAllowed(relocation: StorageRootRelocation): void {
    const currentProjectRoot = resolve(dirname(this.home));
    const layoutMove = isWithin(relocation.fromRoot, this.home)
      && relocation.fromRoot !== this.home
      && isWithin(relocation.toRoot, this.home);
    if (relocation.toRoot !== currentProjectRoot && !layoutMove) {
      throw new Error(`Storage relocation must target the current project root or stay inside IKB home: ${this.home}`);
    }
  }

  verify(): { events: number; brokenChains: string[]; projections: Record<string, number> } {
    const events = this.listEvents();
    const brokenChains: string[] = [];
    const previousByAggregate = new Map<string, string | null>();
    for (const event of events) {
      const key = `${event.aggregateType}:${event.aggregateId}`;
      const previousHash = previousByAggregate.get(key) ?? null;
      const expectedEventHash = hashEvent(event);
      const expectedPayloadHash = sha256(stableStringify(event.payload));
      if (event.previousHash !== previousHash || event.payloadHash !== expectedPayloadHash || event.eventHash !== expectedEventHash) brokenChains.push(event.eventId);
      previousByAggregate.set(key, event.eventHash);
    }
    const projection = this.project(events);
    return {
      events: events.length,
      brokenChains,
      projections: {
        tasks: projection.tasks.size,
        runs: projection.runs.size,
        approvals: projection.approvals.size,
        artifacts: projection.artifacts.size,
      },
    };
  }

  stats(): Record<string, unknown> {
    const projection = this.currentProjection();
    return {
      tasks: groupCount([...projection.tasks.values()], "status"),
      runs: groupCount([...projection.runs.values()], "status"),
      approvals: groupCount([...projection.approvals.values()], "status"),
      recentFailures: [...projection.runs.values()]
        .filter((run) => run.status === "failed")
        .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)))
        .slice(0, 5)
        .map((run) => ({ id: run.id, taskId: run.taskId, reason: run.failureReason, finishedAt: run.finishedAt })),
    };
  }

  getTask(id: string): Task | null {
    return this.currentProjection().tasks.get(id) ?? null;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  listTasks(filters: { status?: string; type?: string } = {}): Task[] {
    return [...this.currentProjection().tasks.values()]
      .filter((task) => !filters.status || task.status === filters.status)
      .filter((task) => !filters.type || task.type === filters.type)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getRun(id: string): Run | null {
    return this.currentProjection().runs.get(id) ?? null;
  }

  requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  listRuns(filters: { taskId?: string; status?: string } = {}): Run[] {
    return [...this.currentProjection().runs.values()]
      .filter((run) => !filters.taskId || run.taskId === filters.taskId)
      .filter((run) => !filters.status || run.status === filters.status)
      .sort((left, right) => String(right.startedAt ?? right.id).localeCompare(String(left.startedAt ?? left.id)));
  }

  getApproval(id: string): Approval | null {
    return this.currentProjection().approvals.get(id) ?? null;
  }

  requireApproval(id: string): Approval {
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    return approval;
  }

  listApprovals(filters: { status?: string; taskId?: string } = {}): Approval[] {
    return [...this.currentProjection().approvals.values()]
      .filter((approval) => !filters.status || approval.status === filters.status)
      .filter((approval) => !filters.taskId || approval.taskId === filters.taskId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  getArtifact(id: string): Artifact | null {
    return this.currentProjection().artifacts.get(id) ?? null;
  }

  requireArtifact(id: string): Artifact {
    const artifact = this.getArtifact(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    return artifact;
  }

  listArtifacts(filters: { runId?: string; taskId?: string } = {}): Artifact[] {
    return [...this.currentProjection().artifacts.values()]
      .filter((artifact) => !filters.runId || artifact.runId === filters.runId)
      .filter((artifact) => !filters.taskId || artifact.taskId === filters.taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listEvents(): EventRecord[] {
    this.reload(false);
    return [...this.events];
  }

  eventsFor(id: string): EventRecord[] {
    const events = this.listEvents();
    const projection = this.currentProjection();
    const task = projection.tasks.get(id);
    if (!task) return events.filter((event) => event.aggregateId === id);
    const related = new Set<string>([
      task.id,
      ...[...projection.runs.values()].filter((run) => run.taskId === task.id).map((run) => run.id),
      ...[...projection.approvals.values()].filter((approval) => approval.taskId === task.id).map((approval) => approval.id),
      ...[...projection.artifacts.values()].filter((artifact) => artifact.taskId === task.id).map((artifact) => artifact.id),
    ]);
    return events.filter((event) => related.has(event.aggregateId));
  }

  private project(events: EventRecord[]): Projection {
    const projection: Projection = { tasks: new Map(), runs: new Map(), approvals: new Map(), artifacts: new Map() };
    const resolver = new StoragePathResolver(storageRootRelocations(events));
    for (const event of events) applyEvent(projection, event, resolver);
    return projection;
  }

  private currentProjection(): Projection {
    this.reload(false);
    if (!this.projectionCache) this.projectionCache = this.project(this.events);
    return this.projectionCache;
  }

  private writeRunSnapshot(runId: string, terminalPayload?: EventPayload): void {
    const run = this.requireRun(runId);
    const runEvents = this.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === runId);
    writeFileSync(join(run.runDir, "events.jsonl"), `${runEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    const verification = {
      status: terminalPayload?.status ?? run.status,
      summary: terminalPayload?.summary ?? null,
      updatedAt: now(),
    };
    writeFileSync(join(run.runDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(run.runDir, "run-digest.md"), `# ${run.id}\n\n- Task: ${run.taskId}\n- Status: ${verification.status}\n- Summary: ${verification.summary ?? ""}\n`, { mode: 0o600 });
  }

  private appendEventInternal(aggregateType: string, aggregateId: string, eventType: string, payload: EventPayload, causationId: string | null): EventRecord {
    const allEvents = [...this.events, ...(this.pendingEvents ?? [])];
    const previous = [...allEvents].reverse().find((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId);
    const normalizedPayload = normalizeJsonValue(payload) as EventPayload;
    const event: EventRecord = {
      eventId: makeId("event"),
      aggregateType,
      aggregateId,
      sequence: (previous?.sequence ?? 0) + 1,
      eventType,
      actor: this.actor,
      occurredAt: now(),
      causationId,
      payload: normalizedPayload,
      payloadHash: sha256(stableStringify(normalizedPayload)),
      previousHash: previous?.eventHash ?? null,
      eventHash: "",
    };
    event.eventHash = hashEvent(event);
    this.pendingEvents?.push(event);
    return event;
  }

  private transact<T>(fn: () => T): T {
    const release = acquireLock(this.lockPath);
    try {
      this.reload(true);
      this.pendingEvents = [];
      const result = fn();
      const pending = this.pendingEvents;
      if (pending.length > 0) appendEvents(this.eventsPath, pending);
      this.events.push(...pending);
      this.eventsSignature = fileSignature(this.eventsPath);
      this.projectionCache = null;
      this.pendingEvents = null;
      return result;
    } catch (error) {
      this.pendingEvents = null;
      throw error;
    } finally {
      release();
    }
  }
}

function isWithin(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function applyEvent(projection: Projection, event: EventRecord, resolver: StoragePathResolver): void {
  const payload = event.payload as Row;
  const task = projection.tasks.get(event.aggregateId);
  if (event.eventType === "task.created") {
    projection.tasks.set(event.aggregateId, { ...payload } as Task);
    return;
  }
  if (event.aggregateType === "task" && task) {
    if (event.eventType === "task.updated") {
      projection.tasks.set(event.aggregateId, { ...task, ...payload, updatedAt: payload.updatedAt ?? event.occurredAt });
    } else if (event.eventType.startsWith("task.")) {
      const status = payload.status ?? event.eventType.slice("task.".length);
      projection.tasks.set(event.aggregateId, {
        ...task,
        status,
        updatedAt: payload.updatedAt ?? event.occurredAt,
        completedAt: status === "done" ? event.occurredAt : task.completedAt,
        evidenceArtifactId: payload.evidenceArtifactId ?? task.evidenceArtifactId,
      });
    }
    return;
  }
  if (event.eventType === "run.queued") {
    projection.runs.set(event.aggregateId, { ...payload, runDir: resolver.resolve(String(payload.runDir)) } as Run);
    return;
  }
  const run = projection.runs.get(event.aggregateId);
  if (event.aggregateType === "run" && run) {
    if (["run.started", "run.resumed"].includes(event.eventType)) {
      projection.runs.set(event.aggregateId, { ...run, status: "running", startedAt: run.startedAt ?? payload.startedAt ?? payload.resumedAt ?? event.occurredAt, failureReason: null });
    } else if (event.eventType === "run.awaiting_approval") {
      projection.runs.set(event.aggregateId, { ...run, status: "awaiting_approval" });
    } else if (event.eventType === "run.checkpointed") {
      projection.runs.set(event.aggregateId, { ...run, checkpoint: payload.checkpoint });
    } else if (["run.finished", "run.failed", "run.canceled"].includes(event.eventType)) {
      projection.runs.set(event.aggregateId, { ...run, status: payload.status, finishedAt: payload.finishedAt ?? event.occurredAt, failureReason: payload.failureReason ?? null });
    }
    return;
  }
  if (event.eventType === "approval.requested") {
    const { payload: _payload, ...approval } = payload;
    projection.approvals.set(event.aggregateId, approval as Approval);
    return;
  }
  const approval = projection.approvals.get(event.aggregateId);
  if (event.aggregateType === "approval" && approval && ["approval.approved", "approval.rejected"].includes(event.eventType)) {
    projection.approvals.set(event.aggregateId, { ...approval, status: payload.status, decidedAt: payload.decidedAt ?? event.occurredAt, decisionNote: payload.decisionNote ?? null });
    return;
  }
  if (event.eventType === "artifact.created") {
    projection.artifacts.set(event.aggregateId, { ...payload, path: resolver.resolve(String(payload.path)) } as Artifact);
  }
}

function taskPayload(task: Task): EventPayload {
  return { ...task };
}

function runPayload(run: Run): EventPayload {
  return { ...run };
}

function readEventsFile(path: string): EventRecord[] {
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  return text.split("\n").map((line, index) => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line) as EventRecord;
    } catch (error) {
      throw new Error(`Invalid event at ${path}:${index + 1}: ${(error as Error).message}`);
    }
  }).filter(Boolean) as EventRecord[];
}

function fileSignature(path: string): string {
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

function appendEvents(path: string, events: EventRecord[]): void {
  const handle = openSync(path, "a");
  try {
    const content = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    appendFileSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = openSync(path, "wx", 0o600);
      writeFileSync(handle, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`);
      closeSync(handle);
      return () => { try { unlinkSync(path); } catch { /* another process recovered a stale lock */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 30000) rmSync(path, { force: true });
      } catch { /* lock disappeared between stat and retry */ }
      sleep(100);
    }
  }
  throw new Error(`Timed out waiting for ledger lock: ${path}`);
}

function groupCount(items: Row[], field: string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const key = String(item[field]);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function makeId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function makeRunDirName(taskId: string, runId: string): string {
  return `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${taskId}-${runId}`;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function normalizeJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashEvent(event: EventRecord): string {
  return sha256(stableStringify({
    eventId: event.eventId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
    eventType: event.eventType,
    actor: event.actor,
    occurredAt: event.occurredAt,
    causationId: event.causationId,
    payloadHash: event.payloadHash,
    previousHash: event.previousHash,
  }));
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
