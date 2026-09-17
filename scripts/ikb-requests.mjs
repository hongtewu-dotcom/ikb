#!/usr/bin/env node

// Request intake is deliberately synchronous.  The request itself is a small,
// immutable local record. The current host owns native subagent execution.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isActiveCardEntry, parseCardMarkdown } from "../mcp/ikb-cards-core.mjs";
import { planIdentity } from "./ikb-admission.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUEST_SCHEMA = "ikb-request-v1";
export const QUEUE_SCHEMA = "ikb-request-queue-v1";
export const DEFAULT_INTAKE_ROOT = join(REPO, "ikb-data", "intake");
export const REQUEST_KEY_VERSION = "ikb-request-key-v1";
const REQUEST_ID_RE = /^req-[a-f0-9]{24}$/u;
const LOCK_WAIT_MS = 5_000;

const fail = (field, message) => { throw new Error(`${field}: ${message}`); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const text = (value, field) => {
  if (typeof value !== "string" || !value.trim()) fail(field, "required nonempty string");
  return value;
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonRead = (path) => JSON.parse(readRegular(path));
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function readRegular(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { fail(path, `readable regular file required (${error.code ?? error.message})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(path, "readable regular file required");
  try { return readFileSync(path, "utf8"); } catch (error) { fail(path, `readable (${error.message})`); }
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = lstatSync(path); } catch (error) { fail(path, `directory required (${error.message})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(path, "regular directory required");
  return resolve(path);
}

function inside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`));
}

function safeRequestPath(root, id) {
  if (!REQUEST_ID_RE.test(id)) fail("requestId", "invalid request id");
  const path = join(root, "requests", id);
  if (!inside(path, join(root, "requests"))) fail("requestId", "outside requests root");
  return path;
}

function sleep(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

// mkdir is the portable atomic lock available to the synchronous API.  A
// stale lock is only recovered after a bounded interval; callers never silently
// overwrite a lock owned by a live process.
export function withShortLock(lockPath, fn, { timeoutMs = LOCK_WAIT_MS } = {}) {
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false, mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      try { return fn(); } finally { try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* retain result */ } }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock is stale only when its recorded owner is definitely dead.
      // Age alone is insufficient because a valid callback can exceed the
      // short-lock budget while still holding the lock.
      try {
        const ownerPath = join(lockPath, "owner.json");
        const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid owner");
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (probeError) { alive = probeError.code !== "ESRCH"; }
        if (!alive) rmSync(lockPath, { recursive: true, force: true });
      } catch { /* lock may be new, incomplete, or released between reads */ }
      if (Date.now() - started >= timeoutMs) fail("lock", `busy: ${lockPath}`);
      sleep(10);
    }
  }
}

function atomicWrite(path, value, flag = "w") {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temp, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 });
  try { renameSync(temp, path); } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
}

function sourceRefPath(reference, field) {
  text(reference, field);
  const match = /^(.*?)(?:#line=(\d+))?$/u.exec(reference);
  const path = match?.[1] ?? reference;
  if (!path || path.startsWith("http://") || path.startsWith("https://")) fail(field, "must identify a readable local evidence file");
  const line = match?.[2] ? Number(match[2]) : null;
  if (line !== null && (!Number.isInteger(line) || line < 1)) fail(field, "line must be a positive integer");
  const content = readRegular(path);
  const sourceStat = statSync(path);
  let snapshotContent = content;
  if (line !== null) {
    const row = content.split(/\r?\n/u)[line - 1];
    if (row === undefined || !row.trim()) fail(field, `missing line ${line}`);
    // A line reference is an explicitly bounded evidence record.  Snapshot
    // only that record so appending unrelated session messages does not make
    // a retry a new request.
    snapshotContent = `${row}\n`;
  }
  return { path: resolve(path), line, content: snapshotContent, sourceContentHash: sha256(content), sourceBytes: sourceStat.size, sourceMtime: Math.floor(sourceStat.mtimeMs) };
}

function snapshotEvidence(requestDir, reference, field, label, seen) {
  const parsed = sourceRefPath(reference, field);
  const key = `${parsed.path}#${parsed.line ?? "all"}`;
  if (seen.has(key)) return seen.get(key);
  const digest = sha256(parsed.content);
  const suffix = extname(parsed.path) || ".txt";
  const snapshotName = `${label}-${seen.size + 1}-${digest.slice(0, 12)}${suffix}`;
  const snapshot = join(requestDir, "evidence", snapshotName);
  mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
  writeFileSync(snapshot, parsed.content, { flag: "wx", mode: 0o600 });
  const result = { reference, snapshot, contentHash: digest, bytes: Buffer.byteLength(parsed.content), line: parsed.line, sourceContentHash: parsed.sourceContentHash, sourceBytes: parsed.sourceBytes, sourceMtime: parsed.sourceMtime };
  seen.set(key, result);
  return result;
}

function validSource(source) {
  if (!isObject(source)) fail("source", "required object");
  for (const key of ["host", "sessionId", "messageId", "reference"]) text(source[key], `source.${key}`);
  for (const key of ["host", "sessionId", "messageId"]) {
    if (/^(?:unknown|unk|n\/a|na|null|undefined|none|[-?])$/iu.test(source[key].trim())) fail(`source.${key}`, "identity cannot be determined");
  }
  return { host: source.host, sessionId: source.sessionId, messageId: source.messageId, reference: source.reference };
}

function normalizeKind(kind) {
  if (kind === "request-update") return "update";
  if (kind !== "feedback" && kind !== "update") fail("kind", "feedback or update required");
  return kind;
}

function validateChange(input, kind, hasTarget) {
  if (kind === "update" && input.change === undefined) fail("change", "required for update");
  if (input.change === undefined || input.change === null) return null;
  if (typeof input.change === "string") {
    if (!input.change.trim()) fail("change", "must be nonempty");
    return input.change;
  }
  if (!isObject(input.change)) fail("change", "string or object required");
  const result = { ...input.change };
  const action = result.action ?? (hasTarget ? "modify" : "add");
  if (!new Set(["add", "modify"]).has(action)) fail("change.action", "archive, personal and principle are not authorized by request-update");
  if (hasTarget && action !== "modify") fail("change.action", "targetCardId only permits modify");
  if (!hasTarget && action !== "add") fail("change.action", "an update without targetCardId only permits one add");
  result.action = action;
  return result;
}

function queryList(value, field) {
  if (!Array.isArray(value)) fail(field, "must be an array");
  const seen = new Set();
  const queries = [];
  for (const [index, query] of value.entries()) {
    if (typeof query !== "string" || !query.trim()) fail(`${field}[${index}]`, "must be a nonempty string");
    if (!seen.has(query)) {
      seen.add(query);
      queries.push(query);
    }
  }
  return queries;
}

function normalizeAcceptance(value, kind, question) {
  if (value === undefined) return kind === "update" ? { positiveQueries: [question], negativeQueries: [] } : null;
  if (!isObject(value)) fail("acceptance", "object required");
  if (Object.keys(value).some((key) => !["positiveQueries", "negativeQueries"].includes(key))) fail("acceptance", "only positiveQueries and negativeQueries are allowed");
  const positiveQueries = queryList(value.positiveQueries, "acceptance.positiveQueries");
  const negativeQueries = queryList(value.negativeQueries, "acceptance.negativeQueries");
  if (!positiveQueries.includes(question)) fail("acceptance.positiveQueries", "must include the original question");
  return { positiveQueries, negativeQueries };
}

function cardFiles(root) {
  const out = [];
  const walk = (path) => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (!isActiveCardEntry(entry)) continue;
      if (entry.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  for (const scope of ["work", "common"]) walk(join(root, scope));
  return out.sort();
}

function cardId(markdown) {
  return parseCardMarkdown(markdown, "request-target").cardId;
}

function targetSnapshot(cardsRoot, targetCardId) {
  if (!targetCardId) return { cardId: null, path: null, contentHash: null, exists: false };
  text(targetCardId, "targetCardId");
  const matches = cardFiles(cardsRoot).filter((path) => cardId(readRegular(path)) === targetCardId);
  if (matches.length > 1) fail("targetCardId", "multiple active cards have this id");
  if (!matches.length) return { cardId: targetCardId, path: null, contentHash: null, exists: false };
  const path = matches[0];
  const markdown = readRegular(path);
  return { cardId: targetCardId, path: resolve(path), contentHash: sha256(markdown), bytes: Buffer.byteLength(markdown), exists: true };
}

function queuePath(root) { return join(root, "requests", "queue.json"); }
function queueLockPath(root) { return join(root, "requests", ".queue.lock"); }
function readQueue(root) {
  const path = queuePath(root);
  if (!existsSync(path)) return { schema: QUEUE_SCHEMA, pending: [], claimed: null, updatedAt: null };
  const value = jsonRead(path);
  if (value.schema !== QUEUE_SCHEMA || !Array.isArray(value.pending)) fail("queue", "invalid queue schema");
  return { schema: QUEUE_SCHEMA, pending: [...new Set(value.pending)], claimed: value.claimed ?? null, updatedAt: value.updatedAt ?? null };
}

function writeQueue(root, queue) {
  atomicWrite(queuePath(root), { schema: QUEUE_SCHEMA, pending: queue.pending, claimed: queue.claimed ?? null, updatedAt: new Date().toISOString() });
}

function appendEventUnlocked(requestDir, id, event) {
  const path = join(requestDir, "events.jsonl");
  mkdirSync(requestDir, { recursive: true, mode: 0o700 });
  const row = { schema: "ikb-request-event-v1", requestId: id, recordedAt: new Date().toISOString(), ...event };
  writeFileSync(path, `${JSON.stringify(row)}\n`, { flag: "a", mode: 0o600 });
  return row;
}

function readEvents(requestDir) {
  const path = join(requestDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readRegular(path).split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) { fail("events", `invalid JSON at line ${index + 1}`); }
  });
}

export function resolveRequest(id, { intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT } = {}) {
  const root = ensureDirectory(resolve(intakeRoot));
  const directory = safeRequestPath(root, id);
  const requestPath = join(directory, "request.json");
  if (!existsSync(requestPath)) fail("requestId", `request not found: ${id}`);
  const request = jsonRead(requestPath);
  if (request.schema !== REQUEST_SCHEMA || request.requestId !== id) fail("request", "invalid immutable request snapshot");
  return { request, directory, requestPath };
}

function reportPath(directory) { return join(directory, "report.json"); }

function snapshotHash(value) {
  if (typeof value !== "string") return null;
  try { return sha256(readRegular(value)); } catch { return null; }
}

function publicationSuccess(value) {
  return isObject(value) && value.ok === true && value.status === "success";
}

function finalSuccess(value) {
  return isObject(value) && value.schema === "ikb-final-verification-v1" && value.ok === true;
}

function currentHash(path) {
  try { return sha256(readRegular(path)); } catch { return null; }
}

function finalMatchesRequest(final, request, workspace, publication, plan) {
  if (!finalSuccess(final) || !isObject(publication) || !isObject(plan) || plan.schema !== "ikb-approved-publication-v2" || !Array.isArray(plan.changes) || plan.changes.length === 0) return false;
  if (request.kind !== "update" || plan.requestId !== request.requestId) return false;
  if (final.requestId !== request.requestId || publication.requestId !== request.requestId) return false;
  if (typeof final.planHash !== "string" || typeof publication.planHash !== "string") return false;
  if (typeof request.cardsRoot !== "string" || typeof plan.cardsRoot !== "string" || typeof publication.cardsRoot !== "string") return false;
  let expectedPlanHash;
  try { if (!Array.isArray(publication.operations) || publication.operations.length !== plan.changes.length) return false; expectedPlanHash = planIdentity(plan, {operations: publication.operations}); } catch { return false; }
  if (final.planHash !== expectedPlanHash || publication.planHash !== expectedPlanHash) return false;
  if (resolve(plan.cardsRoot) !== resolve(request.cardsRoot) || resolve(publication.cardsRoot) !== resolve(plan.cardsRoot)) return false;
  if (final.workspace !== undefined && (typeof final.workspace !== "string" || resolve(final.workspace) !== resolve(workspace))) return false;
  if (typeof final.publicationRef !== "string" || resolve(final.publicationRef) !== resolve(join(workspace, "publication-result.json"))) return false;
  if (!Array.isArray(publication.written) || publication.written.length !== plan.changes.length) return false;
  if (!Array.isArray(final.changes) || final.changes.length !== plan.changes.length) return false;
  let written;
  try {
    if (publication.written.some((path) => typeof path !== "string")) return false;
    written = new Set(publication.written.map((path) => resolve(path)));
  } catch { return false; }
  const seen = new Set();
  for (const change of plan.changes) {
    if (!isObject(change) || typeof change.cardId !== "string" || typeof change.path !== "string") return false;
    const path = resolve(change.path);
    if (!inside(path, request.cardsRoot)) return false;
    if (!written.has(path)) return false;
    const actual = final.changes.find((item) => item?.cardId === change.cardId && typeof item.path === "string" && resolve(item.path) === path);
    if (!actual || seen.has(path)) return false;
    seen.add(path);
    if (change.newPath === null) {
      if (actual.afterHash !== null || existsSync(path)) return false;
    } else {
      if (typeof actual.afterHash !== "string" || !/^[a-f0-9]{64}$/u.test(actual.afterHash)) return false;
      const current = currentHash(path);
      const operation = publication.operations.find(item => item.cardId === change.cardId && item.path === change.path);
      if (!operation || typeof operation.after !== "string" || sha256(operation.after) !== actual.afterHash || current === null || current !== actual.afterHash) return false;
    }
  }
  return seen.size === plan.changes.length;
}

function workspaceArtifacts(workspace, request) {
  if (!workspace || !existsSync(workspace)) return { workspace: null, publication: null, final: null, complete: false };
  const publicationPath = join(workspace, "publication-result.json");
  const finalPath = join(workspace, "final-verification.json");
  let publication = null;
  let final = null;
  let plan = null;
  try { if (existsSync(publicationPath)) publication = jsonRead(publicationPath); } catch { publication = { ok: false, error: "invalid publication-result.json" }; }
  try { if (existsSync(finalPath)) final = jsonRead(finalPath); } catch { final = { ok: false, error: "invalid final-verification.json" }; }
  try { if (existsSync(join(workspace, "admitted-plan.json"))) plan = jsonRead(join(workspace, "admitted-plan.json")); } catch { plan = null; }
  return { workspace, publication, final, plan, complete: publicationSuccess(publication) && finalMatchesRequest(final, request, workspace, publication, plan) };
}

function workspaceResultState(workspace) {
  if (!workspace || !existsSync(join(workspace, "results"))) return null;
  const paths = readdirSync(join(workspace, "results"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+\.json$/u.test(entry.name))
    .sort((left, right) => Number(left.name.slice(0, -5)) - Number(right.name.slice(0, -5)));
  if (!paths.length) return null;
  let result;
  try { result = jsonRead(join(workspace, "results", paths.at(-1).name)); } catch { return null; }
  if (!["no_change", "exclude", "defer", "propose_change"].includes(result.action)) return null;
  if (result.action === "defer" || result.action === "propose_change") return { status: "waiting", result, pendingReasons: result.missing ?? [result.reason ?? "review remains pending"] };
  if (result.action === "no_change") return { status: "no_change", result, pendingReasons: [] };
  return { status: "excluded", result, pendingReasons: [] };
}

function finalFailureReasons(final) {
  const failures = Array.isArray(final?.failures) ? final.failures : [];
  const reasons = failures.map((failure) => {
    if (typeof failure === "string" && failure.trim()) return failure;
    if (!isObject(failure)) return null;
    const question = typeof failure.question === "string" && failure.question.trim() ? failure.question.trim() : null;
    const error = [failure.error, failure.reason, failure.message].find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
    if (question && error) return `${question}: ${error}`;
    return error ?? question ?? JSON.stringify(failure);
  }).filter(Boolean);
  return reasons.length ? reasons : ["final verification failed"];
}

function deriveStatus(request, events, root) {
  const workspaceEvent = [...events].reverse().find((event) => event.type === "workspace" && typeof event.workspace === "string");
  const workspace = workspaceEvent?.workspace ?? null;
  const artifacts = workspaceArtifacts(workspace, request);
  if (artifacts.complete) return { status: "completed", workspace, artifacts };
  if (artifacts.final && artifacts.final.ok === false) return { status: "verification_failed", workspace, artifacts, pendingReasons: finalFailureReasons(artifacts.final) };
  if (artifacts.publication && publicationSuccess(artifacts.publication)) return { status: "published_unverified", workspace, artifacts };
  const latestAttempt = events.findLastIndex(event => event.type === "started");
  const failed = events.slice(latestAttempt + 1).findLast(event => event.type === "failed");
  if (failed) return { status: "failed", workspace, artifacts, failure: failed.reason ?? failed.error ?? null };
  const resultState = workspaceResultState(workspace);
  if (resultState) return { ...resultState, workspace, artifacts };
  const queue = readQueue(root);
  const lastStart = Math.max(events.findLastIndex((event) => ["started", "claimed"].includes(event.type)), -1);
  const lastRelease = Math.max(events.findLastIndex((event) => ["released", "failed", "waiting"].includes(event.type)), -1);
  if (lastRelease >= lastStart && events[lastRelease]?.type === "waiting") return { status: "waiting", workspace, artifacts, pendingReasons: [events[lastRelease].reason] };
  if (queue.claimed === request.requestId || lastStart > lastRelease) return { status: "running", workspace, artifacts };
  if (queue.pending.includes(request.requestId)) return { status: "queued", workspace, artifacts };
  if (workspace) return { status: "prepared", workspace, artifacts };
  return { status: "submitted", workspace, artifacts };
}

export function requestStatus(id, options = {}) {
  const root = ensureDirectory(resolve(options.intakeRoot ?? process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT));
  const resolved = resolveRequest(id, { intakeRoot: root });
  const events = readEvents(resolved.directory);
  const derived = deriveStatus(resolved.request, events, root);
  return {
    schema: "ikb-request-status-v1",
    requestId: id,
    request: resolved.request,
    requestPath: resolved.requestPath,
    reportPath: reportPath(resolved.directory),
    status: derived.status,
    workspace: derived.workspace,
    events,
    failure: derived.failure ?? null,
    pendingReasons: derived.pendingReasons ?? [],
    result: derived.result ?? null,
    decision: ["completed", "no_change", "excluded"].includes(derived.status) ? null : ([...events].reverse().find(event => event.type === "report" && event.decision)?.decision ?? null),
    artifacts: derived.artifacts,
  };
}

export function listRequests({ intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, pending = false } = {}) {
  const root = ensureDirectory(resolve(intakeRoot));
  const requestsRoot = join(root, "requests");
  if (!existsSync(requestsRoot)) return [];
  const ids = readdirSync(requestsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && REQUEST_ID_RE.test(entry.name)).map((entry) => entry.name);
  const terminal = new Set(["completed", "no_change", "excluded"]);
  return ids.map((id) => requestStatus(id, { intakeRoot: root })).filter((item) => !pending || !terminal.has(item.status)).sort((a, b) => a.request.submittedAt.localeCompare(b.request.submittedAt) || a.requestId.localeCompare(b.requestId));
}

// This projection is the scheduler's input; status remains owned by existing
// request events and maintenance/publication artifacts.
export function captureRequestInputs({intakeRoot=process.env.IKB_INTAKE_ROOT??DEFAULT_INTAKE_ROOT}={}){
  const root=resolve(intakeRoot);
  const pendingVisible=listRequests({intakeRoot:root,pending:true}).map(item=>({requestId:item.requestId,kind:item.request.kind,status:item.status,requestPath:item.requestPath,reportPath:item.reportPath,pendingReasons:item.pendingReasons,decision:item.decision}));
  const feedbackReady=pendingVisible.filter(item=>!item.decision?.required&&item.kind==='feedback'&&['submitted','prepared'].includes(item.status)).slice(0,10).map(item=>({...item,workspace:join(root,'maintenance','requests',item.requestId)}));
  return {schema:'ikb-request-inputs-v1',intakeRoot:root,capturedAt:new Date().toISOString(),items:pendingVisible,pendingVisible,feedbackReady,runnable:pendingVisible.filter(item=>!item.decision?.required&&item.kind==='update'&&item.status==='queued')};
}

export function submitRequest(input, { kind = "update", intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, cardsRoot = process.env.IKB_CARDS_ROOT } = {}) {
  if (!isObject(input)) fail("input", "JSON object required");
  kind = normalizeKind(kind);
  const root = ensureDirectory(resolve(intakeRoot));
  const cards = ensureDirectory(resolve(cardsRoot ?? join(REPO, "ikb-data", "cards")));
  const source = validSource(input.source);
  const question = text(input.question, "question");
  if (input.scope !== "work") fail("scope", "only work requests are accepted");
  if (input.targetCardId !== undefined && input.targetCardId !== null) text(input.targetCardId, "targetCardId");
  const target = targetSnapshot(cards, input.targetCardId ?? null);
  const change = validateChange(input, kind, Boolean(input.targetCardId));
  const acceptance = normalizeAcceptance(input.acceptance, kind, question);
  const evidenceRefs = input.evidenceRefs === undefined ? [] : input.evidenceRefs;
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) fail("evidenceRefs", "must be an array of references");
  const requestRoot = ensureDirectory(join(root, "requests"));
  const tempRequestDir = join(requestRoot, `.capture-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRequestDir, { recursive: true, mode: 0o700 });
  const seen = new Map();
  let sourceSnapshot;
  try {
    sourceSnapshot = snapshotEvidence(tempRequestDir, source.reference, "source.reference", "source", seen);
    const evidenceSnapshots = evidenceRefs.map((reference, index) => snapshotEvidence(tempRequestDir, reference, `evidenceRefs[${index}]`, "evidence", seen));
    let candidateSnapshot = null;
    if (input.candidatePath !== undefined && input.candidatePath !== null) candidateSnapshot = snapshotEvidence(tempRequestDir, text(input.candidatePath, "candidatePath"), "candidatePath", "candidate", seen);
    const evidenceDigestInput = { source: sourceSnapshot.contentHash, evidence: evidenceSnapshots.map((item) => item.contentHash), candidate: candidateSnapshot?.contentHash ?? null };
    if (acceptance !== null) evidenceDigestInput.acceptance = acceptance;
    const evidenceDigest = sha256(canonical(evidenceDigestInput));
    const stableKey = canonical({ keyVersion: REQUEST_KEY_VERSION, kind, source: { host: source.host, sessionId: source.sessionId, messageId: source.messageId }, targetCardId: input.targetCardId ?? null, intent: typeof change === "string" ? change : change ?? question });
    const requestId = `req-${sha256(`${stableKey}\n${evidenceDigest}`).slice(0, 24)}`;
    const directory = safeRequestPath(root, requestId);
    const requestPath = join(directory, "request.json");
    const submittedAt = new Date().toISOString();
    const request = {
      schema: REQUEST_SCHEMA,
      keyVersion: REQUEST_KEY_VERSION,
      requestId,
      stableKey,
      kind,
      scope: "work",
      source,
      question,
      change,
      ...(acceptance === null ? {} : { acceptance }),
      evidenceRefs: [...evidenceRefs],
      candidatePath: input.candidatePath ?? null,
      target,
      cardsRoot: cards,
      submittedAt,
      evidenceSnapshots: { source: sourceSnapshot, refs: evidenceSnapshots, candidate: candidateSnapshot },
    };
    const moveSnapshot = (snapshot) => snapshot ? { ...snapshot, snapshot: join(directory, "evidence", snapshot.snapshot.split(sep).at(-1)) } : null;
    request.evidenceSnapshots = {
      source: moveSnapshot(sourceSnapshot),
      refs: evidenceSnapshots.map(moveSnapshot),
      candidate: moveSnapshot(candidateSnapshot),
    };
    // Build the complete immutable request directory before publishing it.
    // The final rename happens under the queue lock, so a consumer can never
    // observe a queue entry whose evidence directory is still being moved.
    atomicWrite(join(tempRequestDir, "request.json"), request);
    appendEventUnlocked(tempRequestDir, requestId, { type: "submitted", kind, scope: "work" });
    let result;
    withShortLock(queueLockPath(root), () => {
      if (existsSync(requestPath)) {
        const existing = jsonRead(requestPath);
        if (existing.stableKey !== stableKey || existing.evidenceSnapshots?.source?.contentHash !== sourceSnapshot.contentHash || canonical(existing.evidenceSnapshots?.refs?.map((item) => item.contentHash) ?? []) !== canonical(evidenceSnapshots.map((item) => item.contentHash)) || canonical(existing.acceptance ?? null) !== canonical(acceptance)) fail("request", "stable key collision with different immutable evidence");
        result = { requestId, requestPath, status: requestStatus(requestId, { intakeRoot: root }).status, reportPath: reportPath(directory), reused: true };
        return;
      }
      const related = listRequests({ intakeRoot: root }).filter((item) => item.request.stableKey === stableKey).map((item) => item.requestId);
      if (related.length) request.relatedRequestIds = related;
      if (related.length) atomicWrite(join(tempRequestDir, "request.json"), request);
      renameSync(tempRequestDir, directory);
      const queue = readQueue(root);
      if (kind === "update") {
        if (!queue.pending.includes(requestId) && queue.claimed !== requestId) queue.pending.push(requestId);
      }
      writeQueue(root, queue);
      result = { requestId, requestPath, status: kind === "update" ? "queued" : "submitted", reportPath: reportPath(directory), reused: false };
    });
    if (!existsSync(result.reportPath)) atomicWrite(result.reportPath, requestStatus(requestId, {intakeRoot:root}));
    if (kind === "update") result.execution = {
      mode: "native-subagent", requestId, requestPath,
      workspace: join(root, "maintenance", "requests", requestId),
      contractPath: join(REPO, "scripts", "ikb-request-prompt.md"),
    };
    return result;
  } finally {
    // Capture directories are private and only contain copied evidence.
    try { rmSync(tempRequestDir, { recursive: true, force: true }); } catch { /* request remains durable */ }
  }
}

export function recordRequestEvent(id, event, { intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT } = {}) {
  if (!isObject(event)) fail("event", "object required");
  if (event.type === "published" || event.status === "published" || event.status === "completed") fail("event", "caller cannot declare publication or completion");
  const root = ensureDirectory(resolve(intakeRoot));
  const resolved = resolveRequest(id, { intakeRoot: root });
  const allowed = new Set(["submitted", "claimed", "started", "workspace", "failed", "waiting", "released", "report"]);
  if (typeof event.type !== "string" || !allowed.has(event.type)) fail("event.type", "unsupported execution event");
  if (event.type === "workspace") text(event.workspace, "workspace");
  if (event.type === "started") text(event.runtimeRef, "runtimeRef");
  if (event.type === "claimed") text(event.owner ?? event.runtimeRef, event.owner ? "owner" : "runtimeRef");
  if (event.type === "failed" || event.type === "waiting") text(event.reason ?? event.error, "reason");
  const eventPath = join(resolved.directory, ".events.lock");
  const recorded=withShortLock(eventPath, () => appendEventUnlocked(resolved.directory, id, event));
  atomicWrite(reportPath(resolved.directory),requestStatus(id,{intakeRoot:root}));
  return recorded;
}

// A decision is a structured report in the existing event stream, not a new
// workflow state or a publication approval. Only the current host records it.
export function recordRequestDecision(id, input, { intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT } = {}) {
  if (!isObject(input)) fail("decision", "object required");
  if (!["ask", "resolve"].includes(input.action)) fail("decision.action", "ask or resolve required");
  const root = ensureDirectory(resolve(intakeRoot));
  const resolved = resolveRequest(id, { intakeRoot: root });
  // Keep the original question/answer evidence in the same request evidence store.
  text(input.reference, "decision.reference");
  sourceRefPath(input.reference, "decision.reference");
  let result;
  withShortLock(join(resolved.directory, ".events.lock"), () => {
    const current = requestStatus(id, { intakeRoot: root });
    if (["completed", "no_change", "excluded"].includes(current.status)) fail("decision", "request is already terminal");
    const previous = current.decision;
    if (input.action === "ask") {
      for (const field of ["question", "difference", "recommendation"]) text(input[field], `decision.${field}`);
      if (!Array.isArray(input.options) || input.options.length < 2 || input.options.some(option => typeof option !== "string" || !option.trim())) fail("decision.options", "at least two nonempty choices required");
    } else {
      text(input.expectedDecisionId, "decision.expectedDecisionId");
      text(input.answer, "decision.answer");
      if (!previous?.required || input.expectedDecisionId !== previous.id) fail("decision.expectedDecisionId", "stale or already resolved");
    }
    const captured = snapshotEvidence(resolved.directory, input.reference, "decision.reference", `decision-${readEvents(resolved.directory).length}`, new Map());
    const recordedAt = new Date().toISOString();
    const decision = input.action === "ask" ? {
      id: `decision-${sha256(canonical({ id, input, recordedAt, sequence: readEvents(resolved.directory).length })).slice(0, 24)}`,
      required: true, question: input.question, difference: input.difference,
      recommendation: input.recommendation, options: input.options, reference: captured.snapshot,
      recordedAt,
    } : { ...previous, required: false, answer: input.answer, answerReference: captured.snapshot, resolvedAt: recordedAt };
    appendEventUnlocked(resolved.directory, id, { type: "report", decision });
    result = decision;
  });
  atomicWrite(reportPath(resolved.directory), requestStatus(id, { intakeRoot: root }));
  return { requestId: id, decision: result };
}

export function claimRequest(id, { intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, owner = `manual:${process.pid}` } = {}) {
  const root = ensureDirectory(resolve(intakeRoot));
  const resolved = resolveRequest(id, { intakeRoot: root });
  return withShortLock(queueLockPath(root), () => {
    const queue = readQueue(root);
    if (queue.claimed && queue.claimed !== id) return { claimed: false, reason: "busy", queue };
    if (!queue.pending.includes(id) && queue.claimed !== id) return { claimed: false, reason: "not_pending", queue };
    queue.pending = queue.pending.filter((item) => item !== id);
    queue.claimed = id;
    writeQueue(root, queue);
    withShortLock(join(resolved.directory, ".events.lock"), () => appendEventUnlocked(resolved.directory, id, { type: "claimed", owner }));
    return { claimed: true, queue };
  });
}

export function releaseRequest(id, { intakeRoot = process.env.IKB_INTAKE_ROOT ?? DEFAULT_INTAKE_ROOT, outcome = "released", requeue = false, reason = null } = {}) {
  const root = ensureDirectory(resolve(intakeRoot));
  const resolved = resolveRequest(id, { intakeRoot: root });
  return withShortLock(queueLockPath(root), () => {
    const queue = readQueue(root);
    if (queue.claimed === id) queue.claimed = null;
    if (requeue && !queue.pending.includes(id)) queue.pending.unshift(id);
    writeQueue(root, queue);
    withShortLock(join(resolved.directory, ".events.lock"), () => appendEventUnlocked(resolved.directory, id, requeue
      ? { type: "waiting", reason: reason ?? outcome, outcome }
      : { type: "released", outcome }));
    return queue;
  });
}

export function _readRequestEvents(id, options = {}) {
  const resolved = resolveRequest(id, options);
  return readEvents(resolved.directory);
}

async function cli() {
  const args = process.argv.slice(2);
  const verb = args.shift();
  if (!verb || verb === "--help") {
    console.log("submitRequest/recordRequestEvent APIs; use ikb-cards-cli.mjs feedback --input FILE or request-update --input FILE; request status/list are available there.");
    return;
  }
  fail("command", "this module is an API; use scripts/ikb-cards-cli.mjs");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) cli().catch((error) => { console.error(error.message); process.exitCode = 1; });
