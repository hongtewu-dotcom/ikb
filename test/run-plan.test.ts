import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRunPlan, writeRunPlan } from "../src/run-plan.ts";
import { LedgerStore } from "../src/store.ts";

test("Run plan writes one normalized DAG and is idempotent before execution", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-run-plan-"));
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "Plan", goal: "Plan a Run", acceptance: "DAG exists" });
  const run = store.createRun(task.id, "ikb-harness", []);
  const input = join(home, "plan-input.json");
  writeFileSync(input, JSON.stringify({ steps: [{ id: "read", dependsOn: [] }, { id: "write", depends_on: ["read", "read"] }] }));
  const first = writeRunPlan(store, run.id, input);
  const second = writeRunPlan(store, run.id, input);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(first.plan.steps, [{ id: "read", depends_on: [] }, { id: "write", depends_on: ["read"] }]);
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), first.plan);
  store.close();
});

test("Run plan rejects duplicate, missing and cyclic dependencies", () => {
  assert.throws(() => normalizeRunPlan({ steps: [{ id: "same" }, { id: "same" }] }), /unique/);
  assert.throws(() => normalizeRunPlan({ steps: [{ id: "write", depends_on: ["read"] }] }), /missing dependencies/);
  assert.throws(() => normalizeRunPlan({ steps: [{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }] }), /dependency cycle/);
});

test("Run plan cannot be relabelled after a step event exists", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-run-plan-immutable-"));
  const store = new LedgerStore({ home });
  const task = store.createTask({ title: "Plan", goal: "Plan a Run", acceptance: "Plan stays fixed" });
  const run = store.createRun(task.id, "ikb-harness", []);
  const first = join(home, "first.json");
  const changed = join(home, "changed.json");
  writeFileSync(first, JSON.stringify({ steps: [{ id: "read" }] }));
  writeFileSync(changed, JSON.stringify({ steps: [{ id: "write" }] }));
  writeRunPlan(store, run.id, first);
  store.recordHarnessEvent(run.id, "run.step_started", { stepId: "read", stepName: "读取", inputRefs: [], outputRefs: [] });
  assert.throws(() => writeRunPlan(store, run.id, changed), /plan is immutable/);
  store.close();
});
