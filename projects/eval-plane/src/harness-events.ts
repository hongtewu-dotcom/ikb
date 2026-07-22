/**
 * Structured events emitted by a Harness Run.
 *
 * The ledger is the source of truth.  These payloads deliberately contain
 * references and hashes, not prompts, outputs, paths or tool payloads.  The
 * same contract is later used by the local evaluator and run-quality projector.
 */

export const HARNESS_EVENT_TYPES = [
  "run.loop_started",
  "run.loop_finished",
  "run.step_started",
  "run.step_finished",
  "run.handoff",
  "run.gate_evaluated",
  "run.verification_completed",
  "run.evaluation_completed",
  "run.artifact_linked",
  "run.approval_checked",
  "run.action_executed",
] as const;

export type HarnessEventType = typeof HARNESS_EVENT_TYPES[number];
export type LoopId = "inner" | "mid" | "outer";
export type GateDecision = "pass" | "block" | "not_applicable";
export type StepStatus = "started" | "succeeded" | "failed" | "blocked" | "skipped";
export type VerificationResult = "pass" | "partial" | "blocked";
export type ApprovalDecision = "pending" | "approved" | "rejected" | "not_required";

const GATE_IDS = new Set(["G0", "G1", "G2", "G3", "G4", "G5", "G6"]);
const STEP_STATUSES = new Set<StepStatus>(["started", "succeeded", "failed", "blocked", "skipped"]);
const FINISHED_STEP_STATUSES = new Set(["succeeded", "failed", "blocked", "skipped"]);
const VERIFICATION_RESULTS = new Set<VerificationResult>(["pass", "partial", "blocked"]);
const APPROVAL_DECISIONS = new Set<ApprovalDecision>(["pending", "approved", "rejected", "not_required"]);
const TOKEN_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:@-]{0,127}$/u;
const CANONICAL_REFERENCE_PATTERN = /^(?:artifact|source|node|run|case|fixture|knowledge|candidate):\/\/[A-Za-z0-9._~:/-]+$/;
const LEGACY_REFERENCE_PATTERN = /^(?:[A-Za-z][A-Za-z0-9._-]*:)?[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const FORBIDDEN_INLINE_CONTENT = /(?:[\r\n\t\\/]|https?:\/\/|file:\/\/|[{}\[\]<>])/i;
const ALLOWED_KEYS = new Set([
  "loopId", "iteration", "inputRefs", "outputRefs", "contextHash", "status", "errorCode", "nextAction",
  "stepId", "stepName", "roleId", "skillId", "inputHash", "outputHash", "handoffId", "fromRole", "toRole",
  "contractVersion", "gateId", "decision", "reasonCode", "evidenceRefs", "gateVersion", "result", "checks",
  "artifactRefs", "artifactId", "relation", "lineageRefs", "approvalId", "approvalDecision", "actionId", "action",
  "sideEffectLevel", "targetHash", "payloadHash", "executedAt", "startedAt", "finishedAt", "evalVersion", "suiteId",
  "suiteVersion", "graderVersion", "subjectVersion", "subjectHash", "evaluationKey", "level", "diagnosis", "reasonCodes",
  "totalCases", "passedCases", "failedCases", "failedCaseRefs", "firstPass", "finalPass", "retryRounds", "repairRounds", "recoverySucceeded",
]);

type Row = Record<string, unknown>;

export function isHarnessEventType(value: string): value is HarnessEventType {
  return (HARNESS_EVENT_TYPES as readonly string[]).includes(value);
}

export function normalizeHarnessEvent(eventType: string, payload: unknown): Row {
  if (!isHarnessEventType(eventType)) throw new Error(`Unknown Harness event type: ${eventType}`);
  const row = objectPayload(payload);
  for (const key of Object.keys(row)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Unsupported or unsafe Harness event field: ${key}`);
  }
  switch (eventType) {
    case "run.loop_started":
      return withCommonLoop(row, eventType, false);
    case "run.loop_finished":
      return withCommonLoop(row, eventType, true);
    case "run.step_started":
      return withStep(row, false);
    case "run.step_finished":
      return withStep(row, true);
    case "run.handoff":
      return {
        handoffId: requiredToken(row, "handoffId"),
        stepId: requiredToken(row, "stepId"),
        fromRole: requiredLabel(row, "fromRole"),
        toRole: requiredLabel(row, "toRole"),
        inputRefs: referenceArray(row, "inputRefs"),
        outputRefs: referenceArray(row, "outputRefs"),
        contractVersion: requiredToken(row, "contractVersion"),
      };
    case "run.gate_evaluated":
      return {
        gateId: requiredGateId(row),
        decision: requiredEnum(row, "decision", ["pass", "block", "not_applicable"] as const),
        reasonCode: optionalToken(row, "reasonCode"),
        evidenceRefs: referenceArray(row, "evidenceRefs"),
        gateVersion: requiredToken(row, "gateVersion"),
      };
    case "run.verification_completed": {
      const result = requiredEnumFromSet(row, "result", VERIFICATION_RESULTS);
      const checks = checkResults(row.checks);
      const artifactRefs = referenceArray(row, "artifactRefs");
      if (result === "pass" && checks.length === 0) throw new Error("Harness pass verification must contain at least one check");
      if (result === "pass" && artifactRefs.length === 0) throw new Error("Harness pass verification must reference at least one Artifact");
      return {
        result,
        checks,
        artifactRefs,
        nextAction: optionalToken(row, "nextAction"),
      };
    }
    case "run.evaluation_completed": {
      const totalCases = nonNegativeInteger(row, "totalCases");
      const passedCases = nonNegativeInteger(row, "passedCases");
      const failedCases = nonNegativeInteger(row, "failedCases");
      if (passedCases + failedCases > totalCases) throw new Error("Harness evaluation passedCases + failedCases cannot exceed totalCases");
      return {
        evalVersion: requiredToken(row, "evalVersion"),
        suiteId: requiredToken(row, "suiteId"),
        suiteVersion: optionalToken(row, "suiteVersion"),
        graderVersion: optionalToken(row, "graderVersion"),
        subjectVersion: optionalToken(row, "subjectVersion"),
        subjectHash: optionalHash(row, "subjectHash"),
        evaluationKey: optionalHash(row, "evaluationKey"),
        level: optionalEnumFromSet(row, "level", new Set(["L1", "L2", "L3"])),
        diagnosis: optionalEnumFromSet(row, "diagnosis", new Set(["subject", "grader", "ground_truth", "environment", "unknown"])),
        reasonCodes: tokenArray(row, "reasonCodes"),
        result: requiredEnumFromSet(row, "result", VERIFICATION_RESULTS),
        totalCases,
        passedCases,
        failedCases,
        failedCaseRefs: referenceArray(row, "failedCaseRefs"),
        artifactRefs: referenceArray(row, "artifactRefs"),
        firstPass: optionalBoolean(row, "firstPass"),
        finalPass: optionalBoolean(row, "finalPass"),
        retryRounds: optionalNonNegativeInteger(row, "retryRounds"),
        repairRounds: optionalNonNegativeInteger(row, "repairRounds"),
        recoverySucceeded: optionalBoolean(row, "recoverySucceeded"),
      };
    }
    case "run.artifact_linked":
      return {
        artifactId: requiredToken(row, "artifactId"),
        relation: requiredEnum(row, "relation", ["produced", "consumed", "verified", "supersedes"] as const),
        lineageRefs: referenceArray(row, "lineageRefs"),
      };
    case "run.approval_checked":
      return {
        approvalId: requiredToken(row, "approvalId"),
        approvalDecision: requiredEnumFromSet(row, "approvalDecision", APPROVAL_DECISIONS),
        action: requiredToken(row, "action"),
        targetHash: requiredHash(row, "targetHash"),
        payloadHash: requiredHash(row, "payloadHash"),
      };
    case "run.action_executed":
      return {
        actionId: requiredToken(row, "actionId"),
        action: requiredToken(row, "action"),
        sideEffectLevel: requiredEnum(row, "sideEffectLevel", ["L0", "L1", "L2", "L3"] as const),
        targetHash: requiredHash(row, "targetHash"),
        payloadHash: requiredHash(row, "payloadHash"),
        approvalId: optionalToken(row, "approvalId"),
        status: requiredEnum(row, "status", ["succeeded", "failed", "blocked", "skipped"] as const),
        errorCode: optionalToken(row, "errorCode"),
        nextAction: optionalToken(row, "nextAction"),
        executedAt: optionalTimestamp(row, "executedAt"),
      };
  }
}

function withCommonLoop(row: Row, eventType: string, finished: boolean): Row {
  const result: Row = {
    loopId: requiredLoopId(row),
    iteration: nonNegativeInteger(row, "iteration"),
    inputRefs: referenceArray(row, "inputRefs"),
    outputRefs: referenceArray(row, "outputRefs"),
    contextHash: optionalHash(row, "contextHash"),
  };
  if (finished) {
    result.status = requiredEnumFromSet(row, "status", new Set(["succeeded", "failed", "blocked", "skipped"]));
    result.errorCode = optionalToken(row, "errorCode");
    result.nextAction = optionalToken(row, "nextAction");
  }
  return result;
}

function withStep(row: Row, finished: boolean): Row {
  const result: Row = {
    stepId: requiredToken(row, "stepId"),
    stepName: requiredLabel(row, "stepName"),
    loopId: optionalLoopId(row, "loopId"),
    iteration: optionalNonNegativeInteger(row, "iteration"),
    roleId: optionalLabel(row, "roleId"),
    skillId: optionalToken(row, "skillId"),
    inputRefs: referenceArray(row, "inputRefs"),
    outputRefs: referenceArray(row, "outputRefs"),
    inputHash: optionalHash(row, "inputHash"),
    outputHash: optionalHash(row, "outputHash"),
  };
  if (finished) {
    const status = requiredEnumFromSet(row, "status", FINISHED_STEP_STATUSES);
    result.status = status;
    result.errorCode = optionalToken(row, "errorCode");
    result.nextAction = optionalToken(row, "nextAction");
  } else {
    result.status = optionalEnumFromSet(row, "status", STEP_STATUSES) ?? "started";
    result.startedAt = optionalTimestamp(row, "startedAt");
  }
  if (finished) result.finishedAt = optionalTimestamp(row, "finishedAt");
  return result;
}

function checkResults(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error("Harness verification checks must be an array");
  return value.map((item, index) => {
    const row = objectPayload(item, `checks[${index}]`);
    const keys = Object.keys(row);
    if (keys.some((key) => !["id", "decision", "evidenceRefs", "reasonCode"].includes(key))) {
      throw new Error(`Unsupported verification check field at checks[${index}]`);
    }
    const decision = requiredEnum(row, "decision", ["pass", "block", "not_applicable"] as const, `checks[${index}]`);
    const evidenceRefs = referenceArray(row, "evidenceRefs", `checks[${index}]`);
    if (decision === "pass" && evidenceRefs.length === 0) throw new Error(`Harness checks[${index}] pass decision must include evidenceRefs`);
    return {
      id: requiredToken(row, "id", `checks[${index}]`),
      decision,
      evidenceRefs,
      reasonCode: optionalToken(row, "reasonCode", `checks[${index}]`),
    };
  });
}

function objectPayload(value: unknown, label = "payload"): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Harness ${label} must be a JSON object`);
  return value as Row;
}

function requiredString(row: Row, key: string, label = "payload"): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Harness ${label}.${key} must be a non-empty string`);
  return value.trim();
}

function requiredToken(row: Row, key: string, label = "payload"): string {
  const value = requiredString(row, key, label);
  if (!TOKEN_PATTERN.test(value)) throw new Error(`Harness ${label}.${key} must be a bounded metadata token`);
  return value;
}

function optionalToken(row: Row, key: string, label = "payload"): string | null {
  if (row[key] === undefined || row[key] === null) return null;
  return requiredToken(row, key, label);
}

function requiredLabel(row: Row, key: string, label = "payload"): string {
  const value = requiredString(row, key, label);
  if (value.length > 160 || FORBIDDEN_INLINE_CONTENT.test(value)) {
    throw new Error(`Harness ${label}.${key} must be bounded metadata, not a URL, path, Prompt or raw output`);
  }
  return value;
}

function optionalLabel(row: Row, key: string, label = "payload"): string | null {
  if (row[key] === undefined || row[key] === null) return null;
  return requiredLabel(row, key, label);
}

function requiredLoopId(row: Row): LoopId {
  return requiredEnum(row, "loopId", ["inner", "mid", "outer"] as const);
}

function optionalLoopId(row: Row, key: string): LoopId | null {
  if (row[key] === undefined || row[key] === null) return null;
  return requiredEnum(row, key, ["inner", "mid", "outer"] as const);
}

function requiredGateId(row: Row): string {
  const value = requiredString(row, "gateId");
  if (!GATE_IDS.has(value)) throw new Error(`payload.gateId must be one of G0..G6 (got ${value})`);
  return value;
}

function requiredHash(row: Row, key: string): string {
  const value = requiredString(row, key);
  if (!/^[a-f0-9]{16,128}$/i.test(value)) throw new Error(`Harness payload.${key} must be a hexadecimal hash`);
  return value.toLowerCase();
}

function optionalHash(row: Row, key: string): string | null {
  if (row[key] === undefined || row[key] === null) return null;
  return requiredHash(row, key);
}

function rawStringArray(row: Row, key: string, label = "payload"): string[] {
  const value = row[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Harness ${label}.${key} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

function referenceArray(row: Row, key: string, label = "payload"): string[] {
  return rawStringArray(row, key, label).map((value) => {
    const canonical = CANONICAL_REFERENCE_PATTERN.test(value) && !value.split("/").includes("..");
    const legacy = LEGACY_REFERENCE_PATTERN.test(value);
    if (!canonical && !legacy) {
      throw new Error(`Harness ${label}.${key} must contain safe references, not URLs, paths, Prompts or raw output`);
    }
    return value;
  });
}

function tokenArray(row: Row, key: string, label = "payload"): string[] {
  return rawStringArray(row, key, label).map((value) => {
    if (!TOKEN_PATTERN.test(value)) throw new Error(`Harness ${label}.${key} must contain bounded metadata tokens`);
    return value;
  });
}

function optionalTimestamp(row: Row, key: string, label = "payload"): string | null {
  if (row[key] === undefined || row[key] === null) return null;
  const value = requiredString(row, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Harness ${label}.${key} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function nonNegativeInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`Harness payload.${key} must be a non-negative integer`);
  return Number(value);
}

function optionalNonNegativeInteger(row: Row, key: string): number | null {
  if (row[key] === undefined || row[key] === null) return null;
  return nonNegativeInteger(row, key);
}

function optionalBoolean(row: Row, key: string): boolean | null {
  if (row[key] === undefined || row[key] === null) return null;
  if (typeof row[key] !== "boolean") throw new Error(`Harness payload.${key} must be a boolean`);
  return row[key];
}

function requiredEnum<const T extends readonly string[]>(row: Row, key: string, values: T, label = "payload"): T[number] {
  const value = requiredString(row, key, label);
  if (!(values as readonly string[]).includes(value)) throw new Error(`${label}.${key} must be one of ${values.join(",")} (got ${value})`);
  return value as T[number];
}

function requiredEnumFromSet<T extends string>(row: Row, key: string, values: Set<T>): T {
  const value = requiredString(row, key);
  if (!values.has(value as T)) throw new Error(`Harness payload.${key} has unsupported value: ${value}`);
  return value as T;
}

function optionalEnumFromSet<T extends string>(row: Row, key: string, values: Set<T>): T | null {
  if (row[key] === undefined || row[key] === null) return null;
  return requiredEnumFromSet(row, key, values);
}
