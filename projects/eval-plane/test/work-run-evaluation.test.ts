import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createDefaultEvalRegistry } from "../src/eval-registry.ts";
import { coordinateWorkRunEvaluation } from "../src/work-evaluation-coordinator.ts";
import { loadWorkRunSubject } from "../src/work-run-subject.ts";

const ikbRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evalPlaneRoot = resolve(ikbRoot, "projects", "eval-plane");

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createCompleteWorkRun(): { root: string; taskDir: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "work-run-eval-"));
  const taskDir = join(root, ".agent-work", "demo");
  const runId = "run-demo";
  mkdirSync(join(taskDir, "nodes", "implement"), { recursive: true });
  mkdirSync(join(taskDir, "nodes", "verify"), { recursive: true });
  writeJson(join(taskDir, "task.json"), {
    schema: "work-harness-task-v1",
    task_id: "demo",
    run_id: runId,
    objective: "evaluate a real task directory",
    scope: ["src"],
    acceptance: ["implementation and verification complete"],
    allowed_side_effects: [],
    budget: { max_agents: 2, max_retries: 1 },
    runtime: "codex",
  });
  writeJson(join(taskDir, "plan.json"), {
    schema: "work-harness-plan-v1",
    task_id: "demo",
    native_plan: { source: "codex", steps: [] },
    nodes: [
      {
        id: "implement", kind: "implement", goal: "implement", depends_on: [], status: "completed",
        read_scope: ["src"], write_scope: ["src/feature"], dispatch_reasons: ["independent_write"],
        post_conditions: ["feature exists"], acceptance: ["tests pass"], output_contract: { handoff: "nodes/implement/handoff.json" }, allowed_side_effects: [],
      },
      {
        id: "verify", kind: "verify", goal: "verify", depends_on: ["implement"], status: "completed",
        read_scope: ["src"], write_scope: [".agent-work/demo/nodes/verify"], dispatch_reasons: ["independent_verification"],
        post_conditions: ["quality checked"], acceptance: ["independent verdict recorded"], output_contract: { handoff: "nodes/verify/handoff.json" }, allowed_side_effects: [],
      },
    ],
  });
  writeJson(join(taskDir, "run-state.json"), {
    schema: "work-harness-v1",
    task_id: "demo",
    status: "completed",
    current_nodes: [],
    completed_nodes: ["implement", "verify"],
    attempts: { implement: 1, verify: 1 },
  });
  writeJson(join(taskDir, "nodes", "implement", "handoff.json"), {
    status: "completed", conclusion: "implemented", evidence: ["case://implementation"], artifacts: ["nodes/implement/handoff.json"], validation: ["unit tests passed"], risks: [], next_action: "verify",
  });
  writeJson(join(taskDir, "nodes", "verify", "handoff.json"), {
    status: "completed", conclusion: "verified", evidence: ["case://verification"], artifacts: ["nodes/verify/handoff.json"], validation: ["independent checks passed"], risks: [], next_action: "finish",
  });
  writeJson(join(taskDir, "run-summary.json"), {
    schema: "work-harness-run-summary-v1",
    task_id: "demo",
    run_id: runId,
    terminal_status: "completed",
    verification: { verdict: "pass", note: "verified" },
    evidence_refs: ["artifact://test/evidence"],
    artifact_refs: ["nodes/verify/handoff.json"],
    knowledge_refs: [],
    correction_signals: [],
  });
  writeJson(join(taskDir, "verification.json"), { status: "passed", note: "", at: "2026-07-22T00:00:00.000Z" });
  const events = [
    { at: "2026-07-22T00:00:00.000Z", event: "task.initialized", run_id: runId },
    { at: "2026-07-22T00:00:01.000Z", event: "node.started", node_id: "implement", attempt: 1 },
    { at: "2026-07-22T00:00:02.000Z", event: "node.handoff_recorded", node_id: "implement", status: "completed" },
    { at: "2026-07-22T00:00:03.000Z", event: "node.started", node_id: "verify", attempt: 1 },
    { at: "2026-07-22T00:00:04.000Z", event: "node.handoff_recorded", node_id: "verify", status: "completed" },
    { at: "2026-07-22T00:00:05.000Z", event: "run.summary_recorded", run_id: runId },
    { at: "2026-07-22T00:00:06.000Z", event: "task.verified", verdict: "pass" },
  ];
  writeFileSync(join(taskDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { root, taskDir, runId };
}

test("a real Work Harness task directory is assessed and persisted idempotently", () => {
  const { taskDir } = createCompleteWorkRun();
  const registry = createDefaultEvalRegistry();
  const before = loadWorkRunSubject(taskDir);
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(first.report.kind, "run_assessment");
  assert.equal(first.report.suiteId, "work-run-quality");
  assert.equal(first.report.hardGatePassed, true);
  assert.equal(first.results.length, 7);
  assert.equal(first.results.every((result) => result.status === "pass"), true);
  assert.equal(first.reportRef, `artifact://evaluation/work-run-quality/${first.evaluationKey}`);
  assert.equal(loadWorkRunSubject(taskDir).subjectHash, before.subjectHash);

  const eventCount = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n").length;
  const second = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(second.reused, true);
  assert.equal(second.evaluationKey, first.evaluationKey);
  assert.equal(readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n").length, eventCount);
});

test("changing real Handoff evidence creates a new blocked assessment", () => {
  const { taskDir } = createCompleteWorkRun();
  const registry = createDefaultEvalRegistry();
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  const handoffPath = join(taskDir, "nodes", "implement", "handoff.json");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  writeJson(handoffPath, { ...handoff, evidence: [], artifacts: [], validation: [] });
  const second = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.notEqual(second.evaluationKey, first.evaluationKey);
  assert.equal(second.report.hardGatePassed, false);
  const closure = second.results.find((result) => result.caseId === "work-run-node-closure");
  assert.equal(closure?.status, "fail");
  assert.ok(closure?.reasonCodes.includes("handoff_evidence_missing"));
  assert.ok(closure?.reasonCodes.includes("handoff_validation_missing"));
});

test("a tampered Work evaluation report is never reused", () => {
  const { taskDir } = createCompleteWorkRun();
  const registry = createDefaultEvalRegistry();
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  writeFileSync(first.reportPath, `${JSON.stringify({ ...first.report, hardGatePassed: false }, null, 2)}\n`);
  assert.throws(() => coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot }), /content hash mismatch/);
});

test("IKB CLI evaluates and reports a real Work Harness task directory", () => {
  const { root, taskDir } = createCompleteWorkRun();
  const home = join(root, "ikb-home");
  const evaluate = spawnSync(join(ikbRoot, "bin", "ikb"), ["harness", "eval", "--suite", "work-run-quality", "--task-dir", taskDir, "--home", home, "--json"], { cwd: ikbRoot, encoding: "utf8" });
  assert.equal(evaluate.status, 0, evaluate.stderr);
  const value = JSON.parse(evaluate.stdout);
  assert.equal(value.report.hardGatePassed, true);
  const report = spawnSync(join(ikbRoot, "bin", "ikb"), ["harness", "report", "--suite", "work-run-quality", "--task-dir", taskDir, "--home", home, "--json"], { cwd: ikbRoot, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).evaluationKey, value.evaluationKey);
});

test("concurrent Work evaluation attempts reuse one report and one event", async () => {
  const { taskDir } = createCompleteWorkRun();
  const script = join(evalPlaneRoot, "src", "work-eval-cli.ts");
  const invoke = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((complete) => {
    const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", script, "--task-dir", taskDir, "--suite", "work-run-quality"], { cwd: ikbRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => complete({ status, stdout, stderr }));
  });
  const attempts = await Promise.all([invoke(), invoke()]);
  assert.ok(attempts.every((attempt) => attempt.status === 0), attempts.map((attempt) => attempt.stderr).join("\n"));
  const keys = attempts.map((attempt) => JSON.parse(attempt.stdout).evaluationKey);
  assert.equal(new Set(keys).size, 1);
  const events = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(events.length, 1);
});
