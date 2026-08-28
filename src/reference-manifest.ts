import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { heldKnowledgeIds } from "./knowledge/holds.ts";
import { knowledgeRetrievalEligibilityAtHome } from "./knowledge/eligibility.ts";
import { listKnowledge } from "./knowledge/records.ts";
import { lookupSources } from "./source-query.ts";

export const REFERENCE_MANIFEST_VERSION = "ikb-reference-manifest.v1";

export interface ReferenceManifestEntry {
  id: string;
  referrer: { path: string; marker: string };
  target: { kind: "source" | "knowledge" | "principle"; reference: string; expectedId?: string };
  requireDefaultRetrieval?: boolean;
  blocking?: boolean;
}

export interface ReferenceManifest {
  schema: typeof REFERENCE_MANIFEST_VERSION;
  scope: "personal" | "work";
  references: ReferenceManifestEntry[];
}

export interface ReferenceLintIssue {
  entryId: string;
  code: "referrer_missing" | "referrer_invalid" | "marker_missing" | "target_unresolved" | "target_ambiguous" | "target_mismatch" | "default_retrieval_unreachable";
  severity: "warning" | "error";
  detail: string;
}

export interface ReferenceLintResult {
  schema: "ikb-reference-lint.v1";
  manifestPath: string;
  scope: "personal" | "work";
  checked: number;
  resolved: number;
  warnings: number;
  errors: number;
  ok: boolean;
  entries: Array<{ entryId: string; resolvedTargetId: string | null; issues: ReferenceLintIssue[] }>;
  issues: ReferenceLintIssue[];
}

export function readReferenceManifest(path: string): ReferenceManifest {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Reference manifest not found: ${absolute}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Reference manifest must be a regular file: ${absolute}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Reference manifest is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reference manifest must be an object");
  const manifest = value as ReferenceManifest;
  if (manifest.schema !== REFERENCE_MANIFEST_VERSION || !["personal", "work"].includes(manifest.scope) || !Array.isArray(manifest.references)) {
    throw new Error(`Reference manifest must use ${REFERENCE_MANIFEST_VERSION}`);
  }
  const ids = new Set<string>();
  for (const entry of manifest.references) {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(entry.id)) || ids.has(entry.id)) throw new Error(`Reference manifest entry id is invalid or duplicated: ${String(entry?.id)}`);
    ids.add(entry.id);
    if (!entry.referrer || typeof entry.referrer.path !== "string" || !entry.referrer.path.trim() || typeof entry.referrer.marker !== "string" || !entry.referrer.marker) throw new Error(`Reference manifest ${entry.id} has an invalid referrer`);
    if (!entry.target || !["source", "knowledge", "principle"].includes(entry.target.kind) || typeof entry.target.reference !== "string" || !entry.target.reference.trim()) throw new Error(`Reference manifest ${entry.id} has an invalid target`);
    if (entry.target.expectedId !== undefined && (typeof entry.target.expectedId !== "string" || !entry.target.expectedId.trim())) throw new Error(`Reference manifest ${entry.id} expectedId must be a non-empty string`);
    if (entry.requireDefaultRetrieval !== undefined && typeof entry.requireDefaultRetrieval !== "boolean") throw new Error(`Reference manifest ${entry.id} requireDefaultRetrieval must be boolean`);
    if (entry.blocking !== undefined && typeof entry.blocking !== "boolean") throw new Error(`Reference manifest ${entry.id} blocking must be boolean`);
  }
  return manifest;
}

export function lintReferenceManifest(home: string, manifestPath: string): ReferenceLintResult {
  const absolute = resolve(manifestPath);
  const manifest = readReferenceManifest(absolute);
  const held = heldKnowledgeIds(home);
  const knowledge = listKnowledge(home, manifest.scope);
  const entries = manifest.references.map((entry) => {
    const issues: ReferenceLintIssue[] = [];
    const add = (code: ReferenceLintIssue["code"], detail: string) => issues.push({ entryId: entry.id, code, severity: entry.blocking === true ? "error" : "warning", detail });
    const referrerPath = isAbsolute(entry.referrer.path)
      ? resolve(entry.referrer.path)
      : resolve(dirname(absolute), entry.referrer.path);
    if (!existsSync(referrerPath)) add("referrer_missing", `Referrer not found: ${referrerPath}`);
    else {
      const stat = lstatSync(referrerPath);
      if (stat.isSymbolicLink() || !stat.isFile()) add("referrer_invalid", `Referrer must be a regular file: ${referrerPath}`);
      else if (!readFileSync(referrerPath, "utf8").includes(entry.referrer.marker)) add("marker_missing", `Referrer no longer contains marker: ${entry.referrer.marker}`);
    }

    let matches: Array<{ id: string; defaultEligible: boolean }> = [];
    if (entry.target.kind === "source") {
      matches = lookupSources(home, entry.target.reference, { scope: manifest.scope, includeQuarantined: true, allVersions: true, limit: 100 })
        .map((item) => ({ id: item.source.id, defaultEligible: false }));
    } else {
      const reference = normalize(entry.target.reference);
      matches = knowledge.filter((record) => (entry.target.kind !== "principle" || record.type.toLowerCase() === "principle")
        && [record.id, record.title, record.canonicalKey ?? "", ...record.aliases].some((value) => normalize(value) === reference))
        .map((record) => ({
          id: record.id,
          defaultEligible: record.status === "verified" && !held.has(record.id) && knowledgeRetrievalEligibilityAtHome(home, record).eligible,
        }));
    }
    const expected = entry.target.expectedId;
    const selected = expected ? matches.find((match) => match.id === expected) ?? null : matches.length === 1 ? matches[0] : null;
    if (matches.length === 0) add("target_unresolved", `Target cannot be resolved: ${entry.target.kind}:${entry.target.reference}`);
    else if (!expected && matches.length > 1) add("target_ambiguous", `Target resolves to multiple ids: ${matches.map((match) => match.id).join(", ")}`);
    else if (expected && !selected) add("target_mismatch", `Target does not resolve to expected id ${expected}; got ${matches.map((match) => match.id).join(", ")}`);
    if (selected && entry.requireDefaultRetrieval === true && !selected.defaultEligible) add("default_retrieval_unreachable", `Target ${selected.id} is not reachable through default Knowledge retrieval`);
    return { entryId: entry.id, resolvedTargetId: selected?.id ?? null, issues };
  });
  const issues = entries.flatMap((entry) => entry.issues);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  return {
    schema: "ikb-reference-lint.v1",
    manifestPath: absolute,
    scope: manifest.scope,
    checked: entries.length,
    resolved: entries.filter((entry) => entry.resolvedTargetId !== null).length,
    warnings,
    errors,
    ok: errors === 0,
    entries,
    issues,
  };
}

export function writeReferenceLint(home: string, result: ReferenceLintResult): { jsonPath: string; markdownPath: string } {
  const root = join(resolve(home), "governance", result.scope, "sources");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const jsonPath = join(root, "reference-lint.json");
  const markdownPath = join(root, "reference-lint.md");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const markdown = [
    "# IKB 长期引用闭环检查",
    "",
    `- Manifest: ${result.manifestPath}`,
    `- Checked: ${result.checked}`,
    `- Resolved: ${result.resolved}`,
    `- Warnings: ${result.warnings}`,
    `- Errors: ${result.errors}`,
    "",
    ...result.entries.flatMap((entry) => [
      `## ${entry.entryId}`,
      `- Target: ${entry.resolvedTargetId ?? "unresolved"}`,
      ...(entry.issues.length === 0 ? ["- Result: resolved"] : entry.issues.map((issue) => `- ${issue.severity}: ${issue.code} — ${issue.detail}`)),
      "",
    ]),
  ].join("\n");
  writeFileSync(markdownPath, `${markdown}\n`, { mode: 0o600 });
  return { jsonPath, markdownPath };
}

export function defaultReferenceManifestPath(home: string, scope: "personal" | "work" = "work"): string {
  return join(resolve(home), "governance", scope, "sources", "reference-manifest.json");
}

function normalize(value: string): string { return value.trim().toLocaleLowerCase("zh-CN"); }
