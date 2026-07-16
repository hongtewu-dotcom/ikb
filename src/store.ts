import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
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
import { dirname, join, resolve } from "node:path";
import type { Approval, Artifact, EventRecord, Run, StoreOptions, Task } from "./types.ts";

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

  constructor(options: StoreOptions) {
    this.home = resolve(options.home);
    this.ledgerDir = join(this.home, "ledger");
    this.eventsPath = join(this.ledgerDir, "events.jsonl");
    this.runsDir = join(this.home, "runs");
    this.lockPath = join(this.ledgerDir, "events.lock");
    this.actor = options.actor ?? process.env.IKB_ACTOR ?? "human";
    mkdirSync(this.ledgerDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, "");
    this.reload();
  }

  close(): void {
    this.events = [];
  }

  reload(): void {
    this.events = readEventsFile(this.eventsPath);
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
    mkdirSync(run.runDir, { recursive: true });
    writeFileSync(join(run.runDir, "input.json"), `${JSON.stringify({ task, run }, null, 2)}\n`);
    writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify({ status: "planned", steps: [] }, null, 2)}\n`);
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
    if (!["failed", "canceled"].includes(run.status)) throw new Error(`Run ${runId} must be failed or canceled before retry`);
    return this.createRun(run.taskId, agentId ?? run.agentId, run.skillIds ? run.skillIds.split(",").filter(Boolean) : [], runId);
  }

  requestApproval(input: { runId: string; action: string; target: string; payload?: unknown; risk?: string }): Approval {
    const run = this.requireRun(input.runId);
    const approval: Approval = {
      id: makeId("approval"),
      taskId: run.taskId,
      runId: run.id,
      action: input.action,
      target: input.target,
      payloadHash: sha256(stableStringify(input.payload ?? {})),
      risk: input.risk ?? "high",
      status: "pending",
      requestedAt: now(),
      decidedAt: null,
      decisionNote: null,
    };
    this.transact(() => {
      this.appendEventInternal("approval", approval.id, "approval.requested", { ...approval, payload: input.payload ?? {} }, null);
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

  recordKnowledgeEvent(knowledgeId: string, eventType: "knowledge.created" | "knowledge.verified" | "knowledge.retired" | "knowledge.related", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("knowledge", knowledgeId, eventType, payload, null);
    });
    return event!;
  }

  recordSourceEvent(sourceId: string, eventType: "source.ingested" | "source.context_built", payload: EventPayload): EventRecord {
    let event: EventRecord;
    this.transact(() => {
      event = this.appendEventInternal("source", sourceId, eventType, payload, null);
    });
    return event!;
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
    const projection = this.project(this.listEvents());
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
    return this.project(this.listEvents()).tasks.get(id) ?? null;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  listTasks(filters: { status?: string; type?: string } = {}): Task[] {
    return [...this.project(this.listEvents()).tasks.values()]
      .filter((task) => !filters.status || task.status === filters.status)
      .filter((task) => !filters.type || task.type === filters.type)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getRun(id: string): Run | null {
    return this.project(this.listEvents()).runs.get(id) ?? null;
  }

  requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  listRuns(filters: { taskId?: string; status?: string } = {}): Run[] {
    return [...this.project(this.listEvents()).runs.values()]
      .filter((run) => !filters.taskId || run.taskId === filters.taskId)
      .filter((run) => !filters.status || run.status === filters.status)
      .sort((left, right) => String(right.startedAt ?? right.id).localeCompare(String(left.startedAt ?? left.id)));
  }

  getApproval(id: string): Approval | null {
    return this.project(this.listEvents()).approvals.get(id) ?? null;
  }

  requireApproval(id: string): Approval {
    const approval = this.getApproval(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    return approval;
  }

  listApprovals(filters: { status?: string; taskId?: string } = {}): Approval[] {
    return [...this.project(this.listEvents()).approvals.values()]
      .filter((approval) => !filters.status || approval.status === filters.status)
      .filter((approval) => !filters.taskId || approval.taskId === filters.taskId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  getArtifact(id: string): Artifact | null {
    return this.project(this.listEvents()).artifacts.get(id) ?? null;
  }

  requireArtifact(id: string): Artifact {
    const artifact = this.getArtifact(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    return artifact;
  }

  listArtifacts(filters: { runId?: string; taskId?: string } = {}): Artifact[] {
    return [...this.project(this.listEvents()).artifacts.values()]
      .filter((artifact) => !filters.runId || artifact.runId === filters.runId)
      .filter((artifact) => !filters.taskId || artifact.taskId === filters.taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listEvents(): EventRecord[] {
    this.reload();
    return [...this.events];
  }

  eventsFor(id: string): EventRecord[] {
    const events = this.listEvents();
    const task = this.project(events).tasks.get(id);
    if (!task) return events.filter((event) => event.aggregateId === id);
    const projection = this.project(events);
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
    for (const event of events) applyEvent(projection, event);
    return projection;
  }

  private writeRunSnapshot(runId: string, terminalPayload?: EventPayload): void {
    const run = this.requireRun(runId);
    const runEvents = this.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === runId);
    writeFileSync(join(run.runDir, "events.jsonl"), `${runEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const verification = {
      status: terminalPayload?.status ?? run.status,
      summary: terminalPayload?.summary ?? null,
      updatedAt: now(),
    };
    writeFileSync(join(run.runDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
    writeFileSync(join(run.runDir, "run-digest.md"), `# ${run.id}\n\n- Task: ${run.taskId}\n- Status: ${verification.status}\n- Summary: ${verification.summary ?? ""}\n`);
  }

  private appendEventInternal(aggregateType: string, aggregateId: string, eventType: string, payload: EventPayload, causationId: string | null): EventRecord {
    const allEvents = [...this.events, ...(this.pendingEvents ?? [])];
    const previous = [...allEvents].reverse().find((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId);
    const event: EventRecord = {
      eventId: makeId("event"),
      aggregateType,
      aggregateId,
      sequence: (previous?.sequence ?? 0) + 1,
      eventType,
      actor: this.actor,
      occurredAt: now(),
      causationId,
      payload,
      payloadHash: sha256(stableStringify(payload)),
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
      this.reload();
      this.pendingEvents = [];
      const result = fn();
      const pending = this.pendingEvents;
      if (pending.length > 0) appendEvents(this.eventsPath, pending);
      this.events.push(...pending);
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

function applyEvent(projection: Projection, event: EventRecord): void {
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
    projection.runs.set(event.aggregateId, { ...payload } as Run);
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
    projection.artifacts.set(event.aggregateId, { ...payload } as Artifact);
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
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = openSync(path, "wx");
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
