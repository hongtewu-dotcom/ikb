import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KNOWLEDGE_CANDIDATE_TYPES, KNOWLEDGE_DIRECTORIES, archiveRetiredKnowledge, captureKnowledge, buildContextPack, completeKnowledgeMigration, findKnowledge, ingestKnowledge, initializeKnowledgeLayout, inspectKnowledgeLayout, isPersonalAdmissionReady, knowledgeRetrievalEligibility, knowledgeRetrievalEligibilityAtHome, listKnowledge, migrateLegacyKnowledge, rebuildKnowledgeViews, relateKnowledge, searchKnowledge, reviewKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";
import type { KnowledgeInput } from "../src/knowledge.ts";
import { writeReceipt } from "../src/receipt.ts";
import { LedgerStore } from "../src/store.ts";
import { initializeHome } from "../src/commands/system.ts";
import { resolveLedgerPath } from "../src/layout.ts";

function principleInput(overrides: Partial<KnowledgeInput> = {}): KnowledgeInput {
  return {
    title: "Evidence before escalation",
    type: "principle",
    scope: "work",
    sourceKind: "manual",
    sourceRefs: ["artifact:principle-review-1"],
    status: "draft",
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "work:principle:evidence-before-escalation",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-principle-1",
    compilationProductId: "product-principle-1",
    extractionManifestRef: "artifact:manifest-principle-1",
    compilationRef: "artifact:compilation-principle-1",
    informationLossRef: "artifact:loss-principle-1",
    factRefs: ["fact:principle-1"],
    questionsAnswered: ["When should escalation require more evidence?"],
    admissionReason: "This rule constrains recurring execution decisions.",
    applicability: "When deciding whether to escalate a blocked task.",
    boundary: "It does not replace incident-specific evidence.",
    confidence: "high",
    confidenceBasis: ["Reviewed source and compilation artifacts."],
    temporalState: "current",
    verification: "unverified",
    body: "Require current evidence before escalating a blocked task.",
    ...overrides,
  };
}

test("knowledge capture writes frontmatter and search returns source-scoped results", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-kb-test-"));
  const record = captureKnowledge(home, {
    title: "Review evidence",
    type: "playbook",
    scope: "personal",
    body: "A review conclusion must include a source and a line reference.",
    tags: ["review", "evidence"],
  });
  const text = readFileSync(record.path, "utf8");
  assert.match(text, /status: draft/);
  assert.match(text, /source_kind: "manual"/);
  assert.equal(searchKnowledge(home, "line reference", { scope: "personal" })[0].id, record.id);
  assert.equal(searchKnowledge(home, "line reference", { scope: "work" }).length, 0);
  assert.equal(reviewKnowledge(home, "personal").length, 1);
});

test("principle is a formal candidate type and defaults to the principles review collection", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-schema-test-"));
  assert.equal(KNOWLEDGE_CANDIDATE_TYPES.includes("principle"), true);
  assert.equal(KNOWLEDGE_DIRECTORIES.includes("principles"), true);
  assert.throws(
    () => captureKnowledge(home, principleInput({ qualityVersion: 1, canonicalKey: "work:principle:pre-compilation" })),
    /principle_quality_version_insufficient/,
  );
  assert.throws(
    () => captureKnowledge(home, principleInput({ productType: "decision_card" })),
    /principle_product_type_mismatch/,
  );
  assert.throws(() => captureKnowledge(home, principleInput({ admissionReason: "" })), /admission_reason_missing/);

  const draft = captureKnowledge(home, principleInput());
  assert.equal(draft.collection, "principles");
  assert.equal(findKnowledge(home, draft.id)?.id, draft.id);
  assert.equal(listKnowledge(home, "work").some((record) => record.id === draft.id), true);
  assert.equal(reviewKnowledge(home, "work").some((record) => record.id === draft.id), true);
  assert.equal(inspectKnowledgeLayout(home, "work").qualityIssues.length, 0);
  assert.match(draft.path, /\/principles\//);
});

test("draft principle remains auditable but is excluded from default search and context", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-draft-eligibility-test-"));
  const draft = captureKnowledge(home, principleInput());

  assert.deepEqual(knowledgeRetrievalEligibility(draft), { eligible: false, reason: "principle_status_not_verified" });
  assert.equal(listKnowledge(home, "work").some((record) => record.id === draft.id), true);
  assert.equal(searchKnowledge(home, "evidence escalation", { scope: "work" }).some((result) => result.id === draft.id), false);
  const context = buildContextPack(home, {
    taskId: "task-principle-draft",
    title: "Evidence escalation",
    goal: "Decide whether to escalate a blocked task.",
    acceptance: "Use only confirmed principles.",
    scope: "work",
  });
  assert.equal(context.results.some((result) => result.id === draft.id), false);
});

test("source-confirmed principle cannot pass ordinary verify or enter default retrieval even if status is edited", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-source-confirmed-test-"));
  const draft = captureKnowledge(home, principleInput({ verification: "source_confirmed" }));

  assert.throws(() => updateKnowledgeStatus(home, draft.id, "verified"), /principle_verification_insufficient/);
  const cli = spawnSync(join(process.cwd(), "bin", "ikb"), ["knowledge", "verify", draft.id, "--home", home, "--json"], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /principle_verification_insufficient/);

  writeFileSync(draft.path, readFileSync(draft.path, "utf8").replace("status: draft", "status: verified"));
  const edited = findKnowledge(home, draft.id)!;
  assert.equal(edited.status, "verified");
  assert.deepEqual(knowledgeRetrievalEligibility(edited), { eligible: false, reason: "principle_verification_not_user_confirmed" });
  assert.equal(searchKnowledge(home, "evidence escalation", { scope: "work" }).some((result) => result.id === draft.id), false);

  writeFileSync(draft.path, readFileSync(draft.path, "utf8").replace("verification: source_confirmed", "verification: task_validated"));
  const taskValidated = findKnowledge(home, draft.id)!;
  assert.deepEqual(knowledgeRetrievalEligibility(taskValidated), { eligible: false, reason: "principle_verification_not_user_confirmed" });
});

test("user-confirmed frontmatter cannot bypass the reviewed Principle lifecycle", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-user-confirmed-test-"));
  assert.throws(() => captureKnowledge(home, principleInput({
    status: "verified",
    verification: "user_confirmed",
    sourceRefs: ["user-confirmation:principle-review-1", "artifact:principle-review-1"],
  })), /principle_confirmation_chain_invalid/);

  const draft = captureKnowledge(home, principleInput({ verification: "user_confirmed" }));
  writeFileSync(draft.path, readFileSync(draft.path, "utf8").replace("status: draft", "status: verified"));
  const edited = findKnowledge(home, draft.id)!;
  assert.deepEqual(knowledgeRetrievalEligibility(edited), { eligible: true, reason: null });
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(home, edited), { eligible: false, reason: "principle_confirmation_chain_invalid" });
  assert.equal(searchKnowledge(home, "evidence escalation", { scope: "work" }).some((result) => result.id === edited.id), false);
  assert.equal(inspectKnowledgeLayout(home, "work").qualityIssues.some((issue) => issue.code === "principle_confirmation_chain_invalid"), true);
  const lint = spawnSync(join(process.cwd(), "bin", "ikb"), ["knowledge", "lint", edited.id, "--home", home, "--json"], { encoding: "utf8" });
  assert.equal(lint.status, 2, lint.stderr);
  assert.equal(JSON.parse(lint.stdout).results[0].issues.some((issue: { code: string }) => issue.code === "principle_confirmation_chain_invalid"), true);
});

test("Receipt confirmation chain admits a confirmed single-page Principle and fails closed when evidence is altered", () => {
  const createConfirmedReceipt = () => {
    const home = mkdtempSync(join(tmpdir(), "ikb-principle-receipt-chain-"));
    initializeHome(home);
    const draft = captureKnowledge(home, principleInput({ verification: "user_confirmed" }));
    writeFileSync(draft.path, readFileSync(draft.path, "utf8")
      .replace("status: draft", "status: verified")
      .replace("verification: user_confirmed", "verification: user_confirmed"));
    const current = findKnowledge(home, draft.id)!;
    const proposalPath = join(home, "inbox", "work", "confirmations", `${current.id}-proposal.md`);
    mkdirSync(join(home, "inbox", "work", "confirmations"), { recursive: true });
    writeFileSync(proposalPath, readFileSync(current.path, "utf8"));
    const exactTextHash = sha256(readFileSync(proposalPath, "utf8"));
    const store = new LedgerStore({ home });
    const receipt = writeReceipt(home, store, {
      kind: "semantic_maintenance",
      scope: "work",
      command: "semantic-maintenance",
      startedAt: "2026-08-27T00:00:00.000Z",
      outcome: "succeeded",
      operations: [{
        action: "confirm",
        subjectRef: `knowledge://${current.id}`,
        inputRefs: [proposalPath, join(home, "inbox", "work", "confirmations", "brief.md")],
        outputRefs: [`knowledge://${current.id}`],
        sourceRefs: current.sourceRefs,
        beforeHash: null,
        afterHash: sha256(readFileSync(current.path, "utf8")),
        applicability: current.applicability,
        boundary: current.boundary,
        validation: { status: "passed", checks: ["human confirmation"], issues: [] },
        outcome: "confirmed",
        confirmation: { actor: "reviewer", confirmedAt: "2026-08-27T00:00:00.000Z", exactTextHash },
      }],
    });
    store.close();
    return { home, current: findKnowledge(home, current.id)!, proposalPath, receipt };
  };

  const valid = createConfirmedReceipt();
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(valid.home, valid.current), { eligible: true, reason: null });

  const proposalTampered = createConfirmedReceipt();
  writeFileSync(proposalTampered.proposalPath, "tampered proposal\n");
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(proposalTampered.home, proposalTampered.current), { eligible: false, reason: "principle_confirmation_chain_invalid" });

  const receiptTampered = createConfirmedReceipt();
  writeFileSync(receiptTampered.receipt.path, `${readFileSync(receiptTampered.receipt.path, "utf8").replace("confirmed", "tampered")}\n`);
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(receiptTampered.home, receiptTampered.current), { eligible: false, reason: "principle_confirmation_chain_invalid" });

  const missingLedger = createConfirmedReceipt();
  writeFileSync(resolveLedgerPath(missingLedger.home), "");
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(missingLedger.home, missingLedger.current), { eligible: false, reason: "principle_confirmation_chain_invalid" });

  const wrongAfterHash = createConfirmedReceipt();
  const receiptJson = JSON.parse(readFileSync(wrongAfterHash.receipt.path, "utf8"));
  receiptJson.operations[0].afterHash = "0".repeat(64);
  const content = `${JSON.stringify(receiptJson, null, 2)}\n`;
  writeFileSync(wrongAfterHash.receipt.path, content);
  // Keep the ledger binding current to prove the after-hash gate itself rejects.
  const ledgerPath = resolveLedgerPath(wrongAfterHash.home);
  const ledger = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  ledger[0].payload.contentHash = sha256(content);
  writeFileSync(ledgerPath, `${ledger.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.deepEqual(knowledgeRetrievalEligibilityAtHome(wrongAfterHash.home, wrongAfterHash.current), { eligible: false, reason: "principle_confirmation_chain_invalid" });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("ordinary verified source-confirmed knowledge keeps its existing retrieval behavior", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-ordinary-regression-test-"));
  const fact = captureKnowledge(home, {
    title: "Ordinary retry evidence",
    type: "fact",
    scope: "work",
    status: "verified",
    verification: "source_confirmed",
    sourceRefs: ["artifact:ordinary-fact-1"],
    body: "Ordinary retry evidence remains searchable after source confirmation.",
  });

  assert.deepEqual(knowledgeRetrievalEligibility(fact), { eligible: true, reason: null });
  assert.equal(searchKnowledge(home, "ordinary retry evidence", { scope: "work" }).some((result) => result.id === fact.id), true);
});

test("Memory Topic cards stay review-only until verified with high confidence and a resolved time boundary", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-memory-topic-admission-test-"));
  const draft = captureKnowledge(home, {
    title: "Migrated Memory Topic",
    type: "synthesis",
    scope: "work",
    status: "draft",
    tags: ["memory-topic"],
    confidence: "medium",
    temporalState: "mixed",
    verification: "source_confirmed",
    sourceRefs: ["artifact:memory-topic-source"],
    body: "A migrated topic is evidence-backed but not yet admitted.",
  });
  assert.deepEqual(knowledgeRetrievalEligibility(draft), { eligible: false, reason: "memory_topic_status_not_verified" });
  assert.equal(searchKnowledge(home, "migrated topic", { scope: "work" }).some((result) => result.id === draft.id), false);
  assert.throws(() => updateKnowledgeStatus(home, draft.id, "verified"), /memory_topic_confidence_insufficient/);

  const admitted = captureKnowledge(home, {
    title: "Verified current Memory Topic fact",
    type: "fact",
    scope: "work",
    status: "verified",
    tags: ["memory-topic"],
    confidence: "high",
    temporalState: "current",
    verification: "source_confirmed",
    sourceRefs: ["artifact:current-authoritative-source"],
    body: "A current, high-confidence fact may enter retrieval after verification.",
  });
  assert.deepEqual(knowledgeRetrievalEligibility(admitted), { eligible: true, reason: null });
  assert.equal(searchKnowledge(home, "high-confidence fact", { scope: "work" }).some((result) => result.id === admitted.id), true);
});

test("pending revision candidates place target Knowledge on a retrieval hold", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-hold-test-"));
  const record = captureKnowledge(home, { title: "旧的无条件重试规则", scope: "work", status: "verified", sourceRefs: ["manual:user"], body: "失败后总是直接重试。" });
  const directory = join(home, "experiences", "candidates");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "exp-cand-revise.json");
  writeFileSync(path, JSON.stringify({
    schema: "ikb-knowledge-candidate.v1",
    id: "exp-cand-revise",
    status: "pending_review",
    title: "待复核知识修订：无条件重试",
    changeTypes: ["revise"],
    targetKnowledgeIds: [record.id],
    candidateKnowledge: { claim: "重试前先确认根因。" },
    createdAt: "2026-08-01T00:00:00Z"
  }, null, 2));
  assert.equal(searchKnowledge(home, "无条件重试", { scope: "work" }).length, 0);
  assert.equal(searchKnowledge(home, "无条件重试", { scope: "work", includeHeld: true })[0].id, record.id);
  assert.equal(buildContextPack(home, { taskId: "task-hold", title: "无条件重试", goal: "执行旧规则", acceptance: "完成", scope: "work" }).results.length, 0);
  writeFileSync(path, readFileSync(path, "utf8").replace('"pending_review"', '"accepted"'));
  assert.equal(searchKnowledge(home, "无条件重试", { scope: "work" }).length, 0);
  writeFileSync(path, readFileSync(path, "utf8").replace('"accepted"', '"rejected"'));
  assert.equal(searchKnowledge(home, "无条件重试", { scope: "work" })[0].id, record.id);
});

test("legacy person observations stay auditable but fail closed in default retrieval", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-person-retrieval-test-"));
  const legacyPerson = captureKnowledge(home, {
    title: "旧人物协作观察",
    type: "preference",
    collection: "people",
    scope: "work",
    sourceKind: "artifact",
    sourceRefs: ["artifact:legacy-person"],
    qualityVersion: 3,
    admissionReason: "旧版本曾用于协作准备。",
    applicability: "架构评审协作。",
    boundary: "没有完成跨来源和反证复核。",
    useWhen: "准备人物协作时。",
    useInputs: ["旧人物证据"],
    useOutputs: ["旧协作建议"],
    useSteps: ["读取旧观察", "核对来源"],
    useChecks: ["不推断人格"],
    useStopConditions: ["反证未完成"],
    confidenceBasis: ["两个旧 Episode"],
    identityConfidence: "high",
    patternConfidence: "medium",
    independentEpisodeCount: 2,
    body: "评审协作时先讲边界和证据。",
  });
  const currentPerson = captureKnowledge(home, {
    title: "当前人物协作观察",
    type: "preference",
    collection: "people",
    scope: "work",
    sourceKind: "artifact",
    sourceRefs: ["src:person-1", "src:person-2"],
    qualityVersion: 4,
    productType: "person_observation",
    compilationRef: "artifact:person-compilation",
    factRefs: ["fact:episode-1", "fact:episode-2", "fact:episode-3"],
    questionsAnswered: ["怎样准备架构评审协作？"],
    admissionReason: "重复观察会改变下一次评审材料准备。",
    applicability: "同一职责范围内的架构评审。",
    boundary: "不用于人格、能力、人事或最终决策权判断。",
    confidenceBasis: ["三个独立 Episode，跨两个来源和日期"],
    identityConfidence: "high",
    patternConfidence: "medium",
    independentEpisodeCount: 3,
    independentSourceCount: 2,
    distinctDateCount: 2,
    counterevidenceSearch: "检索相同职责与日期窗口中的不同评审顺序和反例。",
    doNotUseFor: ["人格判断", "替代正式决策权"],
    body: "评审协作时先讲边界和证据，并根据任务相关性决定是否加载。",
  });
  const legacyDomain = captureKnowledge(home, {
    title: "旧领域事实",
    type: "fact",
    collection: "concepts",
    scope: "work",
    body: "旧领域事实仍可用于边界和证据检索。",
  });

  assert.ok(listKnowledge(home, "work").some((record) => record.id === legacyPerson.id));
  assert.deepEqual(searchKnowledge(home, "边界和证据", { scope: "work" }).map((item) => item.id), [legacyDomain.id]);
  const context = buildContextPack(home, { taskId: "task-person-safe", title: "人物协作", goal: "准备架构评审的边界和证据", acceptance: "不加载旧人物观察", scope: "work" });
  assert.equal(context.results.some((item) => item.id === legacyPerson.id), false);
  assert.equal(context.results.some((item) => item.id === currentPerson.id), true);
});

test("retired knowledge stays auditable but is excluded from default retrieval and separated in indexes", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-retired-retrieval-test-"));
  const current = captureKnowledge(home, { title: "Current routing rule", type: "playbook", body: "Use the current routing rule." });
  const retired = captureKnowledge(home, { title: "Old routing rule", type: "playbook", body: "Use the old routing rule." });
  updateKnowledgeStatus(home, retired.id, "retired");

  assert.deepEqual(searchKnowledge(home, "routing rule").map((item) => item.id), [current.id]);
  assert.deepEqual(searchKnowledge(home, "routing rule", { status: "retired" }).map((item) => item.id), [retired.id]);

  const index = readFileSync(join(home, "vaults", "personal", "playbooks", "index.md"), "utf8");
  assert.match(index, /## Current knowledge/);
  assert.match(index, /## Archived knowledge \(audit only\)/);
  assert.match(index, /Current routing rule/);
  assert.match(index, /Old routing rule/);
});

test("retired knowledge can be archived out of the active vault without losing its bytes", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-archive-retired-test-"));
  const current = captureKnowledge(home, { title: "Current note", body: "current" });
  const retired = captureKnowledge(home, { title: "Old note", body: "old" });
  updateKnowledgeStatus(home, retired.id, "retired");
  const result = archiveRetiredKnowledge(home, "personal")[0];
  assert.equal(result.archived.length, 1);
  assert.equal(listKnowledge(home, "personal").map((item) => item.id).join(","), current.id);
  assert.equal(existsSync(result.archived[0].to), true);
  assert.match(readFileSync(result.manifestPath, "utf8"), new RegExp(retired.id));
});

test("knowledge card metadata persists evidence strength, temporal state and verification", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-knowledge-card-test-"));
  const record = captureKnowledge(home, {
    title: "Bounded playbook",
    type: "playbook",
    sourceKind: "document",
    sourceRefs: ["src-card:r1"],
    scope: "work",
    qualityVersion: 2,
    confidence: "medium",
    confidenceBasis: ["formal document", "no real-task validation yet"],
    temporalState: "mixed",
    verification: "unverified",
    admissionReason: "The decision path is reusable with explicit limits.",
    applicability: "Use for bounded review preparation.",
    boundary: "Do not treat planned behavior as current runtime fact.",
    body: "Use the bounded decision path and verify the current state.",
  });
  const text = readFileSync(record.path, "utf8");
  assert.match(text, /confidence: medium/);
  assert.match(text, /temporal_state: mixed/);
  assert.match(text, /verification: unverified/);
  const reread = listKnowledge(home, "work")[0];
  assert.equal(reread.confidence, "medium");
  assert.deepEqual(reread.confidenceBasis, ["formal document", "no real-task validation yet"]);
  assert.equal(reread.temporalState, "mixed");
  assert.equal(reread.verification, "unverified");
});

test("quality version 2 requires a confidence basis", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-confidence-gate-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "Unjustified confidence",
      sourceKind: "document",
      sourceRefs: ["src-card:r1"],
      qualityVersion: 2,
      admissionReason: "A reusable claim.",
      applicability: "A bounded task.",
      boundary: "Needs validation.",
      body: "A claim without a confidence basis.",
    }),
    /confidence_basis_missing/,
  );
  assert.equal(listKnowledge(home).length, 0);
});

test("quality version 2 person knowledge requires split confidence and independent episodes", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-person-confidence-gate-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "Person pattern without enough evidence",
      type: "preference",
      collection: "people",
      sourceKind: "artifact",
      sourceRefs: ["artifact:person-analysis"],
      qualityVersion: 2,
      confidence: "medium",
      confidenceBasis: ["three direct records"],
      admissionReason: "A repeated work pattern could change future preparation.",
      applicability: "Use to prepare a bounded review.",
      boundary: "Not a personality or capability judgment.",
      body: "Prepare the review with the cited evidence.",
    }),
    /person_identity_confidence_missing.*person_pattern_confidence_missing.*person_episode_count_insufficient/s,
  );
  const record = captureKnowledge(home, {
    title: "Person pattern with split evidence",
    type: "preference",
    collection: "people",
    sourceKind: "artifact",
    sourceRefs: ["artifact:person-analysis"],
    qualityVersion: 2,
    confidence: "medium",
    confidenceBasis: ["identity is exact; pattern repeats across three episodes"],
    identityConfidence: "high",
    patternConfidence: "medium",
    independentEpisodeCount: 3,
    admissionReason: "A repeated work pattern could change future preparation.",
    applicability: "Use to prepare a bounded review.",
    boundary: "Not a personality or capability judgment.",
    body: "Prepare the review with the cited evidence.",
  });
  assert.equal(record.identityConfidence, "high");
  assert.equal(record.patternConfidence, "medium");
  assert.equal(record.independentEpisodeCount, 3);
  assert.throws(
    () => captureKnowledge(home, {
      title: "Verified person without consolidation evidence",
      type: "fact",
      collection: "people",
      sourceKind: "artifact",
      sourceRefs: ["artifact:person-analysis"],
      status: "verified",
      verification: "source_confirmed",
      body: "A person fact that has not passed the person gate.",
    }),
    /person_identity_confidence_missing.*person_pattern_confidence_missing.*person_episode_count_insufficient/s,
  );
});

test("document ingest preserves source kind and source path", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-document-source-test-"));
  const source = join(home, "review.md");
  writeFileSync(source, "# Review\n\nKeep the evidence reference.\n");
  const record = ingestKnowledge(home, source, {
    scope: "work",
    sourceKind: "review_comment",
    admissionReason: "The accepted review rule changes future review behavior.",
    applicability: "Use when curating accepted review feedback.",
    boundary: "A single unverified comment remains evidence, not a universal rule.",
  });
  assert.equal(record.sourceKind, "review_comment");
  assert.deepEqual(record.sourceRefs, [source]);
  assert.match(readFileSync(record.path, "utf8"), /source_kind: "review_comment"/);
});

test("document ingest preserves quality version and parsed lifecycle metadata", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-document-quality-version-test-"));
  const source = join(home, "card.md");
  writeFileSync(source, [
    "---",
    "type: playbook",
    "collection: playbooks",
    "source_kind: document",
    "scope: work",
    "status: draft",
    "quality_version: 2",
    "source_refs: [\"src-card:r1\"]",
    "admission_reason: \"A narrow decision path is reusable.\"",
    "applicability: \"Use in the bounded task.\"",
    "boundary: \"Verify current state first.\"",
    "confidence: medium",
    "confidence_basis: [\"formal source\"]",
    "temporal_state: planned",
    "verification: source_confirmed",
    "---",
    "# Narrow card",
    "\nUse the path only after checking the current state.",
  ].join("\n"));
  const record = ingestKnowledge(home, source, { scope: "work" });
  assert.equal(record.qualityVersion, 2);
  assert.equal(record.temporalState, "planned");
  assert.equal(record.verification, "source_confirmed");
  assert.match(readFileSync(record.path, "utf8"), /quality_version: 2/);
});

test("context pack includes verified and draft knowledge with an explicit use policy", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-test-"));
  const draft = captureKnowledge(home, { title: "Draft technical plan source", body: "technical plan source", scope: "personal", status: "draft" });
  const verified = captureKnowledge(home, {
    title: "Verified plan rule",
    type: "fact",
    body: "technical plan source",
    scope: "personal",
    status: "verified",
    sourceKind: "manual",
    sourceRefs: ["user-confirmation:test"],
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "artifact:plan-test",
    factRefs: ["fact:plan-test"],
    questionsAnswered: ["这条规则用于什么任务？"],
    admissionReason: "会影响后续技术方案准备。",
    applicability: "准备技术方案时。",
    boundary: "不替代当前项目的事实核对。",
    confidence: "high",
    confidenceBasis: ["用户确认"],
    temporalState: "current",
    verification: "user_confirmed",
  });
  const context = buildContextPack(home, { taskId: "task-1", title: "plan", goal: "technical plan", acceptance: "source" });
  assert.equal(context.results.length, 2);
  assert.deepEqual(new Set(context.results.map((item) => item.id)), new Set([draft.id, verified.id]));
  assert.match(context.markdown, /Use policy: verified \+ draft/);
  assert.match(context.markdown, /Draft technical plan source/);
  assert.match(context.markdown, /Verified plan rule/);
  const strict = buildContextPack(home, { taskId: "task-1", title: "plan", goal: "technical plan", acceptance: "source", includeDrafts: false });
  assert.equal(strict.results.length, 1);
  assert.equal(strict.results[0].id, verified.id);
});

test("context pack excludes low-score noise when a clearly stronger Knowledge match exists", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-relevance-test-"));
  const strong = captureKnowledge(home, {
    title: "Knowledge 修订事务恢复与冲突验证",
    scope: "personal",
    body: "候选确认后保存前后快照，冲突时停止覆盖，并从 journal 恢复。",
  });
  captureKnowledge(home, { title: "泛化编码建议", scope: "personal", body: "修订事务可以作为一般背景。" });
  captureKnowledge(home, { title: "泛化评审建议", scope: "personal", body: "修订事务可以作为一般上下文。" });
  const context = buildContextPack(home, {
    taskId: "task-relevance",
    title: "Knowledge 修订事务",
    goal: "验证恢复与冲突",
    acceptance: "候选确认和快照可验证",
    scope: "personal",
  });
  assert.deepEqual(context.results.map((item) => item.id), [strong.id]);
  assert.equal(context.retrieval.candidates, 3);
  assert.equal(context.retrieval.excludedLowScoreIds.length, 2);
  assert.match(context.markdown, /absolute anchor cutoff score/);
});

test("context pack uses the task title as a topic anchor before broad goal and acceptance terms", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-title-anchor-test-"));
  const target = captureKnowledge(home, {
    title: "机票预订模型与验价边界",
    scope: "work",
    body: "多乘机人分单前先核对预订领域对象和当前验价入口。",
  });
  const noise = captureKnowledge(home, {
    title: "返现资损复盘",
    scope: "work",
    body: "验价 风险 边界 证据 验证 影响范围 关键不变量 验证入口 ".repeat(20),
  });
  const context = buildContextPack(home, {
    taskId: "task-title-anchor",
    title: "机票预订编码前知识路由",
    goal: "修改多乘机人分单与验价链路，识别关键不变量、影响范围和验证入口",
    acceptance: "返回风险、边界、证据和验证清单",
    scope: "work",
  });
  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.results.some((item) => item.id === noise.id), false);
  assert.equal(context.retrieval.candidates, 2);
  assert.equal(context.retrieval.anchorApplied, true);
  assert.equal(context.retrieval.anchorMatches, 1);
  assert.match(context.markdown, /title anchor retained 1/);
});

test("context pack returns zero results when Pi/Magent only overlaps cross-domain code architecture cards", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-cross-domain-parent-anchor-test-"));
  captureKnowledge(home, {
    title: "Token 预算代码架构图",
    scope: "work",
    body: "代码架构图用于 Token 预算模型。",
    useWhen: "生成代码架构图时。",
    questionsAnswered: ["如何生成代码架构图？"],
  });
  captureKnowledge(home, {
    title: "RCF Agent 归属代码架构图",
    scope: "work",
    body: "代码架构图用于 RCF Agent 归属关系。",
    useWhen: "生成代码架构图时。",
    questionsAnswered: ["如何生成代码架构图？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-pi-magent-cross-domain",
    title: "Pi/Magent 代码架构图",
    goal: "梳理 Pi/Magent 的调用关系",
    acceptance: "输出代码架构图",
    scope: "work",
  });

  assert.deepEqual(context.results, []);
  assert.deepEqual(context.units, []);
});

test("context pack leaves a generic code architecture task empty instead of routing Token or RCF cards", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-generic-parent-anchor-test-"));
  captureKnowledge(home, {
    title: "Token 预算代码架构图",
    scope: "work",
    body: "代码架构图用于生成 Token 预算方案。",
    useWhen: "生成代码架构图时。",
    questionsAnswered: ["如何生成代码架构图？"],
  });
  captureKnowledge(home, {
    title: "RCF Agent 归属代码架构图",
    scope: "work",
    body: "代码架构图用于生成 RCF Agent 归属方案。",
    useWhen: "生成代码架构图时。",
    questionsAnswered: ["如何生成代码架构图？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-generic-code-architecture",
    taskType: "coding",
    title: "代码架构图",
    goal: "生成方案",
    acceptance: "输出代码架构图",
    scope: "work",
  });

  assert.deepEqual(context.results, []);
  assert.deepEqual(context.units, []);
});

test("document context does not select a generic document card without an entity anchor", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-generic-document-anchor-test-"));
  captureKnowledge(home, {
    title: "通用文档事实边界说明",
    scope: "work",
    body: "文档说明应当区分事实和边界。",
    useWhen: "撰写文档说明时。",
    questionsAnswered: ["文档事实边界如何说明？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-generic-document-anchor",
    taskType: "document",
    title: "文档说明",
    goal: "生成方案",
    acceptance: "事实和边界分开",
    scope: "work",
  });

  assert.deepEqual(context.results, []);
  assert.deepEqual(context.units, []);
});

test("document title routing does not reenter a typed snippet-only card without document intent", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-document-typed-legacy-test-"));
  const documentCard = captureKnowledge(home, {
    title: "技术文档事实与边界写作卡",
    scope: "work",
    body: "技术文档要分开当前事实、计划、未知和证据。",
    useWhen: "撰写技术文档或阶段效果说明时。",
    questionsAnswered: ["技术文档怎样保留事实边界？"],
  });
  const typedLure = captureKnowledge(home, {
    title: "跨域运行事实卡",
    scope: "work",
    sourceKind: "manual",
    sourceRefs: ["src-demo:typed-lure"],
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "artifact:typed-lure",
    factRefs: ["fact:typed-lure"],
    body: "IKB阶段效果与知识检索效果需要通过跨域运行指标汇总。",
    questionsAnswered: ["如何跟踪跨域运行指标？"],
    admissionReason: "该事实卡只用于跨域运行指标跟踪。",
    applicability: "跟踪跨域运行指标时。",
    boundary: "不用于技术文档写作。",
    confidence: "high",
    confidenceBasis: ["人工确认"],
    temporalState: "current",
    verification: "source_confirmed",
  });

  const context = buildContextPack(home, {
    taskId: "task-document-typed-legacy",
    taskType: "document",
    title: "IKB阶段效果文档",
    goal: "说明知识检索效果",
    acceptance: "事实和结论分开",
    scope: "work",
  });

  assert.equal(context.retrieval.anchorApplied, true);
  assert.equal(context.results.some((item) => item.id === documentCard.id), true);
  assert.equal(context.results.some((item) => item.id === typedLure.id), false);
});

test("document title does not fallback to a typed entity-matched card without document intent", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-document-typed-fallback-test-"));
  captureKnowledge(home, {
    title: "跨域运行事实卡",
    scope: "work",
    sourceKind: "manual",
    sourceRefs: ["src-demo:typed-fallback"],
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "artifact:typed-fallback",
    factRefs: ["fact:typed-fallback"],
    body: "IKB阶段效果与知识检索效果需要通过跨域运行指标汇总。",
    questionsAnswered: ["如何跟踪跨域运行指标？"],
    admissionReason: "该事实卡只用于跨域运行指标跟踪。",
    applicability: "跟踪跨域运行指标时。",
    boundary: "不用于技术文档写作。",
    confidence: "high",
    confidenceBasis: ["人工确认"],
    temporalState: "current",
    verification: "source_confirmed",
  });

  const context = buildContextPack(home, {
    taskId: "task-document-typed-fallback",
    taskType: "document",
    title: "IKB阶段效果文档",
    goal: "说明知识检索效果",
    acceptance: "事实和结论分开",
    scope: "work",
  });

  assert.equal(context.retrieval.anchorApplied, false);
  assert.deepEqual(context.results, []);
  assert.deepEqual(context.units, []);
});

test("context pack does not reenter a typed snippet-only card after a non-document title anchor", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-typed-legacy-snippet-test-"));
  const target = captureKnowledge(home, {
    title: "IKB父卡强锚点契约",
    scope: "work",
    body: "IKB父卡强锚点契约要求先固定父卡，再选择直接回答问题的单元。",
    useWhen: "修改 IKB 父卡强锚点时。",
    questionsAnswered: ["IKB父卡强锚点如何限制候选？"],
  });
  const typedLure = captureKnowledge(home, {
    title: "跨域运行指标事实卡",
    scope: "work",
    sourceKind: "manual",
    sourceRefs: ["src-demo:typed-legacy-snippet"],
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "artifact:typed-legacy-snippet",
    factRefs: ["fact:typed-legacy-snippet"],
    body: "IKB 跨域运行指标需要单独汇总。",
    questionsAnswered: ["如何汇总跨域运行指标？"],
    admissionReason: "该事实卡只用于跨域运行指标汇总。",
    applicability: "汇总跨域运行指标时。",
    boundary: "不用于 IKB 父卡强锚点选择。",
    confidence: "high",
    confidenceBasis: ["人工确认"],
    temporalState: "current",
    verification: "source_confirmed",
  });

  const context = buildContextPack(home, {
    taskId: "task-typed-legacy-snippet",
    taskType: "coding",
    title: "IKB父卡强锚点",
    goal: "选择问题单元",
    acceptance: "输出跨域运行指标",
    scope: "work",
  });

  assert.equal(context.retrieval.anchorApplied, true);
  assert.equal(context.results.some((item) => item.id === target.id), true);
  assert.equal(context.results.some((item) => item.id === typedLure.id), false);
});

test("context pack retains the parent card with the matching Pi/Magent entity", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-pi-magent-entity-anchor-test-"));
  const target = captureKnowledge(home, {
    title: "Pi/Magent 调度关系图",
    scope: "work",
    body: "Pi/Magent 调度关系图先固定调用边界，再核对入口。",
    useWhen: "梳理 Pi/Magent 调度关系时。",
    questionsAnswered: ["Pi/Magent 调度关系图如何确定？"],
  });
  captureKnowledge(home, {
    title: "Token 预算代码架构图",
    scope: "work",
    body: "代码架构图用于 Token 预算模型。",
    useWhen: "生成代码架构图时。",
    questionsAnswered: ["如何生成代码架构图？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-pi-magent-entity-anchor",
    title: "Pi/Magent 调度关系图",
    goal: "梳理 Pi/Magent 的调用关系",
    acceptance: "输出调用边界",
    scope: "work",
  });

  assert.equal(context.results.some((item) => item.id === target.id), true);
});

test("context pack emits direct facts but not root or structural sections by default", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-structural-unit-test-"));
  const target = captureKnowledge(home, {
    title: "IKB 精确召回二阶段合同",
    scope: "work",
    productType: "decision_card",
    body: [
      "# IKB 精确召回二阶段合同（decision_card）",
      "",
      "根标题说明 IKB 精确召回二阶段合同。",
      "",
      "## 使用定位",
      "",
      "IKB 精确召回二阶段合同的使用定位。",
      "",
      "## state",
      "",
      "IKB 精确召回二阶段合同的 state。",
      "",
      "## options",
      "",
      "IKB 精确召回二阶段合同的 options。",
      "",
      "## 直接可用事实",
      "",
      "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
      "| --- | --- | --- | --- | --- |",
      "| precise-retrieval-f1 | current | core | IKB 精确召回二阶段合同只返回直接可回答的事实。 | precise-e1 |",
    ].join("\n"),
    useWhen: "实施 IKB 精确召回二阶段合同时。",
    questionsAnswered: ["IKB 精确召回二阶段合同保留什么事实？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-structural-unit-filter",
    title: "IKB 精确召回二阶段合同",
    goal: "只加载直接可回答的事实",
    acceptance: "结构章节不进入 Context Pack",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.units.some((unit) => unit.unitId.includes("precise-retrieval-f1") && unit.kind === "fact"), true);
  assert.equal(context.units.some((unit) => ["IKB 精确召回二阶段合同", "IKB 精确召回二阶段合同（decision_card）", "使用定位", "state", "options"].includes(unit.label)), false);
});

test("context pack excludes a root product-suffix section while retaining its direct fact", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-root-product-suffix-test-"));
  const title = "IKB 根标题后缀泄漏合同";
  const target = captureKnowledge(home, {
    title,
    scope: "work",
    productType: "decision_card",
    body: [
      `# ${title}（decision_card）`,
      "",
      "root-suffix-leak-signal 是根标题段唯一可回答的内容。",
      "",
      "## 直接可用事实",
      "",
      "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
      "| --- | --- | --- | --- | --- |",
      "| root-direct-f1 | current | core | direct-fact-preserved-signal 是必须保留的直接事实。 | root-e1 |",
    ].join("\n"),
    useWhen: `实施 ${title} 时。`,
    questionsAnswered: [`${title} 应保留哪些直接事实？`],
  });

  const context = buildContextPack(home, {
    taskId: "task-root-product-suffix",
    taskType: "coding",
    title,
    goal: "root-suffix-leak-signal；direct-fact-preserved-signal",
    acceptance: "仅输出直接可回答事实",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.units.some((unit) => unit.label === `${title}（decision_card）`), false);
  assert.equal(context.units.some((unit) => unit.unitId.includes("root-direct-f1") && unit.kind === "fact"), true);
});

test("context pack does not select a section that matches acceptance only", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-acceptance-only-unit-test-"));
  const title = "IKB 目标问题隔离合同";
  const target = captureKnowledge(home, {
    title,
    scope: "work",
    body: [
      `# ${title}`,
      "",
      "该卡只保留任务标题和目标直接回答。",
      "",
      "## 直接可用事实",
      "",
      "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
      "| --- | --- | --- | --- | --- |",
      "| goal-direct-f1 | current | core | goal-direct-fact-signal 是任务目标的直接事实。 | goal-e1 |",
      "",
      "## acceptance-only-section",
      "",
      "acceptance-only-signal 只出现在 acceptance 条件，不回答标题或目标。",
    ].join("\n"),
    useWhen: `实施 ${title} 时。`,
    questionsAnswered: [`${title} 应保留什么目标事实？`],
  });

  const context = buildContextPack(home, {
    taskId: "task-acceptance-only-unit",
    taskType: "coding",
    title,
    goal: "goal-direct-fact-signal",
    acceptance: "验证 acceptance-only-signal",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.units.some((unit) => unit.unitId.includes("goal-direct-f1") && unit.kind === "fact"), true);
  assert.equal(context.units.some((unit) => unit.label === "acceptance-only-section"), false);
});

function captureEligiblePersonObservation(home: string) {
  return captureKnowledge(home, {
    title: "王嘉涛：Agent工具评估顺序（观察）",
    scope: "work",
    collection: "people",
    body: "评估 IKB Agent 工具时，先验证可用性，再检查复用路径。",
    sourceRefs: ["src-person-episode-1", "src-person-episode-2", "src-person-episode-3"],
    qualityVersion: 4,
    productType: "person_observation",
    canonicalKey: "work:people:wangjiatao:observation:test",
    compilationRef: "artifact-person-compilation",
    factRefs: ["fact-person-pattern", "fact-person-episode-1", "fact-person-episode-2", "fact-person-episode-3"],
    questionsAnswered: ["评估 Agent 工具时先检查什么？"],
    admissionReason: "两个独立 Episode 支持一条窄范围协作观察。",
    applicability: "准备与王嘉涛讨论 Agent 工具评估时。",
    boundary: "只描述可观察的工作顺序，不推断人格、能力或决策权。",
    useWhen: "准备 Agent 工具方案沟通时。",
    useInputs: ["工具能力", "复用路径"],
    useOutputs: ["沟通检查清单"],
    useSteps: ["先验证可用性", "再检查复用"],
    useChecks: ["不把观察写成正式决定"],
    useStopConditions: ["身份或当前意图不明确"],
    confidence: "medium",
    confidenceBasis: ["三个独立 Episode"],
    temporalState: "current",
    verification: "source_confirmed",
    identityConfidence: "high",
    patternConfidence: "medium",
    independentEpisodeCount: 3,
    independentSourceCount: 3,
    distinctDateCount: 3,
    counterevidenceRefs: [],
    counterevidenceSearch: "检查同一时间窗内的直接表达，未发现反例。",
    doNotUseFor: ["推断人格、动机、能力等级、绩效、晋升或组织权力"],
  });
}

test("search excludes people Knowledge unless the query has explicit person intent", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-search-people-routing-test-"));
  const person = captureEligiblePersonObservation(home);
  const system = captureKnowledge(home, {
    title: "IKB检索效果评估",
    scope: "work",
    collection: "syntheses",
    body: "评估检索命中、实际使用和任务结果。",
  });

  assert.deepEqual(searchKnowledge(home, "IKB Agent 工具评估", { scope: "work" }).map((item) => item.id), [system.id]);
  assert.deepEqual(new Set(searchKnowledge(home, "王嘉涛 IKB Agent 工具评估", { scope: "work" }).map((item) => item.id)), new Set([person.id, system.id]));
});

test("context pack excludes people Knowledge from non-person tasks", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-people-routing-test-"));
  const person = captureEligiblePersonObservation(home);
  const system = captureKnowledge(home, {
    title: "IKB检索回归与效果评估",
    scope: "work",
    collection: "syntheses",
    body: "用固定 Case 验证召回相关性、实际使用和最终效果。",
    useWhen: "修复 IKB 非人物任务的检索误召回时。",
    questionsAnswered: ["如何建立 IKB 检索回归？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-system-retrieval",
    taskType: "coding",
    title: "修复 IKB Agent 非人物任务的检索误召回",
    goal: "建立检索回归并验证最终消费者",
    acceptance: "不召回人物卡",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [system.id]);
  assert.equal(context.results.some((item) => item.id === person.id), false);
  assert.deepEqual(context.retrieval.excludedByRoutingIds, [person.id]);
});

test("context pack allows people Knowledge for communication tasks or an explicit identity", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-people-intent-test-"));
  const person = captureEligiblePersonObservation(home);

  const communication = buildContextPack(home, {
    taskId: "task-communication",
    taskType: "communication",
    title: "Agent工具方案沟通",
    goal: "准备沟通材料",
    acceptance: "表达清楚",
    scope: "work",
  });
  const explicitIdentity = buildContextPack(home, {
    taskId: "task-explicit-person",
    taskType: "general",
    title: "王嘉涛 Agent工具评估顺序",
    goal: "核对可观察的协作方式",
    acceptance: "不推断人格",
    scope: "work",
  });

  assert.deepEqual(communication.results.map((item) => item.id), [person.id]);
  assert.deepEqual(explicitIdentity.results.map((item) => item.id), [person.id]);
});

test("context pack does not fill results from body-only weak matches", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-answerability-test-"));
  captureKnowledge(home, {
    title: "资金安全评审",
    scope: "work",
    collection: "playbooks",
    body: "IKB 检索路由 回归 效果 评估。这里只是正文中的旁路提及，不回答检索问题。",
  });

  const context = buildContextPack(home, {
    taskId: "task-answerability",
    taskType: "coding",
    title: "IKB检索路由回归",
    goal: "修复弱相关填充",
    acceptance: "没有可回答知识时返回空",
    scope: "work",
  });

  assert.deepEqual(context.results, []);
});

test("context pack does not backfill weak two-character units after selecting a direct answer", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-weak-unit-backfill-test-"));
  const target = captureKnowledge(home, {
    title: "IKB专属召回契约",
    scope: "work",
    body: [
      "# 直接回答",
      "",
      "IKB专属召回契约要求只返回能回答任务的问题级单元。",
      "",
      "# 旁路一",
      "",
      "召回。",
      "",
      "# 旁路二",
      "",
      "召回。",
    ].join("\n"),
    useWhen: "处理 IKB专属召回契约时。",
    questionsAnswered: ["IKB专属召回契约如何限制任务单元？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-weak-unit-backfill",
    title: "IKB专属召回契约",
    goal: "只返回直接回答的问题级单元",
    acceptance: "不使用旁路召回填满结果",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.units.some((unit) => unit.label === "旁路一" || unit.label === "旁路二"), false);
  assert.equal(context.units.length, 1);
});

test("context pack rejects cross-domain cards that share only generic recall wording", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-cross-domain-generic-test-"));
  const target = captureKnowledge(home, {
    title: "IKB专属召回契约",
    scope: "work",
    body: "# 直接回答\n\nIKB专属召回契约要求任务只接收直接回答的问题级单元。",
    useWhen: "处理 IKB专属召回契约时。",
    questionsAnswered: ["IKB专属召回契约如何限制任务单元？"],
  });
  const openViking = captureKnowledge(home, {
    title: "OpenViking召回改造手册",
    scope: "work",
    body: "# 旁路\n\n召回。",
    useWhen: "进行召回改造时。",
    questionsAnswered: ["如何进行召回改造？"],
  });
  const booking = captureKnowledge(home, {
    title: "机票预订召回改造说明",
    scope: "work",
    body: "# 旁路\n\n召回。",
    useWhen: "进行召回改造时。",
    questionsAnswered: ["如何进行召回改造？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-cross-domain-generic",
    title: "IKB具体问题到知识单元召回改造",
    goal: "只返回直接回答的问题级单元",
    acceptance: "泛词跨域卡不进入结果",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.units.some((unit) => unit.knowledgeId === openViking.id || unit.knowledgeId === booking.id), false);
});

test("context pack keeps multiple title-anchor dimensions when broad contract text overweights one card", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-multi-anchor-test-"));
  const review = captureKnowledge(home, {
    title: "技术方案与架构评审执行卡",
    scope: "work",
    body: "评审一份涉及预订领域模型与编排边界的技术方案识别事实失真跨层依赖未闭合风险和验证缺口不执行外部评论优先返回技术方案与架构评审执行卡预订领域模型事实包人物观察只能在明确适用范围内形成评审检查清单",
  });
  const domain = captureKnowledge(home, {
    title: "机票预订系统现状与目标模型",
    scope: "work",
    body: "预订领域模型区分事实与编排。",
  });
  const context = buildContextPack(home, {
    taskId: "task-multi-anchor",
    title: "机票预订架构评审",
    goal: "评审一份涉及预订领域模型与编排边界的技术方案，识别事实失真、跨层依赖、未闭合风险和验证缺口，不执行外部评论",
    acceptance: "优先返回技术方案与架构评审执行卡、预订领域模型事实包；人物观察只能在明确适用范围内；形成评审检查清单",
    scope: "work",
  });
  assert.deepEqual(new Set(context.results.map((item) => item.id)), new Set([review.id, domain.id]));
  assert.equal(context.retrieval.anchorMatches, 2);
});

test("context pack does not let one high-scoring Chinese title suppress a second explicit title-anchor match", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-chinese-anchor-skew-test-"));
  const reporting = captureKnowledge(home, {
    title: "技术项目向上汇报的业务结果与机制表达",
    scope: "work",
    body: "技术项目向上汇报要连接业务结果、投入成本和长期机制。",
    useWhen: "本人准备技术项目复盘、阶段价值说明或向上汇报时。",
    questionsAnswered: ["技术项目向上汇报应包含什么"],
  });
  const milestone = captureKnowledge(home, {
    title: "项目推进的里程碑同步契约",
    scope: "work",
    body: "持续项目需要同步当前状态、下一里程碑、负责人和阻塞。",
    useWhen: "持续项目做周报、阶段同步、资源升级或跨人交接时。",
    questionsAnswered: ["项目推进同步需要包含哪些信息"],
  });
  const context = buildContextPack(home, {
    taskId: "task-upward-report",
    title: "技术项目向上汇报与里程碑同步",
    goal: "说明当前结果、未闭合风险、投入成本、后续机制和需要上级决定的事项",
    acceptance: "同时返回向上汇报和里程碑同步知识",
    scope: "work",
  });
  assert.deepEqual(new Set(context.results.map((item) => item.id)), new Set([reporting.id, milestone.id]));
  assert.equal(context.retrieval.anchorMatches, 2);
});

test("context pack applies a visible body budget without losing the full-card path", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-budget-test-"));
  const record = captureKnowledge(home, {
    title: "恢复事务完整手册",
    scope: "personal",
    body: ["# 结论", "恢复事务必须保留快照。", ...Array.from({ length: 30 }, (_, index) => `## 章节 ${index}\n\n${"恢复 冲突 快照 验证 ".repeat(120)}`)].join("\n\n"),
  });
  const context = buildContextPack(home, {
    taskId: "task-budget",
    title: "恢复事务",
    goal: "检查冲突快照",
    acceptance: "验证恢复",
    scope: "personal",
    bodyBudgetChars: 3_000,
  });
  assert.deepEqual(context.retrieval.truncatedIds, []);
  assert.deepEqual(context.retrieval.truncatedUnitIds, []);
  assert.deepEqual(context.results.map((item) => item.id), [record.id]);
  assert.equal(context.units.length, 2, "title 与 goal 两类任务问题各保留一个最佳单元");
  assert.match(context.markdown, /query-focused excerpt/);
  assert.match(context.markdown, new RegExp(record.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(context.markdown.length <= 12_000);
});

test("context pack keeps the total body budget when a caller requests an excessive result limit", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-budget-many-test-"));
  for (let index = 0; index < 20; index += 1) {
    captureKnowledge(home, {
      title: `恢复事务手册 ${index}`,
      scope: "personal",
      body: `# 恢复事务\n\n${"恢复 冲突 快照 验证 ".repeat(500)}`,
    });
  }
  const context = buildContextPack(home, {
    taskId: "task-budget-many",
    title: "恢复事务",
    goal: "验证恢复冲突快照",
    acceptance: "全部结果受总预算约束",
    scope: "personal",
    limit: 100,
    bodyBudgetChars: 2_000,
  });
  assert.equal(context.results.length, 2);
  assert.equal(context.retrieval.truncatedIds.length, 2);
  assert.ok(context.markdown.length < 8_000);
});

test("context pack retrieves concrete Knowledge units instead of a whole weakly matched card", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-unit-retrieval-test-"));
  const target = captureKnowledge(home, {
    title: "IKB知识单元召回契约",
    scope: "work",
    collection: "syntheses",
    body: [
      "# IKB知识单元召回契约",
      "",
      "## 直接可用事实",
      "",
      "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
      "| --- | --- | --- | --- | --- |",
      "| ikb-retrieval-f1 | current | core | Context Pack 应按具体问题只召回命中的事实单元。 | ikb-e1 |",
      "| ikb-storage-f2 | current | supporting | 历史运行目录需要按内容哈希压缩。 | ikb-e2 |",
      "",
      "## 有依据的结论",
      "",
      "### 召回粒度必须落到知识单元",
      "",
      "- 主张：`ikb-retrieval-c1`",
      "- 事实引用：`ikb-retrieval-f1`",
      "- 推导：整卡召回会把无关事实带入任务上下文。",
    ].join("\n"),
    useWhen: "修改 IKB 检索、召回和 Context Pack 时。",
    questionsAnswered: ["IKB 如何按具体问题召回知识单元？"],
    useStopConditions: ["没有直接回答任务问题的单元时返回零结果"],
  });
  const noise = captureKnowledge(home, {
    title: "机票预订系统目标模型",
    scope: "work",
    collection: "domains",
    body: "分单、多程、价格追溯和链路复用是预订系统的具体问题。",
    questionsAnswered: ["预订系统当前有哪些具体问题？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-unit-retrieval",
    taskType: "coding",
    title: "IKB具体问题到知识单元召回改造",
    goal: "按任务问题召回具体 Fact 与 Claim",
    acceptance: "弱相关领域卡不填充；只返回能回答问题的知识单元",
    scope: "work",
  });

  assert.deepEqual(context.results.map((item) => item.id), [target.id]);
  assert.equal(context.results.some((item) => item.id === noise.id), false);
  assert.equal(context.units.some((unit) => unit.unitId.includes("ikb-retrieval-f1") && unit.kind === "fact"), true);
  assert.equal(context.units.some((unit) => unit.unitId.includes("ikb-storage-f2")), false);
  assert.match(context.markdown, /Context Pack 应按具体问题只召回命中的事实单元/);
  assert.doesNotMatch(context.markdown, /历史运行目录需要按内容哈希压缩/);
  assert.doesNotMatch(context.markdown, /机票预订系统目标模型/);
});

test("context pack routes an ASCII-CJK glued IKB title to its relevant contract before generic candidates", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-glued-title-routing-test-"));
  const target = captureKnowledge(home, {
    title: "IKB Context Pack knowledge-unit retrieval contract",
    scope: "work",
    collection: "syntheses",
    body: "Context Pack routes an IKB task to a knowledge unit that answers it.",
    useWhen: "Evolve IKB Context Pack knowledge-unit retrieval.",
    questionsAnswered: ["How should IKB Context Pack retrieve a knowledge unit?"],
  });
  const openVikingNoise = captureKnowledge(home, {
    title: "OpenViking 通用检索运行手册",
    scope: "work",
    collection: "domains",
    body: "任务、问题、召回、改造和验证是检索系统的通用术语。",
    questionsAnswered: ["检索系统如何验证通用任务？"],
  });
  const bookingNoise = captureKnowledge(home, {
    title: "机票预订召回链路说明",
    scope: "work",
    collection: "domains",
    body: "任务、问题、召回、改造和验证是预订链路的通用术语。",
    questionsAnswered: ["预订召回链路有哪些问题？"],
  });

  const context = buildContextPack(home, {
    taskId: "task-glued-title-routing",
    taskType: "coding",
    title: "IKB具体问题到知识单元召回改造",
    goal: "按具体问题返回可用知识单元",
    acceptance: "相关契约被召回，通用卡不进入上下文",
    scope: "work",
  });

  assert.equal(context.results.some((item) => item.id === target.id), true);
  assert.equal(context.results.some((item) => item.id === openVikingNoise.id), false);
  assert.equal(context.results.some((item) => item.id === bookingNoise.id), false);
});

test("context pack decomposes explicit title dimensions and keeps card-level results unique", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-unit-multi-question-test-"));
  const record = captureKnowledge(home, {
    title: "技术项目向上汇报与里程碑同步契约",
    scope: "work",
    body: "# 项目同步\n\n## 结果表达\n\n向上汇报说明业务结果和投入。\n\n## 里程碑\n\n里程碑同步说明状态、负责人和阻塞。",
    questionsAnswered: ["技术项目向上汇报包含什么？", "里程碑同步包含什么？"],
  });
  const context = buildContextPack(home, {
    taskId: "task-unit-multi-question",
    title: "技术项目向上汇报与里程碑同步",
    goal: "准备项目同步材料",
    acceptance: "两个维度都要有具体知识",
    scope: "work",
  });

  assert.equal(context.questions.includes("技术项目向上汇报"), true);
  assert.equal(context.questions.includes("里程碑同步"), true);
  assert.deepEqual(context.results.map((item) => item.id), [record.id]);
  assert.equal(new Set(context.units.map((unit) => unit.knowledgeId)).size, 1);
  assert.equal(context.units.some((unit) => unit.text.includes("业务结果和投入")), true);
  assert.equal(context.units.some((unit) => unit.text.includes("状态、负责人和阻塞")), true);
});

test("context pack enforces a hard total budget across unit metadata and content", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-unit-total-budget-test-"));
  const longFact = "恢复事务必须保留冲突快照和验证证据。".repeat(600);
  captureKnowledge(home, {
    title: "恢复事务事实包",
    scope: "personal",
    body: [
      "# 恢复事务事实包",
      "",
      "## 直接可用事实",
      "",
      "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
      "| --- | --- | --- | --- | --- |",
      `| recovery-f1 | current | core | ${longFact} | recovery-e1 |`,
    ].join("\n"),
    questionsAnswered: ["恢复事务如何保留冲突快照？"],
  });
  const context = buildContextPack(home, {
    taskId: "task-unit-total-budget",
    title: "恢复事务冲突快照",
    goal: "读取恢复事实",
    acceptance: "Context Pack 总长度受限",
    scope: "personal",
    totalBudgetChars: 3_000,
  });

  assert.ok(context.markdown.length <= 3_000, `actual length: ${context.markdown.length}`);
  assert.equal(context.retrieval.totalBudgetChars, 3_000);
  assert.equal(context.retrieval.truncatedUnitIds.length > 0, true);
});

test("quality version 3 requires a task-facing use contract", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-use-contract-test-"));
  assert.throws(
    () => captureKnowledge(home, { title: "Missing use contract", body: "evidence", scope: "work", sourceKind: "document", sourceRefs: ["src:test"], qualityVersion: 3, admissionReason: "reusable", applicability: "task", boundary: "bounded", confidenceBasis: ["source"] }),
    /use_when_missing/,
  );
  const record = captureKnowledge(home, {
    title: "Executable card",
    body: "evidence",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src:test"],
    qualityVersion: 3,
    admissionReason: "reusable",
    applicability: "task",
    boundary: "bounded",
    useWhen: "When a matching task starts",
    useInputs: ["task"],
    useOutputs: ["checklist"],
    useSteps: ["read", "check"],
    useChecks: ["evidence"],
    useStopConditions: ["missing evidence"],
    confidenceBasis: ["source"],
  });
  assert.deepEqual(record.useSteps, ["read", "check"]);
});

test("quality version 4 uses type-specific contracts instead of forcing facts into playbooks", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-v4-type-contract-test-"));
  const architecture = captureKnowledge(home, {
    title: "Typed architecture map",
    type: "fact",
    collection: "domains",
    body: "## 节点\n\nAPI、renderer、adaptor。\n\n## 边\n\nAPI → renderer → adaptor。",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src:architecture"],
    qualityVersion: 4,
    productType: "architecture_map",
    compilationRef: "/tmp/architecture-compilation.md",
    factRefs: ["f-node-api", "f-edge-renderer"],
    questionsAnswered: ["当前来源明确了哪些节点和边"],
    admissionReason: "保留来源里的架构节点与关系。",
    applicability: "架构范围判断。",
    boundary: "来源时点快照，不证明当前上线状态。",
    confidenceBasis: ["正式文档与图节点"],
  });
  assert.equal(architecture.productType, "architecture_map");
  assert.deepEqual(architecture.useSteps, []);
  const context = buildContextPack(home, { taskId: "task-v4", title: "架构", goal: "判断 renderer 链路", acceptance: "有事实引用", scope: "work" });
  assert.match(context.markdown, /Product type: architecture_map/);
  assert.match(context.markdown, /Fact refs: f-node-api; f-edge-renderer/);

  assert.throws(
    () => captureKnowledge(home, {
      title: "Playbook without procedure",
      type: "playbook",
      body: "只有一个结论。",
      scope: "work",
      sourceKind: "document",
      sourceRefs: ["src:playbook"],
      qualityVersion: 4,
      productType: "playbook",
      compilationRef: "/tmp/playbook-compilation.md",
      factRefs: ["f-step"],
      questionsAnswered: ["怎样执行"],
      admissionReason: "尝试形成执行卡。",
      applicability: "执行任务。",
      boundary: "缺步骤时不可用。",
      confidenceBasis: ["正式文档"],
    }),
    /use_when_missing.*use_steps_missing/s,
  );
});

test("quality version 5 binds the final Knowledge view to one loss-audited compilation product", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-v5-loss-contract-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "缺少低损耗绑定的知识",
      type: "fact",
      collection: "domains",
      body: "只有正文，没有来源清单、产品身份和信息损耗报告。",
      scope: "work",
      sourceKind: "document",
      sourceRefs: ["src:pricing"],
      qualityVersion: 5,
      productType: "domain_pack",
      compilationRef: "artifact-result",
      factRefs: ["f-object"],
      questionsAnswered: ["报价领域有哪些核心对象？"],
      admissionReason: "保留可复用领域事实。",
      applicability: "报价方案设计。",
      boundary: "不证明当前生产实现。",
      confidenceBasis: ["正式来源"],
    }),
    /canonical_key_missing.*compilation_schema_missing.*compilation_case_id_missing.*compilation_product_id_missing.*extraction_manifest_ref_missing.*information_loss_ref_missing/s,
  );

  const created = captureKnowledge(home, {
    title: "报价领域低损耗事实包",
    type: "fact",
    collection: "domains",
    body: "保留报价请求、报价方案、乘机人供给及其关系。",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src:pricing"],
    qualityVersion: 5,
    productType: "domain_pack",
    canonicalKey: "work:pricing:domain_pack:target-model",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "pricing-domain-01",
    compilationProductId: "p-domain",
    extractionManifestRef: "artifact-manifest",
    compilationRef: "artifact-result",
    informationLossRef: "artifact-fidelity",
    factRefs: ["f-object"],
    questionsAnswered: ["报价领域有哪些核心对象？"],
    admissionReason: "保留可复用领域事实。",
    applicability: "报价方案设计。",
    boundary: "不证明当前生产实现。",
    confidenceBasis: ["正式来源"],
  });
  const reloaded = listKnowledge(home, "work").find((record) => record.id === created.id);
  assert.ok(reloaded);
  assert.equal(reloaded.canonicalKey, "work:pricing:domain_pack:target-model");
  assert.equal(reloaded.compilationSchema, "ikb-knowledge-compilation-result.v3");
  assert.equal(reloaded.compilationCaseId, "pricing-domain-01");
  assert.equal(reloaded.compilationProductId, "p-domain");
  assert.equal(reloaded.extractionManifestRef, "artifact-manifest");
  assert.equal(reloaded.informationLossRef, "artifact-fidelity");
});

test("quality version 5 rejects duplicate active canonical keys and lint catches manual collisions", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-v5-canonical-collision-test-"));
  const base = {
    type: "fact",
    collection: "domains",
    body: "完整类型化知识正文。",
    scope: "work",
    sourceKind: "document",
    sourceRefs: ["src:pricing"],
    qualityVersion: 5,
    productType: "domain_pack",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "pricing-domain-01",
    extractionManifestRef: "artifact-manifest",
    compilationRef: "artifact-result",
    informationLossRef: "artifact-fidelity",
    factRefs: ["f-object"],
    questionsAnswered: ["报价领域有哪些核心对象？"],
    admissionReason: "保留可复用领域事实。",
    applicability: "报价方案设计。",
    boundary: "不证明当前生产实现。",
    confidenceBasis: ["正式来源"],
  } as const;
  const first = captureKnowledge(home, {
    ...base,
    title: "报价领域主事实包",
    canonicalKey: "work:pricing:domain_pack:target-model",
    compilationProductId: "p-domain",
  });
  assert.throws(
    () => captureKnowledge(home, {
      ...base,
      title: "重复报价领域事实包",
      canonicalKey: first.canonicalKey,
      compilationProductId: "p-domain-copy",
    }),
    /active canonical_key already belongs to/i,
  );

  const second = captureKnowledge(home, {
    ...base,
    title: "另一份领域事实包",
    canonicalKey: "work:pricing:domain_pack:another-boundary",
    compilationProductId: "p-domain-2",
  });
  const text = readFileSync(second.path, "utf8").replace(
    /canonical_key: .*$/m,
    `canonical_key: ${JSON.stringify(first.canonicalKey)}`,
  );
  writeFileSync(second.path, text, { mode: 0o600 });
  const inspection = inspectKnowledgeLayout(home, "work");
  assert.equal(inspection.ok, false);
  assert.equal(inspection.qualityIssues.filter((issue) => issue.code === "active_canonical_key_duplicate").length, 2);
});

test("quality version 4 evidence and safety metadata survive capture and reload", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-v4-metadata-roundtrip-test-"));
  const created = captureKnowledge(home, {
    title: "Reloadable domain fact pack",
    type: "fact",
    collection: "domains",
    body: "A bounded fact pack with explicit evidence and prohibited uses.",
    scope: "work",
    sourceKind: "artifact",
    sourceRefs: ["src:one", "src:two"],
    qualityVersion: 4,
    productType: "domain_pack",
    compilationRef: "/tmp/domain-compilation.md",
    factRefs: ["f-one"],
    questionsAnswered: ["What may the agent safely conclude?"],
    admissionReason: "The fact pack has a direct task consumer.",
    applicability: "Use for bounded domain analysis.",
    boundary: "Do not treat planned behavior as current production behavior.",
    confidenceBasis: ["two source records"],
    independentEpisodeCount: 2,
    independentSourceCount: 2,
    distinctDateCount: 2,
    counterevidenceRefs: ["src:counterexample"],
    counterevidenceSearch: "Checked the same domain and date window for conflicting evidence.",
    doNotUseFor: ["production rollout decisions"],
  });

  const reloaded = listKnowledge(home).find((record) => record.id === created.id);
  assert.ok(reloaded);
  assert.equal(reloaded.independentEpisodeCount, 2);
  assert.equal(reloaded.independentSourceCount, 2);
  assert.equal(reloaded.distinctDateCount, 2);
  assert.deepEqual(reloaded.counterevidenceRefs, ["src:counterexample"]);
  assert.equal(reloaded.counterevidenceSearch, "Checked the same domain and date window for conflicting evidence.");
  assert.deepEqual(reloaded.doNotUseFor, ["production rollout decisions"]);
});

test("quality version 4 person observation needs recurrence, source/date spread and prohibited uses", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-v4-person-contract-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "Two narrow person episodes",
      type: "preference",
      collection: "people",
      body: "两次窄场景发言。",
      scope: "work",
      sourceKind: "artifact",
      sourceRefs: ["artifact:person"],
      qualityVersion: 4,
      productType: "person_observation",
      compilationRef: "/tmp/person-compilation.md",
      factRefs: ["f-episode-1", "f-episode-2"],
      questionsAnswered: ["怎样准备沟通"],
      admissionReason: "尝试形成稳定观察。",
      applicability: "报价沟通。",
      boundary: "不推断人格。",
      confidenceBasis: ["两个 Episode"],
      identityConfidence: "high",
      patternConfidence: "medium",
      independentEpisodeCount: 2,
      independentSourceCount: 2,
      distinctDateCount: 2,
    }),
    /person_episode_count_insufficient.*person_do_not_use_for_missing.*person_counterevidence_search_missing/s,
  );
});

test("formal personal knowledge requires a traceable type-specific admission contract", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-personal-admission-contract-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "个人决策缺少准入合同",
      type: "decision",
      collection: "decisions",
      scope: "personal",
      sourceKind: "manual",
      qualityVersion: 4,
      productType: "decision_card",
      compilationRef: "artifact:decision-compilation",
      factRefs: ["fact:decision"],
      questionsAnswered: ["何时使用这项决定？"],
      confidence: "medium",
      confidenceBasis: ["本人记录"],
      temporalState: "current",
      body: "只保留决定正文，不提供来源和边界。",
    }),
    /personal_source_refs_missing.*personal_admission_reason_missing.*personal_applicability_missing.*personal_boundary_missing.*personal_decision_counterevidence_search_missing/s,
  );
  assert.equal(listKnowledge(home).length, 0);
});

test("formal personal preference cannot become verified from one isolated episode", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-personal-preference-gate-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "单次选择不能固化为偏好",
      type: "preference",
      collection: "concepts",
      scope: "personal",
      sourceKind: "ai_conversation",
      sourceRefs: ["src:preference-1"],
      status: "verified",
      qualityVersion: 4,
      productType: "preference_card",
      compilationRef: "artifact:preference-compilation",
      factRefs: ["fact:preference-1"],
      questionsAnswered: ["后续任务如何使用？"],
      admissionReason: "会改变后续任务的准备方式。",
      applicability: "需要准备个人工作输出时。",
      boundary: "不代表永久偏好，也不用于他人判断。",
      confidence: "medium",
      confidenceBasis: ["一个会话中的一次选择"],
      temporalState: "current",
      verification: "source_confirmed",
      independentEpisodeCount: 1,
      distinctDateCount: 1,
      body: "在一次会话中选择了某种输出方式。",
    }),
    /personal_preference_evidence_insufficient/,
  );
  assert.equal(listKnowledge(home).length, 0);
});

test("formal personal decision can be verified when its consumer contract and confirmation are explicit", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-personal-decision-admission-test-"));
  const record = captureKnowledge(home, {
    title: "个人决策有边界地进入知识库",
    type: "decision",
    collection: "decisions",
    scope: "personal",
    sourceKind: "manual",
    sourceRefs: ["user-confirmation:decision-1"],
    status: "verified",
    qualityVersion: 4,
    productType: "decision_card",
    compilationRef: "artifact:decision-compilation",
    factRefs: ["fact:decision-1"],
    questionsAnswered: ["什么时候采用这个决定？", "什么时候停止采用？"],
    admissionReason: "会改变后续任务的选择和准备动作。",
    applicability: "在个人工作流需要选择输出策略时。",
    boundary: "不适用于工作业务规则，也不代表永久有效。",
    confidence: "high",
    confidenceBasis: ["本人明确确认并写出适用边界"],
    temporalState: "current",
    verification: "user_confirmed",
    counterevidenceSearch: "检查了近期相反决定和失效条件，未发现冲突。",
    body: "在个人工作流中采用该策略；出现边界条件时停止并重新判断。",
  });
  assert.equal(record.status, "verified");
  assert.equal(record.verification, "user_confirmed");
});

test("legacy personal verified knowledge cannot bypass the formal admission version", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-personal-legacy-verified-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "旧个人知识",
      type: "fact",
      scope: "personal",
      sourceKind: "manual",
      sourceRefs: ["user-confirmation:legacy"],
      status: "verified",
      body: "旧格式没有类型化准入合同。",
    }),
    /personal_quality_version_insufficient/,
  );
});

test("legacy personal drafts remain readable but are not ready for verification or publication", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-personal-legacy-draft-test-"));
  const record = captureKnowledge(home, {
    title: "旧个人草稿",
    type: "fact",
    scope: "personal",
    body: "旧格式草稿仍可作为 advisory 上下文。",
  });
  assert.equal(record.status, "draft");
  assert.equal(isPersonalAdmissionReady(record), false);
});

test("knowledge quality gate rejects literal newline escapes before writing", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-literal-newline-test-"));
  assert.throws(
    () => captureKnowledge(home, { title: "Broken prose", body: "First line\\nSecond line." }),
    /literal_escaped_newline/,
  );
  assert.equal(listKnowledge(home).length, 0);
});

test("knowledge quality gate allows escaped newline tokens in inline and fenced code", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-code-newline-test-"));
  const record = captureKnowledge(home, {
    title: "Escaped newline syntax",
    body: [
      "Use `\\n` when documenting the token itself.",
      "",
      "```text",
      "first\\nsecond",
      "```",
    ].join("\n"),
  });
  assert.equal(record.id.startsWith("kb-"), true);
  assert.equal(inspectKnowledgeLayout(home).qualityIssues.length, 0);
});

test("source-derived knowledge requires an explicit admission contract", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-admission-test-"));
  assert.throws(
    () => captureKnowledge(home, {
      title: "Thin document summary",
      sourceKind: "document",
      sourceRefs: ["src-document:r1"],
      body: "The document mentioned a topic.",
    }),
    /admission_reason_missing.*applicability_missing.*boundary_missing/,
  );
  assert.equal(listKnowledge(home).length, 0);
});

test("short manual facts remain valid knowledge", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-short-manual-test-"));
  const record = captureKnowledge(home, { title: "Runtime", body: "IKB requires Node 22." });
  assert.equal(record.sourceKind, "manual");
  assert.equal(inspectKnowledgeLayout(home).qualityIssues.length, 0);
});

test("doctor inspection reports bad knowledge introduced by manual editing", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-edited-quality-test-"));
  const record = captureKnowledge(home, {
    title: "Review boundary",
    sourceKind: "document",
    sourceRefs: ["src-review:r1"],
    admissionReason: "The rule is reusable in later reviews.",
    applicability: "Apply to review conclusions backed by a reproducible failure.",
    boundary: "Do not generalize from an unverified opinion.",
    body: "Keep the evidence with the conclusion.",
  });
  writeFileSync(record.path, readFileSync(record.path, "utf8").replace("Keep the evidence with the conclusion.", "Broken\\nlayout."));
  const inspection = inspectKnowledgeLayout(home);
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.qualityIssues.map((issue) => issue.code), ["literal_escaped_newline"]);
  assert.equal(inspection.qualityIssues[0].knowledgeId, record.id);
});

test("legacy source-derived drafts stay readable but must pass current admission before verify", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-admission-test-"));
  initializeKnowledgeLayout(home, "work");
  const path = join(home, "vaults", "work", "concepts", "legacy-source.md");
  writeFileSync(path, [
    "---",
    "id: kb-legacy-source",
    "type: fact",
    "collection: concepts",
    "source_kind: document",
    "scope: work",
    "status: draft",
    "title: \"Legacy source note\"",
    "source_refs: [\"src-legacy:r1\"]",
    "tags: []",
    "aliases: [\"kb-legacy-source\"]",
    "related: []",
    "derived_from: []",
    "contradicts: []",
    "---",
    "Legacy content remains readable.",
    "",
  ].join("\n"));
  const legacy = listKnowledge(home, "work")[0];
  assert.equal(legacy.id, "kb-legacy-source");
  assert.equal(legacy.qualityVersion, 0);
  assert.equal(inspectKnowledgeLayout(home, "work").qualityIssues.length, 0);
  assert.throws(() => updateKnowledgeStatus(home, legacy.id, "verified"), /admission_reason_missing/);
  assert.equal(listKnowledge(home, "work")[0].status, "draft");
});

test("knowledge cannot become verified without a source", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-admission-test-"));
  const record = captureKnowledge(home, { title: "No source", body: "unverified", scope: "personal" });
  assert.throws(() => updateKnowledgeStatus(home, record.id, "verified"), /source_refs/);
});

test("knowledge relations use Obsidian wikilinks and preserve reciprocal semantics", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-relation-test-"));
  const source = captureKnowledge(home, { title: "Current rule", body: "Keep the current rule.", scope: "personal" });
  const target = captureKnowledge(home, { title: "Old rule", body: "The old rule.", scope: "personal" });

  const related = relateKnowledge(home, source.id, target.id, "related");
  assert.equal(related.changed, true);
  assert.deepEqual(related.source.related, [target.id]);
  assert.deepEqual(related.target.related, [source.id]);
  assert.match(readFileSync(source.path, "utf8"), new RegExp(`related:.*\\[\\[${target.id}\\|Old rule\\]\\]`));
  assert.match(readFileSync(source.path, "utf8"), new RegExp(`aliases:.*${source.id}`));

  const derived = relateKnowledge(home, source.id, target.id, "derived_from");
  assert.equal(derived.reciprocal, false);
  assert.deepEqual(derived.source.derivedFrom, [target.id]);
  assert.deepEqual(derived.target.derivedFrom, []);
  assert.equal(relateKnowledge(home, source.id, target.id, "related").changed, false);
});

test("cross-scope knowledge relations require explicit opt-in", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-cross-scope-relation-test-"));
  const personal = captureKnowledge(home, { title: "Personal", body: "personal", scope: "personal" });
  const work = captureKnowledge(home, { title: "Work", body: "work", scope: "work" });
  assert.throws(() => relateKnowledge(home, personal.id, work.id, "related"), /Cross-scope relation is blocked/);
  assert.equal(relateKnowledge(home, personal.id, work.id, "related", { allowCrossScope: true }).changed, true);
});

test("knowledge routes type and explicit collection into Obsidian collections", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-collection-test-"));
  const concept = captureKnowledge(home, { title: "Service fact", type: "fact", body: "A stable fact." });
  const person = captureKnowledge(home, { title: "Person fact", type: "fact", collection: "people", body: "A sourced person fact." });
  assert.match(concept.path, /\/concepts\//);
  assert.match(person.path, /\/people\//);
  assert.equal(person.collection, "people");
  assert.match(readFileSync(person.path, "utf8"), /collection: people/);
  assert.throws(() => captureKnowledge(home, { title: "Bad collection", collection: "misc", body: "invalid" }), /Knowledge collection/);
});

test("knowledge uses human-readable title filenames and keeps the stable id in frontmatter", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-human-filename-test-"));
  const record = captureKnowledge(home, { title: "示例系统演进评审卡", type: "playbook", body: "Use the review card." });
  assert.match(record.path, /示例系统演进评审卡\.md$/);
  assert.match(readFileSync(record.path, "utf8"), new RegExp(`id: ${record.id}`));
});

test("knowledge validates scope before any durable write", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-scope-validation-test-"));
  initializeKnowledgeLayout(home);
  assert.throws(() => captureKnowledge(home, { title: "Bad scope", scope: "typo", body: "must not persist" }), /personal or work/);
  assert.equal(listKnowledge(home).length, 0);
  assert.equal(inspectKnowledgeLayout(home).ok, true);
});

test("knowledge frontmatter quotes user-controlled scalar values", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-frontmatter-scalar-test-"));
  const record = captureKnowledge(home, {
    title: "Safe frontmatter",
    type: "fact\nid: injected-id",
    sourceKind: "manual\nscope: work",
    sensitivity: "private\nstatus: verified",
    body: "Scalar values cannot create new frontmatter keys.",
  });
  const text = readFileSync(record.path, "utf8");
  assert.match(text, /type: "fact\\nid: injected-id"/);
  assert.equal(/^id: injected-id$/m.test(text), false);
  assert.equal(listKnowledge(home, "personal")[0].id, record.id);
  assert.equal(listKnowledge(home, "personal")[0].status, "draft");
});

test("generated indexes are readable views and never become knowledge", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-index-test-"));
  initializeKnowledgeLayout(home);
  const record = captureKnowledge(home, { title: "Routing decision", type: "decision", body: "Use deterministic routing." });
  const first = listKnowledge(home).map((item) => item.id);
  rebuildKnowledgeViews(home);
  const second = listKnowledge(home).map((item) => item.id);
  assert.deepEqual(first, [record.id]);
  assert.deepEqual(second, first);
  assert.match(readFileSync(join(home, "vaults", "personal", "index.md"), "utf8"), /\[\[decisions\/index\|Decisions\]\]/);
  assert.match(readFileSync(join(home, "vaults", "personal", "decisions", "index.md"), "utf8"), /Routing decision/);
  assert.match(readFileSync(join(home, "governance", "personal", "status.md"), "utf8"), /Total: 1/);
  assert.equal(inspectKnowledgeLayout(home).ok, true);
});

test("generated Obsidian links sanitize nested wikilink titles", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-index-title-test-"));
  const record = captureKnowledge(home, { title: "Use [[wikilink]] | syntax", body: "Link-safe title." });
  const index = readFileSync(join(home, "vaults", "personal", "concepts", "index.md"), "utf8");
  assert.match(index, new RegExp(`\\[\\[[^|]+\\|Use wikilink / syntax\\]\\]`));
  assert.equal(index.includes(`|Use [[wikilink]]`), false);
  assert.match(index, /Use wikilink \/ syntax/);
});

test("legacy entries remain readable and migrate explicitly and idempotently", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-test-"));
  const legacyDirectory = join(home, "vaults", "personal", "entries");
  mkdirSync(legacyDirectory, { recursive: true });
  const legacyPath = join(legacyDirectory, "2026-07-16-kb-legacy.md");
  writeFileSync(legacyPath, [
    "---",
    "id: kb-legacy",
    "type: fact",
    "collection: people",
    "scope: personal",
    "status: draft",
    "title: \"Legacy person fact\"",
    "source_refs: [\"src-legacy\"]",
    "valid_from: 2026-07-16",
    "review_after: 2026-10-16",
    "tags: []",
    "aliases: [\"kb-legacy\"]",
    "related: []",
    "derived_from: []",
    "contradicts: []",
    "---",
    "Legacy evidence.",
    "",
  ].join("\n"));
  initializeKnowledgeLayout(home);
  assert.equal(listKnowledge(home, "personal")[0].id, "kb-legacy");
  assert.deepEqual(inspectKnowledgeLayout(home, "personal").legacyFiles, [legacyPath]);

  const migration = migrateLegacyKnowledge(home, "personal");
  const destination = join(home, "vaults", "personal", "people", "2026-07-16-kb-legacy.md");
  assert.equal(migration.moved.length, 1);
  assert.equal(migration.moved[0].collection, "people");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(destination), true);
  assert.match(readFileSync(destination, "utf8"), /collection: people/);
  assert.equal(listKnowledge(home, "personal")[0].path, destination);
  assert.equal(migrateLegacyKnowledge(home, "personal").moved.length, 0);
});

test("legacy migration refuses to overwrite an existing destination", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-collision-test-"));
  initializeKnowledgeLayout(home, "personal");
  const filename = "2026-07-16-kb-collision.md";
  const legacyPath = join(home, "vaults", "personal", "entries", filename);
  const destination = join(home, "vaults", "personal", "concepts", filename);
  mkdirSync(join(home, "vaults", "personal", "entries"), { recursive: true });
  writeFileSync(legacyPath, "---\nid: kb-collision\ntype: fact\nscope: personal\n---\nlegacy\n");
  writeFileSync(destination, "---\nid: kb-existing\ntype: fact\nscope: personal\n---\nexisting\n");
  assert.throws(() => migrateLegacyKnowledge(home, "personal"), /would overwrite/);
  assert.equal(readFileSync(legacyPath, "utf8").includes("legacy"), true);
  assert.equal(readFileSync(destination, "utf8").includes("existing"), true);
});

test("legacy migration preflights duplicate destination names before moving anything", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-duplicate-target-test-"));
  initializeKnowledgeLayout(home, "personal");
  const first = join(home, "vaults", "personal", "entries", "a", "same.md");
  const second = join(home, "vaults", "personal", "entries", "b", "same.md");
  mkdirSync(join(first, ".."), { recursive: true });
  mkdirSync(join(second, ".."), { recursive: true });
  writeFileSync(first, "---\nid: kb-first\ntype: fact\nscope: personal\n---\nfirst\n");
  writeFileSync(second, "---\nid: kb-second\ntype: fact\nscope: personal\n---\nsecond\n");
  assert.throws(() => migrateLegacyKnowledge(home, "personal"), /multiple legacy files/);
  assert.equal(existsSync(first), true);
  assert.equal(existsSync(second), true);
  assert.equal(existsSync(join(home, "vaults", "personal", "concepts", "same.md")), false);
});

test("legacy index.md remains readable and migrates away from generated index names", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-index-test-"));
  const legacyDirectory = join(home, "vaults", "personal", "entries");
  const legacyPath = join(legacyDirectory, "index.md");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(legacyPath, "---\nid: index\ntype: fact\nscope: personal\n---\nlegacy index knowledge\n");
  assert.equal(listKnowledge(home, "personal")[0].id, "index");
  const migration = migrateLegacyKnowledge(home, "personal");
  const destination = join(home, "vaults", "personal", "concepts", "legacy-index.md");
  assert.equal(migration.moved[0].to, destination);
  assert.equal(existsSync(destination), true);
  assert.equal(existsSync(join(home, "vaults", "personal", "concepts", "index.md")), true);
});

test("legacy index ids cannot escape their destination collection", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-legacy-index-traversal-test-"));
  initializeKnowledgeLayout(home);
  const legacyDirectory = join(home, "vaults", "personal", "entries");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "index.md"), "---\nid: ../../work/concepts/leak\ntype: fact\nscope: personal\n---\nunsafe id\n");
  const migration = migrateLegacyKnowledge(home, "personal");
  assert.match(migration.moved[0].to, /\/vaults\/personal\/concepts\/legacy-index-[a-f0-9]{16}\.md$/);
  assert.equal(existsSync(join(home, "vaults", "work", "concepts", "leak.md")), false);
});

test("migration journal makes moved files recoverable before ledger completion", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-migration-journal-test-"));
  initializeKnowledgeLayout(home, "personal");
  const legacyDirectory = join(home, "vaults", "personal", "entries");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "recover.md"), "---\nid: kb-recover\ntype: decision\nscope: personal\n---\nrecoverable\n");
  const first = migrateLegacyKnowledge(home, "personal", { deferCompletion: true });
  assert.ok(first.journalPath);
  assert.deepEqual(inspectKnowledgeLayout(home).pendingMigrationJournals, [first.journalPath]);
  const recovered = migrateLegacyKnowledge(home, "personal", { deferCompletion: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.moved[0].id, "kb-recover");
  completeKnowledgeMigration(recovered.journalPath!);
  assert.deepEqual(inspectKnowledgeLayout(home).pendingMigrationJournals, []);
});

test("migration recovery refuses journal paths outside the vault contract", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-migration-journal-path-test-"));
  initializeKnowledgeLayout(home, "personal");
  const legacyDirectory = join(home, "vaults", "personal", "entries");
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "recover.md"), "---\nid: kb-safe-journal\ntype: decision\nscope: personal\n---\nrecoverable\n");
  const first = migrateLegacyKnowledge(home, "personal", { deferCompletion: true });
  const journal = JSON.parse(readFileSync(first.journalPath!, "utf8"));
  const escapedPath = join(home, "outside.md");
  journal.items[0].to = escapedPath;
  writeFileSync(first.journalPath!, `${JSON.stringify(journal, null, 2)}\n`);
  assert.throws(() => migrateLegacyKnowledge(home, "personal", { deferCompletion: true }), /destination escapes its collection/);
  assert.equal(existsSync(escapedPath), false);
});

test("knowledge scanner ignores non-record Markdown and doctor reports it", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-invalid-note-test-"));
  initializeKnowledgeLayout(home);
  const note = join(home, "vaults", "personal", "concepts", "scratch.md");
  writeFileSync(note, "# Scratch\n\nThis is an Obsidian note, not an admitted knowledge record.\n");
  assert.equal(listKnowledge(home, "personal").length, 0);
  const inspection = inspectKnowledgeLayout(home, "personal");
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.invalidFiles, [note]);
});

test("invalid collection edits are quarantined instead of breaking doctor", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-invalid-collection-test-"));
  initializeKnowledgeLayout(home);
  const note = join(home, "vaults", "personal", "concepts", "bad-collection.md");
  writeFileSync(note, "---\nid: kb-bad-collection\ntype: fact\ncollection: misc\nscope: personal\n---\ninvalid collection\n");
  assert.equal(listKnowledge(home).length, 0);
  const inspection = inspectKnowledgeLayout(home);
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.invalidFiles, [note]);
});

test("duplicate knowledge ids are diagnosed and block ambiguous mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-duplicate-id-test-"));
  const personal = captureKnowledge(home, { title: "Personal duplicate", scope: "personal", body: "personal" });
  const work = captureKnowledge(home, { title: "Work duplicate", scope: "work", body: "work" });
  writeFileSync(work.path, readFileSync(work.path, "utf8").replace(/^id: .*$/m, `id: ${personal.id}`));
  const inspection = inspectKnowledgeLayout(home);
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.duplicateIds, [personal.id]);
  assert.throws(() => updateKnowledgeStatus(home, personal.id, "retired"), /Duplicate knowledge id/);
});

test("knowledge with a mismatched frontmatter scope is quarantined from its vault", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-scope-mismatch-test-"));
  initializeKnowledgeLayout(home);
  const path = join(home, "vaults", "work", "concepts", "mismatched.md");
  writeFileSync(path, "---\nid: kb-mismatched\ntype: fact\ncollection: concepts\nscope: personal\n---\nwrong vault\n");
  assert.equal(listKnowledge(home, "work").length, 0);
  const inspection = inspectKnowledgeLayout(home);
  assert.equal(inspection.ok, false);
  assert.deepEqual(inspection.scopeMismatchFiles, [path]);
});
