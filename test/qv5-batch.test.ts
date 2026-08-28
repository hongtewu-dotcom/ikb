import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyQv5KnowledgeRevisionBatch, findKnowledge } from "../src/knowledge.ts";
import { LedgerStore } from "../src/store.ts";
import { createQv5Fixture } from "./qv5-fixture.ts";

const batchPlan = (entries: ReturnType<typeof createQv5Fixture>["entry"][]) => ({ schema: "ikb-qv5-revision-batch-plan.v1" as const, entries });
const fresh = () => { const home = mkdtempSync(join(tmpdir(), "qv5-batch-")); return { home, store: new LedgerStore({ home }) }; };

test("QV5 batch applies a valid entry while isolating a revision mismatch", () => {
  const { home, store } = fresh(); const good = createQv5Fixture(home, store); const bad = createQv5Fixture(home, store, "bad");
  const result = applyQv5KnowledgeRevisionBatch(home, store, batchPlan([good.entry, { ...bad.entry, expectedRevision: 99 }]));
  assert.deepEqual(result.entries.map((entry) => entry.status), ["applied", "blocked"]);
  assert.equal(findKnowledge(home, good.target.id)?.revision, 2); assert.equal(findKnowledge(home, bad.target.id)?.revision, 1); store.close();
});

test("QV5 batch blocks an expected knowledge hash mismatch", () => {
  const { home, store } = fresh(); const fx = createQv5Fixture(home, store);
  const result = applyQv5KnowledgeRevisionBatch(home, store, batchPlan([{ ...fx.entry, expectedKnowledgeHash: "0".repeat(64) }]));
  assert.equal(result.entries[0].status, "blocked"); assert.match(result.entries[0].error ?? "", /bytes do not match/); store.close();
});

test("QV5 batch dry-run performs semantic preflight without state, Vault, or Ledger writes", () => {
  const { home, store } = fresh(); const fx = createQv5Fixture(home, store); const ledger = readFileSync(store.eventsPath, "utf8"); const vault = readFileSync(fx.target.path, "utf8");
  const result = applyQv5KnowledgeRevisionBatch(home, store, batchPlan([fx.entry]), { dryRun: true });
  assert.equal(result.entries[0].status, "pending"); assert.equal(existsSync(result.statePath), false); assert.equal(readFileSync(store.eventsPath, "utf8"), ledger); assert.equal(readFileSync(fx.target.path, "utf8"), vault); store.close();
});

test("QV5 batch resume and repeat never increment an already applied entry", () => {
  const { home, store } = fresh(); const fx = createQv5Fixture(home, store); const plan = batchPlan([fx.entry]);
  const first = applyQv5KnowledgeRevisionBatch(home, store, plan); const resumed = applyQv5KnowledgeRevisionBatch(home, store, plan, { resume: true }); const repeated = applyQv5KnowledgeRevisionBatch(home, store, plan);
  assert.equal(first.entries[0].attempt, 1); assert.equal(resumed.entries[0].attempt, 1); assert.equal(repeated.entries[0].attempt, 1); assert.equal(findKnowledge(home, fx.target.id)?.revision, 2); assert.equal(store.listEvents().filter((event) => event.aggregateId === fx.target.id && event.eventType === "knowledge.revised").length, 1); store.close();
});

test("QV5 batch dry-run reuses semantic preflight for a fidelity mismatch", () => {
  const { home, store } = fresh(); const fx = createQv5Fixture(home, store); writeFileSync(fx.paths.fidelity, "tampered");
  const result = applyQv5KnowledgeRevisionBatch(home, store, batchPlan([fx.entry]), { dryRun: true });
  assert.equal(result.entries[0].status, "blocked"); assert.match(result.entries[0].error ?? "", /Artifact bytes changed/); assert.equal(existsSync(result.statePath), false); store.close();
});
