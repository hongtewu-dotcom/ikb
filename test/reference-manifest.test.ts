import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintReferenceManifest, writeReferenceLint } from "../src/reference-manifest.ts";
import { addSourceAliases } from "../src/source-query.ts";
import { importSource } from "../src/source.ts";

test("reference manifest resolves explicit Source links and reports non-blocking gaps", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-reference-manifest-"));
  const evidencePath = join(home, "guide.md");
  writeFileSync(evidencePath, "Use the 接入说明 and keep the missing-reference visible.\n");
  const source = importSource(home, evidencePath, { kind: "document", scope: "work", title: "正式接入说明" }).source;
  addSourceAliases(home, source.id, ["接入说明"]);
  const manifestPath = join(home, "reference-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema: "ikb-reference-manifest.v1",
    scope: "work",
    references: [
      {
        id: "guide-source",
        referrer: { path: evidencePath, marker: "接入说明" },
        target: { kind: "source", reference: "接入说明", expectedId: source.id },
      },
      {
        id: "known-gap",
        referrer: { path: evidencePath, marker: "missing-reference" },
        target: { kind: "knowledge", reference: "尚未整理的知识" },
      },
    ],
  }, null, 2)}\n`);

  const result = lintReferenceManifest(home, manifestPath);
  assert.equal(result.ok, true);
  assert.equal(result.resolved, 1);
  assert.equal(result.warnings, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.entries[0].resolvedTargetId, source.id);
  const paths = writeReferenceLint(home, result);
  assert.equal(existsSync(paths.jsonPath), true);
  assert.equal(existsSync(paths.markdownPath), true);
});

test("blocking unresolved references fail the manifest result", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-reference-blocking-"));
  const referrer = join(home, "AGENTS.md");
  writeFileSync(referrer, "Load must-exist before execution.\n");
  const manifest = join(home, "reference-manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    schema: "ikb-reference-manifest.v1",
    scope: "work",
    references: [{
      id: "must-exist",
      referrer: { path: referrer, marker: "must-exist" },
      target: { kind: "principle", reference: "missing-principle" },
      requireDefaultRetrieval: true,
      blocking: true,
    }],
  }, null, 2)}\n`);
  const result = lintReferenceManifest(home, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.errors, 1);
  assert.equal(result.issues[0].code, "target_unresolved");
});

test("reference manifest rejects malformed boolean controls", () => {
  const home = mkdtempSync(join(tmpdir(), "ikb-reference-invalid-control-"));
  const referrer = join(home, "AGENTS.md");
  writeFileSync(referrer, "Load the registered source.\n");
  const manifest = join(home, "reference-manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    schema: "ikb-reference-manifest.v1",
    scope: "work",
    references: [{
      id: "invalid-control",
      referrer: { path: referrer, marker: "registered source" },
      target: { kind: "source", reference: "source" },
      blocking: "yes",
    }],
  }, null, 2)}\n`);

  assert.throws(() => lintReferenceManifest(home, manifest), /blocking must be boolean/);
});
