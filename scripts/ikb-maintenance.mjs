#!/usr/bin/env node

import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { maintenanceSteps } from "./ikb-maintenance-plan.mjs";

// Compatibility export for callers that previously imported the plan from
// the runner. New code should import the pure plan module directly.
export { maintenanceSteps };

const PROJECT_ROOT = resolve(process.env.IKB_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");
const DEFAULT_HOME = process.env.IKB_HOME ?? join(PROJECT_ROOT, "ikb-data");

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { mode: "daily", home: DEFAULT_HOME };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "daily" || value === "weekly") options.mode = value;
    else if (value === "--home") options.home = resolve(argv[++index]);
    else throw new Error(`Usage: ikb-maintenance.mjs daily|weekly [--home <path>]`);
  }
  if (!new Set(["daily", "weekly"]).has(options.mode)) throw new Error(`Usage: ikb-maintenance.mjs daily|weekly [--home <path>]`);
  return options;
}

function runCli(home, args) {
  const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", CLI_PATH, ...args, "--json", "--home", home], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, IKB_PROJECT_ROOT: PROJECT_ROOT },
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || `ikb exited ${result.status}`).trim(), exitCode: result.status };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }
}

function runCliNoJson(home, args) {
  const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", CLI_PATH, ...args, "--home", home], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, IKB_PROJECT_ROOT: PROJECT_ROOT },
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || `ikb exited ${result.status}`).trim(), exitCode: result.status };
  return { ok: true };
}

function summarizeStep(name, result, summary) {
  if (!result.ok) {
    summary.failures.push({ name, error: result.error, exitCode: result.exitCode ?? null });
    summary.steps.push({ name, ok: false });
    return false;
  }
  summary.steps.push({ name, ok: true, value: result.value ?? null });
  return true;
}

function compactValue(name, value) {
  if (name === "source-ingest") return value ? { scanId: value.scanId, discovered: value.discovered, imported: value.imported, skipped: value.skipped, failed: value.failed } : null;
  if (name === "source-raw-dedup") return value ? { scannedSources: value.scannedSources, duplicateSources: value.duplicateSources, linkedSources: value.linkedSources, prefixCompactedSources: value.prefixCompactedSources, estimatedSharedGB: Number(((value.estimatedSharedBytes ?? 0) / 1073741824).toFixed(2)), issues: value.issues?.length ?? null } : null;
  if (name === "experience-triage") return value ? { scannedSources: value.scannedSources, scannedSessions: value.scannedSessions, selected: value.selected, created: value.created, updated: value.updated, unchanged: value.unchanged, unmappedFeedbackEvents: value.unmappedFeedbackEvents } : null;
  if (name === "experience-cluster") return value ? { clusters: value.clusters, eligible: value.eligible, created: value.created, updated: value.updated, unchanged: value.unchanged, pending: value.pending?.length ?? 0 } : null;
  if (name === "people-rebuild") return Array.isArray(value) ? { people: value.length, matched: value.reduce((total, item) => total + (item.matchedCount ?? 0), 0), direct: value.reduce((total, item) => total + (item.directMatchedCount ?? 0), 0) } : null;
  if (name === "knowledge-rebuild") return Array.isArray(value) ? { scopes: value.length } : value ?? null;
  if (name === "candidate-discover") {
    const results = Array.isArray(value) ? value : (Array.isArray(value?.results) ? value.results : null);
    return results
      ? { sources: results.length, created: results.reduce((total, item) => total + (item.created ?? 0), 0), updated: results.reduce((total, item) => total + (item.updated ?? 0), 0) }
      : null;
  }
  if (name === "candidate-resolve") {
    return value ? {
      scope: value.scope ?? null,
      limit: value.limit ?? null,
      delayMs: value.delayMs ?? null,
      discovered: value.discovered ?? 0,
      ingested: value.ingested ?? 0,
      blocked: value.blocked ?? 0,
      remaining: value.remaining ?? null,
    } : null;
  }
  if (name === "knowledge-lint") {
    const results = Array.isArray(value?.results) ? value.results : [];
    return value ? { ok: value.ok, checked: value.checked ?? results.length, issues: results.reduce((total, item) => total + (item.issues?.length ?? 0), 0) } : null;
  }
  if (name === "reasoning") {
    return value ? {
      reportId: value.id,
      sources: value.inputs?.sources ?? null,
      experiences: value.inputs?.experiences ?? null,
      knowledgeActive: value.inputs?.knowledgeActive ?? null,
      questions: value.summary?.questionsExtracted ?? null,
      autoResolved: value.summary?.autoResolved ?? null,
      deferred: value.summary?.deferred ?? null,
      askUser: value.summary?.askUser ?? null,
      decisionBundles: value.decisionBundles?.length ?? 0,
    } : null;
  }
  if (name === "doctor") return value ? { ok: value.ok, events: value.events, sources: value.sources, candidates: value.candidates, experiences: value.experiences, experienceCandidates: value.experienceCandidates, brokenChains: value.brokenChains?.length ?? null, sourceIssues: value.sourceIssues?.length ?? null, experienceIssues: value.experienceIssues?.length ?? null } : null;
  if (name === "ledger") return value?.replay ? { brokenChains: value.replay.brokenChains?.length ?? null } : value ?? null;
  if (name === "report") return { generated: true };
  return value ?? null;
}

export function maintenanceRunPlan(steps) {
  const lastStep = steps.at(-1)?.name;
  return {
    status: "planned",
    steps: [
      ...steps.map((step) => ({ id: step.name, depends_on: [...step.dependsOn] })),
      { id: "maintenance-summary", depends_on: lastStep ? [lastStep] : [] },
    ],
  };
}

export function writeMaintenanceRunPlan(runDir, steps) {
  const path = join(runDir, "plan.json");
  writeFileSync(path, `${JSON.stringify(maintenanceRunPlan(steps), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function runMaintenance({ mode = "daily", home = DEFAULT_HOME } = {}) {
  const maintenanceDir = join(home, "maintenance");
  const lockPath = join(maintenanceDir, ".lock");
  const runsDir = join(maintenanceDir, "runs");
  mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      const stale = (() => {
        try { return Date.now() - statSync(lockPath).mtimeMs > 30 * 60 * 1000; } catch { return false; }
      })();
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath, { mode: 0o700 });
      } else return { mode, skipped: true, reason: "already_running" };
    }
    else throw error;
  }

  const summary = { schema: "ikb-maintenance.v1", mode, startedAt: new Date().toISOString(), steps: [], failures: [] };
  let taskId = null;
  let runId = null;
  let runDir = null;
  const runEvent = (type, payload) => {
    if (!runId) return { ok: false, error: "maintenance run not started" };
    const result = runCli(home, ["run", "event", runId, "--type", type, "--payload", JSON.stringify(payload)]);
    if (!result.ok) summary.failures.push({ name: `event:${type}`, error: result.error, exitCode: result.exitCode ?? null });
    return result;
  };
  const writeStepArtifact = (name, value) => {
    if (!runDir) return null;
    const directory = join(runDir, "artifacts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${name}.json`);
    writeFileSync(path, `${JSON.stringify({ schema: "ikb-maintenance-step.v1", name, value: value ?? null }, null, 2)}\n`, { mode: 0o600 });
    const artifact = runCli(home, ["artifact", "add", runId, "--path", path, "--kind", "maintenance-step", "--label", name]);
    if (!artifact.ok) return null;
    const artifactId = artifact.value?.id ?? null;
    if (artifactId) runEvent("run.artifact_linked", { artifactId, relation: "produced", lineageRefs: [] });
    return artifactId;
  };
  const receiverForStep = (name) => {
    if (name === "source-ingest" || name === "source-raw-dedup" || name === "candidate-discover" || name === "candidate-resolve") return "ikb-intake";
    if (name === "people-rebuild" || name === "experience-triage" || name === "reasoning") return "ikb-analyst";
    if (name === "knowledge-rebuild" || name === "knowledge-archive" || name === "knowledge-lint") return "ikb-curator";
    if (name === "doctor" || name === "ledger") return "ikb-verifier";
    return "ikb-harness";
  };
  const startRun = () => {
    const task = runCli(home, ["task", "add", "--title", `IKB ${mode === "weekly" ? "周度" : "每日"}维护`, "--goal", "把输入、分析、知识质量和观测收敛为一次可追溯维护 Run", "--accept", "所有依赖步骤完成；Verifier、评估、Artifact 和 Ledger 均可回放", "--type", "general", "--scope", "work"]);
    if (!task.ok) return task;
    taskId = task.value?.id ?? null;
    const run = runCli(home, ["run", "start", taskId, "--agent", "ikb-harness", "--skill", "maintenance"]);
    if (!run.ok) return run;
    runId = run.value?.id ?? null;
    runDir = run.value?.runDir ?? null;
    summary.taskId = taskId;
    summary.runId = runId;
    writeMaintenanceRunPlan(runDir, maintenanceSteps(mode));
    runEvent("run.loop_started", { loopId: "inner", iteration: 1, inputRefs: ["scope:work", `mode:${mode}`], outputRefs: [], contextHash: null });
    return { ok: Boolean(runId), value: run.value };
  };
  const required = (step, completed) => {
    const blockedBy = step.dependsOn.find((dependency) => !completed.get(dependency));
    if (blockedBy) {
      summary.steps.push({ name: step.name, ok: false, status: "blocked", blockedBy });
      summary.failures.push({ name: step.name, error: `dependency ${blockedBy} did not complete` });
      runEvent("run.step_finished", { stepId: step.name, stepName: step.name, loopId: "inner", iteration: 1, inputRefs: [`step:${blockedBy}`], outputRefs: [], status: "blocked", errorCode: "dependency_failed", nextAction: "fix_dependency_then_retry" });
      return false;
    }
    runEvent("run.step_started", { stepId: step.name, stepName: step.name, loopId: "inner", iteration: 1, inputRefs: step.dependsOn.map((dependency) => `step:${dependency}`), outputRefs: [] });
    const result = step.noJson ? runCliNoJson(home, step.args) : runCli(home, step.args);
    const ok = summarizeStep(step.name, result, summary);
    const entry = summary.steps.at(-1);
    entry.status = ok ? "succeeded" : "failed";
    if (ok) {
      entry.value = compactValue(step.name, result.value);
      const artifactId = writeStepArtifact(step.name, result.value ?? { generated: true });
      if (artifactId) entry.artifactId = artifactId;
      else summary.failures.push({ name: `artifact:${step.name}`, error: "successful maintenance step did not produce a registered Artifact" });
      runEvent("run.handoff", { handoffId: `handoff:${step.name}`, stepId: step.name, fromRole: "ikb-harness", toRole: receiverForStep(step.name), inputRefs: step.dependsOn.map((dependency) => `step:${dependency}`), outputRefs: artifactId ? [`artifact:${artifactId}`] : [], contractVersion: "ikb-maintenance.v1" });
      runEvent("run.step_finished", { stepId: step.name, stepName: step.name, loopId: "inner", iteration: 1, inputRefs: step.dependsOn.map((dependency) => `step:${dependency}`), outputRefs: artifactId ? [`artifact:${artifactId}`] : [], status: "succeeded", nextAction: null });
      const gateId = step.name.includes("knowledge") || step.name === "reasoning" || step.name === "experience-triage" ? "G2" : step.name === "doctor" || step.name === "ledger" ? "G6" : "G1";
      runEvent("run.gate_evaluated", { gateId, decision: "pass", reasonCode: null, evidenceRefs: artifactId ? [`artifact:${artifactId}`] : [], gateVersion: "ikb-maintenance.v1" });
    } else {
      runEvent("run.step_finished", { stepId: step.name, stepName: step.name, loopId: "inner", iteration: 1, inputRefs: step.dependsOn.map((dependency) => `step:${dependency}`), outputRefs: [], status: "failed", errorCode: "step_failed", nextAction: "review_summary_then_retry" });
    }
    return ok;
  };
  try {
    const started = startRun();
    if (!started.ok) throw new Error(started.error ?? "failed to start maintenance Run");
    const completed = new Map();
    for (const step of maintenanceSteps(mode)) completed.set(step.name, required(step, completed));
    const allStepsSucceeded = summary.steps.every((step) => step.status === "succeeded");
    const maintenanceStepsSucceeded = summary.failures.length === 0 && allStepsSucceeded;
    const lastStepName = maintenanceSteps(mode).at(-1)?.name;
    runEvent("run.step_started", { stepId: "maintenance-summary", stepName: "maintenance-summary", loopId: "inner", iteration: 1, inputRefs: lastStepName ? [`step:${lastStepName}`] : [], outputRefs: [] });
    let summaryArtifact = null;
    if (maintenanceStepsSucceeded) {
      summaryArtifact = writeStepArtifact("maintenance-summary", {
        schema: summary.schema,
        mode: summary.mode,
        startedAt: summary.startedAt,
        taskId,
        runId,
        steps: summary.steps,
        failures: summary.failures,
        executionOk: true,
      });
    }
    if (summaryArtifact) {
      summary.summaryArtifactId = summaryArtifact;
      summary.steps.push({ name: "maintenance-summary", ok: true, status: "succeeded", artifactId: summaryArtifact, value: { generated: true } });
      runEvent("run.handoff", { handoffId: "handoff:maintenance-summary", stepId: "maintenance-summary", fromRole: "ikb-harness", toRole: "ikb-verifier", inputRefs: lastStepName ? [`step:${lastStepName}`] : [], outputRefs: [`artifact:${summaryArtifact}`], contractVersion: "ikb-maintenance.v1" });
      runEvent("run.step_finished", { stepId: "maintenance-summary", stepName: "maintenance-summary", loopId: "inner", iteration: 1, inputRefs: lastStepName ? [`step:${lastStepName}`] : [], outputRefs: [`artifact:${summaryArtifact}`], status: "succeeded", nextAction: null });
      runEvent("run.gate_evaluated", { gateId: "G6", decision: "pass", reasonCode: null, evidenceRefs: [`artifact:${summaryArtifact}`], gateVersion: "ikb-maintenance.v1" });
    } else {
      summary.steps.push({ name: "maintenance-summary", ok: false, status: maintenanceStepsSucceeded ? "failed" : "blocked", blockedBy: maintenanceStepsSucceeded ? null : lastStepName ?? null });
      summary.failures.push({ name: "artifact:maintenance-summary", error: maintenanceStepsSucceeded ? "maintenance summary could not be registered as an Artifact" : "maintenance summary blocked by a failed dependency" });
      runEvent("run.step_finished", { stepId: "maintenance-summary", stepName: "maintenance-summary", loopId: "inner", iteration: 1, inputRefs: lastStepName ? [`step:${lastStepName}`] : [], outputRefs: [], status: maintenanceStepsSucceeded ? "failed" : "blocked", errorCode: maintenanceStepsSucceeded ? "artifact_missing" : "dependency_failed", nextAction: "review_failed_steps_then_retry" });
    }
    const stepArtifactIds = summary.steps.map((step) => step.artifactId).filter(Boolean);
    const executionOk = maintenanceStepsSucceeded && Boolean(summaryArtifact);
    if (executionOk) {
      runEvent("run.verification_completed", { result: "pass", checks: [{ id: "maintenance-steps", decision: "pass", evidenceRefs: stepArtifactIds.map((id) => `artifact:${id}`), reasonCode: null }], artifactRefs: stepArtifactIds, nextAction: null });
      runEvent("run.gate_evaluated", { gateId: "G6", decision: "pass", reasonCode: null, evidenceRefs: stepArtifactIds.map((id) => `artifact:${id}`), gateVersion: "ikb-maintenance.v1" });
    }
    runEvent("run.loop_finished", { loopId: "inner", iteration: 1, inputRefs: ["scope:work", `mode:${mode}`], outputRefs: stepArtifactIds.map((id) => `artifact:${id}`), contextHash: null, status: executionOk ? "succeeded" : "blocked", errorCode: executionOk ? null : "maintenance_failed", nextAction: executionOk ? null : "review_failed_steps_then_retry" });
    const finished = runCli(home, ["run", "finish", runId, "--status", executionOk ? "succeeded" : "failed", "--summary", executionOk ? "maintenance completed" : "maintenance failed"]);
    if (!finished.ok) summary.failures.push({ name: "run-finish", error: finished.error, exitCode: finished.exitCode ?? null });
    const evaluation = finished.ok
      ? runCli(home, ["run", "evaluate", runId, "--suite", "ikb-run-quality"])
      : { ok: false, error: "run did not reach terminal state" };
    if (!evaluation.ok) summary.failures.push({ name: "harness-eval", error: evaluation.error, exitCode: evaluation.exitCode ?? null });
    const report = evaluation.value?.report;
    const evaluationPassed = Boolean(evaluation.ok && report?.hardGatePassed && Array.isArray(report.results) && report.results.every((result) => result.status === "pass"));
    summary.harnessEvaluation = evaluation.ok
      ? { suiteId: "ikb-run-quality", hardGatePassed: Boolean(report?.hardGatePassed), totalCases: report?.results?.length ?? 0, passedCases: report?.results?.filter((result) => result.status === "pass").length ?? 0, artifactRef: evaluation.value?.artifact?.id ? `artifact://${evaluation.value.artifact.id}` : null }
      : { suiteId: "ikb-run-quality", error: evaluation.error };
    summary.ok = summary.failures.length === 0 && executionOk && evaluationPassed;
    summary.finishedAt = new Date().toISOString();
    const outputPath = join(runsDir, `${summary.finishedAt.replaceAll(/[:.]/g, "-")}-${mode}.json`);
    summary.outputPath = outputPath;
    const data = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(outputPath, data, { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    if (taskId) {
      const taskTransition = runCli(home, summary.ok ? ["task", "done", taskId, "--reason", "维护 Run 已通过验收", ...(summaryArtifact ? ["--evidence", summaryArtifact] : [])] : ["task", "wait", taskId, "--reason", "维护 Run 存在失败或阻断步骤"]);
      if (!taskTransition.ok) summary.failures.push({ name: "task-transition", error: taskTransition.error, exitCode: taskTransition.exitCode ?? null });
    }
    if (summary.failures.length > 0) summary.ok = false;
    // The JSON summary is the human-facing projection. Rewrite it after the
    // summary Artifact and Task transition so the projection includes the
    // final evidence and any late failures.
    writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    return summary;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = parseArgs();
    const summary = runMaintenance(options);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.ok === false) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
