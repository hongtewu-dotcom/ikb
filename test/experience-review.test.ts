import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveRetiredKnowledge, captureKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";
import { renderKnowledge } from "../src/knowledge/codec.ts";
import { renderKnowledgeProductBody, verifyExtractionBatch } from "../src/extraction-result.ts";
import {
  decideReviewedExperienceCandidate,
  inspectCurrentExperienceReviewPackage,
  inspectExperienceReviewRegistry,
  registerExperienceReviewPackage,
} from "../src/experience-review.ts";
import { LedgerStore } from "../src/store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-experience-review-"));
}

function createTarget(home: string, candidateId: string) {
  return captureKnowledge(home, {
    title: "失败后的有界重试规则",
    type: "playbook",
    collection: "playbooks",
    scope: "work",
    status: "draft",
    sourceRefs: [`experience-candidate:${candidateId}`, "src-test:r1"],
    qualityVersion: 4,
    productType: "playbook",
    compilationRef: "artifact:test-compilation",
    factRefs: ["retry-f1"],
    questionsAnswered: ["失败后何时可以重试"],
    useWhen: "自动化步骤失败且重试有成本时。",
    useInputs: ["失败证据", "副作用边界"],
    useOutputs: ["是否重试的决定"],
    useSteps: ["保存失败证据", "确认条件变化后只重试一次"],
    useChecks: ["前后条件差异明确"],
    useStopConditions: ["相同条件再次失败"],
    confidence: "medium",
    confidenceBasis: ["两次独立纠偏和一次验证"],
    temporalState: "current",
    verification: "source_confirmed",
    body: "失败后先保存证据，确认根因和副作用边界；只有条件已经改变时才做一次有界重试。",
  });
}

function writeCandidate(home: string, candidateId: string, targetId: string, overrides: Record<string, unknown> = {}): void {
  const directory = join(home, "experiences", "candidates");
  mkdirSync(directory, { recursive: true });
  const candidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: candidateId,
    scope: "work",
    status: "pending_review",
    contentHash: "a".repeat(64),
    title: "待复核知识修订：失败后的有界重试规则",
    patternKey: "debug.retry",
    signalCodes: ["manual_correction"],
    analysisIds: ["exp-analysis-1"],
    patternLabel: "失败后的有界重试规则",
    claimVariants: ["失败后先确认根因和边界，再决定是否重试。"],
    changeTypes: ["revise"],
    targetKnowledgeIds: [targetId],
    experienceIds: ["exp-1"],
    sourceIds: ["src-test"],
    sourceRecordRefs: ["src-test:r1"],
    evidenceEventIds: [],
    runIds: ["run-evidence"],
    validationRefs: ["exp-validation-1"],
    independentRunCount: 2,
    independentSourceCount: 2,
    humanApprovalRequired: true,
    candidateKnowledge: {
      claim: "失败后先确认根因和边界，再决定是否重试。",
      type: "playbook",
      collection: "playbooks",
      requiredSections: ["claim", "evidence", "applicability", "boundary", "use contract", "validation plan"],
      evidenceRefs: ["src-test:r1"],
      applicability: "自动化步骤失败且重试有成本时。",
      boundary: "已有平台幂等重试契约的瞬时错误另行处理。",
      useContract: "准备重试失败步骤时。",
      validationPlan: "独立 Run 回归。",
      confidence: "medium",
      temporalState: "current",
    },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: "2026-08-07T00:00:00Z",
    updatedAt: "2026-08-07T00:00:00Z",
    ...overrides,
  };
  writeFileSync(join(directory, `${candidateId}.json`), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
}

function createLossArtifacts(home: string, store: LedgerStore, targetId: string, invalidFidelity = false) {
  const sourceText = "失败后先保存证据；只有条件变化且副作用可控时，才允许一次有界重试。";
  const directory = join(home, "extraction", "retry");
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, "重试来源.md");
  writeFileSync(sourcePath, `${sourceText}\n`, { mode: 0o600 });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = {
    schema: "ikb-knowledge-extraction-benchmark.v3",
    benchmark_id: "retry-benchmark",
    cases: [{
      case_id: "retry-case",
      category: "playbook",
      title: "失败后的有界重试规则",
      input_fingerprint: "b".repeat(64),
      extraction_modes: ["playbook"],
      source_ids: ["src-test"],
      source_snapshots: [{ source_id: "src-test", path: sourcePath, content_sha256: hash(`${sourceText}\n`) }],
      consumer_tasks: ["失败恢复"],
      obligations: [{ obligation_id: "retry-rule", description: "失败后何时允许重试", importance: "core", required_product_types: ["playbook"] }],
      source_units: [{
        unit_id: "unit-retry",
        source_id: "src-test",
        unit_kind: "paragraph",
        locator: "第 1 行",
        content: sourceText,
        content_sha256: hash(sourceText),
        importance: "core",
      }],
      reference_facts: [{
        reference_fact_id: "rf-retry",
        statement: sourceText,
        importance: "core",
        source_unit_refs: ["unit-retry"],
        question_refs: ["q-retry"],
      }],
      questions: [{ question_id: "q-retry", text: "失败后何时允许重试？", importance: "core", required_product_types: ["playbook"] }],
      existing_knowledge: [{ knowledge_id: targetId, canonical_key: "work:debug:playbook:bounded-retry" }],
    }],
  };
  const result = {
    schema: "ikb-knowledge-compilation-result.v3",
    benchmark_id: "retry-benchmark",
    case_id: "retry-case",
    input_fingerprint: "b".repeat(64),
    extraction_modes: ["playbook"],
    disposition: "admit",
    disposition_reason: "包含可执行且有停止条件的恢复规则",
    evidence_units: [{
      evidence_id: "ev-retry",
      source_id: "src-test",
      record_id: "src-test:1",
      locator: "第 1 行",
      excerpt: sourceText,
      excerpt_sha256: hash(sourceText),
      attribution_role: "author",
      actor: "author01",
      occurred_at: "2026-08-01T00:00:00Z",
      source_unit_refs: ["unit-retry"],
    }],
    facts: [{
      fact_id: "retry-f1",
      fact_kind: "procedure_rule",
      statement: sourceText,
      evidence_ids: ["ev-retry"],
      reference_fact_refs: ["rf-retry"],
      derivation: "direct",
      temporal_state: "current",
      importance: "core",
    }],
    claims: [{
      claim_id: "claim-retry",
      text: "重试必须以条件变化、副作用可控和一次上限为前提。",
      claim_kind: "synthesis",
      fact_refs: ["retry-f1"],
      counterevidence_fact_refs: [],
      reasoning: "来源同时给出前置条件、次数上限和停止边界。",
      temporal_state: "current",
      support_status: "supported",
    }],
    coverage: [{ obligation_id: "retry-rule", disposition: "covered", fact_refs: ["retry-f1"], reason: "事实直接覆盖" }],
    source_unit_dispositions: [{ unit_id: "unit-retry", disposition: "extracted", evidence_ids: ["ev-retry"], fact_refs: ["retry-f1"], reason: "保留完整规则" }],
    reference_fact_dispositions: [{ reference_fact_id: "rf-retry", disposition: "preserved", fact_refs: ["retry-f1"], reason: "原义保留" }],
    products: [{
      product_id: "p-retry",
      product_type: "playbook",
      title: "失败后的有界重试规则",
      canonical_key: "work:debug:playbook:bounded-retry",
      operation: "revise",
      primary_knowledge_id: targetId,
      unique_value: "给出可执行的前置条件、一次上限和停止条件",
      fact_refs: ["retry-f1"],
      claim_refs: ["claim-retry"],
      question_refs: ["q-retry"],
      consumer_tasks: ["失败恢复"],
      questions_answered: ["失败后何时允许重试？"],
      boundaries: ["瞬时错误已有平台幂等契约时按平台规则处理"],
      verification_plan: ["用相同失败条件和条件变化后的输入各回放一次"],
      procedure: {
        preconditions: ["已有失败证据", "能够判断副作用边界"],
        inputs: ["失败证据", "前后条件差异"],
        steps: ["保存失败证据", "确认条件变化", "只重试一次"],
        checks: ["副作用可控", "前后条件差异明确"],
        branches: ["条件未变化则不重试"],
        rollback: ["再次失败时停止并保留证据"],
        stop_conditions: ["相同条件再次失败"],
      },
    }],
    question_results: [{ question_id: "q-retry", disposition: "answered", fact_refs: ["retry-f1"], product_refs: ["p-retry"], reason: "执行卡直接回答" }],
    unknowns: ["平台内建瞬时重试的具体契约"],
    next_triggers: ["平台重试契约或副作用边界变化"],
  };
  const fidelity = verifyExtractionBatch(manifest, [result]);
  assert.equal(fidelity.valid, true);
  if (invalidFidelity) fidelity.verdicts[0].publishable = false;

  const task = store.createTask({ title: "低损耗抽取", goal: "冻结并验证重试知识", acceptance: "V3 保真报告通过", scope: "work" });
  const run = store.createRun(task.id, "ikb-analyst", ["ikb-conversation-analysis"]);
  const manifestPath = join(directory, "来源与问题清单.json");
  const resultPath = join(directory, "完整编译结果.json");
  const fidelityPath = join(directory, "信息损耗报告.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(resultPath, `${JSON.stringify({ results: [result] }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(fidelityPath, `${JSON.stringify(fidelity, null, 2)}\n`, { mode: 0o600 });
  return {
    manifest,
    result,
    manifestArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-manifest", label: "来源与问题清单", path: manifestPath }),
    resultArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-result", label: "完整编译结果", path: resultPath }),
    fidelityArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-fidelity", label: "信息损耗报告", path: fidelityPath }),
  };
}

function seedReview(home: string, options: { skillIds?: string[]; truncateBody?: boolean; legacyDraft?: boolean; invalidFidelity?: boolean } = {}) {
  const candidateId = "exp-cand-reviewfixture";
  const target = createTarget(home, candidateId);
  writeCandidate(home, candidateId, target.id);
  const store = new LedgerStore({ home, actor: "review-test" });
  const loss = createLossArtifacts(home, store, target.id, options.invalidFidelity);
  const task = store.createTask({ title: "候选评审包", goal: "生成完整评审材料", acceptance: "候选与材料哈希绑定", scope: "work" });
  const run = store.createRun(task.id, "ikb-curator", options.skillIds ?? ["ikb-knowledge-curator"]);
  const directory = join(home, "reviews", "fixture");
  mkdirSync(directory, { recursive: true });
  const draftPath = join(directory, "完整知识稿.md");
  const exactBody = renderKnowledgeProductBody(loss.result, "retry-case", "p-retry");
  const draftText = options.legacyDraft
    ? readFileSync(target.path, "utf8")
    : renderKnowledge({
      ...target,
      path: draftPath,
      qualityVersion: 5,
      canonicalKey: "work:debug:playbook:bounded-retry",
      compilationSchema: "ikb-knowledge-compilation-result.v3",
      compilationCaseId: "retry-case",
      compilationProductId: "p-retry",
      extractionManifestRef: loss.manifestArtifact.id,
      compilationRef: loss.resultArtifact.id,
      informationLossRef: loss.fidelityArtifact.id,
      factRefs: ["retry-f1"],
      questionsAnswered: ["失败后何时允许重试？"],
      body: options.truncateBody ? "失败后谨慎重试。\n" : exactBody,
    });
  writeFileSync(draftPath, draftText, { mode: 0o600 });
  const draft = store.createArtifact({ runId: run.id, kind: "knowledge-candidate-draft", label: "完整知识稿", path: draftPath });
  const validationPath = join(directory, "验证报告.md");
  writeFileSync(validationPath, [
    "# 候选验证报告",
    "",
    `Candidate：${candidateId}`,
    `Candidate content hash：${"a".repeat(64)}`,
    `完整稿 hash：${draft.contentHash}`,
    "",
    "QV5、来源清单、完整编译、信息损耗和最终正文逐字对账均通过。",
  ].join("\n"), { mode: 0o600 });
  const validation = store.createArtifact({ runId: run.id, kind: "knowledge-candidate-validation", label: "候选验证报告", path: validationPath });
  const guidePath = join(directory, "请确认.md");
  writeFileSync(guidePath, [
    "# 请确认：失败后的有界重试规则",
    "",
    `- Candidate：${candidateId}`,
    "",
    "## 待确认（请只回复编号）",
    "",
    "1. 是否接受这份完整修订稿及其中的适用范围和停止条件？",
    "",
    "确认后只进入 Knowledge 修订事务；不授权任何外部动作。驳回时请说明哪条证据或边界不成立。",
  ].join("\n"), { mode: 0o600 });
  const guide = store.createArtifact({ runId: run.id, kind: "knowledge-review-guide", label: "讲人话确认说明", path: guidePath });
  return { candidateId, target, store, run, draft, validation, guide, guidePath, loss };
}

test("review package binds one current Candidate, complete draft, validation and guide idempotently", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  const first = registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  assert.equal(first.outcome, "created");
  assert.equal(first.review.package.primaryKnowledgeId, seeded.target.id);
  assert.equal(first.review.draft?.path, seeded.draft.path);
  assert.equal(first.review.guide.path, seeded.guide.path);
  const confirmation = readFileSync(first.review.confirmationBrief.path, "utf8");
  assert.match(confirmation, /以下是已审阅的完整候选内容/);
  assert.match(confirmation, /失败后先保存证据/);
  assert.match(confirmation, /机器审计附录/);
  assert.doesNotMatch(confirmation, /source_refs:/);
  assert.deepEqual(first.review.validations.map((artifact) => artifact.id), [seeded.validation.id]);

  const second = registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  assert.equal(second.outcome, "unchanged");
  assert.equal(second.review.package.id, first.review.package.id);
  assert.equal(seeded.store.listEvents().filter((event) => event.eventType === "experience.candidate_review_registered").length, 1);
  assert.deepEqual(inspectExperienceReviewRegistry(home, seeded.store), { registered: 1, current: 1, issues: [] });
  seeded.store.close();
});

test("review registry resolves a moved frozen Source snapshot without rewriting its manifest", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "ikb-experience-review-relocation-"));
  const oldRoot = join(sandbox, "old-project");
  const oldHome = join(oldRoot, "ikb-data");
  const seeded = seedReview(oldHome);
  registerExperienceReviewPackage(oldHome, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  const manifestBytes = readFileSync(seeded.loss.manifestArtifact.path, "utf8");
  seeded.store.close();

  const newRoot = join(sandbox, "new-project");
  renameSync(oldRoot, newRoot);
  const newHome = join(newRoot, "ikb-data");
  const store = new LedgerStore({ home: newHome, actor: "review-test" });
  store.recordStorageRootRelocation({ fromRoot: oldRoot, toRoot: newRoot });
  const registry = inspectExperienceReviewRegistry(newHome, store);
  assert.deepEqual(registry, { registered: 1, current: 1, issues: [] });
  const rawManifestEvent = store.listEvents().find((event) => event.aggregateId === seeded.loss.manifestArtifact.id);
  assert.equal((rawManifestEvent?.payload.path as string).startsWith(oldRoot), true);
  assert.equal(readFileSync(store.requireArtifact(seeded.loss.manifestArtifact.id).path, "utf8"), manifestBytes);
  store.close();
});

test("review registry creates a new confirmation entrance after an in-home Artifact relocation", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  const registered = registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  const oldBriefPath = registered.review.confirmationBrief.path;
  const oldRoot = join(home, "reviews");
  const newRoot = join(home, ".system", "runs", "reviews");
  mkdirSync(join(home, ".system", "runs"), { recursive: true });
  renameSync(oldRoot, newRoot);
  seeded.store.recordStorageRootRelocation({ fromRoot: oldRoot, toRoot: newRoot });

  const inspection = inspectCurrentExperienceReviewPackage(home, seeded.store, seeded.candidateId);
  assert.deepEqual(inspection.issues, []);
  assert.ok(inspection.package);
  assert.notEqual(inspection.package.confirmationBrief.path, oldBriefPath);
  assert.match(readFileSync(inspection.package.confirmationBrief.path, "utf8"), /Proposal path: \.system\/runs\/reviews\/fixture/);
  assert.match(readFileSync(oldBriefPath, "utf8"), /Proposal path: reviews\/fixture/);
  assert.deepEqual(inspectExperienceReviewRegistry(home, seeded.store), { registered: 1, current: 1, issues: [] });
  seeded.store.close();
});

test("registry does not treat a rejected review package as current after its target is archived", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  decideReviewedExperienceCandidate(home, seeded.store, seeded.candidateId, {
    decision: "reject",
    reason: "The revision target has been retired and will be rebuilt from current evidence.",
  });
  updateKnowledgeStatus(home, seeded.target.id, "retired");
  archiveRetiredKnowledge(home, "work");

  assert.deepEqual(inspectExperienceReviewRegistry(home, seeded.store), { registered: 1, current: 0, issues: [] });
  seeded.store.close();
});

test("acceptance uses the package-bound draft by default and only accepts an exact explicit draft", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  assert.throws(() => decideReviewedExperienceCandidate(home, seeded.store, seeded.candidateId, {
    decision: "accept",
    reason: "接受完整稿。",
    reviewedArtifactPath: seeded.draft.path,
  }), /current validated review package/);
  registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  const otherPath = join(home, "reviews", "fixture", "另一份稿.md");
  writeFileSync(otherPath, `${readFileSync(seeded.draft.path, "utf8")}\n`, { mode: 0o600 });
  assert.throws(() => decideReviewedExperienceCandidate(home, seeded.store, seeded.candidateId, {
    decision: "accept",
    reason: "接受另一份稿。",
    reviewedArtifactPath: otherPath,
  }), /does not match the current review draft/);
  const accepted = decideReviewedExperienceCandidate(home, seeded.store, seeded.candidateId, {
    decision: "accept",
    reason: "接受完整稿及其边界。",
  });
  assert.equal(accepted.candidate.status, "accepted");
  assert.equal(accepted.candidate.decision?.reviewedArtifact?.contentHash, seeded.draft.contentHash);
  seeded.store.close();
});

test("review package fails closed when a registered review Artifact changes", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  });
  writeFileSync(seeded.guidePath, "# 被篡改\n", { mode: 0o600 });
  const inspection = inspectCurrentExperienceReviewPackage(home, seeded.store, seeded.candidateId);
  assert.equal(inspection.package, null);
  assert.match(inspection.issues.join("\n"), /hash changed/);
  assert.equal(inspectExperienceReviewRegistry(home, seeded.store).issues.length, 1);
  seeded.store.close();
});

test("review package rejects a non-Curator Run and mismatched Candidate shape", () => {
  const wrongRunHome = freshHome();
  const wrongRun = seedReview(wrongRunHome, { skillIds: ["ikb-conversation-analysis"] });
  assert.throws(() => registerExperienceReviewPackage(wrongRunHome, wrongRun.store, wrongRun.candidateId, {
    draftArtifactId: wrongRun.draft.id,
    validationArtifactIds: [wrongRun.validation.id],
    guideArtifactId: wrongRun.guide.id,
  }), /must use ikb-knowledge-curator/);
  wrongRun.store.close();

  const mismatchHome = freshHome();
  const mismatch = seedReview(mismatchHome);
  writeCandidate(mismatchHome, mismatch.candidateId, mismatch.target.id, {
    candidateKnowledge: {
      claim: "失败后先确认根因。",
      type: "fact",
      collection: "concepts",
      requiredSections: [],
      evidenceRefs: ["src-test:r1"],
      applicability: "失败后。",
      boundary: "有界。",
      useContract: "排查时。",
      validationPlan: "回归。",
      confidence: "medium",
      temporalState: "current",
    },
  });
  assert.throws(() => registerExperienceReviewPackage(mismatchHome, mismatch.store, mismatch.candidateId, {
    draftArtifactId: mismatch.draft.id,
    validationArtifactIds: [mismatch.validation.id],
    guideArtifactId: mismatch.guide.id,
  }), /type or collection does not match Candidate/);
  mismatch.store.close();
});

test("review package rejects an Artifact that resolves outside the IKB home", () => {
  const home = freshHome();
  const seeded = seedReview(home);
  const external = join(tmpdir(), `ikb-review-external-${Date.now()}.md`);
  writeFileSync(external, "# external\n", { mode: 0o600 });
  const link = join(home, "reviews", "fixture", "外部验证.md");
  symlinkSync(external, link);
  const artifact = seeded.store.createArtifact({ runId: seeded.run.id, kind: "knowledge-candidate-validation", label: "外部验证", path: link });
  assert.throws(() => registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [artifact.id],
    guideArtifactId: seeded.guide.id,
  }), /must stay inside IKB home/);
  seeded.store.close();
});

test("new review packages reject legacy drafts that are not bound to a V3 loss report", () => {
  const home = freshHome();
  const seeded = seedReview(home, { legacyDraft: true });
  assert.throws(() => registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  }), /quality_version >= 5/);
  seeded.store.close();
});

test("review package rejects a short body even when its frontmatter points at a valid compilation", () => {
  const home = freshHome();
  const seeded = seedReview(home, { truncateBody: true });
  assert.throws(() => registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  }), /body does not exactly match the deterministic product view/);
  seeded.store.close();
});

test("review package recomputes fidelity instead of trusting a stored publishable flag", () => {
  const home = freshHome();
  const seeded = seedReview(home, { invalidFidelity: true });
  assert.throws(() => registerExperienceReviewPackage(home, seeded.store, seeded.candidateId, {
    draftArtifactId: seeded.draft.id,
    validationArtifactIds: [seeded.validation.id],
    guideArtifactId: seeded.guide.id,
  }), /stored information loss report does not match recomputed fidelity/);
  seeded.store.close();
});
