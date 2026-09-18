#!/usr/bin/env node
/* Convert usage projections into bounded feedback requests. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isActiveCardEntry, parseCardMarkdown } from "../mcp/ikb-cards-core.mjs";

export const FEEDBACK_IMPORT_STATE_SCHEMA = "ikb-feedback-import-state-v1";
export const FEEDBACK_IMPORT_GAP_SCHEMA = "ikb-feedback-import-gap-v1";
export const FEEDBACK_IMPORT_REPORT_SCHEMA = "ikb-feedback-import-report-v1";
const CORRECTIONS_SCHEMA = "ikb-recall-user-correction-v1";
const EVALUATED_SCHEMA = "ikb-recall-evaluated-feedback-v1";
const MISSED_SCHEMA = "ikb-recall-missed-lookup-candidate-v1";
const SEARCH_SCHEMA = "ikb-card-search-result-v1";
const READ_SCHEMA = "ikb-card-read-result-v1";
const EXPLICIT_STATES = new Set(["explicitly_rejected_stale", "explicitly_rejected_incorrect"]);
const ENABLED_CORRECTION_LABELS = new Set(["card_exists_question", "missed_lookup", "lookup_question", "distrust", "stale", "adverse_effect", "incorrect", "style_drift"]);
const CORRECTION_PROVENANCE_FIELDS = ["classification", "matchedRule", "matchedText", "sourceEventRef"];
const HOSTS = new Set(["codex", "claude", "pi", "catpaw"]);
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_GAP_RAW_BYTES = 64 * 1024;
const IMPORT_LOCK_WAIT_MS = 5_000;
const IMPORT_LOCK_STALE_MS = 60_000;
const INPUTS = [
  { kind: "user_correction", filename: "user-corrections.jsonl" },
  { kind: "evaluated_feedback", filename: "evaluated-feedback.jsonl" },
  { kind: "missed_lookup", filename: "missed-lookup-candidates.jsonl" },
];

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`directory required: ${path}`);
  return resolve(path);
}
function atomicWrite(path, content) {
  ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); } finally { try { rmSync(temporary, { force: true }); } catch { /* already renamed */ } }
}
function safeRegularFile(path) {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
const referencePath = (reference) => { const value = text(reference); return value ? value.replace(/#line=\d+$/u, "") : null; };
function parseTimestamp(value, label) {
  const raw = text(value);
  if (!raw || !Number.isFinite(Date.parse(raw))) throw new Error(`${label} must be an ISO timestamp`);
  return raw;
}
function sourceParts(subjectRef) {
  const value = text(subjectRef);
  if (!value || !value.startsWith("run://")) return null;
  const parts = value.slice("run://".length).split("/");
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  const host = parts.shift();
  const sessionId = parts.shift();
  const messageId = parts.join("/");
  return HOSTS.has(host) && messageId ? { host, sessionId, messageId, subjectRef: value } : null;
}
const validScope = (value) => value === "work" || value === "personal" ? value : null;
function explicitScope(row) {
  const source = object(row?.source); const payload = object(row?.payload); const message = object(row?.message);
  return [row?.scope, row?.knowledgeScope, source?.scope, payload?.scope, payload?.knowledgeScope, message?.scope].map(validScope).find(Boolean) ?? null;
}
function resultDocuments(value, found = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return found;
  if (typeof value === "string") { const raw = value.trim(); if (!raw || raw.length > MAX_LINE_BYTES) return found; try { resultDocuments(JSON.parse(raw), found, depth + 1); } catch { /* plain text */ } return found; }
  if (Array.isArray(value)) { for (const item of value) resultDocuments(item, found, depth + 1); return found; }
  if (typeof value !== "object") return found;
  if (value.schema === SEARCH_SCHEMA || value.schema === READ_SCHEMA) found.push(value);
  for (const nested of Object.values(value)) resultDocuments(nested, found, depth + 1);
  return found;
}
function actualResultScopes(value) {
  const scopes = new Set();
  for (const row of resultDocuments(value)) {
    if (!text(row.retrievalId) || !validScope(row.scope)) continue;
    if (row.schema === SEARCH_SCHEMA && !Array.isArray(row.items)) continue;
    if (row.schema === READ_SCHEMA && !object(row.card)) continue;
    scopes.add(row.scope);
  }
  return scopes;
}
function operationName(value) {
  const name = text(value) ?? "";
  if (name === "ikb_search_cards" || name.endsWith("__ikb_search_cards") || name.endsWith(".ikb_search_cards") || name.endsWith("/ikb_search_cards") || name === "search") return "search";
  if (name === "ikb_get_card" || name.endsWith("__ikb_get_card") || name.endsWith(".ikb_get_card") || name.endsWith("/ikb_get_card") || name === "get") return "get";
  return null;
}
function hasLookupCommand(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (/(?:^|[\s/])(?:ikb|ikb-cards-cli(?:\.mjs)?)\s+(?:search|get)(?:\s|$)/u.test(value)) return true;
    try { return hasLookupCommand(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some((item) => hasLookupCommand(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => ["cmd", "command", "commands", "arguments", "input"].includes(key) && hasLookupCommand(nested, depth + 1));
}
function walkFiles(root, output, depth = 0) {
  if (depth > 6) return;
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(path, output, depth + 1); else if (entry.isFile()) output.push(path);
  }
}
function hostRoots(host, usageRoot, intakeRoot) {
  const local = [join(usageRoot, "sessions", host), join(usageRoot, host), join(intakeRoot, "sessions", host), join(intakeRoot, host)];
  const home = homedir();
  const native = { codex: [join(home, ".codex", "sessions")], claude: [join(home, ".claude", "projects")], pi: [join(home, ".pi", "agent", "sessions")], catpaw: [join(home, ".catpaw", "logs", "conversations"), join(home, ".catpaw", "claude-sessions")] };
  return { local: [...new Set(local.map((path) => resolve(path)))].filter((path) => existsSync(path)), native: [...new Set((native[host] ?? []).map((path) => resolve(path)))].filter((path) => existsSync(path)) };
}
function linesOf(path) { if (!safeRegularFile(path)) return []; try { return readFileSync(path, "utf8").split(/\r?\n/u); } catch { return []; } }

function codexFacts(path) {
  let sessionId = null; let currentTurn = null; const turns = new Map(); const calls = new Map();
  const ensureTurn = (id) => { if (!turns.has(id)) turns.set(id, { users: [], scopes: new Set(), explicit: new Set() }); return turns.get(id); };
  let lineNumber = 0;
  for (const line of linesOf(path)) {
    lineNumber += 1; if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const payload = object(row?.payload); const outerType = text(row?.type);
    if (outerType === "session_meta" && payload) { sessionId ||= text(payload.id) ?? text(payload.session_id); continue; }
    if (!payload) continue;
    const metadata = object(payload.internal_chat_message_metadata_passthrough);
    const turnId = text(payload.turn_id) ?? text(metadata?.turn_id) ?? currentTurn;
    const rowExplicit = explicitScope(row);
    if (outerType === "turn_context") { currentTurn = turnId; if (turnId && rowExplicit) ensureTurn(turnId).explicit.add(rowExplicit); continue; }
    if (outerType === "event_msg" && text(payload.type) === "task_started") { currentTurn = turnId; if (turnId && rowExplicit) ensureTurn(turnId).explicit.add(rowExplicit); continue; }
    if (outerType === "response_item" && text(payload.type) === "message" && payload.role === "user") { if (!turnId) continue; const turn = ensureTurn(turnId); if (rowExplicit) turn.explicit.add(rowExplicit); turn.users.push({ messageId: turnId, line: lineNumber }); continue; }
    if (outerType === "response_item" && ["function_call", "custom_tool_call"].includes(text(payload.type) ?? "")) { const op = operationName(payload.name ?? payload.tool_name) ?? (hasLookupCommand(payload.arguments ?? payload.input) ? "cli" : null); const callId = text(payload.call_id) ?? text(payload.id); if (turnId && callId && op) calls.set(callId, { turnId, op }); continue; }
    if (outerType === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(text(payload.type) ?? "")) { const call = calls.get(text(payload.call_id)); if (call) for (const scope of actualResultScopes(payload.output)) ensureTurn(call.turnId).scopes.add(scope); continue; }
    if (outerType === "event_msg" && text(payload.type) === "mcp_tool_call_end") { const invocation = object(payload.invocation); const op = operationName(invocation?.tool); if (turnId && op) for (const scope of actualResultScopes(payload.result)) ensureTurn(turnId).scopes.add(scope); continue; }
    if (outerType === "event_msg" && text(payload.type) === "item_completed") { const item = object(payload.item); const op = operationName(item?.tool) ?? (hasLookupCommand(item?.command ?? item?.cmd) ? "cli" : null); if (turnId && op) for (const scope of actualResultScopes(item?.result ?? item?.output ?? item?.stdout ?? item?.aggregated_output)) ensureTurn(turnId).scopes.add(scope); }
    if (outerType === "event_msg" && text(payload.type) === "command_execution") { if (turnId && hasLookupCommand(payload.command ?? payload.cmd)) for (const scope of actualResultScopes(payload.output ?? payload.stdout ?? payload.aggregated_output)) ensureTurn(turnId).scopes.add(scope); }
  }
  const records = []; for (const turn of turns.values()) if (sessionId) for (const user of turn.users) records.push({ sessionId, messageId: user.messageId, line: user.line, scopes: new Set([...turn.scopes, ...turn.explicit]) });
  return { records };
}

function piFacts(path) {
  let sessionId = null; const users = []; const scopes = new Set(); const explicitByMessage = new Map(); const pending = new Map(); let lineNumber = 0;
  for (const line of linesOf(path)) {
    lineNumber += 1; if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "session" && text(row.id)) { sessionId = text(row.id); continue; }
    if (row.type !== "message" || !object(row.message)) continue;
    const message = row.message;
    if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content) if (object(block) && ["toolCall", "tool_call"].includes(text(block.type) ?? "")) { const op = operationName(block.name) ?? (hasLookupCommand(block.arguments ?? block.input) ? "cli" : null); const callId = text(block.id) ?? text(block.callId); if (op && callId) pending.set(callId, op); }
    if (message.role === "toolResult" && text(message.toolName)) { const callId = text(message.toolCallId) ?? text(message.callId); const op = operationName(message.toolName) ?? pending.get(callId); if (op && message.isError !== true && message.is_error !== true) { for (const scope of actualResultScopes(message.content)) scopes.add(scope); if (callId) pending.delete(callId); } }
    if (message.role === "user") { const messageId = text(row.id); if (!messageId) continue; const explicit = explicitScope(row) ?? explicitScope(message); if (explicit) explicitByMessage.set(messageId, explicit); users.push({ messageId, line: lineNumber }); }
  }
  return { records: sessionId ? users.map((user) => ({ sessionId, messageId: user.messageId, line: user.line, scopes: new Set([...scopes, ...(explicitByMessage.has(user.messageId) ? [explicitByMessage.get(user.messageId)] : [])]) })) : [] };
}

function claudeFacts(path) {
  let sessionId = null; const users = []; const scopes = new Set(); const explicitByMessage = new Map(); const pending = new Map(); let lineNumber = 0;
  for (const line of linesOf(path)) {
    lineNumber += 1; if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    sessionId ||= text(row.sessionId); if (!["user", "assistant"].includes(text(row.type)) || !object(row.message)) continue;
    const message = row.message;
    if (row.type === "assistant" && Array.isArray(message.content)) for (const block of message.content) if (object(block) && block.type === "tool_use") { const op = operationName(block.name) ?? (hasLookupCommand(block.input ?? block.arguments) ? "cli" : null); const callId = text(block.id); if (op && callId) pending.set(callId, op); }
    if (row.type === "user" && Array.isArray(message.content)) for (const block of message.content) if (object(block) && block.type === "tool_result") { const op = pending.get(text(block.tool_use_id)); if (op && message.is_error !== true && message.isError !== true) { for (const scope of actualResultScopes(block.content)) scopes.add(scope); pending.delete(text(block.tool_use_id)); } }
    if (row.type === "user") { const messageId = text(row.uuid); if (!messageId) continue; const explicit = explicitScope(row) ?? explicitScope(message); if (explicit) explicitByMessage.set(messageId, explicit); users.push({ messageId, line: lineNumber }); }
  }
  return { records: sessionId ? users.map((user) => ({ sessionId, messageId: user.messageId, line: user.line, scopes: new Set([...scopes, ...(explicitByMessage.has(user.messageId) ? [explicitByMessage.get(user.messageId)] : [])]) })) : [] };
}
function parseHostFile(host, path) { if (host === "codex") return codexFacts(path); if (host === "pi") return piFacts(path); if (host === "claude") return claudeFacts(path); return { records: [] }; }

function buildSourceResolver(usageRoot, intakeRoot) {
  const sourceCache = new Map(); const fileLists = new Map(); const parsedFiles = new Map();
  const filesFor = (host) => {
    if (fileLists.has(host)) return fileLists.get(host);
    const roots = hostRoots(host, usageRoot, intakeRoot); const local = []; const native = [];
    for (const root of roots.local) walkFiles(root, local); for (const root of roots.native) walkFiles(root, native);
    const result = { local: [...new Set(local)].sort(), native: [...new Set(native)].sort() }; fileLists.set(host, result); return result;
  };
  const factsFor = (host, path) => { if (!parsedFiles.has(path)) parsedFiles.set(path, parseHostFile(host, path)); return parsedFiles.get(path); };
  return (parts) => {
    const key = `${parts.host}\n${parts.sessionId}\n${parts.messageId}`; if (sourceCache.has(key)) return sourceCache.get(key);
    const files = filesFor(parts.host); const matchName = (path) => { const name = basename(path, extname(path)); return name === parts.sessionId || name.includes(parts.sessionId); };
    const localMatches = files.local.filter(matchName); const nativeMatches = files.native.filter(matchName);
    const candidates = [...new Set([...(localMatches.length ? localMatches : files.local.filter((path) => extname(path).toLowerCase() === ".jsonl")), ...nativeMatches])]; const found = [];
    for (const path of candidates) for (const record of factsFor(parts.host, path).records) if (record.sessionId === parts.sessionId && record.messageId === parts.messageId) found.push({ path: resolve(path), line: record.line, scopes: record.scopes });
    const scopes = new Set(found.flatMap((record) => [...record.scopes])); let result = null;
    if (found.length && scopes.size <= 1) { const first = found[0]; result = { ...parts, reference: first.path, scope: [...scopes][0] ?? null }; }
    else if (found.length) result = { ...parts, reference: found[0].path, scope: null, ambiguous: true };
    sourceCache.set(key, result); return result;
  };
}
function explicitSource(row, parts) {
  const source = object(row?.source);
  // sourceEventRef is producer provenance.  When it is a local bounded reference,
  // it can also serve as the source snapshot if the host session file is absent.
  for (const candidate of [source?.reference, row?.sourceEventRef]) {
    const reference = text(candidate);
    if (reference && safeRegularFile(referencePath(reference))) return { ...parts, reference: resolve(referencePath(reference)), scope: explicitScope(row) };
  }
  return null;
}

function evaluationRoots(usageRoot, intakeRoot, cardsRoot) { return [...new Set([join(usageRoot, "..", "evaluations"), join(intakeRoot, "evaluations"), join(cardsRoot, "..", "evaluations")].map((path) => resolve(path)))].filter((path) => existsSync(path)); }
function buildEvaluationResolver(usageRoot, intakeRoot, cardsRoot) {
  const cache = new Map(); const rows = []; const paths = []; for (const root of evaluationRoots(usageRoot, intakeRoot, cardsRoot)) walkFiles(root, paths);
  for (const path of paths.filter((value) => extname(value).toLowerCase() === ".json")) try { const row = object(JSON.parse(readFileSync(path, "utf8"))); if (row) rows.push({ row, path: resolve(path) }); } catch { /* unrelated artifact */ }
  return (evaluationKey, fallback) => {
    if (cache.has(evaluationKey)) return cache.get(evaluationKey);
    const candidates = rows.filter(({ row, path }) => row.evaluationKey === evaluationKey || basename(path).includes(evaluationKey)); const found = [];
    for (const { row, path } of [...candidates, { row: fallback, path: null }]) {
      if (!row || (row.evaluationKey && row.evaluationKey !== evaluationKey)) continue;
      const parts = sourceParts(row.subjectRef); if (!parts || !path || !safeRegularFile(path)) continue;
      const scopes = new Set(); for (const retrieval of Array.isArray(row.retrievals) ? row.retrievals : []) { const scope = validScope(retrieval?.scope); if (scope) scopes.add(scope); }
      const scope = explicitScope(row); if (scope) scopes.add(scope); found.push({ ...parts, reference: path, scopes });
    }
    const scopes = new Set(found.flatMap((item) => [...item.scopes])); let result = null;
    if (found.length && scopes.size <= 1) result = { ...found[0], scope: [...scopes][0] ?? null }; else if (found.length) result = { ...found[0], scope: null, ambiguous: true };
    cache.set(evaluationKey, result); return result;
  };
}

function activeCardFiles(root) {
  const files = []; const walk = (directory) => { let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; } entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")); for (const entry of entries) { if (!isActiveCardEntry(entry)) continue; const path = join(directory, entry.name); if (entry.isDirectory()) walk(path); else files.push(path); } };
  if (existsSync(root)) walk(resolve(root)); return files;
}
function cardScope(path, cardsRoot) { const first = relative(resolve(cardsRoot), resolve(path)).split(sep)[0]; return ["work", "personal", "common"].includes(first) ? first : null; }
function buildCardIndex(cardsRoot) {
  const byId = new Map(); for (const path of activeCardFiles(cardsRoot)) { let card; try { card = parseCardMarkdown(readFileSync(path, "utf8"), path); } catch { continue; } const record = { id: card.cardId, path: resolve(path), scope: cardScope(path, cardsRoot) }; const prior = byId.get(record.id); if (!prior) byId.set(record.id, { ...record, paths: [record.path], collision: false }); else { prior.collision = true; prior.paths = [...new Set([...prior.paths, record.path])].sort(); } } return byId;
}
const statePath = (root) => join(resolve(root), "feedback-import-state.json");
const gapPath = (root) => join(resolve(root), "feedback-import-gaps.jsonl");
const lockPath = (root) => join(resolve(root), "feedback-import.lock");
function readState(path, now) {
  if (!existsSync(path)) return { schema: FEEDBACK_IMPORT_STATE_SCHEMA, initializedAt: now, signals: {} };
  const value = object(JSON.parse(readFileSync(path, "utf8"))); if (!value || value.schema !== FEEDBACK_IMPORT_STATE_SCHEMA || !text(value.initializedAt) || !object(value.signals)) throw new Error("feedback import state is invalid");
  return { schema: FEEDBACK_IMPORT_STATE_SCHEMA, initializedAt: parseTimestamp(value.initializedAt, "feedback import initializedAt"), signals: value.signals };
}
function writeState(path, state) { atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`); }
function appendGap(intakeRoot, gap, knownGapIds) {
  const { detectedAt, ...stable } = gap; const stablePayload = { ...stable, schema: FEEDBACK_IMPORT_GAP_SCHEMA }; const gapId = sha256(canonical(stablePayload)); if (knownGapIds.has(gapId)) return false; knownGapIds.add(gapId); ensureDirectory(resolve(intakeRoot)); appendFileSync(gapPath(intakeRoot), `${JSON.stringify({ ...stablePayload, detectedAt, gapId })}\n`, { mode: 0o600 }); return true;
}
function readKnownGapIds(intakeRoot) { const ids = new Set(); const path = gapPath(intakeRoot); if (!safeRegularFile(path)) return ids; for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) if (line.trim()) try { const row = object(JSON.parse(line)); if (text(row?.gapId)) ids.add(row.gapId); } catch { /* preserve malformed history */ } return ids; }
function gapFor(intakeRoot, knownGapIds, reason, kind, record, raw, signalKey = null) { return appendGap(intakeRoot, { detectedAt: new Date().toISOString(), reason, inputKind: kind, signalKey, subjectRef: text(record?.subjectRef), raw: (typeof raw === "string" ? raw : JSON.stringify(record)).slice(0, MAX_GAP_RAW_BYTES) }, knownGapIds); }
function validCorrectionProvenance(row) {
  if (row.classification !== undefined && row.classification !== "candidate") return false;
  return CORRECTION_PROVENANCE_FIELDS.slice(1).every((field) => row[field] === undefined || text(row[field]));
}
function validRecord(kind, row) {
  if (kind === "user_correction") return row?.schema === CORRECTIONS_SCHEMA && text(row.correctionKey) && text(row.detectedAt) && text(row.subjectRef) && text(row.label) && text(row.excerpt) && validCorrectionProvenance(row);
  if (kind === "evaluated_feedback") return row?.schema === EVALUATED_SCHEMA && text(row.evaluationKey) && text(row.evaluatedAt) && text(row.cardId) && text(row.state);
  return row?.schema === MISSED_SCHEMA && text(row.candidateKey) && text(row.detectedAt) && text(row.subjectRef) && text(row.excerpt);
}
const signalTime = (kind, row) => kind === "evaluated_feedback" ? row.evaluatedAt : row.detectedAt;
function signalKey(kind, row) { if (kind === "user_correction") return `correction:${row.correctionKey}`; if (kind === "evaluated_feedback") return `evaluation:${row.evaluationKey}:${row.cardId}`; return `missed:${row.candidateKey}`; }
function signalFingerprint(kind, row) {
  if (kind !== "user_correction") return canonical(row);
  // Producer provenance is enrichment for the same stable event, not a new
  // event.  This also lets an old v1 record and a new candidate record share
  // the persisted key without replaying history.
  const base = { ...row };
  for (const field of CORRECTION_PROVENANCE_FIELDS) delete base[field];
  return canonical(base);
}
function sourceFromRow(kind, row, resolveSource, resolveEvaluation) {
  if (kind === "evaluated_feedback") return resolveEvaluation(row.evaluationKey, row);
  const parts = sourceParts(row.subjectRef); if (!parts) return null; const explicit = explicitSource(row, parts); const native = resolveSource(parts); if (!native && !explicit) return null; if (!native) return explicit;
  const source = { ...native }; if (explicit?.scope && source.scope && explicit.scope !== source.scope) return { ...source, ambiguous: true, scope: null }; if (explicit?.scope && !source.scope) source.scope = explicit.scope; if (explicit?.reference) source.reference = explicit.reference; return source;
}
function parseInputFile(path, kind, callback) {
  if (!existsSync(path)) return; let lineNumber = 0; let lines; try { lines = readFileSync(path, "utf8").split(/\r?\n/u); } catch (error) { callback({ kind, path, lineNumber: 0, raw: "", error: String(error) }); return; }
  for (const raw of lines) { lineNumber += 1; if (!raw.trim()) continue; if (Buffer.byteLength(raw) > MAX_LINE_BYTES) callback({ kind, path, lineNumber, raw, error: "line_too_large" }); else try { callback({ kind, path, lineNumber, raw, row: JSON.parse(raw) }); } catch { callback({ kind, path, lineNumber, raw, error: "invalid_json_line" }); } }
}
const sourceIdentity = (source) => `${source.host}\n${source.sessionId}\n${source.messageId}`;
const readableReference = (value) => { const reference = text(value); return reference && safeRegularFile(referencePath(reference)) ? reference : null; };
function correctionProvenance(row) {
  const details = [];
  if (text(row.matchedRule)) details.push(`matchedRule=${row.matchedRule}`);
  if (text(row.matchedText)) details.push(`matchedText=${row.matchedText}`);
  if (text(row.sourceEventRef)) details.push(`sourceEventRef=${row.sourceEventRef}`);
  return details.length ? `；${details.join("；")}` : "";
}
function signalSummary(kind, row, key) {
  if (kind === "user_correction") return `${key} 正则匹配候选信号（待核实，不等于用户纠正或卡片过期；label=${row.label}${correctionProvenance(row)}）：${row.excerpt}`;
  if (kind === "missed_lookup") return `${key} 该工作问题可能未触发 IKB 检索：${row.excerpt}`;
  return `${key} 评估记录显示卡片 ${row.cardId} 的状态为 ${row.state}，请按原始评估证据人工复核`;
}
function buildGroupedInput(entries) {
  const first = entries[0]; const keys = entries.map((entry) => entry.key); const targetIds = [...new Set(entries.filter((entry) => entry.kind === "evaluated_feedback").map((entry) => entry.row.cardId).filter(Boolean))]; const originalRefs = entries.flatMap((entry) => Array.isArray(entry.row.evidenceRefs) ? entry.row.evidenceRefs.filter((value) => typeof value === "string" && value.trim()) : []); const producerRefs = entries.filter((entry) => entry.kind === "user_correction").map((entry) => entry.row.sourceEventRef).filter((value) => typeof value === "string" && value.trim()); const refs = [...new Set([...entries.map((entry) => entry.source.reference), ...originalRefs.map(readableReference).filter(Boolean), ...producerRefs.map(readableReference).filter(Boolean)])];
  return { scope: "work", question: `[usage_feedback:${keys.join("|")}] ${entries.map((entry) => signalSummary(entry.kind, entry.row, entry.key)).join("；")}${originalRefs.length ? ` 原始证据引用：${originalRefs.join(",")}` : ""}`, source: { host: first.source.host, sessionId: first.source.sessionId, messageId: first.source.messageId, reference: first.source.reference }, ...(targetIds.length ? { targetCardId: targetIds[0] } : {}), evidenceRefs: refs.length ? refs : [first.source.reference] };
}
function groupEntries(entries) {
  const bySource = new Map(); for (const entry of entries) { const key = sourceIdentity(entry.source); if (!bySource.has(key)) bySource.set(key, []); bySource.get(key).push(entry); }
  const groups = [];
  for (const values of bySource.values()) {
    const targets = [...new Set(values.map((entry) => entry.row.cardId).filter(Boolean))];
    const targetBuckets = targets.length <= 1 ? [values] : [null, ...targets].map((target) => values.filter((entry) => target === null ? !entry.row.cardId : entry.row.cardId === target));
    for (const bucket of targetBuckets) {
      if (!bucket.length) continue;
      const byKind = new Map();
      for (const entry of bucket) { if (!byKind.has(entry.kind)) byKind.set(entry.kind, []); byKind.get(entry.kind).push(entry); }
      const count = Math.max(...[...byKind.values()].map((items) => items.length));
      for (let index = 0; index < count; index += 1) groups.push([...byKind.values()].flatMap((items) => items[index] ? [items[index]] : []));
    }
  }
  return groups;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function withImportLock(path, callback) {
  const started = Date.now();
  while (true) {
    try { mkdirSync(path, { recursive: false, mode: 0o700 }); try { writeFileSync(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" }); } catch { /* diagnostic only */ } try { return await callback(); } finally { try { rmSync(path, { recursive: true, force: true }); } catch { /* retain diagnostic lock */ } } }
    catch (error) { if (error.code !== "EEXIST") throw error; try { if (Date.now() - statSync(path).mtimeMs > IMPORT_LOCK_STALE_MS) rmSync(path, { recursive: true, force: true }); } catch { /* released concurrently */ } if (Date.now() - started >= IMPORT_LOCK_WAIT_MS) throw new Error(`feedback import lock busy: ${path}`); await sleep(10); }
  }
}
async function defaultSubmit(input, options) { const module = await import(new URL("../scripts/ikb-requests.mjs", import.meta.url)); if (typeof module.submitRequest !== "function") throw new Error("scripts/ikb-requests.mjs does not export submitRequest"); return module.submitRequest(input, options); }

export async function importUsageFeedback({ usageRoot, intakeRoot, cardsRoot, since, submit = defaultSubmit } = {}) {
  if (!usageRoot || !intakeRoot || !cardsRoot) throw new Error("usageRoot, intakeRoot and cardsRoot are required");
  const usage = resolve(usageRoot); const intake = ensureDirectory(resolve(intakeRoot)); const cards = ensureDirectory(resolve(cardsRoot)); if (!existsSync(usage)) throw new Error("usageRoot does not exist");
  return withImportLock(lockPath(intake), async () => {
    const now = new Date().toISOString(); const stateFile = statePath(intake); const state = readState(stateFile, now); const effectiveSince = since === undefined ? state.initializedAt : parseTimestamp(since, "since"); const sourceResolver = buildSourceResolver(usage, intake); const evaluationResolver = buildEvaluationResolver(usage, intake, cards); const cardIndex = buildCardIndex(cards); const knownGapIds = readKnownGapIds(intake);
    const report = { schema: FEEDBACK_IMPORT_REPORT_SCHEMA, status: "ready", initializedAt: state.initializedAt, since: effectiveSince, files: 0, records: 0, eligible: 0, ignored: 0, imported: 0, reused: 0, gaps: 0, failed: 0, submissions: [], issues: [] };
    const events = []; for (const input of INPUTS) { const path = join(usage, input.filename); if (existsSync(path)) report.files += 1; parseInputFile(path, input.kind, (event) => events.push(event)); }
    const seenSignal = new Map(); const pending = [];
    for (const event of events) {
      report.records += 1;
      if (event.error) { if (gapFor(intake, knownGapIds, event.error, event.kind, null, event.raw)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: event.error }); continue; }
      const row = object(event.row); if (!validRecord(event.kind, row)) { if (gapFor(intake, knownGapIds, "invalid_record", event.kind, row, event.raw)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "invalid_record" }); continue; }
      let timestamp; try { timestamp = parseTimestamp(signalTime(event.kind, row), `${event.kind} timestamp`); } catch { if (gapFor(intake, knownGapIds, "invalid_timestamp", event.kind, row, event.raw, signalKey(event.kind, row))) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "invalid_timestamp" }); continue; }
      if (Date.parse(timestamp) < Date.parse(effectiveSince)) { report.ignored += 1; continue; }
      if (event.kind === "user_correction" && !ENABLED_CORRECTION_LABELS.has(row.label)) { report.ignored += 1; continue; }
      if (event.kind === "evaluated_feedback" && !EXPLICIT_STATES.has(row.state)) { report.ignored += 1; continue; }
      report.eligible += 1; const key = signalKey(event.kind, row); const fingerprint = signalFingerprint(event.kind, row); const previousSeen = seenSignal.get(key);
      if (previousSeen && previousSeen !== fingerprint) { if (gapFor(intake, knownGapIds, "signal_key_collision", event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "signal_key_collision", signalKey: key }); continue; }
      if (previousSeen === fingerprint) { report.reused += 1; continue; }
      seenSignal.set(key, fingerprint); const prior = state.signals[key]; const versionKey = prior && prior.fingerprint !== fingerprint ? `${key}:v${sha256(fingerprint).slice(0, 16)}` : key; if (state.signals[versionKey]?.fingerprint === fingerprint) { report.reused += 1; continue; }
      const card = event.kind === "evaluated_feedback" ? cardIndex.get(row.cardId) : null; const source = sourceFromRow(event.kind, row, sourceResolver, evaluationResolver);
      if (!source) { if (gapFor(intake, knownGapIds, "source_unresolved", event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "source_unresolved", signalKey: key }); continue; }
      if (source.ambiguous) { if (gapFor(intake, knownGapIds, "source_collision", event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "source_collision", signalKey: key }); continue; }
      if (source.scope !== "work") { const reason = source.scope === "personal" ? "non_work_scope" : "scope_unknown"; if (gapFor(intake, knownGapIds, reason, event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason, signalKey: key }); continue; }
      if (event.kind === "evaluated_feedback" && card?.collision) { if (gapFor(intake, knownGapIds, "card_id_collision", event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason: "card_id_collision", signalKey: key }); continue; }
      if (event.kind === "evaluated_feedback" && (!card || card.scope !== "work")) { const reason = !card ? "card_unresolved" : card.scope === "personal" ? "non_work_scope" : "card_scope_unknown"; if (gapFor(intake, knownGapIds, reason, event.kind, row, event.raw, key)) report.gaps += 1; report.issues.push({ kind: event.kind, line: event.lineNumber, reason, signalKey: key }); continue; }
      pending.push({ kind: event.kind, row, key, fingerprint, persistedKey: versionKey, source });
    }
    for (const entries of groupEntries(pending)) {
      const request = buildGroupedInput(entries);
      try { const result = await submit(request, { kind: "feedback", intakeRoot: intake, cardsRoot: cards, wake: false }); const requestId = text(result?.requestId); if (!requestId) throw new Error("submit result missing requestId"); for (const entry of entries) { state.signals[entry.persistedKey] = { fingerprint: entry.fingerprint, requestId, submittedAt: now }; report.imported += 1; } report.submissions.push({ signalKeys: entries.map((entry) => entry.key), requestId, reused: result?.reused === true }); }
      catch (error) { report.failed += entries.length; for (const entry of entries) { if (gapFor(intake, knownGapIds, "submit_failed", entry.kind, entry.row, JSON.stringify(entry.row), entry.key)) report.gaps += 1; report.issues.push({ kind: entry.kind, reason: "submit_failed", signalKey: entry.key, error: String(error) }); } }
    }
    writeState(stateFile, state); if (report.failed > 0) report.status = "degraded"; return report;
  });
}

function usage() { return "usage: ikb-feedback-import.mjs [--usage-root DIR] [--intake-root DIR] [--cards-root DIR] [--since ISO]"; }
function parseArgs(args) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const options = { usageRoot: process.env.IKB_USAGE_ROOT ?? join(repo, "ikb-data", "usage"), intakeRoot: process.env.IKB_INTAKE_ROOT ?? join(repo, "ikb-data", "intake"), cardsRoot: process.env.IKB_CARDS_ROOT ?? join(repo, "ikb-data", "cards") };
  for (let index = 0; index < args.length; index += 1) { const arg = args[index]; if (["--usage-root", "--intake-root", "--cards-root", "--since"].includes(arg)) { const value = args[++index]; if (!value) throw new Error(`${arg} requires a value`); options[{ "--usage-root": "usageRoot", "--intake-root": "intakeRoot", "--cards-root": "cardsRoot", "--since": "since" }[arg]] = value; } else if (arg === "--help") { process.stdout.write(`${usage()}\n`); return null; } else throw new Error(`unknown argument: ${arg}`); }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const options = parseArgs(process.argv.slice(2)); if (options) { const report = await importUsageFeedback(options); process.stdout.write(`${JSON.stringify(report)}\n`); process.exitCode = report.failed > 0 ? 1 : 0; } }
  catch (error) { process.stderr.write(`${String(error?.message ?? error)}\n${usage()}\n`); process.exitCode = 1; }
}
