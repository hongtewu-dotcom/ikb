import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LedgerStore } from "./store.ts";

export interface RunPlanStep {
  id: string;
  depends_on: string[];
}

export interface RunPlan {
  status: "planned";
  steps: RunPlanStep[];
}

export interface RunPlanWriteResult {
  runId: string;
  path: string;
  changed: boolean;
  plan: RunPlan;
}

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Materialize the deterministic Run DAG consumed by the local evaluator.
 * A plan may be corrected before execution starts, but never after a step
 * event exists; otherwise the recorded execution could be relabelled later.
 */
export function writeRunPlan(store: LedgerStore, runId: string, inputPath: string): RunPlanWriteResult {
  const run = store.requireRun(runId);
  if (run.status !== "running" && run.status !== "queued") throw new Error(`Run ${runId} cannot change its plan from ${run.status}`);
  const sourcePath = resolve(inputPath);
  const sourceText = readRegularFile(sourcePath, "Run plan input");
  const plan = normalizeRunPlan(JSON.parse(sourceText) as unknown);
  const targetPath = join(run.runDir, "plan.json");
  const rendered = `${JSON.stringify(plan, null, 2)}\n`;
  if (existsSync(targetPath)) {
    const current = readRegularFile(targetPath, "Run plan");
    if (current === rendered) return { runId, path: targetPath, changed: false, plan };
    const executionStarted = store.listEvents().some((event) => event.aggregateType === "run"
      && event.aggregateId === runId
      && (event.eventType === "run.step_started" || event.eventType === "run.step_finished"));
    if (executionStarted) throw new Error(`Run ${runId} has step events; its plan is immutable`);
  }
  const temporary = `${targetPath}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, rendered, { mode: 0o600 });
  renameSync(temporary, targetPath);
  chmodSync(targetPath, 0o600);
  return { runId, path: targetPath, changed: true, plan };
}

export function normalizeRunPlan(value: unknown): RunPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run plan must be a JSON object");
  const row = value as Record<string, unknown>;
  if (row.status !== undefined && row.status !== "planned") throw new Error("Run plan status must be planned");
  if (!Array.isArray(row.steps) || row.steps.length === 0 || row.steps.length > 100) {
    throw new Error("Run plan must contain 1 to 100 steps");
  }
  const steps = row.steps.map((item, index): RunPlanStep => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Run plan step ${index + 1} must be an object`);
    const step = item as Record<string, unknown>;
    if (Object.keys(step).some((key) => !["id", "depends_on", "dependsOn"].includes(key))) {
      throw new Error(`Run plan step ${index + 1} contains unsupported fields`);
    }
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) throw new Error(`Run plan step ${index + 1} has an invalid id`);
    const dependencies = step.depends_on ?? step.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string" || !STEP_ID.test(dependency))) {
      throw new Error(`Run plan step ${step.id} has invalid dependencies`);
    }
    const depends_on = [...new Set(dependencies as string[])];
    if (depends_on.includes(step.id)) throw new Error(`Run plan step ${step.id} cannot depend on itself`);
    return { id: step.id, depends_on };
  });
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) throw new Error("Run plan step ids must be unique");
  for (const step of steps) {
    const missing = step.depends_on.filter((dependency) => !ids.has(dependency));
    if (missing.length > 0) throw new Error(`Run plan step ${step.id} has missing dependencies: ${missing.join(", ")}`);
  }
  assertAcyclic(steps);
  return { status: "planned", steps };
}

function assertAcyclic(steps: RunPlanStep[]): void {
  const dependencies = new Map(steps.map((step) => [step.id, step.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Run plan contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

function readRegularFile(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return readFileSync(path, "utf8");
}
