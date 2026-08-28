import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EventRecord } from "./types.ts";

export const STORAGE_ROOT_RELOCATED_EVENT = "system.storage_root_relocated";
export const STORAGE_ROOT_AGGREGATE_ID = "storage-root";

export interface StorageRootRelocation {
  fromRoot: string;
  toRoot: string;
}

/**
 * Resolves paths recorded before an IKB project directory moved.  Ledger
 * events stay byte-for-byte historical: consumers receive a derived path.
 */
export class StoragePathResolver {
  private readonly relocations: StorageRootRelocation[];

  constructor(relocations: StorageRootRelocation[]) {
    this.relocations = relocations.map(normalizeRelocation);
    assertAcyclic(this.relocations);
  }

  resolve(path: string): string {
    if (!isAbsolute(path)) return path;
    let current = resolve(path);
    const visited = new Set<string>();
    while (true) {
      const relocation = this.relocations
        .filter((candidate) => isWithinRoot(current, candidate.fromRoot))
        .sort((left, right) => right.fromRoot.length - left.fromRoot.length)[0];
      if (!relocation) return current;
      const key = `${relocation.fromRoot}\u0000${relocation.toRoot}`;
      if (visited.has(key)) throw new Error(`Storage relocation cycle while resolving ${path}`);
      visited.add(key);
      const suffix = relative(relocation.fromRoot, current);
      if (suffix.split(/[\\/]+/).includes("..")) throw new Error(`Storage relocation escapes source root: ${path}`);
      current = resolve(relocation.toRoot, suffix);
      if (visited.size > this.relocations.length) throw new Error(`Storage relocation did not converge for ${path}`);
    }
  }
}

export function storageRootRelocations(events: EventRecord[]): StorageRootRelocation[] {
  const byFromRoot = new Map<string, StorageRootRelocation>();
  for (const event of events) {
    if (event.aggregateType !== "system" || event.eventType !== STORAGE_ROOT_RELOCATED_EVENT) continue;
    const payload = event.payload;
    if (typeof payload.fromRoot !== "string" || typeof payload.toRoot !== "string") continue;
    const relocation = normalizeRelocation({ fromRoot: payload.fromRoot, toRoot: payload.toRoot });
    const existing = byFromRoot.get(relocation.fromRoot);
    if (existing && existing.toRoot !== relocation.toRoot) {
      throw new Error(`Conflicting storage relocation for ${relocation.fromRoot}`);
    }
    byFromRoot.set(relocation.fromRoot, relocation);
  }
  const relocations = [...byFromRoot.values()];
  assertAcyclic(relocations);
  return relocations;
}

export function normalizeRelocation(input: StorageRootRelocation): StorageRootRelocation {
  if (!isAbsolute(input.fromRoot) || !isAbsolute(input.toRoot)) throw new Error("Storage relocation roots must be absolute paths");
  if (hasTraversalSegment(input.fromRoot) || hasTraversalSegment(input.toRoot)) throw new Error("Storage relocation roots must not contain '..'");
  const fromRoot = resolve(input.fromRoot);
  const toRoot = resolve(input.toRoot);
  if (fromRoot === toRoot) throw new Error("Storage relocation source and destination must differ");
  if (isWithinRoot(toRoot, fromRoot)) throw new Error("Storage relocation destination must not be inside its source root");
  return { fromRoot, toRoot };
}

function assertAcyclic(relocations: StorageRootRelocation[]): void {
  const next = new Map(relocations.map((item) => [item.fromRoot, item.toRoot]));
  for (const origin of next.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = origin;
    while (current && next.has(current)) {
      if (visited.has(current)) throw new Error(`Storage relocation cycle at ${current}`);
      visited.add(current);
      current = next.get(current);
    }
  }
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}
