import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureKnowledge, findKnowledge } from "../src/knowledge.ts";
import { LedgerStore } from "../src/store.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

test("remember stores or reuses one Source and writes one unified Receipt", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-agent-remember-"));
  const input = join(home, "handoff.md");
  writeFileSync(input, "# Handoff\n\nKeep the consumer boundary.\n");

  const first = invoke(home, ["remember", input, "--scope", "work"]);
  assert.equal(first.status, 0, first.stderr);
  const remembered = JSON.parse(first.stdout);
  assert.match(remembered.sourceId, /^src-/);
  assert.equal(remembered.knowledgeCoverage.status, "none");
  assert.equal(existsSync(remembered.inbox.path), true);
  assert.equal(remembered.receipt.kind, "remember");
  assert.equal(receiptFiles(home).length, 1);
  const receipt = JSON.parse(readFileSync(remembered.receipt.path, "utf8"));
  assert.equal(receipt.schema, "ikb-receipt.v1");
  assert.equal(receipt.operations.length, 1);
  assert.deepEqual(receipt.operations[0].sourceRefs, [remembered.sourceId]);

  const repeated = invoke(home, ["remember", input, "--scope", "work"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).sourceId, remembered.sourceId);
  assert.equal(receiptFiles(home).length, 2);
});

test("use and helpful feedback close one real Agent usage with a Result", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-agent-use-"));
  const knowledge = verifiedKnowledge(home, "Facade helpful marker", "Facade helpful marker provides the final consumer check.");
  const used = invoke(home, [
    "use",
    "--goal", "Apply Facade helpful marker",
    "--accept", "The result cites the final consumer check",
    "--scope", "work",
  ]);
  assert.equal(used.status, 0, used.stderr);
  const usage = JSON.parse(used.stdout);
  assert.equal(usage.context.results.some((item: { id: string }) => item.id === knowledge.id), true);
  assert.match(usage.usageId, /^run-/);
  const resultPath = join(home, "consumer-result.md");
  writeFileSync(resultPath, "# Consumer result\n\nApplied the Facade helpful marker check.\n");

  const feedback = invoke(home, [
    "feedback", usage.usageId,
    "--outcome", "helpful",
    "--result", resultPath,
    "--knowledge", knowledge.id,
  ]);
  assert.equal(feedback.status, 0, feedback.stderr);
  const closed = JSON.parse(feedback.stdout);
  assert.deepEqual(closed.knowledgeIds, [knowledge.id]);
  assert.equal(closed.outcome, "helpful");
  assert.equal(receiptFiles(home).length, 2);

  const store = new LedgerStore({ home });
  assert.equal(store.requireRun(usage.usageId).status, "succeeded");
  assert.equal(store.requireTask(usage.taskId).status, "done");
  assert.equal(store.listEvents().some((event) => event.eventType === "knowledge.used" && event.aggregateId === knowledge.id), true);
  assert.equal(store.listEvents().some((event) => event.eventType === "knowledge.feedback_recorded" && event.payload.outcome === "helpful"), true);
  store.close();
});

test("use falls back to clearly labelled Source evidence and accepts usage feedback", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-agent-source-fallback-"));
  const input = join(home, "source-fallback-marker.md");
  writeFileSync(input, "# Source fallback marker\n\nThis is raw evidence, not admitted Knowledge.\n");
  const remembered = invoke(home, ["remember", input, "--scope", "work"]);
  assert.equal(remembered.status, 0, remembered.stderr);
  const sourceId = JSON.parse(remembered.stdout).sourceId;

  const used = invoke(home, [
    "use",
    "--goal", "Apply Source fallback marker in a raw-evidence task",
    "--accept", "The Context labels raw evidence as unadmitted",
    "--scope", "work",
  ]);
  assert.equal(used.status, 0, used.stderr);
  const usage = JSON.parse(used.stdout);
  assert.equal(usage.context.results.length, 0);
  assert.equal(usage.context.sourceFallback.sources[0].id, sourceId);
  assert.match(usage.context.sourceFallback.notice, /尚未整理为 verified Knowledge/);
  assert.equal(existsSync(usage.context.sourceFallback.artifact.path), true);
  assert.deepEqual(JSON.parse(readFileSync(usage.inbox.path, "utf8")).sourceRefs, [sourceId]);

  const resultPath = join(home, "source-fallback-result.md");
  writeFileSync(resultPath, "# Result\n\nUsed the Source only as unadmitted evidence.\n");
  const feedback = invoke(home, [
    "feedback", usage.usageId,
    "--outcome", "helpful",
    "--result", resultPath,
  ]);
  assert.equal(feedback.status, 0, feedback.stderr);
  const closed = JSON.parse(feedback.stdout);
  assert.deepEqual(closed.knowledgeIds, []);
  assert.equal(closed.outcome, "helpful");
  assert.equal(receiptFiles(home).length, 3);

  const store = new LedgerStore({ home });
  assert.equal(store.requireRun(usage.usageId).status, "succeeded");
  assert.equal(store.listEvents().some((event) => event.eventType === "source.context_built"
    && event.aggregateId === sourceId
    && event.payload.runId === usage.usageId), true);
  store.close();
});

test("incorrect feedback returns used Knowledge to draft and creates Inbox work", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-agent-incorrect-"));
  const knowledge = verifiedKnowledge(home, "Facade incorrect marker", "Facade incorrect marker is intentionally invalidated by feedback.");
  const usage = JSON.parse(invoke(home, [
    "use",
    "--goal", "Review Facade incorrect marker",
    "--accept", "Incorrect knowledge leaves default recall",
    "--scope", "work",
  ]).stdout);
  const resultPath = join(home, "incorrect-result.md");
  writeFileSync(resultPath, "# Result\n\nThe current source contradicts this Knowledge.\n");
  const feedback = invoke(home, [
    "feedback", usage.usageId,
    "--outcome", "incorrect",
    "--result", resultPath,
    "--knowledge", knowledge.id,
    "--reason-code", "current_source_contradicts",
  ]);
  assert.equal(feedback.status, 0, feedback.stderr);
  const result = JSON.parse(feedback.stdout);
  assert.equal(findKnowledge(home, knowledge.id)?.status, "draft");
  assert.equal(result.inbox.length, 1);
  assert.equal(existsSync(result.inbox[0].path), true);
  const inbox = JSON.parse(readFileSync(result.inbox[0].path, "utf8"));
  assert.equal(inbox.trigger, "incorrect_feedback");
  assert.deepEqual(inbox.knowledgeIds, [knowledge.id]);

  const next = invoke(home, [
    "use",
    "--goal", "Review Facade incorrect marker",
    "--accept", "Draft knowledge is not returned",
    "--scope", "work",
  ]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).context.results.some((item: { id: string }) => item.id === knowledge.id), false);
});

function verifiedKnowledge(home: string, title: string, body: string) {
  return captureKnowledge(home, {
    title,
    body,
    scope: "work",
    status: "verified",
    sourceRefs: ["src-test-facade"],
    verification: "task_validated",
    applicability: "Agent facade integration tests",
    boundary: "Synthetic fixture only",
  });
}

function receiptFiles(home: string): string[] {
  const directory = join(home, ".system", "receipts");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")) : [];
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
