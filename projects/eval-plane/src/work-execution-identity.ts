import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGED_EXECUTION_EVENTS = new Set(["node.started", "node.handoff_recorded"]);

type Row = Record<string, unknown>;

export interface WorkExecutionEventEvidence {
  index: number;
  event: string;
  nodeId: string | null;
  attempt: number | null;
  executionId: string | null;
  executionIdPresent: boolean;
}

export interface WorkExecutionIdentity {
  managed: boolean;
  valid: boolean;
  attempt: number | null;
  executionId: string | null;
}

export function resolveWorkExecutionIdentity(
  taskDir: string,
  taskId: string,
  runId: string,
  nodeId: string,
  execution: Row,
  events: WorkExecutionEventEvidence[],
  reasonCodes: string[],
): WorkExecutionIdentity {
  const reasons: string[] = [];
  const descriptor = readExecutionDescriptor(taskDir, nodeId, reasons);
  const runStateHasId = Object.hasOwn(execution, "execution_id");
  const descriptorHasId = descriptor !== null && Object.hasOwn(descriptor, "execution_id");
  const managedEvents = events.filter((event) => (
    MANAGED_EXECUTION_EVENTS.has(event.event)
    && event.nodeId === nodeId
    && event.executionIdPresent
  ));
  const managed = runStateHasId || descriptorHasId || managedEvents.length > 0;
  if (!managed) {
    reasonCodes.push(...reasons);
    return { managed: false, valid: reasons.length === 0, attempt: null, executionId: null };
  }

  const runStateAttempt = positiveInteger(execution.attempt);
  const runStateExecutionId = identifier(execution.execution_id);
  if (runStateAttempt === null) reasons.push("run_state_execution_attempt_invalid");
  if (!runStateHasId || execution.execution_id === undefined) reasons.push("run_state_execution_id_missing");
  else if (runStateExecutionId === null) reasons.push("run_state_execution_id_invalid");

  let descriptorAttempt: number | null = null;
  let descriptorExecutionId: string | null = null;
  if (descriptorHasId && descriptor) {
    if (descriptor.schema !== "work-harness-node-execution-v1") reasons.push("execution_descriptor_schema_invalid");
    if (descriptor.task_id !== taskId) reasons.push("execution_descriptor_task_id_mismatch");
    if (descriptor.run_id !== runId) reasons.push("execution_descriptor_run_id_mismatch");
    if (descriptor.node_id !== nodeId) reasons.push("execution_descriptor_node_id_mismatch");
    descriptorAttempt = positiveInteger(descriptor.attempt);
    descriptorExecutionId = identifier(descriptor.execution_id);
    if (descriptorAttempt === null) reasons.push("execution_descriptor_attempt_invalid");
    if (descriptorExecutionId === null) reasons.push("execution_descriptor_execution_id_invalid");
  }

  const validManagedEvents = managedEvents.flatMap((event) => {
    const executionId = identifier(event.executionId);
    if (event.attempt === null || event.attempt < 1) reasons.push("execution_event_attempt_invalid");
    if (executionId === null) reasons.push("execution_event_execution_id_invalid");
    return event.attempt !== null && event.attempt >= 1 && executionId
      ? [{ attempt: event.attempt, executionId }]
      : [];
  });
  const fallbackEvent = validManagedEvents.at(-1);
  const expectedAttempt = runStateAttempt ?? descriptorAttempt ?? fallbackEvent?.attempt ?? null;
  const currentEvents = expectedAttempt === null
    ? validManagedEvents
    : validManagedEvents.filter((event) => event.attempt === expectedAttempt);
  const expectedExecutionId = runStateExecutionId
    ?? descriptorExecutionId
    ?? currentEvents.at(0)?.executionId
    ?? fallbackEvent?.executionId
    ?? null;

  if (descriptorAttempt !== null && expectedAttempt !== null && descriptorAttempt !== expectedAttempt) {
    reasons.push("execution_descriptor_attempt_mismatch");
  }
  if (descriptorExecutionId !== null && expectedExecutionId !== null && descriptorExecutionId !== expectedExecutionId) {
    reasons.push("execution_descriptor_execution_id_mismatch");
  }
  for (const event of currentEvents) {
    if (expectedExecutionId !== null && event.executionId !== expectedExecutionId) {
      reasons.push("execution_event_execution_id_mismatch");
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  reasonCodes.push(...uniqueReasons);
  return {
    managed,
    valid: uniqueReasons.length === 0,
    attempt: expectedAttempt,
    executionId: expectedExecutionId,
  };
}

function readExecutionDescriptor(taskDir: string, nodeId: string, reasons: string[]): Row | null {
  const path = resolve(taskDir, "nodes", nodeId, "execution.json");
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reasons.push("execution_descriptor_file_invalid");
    return {};
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      reasons.push("execution_descriptor_json_invalid");
      return {};
    }
    return value as Row;
  } catch {
    reasons.push("execution_descriptor_json_invalid");
    return {};
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 1
    ? value
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value.trim()) ? value.trim() : null;
}
