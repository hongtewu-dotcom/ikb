import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as knowledgeApi from "../src/knowledge.ts";
import {
  applyKnowledgeCandidateRevision,
  applyPreparedKnowledgeRevision,
  buildContextPack,
  captureKnowledge,
  findKnowledge,
  inspectKnowledgeLayout,
  listKnowledgeRevisions,
  prepareKnowledgeCandidateRevision,
  searchKnowledge,
} from "../src/knowledge.ts";
import { findExperienceCandidate } from "../src/experience.ts";
import { LedgerStore } from "../src/store.ts";

type CorrectionRequestInput = {
  knowledgeId: string;
  runId: string;
  artifactId: string;
  action: "revise" | "retire";
  reason: string;
};

type CorrectionRequestResult = {
  outcome: "created" | "unchanged";
  candidate: { id: string; status: string; targetKnowledgeIds: string[]; changeTypes: string[] };
};

// This deliberately names the frozen production seam while it is absent, so
// the test stays a focused runtime red test until the entry point is added.
const requestKnowledgeCorrection = (knowledgeApi as unknown as {
  requestKnowledgeCorrection: (home: string, store: LedgerStore, input: CorrectionRequestInput) => CorrectionRequestResult;
}).requestKnowledgeCorrection;

function createCorrectionEvidence(home: string, store: LedgerStore, scope: "work" | "personal", label: string) {
  const task = store.createTask({ title: label, goal: label, acceptance: label, scope });
  store.transitionTask(task.id, "active");
  const run = store.createRun(task.id, "red-test", ["ikb-knowledge-curator"]);
  const path = join(home, `${label}.md`);
  writeFileSync(path, `完整纠错证据：${label}\n`);
  const artifact = store.createArtifact({ runId: run.id, kind: "knowledge-candidate-validation", label, path });
  return { task, run, artifact };
}

function writeAcceptedCandidate(home: string, input: {
  id: string;
  targetIds: string[];
  reviewedArtifactPath: string;
  candidateType?: string;
  candidateCollection?: string;
}): void {
  const directory = join(home, "experiences", "candidates");
  mkdirSync(directory, { recursive: true });
  const contentHash = "b".repeat(64);
  const reviewedArtifactSourceRef = input.reviewedArtifactPath.slice(home.length + 1).split("\\").join("/");
  const reviewedArtifactHash = createHash("sha256").update(readFileSync(input.reviewedArtifactPath, "utf8")).digest("hex");
  const reviewedArtifactRef = `experiences/reviews/${input.id}/${reviewedArtifactHash}.md`;
  const target = findKnowledge(home, input.targetIds[0]);
  assert.ok(target);
  mkdirSync(join(home, "experiences", "reviews", input.id), { recursive: true });
  writeFileSync(join(home, reviewedArtifactRef), readFileSync(input.reviewedArtifactPath, "utf8"), { mode: 0o600 });
  writeFileSync(join(directory, `${input.id}.json`), `${JSON.stringify({
    schema: "ikb-knowledge-candidate.v1",
    id: input.id,
    scope: "work",
    status: "accepted",
    contentHash,
    title: "待复核知识修订：失败后的重试规则",
    patternKey: "debug.retry-after-cause",
    signalCodes: ["manual_correction"],
    analysisIds: ["exp-analysis-1"],
    patternLabel: "失败后的重试规则",
    claimVariants: ["失败后先确认根因和边界，再决定是否重试。"],
    changeTypes: ["revise"],
    targetKnowledgeIds: input.targetIds,
    experienceIds: ["exp-1"],
    sourceIds: ["src-test"],
    sourceRecordRefs: ["src-test:r1"],
    evidenceEventIds: [],
    runIds: ["run-1"],
    validationRefs: [],
    independentRunCount: 1,
    independentSourceCount: 1,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: "失败后先确认根因和边界，再决定是否重试。",
      type: input.candidateType ?? target.type,
      collection: input.candidateCollection ?? target.collection,
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan"],
      evidenceRefs: ["src-test:r1"],
      applicability: "自动化步骤失败且重试可能有成本时。",
      boundary: "已有平台幂等重试契约的瞬时错误另行处理。",
      useContract: "准备重试失败步骤时。",
      validationPlan: "独立 Run 回归。",
      confidence: "unknown",
      temporalState: "unknown",
    },
    decision: {
      outcome: "accepted",
      reason: "直接反例已经否定旧规则，接受修订方向。",
      candidateContentHash: contentHash,
      reviewedArtifact: { sourceRef: reviewedArtifactSourceRef, ref: reviewedArtifactRef, contentHash: reviewedArtifactHash },
      decidedAt: "2026-08-07T00:00:00Z",
    },
    nextAction: "curate_accepted_candidate_and_apply",
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
  }, null, 2)}\n`, { mode: 0o600 });
}

test("Knowledge revision keeps immutable snapshots, retires merged cards and is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-"));
  const primary = captureKnowledge(home, { title: "旧的记忆压缩规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "超过七天的记忆直接压缩并丢弃过程。" });
  const secondary = captureKnowledge(home, { title: "旧的记忆归档规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "归档内容不需要继续参与检索。" });
  const primaryBefore = readFileSync(primary.path, "utf8");
  const secondaryBefore = readFileSync(secondary.path, "utf8");
  const candidateId = "exp-cand-revisiontest";
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, primaryBefore.replace("超过七天的记忆直接压缩并丢弃过程。", [
    "日志年龄只决定进入整理队列，不决定删除。",
    "",
    "整理前保存权威证据，逐项迁移持久内容，保留可恢复快照，并做冷启动召回测试。",
  ].join("\n")));
  writeAcceptedCandidate(home, { id: candidateId, targetIds: [primary.id, secondary.id], reviewedArtifactPath: replacementPath });
  const store = new LedgerStore({ home });

  const result = applyKnowledgeCandidateRevision(home, store, candidateId, { replacementPath, primaryKnowledgeId: primary.id });
  assert.equal(result.journal.status, "completed");
  assert.equal(result.records.length, 2);
  const revised = findKnowledge(home, primary.id)!;
  const retired = findKnowledge(home, secondary.id)!;
  assert.equal(revised.status, "draft");
  assert.equal(revised.revision, 2);
  assert.match(revised.body, /年龄只决定进入整理队列/);
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);
  assert.equal(retired.supersededBy, primary.id);
  assert.equal(readFileSync(join(home, result.journal.items.find((item) => item.knowledgeId === primary.id)!.beforeRef), "utf8"), primaryBefore);
  assert.equal(readFileSync(join(home, result.journal.items.find((item) => item.knowledgeId === secondary.id)!.beforeRef), "utf8"), secondaryBefore);
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "applied");
  assert.deepEqual(searchKnowledge(home, "记忆 整理队列", { scope: "work" }).map((item) => item.id), [primary.id]);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.revised").length, 1);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.retired" && event.payload.revisionId === result.journal.id).length, 1);

  const rerun = applyKnowledgeCandidateRevision(home, store, candidateId, { replacementPath, primaryKnowledgeId: primary.id });
  assert.equal(rerun.recovered, true);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.revised").length, 1);
  assert.equal(listKnowledgeRevisions(home).length, 1);
  assert.equal(inspectKnowledgeLayout(home, "work").pendingRevisionJournals.length, 0);
  store.close();
});

test("Prepared Knowledge revision refuses a conflicting manual edit and can recover from its snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-recover-"));
  const primary = captureKnowledge(home, { title: "旧规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "失败后直接重试。" });
  const candidateId = "exp-cand-recover";
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, readFileSync(primary.path, "utf8").replace("失败后直接重试。", "失败后先确认根因与边界，再决定是否重试。"));
  writeAcceptedCandidate(home, { id: candidateId, targetIds: [primary.id], reviewedArtifactPath: replacementPath });
  const journal = prepareKnowledgeCandidateRevision(home, candidateId, { replacementPath });
  assert.equal(journal.status, "prepared");
  assert.equal(findKnowledge(home, primary.id)?.revision, 1);
  writeFileSync(primary.path, `${readFileSync(primary.path, "utf8")}\n人工并发修改\n`);
  const store = new LedgerStore({ home });
  assert.throws(() => applyPreparedKnowledgeRevision(home, store, journal.id), /changed after the revision snapshot/);
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "accepted");
  assert.equal(inspectKnowledgeLayout(home, "work").pendingRevisionJournals.length, 1);
  assert.equal(inspectKnowledgeLayout(home, "personal").pendingRevisionJournals.length, 0);

  const before = journal.items[0].beforeRef;
  writeFileSync(primary.path, readFileSync(join(home, before), "utf8"));
  const recovered = applyPreparedKnowledgeRevision(home, store, journal.id);
  assert.equal(recovered.journal.status, "completed");
  assert.equal(findKnowledge(home, primary.id)?.revision, 2);
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "applied");
  store.close();
});

test("Knowledge revision applies only the exact full replacement accepted by the user", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-reviewed-bytes-"));
  const primary = captureKnowledge(home, { title: "旧规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "失败后直接重试。" });
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, readFileSync(primary.path, "utf8").replace("失败后直接重试。", "失败后先确认根因与边界。"));
  const candidateId = "exp-cand-reviewedbytes";
  writeAcceptedCandidate(home, { id: candidateId, targetIds: [primary.id], reviewedArtifactPath: replacementPath });
  writeFileSync(replacementPath, `${readFileSync(replacementPath, "utf8")}\n未经确认的新内容。\n`);
  const store = new LedgerStore({ home });
  assert.throws(() => applyKnowledgeCandidateRevision(home, store, candidateId, { replacementPath }), /do not match the file accepted by the user/);
  assert.equal(findKnowledge(home, primary.id)?.revision, 1);
  assert.equal(listKnowledgeRevisions(home).length, 0);
  store.close();
});

test("Knowledge revision refuses a Candidate that changes the target type or collection", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-shape-"));
  const primary = captureKnowledge(home, {
    title: "报价模型历史事实包",
    scope: "work",
    type: "entity",
    collection: "domains",
    body: "报价模型包含历史事实与待确认设计。",
  });
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, readFileSync(primary.path, "utf8").replace("待确认设计", "当前事实、目标设计和补证计划"));
  const candidateId = "exp-cand-shapemismatch";
  writeAcceptedCandidate(home, {
    id: candidateId,
    targetIds: [primary.id],
    reviewedArtifactPath: replacementPath,
    candidateType: "fact",
    candidateCollection: "syntheses",
  });
  assert.throws(
    () => prepareKnowledgeCandidateRevision(home, candidateId, { replacementPath }),
    /Candidate type or collection does not match revision target/,
  );
  assert.equal(findKnowledge(home, primary.id)?.revision, 1);
  assert.equal(listKnowledgeRevisions(home).length, 0);
});

test("Knowledge revision reports recovery when files already reached the after snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-after-snapshot-"));
  const primary = captureKnowledge(home, { title: "旧规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "失败后直接重试。" });
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, readFileSync(primary.path, "utf8").replace("失败后直接重试。", "失败后先确认根因与边界。"));
  const candidateId = "exp-cand-aftersnapshot";
  writeAcceptedCandidate(home, { id: candidateId, targetIds: [primary.id], reviewedArtifactPath: replacementPath });
  const journal = prepareKnowledgeCandidateRevision(home, candidateId, { replacementPath });
  writeFileSync(primary.path, readFileSync(join(home, journal.items[0].afterRef), "utf8"));
  const store = new LedgerStore({ home });
  const result = applyPreparedKnowledgeRevision(home, store, journal.id);
  assert.equal(result.recovered, true);
  assert.equal(result.journal.status, "completed");
  store.close();
});

test("Knowledge revision recovery rejects a journal redirected to a non-Knowledge file", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-revision-path-tamper-"));
  const primary = captureKnowledge(home, { title: "旧规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "失败后直接重试。" });
  const replacementPath = join(home, "replacement.md");
  writeFileSync(replacementPath, readFileSync(primary.path, "utf8").replace("失败后直接重试。", "失败后先确认根因与边界。"));
  const candidateId = "exp-cand-pathtamper";
  writeAcceptedCandidate(home, { id: candidateId, targetIds: [primary.id], reviewedArtifactPath: replacementPath });
  const journal = prepareKnowledgeCandidateRevision(home, candidateId, { replacementPath });
  const journalPath = join(home, "revisions", "knowledge", "work", journal.id, "journal.json");
  const tampered = JSON.parse(readFileSync(journalPath, "utf8"));
  tampered.items[0].targetRef = "ledger/events.jsonl";
  writeFileSync(journalPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const store = new LedgerStore({ home });
  assert.throws(() => applyPreparedKnowledgeRevision(home, store, journal.id), /target path does not match the current Vault record/);
  assert.equal(findKnowledge(home, primary.id)?.revision, 1);
  store.close();
});

test("Explicit correction request is idempotent, preserves a verified card, and holds default retrieval", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-correction-request-"));
  const target = captureKnowledge(home, {
    title: "P0 无条件重试规则",
    scope: "work",
    status: "verified",
    sourceRefs: ["manual:user"],
    body: "失败后总是直接重试。",
  });
  const before = readFileSync(target.path, "utf8");
  const store = new LedgerStore({ home });
  const evidence = createCorrectionEvidence(home, store, "work", "p0-correction-evidence");
  const input: CorrectionRequestInput = {
    knowledgeId: target.id,
    runId: evidence.run.id,
    artifactId: evidence.artifact.id,
    action: "revise",
    reason: "直接反例表明无条件重试会扩大副作用。",
  };

  const created = requestKnowledgeCorrection(home, store, input);
  const repeated = requestKnowledgeCorrection(home, store, input);

  assert.equal(created.outcome, "created");
  assert.equal(repeated.outcome, "unchanged");
  assert.equal(repeated.candidate.id, created.candidate.id);
  assert.equal(created.candidate.status, "pending_review");
  assert.deepEqual(created.candidate.targetKnowledgeIds, [target.id]);
  assert.deepEqual(created.candidate.changeTypes, ["revise"]);
  assert.equal(readFileSync(target.path, "utf8"), before);
  assert.equal(findKnowledge(home, target.id)?.status, "verified");
  assert.equal(findKnowledge(home, target.id)?.revision, target.revision);
  assert.equal(searchKnowledge(home, "无条件重试", { scope: "work" }).length, 0);
  const context = buildContextPack(home, {
    taskId: "task-p0-correction-hold",
    title: "P0 无条件重试规则",
    goal: "避免执行已被反例否定的旧规则",
    acceptance: "默认上下文不含旧规则",
    scope: "work",
  });
  assert.equal(context.results.length, 0);
  assert.equal(context.units.length, 0);
  assert.equal(findExperienceCandidate(home, created.candidate.id)?.status, "pending_review");
  store.close();
});

test("Explicit correction request fails closed for invalid action, reason, Artifact Run, and scope", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-correction-request-gates-"));
  const store = new LedgerStore({ home });
  const workTarget = captureKnowledge(home, { title: "工作旧规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "旧规则。" });
  const personalTarget = captureKnowledge(home, { title: "个人旧规则", scope: "personal", status: "draft", sourceRefs: ["manual:user"], body: "旧规则。" });
  const workEvidence = createCorrectionEvidence(home, store, "work", "work-correction-evidence");
  const otherWorkEvidence = createCorrectionEvidence(home, store, "work", "other-work-correction-evidence");
  const valid: CorrectionRequestInput = {
    knowledgeId: workTarget.id,
    runId: workEvidence.run.id,
    artifactId: workEvidence.artifact.id,
    action: "revise",
    reason: "明确的直接反例。",
  };

  assert.throws(() => requestKnowledgeCorrection(home, store, { ...valid, action: "new" as never }), /revise|retire/i);
  assert.throws(() => requestKnowledgeCorrection(home, store, { ...valid, reason: "   " }), /reason/i);
  assert.throws(() => requestKnowledgeCorrection(home, store, { ...valid, artifactId: "artifact-missing" }), /artifact/i);
  assert.throws(() => requestKnowledgeCorrection(home, store, { ...valid, artifactId: otherWorkEvidence.artifact.id }), /same.*run|run.*match/i);
  assert.throws(() => requestKnowledgeCorrection(home, store, { ...valid, knowledgeId: personalTarget.id }), /scope/i);
  assert.deepEqual(searchKnowledge(home, "旧规则", { scope: "work" }).map((item) => item.id), [workTarget.id]);
  assert.deepEqual(searchKnowledge(home, "旧规则", { scope: "personal" }).map((item) => item.id), [personalTarget.id]);
  store.close();
});
