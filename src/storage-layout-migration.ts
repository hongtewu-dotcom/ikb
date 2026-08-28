import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { rebuildKnowledgeViews } from "./knowledge.ts";
import { ikbPaths, readConfig } from "./layout.ts";
import { listSources } from "./source.ts";
import { auditStorageLayout, createFullBackup } from "./storage-audit.ts";
import type { LedgerStore } from "./store.ts";
import { LedgerStore as ReopenedLedgerStore } from "./store.ts";
import type { SourceRecord } from "./types.ts";

export const STORAGE_LAYOUT_MIGRATION_SCHEMA = "ikb-storage-layout-migration.v1";

interface DirectoryMove {
  name: string;
  from: string;
  to: string;
}

interface SourceMetadataRewrite {
  id: string;
  path: string;
  before: string;
  after: string;
}

export function migrateStorageLayout(
  home: string,
  store: LedgerStore,
  projectRoot = resolve(process.env.IKB_PROJECT_ROOT ?? process.cwd()),
) {
  const startedAt = new Date().toISOString();
  const paths = ikbPaths(home);
  assertNoPathOverrides();
  if (targetLayoutIsActive(paths)) return finalizeExistingMigration(paths, store, projectRoot);
  assertLegacyLayoutIsActive(paths);

  const backup = createFullBackup(home);
  const before = auditStorageLayout(home, store, projectRoot);
  if (before.references.legacyConsumers.length > 0) {
    throw new Error(`Storage layout migration is blocked by ${before.references.legacyConsumers.length} current legacy path constructors`);
  }
  if (backup.knowledge.aggregateHash !== before.knowledge.aggregateHash || backup.sources.aggregateHash !== before.sources.aggregateHash) {
    throw new Error("Full backup snapshot does not match the pre-migration storage audit");
  }
  const missingRunDirs = store.listRuns().filter((run) => !existsSync(run.runDir)).map((run) => run.id);
  if (missingRunDirs.length > 0) throw new Error(`Storage layout migration has missing Run directories: ${missingRunDirs.slice(0, 10).join(", ")}`);

  const migrationId = `layout-${startedAt.replaceAll(/[:.]/g, "-")}`;
  const migrationDirectory = join(paths.system, "storage-migrations", migrationId);
  mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
  chmodSync(migrationDirectory, 0o700);
  const journalPath = join(migrationDirectory, "journal.json");
  const configPath = join(paths.home, "config.yaml");
  const configBefore = readFileSync(configPath, "utf8");
  const configBackupPath = join(migrationDirectory, "config.before.yaml");
  writeFileSync(configBackupPath, configBefore, { mode: 0o600 });
  chmodSync(configBackupPath, 0o600);

  const primaryMoves = buildPrimaryMoves(paths);
  preflightMoves(primaryMoves);
  const sourceRewrites = buildSourceRewrites(paths);
  const configAfter = targetConfig(configBefore, paths);
  const preparedConfigPath = join(paths.home, `.config-layout-${migrationId}.yaml`);
  writeFileSync(preparedConfigPath, configAfter, { mode: 0o600 });
  chmodSync(preparedConfigPath, 0o600);
  const physicalMoves: DirectoryMove[] = [];
  const rewrittenMetadata: SourceMetadataRewrite[] = [];
  let relocationsRecorded = false;

  const writeJournal = (status: string, error: string | null = null) => {
    const value = {
      schema: STORAGE_LAYOUT_MIGRATION_SCHEMA,
      migrationId,
      startedAt,
      updatedAt: new Date().toISOString(),
      status,
      home: paths.home,
      backupManifestPath: backup.manifestPath,
      preAuditPath: before.path,
      primaryMoves,
      physicalMoves,
      sourceMetadataRewrites: rewrittenMetadata.length,
      relocationsRecorded,
      configPath,
      error,
    };
    writeFileSync(journalPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(journalPath, 0o600);
  };

  writeJournal("prepared");
  try {
    for (const move of primaryMoves.filter((item) => item.name !== "ledger")) executeMove(move, physicalMoves);
    for (const move of splitPersonProjectionMoves(paths)) executeMove(move, physicalMoves);
    for (const rewrite of sourceRewrites) {
      const currentPath = mapPath(rewrite.path, paths.compatibility.sources, paths.sources);
      writeFileSync(currentPath, rewrite.after, { mode: 0o600 });
      chmodSync(currentPath, 0o600);
      rewrittenMetadata.push({ ...rewrite, path: currentPath });
    }
    writeJournal("content_moved");

    const relocationInputs = [
      ...primaryMoves.map((move) => ({ fromRoot: move.from, toRoot: move.to })),
      ...personRelocations(paths),
    ];
    store.recordStorageRootRelocations(relocationInputs);
    relocationsRecorded = true;
    writeJournal("relocations_recorded");

    const ledgerMove = primaryMoves.find((item) => item.name === "ledger")!;
    executeMove(ledgerMove, physicalMoves);
    store.close();
    renameSync(preparedConfigPath, configPath);
    chmodSync(configPath, 0o600);
    writeJournal("config_switched");
  } catch (error) {
    if (!relocationsRecorded) rollbackPhysicalMoves(physicalMoves, rewrittenMetadata);
    writeJournal(relocationsRecorded ? "failed_after_relocation_commit" : "rolled_back", (error as Error).message);
    throw error;
  }

  const reopened = new ReopenedLedgerStore({ home: paths.home, actor: "storage-layout-migration" });
  try {
    rebuildKnowledgeViews(paths.home, "personal");
    rebuildKnowledgeViews(paths.home, "work");
    const after = auditStorageLayout(paths.home, reopened, projectRoot);
    assertSnapshotsEqual(before, after);
    const verification = reopened.verify();
    if (verification.brokenChains.length > 0) throw new Error(`Ledger replay broke after migration: ${verification.brokenChains.length} chains`);
    if (!after.migrationReady) throw new Error(`Post-migration storage audit is still blocked: ${after.blockers.join("; ")}`);
    writeJournal("completed");
    return {
      schema: STORAGE_LAYOUT_MIGRATION_SCHEMA,
      migrationId,
      startedAt,
      finishedAt: new Date().toISOString(),
      backup: {
        manifestPathBeforeMigration: backup.manifestPath,
        manifestPath: mapPath(backup.manifestPath, paths.compatibility.backups, paths.backups),
        knowledge: backup.knowledge,
        sources: backup.sources,
      },
      before: { path: before.path, migrationReady: before.migrationReady, blockers: before.blockers },
      after: { path: after.path, migrationReady: after.migrationReady, deletionReady: after.deletionReady, blockers: after.blockers },
      moves: physicalMoves,
      sourceMetadataRewrites: rewrittenMetadata.length,
      verification,
      journalPath,
    };
  } finally {
    reopened.close();
  }
}

function finalizeExistingMigration(paths: ReturnType<typeof ikbPaths>, store: LedgerStore, projectRoot: string) {
  const journalRoot = join(paths.system, "storage-migrations");
  const journalPath = readdirSync(journalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(journalRoot, entry.name, "journal.json"))
    .filter((path) => existsSync(path))
    .sort()
    .at(-1);
  if (!journalPath) throw new Error("Target storage layout is active but no migration journal exists");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<string, any>;
  if (journal.schema !== STORAGE_LAYOUT_MIGRATION_SCHEMA || typeof journal.preAuditPath !== "string") {
    throw new Error(`Invalid storage layout migration journal: ${journalPath}`);
  }
  const before = JSON.parse(readFileSync(journal.preAuditPath, "utf8"));
  try {
    rebuildKnowledgeViews(paths.home, "personal");
    rebuildKnowledgeViews(paths.home, "work");
    const after = auditStorageLayout(paths.home, store, projectRoot);
    assertSnapshotsEqual(before, after);
    const verification = store.verify();
    if (verification.brokenChains.length > 0) throw new Error(`Ledger replay broke after migration: ${verification.brokenChains.length} chains`);
    if (!after.migrationReady) throw new Error(`Post-migration storage audit is still blocked: ${after.blockers.join("; ")}`);
    const completed = {
      ...journal,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "completed",
      postAuditPath: after.path,
      verification,
      error: null,
    };
    writeFileSync(journalPath, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
    chmodSync(journalPath, 0o600);
    const backupManifestPath = mapPath(String(journal.backupManifestPath), paths.compatibility.backups, paths.backups);
    return {
      schema: STORAGE_LAYOUT_MIGRATION_SCHEMA,
      migrationId: journal.migrationId,
      startedAt: journal.startedAt,
      finishedAt: completed.finishedAt,
      resumed: true,
      backup: { manifestPathBeforeMigration: journal.backupManifestPath, manifestPath: backupManifestPath },
      before: { path: journal.preAuditPath, migrationReady: before.migrationReady, blockers: before.blockers },
      after: { path: after.path, migrationReady: after.migrationReady, deletionReady: after.deletionReady, blockers: after.blockers },
      moves: journal.physicalMoves ?? [],
      sourceMetadataRewrites: journal.sourceMetadataRewrites ?? 0,
      verification,
      journalPath,
    };
  } catch (error) {
    const failed = { ...journal, updatedAt: new Date().toISOString(), status: "verification_failed", error: (error as Error).message };
    writeFileSync(journalPath, `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 });
    chmodSync(journalPath, 0o600);
    throw error;
  }
}

function buildPrimaryMoves(paths: ReturnType<typeof ikbPaths>): DirectoryMove[] {
  return [
    { name: "sources", from: paths.compatibility.sources, to: paths.sources },
    { name: "runs", from: paths.compatibility.runs, to: paths.runs },
    { name: "backups", from: paths.compatibility.backups, to: paths.backups },
    { name: "knowledge-personal", from: join(paths.compatibility.vaults, "personal"), to: join(paths.knowledge, "personal") },
    { name: "knowledge-work", from: join(paths.compatibility.vaults, "work"), to: join(paths.knowledge, "work") },
    { name: "ledger", from: paths.compatibility.ledger, to: paths.ledger },
  ];
}

function personRelocations(paths: ReturnType<typeof ikbPaths>) {
  return ["personal", "work"].map((scope) => ({
    fromRoot: join(paths.compatibility.vaults, scope, "people"),
    toRoot: join(paths.cache, "people", scope),
  }));
}

function splitPersonProjectionMoves(paths: ReturnType<typeof ikbPaths>): DirectoryMove[] {
  const moves: DirectoryMove[] = [];
  for (const scope of ["personal", "work"]) {
    const knowledgePeople = join(paths.knowledge, scope, "people");
    if (!existsSync(knowledgePeople)) continue;
    const cachePeople = join(paths.cache, "people", scope);
    mkdirSync(cachePeople, { recursive: true, mode: 0o700 });
    chmodSync(cachePeople, 0o700);
    for (const entry of readdirSync(knowledgePeople, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      moves.push({ name: `people-${scope}-${entry.name}`, from: join(knowledgePeople, entry.name), to: join(cachePeople, entry.name) });
    }
    const indexPath = join(knowledgePeople, "index.md");
    if (existsSync(indexPath)) moves.push({ name: `people-${scope}-index`, from: indexPath, to: join(cachePeople, "index.md") });
  }
  return moves;
}

function buildSourceRewrites(paths: ReturnType<typeof ikbPaths>): SourceMetadataRewrite[] {
  return listSources(paths.home, { includeQuarantined: true }).map((source) => {
    const metadataPath = join(paths.compatibility.sources, source.id, "source.json");
    const before = readFileSync(metadataPath, "utf8");
    const value = JSON.parse(before) as SourceRecord;
    value.rawPath = mapPath(value.rawPath, paths.compatibility.sources, paths.sources);
    value.recordsPath = mapPath(value.recordsPath, paths.compatibility.sources, paths.sources);
    return { id: source.id, path: metadataPath, before, after: `${JSON.stringify(value, null, 2)}\n` };
  });
}

function preflightMoves(moves: DirectoryMove[]): void {
  for (const move of moves) {
    if (!existsSync(move.from)) throw new Error(`Storage layout source is missing: ${move.from}`);
    if (lstatSync(move.from).isSymbolicLink()) throw new Error(`Storage layout source must not be a symlink: ${move.from}`);
    if (existsSync(move.to)) throw new Error(`Storage layout destination already exists: ${move.to}`);
    mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
    chmodSync(dirname(move.to), 0o700);
  }
}

function executeMove(move: DirectoryMove, completed: DirectoryMove[]): void {
  if (!existsSync(move.from)) return;
  if (existsSync(move.to)) throw new Error(`Storage layout destination already exists: ${move.to}`);
  mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
  renameSync(move.from, move.to);
  completed.push(move);
}

function rollbackPhysicalMoves(completed: DirectoryMove[], rewrites: SourceMetadataRewrite[]): void {
  for (const rewrite of [...rewrites].reverse()) {
    if (existsSync(rewrite.path)) writeFileSync(rewrite.path, rewrite.before, { mode: 0o600 });
  }
  for (const move of [...completed].reverse()) {
    if (existsSync(move.to) && !existsSync(move.from)) {
      mkdirSync(dirname(move.from), { recursive: true, mode: 0o700 });
      renameSync(move.to, move.from);
    }
  }
}

function targetConfig(text: string, paths: ReturnType<typeof ikbPaths>): string {
  const updates: Record<string, string> = {
    home: paths.home,
    ledger: join(paths.ledger, "events.jsonl"),
    sources_root: paths.sources,
    runs_root: paths.runs,
    backups_root: paths.backups,
    cache_root: paths.cache,
    people_root: join(paths.cache, "people"),
    personal_vault: join(paths.knowledge, "personal"),
    work_vault: join(paths.knowledge, "work"),
  };
  const seen = new Set<string>();
  const lines = text.split("\n").filter((line, index, rows) => index < rows.length - 1 || line.length > 0).map((line) => {
    const match = line.match(/^([A-Za-z0-9_]+):/);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}: ${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}: ${value}`);
  return `${lines.join("\n")}\n`;
}

function mapPath(path: string, fromRoot: string, toRoot: string): string {
  if (!isWithin(path, fromRoot)) return path;
  return resolve(toRoot, relative(resolve(fromRoot), resolve(path)));
}

function isWithin(path: string, root: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function assertNoPathOverrides(): void {
  const overrides = ["IKB_LEDGER_PATH", "IKB_SOURCES_ROOT", "IKB_RUNS_ROOT", "IKB_BACKUPS_ROOT", "IKB_CACHE_ROOT", "IKB_PEOPLE_ROOT", "IKB_PERSONAL_VAULT", "IKB_WORK_VAULT"]
    .filter((key) => Boolean(process.env[key]));
  if (overrides.length > 0) throw new Error(`Storage layout migration cannot run with path overrides: ${overrides.join(", ")}`);
}

function assertLegacyLayoutIsActive(paths: ReturnType<typeof ikbPaths>): void {
  const config = readConfig(paths.home);
  if (resolve(config.ledger ?? "") !== join(paths.compatibility.ledger, "events.jsonl")) {
    throw new Error("Storage layout migration requires the compatibility layout to be active");
  }
  for (const path of [paths.compatibility.sources, paths.compatibility.ledger, paths.compatibility.runs, paths.compatibility.backups, paths.compatibility.vaults]) {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Compatibility storage directory is missing: ${path}`);
  }
}

function targetLayoutIsActive(paths: ReturnType<typeof ikbPaths>): boolean {
  const config = readConfig(paths.home);
  return resolve(config.ledger ?? "") === join(paths.ledger, "events.jsonl")
    && resolve(config.sources_root ?? "") === paths.sources
    && resolve(config.runs_root ?? "") === paths.runs
    && resolve(config.backups_root ?? "") === paths.backups
    && resolve(config.personal_vault ?? "") === join(paths.knowledge, "personal")
    && resolve(config.work_vault ?? "") === join(paths.knowledge, "work");
}

function assertSnapshotsEqual(before: any, after: any): void {
  if (before.knowledge.count !== after.knowledge.count || before.knowledge.aggregateHash !== after.knowledge.aggregateHash) {
    throw new Error("Knowledge ids, content hashes, status or Source refs changed during storage migration");
  }
  if (before.sources.count !== after.sources.count || before.sources.aggregateHash !== after.sources.aggregateHash) {
    throw new Error("Source ids or content hashes changed during storage migration");
  }
  const expected = new Map(before.retrieval.map((item: any) => [item.expectedKnowledgeId, item.results.map((result: any) => result.id).join(",")]));
  if (expected.size !== after.retrieval.length) throw new Error("Verified Knowledge retrieval coverage changed during storage migration");
  for (const item of after.retrieval) {
    if (expected.get(item.expectedKnowledgeId) !== item.results.map((result: any) => result.id).join(",")) {
      throw new Error(`Knowledge retrieval changed during storage migration: ${item.expectedKnowledgeId}`);
    }
  }
}
