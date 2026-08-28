import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { sha256Bytes, SPECX_ARTIFACT_PRODUCERS, SPECX_ARTIFACT_REF_SCHEMA, type SpecxArtifactKind, type SpecxArtifactRef } from "../src/specx-artifact-contract.ts";
import { canonicalJson, loadSpecxChangeSubject, SPECX_CHANGE_SUBJECT_VERSION, SPECX_CORE_FILES } from "../src/specx-change-subject.ts";

interface Fixture {
  root: string;
  changeDir: string;
  workspace: string;
  head: string;
  cargo: { ref: SpecxArtifactRef; path: string };
  caseSpec: { ref: SpecxArtifactRef; path: string };
  writeEvidence(path?: string): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createArtifact(changeDir: string, kind: SpecxArtifactKind, value: unknown): { ref: SpecxArtifactRef; path: string } {
  const raw = Buffer.from(`${JSON.stringify(value)}\n`);
  const hash = sha256Bytes(raw);
  const ref: SpecxArtifactRef = {
    schema: SPECX_ARTIFACT_REF_SCHEMA,
    kind,
    ref: `.specx/artifacts/${hash}.json`,
    sha256: hash,
    producer: SPECX_ARTIFACT_PRODUCERS[kind],
  };
  const path = join(changeDir, ref.ref);
  writeFileSync(path, raw);
  return { ref, path };
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "specx-subject-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changeDir = join(root, "change-one");
  const workspace = join(root, "workspace");
  mkdirSync(join(changeDir, ".specx", "artifacts"), { recursive: true });
  mkdirSync(workspace);
  git(workspace, ["init"]);
  git(workspace, ["checkout", "-b", "main"]);
  writeFileSync(join(workspace, "tracked.txt"), "initial\n");
  git(workspace, ["add", "tracked.txt"]);
  git(workspace, ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-m", "initial"]);
  const head = git(workspace, ["rev-parse", "HEAD"]);
  const cargo = createArtifact(changeDir, "cargo-manifest", { env: "test" });
  const caseSpec = createArtifact(changeDir, "flight-case-spec", { schemaVersion: 1, caseId: "case-1" });
  writeFileSync(join(changeDir, "analyze.md"), "# Analyze\n");
  writeFileSync(join(changeDir, "clarify.md"), "# Clarify\n");
  writeFileSync(join(changeDir, "design.md"), "# Design\n");
  writeFileSync(join(changeDir, "change-manifest.yaml"), stringifyYaml({ version: 2, change: { name: "manifest-name" } }));
  writeFileSync(join(changeDir, "approvals.yaml"), stringifyYaml({ version: 1, records: [] }));
  const writeEvidence = (path = workspace): void => {
    writeFileSync(join(changeDir, "execution-evidence.yaml"), stringifyYaml({
      version: 1,
      workspaces: [{ service: "service-a", repo: workspace, path, branch: "main", base_commit: head, head_commit: head }],
      deployments: [{ service: "service-a", manifest: cargo.ref }],
      verification: [{ ac: "AC-1", artifacts: [caseSpec.ref] }],
    }));
  };
  writeEvidence();
  return { root, changeDir, workspace, head, cargo, caseSpec, writeEvidence };
}

function issueCodes(value: ReturnType<typeof loadSpecxChangeSubject>): string[] {
  return value.data.loadIssues.map((issue) => issue.code);
}

function fileSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path)] = readFileSync(path).toString("base64");
      else result[relative(root, path)] = `special:${lstatSync(path).mode}`;
    }
  };
  visit(root);
  return result;
}

test("a complete Git Change produces stable subject, artifact and workspace facts", (t) => {
  const value = fixture(t);
  const first = loadSpecxChangeSubject(value.changeDir);
  const second = loadSpecxChangeSubject(value.changeDir);
  assert.equal(first.adapter, "specx");
  assert.equal(first.subjectVersion, SPECX_CHANGE_SUBJECT_VERSION);
  assert.equal(first.data.changeId, "change-one");
  assert.deepEqual(first.data.coreFiles.map((file) => file.name), [...SPECX_CORE_FILES]);
  assert.ok(first.data.coreFiles.every((file) => file.state === "present" && /^[a-f0-9]{64}$/.test(file.sha256 ?? "")));
  assert.equal(first.data.artifactUses.length, 2);
  assert.equal(first.data.workspaces[0].state, "available");
  assert.equal(first.data.workspaces[0].actualHead, value.head);
  assert.equal(first.data.workspaces[0].actualBranch, "main");
  assert.equal(first.data.workspaces[0].baseIsAncestor, true);
  assert.equal(first.data.workspaces[0].dirty, false);
  assert.deepEqual(first.data.loadIssues, []);
  assert.match(first.subjectHash, /^[a-f0-9]{64}$/);
  assert.equal(first.runId, `specx:change-one:${first.subjectHash}`);
  assert.equal(second.subjectHash, first.subjectHash);
  assert.equal(canonicalJson({ z: 1, a: [{ y: 2, x: 1 }, 3] }), '{"a":[{"x":1,"y":2},3],"z":1}');
});

test("core bytes, artifact bytes and Git dirty state each change sourceSnapshotHash", (t) => {
  const value = fixture(t);
  const baseline = loadSpecxChangeSubject(value.changeDir).subjectHash;
  writeFileSync(join(value.changeDir, "analyze.md"), "# Analyze changed\n");
  const coreChanged = loadSpecxChangeSubject(value.changeDir).subjectHash;
  assert.notEqual(coreChanged, baseline);
  writeFileSync(value.cargo.path, '{"env":"tampered"}\n');
  const artifactChanged = loadSpecxChangeSubject(value.changeDir);
  assert.notEqual(artifactChanged.subjectHash, coreChanged);
  assert.ok(issueCodes(artifactChanged).includes("artifact_hash_mismatch"));
  writeFileSync(join(value.workspace, "tracked.txt"), "dirty\n");
  const dirty = loadSpecxChangeSubject(value.changeDir);
  assert.notEqual(dirty.subjectHash, artifactChanged.subjectHash);
  assert.equal(dirty.data.workspaces[0].dirty, true);
});

test("missing core files and bad YAML remain observable without preventing a Subject", (t) => {
  const value = fixture(t);
  rmSync(join(value.changeDir, "clarify.md"));
  writeFileSync(join(value.changeDir, "approvals.yaml"), "broken: [\n");
  const subject = loadSpecxChangeSubject(value.changeDir);
  assert.equal(subject.data.coreFiles.find((file) => file.name === "clarify.md")?.state, "missing");
  assert.match(subject.subjectHash, /^[a-f0-9]{64}$/);
  assert.ok(issueCodes(subject).includes("core_file_missing"));
  assert.ok(issueCodes(subject).includes("yaml_parse_failed"));
  assert.equal(subject.data.approvals, null);
});

test("symlink core files are rejected and included in the source snapshot", (t) => {
  const value = fixture(t);
  const baseline = loadSpecxChangeSubject(value.changeDir).subjectHash;
  const external = join(value.root, "external-analyze.md");
  writeFileSync(external, "# External\n");
  rmSync(join(value.changeDir, "analyze.md"));
  symlinkSync(external, join(value.changeDir, "analyze.md"));
  const subject = loadSpecxChangeSubject(value.changeDir);
  assert.notEqual(subject.subjectHash, baseline);
  assert.equal(subject.data.coreFiles.find((file) => file.name === "analyze.md")?.state, "unreadable");
  assert.ok(issueCodes(subject).includes("core_file_symlink_rejected"));
});

test("relative and symlink workspace paths are recorded without running Git", (t) => {
  const value = fixture(t);
  value.writeEvidence("relative/workspace");
  const relativeSubject = loadSpecxChangeSubject(value.changeDir);
  assert.equal(relativeSubject.data.workspaces[0].state, "unavailable");
  assert.ok(issueCodes(relativeSubject).includes("workspace_path_not_absolute"));

  const linked = join(value.root, "workspace-link");
  symlinkSync(value.workspace, linked);
  value.writeEvidence(linked);
  const linkedSubject = loadSpecxChangeSubject(value.changeDir);
  assert.equal(linkedSubject.data.workspaces[0].state, "unavailable");
  assert.ok(issueCodes(linkedSubject).includes("workspace_path_symlink"));
});

test("loading does not change the Change file list or bytes", (t) => {
  const value = fixture(t);
  const before = fileSnapshot(value.changeDir);
  loadSpecxChangeSubject(value.changeDir);
  assert.deepEqual(fileSnapshot(value.changeDir), before);
});

test("relative or symlink Change roots are fatal parameter errors", (t) => {
  const value = fixture(t);
  assert.throws(() => loadSpecxChangeSubject("relative/change"), /absolute path/);
  const linkedRoot = join(value.root, "change-link");
  symlinkSync(value.changeDir, linkedRoot);
  assert.throws(() => loadSpecxChangeSubject(linkedRoot), /symbolic link/);
});
