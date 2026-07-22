import { test } from "node:test";
import assert from "node:assert/strict";
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
