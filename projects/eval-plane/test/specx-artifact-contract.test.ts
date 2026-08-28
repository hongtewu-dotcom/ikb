import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import {
  readSpecxArtifact,
  sha256Bytes,
  SPECX_ARTIFACT_REF_SCHEMA,
  type SpecxArtifactRef,
} from "../src/specx-artifact-contract.ts";

function changeDir(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "specx-artifact-"));
  mkdirSync(join(root, ".specx", "artifacts"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function artifact(root: string, raw: Buffer): { ref: SpecxArtifactRef; path: string } {
  const hash = sha256Bytes(raw);
  const ref: SpecxArtifactRef = {
    schema: SPECX_ARTIFACT_REF_SCHEMA,
    kind: "cargo-manifest",
    ref: `.specx/artifacts/${hash}.json`,
    sha256: hash,
    producer: "cargo-test-deploy",
  };
  const path = join(root, ref.ref);
  writeFileSync(path, raw);
  return { ref, path };
}

test("valid content-addressed ArtifactRef loads JSON bytes", (t) => {
  const root = changeDir(t);
  const raw = Buffer.from('{"env":"test"}\n');
  const created = artifact(root, raw);
  const loaded = readSpecxArtifact(root, created.ref);
  assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.actualSha256, created.ref.sha256);
  assert.deepEqual(loaded.value, { env: "test" });
});

test("tampered content is reported instead of accepted", (t) => {
  const root = changeDir(t);
  const created = artifact(root, Buffer.from('{"env":"test"}\n'));
  writeFileSync(created.path, '{"env":"prod"}\n');
  assert.match(readSpecxArtifact(root, created.ref).issues.join("\n"), /content hash/);
});

test("producer mapping and exact keys are enforced", (t) => {
  const root = changeDir(t);
  const created = artifact(root, Buffer.from("{}\n"));
  assert.match(readSpecxArtifact(root, { ...created.ref, producer: "someone-else" }).issues.join("\n"), /producer/);
  assert.match(readSpecxArtifact(root, { ...created.ref, verdict: "PASS" }).issues.join("\n"), /unsupported fields/);
});

test("artifact path and Change root symlinks are rejected", (t) => {
  const root = changeDir(t);
  const raw = Buffer.from("{}\n");
  const hash = sha256Bytes(raw);
  const target = join(root, "target.json");
  writeFileSync(target, raw);
  const linkedPath = join(root, ".specx", "artifacts", `${hash}.json`);
  symlinkSync(target, linkedPath);
  const ref: SpecxArtifactRef = {
    schema: SPECX_ARTIFACT_REF_SCHEMA,
    kind: "cargo-manifest",
    ref: `.specx/artifacts/${hash}.json`,
    sha256: hash,
    producer: "cargo-test-deploy",
  };
  assert.match(readSpecxArtifact(root, ref).issues.join("\n"), /symbolic link/);

  const parent = mkdtempSync(join(tmpdir(), "specx-root-link-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const linkedRoot = join(parent, "change-link");
  symlinkSync(root, linkedRoot);
  assert.match(readSpecxArtifact(linkedRoot, ref).issues.join("\n"), /change root must not be a symbolic link/);
});

test("non-file targets and invalid JSON are observable issues", (t) => {
  const root = changeDir(t);
  const invalid = artifact(root, Buffer.from("not-json\n"));
  assert.match(readSpecxArtifact(root, invalid.ref).issues.join("\n"), /JSON cannot be parsed/);

  const raw = Buffer.from("{}\n");
  const hash = sha256Bytes(raw);
  const ref: SpecxArtifactRef = {
    schema: SPECX_ARTIFACT_REF_SCHEMA,
    kind: "cargo-manifest",
    ref: `.specx/artifacts/${hash}.json`,
    sha256: hash,
    producer: "cargo-test-deploy",
  };
  mkdirSync(join(root, ref.ref));
  assert.match(readSpecxArtifact(root, ref).issues.join("\n"), /regular file/);
});
