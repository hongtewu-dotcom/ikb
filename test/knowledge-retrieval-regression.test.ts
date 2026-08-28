import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildContextPack, captureKnowledge } from "../src/knowledge.ts";

interface RetrievalCase {
  id: string;
  taskType: string;
  title: string;
  goal: string;
  acceptance: string;
  includes?: string[];
  excludes?: string[];
  empty?: boolean;
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/knowledge-retrieval-cases.json", import.meta.url), "utf8")) as {
  schema: string;
  cases: RetrievalCase[];
};

function seedCorpus(home: string): void {
  captureKnowledge(home, {
    title: "IKB检索回归与效果评估",
    scope: "work",
    collection: "syntheses",
    body: "IKB 检索需要区分查询、引用、实际使用和效果反馈，并用固定 Case 验证 Context Pack 相关性。",
    useWhen: "评估 IKB、Agent 知识路由、Context Pack、知识使用效果或知识库改进方案时。",
    questionsAnswered: ["如何验证 IKB 检索效果？", "怎样建立知识召回回归集？", "怎样评审 IKB 检索实现？", "怎样评审 Context Pack 相关性和弱相关填充？"],
  });
  captureKnowledge(home, {
    title: "王嘉涛：Agent工具评估顺序（观察）",
    scope: "work",
    collection: "people",
    body: "评估 Agent 工具时，先验证可用性，再检查复用路径。",
    sourceRefs: ["src-person-episode-1", "src-person-episode-2", "src-person-episode-3"],
    qualityVersion: 4,
    productType: "person_observation",
    canonicalKey: "work:people:wangjiatao:observation:retrieval-regression",
    compilationRef: "artifact-person-compilation",
    factRefs: ["fact-person-pattern", "fact-person-episode-1", "fact-person-episode-2", "fact-person-episode-3"],
    questionsAnswered: ["评估 Agent 工具时先检查什么？", "工具复用路径怎样沟通？"],
    admissionReason: "三个独立 Episode 支持一条窄范围协作观察。",
    applicability: "准备 Agent 工具方案沟通时。",
    boundary: "只描述可观察顺序，不推断人格、能力或决策权。",
    useWhen: "准备 Agent 工具方案沟通、知识工具方案汇报或明确与王嘉涛协作时。",
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
  captureKnowledge(home, {
    title: "机票预订系统架构与依赖边界",
    scope: "work",
    collection: "domains",
    body: "预订架构包含入口、领域组件、下游依赖和验证边界。",
    useWhen: "编码或评审机票预订架构、拓扑、组件和依赖时。",
    questionsAnswered: ["预订系统有哪些架构依赖？"],
  });
  captureKnowledge(home, {
    title: "代码评审风险与验证作业卡",
    scope: "work",
    collection: "playbooks",
    body: "代码评审先检查行为变化、风险边界和验证证据。",
    useWhen: "执行代码评审、CR 或风险验证时。",
    questionsAnswered: ["代码评审怎样形成风险检查清单？"],
  });
  captureKnowledge(home, {
    title: "技术文档事实与边界写作卡",
    scope: "work",
    collection: "playbooks",
    body: "技术文档要分开当前事实、计划、未知和证据。",
    useWhen: "撰写技术文档或阶段效果说明时。",
    questionsAnswered: ["技术文档怎样保留事实边界？"],
  });
  captureKnowledge(home, {
    title: "IKB项目状态与改进路线",
    scope: "work",
    collection: "projects",
    body: "记录 IKB 当前阶段、主要问题、改进路线和验收指标。",
    useWhen: "查看 IKB 项目状态、改进路线或下一步时。",
    questionsAnswered: ["IKB 当前阶段和下一步是什么？"],
  });
  for (const [index, phrase] of ["月球轨道库存回放", "火星订单量子校验", "海底航班缓存协议", "卫星票台路由实验", "深空退款时序"].entries()) {
    captureKnowledge(home, {
      title: `无关资料-${index + 1}`,
      scope: "work",
      collection: "concepts",
      body: `${phrase} 只在正文中被旁路提到一次，不回答该问题。`,
    });
  }
}

test("knowledge retrieval regression suite keeps 30 task-routing cases stable", async (t) => {
  assert.equal(fixture.schema, "ikb-knowledge-retrieval-regression.v1");
  assert.equal(fixture.cases.length, 30);
  const home = mkdtempSync(join(tmpdir(), "ikb-retrieval-regression-"));
  seedCorpus(home);

  for (const current of fixture.cases) {
    await t.test(current.id, () => {
      const context = buildContextPack(home, {
        taskId: `task-${current.id}`,
        taskType: current.taskType,
        title: current.title,
        goal: current.goal,
        acceptance: current.acceptance,
        scope: "work",
        limit: 5,
      });
      const titles = context.results.map((item) => item.title);
      if (current.empty) assert.deepEqual(titles, []);
      for (const title of current.includes ?? []) assert.equal(titles.includes(title), true, `${current.id} should include ${title}; got ${titles.join(", ")}`);
      for (const title of current.excludes ?? []) assert.equal(titles.includes(title), false, `${current.id} should exclude ${title}; got ${titles.join(", ")}`);
    });
  }
});
