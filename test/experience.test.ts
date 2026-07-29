import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";
import { clusterExperienceRecords, listExperienceCandidates, listExperienceRecords, triageSessions } from "../src/experience.ts";

function source(home: string, directory: string, index: number): { id: string; recordId: string } {
  const path = join(directory, `session-${index}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: `session-${index}`, messageId: `u-${index}`, timestamp: `2026-07-21T0${index}:00:00Z`, content: "失败了，重试后不对。必须补充边界和校验，改成可验证的修复。" }),
    JSON.stringify({ role: "assistant", conversationId: `session-${index}`, messageId: `a-${index}`, timestamp: `2026-07-21T0${index}:01:00Z`, content: "确认根因，修复后安排回归验证。" }),
  ].join("\n") + "\n");
  const result = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  return { id: result.source.id, recordId: result.records[0].id };
}

function runForSource(store: LedgerStore, sourceId: string, index: number, validate = false): string {
  const task = store.createTask({ title: `triage-${index}`, goal: "triage", acceptance: "evidence", scope: "work" });
  const run = store.createRun(task.id, "ikb-test", ["triage"]);
  store.recordSourceEvent(sourceId, "source.context_built", { runId: run.id, records: 2 });
  if (validate) {
    store.recordHarnessEvent(run.id, "run.verification_completed", { result: "pass", checks: [{ id: "real", decision: "pass", evidenceRefs: ["artifact-test"] }], artifactRefs: ["artifact-test"] });
  }
  return run.id;
}

test("Session Triage stores evidence references, skips tool output and never writes Knowledge", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "triage", messageId: "u1", content: "不对，失败后要重跑，必须补充边界。" }),
    JSON.stringify({ role: "tool", conversationId: "triage", messageId: "t1", content: "巨大的工具输出 error error error" }),
    JSON.stringify({ role: "assistant", conversationId: "triage", messageId: "a1", content: "修复根因并做回归。" }),
  ].join("\n") + "\n");
  const imported = importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const store = new LedgerStore({ home });
  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSources, 1);
  assert.equal(result.selected, 1);
  assert.equal(result.created, 1);
  assert.equal(result.skippedToolRecords, 1, "triage excludes any tool records that entered a generic Source");
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.ok(records[0].evidenceRecordIds.some((id) => id.includes(imported.source.id)));
  assert.ok(records[0].signalCodes.includes("manual_correction"));
  assert.equal(existsSync(join(home, "vaults")), false);
  assert.equal(store.listEvents().filter((event) => event.eventType === "experience.queued").length, 1);
  const second = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 1);
  store.close();
});

test("Experience clustering requires independent Runs and produces a pending Knowledge Candidate", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-cluster-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const store = new LedgerStore({ home });
  for (let index = 1; index <= 3; index += 1) {
    const item = source(home, inputs, index);
    runForSource(store, item.id, index);
  }
  const triage = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(triage.selected, 3);
  const cluster = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(cluster.eligible, 1);
  assert.equal(cluster.created, 1);
  assert.equal(cluster.candidates[0].status, "pending_review");
  assert.equal(cluster.candidates[0].candidateKnowledge.claim, null);
  assert.equal(cluster.candidates[0].independentRunCount, 3);
  assert.equal(listExperienceCandidates(home, "work").length, 1);
  assert.equal(existsSync(join(home, "vaults")), false);
  const again = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(again.created, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(store.listEvents().filter((event) => event.eventType === "experience.candidate_created").length, 1);
  store.close();
});

test("Two independent Runs need a real validation before promotion", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-validation-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const store = new LedgerStore({ home });
  for (let index = 1; index <= 2; index += 1) {
    const item = source(home, inputs, index);
    runForSource(store, item.id, index, index === 2);
  }
  triageSessions(home, store, { scope: "work", adapter: "claude" });
  const cluster = clusterExperienceRecords(home, store, { scope: "work", minimumSamples: 3 });
  assert.equal(cluster.eligible, 1);
  assert.equal(cluster.candidates[0].validationRefs.length, 1);
  store.close();
});

test("Session Triage ignores runtime envelopes, embedded tool results and evaluation subjects", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-noise-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "noise.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "tool-noise", messageId: "u1", content: "帮我看一下这个项目。" }),
    JSON.stringify({ role: "assistant", conversationId: "tool-noise", messageId: "a1", content: "[external_agent_tool_result] 文档里写了失败、重试、Verifier 驳回和修复。 [/external_agent_tool_result]" }),
    JSON.stringify({ role: "user", conversationId: "system-noise", messageId: "u2", content: "<sandbox_context>必须校验，失败后重试。</sandbox_context>\n\n把 md 默认改成预览。" }),
    JSON.stringify({ role: "assistant", conversationId: "system-noise", messageId: "a2", content: "已修改设置。" }),
    JSON.stringify({ role: "user", conversationId: "evaluation-noise", messageId: "u3", content: "# 知识质量第二轮检查\n\n被评估卡片写着：失败后重试，必须补充边界和验证。\n\n## 输出格式\n只输出 JSON。" }),
    JSON.stringify({ role: "assistant", conversationId: "evaluation-noise", messageId: "a3", content: "{\"notes\":\"建议回原文复核\"}" }),
    JSON.stringify({ role: "user", conversationId: "real-event", messageId: "u4", content: "继续处理刚才的任务。" }),
    JSON.stringify({ role: "assistant", conversationId: "real-event", messageId: "a4", content: "checkout 失败，当前被环境变量阻断；环境恢复后重试。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "codex" });
  assert.equal(result.scannedSessions, 4);
  assert.equal(result.selected, 1);
  assert.equal(result.records[0]?.sourceTitle.includes("noise"), true);
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].signalCodes, ["failure_or_block", "retry"]);
  assert.equal(records[0].triageDisposition, "selected");
  assert.ok(result.skippedToolRecords + result.skippedNonEventRecords >= 2);
  store.close();
});

test("Session Triage does not treat explicit success or negated errors as failures", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-negation-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "success.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "success", messageId: "u1", content: "把 Markdown 默认打开方式改成预览。" }),
    JSON.stringify({ role: "assistant", conversationId: "success", messageId: "a1", content: "改好了。JSON 已校验，没有语法错误，也未发现异常。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "desk", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "desk" });
  assert.equal(result.scannedSessions, 1);
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredSessions, 1);
  assert.equal(listExperienceRecords(home, "work").length, 0);
  store.close();
});

test("Session Triage ignores automated prompt sessions, conditional failures and successful build warnings", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-semantic-noise-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "semantic-noise.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "automated", messageId: "u1", content: "# System\n你是业务知识结构化提取引擎。必须输出边界、失败路径和验证规则。" }),
    JSON.stringify({ role: "assistant", conversationId: "automated", messageId: "a1", content: "文档说明失败后重试，并补充了异常边界。" }),
    JSON.stringify({ role: "user", conversationId: "business-rule", messageId: "u2", content: "往返燃油费如何查询？" }),
    JSON.stringify({ role: "assistant", conversationId: "business-rule", messageId: "a2", content: "如果任一程请求失败，就按航线里程走兜底逻辑；这描述的是业务规则。" }),
    JSON.stringify({ role: "user", conversationId: "successful-build", messageId: "u3", content: "编译结果怎样？" }),
    JSON.stringify({ role: "assistant", conversationId: "successful-build", messageId: "a3", content: "BUILD SUCCESS。[ERROR] version is missing 是 enforcer 告警，非编译错误，不影响构建。" }),
    JSON.stringify({ role: "user", conversationId: "automation", messageId: "u4", content: "<automation_context name=\"巡检\">每天检查文档并输出报告。</automation_context>\n收到任务后执行断链检查。" }),
    JSON.stringify({ role: "assistant", conversationId: "automation", messageId: "a4", content: "巡检完成；历史文档只包含错误码说明，本次无新增断链。" }),
    JSON.stringify({ role: "user", conversationId: "prompt-design", messageId: "u5", content: "把定时任务的提示词精简一下。" }),
    JSON.stringify({ role: "assistant", conversationId: "prompt-design", messageId: "a5", content: "原提示词包含 SSO 失败后重试和手动调用接口的兜底说明，现已删除这些实现细节。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSessions, 5);
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredSessions, 5);
  store.close();
});

test("Session Triage distinguishes ordinary task instructions from explicit durable decisions", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-decision-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "decisions.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "task", messageId: "u1", content: "盘点这些目录，必须查看边界和规则，最后输出报告。" }),
    JSON.stringify({ role: "assistant", conversationId: "task", messageId: "a1", content: "盘点完成。" }),
    JSON.stringify({ role: "user", conversationId: "decision", messageId: "u2", content: "我决定后续统一使用 properties，禁止新增 yml。" }),
    JSON.stringify({ role: "assistant", conversationId: "decision", messageId: "a2", content: "收到，作为后续项目约束。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "codex" });
  assert.equal(result.scannedSessions, 2);
  assert.equal(result.selected, 1);
  const records = listExperienceRecords(home, "work");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].signalCodes, ["decision_or_rule"]);
  store.close();
});

test("Session Triage reconciles a stale prompt-only Experience and clustering excludes it", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-reconcile-"));
  const home = join(sandbox, "ikb-data");
  const inputs = join(sandbox, "inputs");
  mkdirSync(inputs, { recursive: true });
  const path = join(inputs, "prompt.jsonl");
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "prompt-only", messageId: "u1", content: "你是统计子 agent。失败后重试，必须校验。只输出报告。" }),
    JSON.stringify({ role: "assistant", conversationId: "prompt-only", messageId: "a1", content: "报告已完成。" }),
  ].join("\n") + "\n");
  const imported = importSource(home, path, { kind: "ai_conversation", adapter: "desk", scope: "work" });
  const sessionKey = `desk|${imported.source.originalPath}|prompt-only`;
  const id = `exp-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`;
  const directory = join(home, "experiences", "work");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    schema: "ikb-experience.v1",
    id,
    scope: "work",
    adapter: "desk",
    sourceTitle: imported.source.title,
    sourceIds: [imported.source.id],
    sourceOriginHash: imported.source.contentHash,
    sessionKeyHash: "a".repeat(32),
    conversationIdHash: "b".repeat(32),
    sourceRecordIds: imported.records.map((record) => record.id),
    evidenceRecordIds: imported.records.map((record) => record.id),
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    signalCodes: ["failure_or_block", "retry", "verifier_rejection"],
    signalCounts: {
      failure_or_block: 1,
      retry: 1,
      manual_correction: 0,
      verifier_rejection: 1,
      non_obvious_fix: 0,
      knowledge_feedback: 0,
      decision_or_rule: 1
    },
    status: "queued",
    firstSeenAt: "2026-07-21T00:00:00Z",
    lastSeenAt: "2026-07-21T00:00:01Z",
    createdAt: "2026-07-21T00:00:02Z",
    updatedAt: "2026-07-21T00:00:02Z"
  }, null, 2));
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "desk" });
  assert.equal(result.selected, 0);
  assert.equal(result.ignoredUpdated, 1);
  const reconciled = listExperienceRecords(home, "work")[0];
  assert.equal(reconciled.triageDisposition, "ignored");
  assert.deepEqual(reconciled.signalCodes, []);
  assert.ok(reconciled.exclusionReasons.includes("no_semantic_signal_after_filtering"));
  assert.equal(clusterExperienceRecords(home, store, { scope: "work" }).clusters, 0);
  store.close();
});

test("Session Triage retires legacy Experiences whose Sources left the active analysis plane", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-triage-quarantine-"));
  const home = join(sandbox, "ikb-data");
  const input = join(sandbox, "specx-session.jsonl");
  writeFileSync(input, `${JSON.stringify({ role: "user", conversationId: "legacy", messageId: "u1", content: "失败了，需要重试。" })}\n`);
  const imported = importSource(home, input, { kind: "ai_conversation", adapter: "claude", scope: "work" });
  const sessionKey = `claude|${imported.source.originalPath}|legacy`;
  const id = `exp-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`;
  const directory = join(home, "experiences", "work");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    schema: "ikb-experience.v1",
    id,
    scope: "work",
    adapter: "claude",
    sourceTitle: imported.source.title,
    sourceIds: [imported.source.id],
    sourceOriginHash: imported.source.contentHash,
    sessionKeyHash: "a".repeat(32),
    conversationIdHash: "b".repeat(32),
    sourceRecordIds: imported.records.map((record) => record.id),
    evidenceRecordIds: imported.records.map((record) => record.id),
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    signalCodes: ["failure_or_block", "retry"],
    signalCounts: {
      failure_or_block: 1,
      retry: 1,
      manual_correction: 0,
      verifier_rejection: 0,
      non_obvious_fix: 0,
      knowledge_feedback: 0,
      decision_or_rule: 0
    },
    status: "queued",
    firstSeenAt: "2026-07-21T00:00:00Z",
    lastSeenAt: "2026-07-21T00:00:01Z",
    createdAt: "2026-07-21T00:00:02Z",
    updatedAt: "2026-07-21T00:00:02Z"
  }, null, 2));
  const store = new LedgerStore({ home });

  const result = triageSessions(home, store, { scope: "work", adapter: "claude" });
  assert.equal(result.scannedSources, 0);
  assert.equal(result.inactiveSourceRecords, 1);
  assert.equal(result.ignoredUpdated, 1);
  const reconciled = listExperienceRecords(home, "work")[0];
  assert.equal(reconciled.triageDisposition, "ignored");
  assert.deepEqual(reconciled.signalCodes, []);
  assert.deepEqual(reconciled.exclusionReasons, ["source_outside_active_plane"]);
  store.close();
});
