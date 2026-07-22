import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerStore } from "../store.ts";
import { assertValue, formatRows, printValue } from "../format.ts";
import { initializeKnowledgeLayout, inspectKnowledgeLayout, reviewKnowledge } from "../knowledge.ts";
import { ensureCandidateLayout, inspectCandidatePool, listCandidates } from "../candidates.ts";
import { inspectIncrementalState } from "../incremental.ts";
import { inspectSourceIntegrity, inspectSourceRegistry } from "../source.ts";
import { listExperienceCandidates, listExperienceRecords } from "../experience.ts";
import { buildObservabilityReport } from "../observability.ts";
import { initializeKeyPeople } from "../people.ts";
import type { EventRecord, SourceRecord } from "../types.ts";
import { type ParsedArgs, optionalOption, outputFormat } from "./shared.ts";

export function handleStatus(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  printValue({
    home,
    ledger: store.eventsPath,
    knowledgeDue: reviewKnowledge(home).length,
    candidates: listCandidates(home).length,
    ...store.stats(),
  }, outputFormat(parsed));
}

const SOURCE_LEDGER_FIELDS: Array<keyof SourceRecord> = ["id", "title", "kind", "adapter", "includeTools", "scope", "sensitivity", "format", "originalPath", "rawPath", "recordsPath", "contentHash", "recordsHash", "recordCount", "importedAt"];

function inspectSourceLedger(sources: SourceRecord[], events: EventRecord[]) {
  return sources.flatMap((source) => {
    const event = [...events].reverse().find((candidate) => candidate.aggregateType === "source" && candidate.aggregateId === source.id && candidate.eventType === "source.ingested");
    if (!event) return [{ sourceId: source.id, code: "source_ledger_event_missing" as const, path: source.recordsPath, detail: "Source has no source.ingested ledger event" }];
    const mismatchedFields = SOURCE_LEDGER_FIELDS.filter((field) => JSON.stringify(source[field]) !== JSON.stringify(event.payload[field]));
    return mismatchedFields.length > 0
      ? [{ sourceId: source.id, code: "source_metadata_ledger_mismatch" as const, path: source.recordsPath, detail: `metadata differs from ledger fields: ${mismatchedFields.join(", ")}` }]
      : [];
  });
}

export function handleDoctor(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  const verification = store.verify();
  const knowledgeLayout = inspectKnowledgeLayout(home);
  const knownRunDirs = new Set(store.listRuns().map((run) => run.runDir));
  const actualRunDirs = existsSync(store.runsDir) ? readdirSync(store.runsDir).map((entry) => join(store.runsDir, entry)).filter((path) => statSync(path).isDirectory()) : [];
  const sourceRegistry = inspectSourceRegistry(home);
  const sources = sourceRegistry.sources;
  const sourceIssues = [...sourceRegistry.issues, ...sources.flatMap((source) => inspectSourceIntegrity(home, source)), ...inspectSourceLedger(sources, store.listEvents())];
  const candidatePool = inspectCandidatePool(home);
  const candidateIssues = candidatePool.issues;
  const incrementalState = inspectIncrementalState(home);
  let experiences = [];
  let experienceCandidates = [];
  const experienceIssues: Array<{ code: string; detail: string }> = [];
  try {
    experiences = listExperienceRecords(home);
    experienceCandidates = listExperienceCandidates(home);
  } catch (error) {
    experienceIssues.push({ code: "experience_registry_invalid", detail: (error as Error).message });
  }
  const result = {
    home,
    ledger: store.eventsPath,
    ...verification,
    sources: sources.length,
    candidates: candidatePool.candidates.length,
    candidateIssues,
    incrementalState,
    experiences: experiences.length,
    experienceCandidates: experienceCandidates.length,
    experienceIssues,
    knowledgeLayout,
    sourceIssues,
    unhashedNormalizedSources: sources.filter((source) => !source.recordsHash).map((source) => source.id),
    missingSourceFiles: [...new Set(sourceIssues.filter((issue) => issue.code === "raw_missing" || issue.code === "records_missing").map((issue) => issue.sourceId))],
    missingRunDirs: store.listRuns().filter((run) => !existsSync(run.runDir)).map((run) => run.id),
    orphanRunDirs: actualRunDirs.filter((path) => !knownRunDirs.has(path)),
    ok: verification.brokenChains.length === 0 && knowledgeLayout.ok && store.listRuns().every((run) => existsSync(run.runDir)) && sourceIssues.length === 0 && candidateIssues.length === 0 && incrementalState.issues.length === 0 && experienceIssues.length === 0,
  };
  printValue(result, outputFormat(parsed));
  if (!result.ok) process.exitCode = 2;
}

export function handleBackup(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  const backupDir = join(home, "backups", new Date().toISOString().replaceAll(/[:.]/g, "-"));
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const backupEvents = join(backupDir, "events.jsonl");
  copyFileSync(store.eventsPath, backupEvents);
  chmodSync(backupEvents, 0o600);
  printValue({ backupDir, events: store.listEvents().length }, outputFormat(parsed));
}

export function handleRestore(store: LedgerStore, home: string, backupDir: string | undefined, parsed: ParsedArgs): void {
  assertValue(backupDir, "Usage: ikb restore <backup-dir> --yes");
  assertValue(parsed.options.yes === true, "Restore is destructive; add --yes to continue");
  const source = resolve(backupDir);
  const sourceEvents = join(source, "events.jsonl");
  assertValue(existsSync(sourceEvents), `Backup does not contain events.jsonl: ${source}`);
  const currentBackup = join(home, "backups", `pre-restore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  mkdirSync(currentBackup, { recursive: true, mode: 0o700 });
  chmodSync(currentBackup, 0o700);
  const safetyEvents = join(currentBackup, "events.jsonl");
  copyFileSync(store.eventsPath, safetyEvents);
  chmodSync(safetyEvents, 0o600);
  copyFileSync(sourceEvents, store.eventsPath);
  chmodSync(store.eventsPath, 0o600);
  store.reload();
  const verification = store.verify();
  printValue({ restoredFrom: source, safetyBackup: currentBackup, verification }, outputFormat(parsed));
  if (verification.brokenChains.length > 0) process.exitCode = 2;
}

export function handleLedger(store: LedgerStore, action: string | undefined, parsed: ParsedArgs): void {
  if (action === "verify" || action === "rebuild") {
    const verification = store.verify();
    printValue({ mode: action, sourceOfTruth: store.eventsPath, replay: verification }, outputFormat(parsed));
    if (verification.brokenChains.length > 0) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown ledger action: ${action ?? ""}`);
}

export function handleReport(store: LedgerStore, home: string, period: string | undefined, parsed: ParsedArgs): void {
  if (period === "serve") {
    const projectRoot = resolve(process.env.IKB_PROJECT_ROOT ?? process.cwd());
    const server = join(projectRoot, "scripts", "ikb-report-server.mjs");
    assertValue(existsSync(server), `Report server not found: ${server}`);
    const port = optionalOption(parsed, "port") ?? "3417";
    const child = spawn(process.execPath, [server, "--home", home, "--port", port], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, IKB_PROJECT_ROOT: projectRoot },
    });
    child.on("exit", (code, signal) => {
      if (signal) process.exitCode = 1;
      else if (typeof code === "number") process.exitCode = code;
    });
    return;
  }
  if (!period || !["daily", "weekly"].includes(period)) throw new Error("Usage: ikb report daily|weekly [--format md|json]");
  const stats = store.stats();
  const tasks = store.listTasks({});
  const runs = store.listRuns({});
  const observability = buildObservabilityReport(store, period as "daily" | "weekly");
  const markdown = `# ikb ${period} report\n\n## Summary\n\n\`\`\`json\n${JSON.stringify({ stats, observability }, null, 2)}\n\`\`\`\n\n## Tasks\n\n${formatRows(tasks.map((task) => ({ id: task.id, status: task.status, type: task.type, title: task.title })))}\n\n## Runs\n\n${formatRows(runs.map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, checkpoint: run.checkpoint ?? "" })))}\n`;
  if (parsed.options.format === "md") {
    const reportPath = join(home, "reports", `${period}-${new Date().toISOString().slice(0, 10)}.md`);
    mkdirSync(join(home, "reports"), { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, markdown, { mode: 0o600 });
    chmodSync(reportPath, 0o600);
    console.log(markdown);
  } else printValue({ period, stats, observability, tasks, runs }, outputFormat(parsed));
}

export function initializeHome(home: string): void {
  for (const path of [home, join(home, "ledger"), join(home, "runs"), join(home, "backups"), join(home, "reports"), join(home, "sources"), join(home, "vaults", "personal"), join(home, "vaults", "work")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `home: ${home}\nledger: ${join(home, "ledger", "events.jsonl")}\npersonal_vault: ${join(home, "vaults", "personal")}\nwork_vault: ${join(home, "vaults", "work")}\n`, { mode: 0o600 });
  }
  chmodSync(configPath, 0o600);
  initializeKnowledgeLayout(home);
  ensureCandidateLayout(home);
  initializeKeyPeople(home);
}
