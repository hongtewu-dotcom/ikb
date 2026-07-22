import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { KnowledgeRecord } from "../types.ts";
import { resolveVault } from "../layout.ts";
import { knowledgeScopes, resolveKnowledgeDirectory } from "./catalog.ts";
import {
  KNOWLEDGE_DIRECTORIES,
  type KnowledgeArchiveResult,
  type KnowledgeDirectory,
  type KnowledgeLayoutInspection,
  type KnowledgeMigrationItem,
  type KnowledgeMigrationResult,
  type KnowledgeQualityIssue,
} from "./contracts.ts";
import { hasStableKnowledgeId, parseKnowledge, setFrontmatterScalar, tryParseKnowledge } from "./codec.ts";
import { inspectKnowledgeQuality } from "./quality.ts";
import { listKnowledge } from "./records.ts";
import {
  ensurePrivateDirectory,
  GOVERNANCE_DIRECTORIES,
  governanceRoot,
  knowledgeMarkdownFiles,
  LEGACY_KNOWLEDGE_DIRECTORY,
  migrationJournalRoot,
} from "./storage.ts";
import { rebuildKnowledgeViews } from "./views.ts";

interface KnowledgeMigrationJournal {
  id: string;
  status: "planned" | "files_moved" | "completed";
  createdAt: string;
  updatedAt: string;
  items: KnowledgeMigrationItem[];
}

/**
 * Move retired notes out of the active Obsidian vault while preserving an
 * append-only manifest and the original note bytes under ikb-data/archives.
 */
export function archiveRetiredKnowledge(home: string, scope?: string): KnowledgeArchiveResult[] {
  return knowledgeScopes(scope).map((currentScope) => {
    const archiveRoot = join(resolve(home), "archives", "knowledge", currentScope);
    const manifestPath = join(archiveRoot, "manifest.jsonl");
    ensurePrivateDirectory(archiveRoot);
    const archived: KnowledgeArchiveResult["archived"] = [];
    const skipped: KnowledgeArchiveResult["skipped"] = [];
    const candidates = listKnowledge(home, currentScope).filter((record) => record.status === "retired");
    for (const record of candidates) {
      const destinationDirectory = join(archiveRoot, record.collection);
      const destination = join(destinationDirectory, basename(record.path));
      ensurePrivateDirectory(destinationDirectory);
      if (existsSync(destination)) {
        skipped.push({ id: record.id, title: record.title, path: record.path, reason: "archive destination already exists" });
        continue;
      }
      renameSync(record.path, destination);
      chmodSync(destination, 0o600);
      const item = { id: record.id, title: record.title, from: record.path, to: destination };
      appendFileSync(manifestPath, `${JSON.stringify({ archivedAt: new Date().toISOString(), ...item })}\n`, { mode: 0o600 });
      chmodSync(manifestPath, 0o600);
      archived.push(item);
    }
    rebuildKnowledgeViews(home, currentScope);
    return { scope: currentScope, archived, skipped, manifestPath };
  });
}

export function migrateLegacyKnowledge(home: string, scope?: string, options: { deferCompletion?: boolean } = {}): KnowledgeMigrationResult {
  const pending = findPendingMigrationJournal(home, scope);
  if (pending) {
    applyMigrationJournal(home, pending.path, pending.journal);
    rebuildMigrationScopes(home, pending.journal.items);
    if (!options.deferCompletion) completeKnowledgeMigration(pending.path);
    return { moved: pending.journal.items, remainingLegacyFiles: legacyKnowledgeFiles(home, scope), journalPath: pending.path, recovered: true };
  }

  const planned: KnowledgeMigrationItem[] = [];
  const plannedDestinations = new Set<string>();
  for (const currentScope of knowledgeScopes(scope)) {
    const vault = resolveVault(home, currentScope);
    const legacyRoot = join(vault, LEGACY_KNOWLEDGE_DIRECTORY);
    for (const sourcePath of knowledgeMarkdownFiles(legacyRoot, true)) {
      const sourceText = readFileSync(sourcePath, "utf8");
      if (!hasStableKnowledgeId(sourceText)) throw new Error(`Legacy knowledge is missing a stable id: ${sourcePath}`);
      const record = parseKnowledge(sourceText, sourcePath);
      if (record.scope !== currentScope) throw new Error(`Legacy knowledge scope does not match its vault (${record.scope} != ${currentScope}): ${sourcePath}`);
      const destinationDirectory = join(vault, resolveKnowledgeDirectory(record.type, record.collection));
      const destinationName = basename(sourcePath).toLowerCase() === "index.md" ? legacyIndexDestinationName(record.id) : basename(sourcePath);
      const destinationPath = resolve(destinationDirectory, destinationName);
      if (dirname(destinationPath) !== resolve(destinationDirectory)) throw new Error(`Knowledge migration destination escapes its collection: ${destinationPath}`);
      if (existsSync(destinationPath)) throw new Error(`Knowledge migration would overwrite an existing file: ${destinationPath}`);
      const destinationKey = destinationPath.toLocaleLowerCase("en-US");
      if (plannedDestinations.has(destinationKey)) throw new Error(`Knowledge migration has multiple legacy files targeting the same path: ${destinationPath}`);
      plannedDestinations.add(destinationKey);
      planned.push({ id: record.id, scope: currentScope, type: record.type, collection: resolveKnowledgeDirectory(record.type, record.collection), from: sourcePath, to: destinationPath });
    }
  }
  if (planned.length === 0) {
    rebuildKnowledgeViews(home, scope);
    return { moved: [], remainingLegacyFiles: legacyKnowledgeFiles(home, scope), journalPath: null, recovered: false };
  }

  const journal: KnowledgeMigrationJournal = {
    id: `migration-${randomUUID().slice(0, 12)}`,
    status: "planned",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: planned,
  };
  const journalPath = join(migrationJournalRoot(home), `${journal.id}.json`);
  writeMigrationJournal(journalPath, journal);
  applyMigrationJournal(home, journalPath, journal);
  rebuildMigrationScopes(home, journal.items);
  if (!options.deferCompletion) completeKnowledgeMigration(journalPath);
  return { moved: planned, remainingLegacyFiles: legacyKnowledgeFiles(home, scope), journalPath, recovered: false };
}

export function completeKnowledgeMigration(journalPath: string): void {
  const journal = readMigrationJournal(journalPath);
  journal.status = "completed";
  journal.updatedAt = new Date().toISOString();
  writeMigrationJournal(journalPath, journal);
}

export function inspectKnowledgeLayout(home: string, scope?: string): KnowledgeLayoutInspection {
  const missingPaths: string[] = [];
  const legacyFiles: string[] = [];
  const misplacedFiles: string[] = [];
  const invalidFiles: string[] = [];
  const scopeMismatchFiles: string[] = [];
  const pendingMigrationJournals = pendingMigrationJournalPaths(home, scope);
  const records: KnowledgeRecord[] = [];
  const qualityIssues: KnowledgeQualityIssue[] = [];
  for (const currentScope of knowledgeScopes(scope)) {
    const vault = resolveVault(home, currentScope);
    const governance = governanceRoot(home, currentScope);
    const expectedPaths = [
      vault,
      join(vault, "index.md"),
      ...KNOWLEDGE_DIRECTORIES.flatMap((directory) => [join(vault, directory), join(vault, directory, "index.md")]),
      governance,
      join(governance, "status.md"),
      ...GOVERNANCE_DIRECTORIES.map((directory) => join(governance, directory)),
    ];
    missingPaths.push(...expectedPaths.filter((path) => !existsSync(path)));
    const legacyCandidateFiles = knowledgeMarkdownFiles(join(vault, LEGACY_KNOWLEDGE_DIRECTORY), true);
    legacyFiles.push(...legacyCandidateFiles);
    const candidateFiles = [...legacyCandidateFiles, ...KNOWLEDGE_DIRECTORIES.flatMap((directory) => knowledgeMarkdownFiles(join(vault, directory)))];
    const candidateRecords = candidateFiles.map((path) => {
      const text = readFileSync(path, "utf8");
      return { path, record: hasStableKnowledgeId(text) ? tryParseKnowledge(text, path) : null };
    });
    invalidFiles.push(...candidateRecords.filter((candidate) => !candidate.record).map((candidate) => candidate.path));
    scopeMismatchFiles.push(...candidateRecords.filter((candidate) => candidate.record && candidate.record.scope !== currentScope).map((candidate) => candidate.path));
    const scopeRecords = listKnowledge(home, currentScope);
    records.push(...scopeRecords);
    for (const record of scopeRecords) {
      qualityIssues.push(...inspectKnowledgeQuality(record));
      const topLevel = relative(vault, record.path).split(/[\\/]/)[0];
      if ((KNOWLEDGE_DIRECTORIES as readonly string[]).includes(topLevel) && topLevel !== resolveKnowledgeDirectory(record.type, record.collection)) {
        misplacedFiles.push(record.path);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  const duplicateIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  return {
    ok: missingPaths.length === 0 && duplicateIds.length === 0 && misplacedFiles.length === 0 && invalidFiles.length === 0 && scopeMismatchFiles.length === 0 && pendingMigrationJournals.length === 0 && qualityIssues.length === 0,
    missingPaths: missingPaths.sort(),
    legacyFiles: legacyFiles.sort(),
    duplicateIds,
    misplacedFiles: misplacedFiles.sort(),
    invalidFiles: invalidFiles.sort(),
    scopeMismatchFiles: scopeMismatchFiles.sort(),
    pendingMigrationJournals,
    qualityIssues: qualityIssues.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)),
  };
}

function legacyKnowledgeFiles(home: string, scope?: string): string[] {
  return knowledgeScopes(scope).flatMap((currentScope) => knowledgeMarkdownFiles(join(resolveVault(home, currentScope), LEGACY_KNOWLEDGE_DIRECTORY), true));
}

function rebuildMigrationScopes(home: string, items: KnowledgeMigrationItem[]): void {
  for (const scope of new Set(items.map((item) => item.scope))) rebuildKnowledgeViews(home, scope);
}

function findPendingMigrationJournal(home: string, scope?: string): { path: string; journal: KnowledgeMigrationJournal } | null {
  const root = migrationJournalRoot(home);
  if (!existsSync(root)) return null;
  for (const path of readdirSync(root).filter((name) => name.endsWith(".json")).sort().map((name) => join(root, name))) {
    const journal = readMigrationJournal(path);
    if (journal.status !== "completed" && (!scope || journal.items.some((item) => item.scope === scope))) return { path, journal };
  }
  return null;
}

function pendingMigrationJournalPaths(home: string, scope?: string): string[] {
  const root = migrationJournalRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
    const path = join(root, name);
    try {
      const journal = readMigrationJournal(path);
      return journal.status !== "completed" && (!scope || journal.items.some((item) => item.scope === scope)) ? [path] : [];
    } catch {
      return [path];
    }
  });
}

function applyMigrationJournal(home: string, path: string, journal: KnowledgeMigrationJournal): void {
  for (const item of journal.items) {
    assertMigrationItemPaths(home, item);
    const sourceExists = existsSync(item.from);
    const destinationExists = existsSync(item.to);
    if (sourceExists && destinationExists) throw new Error(`Knowledge migration has both source and destination files: ${item.from}, ${item.to}`);
    if (!sourceExists && !destinationExists) throw new Error(`Knowledge migration lost both source and destination files: ${item.from}, ${item.to}`);
    if (sourceExists) {
      materializeKnowledgeCollection(item.from, item.collection);
      ensurePrivateDirectory(dirname(item.to));
      renameSync(item.from, item.to);
    } else {
      materializeKnowledgeCollection(item.to, item.collection);
    }
    chmodSync(item.to, 0o600);
  }
  journal.status = "files_moved";
  journal.updatedAt = new Date().toISOString();
  writeMigrationJournal(path, journal);
}

function materializeKnowledgeCollection(path: string, collection: KnowledgeDirectory): void {
  const text = readFileSync(path, "utf8");
  const updated = setFrontmatterScalar(text, "collection", collection);
  if (updated !== text) writeFileSync(path, updated, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function assertMigrationItemPaths(home: string, item: KnowledgeMigrationItem): void {
  const scope = knowledgeScopes(item.scope)[0];
  const collection = resolveKnowledgeDirectory(item.type, item.collection);
  if (collection !== item.collection) throw new Error(`Knowledge migration collection is invalid: ${item.collection}`);
  const vault = resolveVault(home, scope);
  const legacyRoot = resolve(vault, LEGACY_KNOWLEDGE_DIRECTORY);
  const sourcePath = resolve(item.from);
  const destinationDirectory = resolve(vault, collection);
  const destinationPath = resolve(item.to);
  const sourceRelative = relative(legacyRoot, sourcePath);
  if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) throw new Error(`Knowledge migration source escapes the legacy directory: ${sourcePath}`);
  if (dirname(destinationPath) !== destinationDirectory) throw new Error(`Knowledge migration destination escapes its collection: ${destinationPath}`);
}

function readMigrationJournal(path: string): KnowledgeMigrationJournal {
  const value = JSON.parse(readFileSync(path, "utf8")) as KnowledgeMigrationJournal;
  if (!value || !Array.isArray(value.items) || !["planned", "files_moved", "completed"].includes(value.status)) throw new Error(`Invalid knowledge migration journal: ${path}`);
  return value;
}

function writeMigrationJournal(path: string, journal: KnowledgeMigrationJournal): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function legacyIndexDestinationName(id: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return `legacy-${id}.md`;
  return `legacy-index-${createHash("sha256").update(id).digest("hex").slice(0, 16)}.md`;
}
