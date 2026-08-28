import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseKnowledge } from "./codec.ts";
import { RECEIPT_SCHEMA, type Receipt, type ReceiptOperation } from "../receipt.ts";
import type { KnowledgeRecord } from "../types.ts";
import { resolveLedgerPath } from "../layout.ts";

export interface PrincipleConfirmationIssue {
  code: "principle_confirmation_chain_invalid";
  detail: string;
  candidateId: string | null;
}

interface CandidateSnapshot {
  schema?: unknown;
  id?: unknown;
  status?: unknown;
  contentHash?: unknown;
  changeTypes?: unknown;
  candidateKnowledge?: { type?: unknown };
  decision?: {
    outcome?: unknown;
    candidateContentHash?: unknown;
    reviewedArtifact?: { ref?: unknown; contentHash?: unknown };
  };
  resolution?: { knowledgeIds?: unknown };
  [key: string]: unknown;
}

interface ReceiptLedgerBinding {
  path: string;
  contentHash: string;
}

const receiptLedgerCache = new Map<string, {
  signature: string;
  bindings: Map<string, ReceiptLedgerBinding[]>;
}>();

/**
 * Verify the human-confirmation chain behind an active Principle.
 *
 * A frontmatter flag is not confirmation evidence. The stored card must be the
 * exact draft accepted through the existing Experience Candidate lifecycle,
 * applied to this Knowledge id, with only the lifecycle status changed from
 * draft to verified.
 */
export function inspectPrincipleConfirmation(
  home: string,
  record: KnowledgeRecord,
  phase: "activation" | "retrieval" = "retrieval",
): PrincipleConfirmationIssue | null {
  if (record.type.trim().toLowerCase() !== "principle") return null;

  const refs = record.sourceRefs.flatMap((ref) => {
    const match = /^experience-candidate:(exp-cand-[A-Za-z0-9]+)$/.exec(ref.trim());
    return match ? [match[1]] : [];
  });
  const candidateIds = [...new Set(refs)];
  // Receipt confirmation is the native chain for single-page maintenance.
  // A malformed Candidate reference must never be treated as an invitation to
  // bypass Candidate governance, but no Candidate reference is not malformed.
  if (candidateIds.length === 0) return inspectReceiptConfirmation(home, record);
  if (candidateIds.length !== 1) return issue(`Principle must reference exactly one Experience Candidate; found ${candidateIds.length}`, candidateIds[0] ?? null);
  const candidateId = candidateIds[0];
  const candidatePath = join(resolve(home), "experiences", "candidates", `${candidateId}.json`);
  const candidateRead = readRegularFileWithinHome(home, candidatePath, "Experience Candidate");
  if (typeof candidateRead !== "string") return issue(candidateRead.detail, candidateId);

  let candidate: CandidateSnapshot;
  try {
    candidate = JSON.parse(candidateRead) as CandidateSnapshot;
  } catch (error) {
    return issue(`Experience Candidate is not valid JSON: ${(error as Error).message}`, candidateId);
  }
  if (candidate.schema !== "ikb-knowledge-candidate.v1" || candidate.id !== candidateId) {
    return issue("Experience Candidate identity or schema is invalid", candidateId);
  }
  if (candidateContentHash(candidate) !== candidate.contentHash) {
    return issue("Experience Candidate content hash does not match its semantic payload", candidateId);
  }
  if (candidate.candidateKnowledge?.type !== "principle") {
    return issue("Experience Candidate does not propose a Principle", candidateId);
  }
  if (candidate.status !== "applied" || candidate.decision?.outcome !== "accepted") {
    return issue("Experience Candidate has not been accepted and applied", candidateId);
  }
  if (candidate.decision.candidateContentHash !== candidate.contentHash) {
    return issue("Experience Candidate decision is stale for the current candidate content", candidateId);
  }
  const knowledgeIds = Array.isArray(candidate.resolution?.knowledgeIds)
    ? candidate.resolution!.knowledgeIds!.map(String)
    : [];
  if (!knowledgeIds.includes(record.id)) {
    return issue(`Experience Candidate resolution does not include Knowledge ${record.id}`, candidateId);
  }

  const reviewedRef = String(candidate.decision.reviewedArtifact?.ref ?? "");
  const reviewedHash = String(candidate.decision.reviewedArtifact?.contentHash ?? "");
  const expectedRef = `experiences/reviews/${candidateId}/${reviewedHash}.md`;
  if (!/^[a-f0-9]{64}$/.test(reviewedHash) || reviewedRef !== expectedRef) {
    return issue("Accepted review snapshot reference or hash is invalid", candidateId);
  }
  const reviewedRead = readRegularFileWithinHome(home, resolve(home, reviewedRef), "Accepted Principle draft");
  if (typeof reviewedRead !== "string") return issue(reviewedRead.detail, candidateId);
  if (sha256(reviewedRead) !== reviewedHash) {
    return issue("Accepted Principle draft bytes changed after the decision", candidateId);
  }

  const currentRead = readRegularFileWithinHome(home, record.path, "Principle Knowledge");
  if (typeof currentRead !== "string") return issue(currentRead.detail, candidateId);
  const expected = phase === "activation" ? reviewedRead : activateReviewedDraft(reviewedRead);
  if (expected === null) return issue("Accepted Principle draft does not contain exactly one draft status", candidateId);
  if (currentRead !== expected) {
    const candidateIssue = issue(phase === "activation"
      ? "Principle draft bytes do not match the accepted review snapshot"
      : "Verified Principle differs from the accepted review snapshot beyond its status", candidateId);
    // Candidate identity, schema, hashes and application checks above have
    // already passed.  Only a later confirmed revision can use the receipt
    // chain; every earlier Candidate failure remains fail-closed.
    const receiptIssue = inspectReceiptConfirmation(home, record);
    return receiptIssue === null ? null : candidateIssue;
  }
  return null;
}

function inspectReceiptConfirmation(home: string, record: KnowledgeRecord): PrincipleConfirmationIssue | null {
  const currentRead = readRegularFileWithinHome(home, record.path, "Principle Knowledge");
  if (typeof currentRead !== "string") return issue(currentRead.detail, null);
  const currentHash = sha256(currentRead);
  const receiptDirectory = join(resolve(home), ".system", "receipts");
  const directoryRead = readDirectoryWithinHome(home, receiptDirectory, "Receipt directory");
  if (typeof directoryRead !== "string") return issue(directoryRead.detail, null);

  for (const receiptPath of directoryRead.split("\n").filter(Boolean)) {
    const receiptRead = readRegularFileWithinHome(home, receiptPath, "Confirmation Receipt");
    if (typeof receiptRead !== "string") continue;
    let receipt: Receipt;
    try { receipt = JSON.parse(receiptRead) as Receipt; } catch { continue; }
    if (receipt.schema !== RECEIPT_SCHEMA || !receipt.id || !Array.isArray(receipt.operations)) continue;
    if (!ledgerRecordsReceipt(home, receipt, receiptPath, receiptRead)) continue;
    for (const operation of receipt.operations) {
      if (receiptOperationConfirms(home, record, currentHash, operation)) return null;
    }
  }
  return issue("No valid Receipt-based Principle confirmation chain exists", null);
}

function receiptOperationConfirms(home: string, current: KnowledgeRecord, currentHash: string, operation: ReceiptOperation): boolean {
  if ((operation.action !== "confirm" && operation.action !== "update") || operation.subjectRef !== `knowledge://${current.id}`) return false;
  if (!operation.confirmation?.actor.trim() || Number.isNaN(Date.parse(operation.confirmation.confirmedAt))
    || !/^[a-f0-9]{64}$/.test(operation.confirmation.exactTextHash)) return false;
  if (operation.afterHash !== currentHash) return false;
  const proposalPath = operation.inputRefs.find((ref) => isProposalPath(home, ref));
  if (!proposalPath) return false;
  const proposalRead = readRegularFileWithinHome(home, proposalPath, "Confirmation proposal");
  if (typeof proposalRead !== "string" || sha256(proposalRead) !== operation.confirmation.exactTextHash) return false;
  let proposal: KnowledgeRecord;
  try { proposal = parseKnowledge(proposalRead, resolve(proposalPath)); } catch { return false; }
  return sameConfirmedPrinciple(proposal, current);
}

function isProposalPath(home: string, value: string): boolean {
  if (!isAbsolute(value)) return false;
  const root = resolve(home);
  const absolute = resolve(value);
  return absolute !== root && absolute.startsWith(`${root}${sep}`);
}

function sameConfirmedPrinciple(proposal: KnowledgeRecord, current: KnowledgeRecord): boolean {
  const semantic = (record: KnowledgeRecord) => ({
    id: record.id, title: record.title, type: record.type, collection: record.collection, sourceKind: record.sourceKind,
    scope: record.scope, sensitivity: record.sensitivity, status: record.status, supersededBy: record.supersededBy ?? null,
    sourceRefs: record.sourceRefs, validFrom: record.validFrom, reviewAfter: record.reviewAfter, tags: record.tags, aliases: record.aliases,
    related: record.related, derivedFrom: record.derivedFrom, contradicts: record.contradicts, qualityVersion: record.qualityVersion,
    productType: record.productType ?? "", canonicalKey: record.canonicalKey ?? "", compilationSchema: record.compilationSchema ?? "",
    compilationCaseId: record.compilationCaseId ?? "", compilationProductId: record.compilationProductId ?? "",
    extractionManifestRef: record.extractionManifestRef ?? "", compilationRef: record.compilationRef ?? "", informationLossRef: record.informationLossRef ?? "",
    factRefs: record.factRefs ?? [], questionsAnswered: record.questionsAnswered ?? [], admissionReason: record.admissionReason,
    applicability: record.applicability, boundary: record.boundary, useWhen: record.useWhen ?? "", useInputs: record.useInputs ?? [],
    useOutputs: record.useOutputs ?? [], useSteps: record.useSteps ?? [], useChecks: record.useChecks ?? [], useStopConditions: record.useStopConditions ?? [],
    confidence: record.confidence ?? null, confidenceBasis: record.confidenceBasis ?? [], temporalState: record.temporalState ?? null,
    verification: record.verification ?? null, identityConfidence: record.identityConfidence ?? null, patternConfidence: record.patternConfidence ?? null,
    independentEpisodeCount: record.independentEpisodeCount ?? null, independentSourceCount: record.independentSourceCount ?? null,
    distinctDateCount: record.distinctDateCount ?? null, counterevidenceRefs: record.counterevidenceRefs ?? [],
    counterevidenceSearch: record.counterevidenceSearch ?? "", doNotUseFor: record.doNotUseFor ?? [], body: record.body,
  });
  return JSON.stringify(semantic(proposal)) === JSON.stringify(semantic(current));
}

function ledgerRecordsReceipt(home: string, receipt: Receipt, receiptPath: string, content: string): boolean {
  const bindings = receiptLedgerBindings(home);
  if (bindings === null) return false;
  const contentHash = sha256(content);
  return (bindings.get(receipt.id) ?? []).some((binding) => binding.path === receiptPath && binding.contentHash === contentHash);
}

function receiptLedgerBindings(home: string): Map<string, ReceiptLedgerBinding[]> | null {
  const ledgerPath = resolveLedgerPath(home);
  if (!existsSync(ledgerPath)) return null;
  const stat = lstatSync(ledgerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = receiptLedgerCache.get(ledgerPath);
  if (cached?.signature === signature) return cached.bindings;

  const bindings = new Map<string, ReceiptLedgerBinding[]>();
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { aggregateType?: unknown; aggregateId?: unknown; eventType?: unknown; payload?: Record<string, unknown> };
      if (event.aggregateType !== "receipt" || event.eventType !== "receipt.written" || typeof event.aggregateId !== "string") continue;
      const path = event.payload?.path;
      const contentHash = event.payload?.contentHash;
      if (typeof path !== "string" || typeof contentHash !== "string") continue;
      const current = bindings.get(event.aggregateId) ?? [];
      current.push({ path, contentHash });
      bindings.set(event.aggregateId, current);
    } catch {
      // The ledger verifier reports malformed rows; confirmation remains fail-closed here.
    }
  }
  receiptLedgerCache.set(ledgerPath, { signature, bindings });
  return bindings;
}

function readDirectoryWithinHome(home: string, path: string, label: string): string | PrincipleConfirmationIssue {
  const root = resolve(home);
  const absolute = resolve(path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return issue(`${label} escapes IKB home: ${absolute}`, null);
  if (!existsSync(absolute)) return issue(`${label} not found: ${absolute}`, null);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return issue(`${label} must be a directory: ${absolute}`, null);
  // Avoid a broad recursive walk: receipts are flat and names are generated.
  return readdirSync(absolute).filter((name) => name.endsWith(".json")).map((name) => join(absolute, name)).join("\n");
}

export function assertPrincipleActivationReady(home: string, record: KnowledgeRecord): void {
  const problem = inspectPrincipleConfirmation(home, record, "activation");
  if (problem) throw new Error(`${problem.code}: ${problem.detail}`);
}

function activateReviewedDraft(text: string): string | null {
  const matches = text.match(/^status:\s*draft\s*$/gm) ?? [];
  return matches.length === 1 ? text.replace(/^status:\s*draft\s*$/m, "status: verified") : null;
}

function readRegularFileWithinHome(
  home: string,
  path: string,
  label: string,
): string | PrincipleConfirmationIssue {
  const root = resolve(home);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    return issue(`${label} escapes IKB home: ${absolute}`, null);
  }
  if (!existsSync(absolute)) return issue(`${label} not found: ${absolute}`, null);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) return issue(`${label} must be a regular file: ${absolute}`, null);
  return readFileSync(absolute, "utf8");
}

function candidateContentHash(candidate: CandidateSnapshot): string {
  return sha256(JSON.stringify({
    schema: candidate.schema,
    id: candidate.id,
    scope: candidate.scope,
    title: candidate.title,
    patternKey: candidate.patternKey,
    signalCodes: candidate.signalCodes,
    analysisIds: candidate.analysisIds,
    patternLabel: candidate.patternLabel,
    claimVariants: candidate.claimVariants,
    changeTypes: candidate.changeTypes,
    targetKnowledgeIds: candidate.targetKnowledgeIds,
    experienceIds: candidate.experienceIds,
    sourceIds: candidate.sourceIds,
    sourceRecordRefs: candidate.sourceRecordRefs,
    evidenceEventIds: candidate.evidenceEventIds,
    runIds: candidate.runIds,
    validationRefs: candidate.validationRefs,
    independentRunCount: candidate.independentRunCount,
    independentSourceCount: candidate.independentSourceCount,
    candidateKnowledge: candidate.candidateKnowledge,
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issue(detail: string, candidateId: string | null): PrincipleConfirmationIssue {
  return { code: "principle_confirmation_chain_invalid", detail, candidateId };
}
