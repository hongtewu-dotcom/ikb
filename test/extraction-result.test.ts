import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderExtractionBatch,
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
