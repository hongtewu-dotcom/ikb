import { createHash } from "node:crypto";
import { isHarnessEventType, normalizeHarnessEvent, type HarnessEventType } from "../projects/eval-plane/src/harness-events.ts";
import type { EventRecord, Run } from "./types.ts";

/**
 * Deterministic, privacy-safe projection for local run observability.
 *
 * This module has no network code.  It converts an IKB Run into a derived
 * view, preserving the ledger as the source of truth and deliberately
 * dropping free-form content, paths, URLs, prompts, outputs and raw payloads.
 */

export const IKB_QUALITY_PROJECTION_VERSION = "ikb-run-quality.v2";
export const IKB_QUALITY_ASSESSMENT_SUITE_ID = "ikb-run-quality";
export type RunEventProjectionType = "general" | "tool" | "guardrail";

export interface RunEventProjection {
  name: string;
  type: RunEventProjectionType;
  metadata: Record<string, unknown>;
  eventIdHash: string;
}

export interface RunQualityProjection {
  projectionVersion: string;
  runIdHash: string;
  taskIdHash: string;
  projectionHash: string;
  trace: {
    name: string;
    tags: string[];
    metadata: Record<string, unknown>;
  };
  spans: RunEventProjection[];
  quality: {
    terminalState: string;
    qualityState: "pass" | "block" | "partial";
    verifierResult: string;
    evaluationResult: string;
    evaluationTotalCases: number;
    evaluationPassedCases: number;
    evaluationFailedCases: number;
    evaluationEnvironmentFailures: number;
    firstPass: boolean | null;
    finalPass: boolean | null;
    retryRounds: number;
    repairRounds: number;
    recoverySucceeded: boolean | null;
    passGateCount: number;
    artifactLinkCount: number;
    eventCount: number;
  };
}

const SAFE_STATUSES = new Set(["queued", "running", "awaiting_approval", "succeeded", "failed", "canceled", "started", "blocked", "skipped"]);

export function buildRunQualityProjection(run: Run, events: EventRecord[], scope: "personal" | "work" | "unknown" = "unknown"): RunQualityProjection {
  const runEvents = events.filter((event) => event.aggregateType === "run" && event.aggregateId === run.id);
  const hasCanonicalAssessment = runEvents.some((event) => event.eventType === "run.evaluation_completed" && event.payload.suiteId === IKB_QUALITY_ASSESSMENT_SUITE_ID);
  const qualityAssessmentSuite = hasCanonicalAssessment ? IKB_QUALITY_ASSESSMENT_SUITE_ID : "synthetic-12";
  const spans: RunEventProjection[] = [];
  let terminalState = run.status;
  let verifierResult = "missing";
  let evaluationResult = "missing";
  let evaluationTotalCases = 0;
  let evaluationPassedCases = 0;
  let evaluationFailedCases = 0;
  let evaluationEnvironmentFailures = 0;
  let firstPass: boolean | null = null;
  let finalPass: boolean | null = null;
  let retryRounds = 0;
  let repairRounds = 0;
  let recoverySucceeded: boolean | null = null;
  let passGateCount = 0;
  let artifactLinkCount = 0;
  for (const event of runEvents) {
    if (event.eventType === "run.finished" || event.eventType === "run.failed" || event.eventType === "run.canceled") {
      const status = safeEnum(event.payload.status, SAFE_STATUSES);
      if (status) terminalState = status;
    }
    if (event.eventType === "run.verification_completed" && isHarnessEventType(event.eventType)) {
      try {
        const payload = normalizeHarnessEvent(event.eventType, event.payload);
        verifierResult = safeEnum(payload.result, new Set(["pass", "partial", "blocked"])) ?? "blocked";
      } catch {
        verifierResult = "blocked";
      }
    }
    if (event.eventType === "run.evaluation_completed" && isHarnessEventType(event.eventType)) {
      try {
        const payload = normalizeHarnessEvent(event.eventType, event.payload);
        if (payload.suiteId === qualityAssessmentSuite) {
          if (payload.diagnosis === "environment") evaluationEnvironmentFailures += 1;
          else {
            evaluationResult = safeEnum(payload.result, new Set(["pass", "partial", "blocked"])) ?? "blocked";
            evaluationTotalCases = typeof payload.totalCases === "number" ? payload.totalCases : 0;
            evaluationPassedCases = typeof payload.passedCases === "number" ? payload.passedCases : 0;
            evaluationFailedCases = typeof payload.failedCases === "number" ? payload.failedCases : 0;
            firstPass = typeof payload.firstPass === "boolean" ? payload.firstPass : null;
            finalPass = typeof payload.finalPass === "boolean" ? payload.finalPass : null;
            retryRounds = typeof payload.retryRounds === "number" ? payload.retryRounds : 0;
            repairRounds = typeof payload.repairRounds === "number" ? payload.repairRounds : 0;
            recoverySucceeded = typeof payload.recoverySucceeded === "boolean" ? payload.recoverySucceeded : null;
          }
        }
      } catch {
        if (event.payload.suiteId === qualityAssessmentSuite) evaluationResult = "blocked";
      }
    }
    if (event.eventType === "run.gate_evaluated" && isHarnessEventType(event.eventType)) {
      try {
        const payload = normalizeHarnessEvent(event.eventType, event.payload);
        if (payload.decision === "pass") passGateCount += 1;
      } catch {
        // Invalid events remain visible as invalid hashes, but never as data.
      }
    }
    if (event.eventType === "run.artifact_linked" && isHarnessEventType(event.eventType)) {
      try {
        normalizeHarnessEvent(event.eventType, event.payload);
        artifactLinkCount += 1;
      } catch {
        // Keep the projection fail-closed for malformed structured events.
      }
    }
    const span = projectEvent(event);
    if (span) spans.push(span);
  }
  const qualityState = terminalState === "succeeded" && verifierResult === "pass" && evaluationResult === "pass" && passGateCount > 0 && artifactLinkCount > 0
    ? "pass"
    : verifierResult === "partial" || evaluationResult === "partial" || terminalState === "awaiting_approval" ? "partial" : "block";
  const quality = { terminalState, qualityState, verifierResult, evaluationResult, evaluationTotalCases, evaluationPassedCases, evaluationFailedCases, evaluationEnvironmentFailures, firstPass, finalPass, retryRounds, repairRounds, recoverySucceeded, passGateCount, artifactLinkCount, eventCount: runEvents.length };
  const traceMetadata = {
    projection_version: IKB_QUALITY_PROJECTION_VERSION,
    run_id_hash: hashIdentifier(run.id),
    task_id_hash: hashIdentifier(run.taskId),
    retry_of_hash: run.retryOf ? hashIdentifier(run.retryOf) : null,
    agent_id_hash: hashIdentifier(run.agentId),
    scope,
    skill_count: run.skillIds ? run.skillIds.split(",").filter(Boolean).length : 0,
    terminal_state: terminalState,
    quality_state: qualityState,
    verifier_result: verifierResult,
    evaluation_result: evaluationResult,
    evaluation_total_cases: evaluationTotalCases,
    evaluation_passed_cases: evaluationPassedCases,
    evaluation_failed_cases: evaluationFailedCases,
    evaluation_environment_failures: evaluationEnvironmentFailures,
    quality_assessment_suite: qualityAssessmentSuite,
    first_pass: firstPass,
    final_pass: finalPass,
    retry_rounds: retryRounds,
    repair_rounds: repairRounds,
    recovery_succeeded: recoverySucceeded,
    pass_gate_count: passGateCount,
    artifact_link_count: artifactLinkCount,
    event_count: runEvents.length,
  };
  const projectionWithoutHash = { projectionVersion: IKB_QUALITY_PROJECTION_VERSION, trace: traceMetadata, spans, quality };
  return {
    projectionVersion: IKB_QUALITY_PROJECTION_VERSION,
    runIdHash: hashIdentifier(run.id),
    taskIdHash: hashIdentifier(run.taskId),
    projectionHash: sha256(stableStringify(projectionWithoutHash)),
    trace: { name: "ikb.harness.run", tags: ["ikb", "harness"], metadata: traceMetadata },
    spans,
    quality,
  };
}

function projectEvent(event: EventRecord): RunEventProjection | null {
  if (isHarnessEventType(event.eventType)) {
    let payload: Record<string, unknown>;
    let invalid = false;
    try {
      payload = normalizeHarnessEvent(event.eventType, event.payload);
    } catch {
      payload = {};
      invalid = true;
    }
    return {
      name: `ikb.${event.eventType}`,
      type: spanType(event.eventType),
      metadata: { event_type: event.eventType, event_id_hash: hashIdentifier(event.eventId), ...(invalid ? { invalid_event: true } : {}), ...safeHarnessMetadata(payload) },
      eventIdHash: hashIdentifier(event.eventId),
    };
  }
  const metadata = safeRunMetadata(event);
  if (!metadata) return null;
  return { name: `ikb.${event.eventType}`, type: "general", metadata: { event_type: event.eventType, event_id_hash: hashIdentifier(event.eventId), ...metadata }, eventIdHash: hashIdentifier(event.eventId) };
}

function safeHarnessMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith("Refs")) {
      result[`${snake(key)}_count`] = Array.isArray(value) ? value.length : 0;
      continue;
    }
    if (key === "checks") {
      result.check_count = Array.isArray(value) ? value.length : 0;
      result.check_decisions = Array.isArray(value) ? value.map((item) => typeof item === "object" && item !== null ? safeEnum((item as Record<string, unknown>).decision, new Set(["pass", "block", "not_applicable"])) : null).filter(Boolean) : [];
      continue;
    }
    if (key.endsWith("Hash")) {
      result[snake(key)] = value;
      continue;
    }
    if (key.endsWith("At")) {
      result[snake(key)] = typeof value === "string" ? value : null;
      continue;
    }
    if (["iteration", "loopId", "decision", "reasonCode", "gateId", "gateVersion", "result", "relation", "approvalDecision", "sideEffectLevel", "status", "contractVersion"].includes(key)) {
      const safe = typeof value === "string" ? value : typeof value === "number" ? value : null;
      if (safe !== null) result[snake(key)] = safe;
      continue;
    }
    if (typeof value === "string") result[`${snake(key)}_hash`] = hashIdentifier(value);
  }
  return result;
}

function safeRunMetadata(event: EventRecord): Record<string, unknown> | null {
  const payload = event.payload;
  switch (event.eventType) {
    case "run.queued":
      return {
        status: "queued",
        agent_id_hash: typeof payload.agentId === "string" ? hashIdentifier(payload.agentId) : null,
        skill_count: typeof payload.skillIds === "string" ? payload.skillIds.split(",").filter(Boolean).length : 0,
        retry_of_hash: typeof payload.retryOf === "string" && payload.retryOf ? hashIdentifier(payload.retryOf) : null,
      };
    case "run.started":
    case "run.resumed":
    case "run.awaiting_approval":
    case "run.finished":
    case "run.failed":
    case "run.canceled": {
      const status = safeEnum(payload.status, SAFE_STATUSES);
      return {
        status: status ?? "unknown",
        approval_id_hash: typeof payload.approvalId === "string" ? hashIdentifier(payload.approvalId) : null,
        started_at: typeof payload.startedAt === "string" ? payload.startedAt : undefined,
        resumed_at: typeof payload.resumedAt === "string" ? payload.resumedAt : undefined,
        finished_at: typeof payload.finishedAt === "string" ? payload.finishedAt : undefined,
      };
    }
    case "run.checkpointed":
      return { checkpoint_hash: typeof payload.checkpoint === "string" ? hashIdentifier(payload.checkpoint) : null };
    default:
      return null;
  }
}

function spanType(eventType: HarnessEventType): RunEventProjectionType {
  if (eventType.includes("gate") || eventType.includes("verification") || eventType.includes("approval")) return "guardrail";
  if (eventType.includes("action") || eventType.includes("artifact")) return "tool";
  return "general";
}

function safeEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function hashIdentifier(value: string): string {
  return sha256(value).slice(0, 32);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
