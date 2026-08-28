import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hashSourceContent, hashSourceFile, inspectSourceIntegrity, listSources } from "./source.ts";
import type { SourceRecord } from "./types.ts";
import { resolveSourcesRoot } from "./layout.ts";

export interface SourceRawCompactionOptions {
  scope?: "personal" | "work";
  dryRun?: boolean;
}

export interface SourceRawExternalizeOptions {
  scope?: "personal" | "work";
  dryRun?: boolean;
  onMigrated?: (source: SourceRecord) => void;
}

export interface SourceRawExternalizeIssue {
  sourceId: string;
  code: "records_hash_missing" | "source_integrity_failed" | "origin_missing" | "origin_symlink" | "origin_not_file" | "migration_failed" | "raw_delete_failed";
  detail: string;
}

export interface SourceRawExternalizeResult {
  startedAt: string;
  finishedAt: string;
  scope: "all" | "personal" | "work";
  dryRun: boolean;
  checkedSources: number;
  migratedSources: number;
  externalSources: number;
  evidenceOnlySources: number;
  removedBytes: number;
  migratedSourceIds: string[];
  issues: SourceRawExternalizeIssue[];
  reportPath: string;
}

export interface SourceRawCompactionIssue {
  sourceId: string;
  code: "raw_missing" | "raw_not_file" | "raw_symlink" | "raw_path_outside_source" | "raw_hash_mismatch" | "clone_unavailable";
  detail: string;
}

export interface SourceRawCompactionGroup {
  contentHash: string;
  sourceIds: string[];
  canonicalSourceId: string;
  strategy: "exact-content" | "append-prefix";
  linkedSourceIds: string[];
  prefixSourceIds: string[];
  logicalBytes: number;
  estimatedSharedBytes: number;
}

export interface SourceRawCompactionResult {
  startedAt: string;
  finishedAt: string;
  scope: "all" | "personal" | "work";
  dryRun: boolean;
  scannedSources: number;
  validSources: number;
  uniqueContentHashes: number;
  duplicateGroups: number;
  duplicateSources: number;
  linkedSources: number;
  prefixCompactedSources: number;
  estimatedSharedBytes: number;
  issues: SourceRawCompactionIssue[];
  groups: SourceRawCompactionGroup[];
  checkedSourceIds: string[];
  reportPath: string;
}

interface RawFile {
  source: SourceRecord;
  bytes: number;
  buffer?: Buffer;
}

/**
 * Compact immutable raw snapshots without changing Source IDs or rawPath
 * locators. Exact copies use a copy-on-write clone (or a read-only hardlink
 * fallback); append-only snapshots use an APFS clone plus the new suffix.
 * Normalized records and the ledger remain untouched.
 */
export function compactSourceRaw(home: string, options: SourceRawCompactionOptions = {}): SourceRawCompactionResult {
  const startedAt = new Date().toISOString();
  const allSources = listSources(home, { includeQuarantined: true });
  const scope = options.scope;
  const alreadyCompacted = options.dryRun ? new Set<string>() : readCompactedSourceIds(home);
  const sources = allSources.filter((source) => (source.rawStorage === undefined || source.rawStorage === "managed") && (!scope || source.scope === scope));
  const issues: SourceRawCompactionIssue[] = [];
  const valid: RawFile[] = [];

  for (const source of sources) {
    const pathIssue = validateRawPath(home, source);
    if (pathIssue) {
      issues.push({ sourceId: source.id, ...pathIssue });
      continue;
    }
    if (alreadyCompacted.has(source.id)) {
      valid.push({ source, bytes: statSync(source.rawPath).size });
      continue;
    }
    const bytes = readFileSync(source.rawPath);
    const actualHash = hashSourceContent(bytes);
    if (actualHash !== source.contentHash) {
      issues.push({ sourceId: source.id, code: "raw_hash_mismatch", detail: `expected ${source.contentHash}, got ${actualHash}` });
      continue;
    }
    valid.push({ source, bytes: bytes.length });
  }

  const groupsByHash = new Map<string, RawFile[]>();
  for (const item of valid) {
    const group = groupsByHash.get(item.source.contentHash) ?? [];
    group.push(item);
    groupsByHash.set(item.source.contentHash, group);
  }
  for (const group of groupsByHash.values()) group.sort(compareRawFiles);

  const groups: SourceRawCompactionGroup[] = [];
  let linkedSources = 0;
  let prefixCompactedSources = 0;

  for (const [contentHash, exactGroup] of groupsByHash) {
    const canonical = exactGroup[0];
    const group: SourceRawCompactionGroup = {
      contentHash,
      sourceIds: exactGroup.map((item) => item.source.id),
      canonicalSourceId: canonical.source.id,
      strategy: exactGroup.length > 1 ? "exact-content" : "append-prefix",
      linkedSourceIds: [],
      prefixSourceIds: [],
      logicalBytes: exactGroup.reduce((total, item) => total + item.bytes, 0),
      estimatedSharedBytes: 0,
    };

    if (exactGroup.length > 1) {
      group.strategy = "exact-content";
      for (const duplicate of exactGroup.slice(1)) {
        if (alreadyCompacted.has(duplicate.source.id)) continue;
        if (sameFile(canonical.source.rawPath, duplicate.source.rawPath)) continue;
        group.estimatedSharedBytes += duplicate.bytes;
        if (!options.dryRun) {
          try {
            replaceWithCloneOrHardlink(canonical.source.rawPath, duplicate.source.rawPath);
          } catch (error) {
            issues.push({ sourceId: duplicate.source.id, code: "clone_unavailable", detail: (error as Error).message });
            continue;
          }
        }
        group.linkedSourceIds.push(duplicate.source.id);
        linkedSources += 1;
      }
    }

    groups.push(group);
  }

  // A logical session often grows by appending new JSONL records. Preserve
  // every rawPath, but share its unchanged prefix through a copy-on-write clone.
  const logicalGroups = new Map<string, RawFile[]>();
  for (const item of valid) {
    const key = `${item.source.adapter ?? "direct"}:${item.source.kind}:${item.source.scope}:${item.source.originalPath}`;
    const group = logicalGroups.get(key) ?? [];
    group.push(item);
    logicalGroups.set(key, group);
  }
  for (const logicalGroup of logicalGroups.values()) {
    logicalGroup.sort(compareRawFiles);
    let previous: RawFile | null = null;
    for (const current of logicalGroup) {
      if (!previous || current.bytes <= previous.bytes || current.source.contentHash === previous.source.contentHash) {
        previous = current;
        continue;
      }
      if (alreadyCompacted.has(current.source.id)) {
        previous = current;
        continue;
      }
      const currentBuffer = readFileSync(current.source.rawPath);
      const previousBuffer = readFileSync(previous.source.rawPath);
      if (!currentBuffer.subarray(0, previousBuffer.length).equals(previousBuffer)) {
        previous = current;
        continue;
      }
      const rendered = groups.find((group) => group.contentHash === current.source.contentHash);
      const targetGroup = rendered ?? {
        contentHash: current.source.contentHash,
        sourceIds: [current.source.id],
        canonicalSourceId: previous.source.id,
        strategy: "append-prefix" as const,
        linkedSourceIds: [],
        prefixSourceIds: [],
        logicalBytes: current.bytes,
        estimatedSharedBytes: 0,
      };
      if (!groups.includes(targetGroup)) groups.push(targetGroup);
      const sharedBytes = previousBuffer.length;
      targetGroup.strategy = "append-prefix";
      targetGroup.estimatedSharedBytes += sharedBytes;
      if (!options.dryRun) {
        try {
          replaceWithCloneAndSuffix(previous.source.rawPath, current.source.rawPath, currentBuffer.subarray(sharedBytes));
        } catch (error) {
          issues.push({ sourceId: current.source.id, code: "clone_unavailable", detail: (error as Error).message });
          previous = current;
          continue;
        }
      }
      if (!targetGroup.prefixSourceIds.includes(current.source.id)) targetGroup.prefixSourceIds.push(current.source.id);
      prefixCompactedSources += 1;
      previous = current;
    }
  }

  const estimatedSharedBytes = groups.reduce((total, group) => total + group.estimatedSharedBytes, 0);
  const finishedAt = new Date().toISOString();
  const result: SourceRawCompactionResult = {
    startedAt,
    finishedAt,
    scope: scope ?? "all",
    dryRun: options.dryRun === true,
    scannedSources: sources.length,
    validSources: valid.length,
    uniqueContentHashes: groupsByHash.size,
    duplicateGroups: [...groupsByHash.values()].filter((group) => group.length > 1).length,
    duplicateSources: [...groupsByHash.values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0),
    linkedSources,
    prefixCompactedSources,
    estimatedSharedBytes,
    issues,
    groups,
    checkedSourceIds: valid.map((item) => item.source.id),
    reportPath: writeCompactionReport(home, { startedAt, finishedAt, scope: scope ?? "all", dryRun: options.dryRun === true, scannedSources: sources.length, validSources: valid.length, uniqueContentHashes: groupsByHash.size, duplicateGroups: [...groupsByHash.values()].filter((group) => group.length > 1).length, duplicateSources: [...groupsByHash.values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0), linkedSources, prefixCompactedSources, estimatedSharedBytes, issues, groups, checkedSourceIds: valid.map((item) => item.source.id) }),
  };
  return result;
}

/**
 * Remove redundant managed copies for local Agent histories. The normalized
 * records remain immutable inside IKB while rawPath becomes a locator owned by
 * Codex/Claude/Desk. Remote exports are deliberately excluded because their
 * original may disappear after intake.
 */
export function externalizeHistoryRaw(home: string, options: SourceRawExternalizeOptions = {}): SourceRawExternalizeResult {
  const startedAt = new Date().toISOString();
  const localAdapters = new Set(["claude", "codex", "desk"]);
  const candidates = listSources(home, { includeQuarantined: true }).filter((source) => (
    (source.rawStorage === undefined || source.rawStorage === "managed")
    && source.kind === "ai_conversation"
    && Boolean(source.adapter && localAdapters.has(source.adapter))
    && (!options.scope || source.scope === options.scope)
  ));
  const issues: SourceRawExternalizeIssue[] = [];
  const migratedSourceIds: string[] = [];
  let removedBytes = 0;
  let externalSources = 0;
  let evidenceOnlySources = 0;

  for (const source of candidates) {
    const integrity = inspectSourceIntegrity(home, source);
    if (integrity.length > 0) {
      issues.push({ sourceId: source.id, code: "source_integrity_failed", detail: integrity.map((issue) => issue.code).join(", ") });
      continue;
    }
    const rawBytes = statSync(source.rawPath).size;
    const originAvailable = existsSync(source.originalPath)
      && !lstatSync(source.originalPath).isSymbolicLink()
      && statSync(source.originalPath).isFile();
    if (options.dryRun) {
      migratedSourceIds.push(source.id);
      removedBytes += rawBytes;
      if (originAvailable) externalSources += 1;
      else evidenceOnlySources += 1;
      continue;
    }

    const sourceDirectory = join(resolveSourcesRoot(home), source.id);
    const metadataPath = join(sourceDirectory, "source.json");
    const previousMetadata = readFileSync(metadataPath, "utf8");
    const pendingRawPath = join(dirname(source.rawPath), `.raw-externalize-${randomUUID()}`);
    const temporaryMetadataPath = join(sourceDirectory, `.source-externalize-${randomUUID()}.json`);
    const originStat = originAvailable ? statSync(source.originalPath) : null;
    const normalizedHash = source.recordsHash ?? hashSourceFile(source.recordsPath);
    const migrated: SourceRecord = {
      ...source,
      rawPath: originAvailable ? source.originalPath : source.recordsPath,
      rawStorage: originAvailable ? "external" : "evidence",
      recordsHash: normalizedHash,
      originBytes: originStat?.size ?? rawBytes,
      ...(originStat ? { originModifiedAt: originStat.mtime.toISOString() } : {}),
      externalizedAt: new Date().toISOString(),
    };

    try {
      renameSync(source.rawPath, pendingRawPath);
      writeFileSync(temporaryMetadataPath, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaryMetadataPath, metadataPath);
      try {
        options.onMigrated?.(migrated);
      } catch (error) {
        const rollbackPath = join(sourceDirectory, `.source-rollback-${randomUUID()}.json`);
        writeFileSync(rollbackPath, previousMetadata, { mode: 0o600 });
        renameSync(rollbackPath, metadataPath);
        renameSync(pendingRawPath, source.rawPath);
        throw error;
      }
    } catch (error) {
      try {
        if (existsSync(temporaryMetadataPath)) unlinkSync(temporaryMetadataPath);
      } catch {
        // The report retains the source id for deterministic cleanup.
      }
      issues.push({ sourceId: source.id, code: "migration_failed", detail: (error as Error).message });
      continue;
    }

    try {
      unlinkSync(pendingRawPath);
      removedBytes += rawBytes;
    } catch (error) {
      issues.push({ sourceId: source.id, code: "raw_delete_failed", detail: `${pendingRawPath}: ${(error as Error).message}` });
    }
    migratedSourceIds.push(source.id);
    if (originAvailable) externalSources += 1;
    else evidenceOnlySources += 1;
  }

  const finishedAt = new Date().toISOString();
  const report = {
    startedAt,
    finishedAt,
    scope: options.scope ?? "all" as const,
    dryRun: options.dryRun === true,
    checkedSources: candidates.length,
    migratedSources: migratedSourceIds.length,
    externalSources,
    evidenceOnlySources,
    removedBytes,
    migratedSourceIds,
    issues,
  };
  return { ...report, reportPath: writeExternalizeReport(home, report) };
}

function compareRawFiles(left: RawFile, right: RawFile): number {
  return left.source.importedAt.localeCompare(right.source.importedAt) || left.source.id.localeCompare(right.source.id);
}

function validateRawPath(home: string, source: SourceRecord): { code: SourceRawCompactionIssue["code"]; detail: string } | null {
  const sourceDir = join(resolveSourcesRoot(home), source.id);
  const path = resolve(source.rawPath);
  const relativePath = relative(sourceDir, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return { code: "raw_path_outside_source", detail: `raw path must remain inside ${sourceDir}` };
  if (!existsSync(path)) return { code: "raw_missing", detail: "raw file is missing" };
  if (lstatSync(path).isSymbolicLink()) return { code: "raw_symlink", detail: "raw file must not be a symlink" };
  if (!statSync(path).isFile()) return { code: "raw_not_file", detail: "raw path is not a regular file" };
  return null;
}

function sameFile(left: string, right: string): boolean {
  const a = statSync(left);
  const b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function replaceWithCloneOrHardlink(sourcePath: string, targetPath: string): void {
  const temporary = join(dirname(targetPath), `.raw-dedup-${randomUUID()}`);
  try {
    try {
      execFileSync("cp", ["-c", sourcePath, temporary], { stdio: "pipe" });
    } catch {
      linkSync(sourcePath, temporary);
      chmodSync(temporary, 0o400);
    }
    renameSync(temporary, targetPath);
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The next doctor run will report a missing file if a replacement failed.
    }
  }
}

function replaceWithCloneAndSuffix(sourcePath: string, targetPath: string, suffix: Buffer): void {
  const temporary = join(dirname(targetPath), `.raw-dedup-${randomUUID()}`);
  try {
    execFileSync("cp", ["-c", sourcePath, temporary], { stdio: "pipe" });
    appendFileSync(temporary, suffix);
    chmodSync(temporary, 0o600);
    renameSync(temporary, targetPath);
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The next doctor run will report a missing file if a replacement failed.
    }
  }
}

function writeCompactionReport(home: string, report: Omit<SourceRawCompactionResult, "reportPath">): string {
  const directory = join(resolve(home), "governance", "raw-dedup");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const path = join(directory, "latest.json");
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function writeExternalizeReport(home: string, report: Omit<SourceRawExternalizeResult, "reportPath">): string {
  const directory = join(resolve(home), "governance", "raw-retention");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filename = `${report.startedAt.replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
  const path = join(directory, filename);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  const latest = join(directory, "latest.json");
  writeFileSync(latest, content, { mode: 0o600 });
  chmodSync(latest, 0o600);
  return path;
}

function readCompactedSourceIds(home: string): Set<string> {
  const path = join(resolve(home), "governance", "raw-dedup", "latest.json");
  if (!existsSync(path)) return new Set();
  try {
    const report = JSON.parse(readFileSync(path, "utf8")) as { dryRun?: boolean; groups?: SourceRawCompactionGroup[]; checkedSourceIds?: string[] };
    if (report.dryRun === true) return new Set();
    const ids = new Set<string>();
    for (const id of report.checkedSourceIds ?? []) ids.add(id);
    for (const group of report.groups ?? []) {
      for (const id of [...(group.linkedSourceIds ?? []), ...(group.prefixSourceIds ?? [])]) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}
