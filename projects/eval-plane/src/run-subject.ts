import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isHarnessEventType, normalizeHarnessEvent } from "./harness-events.ts";
import type { EvalSubject } from "./eval-adapters.ts";

export const IKB_RUN_SUBJECT_VERSION = "ikb-run-subject.v1";

export interface RunRecordLike {
  id: string;
  taskId: string;
  agentId: string;
  skillIds: string;
  status: string;
  retryOf: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  checkpoint: string | null;
  failureReason: string | null;
  runDir: string;
}

export interface TaskRecordLike {
  id: string;
  type: string;
  scope: string;
  risk: string;
  acceptance: string;
}

export interface ArtifactRecordLike {
  id: string;
  taskId: string;
  runId: string;
  kind: string;
  label: string;
  path: string;
  contentHash: string | null;
  createdAt: string;
}

export interface ApprovalRecordLike {
  id: string;
  taskId: string;
  runId: string;
  action: string;
  target: string;
  payloadHash: string;
  risk: string;
  status: string;
}

export interface EventRecordLike {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventType: string;
  eventHash: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}

export interface RunSubjectStore {
  requireRun(runId: string): RunRecordLike;
  requireTask(taskId: string): TaskRecordLike;
  listRuns(filters?: { taskId?: string; status?: string }): RunRecordLike[];
  listApprovals(filters?: { taskId?: string; status?: string }): ApprovalRecordLike[];
  listArtifacts(filters?: { runId?: string; taskId?: string }): ArtifactRecordLike[];
  listEvents(): EventRecordLike[];
  verify(): { events: number; brokenChains: string[]; projections: Record<string, number> };
}

export interface RunSubjectEvent {
  eventRef: string;
  eventId: string;
  eventType: string;
  sequence: number;
  eventHash: string;
  payloadHash: string;
  valid: boolean;
  invalidReasonCode: string | null;
  payload: Record<string, unknown>;
}

export interface RunArtifactSubject {
  id: string;
  ref: string;
  kind: string;
  label: string;
  contentHash: string | null;
  currentContentHash: string | null;
  exists: boolean;
  regularFile: boolean;
  hashMatches: boolean;
}

export interface RunApprovalSubject {
  id: string;
  action: string;
  targetHash: string;
  payloadHash: string;
  risk: string;
  status: string;
}

export interface RunPlanStep {
  id: string;
  dependsOn: string[];
}

export interface RunPlanSubject {
  valid: boolean;
  reasonCodes: string[];
  steps: RunPlanStep[];
}

export interface RunSubjectData extends Record<string, unknown> {
  run: {
    id: string;
    taskId: string;
    status: string;
    retryOf: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  task: {
    id: string;
    type: string;
    scope: string;
    risk: string;
    acceptancePresent: boolean;
  };
  events: RunSubjectEvent[];
  artifacts: RunArtifactSubject[];
  approvals: RunApprovalSubject[];
  integrity: {
    ledgerVerified: boolean;
    brokenChains: number;
  };
  plan: RunPlanSubject;
  retry: {
    retryRounds: number;
    rootRunStatus: string;
  };
}

export interface RunSubject extends EvalSubject {
  adapter: "ikb";
  runId: string;
  subjectHash: string;
  subjectVersion: typeof IKB_RUN_SUBJECT_VERSION;
  data: RunSubjectData;
}

export function loadRunSubject(store: RunSubjectStore, runId: string): RunSubject {
  const ledgerIntegrity = store.verify();
  const run = store.requireRun(runId);
  const task = store.requireTask(run.taskId);
  const allArtifacts = store.listArtifacts({ runId });
  const evaluationArtifactIds = new Set(allArtifacts.filter((artifact) => artifact.kind === "evaluation_report").map((artifact) => artifact.id));
  const events = store.listEvents()
    .filter((event) => event.aggregateType === "run" && event.aggregateId === runId)
    .filter((event) => !isEvaluationOutputEvent(event, evaluationArtifactIds))
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => projectEvent(runId, event));
  const artifacts = allArtifacts
    .filter((artifact) => artifact.kind !== "evaluation_report")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(projectArtifact);
  const approvals = store.listApprovals({ taskId: run.taskId })
    .filter((approval) => approval.runId === runId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((approval): RunApprovalSubject => ({
      id: approval.id,
      action: approval.action,
      targetHash: sha256(approval.target),
      payloadHash: approval.payloadHash,
      risk: approval.risk,
      status: approval.status,
    }));
  const data: RunSubjectData = {
    run: {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      retryOf: run.retryOf,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    task: {
      id: task.id,
      type: task.type,
      scope: task.scope,
      risk: task.risk,
      acceptancePresent: Boolean(task.acceptance.trim()),
    },
    events,
    artifacts,
    approvals,
    integrity: {
      ledgerVerified: ledgerIntegrity.brokenChains.length === 0,
      brokenChains: ledgerIntegrity.brokenChains.length,
    },
    plan: readPlan(run.runDir),
    retry: retrySummary(store.listRuns({ taskId: run.taskId }), run),
  };
  return {
    adapter: "ikb",
    runId,
    subjectVersion: IKB_RUN_SUBJECT_VERSION,
    subjectHash: sha256(stableStringify({ subjectVersion: IKB_RUN_SUBJECT_VERSION, data })),
    data,
  };
}

function projectArtifact(artifact: ArtifactRecordLike): RunArtifactSubject {
  if (!existsSync(artifact.path)) {
    return {
      id: artifact.id,
      ref: `artifact://${artifact.id}`,
      kind: artifact.kind,
      label: artifact.label,
      contentHash: artifact.contentHash,
      currentContentHash: null,
      exists: false,
      regularFile: false,
      hashMatches: false,
    };
  }
  const metadata = lstatSync(artifact.path);
  const regularFile = metadata.isFile() && !metadata.isSymbolicLink();
  const currentContentHash = regularFile ? sha256(readFileSync(artifact.path)) : null;
  return {
    id: artifact.id,
    ref: `artifact://${artifact.id}`,
    kind: artifact.kind,
    label: artifact.label,
    contentHash: artifact.contentHash,
    currentContentHash,
    exists: true,
    regularFile,
    hashMatches: Boolean(artifact.contentHash && currentContentHash && artifact.contentHash === currentContentHash),
  };
}

function isEvaluationOutputEvent(event: EventRecordLike, evaluationArtifactIds: Set<string>): boolean {
  if (event.eventType === "run.evaluation_completed") return true;
  if (event.eventType !== "run.artifact_linked") return false;
  return typeof event.payload.artifactId === "string" && evaluationArtifactIds.has(event.payload.artifactId);
}

function projectEvent(runId: string, event: EventRecordLike): RunSubjectEvent {
  if (!isHarnessEventType(event.eventType)) {
    const status = typeof event.payload.status === "string" ? event.payload.status : null;
    return {
      eventRef: `run://${runId}/event/${event.eventId}`,
      eventId: event.eventId,
      eventType: event.eventType,
      sequence: event.sequence,
      eventHash: event.eventHash,
      payloadHash: event.payloadHash,
      valid: true,
      invalidReasonCode: null,
      payload: status ? { status } : {},
    };
  }
  try {
    return {
      eventRef: `run://${runId}/event/${event.eventId}`,
      eventId: event.eventId,
      eventType: event.eventType,
      sequence: event.sequence,
      eventHash: event.eventHash,
      payloadHash: event.payloadHash,
      valid: true,
      invalidReasonCode: null,
      payload: normalizeHarnessEvent(event.eventType, event.payload),
    };
  } catch {
    return {
      eventRef: `run://${runId}/event/${event.eventId}`,
      eventId: event.eventId,
      eventType: event.eventType,
      sequence: event.sequence,
      eventHash: event.eventHash,
      payloadHash: event.payloadHash,
      valid: false,
      invalidReasonCode: "invalid_harness_event",
      payload: {},
    };
  }
}

function readPlan(runDir: string): RunPlanSubject {
  const path = join(runDir, "plan.json");
  if (!existsSync(path)) return { valid: false, reasonCodes: ["plan_file_missing"], steps: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reasonCodes: ["plan_invalid"], steps: [] };
    const row = value as Record<string, unknown>;
    if (!Array.isArray(row.steps)) return { valid: false, reasonCodes: ["plan_steps_invalid"], steps: [] };
    const reasonCodes: string[] = [];
    const steps = row.steps.map((item, index): RunPlanStep => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        reasonCodes.push("plan_step_invalid");
        return { id: `invalid-step-${index}`, dependsOn: [] };
      }
      const step = item as Record<string, unknown>;
      const id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : `invalid-step-${index}`;
      if (id.startsWith("invalid-step-")) reasonCodes.push("plan_step_id_missing");
      const dependencies = step.depends_on ?? step.dependsOn ?? [];
      const dependsOn = Array.isArray(dependencies) && dependencies.every((dependency) => typeof dependency === "string" && dependency.trim())
        ? dependencies.map((dependency) => String(dependency).trim())
        : [];
      if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string" || !dependency.trim())) reasonCodes.push("plan_dependency_invalid");
      return { id, dependsOn };
    });
    return { valid: reasonCodes.length === 0, reasonCodes: [...new Set(reasonCodes)], steps };
  } catch {
    return { valid: false, reasonCodes: ["plan_json_invalid"], steps: [] };
  }
}

function retrySummary(runs: RunRecordLike[], run: RunRecordLike): RunSubjectData["retry"] {
  const byId = new Map(runs.map((item) => [item.id, item]));
  const visited = new Set<string>();
  let current = run;
  let retryRounds = 0;
  while (current.retryOf && !visited.has(current.retryOf)) {
    visited.add(current.retryOf);
    const previous = byId.get(current.retryOf);
    if (!previous) break;
    retryRounds += 1;
    current = previous;
  }
  return { retryRounds, rootRunStatus: current.status };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
