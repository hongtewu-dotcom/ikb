import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideExperienceCandidate, findExperienceCandidate } from "../src/experience.ts";
import { applyKnowledgeCandidate, findKnowledge, listKnowledgeRevisions, searchKnowledge } from "../src/knowledge.ts";
import { LedgerStore } from "../src/store.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(projectRoot, "src", "cli.ts");

function writePendingNewCandidate(home: string, id: string): void {
  const root = join(home, "experiences", "candidates");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${id}.json`), `${JSON.stringify({
    schema: "ikb-knowledge-candidate.v1",
    id,
    scope: "work",
    status: "pending_review",
    contentHash: "c".repeat(64),
    title: "待复核经验模式：失败后先确认根因",
    patternKey: "debug.confirm-cause-before-retry",
    signalCodes: ["manual_correction", "non_obvious_fix"],
    analysisIds: ["exp-analysis-new-1", "exp-analysis-new-2", "exp-analysis-new-3"],
    patternLabel: "失败后先确认根因",
    claimVariants: ["失败后先确认根因和边界，再决定是否重试。"],
    changeTypes: ["new"],
    targetKnowledgeIds: [],
    experienceIds: ["exp-new-1", "exp-new-2", "exp-new-3"],
    sourceIds: ["src-new-1"],
    sourceRecordRefs: ["src-new-1:r1"],
    evidenceEventIds: [],
    runIds: ["run-new-1", "run-new-2", "run-new-3"],
    validationRefs: [],
    independentRunCount: 3,
    independentSourceCount: 1,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: "失败后先确认根因和边界，再决定是否重试。",
      type: "playbook",
      collection: "playbooks",
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan"],
      evidenceRefs: ["src-new-1:r1"],
      applicability: "自动化步骤失败且重试有成本时。",
      boundary: "已有平台幂等重试契约的瞬时错误另行处理。",
      useContract: "准备重试失败步骤时。",
      validationPlan: "独立 Run 回归。",
      confidence: "unknown",
      temporalState: "unknown",
    },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
  }, null, 2)}\n`, { mode: 0o600 });
}

function reviewedDraft(candidateId: string, knowledgeId = "kb-new-candidate-application"): string {
  return `---
id: ${knowledgeId}
type: "playbook"
collection: playbooks
source_kind: "artifact"
scope: work
sensitivity: "work-internal"
status: draft
title: "失败后有界重试作业卡"
source_refs: ["src-new-1","experience-candidate:${candidateId}"]
valid_from: 2026-08-07
review_after: 2026-11-07
tags: ["排查","重试"]
aliases: ["${knowledgeId}"]
related: []
derived_from: []
contradicts: []
revision: 1
revision_history: []
quality_version: 4
product_type: "playbook"
compilation_ref: "experience-candidate:${candidateId}"
fact_refs: ["retry-f1"]
questions_answered: ["失败后何时可以重试"]
admission_reason: "三个独立Run重复出现同一人工纠偏，并能转成有界执行步骤。"
applicability: "自动化步骤失败且重试有成本时。"
boundary: "已有平台幂等重试契约的瞬时错误另行处理。"
use_when: "Agent准备重试失败步骤时。"
use_inputs: ["失败证据","当前输入","副作用边界"]
use_outputs: ["根因分类","是否重试的决定","验证结果"]
use_steps: ["保存失败证据","确认根因和边界","只在条件变化后有界重试"]
use_checks: ["前后条件差异明确","重试结果经过验证"]
use_stop_conditions: ["根因不明且有副作用","相同条件再次失败"]
confidence: medium
confidence_basis: ["三个独立Run中的直接人工纠偏"]
temporal_state: current
verification: source_confirmed
counterevidence_refs: []
counterevidence_search: "检查三个Run中允许平台自动重试的反例。"
do_not_use_for: ["把所有失败都当成可重试","跳过副作用检查"]
---
# 失败后有界重试作业卡

失败后先保存证据、确认根因和影响边界。只有输入、环境或实现条件已经改变，并且副作用可控时，才执行一次有界重试；相同条件再次失败就停止并升级处理。
`;
}

test("new Knowledge Candidate acceptance and application are exact, idempotent and recoverable", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-new-candidate-"));
  const candidateId = "exp-cand-newapplication";
  writePendingNewCandidate(home, candidateId);
  const reviewPath = join(home, "reviews", "完整知识稿.md");
  mkdirSync(join(home, "reviews"), { recursive: true });
  const reviewed = reviewedDraft(candidateId);
  writeFileSync(reviewPath, reviewed, { mode: 0o600 });
  const store = new LedgerStore({ home });

  assert.throws(() => decideExperienceCandidate(home, store, candidateId, {
    decision: "accept",
    reason: "接受完整作业卡。",
  }), /requires --file with the complete reviewed Knowledge draft/);
  const accepted = decideExperienceCandidate(home, store, candidateId, {
    decision: "accept",
    reason: "接受这份完整作业卡及其中的适用边界。",
    reviewedArtifactPath: reviewPath,
  });
  assert.equal(accepted.candidate.status, "accepted");
  assert.ok(accepted.candidate.decision?.reviewedArtifact);

  const applied = applyKnowledgeCandidate(home, store, candidateId, { replacementPath: reviewPath });
  assert.equal(applied.mode, "create");
  assert.equal(applied.recovered, false);
  const record = findKnowledge(home, "kb-new-candidate-application")!;
  assert.ok(record);
  assert.equal(readFileSync(record.path, "utf8"), reviewed);
  assert.equal(record.status, "draft");
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "applied");
  assert.deepEqual(findExperienceCandidate(home, candidateId)?.resolution?.knowledgeIds, [record.id]);
  assert.equal(searchKnowledge(home, "失败 有界重试", { scope: "work" })[0]?.id, record.id);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.created" && event.payload.candidateId === candidateId).length, 1);
  assert.equal(listKnowledgeRevisions(home).length, 0);

  const rerun = applyKnowledgeCandidate(home, store, candidateId, { replacementPath: reviewPath });
  assert.equal(rerun.mode, "create");
  assert.equal(rerun.recovered, true);
  assert.equal(store.listEvents().filter((event) => event.eventType === "knowledge.created" && event.payload.candidateId === candidateId).length, 1);

  const concurrentBytes = `${reviewed}\n并发人工修改。\n`;
  writeFileSync(record.path, concurrentBytes, { mode: 0o600 });
  assert.throws(() => applyKnowledgeCandidate(home, store, candidateId, { replacementPath: reviewPath }), /different bytes; refusing to overwrite/);
  assert.equal(readFileSync(record.path, "utf8"), concurrentBytes);
  store.close();
});

test("new Knowledge Candidate application rejects bytes changed after acceptance", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-new-candidate-changed-"));
  const candidateId = "exp-cand-newchanged";
  writePendingNewCandidate(home, candidateId);
  const reviewPath = join(home, "完整知识稿.md");
  writeFileSync(reviewPath, reviewedDraft(candidateId, "kb-new-candidate-changed"), { mode: 0o600 });
  const store = new LedgerStore({ home });
  decideExperienceCandidate(home, store, candidateId, {
    decision: "accept",
    reason: "接受当前完整稿。",
    reviewedArtifactPath: reviewPath,
  });
  writeFileSync(reviewPath, `${readFileSync(reviewPath, "utf8")}\n未经确认的新内容。\n`);
  assert.throws(() => applyKnowledgeCandidate(home, store, candidateId, { replacementPath: reviewPath }), /do not match the file accepted by the user/);
  assert.equal(findKnowledge(home, "kb-new-candidate-changed"), null);
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "accepted");
  store.close();
});

test("CLI refuses to accept a Knowledge Candidate before a validated review package exists", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-new-candidate-cli-"));
  const candidateId = "exp-cand-newcli";
  writePendingNewCandidate(home, candidateId);
  const reviewPath = join(home, "CLI完整知识稿.md");
  writeFileSync(reviewPath, reviewedDraft(candidateId, "kb-new-candidate-cli"), { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    cliPath,
    "experience", "candidate-decide", candidateId,
    "--decision", "accept",
    "--reason", "接受完整稿、适用范围和停止条件。",
    "--file", reviewPath,
    "--home", home,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be accepted without a current validated review package/);
  assert.equal(findExperienceCandidate(home, candidateId)?.status, "pending_review");
  assert.equal(findKnowledge(home, "kb-new-candidate-cli"), null);
});

function runCli(home: string, args: string[]): any {
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    cliPath,
    ...args,
    "--home",
    home,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
