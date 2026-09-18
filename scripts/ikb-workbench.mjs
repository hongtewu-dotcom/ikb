#!/usr/bin/env node

// The workbench is a read-only projection.  It deliberately does not call a
// request mutation API and does not maintain a second state ledger.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listRequests, withShortLock, DEFAULT_INTAKE_ROOT } from "./ikb-requests.mjs";

import { buildWorkbenchMetrics } from "./ikb-workbench-metrics.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUTPUT_DIR = join(DEFAULT_INTAKE_ROOT, "workbench");
export const WORKBENCH_SCHEMA = "ikb-workbench-snapshot-v1";
const OUTPUT_FILES = ["index.html", "summary.md", "snapshot.json"];
const MAX_RECENT_RUNS = 40;
const REPORT_NAMES = new Set([
  "report.json",
  "latest.json",
  "latest-report.json",
  "run-report.json",
  "receipt.json",
  "verification.json",
  "final-verification.json",
  "publication-result.json",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const asArray = (value) => Array.isArray(value) ? value : [];

function fail(message) {
  throw new Error(`workbench: ${message}`);
}

function regularFile(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { fail(`${path}: unreadable (${error.code ?? error.message})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${path}: regular file required`);
  try { return readFileSync(path, "utf8"); } catch (error) { fail(`${path}: unreadable (${error.message})`); }
}

function jsonFile(path) {
  const source = regularFile(path);
  try { return JSON.parse(source); } catch (error) { fail(`${path}: malformed JSON (${error.message})`); }
}

function directory(path, { optional = true } = {}) {
  if (!existsSync(path)) {
    if (optional) return false;
    fail(`${path}: directory does not exist`);
  }
  let stat;
  try { stat = lstatSync(path); } catch (error) { fail(`${path}: unreadable (${error.code ?? error.message})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${path}: regular directory required`);
  return true;
}

function walkFiles(root, predicate, maxDepth = 8) {
  const found = [];
  const walk = (path, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); }
    catch (error) { fail(`${path}: unreadable (${error.code ?? error.message})`); }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile() && predicate(child, entry.name)) found.push(child);
      else if (entry.isSymbolicLink()) fail(`${child}: symbolic links are not accepted`);
    }
  };
  if (directory(root)) walk(root, 0);
  return found.sort();
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}-${hash(String(value)).slice(0, 16)}`;
}

function pathRef(path) {
  return resolve(path);
}

function sourceRefs(item) {
  const request = item?.request ?? item;
  const result = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim() && !result.includes(value)) result.push(value);
  };
  add(request?.source?.reference);
  for (const ref of asArray(request?.evidenceRefs)) add(ref);
  add(item?.requestPath);
  add(item?.reportPath);
  return result;
}

function requestCommand(item, action = "处理") {
  const id = nonempty(item?.requestId) ?? "unknown";
  const question = nonempty(item?.request?.question);
  return `${action} request:${id}${question ? `：${question}` : ""}；请重读当前请求、来源与状态后继续`;
}

function explicitUserDecision(item) {
  const request = item?.request ?? {};
  const result = item?.result ?? {};
  if (item?.decision) return item.decision.required === true;
  return request.requiresUserDecision === true
    || request.userDecisionRequired === true
    || request.humanDecisionRequired === true
    || request.decision?.required === true
    || result.requiresUserDecision === true
    || result.userDecisionRequired === true
    || ["needs_user_decision", "awaiting_user_decision", "needs_human_decision"].includes(item?.status)
    || ["ask_user", "needs_user_decision"].includes(result.action);
}

function requestReason(item) {
  const request = item?.request ?? {};
  const candidates = [
    ...asArray(item?.pendingReasons),
    item?.failure,
    request.reason,
    request.decision?.question,
    request.change,
    item?.result?.reason,
  ];
  const values = candidates.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (isObject(value)) return [value.message, value.reason, value.detail].filter(Boolean);
    return [];
  }).map(String).map((value) => value.trim()).filter(Boolean);
  return values.length ? values : ["原始回执没有提供理由；需由 Agent 分诊"];
}

function nextStep(item) {
  const status = nonempty(item?.status)?.toLowerCase() ?? "unknown";
  if (["failed", "verification_failed"].includes(status)) return "先核对后续成功请求与本次失败的关联，避免重复执行；确需恢复时再按失败理由处理。";
  if (["waiting", "prepared"].includes(status)) return "按原始待办理由补证或完成主审，再回读当前请求和回执。";
  if (status === "running") return "继续等待当前原生执行终态，再读取请求报告；不要从运行中推断完成。";
  if (["queued", "submitted"].includes(status)) return "由当前 Agent 接手并确认下一步；排队或已提交不表示原生任务已经启动。";
  if (status === "published_unverified") return "补做与当前请求绑定的最终验证，并读取最终回执。";
  return "先由 Agent 分诊原始回执，确认适用流程和恢复条件。";
}

export function resolvedRequestHistory(items) {
  const byId = new Map(items.map(item => [item.requestId, item]));
  const resolved = new Map();
  for (const item of items) {
    if (item.status !== "completed" || !item.request?.stableKey) continue;
    for (const id of item.request.relatedRequestIds ?? []) {
      const old = byId.get(id);
      if (id !== item.requestId && old?.request?.stableKey === item.request.stableKey && old.status !== "completed") resolved.set(id, item.requestId);
    }
  }
  return resolved;
}

function projectRequests(intakeRoot) {
  const requestsRoot = join(intakeRoot, "requests");
  if (!directory(requestsRoot)) return { all: [], decisions: [], agentContinue: [], completed: [], history: [] };
  let items;
  try {
    // listRequests is the existing read-only status projection.  It does not
    // write report.json (request status owns that file only in mutation APIs).
    items = listRequests({ intakeRoot });
  } catch (error) {
    fail(`request status read failed (${error.message})`);
  }
  const decisions = [];
  const agentContinue = [];
  const completed = [];
  const history = [];
  const resolvedHistory = resolvedRequestHistory(items);
  const terminal = new Set(["completed", "no_change", "excluded"]);
  for (const item of items) {
    const request = item.request ?? {};
    const presentation = [...(item.events ?? [])].reverse().find(event => event.type === "report" && event.presentation)?.presentation;
    const base = {
      id: item.requestId,
      stableId: item.requestId,
      kind: request.kind ?? "unknown",
      status: item.status ?? "unknown",
      submittedAt: request.submittedAt ?? null,
      question: request.question ?? "未知问题",
      displayTitle: presentation?.title ?? ((request.target?.path || request.candidatePath) ? basename(request.target?.path || request.candidatePath, ".md") : request.kind === "feedback" ? "知识反馈" : "知识更新"),
      userSummary: presentation?.summary ?? null,
      reasons: requestReason(item),
      sourceRefs: sourceRefs(item),
      requestPath: item.requestPath ?? null,
      reportPath: item.reportPath ?? null,
      originalSource: request.source?.reference ?? null,
      command: requestCommand(item),
    };
    if (resolvedHistory.has(item.requestId)) {
      history.push({ ...base, resolvedBy: resolvedHistory.get(item.requestId) });
    } else if (!terminal.has(item.status) && explicitUserDecision(item)) {
      decisions.push({
        ...base,
        question: item.decision?.question ?? base.question,
        decisionId: item.decision?.id ?? null,
        sourceRefs: [...base.sourceRefs, ...(item.decision?.reference ? [item.decision.reference] : [])],
        options: item.decision?.options ?? [],
        difference: item.decision?.difference ?? request.decision?.difference ?? request.change ?? "请求明确要求用户作决定，但未提供具体差异。",
        recommendation: item.decision?.recommendation ?? request.decision?.recommendation ?? request.recommendation ?? "未知；请先核对原始证据。",
        command: `${requestCommand(item, "决定并处理")}；展示决策版本：${item.decision?.id ?? "请核对原始来源"}；我的选择：____`,
      });
    } else if (terminal.has(item.status)) {
      completed.push({ ...base, completion: item.status, command: requestCommand(item, "回读") });
    } else {
      agentContinue.push({ ...base, nextStep: nextStep(item), triage: item.status === "unknown" });
    }
  }
  return { all: items, decisions, agentContinue, completed, history };
}

function markdownTitle(markdown, fallback) {
  return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? fallback;
}

function markdownType(markdown) {
  const match = markdown.match(/^[-*]\s*(?:类型|type)\s*[:：]\s*`?([^`\n]+)`?/imu);
  return match?.[1]?.trim().toLowerCase().split(/[;；]/u)[0] ?? "topic";
}

function topicDocuments(intakeRoot) {
  const root = join(intakeRoot, "maintenance", "topic-frameworks");
  if (!directory(root)) return [];
  const topics = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail(`${join(root, entry.name)}: symbolic links are not accepted`);
    if (!entry.isDirectory()) continue;
    const topicRoot = join(root, entry.name);
    const documents = [];
    for (const name of ["framework.md", "observations.md", "synthesis.md", "cases.md"]) {
      const path = join(topicRoot, name);
      if (!existsSync(path)) continue;
      const markdown = regularFile(path);
      documents.push({ kind: name.slice(0, -3), path: pathRef(path), markdown });
    }
    if (!documents.length) continue;
    const framework = documents.find((item) => item.kind === "framework");
    const cases = documents.find((item) => item.kind === "cases");
    const title = markdownTitle(framework?.markdown ?? "", entry.name);
    topics.push({
      id: entry.name,
      stableId: `topic:${entry.name}`,
      title,
      type: markdownType(framework?.markdown ?? ""),
      path: pathRef(topicRoot),
      framework: framework ?? null,
      observations: documents.find((item) => item.kind === "observations") ?? null,
      synthesis: documents.find((item) => item.kind === "synthesis") ?? null,
      cases: cases ?? null,
      documents,
    });
  }
  const scopePath = join(root, "people-scope.json");
  if (existsSync(scopePath)) {
    const scope = jsonFile(scopePath);
    if (!Array.isArray(scope.priorityPeople) || scope.priorityPeople.some(person => !nonempty(person.name) || !nonempty(person.topicId))) fail(`${scopePath}: priorityPeople requires name and topicId`);
    for (const [order, person] of scope.priorityPeople.entries()) {
      let topic = topics.find(item => item.id === person.topicId);
      if (!topic) {
        topic = { id: person.topicId, stableId: `topic:${person.topicId}`, title: person.name, type: "person", path: pathRef(root), documents: [], framework: null, observations: null, synthesis: null, cases: null };
        topics.push(topic);
      }
      topic.featured = true;
      topic.priorityOrder = order;
    }
    for (const topic of topics) if (topic.type === "person" && topic.featured !== true) topic.featured = false;
    topics.sort((a,b) => (a.priorityOrder ?? 1000) - (b.priorityOrder ?? 1000));
  }
  return topics;
}

function reportFileName(name) {
  const lower = name.toLowerCase();
  return REPORT_NAMES.has(lower)
    || lower.includes("report")
    || lower.includes("receipt")
    || lower === "final-verification.json"
    || lower === "publication-result.json";
}

function explicitStatus(value) {
  if (!isObject(value)) return null;
  return nonempty(value.status)
    ?? nonempty(value.state)
    ?? nonempty(value.outcome?.status)
    ?? nonempty(value.result?.status)
    ?? nonempty(value.terminal);
}

function explicitQuality(value) {
  if (!isObject(value)) return "unknown";
  const candidate = value.quality ?? value.qualityState ?? value.assessment?.quality ?? value.outcome?.quality;
  return candidate === undefined || candidate === null || candidate === "" ? "unknown" : candidate;
}

function reportTimestamp(value, stat) {
  const candidates = [value?.completedAt, value?.verifiedAt, value?.finishedAt, value?.updatedAt, value?.generatedAt, value?.recordedAt];
  const selected = candidates.find((candidate) => typeof candidate === "string" && Number.isFinite(Date.parse(candidate)));
  return selected ?? new Date(stat.mtimeMs).toISOString();
}

function reportSummary(value) {
  if (typeof value === "string") {
    const first = value.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    return first ?? value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "Markdown 报告为空。";
  }
  if (!isObject(value)) return "报告内容不是 JSON 对象。";
  const candidates = [value.summary, value.note, value.reason, value.outcome?.status, value.status, value.result?.status];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() ?? "原始回执未提供摘要。";
}

function collectRecentRuns(intakeRoot) {
  const root = join(intakeRoot, "runs");
  if (!directory(root)) return [];
  const reportPaths = walkFiles(root, (_path, name) => reportFileName(name), 5);
  const byRun = new Map();
  for (const path of reportPaths) {
    const value = extname(path).toLowerCase() === ".json" ? jsonFile(path) : regularFile(path);
    const runDir = dirname(path);
    const runId = relative(root, runDir) || runDir;
    let stat;
    try { stat = statSync(path); } catch (error) { fail(`${path}: stat failed (${error.message})`); }
    const candidate = {
      runId,
      stableId: `run:${runId}`,
      sourcePath: pathRef(path),
      status: explicitStatus(value) ?? "unknown",
      quality: explicitQuality(value),
      ok: typeof value?.ok === "boolean" ? value.ok : null,
      summary: reportSummary(value),
      recordedAt: reportTimestamp(value, stat),
    };
    const existing = byRun.get(runId);
    const priority = (name) => name.toLowerCase() === "report.json" ? 3 : name.toLowerCase().includes("report") ? 2 : 1;
    const better = !existing || priority(path.split(sep).at(-1)) > priority(existing.sourcePath.split(sep).at(-1)) || candidate.recordedAt > existing.recordedAt;
    if (better) byRun.set(runId, candidate);
  }
  return [...byRun.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.runId.localeCompare(b.runId)).slice(0, MAX_RECENT_RUNS);
}

function collectIncremental(intakeRoot) {
  const roots = [join(intakeRoot, "maintenance", "incremental-live")];
  const runRoot = join(intakeRoot, "runs");
  if (directory(runRoot)) {
    for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /(?:^|[-_])increment(?:al)?(?:[-_]|$)/iu.test(entry.name)) roots.push(join(runRoot, entry.name));
    }
  }
  const uniqueRoots = [...new Set(roots)].filter((root) => directory(root));
  // The launcher's refresh receipt is this projection's output, not a source
  // ledger. Older launchers created it empty before invoking the generator,
  // so reading it here makes generation depend on its own unfinished output.
  // Keep parsing actual source JSON strictly; do not hide malformed reports.
  const files = [...new Set(uniqueRoots.flatMap((root) => walkFiles(root, (_path, name) =>
    name.toLowerCase().endsWith(".json") && name !== "workbench-refresh.json", 4)))].sort();
  const records = [];
  const unreconciled = [];
  const sourcePaths = [];
  const unsupported = [];
  const addUnreconciled = (value, path, keyHint = "") => {
    const action = nonempty(value?.action) ?? nonempty(value?.status);
    const pending = action === "defer" || action === "propose_change" || action === "waiting" || action === "unreconciled"
      || value?.disposition === "needs_triage" || value?.disposition === "partial_source"
      || value?.unprocessed > 0 || value?.unresolvedQuestions > 0;
    if (!pending) return;
    const reason = nonempty(value?.reason) ?? nonempty(value?.note) ?? nonempty(value?.reopenWhen) ?? "增量账本记录仍未完成对账。";
    unreconciled.push({
      id: stableId("incremental", `${path}:${keyHint}:${JSON.stringify(value)}`),
      stableId: stableId("incremental", `${path}:${keyHint}`),
      status: action ?? value?.disposition ?? "unreconciled",
      reason,
      nextStep: nonempty(value?.reopenWhen) ?? "按原始来源和结果引用完成对账；账本累计数字不作为当前待办数量。",
      sourceRefs: [pathRef(path), ...asArray(value?.evidenceRefs).filter((item) => typeof item === "string")],
      command: `分诊 incremental:${hash(`${path}:${keyHint}`).slice(0, 16)}；先核对原始来源和后续回执`,
    });
  };
  const addPendingCollection = (values, path, key) => {
    const pending = asArray(values).filter((item) => isObject(item) && (
      ["defer", "propose_change", "waiting"].includes(item.action ?? item.status)
      || item.disposition === "needs_triage"
      || item.disposition === "partial_source"
    ));
    if (pending.length <= 20) {
      for (const [index, item] of pending.entries()) addUnreconciled(item, path, `${key}:${index}`);
      return;
    }
    const actions = [...new Set(pending.map((item) => item.action ?? item.status ?? item.disposition).filter(Boolean))].join(", ");
    addUnreconciled({
      action: "unreconciled",
      reason: `${key} 有 ${pending.length} 条历史记录未完成对账（${actions || "状态未知"}）。`,
      reopenWhen: "按该文件原始记录和后续回执分批对账；工作台不将其展开为人工待办。",
    }, path, `${key}:aggregate`);
  };
  for (const path of files) {
    const value = jsonFile(path);
    sourcePaths.push(pathRef(path));
    if (isObject(value)) {
      const summary = {
        path: pathRef(path),
        schema: value.schema ?? null,
        action: value.action ?? null,
        status: value.status ?? null,
        counts: value.counts ?? value.dispositions ?? null,
        note: value.note ?? value.reason ?? null,
      };
      records.push(summary);
      addUnreconciled(value, path);
      for (const key of ["records", "requestRecords", "items", "pending", "unresolved", "failures"]) addPendingCollection(value[key], path, key);
      for (const key of ["triageMemberKeys", "pendingReviewKeys"]) {
        const count = asArray(value[key]).length;
        if (count) addUnreconciled({ disposition: "needs_triage", reason: `${key} 中仍有 ${count} 条历史记录未完成对账。`, reopenWhen: "按该文件中的稳定成员标识继续对账；不将累计数量当作当前人工待办。" }, path, `${key}:aggregate`);
      }
      if (value.source?.failures) {
        const failures = asArray(value.source.failures);
        if (failures.length) addUnreconciled({ disposition: "partial_source", reason: `source.failures 中有 ${failures.length} 条历史来源失败记录。`, reopenWhen: "核对来源恢复情况和对应后续回执；累计来源失败数不等于当前待办。" }, path, "source.failures:aggregate");
      }
      if (Number.isFinite(value.sourceFailures) && value.sourceFailures > 0) addUnreconciled({ disposition: "partial_source", reason: `该增量摘要记录累计 sourceFailures=${value.sourceFailures}。`, reopenWhen: "回到原始来源和后续回执核对，不能仅凭累计计数判断当前状态。" }, path, "sourceFailures");
    } else {
      unsupported.push(pathRef(path));
    }
  }
  const deduped = [...new Map(unreconciled.map((item) => [item.stableId, item])).values()];
  // A historical result ledger can contain hundreds of members. Keep the
  // existence, count, reasons and directory source visible, while avoiding a
  // page that turns every old member into a current human task.
  const grouped = new Map();
  const compact = [];
  for (const item of deduped) {
    const source = item.sourceRefs[0] ?? "";
    let key = null;
    if (/\/maintenance\/incremental-live\/results\//u.test(source)) key = "incremental-live-results";
    else if (item.status === "needs_triage" && /\/runs\/catdesk-increment\//u.test(source)) key = "catdesk-increment-triage";
    if (!key) { compact.push(item); continue; }
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  for (const [key, items] of grouped) {
    if (items.length <= 12) { compact.push(...items); continue; }
    const examples = items.slice(0, 3).map((item) => item.reason).join("；");
    const source = key === "incremental-live-results" ? join(intakeRoot, "maintenance", "incremental-live", "results") : join(intakeRoot, "runs", "catdesk-increment");
    compact.push({
      id: stableId("incremental", `${key}:aggregate`),
      stableId: `incremental:${key}`,
      status: "unreconciled",
      reason: `${items.length} 条历史增量记录保留待处理标记；是否已由后续回执关闭未关联，示例：${examples}`,
      nextStep: "按目录中的原始结果和后续回执分批对账；这些旧账不直接生成当前人工待办。",
      sourceRefs: [pathRef(source)],
      command: `分诊 incremental:${key}；先核对目录内原始结果和后续回执`,
    });
  }
  return {
    sources: sourcePaths,
    records,
    unreconciled: compact,
    note: "这些是历史账本的原始标记，未关联全部后续回执，不能据此判定尚未完成；不重新打开已完成的存量治理，也不计为当前待办。",
    warnings: unsupported.length ? [`${unsupported.length} 个 JSON 来源不是对象，未按增量状态投影；示例：${unsupported.slice(0, 3).join(", ")}`] : [],
  };
}

export function buildSnapshot(options = {}) {
  const intakeRoot = resolve(options.intakeRoot ?? process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT);
  if (existsSync(intakeRoot)) directory(intakeRoot, { optional: false });
  const requests = projectRequests(intakeRoot);
  const topics = topicDocuments(intakeRoot);
  const incremental = collectIncremental(intakeRoot);
  const recentRuns = collectRecentRuns(intakeRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const snapshot = {
    schema: WORKBENCH_SCHEMA,
    generatedAt,
    metrics: buildWorkbenchMetrics({ requests: requests.all, cardsRoot: options.cardsRoot ?? join(dirname(intakeRoot), "cards"), decisionIds: requests.decisions.map(item => item.id), historicalIds: requests.history.map(item => item.id), intakeRoot, generatedAt }),
    static: true,
    description: "静态快照；浏览器刷新不会重新读取来源，需重新运行工作台生成器。",
    intakeRoot,
    sections: {
      decisions: requests.decisions,
      agentContinue: requests.agentContinue,
      topics,
      recentRuns,
    },
    decisions: requests.decisions,
    agentContinue: requests.agentContinue,
    topics,
    recentRuns,
    completedRequests: requests.completed,
    historicalRequests: requests.history,
    incremental,
    sourceSummary: {
      requestCount: requests.all.length,
      topicCount: topics.length,
      recentRunCount: recentRuns.length,
      incrementalSourceCount: incremental.sources.length,
    },
  };
  return snapshot;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function safeHref(target, sourcePath = null) {
  const value = String(target ?? "").trim();
  if (/^https?:\/\//iu.test(value) || /^file:\/\//iu.test(value)) return value;
  if (value.startsWith("#")) return value;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return sourcePath ? `file://${resolve(dirname(sourcePath), value)}` : `file://${resolve(value)}`;
  }
  // Markdown links without a scheme are local paths when a source is known.
  return sourcePath ? `file://${resolve(dirname(sourcePath), value)}` : null;
}

function inlineMarkdown(value, sourcePath = null) {
  let text = htmlEscape(value);
  text = text.replace(/`([^`]+)`/gu, "<code>$1</code>");
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, (_all, alt, target) => {
    const href = safeHref(target, sourcePath);
    return href ? `<span class="md-image">${htmlEscape(alt)} <a href="${htmlEscape(href)}" rel="noreferrer">${htmlEscape(target)}</a></span>` : `<span class="md-image">${htmlEscape(alt)} (${htmlEscape(target)})</span>`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_all, label, target) => {
    const href = safeHref(target, sourcePath);
    return href ? `<a href="${htmlEscape(href)}" rel="noreferrer">${label}</a>` : `${label} (${htmlEscape(target)})`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/gu, "<em>$1</em>");
  return text;
}

function renderMarkdown(markdown, sourcePath = null) {
  const lines = String(markdown ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const out = [];
  let list = null;
  let table = false;
  let fence = false;
  let fenceLanguage = "";
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push("</tbody></table>"); table = false; } };
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      closeList(); closeTable();
      if (!fence) { fence = true; fenceLanguage = line.slice(3).trim(); out.push(`<pre class="code ${htmlEscape(fenceLanguage)}">`); }
      else { fence = false; out.push("</pre>"); }
      continue;
    }
    if (fence) { out.push(`${htmlEscape(line)}\n`); continue; }
    if (!line.trim()) { closeList(); closeTable(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) { closeList(); closeTable(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2], sourcePath)}</h${level}>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line)) { closeList(); closeTable(); out.push("<hr>"); continue; }
    if (/^\s*[-*+]\s+/u.test(line) || /^\s*\d+[.)]\s+/u.test(line)) {
      closeTable();
      const ordered = /^\s*\d+[.)]\s+/u.test(line);
      const tag = ordered ? "ol" : "ul";
      if (list !== tag) { closeList(); list = tag; out.push(`<${tag}>`); }
      out.push(`<li>${inlineMarkdown(line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, ""), sourcePath)}</li>`); continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(line.replace(/^[^|]*\|/u, ""))) {
      closeList();
      if (!table) { table = true; out.push("<table><tbody>"); }
      continue;
    }
    if (line.includes("|") && line.split("|").length >= 3) {
      closeList();
      if (!table) { table = true; out.push("<table><tbody>"); }
      const cells = line.replace(/^\s*\|/u, "").replace(/\|\s*$/u, "").split("|");
      out.push(`<tr>${cells.map((cell) => `<td>${inlineMarkdown(cell.trim(), sourcePath)}</td>`).join("")}</tr>`); continue;
    }
    closeList(); closeTable();
    out.push(`<p>${inlineMarkdown(line, sourcePath)}</p>`);
  }
  closeList(); closeTable();
  if (fence) out.push("</pre>");
  return out.join("\n");
}

function pathHtml(path) {
  if (!path) return "<span class=\"muted\">未知</span>";
  const href = safeHref(path);
  return href ? `<a class="path" href="${htmlEscape(href)}" rel="noreferrer"><code>${htmlEscape(path)}</code></a>` : `<code>${htmlEscape(path)}</code>`;
}

function copyButton(command, label = "复制处理指令") {
  return `<button class="copy" type="button" data-label="${htmlEscape(label)}" data-copy="${htmlEscape(command)}">${htmlEscape(label)}</button>`;
}

function emptyState(text) {
  return `<div class="empty">${htmlEscape(text)}</div>`;
}

function renderDecision(item) {
  return `<article class="card decision" data-searchable="${htmlEscape(JSON.stringify(item))}"><span class="badge amber">需要你选择</span><h3>${htmlEscape(item.question)}</h3><dl><dt>有什么区别</dt><dd>${inlineMarkdown(item.difference)}</dd><dt>可以怎么选</dt><dd>${(item.options ?? []).map(option => htmlEscape(option)).join(" / ") || "见问题说明"}</dd><dt>建议</dt><dd>${inlineMarkdown(item.recommendation)}</dd></dl><p>把你的选择发到当前对话即可。</p><div class="actions">${copyButton(item.command, "复制回答模板")}</div><details><summary>查看问题依据</summary>${item.sourceRefs.map(pathHtml).join("<br>")}<p><code>${htmlEscape(item.decisionId ?? item.stableId)}</code></p></details></article>`;
}

function renderAgentItem(item) {
  const state = item.status === "running" ? "有执行记录，进度待核对" : item.status === "waiting" ? "等待补充材料" : "等待 Agent 接手";
  const summary = item.userSummary ?? (item.status === "waiting" ? "材料还不够，暂时保留。需要你提供信息时，会另列出具体问题。" : "由 Agent 核对处理；目前没有需要你回答的问题。");
  return `<article class="card" data-searchable="${htmlEscape(JSON.stringify(item))}"><span class="badge blue">${state}</span><h3>${htmlEscape(item.displayTitle)}</h3><p>${htmlEscape(summary)}</p><p class="muted">不需要你操作。</p><details><summary>查看处理记录</summary><p>${htmlEscape(item.question)}</p><p>${item.reasons.map(reason => inlineMarkdown(reason)).join("；")}</p><p>${item.sourceRefs.map(pathHtml).join("<br>")}</p><code>${htmlEscape(item.stableId)}</code></details></article>`;
}

function renderTopic(topic) {
  const labels = { framework: "收集范围", observations: "已有材料", synthesis: "目前总结", cases: "参考案例" };
  const docs = [...topic.documents].sort((a,b) => ["cases","synthesis","observations","framework"].indexOf(a.kind) - ["cases","synthesis","observations","framework"].indexOf(b.kind)).map(doc => `<details class="doc"><summary>${labels[doc.kind] ?? htmlEscape(doc.kind)}</summary><div class="markdown">${renderMarkdown(doc.markdown, doc.path)}</div></details>`).join("");
  const count = (topic.cases?.markdown.match(/^## (?:W|B|X)\d+/gm) ?? []).length;
  const name = topic.title.split("｜")[0];
  return `<article class="card topic" data-searchable="${htmlEscape(JSON.stringify(topic))}"><h3>${htmlEscape(name)}</h3><p class="muted">${count ? `已有 ${count} 个参考案例，可展开查看原文和具体用法。` : topic.type === "person" ? "已列入积累范围，具体案例尚待补充。" : "查看已收集的材料和总结。"}</p>${docs}<details class="doc"><summary>来源文件</summary>${pathHtml(topic.path)}</details></article>`;
}

function renderRun(run) {
  const status = run.status === "unknown" ? "状态未知" : run.status;
  const quality = run.quality === "unknown" ? "质量未知" : `质量：${String(run.quality)}`;
  return `<article class="card" data-searchable="${htmlEscape(JSON.stringify(run))}"><div class="card-top"><span class="badge green">最近运行</span><code>${htmlEscape(run.stableId)}</code></div><h3>${htmlEscape(run.runId)}</h3><p><strong>${htmlEscape(status)}</strong> · ${htmlEscape(quality)}${run.ok === null ? "" : ` · ok=${htmlEscape(run.ok)}`}</p><p>${inlineMarkdown(run.summary)}</p><p class="source">回执：${pathHtml(run.sourcePath)}<br>记录时间：${htmlEscape(run.recordedAt)}</p></article>`;
}

function renderCompletedRequest(item) {
  const text = item.completion === "completed" ? "已更新知识库，可以直接查询。无需你再处理。" : item.completion === "no_change" ? "已检查，本次不需要修改知识。" : "本次未收录，无需你处理。";
  return `<article class="card" data-searchable="${htmlEscape(JSON.stringify(item))}"><span class="badge green">${item.completion === "completed" ? "已完成" : "已处理"}</span><h3>${htmlEscape(item.displayTitle)}</h3><p>${text}</p><details><summary>查看依据</summary><p>${htmlEscape(item.question)}</p>${pathHtml(item.reportPath)}</details></article>`;
}

function renderIncremental(incremental) {
  const items = incremental.unreconciled.map((item) => `<article class="subcard" data-searchable="${htmlEscape(JSON.stringify(item))}"><div class="card-top"><span class="badge rose">${htmlEscape(item.status)}</span><code>${htmlEscape(item.stableId)}</code></div><p>${inlineMarkdown(item.reason)}</p><p><strong>后续：</strong>${inlineMarkdown(item.nextStep)}</p><p class="source">${item.sourceRefs.map(pathHtml).join("<br>")}</p>${copyButton(item.command)}</article>`).join("");
  const warnings = (incremental.warnings ?? []).map((warning) => `<p class="source"><strong>读取提示：</strong>${htmlEscape(warning)}</p>`).join("");
  return `<div class="ledger"><p class="muted">${htmlEscape(incremental.note)}</p>${warnings}${items || emptyState("本次没有发现相关未对账事项。")}</div>`;
}

function renderStock(stock) {
  if (!stock || stock.state !== "available") return emptyState(`知识库统计暂不可用${stock?.warnings?.length ? `：${stock.warnings.join("；")}` : "，请检查来源"}`);
  const { byScope, knowledgeKinds: kinds, sourceMetadata: sources, updatedMetadata: updated } = stock;
  const percent = value => value === null || value === undefined ? "未知" : `${Number(value).toFixed(1)}%`;
  const categoryNames = { domains: "业务知识", practices: "实践与排查", services: "服务资料", people: "人物资料", team: "团队资料" };
  return `<div class="metric-grid">
    <div class="metric"><span>活动知识总量</span><strong>${stock.total} 张</strong><small>工作 ${byScope.work} · 通用 ${byScope.common} · 个人 ${byScope.personal}</small><small>不含候选、归档和人物空框架</small></div>
    <div class="metric"><span>普通 / 原则 · 工作可查询范围</span><strong>${kinds.normal} / ${kinds.principle} 张</strong><small>普通 ${percent(kinds.normalPercent)} · 原则 ${percent(kinds.principlePercent)}</small><small>${kinds.unknown ? `${kinds.unknown} 张待分类；` : ""}分母 ${kinds.workTotal} 张，不含个人库</small></div>
    <div class="metric"><span>有来源记录的卡片</span><strong>${percent(sources.percent)}</strong><small>${sources.present} 张有记录 · ${sources.missing} 张缺少记录</small><small>只检查是否记录出处，不代表来源已核验</small></div>
    <div class="metric"><span>近 30 天标记更新</span><strong>${updated.last30Days} 张</strong><small>${updated.older} 张更早 · ${updated.unknown + updated.future} 张日期缺失或异常</small><small>按卡片日期统计，不代表事实仍然有效</small></div>
  </div><div class="stock-categories"><p><strong>工作知识分布</strong>（按目录）</p>${Object.entries(stock.byCategory).map(([name,count]) => `<span>${htmlEscape(categoryNames[name] ?? name)} <strong>${count}</strong></span>`).join("")}</div>
  <details class="metric-notes"><summary>分类依据与统计范围</summary><p>普通／原则只采用已核对、且与当前卡片版本相符的分类。新增或改动后没有匹配分类的卡片显示为“待分类”，不会自动归为普通。个人库不混入此比例。</p><p>业务、实践等按所在目录统计，与普通／原则是两个不同维度。近 30 天的日期来自卡片 updated_at；批量整理也会改变它，不能据此判定知识新鲜或准确。</p>${stock.warnings.map(warning => `<p>${htmlEscape(warning)}</p>`).join("")}${pathHtml(stock.classification.sourcePath)}</details>`;
}

function renderMetrics(metrics) {
  if (!metrics) return "";
  const { decisions, knowledge, feedback, usage } = metrics;
  const time = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
  const delta = "按卡片去重 · 以最终验收为准";
  const waiting = decisions.pending === 0 ? "目前没有已登记的待决策问题" : decisions.oldestHours === null ? "等待时间未记录" : decisions.oldestHours === 0 ? "最早一项刚登记不到 1 小时" : `最早一项已等 ${decisions.oldestHours} 小时`;
  const usageValue = usage.reads === null ? "暂无数据" : `${usage.reads} 次读取`;
  const usageDetail = usage.reads === null ? htmlEscape(usage.reason) : `${usage.searches} 次检索 · ${usage.references ?? "未知"} 次引用迹象`;
  const freshness = usage.state === "stale" ? "统计已超过 36 小时未更新" : usage.state === "invalid" ? "统计读取异常" : "";
  return `<div class="metric-grid">
  <a class="metric" href="#decisions"><span>待你决定</span><strong>${decisions.pending} 件</strong><small>${waiting}${decisions.unknownAge ? `；${decisions.unknownAge} 项等待时间未知` : ""}</small></a>
  <a class="metric" href="#recent-runs"><span>近 7 天完成知识更新</span><strong>${knowledge.updatedCards} 张</strong><small>${delta}${knowledge.unplacedCompletions ? `；另有 ${knowledge.unplacedCompletions} 项完成时间缺失` : ""}</small></a>
  <a class="metric" href="#agent-continue"><span>反馈跟进 · 累计</span><strong>${feedback.handled} / ${feedback.total} 已处理</strong><small>${feedback.deferred} 条暂缓 · ${feedback.pending} 条待处理</small></a>
  <div class="metric"><span>知识查阅 · 最近采集窗口</span><strong>${usageValue}</strong><small>${usageDetail}</small><small>含维护和测试流量，不代表效果</small><small>${usage.generatedAt ? `采集截至 ${time(usage.generatedAt)}` : ""}${freshness ? ` · ${freshness}` : ""}</small></div>
  </div><details class="metric-notes"><summary>统计范围与来源</summary><p>前三项按现有请求和最终验收记录统计，截至 ${time(metrics.asOf)}。知识更新只计当前验收通过的卡片，同一卡在窗口内更新多次只计一张；不计草稿、失败或已删除的卡片。反馈“已处理”包含无需修改和未收录，不代表每条都变成新知识。</p><p>知识查阅${usage.window ? `的记录窗口为 ${time(usage.window.from)} 至 ${time(usage.window.to)}；` : "："}仅含已采集流量，包含维护和测试。读取、引用迹象不等于任务有效，暂不计算准确率或收益。</p>${pathHtml(usage.sourcePath)}</details>`;
}

export function renderHtml(snapshot) {
  const section = snapshot.sections;
  const decisions = section.decisions.map(renderDecision).join("") || emptyState("目前没有已登记的待决策问题，你不需要操作。");
  const agent = section.agentContinue.map(renderAgentItem).join("") || emptyState("本次无 Agent 可继续事项。");
  const topics = section.topics.filter(topic => topic.featured !== false).map(renderTopic).join("") || emptyState("暂时没有主题资料。");
  const additionalTopics = section.topics.filter(topic => topic.featured === false).map(renderTopic).join("");
  const runs = section.recentRuns.map(renderRun).join("") || emptyState("本次没有可识别的最近运行回执。");
  const completed = (snapshot.completedRequests ?? []).filter(item => item.completion === "completed").sort((a,b) => String(b.submittedAt).localeCompare(String(a.submittedAt))).slice(0,6).map(renderCompletedRequest).join("") || emptyState("暂时没有新的知识更新。");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>IKB 轻量工作台</title>
<style>
:root{color-scheme:light;--bg:#f6f7fb;--panel:#fff;--ink:#172033;--muted:#667085;--line:#e4e7ec;--accent:#4f46e5;--shadow:0 12px 30px #10182812}html[data-theme=dark]{color-scheme:dark;--bg:#10131a;--panel:#171b24;--ink:#eef2f8;--muted:#9aa4b2;--line:#2b3442;--shadow:0 12px 30px #0006}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1200px;margin:0 auto;padding:32px 22px 64px}header{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;margin-bottom:26px}h1,h2,h3{line-height:1.3}h1{margin:0;font-size:30px}h2{margin:34px 0 12px;font-size:22px}h3{margin:8px 0;font-size:17px}p{margin:8px 0}.lede,.muted{color:var(--muted)}.meta{font-size:13px;color:var(--muted)}.toolbar{min-width:0;display:flex;gap:8px;flex-wrap:wrap}.toolbar input{min-width:260px;flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink)}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;padding:9px 12px;background:var(--panel);color:var(--ink)}button:hover{border-color:var(--accent)}.grid{min-width:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px}.card,.subcard{min-width:0;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow)}.subcard{margin:10px 0;box-shadow:none}.card-top{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}.badge{font-size:12px;border-radius:999px;padding:2px 9px}.amber{background:#fff3c4;color:#8a5a00}.blue{background:#dbeafe;color:#174ea6}.purple{background:#ede9fe;color:#5b21b6}.green{background:#dcfce7;color:#166534}.rose{background:#ffe4e6;color:#9f1239}html[data-theme=dark] .amber{color:#ffe49a;background:#49370b}html[data-theme=dark] .blue{color:#bfdbfe;background:#17345c}html[data-theme=dark] .purple{color:#ddd6fe;background:#33226b}html[data-theme=dark] .green{color:#bbf7d0;background:#123c24}html[data-theme=dark] .rose{color:#fecdd3;background:#571c2a}code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.card dl{display:grid;grid-template-columns:95px 1fr;gap:5px 10px}.card dt{color:var(--muted)}.card dd{margin:0}.actions{margin-top:12px;display:flex;gap:8px}.copy{font-size:13px}.empty{border:1px dashed var(--line);border-radius:12px;color:var(--muted);padding:18px}.source{color:var(--muted);font-size:13px}.path{color:var(--accent);overflow-wrap:anywhere}.path code{color:inherit}.ledger{margin-top:12px}.doc{border-top:1px solid var(--line);margin-top:12px;padding-top:8px}.doc summary{overflow-wrap:anywhere;cursor:pointer;color:var(--accent);font-size:13px}.markdown{margin-top:12px;overflow:auto}.markdown table{border-collapse:collapse;width:100%;margin:8px 0}.markdown td{border:1px solid var(--line);padding:5px 8px;vertical-align:top}.markdown pre{background:#111827;color:#e5e7eb;padding:12px;border-radius:8px;overflow:auto}.markdown blockquote{border-left:3px solid var(--line);padding-left:12px;color:var(--muted)}.metric-grid{display:flex;flex-wrap:wrap;gap:12px}.metric{flex:1;min-width:220px;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);text-decoration:none;display:flex;flex-direction:column;gap:6px}.metric strong{font-size:27px;line-height:1.4}.metric span,.metric small{color:var(--muted)}.stock-categories{margin-top:14px}.stock-categories span{display:inline-block;margin:0 10px 8px 0;padding:5px 12px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.metric-notes{margin-top:12px;color:var(--muted);font-size:13px}strong{color:var(--ink)}footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}@media(max-width:600px){main{padding:22px 14px}header{display:block}.toolbar{margin-top:14px}.toolbar input{min-width:0;width:100%}}
</style></head><body><main>
<header><div><h1>IKB 轻量工作台</h1><p class="lede">看看有什么需要你决定，以及知识库有哪些新内容。</p><p class="meta">生成时间：${htmlEscape(snapshot.generatedAt)} · 来源：${htmlEscape(snapshot.intakeRoot)}</p></div><div class="toolbar"><input id="filter" type="search" placeholder="搜索人物、主题或问题" aria-label="搜索"><button id="theme" type="button">切换明暗</button></div></header>
<section><h2>概览</h2>${renderMetrics(snapshot.metrics)}</section>
<section><h2>需要你决定</h2><div class="grid">${decisions}</div></section>
<section><h2>最近成果</h2><div class="grid">${completed}</div></section>
<section><h2>知识库现状</h2>${renderStock(snapshot.metrics?.stock)}</section>
<section><h2>人物与主题</h2>${section.topics.some(topic => topic.featured === false) && !section.topics.some(topic => topic.featured === true) ? '<p class="muted">你指定的人物名单正在核对；现有人物材料暂放在补充收集中。</p>' : ""}<div class="grid">${topics}</div>${additionalTopics ? `<details><summary>其他人物（补充收集）</summary><div class="grid">${additionalTopics}</div></details>` : ""}</section>
<section><h2>系统处理记录</h2><p class="muted">这里是 Agent 排查和维护时使用的记录，日常不用看。需要你处理的问题会放到页面最上方。</p><details><summary>内部事项（${section.agentContinue.length} 条，不需要你操作）</summary><div class="grid">${agent}</div></details><details><summary>诊断记录（仅供排查）</summary><div class="grid">${runs}</div><details><summary>历史增量记录</summary>${renderIncremental(snapshot.incremental)}</details></details></section>
<footer>静态快照说明：浏览器刷新不会重新读取来源；重新运行 <code>node scripts/ikb-workbench.mjs</code> 才会生成新的 index.html、summary.md 和 snapshot.json。<br>完成状态只采用现有请求状态、运行回执和最终报告中的明确字段；没有证据时显示未知。</footer>
</main><script>
(()=>{const root=document.documentElement;const saved=localStorage.getItem('ikb-workbench-theme');if(saved)root.dataset.theme=saved;document.getElementById('theme').addEventListener('click',()=>{const next=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=next;localStorage.setItem('ikb-workbench-theme',next)});const input=document.getElementById('filter');input.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('[data-searchable]').forEach((el)=>{el.hidden=Boolean(q&&!el.dataset.searchable.toLowerCase().includes(q))})});document.querySelectorAll('[data-copy]').forEach((button)=>button.addEventListener('click',async()=>{const value=button.dataset.copy||'';try{await navigator.clipboard.writeText(value);button.textContent='已复制'}catch{button.textContent='请手动复制';window.prompt('复制处理指令',value)}setTimeout(()=>{button.textContent=button.dataset.label||'复制处理指令'},1500)}))})();
</script></body></html>
`;
}

function markdownSourceList(refs) {
  return refs?.length ? refs.map((ref) => `- ${ref}`).join("\n") : "- 未知";
}

export function renderSummary(snapshot) {
  const lines = [
    "# IKB 轻量工作台摘要",
    "",
    `- 生成时间：${snapshot.generatedAt}`,
    `- 来源根目录：${snapshot.intakeRoot}`,
    "- 页面性质：静态只读快照；刷新浏览器不会重新读取来源。",
    "- 完成性口径：只采用现有请求状态、运行回执和最终报告中的明确字段，没有证据时保留未知。",
    "",
    "## 指标",
    "",
    ...(snapshot.metrics ? [
      `- 待你决定：${snapshot.metrics.decisions.pending} 件`,
      ...(snapshot.metrics.stock?.state === "available" ? [
        `- 活动知识总量：${snapshot.metrics.stock.total} 张；工作 ${snapshot.metrics.stock.byScope.work}，通用 ${snapshot.metrics.stock.byScope.common}，个人 ${snapshot.metrics.stock.byScope.personal}`,
        `- 工作可查知识分型：普通 ${snapshot.metrics.stock.knowledgeKinds.normal}，原则 ${snapshot.metrics.stock.knowledgeKinds.principle}，待分类 ${snapshot.metrics.stock.knowledgeKinds.unknown}`,
        `- 来源记录覆盖：${snapshot.metrics.stock.sourceMetadata.present}/${snapshot.metrics.stock.total}；近 30 天标记更新 ${snapshot.metrics.stock.updatedMetadata.last30Days} 张（不代表有效性）`,
      ] : ["- 活动知识统计：暂不可用"]),
      `- 近 7 天完成知识更新：${snapshot.metrics.knowledge.updatedCards} 张（按卡片去重）`,
      `- 反馈：累计 ${snapshot.metrics.feedback.total} 条，已处理 ${snapshot.metrics.feedback.handled} 条，暂缓 ${snapshot.metrics.feedback.deferred} 条，待处理 ${snapshot.metrics.feedback.pending} 条`,
      `- 知识查阅：${snapshot.metrics.usage.reads ?? "未知"} 次读取；统计状态 ${snapshot.metrics.usage.state}；数据时间 ${snapshot.metrics.usage.generatedAt ?? "缺失"}，含维护与测试，不代表效果`,
      "",
    ] : []),
    "## 需要你决定",
    "",
  ];
  if (!snapshot.decisions.length) lines.push("目前没有已登记的待决策问题，你不需要操作。", "");
  for (const item of snapshot.decisions) lines.push(`### ${item.stableId} · ${item.question}`, "", `- 状态：${item.status}`, `- 具体差异：${item.difference}`, `- 推荐选择：${item.recommendation}`, "- 原始来源：", markdownSourceList(item.sourceRefs), `- 复制指令：${item.command}`, "");
  lines.push("## Agent 可继续", "");
  if (!snapshot.agentContinue.length) lines.push("本次无 Agent 可继续事项。", "");
  for (const item of snapshot.agentContinue) lines.push(`### ${item.stableId} · ${item.question}`, "", `- 状态：${item.status}`, `- 原始理由：${item.reasons.join("；")}`, `- 下一步：${item.nextStep}`, "- 原始来源：", markdownSourceList(item.sourceRefs), `- 复制指令：${item.command}`, "");
  lines.push("## 主题与人物", "");
  if (!snapshot.topics.length) lines.push("本次没有主题底稿。", "");
  for (const topic of snapshot.topics) {
    lines.push(`### ${topic.stableId} · ${topic.title}`, "", `- 类型：${topic.type}`, `- 目录：${topic.path}`, "");
    for (const doc of topic.documents) lines.push(`#### ${doc.kind} · ${doc.path}`, "", doc.markdown.trim(), "");
  }
  lines.push("## 最近完成与运行", "");
  lines.push("### 已完成请求", "");
  if (!snapshot.completedRequests?.length) lines.push("暂时没有新的知识更新。", "");
  for (const item of snapshot.completedRequests ?? []) lines.push(`- ${item.stableId}（${item.completion}）：${item.question}；请求：${item.requestPath}；报告：${item.reportPath}`, "");
  lines.push("### 运行回执", "");
  if (!snapshot.recentRuns.length) lines.push("本次没有可识别的最近运行回执。", "");
  for (const run of snapshot.recentRuns) lines.push(`### ${run.stableId} · ${run.runId}`, "", `- 状态：${run.status}`, `- 质量：${run.quality === "unknown" ? "未知" : run.quality}`, `- 摘要：${run.summary}`, `- 回执：${run.sourcePath}`, `- 记录时间：${run.recordedAt}`, "");
  lines.push("### 历史增量记录（不计为当前待办）", "", snapshot.incremental.note, "");
  for (const warning of snapshot.incremental.warnings ?? []) lines.push(`- 读取提示：${warning}`, "");
  if (!snapshot.incremental.unreconciled.length) lines.push("本次没有发现相关未对账事项。", "");
  for (const item of snapshot.incremental.unreconciled) lines.push(`- ${item.stableId}（${item.status}）：${item.reason}；后续：${item.nextStep}；来源：${item.sourceRefs.join(", ")}`, "");
  return `${lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

function atomicWrite(path, value) {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function replaceOutput(outputDir, files) {
  const parent = dirname(outputDir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(parent, ".ikb-workbench-"));
  const old = `${outputDir}.previous-${process.pid}-${Date.now()}`;
  try {
    for (const name of OUTPUT_FILES) atomicWrite(join(temp, name), files[name]);
    const hadOld = existsSync(outputDir);
    if (hadOld) renameSync(outputDir, old);
    try { renameSync(temp, outputDir); }
    catch (error) {
      if (hadOld) { try { renameSync(old, outputDir); } catch { /* preserve the original error */ } }
      throw error;
    }
    if (hadOld) { try { rmSync(old, { recursive: true, force: true }); } catch { /* a successful replacement remains usable */ } }
  } catch (error) {
    try { if (existsSync(temp)) rmSync(temp, { recursive: true, force: true }); } catch { /* preserve generation failure */ }
    throw error;
  }
  return OUTPUT_FILES.map((name) => join(outputDir, name));
}

export function generateWorkbench(options = {}) {
  const intakeRoot = resolve(options.intakeRoot ?? process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT);
  const outputDir = resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const snapshot = buildSnapshot({ ...options, intakeRoot });
  const html = renderHtml(snapshot);
  const summary = renderSummary(snapshot);
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  // Rendering all three artifacts completes before any existing output is
  // moved. A malformed source therefore leaves the previous page untouched.
  const files = { "index.html": html, "summary.md": summary, "snapshot.json": json };
  mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
  const lockPath = join(dirname(outputDir), ".ikb-workbench.lock");
  const paths = withShortLock(lockPath, () => replaceOutput(outputDir, files));
  return { outputDir, paths, snapshot };
}

export function parseArgs(args = process.argv.slice(2)) {
  const options = { intakeRoot: DEFAULT_INTAKE_ROOT, outputDir: DEFAULT_OUTPUT_DIR, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--intake-root" || arg === "--output-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(`${arg} requires a directory`);
      if (arg === "--intake-root") options.intakeRoot = resolve(value);
      else options.outputDir = resolve(value);
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log("usage: node scripts/ikb-workbench.mjs [--intake-root DIR] [--output-dir DIR]");
      return 0;
    }
    const result = generateWorkbench(options);
    console.log(JSON.stringify({ outputDir: result.outputDir, files: result.paths, generatedAt: result.snapshot.generatedAt }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
