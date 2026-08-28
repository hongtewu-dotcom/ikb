import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseArgs, runLegacyMaintenance, runMaintenance, writeMaintenanceRunPlan } from "../scripts/ikb-maintenance.mjs";
import { legacyMaintenanceSteps, maintenanceSteps } from "../scripts/ikb-maintenance-plan.mjs";
import { listKnowledge } from "../src/knowledge.ts";
import { captureKnowledge } from "../src/knowledge.ts";
import { archivedInboxItemPath, listInboxItems, upsertInboxItem } from "../src/inbox.ts";
import { refreshInboxFromSignals, selectSemanticInbox } from "../src/commands/maintenance.ts";
import { writeReceipt } from "../src/receipt.ts";
import { importSource } from "../src/source.ts";
import { LedgerStore } from "../src/store.ts";
import { createDefaultEvalRegistry } from "../projects/eval-plane/src/eval-registry.ts";
import { coordinateRunEvaluation } from "../projects/eval-plane/src/evaluation-coordinator.ts";

test("maintenance scheduler exposes the three bounded target modes", () => {
  assert.deepEqual(parseArgs(["daily", "--home", "/tmp/ikb-home"]), { mode: "source-sync", home: "/tmp/ikb-home", dryRun: false, decisions: null });
  assert.deepEqual(parseArgs(["weekly", "--home", "/tmp/ikb-home"]), { mode: "weekly-housekeeping", home: "/tmp/ikb-home", dryRun: false, decisions: null });
  assert.deepEqual(parseArgs(["semantic-maintenance", "--dry-run"]), { mode: "semantic-maintenance", home: resolve("ikb-data"), dryRun: true, decisions: null });
  assert.throws(() => parseArgs(["monthly"]), /source-sync\|semantic-maintenance\|weekly-housekeeping/);
});

test("target maintenance plans contain only Source sync, semantic, or housekeeping responsibilities", () => {
  assert.deepEqual(maintenanceSteps("source-sync").map((step) => step.name), [
    "home-init", "local-memory-sync", "registered-files-sync", "source-history-sync", "inbox-refresh", "final-receipt",
  ]);
  assert.deepEqual(maintenanceSteps("semantic-maintenance").map((step) => step.name), [
    "inbox-select", "knowledge-decisions", "final-receipt",
  ]);
  assert.deepEqual(maintenanceSteps("weekly-housekeeping").map((step) => step.name), [
    "source-coverage", "housekeeping-snapshot", "final-receipt",
  ]);
  for (const mode of ["source-sync", "semantic-maintenance", "weekly-housekeeping"]) {
    const names = maintenanceSteps(mode).map((step) => step.name).join(" ");
    assert.doesNotMatch(names, /candidate|experience|reasoning|knowledge-lint|doctor|harness/);
  }
});

test("source-sync dry run writes exactly one final Receipt and no Knowledge", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-sync-dry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const summary = runMaintenance({ mode: "source-sync", home, dryRun: true });
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.steps.map((step) => step.name), [
    "home-init", "local-memory-sync", "registered-files-sync", "source-history-sync", "inbox-refresh", "final-receipt",
  ]);
  assert.equal(receiptCount(home), 1);
  assert.equal(summary.receipt.kind, "source_sync");
  assert.equal(listKnowledge(home).length, 0);
  assert.equal(existsSync(join(home, "maintenance")), false);
  const receipt = JSON.parse(readFileSync(summary.receipt.path, "utf8"));
  assert.equal(receipt.operations.length, 5);
  assert.equal(receipt.operations.every((operation: { validation: { status: string } }) => operation.validation.status === "skipped"), true);
});

test("source-sync formal run keeps partial steps independent and emits one Receipt", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-source-sync-live-"));
  const memoryRoot = join(home, "empty-memory");
  mkdirSync(memoryRoot, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = {
    memoryRoot: process.env.IKB_CATPAW_MEMORY_ROOT,
    from: process.env.IKB_MAINTENANCE_HISTORY_FROM,
    to: process.env.IKB_MAINTENANCE_HISTORY_TO,
  };
  process.env.IKB_CATPAW_MEMORY_ROOT = memoryRoot;
  process.env.IKB_MAINTENANCE_HISTORY_FROM = "2099-01-01T00:00:00Z";
  process.env.IKB_MAINTENANCE_HISTORY_TO = "2099-01-02T00:00:00Z";
  t.after(() => {
    for (const [key, value] of Object.entries({
      IKB_CATPAW_MEMORY_ROOT: previous.memoryRoot,
      IKB_MAINTENANCE_HISTORY_FROM: previous.from,
      IKB_MAINTENANCE_HISTORY_TO: previous.to,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const summary = runMaintenance({ mode: "source-sync", home });
  assert.equal(summary.ok, true, JSON.stringify(summary.failures));
  assert.equal(receiptCount(home), 1);
  assert.equal(summary.receipt.kind, "source_sync");
  assert.equal(listKnowledge(home).length, 0);
  const store = new LedgerStore({ home });
  assert.equal(store.listEvents().filter((event) => event.eventType === "receipt.written").length, 1);
  assert.equal(store.listEvents().some((event) => event.eventType === "task.created" || event.eventType === "run.started"), false);
  store.close();
});

test("semantic selector processes at most three themes and writes one Receipt", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-semantic-select-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const summary = runMaintenance({ mode: "semantic-maintenance", home, dryRun: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.selected.length, 0);
  assert.equal(receiptCount(home), 1);
  assert.equal(summary.receipt.kind, "semantic_maintenance");
});

test("inbox refresh recovers unresolved feedback before the Source-sync boundary and suppresses raw conversation noise", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-inbox-feedback-boundary-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new LedgerStore({ home });
  t.after(() => store.close());
  const knowledge = captureKnowledge(home, { title: "Needs consumer correction", scope: "work", body: "The current card is incomplete." });
  store.recordKnowledgeEvent(knowledge.id, "knowledge.created", { path: knowledge.path });
  store.recordKnowledgeFeedbackEvent(knowledge.id, { runId: "run-consumer", outcome: "partial", reasonCode: "boundary_missing" });
  writeReceipt(home, store, {
    kind: "source_sync",
    scope: "work",
    command: "test boundary",
    startedAt: new Date().toISOString(),
    outcome: "succeeded",
    operations: [],
  });
  const input = join(home, "conversation.jsonl");
  writeFileSync(input, `${JSON.stringify({ role: "user", content: "raw conversation", timestamp: new Date().toISOString() })}\n`);
  const imported = importSource(home, input, { kind: "ai_conversation", scope: "work", title: "Raw conversation" });
  store.recordSourceIngestEvents([{ id: imported.source.id, payload: imported.source }]);

  const first = refreshInboxFromSignals(store, home);
  const items = listInboxItems(home, "work");
  assert.equal(first.feedbackEventsScanned, 1);
  assert.equal(items.some((item) => item.trigger === "partial_feedback" && item.knowledgeIds.includes(knowledge.id)), true);
  assert.equal(items.some((item) => item.trigger === "source_changed" && item.sourceRefs.includes(imported.source.id)), false);
  const occurrenceCount = items.find((item) => item.trigger === "partial_feedback")?.occurrenceCount;
  const second = refreshInboxFromSignals(store, home);
  assert.equal(second.createdOrRefreshed, 0);
  assert.equal(listInboxItems(home, "work").find((item) => item.trigger === "partial_feedback")?.occurrenceCount, occurrenceCount);
});

test("inbox refresh archives stale resolved zero results and unlinked raw Source items", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-inbox-reconcile-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new LedgerStore({ home });
  t.after(() => store.close());
  captureKnowledge(home, { title: "Resolved topic", scope: "work", status: "verified", sourceRefs: ["manual:test"], body: "This topic is available." });
  const input = join(home, "manual.md");
  writeFileSync(input, "# Raw manual memory\n");
  const imported = importSource(home, input, { kind: "manual", scope: "work", title: "Raw manual memory" });
  const zeroResult = upsertInboxItem(home, {
    scope: "work",
    trigger: "zero_result",
    subject: "Resolved topic",
    goal: "Resolved topic",
    sourceRefs: [],
    knowledgeIds: [],
    usageId: "run-zero",
    details: {},
  });
  const rawSource = upsertInboxItem(home, {
    scope: "work",
    trigger: "source_changed",
    subject: imported.source.title,
    goal: "Review raw input",
    sourceRefs: [imported.source.id],
    knowledgeIds: [],
    usageId: null,
    details: {},
  });

  const result = refreshInboxFromSignals(store, home, new Date().toISOString());
  assert.equal(listInboxItems(home, "work").length, 0);
  assert.deepEqual(new Set(result.archived.inbox.map((item) => item.reason)), new Set(["query_now_resolved", "source_routes_to_evidence_analysis"]));
  assert.equal(existsSync(archivedInboxItemPath(home, "work", zeroResult.id)), true);
  assert.equal(existsSync(archivedInboxItemPath(home, "work", rawSource.id)), true);
});

test("semantic selector gives the three partial-feedback topics precedence", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-semantic-priority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const subject of ["Agent runtime", "SpecX entry", "Traffic KB entry"]) {
    upsertInboxItem(home, {
      scope: "work",
      trigger: "partial_feedback",
      subject,
      goal: "Revise from real feedback",
      sourceRefs: [],
      knowledgeIds: [`kb-${subject.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`],
      usageId: `run-${subject}`,
      details: {},
    });
  }
  upsertInboxItem(home, {
    scope: "work",
    trigger: "source_changed",
    subject: "Lower priority source",
    goal: "Review source",
    sourceRefs: ["src-lower-priority"],
    knowledgeIds: [],
    usageId: null,
    details: {},
  });

  const selected = selectSemanticInbox(home, "work", 3).selected;
  assert.equal(selected.length, 3);
  assert.equal(selected.every((item) => item.trigger === "partial_feedback"), true);
  assert.deepEqual(new Set(selected.map((item) => item.subject)), new Set(["Agent runtime", "SpecX entry", "Traffic KB entry"]));
});

function receiptCount(home: string): number {
  const directory = join(home, ".system", "receipts");
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).length : 0;
}

test("legacy maintenance steps remain readable but are not the target scheduler", () => {
  const daily = legacyMaintenanceSteps("daily");
  assert.equal(daily[0].name, "home-init");
  assert.deepEqual(daily.at(-1)?.dependsOn, ["ledger"]);
  assert.equal(daily.some((step) => step.name === "run-evaluation-repair"), false);
  assert.deepEqual(daily.find((step) => step.name === "doctor")?.dependsOn, ["reasoning"]);
  assert.deepEqual(daily.find((step) => step.name === "doctor")?.args, ["doctor", "--write-summary", "--compact"]);
  assert.ok(daily.every((step, index) => index === 0 || step.dependsOn.length > 0));
  const weekly = legacyMaintenanceSteps("weekly");
  assert.deepEqual(weekly.slice(-3).map((step) => step.name), ["weekly-report", "experience-cluster", "outer-patterns"]);
});

test("maintenance plan is a pure dependency graph with explicit external-read controls", () => {
  const previous = process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN;
  process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN = "true";
  try {
    const steps = legacyMaintenanceSteps("daily");
    const resolve = steps.find((step) => step.name === "candidate-resolve");
    assert.ok(resolve);
    assert.ok(resolve.args.includes("--dry-run"));
    assert.deepEqual(resolve.args.slice(resolve.args.indexOf("--delay-ms"), resolve.args.indexOf("--delay-ms") + 2), ["--delay-ms", "30000"]);
    const agentTeam = steps.find((step) => step.name === "agent-team-observe");
    assert.ok(agentTeam?.args.includes("--fail-open"));
    assert.deepEqual(steps.find((step) => step.name === "source-raw-dedup")?.dependsOn, ["agent-team-observe"]);
    assert.deepEqual(steps.map((step) => step.name), [
      "home-init", "local-memory-sync", "registered-files-sync", "source-ingest", "agent-team-observe", "source-raw-dedup", "experience-triage", "experience-analysis-queue",
      "candidate-discover", "candidate-resolve", "source-coverage", "people-rebuild", "people-readiness",
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
  const steps = legacyMaintenanceSteps("daily");
  const path = writeMaintenanceRunPlan(runDir, steps);
  assert.equal(path.endsWith("maintenance-plan-input.json"), true);
  const plan = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(plan.steps.slice(0, -1).map((step) => step.id), steps.map((step) => step.name));
  assert.deepEqual(plan.steps.at(-1), { id: "maintenance-summary", depends_on: [steps.at(-1).name] });
});

test("maintenance closes a real Run quality chain without post-evaluation Artifact drift", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ikb-maintenance-run-"));
  const memoryRoot = join(home, "empty-memory");
  const codexSessionsRoot = join(home, "empty-codex-sessions");
  mkdirSync(memoryRoot, { recursive: true });
  mkdirSync(codexSessionsRoot, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previous = {
    from: process.env.IKB_MAINTENANCE_HISTORY_FROM,
    to: process.env.IKB_MAINTENANCE_HISTORY_TO,
    dryRun: process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN,
    limit: process.env.IKB_MAINTENANCE_CITADEL_LIMIT,
    memoryRoot: process.env.IKB_CATPAW_MEMORY_ROOT,
    agentTeamRoots: process.env.IKB_AGENT_TEAM_SESSION_ROOTS,
  };
  process.env.IKB_MAINTENANCE_HISTORY_FROM = "2099-01-01T00:00:00Z";
  process.env.IKB_MAINTENANCE_HISTORY_TO = "2099-01-02T00:00:00Z";
  process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN = "true";
  process.env.IKB_MAINTENANCE_CITADEL_LIMIT = "10";
  process.env.IKB_CATPAW_MEMORY_ROOT = memoryRoot;
  process.env.IKB_AGENT_TEAM_SESSION_ROOTS = codexSessionsRoot;
  t.after(() => {
    for (const [key, value] of Object.entries({
      IKB_MAINTENANCE_HISTORY_FROM: previous.from,
      IKB_MAINTENANCE_HISTORY_TO: previous.to,
      IKB_MAINTENANCE_CITADEL_DRY_RUN: previous.dryRun,
      IKB_MAINTENANCE_CITADEL_LIMIT: previous.limit,
      IKB_CATPAW_MEMORY_ROOT: previous.memoryRoot,
      IKB_AGENT_TEAM_SESSION_ROOTS: previous.agentTeamRoots,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const summary = runLegacyMaintenance({ mode: "daily", home });
  assert.equal(summary.ok, true);
  assert.equal(summary.harnessEvaluation.hardGatePassed, true);
  assert.equal(summary.harnessEvaluation.passedCases, 8);
  assert.equal(summary.finalLedger.brokenChains, 0);

  const store = new LedgerStore({ home });
  try {
    const run = store.requireRun(summary.runId);
    const plan = JSON.parse(readFileSync(join(run.runDir, "plan.json"), "utf8"));
    assert.equal(plan.status, "planned");
    assert.equal(plan.steps.length, legacyMaintenanceSteps("daily").length + 1);
    const doctorArtifact = store.listArtifacts({ runId: summary.runId }).find((artifact) => artifact.label === "doctor");
    assert.ok(doctorArtifact);
    const doctorStep = JSON.parse(readFileSync(doctorArtifact.path, "utf8"));
    assert.equal(doctorStep.value.incrementalState, undefined);
    assert.equal(typeof doctorStep.value.sourceIssues, "number");
    assert.ok(statSync(doctorArtifact.path).size < 64 * 1024);
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
