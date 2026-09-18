import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activateIkbUsageV2, collectIkbRecallRolloutsV2, ikbUsageV2Paths } from "../src/ikb-recall.ts";

function queryHash(value: string): string {
  return value.padEnd(64, "0").slice(0, 64);
}

function search(retrievalId: string, cardId: string, path: string): Record<string, unknown> {
  return {
    schema: "ikb-card-search-result-v1",
    retrievalId,
    scope: "work",
    queryHash: queryHash(retrievalId),
    total: 1,
    count: 1,
    offset: 0,
    hasMore: false,
    nextOffset: null,
    zeroResult: false,
    items: [{
      cardId,
      title: "card",
      path,
      contentHash: queryHash(cardId),
      matchedFields: ["title"],
      snippet: "card",
    }],
  };
}

function writeRows(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function readDetails(root: string): Array<Record<string, unknown>> {
  const evidence = readFileSync(ikbUsageV2Paths(root).evidence, "utf8").trim();
  return evidence ? evidence.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

test("usage v2 keeps task purpose as the default without letting one marked command contaminate the turn", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-integration-purpose-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  const firstTurn = "turn-purpose-1";
  const secondTurn = "turn-purpose-2";
  const thirdTurn = "turn-purpose-3";
  const output = (id: string) => JSON.stringify(search(id, "purpose-card", cardPath));
  writeRows(join(sessions, "purpose.jsonl"), [
    { timestamp: "2026-09-15T01:00:00.000Z", type: "session_meta", payload: { id: "thread-purpose", source: "vscode" } },
    { timestamp: "2026-09-15T01:00:00.001Z", type: "event_msg", payload: { type: "task_started", turn_id: firstTurn } },
    { timestamp: "2026-09-15T01:00:00.002Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "IKB_USAGE_PURPOSE=maintenance。执行这次维护任务" }], internal_chat_message_metadata_passthrough: { turn_id: firstTurn } } },
    { timestamp: "2026-09-15T01:00:00.003Z", type: "event_msg", payload: { type: "item_completed", turn_id: firstTurn, item: { type: "CommandExecution", id: "maintenance-default", command: "ikb search --scope work --query same", output: output("maintenance-default") } } },
    { timestamp: "2026-09-15T01:00:00.004Z", type: "event_msg", payload: { type: "item_completed", turn_id: firstTurn, item: { type: "CommandExecution", id: "regression-marked", command: "IKB_USAGE_PURPOSE=regression ikb search --scope work --query same", output: output("regression-marked") } } },
    { timestamp: "2026-09-15T01:00:00.005Z", type: "event_msg", payload: { type: "item_completed", turn_id: firstTurn, item: { type: "CommandExecution", id: "maintenance-after-mark", command: "ikb search --scope work --query same", output: output("maintenance-after-mark") } } },
    { timestamp: "2026-09-15T01:00:00.006Z", type: "event_msg", payload: { type: "task_complete", turn_id: firstTurn, last_agent_message: "done" } },
    { timestamp: "2026-09-15T01:00:01.001Z", type: "event_msg", payload: { type: "task_started", turn_id: secondTurn } },
    { timestamp: "2026-09-15T01:00:01.002Z", type: "event_msg", payload: { type: "item_completed", turn_id: secondTurn, item: { type: "CommandExecution", id: "unknown-default", command: "ikb search --scope work --query same", output: output("unknown-default") } } },
    { timestamp: "2026-09-15T01:00:01.003Z", type: "event_msg", payload: { type: "task_complete", turn_id: secondTurn, last_agent_message: "done" } },
    { timestamp: "2026-09-15T01:00:02.001Z", type: "event_msg", payload: { type: "task_started", turn_id: thirdTurn } },
    { timestamp: "2026-09-15T01:00:02.002Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "引用示例：`IKB_USAGE_PURPOSE=maintenance ikb search --scope work --query example`" }], internal_chat_message_metadata_passthrough: { turn_id: thirdTurn } } },
    { timestamp: "2026-09-15T01:00:02.003Z", type: "event_msg", payload: { type: "item_completed", turn_id: thirdTurn, item: { type: "CommandExecution", id: "quoted-marker", command: "ikb search --scope work --query same", output: output("quoted-marker") } } },
    { timestamp: "2026-09-15T01:00:02.004Z", type: "event_msg", payload: { type: "task_complete", turn_id: thirdTurn, last_agent_message: "done" } },
  ]);
  activateIkbUsageV2(root, "2026-09-15T00:00:00.000Z");
  collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, generatedAt: "2026-09-15T01:01:00.000Z" });
  const details = readDetails(root);
  const attempts = details.flatMap((detail) => detail.attempts as Array<Record<string, unknown>>);
  assert.equal(attempts.length, 5);
  assert.deepEqual(attempts.map((attempt) => attempt.purpose), ["maintenance", "regression", "maintenance", "unknown", "unknown"]);
  const summary = JSON.parse(readFileSync(ikbUsageV2Paths(root).summary, "utf8")) as Record<string, unknown>;
  const cumulative = summary.cumulative as Record<string, unknown>;
  assert.deepEqual(cumulative.origins, {
    "codex|root|maintenance": 2,
    "codex|root|regression": 1,
    "codex|root|unknown": 2,
  });
});

test("usage v2 uses event identity for command attempts and falls back to event lines", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-usage-integration-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const cardPath = join(root, "card.md");
  const command = "ikb search --scope work --query repeated";
  const output = `${JSON.stringify(search("repeated", "repeated-card", cardPath))}\nexit=0\nstdout=/tmp/call.stdout.json\n`;
  writeRows(join(sessions, "identity.jsonl"), [
    { timestamp: "2026-09-15T02:00:00.000Z", type: "session_meta", payload: { id: "thread-identity", source: "vscode" } },
    { timestamp: "2026-09-15T02:00:00.001Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-identity" } },
    { timestamp: "2026-09-15T02:00:00.002Z", type: "event_msg", payload: { type: "item_completed", id: "event-one", turn_id: "turn-identity", item: { type: "CommandExecution", command, output } } },
    { timestamp: "2026-09-15T02:00:00.003Z", type: "event_msg", payload: { type: "command_execution", id: "event-one", turn_id: "turn-identity", command, output } },
    { timestamp: "2026-09-15T02:00:00.004Z", type: "event_msg", payload: { type: "item_completed", id: "event-two", turn_id: "turn-identity", item: { type: "CommandExecution", command, output } } },
    { timestamp: "2026-09-15T02:00:00.005Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn-identity", item: { type: "CommandExecution", command, output } } },
    { timestamp: "2026-09-15T02:00:00.006Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn-identity", item: { type: "CommandExecution", command, output } } },
    { timestamp: "2026-09-15T02:00:00.007Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-identity", last_agent_message: "done" } },
  ]);
  activateIkbUsageV2(root, "2026-09-15T00:00:00.000Z");
  collectIkbRecallRolloutsV2({ sessionRoots: [sessions], activeDataRoot: root, generatedAt: "2026-09-15T02:01:00.000Z" });
  const details = readDetails(root);
  const attempts = details.flatMap((detail) => detail.attempts as Array<Record<string, unknown>>);
  assert.equal(attempts.length, 4);
  const sourceRefs = attempts.map((attempt) => String(attempt.sourceEventRef));
  assert.equal(new Set(sourceRefs).size, 4);
  assert.ok(sourceRefs.every((sourceRef) => sourceRef.includes("/event/")));
});

test('native functions exec and runtime command receipts count once, including successful get', t => {
  const root=mkdtempSync(join(tmpdir(),'ikb-native-receipts-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const sessions=join(root,'sessions');mkdirSync(sessions);
  const found=search('abc','abc',join(root,'card.md'));
  const read={schema:'ikb-card-read-result-v1',retrievalId:'abc',scope:'work',card:{...(found.items as any[])[0],markdown:'# card',whenNotTrust:'fixture'}};
  const rows:any[]=[{timestamp:'2026-09-15T02:00:00.000Z',type:'session_meta',payload:{id:'native-thread'}},{timestamp:'2026-09-15T02:00:00.001Z',type:'event_msg',payload:{type:'task_started',turn_id:'native-turn'}}];
  for(const [index,operation] of ['search','get','failure'].entries()) {
    const cmd=operation==='search'?'IKB_USAGE_PURPOSE=maintenance ikb search --scope work --query abc':'IKB_USAGE_PURPOSE=maintenance ikb get --retrieval-id abc --card-id abc';
    const output=JSON.stringify(operation==='search'?found:operation==='get'?read:{error:'Invalid retrieval_id'});
    const exitCode=operation==='failure'?1:0;
    const callId=`call-${index}`;
    for(const [type,payload] of [
      ['response_item',{type:'custom_tool_call',name:'exec',call_id:callId,input:`text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}));`}],
      ['event_msg',{type:'item_completed',turn_id:'native-turn',item:{type:'CommandExecution',id:`exec-${index}`,command:['/bin/zsh','-lc',cmd],stdout:output,exit_code:exitCode,status:'completed'}}],
      ['response_item',{type:'custom_tool_call_output',call_id:callId,output:[{type:'input_text',text:JSON.stringify({exit_code:exitCode,output})}]}]
    ]) rows.push({timestamp:`2026-09-15T02:00:0${index+1}.000Z`,type,payload});
  }
  rows.push({timestamp:'2026-09-15T02:00:03.000Z',type:'event_msg',payload:{type:'task_complete',turn_id:'native-turn',last_agent_message:'done'}});
  writeRows(join(sessions,'native.jsonl'),rows);activateIkbUsageV2(root,'2026-09-15T00:00:00.000Z');
  const report=collectIkbRecallRolloutsV2({sessionRoots:[sessions],activeDataRoot:root,generatedAt:'2026-09-15T03:00:00.000Z'});
  assert.equal(report.status,'degraded',JSON.stringify(report));assert.deepEqual(report.issues,[{reasonCode:'ikb_cli_failure',count:1}]);assert.equal(report.attempts,3);assert.equal(report.searches,1);assert.equal(report.reads,1);
});
