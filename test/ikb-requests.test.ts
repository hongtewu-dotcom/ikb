import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import {
  captureRequestInputs,
  claimRequest,
  listRequests,
  recordRequestEvent,
  releaseRequest,
  requestStatus,
  submitRequest,
  withShortLock,
} from "../scripts/ikb-requests.mjs";
import { planIdentity } from "../scripts/ikb-admission.mjs";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ikb-requests-"));
  const intakeRoot = join(root, "intake");
  const cardsRoot = join(root, "cards");
  const source = join(root, "source.txt");
  mkdirSync(join(cardsRoot, "work"), { recursive: true });
  writeFileSync(join(cardsRoot, "work", "target.md"), "---\nid: target\ntitle: Target\naliases: []\ntags: []\n---\nold\n");
  writeFileSync(source, "user evidence\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = (overrides: Record<string, unknown> = {}) => ({
    scope: "work",
    question: "The target answer is stale",
    source: { host: "catdesk", sessionId: "session-1", messageId: "message-1", reference: source },
    targetCardId: "target",
    change: "replace the stale answer",
    evidenceRefs: [source],
    ...overrides,
  });
  return { root, intakeRoot, cardsRoot, source, input };
}

test("update submission is synchronous, snapshots evidence, and stable retries reuse the request", (t) => {
  const f = fixture(t);
  const first = submitRequest(f.input(), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  assert.equal(first.reused, false);
  assert.equal(first.status, "queued");
  assert.equal(typeof first.requestId, "string");
  assert.ok(existsSync(first.requestPath));
  const snapshot = JSON.parse(readFileSync(first.requestPath, "utf8"));
  assert.equal(snapshot.schema, "ikb-request-v1");
  assert.deepEqual(snapshot.acceptance, { positiveQueries: [snapshot.question], negativeQueries: [] });
  assert.equal(snapshot.target.contentHash.length, 64);
  assert.ok(existsSync(snapshot.evidenceSnapshots.source.snapshot));
  const second = submitRequest(f.input(), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.reused, true);
  assert.equal(listRequests({ intakeRoot: f.intakeRoot }).length, 1);
});

test("request acceptance preserves the original question and changes evidence identity without changing stable intent", (t) => {
  const f = fixture(t);
  const original = submitRequest(f.input({ source: { host: "catdesk", sessionId: "acceptance", messageId: "one", reference: f.source } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const originalSnapshot = JSON.parse(readFileSync(original.requestPath, "utf8"));
  const expanded = submitRequest(f.input({
    source: { host: "catdesk", sessionId: "acceptance", messageId: "one", reference: f.source },
    acceptance: { positiveQueries: ["The target answer is stale", "an independent verification question", "an independent verification question"], negativeQueries: ["a nearby negative", "a nearby negative"] },
  }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  assert.notEqual(expanded.requestId, original.requestId);
  const expandedSnapshot = JSON.parse(readFileSync(expanded.requestPath, "utf8"));
  assert.equal(expandedSnapshot.stableKey, originalSnapshot.stableKey);
  assert.deepEqual(expandedSnapshot.acceptance, { positiveQueries: ["The target answer is stale", "an independent verification question"], negativeQueries: ["a nearby negative"] });
  assert.throws(() => submitRequest(f.input({ acceptance: { positiveQueries: ["a replacement question"], negativeQueries: [] } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false }), /acceptance\.positiveQueries/);
  assert.throws(() => submitRequest(f.input({ acceptance: { positiveQueries: [], negativeQueries: [] } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false }), /acceptance\.positiveQueries/);
  assert.throws(() => submitRequest(f.input({ acceptance: { positiveQueries: ["The target answer is stale"], negativeQueries: [" "] } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false }), /acceptance\.negativeQueries/);
});

test("line bounded evidence ignores unrelated appended session messages", (t) => {
  const f = fixture(t);
  writeFileSync(f.source, "first evidence\nsecond evidence\n");
  const input = f.input({
    source: { host: "catdesk", sessionId: "line-session", messageId: "line-message", reference: `${f.source}#line=1` },
    evidenceRefs: [`${f.source}#line=1`],
  });
  const first = submitRequest(input, { kind: "feedback", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  writeFileSync(f.source, "first evidence\nsecond evidence\nunrelated appended message\n");
  const second = submitRequest(input, { kind: "feedback", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.reused, true);
  const snapshot = JSON.parse(readFileSync(first.requestPath, "utf8"));
  assert.equal(readFileSync(snapshot.evidenceSnapshots.source.snapshot, "utf8"), "first evidence\n");
  assert.equal(snapshot.evidenceSnapshots.source.line, 1);
});

test("stale lock recovery requires a dead recorded owner, never age alone", (t) => {
  const f = fixture(t);
  const lock = join(f.intakeRoot, "requests", ".test.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, startedAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(withShortLock(lock, () => "acquired"), "acquired");
});

test("feedback does not enqueue or wake, and unknown source identity fails by field", (t) => {
  const f = fixture(t);
  const feedback = submitRequest(f.input({ targetCardId: undefined, change: undefined }), { kind: "feedback", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: true });
  assert.equal(JSON.parse(readFileSync(feedback.reportPath,'utf8')).requestId,feedback.requestId);
  assert.equal(feedback.status, "submitted");
  const scheduled = captureRequestInputs({intakeRoot:f.intakeRoot});
  assert.deepEqual(scheduled.feedbackReady.map(item=>item.requestId),[feedback.requestId]);
  assert.deepEqual(scheduled.runnable,[]);
  recordRequestEvent(feedback.requestId,{type:'workspace',workspace:join(f.intakeRoot,'maintenance','requests',feedback.requestId)},{intakeRoot:f.intakeRoot});
  assert.equal(captureRequestInputs({intakeRoot:f.intakeRoot}).feedbackReady.length,1);
  assert.equal(requestStatus(feedback.requestId, { intakeRoot: f.intakeRoot }).status, "prepared");
  assert.throws(() => submitRequest(f.input({ source: { host: "unknown", sessionId: "s", messageId: "m", reference: f.source } }), { kind: "feedback", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false }), /source\.host/);
  assert.throws(() => submitRequest(f.input({ change: undefined }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false }), /change/);
});

test("claim and release handoff drains queued requests without losing wakeups", (t) => {
  const f = fixture(t);
  const a = submitRequest(f.input({ source: { host: "catdesk", sessionId: "s-a", messageId: "m-a", reference: f.source } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const b = submitRequest(f.input({ source: { host: "catdesk", sessionId: "s-b", messageId: "m-b", reference: f.source } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const claimed = claimRequest(a.requestId, { intakeRoot: f.intakeRoot, owner: "test" });
  assert.equal(claimed.claimed, true);
  assert.equal(claimRequest(b.requestId, { intakeRoot: f.intakeRoot }).claimed, false);
  const after = releaseRequest(a.requestId, { intakeRoot: f.intakeRoot, outcome: "failed_execution" });
  assert.deepEqual(after.pending, [b.requestId]);
  assert.equal(claimRequest(b.requestId, { intakeRoot: f.intakeRoot }).claimed, true);
  assert.ok(requestStatus(b.requestId, { intakeRoot: f.intakeRoot }).events.some((event) => event.type === "claimed"));
});

test("update submission returns native subagent handoff and never spawns a dispatcher", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "dispatcher-started");
  const fakeWorker = join(f.root, "fake-worker.mjs");
  writeFileSync(fakeWorker, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "spawned");\n`);
  const priorWorker = process.env.IKB_REQUEST_WORKER;
  process.env.IKB_REQUEST_WORKER = fakeWorker;
  t.after(() => { if (priorWorker === undefined) delete process.env.IKB_REQUEST_WORKER; else process.env.IKB_REQUEST_WORKER = priorWorker; });
  const started = Date.now();
  const request = submitRequest(f.input(), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot });
  assert.ok(Date.now() - started < 500, "submission must not wait for an executor");
  assert.equal(request.status, "queued");
  assert.deepEqual(request.execution, {
    mode: "native-subagent",
    requestId: request.requestId,
    requestPath: request.requestPath,
    workspace: join(f.intakeRoot, "maintenance", "requests", request.requestId),
    contractPath: join(process.cwd(), "scripts", "ikb-request-prompt.md"),
  });
  assert.equal(request.dispatch, undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(marker), false, "submit must never spawn the legacy dispatcher");
  assert.equal(requestStatus(request.requestId, { intakeRoot: f.intakeRoot }).status, "queued");
});

test("status requires publication success and final verification bound to current target", (t) => {
  const f = fixture(t);
  const request = submitRequest(f.input(), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const workspace = join(f.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  recordRequestEvent(request.requestId, { type: "workspace", workspace }, { intakeRoot: f.intakeRoot });
  const targetPath = join(f.cardsRoot, "work", "target.md");
  const targetHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
  const plan = { schema: "ikb-approved-publication-v2", requestId: request.requestId, intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, authorizationBasis: {}, changes: [{ cardId: "target", action: "modify", knowledgeKind: "normal", path: targetPath, oldPath: targetPath, newPath: targetPath }] };
  writeFileSync(join(workspace, "admitted-plan.json"), JSON.stringify(plan));
  const planHash = planIdentity(plan);
  writeFileSync(join(workspace, "publication-result.json"), JSON.stringify({ schema: "ikb-publication-result-v1", ok: true, status: "success", requestId: request.requestId, planHash, cardsRoot: f.cardsRoot, written: [targetPath], operations: [{cardId: "target", action: "modify", path: targetPath, before: readFileSync(targetPath,"utf8"), after: readFileSync(targetPath,"utf8")}] }));
  writeFileSync(join(workspace, "final-verification.json"), JSON.stringify({ schema: "ikb-final-verification-v1", ok: true, requestId: request.requestId, planHash, publicationRef: join(workspace, "publication-result.json"), workspace, changes: [{ cardId: "target", path: targetPath, afterHash: targetHash }] }));
  assert.equal(requestStatus(request.requestId, { intakeRoot: f.intakeRoot }).status, "completed");
  assert.throws(() => recordRequestEvent(request.requestId, { type: "published" }, { intakeRoot: f.intakeRoot }), /publication/);

  const verificationFailure = submitRequest(f.input({ source: { host: "catdesk", sessionId: "verification-failure", messageId: "verification-failure", reference: f.source } }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const failedWorkspace = join(f.root, "verification-failure-workspace");
  mkdirSync(failedWorkspace, { recursive: true });
  recordRequestEvent(verificationFailure.requestId, { type: "workspace", workspace: failedWorkspace }, { intakeRoot: f.intakeRoot });
  writeFileSync(join(failedWorkspace, "final-verification.json"), JSON.stringify({ schema: "ikb-final-verification-v1", ok: false, requestId: verificationFailure.requestId, failures: [{ question: "The target answer is stale", error: "target was not recalled" }] }));
  assert.equal(requestStatus(verificationFailure.requestId, { intakeRoot: f.intakeRoot }).status, "verification_failed");
  assert.deepEqual(requestStatus(verificationFailure.requestId, { intakeRoot: f.intakeRoot }).pendingReasons, ["The target answer is stale: target was not recalled"]);
  assert.ok(listRequests({ intakeRoot: f.intakeRoot, pending: true }).some((item) => item.requestId === verificationFailure.requestId));

  const addRequest = submitRequest(f.input({ source: { host: "catdesk", sessionId: "missing-add", messageId: "missing-add", reference: f.source }, targetCardId: undefined, change: "add the requested card" }), { kind: "update", intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, wake: false });
  const addWorkspace = join(f.root, "missing-add-workspace");
  mkdirSync(addWorkspace, { recursive: true });
  recordRequestEvent(addRequest.requestId, { type: "workspace", workspace: addWorkspace }, { intakeRoot: f.intakeRoot });
  const addPath = join(f.cardsRoot, "work", "added.md");
  const candidatePath = join(addWorkspace, "added.md");
  writeFileSync(candidatePath, "candidate bytes\n");
  const addPlan = { schema: "ikb-approved-publication-v2", requestId: addRequest.requestId, intakeRoot: f.intakeRoot, cardsRoot: f.cardsRoot, authorizationBasis: {}, changes: [{ cardId: "added", action: "add", knowledgeKind: "normal", path: addPath, oldPath: null, newPath: candidatePath }] };
  const addPlanHash = planIdentity(addPlan);
  writeFileSync(join(addWorkspace, "admitted-plan.json"), JSON.stringify(addPlan));
  writeFileSync(join(addWorkspace, "publication-result.json"), JSON.stringify({ schema: "ikb-publication-result-v1", ok: true, status: "success", requestId: addRequest.requestId, planHash: addPlanHash, cardsRoot: f.cardsRoot, written: [addPath], operations: [{cardId: "added", action: "add", path: addPath, before: null, after: "candidate bytes\n"}] }));
  writeFileSync(join(addWorkspace, "final-verification.json"), JSON.stringify({ schema: "ikb-final-verification-v1", ok: true, requestId: addRequest.requestId, planHash: addPlanHash, publicationRef: join(addWorkspace, "publication-result.json"), changes: [{ cardId: "added", path: addPath, afterHash: createHash("sha256").update("candidate bytes\n").digest("hex") }] }));
  assert.equal(requestStatus(addRequest.requestId, { intakeRoot: f.intakeRoot }).status, "published_unverified", "a missing current add target cannot complete from a final hash alone");
});

test("a native continuation preserves old failures without hiding the current attempt", (t) => {
  const f=fixture(t),options={intakeRoot:f.intakeRoot};
  const r=submitRequest(f.input(),{...options,cardsRoot:f.cardsRoot});
  recordRequestEvent(r.requestId,{type:'failed',reason:'old process stopped'},options);
  assert.equal(requestStatus(r.requestId,options).status,'failed');
  recordRequestEvent(r.requestId,{type:'started',runtimeRef:'native-host:test/author'},options);
  assert.equal(requestStatus(r.requestId,options).status,'running');
  recordRequestEvent(r.requestId,{type:'waiting',reason:'native model capacity unavailable'},options);
  const state=requestStatus(r.requestId,options);
  assert.equal(state.status,'waiting');
  assert.deepEqual(state.pendingReasons,['native model capacity unavailable']);
  assert.ok(state.events.some(e=>e.type==='failed'));
});
