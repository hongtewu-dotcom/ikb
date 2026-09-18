import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordRequestDecision } from "../scripts/ikb-requests.mjs";
import { startServer } from "../scripts/ikb-workbench-server.mjs";

function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ikb-workbench-server-"));
  const intakeRoot = join(root, "intake");
  mkdirSync(intakeRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, intakeRoot };
}

function httpGet(port: number, pathname: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function post(port: number, pathname: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: pathname, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function addWaitingRequest(intakeRoot: string, id: string) {
  const requestRoot = join(intakeRoot, "requests", id);
  mkdirSync(requestRoot, { recursive: true });
  const source = join(intakeRoot, `${id}.txt`);
  writeFileSync(source, "source evidence\n");
  writeFileSync(join(requestRoot, "request.json"), JSON.stringify({
    schema: "ikb-request-v1",
    requestId: id,
    kind: "feedback",
    scope: "work",
    submittedAt: "2026-09-17T00:00:00.000Z",
    question: "实时读取的测试问题",
    source: { host: "test", sessionId: "session-1", messageId: id, reference: source },
    evidenceRefs: [source],
  }));
  writeFileSync(join(requestRoot, "events.jsonl"), [
    JSON.stringify({ type: "submitted", requestId: id }),
    JSON.stringify({ type: "waiting", requestId: id, reason: "等待主审" }),
  ].join("\n") + "\n");
}

async function runningServer(t: { after: (fn: () => void | Promise<void>) => void }, intakeRoot: string) {
  const server = startServer({ intakeRoot, port: 0 });
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

test("API reads existing sources afresh and returns rendered HTML", async (t) => {
  const f = fixture(t);
  const running = await runningServer(t, f.intakeRoot);
  const first = await httpGet(running.port, "/api/snapshot");
  assert.equal(first.status, 200);
  const firstPayload = JSON.parse(first.body);
  assert.deepEqual(firstPayload.snapshot.decisions, []);
  assert.match(firstPayload.html, /data-live-section="decisions"/);

  addWaitingRequest(f.intakeRoot, "req-111111111111111111111111");
  const second = await httpGet(running.port, "/api/snapshot", { Origin: `http://127.0.0.1:${running.port}` });
  assert.equal(second.status, 200);
  const secondPayload = JSON.parse(second.body);
  assert.equal(secondPayload.snapshot.agentContinue.length, 1);
  assert.match(secondPayload.html, /实时读取的测试问题/);
});

test("live API exposes a human decision and removes it after the recorded resolution", async (t) => {
  const f = fixture(t);
  const id = "req-333333333333333333333333";
  addWaitingRequest(f.intakeRoot, id);
  const reference = join(f.intakeRoot, `${id}.txt`);
  const asked = recordRequestDecision(id, {
    action: "ask",
    reference,
    question: "采用哪个范围？",
    difference: "A 只改写作；B 包括沟通",
    options: ["A", "B"],
    recommendation: "A",
  }, { intakeRoot: f.intakeRoot });
  const running = await runningServer(t, f.intakeRoot);
  const pending = await httpGet(running.port, "/api/snapshot");
  assert.equal(pending.status, 200);
  assert.equal(JSON.parse(pending.body).snapshot.decisions[0].decisionId, asked.decision.id);
  assert.equal(JSON.parse(pending.body).snapshot.metrics.decisions.pending, 1);
  assert.match(JSON.parse(pending.body).html, /data-live-section="metrics"/);

  recordRequestDecision(id, { action: "resolve", expectedDecisionId: asked.decision.id, answer: "A", reference }, { intakeRoot: f.intakeRoot });
  const resolved = await httpGet(running.port, "/api/snapshot");
  assert.equal(resolved.status, 200);
  const resolvedSnapshot = JSON.parse(resolved.body).snapshot;
  assert.deepEqual(resolvedSnapshot.decisions, []);
  assert.equal(resolvedSnapshot.metrics.decisions.pending, 0);
  assert.equal(resolvedSnapshot.agentContinue.length, 1);
});

test("malformed source is a recoverable 503 and never an empty success", async (t) => {
  const f = fixture(t);
  const running = await runningServer(t, f.intakeRoot);
  const first = await httpGet(running.port, "/api/snapshot");
  assert.equal(first.status, 200);
  const malformed = join(f.intakeRoot, "requests", "req-222222222222222222222222");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, "request.json"), "{ malformed");
  const failed = await httpGet(running.port, "/api/snapshot");
  assert.equal(failed.status, 503);
  const payload = JSON.parse(failed.body);
  assert.equal("snapshot" in payload, false);
  assert.equal("html" in payload, false);
  assert.match(payload.error, /request status read failed/);
});

test("refresh output never becomes snapshot input, while broken run reports still fail", async (t) => {
  const f = fixture(t);
  const runDir = join(f.intakeRoot, "runs", "catdesk-increment", "prepare-test");
  mkdirSync(runDir, { recursive: true });
  const report = join(runDir, "report.json");
  const refresh = join(runDir, "workbench-refresh.json");
  writeFileSync(report, JSON.stringify({ status: "completed", summary: "actual run evidence" }));
  writeFileSync(refresh, ""); // Existing failed shell redirection from the incident.
  writeFileSync(join(runDir, ".workbench-refresh-test.tmp"), "{");
  const running = await runningServer(t, f.intakeRoot);
  for (const output of ["", "{", JSON.stringify({ status: "waiting", reason: "projection only" })]) {
    writeFileSync(refresh, output);
    const response = await httpGet(running.port, "/api/snapshot");
    assert.equal(response.status, 200, response.body);
    const snapshot = JSON.parse(response.body).snapshot;
    assert.equal(snapshot.recentRuns[0].summary, "actual run evidence");
    assert.equal(snapshot.incremental.records.some((item: { path: string }) => item.path === refresh), false);
    assert.equal(snapshot.incremental.unreconciled.length, 0);
  }
  writeFileSync(report, "");
  const failed = await httpGet(running.port, "/api/snapshot");
  assert.equal(failed.status, 503);
  assert.match(JSON.parse(failed.body).error, /report\.json: malformed JSON/);
});

test("HTTP surface is local, same-origin GET only, with a real-time page shell", async (t) => {
  const f = fixture(t);
  const running = await runningServer(t, f.intakeRoot);
  const validHost = { Host: `127.0.0.1:${running.port}` };
  const badHost = await httpGet(running.port, "/api/snapshot", { Host: `evil.example:${running.port}` });
  assert.equal(badHost.status, 403);
  const absoluteForeignUrl = await httpGet(running.port, `http://evil.example:${running.port}/api/snapshot`, validHost);
  assert.equal(absoluteForeignUrl.status, 403);
  const badOrigin = await httpGet(running.port, "/api/snapshot", { Origin: "http://evil.example" });
  assert.equal(badOrigin.status, 403);
  const wrongPath = await httpGet(running.port, "/anything");
  assert.equal(wrongPath.status, 404);
  const method = await post(running.port, "/api/snapshot");
  assert.equal(method.status, 405);

  const page = await httpGet(running.port, "/", validHost);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>IKB 实时工作台<\/title>/);
  assert.match(page.body, /data-live-section="decisions"/);
  assert.match(page.body, /href="#decisions"/);
  assert.match(page.body, /fetch\('\/api\/snapshot\?ts='/);
  assert.match(page.body, /pollMs=5000/);
  assert.match(page.body, /保留上次成功数据/);
  assert.match(page.body, /data-state="connected"/);
  assert.match(page.body, /#b42318/);
  assert.doesNotMatch(page.body, /只读静态快照/);
  assert.equal(page.headers["access-control-allow-origin"], undefined);
});

test("file links open through a bounded source viewer, including topic directories", async (t) => {
  const f = fixture(t);
  addWaitingRequest(f.intakeRoot, "req-777777777777777777777777");
  const source = join(f.intakeRoot, "req-777777777777777777777777.txt");
  writeFileSync(source, '<script>bad()</script> reference text');
  const topic = join(f.intakeRoot, 'maintenance', 'topic-frameworks', 'demo');
  mkdirSync(topic, { recursive: true });
  writeFileSync(join(topic, 'framework.md'), '# Example framework\n');
  const { port } = await runningServer(t, f.intakeRoot);
  const page = await httpGet(port, '/');
  assert.equal(page.body.includes('href="file://'), false);
  const links = [...page.body.matchAll(/href="(\/source\/[a-f0-9]+)"/g)].map(m => m[1]);
  assert.ok(links.length > 0);
  const responses = await Promise.all([...new Set(links)].map(path => httpGet(port, path)));
  assert.ok(responses.some(r => r.status === 200 && r.body.includes('&lt;script&gt;bad()&lt;/script&gt; reference text')));
  assert.ok(responses.some(r => r.status === 200 && r.body.includes('framework.md')));
  assert.ok(responses.every(r => !r.body.includes('<script>bad()</script>')));
  assert.equal((await httpGet(port, '/source/unknown?path=/etc/passwd')).status, 404);
  rmSync(source);
  const disappeared = await Promise.all([...new Set(links)].map(path => httpGet(port, path)));
  assert.ok(disappeared.some(r => r.status === 404 && r.body.includes('文件不存在')));
  const secret = join(f.root, 'unrelated.txt');
  writeFileSync(secret, 'unrelated-private-content');
  symlinkSync(secret, source);
  const redirected = await Promise.all([...new Set(links)].map(path => httpGet(port, path)));
  assert.ok(redirected.some(r => r.status === 403));
  assert.ok(redirected.every(r => !r.body.includes('unrelated-private-content')));
});

test('live stock metrics update after a real card is added and do not guess its knowledge kind', async t => {
  const f = fixture(t);
  const cards = join(f.root, 'cards', 'work', 'domains');
  mkdirSync(cards, { recursive: true });
  const card = (id: string) => `---\nid: ${id}\ntitle: ${id}\naliases: []\ntags: []\nsources: ["source record"]\nupdated_at: 2026-09-01\n---\n\n## 是什么／怎么做\n有具体来源的知识。\n`;
  writeFileSync(join(cards, 'first.md'), card('first'));
  const { port } = await runningServer(t, f.intakeRoot);
  const first = JSON.parse((await httpGet(port, '/api/snapshot')).body);
  assert.equal(first.snapshot.metrics.stock.total, 1);
  assert.equal(first.snapshot.metrics.stock.knowledgeKinds.unknown, 1);
  assert.match(first.html, /data-live-section="stock"/);
  writeFileSync(join(cards, 'second.md'), card('second'));
  const second = JSON.parse((await httpGet(port, '/api/snapshot')).body);
  assert.equal(second.snapshot.metrics.stock.total, 2);
  assert.equal(second.snapshot.metrics.stock.byCategory.domains, 2);
  assert.equal(second.snapshot.metrics.stock.knowledgeKinds.normal, 0);
});
