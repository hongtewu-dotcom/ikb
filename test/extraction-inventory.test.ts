import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceStructureInventory } from "../src/extraction/inventory.ts";

test("source inventory accounts for every non-empty Markdown line without flattening structure", () => {
  const directory = mkdtempSync(join(tmpdir(), "ikb-source-inventory-"));
  const path = join(directory, "验价设计.md");
  const source = [
    "# 验价设计",
    "",
    "报价请求与报价方案是不同对象。",
    "所有状态跃迁必须保留原始报价标识。",
    "",
    "| 状态 | 含义 |",
    "| --- | --- |",
    "| INIT | 初始 |",
    "",
    "![验价链路](./flow.png)",
    "",
    "```java",
    "if (quoteId == null) {",
    "  throw new IllegalStateException();",
    "}",
    "```",
  ].join("\n");
  writeFileSync(path, source);

  const inventory = buildSourceStructureInventory(path, "src-pricing");
  const coveredLines = new Set(inventory.units.flatMap((unit) => {
    const rows: number[] = [];
    for (let line = unit.start_line; line <= unit.end_line; line += 1) rows.push(line);
    return rows;
  }));
  const nonEmptyLines = source.split("\n").flatMap((line, index) => line.trim() ? [index + 1] : []);

  assert.equal(inventory.schema, "ikb-source-structure-inventory.v1");
  assert.equal(inventory.source_id, "src-pricing");
  assert.equal(inventory.units.some((unit) => unit.unit_kind === "section"), true);
  assert.equal(inventory.units.some((unit) => unit.unit_kind === "table"), true);
  assert.equal(inventory.units.some((unit) => unit.unit_kind === "image"), true);
  assert.equal(inventory.units.filter((unit) => unit.unit_kind === "image").every((unit) => unit.importance === "supporting"), true);
  assert.equal(inventory.units.some((unit) => unit.unit_kind === "other" && unit.content.includes("IllegalStateException")), true);
  assert.equal(inventory.units.some((unit) => unit.importance === "core" && unit.content.includes("必须")), true);
  assert.deepEqual([...coveredLines].sort((a, b) => a - b), nonEmptyLines);
  assert.deepEqual(buildSourceStructureInventory(path, "src-pricing"), inventory);
  assert.equal(readFileSync(path, "utf8"), source);
});

test("extraction inventory CLI writes a replayable JSON artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "ikb-source-inventory-cli-"));
  const sourcePath = join(directory, "来源.md");
  const outputPath = join(directory, "来源结构清单.json");
  writeFileSync(sourcePath, "# 规则\n\n所有状态变更必须保留原始标识。\n");
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    "src/cli.ts",
    "extraction",
    "inventory",
    sourcePath,
    "--source-id",
    "src-rule",
    "--file",
    outputPath,
    "--home",
    join(directory, "home"),
    "--json",
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.path, outputPath);
  assert.equal(artifact.source_id, "src-rule");
  assert.equal(artifact.units.some((unit: { importance: string }) => unit.importance === "core"), true);
});

test("JSON comment exports are split into reviewable semantic units instead of one opaque blob", () => {
  const directory = mkdtempSync(join(tmpdir(), "ikb-json-inventory-"));
  const path = join(directory, "comments.json");
  const source = JSON.stringify({
    contentId: "2735181581",
    comments: [{
      commentId: "c1",
      quoteContent: "必须通过定制化实现",
      content: "为什么这是架构问题？",
      creator: "reviewer01",
      createTime: 1776320026000,
    }, {
      commentId: "c2",
      content: "当前方案的回滚边界是什么？",
      creator: "reviewer02",
      createTime: 1776321026000,
    }],
  }, null, 2);
  writeFileSync(path, source);

  const inventory = buildSourceStructureInventory(path, "src-comments");
  const commentUnits = inventory.units.filter((unit) => unit.unit_kind === "comment");
  const metadataUnits = inventory.units.filter((unit) => unit.content.includes("commentId") || unit.content.includes("createTime"));
  assert.equal(commentUnits.length, 3);
  assert.equal(commentUnits.some((unit) => unit.content.includes("必须") && unit.importance === "core"), true);
  assert.equal(commentUnits.some((unit) => unit.content.includes("回滚边界") && unit.importance === "core"), true);
  assert.equal(metadataUnits.every((unit) => unit.importance === "context"), true);
  assert.equal(inventory.units.length > commentUnits.length, true);
  assert.equal(inventory.units.every((unit) => source.includes(unit.content)), true);
});
