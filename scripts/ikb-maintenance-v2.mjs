import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { maintenanceSteps } from "./ikb-maintenance-plan.mjs";

const PROJECT_ROOT = resolve(process.env.IKB_PROJECT_ROOT ?? new URL("..", import.meta.url).pathname);
const CLI_PATH = join(PROJECT_ROOT, "src", "cli.ts");
const DEFAULT_HOME = process.env.IKB_HOME ?? join(PROJECT_ROOT, "ikb-data");
const MODES = new Set(["source-sync", "semantic-maintenance", "weekly-housekeeping"]);

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { mode: "source-sync", home: DEFAULT_HOME, dryRun: false, decisions: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "daily") options.mode = "source-sync";
    else if (value === "weekly") options.mode = "weekly-housekeeping";
    else if (MODES.has(value)) options.mode = value;
    else if (value === "--home") options.home = resolve(requiredArg(argv, ++index, "--home"));
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--decisions") options.decisions = resolve(requiredArg(argv, ++index, "--decisions"));
    else throw new Error(usage());
  }
  if (!MODES.has(options.mode)) throw new Error(usage());
  if (options.decisions && options.mode !== "semantic-maintenance") throw new Error("--decisions is only valid for semantic-maintenance");
  return options;
}

export function runMaintenance(options = {}) {
  const mode = options.mode ?? "source-sync";
  const home = resolve(options.home ?? DEFAULT_HOME);
  const dryRun = options.dryRun === true;
  const maintenanceRoot = join(home, ".system", "maintenance");
  const lockPath = join(maintenanceRoot, ".lock");
  mkdirSync(maintenanceRoot, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stale = (() => {
      try { return Date.now() - statSync(lockPath).mtimeMs > 30 * 60 * 1000; } catch { return false; }
    })();
    if (!stale) return { schema: "ikb-maintenance.v2", mode, dryRun, skipped: true, reason: "already_running" };
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
  }
  const startedAt = new Date().toISOString();
  try {
    const body = mode === "source-sync"
      ? runSourceSync(home, dryRun, startedAt, maintenanceRoot)
      : mode === "semantic-maintenance"
        ? runSemanticMaintenance(home, dryRun, startedAt, maintenanceRoot, options.decisions ?? null)
        : runWeeklyHousekeeping(home, dryRun, startedAt, maintenanceRoot);
    const summary = {
      schema: "ikb-maintenance.v2",
      mode,
      dryRun,
      startedAt,
      finishedAt: new Date().toISOString(),
      ...body,
    };
    const path = join(maintenanceRoot, `${summary.finishedAt.replaceAll(/[:.]/g, "-")}-${mode}.json`);
    summary.outputPath = path;
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return summary;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function runSourceSync(home, dryRun, startedAt, maintenanceRoot) {
  const steps = [];
  const catpawMemoryRoot = process.env.IKB_CATPAW_MEMORY_ROOT ?? `${process.env.HOME ?? "/Users/htwu"}/.catpaw/memory`;
  const historyBounds = [
    ...(process.env.IKB_MAINTENANCE_HISTORY_FROM ? ["--from", process.env.IKB_MAINTENANCE_HISTORY_FROM] : []),
    ...(process.env.IKB_MAINTENANCE_HISTORY_TO ? ["--to", process.env.IKB_MAINTENANCE_HISTORY_TO] : []),
  ];
  const commands = [
    ["home-init", ["init"]],
    ["local-memory-sync", ["source", "sync-files", catpawMemoryRoot, "--adapter", "catpaw-memory-local", "--kind", "manual", "--extensions", "md", "--exclude", "archive,specx,openspec", "--scope", "work", "--limit", "0"]],
    ["registered-files-sync", ["source", "sync-targets", "--scope", "work"]],
    ["source-history-sync", ["source", "ingest-history", "--adapter", "all", "--scope", "work", "--limit", "0", "--incremental", "--summary", ...historyBounds]],
  ];
  for (const [name, args] of commands) {
    steps.push(dryRun ? dryRunStep(name, args) : executeStep(home, name, args));
  }
  const refresh = dryRun
    ? dryRunStep("inbox-refresh", ["maintenance", "refresh-inbox"])
    : executeStep(home, "inbox-refresh", ["maintenance", "refresh-inbox"]);
  steps.push(refresh);
  const operations = steps.map(stepOperation);
  const receipt = writeFinalReceipt(home, maintenanceRoot, {
    kind: "source_sync",
    scope: "work",
    command: dryRun ? "source-sync --dry-run" : "source-sync",
    startedAt,
    outcome: maintenanceOutcome(steps),
    operations,
  });
  steps.push({ name: "final-receipt", ok: receipt.ok, status: receipt.ok ? "succeeded" : "failed", value: receipt.value ?? null, error: receipt.error ?? null });
  return {
    ok: receipt.ok && steps.slice(0, -1).every((step) => step.ok || step.status === "dry_run"),
    steps,
    receipt: receipt.value ?? null,
    failures: steps.filter((step) => !step.ok && step.status !== "dry_run").map((step) => ({ name: step.name, error: step.error })),
  };
}

function runSemanticMaintenance(home, dryRun, startedAt, maintenanceRoot, decisions) {
  if (decisions && !dryRun) {
    const applied = executeStep(home, "knowledge-decisions", ["maintenance", "semantic-apply", "--file", decisions]);
    return {
      ok: applied.ok,
      steps: [applied, { name: "final-receipt", ok: applied.ok, status: applied.ok ? "succeeded" : "failed", value: applied.value?.receipt ?? null }],
      receipt: applied.value?.receipt ?? null,
      failures: applied.ok ? [] : [{ name: applied.name, error: applied.error }],
    };
  }
  const selected = executeStep(home, "inbox-select", ["maintenance", "semantic-select", "--scope", "work", "--limit", "3"]);
  const items = selected.value?.selected ?? [];
  const operations = items.length > 0 ? items.map((item) => ({
    action: "select",
    subjectRef: `inbox://${item.id}`,
    inputRefs: [`inbox://${item.id}`],
    outputRefs: [],
    sourceRefs: item.sourceRefs ?? [],
    beforeHash: null,
    afterHash: hashValue(item),
    applicability: item.goal ?? null,
    boundary: "Selection is not a Knowledge decision",
    validation: { status: dryRun ? "skipped" : "passed", checks: ["at most three Inbox themes"], issues: [] },
    outcome: dryRun ? "dry_run" : "awaiting_agent_decision",
    confirmation: null,
  })) : [{
    action: "select",
    subjectRef: null,
    inputRefs: [],
    outputRefs: [],
    sourceRefs: [],
    beforeHash: null,
    afterHash: hashValue({ selected: 0 }),
    applicability: null,
    boundary: "No Inbox theme with an explicit consumer",
    validation: { status: "passed", checks: ["Inbox inspected"], issues: [] },
    outcome: "nothing_to_do",
    confirmation: null,
  }];
  const receipt = writeFinalReceipt(home, maintenanceRoot, {
    kind: "semantic_maintenance",
    scope: "work",
    command: dryRun ? "semantic-maintenance --dry-run" : "semantic-maintenance",
    startedAt,
    outcome: selected.ok ? (items.length > 0 && !dryRun ? "partial" : "succeeded") : "failed",
    operations,
  });
  return {
    ok: selected.ok && receipt.ok,
    steps: [selected, { name: "knowledge-decisions", ok: true, status: dryRun ? "dry_run" : "awaiting_agent", value: { selected: items.length } }, { name: "final-receipt", ok: receipt.ok, status: receipt.ok ? "succeeded" : "failed", value: receipt.value ?? null }],
    selected: items,
    receipt: receipt.value ?? null,
    failures: [selected, { name: "final-receipt", ok: receipt.ok, error: receipt.error }].filter((step) => !step.ok).map((step) => ({ name: step.name, error: step.error })),
  };
}

function runWeeklyHousekeeping(home, dryRun, startedAt, maintenanceRoot) {
  const coverage = dryRun ? dryRunStep("source-coverage", ["source", "coverage", "--scope", "work"]) : executeStep(home, "source-coverage", ["source", "coverage", "--scope", "work"]);
  const snapshot = dryRun ? dryRunStep("housekeeping-snapshot", ["maintenance", "weekly-snapshot"]) : executeStep(home, "housekeeping-snapshot", ["maintenance", "weekly-snapshot"]);
  const steps = [coverage, snapshot];
  const receipt = writeFinalReceipt(home, maintenanceRoot, {
    kind: "weekly",
    scope: "work",
    command: dryRun ? "weekly-housekeeping --dry-run" : "weekly-housekeeping",
    startedAt,
    outcome: maintenanceOutcome(steps),
    operations: steps.map(stepOperation),
  });
  steps.push({ name: "final-receipt", ok: receipt.ok, status: receipt.ok ? "succeeded" : "failed", value: receipt.value ?? null, error: receipt.error ?? null });
  return {
    ok: receipt.ok && steps.slice(0, -1).every((step) => step.ok || step.status === "dry_run"),
    steps,
    receipt: receipt.value ?? null,
    failures: steps.filter((step) => !step.ok && step.status !== "dry_run").map((step) => ({ name: step.name, error: step.error })),
  };
}

function executeStep(home, name, args) {
  const result = runCli(home, args);
  const rawValue = result.value ?? null;
  return {
    name,
    ok: result.ok,
    status: result.ok ? "succeeded" : result.attention ? "attention" : "failed",
    value: compactStepValue(name, rawValue),
    resultHash: hashValue(rawValue ?? { error: result.error }),
    sourceRefs: changedSourceRefs(rawValue),
    error: result.ok ? null : result.error,
    exitCode: result.exitCode ?? 0,
    args,
  };
}

function dryRunStep(name, args) {
  return { name, ok: true, status: "dry_run", value: { args }, resultHash: hashValue({ args }), sourceRefs: [], error: null, exitCode: 0, args };
}

function stepOperation(step) {
  return {
    action: step.name,
    subjectRef: `maintenance-step://${step.name}`,
    inputRefs: step.args ?? [],
    outputRefs: [],
    sourceRefs: step.sourceRefs ?? [],
    beforeHash: null,
    afterHash: step.resultHash ?? hashValue(step.value ?? { status: step.status, error: step.error }),
    applicability: "Local Source and Inbox maintenance",
    boundary: "Does not create or rewrite Knowledge",
    validation: {
      status: step.status === "dry_run" ? "skipped" : step.ok ? "passed" : "failed",
      checks: ["command completed with bounded JSON output"],
      issues: step.error ? [step.error] : [],
    },
    outcome: step.status,
    confirmation: null,
  };
}

function writeFinalReceipt(home, maintenanceRoot, input) {
  const directory = join(maintenanceRoot, "requests");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `receipt-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const result = runCli(home, ["maintenance", "write-receipt", "--file", path]);
  rmSync(path, { force: true });
  if (result.value) result.value = receiptSummary(result.value);
  return result;
}

function runCli(home, args) {
  const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", CLI_PATH, ...args, "--json", "--home", home], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, IKB_PROJECT_ROOT: PROJECT_ROOT },
  });
  if (result.error) return { ok: false, attention: false, error: result.error.message, exitCode: null };
  let value = null;
  let parseError = null;
  if (result.stdout.trim()) {
    try { value = JSON.parse(result.stdout); } catch (error) { parseError = `invalid JSON: ${error.message}`; }
  }
  const ok = result.status === 0 && parseError === null;
  return {
    ok,
    attention: result.status === 2 && parseError === null,
    value,
    error: ok ? null : parseError ?? (result.stderr || result.stdout || `ikb exited ${result.status}`).trim(),
    exitCode: result.status,
  };
}

function maintenanceOutcome(steps) {
  const failed = steps.filter((step) => !step.ok && step.status !== "dry_run").length;
  if (failed === 0) return "succeeded";
  return failed === steps.length ? "failed" : "partial";
}

function changedSourceRefs(value) {
  if (!value || typeof value !== "object") return [];
  const refs = [];
  const visit = (item, depth) => {
    if (depth > 4 || item === null || item === undefined) return;
    if (Array.isArray(item)) { for (const child of item.slice(0, 500)) visit(child, depth + 1); return; }
    if (typeof item !== "object") return;
    if (item.skipped === true || item.imported === false) return;
    for (const [key, child] of Object.entries(item)) {
      if ((key === "sourceId" || key === "source_id") && typeof child === "string" && child.startsWith("src-")) refs.push(child);
      else visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return [...new Set(refs)];
}

function compactStepValue(name, value) {
  if (!value || typeof value !== "object") return value;
  if (name === "local-memory-sync") return pick(value, ["scanId", "root", "adapter", "scope", "discovered", "imported", "skipped", "failed"]);
  if (name === "registered-files-sync") return pick(value, ["scanId", "discoveredTargets", "discoveredFiles", "imported", "skipped", "failedTargets", "failedFiles"]);
  if (name === "source-history-sync") return pick(value, ["scanId", "discovered", "imported", "skipped", "failed", "recordCount", "deltaCount"]);
  if (name === "inbox-refresh") return pick(value, ["since", "scannedEvents", "createdOrRefreshed", "byTrigger"]);
  if (name === "source-coverage") return {
    inventoryComplete: value.inventoryComplete ?? null,
    stockComplete: value.stockComplete ?? null,
    sourceTotal: value.sources?.total ?? null,
    blockers: Array.isArray(value.blockers) ? value.blockers.length : null,
  };
  if (name === "housekeeping-snapshot") return value;
  if (name === "inbox-select") return {
    scope: value.scope,
    limit: value.limit,
    available: value.available,
    selected: Array.isArray(value.selected) ? value.selected.slice(0, 3) : [],
  };
  return value;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));
}

function receiptSummary(value) {
  return {
    id: value.id,
    kind: value.kind,
    scope: value.scope,
    outcome: value.outcome,
    operationCount: Array.isArray(value.operations) ? value.operations.length : null,
    path: value.path,
    contentHash: value.contentHash,
  };
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requiredArg(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function usage() {
  return "Usage: ikb-maintenance.mjs source-sync|semantic-maintenance|weekly-housekeeping [--home <path>] [--dry-run] [--decisions <json>]";
}
