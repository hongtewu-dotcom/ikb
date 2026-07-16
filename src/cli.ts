import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LedgerStore } from "./store.ts";
import { assertValue, formatRows, printValue } from "./format.ts";
import { buildContextPack, captureKnowledge, findKnowledge, ingestKnowledge, listKnowledge, relateKnowledge, reviewKnowledge, searchKnowledge, updateKnowledgeStatus } from "./knowledge.ts";
import type { KnowledgeRelationType, OutputFormat } from "./types.ts";

interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

const HELP = `ikb - personal knowledge work operating system

Usage:
  ikb init [--home <path>]
  ikb status [--output table|json]
  ikb show <task-or-run-id>
  ikb task add|list|show|update|start|wait|done|cancel
  ikb run start|list|show|follow|checkpoint|resume|retry|finish|succeed|fail|cancel
  ikb approval request|list|show|approve|reject
  ikb artifact add|list|show|open
  ikb capture <source-file|text> --title <title> [--scope personal|work]
  ikb ingest <markdown-file> [--scope personal|work]
  ikb search <query> [--scope personal|work]
  ikb context <task-id> [--run <run-id>]
  ikb review [--scope personal|work]
  ikb knowledge list|show|verify|retire|review|relate
  ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts [--allow-cross-scope]
  ikb timeline <task-or-run-id>
  ikb doctor
  ikb backup
  ikb restore <backup-dir> --yes
  ikb ledger verify|rebuild
  ikb report daily|weekly [--format md|json]

Global options:
  --home <path>       Override IKB_HOME (default: ~/.ikb)
  --output table|json  Select output format
  --json               Alias for --output json
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, ...args] = parsed.positionals;
  if (!command || command === "help" || command === "--help" || parsed.options.help) {
    console.log(HELP);
    return;
  }

  const home = resolve(String(parsed.options.home ?? process.env.IKB_HOME ?? join(homedir(), ".ikb")));
  if (command === "init") {
    const store = new LedgerStore({ home });
    try {
      initializeHome(home);
      printValue({ initialized: true, home, events: store.eventsPath }, outputFormat(parsed));
    } finally {
      store.close();
    }
    return;
  }

  const store = new LedgerStore({ home });
  try {
    switch (command) {
      case "status":
        printValue({ home, ledger: store.eventsPath, knowledgeDue: reviewKnowledge(home).length, ...store.stats() }, outputFormat(parsed));
        break;
      case "show":
        handleShow(store, requiredArg([subcommand, ...args], 0, "task or run id"), parsed);
        break;
      case "task":
        handleTask(store, subcommand, args, parsed);
        break;
      case "run":
        handleRun(store, subcommand, args, parsed);
        break;
      case "approval":
        handleApproval(store, subcommand, args, parsed);
        break;
      case "artifact":
        handleArtifact(store, subcommand, args, parsed);
        break;
      case "capture":
        handleCapture(store, home, subcommand, args, parsed);
        break;
      case "ingest":
        handleIngest(store, home, subcommand, parsed);
        break;
      case "search":
        handleSearch(home, [subcommand, ...args].filter(Boolean).join(" "), parsed);
        break;
      case "context":
        handleContext(store, home, subcommand, parsed);
        break;
      case "review":
        printValue(reviewKnowledge(home, optionalOption(parsed, "scope")), outputFormat(parsed));
        break;
      case "knowledge":
        handleKnowledge(store, home, subcommand, args, parsed);
        break;
      case "timeline":
        handleTimeline(store, subcommand, parsed);
        break;
      case "doctor":
        handleDoctor(store, home, parsed);
        break;
      case "backup":
        handleBackup(store, home, parsed);
        break;
      case "restore":
        handleRestore(store, home, subcommand, parsed);
        break;
      case "ledger":
        handleLedger(store, subcommand, parsed);
        break;
      case "report":
        handleReport(store, subcommand, parsed);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

function handleTask(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "add": {
      const goal = requiredOption(parsed, "goal");
      const task = store.createTask({
        title: String(parsed.options.title ?? goal.slice(0, 72)),
        goal,
        acceptance: requiredOption(parsed, "accept", "acceptance"),
        type: optionalOption(parsed, "type"),
        priority: optionalOption(parsed, "priority"),
        risk: optionalOption(parsed, "risk"),
        scope: optionalOption(parsed, "scope"),
      });
      printValue(task, outputFormat(parsed));
      break;
    }
    case "list": {
      const tasks = store.listTasks({ status: optionalOption(parsed, "status"), type: optionalOption(parsed, "type") });
      printValue(tasks.map((task) => ({ id: task.id, status: task.status, type: task.type, priority: task.priority, title: task.title, updatedAt: task.updatedAt })), outputFormat(parsed));
      break;
    }
    case "show": {
      const task = store.requireTask(requiredArg(args, 0, "task id"));
      const value = { task, runs: store.listRuns({ taskId: task.id }), approvals: store.listApprovals({ taskId: task.id }), artifacts: store.listArtifacts({ taskId: task.id }), events: store.eventsFor(task.id) };
      printValue(value, outputFormat(parsed));
      break;
    }
    case "update": {
      const id = requiredArg(args, 0, "task id");
      const task = store.updateTask(id, pickOptions(parsed, ["title", "goal", "acceptance", "type", "priority", "risk", "scope"]));
      printValue(task, outputFormat(parsed));
      break;
    }
    case "start":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "active"), outputFormat(parsed));
      break;
    case "wait":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "waiting", requiredOption(parsed, "reason")), outputFormat(parsed));
      break;
    case "done":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "done", optionalOption(parsed, "reason"), optionalOption(parsed, "evidence")), outputFormat(parsed));
      break;
    case "cancel":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "canceled", requiredOption(parsed, "reason")), outputFormat(parsed));
      break;
    default:
      throw new Error(`Unknown task action: ${action ?? ""}`);
  }
}

function handleRun(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "start": {
      const skill = optionalOption(parsed, "skill");
      const run = store.createRun(requiredArg(args, 0, "task id"), String(parsed.options.agent ?? "manual"), skill ? skill.split(",") : []);
      printValue(run, outputFormat(parsed));
      break;
    }
    case "list": {
      const runs = store.listRuns({ taskId: optionalOption(parsed, "task"), status: optionalOption(parsed, "status") });
      printValue(runs, outputFormat(parsed));
      break;
    }
    case "show":
    case "follow": {
      const run = store.requireRun(requiredArg(args, 0, "run id"));
      const value = { run, task: store.requireTask(run.taskId), approvals: store.listApprovals({ taskId: run.taskId }).filter((approval) => approval.runId === run.id), artifacts: store.listArtifacts({ runId: run.id }), events: store.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === run.id) };
      printValue(value, outputFormat(parsed));
      break;
    }
    case "checkpoint":
      printValue(store.checkpointRun(requiredArg(args, 0, "run id"), requiredOption(parsed, "step", "checkpoint")), outputFormat(parsed));
      break;
    case "resume":
      printValue(store.resumeRun(requiredArg(args, 0, "run id")), outputFormat(parsed));
      break;
    case "retry":
      printValue(store.retryRun(requiredArg(args, 0, "run id"), optionalOption(parsed, "agent")), outputFormat(parsed));
      break;
    case "finish": {
      const status = requiredOption(parsed, "status");
      assertValue(["succeeded", "failed", "canceled"].includes(status), "--status must be succeeded, failed, or canceled");
      printValue(store.finishRun(requiredArg(args, 0, "run id"), status as "succeeded" | "failed" | "canceled", optionalOption(parsed, "summary")), outputFormat(parsed));
      break;
    }
    case "succeed":
      printValue(store.finishRun(requiredArg(args, 0, "run id"), "succeeded", optionalOption(parsed, "summary")), outputFormat(parsed));
      break;
    case "fail":
      printValue(store.finishRun(requiredArg(args, 0, "run id"), "failed", requiredOption(parsed, "reason", "summary")), outputFormat(parsed));
      break;
    case "cancel":
      printValue(store.finishRun(requiredArg(args, 0, "run id"), "canceled", optionalOption(parsed, "reason")), outputFormat(parsed));
      break;
    default:
      throw new Error(`Unknown run action: ${action ?? ""}`);
  }
}

function handleApproval(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "request": {
      const payloadText = optionalOption(parsed, "payload");
      let payload: unknown = payloadText ?? {};
      if (payloadText) {
        try { payload = JSON.parse(payloadText); } catch { /* plain text payload is still hashable */ }
      }
      const approval = store.requestApproval({
        runId: requiredArg(args, 0, "run id"),
        action: requiredOption(parsed, "action"),
        target: requiredOption(parsed, "target"),
        payload,
        risk: optionalOption(parsed, "risk"),
      });
      printValue(approval, outputFormat(parsed));
      break;
    }
    case "list":
      printValue(store.listApprovals({ status: optionalOption(parsed, "status"), taskId: optionalOption(parsed, "task") }), outputFormat(parsed));
      break;
    case "show":
      printValue(store.requireApproval(requiredArg(args, 0, "approval id")), outputFormat(parsed));
      break;
    case "approve":
      printValue(store.decideApproval(requiredArg(args, 0, "approval id"), "approved", optionalOption(parsed, "note")), outputFormat(parsed));
      break;
    case "reject":
      printValue(store.decideApproval(requiredArg(args, 0, "approval id"), "rejected", requiredOption(parsed, "reason", "note")), outputFormat(parsed));
      break;
    default:
      throw new Error(`Unknown approval action: ${action ?? ""}`);
  }
}

function handleArtifact(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "add":
      printValue(store.createArtifact({ runId: requiredArg(args, 0, "run id"), path: requiredOption(parsed, "path"), kind: optionalOption(parsed, "kind") ?? "file", label: optionalOption(parsed, "label") ?? requiredOption(parsed, "path") }), outputFormat(parsed));
      break;
    case "list":
      printValue(store.listArtifacts({ runId: requiredArg(args, 0, "run id"), taskId: optionalOption(parsed, "task") }), outputFormat(parsed));
      break;
    case "show":
      printValue(store.requireArtifact(requiredArg(args, 0, "artifact id")), outputFormat(parsed));
      break;
    case "open": {
      const artifact = store.requireArtifact(requiredArg(args, 0, "artifact id"));
      if (!existsSync(artifact.path)) throw new Error(`Artifact path does not exist: ${artifact.path}`);
      console.log(readFileSync(artifact.path, "utf8"));
      break;
    }
    default:
      throw new Error(`Unknown artifact action: ${action ?? ""}`);
  }
}

function handleCapture(store: LedgerStore, home: string, source: string | undefined, args: string[], parsed: ParsedArgs): void {
  const sourceValue = source ?? requiredOption(parsed, "content");
  const sourcePath = resolve(sourceValue);
  const fromFile = existsSync(sourcePath) && statSync(sourcePath).isFile();
  const body = fromFile ? readFileSync(sourcePath, "utf8") : sourceValue;
  const record = captureKnowledge(home, {
    title: requiredOption(parsed, "title"),
    body,
    type: optionalOption(parsed, "type"),
    scope: optionalOption(parsed, "scope"),
    sensitivity: optionalOption(parsed, "sensitivity"),
    sourceRefs: fromFile ? [sourcePath] : optionalOption(parsed, "source") ? [String(parsed.options.source)] : [],
    tags: optionalOption(parsed, "tags")?.split(",").filter(Boolean),
  });
  store.recordKnowledgeEvent(record.id, "knowledge.created", knowledgeEventPayload(record));
  printValue(record, outputFormat(parsed));
}

function handleIngest(store: LedgerStore, home: string, source: string | undefined, parsed: ParsedArgs): void {
  const record = ingestKnowledge(home, requiredValue(source, "markdown source"), { scope: optionalOption(parsed, "scope"), title: optionalOption(parsed, "title") });
  store.recordKnowledgeEvent(record.id, "knowledge.created", knowledgeEventPayload(record));
  printValue(record, outputFormat(parsed));
}

function handleSearch(home: string, query: string, parsed: ParsedArgs): void {
  assertValue(query, "Usage: ikb search <query>");
  printValue(searchKnowledge(home, query, { scope: optionalOption(parsed, "scope"), status: optionalOption(parsed, "status"), limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined }), outputFormat(parsed));
}

function handleContext(store: LedgerStore, home: string, taskId: string | undefined, parsed: ParsedArgs): void {
  const task = store.requireTask(requiredValue(taskId, "task id"));
  const context = buildContextPack(home, { taskId: task.id, title: task.title, goal: task.goal, acceptance: task.acceptance, scope: optionalOption(parsed, "scope"), limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined });
  const runId = optionalOption(parsed, "run");
  if (runId) {
    const run = store.requireRun(runId);
    assertValue(run.taskId === task.id, `Run ${runId} does not belong to Task ${task.id}`);
    writeFileSync(join(run.runDir, "context-pack.md"), context.markdown);
  }
  printValue(context, outputFormat(parsed));
}

function handleKnowledge(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "list":
      printValue(listKnowledge(home, optionalOption(parsed, "scope")).filter((record) => !optionalOption(parsed, "status") || record.status === optionalOption(parsed, "status")), outputFormat(parsed));
      break;
    case "show": {
      const record = findKnowledge(home, requiredArg(args, 0, "knowledge id"));
      assertValue(record, `Knowledge not found: ${args[0]}`);
      printValue(record, outputFormat(parsed));
      break;
    }
    case "verify":
      printValue(verifyKnowledge(store, home, requiredArg(args, 0, "knowledge id")), outputFormat(parsed));
      break;
    case "retire":
      printValue(retireKnowledge(store, home, requiredArg(args, 0, "knowledge id")), outputFormat(parsed));
      break;
    case "review":
      printValue(reviewKnowledge(home, optionalOption(parsed, "scope")), outputFormat(parsed));
      break;
    case "relate": {
      const relationType = requiredOption(parsed, "type");
      assertValue(["related", "derived_from", "contradicts"].includes(relationType), "--type must be related, derived_from, or contradicts");
      const result = relateKnowledge(
        home,
        requiredArg(args, 0, "source knowledge id"),
        requiredArg(args, 1, "target knowledge id"),
        relationType as KnowledgeRelationType,
        { allowCrossScope: parsed.options["allow-cross-scope"] === true },
      );
      if (result.changed) {
        const relationPayload = (sourceId: string, targetId: string) => ({
          relationType: result.relationType,
          sourceId,
          targetId,
          reciprocal: result.reciprocal,
          sourcePath: result.source.path,
          targetPath: result.target.path,
        });
        store.recordKnowledgeEvent(result.source.id, "knowledge.related", relationPayload(result.source.id, result.target.id));
        if (result.reciprocal) store.recordKnowledgeEvent(result.target.id, "knowledge.related", relationPayload(result.target.id, result.source.id));
      }
      printValue(result, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown knowledge action: ${action ?? ""}`);
  }
}

function verifyKnowledge(store: LedgerStore, home: string, id: string) {
  const record = updateKnowledgeStatus(home, id, "verified");
  store.recordKnowledgeEvent(record.id, "knowledge.verified", knowledgeEventPayload(record));
  return record;
}

function retireKnowledge(store: LedgerStore, home: string, id: string) {
  const record = updateKnowledgeStatus(home, id, "retired");
  store.recordKnowledgeEvent(record.id, "knowledge.retired", knowledgeEventPayload(record));
  return record;
}

function knowledgeEventPayload(record: { path: string; title: string; type: string; scope: string; status: string; sourceRefs: string[]; validFrom: string; reviewAfter: string; tags: string[]; aliases: string[]; related: string[]; derivedFrom: string[]; contradicts: string[] }): Record<string, unknown> {
  return {
    path: record.path,
    title: record.title,
    type: record.type,
    scope: record.scope,
    status: record.status,
    sourceRefs: record.sourceRefs,
    validFrom: record.validFrom,
    reviewAfter: record.reviewAfter,
    tags: record.tags,
    aliases: record.aliases,
    related: record.related,
    derivedFrom: record.derivedFrom,
    contradicts: record.contradicts,
  };
}

function handleShow(store: LedgerStore, id: string, parsed: ParsedArgs): void {
  const task = store.getTask(id);
  if (task) {
    printValue({ task, runs: store.listRuns({ taskId: id }), approvals: store.listApprovals({ taskId: id }), artifacts: store.listArtifacts({ taskId: id }), events: store.eventsFor(id) }, outputFormat(parsed));
    return;
  }
  const run = store.getRun(id);
  if (run) {
    printValue({ run, task: store.requireTask(run.taskId), approvals: store.listApprovals({ taskId: run.taskId }).filter((approval) => approval.runId === run.id), artifacts: store.listArtifacts({ runId: run.id }), events: store.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === id) }, outputFormat(parsed));
    return;
  }
  const approval = store.getApproval(id);
  if (approval) {
    printValue(approval, outputFormat(parsed));
    return;
  }
  const artifact = store.getArtifact(id);
  if (artifact) {
    printValue(artifact, outputFormat(parsed));
    return;
  }
  throw new Error(`No Task, Run, Approval or Artifact found for ${id}`);
}

function handleTimeline(store: LedgerStore, id: string | undefined, parsed: ParsedArgs): void {
  assertValue(id, "Usage: ikb timeline <task-or-run-id>");
  const events = store.eventsFor(id);
  printValue(events.map((event) => ({ sequence: event.sequence, occurredAt: event.occurredAt, aggregate: `${event.aggregateType}:${event.aggregateId}`, event: event.eventType, actor: event.actor, eventId: event.eventId })), outputFormat(parsed));
}

function handleDoctor(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  const verification = store.verify();
  const knownRunDirs = new Set(store.listRuns().map((run) => run.runDir));
  const actualRunDirs = existsSync(store.runsDir) ? readdirSync(store.runsDir).map((entry) => join(store.runsDir, entry)).filter((path) => statSync(path).isDirectory()) : [];
  const result = {
    home,
    ledger: store.eventsPath,
    ...verification,
    missingRunDirs: store.listRuns().filter((run) => !existsSync(run.runDir)).map((run) => run.id),
    orphanRunDirs: actualRunDirs.filter((path) => !knownRunDirs.has(path)),
    ok: verification.brokenChains.length === 0 && store.listRuns().every((run) => existsSync(run.runDir)),
  };
  printValue(result, outputFormat(parsed));
  if (!result.ok) process.exitCode = 2;
}

function handleBackup(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  const backupDir = join(home, "backups", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(store.eventsPath, join(backupDir, "events.jsonl"));
  printValue({ backupDir, events: store.listEvents().length }, outputFormat(parsed));
}

function handleRestore(store: LedgerStore, home: string, backupDir: string | undefined, parsed: ParsedArgs): void {
  assertValue(backupDir, "Usage: ikb restore <backup-dir> --yes");
  assertValue(parsed.options.yes === true, "Restore is destructive; add --yes to continue");
  const source = resolve(backupDir);
  const sourceEvents = join(source, "events.jsonl");
  assertValue(existsSync(sourceEvents), `Backup does not contain events.jsonl: ${source}`);
  const currentBackup = join(home, "backups", `pre-restore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  mkdirSync(currentBackup, { recursive: true });
  copyFileSync(store.eventsPath, join(currentBackup, "events.jsonl"));
  copyFileSync(sourceEvents, store.eventsPath);
  store.reload();
  const verification = store.verify();
  printValue({ restoredFrom: source, safetyBackup: currentBackup, verification }, outputFormat(parsed));
  if (verification.brokenChains.length > 0) process.exitCode = 2;
}

function handleLedger(store: LedgerStore, action: string | undefined, parsed: ParsedArgs): void {
  if (action === "verify" || action === "rebuild") {
    const verification = store.verify();
    printValue({ mode: action, sourceOfTruth: store.eventsPath, replay: verification }, outputFormat(parsed));
    if (verification.brokenChains.length > 0) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown ledger action: ${action ?? ""}`);
}

function handleReport(store: LedgerStore, period: string | undefined, parsed: ParsedArgs): void {
  if (!period || !["daily", "weekly"].includes(period)) throw new Error("Usage: ikb report daily|weekly [--format md|json]");
  const stats = store.stats();
  const tasks = store.listTasks({});
  const runs = store.listRuns({});
  const markdown = `# ikb ${period} report\n\n## Summary\n\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\`\n\n## Tasks\n\n${formatRows(tasks.map((task) => ({ id: task.id, status: task.status, type: task.type, title: task.title })))}\n\n## Runs\n\n${formatRows(runs.map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, checkpoint: run.checkpoint ?? "" })))}\n`;
  if (parsed.options.format === "md") console.log(markdown);
  else printValue({ period, stats, tasks, runs }, outputFormat(parsed));
}

function initializeHome(home: string): void {
  mkdirSync(join(home, "ledger"), { recursive: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "backups"), { recursive: true });
  mkdirSync(join(home, "vaults", "personal"), { recursive: true });
  mkdirSync(join(home, "vaults", "work"), { recursive: true });
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `home: ${home}\nledger: ${join(home, "ledger", "events.jsonl")}\npersonal_vault: ${join(home, "vaults", "personal")}\nwork_vault: ${join(home, "vaults", "work")}\n`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      options[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[raw] = next;
      index += 1;
    } else {
      options[raw] = true;
    }
  }
  if (options.json) options.output = "json";
  return { positionals, options };
}

function outputFormat(parsed: ParsedArgs): OutputFormat {
  return parsed.options.output === "json" ? "json" : "table";
}

function requiredOption(parsed: ParsedArgs, ...names: string[]): string {
  const value = names.map((name) => parsed.options[name]).find((candidate) => typeof candidate === "string" && candidate.length > 0);
  assertValue(value, `Missing required option: --${names[0]}`);
  return String(value);
}

function optionalOption(parsed: ParsedArgs, ...names: string[]): string | undefined {
  const value = names.map((name) => parsed.options[name]).find((candidate) => typeof candidate === "string");
  return value === undefined ? undefined : String(value);
}

function pickOptions(parsed: ParsedArgs, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => typeof parsed.options[name] === "string").map((name) => [name, String(parsed.options[name])]));
}

function requiredArg(args: string[], index: number, label: string): string {
  assertValue(args[index], `Missing ${label}`);
  return args[index];
}

function requiredValue(value: string | undefined, label: string): string {
  assertValue(value, `Missing ${label}`);
  return value;
}

main().catch((error) => {
  console.error(`ikb: ${(error as Error).message}`);
  process.exitCode = 1;
});
