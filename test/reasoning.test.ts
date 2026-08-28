import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKnowledge, listKnowledge } from "../src/knowledge.ts";
import { parseKnowledge, renderKnowledge } from "../src/knowledge/codec.ts";
import { renderKnowledgeProductBody, verifyExtractionBatch } from "../src/extraction-result.ts";
import { decideReviewedExperienceCandidate, registerExperienceReviewPackage } from "../src/experience-review.ts";
import { runReasoning, readLatestReasoning } from "../src/reasoning.ts";
import { LedgerStore } from "../src/store.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-reasoning-test-"));
}

function writeExperienceCandidate(home: string, overrides: Record<string, unknown> = {}): void {
  const directory = join(home, "experiences", "candidates");
  mkdirSync(directory, { recursive: true });
  const candidate = {
    schema: "ikb-knowledge-candidate.v1",
    id: "exp-cand-correction",
    scope: "work",
    status: "pending_review",
    contentHash: "a".repeat(64),
    title: "待复核知识修订：失败后重试规则",
    patternKey: "debug.retry",
    signalCodes: ["manual_correction"],
    analysisIds: ["analysis-1"],
    patternLabel: "失败后重试规则",
    claimVariants: ["先确认根因，再决定是否重试。"],
    changeTypes: ["revise"],
    targetKnowledgeIds: ["kb-old"],
    experienceIds: ["exp-1"],
    sourceIds: ["src-1"],
    sourceRecordRefs: ["src-1:r1"],
    evidenceEventIds: [],
    runIds: ["run-1"],
    validationRefs: [],
    independentRunCount: 1,
    independentSourceCount: 1,
    humanApprovalRequired: true,
    candidateKnowledge: { claim: "先确认根因，再决定是否重试。", type: "playbook", collection: "playbooks", requiredSections: [], evidenceRefs: ["src-1:r1"], applicability: "失败后", boundary: "有界", useContract: "重试前", validationPlan: "回归", confidence: "unknown", temporalState: "unknown" },
    nextAction: "curator_review_evidence_and_publish_or_reject",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
  writeFileSync(join(directory, `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
}

function reviewDraft(candidateId: string, knowledgeId: string): string {
  return `---
id: ${knowledgeId}
type: "playbook"
collection: playbooks
source_kind: "artifact"
scope: work
sensitivity: "work-internal"
status: draft
title: "失败后有界重试作业卡"
source_refs: ["src-1","experience-candidate:${candidateId}"]
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
admission_reason: "重复纠偏已形成可执行规则。"
applicability: "自动化步骤失败且重试有成本时。"
boundary: "已有幂等重试契约的瞬时错误另行处理。"
use_when: "Agent准备重试失败步骤时。"
use_inputs: ["失败证据","副作用边界"]
use_outputs: ["是否重试的决定"]
use_steps: ["保存失败证据","确认条件变化后只重试一次"]
use_checks: ["前后条件差异明确"]
use_stop_conditions: ["相同条件再次失败"]
confidence: medium
confidence_basis: ["两次独立纠偏和一次验证"]
temporal_state: current
verification: source_confirmed
counterevidence_refs: []
counterevidence_search: "检查允许平台自动重试的反例。"
do_not_use_for: ["跳过副作用检查"]
---
# 失败后有界重试作业卡

失败后先保存证据、确认根因和影响边界；只有条件已经改变时才做一次有界重试。
`;
}

function createLossArtifacts(
  home: string,
  store: LedgerStore,
  input: { mode: "revision" | "new"; knowledgeId: string; suffix?: string },
) {
  const suffix = input.suffix ?? "default";
  const sourceText = "失败后先保存证据；只有条件变化且副作用可控时，才允许一次有界重试。";
  const directory = join(home, "extraction", `${input.mode}-${suffix}`);
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, "重试来源.md");
  writeFileSync(sourcePath, `${sourceText}\n`, { mode: 0o600 });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const canonicalKey = `work:debug:playbook:bounded-retry:${suffix}`;
  const manifest = {
    schema: "ikb-knowledge-extraction-benchmark.v3",
    benchmark_id: `reasoning-${input.mode}-${suffix}`,
    cases: [{
      case_id: "retry-case",
      category: "playbook",
      title: "失败后的有界重试规则",
      input_fingerprint: "b".repeat(64),
      extraction_modes: ["playbook"],
      source_ids: ["src-1"],
      source_snapshots: [{ source_id: "src-1", path: sourcePath, content_sha256: hash(`${sourceText}\n`) }],
      consumer_tasks: ["失败恢复"],
      obligations: [{ obligation_id: "retry-rule", description: "失败后何时允许重试", importance: "core", required_product_types: ["playbook"] }],
      source_units: [{ unit_id: "unit-retry", source_id: "src-1", unit_kind: "paragraph", locator: "第1行", content: sourceText, content_sha256: hash(sourceText), importance: "core" }],
      reference_facts: [{ reference_fact_id: "rf-retry", statement: sourceText, importance: "core", source_unit_refs: ["unit-retry"], question_refs: ["q-retry"] }],
      questions: [{ question_id: "q-retry", text: "失败后何时允许重试？", importance: "core", required_product_types: ["playbook"] }],
      existing_knowledge: input.mode === "revision" ? [{ knowledge_id: input.knowledgeId, canonical_key: canonicalKey }] : [],
    }],
  };
  const result = {
    schema: "ikb-knowledge-compilation-result.v3",
    benchmark_id: `reasoning-${input.mode}-${suffix}`,
    case_id: "retry-case",
    input_fingerprint: "b".repeat(64),
    extraction_modes: ["playbook"],
    disposition: "admit",
    disposition_reason: "包含可执行且有停止条件的恢复规则",
    evidence_units: [{
      evidence_id: "ev-retry",
      source_id: "src-1",
      record_id: "src-1:r1",
      locator: "第1行",
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
      canonical_key: canonicalKey,
      operation: input.mode === "revision" ? "revise" : "new",
      ...(input.mode === "revision" ? { primary_knowledge_id: input.knowledgeId } : {}),
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
  const task = store.createTask({ title: "低损耗抽取", goal: "冻结并验证重试知识", acceptance: "V3保真报告通过", scope: "work" });
  const run = store.createRun(task.id, "ikb-analyst", ["ikb-conversation-analysis"]);
  const manifestPath = join(directory, "来源与问题清单.json");
  const resultPath = join(directory, "完整编译结果.json");
  const fidelityPath = join(directory, "信息损耗报告.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(resultPath, `${JSON.stringify({ results: [result] }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(fidelityPath, `${JSON.stringify(fidelity, null, 2)}\n`, { mode: 0o600 });
  return {
    result,
    canonicalKey,
    manifestArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-manifest", label: "来源与问题清单", path: manifestPath }),
    resultArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-result", label: "完整编译结果", path: resultPath }),
    fidelityArtifact: store.createArtifact({ runId: run.id, kind: "knowledge-extraction-fidelity", label: "信息损耗报告", path: fidelityPath }),
  };
}

function registerReviewFixture(home: string, store: LedgerStore, input: {
  mode: "revision" | "new";
  candidateId?: string;
  title?: string;
  createdAt?: string;
}) {
  const candidateId = input.candidateId ?? "exp-cand-correction";
  const suffix = candidateId.replace(/^exp-cand-/, "");
  let knowledgeId = `kb-new-reviewfixture-${suffix}`;
  let targetRecord: ReturnType<typeof captureKnowledge> | null = null;
  if (input.mode === "revision") {
    const target = captureKnowledge(home, {
      title: "失败后有界重试作业卡",
      type: "playbook",
      collection: "playbooks",
      scope: "work",
      sourceKind: "artifact",
      sourceRefs: ["src-1", `experience-candidate:${candidateId}`],
      qualityVersion: 4,
      productType: "playbook",
      compilationRef: `experience-candidate:${candidateId}`,
      factRefs: ["retry-f1"],
      questionsAnswered: ["失败后何时可以重试"],
      admissionReason: "重复纠偏已形成可执行规则。",
      applicability: "自动化步骤失败且重试有成本时。",
      boundary: "已有幂等重试契约的瞬时错误另行处理。",
      useWhen: "Agent准备重试失败步骤时。",
      useInputs: ["失败证据", "副作用边界"],
      useOutputs: ["是否重试的决定"],
      useSteps: ["保存失败证据", "确认条件变化后只重试一次"],
      useChecks: ["前后条件差异明确"],
      useStopConditions: ["相同条件再次失败"],
      confidence: "medium",
      confidenceBasis: ["两次独立纠偏和一次验证"],
      temporalState: "current",
      verification: "source_confirmed",
      body: "失败后先保存证据、确认根因和影响边界；只有条件已经改变时才做一次有界重试。",
    });
    knowledgeId = target.id;
    targetRecord = target;
  }
  writeExperienceCandidate(home, {
    id: candidateId,
    validationRefs: ["exp-validation-1"],
    changeTypes: [input.mode === "revision" ? "revise" : "new"],
    targetKnowledgeIds: input.mode === "revision" ? [knowledgeId] : [],
    title: input.title ?? (input.mode === "revision" ? "待复核知识修订：失败后重试规则" : "待复核经验模式：失败后重试规则"),
    createdAt: input.createdAt ?? "2026-08-01T00:00:00Z",
    updatedAt: input.createdAt ?? "2026-08-01T00:00:00Z",
  });
  const task = store.createTask({ title: "失败后重试候选评审", goal: "生成完整材料", acceptance: "可点击且哈希绑定", scope: "work" });
  const run = store.createRun(task.id, "ikb-curator", ["ikb-knowledge-curator"]);
  const directory = join(home, "reviews", `${input.mode}-${suffix}`);
  mkdirSync(directory, { recursive: true });
  const draftPath = join(directory, "完整知识稿.md");
  const loss = createLossArtifacts(home, store, { mode: input.mode, knowledgeId, suffix });
  const base = targetRecord ?? parseKnowledge(reviewDraft(candidateId, knowledgeId), draftPath);
  const draftText = renderKnowledge({
    ...base,
    path: draftPath,
    status: "draft",
    sourceRefs: ["src-1", `experience-candidate:${candidateId}`],
    qualityVersion: 5,
    productType: "playbook",
    canonicalKey: loss.canonicalKey,
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "retry-case",
    compilationProductId: "p-retry",
    extractionManifestRef: loss.manifestArtifact.id,
    compilationRef: loss.resultArtifact.id,
    informationLossRef: loss.fidelityArtifact.id,
    factRefs: ["retry-f1"],
    questionsAnswered: ["失败后何时允许重试？"],
    body: renderKnowledgeProductBody(loss.result, "retry-case", "p-retry"),
  });
  writeFileSync(draftPath, draftText, { mode: 0o600 });
  const draft = store.createArtifact({ runId: run.id, kind: "knowledge-candidate-draft", label: "完整知识稿", path: draftPath });
  const validationPath = join(directory, "验证报告.md");
  writeFileSync(validationPath, `# 验证报告\n\nCandidate：${candidateId}\n\nCandidate content hash：${"a".repeat(64)}\n\n完整稿 hash：${draft.contentHash}\n`, { mode: 0o600 });
  const validation = store.createArtifact({ runId: run.id, kind: "knowledge-candidate-validation", label: "验证报告", path: validationPath });
  const guidePath = join(directory, "请确认.md");
  writeFileSync(guidePath, `# 请确认\n\nCandidate：${candidateId}\n\n## 待确认（请只回复编号）\n\n1. 是否接受完整知识稿？\n\n确认后才进入写入流程；不授权外部动作，驳回时保留旧知识。\n`, { mode: 0o600 });
  const guide = store.createArtifact({ runId: run.id, kind: "knowledge-review-guide", label: "请确认", path: guidePath });
  const registered = registerExperienceReviewPackage(home, store, candidateId, {
    draftArtifactId: draft.id,
    validationArtifactIds: [validation.id],
    guideArtifactId: guide.id,
  });
  return { ...registered, draftPath, validationPath, guidePath };
}

test("reasoning compresses low-risk, task evidence and high-risk questions without changing Knowledge", () => {
  const home = freshHome();
  const record = captureKnowledge(home, {
    title: "Reasoning classification fixture",
    type: "playbook",
    scope: "work",
    body: [
      "## 结论",
      "把证据和边界写成可复用的行动卡。",
      "",
      "## 待确认",
      "1. 确认事故数字只作案例，不作为线上阈值",
      "2. 当前最新版 SOP 和配置入口在哪里？",
      "3. 哪些配置变更必须先申请 Approval？",
      "4. 是否允许为这条规则自动创建 Issue？",
    ].join("\n"),
  });
  const store = new LedgerStore({ home, actor: "reasoning-test" });
  const report = runReasoning(home, store, { scope: "work", now: new Date("2026-07-21T00:00:00.000Z") });

  assert.equal(report.inputs.knowledgeActive, 1);
  assert.equal(report.summary.questionsExtracted, 4);
  assert.equal(report.summary.autoResolved, 1);
  assert.equal(report.summary.deferred, 3);
  assert.equal(report.summary.askUser, 0);
  assert.equal(report.decisionBundles.length, 0);
  assert.ok(existsSync(join(home, "governance", "work", "reasoning", "latest.json")));
  assert.ok(readLatestReasoning(home, "work"));
  assert.equal(listKnowledge(home, "work")[0].status, "draft");
  assert.equal(store.listEvents().filter((event) => event.eventType === "reasoning.generated").length, 1);

  const rerun = runReasoning(home, store, { scope: "work", now: new Date("2026-07-21T00:01:00.000Z") });
  assert.equal(rerun.id, report.id);
  assert.equal(store.listEvents().filter((event) => event.eventType === "reasoning.generated").length, 1);
  store.close();
  assert.equal(record.status, "draft");
});

test("reasoning gives policy and external side effects precedence over generic boundaries", () => {
  const home = freshHome();
  captureKnowledge(home, {
    title: "Boundary fixture",
    type: "playbook",
    scope: "work",
    body: [
      "## 待确认",
      "1. 哪些原则必须落为代码门禁？",
      "2. 是否允许生成本地证据清单？",
      "3. 是否允许发送评论到外部系统？",
      "4. 只用于跨域路由，不表示线上架构",
      "5. 是否允许发布敏感字段到外部系统？",
    ].join("\n"),
  });
  const store = new LedgerStore({ home });
  const report = runReasoning(home, store, { scope: "work" });
  const byText = new Map([...report.userDecisionQueue, ...report.autoResolved, ...report.deferred].map((question) => [question.text, question]));
  assert.equal(byText.get("哪些原则必须落为代码门禁？")?.disposition, "defer_until_task");
  assert.equal(byText.get("是否允许生成本地证据清单？")?.disposition, "auto_resolved");
  assert.equal(byText.get("是否允许发送评论到外部系统？")?.disposition, "defer_until_task");
  assert.equal(byText.get("是否允许发布敏感字段到外部系统？")?.disposition, "defer_until_task");
  assert.equal(report.autoResolved.length, 2);
  assert.ok(report.autoResolved.some((question) => question.text.includes("本地证据清单")));
  assert.ok(report.autoResolved.some((question) => question.text.includes("跨域路由")));
  store.close();
});

test("reasoning keeps an unvalidated Knowledge Candidate inside the curator queue", () => {
  const home = freshHome();
  writeExperienceCandidate(home);
  const store = new LedgerStore({ home });
  const report = runReasoning(home, store, { scope: "work" });
  assert.equal(report.inputs.experienceCandidates, 1);
  assert.equal(report.inputs.knowledgeHolds, 1);
  assert.equal(report.summary.askUser, 0);
  assert.equal(report.summary.deferred, 1);
  assert.equal(report.deferred[0].candidateId, "exp-cand-correction");
  assert.match(report.deferred[0].rationale, /本地内容验证/);
  store.close();
});

test("reasoning keeps a validated Candidate deferred until a complete review package is registered", () => {
  const home = freshHome();
  writeExperienceCandidate(home, { validationRefs: ["exp-validation-1"] });
  const store = new LedgerStore({ home });
  const report = runReasoning(home, store, { scope: "work" });
  assert.equal(report.summary.askUser, 0);
  assert.equal(report.summary.deferred, 1);
  assert.match(report.deferred[0].rationale, /完整评审包/);
  store.close();
});

test("reasoning exposes one content-first confirmation entrance only after a hash-bound review package exists", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  const review = registerReviewFixture(home, store, { mode: "revision" });
  const report = runReasoning(home, store, { scope: "work" });
  assert.equal(report.summary.askUser, 1);
  assert.equal(report.userDecisionQueue[0].candidateId, "exp-cand-correction");
  assert.match(report.userDecisionQueue[0].text, /是否接受这次知识修订方向/);
  assert.match(report.userDecisionQueue[0].rationale, /暂停它进入 Agent 上下文/);
  assert.match(report.decisionBundles[0].consequence, /旧知识继续暂停召回/);
  const primaryHumanReviewPath = report.userDecisionQueue[0].reviewPackage!.primaryHumanReviewPath;
  assert.deepEqual(report.userDecisionQueue[0].reviewPackage, {
    id: review.review.package.id,
    primaryHumanReviewPath,
    humanReviewItemKey: "A",
    guidePath: review.guidePath,
    draftPath: review.draftPath,
    validationPaths: [review.validationPath],
  });
  const markdown = readFileSync(report.paths.markdown, "utf8");
  assert.match(markdown, new RegExp(`\\[统一确认入口\\]\\(<${primaryHumanReviewPath}>\\)`));
  assert.doesNotMatch(markdown, /完整知识稿|验证报告 1|确认说明/);
  store.close();
});

test("reasoning aggregates three ready Candidates into one A/B/C human confirmation entrance", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  registerReviewFixture(home, store, {
    mode: "new",
    candidateId: "exp-cand-ba7c0000000a",
    title: "待复核原则：证据入库与知识准入分离",
    createdAt: "2026-08-01T00:00:00Z",
  });
  registerReviewFixture(home, store, {
    mode: "new",
    candidateId: "exp-cand-ba7c0000000b",
    title: "待复核原则：规范性抽象必须人工确认",
    createdAt: "2026-08-02T00:00:00Z",
  });
  registerReviewFixture(home, store, {
    mode: "new",
    candidateId: "exp-cand-ba7c0000000c",
    title: "待复核原则：IKB 是语义主库，AGENTS 是最小运行时投影",
    createdAt: "2026-08-03T00:00:00Z",
  });

  const report = runReasoning(home, store, { scope: "work" });
  assert.equal(report.summary.askUser, 3);
  const paths = new Set(report.userDecisionQueue.map((question) => question.reviewPackage?.primaryHumanReviewPath));
  assert.equal(paths.size, 1);
  assert.deepEqual(report.userDecisionQueue.map((question) => question.reviewPackage?.humanReviewItemKey), ["A", "B", "C"]);
  const confirmationPath = report.userDecisionQueue[0].reviewPackage!.primaryHumanReviewPath;
  const confirmation = readFileSync(confirmationPath, "utf8");
  assert.match(confirmation, /## A\. 待复核原则：证据入库与知识准入分离/);
  assert.match(confirmation, /## B\. 待复核原则：规范性抽象必须人工确认/);
  assert.match(confirmation, /## C\. 待复核原则：IKB 是语义主库，AGENTS 是最小运行时投影/);
  assert.match(confirmation, /确认：A、B、C/);
  assert.doesNotMatch(confirmation, /^- - /m);
  const markdown = readFileSync(report.paths.markdown, "utf8");
  assert.equal(markdown.split(confirmationPath).length - 1, 1);

  decideReviewedExperienceCandidate(home, store, "exp-cand-ba7c0000000a", { decision: "reject", reason: "covered by current code contract" });
  decideReviewedExperienceCandidate(home, store, "exp-cand-ba7c0000000c", { decision: "reject", reason: "mixed code contract and human policy" });
  const narrowed = runReasoning(home, store, { scope: "work", now: new Date("2026-08-04T00:00:00Z") });
  assert.equal(narrowed.summary.askUser, 1);
  assert.equal(narrowed.userDecisionQueue[0].candidateId, "exp-cand-ba7c0000000b");
  assert.equal(narrowed.userDecisionQueue[0].reviewPackage?.humanReviewItemKey, "B");
  store.close();
});

test("reasoning does not claim that a new Knowledge Candidate pauses old Knowledge", () => {
  const home = freshHome();
  const store = new LedgerStore({ home });
  registerReviewFixture(home, store, { mode: "new" });
  const report = runReasoning(home, store, { scope: "work" });
  assert.equal(report.summary.askUser, 1);
  assert.match(report.decisionBundles[0].consequence, /现有 Knowledge 不受影响/);
  assert.doesNotMatch(report.decisionBundles[0].consequence, /旧知识继续暂停召回/);
  store.close();
});

test("reasoning never asks again from an already-confirmed section", () => {
  const home = freshHome();
  captureKnowledge(home, {
    title: "Confirmed fixture",
    scope: "personal",
    body: [
      "## 用户已确认（2026-08-07）",
      "1. 复杂 Run 使用结构化门禁。",
      "2. 外部动作必须重新 Approval。",
      "",
      "## 不需要逐条确认的内容",
      "1. 本地只读诊断。",
    ].join("\n"),
  });
  const store = new LedgerStore({ home });
  const report = runReasoning(home, store, { scope: "personal" });
  assert.equal(report.summary.questionsExtracted, 0);
  assert.equal(report.summary.askUser, 0);
  store.close();
});
