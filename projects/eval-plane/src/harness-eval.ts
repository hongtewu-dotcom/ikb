import { normalizeHarnessEvent, type HarnessEventType } from "./harness-events.ts";

/**
 * Deterministic Harness evaluation.  This module intentionally does not call
 * a model or external observer. It evaluates a small, versioned contract
 * over admission metadata and structured Run events so a failure is
 * reproducible locally and can be replayed after a rule change.
 */

export const HARNESS_EVAL_VERSION = "harness-eval.v1";

export type HarnessEvalCategory = "admission" | "run_quality" | "approval" | "recovery" | "outer_loop" | "security";
export type HarnessObservedOutcome = "admit" | "skip" | "pass" | "block" | "proposal" | "no_proposal";

export interface HarnessEventInput {
  eventType: string;
  payload: unknown;
}

export interface HarnessAdmissionInput {
  decision: "admit" | "skip";
  scope: "personal" | "work";
  sourceRefs: string[];
  sourceScope?: "personal" | "work";
  admissionReason?: string;
  skipReason?: string;
  applicability?: string;
  boundary?: string;
  useWhen?: string;
  useInputs?: string[];
  useOutputs?: string[];
  useSteps?: string[];
  useChecks?: string[];
  useStopConditions?: string[];
}

export interface HarnessFailureInput {
  reasonCode: string;
  scope: "personal" | "work";
  roleId?: string;
  skillId?: string;
}

export interface HarnessEvalCase {
  caseId: string;
  category: HarnessEvalCategory;
  title: string;
  description: string;
  expected: HarnessObservedOutcome;
  admission?: HarnessAdmissionInput;
  events?: HarnessEventInput[];
  terminalStatus?: "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "canceled";
  requiredApproval?: boolean;
  expectedAction?: { targetHash: string; payloadHash: string; sideEffectLevel: string };
  retryActions?: Array<{ actionId: string; targetHash: string; payloadHash: string }>;
  failures?: HarnessFailureInput[];
  unsafePayload?: HarnessEventInput;
  mixedFailureReasons?: boolean;
}

export interface HarnessEvalResult {
  evalVersion: string;
  caseId: string;
  category: HarnessEvalCategory;
  title: string;
  expected: HarnessObservedOutcome;
  observed: HarnessObservedOutcome;
  passed: boolean;
  failedInvariants: string[];
  metrics: Record<string, number | boolean | string>;
}

const HASH = "a".repeat(64);

function event(eventType: HarnessEventType, payload: Record<string, unknown>): HarnessEventInput {
  return { eventType, payload };
}

function completeRunEvents(): HarnessEventInput[] {
  return [
    event("run.loop_started", { loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: [], contextHash: HASH }),
    event("run.step_started", { stepId: "step-1", stepName: "读取证据", loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: [], inputHash: HASH }),
    event("run.step_finished", { stepId: "step-1", stepName: "读取证据", loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: ["artifact-1"], inputHash: HASH, outputHash: HASH, status: "succeeded" }),
    event("run.gate_evaluated", { gateId: "G3", decision: "pass", reasonCode: "evidence_complete", evidenceRefs: ["artifact-1"], gateVersion: "gates.v1" }),
    event("run.artifact_linked", { artifactId: "artifact-1", relation: "produced", lineageRefs: ["src-1"] }),
    event("run.verification_completed", { result: "pass", checks: [{ id: "evidence", decision: "pass", evidenceRefs: ["artifact-1"] }], artifactRefs: ["artifact-1"] }),
    event("run.evaluation_completed", { evalVersion: HARNESS_EVAL_VERSION, suiteId: "synthetic-12", result: "pass", totalCases: 12, passedCases: 12, failedCases: 0, artifactRefs: ["artifact-1"] }),
    event("run.loop_finished", { loopId: "inner", iteration: 0, inputRefs: ["src-1"], outputRefs: ["artifact-1"], contextHash: HASH, status: "succeeded", nextAction: "finish" }),
  ];
}

function approvalEvents(decision: "approved" | "rejected", targetHash = HASH, payloadHash = HASH): HarnessEventInput[] {
  return [
    event("run.approval_checked", { approvalId: "approval-1", approvalDecision: decision, action: "publish", targetHash, payloadHash }),
    event("run.action_executed", { actionId: "action-1", action: "publish", sideEffectLevel: "L3", targetHash, payloadHash, approvalId: "approval-1", status: decision === "approved" ? "succeeded" : "blocked", errorCode: decision === "approved" ? null : "approval_required" }),
  ];
}

export function harnessEvaluationCases(): HarnessEvalCase[] {
  const fullContract = {
    sourceRefs: ["src-1"], admissionReason: "可复用的边界规则", applicability: "接口自动化设计和评审", boundary: "不替代业务验收",
    useWhen: "准备生成接口用例时", useInputs: ["代码 diff", "真实请求样本"], useOutputs: ["可执行用例集"], useSteps: ["代码分析", "真实请求", "差集校验"], useChecks: ["可执行率", "有效断言", "增量覆盖"], useStopConditions: ["接口识别不确定时停止"],
  };
  return [
    {
      caseId: "I1-admit-with-contract", category: "admission", title: "证据充分且有使用契约时准入", description: "来源、适用范围、边界和使用步骤齐全。", expected: "admit",
      admission: { decision: "admit", scope: "personal", ...fullContract },
    },
    {
      caseId: "I2-explicit-skip", category: "admission", title: "无长期增量时显式跳过", description: "跳过有理由且保留来源，不生成知识卡。", expected: "skip",
      admission: { decision: "skip", scope: "personal", sourceRefs: ["src-duplicate"], skipReason: "已有知识覆盖，无新增结论" },
    },
    {
      caseId: "I3-admit-missing-evidence", category: "admission", title: "准入缺少证据时阻断", description: "禁止无 source_refs 的知识进入候选。", expected: "block",
      admission: { decision: "admit", scope: "personal", sourceRefs: [], admissionReason: "仅凭模型判断" },
    },
    {
      caseId: "I4-scope-mismatch", category: "admission", title: "跨 scope 输入未显式授权时阻断", description: "work 来源不能默默进入 personal 知识库。", expected: "block",
      admission: { decision: "admit", scope: "personal", sourceScope: "work", ...fullContract },
    },
    {
      caseId: "M1-quality-needs-verifier", category: "run_quality", title: "成功 Run 必须具备完整证据链", description: "步骤、门禁、Verifier、Artifact 均存在且通过。", expected: "pass",
      terminalStatus: "succeeded", events: completeRunEvents(),
    },
    {
      caseId: "M2-terminal-success-is-not-quality", category: "run_quality", title: "terminal succeeded 不等于质量通过", description: "没有 Verifier/Artifact/Gate 的成功状态必须阻断质量结论。", expected: "block",
      terminalStatus: "succeeded", events: [],
    },
    {
      caseId: "M3-approved-side-effect", category: "approval", title: "高副作用 Action 需要匹配 Approval", description: "Approval 决策和目标/载荷哈希一致后才允许执行。", expected: "pass",
      terminalStatus: "running", requiredApproval: true, expectedAction: { targetHash: HASH, payloadHash: HASH, sideEffectLevel: "L3" }, events: approvalEvents("approved"),
    },
    {
      caseId: "M4-mismatched-approval-blocks-action", category: "approval", title: "Approval 哈希不匹配时隔离副作用", description: "目标或载荷改变后不得复用旧 Approval，Action 必须 blocked。", expected: "block",
      terminalStatus: "running", requiredApproval: true, expectedAction: { targetHash: HASH, payloadHash: "b".repeat(64), sideEffectLevel: "L3" }, events: approvalEvents("approved", HASH, HASH),
    },
    {
      caseId: "R1-idempotent-retry", category: "recovery", title: "恢复重试按 Action 身份幂等", description: "同一 actionId、目标哈希和载荷哈希的重放不会产生第二个副作用。", expected: "pass",
      retryActions: [{ actionId: "action-1", targetHash: HASH, payloadHash: HASH }, { actionId: "action-1", targetHash: HASH, payloadHash: HASH }],
    },
    {
      caseId: "R2-conflicting-retry-blocks", category: "recovery", title: "同一 Action 身份冲突时阻断", description: "重试携带不同载荷必须进入人工处理，而不是覆盖历史。", expected: "block",
      retryActions: [{ actionId: "action-1", targetHash: HASH, payloadHash: HASH }, { actionId: "action-1", targetHash: HASH, payloadHash: "b".repeat(64) }],
    },
    {
      caseId: "O1-failure-cluster-proposal", category: "outer_loop", title: "重复失败只生成改进候选", description: "同一失败模式达到阈值后产生 pending 候选，不能自动改 Skill。", expected: "proposal",
      failures: ["gate_missing_verifier", "gate_missing_verifier", "gate_missing_verifier"].map((reasonCode) => ({ reasonCode, scope: "personal" as const, roleId: "知识整理员", skillId: "ikb-knowledge-curator" })),
    },
    {
      caseId: "O2-mixed-failures-no-proposal", category: "outer_loop", title: "样本不足或失败混杂时不提案", description: "没有稳定模式时只保留观测，不生成规则修改。", expected: "no_proposal",
      failures: [{ reasonCode: "timeout", scope: "personal" }, { reasonCode: "scope_mismatch", scope: "work" }], mixedFailureReasons: true,
      unsafePayload: { eventType: "run.step_finished", payload: { stepId: "unsafe", stepName: "bad", status: "succeeded", content: "raw output", path: "/Users/private" } },
    },
  ];
}

export function evaluateHarnessCase(testCase: HarnessEvalCase): HarnessEvalResult {
  const failedInvariants: string[] = [];
  let observed: HarnessObservedOutcome = "block";
  const events = testCase.events ?? [];
  const normalizedEvents = [] as Array<{ eventType: HarnessEventType; payload: Record<string, unknown> }>;
  for (const input of events) {
    try {
      if (!normalizeHarnessEvent(input.eventType, input.payload)) failedInvariants.push("event_not_normalized");
      else normalizedEvents.push({ eventType: input.eventType as HarnessEventType, payload: input.payload as Record<string, unknown> });
    } catch (error) {
      failedInvariants.push(`invalid_event:${(error as Error).message}`);
    }
  }

  if (testCase.category === "admission") {
    const admission = testCase.admission!;
    if (admission.decision === "skip") {
      observed = admission.skipReason && admission.sourceRefs.length > 0 ? "skip" : "block";
      if (!admission.skipReason) failedInvariants.push("skip_reason_missing");
      if (admission.sourceRefs.length === 0) failedInvariants.push("skip_source_refs_missing");
    } else {
      const contractFields: Array<[string, unknown]> = [
        ["source_refs", admission.sourceRefs], ["admission_reason", admission.admissionReason], ["applicability", admission.applicability],
        ["boundary", admission.boundary], ["use_when", admission.useWhen], ["use_inputs", admission.useInputs], ["use_outputs", admission.useOutputs],
        ["use_steps", admission.useSteps], ["use_checks", admission.useChecks], ["use_stop_conditions", admission.useStopConditions],
      ];
      const missing = contractFields.filter(([, value]) => Array.isArray(value) ? value.length === 0 : !value).map(([name]) => name);
      if (missing.length > 0) failedInvariants.push(`admission_contract_missing:${missing.join(",")}`);
      if (admission.sourceScope && admission.sourceScope !== admission.scope) failedInvariants.push("scope_mismatch");
      observed = missing.length === 0 && !admission.sourceScope || (missing.length === 0 && admission.sourceScope === admission.scope) ? "admit" : "block";
    }
  } else if (testCase.category === "run_quality") {
    const hasStep = normalizedEvents.some((item) => item.eventType === "run.step_finished" && item.payload.status === "succeeded");
    const hasGate = normalizedEvents.some((item) => item.eventType === "run.gate_evaluated" && item.payload.decision === "pass");
    const verifier = normalizedEvents.find((item) => item.eventType === "run.verification_completed");
    const evaluation = normalizedEvents.find((item) => item.eventType === "run.evaluation_completed");
    const hasArtifact = normalizedEvents.some((item) => item.eventType === "run.artifact_linked" && item.payload.relation === "produced");
    const verifierPass = verifier?.payload.result === "pass" && Array.isArray(verifier.payload.artifactRefs) && verifier.payload.artifactRefs.length > 0;
    const evaluationPass = evaluation?.payload.result === "pass" && evaluation.payload.totalCases === evaluation.payload.passedCases && evaluation.payload.failedCases === 0 && Array.isArray(evaluation.payload.artifactRefs) && evaluation.payload.artifactRefs.length > 0;
    observed = testCase.terminalStatus === "succeeded" && hasStep && hasGate && verifierPass && evaluationPass && hasArtifact ? "pass" : "block";
    if (!hasStep) failedInvariants.push("step_success_missing");
    if (!hasGate) failedInvariants.push("gate_pass_missing");
    if (!verifierPass) failedInvariants.push("verifier_or_artifact_missing");
    if (!evaluationPass) failedInvariants.push("evaluation_or_artifact_missing");
    if (!hasArtifact) failedInvariants.push("artifact_link_missing");
  } else if (testCase.category === "approval") {
    const approval = normalizedEvents.find((item) => item.eventType === "run.approval_checked");
    const action = normalizedEvents.find((item) => item.eventType === "run.action_executed");
    const expected = testCase.expectedAction!;
    const matching = approval?.payload.approvalDecision === "approved"
      && approval.payload.targetHash === expected.targetHash
      && approval.payload.payloadHash === expected.payloadHash;
    const executed = action?.payload.status === "succeeded"
      && action.payload.targetHash === expected.targetHash
      && action.payload.payloadHash === expected.payloadHash;
    observed = matching && executed ? "pass" : "block";
    if (!matching) failedInvariants.push("approval_missing_or_hash_mismatch");
    if (testCase.requiredApproval && !executed) failedInvariants.push("side_effect_not_isolated");
  } else if (testCase.category === "recovery") {
    const actions = testCase.retryActions ?? [];
    const first = actions[0];
    const conflicting = actions.some((item) => item.actionId === first?.actionId && (item.targetHash !== first.targetHash || item.payloadHash !== first.payloadHash));
    observed = first && !conflicting ? "pass" : "block";
    if (conflicting) failedInvariants.push("conflicting_retry_identity");
    if (!first) failedInvariants.push("retry_identity_missing");
  } else if (testCase.category === "outer_loop") {
    const failures = testCase.failures ?? [];
    const groups = new Map<string, number>();
    for (const failure of failures) groups.set(`${failure.scope}:${failure.roleId ?? ""}:${failure.skillId ?? ""}:${failure.reasonCode}`, (groups.get(`${failure.scope}:${failure.roleId ?? ""}:${failure.skillId ?? ""}:${failure.reasonCode}`) ?? 0) + 1);
    const maxGroup = Math.max(0, ...groups.values());
    observed = maxGroup >= 3 && !testCase.mixedFailureReasons ? "proposal" : "no_proposal";
    if (observed === "proposal" && testCase.expected !== "proposal") failedInvariants.push("unexpected_proposal");
    if (testCase.unsafePayload) {
      try {
        normalizeHarnessEvent(testCase.unsafePayload.eventType, testCase.unsafePayload.payload);
        failedInvariants.push("unsafe_payload_accepted");
      } catch {
        // Raw content/path is correctly isolated by the event contract.
      }
    }
  } else if (testCase.category === "security") {
    if (!testCase.unsafePayload) failedInvariants.push("unsafe_fixture_missing");
    else {
      try {
        normalizeHarnessEvent(testCase.unsafePayload.eventType, testCase.unsafePayload.payload);
        failedInvariants.push("unsafe_payload_accepted");
      } catch {
        observed = "block";
      }
    }
  }

  const metrics = {
    eventCount: events.length,
    normalizedEventCount: normalizedEvents.length,
    failedInvariantCount: failedInvariants.length,
    hasVerifier: normalizedEvents.some((item) => item.eventType === "run.verification_completed"),
    hasEvaluation: normalizedEvents.some((item) => item.eventType === "run.evaluation_completed"),
    hasApproval: normalizedEvents.some((item) => item.eventType === "run.approval_checked"),
  };
  const unexpectedInvariant = failedInvariants.some((item) => item === "unsafe_payload_accepted" || item === "unexpected_proposal" || item.startsWith("invalid_event:"));
  const passed = observed === testCase.expected && !unexpectedInvariant && (testCase.expected === "block" || failedInvariants.length === 0);
  return { evalVersion: HARNESS_EVAL_VERSION, caseId: testCase.caseId, category: testCase.category, title: testCase.title, expected: testCase.expected, observed, passed, failedInvariants, metrics };
}

export function evaluateHarnessSuite(): { evalVersion: string; total: number; passed: number; failed: number; results: HarnessEvalResult[] } {
  const results = harnessEvaluationCases().map(evaluateHarnessCase);
  return { evalVersion: HARNESS_EVAL_VERSION, total: results.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, results };
}
