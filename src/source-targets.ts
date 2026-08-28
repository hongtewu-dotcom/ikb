import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceKind } from "./types.ts";

export interface SourceTargetLocator {
  gid?: string;
  uid?: string;
  mis?: string;
  path?: string;
}

export interface SourceTarget {
  id: string;
  adapter: string;
  kind: string;
  scope: "personal" | "work";
  name?: string;
  enabled: boolean;
  schedule?: string;
  status?: string;
  sourceKind?: SourceKind;
  sensitivity?: string;
  extensions?: string[];
  exclude?: string[];
  incrementalIdentity?: string;
  locator?: SourceTargetLocator;
}

export interface SourceTargetRegistry {
  schema: "ikb-source-target-registry.v1";
  updatedAt: string;
  policies?: Record<string, unknown>;
  targets: SourceTarget[];
}

export function sourceTargetRegistryPath(home: string): string {
  return join(resolve(home), "entities", "source-targets.json");
}

export function initializeSourceTargets(home: string): SourceTargetRegistry {
  const resolvedHome = resolve(home);
  const defaults = defaultSourceTargets(resolvedHome);
  for (const target of defaults.filter((item) => item.kind === "local_directory")) {
    mkdirSync(resolveTargetPath(target.locator!.path!), { recursive: true, mode: 0o700 });
    chmodSync(resolveTargetPath(target.locator!.path!), 0o700);
  }
  const path = sourceTargetRegistryPath(resolvedHome);
  mkdirSync(join(resolvedHome, "entities"), { recursive: true, mode: 0o700 });
  const current = readSourceTargetRegistry(resolvedHome);
  const currentById = new Map(current.targets.map((target) => [target.id, target] as const));
  const defaultIds = new Set(defaults.map((target) => target.id));
  const targets = [
    ...defaults.map((target) => mergeDefaultTarget(target, currentById.get(target.id))),
    ...current.targets.filter((target) => !defaultIds.has(target.id)),
  ];
  const registry: SourceTargetRegistry = {
    schema: "ikb-source-target-registry.v1",
    updatedAt: new Date().toISOString(),
    ...(current.policies ? { policies: current.policies } : {}),
    targets,
  };
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return registry;
}

export function readSourceTargetRegistry(home: string): SourceTargetRegistry {
  const path = sourceTargetRegistryPath(home);
  if (!existsSync(path)) return { schema: "ikb-source-target-registry.v1", updatedAt: "", targets: [] };
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Source target registry must be a regular file: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SourceTargetRegistry>;
  if (value.schema !== "ikb-source-target-registry.v1" || !Array.isArray(value.targets)) throw new Error(`Invalid source target registry: ${path}`);
  const ids = new Set<string>();
  const targets = value.targets.map((target, index) => validateTarget(target, index, ids));
  return { schema: value.schema, updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "", ...(value.policies && typeof value.policies === "object" ? { policies: value.policies } : {}), targets };
}

export function listSourceTargets(home: string, scope?: string): SourceTarget[] {
  const targets = readSourceTargetRegistry(home).targets;
  return scope === "personal" || scope === "work" ? targets.filter((target) => target.scope === scope) : targets;
}

export function resolveTargetPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function defaultSourceTargets(home: string): SourceTarget[] {
  return [
    {
      id: "important-documents",
      adapter: "local-document",
      kind: "local_directory",
      sourceKind: "document",
      scope: "work",
      name: "工作重要文档与草稿收件箱",
      locator: { path: join(home, "inbox", "work", "documents") },
      extensions: ["md", "txt", "jsonl", "ndjson"],
      exclude: ["archive", "processed", "tmp"],
      enabled: true,
      incrementalIdentity: "absolutePath+contentHash",
      schedule: "daily_on_change",
      status: "active",
    },
    {
      id: "important-review-comments",
      adapter: "local-review-comment",
      kind: "local_directory",
      sourceKind: "review_comment",
      scope: "work",
      name: "工作评审与评论收件箱",
      locator: { path: join(home, "inbox", "work", "review-comments") },
      extensions: ["md", "txt", "jsonl", "ndjson"],
      exclude: ["archive", "processed", "tmp"],
      enabled: true,
      incrementalIdentity: "absolutePath+contentHash",
      schedule: "daily_on_change",
      status: "active",
    },
    {
      id: "personal-documents",
      adapter: "local-personal-document",
      kind: "local_directory",
      sourceKind: "document",
      scope: "personal",
      name: "个人重要文档与草稿收件箱",
      locator: { path: join(home, "inbox", "personal", "documents") },
      extensions: ["md", "txt", "jsonl", "ndjson"],
      exclude: ["archive", "processed", "tmp"],
      enabled: true,
      incrementalIdentity: "absolutePath+contentHash",
      schedule: "daily_on_change",
      status: "active",
    },
    {
      id: "personal-review-comments",
      adapter: "local-personal-review-comment",
      kind: "local_directory",
      sourceKind: "review_comment",
      scope: "personal",
      name: "个人评审与评论收件箱",
      locator: { path: join(home, "inbox", "personal", "review-comments") },
      extensions: ["md", "txt", "jsonl", "ndjson"],
      exclude: ["archive", "processed", "tmp"],
      enabled: true,
      incrementalIdentity: "absolutePath+contentHash",
      schedule: "daily_on_change",
      status: "active",
    },
  ];
}

function mergeDefaultTarget(defaultTarget: SourceTarget, current: SourceTarget | undefined): SourceTarget {
  if (!current) return defaultTarget;
  const migratedStatus = current.status === "needs_explicit_path_registry" ? defaultTarget.status : current.status;
  return {
    ...defaultTarget,
    ...current,
    kind: defaultTarget.kind,
    sourceKind: current.sourceKind ?? defaultTarget.sourceKind,
    locator: current.locator?.path ? current.locator : defaultTarget.locator,
    extensions: current.extensions?.length ? current.extensions : defaultTarget.extensions,
    exclude: current.exclude ?? defaultTarget.exclude,
    ...(migratedStatus ? { status: migratedStatus } : {}),
  };
}

function validateTarget(value: unknown, index: number, ids: Set<string>): SourceTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid source target at index ${index}`);
  const target = value as Partial<SourceTarget>;
  if (!target.id || typeof target.id !== "string") throw new Error(`Source target ${index} needs id`);
  if (ids.has(target.id)) throw new Error(`Duplicate source target id: ${target.id}`);
  ids.add(target.id);
  if (!target.adapter || typeof target.adapter !== "string") throw new Error(`Source target ${target.id} needs adapter`);
  if (!target.kind || typeof target.kind !== "string") throw new Error(`Source target ${target.id} needs kind`);
  if (target.scope !== "personal" && target.scope !== "work") throw new Error(`Source target ${target.id} has invalid scope`);
  if (typeof target.enabled !== "boolean") throw new Error(`Source target ${target.id} needs enabled`);
  if (target.kind === "local_directory" && (!target.locator?.path || !target.sourceKind)) throw new Error(`Local source target ${target.id} needs locator.path and sourceKind`);
  return target as SourceTarget;
}
