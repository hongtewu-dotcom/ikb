import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activateIkbUsageV2,
  collectIkbRecallRolloutsV2,
  collectIkbRecallRollouts,
  detectIkbUsagePurpose,
  ikbUsageV2Paths,
  readIkbUsageV2Summary,
  scanUserCorrections,
} from "../src/ikb-recall.ts";
import { runIkbRecallCli } from "../src/ikb-recall-cli.ts";
import { runIkbWeeklySummaryCli, buildWeeklySummaryV2 } from "../src/ikb-weekly-summary-cli.ts";
import { projectIkbUsageV2 } from "../src/ikb-usage-v2.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function search(retrievalId: string, cardId: string, path: string): Record<string, unknown> {
  return {
    schema: "ikb-card-search-result-v1", retrievalId, scope: "work", queryHash: hash(`query-${retrievalId}`),
    total: 1, count: 1, offset: 0, hasMore: false, nextOffset: null, zeroResult: false,
    items: [{ cardId, title: "safe title", path, contentHash: hash(cardId), matchedFields: ["title"], snippet: "safe snippet" }],
  };
}

function rows(threadId: string, turns: Array<{ turnId: string; startedAt: string; completedAt: string; command?: string; output?: unknown; source?: unknown; parentThreadId?: string; finalText?: string }>): unknown[] {
  const first = turns[0];
  const result: unknown[] = [{ timestamp: first.startedAt, type: "session_meta", payload: { id: threadId, session_id: threadId, source: first.source ?? "exec", ...(first.parentThreadId ? { parent_thread_id: first.parentThreadId } : {}) } }];
  for (const turn of turns) {
    result.push({ timestamp: turn.startedAt, type: "event_msg", payload: { type: "task_started", turn_id: turn.turnId } });
    if (turn.command) {
      result.push({ timestamp: turn.startedAt, type: "event_msg", payload: { type: "item_completed", turn_id: turn.turnId, item: { type: "CommandExecution", command: turn.command, ...(turn.output === undefined ? {} : { output: turn.output }) } } });
    }
    result.push({ timestamp: turn.completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: turn.turnId, last_agent_message: turn.finalText ?? "done" } });
  }
  return result;
}

function writeRows(path: string, values: unknown[]): void {
  writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

test("v2 requires explicit activation and excludes turns started before activation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-activation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  writeRows(join(sessions, "turns.jsonl"), rows("thread-v2-boundary", [
    { turnId: "before", startedAt: "2026-09-01T01:00:00.000Z", completedAt: "2026-09-01T03:00:00.000Z", command: "ikb search --scope work --query before", output: JSON.stringify(search("before", "before-card", cardPath)) },
    { turnId: "after", startedAt: "2026-09-01T02:00:00.000Z", completedAt: "2026-09-01T02:00:01.000Z", command: "IKB_USAGE_PURPOSE=maintenance ikb search --scope work --query after", output: JSON.stringify(search("after", "after-input-card", cardPath)) },
  ]));
  const preActivation = collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z", generatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(preActivation.status, "unavailable");
  assert.deepEqual(preActivation.issues, [{ reasonCode: "activation_required", count: 1 }]);
  const activation = activateIkbUsageV2(root, "2026-09-01T02:00:00.000Z");
  assert.equal(activation.activatedAt, "2026-09-01T02:00:00.000Z");
  const report = collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z", generatedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(report.status, "ready");
  assert.equal(report.completedTurns, 1);
  assert.equal(report.attempts, 1);
  const summary = readIkbUsageV2Summary(root)!;
  assert.equal(summary.cumulative.attempts, 1);
  assert.equal(summary.cumulative.origins["codex|root|maintenance"], 1);
  assert.equal(summary.cumulative.cards["after-input-card"].references, 0);
  assert.equal(summary.cumulative.cards["after-input-card"].states.recalled_not_read, 1);
  assert.equal(existsSync(join(root, "usage", "summary.json")), true);
  assert.equal(existsSync(join(root, "usage-v2")), false);
  const second = collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, generatedAt: "2026-09-02T00:00:00.000Z" });
  // The first invocation used an explicit window, so it intentionally did not
  // advance the incremental cursor.  Replaying it must still be idempotent at
  // the attempt ledger and summary levels.
  assert.equal(second.matchedTurns, 1);
  assert.equal(readIkbUsageV2Summary(root)!.cumulative.attempts, 1);
});

test("v2 preserves success, failure, missing, invalid and unknown attempts and degrades on ambiguity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-outcomes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  const valid = search("success", "success-card", cardPath);
  const invalid = { ...valid, queryHash: "bad" };
  const second = search("ambiguous", "second-card", cardPath);
  writeRows(join(sessions, "outcomes.jsonl"), [
    { timestamp: "2026-09-03T00:00:00.000Z", type: "session_meta", payload: { id: "thread-v2-outcomes", session_id: "thread-v2-outcomes", source: "exec" } },
    { timestamp: "2026-09-03T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "outcomes" } },
    { timestamp: "2026-09-03T00:00:00.100Z", type: "event_msg", payload: { type: "item_completed", turn_id: "outcomes", item: { type: "CommandExecution", command: "ikb search --scope work --query success", output: JSON.stringify(valid) } } },
    { timestamp: "2026-09-03T00:00:00.200Z", type: "event_msg", payload: { type: "item_completed", turn_id: "outcomes", item: { type: "CommandExecution", command: "ikb search --scope work --query failure", exit_code: 1, output: "permission denied" } } },
    { timestamp: "2026-09-03T00:00:00.250Z", type: "event_msg", payload: { type: "command_execution", turn_id: "outcomes", command: "ikb search --scope work --query event-failure", exit_code: 2, output: "permission denied" } },
    { timestamp: "2026-09-03T00:00:00.300Z", type: "event_msg", payload: { type: "item_completed", turn_id: "outcomes", item: { type: "CommandExecution", command: "ikb search --scope work --query missing", output: "not json" } } },
    { timestamp: "2026-09-03T00:00:00.400Z", type: "event_msg", payload: { type: "item_completed", turn_id: "outcomes", item: { type: "CommandExecution", command: "ikb search --scope work --query invalid", output: JSON.stringify(invalid) } } },
    { timestamp: "2026-09-03T00:00:00.500Z", type: "event_msg", payload: { type: "item_completed", turn_id: "outcomes", item: { type: "CommandExecution", command: "ikb search --scope work --query ambiguous", output: { structuredContent: valid, content: [{ type: "text", text: JSON.stringify(second) }] } } } },
    { timestamp: "2026-09-03T00:00:00.600Z", type: "response_item", payload: { type: "function_call", name: "mcp__ikb_cards__ikb_get_card", call_id: "never-ended", arguments: "{}", internal_chat_message_metadata_passthrough: { turn_id: "outcomes" } } },
    { timestamp: "2026-09-03T00:00:01.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "outcomes", last_agent_message: "done" } },
  ]);
  activateIkbUsageV2(root, "2026-09-03T00:00:00.000Z");
  const report = collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, generatedAt: "2026-09-03T00:00:02.000Z" });
  assert.equal(report.status, "degraded");
  assert.equal(report.attempts, 7);
  const summary = readIkbUsageV2Summary(root)!;
  assert.deepEqual(summary.cumulative.outcomes, { success: 1, failure: 2, missing: 1, invalid: 1, unknown: 2 });
  assert.equal(summary.issueCounts.ikb_cli_failure, 1);
  assert.equal(summary.issueCounts.ikb_result_ambiguous, 1);
  assert.equal(summary.issueCounts.ikb_result_unknown, 1);
  const evidence = readFileSync(ikbUsageV2Paths(root).evidence, "utf8");
  assert.equal(evidence.includes(cardPath), false);
  assert.equal(evidence.includes("permission denied"), false);
});

test("purpose markers and explicit card correction candidates keep provenance without false positives", () => {
  assert.equal(detectIkbUsagePurpose({ cmd: "IKB_USAGE_PURPOSE=interactive ikb search --scope work --query x" }), "interactive");
  assert.equal(detectIkbUsagePurpose("IKB_USAGE_PURPOSE=maintenance。执行 scripts/catdesk-increment-prompt.md"), "maintenance");
  assert.equal(detectIkbUsagePurpose({ cmd: "ikb search --scope work --query x" }), null);
  const base = {
    turnId: "correction", startedAt: "2026-09-03T00:00:00.000Z", completedAt: "2026-09-03T00:00:01.000Z", finalText: "done",
    userMessages: [], searches: [], reads: [], ikbCalls: 0, issues: [], feedbackTexts: [],
  };
  assert.equal(scanUserCorrections("thread", { ...base, feedbackTexts: ["读取 Multica Root Issue 时认证会话已过期，你看看"] }).length, 0);
  assert.equal(scanUserCorrections("thread", { ...base, feedbackTexts: ["二、IKB 反馈已按维护流程落地为候选卡，不用这么复杂"] }).length, 0);
  const candidate = scanUserCorrections("thread", { ...base, feedbackTexts: ["卡片内容错误，本次不要采用"] });
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0].classification, "candidate");
  assert.equal(candidate[0].matchedRule, "incorrect");
  assert.equal(candidate[0].matchedText, "卡片内容错误");
  assert.equal(candidate[0].sourceEventRef, "run://codex/thread/correction");
});

test("v2 retains root and subagent origin metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-origin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  writeRows(join(sessions, "root.jsonl"), rows("thread-root", [
    { turnId: "root-turn", startedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:01.000Z", command: "ikb search --scope work --query root", output: JSON.stringify(search("root", "root-card", cardPath)) },
  ]));
  writeRows(join(sessions, "subagent.jsonl"), rows("thread-subagent", [
    { turnId: "sub-turn", startedAt: "2026-09-04T00:00:02.000Z", completedAt: "2026-09-04T00:00:03.000Z", source: { subagent: { thread_spawn: { parent_thread_id: "thread-root", depth: 1, agent_role: "reader" } } }, command: "IKB_USAGE_PURPOSE=regression ikb search --scope work --query sub", output: JSON.stringify(search("sub", "sub-card", cardPath)) },
  ]));
  activateIkbUsageV2(root, "2026-09-04T00:00:00.000Z");
  collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, generatedAt: "2026-09-04T00:00:04.000Z" });
  const summary = readIkbUsageV2Summary(root)!;
  assert.equal(summary.cumulative.origins["codex|root|unknown"], 1);
  assert.equal(summary.cumulative.origins["codex|subagent|regression"], 1);
});

test("v2 uses per-attempt purpose and falls back to detail purpose", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-attempt-purpose-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  activateIkbUsageV2(root, "2026-09-04T00:00:00.000Z");
  const origin = { host: "codex", sessionSource: "exec", relationship: "root" as const, parentThreadId: null, subagentDepth: null, agentRole: null, purpose: "interactive" as const };
  const detail = {
    schema: "ikb-recall-usage-evidence-v2" as const,
    version: "v2" as const,
    subjectRef: "run://codex/thread-attempt-purpose/turn",
    subjectHash: hash("attempt-purpose-detail"),
    startedAt: "2026-09-04T00:00:01.000Z",
    completedAt: "2026-09-04T00:00:02.000Z",
    origin,
    provenance: origin,
    attempts: [
      { attemptKey: hash("attempt-maintenance"), operation: "search" as const, outcome: "success" as const, sourceEventRef: "run://codex/thread-attempt-purpose/turn/event/1", observedAt: "2026-09-04T00:00:01.100Z", purpose: "maintenance" as const },
      { attemptKey: hash("attempt-fallback"), operation: "get" as const, outcome: "missing" as const, sourceEventRef: "run://codex/thread-attempt-purpose/turn/event/2", observedAt: "2026-09-04T00:00:01.200Z" },
    ],
    searches: [], reads: [], states: [], issues: [],
  };
  const summary = projectIkbUsageV2(root, [detail], "2026-09-04T00:00:03.000Z");
  assert.equal(summary.cumulative.origins["codex|root|maintenance"], 1);
  assert.equal(summary.cumulative.origins["codex|root|interactive"], 1);
});

test("v2 summary keeps a rolling seven-day timestamp window and cumulative data separate", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  writeRows(join(sessions, "days.jsonl"), rows("thread-v2-days", [
    { turnId: "old", startedAt: "2026-09-08T11:59:59.000Z", completedAt: "2026-09-08T11:59:59.500Z", command: "ikb search --scope work --query old", output: JSON.stringify(search("old", "old-card", cardPath)) },
    { turnId: "boundary", startedAt: "2026-09-08T12:00:00.000Z", completedAt: "2026-09-08T12:00:01.000Z", command: "ikb search --scope work --query boundary", output: JSON.stringify(search("boundary", "boundary-card", cardPath)) },
    { turnId: "future", startedAt: "2026-09-15T12:00:01.000Z", completedAt: "2026-09-15T12:00:02.000Z", command: "ikb search --scope work --query future", output: JSON.stringify(search("future", "future-card", cardPath)) },
  ]));
  activateIkbUsageV2(root, "2026-09-08T00:00:00.000Z");
  collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, to: "2026-09-15T12:00:03.000Z", generatedAt: "2026-09-15T12:00:00.000Z" });
  const summary = readIkbUsageV2Summary(root)!;
  assert.equal(summary.cumulative.attempts, 3);
  assert.equal(summary.last7Days.attempts, 1);
  assert.equal(summary.window.last7DaysUtc.from, "2026-09-08T12:00:00.000Z");
  assert.equal(summary.window.last7DaysUtc.to, "2026-09-15T12:00:00.000Z");
});

test("v2 weekly summary uses seven-day card reads/references and does not infer principle directories", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-v2-weekly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "summary.json"), `${JSON.stringify({
    schema: "ikb-recall-usage-summary-v2", version: "v2", generatedAt: "2026-09-15T12:00:00.000Z",
    activation: { activatedAt: "2026-09-01T00:00:00.000Z", activationKey: "activation" },
    window: { last7DaysUtc: { from: "2026-09-08T12:00:00.000Z", to: "2026-09-15T12:00:00.000Z" }, cumulative: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-15T12:00:00.000Z" } },
    last7Days: { attempts: 2, searches: 1, reads: 1, states: 2, zeroResults: 0, outcomes: { success: 2, failure: 0, missing: 0, invalid: 0, unknown: 0 }, origins: { "codex|root|interactive": 2 }, cards: { "principle-card": { reads: 1, references: 1, states: { read_adopted: 1 } }, "unread-card": { reads: 0, references: 0, states: { recalled_not_read: 1 } } } },
    cumulative: { attempts: 3, searches: 2, reads: 2, states: 2, zeroResults: 0, outcomes: { success: 3, failure: 0, missing: 0, invalid: 0, unknown: 0 }, origins: { "codex|root|interactive": 3 }, cards: {} },
    issueCounts: {}, evidenceCount: 2,
  }, null, 2)}\n`);
  writeFileSync(join(root, "user-corrections.jsonl"), [
    { schema: "ikb-recall-user-correction-v1", correctionKey: "old", detectedAt: "2026-09-08T11:59:59.999Z", subjectRef: "run://codex/t/old", label: "incorrect", excerpt: "旧", hadIkbCall: true, classification: "candidate" },
    { schema: "ikb-recall-user-correction-v1", correctionKey: "c", detectedAt: "2026-09-15T10:00:00.000Z", subjectRef: "run://codex/t/u", label: "incorrect", excerpt: "卡片错误", hadIkbCall: true, classification: "candidate" },
    { schema: "ikb-recall-user-correction-v1", correctionKey: "future", detectedAt: "2026-09-15T12:00:00.001Z", subjectRef: "run://codex/t/future", label: "incorrect", excerpt: "未来", hadIkbCall: true, classification: "candidate" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(root, "missed-lookup-candidates.jsonl"), [
    { schema: "ikb-recall-missed-lookup-candidate-v1", candidateKey: "old", detectedAt: "2026-09-08T11:59:59.999Z", subjectRef: "run://codex/t/old", excerpt: "旧" },
    { schema: "ikb-recall-missed-lookup-candidate-v1", candidateKey: "current", detectedAt: "2026-09-15T10:00:00.000Z", subjectRef: "run://codex/t/u", excerpt: "当前" },
    { schema: "ikb-recall-missed-lookup-candidate-v1", candidateKey: "future", detectedAt: "2026-09-15T12:00:00.001Z", subjectRef: "run://codex/t/future", excerpt: "未来" },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const report = buildWeeklySummaryV2(root, new Date("2026-09-15T12:00:00.000Z"));
  assert.match(report, /## 卡片读取与引用/);
  assert.match(report, /principle-card：reads 1 ｜ references 1/);
  assert.match(report, /unread-card：reads 0 ｜ references 0/);
  assert.match(report, /用户纠正（最近 7 天 1 条，累计 3 条）/);
  assert.match(report, /该查没查（最近 7 天 1 条，累计 3 条）/);
  assert.match(report, /累计：attempts 3/);
  assert.doesNotMatch(report, /common\//);
  assert.doesNotMatch(report, /work\/practices/);
});

test("default collect and weekly report use activated canonical usage without touching archive", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-unified-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  activateIkbUsageV2(root, "2026-09-01T00:00:00.000Z");
  const archive = join(root, "usage", "archive", "v1"); mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "summary.json"), "legacy untouched");
  let output = "";
  const io = { stdout: { write: (s: string) => { output += s; } }, stderr: { write: (s: string) => { output += s; } } } as any;
  assert.equal(runIkbRecallCli(["collect", "--data-root", root, "--sessions", sessions], io), 0);
  assert.equal(JSON.parse(output).version, "v2");
  assert.throws(() => collectIkbRecallRollouts({ activeDataRoot: root, sessionRoots: [sessions] }), /v2/);
  output = "";
  assert.equal(runIkbWeeklySummaryCli(["--usage-root", join(root, "usage")], io), 0);
  assert.equal(JSON.parse(output).schema, "ikb-weekly-summary-v2");
  assert.equal(readFileSync(join(archive, "summary.json"), "utf8"), "legacy untouched");
});

test("unmigrated split directories fail before legacy writes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-split-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "usage-v2"));
  assert.throws(() => collectIkbRecallRollouts({ activeDataRoot: root, sessionRoots: [root] }), /migration/);
  assert.equal(existsSync(join(root, "usage")), false);
});

test("card ID handling still rejects sensitive fields and unsafe IDs in summary maps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  activateIkbUsageV2(root, "2026-09-01T00:00:00.000Z");
  const summary = projectIkbUsageV2(root, [], "2026-09-02T00:00:00.000Z");
  const path = ikbUsageV2Paths(root).summary;
  writeFileSync(path, JSON.stringify({ ...summary, cumulative: { ...summary.cumulative, cards: { "valid-input-card": { rawText: "private" } } } }));
  assert.throws(() => readIkbUsageV2Summary(root), /restricted field/);
  writeFileSync(path, JSON.stringify({ ...summary, cumulative: { ...summary.cumulative, cards: { "/Users/private": {} } } }));
  assert.throws(() => readIkbUsageV2Summary(root), /invalid card ID/);
});
