import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCandidates } from "./candidates.ts";
import { listKnowledge } from "./knowledge.ts";
import { listSources } from "./source.ts";
import { listExperienceCandidates, listExperienceRecords, type ExperienceKnowledgeCandidate, type ExperienceRecord } from "./experience.ts";
import {
  inspectCurrentExperienceReviewPackage,
  writeExperienceCandidateConfirmationBatch,
  type ExperienceReviewInspection,
} from "./experience-review.ts";
import { listKnowledgeReviewHolds } from "./knowledge/holds.ts";
import type { LedgerStore } from "./store.ts";
import type { KnowledgeRecord, SourceRecord } from "./types.ts";

/**
 * Global reasoning is a deterministic compression layer between evidence and
 * human decisions.  It does not invent claims from raw text and never changes
 * Knowledge lifecycle state; it explains which existing draft questions can
 * be handled by an IKB rule, which need a future task, and which truly need a
 * human decision.
 */
export const REASONING_VERSION = "ikb-reasoning.v2";

export type ReasoningDisposition = "auto_resolved" | "defer_until_task" | "ask_user";
export type ReasoningCategory = "boundary" | "evidence" | "person" | "policy" | "knowledge_candidate" | "sensitivity" | "unknown";

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
  candidateId?: string;
  candidateMode?: "new" | "revision";
  reviewPackage?: {
    id: string;
    primaryHumanReviewPath: string;
    humanReviewItemKey: string;
    guidePath: string;
    draftPath: string | null;
    validationPaths: string[];
  };
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
    experienceCandidates: number;
    experienceCandidateStatus: Record<string, number>;
    knowledgeHolds: number;
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
  const experiences = listExperienceRecords(home, scope)
    .filter((record) => record.triageDisposition !== "ignored")
    .filter((record) => record.sourceIds.length === 0 || record.sourceIds.every((sourceId) => activeSourceIds.has(sourceId)));
  const candidates = listCandidates(home).filter((candidate) => candidate.scope === scope && (candidate.origin.sourceIds.length === 0 || candidate.origin.sourceIds.every((sourceId) => activeSourceIds.has(sourceId))));
  const experienceCandidates = listExperienceCandidates(home, scope);
  const experienceReviews = new Map(experienceCandidates.map((candidate) => [candidate.id, inspectCurrentExperienceReviewPackage(home, store, candidate)]));
  const previousConfirmationKeys = new Map((readLatestReasoning(home, scope)?.userDecisionQueue ?? []).flatMap((question) => {
    const key = question.reviewPackage?.humanReviewItemKey;
    return question.candidateId && key ? [[question.candidateId, key] as const] : [];
  }));
  const pendingExperienceCandidates = experienceCandidates
    .filter((candidate) => candidate.status === "pending_review")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const readyConfirmationEntries = pendingExperienceCandidates.flatMap((candidate) => {
    const review = experienceReviews.get(candidate.id) ?? { package: null, issues: [] };
    return experienceCandidateReviewBlockers(candidate, review).length === 0 && review.package
      ? [{ candidate, review: review.package, key: previousConfirmationKeys.get(candidate.id) }]
      : [];
  }).slice(0, 3);
  const confirmationBatch = readyConfirmationEntries.length > 0
    ? writeExperienceCandidateConfirmationBatch(home, readyConfirmationEntries)
    : null;
  const confirmationItems = new Map((confirmationBatch?.items ?? []).map((item) => [item.candidateId, {
    key: item.key,
    path: confirmationBatch!.brief.path,
  }]));
  const knowledgeHolds = listKnowledgeReviewHolds(home).filter((hold) => experienceCandidates.some((candidate) => candidate.id === hold.candidateId));
  const knowledge = listKnowledge(home, scope);
  const activeKnowledge = knowledge.filter((record) => record.status !== "retired");
  const draftQuestions = activeKnowledge.flatMap(extractQuestions);
  const classified = [
    ...draftQuestions.map(classifyQuestion),
    ...pendingExperienceCandidates.map((candidate) => experienceCandidateQuestion(
      candidate,
      experienceReviews.get(candidate.id) ?? { package: null, issues: [] },
      confirmationItems.get(candidate.id),
    )),
  ];
  const inputFingerprint = sha256(JSON.stringify({
    reasoningVersion: REASONING_VERSION,
    scope,
    sources: sources.map((source) => [source.id, source.contentHash, source.recordsHash ?? null]),
    experiences: experiences.map((record) => [record.id, record.updatedAt, record.status, record.signalCodes]),
    candidates: candidates.map((candidate) => [candidate.id, candidate.revision, candidate.status]),
    experienceCandidates: experienceCandidates.map((candidate) => [candidate.id, candidate.contentHash, candidate.status, candidate.decision?.candidateContentHash ?? null]),
    experienceReviews: experienceCandidates.map((candidate) => {
      const review = experienceReviews.get(candidate.id);
      return [candidate.id, review?.package?.package.id ?? null, review?.package?.package.draftContentHash ?? null, review?.package?.package.guideContentHash ?? null, review?.issues ?? []];
    }),
    confirmationBatch: confirmationBatch
      ? [confirmationBatch.brief.id, confirmationBatch.brief.contentHash, confirmationBatch.items.map((item) => [item.candidateId, item.key])]
      : null,
    knowledgeHolds: knowledgeHolds.map((hold) => [hold.candidateId, hold.knowledgeId]),
    knowledge: activeKnowledge.map((record) => [record.id, record.status, record.path, sha256(record.body)]),
    questions: classified.map((question) => [question.id, question.disposition, question.category]),
  }));
  const reportId = `reason-${inputFingerprint.slice(0, 12)}`;
  const root = reasoningRoot(home, scope);
  ensureDirectory(root);
  const jsonPath = join(root, `${reportId}.json`);
  const markdownPath = join(root, `${reportId}.md`);
  const userDecisionQueue = classified.filter((question) => question.disposition === "ask_user");
  const onlyKnowledgeCandidates = userDecisionQueue.length > 0 && userDecisionQueue.every((question) => question.category === "knowledge_candidate");
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
      experienceCandidates: experienceCandidates.length,
      experienceCandidateStatus: countBy(experienceCandidates, (candidate) => candidate.status),
      knowledgeHolds: knowledgeHolds.length,
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
      note: userDecisionQueue.length > 0
        ? onlyKnowledgeCandidates
          ? "全局报告不提前追问尚未进入真实任务的 Draft 缺口；当前用户队列只保留已经达到证据门槛、完成本地内容验证，但系统禁止自动落库的 Knowledge Candidate。"
          : "全局报告不提前追问尚未进入真实任务的证据缺口；当前用户队列只保留系统禁止自动决定的人物边界或 Knowledge Candidate。"
        : "当前没有必须立即让用户确认的事项；其余问题按既有边界自动处理或延后到具体 Task。",
    },
    autoResolved: classified.filter((question) => question.disposition === "auto_resolved"),
    deferred: classified.filter((question) => question.disposition === "defer_until_task"),
    userDecisionQueue,
    decisionBundles: buildDecisionBundles(userDecisionQueue),
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
    `汇总 ${report.summary.questionsExtracted} 个 Knowledge 草稿问题或候选决策：自动处理 ${report.summary.autoResolved} 个，延后取证 ${report.summary.deferred} 个，真正需要用户确认 ${report.summary.askUser} 个。`,
    "",
    "## 输入覆盖",
    "",
    `- Source：${report.inputs.sources}；Experience：${report.inputs.experiences}；来源 Candidate：${report.inputs.candidates}；Knowledge Candidate：${report.inputs.experienceCandidates}；暂停召回：${report.inputs.knowledgeHolds}`,
    `- Knowledge：总计 ${report.inputs.knowledgeTotal}，当前 ${report.inputs.knowledgeActive}，Draft ${report.inputs.knowledgeDraft}，Verified ${report.inputs.knowledgeVerified}，Retired ${report.inputs.knowledgeRetired}`,
    `- Experience 状态：${formatCounts(report.inputs.experienceStatus) || "无"}`,
    `- Candidate 状态：${formatCounts(report.inputs.candidateStatus) || "无"}`,
    `- Knowledge Candidate 状态：${formatCounts(report.inputs.experienceCandidateStatus) || "无"}`,
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
    const questions = report.userDecisionQueue.filter((item) => bundle.questionIds.includes(item.id));
    for (const question of questions) {
      const key = question.reviewPackage?.humanReviewItemKey;
      lines.push(`  - ${key ? `${key}. ` : ""}${question.knowledgeTitle} #${question.number}：${question.text}`);
    }
    const reviewPaths = [...new Set(questions.flatMap((question) => question.reviewPackage ? [question.reviewPackage.primaryHumanReviewPath] : []))];
    for (const path of reviewPaths) lines.push(`- ${markdownLink("统一确认入口", path)}`);
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
      evidenceRefs: ["docs/knowledge-extraction.md", "ikb-data/.system/cache/people/work/"],
    },
    {
      id: "defer-missing-evidence",
      title: "缺数据延后到任务取证",
      conclusion: `当前有 ${sources.length} 个已保存 Source、${experiences.length} 个 Experience 和 ${candidates.length} 个候选；“已保存”不等于“已深读”，最新配置、SOP 和真实验证应在具体 Task 中补齐。`,
      confidence: "high",
      evidenceRefs: ["ikb-data/.system/sources/", "ikb-data/experiences/", "docs/contracts.md"],
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
  const headingIndex = lines.findIndex((line) => /^##\s+待确认(?:[（(]|\s|$)/u.test(line));
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

function experienceCandidateQuestion(
  candidate: ExperienceKnowledgeCandidate,
  review: ExperienceReviewInspection,
  humanReview?: { key: string; path: string },
): ReasoningQuestion {
  const correction = candidate.changeTypes.some((changeType) => changeType === "revise" || changeType === "retire");
  const claim = (candidate.candidateKnowledge.claim ?? candidate.claimVariants.join("；")) || "候选包含多个主张，需先合并后再落库";
  const target = candidate.targetKnowledgeIds.length > 0 ? `，涉及 ${candidate.targetKnowledgeIds.join("、")}` : "";
  const reviewBlockers = experienceCandidateReviewBlockers(candidate, review);
  const locallyReadyForHumanReview = reviewBlockers.length === 0;
  const readyForHumanReview = locallyReadyForHumanReview && Boolean(humanReview);
  const effectiveReviewBlockers = locallyReadyForHumanReview && !humanReview
    ? ["本轮人工确认批次已达到 3 个主题上限"]
    : reviewBlockers;
  const reviewPackage = review.package && humanReview ? {
    id: review.package.package.id,
    primaryHumanReviewPath: humanReview.path,
    humanReviewItemKey: humanReview.key,
    guidePath: review.package.guide.path,
    draftPath: review.package.draft?.path ?? null,
    validationPaths: review.package.validations.map((artifact) => artifact.path),
  } : undefined;
  return {
    id: `reason-q-${sha256(`candidate|${candidate.id}|${candidate.contentHash}`).slice(0, 12)}`,
    knowledgeId: candidate.targetKnowledgeIds[0] ?? candidate.id,
    knowledgeTitle: candidate.title,
    collection: candidate.candidateKnowledge.collection,
    number: 1,
    text: correction
      ? `是否接受这次知识修订方向${target}：${claim}`
      : `是否允许把这个重复出现的经验整理成正式 Knowledge：${claim}`,
    category: "knowledge_candidate",
    disposition: readyForHumanReview ? "ask_user" : "defer_until_task",
    risk: correction ? "high" : "medium",
    rationale: readyForHumanReview
      ? correction
        ? "现有知识已出现直接反证，系统已暂停它进入 Agent 上下文；替代规则已完成本地内容验证，是否采用仍需要人工确认。"
        : "重复证据已达到候选门槛并完成本地内容验证；正式 Knowledge 的主张和用途仍需人工确认。"
      : `候选只进入了 Curator 队列，还没有整理到可以让用户判断的状态：${effectiveReviewBlockers.join("；")}。`,
    nextAction: readyForHumanReview
      ? `先打开统一确认入口并查看 ${humanReview!.key}；确认完整候选内容、适用范围和边界后，再接受或驳回 ${candidate.id}。`
      : `由 Curator 补齐 ${effectiveReviewBlockers.join("、")}；完成本地验证并生成完整知识稿后再进入用户确认队列。`,
    sourceRefs: [...candidate.sourceRecordRefs, ...candidate.evidenceEventIds, ...(review.package ? [review.package.package.guideArtifactId, ...(review.package.package.draftArtifactId ? [review.package.package.draftArtifactId] : []), ...review.package.package.validationArtifactIds] : [])],
    candidateId: candidate.id,
    candidateMode: correction ? "revision" : "new",
    reviewPackage,
  };
}

function experienceCandidateReviewBlockers(candidate: ExperienceKnowledgeCandidate, review: ExperienceReviewInspection): string[] {
  const blockers: string[] = [];
  const contract = candidate.candidateKnowledge;
  if (candidate.validationRefs.length === 0) blockers.push("缺少候选主张的本地内容验证");
  if (!contract.claim?.trim()) blockers.push("主张尚未合并");
  if (candidate.sourceRecordRefs.length === 0 && candidate.evidenceEventIds.length === 0) blockers.push("缺少可回放证据引用");
  const fields: Array<[string, string]> = [
    ["适用范围", contract.applicability],
    ["边界", contract.boundary],
    ["使用契约", contract.useContract],
    ["验证计划", contract.validationPlan],
  ];
  for (const [label, value] of fields) {
    if (!value.trim() || /^需合并\s/u.test(value.trim())) blockers.push(`${label}尚未收敛`);
  }
  if (review.issues.length > 0) blockers.push(`评审包校验失败：${review.issues.join("；")}`);
  else if (!review.package) blockers.push("缺少已登记的完整评审包");
  return blockers;
}

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
  if (externalAction) return {
    category: "policy",
    disposition: "defer_until_task",
    risk: "high",
    rationale: "外部写入确实需要 Approval，但当前没有一个即将执行的具体 Action；全局维护不提前索要空白授权。",
    nextAction: "命中真实 Task 时先生成本地草稿，再为具体目标和内容哈希申请 Approval。",
  };
  if (sensitivity) return {
    category: "sensitivity",
    disposition: "auto_resolved",
    risk: "low",
    rationale: "按默认最小披露原则处理，未获明确授权不扩写账号、金额拆分或代理商细节。",
    nextAction: "保留敏感字段 unknown；只有具体 Task 明确授权时才局部读取。",
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
    disposition: "defer_until_task",
    risk: "high",
    rationale: "这是高风险策略缺口，但尚未绑定真实消费者、当前基线和拟执行动作；现在确认容易变成脱离场景的永久规则。",
    nextAction: "命中具体 Task 后补当前证据，给出建议和影响，再请求一次有上下文的决策。",
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
    const candidateModes = new Set(items.map((item) => item.candidateMode).filter(Boolean));
    const candidateConsequence = candidateModes.size === 1 && candidateModes.has("new")
      ? "不确认则候选保留在评审队列，不会写入 Vault；现有 Knowledge 不受影响。"
      : candidateModes.size === 1 && candidateModes.has("revision")
      ? "不确认则旧知识继续暂停召回，候选也不会写入 Vault。"
      : "不确认则新增候选不会写入 Vault；修订候选对应的旧知识继续暂停召回。";
    const config = category === "knowledge_candidate"
      ? { title: "Knowledge Candidate 是否进入正式知识", decision: "是否接受候选中的主张、适用范围和边界？", consequence: candidateConsequence }
      : category === "person"
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

function markdownLink(label: string, path: string): string {
  return `[${label}](<${path.replaceAll(">", "%3E")}>)`;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
