export type GateImplementation = "hard" | "partial" | "planned";

export interface GateDefinition {
  id: "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
  name: string;
  description: string;
  implementation: GateImplementation;
  currentCheck: string;
}

export const GATE_DEFINITIONS: readonly GateDefinition[] = [
  {
    id: "G0",
    name: "边界与授权",
    description: "scope、sensitivity、身份、时间范围和连接器权限不越界。",
    implementation: "partial",
    currentCheck: "Source/Knowledge scope 值校验；连接器使用既有登录态；统一授权策略待补。",
  },
  {
    id: "G1",
    name: "存证与完整性",
    description: "原文、标准化记录、来源元数据、hash 和事件账本可互相校验。",
    implementation: "hard",
    currentCheck: "Source integrity、hash、路径、软链接、记录数量和 doctor 检查。",
  },
  {
    id: "G2",
    name: "证据充分性",
    description: "分析结论能回到 Source record、文档版本、评论位置、Artifact 或人工确认。",
    implementation: "partial",
    currentCheck: "Source refs 和 Skill 输出契约已支持；最少/独立证据数尚未强制。",
  },
  {
    id: "G3",
    name: "知识准入",
    description: "每个分析结果明确 admit 或 skip；只有满足来源、适用范围和边界契约的内容才能写入 Knowledge。",
    implementation: "partial",
    currentCheck: "落盘前质量门禁、knowledge lint/doctor、无知识 rejected Candidate 和 verified source_refs 已硬校验；语义价值、重复与冲突仍由 Curator/人工判断。",
  },
  {
    id: "G4",
    name: "执行准备",
    description: "Task 目标/验收、Run、Context Pack、Agent/Skill 白名单齐全。",
    implementation: "partial",
    currentCheck: "Task 创建要求 goal/acceptance；角色和 Skill 白名单由本次 manifest 校验接入。",
  },
  {
    id: "G5",
    name: "副作用审批",
    description: "push、CR 评论、ONES 更新、大象发送等动作必须绑定准确 Approval。",
    implementation: "partial",
    currentCheck: "Approval 等待期间不能成功；外部 Action Gateway 和高风险自动触发待补。",
  },
  {
    id: "G6",
    name: "验收与闭环",
    description: "Artifact、测试/验证结果、状态事件、失败原因和下一步均可追溯。",
    implementation: "partial",
    currentCheck: "Artifact、Run 目录和事件账本已记录；新知识消费契约下，未完成效果分类的引用会阻止 Run 成功收口；统一 verifier 的其他完成条件仍待补。",
  },
];

export function findGate(id: string): GateDefinition | null {
  return GATE_DEFINITIONS.find((gate) => gate.id === id) ?? null;
}

export function listGates(): GateDefinition[] {
  return GATE_DEFINITIONS.map((gate) => ({ ...gate }));
}
