import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonObject } from "./contracts.ts";
import { arrayValue, objectValue, stringArray, stringValue } from "./validation.ts";

export interface RenderedCompilation {
  caseId: string;
  title: string;
  path: string;
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
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resultValues.flatMap((value) => {
    const result = objectValue(value);
    const caseId = stringValue(result?.case_id);
    const manifestCase = cases.get(caseId);
    if (!result || !caseId || !manifestCase) return [];
    const title = stringValue(manifestCase.title) || caseId;
    const path = join(directory, `${safeName(title)}-${safeName(caseId)}.md`);
    writeFileSync(path, renderCompilation(manifestCase, result), { mode: 0o600 });
    chmodSync(path, 0o600);
    return [{ caseId, title, path, disposition: stringValue(result.disposition) }];
  });
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

function renderProduct(product: JsonObject): string[] {
  const type = stringValue(product.product_type);
  const lines = [
    `### ${stringValue(product.title)}（${type}）`,
    "",
    `- 事实引用：${stringArray(product.fact_refs).map((ref) => `\`${ref}\``).join("、") || "无"}`,
    `- 回答问题：${stringArray(product.questions_answered).join("；")}`,
    `- 消费任务：${stringArray(product.consumer_tasks).join("；")}`,
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
  return [
    ...renderValueSection("实体", value.entities),
    ...renderValueSection("关系", value.relations),
    ...renderValueSection("规则", value.rules),
    ...renderValueSection("状态", value.states),
    ...renderValueSection("不变量", value.invariants),
  ];
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
