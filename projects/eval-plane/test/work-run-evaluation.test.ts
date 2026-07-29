import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createDefaultEvalRegistry } from "../src/eval-registry.ts";
import { coordinateWorkRunEvaluation } from "../src/work-evaluation-coordinator.ts";
import { loadWorkRunSubject } from "../src/work-run-subject.ts";

const ikbRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evalPlaneRoot = resolve(ikbRoot, "projects", "eval-plane");
const canonicalScopeVectors = [
  { id: "dot-and-duplicate-separators", left: "src//feature/./nested/..", right: "src/feature/generated", conflict: true },
  { id: "relative-root", left: ".", right: "src/generated", conflict: true },
  { id: "posix-root", left: "/", right: "/workspace/generated", conflict: true },
  { id: "windows-drive-and-dot-segments", left: "C:\\repo\\src\\..\\out", right: "c:/repo/out/generated", conflict: true },
  { id: "windows-unc", left: "\\\\server\\share\\repo\\..\\out", right: "\\\\SERVER\\share\\out\\generated", conflict: true },
  { id: "different-windows-drives", left: "C:\\repo\\out", right: "D:\\repo\\out", conflict: false },
];

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.atomic-replacement`;
  writeJson(temporary, value);
  renameSync(temporary, path);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(row[key])}`).join(",")}}`;
}

function appendMainEvents(taskDir: string, events: Record<string, unknown>[]): void {
  writeFileSync(join(taskDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { flag: "a" });
}

function replaceQualityEvents(taskDir: string, qualityEvents: Record<string, unknown>[]): void {
  const path = join(taskDir, "events.jsonl");
  const baseEvents = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.event !== "task.verified" && !String(event.event).startsWith("evaluation.trigger_"));
  writeFileSync(path, `${[...baseEvents, ...qualityEvents].map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function workTrigger(
  runId: string,
  verificationId: string | null,
  result: "pass" | "blocked",
  at: string,
): Record<string, unknown> {
  return {
    at,
    event: "evaluation.trigger_completed",
    suite_id: "work-run-quality",
    evaluation_schema: "work-harness-evaluation-v1",
    evaluation_run_id: runId,
    evaluation_key: `evaluation-${verificationId ?? at}`,
    hard_gate_passed: result === "pass",
    result,
    report_ref: `artifact://evaluation/work-run-quality/${verificationId ?? "legacy"}`,
    reused: false,
    ...(verificationId ? { verification_id: verificationId } : {}),
  };
}

function setConcurrentWriteScopes(taskDir: string, left: string, right: string): void {
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes[0].write_scope = [left];
  plan.nodes[1].write_scope = [right];
  plan.nodes[1].depends_on = [];
  writeJson(planPath, plan);
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:01.000Z", event: "node.started", node_id: "implement", attempt: 1 },
    { at: "2026-07-23T00:00:02.000Z", event: "node.started", node_id: "verify", attempt: 1 },
    { at: "2026-07-23T00:00:03.000Z", event: "node.handoff_recorded", node_id: "implement", status: "completed" },
    { at: "2026-07-23T00:00:04.000Z", event: "node.handoff_recorded", node_id: "verify", status: "completed" },
    { at: "2026-07-23T00:00:05.000Z", event: "task.verified", verdict: "pass" },
  ]);
}

function seedLegacyWorkEvaluation(taskDir: string, legacyVersion: "v1" | "v2" | "v3"): { evaluationKey: string; reportPath: string } {
  const subject = loadWorkRunSubject(taskDir);
  const subjectVersion = `work-harness-run-subject.${legacyVersion}`;
  const suiteId = "work-run-quality";
  const suiteVersion = legacyVersion;
  const graderVersion = "deterministic-v1";
  const legacyVerification = { ...subject.data.verification } as Record<string, unknown>;
  delete legacyVerification.verificationId;
  const legacyEvents = subject.data.events
    .filter((event) => !event.event.startsWith("evaluation."))
    .map((event) => {
      const legacy = { ...event } as Record<string, unknown>;
      if (legacyVersion !== "v3") delete legacy.verificationId;
      delete legacy.reason;
      return legacy;
    });
  const subjectHash = sha256(stableStringify({
    subjectVersion,
    data: {
      ...subject.data,
      verification: legacyVerification,
      events: legacyEvents,
    },
  }));
  const evaluationKey = sha256([subject.runId, suiteId, suiteVersion, subjectHash, graderVersion].join("\n"));
  const reportPath = join(taskDir, "evaluations", suiteId, `${evaluationKey}.json`);
  writeJson(reportPath, {
    schema: "ikb-eval-report-v1",
    evalVersion: "v1",
    kind: "run_assessment",
    suiteId,
    suiteVersion,
    harnessId: "work-harness",
    graderVersion,
    runId: subject.runId,
    subjectVersion,
    subjectHash,
    evaluationKey,
    hardGatePassed: true,
    levels: [],
    results: [],
  });
  const reportHash = sha256(readFileSync(reportPath));
  mkdirSync(join(taskDir, "evaluations"), { recursive: true });
  writeFileSync(join(taskDir, "evaluations", "events.jsonl"), `${JSON.stringify({
    schema: "work-harness-eval-event-v1",
    at: "2026-07-22T00:00:07.000Z",
    event: "evaluation.completed",
    runId: subject.runId,
    suiteId,
    suiteVersion,
    graderVersion,
    subjectVersion,
    subjectHash,
    evaluationKey,
    diagnosis: "subject",
    result: "pass",
    totalCases: 0,
    passedCases: 0,
    failedCases: 0,
    reasonCodes: [],
    reportRef: `artifact://evaluation/${suiteId}/${evaluationKey}`,
    reportHash,
  })}\n`);
  return { evaluationKey, reportPath };
}

function setCurrentVerification(taskDir: string, verificationId: string): void {
  const verificationPath = join(taskDir, "verification.json");
  const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
  verification.verification_id = verificationId;
  verification.evaluation_triggers = {
    [verificationId]: {
      status: "pending",
      suite_id: "work-run-quality",
      recorded_at: "2026-07-23T00:00:06.000Z",
    },
  };
  writeJson(verificationPath, verification);
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
  ]);
}

function bindManagedImplementHandoff(taskDir: string): { handoffPath: string; overwriteWithStaleIdentity: () => void } {
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.executions = {
    implement: {
      attempt: 1,
      execution_id: "execution-current",
      executor_kind: "subagent",
      runtime: "codex",
      executor_id: "agent-current",
      status: "completed",
    },
  };
  writeJson(statePath, state);
  const handoffPath = join(taskDir, "nodes", "implement", "handoff.json");
  const handoff = {
    ...JSON.parse(readFileSync(handoffPath, "utf8")),
    task_id: "demo",
    run_id: "run-demo",
    node_id: "implement",
    attempt: 1,
    execution_id: "execution-current",
  };
  writeJson(handoffPath, handoff);
  return {
    handoffPath,
    overwriteWithStaleIdentity: () => {
      replaceJsonAtomically(handoffPath, { ...handoff, execution_id: "execution-stale" });
    },
  };
}

function downgradeManagedImplementIdentity(
  taskDir: string,
  evidenceSource: "descriptor" | "started-event" | "handoff-event",
): void {
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.executions = {
    implement: {
      attempt: 1,
      executor_kind: "subagent",
      runtime: "codex",
      executor_id: "agent-current",
      status: "completed",
    },
  };
  writeJson(statePath, state);

  if (evidenceSource === "descriptor") {
    writeJson(join(taskDir, "nodes", "implement", "execution.json"), {
      schema: "work-harness-node-execution-v1",
      task_id: "demo",
      run_id: "run-demo",
      node_id: "implement",
      attempt: 1,
      execution_id: "execution-current",
      executor_kind: "subagent",
      runtime: "codex",
      executor_id: "agent-current",
      status: "completed",
    });
  } else {
    const eventName = evidenceSource === "started-event" ? "node.started" : "node.handoff_recorded";
    const eventsPath = join(taskDir, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
      .map((event) => event.event === eventName && event.node_id === "implement"
        ? { ...event, execution_id: "execution-current" }
        : event);
    writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  const handoffPath = join(taskDir, "nodes", "implement", "handoff.json");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  writeJson(handoffPath, {
    ...handoff,
    task_id: "demo",
    run_id: "run-demo",
    node_id: "implement",
    attempt: 1,
    execution_id: "execution-stale",
  });
}

function writeDomainEvaluation(
  taskDir: string,
  overrides: Partial<{
    run_id: string;
    required: boolean;
    hard_gate_passed: boolean;
    result: "pass" | "blocked";
    report_ref: string;
    report_hash: string;
    metrics: Record<string, unknown>;
    evidence_refs: string[];
    evaluated_at: string;
  }> = {},
): { reportPath: string; reportBytes: Buffer } {
  const reportPath = join(taskDir, "artifacts", "domain-report.json");
  const reportBytes = Buffer.from('{"cases":30,"passed":30}\n');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, reportBytes);
  writeJson(join(taskDir, "domain-evaluation.json"), {
    schema: "work-harness-domain-evaluation-v1",
    task_id: "demo",
    run_id: "run-demo",
    suite_id: "knowledge-extraction-r1",
    suite_version: "v1",
    grader_version: "deterministic-v2",
    required: true,
    hard_gate_passed: true,
    result: "pass",
    report_ref: "file://artifacts/domain-report.json",
    report_hash: sha256(reportBytes),
    metrics: { case_count: 30, pass_rate: 1 },
    evidence_refs: ["file://artifacts/domain-report.json"],
    evaluated_at: "2026-07-23T00:00:00.000Z",
    ...overrides,
  });
  return { reportPath, reportBytes };
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
  assert.equal(first.report.suiteVersion, "v4");
  assert.equal(first.report.subjectVersion, "work-harness-run-subject.v4");
  assert.equal(first.report.hardGatePassed, true);
  assert.equal(first.results.length, 7);
  assert.equal(first.results.every((result) => result.status === "pass"), true);
  const domain = first.results.find((result) => result.caseId === "work-run-domain-result");
  assert.equal(domain?.observed, "not_applicable");
  assert.equal(domain?.metrics.domain_registered, false);
  assert.equal(first.reportRef, `artifact://evaluation/work-run-quality/${first.evaluationKey}`);
  assert.equal(loadWorkRunSubject(taskDir).subjectHash, before.subjectHash);

  const eventCount = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n").length;
  const second = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(second.reused, true);
  assert.equal(second.evaluationKey, first.evaluationKey);
  assert.equal(readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n").length, eventCount);
});

test("new evaluation completion events explicitly bind hardGatePassed to their report and result", async (context) => {
  for (const expectedHardGate of [true, false]) {
    await context.test(expectedHardGate ? "pass" : "blocked", () => {
      const { taskDir } = createCompleteWorkRun();
      if (!expectedHardGate) writeDomainEvaluation(taskDir, { hard_gate_passed: false, result: "blocked" });
      const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
      const event = JSON.parse(readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim());
      assert.equal(Object.hasOwn(event, "hardGatePassed"), true);
      assert.equal(event.hardGatePassed, evaluation.report.hardGatePassed);
      assert.equal(event.hardGatePassed, expectedHardGate);
      assert.equal(event.result === "blocked", !event.hardGatePassed);
    });
  }
});

test("historical evaluation completion events without hardGatePassed map it from result", async (context) => {
  for (const expectedHardGate of [true, false]) {
    await context.test(expectedHardGate ? "pass" : "blocked", () => {
      const { taskDir } = createCompleteWorkRun();
      if (!expectedHardGate) writeDomainEvaluation(taskDir, { hard_gate_passed: false, result: "blocked" });
      const registry = createDefaultEvalRegistry();
      const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
      const eventsPath = join(taskDir, "evaluations", "events.jsonl");
      const historical = JSON.parse(readFileSync(eventsPath, "utf8").trim());
      delete historical.hardGatePassed;
      writeFileSync(eventsPath, `${JSON.stringify(historical)}\n`);

      const reused = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
      assert.equal(reused.reused, true);
      assert.equal(reused.result, first.result);
      assert.equal((reused.evaluationEvent as { hardGatePassed?: boolean }).hardGatePassed, expectedHardGate);
    });
  }
});

test("an explicit evaluation event hardGatePassed conflict with result is rejected", () => {
  const { taskDir } = createCompleteWorkRun();
  const registry = createDefaultEvalRegistry();
  coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  const eventsPath = join(taskDir, "evaluations", "events.jsonl");
  const event = JSON.parse(readFileSync(eventsPath, "utf8").trim());
  writeFileSync(eventsPath, `${JSON.stringify({ ...event, hardGatePassed: false })}\n`);
  assert.throws(
    () => coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot }),
    /hardGatePassed.*result/,
  );
});

test("work-eval-cli binds an optional verification id and returns the v4 subject identity", () => {
  const { taskDir } = createCompleteWorkRun();
  const verificationId = "verification-cli-1";
  setCurrentVerification(taskDir, verificationId);
  const expectedSubject = loadWorkRunSubject(taskDir);
  const script = join(evalPlaneRoot, "src", "work-eval-cli.ts");
  const result = spawnSync(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    script,
    "--task-dir",
    taskDir,
    "--suite",
    "work-run-quality",
    "--verification-id",
    verificationId,
  ], { cwd: ikbRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verificationId, verificationId);
  assert.equal(output.subjectHash, expectedSubject.subjectHash);
  assert.equal(output.subjectVersion, "work-harness-run-subject.v4");
  assert.equal(output.suiteVersion, "v4");
});

test("work-eval-cli rejects a verification id that changes while waiting for the evaluation lock", async () => {
  const { taskDir } = createCompleteWorkRun();
  const firstVerificationId = "verification-delayed-1";
  const secondVerificationId = "verification-delayed-2";
  setCurrentVerification(taskDir, firstVerificationId);
  const registry = createDefaultEvalRegistry();
  const subject = loadWorkRunSubject(taskDir);
  const suite = registry.getSuite("work-run-quality");
  const evaluationKey = sha256([
    subject.runId,
    suite.suiteId,
    suite.suiteVersion,
    subject.subjectHash,
    suite.graderVersion,
  ].join("\n"));
  const lockPath = join(taskDir, "evaluations", ".locks", evaluationKey);
  mkdirSync(lockPath, { recursive: true });

  const script = join(evalPlaneRoot, "src", "work-eval-cli.ts");
  const child = spawn(process.execPath, [
    "--no-warnings=ExperimentalWarning",
    "--experimental-strip-types",
    script,
    "--task-dir",
    taskDir,
    "--suite",
    "work-run-quality",
    "--verification-id",
    firstVerificationId,
  ], { cwd: ikbRoot });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<number | null>((complete) => child.on("close", complete));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  setCurrentVerification(taskDir, secondVerificationId);
  rmdirSync(lockPath);
  const status = await closed;

  assert.equal(status, 1, stdout);
  assert.match(stderr, /verification identity mismatch/i);
});

test("an import-native-plan terminal shape may omit native step scopes", () => {
  const { taskDir } = createCompleteWorkRun();
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const nativeStep = {
    id: "native-step-001",
    kind: "native-plan-step",
    goal: "inspect current state",
    depends_on: [],
    post_conditions: [],
    acceptance: [],
    output_contract: {},
    allowed_side_effects: [],
    status: "completed",
  };
  plan.native_plan = {
    source: "codex",
    steps: [{ id: nativeStep.id, step: nativeStep.goal, status: "completed", depends_on: [] }],
    imported_at: "2026-07-23T00:00:00Z",
    mode: "one-way-snapshot",
  };
  plan.nodes.unshift(nativeStep);
  writeJson(planPath, plan);
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.completed_nodes.unshift(nativeStep.id);
  state.attempts[nativeStep.id] = 1;
  writeJson(statePath, state);

  const subject = loadWorkRunSubject(taskDir);
  const projected = subject.data.nodes.find((node) => node.id === nativeStep.id);
  assert.deepEqual(projected?.readScope, []);
  assert.deepEqual(projected?.writeScope, []);
  assert.equal(subject.data.integrity.reasonCodes.includes("node_read_scope_invalid"), false);
  assert.equal(subject.data.integrity.reasonCodes.includes("node_write_scope_invalid"), false);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.report.hardGatePassed, true);
  assert.equal(evaluation.results.every((result) => result.status === "pass"), true);
});

test("native plan scope fields remain strict when present", () => {
  const { taskDir } = createCompleteWorkRun();
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes.unshift({
    id: "native-step-001",
    kind: "native-plan-step",
    goal: "inspect current state",
    depends_on: [],
    read_scope: ["src,test"],
    write_scope: null,
    post_conditions: [],
    acceptance: [],
    output_contract: {},
    allowed_side_effects: [],
    status: "completed",
  });
  writeJson(planPath, plan);

  const subject = loadWorkRunSubject(taskDir);
  assert.ok(subject.data.integrity.reasonCodes.includes("node_read_scope_comma_joined"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_write_scope_invalid"));
});

test("v4 Work Run semantics do not reuse indexed v1, v2 or v3 reports", async (context) => {
  for (const legacyVersion of ["v1", "v2", "v3"] as const) {
    await context.test(legacyVersion, () => {
      const { taskDir } = createCompleteWorkRun();
      const legacy = seedLegacyWorkEvaluation(taskDir, legacyVersion);
      const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });

      assert.equal(evaluation.reused, false);
      assert.notEqual(evaluation.evaluationKey, legacy.evaluationKey);
      assert.equal(evaluation.report.subjectVersion, "work-harness-run-subject.v4");
      assert.equal(evaluation.report.suiteVersion, "v4");
      assert.equal(evaluation.evaluationEvent.subjectVersion, "work-harness-run-subject.v4");
      assert.equal(evaluation.evaluationEvent.suiteVersion, "v4");
      assert.equal(readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8").trim().split("\n").length, 2);
      assert.equal(JSON.parse(readFileSync(legacy.reportPath, "utf8")).evaluationKey, legacy.evaluationKey);
    });
  }
});

test("a registered domain evaluation passes L3 with its safe scalar metrics", () => {
  const { taskDir } = createCompleteWorkRun();
  writeDomainEvaluation(taskDir);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.equal(domain?.status, "pass");
  assert.equal(domain?.observed, "pass");
  assert.equal(domain?.metrics.domain_registered, true);
  assert.equal(domain?.metrics.required, true);
  assert.equal(domain?.metrics.hard_gate_passed, true);
  assert.equal(domain?.metrics.case_count, 30);
  assert.equal(domain?.metrics.pass_rate, 1);
  assert.equal(evaluation.report.hardGatePassed, true);
});

test("an absolute file report reference is accepted when it names a regular file", () => {
  const { taskDir } = createCompleteWorkRun();
  const { reportPath, reportBytes } = writeDomainEvaluation(taskDir);
  writeDomainEvaluation(taskDir, {
    report_ref: `file://${reportPath}`,
    report_hash: sha256(reportBytes),
  });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.equal(domain?.status, "pass");
  assert.equal(evaluation.report.hardGatePassed, true);
});

test("a required blocked domain evaluation fails L3 and the whole hard gate", () => {
  const { taskDir } = createCompleteWorkRun();
  writeDomainEvaluation(taskDir, { hard_gate_passed: false, result: "blocked" });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.equal(domain?.status, "fail");
  assert.equal(domain?.observed, "blocked");
  assert.ok(domain?.reasonCodes.includes("required_domain_evaluation_blocked"));
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, false);
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.recoverySucceeded, false);
  assert.equal(evaluation.report.hardGatePassed, false);
  assert.equal(evaluation.result, "blocked");
});

test("an optional blocked domain evaluation fails L3 without becoming a hard gate", () => {
  const { taskDir } = createCompleteWorkRun();
  writeDomainEvaluation(taskDir, { required: false, hard_gate_passed: false, result: "blocked" });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.equal(domain?.status, "fail");
  assert.ok(domain?.reasonCodes.includes("domain_evaluation_blocked"));
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, false);
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.recoverySucceeded, false);
  assert.equal(evaluation.report.hardGatePassed, true);
  assert.equal(evaluation.result, "partial");
});

test("node retry rounds stay independent from first-pass quality and recovery", () => {
  const { taskDir } = createCompleteWorkRun();
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.attempts.implement = 2;
  writeJson(statePath, state);

  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.retryRounds, 1);
  assert.equal(recovery?.metrics.repairRounds, 0);
  assert.equal(recovery?.metrics.finalPass, true);
  assert.equal(recovery?.metrics.firstPass, true);
  assert.equal(recovery?.metrics.recoverySucceeded, false);
});

test("a pending verification with fail verdict cannot be a passing quality attempt", () => {
  const { taskDir } = createCompleteWorkRun();
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "fail", verification_id: "verification-fail" },
  ]);

  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, false);
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.repairRounds, 1);
  assert.equal(recovery?.metrics.recoverySucceeded, false);
});

test("domain metrics reject nested values instead of persisting payloads", () => {
  const { taskDir } = createCompleteWorkRun();
  writeDomainEvaluation(taskDir, { metrics: { case_count: 30, details: { leaked: true } } });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
  assert.ok(integrity?.reasonCodes.includes("domain_evaluation_metrics_invalid"));
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("a tampered domain report is blocked instead of being trusted", () => {
  const { taskDir } = createCompleteWorkRun();
  const { reportPath } = writeDomainEvaluation(taskDir);
  writeFileSync(reportPath, '{"cases":30,"passed":29}\n');
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.ok(integrity?.reasonCodes.includes("domain_evaluation_report_hash_mismatch"));
  assert.equal(domain?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("a domain evaluation bound to another run is blocked", () => {
  const { taskDir } = createCompleteWorkRun();
  writeDomainEvaluation(taskDir, { run_id: "run-other" });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
  const domain = evaluation.results.find((result) => result.caseId === "work-run-domain-result");
  assert.ok(integrity?.reasonCodes.includes("domain_evaluation_run_id_mismatch"));
  assert.equal(domain?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("a symlinked domain report is blocked", () => {
  const { taskDir } = createCompleteWorkRun();
  const { reportPath, reportBytes } = writeDomainEvaluation(taskDir);
  const targetPath = join(taskDir, "artifacts", "domain-report-target.json");
  writeFileSync(targetPath, reportBytes);
  writeFileSync(reportPath, reportBytes);
  const linkPath = join(taskDir, "artifacts", "domain-report-link.json");
  symlinkSync(targetPath, linkPath);
  writeDomainEvaluation(taskDir, {
    report_ref: "file://artifacts/domain-report-link.json",
    report_hash: sha256(reportBytes),
  });
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
  assert.ok(integrity?.reasonCodes.includes("domain_evaluation_report_file_invalid"));
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("domain evaluated_at follows the shared strict calendar vectors", async (context) => {
  const vectorPath = join(evalPlaneRoot, "fixtures", "work-harness", "domain-evaluated-at-vectors.json");
  const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as {
    schema: string;
    cases: Array<{ id: string; value: string; valid: boolean }>;
  };
  assert.equal(vectors.schema, "work-harness-domain-evaluated-at-vectors-v1");
  for (const vector of vectors.cases) {
    await context.test(vector.id, () => {
      const { taskDir } = createCompleteWorkRun();
      writeDomainEvaluation(taskDir, { evaluated_at: vector.value });
      const domain = loadWorkRunSubject(taskDir).data.domainEvaluation;
      assert.equal(domain.valid, vector.valid);
      assert.equal(domain.reasonCodes.includes("domain_evaluation_evaluated_at_invalid"), !vector.valid);
    });
  }
});

test("the Python writer and TypeScript reader agree on the shared evaluated_at vectors", () => {
  const vectorPath = join(evalPlaneRoot, "fixtures", "work-harness", "domain-evaluated-at-vectors.json");
  const python = [
    "import hashlib, importlib.util, json, sys, tempfile",
    "from pathlib import Path",
    "module_path, vector_path = sys.argv[1], sys.argv[2]",
    "spec = importlib.util.spec_from_file_location('work_harness_contract', module_path)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "vectors = json.loads(Path(vector_path).read_text(encoding='utf-8'))",
    "with tempfile.TemporaryDirectory() as raw_tmp:",
    "    task_dir = Path(raw_tmp)",
    "    report = b'{\"cases\":30,\"passed\":30}\\n'",
    "    (task_dir / 'domain-report.json').write_bytes(report)",
    "    base = {",
    "        'schema': 'work-harness-domain-evaluation-v1',",
    "        'task_id': 'demo',",
    "        'run_id': 'run-demo',",
    "        'suite_id': 'knowledge-extraction-r1',",
    "        'suite_version': 'v1',",
    "        'grader_version': 'deterministic-v2',",
    "        'required': True,",
    "        'hard_gate_passed': True,",
    "        'result': 'pass',",
    "        'report_ref': 'file://domain-report.json',",
    "        'report_hash': hashlib.sha256(report).hexdigest(),",
    "        'metrics': {'case_count': 30, 'pass_rate': 1.0},",
    "        'evidence_refs': ['file://domain-report.json'],",
    "    }",
    "    task = {'task_id': 'demo', 'run_id': 'run-demo'}",
    "    observed = []",
    "    for case in vectors['cases']:",
    "        value = {**base, 'evaluated_at': case['value']}",
    "        errors = module.domain_evaluation_errors(value, task, task_dir)",
    "        observed.append({'id': case['id'], 'valid': not errors})",
    "print(json.dumps(observed))",
  ].join("\n");
  const result = spawnSync("python3", [
    "-c",
    python,
    join(ikbRoot, "projects", "_archive", "work-harness-20260724", "scripts", "work_harness.py"),
    vectorPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as { cases: Array<{ id: string; valid: boolean }> };
  assert.deepEqual(JSON.parse(result.stdout), vectors.cases.map(({ id, valid }) => ({ id, valid })));
});

test("domain report bytes are opened with O_NOFOLLOW and read from the fstat descriptor", () => {
  const source = readFileSync(join(evalPlaneRoot, "src", "work-domain-evaluation.ts"), "utf8");
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /openSync/);
  assert.match(source, /fstatSync/);
  assert.match(source, /readFileSync\(descriptor\)/);
});

test("v4 terminal trigger hashing includes semantic reason and excludes bookkeeping fields", () => {
  const makeSubject = (reason: string, at: string, evaluationKey: string, reused: boolean) => {
    const { taskDir } = createCompleteWorkRun();
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
      {
        at,
        event: "evaluation.trigger_failed",
        suite_id: "work-run-quality",
        verification_id: "verification-1",
        reason,
        evaluation_key: evaluationKey,
        report_ref: `artifact://evaluation/work-run-quality/${evaluationKey}`,
        reused,
      },
    ]);
    return loadWorkRunSubject(taskDir);
  };

  const first = makeSubject("timeout", "2026-07-23T00:00:07.000Z", "evaluation-a", false);
  const bookkeepingOnly = makeSubject("timeout", "2026-07-23T00:01:07.000Z", "evaluation-b", true);
  const semanticChange = makeSubject("nonzero_exit", "2026-07-23T00:00:07.000Z", "evaluation-a", false);
  assert.equal(first.subjectHash, bookkeepingOnly.subjectHash);
  assert.notEqual(first.subjectHash, semanticChange.subjectHash);
});

test("identified terminal trigger order follows task verification semantics for hashes and evaluation keys", () => {
  const evaluate = (triggerOrder: readonly ["verification-1" | "verification-2", "verification-1" | "verification-2"]) => {
    const { taskDir, runId } = createCompleteWorkRun();
    const triggers = {
      "verification-1": workTrigger(runId, "verification-1", "blocked", "2026-07-23T00:00:08.000Z"),
      "verification-2": workTrigger(runId, "verification-2", "pass", "2026-07-23T00:00:09.000Z"),
    };
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
      { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-2" },
      ...triggerOrder.map((verificationId) => triggers[verificationId]),
    ]);
    const subject = loadWorkRunSubject(taskDir);
    const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
    return { subject, evaluation };
  };

  const t2ThenT1 = evaluate(["verification-2", "verification-1"]);
  const t1ThenT2 = evaluate(["verification-1", "verification-2"]);
  assert.equal(t2ThenT1.subject.subjectHash, t1ThenT2.subject.subjectHash);
  assert.equal(t2ThenT1.evaluation.evaluationKey, t1ThenT2.evaluation.evaluationKey);
  const outOfOrderRecovery = t2ThenT1.evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  const inOrderRecovery = t1ThenT2.evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.deepEqual(outOfOrderRecovery?.metrics, inOrderRecovery?.metrics);
  assert.equal(outOfOrderRecovery?.metrics.firstPass, false);
  assert.equal(outOfOrderRecovery?.metrics.finalPass, true);
  assert.equal(outOfOrderRecovery?.metrics.repairRounds, 1);
  assert.equal(outOfOrderRecovery?.metrics.recoverySucceeded, true);
});

test("identified terminal triggers after a consumed attempt are ignored for hashing", () => {
  const evaluate = (duplicate: boolean) => {
    const { taskDir, runId } = createCompleteWorkRun();
    const trigger = workTrigger(runId, "verification-1", "pass", "2026-07-23T00:00:07.000Z");
    const duplicateTrigger = {
      ...trigger,
      at: "2026-07-23T00:01:07.000Z",
      evaluation_key: "duplicate-bookkeeping-key",
      report_ref: "artifact://evaluation/work-run-quality/duplicate-bookkeeping-key",
      reused: true,
    };
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
      trigger,
      ...(duplicate ? [duplicateTrigger] : []),
    ]);
    const subject = loadWorkRunSubject(taskDir);
    const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
    return { subject, evaluation };
  };

  const single = evaluate(false);
  const duplicate = evaluate(true);
  assert.equal(duplicate.subject.subjectHash, single.subject.subjectHash);
  assert.equal(duplicate.evaluation.evaluationKey, single.evaluation.evaluationKey);
  const singleRecovery = single.evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  const duplicateRecovery = duplicate.evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.deepEqual(duplicateRecovery?.metrics, singleRecovery?.metrics);
});

test("repeated verification ids retain one matched trigger summary per real attempt", () => {
  const evaluate = (triggerCount: 1 | 2) => {
    const { taskDir, runId } = createCompleteWorkRun();
    const verificationId = "verification-repeated";
    const trigger = workTrigger(runId, verificationId, "pass", "2026-07-23T00:00:08.000Z");
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
      { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
      trigger,
      ...(triggerCount === 2 ? [{
        ...trigger,
        at: "2026-07-23T00:00:09.000Z",
        evaluation_key: "second-attempt-bookkeeping-key",
        report_ref: "artifact://evaluation/work-run-quality/second-attempt-bookkeeping-key",
        reused: true,
      }] : []),
    ]);
    const subject = loadWorkRunSubject(taskDir);
    const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
    return { subject, evaluation };
  };

  const oneMatchedAttempt = evaluate(1);
  const twoMatchedAttempts = evaluate(2);
  assert.notEqual(twoMatchedAttempts.subject.subjectHash, oneMatchedAttempt.subject.subjectHash);
  assert.notEqual(twoMatchedAttempts.evaluation.evaluationKey, oneMatchedAttempt.evaluation.evaluationKey);
  const recovery = twoMatchedAttempts.evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.firstPass, true);
  assert.equal(recovery?.metrics.finalPass, true);
  assert.equal(recovery?.metrics.repairRounds, 0);
});

test("the first terminal trigger wins and later conflicting terminals do not affect the hash or L2", () => {
  const evaluate = (results: Array<"pass" | "blocked">) => {
    const { taskDir, runId } = createCompleteWorkRun();
    const verificationId = "verification-first-wins";
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
      ...results.map((result, index) => workTrigger(
        runId,
        verificationId,
        result,
        `2026-07-23T00:00:${String(index + 7).padStart(2, "0")}.000Z`,
      )),
    ]);
    const subject = loadWorkRunSubject(taskDir);
    const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
    const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
    return { subject, evaluation, recovery };
  };

  const passOnly = evaluate(["pass"]);
  const passThenBlocked = evaluate(["pass", "blocked"]);
  assert.equal(passThenBlocked.subject.subjectHash, passOnly.subject.subjectHash);
  assert.equal(passThenBlocked.evaluation.evaluationKey, passOnly.evaluation.evaluationKey);
  assert.deepEqual(passThenBlocked.recovery?.metrics, passOnly.recovery?.metrics);
  assert.equal(passThenBlocked.recovery?.metrics.finalPass, true);

  const blockedOnly = evaluate(["blocked"]);
  const blockedThenPass = evaluate(["blocked", "pass"]);
  assert.equal(blockedThenPass.subject.subjectHash, blockedOnly.subject.subjectHash);
  assert.equal(blockedThenPass.evaluation.evaluationKey, blockedOnly.evaluation.evaluationKey);
  assert.deepEqual(blockedThenPass.recovery?.metrics, blockedOnly.recovery?.metrics);
  assert.equal(blockedThenPass.recovery?.metrics.finalPass, false);
  assert.notEqual(passOnly.subject.subjectHash, blockedOnly.subject.subjectHash);
});

test("an early identified trigger cannot collide with the same trigger after its verification attempt exists", () => {
  const { taskDir, runId } = createCompleteWorkRun();
  const verificationId = "verification-early-then-late";
  const earlyTrigger = workTrigger(runId, verificationId, "blocked", "2026-07-23T00:00:06.000Z");
  replaceQualityEvents(taskDir, [
    earlyTrigger,
    { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
  ]);

  const registry = createDefaultEvalRegistry();
  const earlySubject = loadWorkRunSubject(taskDir);
  const early = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  const earlyRecovery = early.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(early.reused, false);
  assert.equal(early.result, "pass");
  assert.equal(earlyRecovery?.metrics.firstPass, true);
  assert.equal(earlyRecovery?.metrics.finalPass, true);

  appendMainEvents(taskDir, [{
    ...earlyTrigger,
    at: "2026-07-23T00:00:08.000Z",
    evaluation_key: "late-matched-bookkeeping-key",
    report_ref: "artifact://evaluation/work-run-quality/late-matched-bookkeeping-key",
    reused: true,
  }]);
  const lateSubject = loadWorkRunSubject(taskDir);
  const late = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  const lateRecovery = late.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.notEqual(lateSubject.subjectHash, earlySubject.subjectHash);
  assert.notEqual(late.evaluationKey, early.evaluationKey);
  assert.equal(late.reused, false);
  assert.equal(late.result, "partial");
  assert.equal(lateRecovery?.metrics.firstPass, false);
  assert.equal(lateRecovery?.metrics.finalPass, false);
  assert.equal(lateRecovery?.metrics.repairRounds, 1);

  const stable = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(stable.reused, true);
  assert.equal(stable.evaluationKey, late.evaluationKey);
});

test("late terminal triggers invalidate one cache generation and match a fresh v4 evaluation", () => {
  const cachedRun = createCompleteWorkRun();
  const finalQualityEvents = [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
    { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-2" },
    workTrigger(cachedRun.runId, "verification-2", "blocked", "2026-07-23T00:00:08.000Z"),
    workTrigger(cachedRun.runId, "verification-1", "pass", "2026-07-23T00:00:09.000Z"),
  ];
  replaceQualityEvents(cachedRun.taskDir, finalQualityEvents.slice(0, 2));
  const registry = createDefaultEvalRegistry();
  const stale = coordinateWorkRunEvaluation(cachedRun.taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(stale.result, "pass");

  appendMainEvents(cachedRun.taskDir, finalQualityEvents.slice(2));
  const refreshed = coordinateWorkRunEvaluation(cachedRun.taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(refreshed.reused, false);
  assert.notEqual(refreshed.evaluationKey, stale.evaluationKey);

  const freshRun = createCompleteWorkRun();
  replaceQualityEvents(freshRun.taskDir, finalQualityEvents);
  const fresh = coordinateWorkRunEvaluation(freshRun.taskDir, registry, { projectRoot: evalPlaneRoot });
  const refreshedRecovery = refreshed.results.find((result) => result.caseId === "work-run-recovery-quality");
  const freshRecovery = fresh.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.deepEqual(refreshedRecovery?.metrics, freshRecovery?.metrics);
  assert.equal(refreshed.result, fresh.result);
  assert.equal(refreshed.report.subjectHash, fresh.report.subjectHash);
  assert.equal(refreshed.evaluationKey, fresh.evaluationKey);
  assert.equal(refreshedRecovery?.metrics.finalPass, false);
  assert.equal(refreshedRecovery?.metrics.repairRounds, 1);

  const stable = coordinateWorkRunEvaluation(cachedRun.taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(stable.reused, true);
  assert.equal(stable.evaluationKey, refreshed.evaluationKey);
});

test("historical blocked evaluation followed by current pass preserves L2 recovery and converges after its terminal trigger", () => {
  const { taskDir, runId } = createCompleteWorkRun();
  appendMainEvents(taskDir, [
    {
      at: "2026-07-23T00:00:07.000Z",
      event: "evaluation.trigger_completed",
      suite_id: "work-run-quality",
      evaluation_schema: "work-harness-evaluation-v1",
      evaluation_run_id: runId,
      evaluation_key: "historical-blocked",
      hard_gate_passed: false,
      result: "blocked",
      report_ref: "artifact://evaluation/work-run-quality/historical-blocked",
      reused: false,
    },
    { at: "2026-07-23T00:00:08.000Z", event: "task.verified", verdict: "pass" },
  ]);
  const registry = createDefaultEvalRegistry();
  const subjectBefore = loadWorkRunSubject(taskDir);
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  const recovery = first.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.finalPass, true);
  assert.equal(recovery?.metrics.retryRounds, 0);
  assert.equal(recovery?.metrics.repairRounds, 1);
  assert.equal(recovery?.metrics.recoverySucceeded, true);

  appendMainEvents(taskDir, [{
    at: "2026-07-23T00:00:09.000Z",
    event: "evaluation.trigger_completed",
    suite_id: "work-run-quality",
    evaluation_schema: "work-harness-evaluation-v1",
    evaluation_run_id: runId,
    evaluation_key: first.evaluationKey,
    hard_gate_passed: true,
    result: "pass",
    report_ref: first.reportRef,
    reused: false,
  }]);
  assert.notEqual(loadWorkRunSubject(taskDir).subjectHash, subjectBefore.subjectHash);
  const second = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(second.reused, false);
  assert.notEqual(second.evaluationKey, first.evaluationKey);
  const third = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(third.reused, true);
  assert.equal(third.evaluationKey, second.evaluationKey);
});

test("verification document bookkeeping stays excluded while a terminal trigger advances the v4 cache once", () => {
  const { taskDir, runId } = createCompleteWorkRun();
  const verificationId = "verification-1";
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: verificationId },
  ]);
  const verificationPath = join(taskDir, "verification.json");
  const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
  verification.verification_id = verificationId;
  verification.evaluation_triggers = {
    [verificationId]: {
      status: "pending",
      suite_id: "work-run-quality",
      recorded_at: "2026-07-23T00:00:06.000Z",
    },
  };
  writeJson(verificationPath, verification);

  const registry = createDefaultEvalRegistry();
  const before = loadWorkRunSubject(taskDir);
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  verification.evaluation_triggers[verificationId] = {
    status: "completed",
    suite_id: "work-run-quality",
    recorded_at: "2026-07-23T00:00:07.000Z",
  };
  writeJson(verificationPath, verification);
  appendMainEvents(taskDir, [workTrigger(runId, verificationId, "pass", "2026-07-23T00:00:07.000Z")]);

  assert.notEqual(loadWorkRunSubject(taskDir).subjectHash, before.subjectHash);
  const second = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(second.reused, false);
  assert.notEqual(second.evaluationKey, first.evaluationKey);
  const third = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot });
  assert.equal(third.reused, true);
  assert.equal(third.evaluationKey, second.evaluationKey);
});

test("verification ids preserve concurrent V1 V2 T1 T2 attempts without overwriting pending entries", () => {
  const { taskDir, runId } = createCompleteWorkRun();
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
    { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-2" },
    { at: "2026-07-23T00:00:08.000Z", event: "evaluation.trigger_failed", suite_id: "work-run-quality", verification_id: "verification-1", reason: "nonzero_exit" },
    workTrigger(runId, "verification-2", "pass", "2026-07-23T00:00:09.000Z"),
  ]);

  const subject = loadWorkRunSubject(taskDir);
  assert.deepEqual(
    subject.data.events.filter((event) => event.event === "task.verified").map((event) => event.verificationId),
    ["verification-1", "verification-2"],
  );
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, true);
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.repairRounds, 1);
  assert.equal(recovery?.metrics.recoverySucceeded, true);
});

test("verification ids pair out-of-order T2 and T1 responses by identity", () => {
  const { taskDir, runId } = createCompleteWorkRun();
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
    { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-2" },
    workTrigger(runId, "verification-2", "pass", "2026-07-23T00:00:08.000Z"),
    workTrigger(runId, "verification-1", "blocked", "2026-07-23T00:00:09.000Z"),
  ]);

  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, true);
  assert.equal(recovery?.metrics.firstPass, false);
  assert.equal(recovery?.metrics.repairRounds, 1);
  assert.equal(recovery?.metrics.recoverySucceeded, true);
});

test("identified failed and skipped triggers close their pending quality attempts", async (context) => {
  for (const status of ["failed", "skipped"] as const) {
    await context.test(status, () => {
      const { taskDir } = createCompleteWorkRun();
      replaceQualityEvents(taskDir, [
        { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass", verification_id: "verification-1" },
        {
          at: "2026-07-23T00:00:07.000Z",
          event: `evaluation.trigger_${status}`,
          suite_id: "work-run-quality",
          verification_id: "verification-1",
          reason: status === "failed" ? "nonzero_exit" : "disabled",
        },
      ]);

      const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
      const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
      assert.equal(recovery?.metrics.finalPass, false);
      assert.equal(recovery?.metrics.repairRounds, 1);
      assert.equal(recovery?.metrics.recoverySucceeded, false);
    });
  }
});

test("legacy events without verification ids use deterministic FIFO pairing", () => {
  const evaluate = (results: readonly ["pass" | "blocked", "pass" | "blocked"]) => {
    const { taskDir, runId } = createCompleteWorkRun();
    replaceQualityEvents(taskDir, [
      { at: "2026-07-23T00:00:06.000Z", event: "task.verified", verdict: "pass" },
      { at: "2026-07-23T00:00:07.000Z", event: "task.verified", verdict: "pass" },
      workTrigger(runId, null, results[0], "2026-07-23T00:00:08.000Z"),
      workTrigger(runId, null, results[1], "2026-07-23T00:00:09.000Z"),
    ]);
    const subject = loadWorkRunSubject(taskDir);
    const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
    const recovery = evaluation.results.find((result) => result.caseId === "work-run-recovery-quality");
    return { subject, evaluation, recovery };
  };

  const passThenBlocked = evaluate(["pass", "blocked"]);
  const blockedThenPass = evaluate(["blocked", "pass"]);
  assert.notEqual(passThenBlocked.subject.subjectHash, blockedThenPass.subject.subjectHash);
  assert.notEqual(passThenBlocked.evaluation.evaluationKey, blockedThenPass.evaluation.evaluationKey);
  assert.equal(passThenBlocked.recovery?.metrics.finalPass, false);
  assert.equal(passThenBlocked.recovery?.metrics.firstPass, false);
  assert.equal(passThenBlocked.recovery?.metrics.repairRounds, 1);
  assert.equal(passThenBlocked.recovery?.metrics.recoverySucceeded, false);
  assert.equal(blockedThenPass.recovery?.metrics.finalPass, true);
  assert.equal(blockedThenPass.recovery?.metrics.firstPass, false);
  assert.equal(blockedThenPass.recovery?.metrics.repairRounds, 1);
  assert.equal(blockedThenPass.recovery?.metrics.recoverySucceeded, true);
});

test("node.stale_recovered closes the active write interval before a retry starts", () => {
  const { taskDir } = createCompleteWorkRun();
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.attempts.implement = 2;
  writeJson(statePath, state);
  replaceQualityEvents(taskDir, [
    { at: "2026-07-23T00:00:10.000Z", event: "node.started", node_id: "implement", attempt: 1 },
    { at: "2026-07-23T00:00:11.000Z", event: "node.stale_recovered", node_id: "implement", attempt: 1 },
    { at: "2026-07-23T00:00:12.000Z", event: "node.started", node_id: "implement", attempt: 2 },
    { at: "2026-07-23T00:00:13.000Z", event: "node.handoff_recorded", node_id: "implement", attempt: 2, status: "completed" },
    { at: "2026-07-23T00:00:14.000Z", event: "node.started", node_id: "verify", attempt: 1 },
    { at: "2026-07-23T00:00:15.000Z", event: "node.handoff_recorded", node_id: "verify", attempt: 1, status: "completed" },
    { at: "2026-07-23T00:00:16.000Z", event: "task.verified", verdict: "pass" },
  ]);

  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const graph = evaluation.results.find((result) => result.caseId === "work-run-dag-scope");
  assert.equal(graph?.metrics.concurrentWriteConflicts, 0);
  assert.equal(graph?.status, "pass");
  assert.equal(evaluation.report.hardGatePassed, true);
});

test("comma-joined task and node scope entries remain readable but fail L1 integrity", () => {
  const { taskDir } = createCompleteWorkRun();
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  writeJson(taskPath, { ...task, scope: ["src,test"] });
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes[0].read_scope = ["src,test"];
  plan.nodes[0].write_scope = ["src/generated,test/generated"];
  writeJson(planPath, plan);

  const subject = loadWorkRunSubject(taskDir);
  assert.deepEqual(subject.data.task.scope, ["src,test"]);
  assert.deepEqual(subject.data.nodes[0].readScope, ["src,test"]);
  assert.deepEqual(subject.data.nodes[0].writeScope, ["src/generated,test/generated"]);
  assert.ok(subject.data.integrity.reasonCodes.includes("task_scope_comma_joined"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_read_scope_comma_joined"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_write_scope_comma_joined"));

  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
  assert.equal(integrity?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("multiple absolute paths inside one task or node scope entry fail L1 integrity", () => {
  const { taskDir } = createCompleteWorkRun();
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  writeJson(taskPath, { ...task, scope: ["/workspace/src /workspace/test"] });
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes[0].read_scope = ["/workspace/src /workspace/test"];
  plan.nodes[0].write_scope = ["/workspace/out /workspace/generated"];
  writeJson(planPath, plan);

  const subject = loadWorkRunSubject(taskDir);
  assert.ok(subject.data.integrity.reasonCodes.includes("task_scope_multiple_absolute_paths"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_read_scope_multiple_absolute_paths"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_write_scope_multiple_absolute_paths"));
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("bundled UNC paths produce stable task, read and write scope reason codes", () => {
  const { taskDir } = createCompleteWorkRun();
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  task.scope = ["\\\\server\\share\\one \\\\server\\share\\two"];
  writeJson(taskPath, task);
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes[0].read_scope = ["\\\\server\\share\\one=\\\\other\\share\\two"];
  plan.nodes[0].write_scope = ["\\\\server\\share\\one;\\\\other\\share\\two"];
  writeJson(planPath, plan);

  const subject = loadWorkRunSubject(taskDir);
  assert.ok(subject.data.integrity.reasonCodes.includes("task_scope_multiple_absolute_paths"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_read_scope_multiple_absolute_paths"));
  assert.ok(subject.data.integrity.reasonCodes.includes("node_write_scope_multiple_absolute_paths"));
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("one absolute path per task or node scope entry remains valid", () => {
  const { taskDir } = createCompleteWorkRun();
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  writeJson(taskPath, { ...task, scope: ["/workspace/src", "/workspace/test"] });
  const planPath = join(taskDir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.nodes[0].read_scope = ["/workspace/src"];
  plan.nodes[0].write_scope = ["/workspace/generated"];
  writeJson(planPath, plan);

  const subject = loadWorkRunSubject(taskDir);
  assert.equal(subject.data.integrity.reasonCodes.some((code) => code.includes("scope_")), false);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "pass");
  assert.equal(evaluation.report.hardGatePassed, true);
});

test("scope conflicts use canonical POSIX, root, duplicate-separator and Windows lexical paths", async (context) => {
  for (const vector of canonicalScopeVectors) {
    await context.test(vector.id, () => {
      const { taskDir } = createCompleteWorkRun();
      setConcurrentWriteScopes(taskDir, vector.left, vector.right);
      const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
      const graph = evaluation.results.find((result) => result.caseId === "work-run-dag-scope");
      assert.equal(graph?.reasonCodes.includes("concurrent_write_scope_conflict"), vector.conflict);
      assert.equal(graph?.metrics.concurrentWriteConflicts, vector.conflict ? 1 : 0);
    });
  }
});

test("TypeScript scope conflict vectors agree with the Python canonical path contract", () => {
  const python = [
    "import importlib.util, json, sys",
    "module_path = sys.argv[1]",
    "spec = importlib.util.spec_from_file_location('work_harness_scope', module_path)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "vectors = json.loads(sys.argv[2])",
    "print(json.dumps([{'id': case['id'], 'conflict': module.scopes_overlap([case['left']], [case['right']])} for case in vectors]))",
  ].join("\n");
  const result = spawnSync("python3", [
    "-c",
    python,
    join(ikbRoot, "projects", "_archive", "work-harness-20260724", "scripts", "work_harness.py"),
    JSON.stringify(canonicalScopeVectors),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    canonicalScopeVectors.map(({ id, conflict }) => ({ id, conflict })),
  );
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
  const recovery = second.results.find((result) => result.caseId === "work-run-recovery-quality");
  assert.equal(recovery?.metrics.finalPass, false);
  assert.equal(recovery?.metrics.recoverySucceeded, false);
});

test("a new evaluation discards a pass when its managed Handoff changes after the locked subject load", () => {
  const { taskDir } = createCompleteWorkRun();
  const verificationId = "verification-final-snapshot-new";
  const { overwriteWithStaleIdentity } = bindManagedImplementHandoff(taskDir);
  setCurrentVerification(taskDir, verificationId);
  const registry = createDefaultEvalRegistry();
  const staleSubject = loadWorkRunSubject(taskDir);
  const suite = registry.getSuite("work-run-quality");
  const staleKey = sha256([
    staleSubject.runId,
    suite.suiteId,
    suite.suiteVersion,
    staleSubject.subjectHash,
    suite.graderVersion,
  ].join("\n"));
  const getCases = registry.getCases.bind(registry);
  let overwritten = false;
  registry.getCases = ((...args: Parameters<typeof getCases>) => {
    if (!overwritten) {
      overwritten = true;
      overwriteWithStaleIdentity();
    }
    return getCases(...args);
  }) as typeof registry.getCases;

  const evaluation = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot, verificationId });
  const finalSubject = loadWorkRunSubject(taskDir);
  assert.equal(overwritten, true);
  assert.notEqual(finalSubject.subjectHash, staleSubject.subjectHash);
  assert.equal(evaluation.report.subjectHash, finalSubject.subjectHash);
  assert.notEqual(evaluation.evaluationKey, staleKey);
  assert.equal(evaluation.result, "blocked");
  assert.equal(evaluation.report.hardGatePassed, false);
  assert.equal(existsSync(join(taskDir, "evaluations", "work-run-quality", `${staleKey}.json`)), false);
  const events = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.evaluationKey), [evaluation.evaluationKey]);
});

test("a cached pass is not returned when its managed Handoff changes after the locked subject load", () => {
  const { taskDir } = createCompleteWorkRun();
  const verificationId = "verification-final-snapshot-cache";
  const { overwriteWithStaleIdentity } = bindManagedImplementHandoff(taskDir);
  setCurrentVerification(taskDir, verificationId);
  const registry = createDefaultEvalRegistry();
  const first = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot, verificationId });
  assert.equal(first.result, "pass");
  const getSuite = registry.getSuite.bind(registry);
  let suiteLoads = 0;
  let overwritten = false;
  registry.getSuite = ((...args: Parameters<typeof getSuite>) => {
    suiteLoads += 1;
    if (suiteLoads === 2) {
      overwritten = true;
      overwriteWithStaleIdentity();
    }
    return getSuite(...args);
  }) as typeof registry.getSuite;

  const evaluation = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot, verificationId });
  const finalSubject = loadWorkRunSubject(taskDir);
  assert.equal(overwritten, true);
  assert.equal(evaluation.reused, false);
  assert.notEqual(evaluation.evaluationKey, first.evaluationKey);
  assert.equal(evaluation.report.subjectHash, finalSubject.subjectHash);
  assert.equal(evaluation.result, "blocked");
  assert.equal(evaluation.report.hardGatePassed, false);
  const events = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.evaluationKey), [first.evaluationKey, evaluation.evaluationKey]);
});

test("a newly persisted report is removed when the final subject snapshot changes before event publication", () => {
  const { taskDir } = createCompleteWorkRun();
  const verificationId = "verification-final-snapshot-persisted";
  const { overwriteWithStaleIdentity } = bindManagedImplementHandoff(taskDir);
  setCurrentVerification(taskDir, verificationId);
  const registry = createDefaultEvalRegistry();
  const staleSubject = loadWorkRunSubject(taskDir);
  const suite = registry.getSuite("work-run-quality");
  const staleKey = sha256([
    staleSubject.runId,
    suite.suiteId,
    suite.suiteVersion,
    staleSubject.subjectHash,
    suite.graderVersion,
  ].join("\n"));
  const originalToISOString = Date.prototype.toISOString;
  let overwritten = false;
  Date.prototype.toISOString = function toISOString() {
    if (!overwritten) {
      overwritten = true;
      overwriteWithStaleIdentity();
    }
    return originalToISOString.call(this);
  };
  let evaluation: ReturnType<typeof coordinateWorkRunEvaluation>;
  try {
    evaluation = coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot, verificationId });
  } finally {
    Date.prototype.toISOString = originalToISOString;
  }

  assert.equal(overwritten, true);
  assert.equal(evaluation.result, "blocked");
  assert.notEqual(evaluation.evaluationKey, staleKey);
  assert.equal(existsSync(join(taskDir, "evaluations", "work-run-quality", `${staleKey}.json`)), false);
  const events = readFileSync(join(taskDir, "evaluations", "events.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.evaluationKey), [evaluation.evaluationKey]);
});

test("repeated final subject changes exhaust a bounded retry without publishing reports or events", () => {
  const { taskDir } = createCompleteWorkRun();
  const verificationId = "verification-final-snapshot-retry";
  const { handoffPath } = bindManagedImplementHandoff(taskDir);
  setCurrentVerification(taskDir, verificationId);
  const registry = createDefaultEvalRegistry();
  const getCases = registry.getCases.bind(registry);
  let mutations = 0;
  registry.getCases = ((...args: Parameters<typeof getCases>) => {
    mutations += 1;
    const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
    replaceJsonAtomically(handoffPath, { ...handoff, conclusion: `late mutation ${mutations}` });
    return getCases(...args);
  }) as typeof registry.getCases;

  assert.throws(
    () => coordinateWorkRunEvaluation(taskDir, registry, { projectRoot: evalPlaneRoot, verificationId }),
    /changed repeatedly before its assessment could be committed/,
  );
  assert.equal(mutations, 3);
  assert.equal(existsSync(join(taskDir, "evaluations", "events.jsonl")), false);
});

test("legacy Handoffs without managed execution identity remain explicitly compatible", () => {
  const { taskDir } = createCompleteWorkRun();
  const subject = loadWorkRunSubject(taskDir);
  assert.equal(subject.data.nodes.every((node) => node.handoff.valid), true);
  assert.equal(subject.data.integrity.reasonCodes.some((reason) => reason.startsWith("handoff_") && reason.endsWith("_mismatch")), false);
});

test("descriptor or managed event evidence prevents run-state identity downgrade", async (context) => {
  for (const evidenceSource of ["descriptor", "started-event", "handoff-event"] as const) {
    await context.test(evidenceSource, () => {
      const { taskDir } = createCompleteWorkRun();
      downgradeManagedImplementIdentity(taskDir, evidenceSource);

      const subject = loadWorkRunSubject(taskDir);
      assert.ok(subject.data.integrity.reasonCodes.includes("run_state_execution_id_missing"));
      assert.ok(subject.data.integrity.reasonCodes.includes("handoff_execution_id_mismatch"));
      assert.equal(subject.data.nodes.find((node) => node.id === "implement")?.handoff.valid, false);

      const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
      const integrity = evaluation.results.find((result) => result.caseId === "work-run-contract-integrity");
      const closure = evaluation.results.find((result) => result.caseId === "work-run-node-closure");
      assert.equal(integrity?.status, "fail");
      assert.ok(integrity?.reasonCodes.includes("run_state_execution_id_missing"));
      assert.equal(closure?.status, "fail");
      assert.ok(closure?.reasonCodes.includes("handoff_contract_invalid"));
      assert.equal(evaluation.report.hardGatePassed, false);
    });
  }
});

test("managed descriptor and event identity conflicts expose stable reason codes", () => {
  const { taskDir } = createCompleteWorkRun();
  bindManagedImplementHandoff(taskDir);
  writeJson(join(taskDir, "nodes", "implement", "execution.json"), {
    schema: "work-harness-node-execution-v1",
    task_id: "other-task",
    run_id: "run-other",
    node_id: "verify",
    attempt: 2,
    execution_id: "execution-descriptor",
  });
  const eventsPath = join(taskDir, "events.jsonl");
  const events = readFileSync(eventsPath, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))
    .map((event) => event.event === "node.started" && event.node_id === "implement"
      ? { ...event, execution_id: "execution-event" }
      : event);
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const subject = loadWorkRunSubject(taskDir);
  for (const reason of [
    "execution_descriptor_task_id_mismatch",
    "execution_descriptor_run_id_mismatch",
    "execution_descriptor_node_id_mismatch",
    "execution_descriptor_attempt_mismatch",
    "execution_descriptor_execution_id_mismatch",
    "execution_event_execution_id_mismatch",
  ]) {
    assert.ok(subject.data.integrity.reasonCodes.includes(reason), reason);
  }
  assert.equal(subject.data.nodes.find((node) => node.id === "implement")?.handoff.valid, false);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "fail");
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-node-closure")?.status, "fail");
});

test("managed Handoffs are bound to the current task, run, node, attempt and execution", () => {
  const { taskDir } = createCompleteWorkRun();
  const statePath = join(taskDir, "run-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.attempts.implement = 2;
  state.executions = {
    implement: {
      attempt: 2,
      execution_id: "execution-current",
      executor_kind: "subagent",
      runtime: "codex",
      executor_id: "agent-current",
      status: "completed",
    },
  };
  writeJson(statePath, state);
  const handoffPath = join(taskDir, "nodes", "implement", "handoff.json");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  writeJson(handoffPath, {
    ...handoff,
    task_id: "demo",
    run_id: "run-demo",
    node_id: "implement",
    attempt: 2,
    execution_id: "execution-current",
  });
  const current = loadWorkRunSubject(taskDir);
  assert.equal(current.data.nodes.find((node) => node.id === "implement")?.handoff.valid, true);
  assert.equal(current.data.integrity.reasonCodes.some((reason) => reason.startsWith("handoff_") && reason.endsWith("_mismatch")), false);

  writeJson(handoffPath, {
    ...handoff,
    task_id: "other-task",
    run_id: "run-other",
    node_id: "verify",
    attempt: 1,
    execution_id: "execution-stale",
  });

  const subject = loadWorkRunSubject(taskDir);
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_task_id_mismatch"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_run_id_mismatch"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_node_id_mismatch"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_attempt_mismatch"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_execution_id_mismatch"));
  assert.equal(subject.data.nodes.find((node) => node.id === "implement")?.handoff.valid, false);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "fail");
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-node-closure")?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
});

test("every Handoff evidence, artifact, validation and risk entry must be a non-empty string", () => {
  const { taskDir } = createCompleteWorkRun();
  const handoffPath = join(taskDir, "nodes", "implement", "handoff.json");
  const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
  writeJson(handoffPath, {
    ...handoff,
    evidence: ["case://implementation", {}],
    artifacts: ["nodes/implement/handoff.json", null],
    validation: ["unit tests passed", "   "],
    risks: ["known risk", 42],
  });

  const subject = loadWorkRunSubject(taskDir);
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_evidence_invalid"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_artifacts_invalid"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_validation_invalid"));
  assert.ok(subject.data.integrity.reasonCodes.includes("handoff_risks_invalid"));
  assert.equal(subject.data.nodes.find((node) => node.id === "implement")?.handoff.valid, false);
  const evaluation = coordinateWorkRunEvaluation(taskDir, createDefaultEvalRegistry(), { projectRoot: evalPlaneRoot });
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-contract-integrity")?.status, "fail");
  assert.equal(evaluation.results.find((result) => result.caseId === "work-run-node-closure")?.status, "fail");
  assert.equal(evaluation.report.hardGatePassed, false);
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
