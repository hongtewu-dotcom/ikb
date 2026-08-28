import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultEvalRegistry, EvalRegistry } from "../src/eval-registry.ts";
import { compareEvalResults, runEvalSuite } from "../src/eval-runner.ts";
import { EVAL_CASE_SCHEMA, EVAL_SUITE_SCHEMA, DETERMINISTIC_GRADER_VERSION, validateEvalCase, validateEvalResult } from "../src/eval-contract.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the unified registry keeps the legacy twelve cases and exposes versioned adapter suites", () => {
  const registry = createDefaultEvalRegistry();
  const suites = registry.listSuites();
  assert.equal(suites.length, 10);
  assert.equal(suites.filter((suite) => suite.adapter === "ikb" && suite.kind === "regression").flatMap((suite) => suite.cases).length, 12);
  assert.equal(new Set(suites.filter((suite) => suite.adapter === "ikb" && suite.kind === "regression").flatMap((suite) => suite.cases)).size, 12);
  assert.deepEqual(suites.map((suite) => suite.suiteId), [
    "ikb-admission-knowledge",
    "ikb-mid-run-quality",
    "ikb-approval-recovery-security",
    "ikb-outer-loop",
    "work-protocol",
    "specx-ac",
    "pipeline-contract",
    "ikb-run-quality",
    "work-run-quality",
    "specx-change-quality",
  ]);
  assert.equal(registry.getSuite("ikb-run-quality").kind, "run_assessment");
  assert.equal(registry.getSuite("work-run-quality").kind, "run_assessment");
  assert.equal(registry.getSuite("work-run-quality").suiteVersion, "v4");
  assert.deepEqual(registry.getSuite("specx-change-quality").requiredCaseIds, [
    "specx-source-integrity",
    "specx-evidence-provenance",
    "specx-flight-outcome",
  ]);
});

test("duplicate Suite id and version is rejected", () => {
  const registry = new EvalRegistry();
  const suite = { schema: EVAL_SUITE_SCHEMA, kind: "regression" as const, suiteId: "demo", suiteVersion: "v1", harnessId: "ikb", levels: ["L1" as const], graderVersion: DETERMINISTIC_GRADER_VERSION, cases: ["demo-case"], thresholds: {}, adapter: "ikb" as const };
  const testCase = { schema: EVAL_CASE_SCHEMA, caseId: "demo-case", suiteId: "demo", suiteVersion: "v1", level: "L1" as const, title: "demo", description: "demo", inputRefs: ["case://demo"], expected: { outcome: "pass", invariants: [] }, grader: { type: "deterministic" as const, version: DETERMINISTIC_GRADER_VERSION }, tags: [], adapter: "ikb" as const };
  registry.register(suite, [testCase]);
  assert.throws(() => registry.register(suite, [testCase]), /already registered/);
});

test("Eval contracts reject raw Prompt, output, path, URL and approval payload fields", () => {
  assert.throws(() => validateEvalResult({
    schema: "ikb-eval-result-v1", evalVersion: "v1", suiteId: "demo", suiteVersion: "v1", caseId: "demo", harnessId: "ikb", runId: "run-1", subjectVersion: "v1", graderVersion: "deterministic-v1", level: "L1", expected: "pass", observed: "pass", status: "pass", reasonCodes: [], metrics: {}, evidenceRefs: ["case://demo"], artifactRefs: ["artifact://demo"], diagnosis: "subject", prompt: "do not persist this",
  }), /unsupported or unsafe/);
  assert.throws(() => validateEvalCase({
    schema: EVAL_CASE_SCHEMA, caseId: "unsafe", suiteId: "demo", suiteVersion: "v1", level: "L1", title: "unsafe", description: "unsafe", inputRefs: ["https://private.example/doc"], expected: { outcome: "pass", invariants: [] }, grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION }, tags: [], adapter: "ikb", approvalPayload: { secret: true },
  }), /safe versioned reference|unsupported or unsafe/);
});

test("fixture adapters run deterministic negative L1 cases and domain metrics without a total score", () => {
  const registry = createDefaultEvalRegistry();
  const work = runEvalSuite(registry, "work-protocol", { projectRoot });
  assert.equal(work.report.hardGatePassed, true);
  assert.equal(work.results.length, 9);
  assert.equal(work.report.levels.some((level) => level.level === "L1" && level.failedCases === 0), true);
  assert.deepEqual(work.report.levels.find((level) => level.level === "L1")?.reasonCodes, {});
  assert.equal(Object.prototype.hasOwnProperty.call(work.report, "score"), false);
  assert.equal(runEvalSuite(registry, "specx-ac", { projectRoot }).results[0].status, "pass");
  assert.equal(runEvalSuite(registry, "pipeline-contract", { projectRoot }).results[0].status, "pass");
});

test("Adapter thresholds come from the registered Suite", () => {
  const registry = new EvalRegistry();
  registry.register({
    schema: EVAL_SUITE_SCHEMA, kind: "regression", suiteId: "strict-specx", suiteVersion: "v1", harnessId: "specx", levels: ["L3"],
    graderVersion: DETERMINISTIC_GRADER_VERSION, cases: ["strict-coverage"], thresholds: { acCoverage: 1.1 }, adapter: "specx",
  }, [{
    schema: EVAL_CASE_SCHEMA, caseId: "strict-coverage", suiteId: "strict-specx", suiteVersion: "v1", level: "L3", title: "strict", description: "strict",
    inputRefs: ["fixture://specx/valid-change.json"], expected: { outcome: "pass", invariants: [] }, grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION }, tags: [], adapter: "specx",
  }]);
  const result = runEvalSuite(registry, "strict-specx", { projectRoot }).results[0];
  assert.equal(result.status, "fail");
  assert.equal(result.metrics.requiredCoverage, 1.1);
});

test("same Suite produces a case-level before/after comparison", () => {
  const registry = createDefaultEvalRegistry();
  const before = runEvalSuite(registry, "work-protocol", { projectRoot, runId: "before" }).results;
  const after = runEvalSuite(registry, "work-protocol", { projectRoot, runId: "after" }).results.map((result) => result.caseId === "work-quality-summary" ? { ...result, status: "fail" as const, reasonCodes: ["regression"] } : result);
  const comparison = compareEvalResults(before, after);
  assert.equal(comparison.suiteId, "work-protocol");
  assert.deepEqual(comparison.newlyFailing, ["work-quality-summary"]);
  assert.ok(comparison.changedCases.some((item) => item.caseId === "work-quality-summary"));
});
