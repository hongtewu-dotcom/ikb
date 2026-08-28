import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CAMPAIGN_MANIFEST_SCHEMA,
  CAMPAIGN_OBSERVATION_SCHEMA,
  computeCampaignCohortHash,
  evaluateCampaign,
  type CampaignManifest,
  type CampaignObservation,
} from "../src/campaign-evaluator.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const controlHash = hash("same-model-repo-tools-budget");

function manifest(
  caseHashes: string[],
  strata: Array<{ id: string; caseCount: number }> = [{ id: "default", caseCount: caseHashes.length }],
  options: { trialsPerCase?: number; confidenceLevel?: number } = {},
): CampaignManifest {
  return {
    schema: CAMPAIGN_MANIFEST_SCHEMA,
    campaignId: "agent-teams-holdout-r1",
    campaignVersion: "v1",
    dataset: {
      kind: "sealed_holdout",
      cohortHash: computeCampaignCohortHash(caseHashes),
      caseCount: caseHashes.length,
      trialsPerCase: options.trialsPerCase ?? 1,
      strata,
      minReportGroupSize: 5,
    },
    baseline: { id: "baseline", harnessRef: "artifact://harness/agent-teams-v1", configHash: hash("baseline") },
    candidate: { id: "candidate", harnessRef: "artifact://harness/agent-teams-v2", configHash: hash("candidate") },
    controlHash,
    policy: {
      minPairedCases: caseHashes.length,
      maxCandidateL1Failures: 0,
      minL3Improvement: 0.1,
      confidenceLevel: options.confidenceLevel ?? 0.95,
      maxStratumL3Regression: 0,
      maxTokenIncreaseRatio: 0.2,
      maxWallTimeIncreaseRatio: 0.2,
      maxManualInterventionIncrease: 0,
    },
  };
}

function observation(
  campaignId: string,
  variantId: "baseline" | "candidate",
  caseHash: string,
  stratum: string,
  l3Status: "pass" | "fail" | "inconclusive",
  overrides: Partial<CampaignObservation> = {},
): CampaignObservation {
  return {
    schema: CAMPAIGN_OBSERVATION_SCHEMA,
    campaignId,
    variantId,
    caseHash,
    trial: 1,
    stratum,
    controlHash,
    l1Passed: true,
    l3Status,
    l2: { tokens: variantId === "baseline" ? 100 : 110, wallTimeMs: variantId === "baseline" ? 1_000 : 1_100, manualInterventions: 0 },
    resultRef: `artifact://campaign-run/${variantId}-${caseHash.slice(0, 12)}`,
    ...overrides,
  };
}

test("promotes only from a complete comparable sealed holdout and exposes aggregates only", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass"),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.decision, "promote");
  assert.equal(report.comparability.pairedAttempts, 20);
  assert.equal(report.l1.candidateFailures, 0);
  assert.equal(report.l3.delta, 1);
  assert.equal(report.l3.improvementProven, true);
  assert.equal(report.l2.withinBudget, true);
  assert.equal(report.identity.baseline.configHash, campaign.baseline.configHash);
  assert.equal(report.identity.candidate.configHash, campaign.candidate.configHash);
  assert.equal(report.leakage.perCaseDetailsExposed, false);
  for (const caseHash of caseHashes) assert.equal(JSON.stringify(report).includes(caseHash), false);
});

test("rejects a candidate with an L1 failure even when L3 improves", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash, index) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass", index === 0 ? { l1Passed: false } : {}),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.decision, "reject");
  assert.equal(report.reasonCodes.includes("candidate_l1_gate_failed"), true);
});

test("returns inconclusive when any expected pair is missing", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash, index) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    ...(index === 0 ? [] : [observation(campaign.campaignId, "candidate", caseHash, "default", "pass")]),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.decision, "inconclusive");
  assert.equal(report.reasonCodes.includes("paired_attempts_incomplete"), true);
});

test("does not call lower cost an improvement when L3 quality is unchanged", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "pass"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass", { l2: { tokens: 10, wallTimeMs: 100, manualInterventions: 0 } }),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.decision, "inconclusive");
  assert.equal(report.reasonCodes.includes("l3_improvement_not_proven"), true);
});

test("rejects an overall winner that regresses a holdout stratum", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes, [{ id: "core", caseCount: 15 }, { id: "edge", caseCount: 5 }]);
  const observations = caseHashes.flatMap((caseHash, index) => {
    const stratum = index < 15 ? "core" : "edge";
    return index < 15
      ? [observation(campaign.campaignId, "baseline", caseHash, stratum, "fail"), observation(campaign.campaignId, "candidate", caseHash, stratum, "pass")]
      : [observation(campaign.campaignId, "baseline", caseHash, stratum, "pass"), observation(campaign.campaignId, "candidate", caseHash, stratum, "fail")];
  });

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.l3.improvementProven, true);
  assert.equal(report.decision, "reject");
  assert.equal(report.reasonCodes.includes("holdout_stratum_regressed"), true);
  assert.equal(report.l3.regressedStrata, 1);
});

test("is deterministic regardless of observation order", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass"),
  ]);

  assert.deepEqual(evaluateCampaign(campaign, observations), evaluateCampaign(campaign, [...observations].reverse()));
});

test("uses tasks rather than repeated trials as the statistical unit", () => {
  const caseHashes = Array.from({ length: 5 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes, [{ id: "default", caseCount: 5 }], { trialsPerCase: 10, confidenceLevel: 0.99 });
  const observations = caseHashes.flatMap((caseHash) => Array.from({ length: 10 }, (_, index) => index + 1).flatMap((trial) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail", { trial, resultRef: `artifact://campaign-run/baseline-${caseHash.slice(0, 8)}-${trial}` }),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass", { trial, resultRef: `artifact://campaign-run/candidate-${caseHash.slice(0, 8)}-${trial}` }),
  ]));

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.comparability.pairedCases, 5);
  assert.equal(report.comparability.pairedAttempts, 50);
  assert.equal(report.l3.wins, 5);
  assert.equal(report.l3.oneSidedPValue, 0.03125);
  assert.equal(report.decision, "inconclusive");
  assert.equal(report.reasonCodes.includes("l3_improvement_not_proven"), true);
});

test("returns inconclusive when runtime controls differ between variants", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash, index) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass", index === 0 ? { controlHash: hash("different-model") } : {}),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.decision, "inconclusive");
  assert.equal(report.reasonCodes.includes("control_hash_mismatch"), true);
});

test("rejects proven L3 improvement when the frozen L2 budget is exceeded", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = manifest(caseHashes);
  const observations = caseHashes.flatMap((caseHash) => [
    observation(campaign.campaignId, "baseline", caseHash, "default", "fail"),
    observation(campaign.campaignId, "candidate", caseHash, "default", "pass", { l2: { tokens: 200, wallTimeMs: 2_000, manualInterventions: 0 } }),
  ]);

  const report = evaluateCampaign(campaign, observations);

  assert.equal(report.l3.improvementProven, true);
  assert.equal(report.decision, "reject");
  assert.equal(report.reasonCodes.includes("l2_budget_exceeded"), true);
});

test("rejects prompt or other undeclared fields at the Campaign contract boundary", () => {
  const caseHashes = Array.from({ length: 20 }, (_, index) => hash(`case-${index}`));
  const campaign = { ...manifest(caseHashes), prompt: "leaked holdout answer" };

  assert.throws(() => evaluateCampaign(campaign, []), /unsupported fields: prompt/);
});
