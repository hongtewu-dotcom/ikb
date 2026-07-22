import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { EvalSubject } from "./eval-adapters.ts";

export const WORK_RUN_SUBJECT_VERSION = "work-harness-run-subject.v1";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HANDOFF_STATUSES = new Set(["completed", "blocked", "failed"]);

type Row = Record<string, unknown>;

export interface WorkHandoffSubject {
  exists: boolean;
  valid: boolean;
  status: string;
  evidenceCount: number;
  artifactCount: number;
  resolvedArtifactCount: number;
  missingArtifactCount: number;
  validationCount: number;
  riskCount: number;
  conclusionPresent: boolean;
  nextActionPresent: boolean;
  contentHash: string | null;
}

export interface WorkNodeSubject {
  id: string;
  kind: string;
  status: string;
  dependsOn: string[];
  readScope: string[];
  writeScope: string[];
  dispatchReasons: string[];
  postConditions: string[];
  acceptance: string[];
  allowedSideEffects: string[];
  handoff: WorkHandoffSubject;
}

export interface WorkEventSubject {
  index: number;
  event: string;
  nodeId: string | null;
  attempt: number | null;
  verdict: string | null;
  contentHash: string;
}

export interface WorkRunSubjectData extends Record<string, unknown> {
  task: {
    taskId: string;
    runId: string;
    acceptanceCount: number;
    allowedSideEffectCount: number;
    maxAgents: number;
    maxRetries: number;
  };
  state: {
    status: string;
    currentNodes: string[];
    completedNodes: string[];
    attempts: Record<string, number>;
  };
  nodes: WorkNodeSubject[];
  events: WorkEventSubject[];
  summary: {
    exists: boolean;
    terminalStatus: string;
    verificationVerdict: string;
    evidenceCount: number;
    artifactCount: number;
    resolvedArtifactCount: number;
    missingArtifactCount: number;
    correctionSignalCount: number;
    contentHash: string | null;
  };
  verification: {
    exists: boolean;
    status: string;
    contentHash: string | null;
  };
  integrity: {
    valid: boolean;
    reasonCodes: string[];
  };
}

export interface WorkRunSubject extends EvalSubject {
  adapter: "work-harness";
  runId: string;
  subjectVersion: typeof WORK_RUN_SUBJECT_VERSION;
  subjectHash: string;
  data: WorkRunSubjectData;
}

export function loadWorkRunSubject(taskDirectory: string): WorkRunSubject {
  const taskDir = resolve(taskDirectory);
  assertTaskDirectory(taskDir);
  const reasonCodes: string[] = [];
  const task = readRequiredObject(resolve(taskDir, "task.json"), "task", reasonCodes);
  const taskId = safeIdentifier(task.task_id, "task.task_id");
  const runId = safeIdentifier(task.run_id, "task.run_id");
  const plan = readOptionalObject(resolve(taskDir, "plan.json"), "plan", reasonCodes);
  const state = readOptionalObject(resolve(taskDir, "run-state.json"), "run_state", reasonCodes);
  const summary = readOptionalObject(resolve(taskDir, "run-summary.json"), "run_summary", reasonCodes);
  const verification = readOptionalObject(resolve(taskDir, "verification.json"), "verification", reasonCodes);

  expectSchema(task, "work-harness-task-v1", "task_schema_invalid", reasonCodes);
  expectSchema(plan, "work-harness-plan-v1", "plan_schema_invalid", reasonCodes);
  expectSchema(state, "work-harness-v1", "run_state_schema_invalid", reasonCodes);
  expectSchema(summary, "work-harness-run-summary-v1", "run_summary_schema_invalid", reasonCodes);
  if (stringValue(plan.task_id) !== taskId || stringValue(state.task_id) !== taskId || stringValue(summary.task_id) !== taskId) reasonCodes.push("task_id_mismatch");
  if (stringValue(summary.run_id) !== runId) reasonCodes.push("run_id_mismatch");

  const nodes = projectNodes(taskDir, plan.nodes, reasonCodes);
  const stateAttempts = numberMap(state.attempts, "run_state_attempts_invalid", reasonCodes);
  const currentNodes = stringArray(state.current_nodes);
  const completedNodes = stringArray(state.completed_nodes);
  if (!Array.isArray(state.current_nodes)) reasonCodes.push("run_state_current_nodes_invalid");
  if (!Array.isArray(state.completed_nodes)) reasonCodes.push("run_state_completed_nodes_invalid");

  const events = projectEvents(taskDir, reasonCodes);
  const summaryArtifactRefs = stringArray(summary.artifact_refs);
  const summaryArtifactResolution = artifactResolution(taskDir, summaryArtifactRefs);
  const verificationStatus = stringValue(verification.status) ?? "missing";
  if (!new Set(["passed", "failed"]).has(verificationStatus)) reasonCodes.push("verification_status_invalid");

  const budget = objectOrEmpty(task.budget);
  const maxAgents = finiteInteger(budget.max_agents) ?? 0;
  const maxRetries = finiteInteger(budget.max_retries) ?? -1;
  if (maxAgents < 1) reasonCodes.push("max_agents_invalid");
  if (maxRetries < 0) reasonCodes.push("max_retries_invalid");

  const data: WorkRunSubjectData = {
    task: {
      taskId,
      runId,
      acceptanceCount: stringArray(task.acceptance).length,
      allowedSideEffectCount: stringArray(task.allowed_side_effects).length,
      maxAgents,
      maxRetries,
    },
    state: {
      status: stringValue(state.status) ?? "missing",
      currentNodes,
      completedNodes,
      attempts: stateAttempts,
    },
    nodes,
    events,
    summary: {
      exists: Object.keys(summary).length > 0,
      terminalStatus: stringValue(summary.terminal_status) ?? "missing",
      verificationVerdict: stringValue(objectOrEmpty(summary.verification).verdict) ?? "missing",
      evidenceCount: stringArray(summary.evidence_refs).length,
      artifactCount: summaryArtifactRefs.length,
      resolvedArtifactCount: summaryArtifactResolution.resolved,
      missingArtifactCount: summaryArtifactResolution.missing,
      correctionSignalCount: Array.isArray(summary.correction_signals) ? summary.correction_signals.length : 0,
      contentHash: documentHash(resolve(taskDir, "run-summary.json")),
    },
    verification: {
      exists: Object.keys(verification).length > 0,
      status: verificationStatus,
      contentHash: documentHash(resolve(taskDir, "verification.json")),
    },
    integrity: {
      valid: reasonCodes.length === 0,
      reasonCodes: unique(reasonCodes),
    },
  };
  return {
    adapter: "work-harness",
    runId,
    subjectVersion: WORK_RUN_SUBJECT_VERSION,
    subjectHash: sha256(stableStringify({ subjectVersion: WORK_RUN_SUBJECT_VERSION, data })),
    data,
  };
}

function projectNodes(taskDir: string, value: unknown, reasonCodes: string[]): WorkNodeSubject[] {
  if (!Array.isArray(value)) {
    reasonCodes.push("plan_nodes_invalid");
    return [];
  }
  const seen = new Set<string>();
  return value.map((item, index): WorkNodeSubject => {
    const row = objectOrEmpty(item);
    const rawId = stringValue(row.id);
    const id = rawId && ID_PATTERN.test(rawId) ? rawId : `invalid-node-${index + 1}`;
    if (id.startsWith("invalid-node-")) reasonCodes.push("node_id_invalid");
    if (seen.has(id)) reasonCodes.push("node_id_duplicate");
    seen.add(id);
    const kind = stringValue(row.kind) ?? "missing";
    const handoff = kind === "native-plan-step" ? emptyHandoff() : projectHandoff(taskDir, id, reasonCodes);
    return {
      id,
      kind,
      status: stringValue(row.status) ?? "missing",
      dependsOn: stringArray(row.depends_on),
      readScope: stringArray(row.read_scope),
      writeScope: stringArray(row.write_scope),
      dispatchReasons: stringArray(row.dispatch_reasons),
      postConditions: stringArray(row.post_conditions),
      acceptance: stringArray(row.acceptance),
      allowedSideEffects: stringArray(row.allowed_side_effects),
      handoff,
    };
  });
}

function projectHandoff(taskDir: string, nodeId: string, reasonCodes: string[]): WorkHandoffSubject {
  const path = resolve(taskDir, "nodes", nodeId, "handoff.json");
  const row = readOptionalObject(path, `handoff_${nodeId}`, reasonCodes);
  const exists = Object.keys(row).length > 0;
  const artifactRefs = stringArray(row.artifacts);
  const resolution = artifactResolution(taskDir, artifactRefs);
  const valid = exists
    && HANDOFF_STATUSES.has(stringValue(row.status) ?? "")
    && Boolean(stringValue(row.conclusion))
    && Array.isArray(row.evidence)
    && Array.isArray(row.artifacts)
    && Array.isArray(row.validation)
    && Array.isArray(row.risks)
    && Boolean(stringValue(row.next_action));
  return {
    exists,
    valid,
    status: stringValue(row.status) ?? "missing",
    evidenceCount: stringArray(row.evidence).length,
    artifactCount: artifactRefs.length,
    resolvedArtifactCount: resolution.resolved,
    missingArtifactCount: resolution.missing,
    validationCount: stringArray(row.validation).length,
    riskCount: stringArray(row.risks).length,
    conclusionPresent: Boolean(stringValue(row.conclusion)),
    nextActionPresent: Boolean(stringValue(row.next_action)),
    contentHash: documentHash(path),
  };
}

function projectEvents(taskDir: string, reasonCodes: string[]): WorkEventSubject[] {
  const path = resolve(taskDir, "events.jsonl");
  if (!existsSync(path)) {
    reasonCodes.push("events_file_missing");
    return [];
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reasonCodes.push("events_file_invalid");
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  const events: WorkEventSubject[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const value = JSON.parse(lines[index]) as unknown;
      const row = objectOrEmpty(value);
      const event = stringValue(row.event);
      if (!event) {
        reasonCodes.push("event_contract_invalid");
        continue;
      }
      if (event.startsWith("evaluation.")) continue;
      events.push({
        index: index + 1,
        event,
        nodeId: stringValue(row.node_id),
        attempt: finiteInteger(row.attempt),
        verdict: stringValue(row.verdict),
        contentHash: sha256(stableStringify(row)),
      });
    } catch {
      reasonCodes.push("event_json_invalid");
    }
  }
  return events;
}

function artifactResolution(taskDir: string, references: string[]): { resolved: number; missing: number } {
  let resolvedCount = 0;
  let missing = 0;
  for (const reference of references) {
    if (/^(?:artifact|node|run|source|knowledge|candidate):\/\//.test(reference)) {
      resolvedCount += 1;
      continue;
    }
    const candidates = isAbsolute(reference)
      ? [resolve(reference)]
      : [resolve(taskDir, reference), resolve(workspaceRoot(taskDir), reference)];
    const found = candidates.some((candidate) => {
      if (!existsSync(candidate)) return false;
      const metadata = lstatSync(candidate);
      return metadata.isFile() && !metadata.isSymbolicLink();
    });
    if (found) resolvedCount += 1;
    else missing += 1;
  }
  return { resolved: resolvedCount, missing };
}

function workspaceRoot(taskDir: string): string {
  const parent = resolve(taskDir, "..");
  return parent.endsWith("/.agent-work") ? resolve(parent, "..") : taskDir;
}

function readRequiredObject(path: string, label: string, reasonCodes: string[]): Row {
  const value = readOptionalObject(path, label, reasonCodes);
  if (Object.keys(value).length === 0) throw new Error(`Work Harness ${label} document is missing or invalid`);
  return value;
}

function readOptionalObject(path: string, label: string, reasonCodes: string[]): Row {
  if (!existsSync(path)) {
    reasonCodes.push(`${label}_missing`);
    return {};
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reasonCodes.push(`${label}_file_invalid`);
    return {};
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reasonCodes.push(`${label}_json_invalid`);
      return {};
    }
    return value as Row;
  } catch {
    reasonCodes.push(`${label}_json_invalid`);
    return {};
  }
}

function documentHash(path: string): string | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink() ? sha256(readFileSync(path)) : null;
}

function expectSchema(row: Row, expected: string, reasonCode: string, reasonCodes: string[]): void {
  if (row.schema !== expected) reasonCodes.push(reasonCode);
}

function safeIdentifier(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result || !ID_PATTERN.test(result)) throw new Error(`Work Harness ${label} is not a safe identifier`);
  return result;
}

function objectOrEmpty(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : null;
}

function numberMap(value: unknown, reasonCode: string, reasonCodes: string[]): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reasonCodes.push(reasonCode);
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Row)) {
    const number = finiteInteger(item);
    if (!ID_PATTERN.test(key) || number === null || number < 0) reasonCodes.push(reasonCode);
    else result[key] = number;
  }
  return result;
}

function emptyHandoff(): WorkHandoffSubject {
  return { exists: false, valid: true, status: "not_required", evidenceCount: 0, artifactCount: 0, resolvedArtifactCount: 0, missingArtifactCount: 0, validationCount: 0, riskCount: 0, conclusionPresent: false, nextActionPresent: false, contentHash: null };
}

function assertTaskDirectory(taskDir: string): void {
  if (!existsSync(taskDir)) throw new Error(`Work Harness task directory does not exist: ${taskDir}`);
  const metadata = lstatSync(taskDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Work Harness task directory must be a real directory");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Row;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
