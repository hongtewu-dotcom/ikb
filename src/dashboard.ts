import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCandidates } from "./candidates.ts";
import { citadelRateLimit, CITADEL_RATE_LIMIT_MAX } from "./commands/source-shared.ts";
import { listExperienceCandidates, listExperienceRecords } from "./experience.ts";
import { rankExperienceQueue } from "./experience-analysis.ts";
import { buildHealthView } from "./health.ts";
import { reviewKnowledge } from "./knowledge.ts";
import { listKnowledgeReviewHolds } from "./knowledge/holds.ts";
import { buildObservabilityReport } from "./observability.ts";
import { readLatestReasoning } from "./reasoning.ts";
import type { LedgerStore } from "./store.ts";

export function buildDashboardReport(store: LedgerStore, home: string): Record<string, unknown> {
  const generatedAt = new Date().toISOString();
  const stats = store.stats();
  const tasks = store.listTasks({}).filter((task) => !["done", "canceled"].includes(task.status)).map((task) => ({ id: task.id, status: task.status, type: task.type, priority: task.priority, title: task.title, updatedAt: task.updatedAt }));
  const knowledge = reviewKnowledge(home, "work").map((record) => ({
    id: record.id, title: record.title, status: record.status, type: record.type, collection: record.collection,
    reviewAfter: record.reviewAfter, confidence: record.confidence ?? null, verification: record.verification ?? null,
  }));
  const candidates = summarizeCandidates(listCandidates(home, "work"));
  const experience = summarizeExperiences(listExperienceRecords(home, "work"));
  const experienceCandidates = summarizeExperienceCandidates(listExperienceCandidates(home));
  const knowledgeHolds = listKnowledgeReviewHolds(home);
  const workReasoning = readReasoningForDashboard(home, "work");
  const personalReasoning = readReasoningForDashboard(home, "personal");
  const reasoning = summarizeReasoningScopes(
    { work: workReasoning.report, personal: personalReasoning.report },
    { work: workReasoning.error, personal: personalReasoning.error },
  );
  const health = buildHealthView(home);
  const coverage = readCoverage(home, "work");
  const people = readPeopleReadiness(home, "work");
  const rate = citadelRateLimit(store);
  const externalReads = {
    citadel: { ...rate, max: CITADEL_RATE_LIMIT_MAX, windowMinutes: 30, minimumDelayMs: 30_000, readOnly: true },
    elephant: { readOnly: true, boundedTargetsOnly: true, writeActionsForbidden: true },
  };
  const status = {
    knowledgeDue: knowledge.length,
    candidates: candidates.total,
    tasks: (stats.tasks as Record<string, number> | undefined) ?? {},
    runs: (stats.runs as Record<string, number> | undefined) ?? {},
    approvals: (stats.approvals as Record<string, number> | undefined) ?? {},
    recentFailures: Array.isArray(stats.recentFailures) ? stats.recentFailures : [],
    error: null,
  };
  const daily = buildObservabilityReport(store, "daily");
  const weekly = buildObservabilityReport(store, "weekly");
  return {
    schema: "ikb-live-report.v2",
    generatedAt,
    home: resolve(home).replaceAll(/[^/\\]+/g, "…"),
    status,
    tasks,
    knowledge,
    candidates,
    experience,
    experienceCandidates,
    knowledgeHolds,
    reasoning,
    daily,
    weekly,
    doctor: health.doctor,
    ledger: health.ledger,
    healthUpdatedAt: health.updatedAt || null,
    healthStale: health.stale,
    coverage,
    people,
    externalReads,
    attention: buildAttention({ tasks, weekly, knowledge, candidates, experience, experienceCandidates, knowledgeHolds, reasoning, health, coverage, people, externalReads }),
  };
}

function readPeopleReadiness(home: string, scope: "personal" | "work") {
  const path = join(resolve(home), "governance", scope, "people", "readiness.json");
  if (!existsSync(path)) return { error: "尚未生成人物周期分析就绪账", summary: null, people: [] };
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return { error: "人物就绪账不是普通文件", summary: null, people: [] };
  const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { generatedAt: report.generatedAt ?? null, mode: report.mode ?? null, summary: report.summary ?? null, people: Array.isArray(report.people) ? report.people : [] };
}

function summarizeCandidates(items: ReturnType<typeof listCandidates>) {
  const byStatus = countBy(items.map((item) => item.status));
  return {
    total: items.length,
    byStatus,
    recent: items.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 30).map((item) => ({
      id: item.id, status: item.status, kind: item.kind, title: item.title, nextAction: item.nextAction,
    })),
  };
}

function summarizeExperiences(items: ReturnType<typeof listExperienceRecords>) {
  const selected = items.filter((record) => record.triageDisposition !== "ignored");
  const queue = rankExperienceQueue(items, "work", 30);
  const bySignal: Record<string, number> = {};
  for (const record of selected) for (const signal of record.signalCodes ?? []) bySignal[signal] = (bySignal[signal] ?? 0) + 1;
  return {
    total: items.length,
    selected: selected.length,
    ignored: items.length - selected.length,
    queued: selected.filter((record) => record.status === "queued").length,
    analyzed: selected.filter((record) => record.status === "analyzed").length,
    bySignal,
    recent: queue.map((item) => {
      const record = selected.find((candidate) => candidate.id === item.experienceId)!;
      return {
        id: record.id, status: record.status, adapter: record.adapter, sourceTitle: record.sourceTitle,
        signalCodes: record.signalCodes, runCount: record.runIds?.length ?? 0,
        priority: item.priority, priorityReasons: item.priorityReasons,
      };
    }),
  };
}

function summarizeExperienceCandidates(items: ReturnType<typeof listExperienceCandidates>) {
  const byStatus = countBy(items.map((candidate) => candidate.status));
  return {
    total: items.length,
    byStatus,
    pendingReview: byStatus.pending_review ?? 0,
    accepted: byStatus.accepted ?? 0,
    applied: byStatus.applied ?? 0,
    rejected: byStatus.rejected ?? 0,
    recent: items.slice().sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, 20).map((candidate) => ({
      id: candidate.id, status: candidate.status, title: candidate.title, signalCodes: candidate.signalCodes,
      independentRunCount: candidate.independentRunCount, nextAction: candidate.nextAction,
      changeTypes: candidate.changeTypes, targetKnowledgeIds: candidate.targetKnowledgeIds,
      claim: candidate.candidateKnowledge.claim, decisionReason: candidate.decision?.reason ?? null,
    })),
  };
}

function summarizeReasoningScopes(
  reasonings: Record<"personal" | "work", ReturnType<typeof readLatestReasoning>>,
  errors: Record<"personal" | "work", string | null>,
) {
  const available = (Object.entries(reasonings) as Array<["personal" | "work", NonNullable<ReturnType<typeof readLatestReasoning>> | null]>)
    .filter((entry): entry is ["personal" | "work", NonNullable<ReturnType<typeof readLatestReasoning>>] => Boolean(entry[1]));
  const scopeErrors = Object.fromEntries(Object.entries(errors).filter(([, value]) => Boolean(value)));
  if (available.length === 0) return { error: "尚无可读取的全局推理报告", scopeErrors };
  const sum = (field: "questionsExtracted" | "autoResolved" | "deferred" | "askUser") => available.reduce((total, [, report]) => total + report.summary[field], 0);
  return {
    id: available.map(([scope, report]) => `${scope}:${report.id}`).join(" | "),
    generatedAt: available.map(([, report]) => report.generatedAt).sort().at(-1),
    scopes: Object.fromEntries(available.map(([scope, report]) => [scope, { id: report.id, generatedAt: report.generatedAt, summary: report.summary }])),
    scopeErrors,
    inputs: {
      sources: available.reduce((total, [, report]) => total + report.inputs.sources, 0),
      experiences: available.reduce((total, [, report]) => total + report.inputs.experiences, 0),
      candidates: available.reduce((total, [, report]) => total + report.inputs.candidates, 0),
      experienceCandidates: available.reduce((total, [, report]) => total + report.inputs.experienceCandidates, 0),
      knowledgeHolds: available.reduce((total, [, report]) => total + report.inputs.knowledgeHolds, 0),
      knowledgeActive: available.reduce((total, [, report]) => total + report.inputs.knowledgeActive, 0),
    },
    summary: {
      questionsExtracted: sum("questionsExtracted"),
      autoResolved: sum("autoResolved"),
      deferred: sum("deferred"),
      askUser: sum("askUser"),
      immediateConfirmationRequired: sum("askUser") > 0,
      note: sum("askUser") > 0 ? "只展示已经过系统推理、现在确实需要确认的事项；普通 Draft 缺口延后到真实 Task。" : "当前没有必须立即确认的事项。",
    },
    decisionBundles: available.flatMap(([scope, reasoning]) => reasoning.decisionBundles.map((bundle) => ({
      id: `${scope}:${bundle.id}`, scope, category: bundle.category, title: bundle.title, itemCount: bundle.itemCount,
      decision: bundle.decision, consequence: bundle.consequence,
      questions: reasoning.userDecisionQueue.filter((question) => bundle.questionIds.includes(question.id)).map((question) => ({
        id: question.id, knowledgeTitle: question.knowledgeTitle, number: question.number, text: question.text,
        risk: question.risk, nextAction: question.nextAction, candidateId: question.candidateId ?? null,
        reviewPackage: question.reviewPackage ?? null,
      })),
    }))),
  };
}

function readReasoningForDashboard(home: string, scope: "personal" | "work") {
  try {
    return { report: readLatestReasoning(home, scope), error: null };
  } catch (error) {
    return { report: null, error: (error as Error).message };
  }
}

function readCoverage(home: string, scope: "personal" | "work") {
  const path = join(resolve(home), "governance", scope, "sources", "coverage.json");
  if (!existsSync(path)) return { error: "尚未生成来源覆盖账", blockers: [] };
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return { error: "来源覆盖账不是普通文件", blockers: [] };
  const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const histories = report.histories as Record<string, unknown> | undefined;
  const sources = report.sources as Record<string, unknown> | undefined;
  const catpaw = report.catpawMemory as Record<string, unknown> | undefined;
  return {
    generatedAt: report.generatedAt ?? null,
    inventoryComplete: report.inventoryComplete === true,
    stockComplete: report.stockComplete === true,
    histories: histories ? { discovered: histories.discovered, covered: histories.covered, empty: histories.empty, backlog: histories.backlog } : null,
    sources: sources ? { total: sources.total, records: sources.records } : null,
    citadel: report.citadel ?? null,
    catpawMemory: catpaw ? { retrievedAt: catpaw.retrievedAt, totalCount: catpaw.totalCount, ageHours: catpaw.ageHours, credentialAvailable: catpaw.credentialAvailable } : null,
    targets: Array.isArray(report.targets) ? report.targets.map((value) => {
      const target = value as Record<string, unknown>;
      return { id: target.id, name: target.name ?? target.id, coverageState: target.coverageState, matchedSources: target.matchedSources, records: target.records, lastImportedAt: target.lastImportedAt };
    }) : [],
    keyPeople: report.keyPeople ?? null,
    blockers: Array.isArray(report.blockers) ? report.blockers : [],
  };
}

function buildAttention(input: Record<string, any>) {
  const attention: Array<{ severity: string; kind: string; title: string; detail: string }> = [];
  for (const task of input.tasks.filter((item: { status: string }) => item.status === "active" || item.status === "waiting")) {
    attention.push({ severity: task.status, kind: "task", title: task.title, detail: `${task.status} · ${task.id}` });
  }
  for (const observation of (input.weekly.runs?.observations ?? []).filter((item: { qualityState: string }) => item.qualityState === "block").slice(0, 20)) {
    attention.push({ severity: "quality", kind: "run", title: `Run ${observation.runId}`, detail: "终态已结束，但质量证据被阻断或不完整" });
  }
  for (const record of input.knowledge.slice(0, 20)) attention.push({ severity: "review", kind: "knowledge", title: record.title, detail: `${record.status} · ${record.id}` });
  if ((input.candidates.byStatus.discovered ?? 0) > 0) attention.push({ severity: "candidate", kind: "candidate", title: "待读取来源候选", detail: `${input.candidates.byStatus.discovered} 条 discovered；学城仍受半小时 10 篇门禁` });
  if (input.experience.queued > 0) attention.push({ severity: "review", kind: "experience", title: "待分析 Experience", detail: `${input.experience.queued} 个会话命中信号，尚未形成知识候选` });
  if (input.experienceCandidates.pendingReview > 0) attention.push({ severity: "candidate", kind: "experience-candidate", title: "待复核 Knowledge Candidate", detail: `${input.experienceCandidates.pendingReview} 个模式达到跨 Run 门槛` });
  if (input.experienceCandidates.accepted > 0) attention.push({ severity: "review", kind: "experience-candidate", title: "已接受但尚未写入 Knowledge", detail: `${input.experienceCandidates.accepted} 个候选仍需生成完整知识并通过修订事务` });
  if (input.knowledgeHolds.length > 0) attention.push({ severity: "quality", kind: "knowledge-hold", title: "有旧知识因反证暂停召回", detail: `${input.knowledgeHolds.length} 条旧知识在复核或修订完成前不会进入 Agent Context Pack` });
  if ((input.weekly.knowledgeUsage?.unresolvedReferences ?? 0) > 0) attention.push({ severity: "quality", kind: "knowledge-usage", title: "有知识引用尚未说明效果", detail: `${input.weekly.knowledgeUsage.unresolvedReferences} 条引用分布在 ${input.weekly.knowledgeUsage.unresolvedRuns} 个 Run；需要标记 helpful、partial、incorrect 或 unused` });
  if ((input.weekly.knowledgeUsage?.queries?.total ?? 0) >= 3 && (input.weekly.knowledgeUsage?.queries?.zeroResultRate ?? 0) >= 0.5) attention.push({ severity: "review", kind: "knowledge-retrieval", title: "知识检索零结果比例偏高", detail: `近 7 天 ${input.weekly.knowledgeUsage.queries.total} 次查询中有 ${input.weekly.knowledgeUsage.queries.zeroResult} 次零结果；需要检查知识缺口或检索表达` });
  if ((input.reasoning.summary?.askUser ?? 0) > 0) attention.push({ severity: "review", kind: "reasoning", title: "需要确认的高风险决策", detail: `${input.reasoning.summary.askUser} 个问题；先看推理报告中的中文决策包` });
  for (const blocker of input.coverage.blockers ?? []) attention.push({ severity: "waiting", kind: "source", title: "来源尚未闭合", detail: `${blocker.code}：${blocker.detail}` });
  if ((input.people.summary?.analysisDue ?? 0) > 0) attention.push({ severity: "review", kind: "person", title: "人物证据已达到语义分析门槛", detail: `${input.people.summary.analysisDue} 人需要做多视角聚类和反证搜索；这不等于人物知识可入库` });
  if (input.health.stale) attention.push({ severity: "waiting", kind: "health", title: "质量快照已过期", detail: `最近完整校验：${input.health.updatedAt || "尚未执行"}；下次维护会刷新` });
  if (input.health.doctor.ok !== true && !input.health.doctor.unavailable) attention.push({ severity: "error", kind: "doctor", title: "doctor 未通过", detail: "请检查来源、知识结构和增量状态" });
  if (input.health.ledger.ok !== true && !input.health.ledger.unavailable) attention.push({ severity: "error", kind: "ledger", title: "账本校验未通过", detail: `${input.health.ledger.brokenChains ?? "未知"} 条断链` });
  if (input.externalReads.citadel.remaining === 0) attention.push({ severity: "waiting", kind: "rate-limit", title: "学城读取额度已用完", detail: `最早恢复时间：${input.externalReads.citadel.resetAt ?? "等待滚动窗口"}` });
  return attention;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
