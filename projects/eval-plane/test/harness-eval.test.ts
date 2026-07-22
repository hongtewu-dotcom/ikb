import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHarnessCase, evaluateHarnessSuite, harnessEvaluationCases } from "../src/harness-eval.ts";

test("the deterministic Harness suite covers the twelve admission, quality, recovery and safety cases", () => {
  const cases = harnessEvaluationCases();
  assert.equal(cases.length, 12);
  const suite = evaluateHarnessSuite();
  assert.equal(suite.total, 12);
  assert.equal(suite.failed, 0, JSON.stringify(suite.results.filter((result) => !result.passed), null, 2));
  assert.equal(suite.passed, 12);
  assert.ok(suite.results.some((result) => result.observed === "block"));
  assert.ok(suite.results.some((result) => result.observed === "proposal"));
  assert.ok(suite.results.some((result) => result.observed === "skip"));
});

test("the evaluator does not mistake terminal success for a verified result", () => {
  const testCase = harnessEvaluationCases().find((item) => item.caseId === "M2-terminal-success-is-not-quality");
  assert.ok(testCase);
  const result = evaluateHarnessCase(testCase);
  assert.equal(result.observed, "block");
  assert.ok(result.failedInvariants.includes("verifier_or_artifact_missing"));
});

test("the evaluator blocks a changed payload from reusing an approval", () => {
  const testCase = harnessEvaluationCases().find((item) => item.caseId === "M4-mismatched-approval-blocks-action");
  assert.ok(testCase);
  const result = evaluateHarnessCase(testCase);
  assert.equal(result.observed, "block");
  assert.ok(result.failedInvariants.includes("approval_missing_or_hash_mismatch"));
});
