import { createHash } from "node:crypto";
import {
  CAMPAIGN_GRADER_VERSION,
  CAMPAIGN_MANIFEST_SCHEMA,
  CAMPAIGN_OBSERVATION_SCHEMA,
  CAMPAIGN_REPORT_SCHEMA,
  type CampaignDecision,
  type CampaignManifest,
  type CampaignObservation,
  type CampaignReport,
  validateCampaignManifest,
  validateCampaignObservation,
} from "./campaign-contract.ts";

export {
  CAMPAIGN_GRADER_VERSION,
  CAMPAIGN_MANIFEST_SCHEMA,
  CAMPAIGN_OBSERVATION_SCHEMA,
  CAMPAIGN_REPORT_SCHEMA,
  type CampaignDecision,
  type CampaignManifest,
  type CampaignObservation,
  type CampaignReport,
  validateCampaignManifest,
  validateCampaignObservation,
} from "./campaign-contract.ts";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

export function computeCampaignCohortHash(caseHashes: string[]): string {
  if (!Array.isArray(caseHashes) || caseHashes.length === 0 || caseHashes.some((value) => typeof value !== "string" || !HASH_PATTERN.test(value))) {
    throw new Error("Campaign cohort requires non-empty SHA-256 case hashes");
  }
  const unique = [...new Set(caseHashes)].sort();
  if (unique.length !== caseHashes.length) throw new Error("Campaign cohort case hashes must be unique");
  return sha256(canonical({ schema: "ikb-eval-campaign-cohort-v1", caseHashes: unique }));
}

function oneSidedBinomialPValue(wins: number, losses: number): number {
  const total = wins + losses;
  if (total === 0 || wins <= losses) return 1;
  const logs: number[] = [];
  for (let successes = wins; successes <= total; successes += 1) {
    let logCombination = 0;
    const smaller = Math.min(successes, total - successes);
    for (let index = 1; index <= smaller; index += 1) logCombination += Math.log(total - smaller + index) - Math.log(index);
    logs.push(logCombination - total * Math.log(2));
  }
  const maximum = Math.max(...logs);
  const probability = Math.exp(maximum) * logs.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
  return rounded(Math.min(1, probability));
}

function increaseRatio(baseline: number, candidate: number): number | null {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return rounded((candidate - baseline) / baseline);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
}

interface Pair {
  baseline: CampaignObservation;
  candidate: CampaignObservation;
}

interface CaseSummary {
  stratum: string;
  baselinePassRate: number;
  candidatePassRate: number;
  inconclusive: boolean;
}

export function evaluateCampaign(manifestValue: unknown, observationValues: unknown[]): CampaignReport {
  const manifest = validateCampaignManifest(manifestValue);
  if (!Array.isArray(observationValues)) throw new Error("Campaign observations must be an array");
  const observations = observationValues.map(validateCampaignObservation).sort((left, right) =>
    left.caseHash.localeCompare(right.caseHash)
      || left.trial - right.trial
      || left.variantId.localeCompare(right.variantId));

  const allowedVariants = new Set([manifest.baseline.id, manifest.candidate.id]);
  const observationByVariantAttempt = new Map<string, CampaignObservation>();
  const attemptMap = new Map<string, Partial<Record<"baseline" | "candidate", CampaignObservation>>>();
  const caseStrata = new Map<string, string>();
  let controlsMatched = true;
  let strataMatched = true;

  for (const observation of observations) {
    if (observation.campaignId !== manifest.campaignId) throw new Error(`CampaignObservation campaign mismatch: ${observation.campaignId}`);
    if (!allowedVariants.has(observation.variantId)) throw new Error(`CampaignObservation variant is not frozen by manifest: ${observation.variantId}`);
    if (observation.trial > manifest.dataset.trialsPerCase) throw new Error(`CampaignObservation trial exceeds frozen trialsPerCase: ${observation.trial}`);
    const uniqueKey = `${observation.variantId}:${observation.caseHash}:${observation.trial}`;
    if (observationByVariantAttempt.has(uniqueKey)) throw new Error(`Duplicate CampaignObservation: ${uniqueKey}`);
    observationByVariantAttempt.set(uniqueKey, observation);
    if (observation.controlHash !== manifest.controlHash) controlsMatched = false;
    if (!manifest.dataset.strata.some((item) => item.id === observation.stratum)) strataMatched = false;
    const existingStratum = caseStrata.get(observation.caseHash);
    if (existingStratum && existingStratum !== observation.stratum) strataMatched = false;
    else caseStrata.set(observation.caseHash, observation.stratum);

    const attemptKey = `${observation.caseHash}:${observation.trial}`;
    const pair = attemptMap.get(attemptKey) ?? {};
    if (observation.variantId === manifest.baseline.id) pair.baseline = observation;
    else pair.candidate = observation;
    attemptMap.set(attemptKey, pair);
  }

  const caseHashes = [...new Set(observations.map((item) => item.caseHash))];
  const cohortMatched = caseHashes.length === manifest.dataset.caseCount
    && computeCampaignCohortHash(caseHashes) === manifest.dataset.cohortHash;
  const actualStrataCounts = new Map<string, number>();
  for (const caseHash of caseHashes) {
    const stratum = caseStrata.get(caseHash);
    if (stratum) actualStrataCounts.set(stratum, (actualStrataCounts.get(stratum) ?? 0) + 1);
  }
  for (const expected of manifest.dataset.strata) {
    if ((actualStrataCounts.get(expected.id) ?? 0) !== expected.caseCount) strataMatched = false;
  }

  const pairs: Pair[] = [];
  for (const pair of attemptMap.values()) {
    if (pair.baseline && pair.candidate) {
      if (pair.baseline.stratum !== pair.candidate.stratum) strataMatched = false;
      pairs.push({ baseline: pair.baseline, candidate: pair.candidate });
    }
  }
  pairs.sort((left, right) => left.baseline.caseHash.localeCompare(right.baseline.caseHash) || left.baseline.trial - right.baseline.trial);
  const pairsByCase = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const grouped = pairsByCase.get(pair.baseline.caseHash) ?? [];
    grouped.push(pair);
    pairsByCase.set(pair.baseline.caseHash, grouped);
  }
  const caseSummaries: CaseSummary[] = [];
  for (const grouped of pairsByCase.values()) {
    if (grouped.length !== manifest.dataset.trialsPerCase) continue;
    caseSummaries.push({
      stratum: grouped[0].baseline.stratum,
      baselinePassRate: grouped.filter((pair) => pair.baseline.l3Status === "pass").length / grouped.length,
      candidatePassRate: grouped.filter((pair) => pair.candidate.l3Status === "pass").length / grouped.length,
      inconclusive: grouped.some((pair) => pair.baseline.l3Status === "inconclusive" || pair.candidate.l3Status === "inconclusive"),
    });
  }
  const expectedCases = manifest.dataset.caseCount;
  const pairedCases = caseSummaries.length;
  const expectedAttempts = manifest.dataset.caseCount * manifest.dataset.trialsPerCase;
  const pairedAttempts = pairs.length;
  const unpairedAttempts = Math.max(0, expectedAttempts - pairedAttempts);

  const baselineFailures = pairs.filter((pair) => !pair.baseline.l1Passed).length;
  const candidateFailures = pairs.filter((pair) => !pair.candidate.l1Passed).length;
  const inconclusiveCases = caseSummaries.filter((item) => item.inconclusive).length;
  const conclusiveCases = caseSummaries.filter((item) => !item.inconclusive);
  const wins = conclusiveCases.filter((item) => item.candidatePassRate > item.baselinePassRate).length;
  const losses = conclusiveCases.filter((item) => item.candidatePassRate < item.baselinePassRate).length;
  const ties = conclusiveCases.filter((item) => item.candidatePassRate === item.baselinePassRate).length;
  const baselinePassRate = average(caseSummaries.map((item) => item.baselinePassRate));
  const candidatePassRate = average(caseSummaries.map((item) => item.candidatePassRate));
  const delta = rounded(candidatePassRate - baselinePassRate);
  const oneSidedPValue = oneSidedBinomialPValue(wins, losses);
  const improvementProven = inconclusiveCases === 0
    && delta >= manifest.policy.minL3Improvement
    && wins > losses
    && oneSidedPValue <= 1 - manifest.policy.confidenceLevel;

  let regressedStrata = 0;
  for (const stratum of manifest.dataset.strata) {
    const stratumCases = caseSummaries.filter((item) => item.stratum === stratum.id);
    if (stratumCases.length === 0 || stratumCases.some((item) => item.inconclusive)) continue;
    const baselineRate = average(stratumCases.map((item) => item.baselinePassRate));
    const candidateRate = average(stratumCases.map((item) => item.candidatePassRate));
    if (candidateRate - baselineRate < -manifest.policy.maxStratumL3Regression) regressedStrata += 1;
  }

  const baselineTokens = average(pairs.map((pair) => pair.baseline.l2.tokens));
  const candidateTokens = average(pairs.map((pair) => pair.candidate.l2.tokens));
  const baselineWallTime = average(pairs.map((pair) => pair.baseline.l2.wallTimeMs));
  const candidateWallTime = average(pairs.map((pair) => pair.candidate.l2.wallTimeMs));
  const baselineManual = average(pairs.map((pair) => pair.baseline.l2.manualInterventions));
  const candidateManual = average(pairs.map((pair) => pair.candidate.l2.manualInterventions));
  const tokenIncreaseRatio = increaseRatio(baselineTokens, candidateTokens);
  const wallTimeIncreaseRatio = increaseRatio(baselineWallTime, candidateWallTime);
  const manualInterventionIncrease = rounded(candidateManual - baselineManual);
  const withinBudget = tokenIncreaseRatio !== null
    && wallTimeIncreaseRatio !== null
    && tokenIncreaseRatio <= manifest.policy.maxTokenIncreaseRatio
    && wallTimeIncreaseRatio <= manifest.policy.maxWallTimeIncreaseRatio
    && manualInterventionIncrease <= manifest.policy.maxManualInterventionIncrease;

  const reasonCodes: string[] = [];
  let decision: CampaignDecision;
  if (!cohortMatched || !controlsMatched || !strataMatched || pairedAttempts !== expectedAttempts || pairedCases !== expectedCases || pairedCases < manifest.policy.minPairedCases) {
    if (!cohortMatched) reasonCodes.push("cohort_hash_mismatch");
    if (!controlsMatched) reasonCodes.push("control_hash_mismatch");
    if (!strataMatched) reasonCodes.push("holdout_strata_mismatch");
    if (pairedAttempts !== expectedAttempts) reasonCodes.push("paired_attempts_incomplete");
    if (pairedCases !== expectedCases) reasonCodes.push("paired_cases_incomplete");
    if (pairedCases < manifest.policy.minPairedCases) reasonCodes.push("minimum_paired_cases_not_met");
    decision = "inconclusive";
  } else if (candidateFailures > manifest.policy.maxCandidateL1Failures) {
    reasonCodes.push("candidate_l1_gate_failed");
    decision = "reject";
  } else if (inconclusiveCases > 0) {
    reasonCodes.push("l3_observation_inconclusive");
    decision = "inconclusive";
  } else if (regressedStrata > 0) {
    reasonCodes.push("holdout_stratum_regressed");
    decision = "reject";
  } else if (delta < 0) {
    reasonCodes.push("candidate_l3_regressed");
    decision = "reject";
  } else if (!improvementProven) {
    reasonCodes.push("l3_improvement_not_proven");
    decision = "inconclusive";
  } else if (!withinBudget) {
    reasonCodes.push("l2_budget_exceeded");
    decision = "reject";
  } else {
    reasonCodes.push("candidate_proven_better");
    decision = "promote";
  }

  const manifestHash = sha256(canonical(manifest));
  const subjectHash = sha256(canonical({ manifest, observations }));
  const evaluationKey = sha256(canonical({ campaignId: manifest.campaignId, campaignVersion: manifest.campaignVersion, graderVersion: CAMPAIGN_GRADER_VERSION, subjectHash }));
  return {
    schema: CAMPAIGN_REPORT_SCHEMA,
    campaignId: manifest.campaignId,
    campaignVersion: manifest.campaignVersion,
    graderVersion: CAMPAIGN_GRADER_VERSION,
    subjectHash,
    evaluationKey,
    identity: {
      manifestHash,
      cohortHash: manifest.dataset.cohortHash,
      controlHash: manifest.controlHash,
      baseline: manifest.baseline,
      candidate: manifest.candidate,
    },
    decision,
    reasonCodes,
    comparability: { expectedCases, pairedCases, expectedAttempts, pairedAttempts, unpairedAttempts, cohortMatched, controlsMatched, strataMatched },
    l1: { baselineFailures, candidateFailures },
    l3: { baselinePassRate, candidatePassRate, delta, wins, losses, ties, inconclusiveCases, oneSidedPValue, improvementProven, regressedStrata },
    l2: {
      baseline: { averageTokens: baselineTokens, averageWallTimeMs: baselineWallTime, averageManualInterventions: baselineManual },
      candidate: { averageTokens: candidateTokens, averageWallTimeMs: candidateWallTime, averageManualInterventions: candidateManual },
      tokenIncreaseRatio,
      wallTimeIncreaseRatio,
      manualInterventionIncrease,
      withinBudget,
    },
    leakage: {
      datasetKind: "sealed_holdout",
      perCaseDetailsExposed: false,
      suppressedGroupCount: manifest.dataset.strata.filter((item) => item.caseCount < manifest.dataset.minReportGroupSize).length,
    },
  };
}
