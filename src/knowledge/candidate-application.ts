import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { findExperienceCandidate, markExperienceCandidateApplied } from "../experience.ts";
import type { LedgerStore } from "../store.ts";
import type { KnowledgeRecord } from "../types.ts";
import { parseKnowledge } from "./codec.ts";
import { assertKnowledgeQuality, isSourceDerived } from "./quality.ts";
import { installReviewedKnowledge } from "./repository.ts";
import { applyKnowledgeCandidateRevision, type KnowledgeRevisionResult } from "./revision.ts";

export interface NewKnowledgeCandidateApplicationResult {
  mode: "create";
  candidateId: string;
  knowledgeIds: string[];
  records: KnowledgeRecord[];
  reviewedArtifactRef: string;
  reviewedArtifactHash: string;
  recovered: boolean;
}

export type KnowledgeCandidateApplicationResult =
  | NewKnowledgeCandidateApplicationResult
  | ({ mode: "revision" } & KnowledgeRevisionResult);

export function applyKnowledgeCandidate(
  home: string,
  store: LedgerStore,
  candidateId: string,
  input: { replacementPath?: string; primaryKnowledgeId?: string } = {},
): KnowledgeCandidateApplicationResult {
  const candidate = findExperienceCandidate(home, candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found: ${candidateId}`);
  if (candidate.changeTypes.includes("new")) {
    return applyAcceptedNewKnowledgeCandidate(home, store, candidateId, input);
  }
  return { mode: "revision", ...applyKnowledgeCandidateRevision(home, store, candidateId, input) };
}

export function applyAcceptedNewKnowledgeCandidate(
  home: string,
  store: LedgerStore,
  candidateId: string,
  input: { replacementPath?: string; primaryKnowledgeId?: string } = {},
): NewKnowledgeCandidateApplicationResult {
  const candidate = findExperienceCandidate(home, candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found: ${candidateId}`);
  if (candidate.changeTypes.length !== 1 || candidate.changeTypes[0] !== "new" || candidate.targetKnowledgeIds.length > 0) {
    throw new Error(`Experience Candidate ${candidateId} is not an unambiguous new-Knowledge Candidate`);
  }
  if (input.primaryKnowledgeId) throw new Error("A new Knowledge Candidate does not accept --primary");
  if (candidate.status !== "accepted" && candidate.status !== "applied") {
    throw new Error(`Experience Candidate ${candidateId} must be accepted before it can create Knowledge`);
  }
  if (!candidate.decision || candidate.decision.outcome !== "accepted" || candidate.decision.candidateContentHash !== candidate.contentHash) {
    throw new Error(`Experience Candidate ${candidateId} does not have a current accepted decision`);
  }
  const reviewedArtifact = candidate.decision.reviewedArtifact;
  if (!reviewedArtifact) {
    throw new Error(`Experience Candidate ${candidateId} was not accepted against a complete reviewed Knowledge draft`);
  }
  const expectedRef = `experiences/reviews/${candidate.id}/${reviewedArtifact.contentHash}.md`;
  if (reviewedArtifact.ref !== expectedRef) {
    throw new Error(`Experience Candidate ${candidateId} reviewed artifact is not an immutable decision snapshot`);
  }
  if (!input.replacementPath) throw new Error("A new Knowledge Candidate requires --file with the complete reviewed Knowledge draft");

  const reviewedPath = resolveSafeRef(home, reviewedArtifact.ref);
  const reviewedText = readRegularFile(reviewedPath, "Reviewed new Knowledge draft");
  if (sha256(reviewedText) !== reviewedArtifact.contentHash) {
    throw new Error(`Reviewed new Knowledge draft changed after acceptance: ${reviewedArtifact.ref}`);
  }
  const replacementPath = resolve(input.replacementPath);
  const replacementText = readRegularFile(replacementPath, "New Knowledge draft");
  if (replacementText !== reviewedText) {
    throw new Error("New Knowledge draft bytes do not match the file accepted by the user");
  }

  const parsed = parseKnowledge(replacementText, replacementPath);
  if (parsed.scope !== candidate.scope) {
    throw new Error(`New Knowledge scope ${parsed.scope} does not match Candidate scope ${candidate.scope}`);
  }
  if (parsed.status !== "draft") throw new Error("Accepted new Knowledge must enter the Vault as draft");
  if (parsed.type !== candidate.candidateKnowledge.type || parsed.collection !== candidate.candidateKnowledge.collection) {
    throw new Error("New Knowledge type or collection does not match the accepted Candidate");
  }
  const candidateRef = `experience-candidate:${candidate.id}`;
  if (!parsed.sourceRefs.includes(candidateRef)) {
    throw new Error(`New Knowledge source_refs must include ${candidateRef}`);
  }
  const missingSources = candidate.sourceIds.filter((sourceId) => !parsed.sourceRefs.includes(sourceId));
  if (missingSources.length > 0) {
    throw new Error(`New Knowledge source_refs are missing Candidate Sources: ${missingSources.join(", ")}`);
  }
  assertKnowledgeQuality(parsed, { requireAdmission: isSourceDerived(parsed) });

  const installation = installReviewedKnowledge(home, replacementText, replacementPath);
  const record = installation.record;
  const existingResolution = candidate.resolution?.knowledgeIds ?? [];
  if (candidate.status === "applied" && (existingResolution.length !== 1 || existingResolution[0] !== record.id)) {
    throw new Error(`Experience Candidate ${candidate.id} is already applied with a different Knowledge resolution`);
  }
  ensureKnowledgeCreatedEvent(store, record, candidate.id, candidate.contentHash, reviewedArtifact.ref, reviewedArtifact.contentHash);
  markExperienceCandidateApplied(home, store, candidate.id, { knowledgeIds: [record.id], revisionId: null });
  return {
    mode: "create",
    candidateId: candidate.id,
    knowledgeIds: [record.id],
    records: [record],
    reviewedArtifactRef: reviewedArtifact.ref,
    reviewedArtifactHash: reviewedArtifact.contentHash,
    recovered: installation.recovered || candidate.status === "applied",
  };
}

function ensureKnowledgeCreatedEvent(
  store: LedgerStore,
  record: KnowledgeRecord,
  candidateId: string,
  candidateContentHash: string,
  reviewedArtifactRef: string,
  reviewedArtifactHash: string,
): void {
  const exists = store.listEvents().some((event) => event.aggregateType === "knowledge"
    && event.aggregateId === record.id
    && event.eventType === "knowledge.created"
    && event.payload.candidateId === candidateId
    && event.payload.candidateContentHash === candidateContentHash
    && event.payload.reviewedArtifactHash === reviewedArtifactHash);
  if (exists) return;
  store.recordKnowledgeEvent(record.id, "knowledge.created", {
    path: record.path,
    title: record.title,
    type: record.type,
    collection: record.collection,
    scope: record.scope,
    status: record.status,
    revision: record.revision,
    sourceRefs: record.sourceRefs,
    qualityVersion: record.qualityVersion,
    productType: record.productType,
    canonicalKey: record.canonicalKey,
    compilationSchema: record.compilationSchema,
    compilationCaseId: record.compilationCaseId,
    compilationProductId: record.compilationProductId,
    extractionManifestRef: record.extractionManifestRef,
    compilationRef: record.compilationRef,
    informationLossRef: record.informationLossRef,
    candidateId,
    candidateContentHash,
    reviewedArtifactRef,
    reviewedArtifactHash,
  });
}

function readRegularFile(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return readFileSync(path, "utf8");
}

function resolveSafeRef(home: string, ref: string): string {
  if (!ref || isAbsolute(ref)) throw new Error(`Reviewed Knowledge ref must be relative: ${ref}`);
  const root = resolve(home);
  const path = resolve(root, ref);
  const remainder = relative(root, path);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) {
    throw new Error(`Reviewed Knowledge ref escapes IKB home: ${ref}`);
  }
  return path;
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
