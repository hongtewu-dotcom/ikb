import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeExperience, findLatestExperienceAnalysis, listExperienceValidations, rankExperienceQueue, recordExperienceValidation, type ExperienceAnalysisInput } from "../src/experience-analysis.ts";
import { clusterExperienceRecords, decideExperienceCandidate, findExperienceCandidate, findExperienceRecord, listExperienceRecords, markExperienceAnalyzed, triageSessions, type ExperienceRecord } from "../src/experience.ts";
import { captureKnowledge } from "../src/knowledge.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";

function seed(home: string, path: string): { store: LedgerStore; record: ExperienceRecord } {
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "analysis", messageId: "u1", timestamp: "2026-08-01T10:00:00Z", content: "这个结论不对，失败后不能直接重试，必须先确认根因和边界。" }),
    JSON.stringify({ role: "assistant", conversationId: "analysis", messageId: "a1", timestamp: "2026-08-01T10:01:00Z", content: "已定位根因，修正后会补充回归验证。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  const store = new LedgerStore({ home });
  triageSessions(home, store, { scope: "work", adapter: "codex" });
  const record = listExperienceRecords(home, "work")[0];
  assert.ok(record);
  return { store, record };
}

function validInput(record: ExperienceRecord): ExperienceAnalysisInput {
  return {
    experienceId: record.id,
    title: "重试前先确认根因",
    summary: "人工纠偏指出，失败后不能机械重试，需要先确认根因、适用边界和回归证据。",
    disposition: "candidate",
    reason: "这是一条具备明确触发条件、动作和验证方式的可复用排查规则。",
    findings: [{
      id: "fact-1",
      kind: "fact",
      statement: "用户明确否定了失败后直接重试，并要求先确认根因和边界。",
      evidenceRecordIds: [record.evidenceRecordIds[0]],
      evidenceEventIds: [],
    }],
    candidate: {
      changeType: "new",
      targetKnowledgeIds: [],
      patternKey: "debug.confirm-cause-before-retry",
      patternLabel: "重试前确认根因",
      knowledgeType: "playbook",
      collection: "playbooks",
      canonicalClaim: "失败后的第一次动作应是确认根因与影响边界；只有证据表明重试可改变条件时才重试。",
      applicability: "命令、构建、接口或自动化步骤出现失败且重试成本不为零时。",
      boundary: "瞬时网络抖动且已有幂等重试策略的场景，可由既有策略处理。",
      useWhen: "Agent 准备对失败步骤执行重试时。",
      steps: ["保存失败证据", "区分环境、输入和实现根因", "确认重试会改变哪个条件", "执行一次有界重试"],
      checks: ["失败证据可回放", "重试前后条件差异明确", "结果经过回归验证"],
      stopConditions: ["根因未明且重试可能产生副作用时停止", "同一条件下重复失败时停止"],
      validationPlan: "在一个独立 Run 中记录失败条件、修复或条件变化、重试结果及 Verifier 结论。",
    },
    counterevidence: {
      searched: true,
      scope: "本次会话的全部人类与助手消息",
      evidenceRecordIds: [],
      result: "未发现用户允许无条件机械重试的陈述。",
    },
    unknowns: ["尚未验证该规则是否适用于已有平台级自动重试的任务"],
  };
}

test("Experience Analysis rejects invented evidence and incomplete candidate contracts", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-analysis-invalid-"));
  const home = join(sandbox, "ikb-data");
  const seeded = seed(home, join(sandbox, "session.jsonl"));
  const invented = validInput(seeded.record);
  invented.findings[0].evidenceRecordIds = ["record-does-not-exist"];
  assert.throws(
    () => analyzeExperience(home, seeded.store, seeded.record, invented, (analysis) => markExperienceAnalyzed(home, analysis)),
    /outside Experience/,
  );
  const incomplete = validInput(seeded.record);
  incomplete.candidate!.checks = [];
  assert.throws(
    () => analyzeExperience(home, seeded.store, seeded.record, incomplete, (analysis) => markExperienceAnalyzed(home, analysis)),
    /candidate\.checks must not be empty/,
  );
  seeded.store.close();
});

test("Experience Analysis preserves an entity/domains revision shape and rejects type drift", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-analysis-domain-shape-"));
  const home = join(sandbox, "ikb-data");
  const target = captureKnowledge(home, {
    title: "报价模型历史事实包",
    scope: "work",
    type: "entity",
    collection: "domains",
    body: "报价模型包含当前事实、目标设计和待补证边界。",
  });
  const seeded = seed(home, join(sandbox, "session.jsonl"));

  const drifting = validInput(seeded.record);
  drifting.candidate = {
    ...drifting.candidate!,
    changeType: "revise",
    targetKnowledgeIds: [target.id],
    patternKey: "pricing.revise-domain-fact-pack",
  };
  assert.throws(
    () => analyzeExperience(home, seeded.store, seeded.record, drifting, (analysis) => markExperienceAnalyzed(home, analysis)),
    /type and collection must match its target Knowledge: entity\/domains/,
  );

  const preserving = validInput(seeded.record);
  preserving.candidate = {
    ...preserving.candidate!,
    changeType: "revise",
    targetKnowledgeIds: [target.id],
    patternKey: "pricing.revise-domain-fact-pack",
    patternLabel: "修订报价模型历史事实包",
    knowledgeType: "entity",
    collection: "domains",
  };
  analyzeExperience(home, seeded.store, seeded.record, preserving, (analysis) => markExperienceAnalyzed(home, analysis));
  const candidate = clusterExperienceRecords(home, seeded.store, { scope: "work" }).candidates[0];
  assert.equal(candidate.candidateKnowledge.type, "entity");
  assert.equal(candidate.candidateKnowledge.collection, "domains");
  assert.deepEqual(candidate.targetKnowledgeIds, [target.id]);
  seeded.store.close();
});

test("Experience Analysis is immutable, idempotent and survives unchanged Triage", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-analysis-idempotent-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "session.jsonl");
  const seeded = seed(home, path);
  const input = validInput(seeded.record);
  const first = analyzeExperience(home, seeded.store, seeded.record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  assert.equal(first.outcome, "created");
  assert.equal(first.record.status, "analyzed");
  assert.equal(first.record.analysisDisposition, "candidate");
  assert.equal(first.record.semanticPatternKey, "debug.confirm-cause-before-retry");
  assert.equal(existsSync(join(home, first.analysis.revisionRef)), true);
  const originalRevision = readFileSync(join(home, first.analysis.revisionRef), "utf8");

  const second = analyzeExperience(home, seeded.store, first.record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  assert.equal(second.outcome, "unchanged");
  assert.equal(second.analysis.createdAt, first.analysis.createdAt);
  assert.equal(readFileSync(join(home, first.analysis.revisionRef), "utf8"), originalRevision);
  assert.equal(seeded.store.listEvents().filter((event) => event.eventType === "experience.analyzed").length, 1);

  triageSessions(home, seeded.store, { scope: "work", adapter: "codex" });
  const afterTriage = findExperienceRecord(home, seeded.record.id)!;
  assert.equal(afterTriage.status, "analyzed");
  assert.equal(afterTriage.analysisId, first.analysis.id);
  assert.equal(findLatestExperienceAnalysis(home, afterTriage)?.id, first.analysis.id);
  seeded.store.close();
});

test("Changed source evidence invalidates prior semantic analysis and returns it to queue", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-analysis-invalidate-"));
  const home = join(sandbox, "ikb-data");
  const path = join(sandbox, "session.jsonl");
  const seeded = seed(home, path);
  const analyzed = analyzeExperience(home, seeded.store, seeded.record, validInput(seeded.record), (analysis) => markExperienceAnalyzed(home, analysis));
  writeFileSync(path, [
    JSON.stringify({ role: "user", conversationId: "analysis", messageId: "u1", timestamp: "2026-08-01T10:00:00Z", content: "这个结论不对，失败后不能直接重试，必须先确认根因和边界。" }),
    JSON.stringify({ role: "assistant", conversationId: "analysis", messageId: "a1", timestamp: "2026-08-01T10:01:00Z", content: "已定位根因，修正后会补充回归验证。" }),
    JSON.stringify({ role: "user", conversationId: "analysis", messageId: "u2", timestamp: "2026-08-01T10:02:00Z", content: "补充决定：有明确幂等契约且已知是瞬时网络错误时可以有界重试。" }),
  ].join("\n") + "\n");
  importSource(home, path, { kind: "ai_conversation", adapter: "codex", scope: "work" });
  triageSessions(home, seeded.store, { scope: "work", adapter: "codex" });
  const changed = findExperienceRecord(home, analyzed.record.id)!;
  assert.equal(changed.status, "queued");
  assert.equal(changed.analysisId, undefined);
  assert.equal(rankExperienceQueue([changed], "work").length, 1);
  assert.equal(seeded.store.listEvents().some((event) => event.eventType === "experience.analysis_invalidated"), true);
  seeded.store.close();
});

test("Experience semantic validation requires a current hashed Artifact", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-validation-artifact-"));
  const home = join(sandbox, "ikb-data");
  const seeded = seed(home, join(sandbox, "session.jsonl"));
  const analyzed = analyzeExperience(home, seeded.store, seeded.record, validInput(seeded.record), (analysis) => markExperienceAnalyzed(home, analysis));
  const task = seeded.store.createTask({ title: "validate", goal: "validate experience", acceptance: "artifact", scope: "work" });
  const run = seeded.store.createRun(task.id, "ikb-verifier", ["experience-validation"]);
  const path = join(sandbox, "validation.md");
  writeFileSync(path, "# 验证\n\n复现失败，应用规则后回归通过。\n");
  const artifact = seeded.store.createArtifact({ runId: run.id, kind: "experience-validation", label: "真实回归", path });
  const validation = recordExperienceValidation(home, seeded.store, analyzed.record, {
    result: "pass",
    method: "独立复现与回归",
    note: "证据显示规则在本次独立任务中成立。",
    artifactId: artifact.id,
  });
  assert.equal(listExperienceValidations(home, analyzed.record).map((item) => item.id).includes(validation.id), true);
  assert.equal(seeded.store.listEvents().filter((event) => event.eventType === "experience.validation_recorded").length, 1);
  assert.equal(recordExperienceValidation(home, seeded.store, analyzed.record, {
    result: "pass",
    method: "独立复现与回归",
    note: "证据显示规则在本次独立任务中成立。",
    artifactId: artifact.id,
  }).id, validation.id);
  assert.equal(seeded.store.listEvents().filter((event) => event.eventType === "experience.validation_recorded").length, 1);
  writeFileSync(path, "tampered\n");
  assert.throws(() => recordExperienceValidation(home, seeded.store, analyzed.record, {
    result: "pass",
    method: "独立复现与回归",
    note: "证据已变化。",
    artifactId: artifact.id,
  }), /Artifact hash changed/);
  seeded.store.close();
});

test("A direct counterexample can create a pending revision candidate without pretending it is new knowledge", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-revision-candidate-"));
  const home = join(sandbox, "ikb-data");
  const target = captureKnowledge(home, { title: "旧的自动重试规则", scope: "personal", type: "playbook", collection: "playbooks", body: "失败后总是直接重试。" });
  const seeded = seed(home, join(sandbox, "session.jsonl"));
  const input = validInput(seeded.record);
  input.candidate = {
    ...input.candidate!,
    changeType: "revise",
    targetKnowledgeIds: [target.id],
    patternKey: "debug.revise-unconditional-retry",
    patternLabel: "修订无条件重试规则",
    canonicalClaim: "旧规则把所有失败都视为可重试；新证据要求先确认根因与边界。",
  };
  analyzeExperience(home, seeded.store, seeded.record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  const clustered = clusterExperienceRecords(home, seeded.store, { scope: "work", minimumSamples: 3 });
  assert.equal(clustered.eligible, 1);
  assert.deepEqual(clustered.candidates[0].changeTypes, ["revise"]);
  assert.deepEqual(clustered.candidates[0].targetKnowledgeIds, [target.id]);
  assert.match(clustered.candidates[0].title, /知识修订/);
  assert.equal(clustered.candidates[0].status, "pending_review");
  assert.equal(clustered.candidates[0].scope, "personal");
  assert.equal(clustered.candidates[0].sourceRecordRefs.some((ref) => /^src-[^:]+:src-/.test(ref)), false);
  seeded.store.close();
});

test("Experience Candidate decisions are immutable, idempotent and bound to reviewed content", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-candidate-decision-"));
  const home = join(sandbox, "ikb-data");
  const target = captureKnowledge(home, { title: "旧的自动重试规则", scope: "work", type: "playbook", collection: "playbooks", body: "失败后总是直接重试。" });
  const seeded = seed(home, join(sandbox, "session.jsonl"));
  const input = validInput(seeded.record);
  input.candidate = {
    ...input.candidate!,
    changeType: "revise",
    targetKnowledgeIds: [target.id],
    patternKey: "debug.revise-reviewed-content",
    patternLabel: "修订无条件重试规则",
  };
  analyzeExperience(home, seeded.store, seeded.record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  const clustered = clusterExperienceRecords(home, seeded.store, { scope: "work" });
  const pending = clustered.candidates[0];
  assert.match(pending.contentHash, /^[a-f0-9]{64}$/);
  const reviewedPath = join(home, "reviews", "完整替换稿.md");
  mkdirSync(join(home, "reviews"), { recursive: true });
  writeFileSync(reviewedPath, "---\nid: kb-reviewed\nscope: work\n---\n\n# 完整替换稿\n\n失败后先确认根因与边界，再决定是否重试。\n");

  assert.throws(() => decideExperienceCandidate(home, seeded.store, pending.id, {
    decision: "accept",
    reason: "反例足以否定无条件规则。",
  }), /requires --file with the complete reviewed Knowledge draft/);

  const accepted = decideExperienceCandidate(home, seeded.store, pending.id, {
    decision: "accept",
    reason: "反例足以否定无条件规则，接受这份完整替换稿。",
    reviewedArtifactPath: reviewedPath,
  });
  assert.equal(accepted.outcome, "updated");
  assert.equal(accepted.candidate.status, "accepted");
  assert.equal(accepted.candidate.decision?.candidateContentHash, pending.contentHash);
  assert.equal(accepted.candidate.decision?.reviewedArtifact?.sourceRef, "reviews/完整替换稿.md");
  assert.match(accepted.candidate.decision?.reviewedArtifact?.ref ?? "", /^experiences\/reviews\/exp-cand-[^/]+\/[a-f0-9]{64}\.md$/);
  assert.equal(existsSync(join(home, accepted.candidate.decision!.reviewedArtifact!.ref)), true);
  assert.equal(accepted.candidate.nextAction, "curate_accepted_candidate_and_apply");
  assert.equal(decideExperienceCandidate(home, seeded.store, pending.id, {
    decision: "accept",
    reason: "反例足以否定无条件规则，接受这份完整替换稿。",
  }).outcome, "unchanged");
  assert.throws(() => decideExperienceCandidate(home, seeded.store, pending.id, {
    decision: "reject",
    reason: "改主意",
  }), /already accepted/);
  assert.equal(seeded.store.listEvents().filter((event) => event.eventType === "experience.candidate_accepted").length, 1);
  seeded.store.close();

  // Simulate a crash after the Candidate file was written but before its
  // lifecycle event reached the ledger. An idempotent retry must repair it.
  const ledgerPath = join(home, "ledger", "events.jsonl");
  const withoutDecisionEvent = readFileSync(ledgerPath, "utf8").split("\n")
    .filter((line) => line && JSON.parse(line).eventType !== "experience.candidate_accepted")
    .join("\n");
  writeFileSync(ledgerPath, `${withoutDecisionEvent}\n`);
  const recoveredStore = new LedgerStore({ home });
  assert.equal(decideExperienceCandidate(home, recoveredStore, pending.id, {
    decision: "accept",
    reason: "反例足以否定无条件规则，接受这份完整替换稿。",
  }).outcome, "unchanged");
  assert.equal(recoveredStore.listEvents().filter((event) => event.eventType === "experience.candidate_accepted").length, 1);

  const rerun = clusterExperienceRecords(home, recoveredStore, { scope: "work" });
  assert.equal(rerun.candidates[0].status, "accepted");
  assert.equal(findExperienceCandidate(home, pending.id)?.decision?.reason, accepted.candidate.decision?.reason);
  recoveredStore.close();
});

test("A changed Candidate invalidates an earlier decision instead of reusing stale approval", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-candidate-decision-stale-"));
  const home = join(sandbox, "ikb-data");
  const target = captureKnowledge(home, { title: "旧规则", scope: "work", type: "playbook", collection: "playbooks", body: "失败后总是直接重试。" });
  const seeded = seed(home, join(sandbox, "session.jsonl"));
  const input = validInput(seeded.record);
  input.candidate = { ...input.candidate!, changeType: "revise", targetKnowledgeIds: [target.id], patternKey: "debug.stale-decision", patternLabel: "旧规则修订" };
  analyzeExperience(home, seeded.store, seeded.record, input, (analysis) => markExperienceAnalyzed(home, analysis));
  const first = clusterExperienceRecords(home, seeded.store, { scope: "work" }).candidates[0];
  decideExperienceCandidate(home, seeded.store, first.id, { decision: "reject", reason: "当前反证范围不足。" });

  const path = join(home, "experiences", "candidates", `${first.id}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.claimVariants = [...raw.claimVariants, "补充后的不同主张"];
  raw.contentHash = "stale";
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  const refreshed = clusterExperienceRecords(home, seeded.store, { scope: "work" }).candidates[0];
  assert.equal(refreshed.status, "pending_review");
  assert.equal(refreshed.decision, undefined);
  assert.notEqual(refreshed.contentHash, "stale");
  seeded.store.close();
});

test("Experience queue prioritizes human correction over a plain retry signal", () => {
  const base = {
    schema: "ikb-experience.v1" as const,
    scope: "work" as const,
    adapter: "codex" as const,
    sourceTitle: "session",
    sourceIds: ["src-1"],
    sourceOriginHash: "hash",
    sessionKeyHash: "session",
    conversationIdHash: "conversation",
    sourceRecordIds: ["r1"],
    evidenceRecordIds: ["r1"],
    evidenceEventIds: [],
    runIds: [],
    validationRefs: [],
    triageDisposition: "selected" as const,
    exclusionReasons: [],
    status: "queued" as const,
    firstSeenAt: "2026-08-01T00:00:00Z",
    lastSeenAt: "2026-08-01T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
  const retry = { ...base, id: "exp-retry", signalCodes: ["retry" as const], signalCounts: { retry: 1 } as ExperienceRecord["signalCounts"] };
  const correction = { ...base, id: "exp-correction", signalCodes: ["manual_correction" as const], signalCounts: { manual_correction: 1 } as ExperienceRecord["signalCounts"] };
  const queue = rankExperienceQueue([retry, correction], "work");
  assert.deepEqual(queue.map((item) => item.experienceId), ["exp-correction", "exp-retry"]);
});
