import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverHistoryCandidates, ingestHistory } from "../src/history.ts";
import { listSources, readSourceRecords } from "../src/source.ts";

test("history adapters discover and normalize Claude, Codex and Desk sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-history-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-history-home-"));
  const claudeRoot = join(root, "claude");
  const codexRoot = join(root, "codex");
  const deskRoot = join(root, "desk");
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(deskRoot, { recursive: true });
  writeFileSync(join(claudeRoot, "claude.jsonl"), [
    JSON.stringify({ type: "user", isMeta: true, sessionId: "claude-1", uuid: "meta-1", timestamp: "2026-07-16T00:59:00Z", message: { role: "user", content: "Injected skill instructions must not become user evidence." } }),
    JSON.stringify({ type: "user", isCompactSummary: true, sessionId: "claude-1", uuid: "summary-1", timestamp: "2026-07-16T00:59:30Z", message: { role: "user", content: "A generated compact summary is not user-authored evidence." } }),
    JSON.stringify({ type: "user", promptSource: "system", sessionId: "claude-1", uuid: "system-1", message: { role: "user", content: "Unflagged system prompt must not become user evidence." } }),
    JSON.stringify({ type: "user", sessionId: "claude-1", uuid: "task-1", message: { role: "user", content: "<task-notification>background task finished</task-notification>" } }),
    JSON.stringify({ type: "user", sessionId: "claude-1", uuid: "interrupt-1", message: { role: "user", content: "[Request interrupted by user for tool use]" } }),
    JSON.stringify({ type: "user", sessionId: "claude-1", uuid: "command-1", message: { role: "user", content: "<command-name>/review</command-name>" } }),
    JSON.stringify({ type: "user", sessionId: "claude-1", uuid: "stdout-1", message: { role: "user", content: "<local-command-stdout>control output</local-command-stdout>" } }),
    JSON.stringify({ type: "user", sessionId: "claude-1", uuid: "u1", timestamp: "2026-07-16T01:00:00Z", cwd: "/repo", message: { role: "user", content: "Review the design" } }),
    JSON.stringify({ type: "assistant", sessionId: "claude-1", uuid: "a1", timestamp: "2026-07-16T01:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Keep the evidence." }] } }),
  ].join("\n") + "\n");
  writeFileSync(join(codexRoot, "codex.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-16T02:00:00Z", type: "session_meta", payload: { session_id: "codex-1", cwd: "/repo" } }),
    JSON.stringify({ timestamp: "2026-07-16T02:01:00Z", type: "event_msg", payload: { type: "user_message", message: "Check the failure path" } }),
    JSON.stringify({ timestamp: "2026-07-16T02:02:00Z", type: "event_msg", payload: { type: "agent_message", message: "Add a cited failure test." } }),
  ].join("\n") + "\n");
  writeFileSync(join(deskRoot, "desk.jsonl"), [
    JSON.stringify({ type: "user", conversationId: "desk-1", timestamp: "2026-07-16T03:00:00Z", message: { content: [{ type: "text", text: "Write a review note" }] } }),
    JSON.stringify({ type: "assistant", conversationId: "desk-1", timestamp: "2026-07-16T03:01:00Z", message: { content: [{ type: "text", text: "Record the decision." }] } }),
  ].join("\n") + "\n");

  assert.equal(discoverHistoryCandidates("claude", { root: claudeRoot, limit: 0 }).length, 1);
  assert.equal(discoverHistoryCandidates("codex", { root: codexRoot, limit: 0 }).length, 1);
  assert.equal(discoverHistoryCandidates("desk", { root: deskRoot, limit: 0 }).length, 1);
  const scans = [
    ingestHistory(home, "claude", { root: claudeRoot, scope: "work", limit: 0 }),
    ingestHistory(home, "codex", { root: codexRoot, scope: "work", limit: 0 }),
    ingestHistory(home, "desk", { root: deskRoot, scope: "work", limit: 0 }),
  ];
  assert.equal(scans.reduce((total, scan) => total + scan.discovered, 0), 3);
  assert.equal(scans.reduce((total, scan) => total + scan.imported, 0), 3);
  assert.equal(scans.reduce((total, scan) => total + scan.failed, 0), 0);
  assert.equal(listSources(home).length, 3);
  for (const source of listSources(home)) {
    assert.equal(source.adapter === "claude" || source.adapter === "codex" || source.adapter === "desk", true);
    assert.equal(source.scope, "work");
    assert.equal(existsSync(source.rawPath), true);
    assert.equal(readFileSync(source.rawPath, "utf8").length > 0, true);
    assert.equal(readSourceRecords(home, source.id).length > 0, true);
  }
  const claudeSource = listSources(home).find((source) => source.adapter === "claude");
  assert.ok(claudeSource);
  assert.equal(readSourceRecords(home, claudeSource.id).some((record) => record.content.includes("Injected skill instructions")), false);
  assert.equal(readSourceRecords(home, claudeSource.id).some((record) => record.content.includes("compact summary")), false);
  assert.equal(readSourceRecords(home, claudeSource.id).some((record) => /system prompt|task-notification|Request interrupted|command-name|local-command-stdout/.test(record.content)), false);

  const secondScans = [
    ingestHistory(home, "claude", { root: claudeRoot, scope: "work", limit: 0 }),
    ingestHistory(home, "codex", { root: codexRoot, scope: "work", limit: 0 }),
    ingestHistory(home, "desk", { root: deskRoot, scope: "work", limit: 0 }),
  ];
  assert.equal(secondScans.reduce((total, scan) => total + scan.imported, 0), 0);
  assert.equal(secondScans.reduce((total, scan) => total + scan.skipped, 0), 3);
});

test("history adapters keep tool output opt-in", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-history-tools-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-history-tools-home-"));
  writeFileSync(join(root, "codex.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-16T04:00:00Z", type: "session_meta", payload: { session_id: "codex-2", cwd: "/repo" } }),
    JSON.stringify({ timestamp: "2026-07-16T04:01:00Z", type: "event_msg", payload: { type: "user_message", message: "Run the check" } }),
    JSON.stringify({ timestamp: "2026-07-16T04:02:00Z", type: "event_msg", payload: { type: "custom_tool_call_output", output: "test passed" } }),
  ].join("\n") + "\n");

  const withoutTools = ingestHistory(home, "codex", { root, scope: "work", includeTools: false });
  assert.equal(withoutTools.imported, 1);
  assert.equal(withoutTools.results[0].recordCount, 1);
  const withTools = ingestHistory(home, "codex", { root, scope: "work", includeTools: true });
  assert.equal(withTools.imported, 1);
  assert.equal(withTools.results[0].recordCount, 2);
  const toolSource = listSources(home).find((source) => source.includeTools === true);
  assert.ok(toolSource);
  assert.equal(readSourceRecords(home, toolSource.id).some((record) => record.role === "tool"), true);
  assert.equal(ingestHistory(home, "codex", { root, scope: "work", includeTools: true }).skipped, 1);

  const claudeRoot = mkdtempSync(join(tmpdir(), "ikb-claude-tools-input-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "ikb-claude-tools-home-"));
  writeFileSync(join(claudeRoot, "claude.jsonl"), `${JSON.stringify({
    type: "user",
    sessionId: "claude-tools",
    uuid: "mixed-1",
    timestamp: "2026-07-16T04:10:00Z",
    message: { role: "user", content: [{ type: "text", text: "Run the check" }, { type: "tool_result", content: "<system-reminder>internal control</system-reminder>\ntest passed" }] },
  })}\n`);
  assert.equal(ingestHistory(claudeHome, "claude", { root: claudeRoot, scope: "work", includeTools: false }).results[0].recordCount, 1);
  const claudeWithTools = ingestHistory(claudeHome, "claude", { root: claudeRoot, scope: "work", includeTools: true });
  assert.equal(claudeWithTools.results[0].recordCount, 2);
  const claudeToolSource = listSources(claudeHome).find((source) => source.includeTools === true);
  assert.ok(claudeToolSource);
  const claudeRecords = readSourceRecords(claudeHome, claudeToolSource.id);
  assert.equal(claudeRecords.find((record) => record.role === "tool")?.content, "test passed");
  assert.equal(claudeRecords.some((record) => record.content.includes("internal control")), false);
  assert.equal(claudeRecords.some((record) => record.role === "user" && record.content.includes("test passed")), false);

  const claudeControlRoot = mkdtempSync(join(tmpdir(), "ikb-claude-control-input-"));
  const claudeControlHome = mkdtempSync(join(tmpdir(), "ikb-claude-control-home-"));
  writeFileSync(join(claudeControlRoot, "claude.jsonl"), `${JSON.stringify({
    type: "user",
    sessionId: "claude-control",
    uuid: "stdout-1",
    message: { role: "user", content: "<local-command-stdout>opt-in output</local-command-stdout>" },
  })}\n`);
  assert.equal(ingestHistory(claudeControlHome, "claude", { root: claudeControlRoot, scope: "work", includeTools: false }).results[0].reason, "no messages");
  const claudeControlScan = ingestHistory(claudeControlHome, "claude", { root: claudeControlRoot, scope: "work", includeTools: true });
  assert.equal(claudeControlScan.results[0].recordCount, 1);
  assert.equal(readSourceRecords(claudeControlHome, claudeControlScan.results[0].source!.id)[0].role, "tool");

  const claudeSidechainRoot = mkdtempSync(join(tmpdir(), "ikb-claude-sidechain-input-"));
  const claudeSidechainHome = mkdtempSync(join(tmpdir(), "ikb-claude-sidechain-home-"));
  writeFileSync(join(claudeSidechainRoot, "claude.jsonl"), [
    JSON.stringify({ type: "user", isSidechain: true, agentId: "reviewer-1", sessionId: "claude-side", uuid: "side-u", message: { content: "Investigate the failure." } }),
    JSON.stringify({ type: "assistant", isSidechain: true, agentId: "reviewer-1", sessionId: "claude-side", uuid: "side-a", message: { content: "The failure is reproducible." } }),
  ].join("\n") + "\n");
  assert.equal(ingestHistory(claudeSidechainHome, "claude", { root: claudeSidechainRoot, scope: "work", includeTools: false }).results[0].reason, "no messages");
  const sidechainScan = ingestHistory(claudeSidechainHome, "claude", { root: claudeSidechainRoot, scope: "work", includeTools: true });
  const sidechainRecords = readSourceRecords(claudeSidechainHome, sidechainScan.results[0].source!.id);
  assert.deepEqual(sidechainRecords.map((record) => record.actor), ["agent:reviewer-1", "agent:reviewer-1"]);
  assert.deepEqual(sidechainRecords.map((record) => record.conversationId), ["claude-side:sidechain:reviewer-1", "claude-side:sidechain:reviewer-1"]);
  assert.equal(sidechainRecords[0].role, "agent_prompt");

  const deskRoot = mkdtempSync(join(tmpdir(), "ikb-desk-tools-input-"));
  const deskHome = mkdtempSync(join(tmpdir(), "ikb-desk-tools-home-"));
  writeFileSync(join(deskRoot, "desk.jsonl"), `${JSON.stringify({
    type: "assistant",
    conversationId: "desk-tools",
    timestamp: "2026-07-16T04:20:00Z",
    message: { content: [{ type: "text", text: "Running the check." }, { type: "tool_use", toolName: "Bash", toolParams: { command: "safe-demo" } }] },
  })}\n`);
  const deskWithTools = ingestHistory(deskHome, "desk", { root: deskRoot, scope: "work", includeTools: true });
  assert.equal(deskWithTools.results[0].recordCount, 2);
  const deskToolSource = listSources(deskHome).find((source) => source.includeTools === true);
  assert.ok(deskToolSource);
  const deskToolRecord = readSourceRecords(deskHome, deskToolSource.id).find((record) => record.role === "tool");
  assert.match(deskToolRecord?.content ?? "", /tool use: Bash/);
  assert.match(deskToolRecord?.content ?? "", /safe-demo/);
});

test("Codex adapter keeps narrow assistant final-answer records and deduplicates exact event mirrors", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-codex-final-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-codex-final-home-"));
  writeFileSync(join(root, "codex.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-16T04:30:00Z", type: "session_meta", payload: { session_id: "codex-final", cwd: "/repo" } }),
    JSON.stringify({ timestamp: "2026-07-16T04:31:00Z", type: "event_msg", payload: { type: "agent_message", message: "Exact final answer." } }),
    JSON.stringify({ timestamp: "2026-07-16T04:31:01Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Exact final answer." }] } }),
    JSON.stringify({ timestamp: "2026-07-16T04:32:00Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "A standalone complete answer." }] } }),
    JSON.stringify({ timestamp: "2026-07-16T04:33:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Injected replay must stay excluded." }] } }),
  ].join("\n") + "\n");

  const scan = ingestHistory(home, "codex", { root, scope: "work" });
  assert.equal(scan.imported, 1);
  assert.equal(scan.results[0].recordCount, 2);
  const records = readSourceRecords(home, scan.results[0].source!.id);
  assert.deepEqual(records.map((record) => record.content), ["Exact final answer.", "A standalone complete answer."]);
  assert.equal(records.some((record) => record.content.includes("Injected replay")), false);
});

test("Codex adapter keeps subagent sessions out of human attribution by default", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-codex-subagent-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-codex-subagent-home-"));
  writeFileSync(join(root, "codex.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-16T04:40:00Z", type: "session_meta", payload: { session_id: "codex-sub", cwd: "/repo", source: { subagent: { thread_spawn: { parent_thread_id: "parent-1", depth: 1, agent_path: "reviewer", agent_nickname: "reviewer-2", agent_role: "review" } } } } }),
    JSON.stringify({ timestamp: "2026-07-16T04:41:00Z", type: "event_msg", payload: { type: "user_message", message: "Inspect the failure." } }),
    JSON.stringify({ timestamp: "2026-07-16T04:42:00Z", type: "event_msg", payload: { type: "agent_message", message: "The failure is reproducible." } }),
  ].join("\n") + "\n");

  assert.equal(ingestHistory(home, "codex", { root, scope: "work", includeTools: false }).results[0].reason, "no messages");
  const scan = ingestHistory(home, "codex", { root, scope: "work", includeTools: true });
  const records = readSourceRecords(home, scan.results[0].source!.id);
  assert.deepEqual(records.map((record) => record.actor), ["agent:reviewer-2", "agent:reviewer-2"]);
  assert.deepEqual(records.map((record) => record.conversationId), ["codex-sub:subagent:reviewer-2", "codex-sub:subagent:reviewer-2"]);
  assert.equal(records[0].role, "agent_prompt");
  assert.equal(records[0].refs.includes("parent-1"), true);
});

test("Elephant export adapter preserves actor and participants", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-elephant-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-elephant-home-"));
  writeFileSync(join(root, "conversation.ndjson"), [
    JSON.stringify({ conversation_id: "ele-1", id: "m1", role: "human", sender: { id: "person-a" }, participants: [{ id: "person-a" }, { display_name: "person-b" }], sent_at: "2026-07-16T05:00:00+08:00", content: "需要把决定和依据记下来。" }),
    JSON.stringify({ conversation_id: "ele-1", id: "m2", role: "human", sender: { name: "person-b" }, sent_at: "2026-07-16T05:01:00+08:00", content: { text: "同意，后续按这个方案推进。" } }),
    JSON.stringify({ conversation_id: "ele-1", id: "m3", role: "human", sender: { name: "person-c" }, participants: [], participant_ids: ["person-a", "person-c"], content: "", text: "空主字段应继续读取后备正文。" }),
  ].join("\n") + "\n");

  assert.throws(() => discoverHistoryCandidates("elephant"), /--root is required/);
  const scan = ingestHistory(home, "elephant", { root, scope: "work", limit: 0 });
  assert.equal(scan.discovered, 1);
  assert.equal(scan.imported, 1);
  const source = listSources(home)[0];
  assert.ok(source);
  assert.equal(source.kind, "elephant");
  assert.equal(source.adapter, "elephant");
  const records = readSourceRecords(home, source.id);
  assert.equal(records.length, 3);
  assert.equal(records[0].actor, "person-a");
  assert.equal(records[0].timestamp, "2026-07-16T05:00:00+08:00");
  assert.deepEqual(records[0].participants, ["person-a", "person-b"]);
  assert.equal(records[1].actor, "person-b");
  assert.equal(records[1].conversationId, "ele-1");
  assert.equal(records[2].content, "空主字段应继续读取后备正文。");
  assert.deepEqual(records[2].participants, ["person-a", "person-c"]);
});

test("history adapter skips files without user-visible messages", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-empty-history-input-"));
  const home = mkdtempSync(join(tmpdir(), "ikb-empty-history-home-"));
  writeFileSync(join(root, "control-only.jsonl"), `${JSON.stringify({ type: "progress", message: "indexing" })}\n`);
  const scan = ingestHistory(home, "claude", { root, scope: "work" });
  assert.equal(scan.discovered, 1);
  assert.equal(scan.imported, 0);
  assert.equal(scan.skipped, 1);
  assert.equal(scan.results[0].reason, "no messages");
  assert.equal(listSources(home).length, 0);
});

test("history scan rejects invalid scope before discovery or import", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-history-scope-input-"));
  writeFileSync(join(root, "session.jsonl"), `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
  assert.throws(() => discoverHistoryCandidates("claude", { root, scope: "typo" }), /personal or work/);
  assert.throws(() => discoverHistoryCandidates("claude", { root, limit: Number.NaN }), /non-negative integer/);
  assert.throws(() => discoverHistoryCandidates("claude", { root, limit: -1 }), /non-negative integer/);
  assert.throws(() => discoverHistoryCandidates("claude", { root: join(root, "missing") }), /does not exist/);
  assert.throws(() => discoverHistoryCandidates("claude", { root: join(root, "session.jsonl") }), /not a directory/);
});

test("history discovery applies inclusive from and exclusive to date boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "ikb-history-window-input-"));
  writeFileSync(join(root, "recent.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-07-16T00:00:00Z", message: { content: "recent" } })}\n`);
  writeFileSync(join(root, "old.jsonl"), `${JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", message: { content: "old" } })}\n`);
  const now = Date.now();
  utimesSync(join(root, "recent.jsonl"), new Date(now), new Date("2026-07-16T12:00:00Z"));
  utimesSync(join(root, "old.jsonl"), new Date(now), new Date("2026-07-09T23:59:59Z"));
  const candidates = discoverHistoryCandidates("claude", { root, from: "2026-07-10", to: "2026-07-18", limit: 0 });
  assert.deepEqual(candidates.map((candidate) => candidate.title), ["claude: recent"]);
  assert.throws(() => discoverHistoryCandidates("claude", { root, from: "not-a-time" }), /Invalid history time boundary/);
  assert.throws(() => discoverHistoryCandidates("claude", { root, from: "2026-07-18", to: "2026-07-10" }), /less than or equal/);
});
