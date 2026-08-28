import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { stringify as stringifyYaml } from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(projectRoot, "src", "specx-eval-cli.ts");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function incompleteChange(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "specx-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changeDir = join(root, "incomplete-change");
  const workspace = join(root, "workspace");
  mkdirSync(join(changeDir, ".specx", "artifacts"), { recursive: true });
  mkdirSync(workspace);
  git(workspace, ["init"]);
  git(workspace, ["checkout", "-b", "main"]);
  writeFileSync(join(workspace, "tracked.txt"), "initial\n");
  git(workspace, ["add", "tracked.txt"]);
  git(workspace, ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-m", "initial"]);
  const head = git(workspace, ["rev-parse", "HEAD"]);
  writeFileSync(join(changeDir, "analyze.md"), "# Analyze\n");
  writeFileSync(join(changeDir, "clarify.md"), "# Clarify\n");
  writeFileSync(join(changeDir, "design.md"), "# Design\n");
  writeFileSync(join(changeDir, "change-manifest.yaml"), stringifyYaml({
    version: 2,
    change: { name: "incomplete-change" },
    entry_inventory: [{ id: "E-1", service: "svc", kind: "thrift", symbol: "S.m", disposition: "change" }],
    acceptance_criteria: [{ id: "AC-1", prd_refs: ["p"], entries: ["E-1"] }],
    tasks: [{ id: "T-1", service: "svc", entries: ["E-1"] }],
  }));
  writeFileSync(join(changeDir, "approvals.yaml"), stringifyYaml({ version: 1, records: [] }));
  writeFileSync(join(changeDir, "execution-evidence.yaml"), stringifyYaml({
    version: 1,
    workspaces: [{ service: "svc", repo: workspace, path: workspace, branch: "main", base_commit: head, head_commit: head }],
    implementations: [],
    reviews: [],
    deployments: [],
    verification: [],
  }));
  return changeDir;
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return result;
}

function run(changeDir: string) {
  return spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", cli, "--change-dir", changeDir], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("pure CLI emits one inconclusive envelope without changing the Change", (t) => {
  const changeDir = incompleteChange(t);
  const before = snapshot(changeDir);
  const result = run(changeDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schema, "specx-eval-envelope-v1");
  assert.equal(envelope.changeId, "incomplete-change");
  assert.equal(envelope.subjectVersion, "specx-change-subject.v1");
  assert.equal(envelope.suiteId, "specx-change-quality");
  assert.equal(envelope.suiteVersion, "v1");
  assert.equal(envelope.graderVersion, "deterministic-v1");
  assert.equal(envelope.hardGatePassed, false);
  assert.equal(envelope.verdict, "inconclusive");
  assert.equal(envelope.results.length, 3);
  assert.match(envelope.sourceSnapshotHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot(changeDir), before);
});

test("CLI rejects relative, missing and extra arguments with exit 2", () => {
  for (const args of [[], ["--change-dir", "relative"], ["--change-dir", "/tmp", "extra"]]) {
    const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--experimental-strip-types", cli, ...args], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr.trim(), "");
  }
});
