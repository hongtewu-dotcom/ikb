import type { AdapterEvaluation, EvalSubject } from "./eval-adapters.ts";
import { DETERMINISTIC_GRADER_VERSION, EVAL_CASE_SCHEMA, EVAL_SUITE_SCHEMA, type EvalCase, type EvalLevel, type EvalSuite } from "./eval-contract.ts";
import { WORK_RUN_QUALITY_SUITE_ID, workQualityHistory, type WorkQualityAttempt } from "./work-quality-history.ts";
import { WORK_RUN_SUBJECT_VERSION, type WorkNodeSubject, type WorkRunSubject, type WorkRunSubjectData } from "./work-run-subject.ts";

export { WORK_RUN_QUALITY_SUITE_ID } from "./work-quality-history.ts";
export const WORK_RUN_QUALITY_SUITE_VERSION = "v4";

const HARD_DISPATCH_REASONS = new Set(["independent_write", "approval_boundary", "independent_verification", "independent_retry"]);
const SOFT_DISPATCH_REASONS = new Set(["parallelism", "context_reduction", "evidence_separation", "owner_separation"]);
const ALL_DISPATCH_REASONS = new Set([...HARD_DISPATCH_REASONS, ...SOFT_DISPATCH_REASONS]);

interface WorkQualityFacts {
  contractPassed: boolean;
  graphPassed: boolean;
  closurePassed: boolean;
  verificationPassed: boolean;
  retryPassed: boolean;
  finalPass: boolean;
  firstPass: boolean;
  recoverySucceeded: boolean;
  retryRounds: number;
  repairRounds: number;
  maxObservedRetries: number;
  graphReasons: string[];
  closureReasons: string[];
  verificationReasons: string[];
  retryReasons: string[];
  verifierNodes: number;
  completedNodes: number;
  handoffNodes: number;
  concurrentWriteConflicts: number;
}

interface CanonicalScope {
  root: string;
  segments: string[];
  caseInsensitive: boolean;
}

export function workRunAssessmentSuite(): { suite: EvalSuite; cases: EvalCase[] } {
  const definitions: Array<{ id: string; level: EvalLevel; title: string; description: string; expected?: string; invariants: string[]; tags: string[] }> = [
    {
      id: "work-run-contract-integrity",
      level: "L1",
      title: "真实任务目录合同完整",
      description: "Task、Plan、Run State、Events、Verification 与 Run Summary 必须可解析且身份一致。",
      invariants: ["documents_valid", "identity_consistent", "events_parseable"],
      tags: ["real-run", "contract"],
    },
    {
      id: "work-run-dag-scope",
      level: "L1",
      title: "真实 DAG 与调度范围合法",
      description: "节点依赖无环、调度理由有效，实际并行执行不能发生写范围冲突。",
      invariants: ["dag_valid", "dispatch_reason_valid", "concurrent_write_scope_safe"],
      tags: ["real-run", "dag", "side-effect"],
    },
    {
      id: "work-run-node-closure",
      level: "L1",
      title: "节点与 Handoff 证据闭合",
      description: "每个独立节点都必须完成，并留下合法 Handoff、证据或产物以及验证记录。",
      invariants: ["nodes_completed", "handoffs_valid", "evidence_present", "validation_present"],
      tags: ["real-run", "handoff", "quality-gate"],
    },
    {
      id: "work-run-verification-chain",
      level: "L1",
      title: "终态成功具备独立验证链",
      description: "completed、Run Summary、Verification 和独立 verify 节点必须一致，终态不能替代质量结论。",
      invariants: ["terminal_completed", "summary_verified", "verification_passed", "independent_verifier_present"],
      tags: ["real-run", "verifier", "quality-gate"],
    },
    {
      id: "work-run-retry-budget",
      level: "L1",
      title: "节点重试未超过预算",
      description: "每个节点的实际重试次数必须在 Task 声明的 max_retries 内。",
      invariants: ["retry_budget_respected"],
      tags: ["real-run", "recovery"],
    },
    {
      id: "work-run-recovery-quality",
      level: "L2",
      title: "首次与最终质量可计算",
      description: "从节点 Attempts 及 task.verified→evaluation.trigger_completed 序列分别计算重试、修复轮次和恢复成功。",
      invariants: ["final_quality_computable"],
      tags: ["real-run", "metric", "recovery"],
    },
    {
      id: "work-run-domain-result",
      level: "L3",
      title: "业务结果由领域 Suite 负责",
      description: "存在 domain-evaluation.json 时校验其身份、报告 hash 和真实结果；未注册时明确返回 not_applicable。",
      expected: "pass_or_not_applicable",
      invariants: ["domain_suite_explicit", "domain_report_bound", "required_domain_gate_enforced"],
      tags: ["real-run", "domain", "adapter-boundary"],
    },
  ];
  const cases = definitions.map((definition): EvalCase => ({
    schema: EVAL_CASE_SCHEMA,
    caseId: definition.id,
    suiteId: WORK_RUN_QUALITY_SUITE_ID,
    suiteVersion: WORK_RUN_QUALITY_SUITE_VERSION,
    level: definition.level,
    title: definition.title,
    description: definition.description,
    inputRefs: ["run://subject"],
    expected: { outcome: definition.expected ?? "pass", invariants: definition.invariants },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags: definition.tags,
    adapter: "work-harness",
  }));
  return {
    suite: {
      schema: EVAL_SUITE_SCHEMA,
      kind: "run_assessment",
      suiteId: WORK_RUN_QUALITY_SUITE_ID,
      suiteVersion: WORK_RUN_QUALITY_SUITE_VERSION,
      harnessId: "work-harness",
      levels: ["L1", "L2", "L3"],
      graderVersion: DETERMINISTIC_GRADER_VERSION,
      cases: cases.map((testCase) => testCase.caseId),
      thresholds: { qualityPassRate: 1 },
      adapter: "work-harness",
    },
    cases,
  };
}

export function evaluateWorkRunAssessmentCase(testCase: EvalCase, value: EvalSubject): AdapterEvaluation {
  const subject = requireWorkRunSubject(value);
  const facts = qualityFacts(subject.data);
  switch (testCase.caseId) {
    case "work-run-contract-integrity":
      return evaluated(testCase, facts.contractPassed ? "pass" : "block", subject.data.integrity.reasonCodes, {
        integrityValid: facts.contractPassed,
        integrityReasonCount: subject.data.integrity.reasonCodes.length,
        eventCount: subject.data.events.length,
      }, subject);
    case "work-run-dag-scope":
      return evaluated(testCase, facts.graphPassed ? "pass" : "block", facts.graphReasons, {
        nodeCount: subject.data.nodes.length,
        concurrentWriteConflicts: facts.concurrentWriteConflicts,
        graphReasonCount: facts.graphReasons.length,
      }, subject);
    case "work-run-node-closure":
      return evaluated(testCase, facts.closurePassed ? "pass" : "block", facts.closureReasons, {
        nodeCount: subject.data.nodes.length,
        completedNodes: facts.completedNodes,
        handoffNodes: facts.handoffNodes,
        closureReasonCount: facts.closureReasons.length,
      }, subject);
    case "work-run-verification-chain":
      return evaluated(testCase, facts.verificationPassed ? "pass" : "block", facts.verificationReasons, {
        verifierNodes: facts.verifierNodes,
        runCompleted: subject.data.state.status === "completed",
        summaryEvidenceCount: subject.data.summary.evidenceCount,
        summaryArtifactCount: subject.data.summary.artifactCount,
        verificationPassed: subject.data.verification.status === "passed",
      }, subject);
    case "work-run-retry-budget":
      return evaluated(testCase, facts.retryPassed ? "pass" : "block", facts.retryReasons, {
        retryRounds: facts.retryRounds,
        maxObservedRetries: facts.maxObservedRetries,
        maxRetries: subject.data.task.maxRetries,
      }, subject);
    case "work-run-recovery-quality":
      return evaluated(testCase, facts.finalPass ? "pass" : "block", facts.finalPass ? [] : ["final_acceptance_failed"], {
        firstPass: facts.firstPass,
        finalPass: facts.finalPass,
        retryRounds: facts.retryRounds,
        repairRounds: facts.repairRounds,
        recoverySucceeded: facts.recoverySucceeded,
      }, subject);
    case "work-run-domain-result":
      return domainEvaluation(subject);
    default:
      throw new Error(`Work Run Assessment does not support case ${testCase.caseId}`);
  }
}

function qualityFacts(data: WorkRunSubjectData): WorkQualityFacts {
  const graph = graphFacts(data.nodes, data.events);
  const closure = closureFacts(data.nodes);
  const verification = verificationFacts(data);
  const retry = retryFacts(data);
  const contractPassed = data.integrity.valid;
  const commonPassed = contractPassed && graph.passed && closure.passed && verification.passed && retry.passed;
  const currentOverallPassed = commonPassed && currentDomainPassed(data);
  const qualityAttempts = workQualityHistory(data.events, data.task.runId);
  const qualityOutcomes = qualityAttempts.map((attempt) => qualityAttemptPassed(attempt, currentOverallPassed));
  const repairRounds = qualityOutcomes.filter((passed) => !passed).length;
  const finalPass = currentOverallPassed && qualityOutcomes.length > 0 && qualityOutcomes.at(-1) === true;
  const firstPass = finalPass && repairRounds === 0;
  return {
    contractPassed,
    graphPassed: graph.passed,
    closurePassed: closure.passed,
    verificationPassed: verification.passed,
    retryPassed: retry.passed,
    finalPass,
    firstPass,
    recoverySucceeded: finalPass && repairRounds > 0,
    retryRounds: retry.retryRounds,
    repairRounds,
    maxObservedRetries: retry.maxObservedRetries,
    graphReasons: graph.reasons,
    closureReasons: closure.reasons,
    verificationReasons: verification.reasons,
    retryReasons: retry.reasons,
    verifierNodes: verification.verifierNodes,
    completedNodes: closure.completedNodes,
    handoffNodes: closure.handoffNodes,
    concurrentWriteConflicts: graph.concurrentWriteConflicts,
  };
}

function qualityAttemptPassed(attempt: WorkQualityAttempt, currentOverallPassed: boolean): boolean {
  if (attempt.verification.verdict !== "pass") return false;
  if (!attempt.trigger) return currentOverallPassed;
  return attempt.trigger.event === "evaluation.trigger_completed"
    && attempt.trigger.hardGatePassed === true
    && attempt.trigger.result === "pass";
}

function currentDomainPassed(data: WorkRunSubjectData): boolean {
  const domain = data.domainEvaluation;
  return !domain.registered || (domain.valid && domain.result === "pass" && domain.hardGatePassed);
}

function domainEvaluation(subject: WorkRunSubject): AdapterEvaluation {
  const domain = subject.data.domainEvaluation;
  if (!domain.registered) {
    return {
      observed: "not_applicable",
      passed: true,
      reasonCodes: [],
      metrics: { domain_registered: false, required: false },
      evidenceRefs: [`run://${subject.runId}/work/domain-evaluation`],
      artifactRefs: [],
      diagnosis: "subject",
    };
  }
  const metrics: AdapterEvaluation["metrics"] = {
    ...domain.metrics,
    domain_registered: true,
    required: domain.required,
    hard_gate_passed: domain.hardGatePassed,
    suite_id: domain.suiteId ?? "invalid",
    suite_version: domain.suiteVersion ?? "invalid",
    grader_version: domain.graderVersion ?? "invalid",
    domain_result: domain.result,
    evidence_count: domain.evidenceRefs.length,
    report_hash: domain.reportHash ?? "invalid",
  };
  const evidenceRefs = [
    `run://${subject.runId}/work/domain-evaluation`,
    ...domain.evidenceRefs.map((reference, index) => reference.startsWith("file://")
      ? `run://${subject.runId}/work/domain-evidence/${index + 1}`
      : reference),
  ];
  const artifactRefs = domain.reportHash
    ? [`artifact://work-harness/${subject.runId}/domain-report/${domain.reportHash}`]
    : [];
  if (!domain.valid) {
    return {
      observed: "blocked",
      passed: false,
      reasonCodes: domain.reasonCodes.length > 0 ? domain.reasonCodes : ["domain_evaluation_invalid"],
      metrics,
      evidenceRefs,
      artifactRefs,
      diagnosis: "subject",
    };
  }
  if (domain.result === "pass" && domain.hardGatePassed) {
    return { observed: "pass", passed: true, reasonCodes: [], metrics, evidenceRefs, artifactRefs, diagnosis: "subject" };
  }
  return {
    observed: "blocked",
    passed: false,
    reasonCodes: [domain.required ? "required_domain_evaluation_blocked" : "domain_evaluation_blocked"],
    metrics,
    evidenceRefs,
    artifactRefs,
    diagnosis: "subject",
  };
}

function graphFacts(nodes: WorkNodeSubject[], events: WorkRunSubjectData["events"]): { passed: boolean; reasons: string[]; concurrentWriteConflicts: number } {
  const reasons: string[] = [];
  if (nodes.length === 0) reasons.push("plan_node_missing");
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) reasons.push("node_id_duplicate");
    ids.add(node.id);
  }
  for (const node of nodes) {
    if (node.dependsOn.some((dependency) => !ids.has(dependency))) reasons.push("dag_dependency_missing");
    if (node.dependsOn.includes(node.id)) reasons.push("dag_self_dependency");
    if (node.kind !== "native-plan-step") {
      const reasonsSet = new Set(node.dispatchReasons);
      if (node.dispatchReasons.length === 0 || node.dispatchReasons.some((reason) => !ALL_DISPATCH_REASONS.has(reason))) reasons.push("dispatch_reason_invalid");
      const hard = [...reasonsSet].some((reason) => HARD_DISPATCH_REASONS.has(reason));
      const soft = [...reasonsSet].filter((reason) => SOFT_DISPATCH_REASONS.has(reason)).length;
      if (!hard && soft < 2) reasons.push("dispatch_reason_insufficient");
      if (node.postConditions.length === 0 || node.acceptance.length === 0) reasons.push("node_contract_incomplete");
    }
  }
  if (hasCycle(nodes)) reasons.push("dag_cycle");
  const concurrentWriteConflicts = countConcurrentWriteConflicts(nodes, events);
  if (concurrentWriteConflicts > 0) reasons.push("concurrent_write_scope_conflict");
  return { passed: reasons.length === 0, reasons: unique(reasons), concurrentWriteConflicts };
}

function closureFacts(nodes: WorkNodeSubject[]): { passed: boolean; reasons: string[]; completedNodes: number; handoffNodes: number } {
  const reasons: string[] = [];
  let completedNodes = 0;
  let handoffNodes = 0;
  for (const node of nodes) {
    if (node.status === "completed") completedNodes += 1;
    else reasons.push("node_not_completed");
    if (node.kind === "native-plan-step") continue;
    if (node.handoff.exists) handoffNodes += 1;
    else reasons.push("handoff_missing");
    if (node.handoff.exists && !node.handoff.valid) reasons.push("handoff_contract_invalid");
    if (node.handoff.status !== "completed") reasons.push("handoff_not_completed");
    if (node.handoff.evidenceCount + node.handoff.artifactCount === 0) reasons.push("handoff_evidence_missing");
    if (node.handoff.validationCount === 0) reasons.push("handoff_validation_missing");
    if (node.handoff.missingArtifactCount > 0) reasons.push("handoff_artifact_missing");
  }
  return { passed: nodes.length > 0 && reasons.length === 0, reasons: unique(reasons), completedNodes, handoffNodes };
}

function verificationFacts(data: WorkRunSubjectData): { passed: boolean; reasons: string[]; verifierNodes: number } {
  const reasons: string[] = [];
  const verifierNodes = data.nodes.filter((node) => node.kind === "verify" && node.status === "completed" && node.handoff.valid && node.handoff.status === "completed").length;
  if (data.state.status !== "completed") reasons.push("run_state_not_completed");
  if (data.summary.terminalStatus !== "completed") reasons.push("summary_terminal_not_completed");
  if (data.summary.verificationVerdict !== "pass") reasons.push("summary_verdict_not_passed");
  if (data.verification.status !== "passed") reasons.push("verification_not_passed");
  if (verifierNodes === 0) reasons.push("independent_verifier_missing");
  if (data.summary.evidenceCount === 0) reasons.push("summary_evidence_missing");
  if (data.summary.artifactCount === 0) reasons.push("summary_artifact_missing");
  if (data.summary.missingArtifactCount > 0 || data.summary.resolvedArtifactCount !== data.summary.artifactCount) reasons.push("summary_artifact_unresolved");
  return { passed: reasons.length === 0, reasons: unique(reasons), verifierNodes };
}

function retryFacts(data: WorkRunSubjectData): { passed: boolean; reasons: string[]; retryRounds: number; maxObservedRetries: number } {
  const retries = Object.values(data.state.attempts).map((attempts) => Math.max(attempts - 1, 0));
  const retryRounds = retries.reduce((total, value) => total + value, 0);
  const maxObservedRetries = retries.length > 0 ? Math.max(...retries) : 0;
  const passed = data.task.maxRetries >= 0 && maxObservedRetries <= data.task.maxRetries;
  return { passed, reasons: passed ? [] : ["retry_budget_exceeded"], retryRounds, maxObservedRetries };
}

function hasCycle(nodes: WorkNodeSubject[]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const dependency of dependencies.get(nodeId) ?? []) if (dependencies.has(dependency) && visit(dependency)) return true;
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

function countConcurrentWriteConflicts(nodes: WorkNodeSubject[], events: WorkRunSubjectData["events"]): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const active = new Set<string>();
  let conflicts = 0;
  for (const event of events) {
    if (!event.nodeId) continue;
    if (event.event === "node.started") {
      const node = byId.get(event.nodeId);
      if (node) for (const activeId of active) {
        const running = byId.get(activeId);
        if (running && scopesOverlap(node.writeScope, running.writeScope)) conflicts += 1;
      }
      active.add(event.nodeId);
    }
    if (event.event === "node.handoff_recorded" || event.event === "node.stale_recovered") active.delete(event.nodeId);
  }
  return conflicts;
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftScope) => right.some((rightScope) => canonicalScopesOverlap(
    canonicalScope(leftScope),
    canonicalScope(rightScope),
  )));
}

function canonicalScopesOverlap(left: CanonicalScope, right: CanonicalScope): boolean {
  if (left.root !== right.root) return false;
  const insensitive = left.caseInsensitive || right.caseInsensitive;
  const sharedLength = Math.min(left.segments.length, right.segments.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftSegment = insensitive ? left.segments[index].toLowerCase() : left.segments[index];
    const rightSegment = insensitive ? right.segments[index].toLowerCase() : right.segments[index];
    if (leftSegment !== rightSegment) return false;
  }
  return true;
}

function canonicalScope(value: string): CanonicalScope {
  const raw = value.trim();
  const windows = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw);
  const normalized = windows ? raw.replace(/\\/g, "/") : raw;
  let root = "relative";
  let remainder = normalized;
  let absolute = false;

  const driveAbsolute = /^([A-Za-z]):\/+/.exec(normalized);
  if (driveAbsolute) {
    root = `windows-drive:${driveAbsolute[1].toLowerCase()}`;
    remainder = normalized.slice(driveAbsolute[0].length);
    absolute = true;
  } else if (windows && normalized.startsWith("//")) {
    const parts = normalized.replace(/^\/+/, "").split(/\/+/);
    const server = parts.shift() ?? "";
    const share = parts.shift() ?? "";
    root = `windows-unc:${server.toLowerCase()}/${share.toLowerCase()}`;
    remainder = parts.join("/");
    absolute = true;
  } else {
    if (normalized.startsWith("/")) {
      root = "posix-root";
      remainder = normalized.replace(/^\/+/, "");
      absolute = true;
    }
  }

  const segments: string[] = [];
  for (const segment of remainder.split(/\/+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return { root, segments, caseInsensitive: windows };
}

function evaluated(testCase: EvalCase, observed: string, reasonCodes: string[], metrics: AdapterEvaluation["metrics"], subject: WorkRunSubject): AdapterEvaluation {
  const passed = observed === testCase.expected.outcome;
  return {
    observed,
    passed,
    reasonCodes: passed ? [] : unique(reasonCodes.length > 0 ? reasonCodes : ["work_run_assessment_failed"]),
    metrics,
    evidenceRefs: [`run://${subject.runId}/work/subject`, `run://${subject.runId}/work/${testCase.caseId}`],
    artifactRefs: [`artifact://work-harness/${subject.runId}/run-summary`, `artifact://work-harness/${subject.runId}/verification`],
    diagnosis: "subject",
  };
}

function requireWorkRunSubject(value: EvalSubject): WorkRunSubject {
  if (value.adapter !== "work-harness" || !value.runId || !value.subjectHash || value.subjectVersion !== WORK_RUN_SUBJECT_VERSION) throw new Error("Work Run Assessment requires a real WorkRunSubject");
  return value as WorkRunSubject;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
