import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CAMPAIGN_MANIFEST_SCHEMA,
  CAMPAIGN_OBSERVATION_SCHEMA,
  computeCampaignCohortHash,
} from "../src/campaign-evaluator.ts";
import { CAMPAIGN_OBSERVATIONS_SCHEMA, evaluateCampaignFiles } from "../src/campaign-cli.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function writeCampaignInput(root: string): { manifestPath: string; observationsPath: string; caseHashes: string[] } {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`real-task-${index}`));
  const campaignId = "agent-teams-real-task-r1";
  const controlHash = hash("model-repo-tools-budget");
  const manifest = {
    schema: CAMPAIGN_MANIFEST_SCHEMA,
    campaignId,
    campaignVersion: "v1",
    dataset: {
      kind: "sealed_holdout",
      cohortHash: computeCampaignCohortHash(caseHashes),
      caseCount: caseHashes.length,
      trialsPerCase: 1,
      strata: [{ id: "coding", caseCount: caseHashes.length }],
      minReportGroupSize: 5,
    },
    baseline: { id: "baseline", harnessRef: "artifact://harness/agent-teams-v1", configHash: hash("baseline") },
    candidate: { id: "candidate", harnessRef: "artifact://harness/agent-teams-v2", configHash: hash("candidate") },
    controlHash,
    policy: {
      minPairedCases: caseHashes.length,
      maxCandidateL1Failures: 0,
      minL3Improvement: 0.1,
      confidenceLevel: 0.95,
      maxStratumL3Regression: 0,
      maxTokenIncreaseRatio: 0.2,
      maxWallTimeIncreaseRatio: 0.2,
      maxManualInterventionIncrease: 0,
    },
  };
  const observations = caseHashes.flatMap((caseHash) => ["baseline", "candidate"].map((variantId) => ({
    schema: CAMPAIGN_OBSERVATION_SCHEMA,
    campaignId,
    variantId,
    caseHash,
    trial: 1,
    stratum: "coding",
    controlHash,
    l1Passed: true,
    l3Status: variantId === "baseline" ? "fail" : "pass",
    l2: { tokens: variantId === "baseline" ? 100 : 110, wallTimeMs: variantId === "baseline" ? 1_000 : 1_100, manualInterventions: 0 },
    resultRef: `artifact://campaign-run/${variantId}-${caseHash.slice(0, 12)}`,
  })));
  const manifestPath = join(root, "manifest.json");
  const observationsPath = join(root, "observations.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(observationsPath, `${JSON.stringify({ schema: CAMPAIGN_OBSERVATIONS_SCHEMA, campaignId, observations }, null, 2)}\n`);
  return { manifestPath, observationsPath, caseHashes };
}

test("persists one content-addressed aggregate report and reuses identical evaluation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-campaign-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = writeCampaignInput(root);
  const reportRoot = join(root, "reports");

  const first = evaluateCampaignFiles(input.manifestPath, input.observationsPath, reportRoot);
  const second = evaluateCampaignFiles(input.manifestPath, input.observationsPath, reportRoot);

  assert.equal(first.report.decision, "promote");
  assert.equal(first.persistence.reused, false);
  assert.equal(second.persistence.reused, true);
  assert.equal(first.persistence.path, second.persistence.path);
  assert.equal(existsSync(first.persistence.path), true);
  for (const caseHash of input.caseHashes) assert.equal(JSON.stringify(first).includes(caseHash), false);
});

test("ikb harness campaign is the final CLI consumer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-campaign-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = writeCampaignInput(root);
  const home = join(root, "ikb-home");
  const ikbRoot = resolve(import.meta.dirname, "../../..");
  const result = spawnSync(join(ikbRoot, "bin/ikb"), [
    "harness", "campaign",
    "--manifest", input.manifestPath,
    "--observations", input.observationsPath,
    "--home", home,
    "--json",
  ], { cwd: ikbRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.report.decision, "promote");
  assert.equal(envelope.report.leakage.perCaseDetailsExposed, false);
  assert.equal(existsSync(envelope.persistence.path), true);
});

test("refuses to reuse a content-addressed report after tampering", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-campaign-tamper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = writeCampaignInput(root);
  const reportRoot = join(root, "reports");
  const first = evaluateCampaignFiles(input.manifestPath, input.observationsPath, reportRoot);
  writeFileSync(first.persistence.path, "{}\n");

  assert.throws(
    () => evaluateCampaignFiles(input.manifestPath, input.observationsPath, reportRoot),
    /content mismatch/,
  );
});

test("rejects symlinked Campaign inputs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ikb-campaign-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = writeCampaignInput(root);
  const linkedManifest = join(root, "linked-manifest.json");
  symlinkSync(input.manifestPath, linkedManifest);

  assert.throws(() => evaluateCampaignFiles(linkedManifest, input.observationsPath, join(root, "reports")));
});
