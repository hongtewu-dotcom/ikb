import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCandidates } from "./candidates.ts";
import { listKnowledge } from "./knowledge.ts";
import { listSources } from "./source.ts";
import { listExperienceRecords, type ExperienceRecord } from "./experience.ts";
import type { LedgerStore } from "./store.ts";
import type { KnowledgeRecord, SourceRecord } from "./types.ts";

/**
 * Global reasoning is a deterministic compression layer between evidence and
 * human decisions.  It does not invent claims from raw text and never changes
 * Knowledge lifecycle state; it explains which existing draft questions can
 * be handled by an IKB rule, which need a future task, and which truly need a
 * human decision.
 */
export const REASONING_VERSION = "ikb-reasoning.v1";

export type ReasoningDisposition = "auto_resolved" | "defer_until_task" | "ask_user";
export type ReasoningCategory = "boundary" | "evidence" | "person" | "policy" | "sensitivity" | "unknown";

export interface ReasoningQuestion {
  id: string;
  knowledgeId: string;
  knowledgeTitle: string;
  collection: string;
  number: number;
  text: string;
  category: ReasoningCategory;
  disposition: ReasoningDisposition;
  risk: "low" | "medium" | "high";
  rationale: string;
  nextAction: string;
  sourceRefs: string[];
}

export interface ReasoningDecisionBundle {
  id: string;
  category: ReasoningCategory;
  title: string;
  questionIds: string[];
  itemCount: number;
  decision: string;
  consequence: string;
}

export interface ReasoningFinding {
  id: string;
  title: string;
  conclusion: string;
  confidence: "high" | "medium";
  evidenceRefs: string[];
}

export interface ReasoningReport {
  schema: typeof REASONING_VERSION;
  id: string;
  scope: "personal" | "work";
  generatedAt: string;
  inputFingerprint: string;
  inputs: {
    sources: number;
    sourceKinds: Record<string, number>;
    sourceAdapters: Record<string, number>;
    experiences: number;
    experienceStatus: Record<string, number>;
    experienceSignals: Record<string, number>;
    candidates: number;
    candidateStatus: Record<string, number>;
    knowledgeTotal: number;
    knowledgeActive: number;
    knowledgeDraft: number;
    knowledgeVerified: number;
    knowledgeRetired: number;
    activeDraftQuestions: number;
  };
  findings: ReasoningFinding[];
  summary: {
    questionsExtracted: number;
    autoResolved: number;
    deferred: number;
    askUser: number;
    immediateConfirmationRequired: boolean;
    note: string;
  };
  autoResolved: ReasoningQuestion[];
  deferred: ReasoningQuestion[];
  userDecisionQueue: ReasoningQuestion[];
  decisionBundles: ReasoningDecisionBundle[];
  paths: {
    json: string;
    markdown: string;
  };
}

export interface ReasoningOptions {
  scope?: "personal" | "work";
  now?: Date;
}

export function runReasoning(home: string, store: LedgerStore, options: ReasoningOptions = {}): ReasoningReport {
  const scope = options.scope ?? "work";
  const now = options.now ?? new Date();
  const sources = listSources(home).filter((source) => source.scope === scope);
  const activeSourceIds = new Set(sources.map((source) => source.id));
  const experiences = listExperienceRecords(home, scope).filter((record) => record.sourceIds.length === 0 || record.sourceIds.every((sourceId) => activeSourceIds.has(sourceId)));
  const candidates = listCandidates(home).filter((candidate) => candidate.scope === scope && (candidate.origin.sourceIds.length === 0 || candidate.origin.sourceIds.every((sourceId) => activeSourceIds.has(sourceId))));
  const knowledge = listKnowledge(home, scope);
  const activeKnowledge = knowledge.filter((record) => record.status !== "retired");
  const draftQuestions = activeKnowledge.flatMap(extractQuestions);
  const classified = draftQuestions.map(classifyQuestion);
  const inputFingerprint = sha256(JSON.stringify({
    scope,
    sources: sources.map((source) => [source.id, source.contentHash, source.recordsHash ?? null]),
    experiences: experiences.map((record) => [record.id, record.updatedAt, record.status, record.signalCodes]),
    candidates: candidates.map((candidate) => [candidate.id, candidate.revision, candidate.status]),
    knowledge: activeKnowledge.map((record) => [record.id, record.status, record.path, sha256(record.body)]),
    questions: classified.map((question) => [question.id, question.disposition, question.category]),
  }));
  const reportId = `reason-${inputFingerprint.slice(0, 12)}`;
  const root = reasoningRoot(home, scope);
  ensureDirectory(root);
  const jsonPath = join(root, `${reportId}.json`);
  const markdownPath = join(root, `${reportId}.md`);
  const report: ReasoningReport = {
    schema: REASONING_VERSION,
    id: reportId,
    scope,
    generatedAt: now.toISOString(),
    inputFingerprint,
    inputs: {
      sources: sources.length,
      sourceKinds: countBy(sources, (source) => source.kind),
      sourceAdapters: countBy(sources, (source) => source.adapter ?? "unknown"),
      experiences: experiences.length,
      experienceStatus: countBy(experiences, (record) => record.status),
      experienceSignals: countSignals(experiences),
      candidates: candidates.length,
      candidateStatus: countBy(candidates, (candidate) => candidate.status),
      knowledgeTotal: knowledge.length,
      knowledgeActive: activeKnowledge.length,
      knowledgeDraft: activeKnowledge.filter((record) => record.status === "draft").length,
      knowledgeVerified: activeKnowledge.filter((record) => record.status === "verified").length,
      knowledgeRetired: knowledge.filter((record) => record.status === "retired").length,
      activeDraftQuestions: draftQuestions.length,
    },
    findings: buildFindings(sources, activeKnowledge, experiences, candidates),
    summary: {
      questionsExtracted: classified.length,
      autoResolved: classified.filter((question) => question.disposition === "auto_resolved").length,
      deferred: classified.filter((question) => question.disposition === "defer_until_task").length,
      askUser: classified.filter((question) => question.disposition === "ask_user").length,
      immediateConfirmationRequired: classified.some((question) => question.disposition === "ask_user"),
      note: classified.some((question) => question.disposition === "ask_user")
        ? "只有人物稳定观察、Approval/门禁、生产阈值和组织策略等不可由当前证据推出的事项进入用户队列。"
        : "当前没有必须立即让用户确认的事项；其余问题按既有边界自动处理或延后到具体 Task。",
    },
    autoResolved: classified.filter((question) => question.disposition === "auto_resolved"),
    deferred: classified.filter((question) => question.disposition === "defer_until_task"),
    userDecisionQueue: classified.filter((question) => question.disposition === "ask_user"),
    decisionBundles: buildDecisionBundles(classified.filter((question) => question.disposition === "ask_user")),
    paths: { json: jsonPath, markdown: markdownPath },
  };
  writeJson(jsonPath, report);
  writeJson(join(root, "latest.json"), report);
  writeFile(markdownPath, renderReasoningMarkdown(report));
  writeFile(join(root, "latest.md"), renderReasoningMarkdown(report));

  const alreadyRecorded = store.listEvents().some((event) => event.aggregateType === "reasoning"
    && event.aggregateId === report.id
    && event.eventType === "reasoning.generated"
    && event.payload.inputFingerprint === report.inputFingerprint);
  if (!alreadyRecorded) {
    store.recordReasoningEvent(report.id, "reasoning.generated", {
      schema: report.schema,
      scope: report.scope,
      inputFingerprint: report.inputFingerprint,
      jsonPath,
      markdownPath,
      inputs: report.inputs,
      summary: report.summary,
      decisionBundleCount: report.decisionBundles.length,
    });
  }
  return report;
}

export function readLatestReasoning(home: string, scope: "personal" | "work" = "work"): ReasoningReport | null {
  const path = join(reasoningRoot(home, scope), "latest.json");
  if (!existsSync(path)) return null;
  assertRegularFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as ReasoningReport;
  validateReport(value, path);
  return value;
}

export function renderReasoningMarkdown(report: ReasoningReport): string {
  const lines: string[] = [
    "# IKB 全局推理报告",
    "",
    `- 报告：\`${report.id}\``,
    `- 范围：\`${report.scope}\``,
    `- 生成时间：${report.generatedAt}`,
    `- 输入指纹：\`${report.inputFingerprint.slice(0, 16)}\``,
    "",
    "## 结论",
    "",
    report.summary.note,
    "",
    `抽取到 ${report.summary.questionsExtracted} 个旧 Draft 确认项：自动处理 ${report.summary.autoResolved} 个，延后取证 ${report.summary.deferred} 个，真正需要用户确认 ${report.summary.askUser} 个。`,
    "",
    "## 输入覆盖",
    "",
    `- Source：${report.inputs.sources}；Experience：${report.inputs.experiences}；Candidate：${report.inputs.candidates}`,
    `- Knowledge：总计 ${report.inputs.knowledgeTotal}，当前 ${report.inputs.knowledgeActive}，Draft ${report.inputs.knowledgeDraft}，Verified ${report.inputs.knowledgeVerified}，Retired ${report.inputs.knowledgeRetired}`,
    `- Experience 状态：${formatCounts(report.inputs.experienceStatus) || "无"}`,
    `- Candidate 状态：${formatCounts(report.inputs.candidateStatus) || "无"}`,
    "",
    "## 系统原则判断",
    "",
  ];
  for (const finding of report.findings) {
    lines.push(`### ${finding.title}`, "", finding.conclusion, `置信度：${finding.confidence}`, `证据：${finding.evidenceRefs.map((ref) => `\`${ref}\``).join("、")}`, "");
  }
  lines.push("## 自动处理", "");
  if (report.autoResolved.length === 0) lines.push("无。", "");
  for (const question of report.autoResolved) lines.push(`- ${question.knowledgeTitle} #${question.number}：${question.text}（${question.rationale}）`);
  lines.push("", "## 延后到具体 Task", "");
  if (report.deferred.length === 0) lines.push("无。", "");
  for (const question of report.deferred) lines.push(`- ${question.knowledgeTitle} #${question.number}：${question.text}（${question.rationale}）`);
  lines.push("", "## 需要用户确认", "");
  if (report.decisionBundles.length === 0) lines.push("当前没有必须立即确认的事项。", "");
  for (const bundle of report.decisionBundles) {
    lines.push(`### ${bundle.title}`, "", `- 决策项：${bundle.itemCount} 个`, `- 影响：${bundle.consequence}`, "- 具体问题：");
    for (const question of report.userDecisionQueue.filter((item) => bundle.questionIds.includes(item.id))) {
      lines.push(`  - ${question.knowledgeTitle} #${question.number}：${question.text}`);
    }
    lines.push("");
  }
  lines.push("## 数据边界", "", "本报告只保存引用、计数和确认项文本，不复制聊天长文本；不修改 Knowledge 生命周期，不读取未排队的远端候选，也不执行学城/大象写操作。", "");
  return `${lines.join("\n")}\n`;
}

function buildFindings(sources: SourceRecord[], knowledge: KnowledgeRecord[], experiences: ExperienceRecord[], candidates: ReturnType<typeof listCandidates>): ReasoningFinding[] {
  const refs = ["docs/knowledge-extraction.md", "docs/contracts.md"];
  return [
    {
      id: "evidence-before-confirmation",
      title: "证据先于确认",
      conclusion: "当前输入先保留在 Source/Experience，推理只输出带引用的压缩结果；未满足证据条件的内容不直接进入 Knowledge。",
      confidence: "high",
      evidenceRefs: refs,
    },
    {
      id: "people-stricter-than-business",
      title: "人物知识门槛高于普通业务知识",
      conclusion: "人物观察必须先通过身份、直接发言和独立 Episode 门禁；业务 playbook 可以先以 advisory draft 使用，但不能把人物观察当成稳定偏好。",
      confidence: "high",
      evidenceRefs: ["docs/knowledge-extraction.md", "ikb-data/vaults/work/people/"],
    },
    {
      id: "defer-missing-evidence",
      title: "缺数据延后到任务取证",
      conclusion: `当前有 ${sources.length} 个已保存 Source、${experiences.length} 个 Experience 和 ${candidates.length} 个候选；“已保存”不等于“已深读”，最新配置、SOP 和真实验证应在具体 Task 中补齐。`,
      confidence: "high",
      evidenceRefs: ["ikb-data/sources/", "ikb-data/experiences/", "docs/contracts.md"],
    },
    {
      id: "advisory-first",
      title: "Draft 先 advisory，不自动升级",
      conclusion: `${knowledge.length} 张当前 Knowledge 中只有非 retired 条目进入推理；报告不改变 draft/verified/retired 生命周期，真实 Task 验证或用户确认仍是升级条件。`,
      confidence: "high",
      evidenceRefs: ["docs/knowledge-extraction.md", "src/knowledge.ts"],
    },
  ];
}

function extractQuestions(record: KnowledgeRecord): ReasoningQuestion[] {
  if (record.status === "retired") return [];
  const lines = readFileSync(record.path, "utf8").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+.*(?:待确认|确认)/u.test(line));
  if (headingIndex < 0) return [];
  const items: Array<{ number: number; text: string }> = [];
  let current: { number: number; text: string } | null = null;
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/u.test(line)) break;
    const match = /^\s*(\d+)[.)]\s+(.*\S)\s*$/u.exec(line);
    if (match) {
      if (current) items.push(current);
      current = { number: Number(match[1]), text: match[2].trim() };
    } else if (current && line.trim()) {
      current.text = `${current.text} ${line.trim()}`.trim();
    }
  }
  if (current) items.push(current);
  return items.map((item) => {
    const id = `reason-q-${sha256(`${record.id}|${item.number}|${item.text}`).slice(0, 12)}`;
    const classification = classify(record, item.text);
    return {
      id,
      knowledgeId: record.id,
      knowledgeTitle: record.title,
      collection: record.collection,
      number: item.number,
      text: item.text,
      category: classification.category,
      disposition: classification.disposition,
      risk: classification.risk,
      rationale: classification.rationale,
      nextAction: classification.nextAction,
      sourceRefs: record.sourceRefs,
    };
  });
}

function classifyQuestion(question: ReasoningQuestion): ReasoningQuestion { return question; }

function classify(record: KnowledgeRecord, raw: string): Pick<ReasoningQuestion, "category" | "disposition" | "risk" | "rationale" | "nextAction"> {
  const text = `${record.title} ${raw}`;
  const person = record.collection === "people" || /身份|直接消息|人物|偏好|画像|沟通策略|稳定观察/u.test(text);
  const sensitivity = /敏感|账号|金额|代理商|字段范围|脱敏/u.test(text);
  const policy = /Approval|审批|门禁|阈值|策略|哪些.*必须|必须阻断|通过、条件通过|组织/u.test(text);
  const externalAction = /Issue|外部|发布|发送|评论|写入/u.test(text) && /允许|建立|生成|修改/u.test(text);
  const evidence = /当前|最新版|提供|入口|仓库|历史任务|真实|演练|回归|配置|SOP|流量|查询|数据准备|执行报告|首次.*使用|第一次.*使用/u.test(text);
  const boundary = /只(用于|覆盖|作|保存)|不(表示|保存|纳入|替代|直接)|案例.*不|不把|不写/u.test(text);
  const safeAutomation = /是否允许.*(生成|建立|默认|先生成|使用|修订)/u.test(text) && !policy;
  const questionLike = /[?？]|^(是否|哪些|能否|要不要|请确认)/u.test(raw.trim());

  if (person) return {
    category: "person",
    disposition: "ask_user",
    risk: "high",
    rationale: "人物身份、稳定观察或 Agent 使用边界不能仅靠文本相似度推出。",
    nextAction: "保持人物观察 draft；用户确认身份和适用范围后，才允许作为个性化准备规则。",
  };
  if (sensitivity) return {
    category: "sensitivity",
    disposition: "auto_resolved",
    risk: "low",
    rationale: "按默认最小披露原则处理，未获明确授权不扩写账号、金额拆分或代理商细节。",
    nextAction: "保留敏感字段 unknown；只有具体 Task 明确授权时才局部读取。",
  };
  if (externalAction) return {
    category: "policy",
    disposition: "ask_user",
    risk: "high",
    rationale: "Issue、评论、发布或其他外部写入会产生副作用，不能由推理层默认为允许。",
    nextAction: "先生成本地草稿或 Issue 候选；真正写入前单独申请 Approval。",
  };
  // A declarative boundary such as “案例数字不作为阈值” is already a
  // system rule.  Only a question or an explicit governance instruction is
  // a user decision; otherwise the word “阈值” alone would over-ask.
  if (boundary && !questionLike) return {
    category: "boundary",
    disposition: "auto_resolved",
    risk: "low",
    rationale: "这是已有系统边界，不需要重复向用户确认。",
    nextAction: "将其作为 advisory card 的停止条件，不改变 Knowledge 生命周期。",
  };
  if (policy && (questionLike || /Approval|审批|门禁|必须阻断|组织/u.test(text))) return {
    category: "policy",
    disposition: "ask_user",
    risk: "high",
    rationale: "Approval、门禁、阈值和阻断策略会改变后续行为，当前材料不能代替用户或组织决策。",
    nextAction: "进入压缩后的用户决策包；未确认前只生成报告，不改变默认执行策略。",
  };
  if (boundary) return {
    category: "boundary",
    disposition: "auto_resolved",
    risk: "low",
    rationale: "这是已有系统边界，不需要重复向用户确认。",
    nextAction: "将其作为 advisory card 的停止条件，不改变 Knowledge 生命周期。",
  };
  if (safeAutomation) return {
    category: "boundary",
    disposition: "auto_resolved",
    risk: "low",
    rationale: "仅生成本地证据清单或 advisory 路由表，不产生外部副作用。",
    nextAction: "允许 Agent 先生成草稿，外部写入仍需独立 Approval。",
  };
  if (evidence) return {
    category: "evidence",
    disposition: "defer_until_task",
    risk: "medium",
    rationale: "这是需要当前数据或真实演练的证据缺口，不是现在向用户提问的原则决策。",
    nextAction: "在命中具体 Task 时读取最新 SOP/配置/入口并回写验证 Artifact。",
  };
  return {
    category: "unknown",
    disposition: "defer_until_task",
    risk: "medium",
    rationale: "当前证据不足以作稳定判断，先保留未知。",
    nextAction: "绑定后续分析 Task，补证据后再决定是否形成 Knowledge。",
  };
}

function buildDecisionBundles(questions: ReasoningQuestion[]): ReasoningDecisionBundle[] {
  const groups = new Map<ReasoningCategory, ReasoningQuestion[]>();
  for (const question of questions) {
    const list = groups.get(question.category) ?? [];
    list.push(question);
    groups.set(question.category, list);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([category, items]) => {
    const config = category === "person"
      ? { title: "人物身份、稳定观察与使用边界", decision: "是否确认人物身份、观察可重复性以及 Agent 使用范围？", consequence: "不确认则人物卡只保留为观察，不进入个性化沟通或任务策略。" }
      : { title: "高风险规则、Approval 与门禁", decision: "是否确认这些规则可以成为当前任务的默认门禁或 Approval 条件？", consequence: "不确认则只保留 advisory，遇到实际动作仍停在人工确认。" };
    return {
      id: `reason-bundle-${category}`,
      category,
      title: config.title,
      questionIds: items.map((item) => item.id),
      itemCount: items.length,
      decision: config.decision,
      consequence: config.consequence,
    };
  });
}

function reasoningRoot(home: string, scope: "personal" | "work"): string {
  return join(resolve(home), "governance", scope, "reasoning");
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Reasoning report must be a regular file: ${path}`);
}

function validateReport(value: ReasoningReport, path: string): void {
  if (!value || value.schema !== REASONING_VERSION || typeof value.id !== "string" || !value.inputs || !value.summary) {
    throw new Error(`Invalid reasoning report: ${path}`);
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const value = key(item) || "unknown";
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function countSignals(records: ExperienceRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) for (const signal of record.signalCodes) counts[signal] = (counts[signal] ?? 0) + 1;
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("，");
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
