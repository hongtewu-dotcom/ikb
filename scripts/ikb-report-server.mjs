#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");
const DEFAULT_PORT = 3417;

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
  return {
    total: items.length,
    pendingReview: items.filter((candidate) => candidate.status === "pending_review").length,
    recent: items.slice().sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))).slice(0, 20).map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      title: candidate.title,
      signalCodes: candidate.signalCodes,
      independentRunCount: candidate.independentRunCount,
      nextAction: candidate.nextAction,
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
  const rawStatus = runIkb(home, ["status"]);
  const tasks = runIkb(home, ["task", "list"]);
  const weekly = runIkb(home, ["observe", "weekly"]);
  const daily = runIkb(home, ["observe", "daily"]);
  const knowledge = runIkb(home, ["knowledge", "review", "--scope", "work"]);
  const candidates = runIkb(home, ["candidate", "list", "--scope", "work"]);
  const experiences = runIkb(home, ["experience", "list", "--scope", "work"]);
  const experienceCandidates = runIkb(home, ["experience", "candidate-list", "--scope", "work"]);
  const reasoning = compactReasoning(runIkb(home, ["reasoning", "show", "--scope", "work"]));
  const doctor = compactDoctor(runIkb(home, ["doctor"]));
  const ledger = compactLedger(runIkb(home, ["ledger", "verify"]));
  const taskRows = summarizeTasks(tasks);
  const knowledgeRows = summarizeKnowledge(knowledge);
  const candidateSummary = summarizeCandidates(candidates);
  const experienceSummary = summarizeExperiences(experiences);
  const experienceCandidateSummary = summarizeExperienceCandidates(experienceCandidates);
  const status = rawStatus?.error ? rawStatus : { ...rawStatus, tasksList: taskRows };
  return {
    schema: "ikb-live-report.v1",
    generatedAt: new Date().toISOString(),
    home: home.replaceAll(/[^/\\]+/g, "…"),
    status: {
      knowledgeDue: status.knowledgeDue ?? knowledgeRows.length,
      candidates: status.candidates ?? candidateSummary.total,
      tasks: status.tasks ?? {},
      runs: status.runs ?? {},
      approvals: status.approvals ?? {},
      recentFailures: status.recentFailures ?? [],
      error: status.error ?? null,
    },
    tasks: taskRows,
    knowledge: knowledgeRows,
    candidates: candidateSummary,
    experience: experienceSummary,
    experienceCandidates: experienceCandidateSummary,
    reasoning,
    daily: daily?.error ? { error: daily.error } : daily,
    weekly: weekly?.error ? { error: weekly.error } : weekly,
    doctor,
    ledger,
    attention: buildAttention({ status, weekly, knowledge, candidates: candidateSummary, experiences: experienceSummary, experienceCandidates: experienceCandidateSummary, reasoning, doctor, ledger }),
  };
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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
  <section><h2>Knowledge 待复核</h2><div id="knowledge"></div></section>
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
const rows = (items, render, empty='暂无') => items && items.length ? items.map(render).join('') : '<div class="empty">'+empty+'</div>';
function render(data) {
  document.querySelector('#generated').textContent = '最近读取：' + new Date(data.generatedAt).toLocaleString('zh-CN') + (data.status.error ? ' · 状态读取异常' : '');
  const s = data.status || {}, d = data.weekly || {}, q = d.runs?.quality || {};
  document.querySelector('#metrics').innerHTML = [
    ['待复核 Knowledge', s.knowledgeDue], ['来源候选', s.candidates], ['Waiting Task', s.tasks?.waiting || 0], ['Active Task', s.tasks?.active || 0],
    ['Run 质量通过', q.pass || 0], ['Run 质量阻断', q.block || 0], ['Experience 待分析', data.experience?.queued || 0], ['推理待确认', data.reasoning?.summary?.askUser || 0], ['账本事件', data.doctor?.events]
  ].map(([label,value]) => '<div class="card"><div class="muted">'+esc(label)+'</div><div class="metric">'+fmt(value)+'</div></div>').join('');
  document.querySelector('#attention').innerHTML = rows(data.attention, item => '<div class="row"><div>'+tag(item.severity, item.severity)+' '+esc(item.title)+'<div class="muted">'+esc(item.detail)+'</div></div><span class="muted">'+esc(item.kind)+'</span></div>', '当前没有结构化待处理项');
  document.querySelector('#tasks').innerHTML = rows(data.tasks.filter(item => item.status !== 'done' && item.status !== 'canceled'), item => '<div class="row"><div>'+tag(item.status, item.status)+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.type)+'</div></div><span class="muted">'+fmt(item.updatedAt)+'</span></div>', '没有 active/waiting Task');
  document.querySelector('#knowledge').innerHTML = rows(data.knowledge, item => '<div class="row"><div>'+tag(item.status, item.status === 'draft' ? 'review' : '')+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.collection)+'</div></div><span class="muted">'+esc(item.verification || 'unverified')+'</span></div>', '没有待复核 Knowledge');
  document.querySelector('#candidates').innerHTML = '<div class="muted">总数 '+fmt(data.candidates?.total)+' · '+Object.entries(data.candidates?.byStatus || {}).map(([k,v]) => k+' '+v).join(' · ')+'</div>' + rows(data.candidates?.recent, item => '<div class="row"><div>'+tag(item.status, 'candidate')+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc(item.kind)+'</div></div><span class="muted">'+esc(item.nextAction || '')+'</span></div>', '没有候选');
  document.querySelector('#experience').innerHTML = '<div class="muted">总数 '+fmt(data.experience?.total)+' · queued '+fmt(data.experience?.queued)+' · 信号 '+Object.entries(data.experience?.bySignal || {}).map(([k,v]) => k+' '+v).join(' · ')+'</div>' + rows(data.experience?.recent, item => '<div class="row"><div>'+tag(item.status, item.status === 'queued' ? 'review' : '')+' '+esc(item.sourceTitle)+'<div class="muted">'+esc(item.id)+' · '+esc(item.adapter || 'direct')+' · '+esc((item.signalCodes || []).join('、'))+'</div></div><span class="muted">Run '+fmt(item.runCount)+'</span></div>', '没有待分析 Experience');
  document.querySelector('#experience-candidates').innerHTML = '<div class="muted">总数 '+fmt(data.experienceCandidates?.total)+' · pending_review '+fmt(data.experienceCandidates?.pendingReview)+'</div>' + rows(data.experienceCandidates?.recent, item => '<div class="row"><div>'+tag(item.status, 'candidate')+' '+esc(item.title)+'<div class="muted">'+esc(item.id)+' · '+esc((item.signalCodes || []).join('、'))+' · 独立 Run '+fmt(item.independentRunCount)+'</div></div><span class="muted">'+esc(item.nextAction || '')+'</span></div>', '没有待复核 Knowledge Candidate');
  const reasoning = data.reasoning || {};
  const reasoningSummary = reasoning.summary || {};
  const reasoningBundles = reasoning.decisionBundles || [];
  document.querySelector('#reasoning').innerHTML = reasoning.error
    ? '<div class="empty">'+esc(reasoning.error)+'</div>'
    : '<div class="muted">报告 '+esc(reasoning.id || '—')+' · Source '+fmt(reasoning.inputs?.sources)+' · Experience '+fmt(reasoning.inputs?.experiences)+' · Knowledge 当前 '+fmt(reasoning.inputs?.knowledgeActive)+'</div>'
      + '<div class="muted" style="margin-top:8px">自动处理 '+fmt(reasoningSummary.autoResolved)+' · 延后到 Task '+fmt(reasoningSummary.deferred)+' · 真正待确认 '+fmt(reasoningSummary.askUser)+'</div>'
      + rows(reasoningBundles, bundle => '<div class="row"><div>'+tag('待确认', 'review')+' '+esc(bundle.title)+'<div class="muted">'+esc(bundle.decision || '')+' · '+fmt(bundle.itemCount)+' 项 · '+esc(bundle.consequence || '')+'</div>'+rows(bundle.questions, question => '<div class="muted" style="margin:5px 0 0 18px">'+esc(question.knowledgeTitle)+' #'+esc(question.number)+'：'+esc(question.text)+'</div>', '')+'</div><span class="muted">'+esc(bundle.category || '')+'</span></div>', '当前没有必须立即确认的事项');
  const health = data.doctor || {}, ledger = data.ledger || {};
  document.querySelector('#health').innerHTML = '<div class="row"><div>doctor</div>'+tag(health.ok ? 'ok' : 'error', health.ok ? 'active' : 'error')+'</div><div class="row"><div>ledger</div>'+tag(ledger.ok ? 'ok' : 'error', ledger.ok ? 'active' : 'error')+'</div><div class="row"><div>knowledge layout</div>'+tag(health.knowledgeLayoutOk ? 'ok' : 'error', health.knowledgeLayoutOk ? 'active' : 'error')+'</div>';
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
    if (request.url?.startsWith("/api/report")) {
      const payload = buildReport(home);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "ikb-report", generatedAt: new Date().toISOString() }));
      return;
    }
    if (request.url === "/" || request.url?.startsWith("/index.html")) {
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
