import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { captureKnowledge } from "../src/knowledge.ts";
import { buildPublication } from "../src/publication.ts";
import { inspectPublicText } from "../src/publication/safety.ts";
import { buildPublicationRun } from "../src/publication/workflow.ts";
import { LedgerStore } from "../src/store.ts";

test("personal GitHub publication build is deterministic and excludes private lineage", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-publication-build-test-"));
  const knowledge = captureKnowledge(home, {
    title: "个人知识发布只输出安全投影",
    type: "fact",
    collection: "concepts",
    scope: "personal",
    sensitivity: "public",
    sourceKind: "manual",
    sourceRefs: ["user-confirmation:publication-rule"],
    status: "verified",
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "artifact:publication-compilation",
    factRefs: ["fact:publication-rule"],
    questionsAnswered: ["什么内容可以进入个人公开知识？"],
    admissionReason: "这条规则决定后续个人知识发布范围。",
    applicability: "构建个人 GitHub 知识投影时。",
    boundary: "不发布工作知识、私有证据或本机路径。",
    confidence: "high",
    confidenceBasis: ["用户明确确认"],
    temporalState: "current",
    verification: "user_confirmed",
    body: "公开投影只保留可复用正文、标题、分类和标签。私有来源映射只保存在本地 Release Record。",
  });

  const first = buildPublication(home, {
    channel: "personal-github",
    knowledgeIds: [knowledge.id],
  });
  const firstBundleBytes = readFileSync(first.bundlePath, "utf8");
  const firstManifestBytes = readFileSync(join(first.outputDir, "manifest.json"), "utf8");

  const second = buildPublication(home, {
    channel: "personal-github",
    knowledgeIds: [knowledge.id],
  });

  assert.equal(second.releaseId, first.releaseId);
  assert.equal(second.outputHash, first.outputHash);
  assert.equal(second.reused, true);
  assert.equal(readFileSync(second.bundlePath, "utf8"), firstBundleBytes);
  assert.equal(readFileSync(join(second.outputDir, "manifest.json"), "utf8"), firstManifestBytes);

  const manifest = JSON.parse(firstManifestBytes);
  assert.equal(manifest.schema_version, "ikb-personal-publication-manifest.v1");
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].title, knowledge.title);
  const publicMarkdown = readFileSync(join(first.outputDir, manifest.entries[0].path), "utf8");
  for (const privateValue of [knowledge.id, knowledge.path, knowledge.sourceRefs[0], knowledge.compilationRef]) {
    assert.doesNotMatch(firstBundleBytes, new RegExp(escapeRegExp(privateValue!)));
    assert.doesNotMatch(firstManifestBytes, new RegExp(escapeRegExp(privateValue!)));
    assert.doesNotMatch(publicMarkdown, new RegExp(escapeRegExp(privateValue!)));
  }
});

test("an existing publication cannot be reused after output tampering or symlink substitution", () => {
  const tamperedHome = mkdtempSync(join(tmpdir(), "ikb-publication-tamper-test-"));
  const tamperedKnowledge = captureKnowledge(tamperedHome, publishableKnowledgeInput());
  const tamperedBuild = buildPublication(tamperedHome, {
    channel: "personal-github",
    knowledgeIds: [tamperedKnowledge.id],
  });
  writeFileSync(join(tamperedBuild.outputDir, "manifest.json"), "{}\n");
  assert.throws(
    () => buildPublication(tamperedHome, { channel: "personal-github", knowledgeIds: [tamperedKnowledge.id] }),
    /output was modified/,
  );

  const symlinkHome = mkdtempSync(join(tmpdir(), "ikb-publication-symlink-test-"));
  const symlinkKnowledge = captureKnowledge(symlinkHome, publishableKnowledgeInput());
  const symlinkBuild = buildPublication(symlinkHome, {
    channel: "personal-github",
    knowledgeIds: [symlinkKnowledge.id],
  });
  const manifestPath = join(symlinkBuild.outputDir, "manifest.json");
  const externalPath = join(symlinkHome, "manifest-copy.json");
  writeFileSync(externalPath, readFileSync(manifestPath));
  unlinkSync(manifestPath);
  symlinkSync(externalPath, manifestPath);
  assert.throws(
    () => buildPublication(symlinkHome, { channel: "personal-github", knowledgeIds: [symlinkKnowledge.id] }),
    /symbolic link/,
  );
});

test("explicit publication selection hard-blocks work, private and draft Knowledge before writing", () => {
  for (const blocked of [
    { label: "work", scope: "work", sensitivity: "public", status: "verified" as const, expected: "scope_not_personal" },
    { label: "private", scope: "personal", sensitivity: "private", status: "verified" as const, expected: "sensitivity_not_public" },
    { label: "draft", scope: "personal", sensitivity: "public", status: "draft" as const, expected: "status_not_verified" },
  ]) {
    const home = mkdtempSync(join(tmpdir(), `ikb-publication-${blocked.label}-test-`));
    const knowledge = captureKnowledge(home, publishableKnowledgeInput({
      scope: blocked.scope,
      sensitivity: blocked.sensitivity,
      status: blocked.status,
    }));
    assert.throws(
      () => buildPublication(home, { channel: "personal-github", knowledgeIds: [knowledge.id] }),
      new RegExp(blocked.expected),
    );
    assert.equal(existsSync(join(home, "publications")), false);
  }
});

test("sensitive content blocks publication before writing any release", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-publication-sensitive-test-"));
  const knowledge = captureKnowledge(home, publishableKnowledgeInput({
    body: "排查入口是 https://km.sankuai.com/example，本条不能进入公开投影。",
  }));
  assert.throws(
    () => buildPublication(home, { channel: "personal-github", knowledgeIds: [knowledge.id] }),
    /internal_domain/,
  );
  assert.equal(existsSync(join(home, "publications")), false);
});

test("public safety scan allows generated public ids but still blocks long numeric identifiers", () => {
  const publicId = "pub-1234567890123456";
  const generated = inspectPublicText(`{"public_id":"${publicId}","path":"${publicId}.md"}`, [publicId]);
  assert.equal(generated.some((issue) => issue.code === "long_numeric_identifier"), false);

  const untrustedLookalike = inspectPublicText(`正文中的 ${publicId} 没有被声明为系统生成值`);
  assert.equal(untrustedLookalike.some((issue) => issue.code === "long_numeric_identifier"), true);

  const plain = inspectPublicText("订单标识 1234567890123456 不能进入公开投影", [publicId]);
  assert.equal(plain.some((issue) => issue.code === "long_numeric_identifier"), true);
});

test("internal product and workspace names are blocked from public projections", () => {
  for (const [label, body] of [
    ["internal-agent", "通过 CatDesk 复用本机登录态读取内部系统。"],
    ["internal-platform", "把任务迁移到 Multica 后再由本地运行器处理。"],
    ["internal-harness", "这个实现依赖 SpecX 的内部状态文件。"],
    ["internal-config", "故障时去 Lion 配置中心确认当前值。"],
  ]) {
    const home = mkdtempSync(join(tmpdir(), `ikb-publication-${label}-test-`));
    const knowledge = captureKnowledge(home, publishableKnowledgeInput({ body }));
    assert.throws(
      () => buildPublication(home, { channel: "personal-github", knowledgeIds: [knowledge.id] }),
      /internal_product/,
    );
    assert.equal(existsSync(join(home, "publications")), false);
  }
});

test("publication requires task or user validation and rejects raw HTML", () => {
  const unconfirmedHome = mkdtempSync(join(tmpdir(), "ikb-publication-unconfirmed-test-"));
  const unconfirmed = captureKnowledge(unconfirmedHome, publishableKnowledgeInput({
    verification: "source_confirmed",
  }));
  assert.throws(
    () => buildPublication(unconfirmedHome, { channel: "personal-github", knowledgeIds: [unconfirmed.id] }),
    /publication_verification_insufficient/,
  );
  assert.equal(existsSync(join(unconfirmedHome, "publications")), false);

  const htmlHome = mkdtempSync(join(tmpdir(), "ikb-publication-html-test-"));
  const html = captureKnowledge(htmlHome, publishableKnowledgeInput({
    body: "公开正文里不能直接保留 <script>alert('x')</script>。",
  }));
  assert.throws(
    () => buildPublication(htmlHome, { channel: "personal-github", knowledgeIds: [html.id] }),
    /raw_html/,
  );
  assert.equal(existsSync(join(htmlHome, "publications")), false);
});

test("publication blocks superseded or overdue personal Knowledge", () => {
  const supersededHome = mkdtempSync(join(tmpdir(), "ikb-publication-superseded-test-"));
  const superseded = captureKnowledge(supersededHome, publishableKnowledgeInput({
    temporalState: "superseded",
  }));
  assert.throws(
    () => buildPublication(supersededHome, { channel: "personal-github", knowledgeIds: [superseded.id] }),
    /temporal_state_superseded/,
  );

  const overdueHome = mkdtempSync(join(tmpdir(), "ikb-publication-overdue-test-"));
  const overdue = captureKnowledge(overdueHome, publishableKnowledgeInput());
  writeFileSync(overdue.path, readFileSync(overdue.path, "utf8").replace(/^review_after: .*$/m, "review_after: 2020-01-01"));
  assert.throws(
    () => buildPublication(overdueHome, { channel: "personal-github", knowledgeIds: [overdue.id] }),
    /review_overdue/,
  );
});

test("publication build runs inside the ledger with artifacts, gates and verification", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-publication-ledger-test-"));
  const knowledge = captureKnowledge(home, publishableKnowledgeInput());
  const store = new LedgerStore({ home, actor: "publication-test" });

  const result = buildPublicationRun(store, home, {
    channel: "personal-github",
    knowledgeIds: [knowledge.id],
  });

  assert.equal(store.requireTask(result.taskId).status, "done");
  assert.equal(store.requireRun(result.runId).status, "succeeded");
  assert.equal(result.artifactIds.length, 4);
  assert.equal(store.listEvents().filter((event) => event.eventType === "publication.built").length, 1);
  assert.equal(
    store.listEvents().find((event) => event.aggregateId === result.runId && event.eventType === "run.verification_completed")?.payload.result,
    "pass",
  );
  assert.equal(
    store.listEvents().find((event) => event.aggregateId === result.runId && event.eventType === "run.evaluation_completed")?.payload.result,
    "pass",
  );
  assert.equal(store.listApprovals({ runId: result.runId }).length, 0);
  assert.equal(store.verify().brokenChains.length, 0);
  store.close();
});

test("publish build CLI exposes the traced local build", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-publication-cli-test-"));
  const knowledge = captureKnowledge(home, publishableKnowledgeInput());
  const invoked = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    join(process.cwd(), "src", "cli.ts"),
    "publish",
    "build",
    "--channel",
    "personal-github",
    "--knowledge-id",
    knowledge.id,
    "--home",
    home,
    "--json",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(invoked.status, 0, invoked.stderr);
  const result = JSON.parse(invoked.stdout);
  assert.equal(result.channel, "personal-github");
  assert.equal(result.entryCount, 1);
  assert.match(result.taskId, /^task-/);
  assert.match(result.runId, /^run-/);
  assert.equal(existsSync(result.bundlePath), true);
});

test("daily copilot adapter preserves legacy ids, derives categories and reuses one Knowledge for multiple views", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-daily-copilot-build-test-"));
  const knowledge = captureKnowledge(home, publishableKnowledgeInput({
    title: "复杂 Agent Run 质量闭环",
    type: "playbook",
    collection: "playbooks",
    productType: "playbook",
    useWhen: "复杂任务需要恢复、门禁或外部动作时。",
    useInputs: ["任务目标", "验收条件"],
    useOutputs: ["可恢复 Run", "质量报告"],
    useSteps: ["冻结任务合同", "执行门禁与验证"],
    useChecks: ["终态与质量结果分离"],
    useStopConditions: ["证据链不完整"],
    body: "# 质量闭环\n\n终态成功不等于质量通过。\n\n## 执行\n\n1. 冻结任务合同。\n2. 记录 Artifact、Gate 与 Verifier。\n",
  }));
  const migration = {
    schema_version: "ikb-daily-copilot-migration.v1" as const,
    source_snapshot: "fixture-commit",
    expected_legacy_ids: [14, 15, 49],
    category_order: ["Agent 协作", "AI 编程"],
    category_icons: {
      "Agent 协作": "🤖",
      "AI 编程": "💻",
    },
    entries: [
      {
        legacy_id: 14,
        disposition: "publish" as const,
        knowledge_id: knowledge.id,
        title: "多 Agent 协作体系",
        category: "Agent 协作",
        attachment_disposition: "removed_unlicensed" as const,
        reason_code: "merged_into_verified_knowledge",
      },
      {
        legacy_id: 15,
        disposition: "publish" as const,
        knowledge_id: knowledge.id,
        title: "Pipeline 执行纪律",
        category: "Agent 协作",
        attachment_disposition: "removed_unlicensed" as const,
        reason_code: "merged_into_verified_knowledge",
      },
      {
        legacy_id: 49,
        disposition: "publish" as const,
        knowledge_id: knowledge.id,
        title: "Agent Harness 质量门禁",
        category: "AI 编程",
        attachment_disposition: "none" as const,
        reason_code: "merged_into_verified_knowledge",
      },
    ],
  };

  const first = buildPublication(home, {
    channel: "daily-copilot",
    dailyCopilotMigration: migration,
  });
  const second = buildPublication(home, {
    channel: "daily-copilot",
    dailyCopilotMigration: migration,
  });

  assert.equal(second.releaseId, first.releaseId);
  assert.equal(second.outputHash, first.outputHash);
  assert.equal(second.reused, true);

  const dataBytes = readFileSync(join(first.outputDir, "experience-data.js"), "utf8");
  const categoryBytes = readFileSync(join(first.outputDir, "experience-categories.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(first.outputDir, "manifest.json"), "utf8"));
  const data = loadCommonJs(dataBytes);
  const categories = loadCommonJs(categoryBytes);

  assert.deepEqual(data.map((entry: { id: number }) => entry.id), [14, 15, 49]);
  assert.deepEqual(data.map((entry: { t: string }) => entry.t), [
    "多 Agent 协作体系",
    "Pipeline 执行纪律",
    "Agent Harness 质量门禁",
  ]);
  assert.equal(data.every((entry: { publicId: string }) => entry.publicId === data[0].publicId), true);
  assert.equal(data[0].d, "终态成功不等于质量通过。");
  assert.match(data[0].content, /<h4>质量闭环<\/h4>/);
  assert.match(data[0].content, /<ol>/);
  assert.deepEqual(categories, [
    { name: "Agent 协作", icon: "🤖" },
    { name: "AI 编程", icon: "💻" },
  ]);
  assert.equal(manifest.schema_version, "ikb-daily-copilot-manifest.v1");
  assert.deepEqual(manifest.expected_legacy_ids, [14, 15, 49]);
  assert.deepEqual(manifest.omitted_legacy_ids, []);
  assert.equal(manifest.entries.length, 3);
  assert.equal(manifest.entries[0].content_hash, data[0].contentHash);
  assert.doesNotMatch(dataBytes, new RegExp(escapeRegExp(knowledge.id)));
  assert.doesNotMatch(categoryBytes, new RegExp(escapeRegExp(knowledge.id)));
});

test("daily copilot adapter blocks incomplete migration coverage before writing", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-daily-copilot-coverage-test-"));
  const knowledge = captureKnowledge(home, publishableKnowledgeInput());
  const migration = {
    schema_version: "ikb-daily-copilot-migration.v1" as const,
    source_snapshot: "fixture-commit",
    expected_legacy_ids: [1, 2],
    category_order: ["AI 编程"],
    category_icons: { "AI 编程": "💻" },
    entries: [{
      legacy_id: 1,
      disposition: "publish" as const,
      knowledge_id: knowledge.id,
      category: "AI 编程",
      attachment_disposition: "none" as const,
      reason_code: "approved",
    }],
  };

  assert.throws(
    () => buildPublication(home, { channel: "daily-copilot", dailyCopilotMigration: migration }),
    /migration coverage mismatch/,
  );
  assert.equal(existsSync(join(home, "publications")), false);
});

function publishableKnowledgeInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "个人知识公开投影测试",
    type: "fact",
    collection: "concepts",
    scope: "personal",
    sensitivity: "public",
    sourceKind: "manual",
    sourceRefs: ["manual-publication-confirmation"],
    status: "verified",
    qualityVersion: 4,
    productType: "fact_card",
    compilationRef: "local-publication-compilation",
    factRefs: ["publication-fact"],
    questionsAnswered: ["什么知识不能发布？"],
    admissionReason: "防止私有信息进入公开投影。",
    applicability: "构建个人公开知识时。",
    boundary: "仅验证发布门禁。",
    confidence: "high",
    confidenceBasis: ["用户明确确认"],
    temporalState: "current",
    verification: "user_confirmed",
    body: "只有通过个人知识准入和公开发布门禁的内容才能进入公开投影。",
    ...overrides,
  } as Parameters<typeof captureKnowledge>[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadCommonJs(source: string): any {
  const module = { exports: {} as unknown };
  runInNewContext(source, { module, exports: module.exports });
  return JSON.parse(JSON.stringify(module.exports));
}
