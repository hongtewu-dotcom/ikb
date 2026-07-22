import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { KnowledgeRecord } from "../types.ts";

export const LEGACY_KNOWLEDGE_DIRECTORY = "entries";
export const GOVERNANCE_DIRECTORIES = ["gaps", "conflicts", "reviews"] as const;

export function governanceRoot(home: string, scope: string): string {
  return join(resolve(home), "governance", scope);
}

export function migrationJournalRoot(home: string): string {
  return join(resolve(home), "governance", "migrations");
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function knowledgeMarkdownFiles(root: string, includeIndex = false): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return walk(root)
    .filter((path) => extname(path).toLowerCase() === ".md" && (includeIndex || basename(path).toLowerCase() !== "index.md"))
    .sort();
}

export function compareKnowledge(left: KnowledgeRecord, right: KnowledgeRecord): number {
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

export function writeGeneratedFile(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function walk(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
