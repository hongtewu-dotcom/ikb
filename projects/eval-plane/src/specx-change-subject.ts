import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readSpecxArtifact, sha256Bytes, type LoadedSpecxArtifact } from "./specx-artifact-contract.ts";

export const SPECX_CHANGE_SUBJECT_VERSION = "specx-change-subject.v1" as const;
export const SPECX_CORE_FILES = [
  "analyze.md",
  "clarify.md",
  "design.md",
  "change-manifest.yaml",
  "approvals.yaml",
  "execution-evidence.yaml",
] as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SpecxCoreFileName = typeof SPECX_CORE_FILES[number];
export type SpecxCoreFileState = "present" | "missing" | "unreadable";

export interface SpecxLoadIssue {
  scope: string;
  code: string;
}

export interface SpecxCoreFileFact {
  name: SpecxCoreFileName;
  state: SpecxCoreFileState;
  sha256?: string;
}

export type SpecxArtifactOrigin =
  | { type: "deployment"; service: string; index: number }
  | { type: "verification"; ac: string; index: number };

export interface SpecxArtifactUse {
  origin: SpecxArtifactOrigin;
  declared: unknown;
  read: LoadedSpecxArtifact;
}

export interface SpecxWorkspaceDeclaration {
  service: string;
  repo: string;
  path: string;
  branch: string;
  base_commit: string;
  head_commit: string;
}

export interface SpecxWorkspaceFact {
  index: number;
  declaration: SpecxWorkspaceDeclaration;
  state: "available" | "unavailable";
  actualHead: string | null;
  actualTree: string | null;
  actualBranch: string | null;
  baseIsAncestor: boolean | null;
  statusSha256: string | null;
  dirty: boolean | null;
}

interface ArtifactSnapshotFact {
  origin: SpecxArtifactOrigin;
  declaration: { kind: string; ref: string; sha256: string; producer: string } | { invalidDeclarationSha256: string };
  state: "available" | "unavailable";
  actualSha256: string | null;
}

interface WorkspaceSnapshotFact extends SpecxWorkspaceFact {}

export interface SpecxSourceSnapshotInput {
  changeId: string;
  coreFiles: Array<{ name: SpecxCoreFileName; state: SpecxCoreFileState; sha256?: string }>;
  artifactUses: ArtifactSnapshotFact[];
  workspaces: WorkspaceSnapshotFact[];
  loadIssues: SpecxLoadIssue[];
}

export interface SpecxChangeSubjectData {
  changeId: string;
  coreFiles: SpecxCoreFileFact[];
  manifest: unknown;
  approvals: unknown;
  evidence: unknown;
  artifactUses: SpecxArtifactUse[];
  workspaces: SpecxWorkspaceFact[];
  loadIssues: SpecxLoadIssue[];
}

export interface SpecxChangeSubject {
  adapter: "specx";
  subjectVersion: typeof SPECX_CHANGE_SUBJECT_VERSION;
  runId: string;
  subjectHash: string;
  data: SpecxChangeSubjectData;
}

type Row = Record<string, unknown>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: JsonValue): string {
  const active = new Set<object>();
  const encode = (item: JsonValue): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("canonicalJson only accepts finite JSON numbers");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new Error("canonicalJson only accepts JSON values");
    if (active.has(item)) throw new Error("canonicalJson does not accept cyclic values");
    active.add(item);
    try {
      if (Array.isArray(item)) return `[${item.map((entry) => encode(entry)).join(",")}]`;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("canonicalJson only accepts plain JSON objects");
      return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
    } finally {
      active.delete(item);
    }
  };
  return encode(value);
}

export function computeSpecxSourceSnapshotHash(snapshotInput: SpecxSourceSnapshotInput): string {
  return sha256Bytes(Buffer.from(canonicalJson(snapshotInput as unknown as JsonValue), "utf8"));
}

function rowValue(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function normalizedString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function pushIssue(issues: SpecxLoadIssue[], scope: string, code: string): void {
  issues.push({ scope, code });
}

function stableIssues(issues: SpecxLoadIssue[]): SpecxLoadIssue[] {
  return [...issues].sort((left, right) => compareText(`${left.scope}\0${left.code}`, `${right.scope}\0${right.code}`));
}

function readCoreFiles(changeDir: string, issues: SpecxLoadIssue[]): { facts: SpecxCoreFileFact[]; raw: Map<SpecxCoreFileName, Buffer> } {
  const raw = new Map<SpecxCoreFileName, Buffer>();
  const facts = SPECX_CORE_FILES.map((name): SpecxCoreFileFact => {
    const path = join(changeDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        pushIssue(issues, `core:${name}`, "core_file_symlink_rejected");
        return { name, state: "unreadable" };
      }
      if (!stat.isFile()) {
        pushIssue(issues, `core:${name}`, "core_file_not_regular");
        return { name, state: "unreadable" };
      }
      const bytes = readFileSync(path);
      raw.set(name, bytes);
      return { name, state: "present", sha256: sha256Bytes(bytes) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const state: SpecxCoreFileState = code === "ENOENT" ? "missing" : "unreadable";
      pushIssue(issues, `core:${name}`, state === "missing" ? "core_file_missing" : "core_file_unreadable");
      return { name, state };
    }
  });
  return { facts, raw };
}

function parseYamlCore(name: "change-manifest.yaml" | "approvals.yaml" | "execution-evidence.yaml", raw: Map<SpecxCoreFileName, Buffer>, issues: SpecxLoadIssue[]): unknown {
  const bytes = raw.get(name);
  if (!bytes) return null;
  try {
    return parseYaml(bytes.toString("utf8"));
  } catch {
    pushIssue(issues, `yaml:${name}`, "yaml_parse_failed");
    return null;
  }
}

function artifactIssueCode(message: string): string {
  if (/content hash/i.test(message)) return "artifact_hash_mismatch";
  if (/JSON cannot be parsed/i.test(message)) return "artifact_json_invalid";
  if (/symbolic link/i.test(message)) return "artifact_symlink_rejected";
  if (/regular file/i.test(message)) return "artifact_not_regular_file";
  if (/cannot be read|ENOENT/i.test(message)) return "artifact_unreadable";
  return "artifact_ref_invalid";
}

function originKey(origin: SpecxArtifactOrigin): string {
  return canonicalJson(origin as unknown as JsonValue);
}

function addArtifactUse(changeDir: string, origin: SpecxArtifactOrigin, declared: unknown, uses: SpecxArtifactUse[], issues: SpecxLoadIssue[]): void {
  const loaded = readSpecxArtifact(changeDir, declared);
  const scope = `artifact:${originKey(origin)}`;
  for (const message of loaded.issues) pushIssue(issues, scope, artifactIssueCode(message));
  uses.push({ origin, declared, read: loaded });
}

function extractArtifactUses(changeDir: string, evidence: unknown, issues: SpecxLoadIssue[]): SpecxArtifactUse[] {
  const uses: SpecxArtifactUse[] = [];
  const row = rowValue(evidence);
  if (!row) {
    if (evidence !== null) pushIssue(issues, "evidence", "evidence_not_object");
    return uses;
  }
  if (!Array.isArray(row.deployments)) {
    pushIssue(issues, "evidence:deployments", "deployments_not_array");
  } else {
    row.deployments.forEach((value, index) => {
      const deployment = rowValue(value);
      const service = normalizedString(deployment?.service);
      if (!deployment) pushIssue(issues, `deployment:${index}`, "deployment_not_object");
      addArtifactUse(changeDir, { type: "deployment", service, index }, deployment?.manifest ?? null, uses, issues);
    });
  }
  if (!Array.isArray(row.verification)) {
    pushIssue(issues, "evidence:verification", "verification_not_array");
  } else {
    row.verification.forEach((value, verificationIndex) => {
      const verification = rowValue(value);
      const ac = normalizedString(verification?.ac);
      if (!verification) pushIssue(issues, `verification:${verificationIndex}`, "verification_not_object");
      const artifacts = verification?.artifacts;
      if (!Array.isArray(artifacts) || artifacts.length === 0) {
        pushIssue(issues, `verification:${ac || verificationIndex}`, "verification_artifacts_missing");
        return;
      }
      artifacts.forEach((declared, index) => addArtifactUse(changeDir, { type: "verification", ac, index }, declared, uses, issues));
    });
  }
  return uses;
}

function gitBytes(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function gitBaseIsAncestor(cwd: string, baseCommit: string, actualHead: string): boolean | null {
  if (!baseCommit || !actualHead) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseCommit, actualHead], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    return (error as { status?: number }).status === 1 ? false : null;
  }
}

function workspaceDeclaration(value: unknown): SpecxWorkspaceDeclaration {
  const row = rowValue(value);
  return {
    service: normalizedString(row?.service),
    repo: normalizedString(row?.repo),
    path: normalizedString(row?.path),
    branch: normalizedString(row?.branch),
    base_commit: normalizedString(row?.base_commit),
    head_commit: normalizedString(row?.head_commit),
  };
}

function inspectWorkspace(value: unknown, index: number, issues: SpecxLoadIssue[]): SpecxWorkspaceFact {
  const declaration = workspaceDeclaration(value);
  const scope = `workspace:${index}:${declaration.service}`;
  const unavailable = (): SpecxWorkspaceFact => ({ index, declaration, state: "unavailable", actualHead: null, actualTree: null, actualBranch: null, baseIsAncestor: null, statusSha256: null, dirty: null });
  if (!rowValue(value)) {
    pushIssue(issues, scope, "workspace_not_object");
    return unavailable();
  }
  if (!isAbsolute(declaration.path)) {
    pushIssue(issues, scope, "workspace_path_not_absolute");
    return unavailable();
  }
  try {
    const stat = lstatSync(declaration.path);
    if (stat.isSymbolicLink()) {
      pushIssue(issues, scope, "workspace_path_symlink");
      return unavailable();
    }
    if (!stat.isDirectory()) {
      pushIssue(issues, scope, "workspace_path_not_directory");
      return unavailable();
    }
  } catch {
    pushIssue(issues, scope, "workspace_path_unavailable");
    return unavailable();
  }
  const head = gitBytes(declaration.path, ["rev-parse", "HEAD"]);
  const tree = gitBytes(declaration.path, ["rev-parse", "HEAD^{tree}"]);
  const branch = gitBytes(declaration.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = gitBytes(declaration.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const actualHead = head ? head.toString("utf8").trim() : "";
  const baseIsAncestor = gitBaseIsAncestor(declaration.path, declaration.base_commit, actualHead);
  if (!head) pushIssue(issues, scope, "git_head_unavailable");
  if (!tree) pushIssue(issues, scope, "git_tree_unavailable");
  if (!branch) pushIssue(issues, scope, "git_branch_unavailable");
  if (!status) pushIssue(issues, scope, "git_status_unavailable");
  if (baseIsAncestor === null) pushIssue(issues, scope, "git_base_ancestry_unavailable");
  return {
    index,
    declaration,
    state: head && tree && branch && status && baseIsAncestor !== null ? "available" : "unavailable",
    actualHead: actualHead || null,
    actualTree: tree ? tree.toString("utf8").trim() : null,
    actualBranch: branch ? branch.toString("utf8").trim() : null,
    baseIsAncestor,
    statusSha256: status ? sha256Bytes(status) : null,
    dirty: status ? status.length > 0 : null,
  };
}

function extractWorkspaces(evidence: unknown, issues: SpecxLoadIssue[]): SpecxWorkspaceFact[] {
  const row = rowValue(evidence);
  if (!row) return [];
  if (!Array.isArray(row.workspaces)) {
    pushIssue(issues, "evidence:workspaces", "workspaces_not_array");
    return [];
  }
  return row.workspaces.map((value, index) => inspectWorkspace(value, index, issues));
}

function declarationIdentity(use: SpecxArtifactUse, issues: SpecxLoadIssue[]): ArtifactSnapshotFact["declaration"] {
  const declaration = use.read.declaration;
  if (declaration) return { kind: declaration.kind, ref: declaration.ref, sha256: declaration.sha256, producer: declaration.producer };
  try {
    return { invalidDeclarationSha256: sha256Bytes(Buffer.from(canonicalJson(use.declared as JsonValue), "utf8")) };
  } catch {
    pushIssue(issues, `artifact:${originKey(use.origin)}`, "artifact_declaration_not_json");
    return { invalidDeclarationSha256: sha256Bytes(Buffer.from(canonicalJson({ invalid: "non-json" }), "utf8")) };
  }
}

function snapshotInput(changeId: string, coreFiles: SpecxCoreFileFact[], artifactUses: SpecxArtifactUse[], workspaces: SpecxWorkspaceFact[], issues: SpecxLoadIssue[]): SpecxSourceSnapshotInput {
  const artifactFacts = artifactUses.map((use): ArtifactSnapshotFact => ({
    origin: use.origin,
    declaration: declarationIdentity(use, issues),
    state: use.read.raw !== undefined ? "available" : "unavailable",
    actualSha256: use.read.actualSha256 ?? null,
  })).sort((left, right) => compareText(originKey(left.origin), originKey(right.origin)));
  const workspaceFacts = [...workspaces].sort((left, right) => compareText(
    `${left.declaration.service}\0${left.declaration.path}\0${String(left.index).padStart(12, "0")}`,
    `${right.declaration.service}\0${right.declaration.path}\0${String(right.index).padStart(12, "0")}`,
  ));
  return {
    changeId,
    coreFiles: coreFiles.map(({ name, state, sha256 }) => sha256 ? { name, state, sha256 } : { name, state }),
    artifactUses: artifactFacts,
    workspaces: workspaceFacts,
    loadIssues: stableIssues(issues),
  };
}

export function loadSpecxChangeSubject(changeDir: string): SpecxChangeSubject {
  if (!isAbsolute(changeDir)) throw new Error("changeDir must be an absolute path");
  const root = resolve(changeDir);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error("changeDir must not be a symbolic link");
  if (!rootStat.isDirectory()) throw new Error("changeDir must be a directory");

  const changeId = basename(root);
  const issues: SpecxLoadIssue[] = [];
  const core = readCoreFiles(root, issues);
  const manifest = parseYamlCore("change-manifest.yaml", core.raw, issues);
  const approvals = parseYamlCore("approvals.yaml", core.raw, issues);
  const evidence = parseYamlCore("execution-evidence.yaml", core.raw, issues);
  const artifactUses = extractArtifactUses(root, evidence, issues);
  const workspaces = extractWorkspaces(evidence, issues);
  const input = snapshotInput(changeId, core.facts, artifactUses, workspaces, issues);
  const sourceSnapshotHash = computeSpecxSourceSnapshotHash(input);
  const loadIssues = stableIssues(issues);
  return {
    adapter: "specx",
    subjectVersion: SPECX_CHANGE_SUBJECT_VERSION,
    runId: `specx:${changeId}:${sourceSnapshotHash}`,
    subjectHash: sourceSnapshotHash,
    data: { changeId, coreFiles: core.facts, manifest, approvals, evidence, artifactUses, workspaces, loadIssues },
  };
}
