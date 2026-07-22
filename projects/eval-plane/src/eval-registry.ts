import { harnessEvaluationCases } from "./harness-eval.ts";
import { assertUniqueSuiteKey, DETERMINISTIC_GRADER_VERSION, EVAL_CASE_SCHEMA, EVAL_SUITE_SCHEMA, type EvalCase, type EvalSuite, validateEvalCase, validateEvalSuite } from "./eval-contract.ts";
import { runAssessmentSuite } from "./run-assessment.ts";
import { workRunAssessmentSuite } from "./work-run-assessment.ts";

export class EvalRegistry {
  private readonly suites = new Map<string, { suite: EvalSuite; cases: Map<string, EvalCase> }>();

  register(suiteValue: EvalSuite, cases: EvalCase[]): EvalSuite {
    const suite = validateEvalSuite(suiteValue);
    assertUniqueSuiteKey(suite, [...this.suites.values()].map((item) => item.suite));
    const caseMap = new Map<string, EvalCase>();
    for (const caseValue of cases) {
      const testCase = validateEvalCase(caseValue);
      if (testCase.suiteId !== suite.suiteId || testCase.suiteVersion !== suite.suiteVersion) throw new Error(`EvalCase ${testCase.caseId} does not belong to ${suite.suiteId}@${suite.suiteVersion}`);
      if (caseMap.has(testCase.caseId)) throw new Error(`EvalCase already registered in suite: ${testCase.caseId}`);
      caseMap.set(testCase.caseId, testCase);
    }
    for (const caseId of suite.cases) if (!caseMap.has(caseId)) throw new Error(`EvalSuite references missing EvalCase: ${caseId}`);
    this.suites.set(`${suite.suiteId}@${suite.suiteVersion}`, { suite, cases: caseMap });
    return suite;
  }

  listSuites(): EvalSuite[] {
    return [...this.suites.values()].map((item) => item.suite);
  }

  getSuite(suiteId: string, suiteVersion?: string): EvalSuite {
    const matches = this.listSuites().filter((suite) => suite.suiteId === suiteId && (!suiteVersion || suite.suiteVersion === suiteVersion));
    if (matches.length === 0) throw new Error(`EvalSuite not found: ${suiteId}${suiteVersion ? `@${suiteVersion}` : ""}`);
    matches.sort((left, right) => right.suiteVersion.localeCompare(left.suiteVersion));
    return matches[0];
  }

  getCases(suiteId: string, suiteVersion?: string): EvalCase[] {
    const suite = this.getSuite(suiteId, suiteVersion);
    return [...this.suites.get(`${suite.suiteId}@${suite.suiteVersion}`)!.cases.values()];
  }

  getCase(caseId: string, suiteId?: string, suiteVersion?: string): EvalCase {
    const suites = this.listSuites().filter((suite) => (!suiteId || suite.suiteId === suiteId) && (!suiteVersion || suite.suiteVersion === suiteVersion));
    for (const suite of suites) {
      const item = this.suites.get(`${suite.suiteId}@${suite.suiteVersion}`)!.cases.get(caseId);
      if (item) return item;
    }
    throw new Error(`EvalCase not found: ${caseId}`);
  }
}

function legacyCase(testCase: ReturnType<typeof harnessEvaluationCases>[number], suiteId: string, level: "L1" | "L2" | "L3"): EvalCase {
  return {
    schema: EVAL_CASE_SCHEMA,
    caseId: testCase.caseId,
    suiteId,
    suiteVersion: "v1",
    level,
    title: testCase.title,
    description: testCase.description,
    inputRefs: [`case://${testCase.caseId}`],
    expected: { outcome: testCase.expected, invariants: [] },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags: [testCase.category, testCase.expected === "block" ? "negative" : "positive"],
    adapter: "ikb",
    legacyCaseId: testCase.caseId,
  };
}

function fixtureCase(caseId: string, suiteId: string, level: "L1" | "L2" | "L3", title: string, description: string, adapter: "work-harness" | "specx" | "pipeline", fixture: string, expected: string, tags: string[] = []): EvalCase {
  return {
    schema: EVAL_CASE_SCHEMA,
    caseId,
    suiteId,
    suiteVersion: "v1",
    level,
    title,
    description,
    inputRefs: [`fixture://${fixture}`],
    expected: { outcome: expected, invariants: [] },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags,
    adapter,
  };
}

function registerLegacySuites(registry: EvalRegistry): void {
  const cases = harnessEvaluationCases();
  const byId = new Map(cases.map((item) => [item.caseId, item]));
  const register = (suiteId: string, harnessId: string, levels: ("L1" | "L2" | "L3")[], caseIds: string[], level: "L1" | "L2" | "L3") => {
    const suiteCases = caseIds.map((caseId) => legacyCase(byId.get(caseId)!, suiteId, level));
    registry.register({ schema: EVAL_SUITE_SCHEMA, kind: "regression", suiteId, suiteVersion: "v1", harnessId, levels, graderVersion: DETERMINISTIC_GRADER_VERSION, cases: caseIds, thresholds: {}, adapter: "ikb" }, suiteCases);
  };
  register("ikb-admission-knowledge", "ikb", ["L1"], ["I1-admit-with-contract", "I2-explicit-skip", "I3-admit-missing-evidence", "I4-scope-mismatch"], "L1");
  register("ikb-mid-run-quality", "ikb", ["L1"], ["M1-quality-needs-verifier", "M2-terminal-success-is-not-quality"], "L1");
  register("ikb-approval-recovery-security", "ikb", ["L1"], ["M3-approved-side-effect", "M4-mismatched-approval-blocks-action", "R1-idempotent-retry", "R2-conflicting-retry-blocks", "O2-mixed-failures-no-proposal"], "L1");
  register("ikb-outer-loop", "ikb", ["L2"], ["O1-failure-cluster-proposal"], "L2");
}

function registerExternalSuites(registry: EvalRegistry): void {
  const workSuite = "work-protocol";
  const workCases = [
    fixtureCase("work-missing-dispatch-reason", workSuite, "L1", "微任务必须有合法 dispatch reason", "没有独立调度理由的节点必须阻断。", "work-harness", "work-harness/missing-dispatch-reason.json", "block", ["negative", "quality-gate"]),
    fixtureCase("work-missing-acceptance", workSuite, "L1", "节点必须有 post-condition 和 acceptance", "缺少验收合同的节点必须阻断。", "work-harness", "work-harness/missing-acceptance.json", "block", ["negative", "quality-gate"]),
    fixtureCase("work-invalid-dag", workSuite, "L1", "DAG 依赖必须存在", "依赖不存在的计划必须阻断。", "work-harness", "work-harness/invalid-dag.json", "block", ["negative", "dag"]),
    fixtureCase("work-write-conflict", workSuite, "L1", "并行波次不能有写入冲突", "同一写入范围不得并行执行。", "work-harness", "work-harness/write-conflict.json", "block", ["negative", "side-effect"]),
    fixtureCase("work-incomplete-handoff", workSuite, "L1", "Handoff 必须完整", "交接必须包含来源、目标和输出引用。", "work-harness", "work-harness/incomplete-handoff.json", "block", ["negative", "handoff"]),
    fixtureCase("work-missing-verifier", workSuite, "L1", "没有 Verifier 不得质量通过", "terminal success 不能替代独立验收。", "work-harness", "work-harness/missing-verifier.json", "block", ["negative", "quality-gate"]),
    fixtureCase("work-retry-budget", workSuite, "L1", "重试不得超过预算", "超过 retry budget 必须阻断。", "work-harness", "work-harness/retry-budget.json", "block", ["negative", "recovery"]),
    fixtureCase("work-conflicting-side-effect", workSuite, "L1", "同一副作用身份不得冲突", "相同 action 身份不能携带不同 target/payload hash。", "work-harness", "work-harness/conflicting-side-effect.json", "block", ["negative", "idempotency"]),
    fixtureCase("work-quality-summary", workSuite, "L2", "Work Harness 质量摘要可计算", "从 run summary 计算首次通过、最终通过和修复轮次。", "work-harness", "work-harness/quality-summary.json", "pass", ["metric"]),
  ];
  registry.register({ schema: EVAL_SUITE_SCHEMA, kind: "regression", suiteId: workSuite, suiteVersion: "v1", harnessId: "work-harness", levels: ["L1", "L2"], graderVersion: DETERMINISTIC_GRADER_VERSION, cases: workCases.map((item) => item.caseId), thresholds: { assertionValidRate: 0.8 }, adapter: "work-harness" }, workCases);

  const specxSuite = "specx-ac";
  const specxCase = fixtureCase("specx-ac-coverage", specxSuite, "L3", "SpecX AC 与产物一致", "读取既有产物计算 AC 覆盖率、代码测试一致性和新鲜度。", "specx", "specx/valid-change.json", "pass", ["specx", "ac"]);
  registry.register({ schema: EVAL_SUITE_SCHEMA, kind: "regression", suiteId: specxSuite, suiteVersion: "v1", harnessId: "specx", levels: ["L3"], graderVersion: DETERMINISTIC_GRADER_VERSION, cases: [specxCase.caseId], thresholds: { acCoverage: 0.8 }, adapter: "specx" }, [specxCase]);

  const pipelineSuite = "pipeline-contract";
  const pipelineCase = fixtureCase("pipeline-cleanup-idempotency", pipelineSuite, "L3", "测试流水线执行、断言与清理可追溯", "从 CaseSpec、执行结果、日志验证和清理结果计算领域指标。", "pipeline", "pipeline/valid-run.json", "pass", ["pipeline", "cleanup"]);
  registry.register({ schema: EVAL_SUITE_SCHEMA, kind: "regression", suiteId: pipelineSuite, suiteVersion: "v1", harnessId: "pipeline", levels: ["L3"], graderVersion: DETERMINISTIC_GRADER_VERSION, cases: [pipelineCase.caseId], thresholds: { assertionValidRate: 0.8 }, adapter: "pipeline" }, [pipelineCase]);
}

export function createDefaultEvalRegistry(): EvalRegistry {
  const registry = new EvalRegistry();
  registerLegacySuites(registry);
  registerExternalSuites(registry);
  const assessment = runAssessmentSuite();
  registry.register(assessment.suite, assessment.cases);
  const workAssessment = workRunAssessmentSuite();
  registry.register(workAssessment.suite, workAssessment.cases);
  return registry;
}
