import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveRetiredKnowledge, captureKnowledge, buildContextPack, completeKnowledgeMigration, ingestKnowledge, initializeKnowledgeLayout, inspectKnowledgeLayout, isPersonalAdmissionReady, listKnowledge, migrateLegacyKnowledge, rebuildKnowledgeViews, relateKnowledge, searchKnowledge, reviewKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";

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
  const draft = captureKnowledge(home, { title: "Draft note", body: "technical plan source", scope: "personal", status: "draft" });
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
  assert.match(context.markdown, /Draft note/);
  assert.match(context.markdown, /Verified plan rule/);
  const strict = buildContextPack(home, { taskId: "task-1", title: "plan", goal: "technical plan", acceptance: "source", includeDrafts: false });
  assert.equal(strict.results.length, 1);
  assert.equal(strict.results[0].id, verified.id);
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
