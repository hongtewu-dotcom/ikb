import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DETERMINISTIC_GRADER_VERSION,
  EVAL_CASE_SCHEMA,
  EVAL_RESULT_SCHEMA,
  EVAL_SUITE_SCHEMA,
  EVAL_VERSION,
  type EvalCase,
  type EvalResult,
  type EvalStatus,
  type EvalSuite,
  validateEvalSuite,
} from "../src/eval-contract.ts";
import { EvalRegistry } from "../src/eval-registry.ts";
import { buildEvalReport, compareEvalResults, runEvalSuite } from "../src/eval-runner.ts";

function suite(requiredCaseIds?: string[]): EvalSuite {
  return {
    schema: EVAL_SUITE_SCHEMA,
    kind: "regression",
    suiteId: "three-state",
    suiteVersion: "v1",
    harnessId: "ikb",
    levels: ["L1"],
    graderVersion: DETERMINISTIC_GRADER_VERSION,
    cases: ["case-a", "case-b", "case-c", "case-d", "case-e"],
    ...(requiredCaseIds === undefined ? {} : { requiredCaseIds }),
    thresholds: {},
    adapter: "ikb",
  };
}

function result(caseId: string, status: EvalStatus, reasonCodes: string[] = []): EvalResult {
  return {
    schema: EVAL_RESULT_SCHEMA,
    evalVersion: EVAL_VERSION,
    suiteId: "three-state",
    suiteVersion: "v1",
    caseId,
    harnessId: "ikb",
    runId: "run",
    subjectVersion: "subject-v1",
    graderVersion: DETERMINISTIC_GRADER_VERSION,
    level: "L1",
    expected: "pass",
    observed: status,
    status,
    reasonCodes,
    metrics: {},
    evidenceRefs: [`case://${caseId}`],
    artifactRefs: [`artifact://${caseId}`],
    diagnosis: "subject",
  };
}

test("requiredCaseIds must be non-empty, unique and part of suite.cases", () => {
  assert.throws(() => validateEvalSuite(suite([])), /must not be empty/);
  assert.throws(() => validateEvalSuite(suite(["case-a", "case-a"])), /must not contain duplicates/);
  assert.throws(() => validateEvalSuite(suite(["outside"])), /must belong/);
  assert.deepEqual(validateEvalSuite(suite(["case-a", "case-b"])).requiredCaseIds, ["case-a", "case-b"]);
});

test("a single required case run cannot pass the full hard gate", () => {
  const registry = new EvalRegistry();
  const caseIds = ["I1-admit-with-contract", "I2-explicit-skip"];
  const cases = caseIds.map((caseId): EvalCase => ({
    schema: EVAL_CASE_SCHEMA,
    caseId,
    suiteId: "required-demo",
    suiteVersion: "v1",
    level: "L1",
    title: caseId,
    description: caseId,
    inputRefs: [`case://${caseId}`],
    expected: { outcome: "pass", invariants: [] },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags: [],
    adapter: "ikb",
    legacyCaseId: caseId,
  }));
  registry.register({
    schema: EVAL_SUITE_SCHEMA,
    kind: "regression",
    suiteId: "required-demo",
    suiteVersion: "v1",
    harnessId: "ikb",
    levels: ["L1"],
    graderVersion: DETERMINISTIC_GRADER_VERSION,
    cases: caseIds,
    requiredCaseIds: caseIds,
    thresholds: {},
    adapter: "ikb",
  }, cases);
  const output = runEvalSuite(registry, "required-demo", { projectRoot: ".", caseId: caseIds[0] });
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].status, "pass");
  assert.equal(output.report.hardGatePassed, false);
});

test("a duplicated required result cannot pass the hard gate", () => {
  const report = buildEvalReport(suite(["case-a", "case-b"]), [
    result("case-a", "pass"),
    result("case-a", "pass"),
    result("case-b", "pass"),
  ], "run");
  assert.equal(report.hardGatePassed, false);
});

test("level reports expose inconclusive counts and aggregate non-pass reasons", () => {
  const report = buildEvalReport(suite(), [
    result("case-a", "pass"),
    result("case-b", "fail", ["shared", "failed"]),
    result("case-c", "inconclusive", ["shared", "unavailable"]),
  ], "run");
  assert.deepEqual(report.levels[0], {
    level: "L1",
    totalCases: 3,
    passedCases: 1,
    failedCases: 1,
    failedCaseIds: ["case-b"],
    inconclusiveCases: 1,
    inconclusiveCaseIds: ["case-c"],
    reasonCodes: { shared: 2, failed: 1, unavailable: 1 },
  });
  const withoutInconclusive = buildEvalReport(suite(), [result("case-a", "pass")], "run");
  assert.equal(Object.hasOwn(withoutInconclusive.levels[0], "inconclusiveCases"), false);
  assert.equal(Object.hasOwn(withoutInconclusive.levels[0], "inconclusiveCaseIds"), false);
});

test("three-state comparisons preserve inconclusive and missing transitions", () => {
  const before = [
    result("case-a", "inconclusive", ["waiting"]),
    result("case-b", "pass"),
    result("case-c", "inconclusive"),
    result("case-d", "pass"),
    result("case-e", "fail"),
  ];
  const after = [
    result("case-a", "pass"),
    result("case-b", "fail"),
    result("case-c", "fail"),
    result("case-d", "inconclusive"),
    result("case-e", "inconclusive"),
    result("case-new", "inconclusive"),
  ];
  const comparison = compareEvalResults(before, after);
  assert.deepEqual(comparison.newlyPassing, ["case-a"]);
  assert.deepEqual(comparison.newlyFailing, ["case-b", "case-c"]);
  assert.equal(comparison.changedCases.find((item) => item.caseId === "case-d")?.after, "inconclusive");
  assert.equal(comparison.changedCases.find((item) => item.caseId === "case-e")?.after, "inconclusive");
  assert.equal(comparison.changedCases.find((item) => item.caseId === "case-new")?.before, "missing");
});
