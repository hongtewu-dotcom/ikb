import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureKnowledge } from "../src/knowledge.ts";
import { buildKnowledgeUsageStatus, retrySuppressedKnowledgeIds } from "../src/knowledge-usage.ts";
import { finishRunAndAssess } from "../src/run-completion.ts";
import { LedgerStore } from "../src/store.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

test("search records both matched and zero-result queries without changing its output shape", () => {
  const home = freshHome();
  const knowledge = captureKnowledge(home, {
    title: "可追溯检索标记",
    scope: "work",
    body: "可追溯检索标记用于验证本地查询账本。",
  });

  const matched = invoke(home, ["search", "可追溯检索标记", "--scope", "work"]);
  assert.equal(matched.status, 0, matched.stderr);
  const matchedRows = JSON.parse(matched.stdout);
  assert.ok(Array.isArray(matchedRows));
  assert.equal(matchedRows.some((item: { id: string }) => item.id === knowledge.id), true);

  const missing = invoke(home, ["search", "绝不会命中的检索词-9f01897a", "--scope", "work"]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), []);

  const store = new LedgerStore({ home });
  const events = store.listEvents().filter((event) => event.eventType === "knowledge.query_executed");
  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.aggregateType === "knowledge_query"), true);
  assert.deepEqual(events.map((event) => event.payload.mode), ["search", "search"]);
  assert.deepEqual(events.map((event) => event.payload.resultCount), [1, 0]);
  assert.deepEqual(events.map((event) => event.payload.zeroResult), [false, true]);
  assert.equal(events[0].payload.contractVersion, "knowledge-usage.v1");
  store.close();
});

test("context query links its query id to Knowledge references", () => {
  const home = freshHome();
  const knowledge = captureKnowledge(home, {
    title: "上下文查询关联标记",
    scope: "work",
    body: "上下文查询关联标记用于验证查询与引用之间的关系。",
  });
  const store = new LedgerStore({ home });
  const task = store.createTask({
    title: "上下文查询关联标记",
    goal: "读取上下文查询关联标记",
    acceptance: "查询事件能够关联引用事件",
    scope: "work",
  });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  store.close();

  const result = invoke(home, ["context", task.id, "--run", run.id]);
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.results.some((item: { id: string }) => item.id === knowledge.id), true);

  const replay = new LedgerStore({ home });
  const query = replay.listEvents().find((event) => event.eventType === "knowledge.query_executed" && event.payload.runId === run.id);
  assert.ok(query);
  assert.equal(query.aggregateType, "knowledge_query");
  assert.equal(query.payload.mode, "context");
  assert.equal(query.payload.contextArtifactId, context.contextArtifact.id);
  assert.deepEqual(query.payload.units.map((unit: { unitId: string }) => unit.unitId), context.units.map((unit: { unitId: string }) => unit.unitId));
  const reference = replay.listEvents().find((event) => event.eventType === "knowledge.referenced" && event.aggregateId === knowledge.id && event.payload.runId === run.id);
  assert.ok(reference);
  assert.equal(reference.payload.contractVersion, "knowledge-usage.v1");
  assert.equal(reference.payload.queryId, query.aggregateId);
  assert.equal(reference.payload.queryEventId, query.eventId);
  assert.deepEqual(reference.payload.selectedUnitIds, context.units.map((unit: { unitId: string }) => unit.unitId));
  assert.equal(buildKnowledgeUsageStatus(replay, run.id).referenceCount, 1);
  replay.close();
});

test("actual use is evidence-bound and feedback closes every referenced Knowledge", () => {
  const home = freshHome();
  const usedKnowledge = captureKnowledge(home, {
    title: "真实采用知识标记",
    scope: "work",
    body: "真实采用知识标记用于影响最终交付物。",
  });
  const unusedKnowledge = captureKnowledge(home, {
    title: "仅召回未采用标记",
    scope: "work",
    body: "仅召回未采用标记只进入上下文，不进入最终交付物。",
  });
  const store = new LedgerStore({ home });
  const task = store.createTask({
    title: "真实采用知识标记与仅召回未采用标记",
    goal: "验证实际使用和最终反馈",
    acceptance: "每条引用都有明确结论",
    scope: "work",
  });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const resultPath = join(home, "最终交付物.md");
  writeFileSync(resultPath, "# 最终交付物\n\n采用真实知识形成一个检查项。\n");
  const resultArtifact = store.createArtifact({ runId: run.id, path: resultPath, kind: "deliverable", label: "最终交付物" });
  store.close();

  const contextCall = invoke(home, ["context", task.id, "--run", run.id]);
  assert.equal(contextCall.status, 0, contextCall.stderr);
  const context = JSON.parse(contextCall.stdout);
  assert.equal(context.results.some((item: { id: string }) => item.id === usedKnowledge.id), true);
  assert.equal(context.results.some((item: { id: string }) => item.id === unusedKnowledge.id), true);

  const missingArtifact = invoke(home, ["knowledge", "use", usedKnowledge.id, "--run", run.id, "--purpose", "check", "--note", "用于形成最终检查项"]);
  assert.notEqual(missingArtifact.status, 0);
  assert.match(missingArtifact.stderr, /--artifact/);

  writeFileSync(resultPath, "# 被篡改的交付物\n");
  const tamperedArtifact = invoke(home, ["knowledge", "use", usedKnowledge.id, "--run", run.id, "--artifact", resultArtifact.id, "--purpose", "check", "--note", "用于形成最终检查项"]);
  assert.notEqual(tamperedArtifact.status, 0);
  assert.match(tamperedArtifact.stderr, /content hash mismatch/);
  writeFileSync(resultPath, "# 最终交付物\n\n采用真实知识形成一个检查项。\n");

  const used = invoke(home, ["knowledge", "use", usedKnowledge.id, "--run", run.id, "--artifact", resultArtifact.id, "--purpose", "check", "--note", "用于形成最终检查项"]);
  assert.equal(used.status, 0, used.stderr);
  const usedResult = JSON.parse(used.stdout);
  const repeated = invoke(home, ["knowledge", "use", usedKnowledge.id, "--run", run.id, "--artifact", resultArtifact.id, "--purpose", "check", "--note", "用于形成最终检查项"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).eventId, usedResult.eventId);

  const beforeFeedback = new LedgerStore({ home });
  const statusBefore = buildKnowledgeUsageStatus(beforeFeedback, run.id);
  assert.equal(statusBefore.complete, false);
  assert.deepEqual(statusBefore.usedKnowledgeIds, [usedKnowledge.id]);
  assert.deepEqual(statusBefore.unresolvedKnowledgeIds.sort(), [unusedKnowledge.id, usedKnowledge.id].sort());
  assert.equal(beforeFeedback.listEvents().filter((event) => event.eventType === "knowledge.used").length, 1);
  beforeFeedback.close();
  const statusCall = invoke(home, ["knowledge", "usage-status", "--run", run.id]);
  assert.equal(statusCall.status, 0, statusCall.stderr);
  assert.equal(JSON.parse(statusCall.stdout).complete, false);

  const prematureFinish = invoke(home, ["run", "succeed", run.id, "--summary", "不应成功"]);
  assert.notEqual(prematureFinish.status, 0);
  assert.match(prematureFinish.stderr, /尚有 2 条 Knowledge 未记录最终效果/);

  const helpfulWithoutEvidence = invoke(home, ["knowledge", "feedback", usedKnowledge.id, "--run", run.id, "--outcome", "helpful", "--reason-code", "improved_check"]);
  assert.notEqual(helpfulWithoutEvidence.status, 0);
  assert.match(helpfulWithoutEvidence.stderr, /requires at least one --evidence Artifact/);

  const helpful = invoke(home, ["knowledge", "feedback", usedKnowledge.id, "--run", run.id, "--outcome", "helpful", "--reason-code", "improved_check", "--note", "直接形成了交付物中的检查项", "--evidence", resultArtifact.id]);
  assert.equal(helpful.status, 0, helpful.stderr);
  const helpfulRepeated = invoke(home, ["knowledge", "feedback", usedKnowledge.id, "--run", run.id, "--outcome", "helpful", "--reason-code", "improved_check", "--note", "直接形成了交付物中的检查项", "--evidence", resultArtifact.id]);
  assert.equal(helpfulRepeated.status, 0, helpfulRepeated.stderr);
  assert.equal(JSON.parse(helpfulRepeated.stdout).eventId, JSON.parse(helpful.stdout).eventId);

  const helpfulWithoutUse = invoke(home, ["knowledge", "feedback", unusedKnowledge.id, "--run", run.id, "--outcome", "helpful", "--reason-code", "looked_relevant", "--evidence", context.contextArtifact.id]);
  assert.notEqual(helpfulWithoutUse.status, 0);
  assert.match(helpfulWithoutUse.stderr, /requires a prior knowledge use/);

  const unused = invoke(home, ["knowledge", "feedback", unusedKnowledge.id, "--run", run.id, "--outcome", "unused", "--reason-code", "not_relevant", "--note", "召回后核对发现与交付目标无关", "--evidence", context.contextArtifact.id]);
  assert.equal(unused.status, 0, unused.stderr);

  const conflict = invoke(home, ["knowledge", "feedback", unusedKnowledge.id, "--run", run.id, "--outcome", "incorrect", "--reason-code", "changed_mind", "--evidence", context.contextArtifact.id]);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already has final feedback/);

  const completeStore = new LedgerStore({ home });
  const complete = buildKnowledgeUsageStatus(completeStore, run.id);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.unresolvedKnowledgeIds, []);
  assert.equal(completeStore.listEvents().filter((event) => event.eventType === "knowledge.feedback_recorded").every((event) => event.payload.contractVersion === "knowledge-usage.v1"), true);
  completeStore.close();

  const finished = invoke(home, ["run", "succeed", run.id, "--summary", "知识使用反馈已闭环"]);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).status, "succeeded");
});

test("usage status separates reviewed incorrect unadopted Knowledge from adopted incorrect feedback", () => {
  const home = freshHome();
  const evidencePath = join(home, "review-result.md");
  writeFileSync(evidencePath, "# Review result\n\nThe retrieved card was rejected before adoption.\n");
  const knowledge = captureKnowledge(home, {
    title: "审阅后未采用的错误知识",
    scope: "work",
    body: "该卡在审阅后被判定错误，但没有进入交付物。",
  });
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "审阅未采用知识", goal: "区分采用后的错误与审阅拒绝", acceptance: "状态保留父卡闭合语义", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const artifact = store.createArtifact({ runId: run.id, path: evidencePath, kind: "deliverable", label: "审阅结果" });
  store.recordKnowledgeEvent(knowledge.id, "knowledge.referenced", {
    contractVersion: "knowledge-usage.v1",
    taskId: task.id,
    runId: run.id,
    contextArtifactId: artifact.id,
  });
  store.recordKnowledgeEvent(knowledge.id, "knowledge.feedback_recorded", {
    contractVersion: "knowledge-usage.v1",
    taskId: task.id,
    runId: run.id,
    outcome: "unused",
    reviewFinding: "incorrect",
    reasonCode: "source_conflicts_with_current_state",
    note: "审阅发现来源与当前一手事实冲突，未写入交付物",
    evidenceRefs: [artifact.id],
  });

  const status = buildKnowledgeUsageStatus(store, run.id);
  assert.equal(status.complete, true);
  assert.deepEqual(status.usedKnowledgeIds, []);
  assert.equal(status.outcomes.unused, 1);
  assert.equal(status.outcomes.incorrect ?? 0, 0);
  assert.deepEqual(status.reviewedIncorrectUnadoptedKnowledgeIds, [knowledge.id]);
  assert.equal(status.reviewedIncorrectUnadoptedKnowledgeCount, 1);
  store.close();
});

test("historical references without the new query contract remain finishable", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "历史任务", goal: "保持兼容", acceptance: "旧 Run 可结束", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  store.recordKnowledgeEvent("kb-legacy", "knowledge.referenced", { taskId: task.id, runId: run.id, query: "legacy" });
  const status = buildKnowledgeUsageStatus(store, run.id);
  assert.deepEqual(status.reviewedIncorrectUnadoptedKnowledgeIds, []);
  assert.equal(status.reviewedIncorrectUnadoptedKnowledgeCount, 0);
  const finished = finishRunAndAssess(store, run.id, "succeeded", "legacy compatible");
  assert.equal(finished.status, "succeeded");
  store.close();
});

test("retry suppression uses the latest ancestor feedback for each Knowledge card", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "重试反馈覆盖", goal: "后续反馈覆盖先前未采用反馈", acceptance: "只抑制最新反馈仍明确无关的知识", scope: "work" });
  const ancestor = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const retry = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"], ancestor.id);
  const knowledgeId = "kb-latest-feedback-wins";

  store.recordKnowledgeEvent(knowledgeId, "knowledge.feedback_recorded", {
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "unrelated-domain",
  });
  store.recordKnowledgeEvent(knowledgeId, "knowledge.feedback_recorded", {
    runId: ancestor.id,
    outcome: "helpful",
    reasonCode: "applied-to-deliverable",
  });

  assert.deepEqual(retrySuppressedKnowledgeIds(store, retry.id), []);
  store.close();
});

test("retry suppression accepts only the exact not-applicable whitelist", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "重试原因白名单", goal: "仅抑制明确无关的反馈原因", acceptance: "精确 reasonCode 行为保持稳定", scope: "work" });
  const ancestor = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const retry = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"], ancestor.id);

  store.recordKnowledgeEvent("kb-not-applicable-other", "knowledge.feedback_recorded", {
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "not-applicable-other",
  });
  store.recordKnowledgeEvent("kb-not-applicable", "knowledge.feedback_recorded", {
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "not-applicable",
  });
  store.recordKnowledgeEvent("kb-retrieved-but-not-applicable", "knowledge.feedback_recorded", {
    runId: ancestor.id,
    outcome: "unused",
    reasonCode: "retrieved-but-not-applicable",
  });

  assert.deepEqual(retrySuppressedKnowledgeIds(store, retry.id), [
    "kb-not-applicable",
    "kb-retrieved-but-not-applicable",
  ]);
  store.close();
});

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-knowledge-usage-"));
}

function invoke(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    cliPath,
    ...args,
    "--home",
    home,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
}
