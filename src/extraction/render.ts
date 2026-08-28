import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXTRACTION_MANIFEST_VERSION, type JsonObject } from "./contracts.ts";
import { calculateInformationLossMetrics } from "./information-loss.ts";
import { arrayValue, objectValue, stringArray, stringValue } from "./validation.ts";

export interface RenderedCompilation {
  caseId: string;
  title: string;
  path: string;
  informationLossPath: string | null;
  disposition: string;
}

export function renderExtractionBatch(manifestValue: unknown, resultValues: unknown[], outputDirectory: string): RenderedCompilation[] {
  const manifest = objectValue(manifestValue);
  const cases = new Map(arrayValue(manifest?.cases).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.case_id);
    return row && id ? [[id, row] as const] : [];
  }));
  const directory = resolve(outputDirectory);
  const isV3 = stringValue(manifest?.schema) === EXTRACTION_MANIFEST_VERSION;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resultValues.flatMap((value) => {
    const result = objectValue(value);
    const caseId = stringValue(result?.case_id);
    const manifestCase = cases.get(caseId);
    if (!result || !caseId || !manifestCase) return [];
    const title = stringValue(manifestCase.title) || caseId;
    const baseName = `${safeName(title)}-${safeName(caseId)}`;
    const path = join(directory, `${baseName}.md`);
    writeFileSync(path, renderCompilation(manifestCase, result), { mode: 0o600 });
    chmodSync(path, 0o600);
    const informationLossPath = isV3 ? join(directory, `${baseName}-信息损耗报告.md`) : null;
    if (informationLossPath) {
      writeFileSync(informationLossPath, renderInformationLossReport(manifestCase, result), { mode: 0o600 });
      chmodSync(informationLossPath, 0o600);
    }
    return [{ caseId, title, path, informationLossPath, disposition: stringValue(result.disposition) }];
  });
}

export function renderInformationLossReport(manifestCase: JsonObject, result: JsonObject): string {
  const metrics = calculateInformationLossMetrics(manifestCase, result);
  const sourceUnits = objects(result.source_unit_dispositions);
  const referenceFacts = objects(result.reference_fact_dispositions);
  const claims = objects(result.claims);
  const questions = objects(result.question_results);
  const referenceById = new Map(objects(manifestCase.reference_facts).map((item) => [stringValue(item.reference_fact_id), item]));
  return [
    `# ${stringValue(manifestCase.title) || stringValue(result.case_id)}：信息损耗报告`,
    "",
    `- Case：\`${stringValue(result.case_id)}\``,
    `- 输入指纹：\`${stringValue(result.input_fingerprint)}\``,
    `- Source 字符数：${metrics.sourceCharacterCount ?? "未知"}`,
    `- Knowledge View 字符数：${metrics.knowledgeCharacterCount ?? "未知"}`,
    `- 文本压缩比：${percent(metrics.compressionRatio)}`,
    "",
    "## Source → Fact Package",
    "",
    `- 来源内容单元处置率：${percent(metrics.sourceUnitDispositionRate)}`,
    `- 来源内容单元实际抽取率：${percent(metrics.sourceUnitExtractionRate)}`,
    `- P0/P1 内容单元实际抽取率：${percent(metrics.materialSourceUnitExtractionRate)}`,
    `- 显式 blocked/unreadable 单元：${metrics.blockedSourceUnitCount}`,
    `- P0 关键事实召回率：${percent(metrics.coreFactRecall)}`,
    `- P1 重要事实处置率：${percent(metrics.supportingFactDispositionRate)}`,
    `- 未解释语义损耗：${percent(metrics.semanticLoss)}`,
    "",
    "| 来源单元 | 处置 | Evidence | Fact | 原因 |",
    "| --- | --- | --- | --- | --- |",
    ...sourceUnits.map((item) => `| ${cell(item.unit_id)} | ${cell(item.disposition)} | ${cell(stringArray(item.evidence_ids).join(", "))} | ${cell(stringArray(item.fact_refs).join(", "))} | ${cell(item.reason)} |`),
    "",
    "| 参考事实 | 重要性 | 处置 | Fact | 原因 |",
    "| --- | --- | --- | --- | --- |",
    ...referenceFacts.map((item) => {
      const reference = referenceById.get(stringValue(item.reference_fact_id));
      return `| ${cell(item.reference_fact_id)} | ${cell(reference?.importance)} | ${cell(item.disposition)} | ${cell(stringArray(item.fact_refs).join(", "))} | ${cell(item.reason)} |`;
    }),
    "",
    "## Fact Package → Knowledge View",
    "",
    `- 全部参考事实进入最终视图：${percent(metrics.viewFactRetention)}`,
    `- P0 参考事实进入最终视图：${percent(metrics.viewCoreFactRetention)}`,
    `- 任务问题覆盖率：${percent(metrics.questionCoverage)}`,
    `- 冲突暴露率：${percent(metrics.conflictExposure)}`,
    "",
    "| 问题 | 结果 | Fact | Product | 原因 |",
    "| --- | --- | --- | --- | --- |",
    ...questions.map((item) => `| ${cell(item.question_id)} | ${cell(item.disposition)} | ${cell(stringArray(item.fact_refs).join(", "))} | ${cell(stringArray(item.product_refs).join(", "))} | ${cell(item.reason)} |`),
    "",
    "## Knowledge View → Source",
    "",
    `- 主张支持精度：${percent(metrics.claimSupportPrecision)}`,
    "",
    "| 主张 | 支持状态 | Fact |",
    "| --- | --- | --- |",
    ...claims.map((item) => `| ${cell(item.claim_id)} | ${cell(item.support_status)} | ${cell(stringArray(item.fact_refs).join(", "))} |`),
    "",
    "## 失败项",
    "",
    ...lossRows(sourceUnits, referenceFacts, claims, questions),
    "",
  ].join("\n");
}

export function renderCompilation(manifestCase: JsonObject, result: JsonObject): string {
  const evidence = arrayValue(result.evidence_units).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const facts = arrayValue(result.facts).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const claims = arrayValue(result.claims).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const coverage = arrayValue(result.coverage).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const products = arrayValue(result.products).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const obligations = new Map(arrayValue(manifestCase.obligations).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.obligation_id);
    return row && id ? [[id, row] as const] : [];
  }));
  return [
    `# ${stringValue(manifestCase.title) || stringValue(result.case_id)}`,
    "",
    "## 编译结论",
    "",
    `- Case：\`${stringValue(result.case_id)}\``,
    `- 处置：\`${stringValue(result.disposition)}\``,
    `- 原因：${stringValue(result.disposition_reason)}`,
    `- 输入指纹：\`${stringValue(result.input_fingerprint)}\``,
    "",
    "## 证据片段",
    "",
    "| ID | 归因 | 时间 | 来源定位 | 原文片段 |",
    "| --- | --- | --- | --- | --- |",
    ...evidence.map((item) => `| ${cell(item.evidence_id)} | ${cell(`${stringValue(item.attribution_role)}:${stringValue(item.actor)}`)} | ${cell(item.occurred_at)} | ${cell(item.locator)} | ${cell(item.excerpt)} |`),
    "",
    "## 事实清单",
    "",
    "| ID | 类型 | 推导 | 时间状态 | 重要性 | 事实 | 证据 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...facts.map((item) => `| ${cell(item.fact_id)} | ${cell(item.fact_kind)} | ${cell(item.derivation)} | ${cell(item.temporal_state)} | ${cell(item.importance)} | ${cell(item.statement)} | ${cell(stringArray(item.evidence_ids).join(", "))} |`),
    "",
    "## 必答项覆盖",
    "",
    "| 必答项 | 重要性 | 结果 | 事实 | 原因 |",
    "| --- | --- | --- | --- | --- |",
    ...coverage.map((item) => {
      const obligation = obligations.get(stringValue(item.obligation_id));
      return `| ${cell(stringValue(obligation?.description) || item.obligation_id)} | ${cell(obligation?.importance)} | ${cell(item.disposition)} | ${cell(stringArray(item.fact_refs).join(", "))} | ${cell(item.reason)} |`;
    }),
    "",
    "## 主张与推导",
    "",
    ...(claims.length === 0 ? ["没有形成可发布主张。"] : claims.flatMap((item) => [
      `### ${stringValue(item.claim_id)} · ${stringValue(item.text)}`,
      "",
      `- 类型/时间：\`${stringValue(item.claim_kind)}\` / \`${stringValue(item.temporal_state)}\``,
      `- 事实引用：${stringArray(item.fact_refs).map((ref) => `\`${ref}\``).join("、")}`,
      `- 推导：${stringValue(item.reasoning)}`,
      `- 反证：${stringArray(item.counterevidence_fact_refs).length > 0 ? stringArray(item.counterevidence_fact_refs).map((ref) => `\`${ref}\``).join("、") : "未提供"}`,
      "",
    ])),
    "## 类型化知识视图",
    "",
    ...products.flatMap(renderProduct),
    "## 未知项",
    "",
    ...listOrNone(stringArray(result.unknowns)),
    "",
    "## 重新触发条件",
    "",
    ...listOrNone(stringArray(result.next_triggers)),
    "",
  ].join("\n");
}

/**
 * Materialize the exact consumer-facing body for one validated V3 product.
 * Curators may edit the structured compilation, but the final Knowledge body
 * is generated here so a polished summary cannot silently drop facts between
 * the fidelity report and the Vault.
 */
export function renderKnowledgeProductBody(resultValue: unknown, caseId: string, productId: string): string {
  const result = objectValue(resultValue);
  if (!result || stringValue(result.case_id) !== caseId) throw new Error(`Extraction result case not found: ${caseId}`);
  const product = objects(result.products).find((item) => stringValue(item.product_id) === productId);
  if (!product) throw new Error(`Extraction product not found in ${caseId}: ${productId}`);
  const factRefs = new Set(stringArray(product.fact_refs));
  const claimRefs = new Set(stringArray(product.claim_refs));
  const facts = objects(result.facts).filter((item) => factRefs.has(stringValue(item.fact_id)));
  const claims = objects(result.claims).filter((item) => claimRefs.has(stringValue(item.claim_id)));
  return [
    `# ${stringValue(product.title) || productId}`,
    "",
    "> 本文由已验证的结构化编译结果确定性生成。修改内容时必须先更新 Source/Fact Package，再重新生成并重跑信息损耗门禁。",
    "",
    "## 使用定位",
    "",
    `- 唯一身份：\`${stringValue(product.canonical_key)}\``,
    `- 非重复价值：${stringValue(product.unique_value)}`,
    `- 变更方式：\`${stringValue(product.operation)}\``,
    `- 回答问题：${stringArray(product.questions_answered).join("；") || "无"}`,
    `- 消费任务：${stringArray(product.consumer_tasks).join("；") || "无"}`,
    "",
    "## 直接可用事实",
    "",
    "| Fact | 时间状态 | 重要性 | 事实 | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...facts.map((item) => `| ${cell(item.fact_id)} | ${cell(item.temporal_state)} | ${cell(item.importance)} | ${cell(item.statement)} | ${cell(stringArray(item.evidence_ids).join(", "))} |`),
    "",
    "## 有依据的结论",
    "",
    ...(claims.length === 0 ? ["- 本视图不额外生成综合主张。"] : claims.flatMap((item) => [
      `### ${stringValue(item.text)}`,
      "",
      `- 主张：\`${stringValue(item.claim_id)}\``,
      `- 支持状态：\`${stringValue(item.support_status)}\``,
      `- 事实引用：${stringArray(item.fact_refs).map((ref) => `\`${ref}\``).join("、")}`,
      `- 推导：${stringValue(item.reasoning)}`,
      "",
    ])),
    "## 类型化知识视图",
    "",
    ...renderProduct(product),
    "## 当前未知与维护触发",
    "",
    "### 未知项",
    "",
    ...listOrNone(stringArray(result.unknowns)),
    "",
    "### 重新编译条件",
    "",
    ...listOrNone(stringArray(result.next_triggers)),
    "",
  ].join("\n");
}

function renderProduct(product: JsonObject): string[] {
  const type = stringValue(product.product_type);
  const lines = [
    `### ${stringValue(product.title)}（${type}）`,
    "",
    `- 事实引用：${stringArray(product.fact_refs).map((ref) => `\`${ref}\``).join("、") || "无"}`,
    `- 回答问题：${stringArray(product.questions_answered).join("；")}`,
    `- 消费任务：${stringArray(product.consumer_tasks).join("；")}`,
    ...(stringValue(product.canonical_key) ? [`- 唯一身份：\`${stringValue(product.canonical_key)}\``] : []),
    ...(stringValue(product.operation) ? [`- 变更方式：\`${stringValue(product.operation)}\``] : []),
    ...(stringValue(product.unique_value) ? [`- 非重复价值：${stringValue(product.unique_value)}`] : []),
    "",
  ];
  switch (type) {
    case "architecture_map":
      return [...lines, ...renderArchitecture(objectValue(product.architecture)), ...renderCommon(product)];
    case "domain_pack":
      return [...lines, ...renderDomain(objectValue(product.domain)), ...renderCommon(product)];
    case "entity_card":
      return [...lines, ...renderNamedObject("实体", objectValue(product.entity)), ...renderCommon(product)];
    case "flow_card":
      return [...lines, ...renderNamedObject("流程", objectValue(product.flow)), ...renderCommon(product)];
    case "decision_card":
      return [...lines, ...renderNamedObject("决策", objectValue(product.decision)), ...renderCommon(product)];
    case "principle_card":
      return [...lines, ...renderNamedObject("原则", objectValue(product.principle)), ...renderCommon(product)];
    case "playbook":
      return [...lines, ...renderNamedObject("执行合同", objectValue(product.procedure)), ...renderCommon(product)];
    case "person_evidence_view":
      return [...lines, ...renderPersonEvidence(objectValue(product.person_evidence)), ...renderCommon(product)];
    case "person_observation":
      return [...lines, ...renderNamedObject("人物观察", objectValue(product.observation)), ...renderCommon(product)];
    case "gap":
      return [...lines, ...renderNamedObject("缺口", objectValue(product.gap)), ...renderCommon(product)];
    default:
      return [...lines, ...renderNamedObject("详情", objectValue(product.details)), ...renderCommon(product)];
  }
}

function renderArchitecture(value: JsonObject | null): string[] {
  if (!value) return ["架构结构缺失。", ""];
  const nodes = arrayValue(value.nodes).flatMap((item) => objectValue(item) ? [objectValue(item)!] : []);
  const edges = arrayValue(value.edges).flatMap((item) => objectValue(item) ? [objectValue(item)!] : []);
  return [
    `- 版本/时点：${stringValue(value.version)} / ${stringValue(value.as_of)}`,
    "",
    "#### 节点",
    "",
    "| ID | 名称 | 层级 | 时间状态 |",
    "| --- | --- | --- | --- |",
    ...nodes.map((item) => `| ${cell(item.node_id)} | ${cell(item.name)} | ${cell(item.layer)} | ${cell(item.temporal_state)} |`),
    "",
    "#### 边",
    "",
    "| From | 关系 | To |",
    "| --- | --- | --- |",
    ...edges.map((item) => `| ${cell(item.from)} | ${cell(item.relation)} | ${cell(item.to)} |`),
    "",
  ];
}

function renderDomain(value: JsonObject | null): string[] {
  if (!value) return ["领域结构缺失。", ""];
  const known = new Set(["entities", "relations", "rules", "states", "invariants", "flows", "decisions", "gaps"]);
  return [
    ...renderValueSection("实体", value.entities),
    ...renderValueSection("关系", value.relations),
    ...renderValueSection("规则", value.rules),
    ...renderValueSection("状态", value.states),
    ...renderValueSection("不变量", value.invariants),
    ...renderStructuredCollection("流程", value.flows),
    ...renderStructuredCollection("决策", value.decisions),
    ...renderStructuredCollection("缺口", value.gaps),
    ...Object.entries(value).filter(([key]) => !known.has(key)).flatMap(([key, item]) => renderValueSection(key, item)),
  ];
}

function renderStructuredCollection(title: string, value: unknown): string[] {
  const rows = objects(value);
  if (rows.length === 0) return [];
  return rows.flatMap((row, index) => renderNamedObject(`${title} ${index + 1}`, row));
}

function renderPersonEvidence(value: JsonObject | null): string[] {
  if (!value) return ["人物证据结构缺失。", ""];
  return [
    `- 人物：${stringValue(value.person_id)}`,
    `- 时间范围：${stringValue(value.from)} → ${stringValue(value.to)}`,
    `- 身份证据：${stringArray(value.identity_refs).join("；")}`,
    `- 反证检索：${stringValue(value.counterevidence_search)}`,
    "",
    ...renderValueSection("时间线", value.timeline),
  ];
}

function renderNamedObject(title: string, value: JsonObject | null): string[] {
  if (!value) return [`${title}结构缺失。`, ""];
  return Object.entries(value).flatMap(([key, item]) => renderValueSection(key, item));
}

function renderValueSection(title: string, value: unknown): string[] {
  if (Array.isArray(value)) return [`#### ${title}`, "", ...listOrNone(value.map(renderValue)), ""];
  if (value && typeof value === "object") return [`#### ${title}`, "", "```json", JSON.stringify(value, null, 2), "```", ""];
  if (stringValue(value)) return [`#### ${title}`, "", stringValue(value), ""];
  return [];
}

function renderCommon(product: JsonObject): string[] {
  return [
    "#### 边界",
    "",
    ...listOrNone(stringArray(product.boundaries)),
    "",
    "#### 验证",
    "",
    ...listOrNone(stringArray(product.verification_plan)),
    "",
  ];
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function listOrNone(values: string[]): string[] {
  return values.length > 0 ? values.map((item) => `- ${item}`) : ["- 无"];
}

function objects(value: unknown): JsonObject[] {
  return arrayValue(value).flatMap((item) => objectValue(item) ? [objectValue(item)!] : []);
}

function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "不适用";
  const rounded = Math.round(value * 10_000) / 100;
  return `${rounded}%`;
}

function lossRows(
  sourceUnits: JsonObject[],
  referenceFacts: JsonObject[],
  claims: JsonObject[],
  questions: JsonObject[],
): string[] {
  const rows = [
    ...sourceUnits.filter((item) => ["unreadable", "blocked"].includes(stringValue(item.disposition))).map((item) => `- 来源单元 ${stringValue(item.unit_id)}：${stringValue(item.disposition)}，${stringValue(item.reason)}`),
    ...referenceFacts.filter((item) => ["gap", "conflicted", "lost"].includes(stringValue(item.disposition))).map((item) => `- 参考事实 ${stringValue(item.reference_fact_id)}：${stringValue(item.disposition)}，${stringValue(item.reason)}`),
    ...claims.filter((item) => stringValue(item.support_status) !== "supported").map((item) => `- 主张 ${stringValue(item.claim_id)}：${stringValue(item.support_status)}`),
    ...questions.filter((item) => stringValue(item.disposition) !== "answered").map((item) => `- 问题 ${stringValue(item.question_id)}：${stringValue(item.disposition)}，${stringValue(item.reason)}`),
  ];
  return rows.length > 0 ? rows : ["- 无"];
}

function cell(value: unknown): string {
  return stringValue(value).replaceAll("|", "\\|").replace(/\s+/gu, " ");
}

function safeName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96) || "知识编译";
}
