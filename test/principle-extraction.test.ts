import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderKnowledgeProductBody, validateExtractionBatch, verifyExtractionBatch } from "../src/extraction-result.ts";
import { requestPrincipleAdmission } from "../src/experience.ts";
import { decideReviewedExperienceCandidate, registerExperienceReviewPackage } from "../src/experience-review.ts";
import { renderKnowledge } from "../src/knowledge/codec.ts";
import { applyKnowledgeCandidate, findKnowledge, knowledgeRetrievalEligibilityAtHome, searchKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";
import { writeReceipt } from "../src/receipt.ts";
import type { KnowledgeRecord } from "../src/types.ts";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principleFixture() {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-extraction-"));
  const text = "规范性抽象必须有完整审查包并经人工确认后才能默认生效。";
  const sourcePath = join(home, "source.md");
  writeFileSync(sourcePath, `${text}\n`, "utf8");
  const manifest = {
    schema: "ikb-knowledge-extraction-benchmark.v3",
    benchmark_id: "principle-qv5",
    cases: [{
      case_id: "case-principle",
      category: "principle",
      title: "规范性抽象必须人工确认",
      input_fingerprint: "a".repeat(64),
      extraction_modes: ["principle"],
      source_ids: ["src-principle"],
      source_snapshots: [{ source_id: "src-principle", path: sourcePath, content_sha256: hash(`${text}\n`) }],
      consumer_tasks: ["govern agent behavior"],
      obligations: [{ obligation_id: "o", description: "保留人工确认边界", importance: "core", required_product_types: ["principle_card"] }],
      source_units: [{ unit_id: "u", source_id: "src-principle", unit_kind: "paragraph", locator: "1", content: text, content_sha256: hash(text), importance: "core" }],
      reference_facts: [{ reference_fact_id: "rf", statement: text, importance: "core", source_unit_refs: ["u"], question_refs: ["q"] }],
      questions: [{ question_id: "q", text: "规范性抽象何时生效？", importance: "core", required_product_types: ["principle_card"] }],
      existing_knowledge: [],
    }],
  };
  const result = {
    schema: "ikb-knowledge-compilation-result.v3",
    benchmark_id: "principle-qv5",
    case_id: "case-principle",
    input_fingerprint: "a".repeat(64),
    extraction_modes: ["principle"],
    disposition: "admit",
    disposition_reason: "该规则会约束后续 Agent 行为。",
    evidence_units: [{ evidence_id: "e", source_id: "src-principle", record_id: "src-principle:1", locator: "1", excerpt: text, excerpt_sha256: hash(text), attribution_role: "author", actor: "owner", occurred_at: "2026-08-24T00:00:00Z", source_unit_refs: ["u"] }],
    facts: [{ fact_id: "f", fact_kind: "governance_rule", statement: text, evidence_ids: ["e"], reference_fact_refs: ["rf"], derivation: "direct", temporal_state: "current", importance: "core" }],
    claims: [{ claim_id: "c", text, claim_kind: "decision", fact_refs: ["f"], counterevidence_fact_refs: [], reasoning: "直接保留已提出的治理规则，等待人工确认。", temporal_state: "current", support_status: "supported" }],
    coverage: [{ obligation_id: "o", disposition: "covered", fact_refs: ["f"], reason: "原则正文保留人工确认边界。" }],
    source_unit_dispositions: [{ unit_id: "u", disposition: "extracted", evidence_ids: ["e"], fact_refs: ["f"], reason: "核心规则完整保留。" }],
    reference_fact_dispositions: [{ reference_fact_id: "rf", disposition: "preserved", fact_refs: ["f"], reason: "逐字保留核心语义。" }],
    products: [{
      product_id: "p",
      product_type: "principle_card",
      title: "规范性抽象必须人工确认",
      canonical_key: "work:principle:normative-abstraction-requires-human-confirmation",
      operation: "new",
      unique_value: "防止 Agent 自我批准会改变后续行为的抽象规则。",
      fact_refs: ["f"],
      claim_refs: ["c"],
      question_refs: ["q"],
      consumer_tasks: ["govern agent behavior"],
      questions_answered: ["规范性抽象何时生效？"],
      boundaries: ["纯客观事实按普通 Knowledge 准入。"],
      verification_plan: ["人工逐条确认审查包。"],
      principle: {
        statement: text,
        triggers: ["候选内容会改变 Agent 后续行为。"],
        scope: ["work scope 的 Agent 治理原则。"],
        exceptions: ["纯客观事实不归类为 Principle。"],
        rationale: ["规范性结论不能由生成它的 Agent 自我批准。"],
        retirement_signals: ["规则已由更可靠的确定性控制替代。"],
      },
    }],
    question_results: [{ question_id: "q", disposition: "answered", fact_refs: ["f"], product_refs: ["p"], reason: "原则给出明确生效条件。" }],
    unknowns: [],
    next_triggers: ["来源、适用边界或运行时控制发生变化。"],
  };
  return { manifest, result };
}

test("QV5 accepts and renders a native principle_card", () => {
  const { manifest, result } = principleFixture();
  const validation = validateExtractionBatch(manifest, [result]);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const fidelity = verifyExtractionBatch(manifest, [result]);
  assert.equal(fidelity.valid, true, JSON.stringify(fidelity.issues));
  assert.equal(fidelity.publishableCount, 1);
  const body = renderKnowledgeProductBody(result, "case-principle", "p");
  assert.match(body, /规范性抽象必须有完整审查包/);
  assert.match(body, /retirement_signals/);
});

test("principle_card fails closed when retirement signals are absent", () => {
  const { manifest, result } = principleFixture();
  const product = result.products[0];
  product.principle.retirement_signals = [];
  const validation = validateExtractionBatch(manifest, [result]);
  assert.equal(validation.valid, false);
  assert.equal(validation.issues.some((issue) => issue.code === "principle_retirement_signals_missing"), true);
});

test("a publishable QV5 principle product creates an idempotent review-only Candidate", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-admission-"));
  const sourceInput = join(home, "source-input.md");
  const sourceText = "规范性抽象必须有完整审查包并经人工确认后才能默认生效。";
  writeFileSync(sourceInput, `${sourceText}\n`, "utf8");
  const imported = importSource(home, sourceInput, { kind: "document", scope: "work", title: "原则来源" }).source;
  const { manifest, result } = principleFixture();
  manifest.cases[0].source_ids = [imported.id];
  manifest.cases[0].source_snapshots = [{ source_id: imported.id, path: imported.rawPath, content_sha256: hash(`${sourceText}\n`) }];
  manifest.cases[0].source_units[0].source_id = imported.id;
  result.evidence_units[0].source_id = imported.id;
  result.evidence_units[0].record_id = `${imported.id}:1`;

  const store = new LedgerStore({ home, actor: "principle-test" });
  const task = store.createTask({ title: "Principle admission", goal: "Create review package", acceptance: "Candidate remains review-only", scope: "work" });
  const run = store.createRun(task.id, "ikb-operator", []);
  const directory = join(home, "principle-artifacts");
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  const compilationPath = join(directory, "compilation.json");
  const fidelityPath = join(directory, "fidelity.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(compilationPath, `${JSON.stringify({ results: [result] }, null, 2)}\n`);
  writeFileSync(fidelityPath, `${JSON.stringify(verifyExtractionBatch(manifest, [result]), null, 2)}\n`);
  const manifestArtifact = store.createArtifact({ runId: run.id, kind: "knowledge-extraction-manifest", label: "manifest", path: manifestPath });
  const compilationArtifact = store.createArtifact({ runId: run.id, kind: "knowledge-extraction-result", label: "compilation", path: compilationPath });
  const fidelityArtifact = store.createArtifact({ runId: run.id, kind: "knowledge-extraction-fidelity", label: "fidelity", path: fidelityPath });
  const input = {
    runId: run.id,
    manifestArtifactId: manifestArtifact.id,
    compilationArtifactId: compilationArtifact.id,
    fidelityArtifactId: fidelityArtifact.id,
    caseId: "case-principle",
    productId: "p",
  };

  const created = requestPrincipleAdmission(home, store, input);
  const repeated = requestPrincipleAdmission(home, store, input);
  assert.equal(created.outcome, "created");
  assert.equal(repeated.outcome, "unchanged");
  assert.equal(created.candidate.status, "pending_review");
  assert.equal(created.candidate.candidateKnowledge.type, "principle");
  assert.equal(created.candidate.candidateKnowledge.collection, "principles");
  assert.deepEqual(created.candidate.sourceIds, [imported.id]);
  assert.equal(store.listEvents().filter((event) => event.eventType === "experience.candidate_created").length, 1);
  store.close();
});

test("only the exact accepted and applied Principle draft can become active", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-confirmation-chain-"));
  const sourceInput = join(home, "source-input.md");
  const sourceText = "规范性抽象必须有完整审查包并经人工确认后才能默认生效。";
  writeFileSync(sourceInput, `${sourceText}\n`, "utf8");
  const imported = importSource(home, sourceInput, { kind: "document", scope: "work", title: "原则来源" }).source;
  const { manifest, result } = principleFixture();
  manifest.cases[0].source_ids = [imported.id];
  manifest.cases[0].source_snapshots = [{ source_id: imported.id, path: imported.rawPath, content_sha256: hash(`${sourceText}\n`) }];
  manifest.cases[0].source_units[0].source_id = imported.id;
  result.evidence_units[0].source_id = imported.id;
  result.evidence_units[0].record_id = `${imported.id}:1`;

  const store = new LedgerStore({ home, actor: "principle-test" });
  const analystTask = store.createTask({ title: "Principle analysis", goal: "Prepare QV5 evidence", acceptance: "Produce a review-only candidate", scope: "work" });
  const analystRun = store.createRun(analystTask.id, "ikb-analyst", ["ikb-conversation-analysis"]);
  const artifacts = join(home, "principle-artifacts");
  mkdirSync(artifacts, { recursive: true });
  const manifestPath = join(artifacts, "manifest.json");
  const compilationPath = join(artifacts, "compilation.json");
  const fidelityPath = join(artifacts, "fidelity.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(compilationPath, `${JSON.stringify({ results: [result] }, null, 2)}\n`);
  writeFileSync(fidelityPath, `${JSON.stringify(verifyExtractionBatch(manifest, [result]), null, 2)}\n`);
  const manifestArtifact = store.createArtifact({ runId: analystRun.id, kind: "knowledge-extraction-manifest", label: "manifest", path: manifestPath });
  const compilationArtifact = store.createArtifact({ runId: analystRun.id, kind: "knowledge-extraction-result", label: "compilation", path: compilationPath });
  const fidelityArtifact = store.createArtifact({ runId: analystRun.id, kind: "knowledge-extraction-fidelity", label: "fidelity", path: fidelityPath });
  const candidate = requestPrincipleAdmission(home, store, {
    runId: analystRun.id,
    manifestArtifactId: manifestArtifact.id,
    compilationArtifactId: compilationArtifact.id,
    fidelityArtifactId: fidelityArtifact.id,
    caseId: "case-principle",
    productId: "p",
  }).candidate;

  const draftPath = join(artifacts, "reviewed-principle.md");
  const draft: KnowledgeRecord = {
    id: "kb-principle-reviewed-chain",
    title: "规范性抽象必须人工确认",
    type: "principle",
    collection: "principles",
    sourceKind: "document",
    scope: "work",
    sensitivity: "work-internal",
    status: "draft",
    revision: 1,
    revisionHistory: [],
    sourceRefs: [imported.id, `experience-candidate:${candidate.id}`],
    validFrom: "2026-08-24",
    reviewAfter: "2026-11-24",
    tags: ["principle", "human-confirmation"],
    aliases: ["kb-principle-reviewed-chain"],
    related: [],
    derivedFrom: [],
    contradicts: [],
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "work:principle:normative-abstraction-requires-human-confirmation",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-principle",
    compilationProductId: "p",
    extractionManifestRef: manifestArtifact.id,
    compilationRef: compilationArtifact.id,
    informationLossRef: fidelityArtifact.id,
    factRefs: ["f"],
    questionsAnswered: ["规范性抽象何时生效？"],
    admissionReason: "该原则约束 Agent 后续行为，必须保留人工确认链。",
    applicability: "候选内容会改变 Agent 后续行为时。",
    boundary: "纯客观事实按普通 Knowledge 准入。",
    useWhen: "准备激活规范性抽象时。",
    useInputs: ["完整审查包", "人工决定"],
    useOutputs: ["已确认或拒绝的 Principle"],
    useSteps: ["核对证据与边界", "取得人工确认", "按确认字节激活"],
    useChecks: ["候选、审查快照和 Knowledge ID 可追溯"],
    useStopConditions: ["缺少人工确认或审查字节发生变化"],
    confidence: "high",
    confidenceBasis: ["人工审查的 QV5 完整草稿"],
    temporalState: "current",
    verification: "user_confirmed",
    path: draftPath,
    body: renderKnowledgeProductBody(result, "case-principle", "p"),
  };
  const draftText = renderKnowledge(draft);
  writeFileSync(draftPath, draftText);

  const curatorTask = store.createTask({ title: "Principle review", goal: "Bind the complete Principle draft", acceptance: "User decision applies exact bytes", scope: "work" });
  const curatorRun = store.createRun(curatorTask.id, "ikb-curator", ["ikb-knowledge-curator"]);
  const unclassifiedValidationPath = join(artifacts, "review-validation-unclassified.md");
  const deterministicValidationPath = join(artifacts, "review-validation-deterministic.md");
  const validationPath = join(artifacts, "review-validation.md");
  const guidePath = join(artifacts, "review-guide.md");
  const validationBinding = `Candidate ${candidate.id}\nCandidate hash ${candidate.contentHash}\nDraft hash ${hash(draftText)}\n`;
  writeFileSync(unclassifiedValidationPath, validationBinding);
  writeFileSync(deterministicValidationPath, `${validationBinding}Principle responsibility owner: deterministic_contract\nPrinciple responsibility rationale: 当前代码已经完整承担该约束。\nPrinciple responsibility evidence: src/commands/agent-facade.ts; test/agent-facade.test.ts\n`);
  writeFileSync(validationPath, `${validationBinding}Principle responsibility owner: human_policy\nPrinciple responsibility rationale: 代码只能执行既定授权边界，不能替用户决定是否采用该边界。\nPrinciple responsibility evidence: src/knowledge/principle-admission.ts; test/principle-extraction.test.ts\n`);
  writeFileSync(guidePath, `# 待确认\n\nCandidate ${candidate.id}\n\n1. 确认原则正文、适用边界和例外。\n2. 确认后只允许激活本次审查的完整字节；驳回则不生效。\n`);
  const draftArtifact = store.createArtifact({ runId: curatorRun.id, kind: "knowledge-candidate-draft", label: "draft", path: draftPath });
  const unclassifiedValidationArtifact = store.createArtifact({ runId: curatorRun.id, kind: "knowledge-candidate-validation", label: "unclassified validation", path: unclassifiedValidationPath });
  const deterministicValidationArtifact = store.createArtifact({ runId: curatorRun.id, kind: "knowledge-candidate-validation", label: "deterministic validation", path: deterministicValidationPath });
  const validationArtifact = store.createArtifact({ runId: curatorRun.id, kind: "knowledge-candidate-validation", label: "validation", path: validationPath });
  const guideArtifact = store.createArtifact({ runId: curatorRun.id, kind: "knowledge-review-guide", label: "guide", path: guidePath });
  assert.throws(() => registerExperienceReviewPackage(home, store, candidate.id, {
    draftArtifactId: draftArtifact.id,
    validationArtifactIds: [unclassifiedValidationArtifact.id],
    guideArtifactId: guideArtifact.id,
  }), /responsibility assessment/);
  assert.throws(() => registerExperienceReviewPackage(home, store, candidate.id, {
    draftArtifactId: draftArtifact.id,
    validationArtifactIds: [deterministicValidationArtifact.id],
    guideArtifactId: guideArtifact.id,
  }), /deterministic_contract/);
  registerExperienceReviewPackage(home, store, candidate.id, {
    draftArtifactId: draftArtifact.id,
    validationArtifactIds: [validationArtifact.id],
    guideArtifactId: guideArtifact.id,
  });
  decideReviewedExperienceCandidate(home, store, candidate.id, {
    decision: "accept",
    reason: "User confirmed the complete Principle package",
    reviewedArtifactPath: draftPath,
  });
  const applied = applyKnowledgeCandidate(home, store, candidate.id, { replacementPath: draftPath });
  assert.deepEqual(applied.knowledgeIds, [draft.id]);
  const installed = findKnowledge(home, draft.id)!;
  assert.equal(installed.status, "draft");
  const verified = updateKnowledgeStatus(home, installed.id, "verified");
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(home, verified), { eligible: true, reason: null });
  assert.equal(searchKnowledge(home, "规范性抽象 人工确认", { scope: "work" }).some((item) => item.id === verified.id), true);

  const verifiedText = readFileSync(verified.path, "utf8");
  assert.match(verifiedText, /完整审查包/);
  const proposalPath = join(home, "inbox", "work", "principle-diffs", `${verified.id}-proposed.md`);
  mkdirSync(join(home, "inbox", "work", "principle-diffs"), { recursive: true });
  const proposalText = verifiedText.replaceAll("完整审查包", "严格审查包");
  writeFileSync(proposalPath, proposalText);
  const revisedText = proposalText.replace("revision: 1", "revision: 2");
  assert.notEqual(revisedText, proposalText);
  writeFileSync(verified.path, revisedText);
  const revised = findKnowledge(home, verified.id)!;
  writeReceipt(home, store, {
    kind: "semantic_maintenance",
    scope: "work",
    command: "semantic-maintenance",
    startedAt: "2026-08-27T00:00:00.000Z",
    outcome: "succeeded",
    operations: [{
      action: "update",
      subjectRef: `knowledge://${revised.id}`,
      inputRefs: [proposalPath],
      outputRefs: [`knowledge://${revised.id}`],
      sourceRefs: revised.sourceRefs,
      beforeHash: hash(verifiedText),
      afterHash: hash(revisedText),
      applicability: revised.applicability,
      boundary: revised.boundary,
      validation: { status: "passed", checks: ["human confirmation"], issues: [] },
      outcome: "confirmed",
      confirmation: { actor: "reviewer", confirmedAt: "2026-08-27T00:00:00.000Z", exactTextHash: hash(proposalText) },
    }],
  });
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(home, revised), { eligible: true, reason: null });

  writeFileSync(verified.path, revisedText.replace("严格审查包", "简化审查包"));
  const tampered = findKnowledge(home, verified.id)!;
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(home, tampered), { eligible: false, reason: "principle_confirmation_chain_invalid" });
  assert.equal(searchKnowledge(home, "规范性抽象 人工确认", { scope: "work" }).some((item) => item.id === verified.id), false);
  store.close();
});
