import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import { importIncrementalRecords, type IncrementalState } from "./incremental.ts";
import { listSources, makeSourceId, normalizeSourceScope, parseSourceRecords } from "./source.ts";
import { listSourceTargets, resolveTargetPath, type SourceTarget } from "./source-targets.ts";
import type { SourceKind, SourceRecord } from "./types.ts";

export interface LocalFileSyncOptions {
  adapter: string;
  kind: SourceKind;
  scope?: string;
  sensitivity?: string;
  extensions?: string[];
  exclude?: string[];
  limit?: number;
}

export interface LocalFileSyncResult {
  scanId: string;
  root: string;
  adapter: string;
  scope: "personal" | "work";
  discovered: number;
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{
    path: string;
    source: SourceRecord | null;
    skipped: boolean;
    reason?: string;
    error?: string;
    deltaCount?: number;
    duplicateCount?: number;
    changedCount?: number;
    incrementalState?: IncrementalState;
  }>;
}

export interface LocalTargetSyncResult {
  scanId: string;
  discoveredTargets: number;
  syncedTargets: number;
  failedTargets: number;
  discoveredFiles: number;
  imported: number;
  skipped: number;
  failedFiles: number;
  results: Array<{ target: SourceTarget; scan: LocalFileSyncResult | null; error?: string }>;
}

export function syncLocalFiles(home: string, rootValue: string, options: LocalFileSyncOptions): LocalFileSyncResult {
  const root = resolve(rootValue.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Local file root is not a directory: ${rootValue}`);
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Local file root must not be a symlink: ${root}`);
  const adapter = String(options.adapter ?? "").trim();
  if (!adapter) throw new Error("Local file sync requires an adapter");
  const scope = normalizeSourceScope(options.scope, "work");
  const extensions = new Set((options.extensions?.length ? options.extensions : [".md"])
    .map((extension) => extension.trim().toLowerCase())
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`));
  const exclude = (options.exclude ?? []).map((item) => item.trim()).filter(Boolean);
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) throw new Error("Local file sync limit must be a non-negative integer");
  const allPaths = discoverLocalFiles(root, extensions, exclude);
  const paths = options.limit && options.limit > 0 ? allPaths.slice(0, options.limit) : allPaths;
  const previousSources = listSources(home, { includeQuarantined: true });
  const results = paths.map((path) => {
    try {
      const content = readFileSync(path);
      const sourceId = makeSourceId();
      const records = parseSourceRecords(content.toString("utf8"), sourceId, options.kind, path);
      const result = importIncrementalRecords(home, path, content, {
        kind: options.kind,
        adapter,
        title: basename(path, extname(path)),
        scope,
        sensitivity: options.sensitivity ?? (scope === "personal" ? "private" : "work-internal"),
        logicalKey: `files:${adapter}:${path}`,
        cursor: { version: 1, modifiedAt: statSync(path).mtime.toISOString(), size: statSync(path).size },
        previousSources,
      }, records);
      return {
        path,
        source: result.source,
        skipped: result.skipped,
        reason: result.reason,
        deltaCount: result.deltaCount,
        duplicateCount: result.duplicateCount,
        changedCount: result.changedCount,
        incrementalState: result.state,
      };
    } catch (error) {
      return { path, source: null, skipped: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return {
    scanId: `file-scan-${randomUUID().slice(0, 12)}`,
    root,
    adapter,
    scope,
    discovered: paths.length,
    imported: results.filter((result) => !result.skipped && !result.error).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => Boolean(result.error)).length,
    results,
  };
}

export function syncLocalSourceTargets(home: string, scope?: string): LocalTargetSyncResult {
  const targets = listSourceTargets(home, scope).filter((target) => target.enabled && target.kind === "local_directory");
  const results = targets.map((target) => {
    try {
      const scan = syncLocalFiles(home, resolveTargetPath(target.locator!.path!), {
        adapter: target.adapter,
        kind: target.sourceKind!,
        scope: target.scope,
        sensitivity: target.sensitivity,
        extensions: target.extensions,
        exclude: target.exclude,
        limit: 0,
      });
      return { target, scan };
    } catch (error) {
      return { target, scan: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const scans = results.flatMap((result) => result.scan ? [result.scan] : []);
  return {
    scanId: `target-scan-${randomUUID().slice(0, 12)}`,
    discoveredTargets: targets.length,
    syncedTargets: scans.length,
    failedTargets: results.filter((result) => Boolean(result.error)).length,
    discoveredFiles: scans.reduce((sum, scan) => sum + scan.discovered, 0),
    imported: scans.reduce((sum, scan) => sum + scan.imported, 0),
    skipped: scans.reduce((sum, scan) => sum + scan.skipped, 0),
    failedFiles: scans.reduce((sum, scan) => sum + scan.failed, 0),
    results,
  };
}

function discoverLocalFiles(root: string, extensions: Set<string>, exclude: string[]): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      const parts = relative(root, path).split(/[\\/]/).filter(Boolean);
      if (exclude.some((item) => parts.includes(item) || relative(root, path).includes(item))) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) result.push(path);
    }
  };
  visit(root);
  return result.sort();
}
