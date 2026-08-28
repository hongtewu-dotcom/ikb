import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { captureKnowledge } from "../src/knowledge.ts";
import { LedgerStore } from "../src/store.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

test("Knowledge feedback requires an integrity-checked Artifact from the same Run", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-feedback-"));
  const evidencePath = join(home, "consumer-result.md");
  const otherPath = join(home, "other-result.md");
  writeFileSync(evidencePath, "# Result\n\nThe Knowledge was only partially useful.\n");
  writeFileSync(otherPath, "# Other result\n");
  const knowledge = captureKnowledge(home, { title: "Historical pricing context", scope: "work", body: "A historical pricing note." });
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "Use pricing context", goal: "Prepare a current brief", acceptance: "Separate current and historical facts", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const artifact = store.createArtifact({ runId: run.id, path: evidencePath, kind: "consumer-result", label: "consumer result" });
  store.recordKnowledgeEvent(knowledge.id, "knowledge.referenced", { taskId: task.id, runId: run.id, contextArtifactId: artifact.id });
  store.recordKnowledgeUsageEvent(knowledge.id, { contractVersion: "knowledge-usage.v1", taskId: task.id, runId: run.id, artifactId: artifact.id, artifactHash: artifact.contentHash, purpose: "paragraph", note: "用于当前简报" });
  const otherTask = store.createTask({ title: "Other task", goal: "Other work", acceptance: "Other result", scope: "work" });
  const otherRun = store.createRun(otherTask.id, "ikb-operator", ["ikb-use-knowledge"]);
  const otherArtifact = store.createArtifact({ runId: otherRun.id, path: otherPath, kind: "consumer-result", label: "other result" });
  store.close();

  const missing = invokeFeedback(home, [knowledge.id, "--run", run.id, "--outcome", "partial", "--reason-code", "current_status_missing"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires at least one --evidence Artifact/);

  const foreign = invokeFeedback(home, [knowledge.id, "--run", run.id, "--outcome", "incorrect", "--reason-code", "wrong_scope", "--evidence", otherArtifact.id]);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /does not belong to Run/);

  const accepted = invokeFeedback(home, [knowledge.id, "--run", run.id, "--outcome", "partial", "--reason-code", "current_status_missing", "--evidence", `artifact://${artifact.id}`]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const result = JSON.parse(accepted.stdout);
  const replay = new LedgerStore({ home });
  const event = replay.listEvents().find((item) => item.eventId === result.eventId);
  assert.deepEqual(event?.payload.evidenceRefs, [artifact.id]);
  replay.close();
});

test("an unadopted incorrect review finding stays unused and is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-review-finding-"));
  const evidencePath = join(home, "review.md");
  writeFileSync(evidencePath, "# Review\n\nThe card was rejected before adoption.\n");
  const reviewedKnowledge = captureKnowledge(home, { title: "Rejected before adoption", scope: "work", body: "This card must not become a use event." });
  const missingNoteKnowledge = captureKnowledge(home, { title: "Missing review note", scope: "work", body: "A review finding needs an observable note." });
  const incompatibleKnowledge = captureKnowledge(home, { title: "Incompatible review outcome", scope: "work", body: "A review finding cannot relabel adopted feedback." });
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "Review retrieved Knowledge", goal: "Reject an incorrect card before use", acceptance: "Preserve use semantics", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", ["ikb-use-knowledge"]);
  const artifact = store.createArtifact({ runId: run.id, path: evidencePath, kind: "consumer-result", label: "review result" });
  for (const knowledge of [reviewedKnowledge, missingNoteKnowledge, incompatibleKnowledge]) {
    store.recordKnowledgeEvent(knowledge.id, "knowledge.referenced", { taskId: task.id, runId: run.id, contextArtifactId: artifact.id });
  }
  store.recordKnowledgeUsageEvent(incompatibleKnowledge.id, {
    contractVersion: "knowledge-usage.v1",
    taskId: task.id,
    runId: run.id,
    artifactId: artifact.id,
    artifactHash: artifact.contentHash,
    purpose: "check",
    note: "该卡已实际用于检查",
  });
  store.close();

  const reviewedArgs = [
    reviewedKnowledge.id,
    "--run", run.id,
    "--outcome", "unused",
    "--review-finding", "incorrect",
    "--reason-code", "source_conflicts_with_current_state",
    "--note", "审阅发现来源与当前一手事实冲突，未写入交付物",
    "--evidence", artifact.id,
  ];
  const recorded = invokeFeedback(home, reviewedArgs);
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  const repeated = invokeFeedback(home, reviewedArgs);
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(JSON.parse(repeated.stdout).eventId, JSON.parse(recorded.stdout).eventId);

  const missingNote = invokeFeedback(home, [
    missingNoteKnowledge.id,
    "--run", run.id,
    "--outcome", "unused",
    "--review-finding", "incorrect",
    "--reason-code", "source_conflicts_with_current_state",
    "--evidence", artifact.id,
  ]);
  assert.notEqual(missingNote.status, 0);
  assert.match(missingNote.stderr, /--note/);

  const incompatibleOutcome = invokeFeedback(home, [
    incompatibleKnowledge.id,
    "--run", run.id,
    "--outcome", "helpful",
    "--review-finding", "incorrect",
    "--reason-code", "improved_check",
    "--note", "该卡已实际用于检查",
    "--evidence", artifact.id,
  ]);
  assert.notEqual(incompatibleOutcome.status, 0);
  assert.match(incompatibleOutcome.stderr, /review.*finding.*unused/i);

  const replay = new LedgerStore({ home });
  const feedback = replay.listEvents().find((event) => event.eventType === "knowledge.feedback_recorded" && event.aggregateId === reviewedKnowledge.id);
  assert.equal(feedback?.payload.outcome, "unused");
  assert.equal(feedback?.payload.reviewFinding, "incorrect");
  assert.equal(feedback?.payload.reasonCode, "source_conflicts_with_current_state");
  assert.equal(feedback?.payload.note, "审阅发现来源与当前一手事实冲突，未写入交付物");
  assert.deepEqual(feedback?.payload.evidenceRefs, [artifact.id]);
  assert.equal(replay.listEvents().some((event) => event.eventType === "knowledge.used" && event.aggregateId === reviewedKnowledge.id), false);
  assert.equal(replay.listEvents().some((event) => event.eventType === "knowledge.feedback_recorded" && event.aggregateId === missingNoteKnowledge.id), false);
  assert.equal(replay.listEvents().some((event) => event.eventType === "knowledge.feedback_recorded" && event.aggregateId === incompatibleKnowledge.id), false);
  replay.close();
});

function invokeFeedback(home: string, args: string[]) {
  return spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    cliPath,
    "knowledge",
    "feedback",
    ...args,
    "--home",
    home,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
}
