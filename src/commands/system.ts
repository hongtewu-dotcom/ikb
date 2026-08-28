import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LedgerStore } from "../store.ts";
import { assertValue, formatRows, printValue } from "../format.ts";
import { initializeKnowledgeLayout, inspectKnowledgeLayout, reviewKnowledge } from "../knowledge.ts";
import { ensureCandidateLayout, inspectCandidatePool, listCandidates } from "../candidates.ts";
import { inspectIncrementalState } from "../incremental.ts";
import { inspectSourceIntegrity, inspectSourceRegistry } from "../source.ts";
import { inspectSourceAliasRegistry } from "../source-query.ts";
import { defaultReferenceManifestPath, lintReferenceManifest } from "../reference-manifest.ts";
import { checkPrincipleProjections, defaultPrincipleProjectionManifestPath } from "../knowledge/principle-projection.ts";
import { listExperienceCandidates, listExperienceRecords } from "../experience.ts";
import { inspectExperienceReviewRegistry } from "../experience-review.ts";
import { buildObservabilityReport } from "../observability.ts";
import { initializeKeyPeople } from "../people.ts";
import { initializeSourceTargets } from "../source-targets.ts";
import { buildHealthView, writeDoctorHealth, writeLedgerHealth } from "../health.ts";
import { auditStorageLayout, createFullBackup } from "../storage-audit.ts";
import { ikbPaths, resolveBackupsRoot, resolveCacheRoot, resolveLedgerPath, resolveLedgerRoot, resolveRunsRoot, resolveSourcesRoot, resolveVault } from "../layout.ts";
import type { EventRecord, SourceRecord } from "../types.ts";
import { migrateStorageLayout } from "../storage-layout-migration.ts";
import { type ParsedArgs, optionalOption, outputFormat, requiredOption } from "./shared.ts";

export function handleStatus(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  printValue({
    home,
    ledger: store.eventsPath,
    knowledgeDue: reviewKnowledge(home).length,
    candidates: listCandidates(home).length,
    ...store.stats(),
  }, outputFormat(parsed));
}

export function handleHealth(home: string, parsed: ParsedArgs): void {
  const result = buildHealthView(home);
  printValue(result, outputFormat(parsed));
  if (result.state !== "ok") process.exitCode = 2;
}

const SOURCE_LEDGER_FIELDS: Array<keyof SourceRecord> = ["id", "title", "kind", "adapter", "includeTools", "scope", "sensitivity", "format", "originalPath", "rawPath", "rawStorage", "originBytes", "originModifiedAt", "externalizedAt", "recordsPath", "contentHash", "recordsHash", "recordCount", "importedAt"];

const SOURCE_PATH_FIELDS = new Set<keyof SourceRecord>(["originalPath", "rawPath", "recordsPath"]);

function inspectSourceLedger(sources: SourceRecord[], events: EventRecord[], resolvePath: (path: string) => string) {
  return sources.flatMap((source) => {
    const event = [...events].reverse().find((candidate) => candidate.aggregateType === "source"
      && candidate.aggregateId === source.id
      && (candidate.eventType === "source.ingested" || candidate.eventType === "source.storage_migrated"));
    if (!event) return [{ sourceId: source.id, code: "source_ledger_event_missing" as const, path: source.recordsPath, detail: "Source has no source.ingested ledger event" }];
    const valueForComparison = (field: keyof SourceRecord, value: unknown) => SOURCE_PATH_FIELDS.has(field) && typeof value === "string" ? resolvePath(value) : value;
    const mismatchedFields = SOURCE_LEDGER_FIELDS.filter((field) => JSON.stringify(valueForComparison(field, source[field])) !== JSON.stringify(valueForComparison(field, event.payload[field])));
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
  const sourceIssues = [...sourceRegistry.issues, ...inspectSourceAliasRegistry(home).issues, ...sources.flatMap((source) => inspectSourceIntegrity(home, source)), ...inspectSourceLedger(sources, store.listEvents(), (path) => store.resolveStoragePath(path))];
  const referenceManifestPath = defaultReferenceManifestPath(home);
  const referenceManifest = existsSync(referenceManifestPath) ? lintReferenceManifest(home, referenceManifestPath) : null;
  const principleProjectionManifestPath = defaultPrincipleProjectionManifestPath(home);
  const principleProjection = existsSync(principleProjectionManifestPath) ? checkPrincipleProjections(home, principleProjectionManifestPath) : null;
  const candidatePool = inspectCandidatePool(home);
  const candidateIssues = candidatePool.issues;
  const incrementalState = inspectIncrementalState(home);
  let experiences = [];
  let experienceCandidates = [];
  let experienceReviewPackages = { registered: 0, current: 0, issues: [] as Array<{ candidateId: string; detail: string }> };
  const experienceIssues: Array<{ code: string; detail: string }> = [];
  try {
    experiences = listExperienceRecords(home);
    experienceCandidates = listExperienceCandidates(home);
    experienceReviewPackages = inspectExperienceReviewRegistry(home, store);
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
    experienceReviewPackages,
    experienceIssues,
    knowledgeLayout,
    sourceIssues,
    referenceManifest,
    principleProjection,
    unhashedNormalizedSources: sources.filter((source) => !source.recordsHash).map((source) => source.id),
    missingSourceFiles: [...new Set(sourceIssues.filter((issue) => issue.code === "raw_missing" || issue.code === "records_missing").map((issue) => issue.sourceId))],
    missingRunDirs: store.listRuns().filter((run) => !existsSync(run.runDir)).map((run) => run.id),
    orphanRunDirs: actualRunDirs.filter((path) => !knownRunDirs.has(path)),
    ok: verification.brokenChains.length === 0 && knowledgeLayout.ok && store.listRuns().every((run) => existsSync(run.runDir)) && sourceIssues.length === 0 && candidateIssues.length === 0 && incrementalState.issues.length === 0 && experienceIssues.length === 0 && experienceReviewPackages.issues.length === 0 && (referenceManifest?.ok ?? true) && (principleProjection?.ok ?? true),
  };
  if (parsed.options["write-summary"] === true) writeDoctorHealth(home, result as unknown as Record<string, unknown>);
  printValue(parsed.options.compact === true ? compactDoctorResult(result) : result, outputFormat(parsed));
  if (!result.ok) process.exitCode = 2;
}

/** Compact terminal view for maintenance artifacts; the full result remains
 * available to ordinary doctor callers and is what --write-summary observes. */
export function compactDoctorResult(result: Record<string, any>): Record<string, unknown> {
  return {
    home: result.home,
    ledger: result.ledger,
    ok: result.ok,
    events: result.events,
    projections: result.projections,
    sources: result.sources,
    candidates: result.candidates,
    experiences: result.experiences,
    experienceCandidates: result.experienceCandidates,
    brokenChains: Array.isArray(result.brokenChains) ? result.brokenChains.length : 0,
    sourceIssues: Array.isArray(result.sourceIssues) ? result.sourceIssues.length : 0,
    candidateIssues: Array.isArray(result.candidateIssues) ? result.candidateIssues.length : 0,
    missingSourceFiles: Array.isArray(result.missingSourceFiles) ? result.missingSourceFiles.length : 0,
    missingRunDirs: Array.isArray(result.missingRunDirs) ? result.missingRunDirs.length : 0,
    orphanRunDirs: Array.isArray(result.orphanRunDirs) ? result.orphanRunDirs.length : 0,
    incrementalIssues: Array.isArray(result.incrementalState?.issues) ? result.incrementalState.issues.length : 0,
    experienceIssues: Array.isArray(result.experienceIssues) ? result.experienceIssues.length : 0,
    experienceReviewIssues: Array.isArray(result.experienceReviewPackages?.issues) ? result.experienceReviewPackages.issues.length : 0,
    knowledgeLayoutOk: result.knowledgeLayout?.ok === true,
    knowledgeLayoutQualityIssues: Array.isArray(result.knowledgeLayout?.qualityIssues) ? result.knowledgeLayout.qualityIssues.length : 0,
    referenceManifestOk: result.referenceManifest?.ok ?? null,
    principleProjectionOk: result.principleProjection?.ok ?? null,
  };
}

export function handleBackup(store: LedgerStore, home: string, parsed: ParsedArgs): void {
  if (parsed.options.full === true) {
    printValue(createFullBackup(home), outputFormat(parsed));
    return;
  }
  const backupDir = join(resolveBackupsRoot(home), new Date().toISOString().replaceAll(/[:.]/g, "-"));
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
  const currentBackup = join(resolveBackupsRoot(home), `pre-restore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
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

export function handleLedger(store: LedgerStore, home: string, action: string | undefined, parsed: ParsedArgs): void {
  if (action === "verify" || action === "rebuild") {
    const verification = store.verify();
    const result = { mode: action, sourceOfTruth: store.eventsPath, replay: verification };
    if (parsed.options["write-summary"] === true) writeLedgerHealth(home, result as unknown as Record<string, unknown>);
    printValue(result, outputFormat(parsed));
    if (verification.brokenChains.length > 0) process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown ledger action: ${action ?? ""}`);
}

export function handleStorage(store: LedgerStore, home: string, action: string | undefined, parsed: ParsedArgs): void {
  if (action === "audit") {
    printValue(auditStorageLayout(home, store), outputFormat(parsed));
    return;
  }
  if (action === "migrate-layout") {
    printValue(migrateStorageLayout(home, store), outputFormat(parsed));
    return;
  }
  if (action !== "relocate") throw new Error(`Unknown storage action: ${action ?? ""}`);
  const event = store.recordStorageRootRelocation({
    fromRoot: requiredOption(parsed, "from"),
    toRoot: requiredOption(parsed, "to"),
  });
  printValue({ event, effectiveFrom: store.resolveStoragePath(String(event.payload.fromRoot)) }, outputFormat(parsed));
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
    const reportRoot = join(resolveCacheRoot(home), "reports");
    const reportPath = join(reportRoot, `${period}-${new Date().toISOString().slice(0, 10)}.md`);
    mkdirSync(reportRoot, { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, markdown, { mode: 0o600 });
    chmodSync(reportPath, 0o600);
    console.log(markdown);
  } else printValue({ period, stats, observability, tasks, runs }, outputFormat(parsed));
}

export function initializeHome(home: string): void {
  const paths = ikbPaths(home);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  const configPath = join(home, "config.yaml");
  if (!existsSync(configPath)) {
    const compatibilityBootstrap = existsSync(join(paths.compatibility.ledger, "events.jsonl"));
    const ledgerPath = compatibilityBootstrap ? join(paths.compatibility.ledger, "events.jsonl") : join(paths.ledger, "events.jsonl");
    const sourcesRoot = compatibilityBootstrap ? paths.compatibility.sources : paths.sources;
    const runsRoot = compatibilityBootstrap ? paths.compatibility.runs : paths.runs;
    const backupsRoot = compatibilityBootstrap ? paths.compatibility.backups : paths.backups;
    const knowledgeRoot = compatibilityBootstrap ? paths.compatibility.vaults : paths.knowledge;
    writeFileSync(configPath, [
      `home: ${paths.home}`,
      `ledger: ${ledgerPath}`,
      `sources_root: ${sourcesRoot}`,
      `runs_root: ${runsRoot}`,
      `backups_root: ${backupsRoot}`,
      `cache_root: ${paths.cache}`,
      `people_root: ${compatibilityBootstrap ? paths.compatibility.vaults : join(paths.cache, "people")}`,
      `personal_vault: ${join(knowledgeRoot, "personal")}`,
      `work_vault: ${join(knowledgeRoot, "work")}`,
      "",
    ].join("\n"), { mode: 0o600 });
  }
  for (const path of [
    paths.system,
    paths.inbox,
    paths.archive,
    paths.receipts,
    resolveLedgerRoot(home),
    resolveRunsRoot(home),
    resolveBackupsRoot(home),
    resolveCacheRoot(home),
    resolveSourcesRoot(home),
    resolveVault(home, "personal"),
    resolveVault(home, "work"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  chmodSync(configPath, 0o600);
  initializeKnowledgeLayout(home);
  ensureCandidateLayout(home);
  initializeKeyPeople(home);
  initializeSourceTargets(home);
}
