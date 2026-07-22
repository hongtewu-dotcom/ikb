export type AgentRoleId =
  | "ikb-harness"
  | "ikb-intake"
  | "ikb-analyst"
  | "ikb-curator"
  | "ikb-operator"
  | "ikb-verifier";

export type SideEffectLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export interface AgentManifest {
  id: AgentRoleId;
  name: string;
  description: string;
  accepts: string[];
  skills: string[];
  gates: string[];
  read: string[];
  write: string[];
  maxSideEffect: SideEffectLevel;
}

const ROLE_MANIFESTS: readonly AgentManifest[] = [
  {
    id: "ikb-harness",
    name: "任务总管",
    description: "执行编排、单次 Run 复盘、跨 Task 模式发现、改进建议，以及 Context Pack、Approval 和恢复流程。",
    accepts: ["general", "*"],
    skills: ["task-plan", "context-build", "approval-request", "run-recovery", "maintenance"],
    gates: ["G0", "G4", "G5", "G6"],
    read: ["task", "run", "source", "knowledge", "artifact", "approval"],
    write: ["task", "run", "ledger", "approval"],
    maxSideEffect: "L2",
  },
  {
    id: "ikb-intake",
    name: "资料采集员",
    description: "采集大象、Agent 会话、学城、文档和评论，保存可重放的 Source。",
    accepts: ["intake", "source", "research", "document", "review_comment", "ai_conversation", "elephant"],
    skills: ["ikb-source-intake"],
    gates: ["G0", "G1"],
    read: ["external-source", "connector"],
    write: ["source", "ledger"],
    maxSideEffect: "L1",
  },
  {
    id: "ikb-analyst",
    name: "证据分析员",
    description: "从 Source 中提取事实、决策、人物、冲突、缺口和未知项。",
    accepts: ["analysis", "research", "person", "document", "review", "cr", "communication", "general"],
    skills: ["ikb-conversation-analysis"],
    gates: ["G1", "G2"],
    read: ["source", "knowledge", "task", "run"],
    write: ["artifact", "ledger"],
    maxSideEffect: "L1",
  },
  {
    id: "ikb-curator",
    name: "知识策展员",
    description: "将有证据的分析整理成 Obsidian draft，维护来源、关系和复核项。",
    accepts: ["knowledge", "curation", "research", "document", "review", "general"],
    skills: ["ikb-knowledge-curator"],
    gates: ["G2", "G3"],
    read: ["source", "knowledge", "artifact", "task", "run"],
    write: ["knowledge:draft", "governance", "artifact", "ledger"],
    maxSideEffect: "L1",
  },
  {
    id: "ikb-operator",
    name: "工作执行员",
    description: "执行编码、评审、CR、文档、沟通草稿和向上管理等工作 Skill。",
    accepts: ["coding", "review", "cr", "document", "communication", "upward-management", "general"],
    skills: ["coding", "review", "cr", "document", "elephant-draft", "upward-management"],
    gates: ["G4", "G5", "G6"],
    read: ["task", "run", "source", "knowledge", "artifact"],
    write: ["workspace", "artifact", "ledger", "draft"],
    maxSideEffect: "L2",
  },
  {
    id: "ikb-verifier",
    name: "验收审计员",
    description: "检查事实、测试、风险、隐私、完整性和验收条件，输出通过或阻断。",
    accepts: ["verification", "coding", "review", "cr", "document", "communication", "general"],
    skills: ["ikb-verification"],
    gates: ["G1", "G2", "G3", "G6"],
    read: ["task", "run", "source", "knowledge", "artifact", "approval"],
    write: ["artifact", "ledger", "verification"],
    maxSideEffect: "L1",
  },
];

const AGENT_ALIASES: Record<string, AgentRoleId> = {
  manual: "ikb-operator",
  operator: "ikb-operator",
  document: "ikb-operator",
  "document-agent": "ikb-operator",
};

const SKILL_ALIASES: Record<string, string> = {
  draft: "document",
  "document-agent": "document",
};

export function canonicalAgentId(agentId: string): string {
  return AGENT_ALIASES[agentId] ?? agentId;
}

export function canonicalSkillId(skillId: string): string {
  return SKILL_ALIASES[skillId] ?? skillId;
}

export function listAgentRoles(): AgentManifest[] {
  return ROLE_MANIFESTS.map(cloneManifest);
}

export function findAgentRole(agentId: string | undefined): AgentManifest | null {
  if (!agentId) return null;
  const canonicalId = canonicalAgentId(agentId);
  const role = ROLE_MANIFESTS.find((item) => item.id === canonicalId);
  return role ? cloneManifest(role) : null;
}

export function validateAgentInvocation(agentId: string, skillIds: string[] = [], taskType?: string): { ok: boolean; agentId: string; role: AgentManifest | null; skills: string[]; issues: string[] } {
  const canonicalId = canonicalAgentId(agentId);
  const role = findAgentRole(canonicalId);
  const skills = skillIds.map((skill) => canonicalSkillId(skill.trim())).filter(Boolean);
  if (!role) {
    return { ok: false, agentId: canonicalId, role: null, skills, issues: [`Unknown Agent role: ${agentId}`] };
  }
  const allowed = new Set(role.skills);
  const issues = skills
    .filter((skill) => !allowed.has(skill))
    .map((skill) => `Skill ${skill} is not allowed for ${role.id}`);
  if (taskType && !role.accepts.includes("*") && !role.accepts.includes(taskType)) {
    issues.push(`Agent role ${role.id} does not accept Task type ${taskType}`);
  }
  return { ok: issues.length === 0, agentId: role.id, role, skills, issues };
}

function cloneManifest(role: AgentManifest): AgentManifest {
  return {
    ...role,
    accepts: [...role.accepts],
    skills: [...role.skills],
    gates: [...role.gates],
    read: [...role.read],
    write: [...role.write],
  };
}
