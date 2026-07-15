import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureKnowledge, buildContextPack, searchKnowledge, reviewKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";

test("knowledge capture writes frontmatter and search returns source-scoped results", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-kb-test-"));
  const record = captureKnowledge(home, {
    title: "Review evidence",
    type: "playbook",
    scope: "personal",
    body: "A review conclusion must include a source and a line reference.",
    tags: ["review", "evidence"],
  });
  const text = readFileSync(record.path, "utf8");
  assert.match(text, /status: draft/);
  assert.equal(searchKnowledge(home, "line reference", { scope: "personal" })[0].id, record.id);
  assert.equal(searchKnowledge(home, "line reference", { scope: "work" }).length, 0);
  assert.equal(reviewKnowledge(home, "personal").length, 1);
});

test("context pack only includes verified knowledge", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-context-test-"));
  captureKnowledge(home, { title: "Draft note", body: "technical plan source", scope: "personal", status: "draft" });
  const verified = captureKnowledge(home, { title: "Verified plan rule", body: "technical plan source", scope: "personal", status: "verified" });
  const context = buildContextPack(home, { taskId: "task-1", title: "plan", goal: "technical plan", acceptance: "source" });
  assert.equal(context.results.length, 1);
  assert.equal(context.results[0].id, verified.id);
  assert.match(context.markdown, /Verified plan rule/);
});

test("knowledge cannot become verified without a source", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-admission-test-"));
  const record = captureKnowledge(home, { title: "No source", body: "unverified", scope: "personal" });
  assert.throws(() => updateKnowledgeStatus(home, record.id, "verified"), /source_refs/);
});
