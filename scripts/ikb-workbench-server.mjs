#!/usr/bin/env node

// Local, read-only HTTP projection for the workbench.  The snapshot builder
// remains the only owner of the source projection; this server never writes a
// generated workbench artifact and never exposes an arbitrary file path.
import { createServer } from "node:http";
import { dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, openSync, readSync, closeSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSnapshot, renderHtml } from "./ikb-workbench.mjs";
import { DEFAULT_INTAKE_ROOT } from "./ikb-requests.mjs";

export const DEFAULT_PORT = 43127;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const LIVE_SECTION_IDS = ["decisions", "agent-continue", "topics", "recent-runs", "metrics", "stock"];

function fail(message) {
  throw new Error(`ikb-workbench-server: ${message}`);
}

function asPort(value, field = "port") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`${field} must be an integer from 0 to 65535`);
  return port;
}

function hostPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}

function parseAuthority(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 255) return null;
  let url;
  try { url = new URL(`http://${value}`); } catch { return null; }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: url.hostname.toLowerCase(), port };
}

function validHost(request, server) {
  const authority = parseAuthority(request.headers.host, "Host");
  const port = hostPort(server);
  return authority !== null && port !== null && authority.port === port;
}

function validOrigin(request, server) {
  const origin = request.headers.origin;
  // Non-browser clients and same-origin navigations commonly have no Origin.
  if (origin === undefined) return true;
  const authority = parseAuthority(origin.replace(/^https?:\/\//u, ""), "Origin");
  if (!/^http:\/\//iu.test(origin)) return false;
  const port = hostPort(server);
  return authority !== null && port !== null && authority.port === port;
}

function headers(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8", extra = {}) {
  response.writeHead(status, { ...headers(contentType), ...extra });
  response.end(body);
}

function sendJson(response, status, body) {
  sendText(response, status, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function decorateHtml(html, snapshot, sources) {
  let result = String(html);
  const sectionHeadings = ["需要你决定", "系统处理记录", "人物与主题", "最近成果", "概览", "知识库现状"];
  for (const [index, heading] of sectionHeadings.entries()) {
    const marker = `<section><h2>${heading}</h2>`;
    const replacement = `<section id="${LIVE_SECTION_IDS[index]}" data-live-section="${LIVE_SECTION_IDS[index]}"><h2>${heading}</h2>`;
    result = result.replace(marker, replacement);
  }
  result = result
    .replace("</style>", ".live-status{margin-top:12px;padding:7px 10px;border-radius:9px;font-size:13px}.live-status[data-state=connected]{color:#166534;background:#f0fdf4}.live-status[data-state=stale]{color:#b42318;background:#fef3f2;border:1px solid #fecdca}.live-status a{color:inherit;font-weight:600}</style>")
    .replaceAll("<title>IKB 轻量工作台</title>", "<title>IKB 实时工作台</title>")
    .replaceAll("<h1>IKB 轻量工作台</h1>", "<h1>IKB 实时工作台</h1>")
    .replace("只读静态快照；页面不提交发布、不执行复制指令。", "只读实时数据；页面不提交发布、不执行复制指令。")
    .replace("生成时间：", "最近快照：")
    .replace("静态快照说明：浏览器刷新不会重新读取来源；重新运行 <code>node scripts/ikb-workbench.mjs</code> 才会生成新的 index.html、summary.md 和 snapshot.json。", "实时工作台说明：页面每 5 秒读取现有来源；数据读取失败时保留上次成功内容。")
    .replace("完成状态只采用现有请求状态、运行回执和最终报告中的明确字段；没有证据时显示未知。", "完成状态只采用现有请求状态、运行回执和最终报告中的明确字段；没有证据时显示未知。")
    .replace("</header>", `</header>${liveStatus(snapshot)}`);
  for (const topic of snapshot.topics ?? []) for (const doc of topic.documents ?? []) registerSource(doc.path, sources);
  return rewriteSources(result, sources);
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function registerSource(path, sources) {
  const absolute = resolve(path);
  const id = createHash("sha256").update(absolute).digest("hex");
  if (!sources.has(id)) {
    let real = null;
    try { real = realpathSync(absolute); } catch { /* retain missing reference */ }
    sources.set(id, { path: absolute, real });
  }
  return `/source/${id}`;
}

function rewriteSources(html, sources) {
  return html.replace(/href="(file:\/\/[^"\n]+)"/gu, (_match, encoded) => {
    const value = encoded.replace(/&amp;/gu, "&").replace(/&#39;/gu, "'").replace(/&quot;/gu, '"').replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
    try {
      const url = new URL(value);
      const path = fileURLToPath(url);
      return `href="${registerSource(path, sources)}"`;
    } catch { return 'href="#"'; }
  });
}

function sourcePage(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{max-width:1100px;margin:32px auto;padding:0 20px;font:16px/1.65 system-ui;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f7fb;padding:20px}a{color:#4f46e5}h1{font-size:22px;overflow-wrap:anywhere}li{overflow-wrap:anywhere}</style><a href="/">返回工作台</a><h1>${htmlEscape(title)}</h1>${body}</html>`;
}

function serveSource(response, id, sources) {
  const entry = sources.get(id);
  if (!entry) { sendText(response, 404, "未登记的来源链接"); return; }
  const path = entry.path;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !entry.real || realpathSync(path) !== entry.real) {
      sendText(response, 403, "来源路径已变化，请返回工作台核对"); return;
    }
    let body;
    if (stat.isDirectory()) {
      const children = [...sources].filter(([, value]) => dirname(value.path) === path);
      body = `<p>此目录中工作台已关联的文件：</p><ul>${children.map(([key, value]) => `<li><a href="/source/${key}">${htmlEscape(basename(value.path))}</a></li>`).join("")}</ul>`;
    } else if (stat.isFile()) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try { const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024)); const count = readSync(fd, buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, count); }
      finally { closeSync(fd); }
      if (bytes.includes(0)) { sendText(response, 415, "此来源不是文本文件，暂不支持在线预览"); return; }
      body = `${stat.size > bytes.length ? '<p>文件较大，仅展示前 2 MiB。</p>' : ''}<pre>${htmlEscape(bytes.toString("utf8"))}</pre>`;
    } else { sendText(response, 415, "不支持此来源类型"); return; }
    sendText(response, 200, sourcePage(path, body), "text/html; charset=utf-8", {"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"});
  } catch (error) {
    sendText(response, error.code === "ENOENT" ? 404 : 503, sourcePage(path, `<p>${error.code === "ENOENT" ? '文件不存在或已被清理。请返回工作台核对来源。' : '文件读取失败：'+htmlEscape(error.message)}</p>`), "text/html; charset=utf-8");
  }
}

function liveStatus(snapshot) {
  return `<div id="live-status" class="live-status" data-state="connected" data-last-success="${htmlEscape(snapshot.generatedAt)}" role="status"><span data-live-message>实时连接：已连接 · 最近成功更新：${htmlEscape(snapshot.generatedAt)}</span><span class="live-links"> · <a href="#decisions">需要你决定</a> · <a href="#stock">知识库现状</a> · <a href="#recent-runs">最近成果</a> · <a href="#topics">人物与主题</a></span></div>`;
}

const LIVE_SCRIPT = String.raw`<script>
(()=>{
  const pollMs=5000;
  const status=document.getElementById('live-status');
  const message=status?.querySelector('[data-live-message]');
  let inFlight=false;
  let lastContentKey=null;
  let lastSuccess=status?.dataset.lastSuccess||message?.textContent?.split('：').at(-1)||'';
  const sectionIds=['decisions','agent-continue','topics','recent-runs','metrics','stock'];
  const detailsKey=(item)=>{
    const owner=item.closest('[data-searchable]');
    return (owner?.getAttribute('data-searchable')||'')+'|'+(item.querySelector('summary')?.textContent||'');
  };
  const openDetails=()=>new Set([...document.querySelectorAll('main details[open]')].map(detailsKey));
  const bindCopyButtons=(root=document)=>root.querySelectorAll('.copy').forEach((button)=>{
    if(button.dataset.liveBound==='1') return;
    button.dataset.liveBound='1';
    button.addEventListener('click',async()=>{
      const value=button.dataset.copy||'';
      try{await navigator.clipboard.writeText(value);button.textContent='已复制'}
      catch{button.textContent='请手动复制';window.prompt('复制处理指令',value)}
      setTimeout(()=>{button.textContent=button.dataset.label||'复制处理指令'},1500);
    });
  });
  const contentKey=(payload)=>{
    const value=JSON.parse(JSON.stringify(payload?.snapshot||{}));
    delete value.generatedAt;
    return JSON.stringify(value);
  };
  const setStatus=(state,text)=>{
    if(!status||!message)return;
    status.dataset.state=state;
    message.textContent=text;
  };
  const replaceSections=(html)=>{
    const parsed=new DOMParser().parseFromString(html,'text/html');
    const current=sectionIds.map((id)=>document.querySelector('main > section[data-live-section="'+id+'"]'));
    const next=sectionIds.map((id)=>parsed.querySelector('main > section[data-live-section="'+id+'"]'));
    if(current.some((item)=>!item)||next.some((item)=>!item))throw new Error('live sections missing');
    const expanded=openDetails();
    current.forEach((item,index)=>item.replaceWith(next[index]));
    document.querySelectorAll('main details').forEach((item)=>{if(expanded.has(detailsKey(item)))item.open=true});
    const filter=document.getElementById('filter');
    if(filter)filter.dispatchEvent(new Event('input'));
    bindCopyButtons(document);
  };
  const load=async()=>{
    if(inFlight)return;
    inFlight=true;
    try{
      const response=await fetch('/api/snapshot?ts='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(15000)});
      let payload=null;
      try{payload=await response.json()}catch{throw new Error('响应不是 JSON')}
      if(!response.ok||!payload?.snapshot||typeof payload.html!=='string')throw new Error(payload?.error||('HTTP '+response.status));
      const nextKey=contentKey(payload);
      if(nextKey!==lastContentKey){replaceSections(payload.html);lastContentKey=nextKey}
      lastSuccess=payload.snapshot.generatedAt||new Date().toISOString();
      const meta=document.querySelector('header .meta');
      if(meta)meta.textContent='最近快照：'+lastSuccess+' · 来源：'+payload.snapshot.intakeRoot;
      setStatus('connected','实时连接：已连接 · 最近成功更新：'+lastSuccess);
    }catch(error){
      const when=lastSuccess||'未知';
      setStatus('stale','实时连接：已断开或数据读取失败 · 保留上次成功数据（'+when+'）');
    }finally{
      inFlight=false;
      window.setTimeout(load,pollMs);
    }
  };
  load();
})();
</script>`;

function livePage(snapshot, sources) {
  const base = decorateHtml(renderHtml(snapshot), snapshot, sources);
  return base.replace("</body>", `${LIVE_SCRIPT}</body>`);
}

function buildPayload(intakeRoot, sources) {
  const snapshot = buildSnapshot({ intakeRoot });
  return { snapshot, html: decorateHtml(renderHtml(snapshot), snapshot, sources) };
}

function handleRequest(server, intakeRoot, sources, request, response) {
  if (!validHost(request, server)) {
    sendText(response, 403, "Host must be the local server authority\n");
    return;
  }
  if (!validOrigin(request, server)) {
    sendText(response, 403, "Origin must be the local server origin\n");
    return;
  }
  if (request.method !== "GET") {
    sendText(response, 405, "GET only\n", "text/plain; charset=utf-8", { allow: "GET" });
    return;
  }
  let requestUrl;
  try { requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`); }
  catch { sendText(response, 400, "Invalid URL\n"); return; }
  const requestAuthority = parseAuthority(requestUrl.host, "request URL");
  if (!requestAuthority || requestAuthority.port !== hostPort(server)) {
    sendText(response, 403, "Request URL must be the local server authority\n");
    return;
  }
  if (requestUrl.pathname.startsWith("/source/")) {
    const id = requestUrl.pathname.slice("/source/".length);
    if (!/^[a-f0-9]{64}$/u.test(id)) { sendText(response, 404, "未登记的来源链接"); return; }
    if (!sources.has(id)) {
      try { buildPayload(intakeRoot, sources); } catch { /* known references remain available */ }
    }
    serveSource(response, id, sources);
    return;
  }
  if (requestUrl.pathname === "/api/snapshot") {
    try { sendJson(response, 200, buildPayload(intakeRoot, sources)); }
    catch (error) { sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (requestUrl.pathname === "/") {
    try { sendText(response, 200, livePage(buildSnapshot({ intakeRoot }), sources), "text/html; charset=utf-8", { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" }); }
    catch (error) { sendText(response, 503, error instanceof Error ? error.message : String(error)); }
    return;
  }
  sendText(response, 404, "Not found\n");
}

export function startServer({ intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, port = DEFAULT_PORT } = {}) {
  const resolvedIntakeRoot = resolve(intakeRoot);
  const listenPort = asPort(port);
  const sources = new Map();
  const server = createServer((request, response) => handleRequest(server, resolvedIntakeRoot, sources, request, response));
  server.listen(listenPort, "127.0.0.1");
  return server;
}

export function parseArgs(args = process.argv.slice(2)) {
  const options = { intakeRoot: process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, port: DEFAULT_PORT, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--port" || arg === "--intake-root") {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
      if (arg === "--port") options.port = asPort(value, arg);
      else options.intakeRoot = resolve(value);
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return options;
}

function runCli(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log("usage: node scripts/ikb-workbench-server.mjs [--port PORT] [--intake-root DIR]");
      return 0;
    }
    const server = startServer(options);
    const shutdown = () => server.close(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    server.once("listening", () => {
      const port = hostPort(server);
      console.log(`IKB realtime workbench: http://127.0.0.1:${port}`);
    });
    server.once("error", (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli();
