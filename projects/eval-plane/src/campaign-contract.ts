import { validateReference } from "./eval-contract.ts";

export const CAMPAIGN_MANIFEST_SCHEMA = "ikb-eval-campaign-v1";
export const CAMPAIGN_OBSERVATION_SCHEMA = "ikb-eval-campaign-observation-v1";
export const CAMPAIGN_REPORT_SCHEMA = "ikb-eval-campaign-report-v1";
export const CAMPAIGN_GRADER_VERSION = "campaign-deterministic-v1";

export type CampaignDecision = "promote" | "reject" | "inconclusive";
export type CampaignL3Status = "pass" | "fail" | "inconclusive";

export interface CampaignDataset {
  kind: "sealed_holdout";
  cohortHash: string;
  caseCount: number;
  trialsPerCase: number;
  strata: Array<{ id: string; caseCount: number }>;
  minReportGroupSize: number;
}

export interface CampaignVariant {
  id: string;
  harnessRef: string;
  configHash: string;
}

export interface CampaignPolicy {
  minPairedCases: number;
  maxCandidateL1Failures: number;
  minL3Improvement: number;
  confidenceLevel: number;
  maxStratumL3Regression: number;
  maxTokenIncreaseRatio: number;
  maxWallTimeIncreaseRatio: number;
  maxManualInterventionIncrease: number;
}

export interface CampaignManifest {
  schema: typeof CAMPAIGN_MANIFEST_SCHEMA;
  campaignId: string;
  campaignVersion: string;
  dataset: CampaignDataset;
  baseline: CampaignVariant;
  candidate: CampaignVariant;
  controlHash: string;
  policy: CampaignPolicy;
}

export interface CampaignObservation {
  schema: typeof CAMPAIGN_OBSERVATION_SCHEMA;
  campaignId: string;
  variantId: string;
  caseHash: string;
  trial: number;
  stratum: string;
  controlHash: string;
  l1Passed: boolean;
  l3Status: CampaignL3Status;
  l2: {
    tokens: number;
    wallTimeMs: number;
    manualInterventions: number;
  };
  resultRef: string;
}

export interface CampaignReport {
  schema: typeof CAMPAIGN_REPORT_SCHEMA;
  campaignId: string;
  campaignVersion: string;
  graderVersion: typeof CAMPAIGN_GRADER_VERSION;
  subjectHash: string;
  evaluationKey: string;
  identity: {
    manifestHash: string;
    cohortHash: string;
    controlHash: string;
    baseline: CampaignVariant;
    candidate: CampaignVariant;
  };
  decision: CampaignDecision;
  reasonCodes: string[];
  comparability: {
    expectedCases: number;
    pairedCases: number;
    expectedAttempts: number;
    pairedAttempts: number;
    unpairedAttempts: number;
    cohortMatched: boolean;
    controlsMatched: boolean;
    strataMatched: boolean;
  };
  l1: {
    baselineFailures: number;
    candidateFailures: number;
  };
  l3: {
    baselinePassRate: number;
    candidatePassRate: number;
    delta: number;
    wins: number;
    losses: number;
    ties: number;
    inconclusiveCases: number;
    oneSidedPValue: number;
    improvementProven: boolean;
    regressedStrata: number;
  };
  l2: {
    baseline: { averageTokens: number; averageWallTimeMs: number; averageManualInterventions: number };
    candidate: { averageTokens: number; averageWallTimeMs: number; averageManualInterventions: number };
    tokenIncreaseRatio: number | null;
    wallTimeIncreaseRatio: number | null;
    manualInterventionIncrease: number;
    withinBudget: boolean;
  };
  leakage: {
    datasetKind: "sealed_holdout";
    perCaseDetailsExposed: false;
    suppressedGroupCount: number;
  };
}

type Row = Record<string, unknown>;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Row;
}

function exactKeys(row: Row, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported fields: ${unsupported.join(",")}`);
}

function stringValue(value: unknown, label: string, pattern = ID_PATTERN): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return Number(value);
}

function finite(value: unknown, label: string, minimum: number, maximum = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function hashValue(value: unknown, label: string): string {
  return stringValue(value, label, HASH_PATTERN);
}

function variant(value: unknown, label: string): CampaignVariant {
  const row = objectValue(value, label);
  exactKeys(row, ["id", "harnessRef", "configHash"], label);
  return {
    id: stringValue(row.id, `${label}.id`),
    harnessRef: validateReference(row.harnessRef, `${label}.harnessRef`),
    configHash: hashValue(row.configHash, `${label}.configHash`),
  };
}

export function validateCampaignManifest(value: unknown): CampaignManifest {
  const row = objectValue(value, "CampaignManifest");
  exactKeys(row, ["schema", "campaignId", "campaignVersion", "dataset", "baseline", "candidate", "controlHash", "policy"], "CampaignManifest");
  if (row.schema !== CAMPAIGN_MANIFEST_SCHEMA) throw new Error(`CampaignManifest.schema must be ${CAMPAIGN_MANIFEST_SCHEMA}`);

  const datasetRow = objectValue(row.dataset, "CampaignManifest.dataset");
  exactKeys(datasetRow, ["kind", "cohortHash", "caseCount", "trialsPerCase", "strata", "minReportGroupSize"], "CampaignManifest.dataset");
  if (datasetRow.kind !== "sealed_holdout") throw new Error("CampaignManifest.dataset.kind must be sealed_holdout");
  const caseCount = integer(datasetRow.caseCount, "CampaignManifest.dataset.caseCount", 1);
  const trialsPerCase = integer(datasetRow.trialsPerCase, "CampaignManifest.dataset.trialsPerCase", 1);
  if (caseCount * trialsPerCase > 10_000) throw new Error("CampaignManifest expected attempts must not exceed 10000");
  if (!Array.isArray(datasetRow.strata) || datasetRow.strata.length === 0) throw new Error("CampaignManifest.dataset.strata must not be empty");
  const strata = datasetRow.strata.map((value, index) => {
    const stratum = objectValue(value, `CampaignManifest.dataset.strata[${index}]`);
    exactKeys(stratum, ["id", "caseCount"], `CampaignManifest.dataset.strata[${index}]`);
    return { id: stringValue(stratum.id, `CampaignManifest.dataset.strata[${index}].id`), caseCount: integer(stratum.caseCount, `CampaignManifest.dataset.strata[${index}].caseCount`, 1) };
  });
  if (new Set(strata.map((item) => item.id)).size !== strata.length) throw new Error("CampaignManifest.dataset.strata ids must be unique");
  if (strata.reduce((sum, item) => sum + item.caseCount, 0) !== caseCount) throw new Error("CampaignManifest.dataset.strata case counts must equal caseCount");

  const policyRow = objectValue(row.policy, "CampaignManifest.policy");
  exactKeys(policyRow, ["minPairedCases", "maxCandidateL1Failures", "minL3Improvement", "confidenceLevel", "maxStratumL3Regression", "maxTokenIncreaseRatio", "maxWallTimeIncreaseRatio", "maxManualInterventionIncrease"], "CampaignManifest.policy");
  const policy: CampaignPolicy = {
    minPairedCases: integer(policyRow.minPairedCases, "CampaignManifest.policy.minPairedCases", 1),
    maxCandidateL1Failures: integer(policyRow.maxCandidateL1Failures, "CampaignManifest.policy.maxCandidateL1Failures", 0),
    minL3Improvement: finite(policyRow.minL3Improvement, "CampaignManifest.policy.minL3Improvement", 0, 1),
    confidenceLevel: finite(policyRow.confidenceLevel, "CampaignManifest.policy.confidenceLevel", 0.5, 0.999),
    maxStratumL3Regression: finite(policyRow.maxStratumL3Regression, "CampaignManifest.policy.maxStratumL3Regression", 0, 1),
    maxTokenIncreaseRatio: finite(policyRow.maxTokenIncreaseRatio, "CampaignManifest.policy.maxTokenIncreaseRatio", 0),
    maxWallTimeIncreaseRatio: finite(policyRow.maxWallTimeIncreaseRatio, "CampaignManifest.policy.maxWallTimeIncreaseRatio", 0),
    maxManualInterventionIncrease: finite(policyRow.maxManualInterventionIncrease, "CampaignManifest.policy.maxManualInterventionIncrease", 0),
  };
  if (policy.minPairedCases > caseCount) throw new Error("CampaignManifest.policy.minPairedCases exceeds caseCount");

  const baseline = variant(row.baseline, "CampaignManifest.baseline");
  const candidate = variant(row.candidate, "CampaignManifest.candidate");
  if (baseline.id === candidate.id) throw new Error("Campaign variants must have different ids");
  if (baseline.configHash === candidate.configHash) throw new Error("Campaign variants must freeze different Harness configurations");

  return {
    schema: CAMPAIGN_MANIFEST_SCHEMA,
    campaignId: stringValue(row.campaignId, "CampaignManifest.campaignId"),
    campaignVersion: stringValue(row.campaignVersion, "CampaignManifest.campaignVersion", VERSION_PATTERN),
    dataset: {
      kind: "sealed_holdout",
      cohortHash: hashValue(datasetRow.cohortHash, "CampaignManifest.dataset.cohortHash"),
      caseCount,
      trialsPerCase,
      strata,
      minReportGroupSize: integer(datasetRow.minReportGroupSize, "CampaignManifest.dataset.minReportGroupSize", 2),
    },
    baseline,
    candidate,
    controlHash: hashValue(row.controlHash, "CampaignManifest.controlHash"),
    policy,
  };
}

export function validateCampaignObservation(value: unknown): CampaignObservation {
  const row = objectValue(value, "CampaignObservation");
  exactKeys(row, ["schema", "campaignId", "variantId", "caseHash", "trial", "stratum", "controlHash", "l1Passed", "l3Status", "l2", "resultRef"], "CampaignObservation");
  if (row.schema !== CAMPAIGN_OBSERVATION_SCHEMA) throw new Error(`CampaignObservation.schema must be ${CAMPAIGN_OBSERVATION_SCHEMA}`);
  if (typeof row.l1Passed !== "boolean") throw new Error("CampaignObservation.l1Passed must be boolean");
  if (!['pass', 'fail', 'inconclusive'].includes(String(row.l3Status))) throw new Error("CampaignObservation.l3Status is unsupported");
  const l2 = objectValue(row.l2, "CampaignObservation.l2");
  exactKeys(l2, ["tokens", "wallTimeMs", "manualInterventions"], "CampaignObservation.l2");
  return {
    schema: CAMPAIGN_OBSERVATION_SCHEMA,
    campaignId: stringValue(row.campaignId, "CampaignObservation.campaignId"),
    variantId: stringValue(row.variantId, "CampaignObservation.variantId"),
    caseHash: hashValue(row.caseHash, "CampaignObservation.caseHash"),
    trial: integer(row.trial, "CampaignObservation.trial", 1),
    stratum: stringValue(row.stratum, "CampaignObservation.stratum"),
    controlHash: hashValue(row.controlHash, "CampaignObservation.controlHash"),
    l1Passed: row.l1Passed,
    l3Status: row.l3Status as CampaignL3Status,
    l2: {
      tokens: finite(l2.tokens, "CampaignObservation.l2.tokens", 0),
      wallTimeMs: finite(l2.wallTimeMs, "CampaignObservation.l2.wallTimeMs", 0),
      manualInterventions: integer(l2.manualInterventions, "CampaignObservation.l2.manualInterventions", 0),
    },
    resultRef: validateReference(row.resultRef, "CampaignObservation.resultRef"),
  };
}
