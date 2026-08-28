import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureKnowledge } from "../src/knowledge.ts";
import {
  checkPrincipleProjections,
  inspectAgentProjection,
  renderPrincipleProjectionBlock,
  writePrincipleProjectionReport,
} from "../src/knowledge/principle-projection.ts";

test("projection inspection reports exact, drifted and duplicate AGENTS blocks", () => {
  const principleId = "kb-principle-123";
  const projection = "重要资料先进入 Source；Source 不等于已准入 Knowledge。";
  const block = renderPrincipleProjectionBlock(principleId, projection);

  assert.equal(inspectAgentProjection(principleId, projection, block).status, "current");
  assert.equal(inspectAgentProjection(principleId, projection, block.replace("不等于", "就是")).status, "drifted");
  assert.equal(inspectAgentProjection(principleId, projection, `${block}\n${block}`).status, "duplicate");
  assert.equal(inspectAgentProjection(principleId, projection, "# no projection\n").status, "missing");
});

test("projection checker rejects unconfirmed Principles and only writes a review report", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-projection-"));
  const principle = captureKnowledge(home, {
    title: "证据入库与知识准入分离",
    type: "principle",
    sourceKind: "document",
    scope: "work",
    sourceRefs: ["src-example"],
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "work:principle:source-is-not-admitted-knowledge",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-source-admission",
    compilationProductId: "product-source-admission",
    extractionManifestRef: "artifact:manifest-source-admission",
    compilationRef: "artifact:compilation-source-admission",
    informationLossRef: "artifact:loss-source-admission",
    factRefs: ["fact:source-admission"],
    questionsAnswered: ["Source 何时可以作为默认知识使用？"],
    admissionReason: "防止证据快照被误当作已确认结论。",
    applicability: "接收重要资料时。",
    boundary: "只约束 Source 与 Knowledge 的状态语义。",
    confidence: "high",
    confidenceBasis: ["有独立 Source 与编译产物。"],
    temporalState: "current",
    verification: "unverified",
    body: "重要资料先进入 Source；Source 不等于已准入 Knowledge。",
  });
  const agentsPath = join(home, "AGENTS.md");
  const projection = "重要资料先进入 Source；Source 不等于已准入 Knowledge。";
  writeFileSync(agentsPath, `${renderPrincipleProjectionBlock(principle.id, projection)}\n`);
  const manifestPath = join(home, "projection-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "ikb-principle-projection-manifest.v1",
    scope: "work",
    agentsPaths: [agentsPath],
    mappings: [{
      id: "source-admission",
      principleId: principle.id,
      startupRequired: true,
      rationale: "启动时必须区分证据与知识。",
      agentsPath,
      projection,
    }],
  }, null, 2)}\n`);

  const result = checkPrincipleProjections(home, manifestPath);
  assert.equal(result.ok, false);
  assert.equal(result.mappings[0].projectionStatus, "current");
  assert.equal(result.issues.some((issue) => issue.code === "principle_not_active"), true);
  const paths = writePrincipleProjectionReport(home, result);
  assert.match(paths.jsonPath, /projection-drift\.json$/);
  assert.match(paths.markdownPath, /projection-drift\.md$/);

  const agentsBefore = readFileSync(agentsPath, "utf8");
  const cli = spawnSync(join(process.cwd(), "bin", "ikb"), [
    "knowledge", "principle-projection-check",
    "--manifest", manifestPath,
    "--write",
    "--home", home,
    "--json",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 2, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.ok, false);
  assert.match(cliResult.paths.jsonPath, /projection-drift\.json$/);
  assert.equal(readFileSync(agentsPath, "utf8"), agentsBefore);
});

test("projection checker reports conflicting text and unmanaged blocks", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-projection-conflict-"));
  const agentsPath = join(home, "AGENTS.md");
  writeFileSync(agentsPath, `${renderPrincipleProjectionBlock("kb-unmanaged-1", "未登记投影。") }\n`);
  const manifestPath = join(home, "projection-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "ikb-principle-projection-manifest.v1",
    scope: "work",
    agentsPaths: [agentsPath],
    mappings: [
      { id: "one", principleId: "kb-missing-1", startupRequired: false, rationale: "检查冲突。", projection: "版本一" },
      { id: "two", principleId: "kb-missing-1", startupRequired: false, rationale: "检查冲突。", projection: "版本二" },
    ],
  }, null, 2)}\n`);

  const result = checkPrincipleProjections(home, manifestPath);
  assert.equal(result.issues.filter((issue) => issue.code === "projection_conflict").length, 2);
  assert.equal(result.issues.some((issue) => issue.code === "unmanaged_projection" && issue.principleId === "kb-unmanaged-1"), true);
});

test("projection checker rejects a Principle from another scope", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-principle-projection-scope-"));
  const principle = captureKnowledge(home, {
    title: "个人范围原则",
    type: "principle",
    sourceKind: "manual",
    scope: "personal",
    sourceRefs: ["src-personal"],
    qualityVersion: 5,
    productType: "principle_card",
    canonicalKey: "personal:principle:scope-boundary",
    compilationSchema: "ikb-knowledge-compilation-result.v3",
    compilationCaseId: "case-scope-boundary",
    compilationProductId: "product-scope-boundary",
    extractionManifestRef: "artifact:manifest-scope-boundary",
    compilationRef: "artifact:compilation-scope-boundary",
    informationLossRef: "artifact:loss-scope-boundary",
    factRefs: ["fact:scope-boundary"],
    questionsAnswered: ["原则能否跨 scope 投影？"],
    admissionReason: "验证 Principle 投影的 scope 边界。",
    applicability: "检查 Principle 投影时。",
    boundary: "只验证 scope 隔离。",
    confidence: "high",
    confidenceBasis: ["manifest scope 是显式契约。"],
    temporalState: "current",
    verification: "unverified",
    body: "个人范围 Principle 不得由 work manifest 投影。",
  });
  const manifestPath = join(home, "projection-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "ikb-principle-projection-manifest.v1",
    scope: "work",
    mappings: [{
      id: "cross-scope",
      principleId: principle.id,
      startupRequired: false,
      rationale: "验证 scope 隔离。",
    }],
  }, null, 2)}\n`);

  const result = checkPrincipleProjections(home, manifestPath);
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "principle_scope_mismatch"), true);
});
