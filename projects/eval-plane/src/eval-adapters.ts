import type { EvalAdapterId, EvalCase } from "./eval-contract.ts";
import { evaluateRunAssessmentCase } from "./run-assessment.ts";
import { evaluateWorkRunAssessmentCase, WORK_RUN_QUALITY_SUITE_ID } from "./work-run-assessment.ts";

export interface EvalSubject {
  adapter: EvalAdapterId;
  subjectVersion: string;
  runId?: string;
  subjectHash?: string;
  data: Record<string, unknown>;
}

export interface AdapterEvaluation {
  observed: string;
  passed: boolean;
  reasonCodes: string[];
  metrics: Record<string, number | boolean | string>;
  evidenceRefs: string[];
  artifactRefs: string[];
  diagnosis: "subject" | "grader" | "ground_truth" | "environment" | "unknown";
}

export interface EvalAdapter {
  id: EvalAdapterId;
  version: string;
  load(value: unknown): EvalSubject;
  evaluate(testCase: EvalCase, subject: EvalSubject, thresholds?: Record<string, number>): AdapterEvaluation;
}

type Row = Record<string, unknown>;

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Row;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function bool(value: unknown): boolean {
  return value === true;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeSubject(adapter: EvalAdapterId, value: unknown): EvalSubject {
  const row = objectValue(value, `${adapter} fixture`);
  const subjectVersion = stringValue(row.subjectVersion ?? row.version) ?? "fixture-v1";
  return { adapter, subjectVersion, data: row };
}

function refs(testCase: EvalCase, suffix: string): { evidenceRefs: string[]; artifactRefs: string[] } {
  const fixture = testCase.inputRefs.find((item) => item.startsWith("fixture://")) ?? `case://${testCase.caseId}`;
  return { evidenceRefs: [fixture, `case://${testCase.caseId}/${suffix}`], artifactRefs: [`artifact://eval/${testCase.caseId}`] };
}

function result(testCase: EvalCase, observed: string, passed: boolean, reasonCodes: string[], metrics: Record<string, number | boolean | string>, diagnosis: AdapterEvaluation["diagnosis"] = "subject"): AdapterEvaluation {
  const casePassed = observed === testCase.expected.outcome;
  return { observed, passed: casePassed, reasonCodes, metrics, ...refs(testCase, casePassed ? "pass" : "fail"), diagnosis };
}

function workNodes(subject: EvalSubject): Row[] {
  const value = subject.data.nodes;
  if (Array.isArray(value)) return value.map((item) => objectValue(item, "work-harness node"));
  if (value && typeof value === "object") return Object.values(value).map((item) => objectValue(item, "work-harness node"));
  return [];
}

function workEvents(subject: EvalSubject): Row[] {
  return Array.isArray(subject.data.events) ? subject.data.events.map((item) => objectValue(item, "work-harness event")) : [];
}

function writeScopes(node: Row): string[] {
  return stringArray(node.write_scope ?? node.writeScope);
}

function actionIdentity(events: Row[]): Map<string, string> {
  const resultMap = new Map<string, string>();
  for (const event of events) {
    const actionId = stringValue(event.actionId ?? event.action_id);
    const targetHash = stringValue(event.targetHash ?? event.target_hash);
    const payloadHash = stringValue(event.payloadHash ?? event.payload_hash);
    if (actionId && targetHash && payloadHash) resultMap.set(actionId, `${targetHash}:${payloadHash}`);
  }
  return resultMap;
}

const workAdapter: EvalAdapter = {
  id: "work-harness",
  version: "work-harness-adapter-v1",
  load: (value) => safeSubject("work-harness", value),
  evaluate: (testCase, subject) => {
    if (testCase.suiteId === WORK_RUN_QUALITY_SUITE_ID) return evaluateWorkRunAssessmentCase(testCase, subject);
    const nodes = workNodes(subject);
    const events = workEvents(subject);
    const plan = objectValue(subject.data.plan ?? {}, "work-harness plan");
    const budget = objectValue(subject.data.budget ?? {}, "work-harness budget");
    const summary = objectValue(subject.data.summary ?? {}, "work-harness summary");
    const refsForCase = refs(testCase, "fixture");
    switch (testCase.caseId) {
      case "work-missing-dispatch-reason": {
        const missing = nodes.filter((node) => stringArray(node.dispatch_reasons ?? node.dispatchReasons).length === 0).length;
        return result(testCase, missing === 0 ? "pass" : "block", missing === 0, missing === 0 ? [] : ["dispatch_reason_missing"], { nodeCount: nodes.length, missingDispatchReasons: missing });
      }
      case "work-missing-acceptance": {
        const missing = nodes.filter((node) => stringArray(node.acceptance).length === 0 || stringArray(node.post_conditions ?? node.postConditions).length === 0).length;
        return result(testCase, missing === 0 ? "pass" : "block", missing === 0, missing === 0 ? [] : ["acceptance_or_post_condition_missing"], { nodeCount: nodes.length, incompleteNodes: missing });
      }
      case "work-invalid-dag": {
        const ids = new Set(nodes.map((node) => stringValue(node.id)).filter((item): item is string => Boolean(item)));
        const missingDeps = nodes.flatMap((node) => stringArray(node.depends_on ?? node.dependsOn)).filter((dependency) => !ids.has(dependency));
        return result(testCase, missingDeps.length === 0 ? "pass" : "block", missingDeps.length === 0, missingDeps.length === 0 ? [] : ["dag_dependency_missing"], { nodeCount: nodes.length, missingDependencies: missingDeps.length });
      }
      case "work-write-conflict": {
        const waves = Array.isArray(plan.parallel_waves ?? plan.parallelWaves) ? (plan.parallel_waves ?? plan.parallelWaves) as unknown[] : [];
        let conflicts = 0;
        for (const wave of waves) {
          const waveNodes = stringArray(wave).map((id) => nodes.find((node) => node.id === id)).filter((item): item is Row => Boolean(item));
          const seen = new Set<string>();
          for (const node of waveNodes) for (const scope of writeScopes(node)) {
            if (seen.has(scope)) conflicts += 1;
            seen.add(scope);
          }
        }
        return result(testCase, conflicts === 0 ? "pass" : "block", conflicts === 0, conflicts === 0 ? [] : ["write_scope_conflict"], { parallelWaves: waves.length, writeConflicts: conflicts });
      }
      case "work-incomplete-handoff": {
        const handoffs = events.filter((event) => event.type === "handoff" || event.eventType === "handoff" || event.handoff);
        const incomplete = handoffs.filter((event) => !stringValue(event.fromRole ?? event.from_role) || !stringValue(event.toRole ?? event.to_role) || stringArray(event.outputRefs ?? event.output_refs).length === 0).length;
        return result(testCase, incomplete === 0 ? "pass" : "block", incomplete === 0, incomplete === 0 ? [] : ["handoff_contract_incomplete"], { handoffs: handoffs.length, incompleteHandoffs: incomplete });
      }
      case "work-missing-verifier": {
        const hasVerifier = events.some((event) => event.type === "verifier_completed" || event.eventType === "verifier_completed" || event.verifier === true);
        const qualityPassed = bool(summary.quality_verified ?? summary.qualityVerified);
        const valid = hasVerifier && qualityPassed;
        return result(testCase, valid ? "pass" : "block", valid, valid ? [] : ["verifier_required"], { hasVerifier, qualityVerified: qualityPassed });
      }
      case "work-retry-budget": {
        const retries = finite(summary.retry_rounds ?? summary.retryRounds) ?? events.filter((event) => event.type === "retry" || event.eventType === "retry").length;
        const maxRetries = finite(budget.max_retries ?? budget.maxRetries) ?? 0;
        const valid = retries <= maxRetries;
        return result(testCase, valid ? "pass" : "block", valid, valid ? [] : ["retry_budget_exceeded"], { retryRounds: retries, maxRetries });
      }
      case "work-conflicting-side-effect": {
        const seen = new Map<string, string>();
        let conflicts = 0;
        let actionCount = 0;
        for (const event of events) {
          const actionId = stringValue(event.actionId ?? event.action_id);
          const targetHash = stringValue(event.targetHash ?? event.target_hash);
          const payloadHash = stringValue(event.payloadHash ?? event.payload_hash);
          if (!actionId || !targetHash || !payloadHash) continue;
          actionCount += 1;
          const identity = `${targetHash}:${payloadHash}`;
          const previous = seen.get(actionId);
          if (previous && previous !== identity) conflicts += 1;
          seen.set(actionId, identity);
        }
        return result(testCase, conflicts === 0 ? "pass" : "block", conflicts === 0, conflicts === 0 ? [] : ["side_effect_identity_conflict"], { actionEvents: actionCount, actionIds: seen.size, conflictingActionIds: conflicts });
      }
      case "work-quality-summary": {
        const firstPass = bool(summary.first_pass ?? summary.firstPass);
        const finalPass = bool(summary.final_pass ?? summary.finalPass);
        const repairRounds = finite(summary.repair_rounds ?? summary.repairRounds) ?? 0;
        return { ...result(testCase, finalPass ? "pass" : "block", finalPass, finalPass ? [] : ["final_acceptance_failed"], { firstPass, finalPass, repairRounds }), evidenceRefs: refsForCase.evidenceRefs, artifactRefs: refsForCase.artifactRefs };
      }
      default:
        throw new Error(`Work Harness adapter does not support case ${testCase.caseId}`);
    }
  },
};

const specxAdapter: EvalAdapter = {
  id: "specx",
  version: "specx-adapter-v1",
  load: (value) => safeSubject("specx", value),
  evaluate: (testCase, subject, thresholds = {}) => {
    const artifacts = objectValue(subject.data.artifacts ?? {}, "SpecX artifacts");
    const coverage = finite(subject.data.ac_coverage ?? subject.data.acCoverage) ?? 0;
    const consistent = bool(subject.data.code_test_consistent ?? subject.data.codeTestConsistent);
    const fresh = bool(subject.data.artifact_fresh ?? subject.data.artifactFresh);
    const required = ["design.md", "tasks.md", "code_done.md", "test_report.md"].every((name) => Boolean(artifacts[name]));
    const requiredCoverage = thresholds.acCoverage ?? 0.8;
    const valid = required && coverage >= requiredCoverage && consistent && fresh;
    return result(testCase, valid ? "pass" : "block", valid, valid ? [] : ["specx_artifact_or_ac_missing"], { acCoverage: coverage, requiredCoverage, requiredArtifacts: required, codeTestConsistent: consistent, artifactFresh: fresh });
  },
};

const pipelineAdapter: EvalAdapter = {
  id: "pipeline",
  version: "pipeline-adapter-v1",
  load: (value) => safeSubject("pipeline", value),
  evaluate: (testCase, subject, thresholds = {}) => {
    const specValid = bool(subject.data.case_spec_valid ?? subject.data.caseSpecValid);
    const stepsMatch = bool(subject.data.steps_match ?? subject.data.stepsMatch);
    const assertions = finite(subject.data.assertion_valid_rate ?? subject.data.assertionValidRate) ?? 0;
    const logHits = finite(subject.data.log_verification_hits ?? subject.data.logVerificationHits) ?? 0;
    const cleanup = bool(subject.data.cleanup_idempotent ?? subject.data.cleanupIdempotent);
    const requiredAssertionRate = thresholds.assertionValidRate ?? 0.8;
    const valid = specValid && stepsMatch && assertions >= requiredAssertionRate && logHits > 0 && cleanup;
    return result(testCase, valid ? "pass" : "block", valid, valid ? [] : ["pipeline_contract_or_cleanup_failed"], { caseSpecValid: specValid, stepsMatch, assertionValidRate: assertions, requiredAssertionRate, logVerificationHits: logHits, cleanupIdempotent: cleanup });
  },
};

const adapters: Record<EvalAdapterId, EvalAdapter> = {
  "ikb": {
    id: "ikb",
    version: "ikb-run-adapter-v1",
    load: (value) => safeSubject("ikb", value),
    evaluate: (testCase, subject) => evaluateRunAssessmentCase(testCase, subject),
  },
  "work-harness": workAdapter,
  specx: specxAdapter,
  pipeline: pipelineAdapter,
};

export function getEvalAdapter(id: EvalAdapterId): EvalAdapter {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`Eval adapter not found: ${id}`);
  return adapter;
}
