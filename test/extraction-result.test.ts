import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderExtractionBatch,
  renderKnowledgeProductBody,
  validateExtractionBatch,
  verifyExtractionBatch,
} from "../src/extraction-result.ts";

function sourceSnapshot(sourceId: string, content: string) {
  const directory = mkdtempSync(join(tmpdir(), "ikb-extraction-source-"));
  const path = join(directory, `${sourceId}.txt`);
  writeFileSync(path, content);
  return {
    source_id: sourceId,
    path,
    content_sha256: createHash("sha256").update(content).digest("hex"),
  };
}

const businessSourceContent = [
  "报价请求、报价方案与乘机人供给是不同对象。",
  "统一调用链路为 API 到 renderer 到 adaptor 到供应链系统。",
].join("\n");

const manifest = {
  schema: "ikb-knowledge-extraction-benchmark.v2",
  benchmark_id: "benchmark-test",
  cases: [
    {
      case_id: "business-01",
      category: "business_structure",
      title: "报价领域事实",
      input_fingerprint: "a".repeat(64),
      extraction_modes: ["domain_pack", "flow_entry"],
      source_ids: ["src-business"],
      source_snapshots: [sourceSnapshot("src-business", businessSourceContent)],
      consumer_tasks: ["方案", "排查"],
      obligations: [
        {
          obligation_id: "objects",
          description: "核心对象和关系是什么",
          importance: "core",
          required_product_types: ["domain_pack"],
        },
        {
          obligation_id: "flow",
          description: "真实主链路怎样流转",
          importance: "core",
          required_product_types: ["flow_card"],
        },
      ],
    },
  ],
};

function evidence(id: string, excerpt: string, overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: id,
    source_id: "src-business",
    record_id: "src-business:document:1",
    locator: "正文 20-40 行",
    excerpt,
    excerpt_sha256: createHash("sha256").update(excerpt).digest("hex"),
    attribution_role: "author",
    actor: "author01",
    occurred_at: "2026-04-14T09:33:35.000Z",
    ...overrides,
  };
}

function baseResult() {
  return {
    schema: "ikb-knowledge-compilation-result.v2",
    benchmark_id: "benchmark-test",
    case_id: "business-01",
    input_fingerprint: "a".repeat(64),
    extraction_modes: ["domain_pack", "flow_entry"],
    disposition: "admit",
    disposition_reason: "来源包含可复用对象、关系和真实链路",
    evidence_units: [
      evidence("ev-objects", "报价请求、报价方案与乘机人供给是不同对象。"),
      evidence("ev-flow", "统一调用链路为 API 到 renderer 到 adaptor 到供应链系统。"),
    ],
    facts: [
      {
        fact_id: "f-objects",
        fact_kind: "domain_relation",
        statement: "报价方案按乘机人与供给关系组织。",
        evidence_ids: ["ev-objects"],
        derivation: "direct",
        temporal_state: "planned",
        importance: "core",
      },
      {
        fact_id: "f-flow",
        fact_kind: "flow",
        statement: "目标调用链路是 API→renderer→adaptor→供应链系统。",
        evidence_ids: ["ev-flow"],
        derivation: "direct",
        temporal_state: "planned",
        importance: "core",
      },
    ],
    claims: [
      {
        claim_id: "c-model",
        text: "统一方案必须同时保留乘机人—供给关系和目标调用链。",
        claim_kind: "synthesis",
        fact_refs: ["f-objects", "f-flow"],
        counterevidence_fact_refs: [],
        reasoning: "对象关系约束模型，目标链路约束职责分布；两者缺一不可。",
        temporal_state: "planned",
      },
    ],
    coverage: [
      { obligation_id: "objects", disposition: "covered", fact_refs: ["f-objects"], reason: "" },
      { obligation_id: "flow", disposition: "covered", fact_refs: ["f-flow"], reason: "" },
    ],
    products: [
      {
        product_id: "p-domain",
        product_type: "domain_pack",
        title: "报价领域对象",
        fact_refs: ["f-objects"],
        claim_refs: ["c-model"],
        consumer_tasks: ["报价方案"],
        questions_answered: ["对象和关系是什么"],
        boundaries: ["目标模型仍需当前代码核验"],
        verification_plan: ["对照当前 IDL 和代码"],
        domain: {
          entities: ["报价方案", "乘机人", "供给"],
          relations: ["报价方案按乘机人关联一个或多个供给"],
          rules: [],
          states: ["planned"],
          invariants: ["乘机人和供给关系不能在组合时丢失"],
        },
      },
      {
        product_id: "p-flow",
        product_type: "flow_card",
        title: "目标报价主链路",
        fact_refs: ["f-flow"],
        claim_refs: ["c-model"],
        consumer_tasks: ["链路影响分析"],
        questions_answered: ["目标主链路怎样流转"],
        boundaries: ["这是目标链路，不证明当前已上线"],
        verification_plan: ["对照当前入口、调用和发布状态"],
        flow: {
          trigger: "报价查询请求",
          nodes: ["API", "renderer", "adaptor", "供应链系统"],
          edges: ["API→renderer", "renderer→adaptor", "adaptor→供应链系统"],
          exceptions: ["当前代码仍可能存在旧链路"],
          recovery: ["发现旧链路时保留 Gap，不臆测迁移完成"],
        },
      },
    ],
    unknowns: ["当前上线范围"],
    next_triggers: ["当前代码或发布状态变化时重跑"],
  };
}

function v3Manifest() {
  const next = structuredClone(manifest);
  next.schema = "ikb-knowledge-extraction-benchmark.v3";
  next.cases[0].source_units = [
    {
      unit_id: "u-objects",
      source_id: "src-business",
      unit_kind: "paragraph",
      locator: "第 1 行",
      content: "报价请求、报价方案与乘机人供给是不同对象。",
      content_sha256: createHash("sha256").update("报价请求、报价方案与乘机人供给是不同对象。").digest("hex"),
      importance: "core",
    },
    {
      unit_id: "u-flow",
      source_id: "src-business",
      unit_kind: "paragraph",
      locator: "第 2 行",
      content: "统一调用链路为 API 到 renderer 到 adaptor 到供应链系统。",
      content_sha256: createHash("sha256").update("统一调用链路为 API 到 renderer 到 adaptor 到供应链系统。").digest("hex"),
      importance: "core",
    },
  ];
  next.cases[0].reference_facts = [
    {
      reference_fact_id: "rf-objects",
      statement: "报价请求、报价方案与乘机人供给是不同对象。",
      importance: "core",
      source_unit_refs: ["u-objects"],
      question_refs: ["q-objects"],
    },
    {
      reference_fact_id: "rf-flow",
      statement: "统一调用链路为 API 到 renderer 到 adaptor 到供应链系统。",
      importance: "core",
      source_unit_refs: ["u-flow"],
      question_refs: ["q-flow"],
    },
  ];
  next.cases[0].questions = [
    {
      question_id: "q-objects",
      text: "报价领域有哪些核心对象和关系？",
      importance: "core",
      required_product_types: ["domain_pack"],
    },
    {
      question_id: "q-flow",
      text: "目标报价主链路怎样流转？",
      importance: "core",
      required_product_types: ["flow_card"],
    },
  ];
  next.cases[0].existing_knowledge = [];
  return next;
}

function v3Result() {
  const next = structuredClone(baseResult());
  next.schema = "ikb-knowledge-compilation-result.v3";
  next.evidence_units[0].source_unit_refs = ["u-objects"];
  next.evidence_units[1].source_unit_refs = ["u-flow"];
  next.facts[0].reference_fact_refs = ["rf-objects"];
  next.facts[1].reference_fact_refs = ["rf-flow"];
  next.claims[0].support_status = "supported";
  next.source_unit_dispositions = [
    { unit_id: "u-objects", disposition: "extracted", evidence_ids: ["ev-objects"], fact_refs: ["f-objects"], reason: "保留领域对象" },
    { unit_id: "u-flow", disposition: "extracted", evidence_ids: ["ev-flow"], fact_refs: ["f-flow"], reason: "保留目标链路" },
  ];
  next.reference_fact_dispositions = [
    { reference_fact_id: "rf-objects", disposition: "preserved", fact_refs: ["f-objects"], reason: "原义保留" },
    { reference_fact_id: "rf-flow", disposition: "preserved", fact_refs: ["f-flow"], reason: "原义保留" },
  ];
  next.products[0].canonical_key = "work:pricing:domain_pack:target-model";
  next.products[0].operation = "new";
  next.products[0].question_refs = ["q-objects"];
  next.products[0].unique_value = "保留报价领域对象及关系";
  next.products[1].canonical_key = "work:pricing:flow_card:target-chain";
  next.products[1].operation = "new";
  next.products[1].question_refs = ["q-flow"];
  next.products[1].unique_value = "提供可独立检索和验证的目标调用链";
  next.question_results = [
    { question_id: "q-objects", disposition: "answered", fact_refs: ["f-objects"], product_refs: ["p-domain"], reason: "领域包直接回答" },
    { question_id: "q-flow", disposition: "answered", fact_refs: ["f-flow"], product_refs: ["p-flow"], reason: "流程卡直接回答" },
  ];
  return next;
}

test("v3 verifier measures a lossless compilation against frozen source facts", () => {
  const report = verifyExtractionBatch(v3Manifest(), [v3Result()]);
  assert.equal(report.valid, true);
  assert.equal(report.verdicts[0].publishable, true);
  assert.equal(report.verdicts[0].checks.sourceCompleteness, true);
  assert.equal(report.verdicts[0].checks.informationLoss, true);
  assert.equal(report.verdicts[0].checks.minimalSufficiency, true);
  assert.deepEqual(report.verdicts[0].metrics, {
    sourceUnitDispositionRate: 1,
    sourceUnitExtractionRate: 1,
    materialSourceUnitExtractionRate: 1,
    blockedSourceUnitCount: 0,
    coreFactRecall: 1,
    supportingFactDispositionRate: 1,
    viewFactRetention: 1,
    viewCoreFactRetention: 1,
    claimSupportPrecision: 1,
    questionCoverage: 1,
    conflictExposure: 1,
    semanticLoss: 0,
    sourceCharacterCount: businessSourceContent.length,
    knowledgeCharacterCount: JSON.stringify(v3Result().products).length,
    compressionRatio: JSON.stringify(v3Result().products).length / businessSourceContent.length,
  });
});

test("v3 product view deterministically materializes the exact task-facing facts and structure", () => {
  const result = v3Result();
  const first = renderKnowledgeProductBody(result, "business-01", "p-domain");
  const second = renderKnowledgeProductBody(structuredClone(result), "business-01", "p-domain");
  assert.equal(second, first);
  assert.match(first, /work:pricing:domain_pack:target-model/);
  assert.match(first, /保留报价领域对象及关系/);
  assert.match(first, /报价方案按乘机人与供给关系组织/);
  assert.match(first, /乘机人和供给关系不能在组合时丢失/);
  assert.match(first, /目标模型仍需当前代码核验/);
  assert.doesNotMatch(first, /目标调用链路是 API→renderer/);
});

test("v3 verifier rejects a source unit that has no explicit disposition", () => {
  const result = v3Result();
  result.source_unit_dispositions = result.source_unit_dispositions.slice(0, 1);
  const report = verifyExtractionBatch(v3Manifest(), [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "source_unit_disposition_missing"), true);
  assert.equal(report.verdicts[0].checks.sourceCompleteness, false);
});

test("v3 admits an explicitly blocked supporting visual but rejects a blocked core visual", () => {
  const supportingManifest = v3Manifest();
  supportingManifest.cases[0].source_units.push({
    unit_id: "u-screenshot",
    source_id: "src-business",
    unit_kind: "image",
    locator: "附图 1",
    content: "报价请求、报价方案与乘机人供给是不同对象。",
    content_sha256: createHash("sha256").update("报价请求、报价方案与乘机人供给是不同对象。").digest("hex"),
    importance: "supporting",
  });
  const supportingResult = v3Result();
  supportingResult.source_unit_dispositions.push({
    unit_id: "u-screenshot",
    disposition: "blocked",
    evidence_ids: [],
    fact_refs: [],
    reason: "视觉原件尚未进入当前只读快照，显式保留为P1缺口。",
  });
  const supportingReport = verifyExtractionBatch(supportingManifest, [supportingResult]);
  assert.equal(supportingReport.valid, true);
  assert.equal(supportingReport.verdicts[0].publishable, true);
  assert.equal(supportingReport.verdicts[0].metrics.sourceUnitDispositionRate, 1);
  assert.equal(supportingReport.verdicts[0].metrics.sourceUnitExtractionRate, 2 / 3);
  assert.equal(supportingReport.verdicts[0].metrics.blockedSourceUnitCount, 1);

  supportingManifest.cases[0].source_units.at(-1).importance = "core";
  const coreReport = verifyExtractionBatch(supportingManifest, [supportingResult]);
  assert.equal(coreReport.valid, false);
  assert.equal(coreReport.issues.some((item) => item.code === "source_unit_material_unresolved"), true);
});

test("v3 hashes frozen source-unit bytes without trimming JSON or code indentation", () => {
  const currentManifest = v3Manifest();
  const indented = "  \"content\": \"必须保留原始缩进\"";
  currentManifest.cases[0].source_snapshots = [sourceSnapshot("src-business", `${businessSourceContent}\n${indented}`)];
  currentManifest.cases[0].source_units.push({
    unit_id: "u-indented-json",
    source_id: "src-business",
    unit_kind: "comment",
    locator: "JSON 第 3 行",
    content: indented,
    content_sha256: createHash("sha256").update(indented).digest("hex"),
    importance: "supporting",
  });
  const result = v3Result();
  result.source_unit_dispositions.push({
    unit_id: "u-indented-json",
    disposition: "context_only",
    evidence_ids: [],
    fact_refs: [],
    reason: "仅用于解释来源格式。",
  });
  const report = verifyExtractionBatch(currentManifest, [result]);
  assert.equal(report.valid, true);
});

test("v3 verifier reports and blocks a lost core fact", () => {
  const result = v3Result();
  result.reference_fact_dispositions[1] = {
    reference_fact_id: "rf-flow",
    disposition: "lost",
    fact_refs: [],
    reason: "编译时遗漏目标主链路",
  };
  result.facts[1].reference_fact_refs = [];
  const report = verifyExtractionBatch(v3Manifest(), [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "information_loss_core_fact_lost"), true);
  assert.equal(report.verdicts[0].metrics.coreFactRecall, 0.5);
  assert.equal(report.verdicts[0].metrics.semanticLoss > 0, true);
});

test("v3 verifier rejects a material claim that is not fully supported", () => {
  const result = v3Result();
  result.claims[0].support_status = "partially_supported";
  const report = verifyExtractionBatch(v3Manifest(), [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "claim_support_status_not_supported"), true);
  assert.equal(report.verdicts[0].metrics.claimSupportPrecision, 0);
});

test("v3 verifier rejects an unanswered core consumer question", () => {
  const result = v3Result();
  result.question_results[1] = {
    question_id: "q-flow",
    disposition: "gap",
    fact_refs: [],
    product_refs: [],
    reason: "流程信息没有进入消费者视图",
  };
  const report = verifyExtractionBatch(v3Manifest(), [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "question_core_unanswered"), true);
  assert.equal(report.verdicts[0].metrics.questionCoverage, 0.5);
});

test("v3 validator prevents two active products from sharing one canonical key", () => {
  const result = v3Result();
  result.products[1].canonical_key = result.products[0].canonical_key;
  const report = validateExtractionBatch(v3Manifest(), [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "canonical_key_duplicate"), true);
});

test("v2 compilations remain auditable but cannot publish new knowledge", () => {
  const report = verifyExtractionBatch(manifest, [baseResult()]);
  assert.equal(report.valid, true);
  assert.equal(report.verdicts[0].legacy, true);
  assert.equal(report.verdicts[0].publishable, false);
  assert.equal(report.verdicts[0].checks.informationLoss, false);
});

test("v2 validator rejects a polished headline without fact inventory and type structure", () => {
  const result = baseResult();
  result.evidence_units[0].excerpt_sha256 = "bad";
  result.products = [{
    product_id: "p-domain",
    product_type: "domain_pack",
    title: "链路需要统一",
    fact_refs: ["f-objects"],
    claim_refs: ["c-model"],
    consumer_tasks: ["方案"],
    questions_answered: ["怎么办"],
    boundaries: ["未知"],
    verification_plan: ["以后验证"],
  }] as typeof result.products;

  const report = validateExtractionBatch(manifest, [result]);
  const codes = new Set(report.issues.map((item) => item.code));
  assert.equal(report.valid, false);
  assert.equal(codes.has("evidence_hash_mismatch"), true);
  assert.equal(codes.has("domain_missing"), true);
  assert.equal(codes.has("mode_product_missing"), true);
});

test("v2 validator accepts a fact-backed typed compilation", () => {
  const report = validateExtractionBatch(manifest, [baseResult()]);
  assert.equal(report.valid, true);
  assert.deepEqual(report.issues, []);
});

test("fidelity verifier rejects core coverage supported only by inference", () => {
  const result = baseResult();
  result.facts[0].derivation = "inference";
  const report = verifyExtractionBatch(manifest, [result]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "core_coverage_inference_only"), true);
  assert.equal(report.verdicts[0].publishable, false);
});

test("person observation needs semantic recurrence, sources, dates, and counterevidence scope", () => {
  const personManifest = {
    schema: "ikb-knowledge-extraction-benchmark.v2",
    benchmark_id: "person-test",
    cases: [{
      case_id: "person-01",
      title: "人物窄样本",
      category: "person",
      input_fingerprint: "b".repeat(64),
      extraction_modes: ["person"],
      source_ids: ["src-chat", "src-comment"],
      source_snapshots: [
        sourceSnapshot("src-chat", "二次什么场景呀"),
        sourceSnapshot("src-comment", "先提升通过率"),
      ],
      obligations: [{
        obligation_id: "stable-pattern",
        description: "是否存在跨场景稳定观察",
        importance: "core",
      }],
    }],
  };
  const ev1 = evidence("ev-chat", "二次什么场景呀", { source_id: "src-chat", record_id: "src-chat:1", attribution_role: "speaker" });
  const ev2 = evidence("ev-comment", "先提升通过率", { source_id: "src-comment", record_id: "src-comment:1", attribution_role: "reviewer", occurred_at: "2025-06-11T02:00:00Z" });
  const personResult = {
    schema: "ikb-knowledge-compilation-result.v2",
    benchmark_id: "person-test",
    case_id: "person-01",
    input_fingerprint: "b".repeat(64),
    extraction_modes: ["person"],
    disposition: "admit",
    disposition_reason: "两段话看起来相似",
    evidence_units: [ev1, ev2],
    facts: [{
      fact_id: "f-person",
      fact_kind: "person_episode",
      statement: "两段窄场景发言都涉及口径。",
      evidence_ids: ["ev-chat", "ev-comment"],
      derivation: "synthesis",
      temporal_state: "current",
      importance: "core",
    }],
    claims: [{
      claim_id: "c-person",
      text: "此人总是先收敛口径。",
      claim_kind: "inference",
      fact_refs: ["f-person"],
      counterevidence_fact_refs: [],
      reasoning: "把两段窄场景发言扩成稳定模式。",
      temporal_state: "current",
    }],
    coverage: [{ obligation_id: "stable-pattern", disposition: "covered", fact_refs: ["f-person"], reason: "" }],
    products: [{
      product_id: "p-person",
      product_type: "person_observation",
      title: "稳定沟通观察",
      fact_refs: ["f-person"],
      claim_refs: ["c-person"],
      consumer_tasks: ["沟通"],
      questions_answered: ["怎样准备材料"],
      boundaries: ["不推断人格"],
      verification_plan: ["下次观察"],
      observation: {
        person_id: "person01",
        view: "communication_contract",
        pattern: "先收敛口径",
        trigger: "评审",
        response_shape: "先问场景",
        usable_for: ["报价问题"],
        do_not_use_for: ["绩效评价"],
        identity_confidence: "high",
        pattern_confidence: "medium",
        counterevidence_search: "检索当前两个来源",
        episodes: [
          { episode_ref: "chat-1", source_id: "src-chat", date: "2026-04-14", semantic_basis: "追问场景", evidence_ids: ["ev-chat"] },
          { episode_ref: "comment-1", source_id: "src-comment", date: "2025-06-11", semantic_basis: "指标排序", evidence_ids: ["ev-comment"] },
        ],
      },
    }],
    unknowns: ["是否跨场景重复"],
    next_triggers: ["出现第三个独立 Episode 时重跑"],
  };
  const report = verifyExtractionBatch(personManifest, [personResult]);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "person_episode_count_insufficient"), true);
  assert.equal(report.verdicts[0].checks.personSelectivity, false);
});

test("legitimate person abstention retains the timeline without publishing an observation", () => {
  const personManifest = {
    schema: "ikb-knowledge-extraction-benchmark.v2",
    benchmark_id: "person-skip-test",
    cases: [{
      case_id: "person-01",
      title: "人物证据视图",
      category: "person",
      input_fingerprint: "c".repeat(64),
      extraction_modes: ["person"],
      source_ids: ["src-chat"],
      source_snapshots: [sourceSnapshot("src-chat", "二次什么场景呀")],
      obligations: [{
        obligation_id: "stable-pattern",
        description: "是否存在稳定观察",
        importance: "core",
      }],
    }],
  };
  const ev = evidence("ev-chat", "二次什么场景呀", { source_id: "src-chat", record_id: "src-chat:1", attribution_role: "speaker" });
  const result = {
    schema: "ikb-knowledge-compilation-result.v2",
    benchmark_id: "person-skip-test",
    case_id: "person-01",
    input_fingerprint: "c".repeat(64),
    extraction_modes: ["person"],
    disposition: "skip",
    disposition_reason: "只有一个窄场景 Episode，不形成稳定观察",
    evidence_units: [ev],
    facts: [{
      fact_id: "f-episode",
      fact_kind: "person_episode",
      statement: "在一次验价排查中追问了二次验价场景。",
      evidence_ids: ["ev-chat"],
      derivation: "direct",
      temporal_state: "historical",
      importance: "context",
    }],
    claims: [],
    coverage: [{
      obligation_id: "stable-pattern",
      disposition: "unknown",
      fact_refs: ["f-episode"],
      reason: "Episode 数量和场景独立性不足",
    }],
    products: [{
      product_id: "p-evidence",
      product_type: "person_evidence_view",
      title: "人物证据时间线",
      fact_refs: ["f-episode"],
      claim_refs: [],
      consumer_tasks: ["后续周期蒸馏"],
      questions_answered: ["当前有什么直接证据"],
      boundaries: ["不能形成稳定画像"],
      verification_plan: ["新增独立 Episode 后重建"],
      person_evidence: {
        person_id: "person01",
        identity_refs: ["senderMis:person01"],
        from: "2026-04-14",
        to: "2026-04-14",
        counterevidence_search: "仅检索冻结输入，未发现反例；不等于证明没有反例",
        timeline: [{ date: "2026-04-14", evidence_id: "ev-chat", observation: "追问具体场景" }],
      },
    }],
    unknowns: ["是否在其他任务重复出现"],
    next_triggers: ["新增三个独立 Episode 时重跑"],
  };
  const report = verifyExtractionBatch(personManifest, [result]);
  assert.equal(report.valid, true);
  assert.equal(report.retainedOnlyCount, 1);
  assert.equal(report.verdicts[0].publishable, false);
});

test("renderer keeps the fact inventory in a human-readable Chinese file", () => {
  const output = mkdtempSync(join(tmpdir(), "ikb-extraction-"));
  const rendered = renderExtractionBatch(manifest, [baseResult()], output);
  assert.match(rendered[0].path, /报价领域事实-business-01\.md$/);
  const markdown = readFileSync(rendered[0].path, "utf8");
  assert.match(markdown, /## 事实清单/);
  assert.match(markdown, /报价方案按乘机人与供给关系组织/);
  assert.match(markdown, /API→renderer→adaptor→供应链系统/);
});

test("v3 renderer writes a separate human-readable information loss report", () => {
  const output = mkdtempSync(join(tmpdir(), "ikb-extraction-loss-"));
  const rendered = renderExtractionBatch(v3Manifest(), [v3Result()], output);
  assert.match(rendered[0].informationLossPath, /报价领域事实-business-01-信息损耗报告\.md$/);
  const markdown = readFileSync(rendered[0].informationLossPath, "utf8");
  assert.match(markdown, /## Source → Fact Package/);
  assert.match(markdown, /P0 关键事实召回率.*100%/);
  assert.match(markdown, /主张支持精度.*100%/);
  assert.match(markdown, /未解释语义损耗.*0%/);
});

test("renderer sanitizes frozen case ids before constructing a file path", () => {
  const output = mkdtempSync(join(tmpdir(), "ikb-extraction-path-"));
  const unsafeCaseId = "../../../escaped";
  const unsafeManifest = structuredClone(manifest);
  unsafeManifest.cases[0].case_id = unsafeCaseId;
  const unsafeResult = baseResult();
  unsafeResult.case_id = unsafeCaseId;

  const rendered = renderExtractionBatch(unsafeManifest, [unsafeResult], output);
  assert.equal(rendered[0].path.startsWith(`${output}/`), true);
  assert.match(rendered[0].path, /报价领域事实-escaped\.md$/);
});

test("v2 validator requires every frozen case exactly once", () => {
  const report = validateExtractionBatch(manifest, []);
  assert.equal(report.valid, false);
  assert.equal(report.issues.some((item) => item.code === "case_missing"), true);
});
