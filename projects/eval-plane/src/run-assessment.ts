import type { EvalSubject, AdapterEvaluation } from "./eval-adapters.ts";
import { DETERMINISTIC_GRADER_VERSION, EVAL_CASE_SCHEMA, EVAL_SUITE_SCHEMA, type EvalCase, type EvalLevel, type EvalSuite } from "./eval-contract.ts";
import type { RunArtifactSubject, RunPlanStep, RunSubject, RunSubjectEvent } from "./run-subject.ts";

export const IKB_RUN_QUALITY_SUITE_ID = "ikb-run-quality";
export const IKB_RUN_QUALITY_SUITE_VERSION = "v1";

interface QualityFacts {
  terminalSucceeded: boolean;
  plannedSteps: number;
  completedPlanSteps: number;
  successfulSteps: number;
  failedSteps: number;
  passGates: number;
  blockedGates: number;
  verifierResult: string;
  verifierChecks: number;
  verifierArtifacts: number;
  registeredArtifacts: number;
  existingArtifacts: number;
  validArtifactHashes: number;
  linkedArtifacts: number;
  invalidEvents: number;
  ledgerBrokenChains: number;
  passed: boolean;
  reasonCodes: string[];
  evidenceRefs: string[];
  artifactRefs: string[];
}

export function runAssessmentSuite(): { suite: EvalSuite; cases: EvalCase[] } {
  const definitions: Array<{ id: string; level: EvalLevel; title: string; description: string; expected?: string; invariants: string[]; tags: string[] }> = [
    {
      id: "run-quality-chain",
      level: "L1",
      title: "成功 Run 具备完整质量证据链",
      description: "真实 Run 只有在 Step、Gate、Verifier 和已登记 Artifact 均有效时才质量通过。",
      invariants: ["terminal_succeeded", "step_succeeded", "gate_passed", "verifier_passed", "artifact_registered_and_linked"],
      tags: ["quality-gate", "real-run"],
    },
    {
      id: "run-terminal-is-not-quality",
      level: "L1",
      title: "终态成功不能替代质量通过",
      description: "terminal succeeded 但证据链不完整时必须阻断质量结论。",
      invariants: ["terminal_success_requires_quality_chain"],
      tags: ["quality-gate", "negative-rule", "real-run"],
    },
    {
      id: "run-handoff-contract",
      level: "L1",
      title: "真实 Handoff 满足交接合同",
      description: "每次 Handoff 必须具有来源、目标、Step、输出引用和合同版本。",
      invariants: ["handoff_contract_complete"],
      tags: ["handoff", "real-run"],
    },
    {
      id: "run-dag-contract",
      level: "L1",
      title: "真实 Run Plan 的依赖合法",
      description: "Plan Step ID 唯一，依赖存在且不能形成环。",
      invariants: ["plan_valid", "dependencies_exist", "dag_acyclic"],
      tags: ["dag", "real-run"],
    },
    {
      id: "run-approval-binding",
      level: "L1",
      title: "Approval 与 Action 身份绑定",
      description: "Approval 的状态、动作、目标 hash 和载荷 hash 必须与检查及执行事件一致。",
      invariants: ["approval_state_matches", "action_identity_matches"],
      tags: ["approval", "side-effect", "real-run"],
    },
    {
      id: "run-side-effect-idempotency",
      level: "L1",
      title: "副作用身份无冲突",
      description: "同一 actionId 不能对应不同动作、目标 hash 或载荷 hash。",
      invariants: ["action_identity_stable"],
      tags: ["idempotency", "side-effect", "real-run"],
    },
    {
      id: "run-recovery-quality",
      level: "L2",
      title: "恢复后的最终质量可计算",
      description: "区分首次通过、最终通过、重试轮次和恢复成功。",
      invariants: ["final_quality_passed"],
      tags: ["recovery", "metric", "real-run"],
    },
    {
      id: "run-domain-result",
      level: "L3",
      title: "领域结果由领域 Adapter 负责",
      description: "基础真实 Run Suite 不伪造领域结论；未注册领域 Adapter 时明确返回 not_applicable。",
      expected: "not_applicable",
      invariants: ["domain_adapter_explicit"],
      tags: ["domain", "adapter-boundary", "real-run"],
    },
  ];
  const cases = definitions.map((definition): EvalCase => ({
    schema: EVAL_CASE_SCHEMA,
    caseId: definition.id,
    suiteId: IKB_RUN_QUALITY_SUITE_ID,
    suiteVersion: IKB_RUN_QUALITY_SUITE_VERSION,
    level: definition.level,
    title: definition.title,
    description: definition.description,
    inputRefs: ["run://subject"],
    expected: { outcome: definition.expected ?? "pass", invariants: definition.invariants },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags: definition.tags,
    adapter: "ikb",
  }));
  return {
    suite: {
      schema: EVAL_SUITE_SCHEMA,
      kind: "run_assessment",
      suiteId: IKB_RUN_QUALITY_SUITE_ID,
      suiteVersion: IKB_RUN_QUALITY_SUITE_VERSION,
      harnessId: "ikb",
      levels: ["L1", "L2", "L3"],
      graderVersion: DETERMINISTIC_GRADER_VERSION,
      cases: cases.map((testCase) => testCase.caseId),
      thresholds: { qualityPassRate: 1, maxRetryRounds: 3 },
      adapter: "ikb",
    },
    cases,
  };
}

export function evaluateRunAssessmentCase(testCase: EvalCase, value: EvalSubject): AdapterEvaluation {
  const subject = requireRunSubject(value);
  switch (testCase.caseId) {
    case "run-quality-chain":
      return qualityResult(testCase, qualityFacts(subject));
    case "run-terminal-is-not-quality": {
      const quality = qualityFacts(subject);
      const passed = !quality.terminalSucceeded || quality.passed;
      return evaluated(testCase, passed ? "pass" : "block", passed ? [] : ["terminal_success_without_quality"], {
        terminalSucceeded: quality.terminalSucceeded,
        qualityChainPassed: quality.passed,
      }, quality.evidenceRefs, quality.artifactRefs);
    }
    case "run-handoff-contract":
      return handoffResult(testCase, subject);
    case "run-dag-contract":
      return dagResult(testCase, subject);
    case "run-approval-binding":
      return approvalResult(testCase, subject);
    case "run-side-effect-idempotency":
      return sideEffectResult(testCase, subject);
    case "run-recovery-quality":
      return recoveryResult(testCase, subject);
    case "run-domain-result":
      return evaluated(testCase, "not_applicable", [], {
        domainAdapterConfigured: false,
        taskTypePresent: Boolean(subject.data.task.type),
      }, [`run://${subject.runId}`], []);
    default:
      throw new Error(`IKB Run adapter does not support case ${testCase.caseId}`);
  }
}

function qualityResult(testCase: EvalCase, quality: QualityFacts): AdapterEvaluation {
  return evaluated(testCase, quality.passed ? "pass" : "block", quality.reasonCodes, {
    terminalSucceeded: quality.terminalSucceeded,
    plannedSteps: quality.plannedSteps,
    completedPlanSteps: quality.completedPlanSteps,
    successfulSteps: quality.successfulSteps,
    failedSteps: quality.failedSteps,
    passGates: quality.passGates,
    blockedGates: quality.blockedGates,
    verifierPassed: quality.verifierResult === "pass",
    verifierChecks: quality.verifierChecks,
    verifierArtifacts: quality.verifierArtifacts,
    registeredArtifacts: quality.registeredArtifacts,
    existingArtifacts: quality.existingArtifacts,
    validArtifactHashes: quality.validArtifactHashes,
    linkedArtifacts: quality.linkedArtifacts,
    invalidEvents: quality.invalidEvents,
    ledgerBrokenChains: quality.ledgerBrokenChains,
  }, quality.evidenceRefs, quality.artifactRefs);
}

function qualityFacts(subject: RunSubject): QualityFacts {
  const stepEvents = latestBy(subject.data.events.filter((event) => event.eventType === "run.step_finished" && event.valid), (event) => stringValue(event.payload.stepId));
  const stepById = new Map(stepEvents.map((event) => [stringValue(event.payload.stepId), event]));
  const plannedStepIds = new Set(subject.data.plan.steps.map((step) => step.id));
  const completedPlanSteps = subject.data.plan.steps.filter((step) => stepById.get(step.id)?.payload.status === "succeeded").length;
  const successfulSteps = stepEvents.filter((event) => event.payload.status === "succeeded").length;
  const failedSteps = stepEvents.filter((event) => event.payload.status === "failed" || event.payload.status === "blocked").length;
  const gateEvents = latestBy(subject.data.events.filter((event) => event.eventType === "run.gate_evaluated" && event.valid), (event) => stringValue(event.payload.gateId));
  const passGates = gateEvents.filter((event) => event.payload.decision === "pass").length;
  const blockedGates = gateEvents.filter((event) => event.payload.decision === "block").length;
  const verifier = lastEvent(subject.data.events, "run.verification_completed");
  const verifierResult = verifier?.valid && typeof verifier.payload.result === "string" ? verifier.payload.result : "missing";
  const artifactIds = new Set(subject.data.artifacts.map((artifact) => artifact.id));
  const artifactRefs = new Set(subject.data.artifacts.map((artifact) => artifact.ref));
  const links = subject.data.events.filter((event) => event.eventType === "run.artifact_linked" && event.valid && event.payload.relation === "produced");
  const linkedArtifactIds = new Set(links.map((event) => stringValue(event.payload.artifactId)).filter((id): id is string => Boolean(id) && artifactIds.has(id!)));
  const successfulStepArtifactIds = referencedArtifactIds(stepEvents
    .filter((event) => event.payload.status === "succeeded" && plannedStepIds.has(stringValue(event.payload.stepId) ?? ""))
    .flatMap((event) => stringArray(event.payload.outputRefs)));
  const passGateArtifactIds = referencedArtifactIds(gateEvents
    .filter((event) => event.payload.decision === "pass")
    .flatMap((event) => stringArray(event.payload.evidenceRefs)));
  const verifierChecks = verifier?.valid && Array.isArray(verifier.payload.checks)
    ? verifier.payload.checks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const verifierArtifactReferenceValues = verifier?.valid ? stringArray(verifier.payload.artifactRefs) : [];
  const verifierArtifactIds = referencedArtifactIds(verifierArtifactReferenceValues);
  const verifierEvidenceArtifactIds = referencedArtifactIds(verifierChecks.flatMap((check) => stringArray(check.evidenceRefs)));
  const verifierChecksPassed = verifierChecks.length > 0
    && verifierChecks.every((check) => check.decision === "pass" || check.decision === "not_applicable")
    && verifierChecks.some((check) => check.decision === "pass");
  const verifierChecksHaveEvidence = verifierChecks.length > 0
    && verifierChecks.every((check) => stringArray(check.evidenceRefs).length > 0);
  const invalidEvents = subject.data.events.filter((event) => !event.valid).length;
  const terminalSucceeded = subject.data.run.status === "succeeded";
  const registeredArtifacts = subject.data.artifacts.length;
  const existingArtifacts = subject.data.artifacts.filter((artifact) => artifact.exists).length;
  const validArtifactHashes = subject.data.artifacts.filter((artifact) => artifact.regularFile && artifact.hashMatches).length;
  const linkedArtifacts = linkedArtifactIds.size;
  const reasonCodes: string[] = [];
  if (!subject.data.integrity.ledgerVerified) reasonCodes.push("ledger_integrity_broken");
  if (!terminalSucceeded) reasonCodes.push("terminal_not_succeeded");
  if (!subject.data.plan.valid) reasonCodes.push("plan_invalid");
  if (subject.data.plan.steps.length === 0) reasonCodes.push("planned_step_missing");
  if (completedPlanSteps < subject.data.plan.steps.length) reasonCodes.push("plan_step_incomplete");
  if (successfulSteps === 0) reasonCodes.push("successful_step_missing");
  if (failedSteps > 0) reasonCodes.push("step_failed_or_blocked");
  if (passGates === 0) reasonCodes.push("gate_pass_missing");
  if (blockedGates > 0) reasonCodes.push("gate_blocked");
  if (verifierResult !== "pass") reasonCodes.push("verifier_not_passed");
  if (verifierChecks.length === 0) reasonCodes.push("verifier_checks_missing");
  else if (!verifierChecksPassed) reasonCodes.push("verifier_check_not_passed");
  if (!verifierChecksHaveEvidence) reasonCodes.push("verifier_check_evidence_missing");
  if (registeredArtifacts === 0) reasonCodes.push("produced_artifact_missing");
  if (existingArtifacts < registeredArtifacts) reasonCodes.push("artifact_content_missing");
  if (validArtifactHashes < registeredArtifacts) reasonCodes.push("artifact_hash_mismatch");
  if (linkedArtifacts < registeredArtifacts) reasonCodes.push("artifact_link_missing");
  if (links.some((event) => !artifactIds.has(stringValue(event.payload.artifactId) ?? ""))) reasonCodes.push("artifact_not_registered");
  if ([...artifactIds].some((id) => !successfulStepArtifactIds.has(id))) reasonCodes.push("step_artifact_coverage_missing");
  if ([...artifactIds].some((id) => !passGateArtifactIds.has(id))) reasonCodes.push("gate_artifact_coverage_missing");
  if (verifierArtifactReferenceValues.length === 0) reasonCodes.push("verifier_artifact_refs_missing");
  if ([...artifactIds].some((id) => !verifierArtifactIds.has(id))) reasonCodes.push("verifier_artifact_coverage_missing");
  if ([...verifierArtifactIds].some((id) => !artifactIds.has(id))) reasonCodes.push("verifier_artifact_unregistered");
  if ([...artifactIds].some((id) => !verifierEvidenceArtifactIds.has(id))) reasonCodes.push("verifier_evidence_coverage_missing");
  if (invalidEvents > 0) reasonCodes.push("invalid_harness_event");
  return {
    terminalSucceeded,
    plannedSteps: subject.data.plan.steps.length,
    completedPlanSteps,
    successfulSteps,
    failedSteps,
    passGates,
    blockedGates,
    verifierResult,
    verifierChecks: verifierChecks.length,
    verifierArtifacts: verifierArtifactIds.size,
    registeredArtifacts,
    existingArtifacts,
    validArtifactHashes,
    linkedArtifacts,
    invalidEvents,
    ledgerBrokenChains: subject.data.integrity.brokenChains,
    passed: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)],
    evidenceRefs: unique([`run://${subject.runId}`, ...stepEvents.map((event) => event.eventRef), ...gateEvents.map((event) => event.eventRef), ...(verifier ? [verifier.eventRef] : []), ...links.map((event) => event.eventRef)]),
    artifactRefs: [...artifactRefs],
  };
}

function handoffResult(testCase: EvalCase, subject: RunSubject): AdapterEvaluation {
  const handoffs = subject.data.events.filter((event) => event.eventType === "run.handoff");
  const incomplete = handoffs.filter((event) => !event.valid
    || !stringValue(event.payload.handoffId)
    || !stringValue(event.payload.stepId)
    || !stringValue(event.payload.fromRole)
    || !stringValue(event.payload.toRole)
    || !stringValue(event.payload.contractVersion)
    || stringArray(event.payload.outputRefs).length === 0);
  return evaluated(testCase, incomplete.length === 0 ? "pass" : "block", incomplete.length === 0 ? [] : ["handoff_contract_incomplete"], {
    handoffCount: handoffs.length,
    incompleteHandoffs: incomplete.length,
  }, unique([`run://${subject.runId}`, ...handoffs.map((event) => event.eventRef)]), []);
}

function dagResult(testCase: EvalCase, subject: RunSubject): AdapterEvaluation {
  const steps = subject.data.plan.steps;
  const ids = steps.map((step) => step.id);
  const idSet = new Set(ids);
  const duplicateIds = ids.length - idSet.size;
  const missingDependencies = steps.flatMap((step) => step.dependsOn).filter((dependency) => !idSet.has(dependency)).length;
  const cyclic = hasCycle(steps);
  const reasonCodes = [...subject.data.plan.reasonCodes];
  if (duplicateIds > 0) reasonCodes.push("plan_step_id_duplicate");
  if (missingDependencies > 0) reasonCodes.push("plan_dependency_missing");
  if (cyclic) reasonCodes.push("plan_cycle_detected");
  const passed = subject.data.plan.valid && reasonCodes.length === 0;
  return evaluated(testCase, passed ? "pass" : "block", unique(reasonCodes), {
    planValid: subject.data.plan.valid,
    planSteps: steps.length,
    duplicateStepIds: duplicateIds,
    missingDependencies,
    cycleDetected: cyclic,
  }, [`run://${subject.runId}`], []);
}

function approvalResult(testCase: EvalCase, subject: RunSubject): AdapterEvaluation {
  const approvals = new Map(subject.data.approvals.map((approval) => [approval.id, approval]));
  const checks = subject.data.events.filter((event) => event.eventType === "run.approval_checked");
  const actions = subject.data.events.filter((event) => event.eventType === "run.action_executed");
  const checkedApprovalIds = new Set<string>();
  let mismatches = 0;
  let invalidEvents = 0;
  for (const check of checks) {
    if (!check.valid) {
      invalidEvents += 1;
      continue;
    }
    const decision = stringValue(check.payload.approvalDecision);
    if (decision === "not_required") continue;
    const approvalId = stringValue(check.payload.approvalId);
    const approval = approvalId ? approvals.get(approvalId) : undefined;
    if (approvalId) checkedApprovalIds.add(approvalId);
    if (!approval
      || approval.status !== decision
      || approval.action !== stringValue(check.payload.action)
      || approval.targetHash !== stringValue(check.payload.targetHash)
      || approval.payloadHash !== stringValue(check.payload.payloadHash)) mismatches += 1;
  }
  for (const action of actions) {
    if (!action.valid) {
      invalidEvents += 1;
      continue;
    }
    const approvalId = stringValue(action.payload.approvalId);
    if (!approvalId) continue;
    const approval = approvals.get(approvalId);
    const matchingCheck = checks.find((check) => check.valid
      && check.payload.approvalId === approvalId
      && check.payload.approvalDecision === "approved"
      && check.payload.action === action.payload.action
      && check.payload.targetHash === action.payload.targetHash
      && check.payload.payloadHash === action.payload.payloadHash);
    if (!approval
      || approval.status !== "approved"
      || approval.action !== stringValue(action.payload.action)
      || approval.targetHash !== stringValue(action.payload.targetHash)
      || approval.payloadHash !== stringValue(action.payload.payloadHash)
      || !matchingCheck) mismatches += 1;
  }
  const missingChecks = subject.data.approvals.filter((approval) => !checkedApprovalIds.has(approval.id)).length;
  const reasonCodes: string[] = [];
  if (mismatches > 0) reasonCodes.push("approval_action_mismatch");
  if (missingChecks > 0) reasonCodes.push("approval_check_missing");
  if (invalidEvents > 0) reasonCodes.push("approval_event_invalid");
  return evaluated(testCase, reasonCodes.length === 0 ? "pass" : "block", reasonCodes, {
    registeredApprovals: subject.data.approvals.length,
    approvalChecks: checks.length,
    actionEvents: actions.length,
    approvalMismatches: mismatches,
    missingApprovalChecks: missingChecks,
  }, unique([`run://${subject.runId}`, ...checks.map((event) => event.eventRef), ...actions.map((event) => event.eventRef)]), []);
}

function sideEffectResult(testCase: EvalCase, subject: RunSubject): AdapterEvaluation {
  const actions = subject.data.events.filter((event) => event.eventType === "run.action_executed");
  const identities = new Map<string, string>();
  let conflicts = 0;
  let duplicates = 0;
  let invalidEvents = 0;
  for (const event of actions) {
    if (!event.valid) {
      invalidEvents += 1;
      continue;
    }
    const actionId = stringValue(event.payload.actionId);
    const action = stringValue(event.payload.action);
    const targetHash = stringValue(event.payload.targetHash);
    const bodyHash = stringValue(event.payload.payloadHash);
    if (!actionId || !action || !targetHash || !bodyHash) {
      invalidEvents += 1;
      continue;
    }
    const identity = `${action}:${targetHash}:${bodyHash}`;
    const previous = identities.get(actionId);
    if (previous === identity) duplicates += 1;
    else if (previous) conflicts += 1;
    identities.set(actionId, identity);
  }
  const reasonCodes: string[] = [];
  if (conflicts > 0) reasonCodes.push("side_effect_identity_conflict");
  if (invalidEvents > 0) reasonCodes.push("action_event_invalid");
  return evaluated(testCase, reasonCodes.length === 0 ? "pass" : "block", reasonCodes, {
    actionEvents: actions.length,
    distinctActionIds: identities.size,
    duplicateActions: duplicates,
    conflictingActionIds: conflicts,
  }, unique([`run://${subject.runId}`, ...actions.map((event) => event.eventRef)]), []);
}

function recoveryResult(testCase: EvalCase, subject: RunSubject): AdapterEvaluation {
  const quality = qualityFacts(subject);
  const retryRounds = subject.data.retry.retryRounds;
  const firstPass = retryRounds === 0 && quality.passed;
  const finalPass = quality.passed;
  const recoverySucceeded = retryRounds > 0 && finalPass;
  return evaluated(testCase, finalPass ? "pass" : "block", finalPass ? [] : ["final_quality_failed"], {
    firstPass,
    finalPass,
    retryRounds,
    repairRounds: retryRounds,
    recoverySucceeded,
  }, quality.evidenceRefs, quality.artifactRefs);
}

function evaluated(testCase: EvalCase, observed: string, reasonCodes: string[], metrics: AdapterEvaluation["metrics"], evidenceRefs: string[], artifactRefs: string[]): AdapterEvaluation {
  return {
    observed,
    passed: observed === testCase.expected.outcome,
    reasonCodes,
    metrics,
    evidenceRefs: unique(evidenceRefs),
    artifactRefs: unique(artifactRefs),
    diagnosis: "subject",
  };
}

function requireRunSubject(subject: EvalSubject): RunSubject {
  if (subject.adapter !== "ikb" || typeof subject.runId !== "string" || typeof subject.subjectHash !== "string") {
    throw new Error("IKB Run assessment requires a loaded RunSubject");
  }
  return subject as RunSubject;
}

function latestBy(events: RunSubjectEvent[], key: (event: RunSubjectEvent) => string | null): RunSubjectEvent[] {
  const result = new Map<string, RunSubjectEvent>();
  for (const event of events) {
    const value = key(event);
    if (value) result.set(value, event);
  }
  return [...result.values()];
}

function lastEvent(events: RunSubjectEvent[], eventType: string): RunSubjectEvent | null {
  return [...events].reverse().find((event) => event.eventType === eventType) ?? null;
}

function hasCycle(steps: RunPlanStep[]): boolean {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (dependencies.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function referencedArtifactIds(references: string[]): Set<string> {
  const result = new Set<string>();
  for (const reference of references) {
    if (reference.startsWith("artifact://")) result.add(reference.slice("artifact://".length));
    else if (reference.startsWith("artifact:")) result.add(reference.slice("artifact:".length));
    else result.add(reference);
  }
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
