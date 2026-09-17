import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildStockMetrics } from "../scripts/ikb-workbench-stock.mjs";

const generatedAt = "2026-09-17T12:00:00.000Z";

function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ikb-stock-"));
  const cardsRoot = join(root, "cards");
  const intakeRoot = join(root, "intake");
  for (const scope of ["work", "common", "personal", "archive"]) mkdirSync(join(cardsRoot, scope), { recursive: true });
  mkdirSync(join(intakeRoot, "maintenance"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cardsRoot, intakeRoot };
}

function card(
  cardsRoot: string,
  relativePath: string,
  options: { id: string; updatedAt?: string; sources?: string[]; body?: string },
) {
  const path = join(cardsRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  const sources = options.sources === undefined ? "[]" : `[${options.sources.map((source) => JSON.stringify(source)).join(", ")}]`;
  writeFileSync(path, [
    "---",
    `id: ${options.id}`,
    `title: ${options.id}`,
    "aliases: []",
    `updated_at: ${options.updatedAt ?? "2026-09-01"}`,
    "tags: []",
    `sources: ${sources}`,
    "---",
    "",
    options.body ?? "## 是什么／怎么做\n\n有边界的知识。",
    "",
  ].join("\n"));
  return path;
}

function hash(path: string) {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

function ledger(intakeRoot: string, cards: Array<{ cardId: string; kind: "normal" | "principle"; contentHash: string }>) {
  writeFileSync(join(intakeRoot, "maintenance", "card-classification.json"), JSON.stringify({
    schema: "ikb-card-classification-v1",
    classifiedAt: generatedAt,
    sourceRefs: ["classification evidence"],
    cards,
  }));
}

test("counts active scopes and work directories while excluding archive, README, and symlinks", (t) => {
  const f = fixture(t);
  card(f.cardsRoot, "work/domains/domain.md", { id: "domain", updatedAt: generatedAt, sources: ["primary source"] });
  card(f.cardsRoot, "work/practices/practice.md", { id: "practice", updatedAt: "2026-08-01", sources: [] });
  card(f.cardsRoot, "common/common.md", { id: "common", updatedAt: "bad-date", sources: [" ", "shared source"] });
  card(f.cardsRoot, "personal/personal.md", { id: "personal", updatedAt: "2026-10-01", sources: ["personal source"] });
  card(f.cardsRoot, "archive/archived.md", { id: "archived", sources: ["must be ignored"] });
  writeFileSync(join(f.cardsRoot, "work", "README.md"), "not a card");
  writeFileSync(join(f.cardsRoot, "work", "domains", "ignored.txt"), "not a card");
  symlinkSync(join(f.cardsRoot, "common", "common.md"), join(f.cardsRoot, "work", "domains", "linked.md"));

  const result = buildStockMetrics({ cardsRoot: f.cardsRoot, intakeRoot: f.intakeRoot, generatedAt });
  assert.equal(result.state, "available");
  assert.equal(result.total, 4);
  assert.deepEqual(result.byScope, { work: 2, common: 1, personal: 1 });
  assert.deepEqual(result.byCategory, { domains: 1, practices: 1, services: 0, people: 0, team: 0 });
  assert.deepEqual(result.sourceMetadata, { present: 3, missing: 1, percent: 75 });
  assert.deepEqual(result.updatedMetadata, { last30Days: 1, older: 1, unknown: 1, future: 1 });
});

test("requires current card hash for baseline and accepts valid explicit overrides only for work/common", (t) => {
  const f = fixture(t);
  const normalPath = card(f.cardsRoot, "work/domains/normal.md", { id: "normal" });
  const principlePath = card(f.cardsRoot, "work/team/principle.md", { id: "principle" });
  const changedPath = card(f.cardsRoot, "common/changed.md", { id: "changed" });
  const personalPath = card(f.cardsRoot, "personal/private.md", { id: "private" });
  ledger(f.intakeRoot, [
    { cardId: "normal", kind: "normal", contentHash: hash(normalPath) },
    { cardId: "principle", kind: "principle", contentHash: hash(principlePath) },
    { cardId: "changed", kind: "normal", contentHash: "0".repeat(64) },
    { cardId: "private", kind: "principle", contentHash: hash(personalPath) },
  ]);
  let result = buildStockMetrics({ cardsRoot: f.cardsRoot, intakeRoot: f.intakeRoot, generatedAt });
  assert.deepEqual(result.knowledgeKinds, {
    normal: 1, principle: 1, unknown: 1, workTotal: 3, normalPercent: 33.33333333333333, principlePercent: 33.33333333333333,
  });

  writeFileSync(changedPath, `${readFileSync(changedPath, "utf8")}\nchanged\n`);
  result = buildStockMetrics({
    cardsRoot: f.cardsRoot,
    intakeRoot: f.intakeRoot,
    generatedAt,
    classifications: [
      { cardId: "changed", kind: "principle", contentHash: hash(changedPath) },
      { cardId: "private", kind: "normal", contentHash: hash(personalPath) },
      { cardId: "normal", kind: "principle", contentHash: "0".repeat(64) },
    ],
  });
  assert.equal(result.knowledgeKinds.normal, 1);
  assert.equal(result.knowledgeKinds.principle, 2);
  assert.equal(result.knowledgeKinds.unknown, 0);
  assert.equal(result.knowledgeKinds.normalPercent, 33.33333333333333);
  assert.equal(result.knowledgeKinds.principlePercent, 66.66666666666666);
});

test("duplicate active IDs invalidate the result, while a missing ledger preserves stock counts", (t) => {
  const f = fixture(t);
  card(f.cardsRoot, "work/domains/one.md", { id: "duplicate" });
  card(f.cardsRoot, "common/two.md", { id: "duplicate" });
  let result = buildStockMetrics({ cardsRoot: f.cardsRoot, intakeRoot: f.intakeRoot, generatedAt });
  assert.equal(result.state, "invalid");
  assert.equal(result.total, null);
  assert.match(result.warnings.join("\n"), /duplicate active card id/);

  rmSync(join(f.cardsRoot, "common", "two.md"));
  result = buildStockMetrics({ cardsRoot: f.cardsRoot, intakeRoot: f.intakeRoot, generatedAt });
  assert.equal(result.state, "available");
  assert.equal(result.total, 1);
  assert.deepEqual(result.knowledgeKinds, {
    normal: 0, principle: 0, unknown: 1, workTotal: 1, normalPercent: 0, principlePercent: 0,
  });
  assert.match(result.warnings.join("\n"), /分类账本缺失/);
});

test("missing and malformed cards roots expose null totals", (t) => {
  const f = fixture(t);
  const missing = buildStockMetrics({ cardsRoot: join(f.root, "does-not-exist"), intakeRoot: f.intakeRoot, generatedAt });
  assert.equal(missing.state, "missing");
  assert.equal(missing.total, null);

  writeFileSync(join(f.cardsRoot, "work", "broken.md"), "---\nid: broken\ntitle: broken\n");
  const invalid = buildStockMetrics({ cardsRoot: f.cardsRoot, intakeRoot: f.intakeRoot, generatedAt });
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.total, null);
  assert.match(invalid.warnings.join("\n"), /malformed card/);
});
