import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseArgs, runMaintenance, writeMaintenanceRunPlan } from "../scripts/ikb-maintenance.mjs";
import { maintenanceSteps } from "../scripts/ikb-maintenance-plan.mjs";
import { LedgerStore } from "../src/store.ts";
import { createDefaultEvalRegistry } from "../projects/eval-plane/src/eval-registry.ts";
import { coordinateRunEvaluation } from "../projects/eval-plane/src/evaluation-coordinator.ts";

test("maintenance scheduler accepts bounded daily and weekly modes", () => {
  assert.deepEqual(parseArgs(["daily", "--home", "/tmp/ikb-home"]), { mode: "daily", home: "/tmp/ikb-home" });
  assert.deepEqual(parseArgs(["weekly", "--home", "/tmp/ikb-home"]), { mode: "weekly", home: "/tmp/ikb-home" });
  assert.throws(() => parseArgs(["monthly"]), /daily\|weekly/);
});

test("maintenance steps form a dependency chain and weekly work extends daily outputs", () => {
  const daily = maintenanceSteps("daily");
  assert.equal(daily[0].name, "home-init");
  assert.deepEqual(daily.at(-1)?.dependsOn, ["ledger"]);
  assert.equal(daily.some((step) => step.name === "run-evaluation-repair"), false);
  assert.deepEqual(daily.find((step) => step.name === "doctor")?.dependsOn, ["reasoning"]);
  assert.ok(daily.every((step, index) => index === 0 || step.dependsOn.length > 0));
  const weekly = maintenanceSteps("weekly");
  assert.deepEqual(weekly.slice(-3).map((step) => step.name), ["weekly-report", "experience-cluster", "outer-patterns"]);
});

test("maintenance plan is a pure dependency graph with explicit external-read controls", () => {
  const previous = process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN;
  process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN = "true";
  try {
    const steps = maintenanceSteps("daily");
    const resolve = steps.find((step) => step.name === "candidate-resolve");
    assert.ok(resolve);
    assert.ok(resolve.args.includes("--dry-run"));
    assert.deepEqual(steps.map((step) => step.name), [
      "home-init", "source-ingest", "source-raw-dedup", "experience-triage",
      "candidate-discover", "candidate-resolve", "people-rebuild",
      "knowledge-rebuild", "knowledge-archive", "knowledge-lint", "reasoning",
      "doctor", "ledger", "report",
    ]);
  } finally {
    if (previous === undefined) delete process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN;
    else process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN = previous;
  }
});

test("maintenance materializes every executable step and its final summary in the Run plan", (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "ikb-maintenance-plan-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const steps = maintenanceSteps("daily");
  const path = writeMaintenanceRunPlan(runDir, steps);
  const plan = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(plan.steps.slice(0, -1).map((step) => step.id), steps.map((step) => step.name));
  assert.deepEqual(plan.steps.at(-1), { id: "maintenance-summary", depends_on: [steps.at(-1).name] });
});

test("maintenance closes a real Run quality chain without post-evaluation Artifact drift", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-maintenance-run-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = {
    from: process.env.IKB_MAINTENANCE_HISTORY_FROM,
    to: process.env.IKB_MAINTENANCE_HISTORY_TO,
    dryRun: process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN,
    limit: process.env.IKB_MAINTENANCE_CITADEL_LIMIT,
  };
  process.env.IKB_MAINTENANCE_HISTORY_FROM = "2099-01-01T00:00:00Z";
  process.env.IKB_MAINTENANCE_HISTORY_TO = "2099-01-02T00:00:00Z";
  process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN = "true";
  process.env.IKB_MAINTENANCE_CITADEL_LIMIT = "10";
  t.after(() => {
    for (const [key, value] of Object.entries({
      IKB_MAINTENANCE_HISTORY_FROM: previous.from,
      IKB_MAINTENANCE_HISTORY_TO: previous.to,
      IKB_MAINTENANCE_CITADEL_DRY_RUN: previous.dryRun,
      IKB_MAINTENANCE_CITADEL_LIMIT: previous.limit,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const summary = runMaintenance({ mode: "daily", home });
  assert.equal(summary.ok, true);
  assert.equal(summary.harnessEvaluation.hardGatePassed, true);
  assert.equal(summary.harnessEvaluation.passedCases, 8);

  const store = new LedgerStore({ home });
  try {
    const repeated = coordinateRunEvaluation(store, createDefaultEvalRegistry(), summary.runId, {
      projectRoot: resolve(new URL("..", import.meta.url).pathname),
      suiteId: "ikb-run-quality",
    });
    assert.equal(repeated.report.hardGatePassed, true);
    assert.equal(repeated.report.results.every((result) => result.status === "pass"), true);
  } finally {
    store.close();
  }
});
