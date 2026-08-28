import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { evaluateCampaign, type CampaignObservation, type CampaignReport } from "./campaign-evaluator.ts";

export const CAMPAIGN_OBSERVATIONS_SCHEMA = "ikb-eval-campaign-observations-v1";
export const CAMPAIGN_ENVELOPE_SCHEMA = "ikb-eval-campaign-envelope-v1";

export interface CampaignEnvelope {
  schema: typeof CAMPAIGN_ENVELOPE_SCHEMA;
  report: CampaignReport;
  persistence: {
    path: string;
    hash: string;
    reused: boolean;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readRegularJson(path: string, label: string): unknown {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function observationsFromDocument(value: unknown): { campaignId: string; observations: CampaignObservation[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Campaign observations document must be an object");
  const row = value as Record<string, unknown>;
  const unsupported = Object.keys(row).filter((key) => !["schema", "campaignId", "observations"].includes(key));
  if (unsupported.length > 0) throw new Error(`Campaign observations document contains unsupported fields: ${unsupported.join(",")}`);
  if (row.schema !== CAMPAIGN_OBSERVATIONS_SCHEMA) throw new Error(`Campaign observations schema must be ${CAMPAIGN_OBSERVATIONS_SCHEMA}`);
  if (typeof row.campaignId !== "string" || !row.campaignId) throw new Error("Campaign observations campaignId is required");
  if (!Array.isArray(row.observations)) throw new Error("Campaign observations must be an array");
  return { campaignId: row.campaignId, observations: row.observations as CampaignObservation[] };
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Campaign report directory is unsafe: ${path}`);
}

function readExistingReport(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Campaign report must be a regular file: ${path}`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function persistCampaignReport(reportRoot: string, report: CampaignReport): CampaignEnvelope["persistence"] {
  if (!isAbsolute(reportRoot)) throw new Error("Campaign report root must be an absolute path");
  ensureDirectory(reportRoot);
  const campaignDirectory = join(reportRoot, report.campaignId);
  ensureDirectory(campaignDirectory);
  const path = join(campaignDirectory, `${report.evaluationKey}.json`);
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const hash = sha256(bytes);
  if (existsSync(path)) {
    if (readExistingReport(path) !== bytes) throw new Error(`Campaign report content mismatch for evaluationKey ${report.evaluationKey}`);
    return { path, hash, reused: true };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    return { path, hash, reused: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (readExistingReport(path) !== bytes) throw new Error(`Campaign report content mismatch for evaluationKey ${report.evaluationKey}`);
      return { path, hash, reused: true };
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function evaluateCampaignFiles(manifestPath: string, observationsPath: string, reportRoot: string): CampaignEnvelope {
  const manifest = readRegularJson(manifestPath, "Campaign manifest");
  const document = observationsFromDocument(readRegularJson(observationsPath, "Campaign observations"));
  const report = evaluateCampaign(manifest, document.observations);
  if (document.campaignId !== report.campaignId) throw new Error(`Campaign observations identity mismatch: expected ${report.campaignId}, got ${document.campaignId}`);
  return {
    schema: CAMPAIGN_ENVELOPE_SCHEMA,
    report,
    persistence: persistCampaignReport(reportRoot, report),
  };
}
