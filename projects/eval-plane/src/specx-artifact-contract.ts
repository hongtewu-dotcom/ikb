import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const SPECX_ARTIFACT_REF_SCHEMA = "specx-artifact-ref-v1" as const;

export const SPECX_ARTIFACT_KINDS = [
  "cargo-manifest",
  "flight-case-spec",
  "flight-case-result",
  "flight-log-verification",
] as const;

export type SpecxArtifactKind = typeof SPECX_ARTIFACT_KINDS[number];

export const SPECX_ARTIFACT_PRODUCERS: Record<SpecxArtifactKind, string> = {
  "cargo-manifest": "cargo-test-deploy",
  "flight-case-spec": "flight-case-spec",
  "flight-case-result": "flight-case-runner",
  "flight-log-verification": "flight-log-verifier",
};

export interface SpecxArtifactRef {
  schema: typeof SPECX_ARTIFACT_REF_SCHEMA;
  kind: SpecxArtifactKind;
  ref: string;
  sha256: string;
  producer: string;
}

export interface LoadedSpecxArtifact {
  declaration?: SpecxArtifactRef;
  path?: string;
  raw?: Buffer;
  value?: unknown;
  actualSha256?: string;
  issues: string[];
}

type Row = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_REF_PATTERN = /^\.specx\/artifacts\/([a-f0-9]{64})\.json$/;

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Row;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function assertExactKeys(row: Row, keys: readonly string[], label: string): void {
  const unknown = Object.keys(row).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(",")}`);
}

export function sha256Bytes(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function validateSpecxArtifactRef(value: unknown): SpecxArtifactRef {
  const row = objectValue(value, "ArtifactRef");
  assertExactKeys(row, ["schema", "kind", "ref", "sha256", "producer"], "ArtifactRef");
  if (row.schema !== SPECX_ARTIFACT_REF_SCHEMA) throw new Error(`ArtifactRef.schema must be ${SPECX_ARTIFACT_REF_SCHEMA}`);
  if (!SPECX_ARTIFACT_KINDS.includes(row.kind as SpecxArtifactKind)) throw new Error("ArtifactRef.kind is unsupported");
  const kind = row.kind as SpecxArtifactKind;
  const ref = stringValue(row.ref, "ArtifactRef.ref");
  const hash = stringValue(row.sha256, "ArtifactRef.sha256");
  if (!SHA256_PATTERN.test(hash)) throw new Error("ArtifactRef.sha256 must be a lowercase SHA-256");
  const match = ARTIFACT_REF_PATTERN.exec(ref);
  if (!match || match[1] !== hash) throw new Error("ArtifactRef.ref must be .specx/artifacts/<sha256>.json and match sha256");
  const producer = stringValue(row.producer, "ArtifactRef.producer");
  if (producer !== SPECX_ARTIFACT_PRODUCERS[kind]) throw new Error(`ArtifactRef.producer does not match ${kind}`);
  return { schema: SPECX_ARTIFACT_REF_SCHEMA, kind, ref, sha256: hash, producer };
}

function noSymlinkPath(root: string, artifactRef: string): string {
  const rootPath = resolve(root);
  const rootStat = lstatSync(rootPath);
  if (rootStat.isSymbolicLink()) throw new Error("change root must not be a symbolic link");
  if (!rootStat.isDirectory()) throw new Error("change root must be a directory");
  const candidate = resolve(rootPath, artifactRef);
  const rel = relative(rootPath, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("ArtifactRef.ref escapes the Change directory");
  let current = rootPath;
  let targetStat = rootStat;
  for (const component of rel.split("/")) {
    current = join(current, component);
    targetStat = lstatSync(current);
    if (targetStat.isSymbolicLink()) throw new Error(`Artifact path component is a symbolic link: ${component}`);
  }
  if (!targetStat.isFile()) throw new Error("Artifact target must be a regular file");
  return candidate;
}

export function readSpecxArtifact(changeDir: string, value: unknown): LoadedSpecxArtifact {
  let declaration: SpecxArtifactRef;
  try {
    declaration = validateSpecxArtifactRef(value);
  } catch (error) {
    return { issues: [error instanceof Error ? error.message : String(error)] };
  }
  let path: string;
  try {
    path = noSymlinkPath(changeDir, declaration.ref);
  } catch (error) {
    return { declaration, issues: [error instanceof Error ? error.message : String(error)] };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return { declaration, path, issues: [`Artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const actualSha256 = sha256Bytes(raw);
  const issues: string[] = [];
  if (actualSha256 !== declaration.sha256) issues.push("Artifact content hash does not match ArtifactRef.sha256");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    issues.push(`Artifact JSON cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { declaration, path, raw, value: parsed, actualSha256, issues };
}

export function artifactReferenceId(value: unknown): string {
  try {
    return validateSpecxArtifactRef(value).ref;
  } catch {
    return JSON.stringify(value) ?? String(value);
  }
}
