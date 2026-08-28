import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKnowledge } from "../src/knowledge.ts";
import { addSourceAliases, buildSourceReceipt, inspectSourceAliasRegistry, lookupSources } from "../src/source-query.ts";
import { importSource } from "../src/source.ts";

test("Source lookup resolves title, Citadel URL and explicit business alias", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-query-"));
  const input = join(home, "2782466796.md");
  writeFileSync(input, "# 模型越来越强，harness该留下什么？\n");
  const source = importSource(home, input, { kind: "document", scope: "work", title: "模型越来越强，harness该留下什么？" }).source;
  addSourceAliases(home, source.id, ["Harness 原则文章", "Agent 治理参考"]);

  assert.equal(lookupSources(home, "模型越来越强，harness该留下什么？", { scope: "work" })[0].source.id, source.id);
  const byUrl = lookupSources(home, "https://km.sankuai.com/collabpage/2782466796", { scope: "work" })[0];
  assert.equal(byUrl.source.id, source.id);
  assert.equal(byUrl.matches.includes("content_id"), true);
  const byAlias = lookupSources(home, "harness 原则文章", { scope: "work" })[0];
  assert.equal(byAlias.source.id, source.id);
  assert.equal(byAlias.matches.includes("alias"), true);
  assert.deepEqual(inspectSourceAliasRegistry(home).issues, []);
});

test("Source receipt distinguishes stored evidence from default-eligible Knowledge", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-receipt-"));
  const input = join(home, "integration-guide.md");
  writeFileSync(input, "# 接入文档\n\n先保存证据。\n");
  const source = importSource(home, input, { kind: "document", scope: "work", title: "接入文档" }).source;

  const sourceOnly = buildSourceReceipt(home, source);
  assert.equal(sourceOnly.knowledgeStatus, "none");
  assert.equal(sourceOnly.notice, "仅 Source，未准入为知识");

  const draft = captureKnowledge(home, {
    title: "接入文档摘要",
    type: "fact",
    sourceKind: "document",
    scope: "work",
    sourceRefs: [source.id],
    admissionReason: "为接入任务提供稳定说明。",
    applicability: "接入该工具时。",
    boundary: "不代表运行时已经验证。",
    body: "接入前先读取正式文档。",
  });
  const draftReceipt = buildSourceReceipt(home, source.id);
  assert.equal(draftReceipt.knowledgeStatus, "draft_only");
  assert.deepEqual(draftReceipt.linkedKnowledgeIds, [draft.id]);

  const verified = captureKnowledge(home, {
    title: "接入文档已核验事实",
    type: "fact",
    sourceKind: "document",
    scope: "work",
    status: "verified",
    verification: "source_confirmed",
    sourceRefs: [source.id],
    admissionReason: "为接入任务提供已核验事实。",
    applicability: "接入该工具时。",
    boundary: "只覆盖当前文档版本。",
    body: "正式接入入口已经由来源文档确认。",
  });
  const verifiedReceipt = buildSourceReceipt(home, source.id);
  assert.equal(verifiedReceipt.knowledgeStatus, "default_eligible");
  assert.deepEqual(verifiedReceipt.defaultEligibleKnowledgeIds, [verified.id]);
});
