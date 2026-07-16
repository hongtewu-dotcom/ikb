import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureKnowledge, buildContextPack, relateKnowledge, searchKnowledge, reviewKnowledge, updateKnowledgeStatus } from "../src/knowledge.ts";

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

test("knowledge relations use Obsidian wikilinks and preserve reciprocal semantics", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-relation-test-"));
  const source = captureKnowledge(home, { title: "Current rule", body: "Keep the current rule.", scope: "personal" });
  const target = captureKnowledge(home, { title: "Old rule", body: "The old rule.", scope: "personal" });

  const related = relateKnowledge(home, source.id, target.id, "related");
  assert.equal(related.changed, true);
  assert.deepEqual(related.source.related, [target.id]);
  assert.deepEqual(related.target.related, [source.id]);
  assert.match(readFileSync(source.path, "utf8"), new RegExp(`related:.*\\[\\[${target.id}\\|Old rule\\]\\]`));
  assert.match(readFileSync(source.path, "utf8"), new RegExp(`aliases:.*${source.id}`));

  const derived = relateKnowledge(home, source.id, target.id, "derived_from");
  assert.equal(derived.reciprocal, false);
  assert.deepEqual(derived.source.derivedFrom, [target.id]);
  assert.deepEqual(derived.target.derivedFrom, []);
  assert.equal(relateKnowledge(home, source.id, target.id, "related").changed, false);
});

test("cross-scope knowledge relations require explicit opt-in", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-cross-scope-relation-test-"));
  const personal = captureKnowledge(home, { title: "Personal", body: "personal", scope: "personal" });
  const work = captureKnowledge(home, { title: "Work", body: "work", scope: "work" });
  assert.throws(() => relateKnowledge(home, personal.id, work.id, "related"), /Cross-scope relation is blocked/);
  assert.equal(relateKnowledge(home, personal.id, work.id, "related", { allowCrossScope: true }).changed, true);
});
