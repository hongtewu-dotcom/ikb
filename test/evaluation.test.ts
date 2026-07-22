import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordinateRunEvaluation, loadLatestRunEvaluation, recordEvaluationFailure } from "../projects/eval-plane/src/evaluation-coordinator.ts";
import { createDefaultEvalRegistry } from "../projects/eval-plane/src/eval-registry.ts";
import { loadRunSubject } from "../projects/eval-plane/src/run-subject.ts";
import { buildRunQualityProjection } from "../src/run-quality.ts";
import { LedgerStore } from "../src/store.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalPlaneRoot = join(projectRoot, "projects", "eval-plane");

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "ikb-evaluation-"));
}

function createCompleteRun(store: LedgerStore, home: string): ReturnType<LedgerStore["requireRun"]> {
  const task = store.createTask({ title: "真实 Run 评估", goal: "验证完整质量链", acceptance: "评估通过", type: "general", scope: "work" });
  const run = store.createRun(task.id, "ikb-harness", ["real-run"]);
  writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify({ status: "planned", steps: [{ id: "step-1", depends_on: [] }] }, null, 2)}\n`);
  store.recordHarnessEvent(run.id, "run.step_started", {
    stepId: "step-1", stepName: "执行", inputRefs: ["run://input"], outputRefs: [],
  });
  const artifactPath = join(home, `${run.id}-result.md`);
  writeFileSync(artifactPath, "# verified result\n");
  const artifact = store.createArtifact({ runId: run.id, kind: "document", label: "result", path: artifactPath });
  store.recordHarnessEvent(run.id, "run.step_finished", {
    stepId: "step-1", stepName: "执行", inputRefs: ["run://input"], outputRefs: [`artifact://${artifact.id}`], status: "succeeded",
  });
  store.recordHarnessEvent(run.id, "run.gate_evaluated", {
    gateId: "G6", decision: "pass", evidenceRefs: [`artifact://${artifact.id}`], gateVersion: "gates.v1",
  });
  store.recordHarnessEvent(run.id, "run.artifact_linked", {
    artifactId: artifact.id, relation: "produced", lineageRefs: [`run://${run.id}`],
  });
  store.recordHarnessEvent(run.id, "run.verification_completed", {
    result: "pass", checks: [{ id: "acceptance", decision: "pass", evidenceRefs: [`artifact://${artifact.id}`] }], artifactRefs: [`artifact://${artifact.id}`],
  });
  return store.finishRun(run.id, "succeeded", "done");
}

test("a real Run is assessed from Ledger evidence and the report is registered idempotently", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-test" });
  const run = createCompleteRun(store, home);
  const subjectBefore = loadRunSubject(store, run.id);
  const registry = createDefaultEvalRegistry();
  const first = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });

  assert.equal(first.report.kind, "run_assessment");
  assert.equal(first.report.hardGatePassed, true);
  assert.equal(first.results.length, 8);
  assert.equal(first.results.every((result) => result.status === "pass"), true);
  assert.equal(first.artifact.kind, "evaluation_report");
  assert.equal(first.artifact.ref, `artifact://${first.artifact.id}`);
  assert.equal(first.evaluationEvent.payload.evaluationKey, first.evaluationKey);
  assert.equal(first.evaluationEvent.payload.subjectHash, subjectBefore.subjectHash);

  const subjectAfter = loadRunSubject(store, run.id);
  assert.equal(subjectAfter.subjectHash, subjectBefore.subjectHash);
  const eventCount = store.listEvents().length;
  const artifactCount = store.listArtifacts({ runId: run.id }).length;
  const second = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  assert.equal(second.reused, true);
  assert.equal(second.evaluationKey, first.evaluationKey);
  assert.equal(second.artifact.id, first.artifact.id);
  assert.equal(store.listEvents().length, eventCount);
  assert.equal(store.listArtifacts({ runId: run.id }).length, artifactCount);
  assert.equal(store.listEvents().filter((event) => event.aggregateId === run.id && event.eventType === "run.evaluation_completed").length, 1);

  const projection = buildRunQualityProjection(store.requireRun(run.id), store.listEvents(), "work");
  assert.equal(projection.quality.qualityState, "pass");
  assert.equal(projection.quality.firstPass, true);
  assert.equal(projection.quality.finalPass, true);
  store.close();
});

test("a broken Ledger hash chain is an L1 hard block even when the payload remains parseable", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-ledger-integrity-test" });
  const run = createCompleteRun(store, home);
  const lines = readFileSync(store.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const step = lines.find((event) => event.aggregateId === run.id && event.eventType === "run.step_finished");
  assert.ok(step);
  step.payload.stepName = "被篡改但仍可解析";
  writeFileSync(store.eventsPath, `${lines.map((event) => JSON.stringify(event)).join("\n")}\n`);
  store.reload();

  const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), run.id, { projectRoot: evalPlaneRoot });
  const quality = result.results.find((item) => item.caseId === "run-quality-chain");
  assert.equal(result.report.hardGatePassed, false);
  assert.equal(result.evaluationEvent.payload.result, "blocked");
  assert.ok(quality?.reasonCodes.includes("ledger_integrity_broken"));
  assert.ok(Number(quality?.metrics.ledgerBrokenChains) > 0);
  store.close();
});

test("every planned Step and produced Artifact must be closed by execution and Verifier evidence", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-closure-test" });
  const run = createCompleteRun(store, home);
  writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify({ status: "planned", steps: [
    { id: "step-1", depends_on: [] },
    { id: "step-2", depends_on: ["step-1"] },
  ] }, null, 2)}\n`);
  const uncoveredPath = join(home, `${run.id}-uncovered.md`);
  writeFileSync(uncoveredPath, "# uncovered result\n");
  const uncovered = store.createArtifact({ runId: run.id, kind: "document", label: "uncovered", path: uncoveredPath });
  store.recordHarnessEvent(run.id, "run.artifact_linked", {
    artifactId: uncovered.id, relation: "produced", lineageRefs: [`run://${run.id}`],
  });

  const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), run.id, { projectRoot: evalPlaneRoot });
  const quality = result.results.find((item) => item.caseId === "run-quality-chain");
  assert.equal(result.report.hardGatePassed, false);
  assert.ok(quality?.reasonCodes.includes("plan_step_incomplete"));
  assert.ok(quality?.reasonCodes.includes("step_artifact_coverage_missing"));
  assert.ok(quality?.reasonCodes.includes("gate_artifact_coverage_missing"));
  assert.ok(quality?.reasonCodes.includes("verifier_artifact_coverage_missing"));
  assert.ok(quality?.reasonCodes.includes("verifier_evidence_coverage_missing"));
  store.close();
});

test("terminal success without Verifier and Artifact is blocked by the real Run Suite", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-test" });
  const task = store.createTask({ title: "证据缺失", goal: "不能误判", acceptance: "必须阻断", scope: "work" });
  const run = store.createRun(task.id, "ikb-harness");
  store.finishRun(run.id, "succeeded", "terminal only");
  const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), run.id, { projectRoot: evalPlaneRoot });
  const quality = result.results.find((item) => item.caseId === "run-quality-chain");
  assert.equal(result.report.hardGatePassed, false);
  assert.equal(result.evaluationEvent.payload.result, "blocked");
  assert.ok(quality?.reasonCodes.includes("successful_step_missing"));
  assert.ok(quality?.reasonCodes.includes("verifier_not_passed"));
  assert.ok(quality?.reasonCodes.includes("produced_artifact_missing"));
  assert.equal(store.listArtifacts({ runId: run.id }).filter((artifact) => artifact.kind === "evaluation_report").length, 1);
  assert.equal(buildRunQualityProjection(store.requireRun(run.id), store.listEvents(), "work").quality.qualityState, "block");
  store.close();
});

test("a registered Artifact with missing content cannot satisfy the quality chain", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-missing-artifact-test" });
  const run = createCompleteRun(store, home);
  unlinkSync(join(home, `${run.id}-result.md`));
  const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), run.id, { projectRoot: evalPlaneRoot });
  const quality = result.results.find((item) => item.caseId === "run-quality-chain");
  assert.equal(result.report.hardGatePassed, false);
  assert.ok(quality?.reasonCodes.includes("artifact_content_missing"));
  assert.ok(quality?.reasonCodes.includes("artifact_hash_mismatch"));
  store.close();
});

test("an Approval and Action hash mismatch fails the L1 binding Case", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-test" });
  const task = store.createTask({ title: "审批绑定", goal: "校验 Action", acceptance: "hash 一致", scope: "work" });
  const run = store.createRun(task.id, "ikb-harness");
  writeFileSync(join(run.runDir, "plan.json"), `${JSON.stringify({ status: "planned", steps: [{ id: "step-1", depends_on: [] }] }, null, 2)}\n`);
  const approval = store.requestApproval({ runId: run.id, action: "publish", target: "document-1", payload: { version: 1 } });
  store.decideApproval(approval.id, "approved");
  store.resumeRun(run.id);
  const wrongHash = "b".repeat(64);
  store.recordHarnessEvent(run.id, "run.approval_checked", {
    approvalId: approval.id, approvalDecision: "approved", action: "publish", targetHash: wrongHash, payloadHash: wrongHash,
  });
  store.recordHarnessEvent(run.id, "run.action_executed", {
    actionId: "publish-1", action: "publish", sideEffectLevel: "L2", targetHash: wrongHash, payloadHash: wrongHash,
    approvalId: approval.id, status: "succeeded",
  });
  store.recordHarnessEvent(run.id, "run.step_finished", { stepId: "step-1", stepName: "发布", inputRefs: [], outputRefs: ["artifact://result"], status: "succeeded" });
  const resultPath = join(home, "approval-result.md");
  writeFileSync(resultPath, "done\n");
  const artifact = store.createArtifact({ runId: run.id, kind: "document", label: "result", path: resultPath });
  store.recordHarnessEvent(run.id, "run.artifact_linked", { artifactId: artifact.id, relation: "produced", lineageRefs: [`run://${run.id}`] });
  store.recordHarnessEvent(run.id, "run.gate_evaluated", { gateId: "G6", decision: "pass", evidenceRefs: [`artifact://${artifact.id}`], gateVersion: "gates.v1" });
  store.recordHarnessEvent(run.id, "run.verification_completed", { result: "pass", checks: [{ id: "done", decision: "pass", evidenceRefs: [`artifact://${artifact.id}`] }], artifactRefs: [`artifact://${artifact.id}`] });
  store.finishRun(run.id, "succeeded");

  const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), run.id, { projectRoot: evalPlaneRoot });
  const binding = result.results.find((item) => item.caseId === "run-approval-binding");
  assert.equal(binding?.status, "fail");
  assert.ok(binding?.reasonCodes.includes("approval_action_mismatch"));
  assert.equal(result.report.hardGatePassed, false);
  store.close();
});

test("the CLI evaluates and reports an existing real Run", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-cli-test" });
  const run = createCompleteRun(store, home);
  store.close();
  const evaluate = spawnSync(join(projectRoot, "bin", "ikb"), ["run", "evaluate", run.id, "--home", home, "--json"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(evaluate.status, 0, evaluate.stderr);
  const value = JSON.parse(evaluate.stdout);
  assert.equal(value.report.kind, "run_assessment");
  assert.equal(value.report.hardGatePassed, true);
  const report = spawnSync(join(projectRoot, "bin", "ikb"), ["harness", "report", "--suite", "ikb-run-quality", "--run", run.id, "--home", home, "--json"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).evaluationKey, value.evaluationKey);
});

test("CLI run finish triggers a bounded assessment without changing the terminal result", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-auto-test" });
  const task = store.createTask({ title: "自动评估", goal: "终态后评估", acceptance: "留下阻断证据", scope: "work" });
  const run = store.createRun(task.id, "ikb-harness");
  store.close();

  const finish = spawnSync(join(projectRoot, "bin", "ikb"), ["run", "finish", run.id, "--status", "succeeded", "--home", home, "--json"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(JSON.parse(finish.stdout).status, "succeeded");
  const reopened = new LedgerStore({ home, actor: "evaluation-auto-test" });
  const evaluation = reopened.listEvents().find((event) => event.aggregateId === run.id && event.eventType === "run.evaluation_completed");
  assert.ok(evaluation);
  assert.equal(evaluation.payload.result, "blocked");
  assert.equal(reopened.requireRun(run.id).status, "succeeded");
  reopened.close();
});

test("evaluation repair backfills terminal Runs and reuses current assessments", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-repair-test" });
  const run = createCompleteRun(store, home);
  store.close();

  const first = spawnSync(join(projectRoot, "bin", "ikb"), ["harness", "repair", "--suite", "ikb-run-quality", "--limit", "10", "--home", home, "--json"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).created, 1);
  const second = spawnSync(join(projectRoot, "bin", "ikb"), ["harness", "repair", "--suite", "ikb-run-quality", "--limit", "10", "--home", home, "--json"], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).reused, 1);
});

test("a tampered Evaluation Artifact is never reused", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-integrity-test" });
  const run = createCompleteRun(store, home);
  const registry = createDefaultEvalRegistry();
  const result = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  writeFileSync(result.artifact.path, `${JSON.stringify({ ...result.report, hardGatePassed: false }, null, 2)}\n`);
  assert.throws(() => coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot }), /content hash mismatch/);
  store.close();
});

test("a missing Evaluation report file is rebuilt without duplicating Ledger entities", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-recovery-test" });
  const run = createCompleteRun(store, home);
  const registry = createDefaultEvalRegistry();
  const first = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  const eventCount = store.listEvents().length;
  const artifactCount = store.listArtifacts({ runId: run.id }).length;
  unlinkSync(first.artifact.path);
  const recovered = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.artifact.id, first.artifact.id);
  assert.equal(existsSync(first.artifact.path), true);
  assert.equal(store.listEvents().length, eventCount);
  assert.equal(store.listArtifacts({ runId: run.id }).length, artifactCount);
  store.close();
});

test("changing a produced Artifact changes the subject and creates a blocked assessment version", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-subject-test" });
  const run = createCompleteRun(store, home);
  const registry = createDefaultEvalRegistry();
  const first = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  writeFileSync(join(home, `${run.id}-result.md`), "# changed after registration\n");
  const second = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  const quality = second.results.find((item) => item.caseId === "run-quality-chain");
  assert.notEqual(second.evaluationKey, first.evaluationKey);
  assert.equal(second.reused, false);
  assert.equal(second.report.hardGatePassed, false);
  assert.ok(quality?.reasonCodes.includes("artifact_hash_mismatch"));
  assert.equal(store.listArtifacts({ runId: run.id }).filter((artifact) => artifact.kind === "evaluation_report").length, 2);
  store.close();
});

test("environment failures and unrelated Suites do not hide a valid quality assessment", () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-selection-test" });
  const run = createCompleteRun(store, home);
  const registry = createDefaultEvalRegistry();
  const valid = coordinateRunEvaluation(store, registry, run.id, { projectRoot: evalPlaneRoot });
  recordEvaluationFailure(store, registry, run.id, "ikb-run-quality", "post_assessment_environment_failure");
  store.recordHarnessEvent(run.id, "run.evaluation_completed", {
    evalVersion: "eval-plane.v1", suiteId: "other-run-suite", suiteVersion: "v1", graderVersion: "deterministic-v1",
    diagnosis: "subject", result: "blocked", reasonCodes: ["unrelated"], totalCases: 1, passedCases: 0, failedCases: 1,
    failedCaseRefs: ["case://other"], artifactRefs: [],
  });
  const latest = loadLatestRunEvaluation(store, registry, run.id, "ikb-run-quality");
  assert.equal(latest?.evaluationKey, valid.evaluationKey);
  const projection = buildRunQualityProjection(store.requireRun(run.id), store.listEvents(), "work");
  assert.equal(projection.quality.evaluationResult, "pass");
  assert.equal(projection.quality.qualityState, "pass");
  assert.equal(projection.quality.evaluationEnvironmentFailures, 1);
  store.close();
});

test("concurrent evaluation attempts never duplicate the report Artifact or completion event", async () => {
  const home = freshHome();
  const store = new LedgerStore({ home, actor: "evaluation-concurrency-test" });
  const run = createCompleteRun(store, home);
  store.close();
  const invoke = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((complete) => {
    const child = spawn(join(projectRoot, "bin", "ikb"), ["run", "evaluate", run.id, "--home", home, "--json"], { cwd: projectRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => complete({ status, stdout, stderr }));
  });
  const attempts = await Promise.all([invoke(), invoke()]);
  assert.ok(attempts.every((attempt) => attempt.status === 0), attempts.map((attempt) => attempt.stderr).join("\n"));
  const evaluationKeys = attempts.map((attempt) => JSON.parse(attempt.stdout).evaluationKey);
  assert.equal(new Set(evaluationKeys).size, 1);
  const reopened = new LedgerStore({ home, actor: "evaluation-concurrency-test" });
  assert.equal(reopened.listEvents().filter((event) => event.aggregateId === run.id && event.eventType === "run.evaluation_completed").length, 1);
  assert.equal(reopened.listArtifacts({ runId: run.id }).filter((artifact) => artifact.kind === "evaluation_report").length, 1);
  reopened.close();
});
