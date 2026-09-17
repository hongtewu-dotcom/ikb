import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordRequestDecision, captureRequestInputs } from "../scripts/ikb-requests.mjs";
import { buildSnapshot, generateWorkbench, renderHtml } from "../scripts/ikb-workbench.mjs";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ikb-workbench-"));
  const intakeRoot = join(root, "intake");
  mkdirSync(intakeRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, intakeRoot, outputDir: join(root, "workbench") };
}

function request(root: string, id: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, "requests", id);
  mkdirSync(dir, { recursive: true });
  const source = join(root, `${id}.txt`);
  writeFileSync(source, "source evidence\n");
  writeFileSync(join(dir, "request.json"), JSON.stringify({
    schema: "ikb-request-v1", requestId: id, kind: "feedback", scope: "work", submittedAt: "2026-09-17T00:00:00.000Z",
    question: "需要核对的问法", source: { host: "test", sessionId: "session-1", messageId: id, reference: source }, evidenceRefs: [source], ...extra,
  }));
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({ type: "submitted", requestId: id }),
    JSON.stringify({ type: extra.eventType ?? "waiting", requestId: id, reason: extra.reason ?? "等待主审" }),
  ].join("\n") + "\n");
}

test("waiting is agent continuation unless the request has explicit user-decision evidence", (t) => {
  const f = fixture(t);
  request(f.intakeRoot, "req-111111111111111111111111", { reason: "等待补证" });
  request(f.intakeRoot, "req-222222222222222222222222", {
    reason: "存在两个明确范围选项", requiresUserDecision: true,
    decision: { difference: "范围 A 或范围 B", recommendation: "先核对范围" },
  });
  const snapshot = buildSnapshot({ intakeRoot: f.intakeRoot, generatedAt: "2026-09-17T01:00:00.000Z" });
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0].id, "req-222222222222222222222222");
  assert.equal(snapshot.agentContinue.length, 1);
  assert.equal(snapshot.agentContinue[0].id, "req-111111111111111111111111");
  assert.match(snapshot.agentContinue[0].reasons.join("\n"), /等待补证/);
});

test("topic cases are retained and source markdown is safely rendered", (t) => {
  const f = fixture(t);
  const topic = join(f.intakeRoot, "maintenance", "topic-frameworks", "person-demo");
  mkdirSync(topic, { recursive: true });
  writeFileSync(join(topic, "framework.md"), "# Demo 人物\n\n- 类型：person\n\n[unsafe](javascript:alert(1)) <script>alert(1)</script>\n");
  writeFileSync(join(topic, "observations.md"), "# Observations\n\n事实记录。\n");
  writeFileSync(join(topic, "synthesis.md"), "# Synthesis\n\n暂定归纳。\n");
  writeFileSync(join(topic, "cases.md"), "# Cases\n\n## W01\n\n一个可展开的具体场景。\n");
  const snapshot = buildSnapshot({ intakeRoot: f.intakeRoot, generatedAt: "2026-09-17T01:00:00.000Z" });
  assert.equal(snapshot.topics[0].cases.markdown.includes("W01"), true);
  const html = renderHtml(snapshot);
  assert.match(html, /一个可展开的具体场景/);
  assert.match(html, /cases/);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /&lt;script&gt;alert/);
});

test("malformed input fails without replacing the previous complete output", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.intakeRoot, "runs", "run-a"), { recursive: true });
  writeFileSync(join(f.intakeRoot, "runs", "run-a", "report.json"), JSON.stringify({ status: "succeeded", exitCode: 0 }));
  generateWorkbench({ intakeRoot: f.intakeRoot, outputDir: f.outputDir, generatedAt: "2026-09-17T01:00:00.000Z" });
  const before = readFileSync(join(f.outputDir, "snapshot.json"), "utf8");
  const bad = join(f.intakeRoot, "requests", "req-333333333333333333333333");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "request.json"), "{ malformed");
  assert.throws(() => generateWorkbench({ intakeRoot: f.intakeRoot, outputDir: f.outputDir }), /request status read failed/);
  assert.equal(readFileSync(join(f.outputDir, "snapshot.json"), "utf8"), before);
  assert.equal(existsSync(join(f.outputDir, "index.html")), true);
});

test("empty intake produces explicit empty sections, and completion quality stays unknown without evidence", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.intakeRoot, "runs", "run-exit-only"), { recursive: true });
  writeFileSync(join(f.intakeRoot, "runs", "run-exit-only", "report.json"), JSON.stringify({ exitCode: 0 }));
  const result = generateWorkbench({ intakeRoot: f.intakeRoot, outputDir: f.outputDir, generatedAt: "2026-09-17T01:00:00.000Z" });
  assert.deepEqual(result.snapshot.decisions, []);
  assert.deepEqual(result.snapshot.agentContinue, []);
  assert.deepEqual(result.snapshot.topics, []);
  assert.equal(result.snapshot.recentRuns[0].quality, "unknown");
  assert.equal(result.snapshot.recentRuns[0].status, "unknown");
  const html = readFileSync(join(f.outputDir, "index.html"), "utf8");
  assert.match(html, /目前没有已登记的待决策问题/);
  assert.match(html, /质量未知/);
});


test("real decision producer appears, updates and resolves without changing publication state", (t) => {
  const f = fixture(t);
  const id = "req-333333333333333333333333";
  request(f.intakeRoot, id);
  const reference = join(f.intakeRoot, `${id}.txt`);
  const input = { action: "ask", reference, question: "采用哪个范围？", difference: "A 只改写作；B 包括沟通", options: ["A", "B"], recommendation: "A" };
  assert.throws(() => recordRequestDecision(id, { ...input, options: [] }, { intakeRoot: f.intakeRoot }), /options/);
  const first = recordRequestDecision(id, input, { intakeRoot: f.intakeRoot });
  let snapshot = buildSnapshot({ intakeRoot: f.intakeRoot });
  assert.equal(snapshot.decisions[0].decisionId, first.decision.id);
  assert.equal(snapshot.decisions[0].question, input.question);
  assert.match(renderHtml(snapshot), /A 只改写作/);
  const second = recordRequestDecision(id, { ...input, difference: "新的具体差异" }, { intakeRoot: f.intakeRoot });
  assert.notEqual(first.decision.id, second.decision.id);
  assert.throws(() => recordRequestDecision(id, { action: "resolve", expectedDecisionId: first.decision.id, reference, answer: "A" }, { intakeRoot: f.intakeRoot }), /stale/);
  recordRequestDecision(id, { action: "resolve", expectedDecisionId: second.decision.id, reference, answer: "A" }, { intakeRoot: f.intakeRoot });
  snapshot = buildSnapshot({ intakeRoot: f.intakeRoot });
  assert.equal(snapshot.decisions.length, 0);
  assert.equal(snapshot.agentContinue.length, 1);
  assert.equal(snapshot.completedRequests.length, 0);
  assert.throws(() => recordRequestDecision(id, { action: "resolve", expectedDecisionId: second.decision.id, reference, answer: "A" }, { intakeRoot: f.intakeRoot }), /stale/);
});


test("scheduler keeps human decisions visible but does not process them as ready feedback", (t) => {
  const f = fixture(t);
  const id = "req-444444444444444444444444";
  request(f.intakeRoot, id, { eventType: "submitted" });
  assert.equal(captureRequestInputs({ intakeRoot: f.intakeRoot }).feedbackReady.length, 1);
  const reference = join(f.intakeRoot, `${id}.txt`);
  const receipt = recordRequestDecision(id, { action: "ask", question: "范围？", difference: "A/B", options: ["A", "B"], recommendation: "A", reference }, { intakeRoot: f.intakeRoot });
  const held = captureRequestInputs({ intakeRoot: f.intakeRoot });
  assert.equal(held.pendingVisible.length, 1);
  assert.equal(held.feedbackReady.length, 0);
  recordRequestDecision(id, { action: "resolve", expectedDecisionId: receipt.decision.id, answer: "A", reference }, { intakeRoot: f.intakeRoot });
  assert.equal(captureRequestInputs({ intakeRoot: f.intakeRoot }).feedbackReady.length, 1);
});

test("an explicitly linked successful retry closes the old failure only for the same intent", async () => {
  const { resolvedRequestHistory } = await import('../scripts/ikb-workbench.mjs');
  const old = { requestId: 'old', status: 'verification_failed', request: { stableKey: 'same-intent' } };
  const success = { requestId: 'new', status: 'completed', request: { stableKey: 'same-intent', relatedRequestIds: ['old'] } };
  assert.equal(resolvedRequestHistory([old, success]).get('old'), 'new');
  assert.equal(resolvedRequestHistory([old, { ...success, status: 'published_unverified' }]).size, 0);
  assert.equal(resolvedRequestHistory([old, { ...success, request: { ...success.request, stableKey: 'different' } }]).size, 0);
  assert.equal(resolvedRequestHistory([old, { ...success, request: { stableKey: 'same-intent' } }]).size, 0);
});

test("human homepage puts results first and keeps machine records folded", (t) => {
  const f = fixture(t);
  request(f.intakeRoot, 'req-666666666666666666666666', { reason: 'internal retry evidence', question: 'very technical original instruction' });
  const html = renderHtml(buildSnapshot({ intakeRoot: f.intakeRoot }));
  assert.ok(html.indexOf('<h2>最近成果</h2>') < html.indexOf('<h2>系统处理记录</h2>'));
  assert.match(html, /<details><summary>内部事项（1 条，不需要你操作）<\/summary>/);
  assert.match(html, /<details><summary>诊断记录（仅供排查）<\/summary>/);
  assert.equal(html.includes('<h2>Agent 可继续</h2>'), false);
  assert.equal(html.includes('<strong>下一步：</strong>'), false);
});

test("the explicit people list controls priority and missing frameworks cannot hide requested people", (t) => {
  const f = fixture(t);
  const root = join(f.intakeRoot, 'maintenance', 'topic-frameworks');
  mkdirSync(join(root, 'person-extra'), { recursive: true });
  writeFileSync(join(root, 'person-extra', 'framework.md'), '# 附加人物｜长期协作主题\n\n- 类型：person；scope：work\n');
  writeFileSync(join(root, 'people-scope.json'), JSON.stringify({ priorityPeople: [{ name: '指定人物', topicId: 'person-requested' }] }));
  const snapshot = buildSnapshot({ intakeRoot: f.intakeRoot });
  assert.equal(snapshot.topics[0].title, '指定人物');
  assert.equal(snapshot.topics[0].featured, true);
  assert.equal(snapshot.topics[1].featured, false);
  const html = renderHtml(snapshot);
  assert.ok(html.indexOf('<h3>指定人物</h3>') < html.indexOf('<summary>其他人物（补充收集）</summary>'));
  assert.ok(html.indexOf('<h3>附加人物</h3>') > html.indexOf('<summary>其他人物（补充收集）</summary>'));
});
