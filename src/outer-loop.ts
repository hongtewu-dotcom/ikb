import { createHash } from "node:crypto";
import type { EventRecord } from "./types.ts";

/**
 * Outer Loop is deliberately advisory.  It clusters repeated, structured
 * failures and returns a review candidate; it never edits a Skill, Prompt,
 * Knowledge card, role or permission.
 */

export const OUTER_LOOP_VERSION = "ikb-outer-loop.v1";
export type OuterScope = "personal" | "work" | "unknown";

export interface FailureObservation {
  eventId: string;
  runId: string;
  reasonCode: string;
  scope?: OuterScope;
  roleId?: string;
  skillId?: string;
  gateId?: string;
  eventType: string;
}

export interface ImprovementCandidate {
  candidateId: string;
  patternKeyHash: string;
  status: "pending_review";
  sampleCount: number;
  scope: OuterScope;
  reasonCode: string;
  roleIdHash: string | null;
  skillIdHash: string | null;
  gateId: string | null;
  evidenceEventHashes: string[];
  regressionCaseIds: string[];
  humanApprovalRequired: true;
  automaticChanges: [];
}

export function extractFailureObservations(events: EventRecord[], scopeByRun: Map<string, OuterScope> = new Map()): FailureObservation[] {
  const result: FailureObservation[] = [];
  const stepContext = new Map<string, { roleId?: string; skillId?: string }>();
  for (const event of events) {
    if (event.aggregateType === "knowledge" && event.eventType === "knowledge.feedback_recorded") {
      const outcome = stringValue(event.payload.outcome);
      const runId = stringValue(event.payload.runId);
      const reasonCode = stringValue(event.payload.reasonCode);
      if (runId && reasonCode && (outcome === "partial" || outcome === "incorrect")) {
        result.push({
          eventId: event.eventId,
          runId,
          reasonCode,
          scope: scopeByRun.get(runId) ?? "unknown",
          eventType: event.eventType,
        });
      }
      continue;
    }
    if (event.aggregateType !== "run") continue;
    const payload = event.payload;
    if (event.eventType === "run.step_started" && typeof payload.stepId === "string") {
      stepContext.set(`${event.aggregateId}:${payload.stepId}`, { roleId: stringValue(payload.roleId), skillId: stringValue(payload.skillId) });
    }
    const reasonCodes = failureReasons(event);
    if (reasonCodes.length === 0) continue;
    const stepId = stringValue(payload.stepId);
    const context = stepId ? stepContext.get(`${event.aggregateId}:${stepId}`) : undefined;
    for (const reasonCode of reasonCodes) {
      result.push({
        eventId: event.eventId,
        runId: event.aggregateId,
        reasonCode,
        scope: scopeByRun.get(event.aggregateId) ?? "unknown",
        roleId: stringValue(payload.roleId) ?? context?.roleId,
        skillId: stringValue(payload.skillId) ?? context?.skillId,
        gateId: stringValue(payload.gateId),
        eventType: event.eventType,
      });
    }
  }
  return result;
}

export function buildImprovementCandidates(observations: FailureObservation[], minimumSamples = 3): ImprovementCandidate[] {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 2) throw new Error("Outer Loop minimumSamples must be an integer >= 2");
  const groups = new Map<string, FailureObservation[]>();
  for (const observation of observations) {
    const key = patternKey(observation);
    const list = groups.get(key) ?? [];
    list.push(observation);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= minimumSamples)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, list]) => {
      const first = list[0];
      return {
        candidateId: `pattern-${sha256(key).slice(0, 12)}`,
        patternKeyHash: sha256(key).slice(0, 32),
        status: "pending_review" as const,
        sampleCount: list.length,
        scope: first.scope ?? "unknown",
        reasonCode: first.reasonCode,
        roleIdHash: first.roleId ? hashIdentifier(first.roleId) : null,
        skillIdHash: first.skillId ? hashIdentifier(first.skillId) : null,
        gateId: first.gateId ?? null,
        evidenceEventHashes: list.map((item) => hashIdentifier(item.eventId)),
        regressionCaseIds: regressionCasesFor(first.reasonCode),
        humanApprovalRequired: true as const,
        automaticChanges: [] as [],
      };
    });
}

function failureReasons(event: EventRecord): string[] {
  const payload = event.payload;
  if (event.eventType === "run.gate_evaluated" && payload.decision === "block" && typeof payload.reasonCode === "string" && payload.reasonCode.trim()) return [payload.reasonCode.trim()];
  if (event.eventType === "run.verification_completed" && (payload.result === "blocked" || payload.result === "partial") && Array.isArray(payload.checks)) {
    const blocked = payload.checks.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).decision === "block");
    if (blocked && typeof (blocked as Record<string, unknown>).reasonCode === "string") return [String((blocked as Record<string, unknown>).reasonCode)];
    return ["verifier_incomplete"];
  }
  if (event.eventType === "run.evaluation_completed" && (payload.result === "blocked" || payload.result === "partial")) {
    const reasonCodes = Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
      : [];
    return reasonCodes.length > 0 ? [...new Set(reasonCodes)] : ["evaluation_incomplete"];
  }
  if (["run.step_finished", "run.loop_finished", "run.action_executed"].includes(event.eventType)) {
    const status = payload.status;
    if ((status === "failed" || status === "blocked") && typeof payload.errorCode === "string" && payload.errorCode.trim()) return [payload.errorCode.trim()];
  }
  return [];
}

function patternKey(observation: FailureObservation): string {
  return [observation.scope ?? "unknown", observation.reasonCode, observation.roleId ?? "", observation.skillId ?? "", observation.gateId ?? ""].join("|");
}

function regressionCasesFor(reasonCode: string): string[] {
  const lower = reasonCode.toLowerCase();
  if (lower.includes("verifier")) return ["M1-quality-needs-verifier", "M2-terminal-success-is-not-quality"];
  if (lower.includes("approval") || lower.includes("payload")) return ["M3-approved-side-effect", "M4-mismatched-approval-blocks-action"];
  if (lower.includes("retry") || lower.includes("idempot")) return ["R1-idempotent-retry", "R2-conflicting-retry-blocks"];
  if (lower.includes("scope")) return ["I4-scope-mismatch"];
  return [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hashIdentifier(value: string): string { return sha256(value).slice(0, 32); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
