import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { ikbPaths, resolveBackupsRoot, resolveLedgerPath } from "./layout.ts";
import { listKnowledge, searchKnowledge } from "./knowledge.ts";
import { listSources } from "./source.ts";
import type { LedgerStore } from "./store.ts";

export const FULL_BACKUP_MANIFEST_SCHEMA = "ikb-full-backup.v1";
export const STORAGE_AUDIT_SCHEMA = "ikb-storage-layout-audit.v1";

export function createFullBackup(home: string) {
  const paths = ikbPaths(home);
  const createdAt = new Date().toISOString();
  const backupRoot = resolveBackupsRoot(home);
  const backupDir = join(backupRoot, `full-${createdAt.replaceAll(/[:.]/g, "-")}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const stats = { files: 0, directories: 0, symlinks: 0, bytes: 0, skipped: [] as string[] };
  for (const entry of readdirSync(paths.home, { withFileTypes: true })) {
    cloneTree(join(paths.home, entry.name), join(backupDir, entry.name), stats, [backupRoot]);
  }
  const knowledge = knowledgeSnapshot(home);
  const sources = sourceSnapshot(home);
  const ledgerPath = resolveLedgerPath(home);
  const ledgerHash = hashFile(ledgerPath);
  const manifest = {
    schema: FULL_BACKUP_MANIFEST_SCHEMA,
    createdAt,
    sourceHome: paths.home,
    backupDir,
    excluded: [relative(paths.home, backupRoot)],
    cloneMode: "COPYFILE_FICLONE",
    stats,
    ledgerHash,
    knowledge,
    sources,
  };
  const manifestPath = join(backupDir, "backup-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return { ...manifest, manifestPath };
}

export function auditStorageLayout(home: string, store: LedgerStore, projectRoot = resolve(process.env.IKB_PROJECT_ROOT ?? process.cwd())) {
  const paths = ikbPaths(home);
  const createdAt = new Date().toISOString();
  const knowledge = knowledgeSnapshot(home);
  const sources = sourceSnapshot(home);
  const retrieval = listKnowledge(home, "work")
    .filter((record) => record.status === "verified")
    .map((record) => ({
      query: record.title,
      expectedKnowledgeId: record.id,
      results: searchKnowledge(home, record.title, { scope: "work", status: "verified", limit: 10 }).map((item) => ({ id: item.id, score: item.score })),
    }));
  const events = store.listEvents();
  const rawRunPathRefs = events.filter((event) => event.eventType === "run.queued" && typeof event.payload.runDir === "string" && isWithin(String(event.payload.runDir), paths.compatibility.runs));
  const rawArtifactPathRefs = events.filter((event) => event.eventType === "artifact.created" && typeof event.payload.path === "string" && isWithin(String(event.payload.path), paths.compatibility.runs));
  const runPathRefs = rawRunPathRefs.filter((event) => isWithin(store.resolveStoragePath(String(event.payload.runDir)), paths.compatibility.runs));
  const artifactPathRefs = rawArtifactPathRefs.filter((event) => isWithin(store.resolveStoragePath(String(event.payload.path)), paths.compatibility.runs));
  const legacyConsumers = scanLegacyConsumers(projectRoot);
  const trees = Object.fromEntries([
    ["sources", paths.compatibility.sources],
    ["vaults", paths.compatibility.vaults],
    ["ledger", paths.compatibility.ledger],
    ["runs", paths.compatibility.runs],
    ["backups", paths.compatibility.backups],
    ["reports", join(paths.home, "reports")],
    ["staging", join(paths.home, "staging")],
  ].map(([name, path]) => [name, { path, ...treeStats(path) }]));
  const blockers = [
    ...(legacyConsumers.length > 0 ? [`${legacyConsumers.length} current code locations still construct legacy storage paths`] : []),
    ...(runPathRefs.length > 0 ? [`${runPathRefs.length} Ledger Run events still reference compatibility runs paths`] : []),
    ...(artifactPathRefs.length > 0 ? [`${artifactPathRefs.length} Ledger Artifact events still reference compatibility runs paths`] : []),
  ];
  const audit = {
    schema: STORAGE_AUDIT_SCHEMA,
    createdAt,
    home: paths.home,
    targetPaths: {
      knowledge: paths.knowledge,
      inbox: paths.inbox,
      archive: paths.archive,
      sources: paths.sources,
      receipts: paths.receipts,
      ledger: paths.ledger,
      runs: paths.runs,
      backups: paths.backups,
    },
    compatibilityPaths: paths.compatibility,
    knowledge,
    sources,
    retrieval,
    trees,
    references: {
      runPathRefs: { count: runPathRefs.length, rawCount: rawRunPathRefs.length, eventIds: runPathRefs.slice(0, 20).map((event) => event.eventId) },
      artifactPathRefs: { count: artifactPathRefs.length, rawCount: rawArtifactPathRefs.length, eventIds: artifactPathRefs.slice(0, 20).map((event) => event.eventId) },
      legacyConsumers,
    },
    migrationReady: blockers.length === 0,
    deletionReady: false,
    blockers,
    deletionBoundary: "No runs, reports, staging or backups are deleted by this audit; deletion requires zero live references and a recoverable full backup.",
  };
  const directory = join(paths.system, "storage-audits");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${createdAt.replaceAll(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ...audit, path };
}

function cloneTree(source: string, target: string, stats: { files: number; directories: number; symlinks: number; bytes: number; skipped: string[] }, excludedRoots: string[]): void {
  if (excludedRoots.some((root) => resolve(source) === resolve(root))) {
    stats.skipped.push(source);
    return;
  }
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
    stats.directories += 1;
    for (const entry of readdirSync(source)) cloneTree(join(source, entry), join(target, entry), stats, excludedRoots);
    return;
  }
  if (stat.isFile()) {
    copyFileSync(source, target, constants.COPYFILE_FICLONE);
    chmodSync(target, 0o600);
    const copied = lstatSync(target);
    if (copied.size !== stat.size) throw new Error(`Backup size mismatch: ${source}`);
    stats.files += 1;
    stats.bytes += stat.size;
    return;
  }
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    stats.symlinks += 1;
    return;
  }
  stats.skipped.push(source);
}

function knowledgeSnapshot(home: string) {
  const records = listKnowledge(home).map((record) => ({
    id: record.id,
    scope: record.scope,
    status: record.status,
    path: record.path,
    contentHash: hashFile(record.path),
    sourceRefs: [...record.sourceRefs].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const semanticRecords = records.map(({ path: _path, ...record }) => record);
  return { count: records.length, aggregateHash: hash(JSON.stringify(semanticRecords)), records };
}

function sourceSnapshot(home: string) {
  const rows = listSources(home, { includeQuarantined: true }).map((source) => ({ id: source.id, contentHash: source.contentHash, recordsHash: source.recordsHash ?? null })).sort((left, right) => left.id.localeCompare(right.id));
  return { count: rows.length, aggregateHash: hash(JSON.stringify(rows)) };
}

function scanLegacyConsumers(projectRoot: string) {
  const roots = [join(projectRoot, "src"), join(projectRoot, "scripts")];
  const tokens = ["sources", "vaults", "ledger", "runs", "backups"];
  const results: Array<{ path: string; line: number; tokens: string[] }> = [];
  for (const root of roots) {
    for (const path of textFiles(root)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        const normalized = line.replaceAll(/resolve\(\s*(?:home|this\.home)\s*\)/g, "IKB_HOME");
        const firstSegment = normalized.match(/(?:join|resolve)\(\s*(?:IKB_HOME|home|this\.home)\s*,\s*["']([^"']+)["']/)?.[1];
        const matched = firstSegment && tokens.includes(firstSegment) ? [firstSegment] : [];
        if (matched.length > 0) results.push({ path, line: index + 1, tokens: matched });
      });
    }
  }
  return results;
}

function textFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...textFiles(path));
    else if (entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function treeStats(root: string): { files: number; directories: number; bytes: number } {
  if (!existsSync(root)) return { files: 0, directories: 0, bytes: 0 };
  const result = { files: 0, directories: 0, bytes: 0 };
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      result.directories += 1;
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (stat.isFile()) {
      result.files += 1;
      result.bytes += stat.size;
    }
  };
  visit(root);
  return result;
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function hashFile(path: string): string | null {
  return existsSync(path) ? hash(readFileSync(path)) : null;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
