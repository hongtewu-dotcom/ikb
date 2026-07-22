import type { AgentRoleId } from "./roles.ts";

export type LoopId = "inner" | "mid" | "outer";
export type LoopImplementation = "partial" | "planned";

export interface LoopDataRequirement {
  key: string;
  required: boolean;
  source: string;
  description: string;
}

export interface LoopContract {
  id: LoopId;
  name: string;
  purpose: string;
  trigger: string;
  ownerRole: AgentRoleId;
  participants: AgentRoleId[];
  gates: string[];
  inputs: LoopDataRequirement[];
  outputs: LoopDataRequirement[];
  evidence: string[];
  implementation: LoopImplementation;
}

const LOOP_CONTRACTS: readonly LoopContract[] = [
  {
    id: "inner",
    name: "知识收敛",
    purpose: "把有边界的 Source 和分析结果收敛为可引用的 Knowledge draft/verified。",
    trigger: "一组 Source 需要分析，或已有 Knowledge 需要复核、冲突处理和关系维护。",
    ownerRole: "ikb-harness",
    participants: ["ikb-intake", "ikb-analyst", "ikb-curator", "ikb-verifier"],
    gates: ["G0", "G1", "G2", "G3"],
    inputs: [
      requirement("source_refs", true, "ikb-data/sources/<source-id>/{source.json,raw,records.jsonl}", "待分析的原始来源和标准化记录 ID。"),
      requirement("analysis_question", true, "Task.goal/acceptance 或分析请求 Artifact", "要解释的问题和预期用途。"),
      requirement("scope_sensitivity", true, "Source.source.json、Task 和 Knowledge frontmatter", "personal/work 范围及敏感等级。"),
      requirement("time_or_revision_window", true, "Source 元数据、history --from/--to 或文档 revision", "分析边界，禁止无边界扩张。"),
      requirement("identity_or_subject", false, "people/key-people.json、Source participants 或 Task", "人物、项目、文档或主题的明确身份。"),
      requirement("existing_knowledge", false, "ikb-data/vaults/<scope> 与 governance", "相关 verified/draft、冲突和待复核条目。"),
    ],
    outputs: [
      requirement("analysis_artifact", true, "ikb-data/runs/<run-id>/artifacts/", "可重放的分析报告，而不是只存在于 prompt 的结论。"),
      requirement("evidence_refs", true, "Analysis Artifact + Source record IDs", "每个 finding/candidate 的来源定位。"),
      requirement("findings_unknowns_conflicts", true, "Analysis Artifact", "事实、推断、未知项和冲突必须分开记录，可为空但字段不能省略。"),
      requirement("candidate_knowledge", true, "Analysis Artifact → Knowledge draft", "候选知识、建议 type/collection 和下一步。"),
      requirement("gate_results", true, "Run events / GateResult", "G0～G3 的通过、阻断和原因。"),
    ],
    evidence: ["Source raw/records hash", "source.ingested/source.incremental_scan/source.context_built events", "Knowledge source_refs", "analysis Artifact"],
    implementation: "partial",
  },
  {
    id: "mid",
    name: "任务执行",
    purpose: "让一个 Task 通过角色节点完成一次可恢复、可验收的 Run。",
    trigger: "Task 已创建并具备目标、验收条件，需要执行或恢复。",
    ownerRole: "ikb-harness",
    participants: ["ikb-intake", "ikb-analyst", "ikb-curator", "ikb-operator", "ikb-verifier"],
    gates: ["G0", "G4", "G5", "G6"],
    inputs: [
      requirement("task_contract", true, "ikb-data/ledger/events.jsonl → task.created/task.updated", "Task 的 goal、acceptance、type、scope、risk。"),
      requirement("role_and_skill_manifest", true, "src/roles.ts / Agent manifest", "允许的角色、Task 类型和 Skill 白名单。"),
      requirement("context_pack", true, "ikb-data/runs/<run-id>/context-pack.md", "实际交给执行角色的知识和来源上下文。"),
      requirement("plan_and_checkpoint", true, "ikb-data/runs/<run-id>/plan.json 与 Run events", "步骤、当前 checkpoint 和恢复入口。"),
      requirement("prior_run_feedback", false, "retryOf、历史 Run events、Artifact", "重试或回退时使用的失败原因和已有产物。"),
    ],
    outputs: [
      requirement("handoff_events", true, "Run events / ledger", "角色之间的输入引用、输出引用和 gate 状态。"),
      requirement("run_artifacts", true, "ikb-data/runs/<run-id>/artifacts/ + artifact.created", "草稿、diff、测试、报告和验证证据。"),
      requirement("approval_record", true, "Approval events", "L3/L4 动作的准确目标、参数 hash 和人工决定；无副作用时记录 not-needed。"),
      requirement("verification_result", true, "verification Artifact + run verification.json", "验收通过或阻断及理由。"),
      requirement("knowledge_references", true, "context pack + knowledge.referenced events", "实际使用的 Knowledge 及支持的判断。"),
      requirement("gate_results", true, "Run events / GateResult", "G4～G6 的通过、阻断和恢复原因。"),
    ],
    evidence: ["Task/Run/Approval/Artifact events", "run input/plan/context/events/verification files", "artifact content hash", "test and verifier results"],
    implementation: "partial",
  },
  {
    id: "outer",
    name: "跨任务进化",
    purpose: "从多个已结束 Run 中发现重复失败、知识缺口、Skill 低效和可复用新模式。",
    trigger: "达到复盘周期，或失败/阻断模式达到阈值，需要提出流程改进。",
    ownerRole: "ikb-harness",
    participants: ["ikb-harness", "ikb-analyst", "ikb-verifier"],
    gates: ["G1", "G2", "G5", "G6"],
    inputs: [
      requirement("review_window", true, "Harness review request / report period", "复盘的时间窗口、Task type 和 scope。"),
      requirement("completed_runs", true, "ledger events + ikb-data/runs/<run-id>/", "窗口内成功、失败、取消和阻断的 Run 集合。"),
      requirement("gate_and_failure_events", true, "Run/Approval/GateResult events", "失败原因、门禁阻断、恢复次数和 Approval 决策。"),
      requirement("artifact_outcomes", true, "Artifact hashes、verification、Task acceptance", "产物是否被接受、修改或退回。"),
      requirement("knowledge_usage", true, "knowledge.referenced + Context Pack + Knowledge revisions", "哪些知识帮助了任务，哪些知识缺失或错误。"),
      requirement("previous_proposals", false, "governance/reviews、Plan Pack、改进 Task", "避免重复提出无效规则。"),
    ],
    outputs: [
      requirement("harness_review", true, "ikb-data/reports/ 或 runs/<run-id>/artifacts/", "带统计窗口和证据引用的复盘报告。"),
      requirement("pattern_candidates", true, "Harness Review", "重复失败、瓶颈、知识缺口和可复用新模式。"),
      requirement("improvement_proposals", true, "governance/ 与 Plan Pack candidate", "Skill、门禁、Context Builder 或流程的改进建议。"),
      requirement("follow_up_task_or_plan", true, "Task/Plan Pack + Approval", "可执行的改进 Task；高影响改动不能直接应用。"),
      requirement("gate_results", true, "Harness Review / ledger", "G1/G2/G5/G6 以及人工批准状态。"),
    ],
    evidence: ["run/ledger summaries", "Artifact and verifier outcomes", "Approval decisions", "Knowledge references and revisions", "previous improvement Tasks"],
    implementation: "planned",
  },
];

export function listLoops(): LoopContract[] {
  return LOOP_CONTRACTS.map(cloneLoop);
}

export function findLoop(id: string): LoopContract | null {
  const loop = LOOP_CONTRACTS.find((item) => item.id === id);
  return loop ? cloneLoop(loop) : null;
}

function requirement(key: string, required: boolean, source: string, description: string): LoopDataRequirement {
  return { key, required, source, description };
}

function cloneLoop(loop: LoopContract): LoopContract {
  return {
    ...loop,
    participants: [...loop.participants],
    gates: [...loop.gates],
    inputs: loop.inputs.map((item) => ({ ...item })),
    outputs: loop.outputs.map((item) => ({ ...item })),
    evidence: [...loop.evidence],
  };
}
