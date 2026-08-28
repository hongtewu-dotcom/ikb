import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findCandidateReviewDocuments, findCandidateReviewPackageDocuments, renderCandidateReviewPage, renderKnowledgeReviewPage, renderReportHtml } from "../scripts/ikb-report-server.mjs";

test("live report serves a local, no-store HTML shell", () => {
  const html = renderReportHtml();
  assert.match(html, /IKB 运行观测/);
  assert.match(html, /fetch\('\/api\/report\?ts=/);
  assert.match(html, /setInterval\(load, 15000\)/);
  assert.match(html, /本地只读观测/);
  assert.doesNotMatch(html, /127\.0\.0\.1:5173/);
  assert.match(html, /不含 Source\/Knowledge 正文/);
  assert.match(html, /Experience 分析队列/);
  assert.match(html, /Knowledge Candidate 待复核/);
  assert.match(html, /全局推理与确认项/);
  assert.match(html, /推理待确认/);
  assert.match(html, /来源覆盖与外部读取/);
  assert.match(html, /学城只读额度/);
  assert.match(html, /大象读取边界/);
  assert.match(html, /人物证据与周期蒸馏/);
  assert.match(html, /知识检索与使用（近 7 天）/);
  assert.match(html, /未分类引用/);
  assert.match(html, /referenceToUseRate/);
  assert.match(html, /reviewLink\('candidate'/);
  assert.match(html, /reviewLink\('knowledge'/);
});

test("candidate review pages expose only matching regular Markdown files", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-review-page-"));
  const matching = join(home, "reviews", "memory-rule");
  const unrelated = join(home, "reviews", "other");
  mkdirSync(matching, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(matching, "请确认.md"), "# 请确认\n\n候选 exp-cand-abc123\n");
  writeFileSync(join(matching, "完整替换稿.md"), "# 完整替换稿\n\n<script>alert(1)</script>\n");
  writeFileSync(join(unrelated, "其他.md"), "# 其他候选\n");
  symlinkSync(join(unrelated, "其他.md"), join(matching, "外部链接.md"));

  const documents = findCandidateReviewDocuments(home, "exp-cand-abc123");
  assert.deepEqual(documents.map((item) => item.name), ["完整替换稿.md", "请确认.md"]);
  assert.equal(documents.some((item) => item.name === "外部链接.md"), false);
  assert.throws(() => findCandidateReviewDocuments(home, "../outside"), /Invalid candidate id/);

  const html = renderCandidateReviewPage({
    id: "exp-cand-abc123",
    title: "<script>bad title</script>",
    status: "pending_review",
    changeTypes: ["revise"],
    targetKnowledgeIds: ["kb-abc123"],
    candidateKnowledge: { claim: "完整替换而不是一句摘要" },
  }, documents);
  assert.match(html, /&lt;script&gt;bad title&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\/review\/knowledge\/kb-abc123/);
});

test("knowledge review pages escape content and keep the object identity visible", () => {
  const html = renderKnowledgeReviewPage({ id: "kb-abc123", title: "Knowledge", status: "draft", scope: "personal", verification: "unverified", body: "# 正文\n\n<img src=x onerror=alert(1)>" });
  assert.match(html, /kb-abc123/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test("registered review package reads only its exact hash-bound documents", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-registered-review-page-"));
  const directory = join(home, "reviews", "registered");
  mkdirSync(directory, { recursive: true });
  const guidePath = join(directory, "请确认.md");
  const draftPath = join(directory, "完整稿.md");
  const validationPath = join(directory, "验证报告.md");
  const unrelatedPath = join(directory, "同目录但未登记.md");
  writeFileSync(guidePath, "# 请确认\n");
  writeFileSync(draftPath, "# 完整稿\n");
  writeFileSync(validationPath, "# 验证报告\n");
  writeFileSync(unrelatedPath, "# 不应读取\n");
  const artifact = (id: string, kind: string, path: string, content: string) => ({
    id, kind, label: id, path, contentHash: createHash("sha256").update(content).digest("hex"),
  });
  const inspection = {
    issues: [],
    package: {
      package: { id: "exp-review-fixture" },
      path: join(home, "experiences", "review-packages", "fixture.json"),
      guide: artifact("artifact-guide", "knowledge-review-guide", guidePath, "# 请确认\n"),
      draft: artifact("artifact-draft", "knowledge-candidate-draft", draftPath, "# 完整稿\n"),
      validations: [artifact("artifact-validation", "knowledge-candidate-validation", validationPath, "# 验证报告\n")],
    },
  };
  const documents = findCandidateReviewPackageDocuments(home, inspection);
  assert.deepEqual(documents.map((document) => document.name), ["请确认.md", "完整稿.md", "验证报告.md"]);
  assert.equal(documents.some((document) => document.name === "同目录但未登记.md"), false);

  writeFileSync(validationPath, "# 被篡改\n");
  assert.throws(() => findCandidateReviewPackageDocuments(home, inspection), /hash changed/);
});
