#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");
const DEFAULT_PORT = 3417;
const CANDIDATE_ID_PATTERN = /^exp-cand-[a-z0-9-]{1,96}$/;
const KNOWLEDGE_ID_PATTERN = /^kb-[a-z0-9-]{1,96}$/;
const MAX_REVIEW_FILES = 2_000;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const reportCache = new Map();

function parseArgs(argv = process.argv.slice(2)) {
  const options = { home: process.env.IKB_HOME ?? join(PROJECT_ROOT, "ikb-data"), port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--home") options.home = resolve(argv[++index]);
    else if (value === "--port") options.port = Number(argv[++index]);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid --port: ${options.port}`);
  }
  return options;
}

function runIkb(home, args) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", CLI_PATH, ...args, "--json", "--home", home],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, IKB_PROJECT_ROOT: PROJECT_ROOT },
    },
  );
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: (result.stderr || result.stdout || `ikb exited ${result.status}`).trim() };
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { error: `invalid ikb JSON: ${error.message}` };
  }
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function summarizeTasks(tasks) {
  return listOrEmpty(tasks).map((task) => ({
    id: task.id,
    status: task.status,
    type: task.type,
    priority: task.priority,
    title: task.title,
    updatedAt: task.updatedAt,
  }));
}

function summarizeKnowledge(records) {
  return listOrEmpty(records).map((record) => ({
    id: record.id,
    title: record.title,
    status: record.status,
    type: record.type,
    collection: record.collection,
    reviewAfter: record.reviewAfter,
    confidence: record.confidence ?? null,
    verification: record.verification ?? null,
  }));
}

function summarizeCandidates(candidates) {
  const byStatus = {};
  for (const candidate of listOrEmpty(candidates)) byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
  return {
    total: listOrEmpty(candidates).length,
    byStatus,
    recent: listOrEmpty(candidates).slice(-30).reverse().map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      kind: candidate.kind,
      title: candidate.title,
      nextAction: candidate.nextAction,
    })),
  };
}

function summarizeExperiences(records) {
  const items = listOrEmpty(records);
  const bySignal = {};
  for (const record of items) for (const signal of listOrEmpty(record.signalCodes)) bySignal[signal] = (bySignal[signal] ?? 0) + 1;
  return {
    total: items.length,
    queued: items.filter((record) => record.status === "queued").length,
    analyzed: items.filter((record) => record.status === "analyzed").length,
    bySignal,
    recent: items.slice().sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, 30).map((record) => ({
      id: record.id,
      status: record.status,
      adapter: record.adapter,
      sourceTitle: record.sourceTitle,
      signalCodes: record.signalCodes,
      runCount: listOrEmpty(record.runIds).length,
    })),
  };
}

function summarizeExperienceCandidates(candidates) {
  const items = listOrEmpty(candidates);
  const byStatus = {};
  for (const candidate of items) byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
  return {
    total: items.length,
    byStatus,
    pendingReview: byStatus.pending_review ?? 0,
    accepted: byStatus.accepted ?? 0,
    applied: byStatus.applied ?? 0,
    rejected: byStatus.rejected ?? 0,
    recent: items.slice().sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, 20).map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      title: candidate.title,
      signalCodes: candidate.signalCodes,
      independentRunCount: candidate.independentRunCount,
      nextAction: candidate.nextAction,
      changeTypes: candidate.changeTypes,
      targetKnowledgeIds: candidate.targetKnowledgeIds,
      claim: candidate.candidateKnowledge?.claim ?? null,
      decisionReason: candidate.decision?.reason ?? null,
    })),
  };
}

function compactDoctor(doctor) {
  if (!doctor || doctor.error) return { ok: false, error: doctor?.error ?? "doctor unavailable" };
  return {
    ok: doctor.ok === true,
    events: doctor.events ?? null,
    sources: doctor.sources ?? null,
    candidates: doctor.candidates ?? null,
    brokenChains: Array.isArray(doctor.brokenChains) ? doctor.brokenChains.length : null,
    sourceIssues: Array.isArray(doctor.sourceIssues) ? doctor.sourceIssues.length : null,
    experiences: doctor.experiences ?? null,
    experienceCandidates: doctor.experienceCandidates ?? null,
    experienceIssues: Array.isArray(doctor.experienceIssues) ? doctor.experienceIssues.length : null,
    experienceReviewPackages: doctor.experienceReviewPackages ?? null,
    knowledgeLayoutOk: doctor.knowledgeLayout?.ok ?? null,
    qualityIssues: doctor.knowledgeLayout?.qualityIssues?.length ?? null,
  };
}

function compactLedger(ledger) {
  const replay = ledger?.replay ?? ledger;
  return {
    ok: Array.isArray(replay?.brokenChains) && replay.brokenChains.length === 0,
    events: replay?.events ?? null,
    brokenChains: Array.isArray(replay?.brokenChains) ? replay.brokenChains.length : null,
  };
}

function compactReasoning(reasoning) {
  if (!reasoning || reasoning.error) return { error: reasoning?.error ?? "reasoning unavailable" };
  return {
    id: reasoning.id ?? null,
    generatedAt: reasoning.generatedAt ?? null,
    inputs: {
      sources: reasoning.inputs?.sources ?? null,
      experiences: reasoning.inputs?.experiences ?? null,
      candidates: reasoning.inputs?.candidates ?? null,
      experienceCandidates: reasoning.inputs?.experienceCandidates ?? null,
      knowledgeHolds: reasoning.inputs?.knowledgeHolds ?? null,
      knowledgeActive: reasoning.inputs?.knowledgeActive ?? null,
    },
    summary: {
      questionsExtracted: reasoning.summary?.questionsExtracted ?? 0,
      autoResolved: reasoning.summary?.autoResolved ?? 0,
      deferred: reasoning.summary?.deferred ?? 0,
      askUser: reasoning.summary?.askUser ?? 0,
      immediateConfirmationRequired: reasoning.summary?.immediateConfirmationRequired === true,
      note: reasoning.summary?.note ?? null,
    },
    decisionBundles: listOrEmpty(reasoning.decisionBundles).map((bundle) => ({
      id: bundle.id,
      category: bundle.category,
      title: bundle.title,
      itemCount: bundle.itemCount,
      decision: bundle.decision,
      consequence: bundle.consequence,
      questions: listOrEmpty(reasoning.userDecisionQueue)
        .filter((question) => listOrEmpty(bundle.questionIds).includes(question.id))
        .map((question) => ({
          id: question.id,
          knowledgeTitle: question.knowledgeTitle,
          number: question.number,
          text: question.text,
          risk: question.risk,
          nextAction: question.nextAction,
          candidateId: question.candidateId ?? null,
          reviewPackage: question.reviewPackage ?? null,
        })),
    })),
  };
}

function buildAttention({ status, weekly, knowledge, candidates, experiences, experienceCandidates, reasoning, doctor, ledger }) {
  const attention = [];
  for (const task of summarizeTasks(status?.tasksList ?? [])) {
    if (task.status === "active" || task.status === "waiting") {
      attention.push({ severity: task.status === "active" ? "active" : "waiting", kind: "task", title: task.title, detail: `${task.status} · ${task.id}` });
    }
  }
  for (const observation of listOrEmpty(weekly?.runs?.observations).filter((item) => item.qualityState === "block").slice(0, 20)) {
    attention.push({ severity: "quality", kind: "run", title: `Run ${observation.runId}`, detail: "terminal 已结束，但缺少质量证据或质量被阻断" });
  }
  for (const record of summarizeKnowledge(knowledge).slice(0, 20)) {
    attention.push({ severity: "review", kind: "knowledge", title: record.title, detail: `${record.status} · ${record.id}` });
  }
  if ((candidates?.byStatus?.discovered ?? 0) > 0) {
    attention.push({ severity: "candidate", kind: "candidate", title: "待排队来源候选", detail: `${candidates.byStatus.discovered} 条 discovered，尚未读取` });
  }
  if ((experiences?.queued ?? 0) > 0) {
    attention.push({ severity: "review", kind: "experience", title: "待分析 Experience", detail: `${experiences.queued} 个会话已命中信号，尚未形成 Knowledge` });
  }
  if ((experienceCandidates?.pendingReview ?? 0) > 0) {
    attention.push({ severity: "candidate", kind: "experience-candidate", title: "待复核 Knowledge Candidate", detail: `${experienceCandidates.pendingReview} 个模式达到跨 Run 门槛，仍需补齐 Knowledge Card` });
  }
  if ((reasoning?.summary?.askUser ?? 0) > 0) {
    const bundles = listOrEmpty(reasoning.decisionBundles).map((bundle) => `${bundle.title}（${bundle.itemCount}）`).join("、");
    attention.push({ severity: "review", kind: "reasoning", title: "需要确认的高风险决策包", detail: `${reasoning.summary.askUser} 个问题，${bundles || "请打开推理报告查看"}` });
  }
  if (doctor?.ok !== true) attention.push({ severity: "error", kind: "doctor", title: "doctor 未通过", detail: doctor?.error ?? "请检查结构、来源和知识质量" });
  if (ledger?.ok !== true) attention.push({ severity: "error", kind: "ledger", title: "账本校验未通过", detail: `${ledger?.brokenChains ?? "未知"} 条断链` });
  return attention;
}

export function buildReport(home) {
  const fingerprint = reportFingerprint(home);
  const cached = reportCache.get(home);
  if (cached?.fingerprint === fingerprint) return cached.value;
  const value = runIkb(home, ["observe", "dashboard"]);
  if (!value?.error) reportCache.set(home, { fingerprint, value });
  return value;
}

function reportFingerprint(home) {
  return [
    configuredLedgerPath(home),
    join(home, "governance", "work", "sources", "coverage.json"),
    join(home, "governance", "work", "reasoning", "latest.json"),
    join(home, "governance", "work", "people", "readiness.json"),
    join(home, "governance", "system", "health.json"),
  ].map((path) => {
    if (!existsSync(path)) return `${path}:missing`;
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
}

function configuredLedgerPath(home) {
  const configPath = join(home, "config.yaml");
  if (existsSync(configPath)) {
    const line = readFileSync(configPath, "utf8").split("\n").find((row) => row.trimStart().startsWith("ledger:"));
    const configured = line?.slice(line.indexOf(":") + 1).trim();
    if (configured) return resolve(configured);
  }
  return join(home, ".system", "ledger", "events.jsonl");
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function decodePathSegment(pathname, prefix) {
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return "";
  }
}

export function findCandidateReviewDocuments(home, candidateId) {
  if (!CANDIDATE_ID_PATTERN.test(String(candidateId ?? ""))) throw new Error(`Invalid candidate id: ${candidateId}`);
  const root = join(resolve(home), "reviews");
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) throw new Error(`Review root must be a regular directory: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_REVIEW_FILES || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const stat = statSync(path);
      if (stat.size > MAX_REVIEW_BYTES) continue;
      files.push({ directory, name: entry.name, relativePath: relative(root, path), content: readFileSync(path, "utf8") });
    }
  };
  visit(root);
  const matchingDirectories = new Set(files.filter((file) => file.content.includes(candidateId)).map((file) => file.directory));
  return files
    .filter((file) => matchingDirectories.has(file.directory))
    .map(({ name, relativePath, content }) => ({ name, relativePath, content }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export function findCandidateReviewPackageDocuments(home, inspection) {
  if (!inspection || listOrEmpty(inspection.issues).length > 0 || !inspection.package) {
    throw new Error(`Candidate review package is not current: ${listOrEmpty(inspection?.issues).join("; ") || "missing"}`);
  }
  const review = inspection.package;
  const artifacts = [review.guide, ...(review.draft ? [review.draft] : []), ...listOrEmpty(review.validations)];
  return artifacts.map((artifact) => readRegisteredReviewArtifact(home, artifact));
}

function readRegisteredReviewArtifact(home, artifact) {
  if (!artifact || typeof artifact.path !== "string" || typeof artifact.contentHash !== "string") {
    throw new Error("Candidate review package contains an invalid Artifact view");
  }
  const root = realpathSync(resolve(home));
  const path = resolve(artifact.path);
  if (!existsSync(path)) throw new Error(`Registered review Artifact is missing: ${artifact.id}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Registered review Artifact must be a regular file: ${artifact.id}`);
  const actual = realpathSync(path);
  const remainder = relative(root, actual);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) throw new Error(`Registered review Artifact must stay inside IKB home: ${artifact.id}`);
  if (stat.size > MAX_REVIEW_BYTES) throw new Error(`Registered review Artifact is too large: ${artifact.id}`);
  const content = readFileSync(path, "utf8");
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (contentHash !== artifact.contentHash) throw new Error(`Registered review Artifact hash changed: ${artifact.id}`);
  return { name: basename(path), relativePath: remainder, content, artifactId: artifact.id, kind: artifact.kind };
}

function reviewPageShell(title, content) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6f8;color:#1f2937}body{margin:0}main{max-width:1080px;margin:0 auto;padding:24px}a{color:#2563eb}h1{font-size:24px;margin:0 0 8px}.muted{color:#6b7280;font-size:13px}.facts{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.fact{min-width:220px;flex:1;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px}section{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:14px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:0;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.back{display:inline-block;margin-bottom:16px}
  </style></head><body><main><a class="back" href="/">← 返回 IKB 观测</a>${content}</main></body></html>`;
}

export function renderCandidateReviewPage(candidate, documents = []) {
  const targetLinks = Array.isArray(candidate.targetKnowledgeIds)
    ? candidate.targetKnowledgeIds.map((id) => KNOWLEDGE_ID_PATTERN.test(String(id)) ? `<a href="/review/knowledge/${encodeURIComponent(id)}" target="_blank">${escapeHtml(id)}</a>` : escapeHtml(id)).join("、")
    : "新知识";
  const claim = candidate.candidateKnowledge?.claim ?? "候选包含多个主张，请查看完整评审材料";
  const documentSections = documents.length > 0
    ? documents.map((document) => `<section><h2>${escapeHtml(document.name)}</h2><div class="muted">${escapeHtml(document.relativePath)}</div><pre>${escapeHtml(document.content)}</pre></section>`).join("")
    : '<section><div class="muted">没有找到包含该候选 ID 的本地评审文件；请先查看候选主张与目标 Knowledge。</div></section>';
  return reviewPageShell(candidate.title ?? candidate.id, `<h1>${escapeHtml(candidate.title ?? candidate.id)}</h1><div class="muted">${escapeHtml(candidate.id)} · 本地只读 · 不在此页面执行接受或驳回</div><div class="facts"><div class="fact"><strong>状态</strong><div>${escapeHtml(candidate.status ?? "unknown")}</div></div><div class="fact"><strong>变更</strong><div>${escapeHtml((candidate.changeTypes ?? []).join("、") || "未声明")}</div></div><div class="fact"><strong>目标 Knowledge</strong><div>${targetLinks || "新知识"}</div></div></div><section><h2>候选主张</h2><p>${escapeHtml(claim)}</p></section>${documentSections}`);
}

export function renderKnowledgeReviewPage(record) {
  return reviewPageShell(record.title ?? record.id, `<h1>${escapeHtml(record.title ?? record.id)}</h1><div class="muted">${escapeHtml(record.id)} · 本地只读</div><div class="facts"><div class="fact"><strong>状态</strong><div>${escapeHtml(record.status ?? "unknown")}</div></div><div class="fact"><strong>范围</strong><div>${escapeHtml(record.scope ?? "unknown")}</div></div><div class="fact"><strong>验证</strong><div>${escapeHtml(record.verification ?? "unverified")}</div></div></div><section><pre>${escapeHtml(record.body ?? "")}</pre></section>`);
}

export function renderReportHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IKB 运行观测</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f8; color: #1f2937; }
    body { margin: 0; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 24px; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    a { color: #2563eb; }
    .muted { color: #6b7280; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 14px 0 24px; }
    .card, section { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 2px 8px #1118270d; }
    .card { padding: 15px; }
    .metric { font-size: 27px; font-weight: 650; margin-top: 4px; }
    section { padding: 18px; margin: 14px 0; }
    .row { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; padding: 10px 0; border-bottom: 1px solid #f0f2f4; }
    .row:last-child { border-bottom: 0; }
    .tag { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
    .tag.error, .tag.quality { background: #fee2e2; color: #991b1b; }
    .tag.waiting, .tag.review, .tag.candidate { background: #fef3c7; color: #92400e; }
    .tag.active { background: #dcfce7; color: #166534; }
    .empty { padding: 12px 0; color: #6b7280; }
    details pre { white-space: pre-wrap; max-height: 420px; overflow: auto; background: #f8fafc; padding: 12px; border-radius: 8px; font-size: 12px; }
    footer { margin-top: 20px; }
  </style>
</head>
<body>
<main>
  <header>
    <div><h1>IKB 运行观测</h1><div id="generated" class="muted">加载中…</div></div>
    <div><span class="muted">本地只读观测 · 每 15 秒刷新</span></div>
  </header>
  <div id="metrics" class="grid"></div>
  <section><h2>需要注意</h2><div id="attention"></div></section>
  <section><h2>全局推理与确认项</h2><div id="reasoning"></div></section>
  <section><h2>任务</h2><div id="tasks"></div></section>
  <section><h2>知识检索与使用（近 7 天）</h2><div id="knowledge-usage"></div></section>
  <section><h2>Knowledge 待复核</h2><div id="knowledge"></div></section>
  <section><h2>来源覆盖与外部读取</h2><div id="coverage"></div><div id="external-reads" style="margin-top:14px"></div></section>
  <section><h2>人物证据与周期蒸馏</h2><div id="people-readiness"></div></section>
  <section><h2>来源候选</h2><div id="candidates"></div></section>
  <section><h2>Experience 分析队列</h2><div id="experience"></div><h2 style="margin-top:18px">Knowledge Candidate 待复核</h2><div id="experience-candidates"></div></section>
  <section><h2>系统健康</h2><div id="health"></div></section>
  <details><summary>查看本次观测 JSON（不含 Source/Knowledge 正文）</summary><pre id="raw"></pre></details>
  <footer class="muted">IKB Ledger 是真相源；本页只读本机状态，未启用外部写操作。</footer>
</main>
<script>
const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fmt = value => value == null ? '—' : (typeof value === 'number' ? value.toLocaleString('zh-CN') : esc(value));
const tag = (value, cls='') => '<span class="tag '+esc(cls || value)+'">'+fmt(value)+'</span>';
const reviewLink = (kind, id, label) => '<a href="/review/'+encodeURIComponent(kind)+'/'+encodeURIComponent(id)+'" target="_blank" rel="noopener">'+esc(label)+'</a>';
const rows = (items, render, empty='暂无') => items && items.length ? items.map(render).join('') : '<div class="empty">'+empty+'</div>';
function render(data) {
  document.querySelector('#generated').textContent = '最近读取：' + new Date(data.generatedAt).toLocaleString('zh-CN') + (data.status.error ? ' · 状态读取异常' : '');
  const s = data.status || {}, d = data.weekly || {}, q = d.runs?.quality || {};
  const ku = d.knowledgeUsage || {}, queries = ku.queries || {};
  document.querySelector('#metrics').innerHTML = [
    ['待复核 Knowledge', s.knowledgeDue], ['来源候选', s.candidates], ['Waiting Task', s.tasks?.waiting || 0], ['Active Task', s.tasks?.active || 0],
    ['Run 质量通过', q.pass || 0], ['Run 质量阻断', q.block || 0], ['知识查询', queries.total || 0], ['真实使用', ku.uses || 0], ['未分类引用', ku.unresolvedReferences || 0], ['Experience 待分析', data.experience?.queued || 0], ['知识暂停召回', data.knowledgeHolds?.length || 0], ['推理待确认', data.reasoning?.summary?.askUser || 0], ['会话欠账', data.coverage?.histories?.backlog], ['账本事件', data.doctor?.events]
  ].map(([label,value]) => '<div class="card"><div class="muted">'+esc(label)+'</div><div class="metric">'+fmt(value)+'</div></div>').join('');
  document.querySelector('#attention').innerHTML = rows(data.attention, item => '<div class="row"><div>'+tag(item.severity, item.severity)+' '+esc(item.title)+'<div class="muted">'+esc(item.detail)+'</div></div><span class="muted">'+esc(item.kind)+'</span></div>', '当前没有结构化待处理项');
  document.querySelector('#tasks').innerHTML = rows(data.tasks.filter(item => item.status !== 'done' && item.status !== 'canceled'), item => '<div class="row"><div>'+tag(item.status, item.status)+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.type)+'</div></div><span class="muted">'+fmt(item.updatedAt)+'</span></div>', '没有 active/waiting Task');
  document.querySelector('#knowledge-usage').innerHTML = '<div class="muted">查询 '+fmt(queries.total)+'（零结果 '+fmt(queries.zeroResult)+'，比例 '+fmt(Math.round((queries.zeroResultRate || 0) * 100))+'%） · 引用 '+fmt(ku.references)+' · 真实使用 '+fmt(ku.uses)+' · 引用转使用 '+fmt(Math.round((ku.referenceToUseRate || 0) * 100))+'% · 反馈完成 '+fmt(Math.round((ku.feedbackCompletionRate || 0) * 100))+'%</div>'
    + '<div class="row"><div>查询方式<div class="muted">'+esc(Object.entries(queries.byMode || {}).map(([key,value]) => key+' '+value).join(' · ') || '暂无查询')+'</div></div>'+tag('零结果 '+fmt(queries.zeroResult), queries.zeroResult > 0 ? 'review' : 'active')+'</div>'
    + '<div class="row"><div>真实使用用途<div class="muted">'+esc(Object.entries(ku.useByPurpose || {}).map(([key,value]) => key+' '+value).join(' · ') || '暂无实际使用')+'</div></div>'+tag('使用 '+fmt(ku.uses), ku.uses > 0 ? 'active' : 'waiting')+'</div>'
    + '<div class="row"><div>最终效果<div class="muted">'+esc(Object.entries(ku.feedback || {}).map(([key,value]) => key+' '+value).join(' · ') || '暂无反馈')+'</div></div>'+tag('未分类 '+fmt(ku.unresolvedReferences), ku.unresolvedReferences > 0 ? 'quality' : 'active')+'</div>';
  document.querySelector('#knowledge').innerHTML = rows(data.knowledge, item => '<div class="row"><div>'+tag(item.status, item.status === 'draft' ? 'review' : '')+' '+reviewLink('knowledge', item.id, item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.collection)+'</div></div><span class="muted">'+esc(item.verification || 'unverified')+'</span></div>', '没有待复核 Knowledge');
  const coverage = data.coverage || {};
  document.querySelector('#coverage').innerHTML = coverage.error
    ? '<div class="empty">'+esc(coverage.error)+'</div>'
    : '<div class="muted">覆盖账 '+fmt(coverage.generatedAt)+' · Source '+fmt(coverage.sources?.total)+' / Record '+fmt(coverage.sources?.records)+' · 会话：已覆盖 '+fmt(coverage.histories?.covered)+'、确认空 '+fmt(coverage.histories?.empty)+'、欠账 '+fmt(coverage.histories?.backlog)+'</div>'
      + rows(coverage.targets, item => '<div class="row"><div>'+tag(item.coverageState, item.coverageState === 'backlog' ? 'error' : item.coverageState === 'empty' ? 'waiting' : 'active')+' '+esc(item.name)+'<div class="muted">'+fmt(item.matchedSources)+' Source · '+fmt(item.records)+' Record</div></div><span class="muted">'+fmt(item.lastImportedAt)+'</span></div>', '没有来源目标')
      + rows(coverage.blockers, item => '<div class="row"><div>'+tag('阻断', 'waiting')+' '+esc(item.detail)+'</div><span class="muted">'+esc(item.code)+'</span></div>', '来源盘点没有阻断');
  const citadel = data.externalReads?.citadel || {}, elephant = data.externalReads?.elephant || {};
  document.querySelector('#external-reads').innerHTML = '<div class="row"><div>学城只读额度<div class="muted">滚动 '+fmt(citadel.windowMinutes)+' 分钟最多 '+fmt(citadel.max)+' 篇，文档间隔至少 '+fmt((citadel.minimumDelayMs || 0) / 1000)+' 秒</div></div>'+tag('剩余 '+fmt(citadel.remaining), citadel.remaining > 0 ? 'active' : 'waiting')+'</div>'
    + '<div class="row"><div>大象读取边界<div class="muted">仅登记的人/群，有界增量；发送、回复、点赞、修改全部禁止</div></div>'+tag(elephant.readOnly ? '只读' : '异常', elephant.readOnly ? 'active' : 'error')+'</div>';
  const people = data.people || {};
  document.querySelector('#people-readiness').innerHTML = people.error
    ? '<div class="empty">'+esc(people.error)+'</div>'
    : '<div class="muted">证据刷新 '+fmt(people.generatedAt)+' · 待语义分析 '+fmt(people.summary?.analysisDue)+' · 已最新 '+fmt(people.summary?.upToDate)+' · 继续积累 '+fmt(people.summary?.accumulating)+' · 数量门槛不等于知识准入</div>'
      + rows(people.people, item => '<div class="row"><div>'+tag(item.state, item.state === 'analysis_due' ? 'review' : item.state === 'up_to_date' ? 'active' : 'waiting')+' '+esc(item.name)+'<div class="muted">结构 Episode '+fmt(item.directEpisodes)+' · 独立来源 '+fmt(item.independentSources)+' · 日期 '+fmt(item.distinctDates)+' · 相对上次 +'+fmt(item.newDirectEpisodes)+' / +'+fmt(item.newIndependentSources)+'</div></div><span class="muted">'+esc(item.nextAction)+'</span></div>', '没有登记人物证据');
  document.querySelector('#candidates').innerHTML = '<div class="muted">总数 '+fmt(data.candidates?.total)+' · '+Object.entries(data.candidates?.byStatus || {}).map(([k,v]) => k+' '+v).join(' · ')+'</div>' + rows(data.candidates?.recent, item => '<div class="row"><div>'+tag(item.status, 'candidate')+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.kind)+'</div></div><span class="muted">'+esc(item.nextAction || '')+'</span></div>', '没有候选');
  document.querySelector('#experience').innerHTML = '<div class="muted">Triage 记录 '+fmt(data.experience?.total)+' · 命中 '+fmt(data.experience?.selected)+' · 已排除 '+fmt(data.experience?.ignored)+' · 待分析 '+fmt(data.experience?.queued)+' · 已分析 '+fmt(data.experience?.analyzed)+' · 信号 '+Object.entries(data.experience?.bySignal || {}).map(([k,v]) => k+' '+v).join(' · ')+'</div>' + rows(data.experience?.recent, item => '<div class="row"><div>'+tag('待分析', 'review')+' '+esc(item.sourceTitle)+'<div class="muted">'+esc(item.id)+' · 优先级 '+fmt(item.priority)+' · '+esc((item.priorityReasons || []).join('；'))+'</div></div><span class="muted">Run '+fmt(item.runCount)+'</span></div>', '没有待分析 Experience');
  document.querySelector('#experience-candidates').innerHTML = '<div class="muted">总数 '+fmt(data.experienceCandidates?.total)+' · 待确认 '+fmt(data.experienceCandidates?.pendingReview)+' · 已接受待落库 '+fmt(data.experienceCandidates?.accepted)+' · 已应用 '+fmt(data.experienceCandidates?.applied)+' · 已驳回 '+fmt(data.experienceCandidates?.rejected)+'</div>'
    + rows(data.experienceCandidates?.recent, item => '<div class="row"><div>'+tag(item.status, item.status === 'applied' ? 'active' : item.status === 'rejected' ? 'waiting' : 'candidate')+' '+reviewLink('candidate', item.id, item.title)+'<div class="muted">'+esc(item.id)+' · '+esc((item.changeTypes || []).join('、'))+' · 目标 '+esc((item.targetKnowledgeIds || []).join('、') || '新知识')+'</div><div>'+esc(item.claim || '候选包含多个主张，需先合并')+'</div>'+(item.decisionReason ? '<div class="muted">确认理由：'+esc(item.decisionReason)+'</div>' : '')+'</div><span class="muted">'+esc(item.nextAction || '')+'</span></div>', '没有 Knowledge Candidate')
    + (data.knowledgeHolds?.length ? '<div class="muted" style="margin-top:12px">以下旧知识已暂停进入 Agent 上下文：</div>'+rows(data.knowledgeHolds, item => '<div class="row"><div>'+tag('暂停召回','quality')+' '+esc(item.knowledgeId)+'<div class="muted">由 '+esc(item.candidateId)+' 触发</div></div><span class="muted">'+esc((item.changeTypes || []).join('、'))+'</span></div>','') : '');
  const reasoning = data.reasoning || {};
  const reasoningSummary = reasoning.summary || {};
  const reasoningBundles = reasoning.decisionBundles || [];
  document.querySelector('#reasoning').innerHTML = reasoning.error
    ? '<div class="empty">'+esc(reasoning.error)+'</div>'
    : '<div class="muted">报告 '+esc(reasoning.id || '—')+' · Source '+fmt(reasoning.inputs?.sources)+' · Experience '+fmt(reasoning.inputs?.experiences)+' · Knowledge 当前 '+fmt(reasoning.inputs?.knowledgeActive)+'</div>'
      + '<div class="muted" style="margin-top:8px">自动处理 '+fmt(reasoningSummary.autoResolved)+' · 延后到 Task '+fmt(reasoningSummary.deferred)+' · 真正待确认 '+fmt(reasoningSummary.askUser)+'</div>'
      + rows(reasoningBundles, bundle => '<div class="row"><div>'+tag('待确认', 'review')+' '+esc(bundle.title)+'<div class="muted">'+esc(bundle.decision || '')+' · '+fmt(bundle.itemCount)+' 项 · '+esc(bundle.consequence || '')+'</div>'+rows(bundle.questions, question => '<div class="muted" style="margin:5px 0 0 18px">'+(question.candidateId ? reviewLink('candidate', question.candidateId, question.knowledgeTitle) : esc(question.knowledgeTitle))+' #'+esc(question.number)+'：'+esc(question.text)+'</div>', '')+'</div><span class="muted">'+esc(bundle.scope || '')+' · '+esc(bundle.category || '')+'</span></div>', '当前没有必须立即确认的事项');
  const health = data.doctor || {}, ledger = data.ledger || {};
  const healthState = value => value.stale ? ['待刷新','waiting'] : value.ok ? ['ok','active'] : ['error','error'];
  const doctorState = healthState(health), ledgerState = healthState(ledger);
  document.querySelector('#health').innerHTML = '<div class="muted">最近完整校验：'+fmt(data.healthUpdatedAt)+'</div><div class="row"><div>doctor</div>'+tag(doctorState[0], doctorState[1])+'</div><div class="row"><div>ledger</div>'+tag(ledgerState[0], ledgerState[1])+'</div><div class="row"><div>knowledge layout</div>'+tag(health.knowledgeLayoutOk ? 'ok' : health.stale ? '待刷新' : 'error', health.knowledgeLayoutOk ? 'active' : health.stale ? 'waiting' : 'error')+'</div>';
  document.querySelector('#raw').textContent = JSON.stringify(data, null, 2);
}
async function load() { try { const response = await fetch('/api/report?ts='+Date.now(), {cache:'no-store'}); render(await response.json()); } catch (error) { document.querySelector('#generated').textContent = '加载失败：'+error.message; } }
load(); setInterval(load, 15000);
</script>
</body>
</html>`;
}

export function startServer({ home, port = DEFAULT_PORT } = {}) {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      response.end("GET only\n");
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    if (pathname === "/api/report") {
      const payload = buildReport(home);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
      return;
    }
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "ikb-report", generatedAt: new Date().toISOString() }));
      return;
    }
    if (pathname.startsWith("/review/candidate/")) {
      const id = decodePathSegment(pathname, "/review/candidate/");
      if (!CANDIDATE_ID_PATTERN.test(id)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Invalid candidate id\n");
        return;
      }
      const candidate = runIkb(home, ["experience", "candidate-show", id]);
      if (candidate.error) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Candidate not found\n");
        return;
      }
      let documents;
      try {
        const review = runIkb(home, ["experience", "candidate-review-show", id]);
        if (review.error) throw new Error(review.error);
        if (review.package) documents = findCandidateReviewPackageDocuments(home, review);
        else if (listOrEmpty(review.issues).length > 0) throw new Error(listOrEmpty(review.issues).join("; "));
        else documents = findCandidateReviewDocuments(home, id);
      } catch (error) {
        response.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(`Review files unavailable: ${error.message}\n`);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      response.end(renderCandidateReviewPage(candidate, documents));
      return;
    }
    if (pathname.startsWith("/review/knowledge/")) {
      const id = decodePathSegment(pathname, "/review/knowledge/");
      if (!KNOWLEDGE_ID_PATTERN.test(id)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Invalid knowledge id\n");
        return;
      }
      const record = runIkb(home, ["knowledge", "show", id]);
      if (record.error) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Knowledge not found\n");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      });
      response.end(renderKnowledgeReviewPage(record));
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderReportHtml());
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`IKB report: http://127.0.0.1:${port}`);
    console.log("只读本机 Ledger；打开页面时实时读取，15 秒自动刷新。");
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startServer(parseArgs());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
