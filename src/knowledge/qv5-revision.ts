import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findExperienceCandidate, markExperienceCandidateApplied } from "../experience.ts";
import type { LedgerStore } from "../store.ts";
import type { KnowledgeRecord } from "../types.ts";
import { parseKnowledge, renderKnowledge } from "./codec.ts";
import { assertKnowledgeQuality, isSourceDerived } from "./quality.ts";
import { findKnowledge } from "./records.ts";
import { assertActiveCanonicalKeyAvailable } from "./repository.ts";
import { rebuildKnowledgeViews } from "./views.ts";
import { renderKnowledgeProductBody, validateExtractionBatch, verifyExtractionBatch } from "../extraction-result.ts";

export const QV5_REVISION_VERSION = "ikb-qv5-knowledge-revision.v1";

export interface Qv5KnowledgeRevisionJournal {
  schema: typeof QV5_REVISION_VERSION;
  id: string;
  scope: "personal" | "work";
  knowledgeId: string;
  status: "prepared" | "completed";
  replacementArtifactId: string;
  validationArtifactId: string;
  manifestArtifactId: string;
  compilationArtifactId: string;
  fidelityArtifactId: string;
  beforeRef: string;
  afterRef: string;
  beforeHash: string;
  afterHash: string;
  beforeRevision: number;
  afterRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Read-only fail-closed gate shared by direct revision and batch dry-runs. */
export function preflightReviewedQv5KnowledgeRevision(home: string, store: LedgerStore, input: {
  knowledgeId: string; replacementArtifactId: string; validationArtifactId: string; manifestArtifactId: string; compilationArtifactId: string; fidelityArtifactId: string;
}): void {
  const target = findKnowledge(home, input.knowledgeId);
  if (!target) throw new Error(`Knowledge not found: ${input.knowledgeId}`);
  const replacement = requireArtifact(store, input.replacementArtifactId, "knowledge-qv5-replacement-draft");
  const validation = requireArtifact(store, input.validationArtifactId, "knowledge-qv5-validation");
  const manifest = requireArtifact(store, input.manifestArtifactId, "knowledge-extraction-manifest");
  const compilation = requireArtifact(store, input.compilationArtifactId, "knowledge-extraction-result");
  const fidelity = requireArtifact(store, input.fidelityArtifactId, "knowledge-extraction-fidelity");
  if (replacement.runId !== validation.runId) throw new Error("QV5 replacement and validation Artifacts must belong to one Curator Run");
  if (manifest.runId !== compilation.runId || manifest.runId !== fidelity.runId) throw new Error("QV5 manifest, compilation and fidelity Artifacts must belong to one Analyst Run");
  if (replacement.runId === manifest.runId) throw new Error("QV5 Curator Run and Analyst Run must be different Runs");
  const curatorRun = store.requireRun(replacement.runId); const analystRun = store.requireRun(manifest.runId);
  const curatorTask = store.requireTask(curatorRun.taskId); const analystTask = store.requireTask(analystRun.taskId);
  if (curatorTask.scope !== target.scope || analystTask.scope !== target.scope) throw new Error(`QV5 Artifact scope does not match Knowledge ${target.id}`);
  if (!curatorRun.skillIds.split(",").includes("ikb-knowledge-curator")) throw new Error(`QV5 Curator Run ${curatorRun.id} must include ikb-knowledge-curator`);
  if (!analystRun.skillIds.split(",").includes("ikb-conversation-analysis")) throw new Error(`QV5 Analyst Run ${analystRun.id} must include ikb-conversation-analysis`);
  const replacementBytes = readRegularFile(replacement.path, "QV5 replacement draft");
  const validationValue = readJson(validation.path, "QV5 replacement validation");
  if (String(validationValue.knowledgeId ?? "") !== target.id || validationValue.bodyExact !== true || String(validationValue.renderedHash ?? "") !== sha256(replacementBytes)) throw new Error("QV5 replacement validation does not bind the exact replacement bytes");
  const parsed = parseKnowledge(replacementBytes, replacement.path);
  if (parsed.id !== target.id || parsed.scope !== target.scope || parsed.type !== target.type || parsed.collection !== target.collection) throw new Error("QV5 replacement must preserve Knowledge id, scope, type and collection");
  if (parsed.qualityVersion < 5 || parsed.status !== "draft") throw new Error("QV5 replacement must be a draft with quality_version >= 5");
  if (parsed.extractionManifestRef !== manifest.id || parsed.compilationRef !== compilation.id || parsed.informationLossRef !== fidelity.id) throw new Error("QV5 replacement Artifact refs do not match the transaction inputs");
  assertValidatedExtractionReplacement(parsed, manifest.path, compilation.path, fidelity.path);
  assertKnowledgeQuality(parsed, { requireAdmission: isSourceDerived(parsed) });
}

/**
 * Applies a source-derived QV5 replacement after its full bytes have been
 * reviewed. This intentionally does not reuse Experience Candidates: a V3
 * Compilation is evidence-backed knowledge production, not an Experience
 * pattern. The transaction is local, hash-bound, crash recoverable and keeps
 * the former Vault bytes in an immutable before snapshot.
 */
export function applyReviewedQv5KnowledgeRevision(
  home: string,
  store: LedgerStore,
  input: {
    knowledgeId: string;
    replacementArtifactId: string;
    validationArtifactId: string;
    manifestArtifactId: string;
    compilationArtifactId: string;
    fidelityArtifactId: string;
  },
): { journal: Qv5KnowledgeRevisionJournal; record: KnowledgeRecord; recovered: boolean } {
  preflightReviewedQv5KnowledgeRevision(home, store, input);
  const target = findKnowledge(home, input.knowledgeId);
  if (!target) throw new Error(`Knowledge not found: ${input.knowledgeId}`);
  const replacementArtifact = requireArtifact(store, input.replacementArtifactId, "knowledge-qv5-replacement-draft");
  const validationArtifact = requireArtifact(store, input.validationArtifactId, "knowledge-qv5-validation");
  const manifestArtifact = requireArtifact(store, input.manifestArtifactId, "knowledge-extraction-manifest");
  const compilationArtifact = requireArtifact(store, input.compilationArtifactId, "knowledge-extraction-result");
  const fidelityArtifact = requireArtifact(store, input.fidelityArtifactId, "knowledge-extraction-fidelity");
  const replacement = readRegularFile(replacementArtifact.path, "QV5 replacement draft");
  const validation = readJson(validationArtifact.path, "QV5 replacement validation");
  if (String(validation.knowledgeId ?? "") !== target.id || validation.bodyExact !== true || String(validation.renderedHash ?? "") !== sha256(replacement)) {
    throw new Error("QV5 replacement validation does not bind the exact replacement bytes");
  }
  const parsed = parseKnowledge(replacement, replacementArtifact.path);
  if (parsed.id !== target.id || parsed.scope !== target.scope || parsed.type !== target.type || parsed.collection !== target.collection) {
    throw new Error("QV5 replacement must preserve Knowledge id, scope, type and collection");
  }
  if (parsed.qualityVersion < 5 || parsed.status !== "draft") throw new Error("QV5 replacement must be a draft with quality_version >= 5");
  if (parsed.extractionManifestRef !== manifestArtifact.id || parsed.compilationRef !== compilationArtifact.id || parsed.informationLossRef !== fidelityArtifact.id) {
    throw new Error("QV5 replacement Artifact refs do not match the transaction inputs");
  }
  assertValidatedExtractionReplacement(parsed, manifestArtifact.path, compilationArtifact.path, fidelityArtifact.path);
  assertKnowledgeQuality(parsed, { requireAdmission: isSourceDerived(parsed) });

  const seed = [target.id, replacementArtifact.contentHash, validationArtifact.contentHash, manifestArtifact.contentHash, compilationArtifact.contentHash, fidelityArtifact.contentHash].join("|");
  const id = `qv5-revision-${sha256(seed).slice(0, 16)}`;
  const existing = findQv5Revision(home, target.scope, id);
  if (existing) return applyJournal(home, store, existing);

  const root = `revisions/knowledge/${target.scope}/${id}`;
  const beforeRef = `${root}/before/${target.id}.md`;
  const afterRef = `${root}/after/${target.id}.md`;
  const journalRef = `revisions/knowledge/${target.scope}/${id}/journal.json`;
  const finalRecord: KnowledgeRecord = {
    ...parsed,
    path: target.path,
    revision: target.revision + 1,
    revisionHistory: [...new Set([...target.revisionHistory, journalRef])].sort(),
    status: "draft",
    verification: parsed.verification,
    sourceRefs: [...new Set([...target.sourceRefs, ...parsed.sourceRefs])].sort(),
  };
  assertKnowledgeQuality(finalRecord, { requireAdmission: isSourceDerived(finalRecord) });
  assertActiveCanonicalKeyAvailable(home, finalRecord);
  const before = readRegularFile(target.path, `Knowledge ${target.id}`);
  const after = renderKnowledge(finalRecord);
  writeImmutable(home, beforeRef, before);
  writeImmutable(home, afterRef, after);
  const now = new Date().toISOString();
  const journal: Qv5KnowledgeRevisionJournal = {
    schema: QV5_REVISION_VERSION, id, scope: target.scope, knowledgeId: target.id, status: "prepared",
    replacementArtifactId: replacementArtifact.id, validationArtifactId: validationArtifact.id,
    manifestArtifactId: manifestArtifact.id, compilationArtifactId: compilationArtifact.id, fidelityArtifactId: fidelityArtifact.id,
    beforeRef, afterRef, beforeHash: sha256(before), afterHash: sha256(after), beforeRevision: target.revision, afterRevision: finalRecord.revision,
    createdAt: now, updatedAt: now,
  };
  writeJournal(home, journal);
  return applyJournal(home, store, journal);
}

/**
 * Resolves the existing correction-Candidate hold only after the QV5 journal
 * proves that the exact reviewed replacement is now the active card bytes.
 * A failed precondition leaves the Candidate pending/accepted and therefore
 * fail-closed in default retrieval.
 */
export function resolveQv5KnowledgeCorrectionHold(
  home: string,
  store: LedgerStore,
  input: { candidateId: string; revisionId: string },
) {
  const candidate = findExperienceCandidate(home, input.candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found: ${input.candidateId}`);
  const alternateScope = candidate.scope === "work" ? "personal" : "work";
  const journal = findQv5Revision(home, candidate.scope, input.revisionId)
    ?? findQv5Revision(home, alternateScope, input.revisionId);
  if (!journal) throw new Error(`QV5 revision journal not found: ${input.revisionId}`);
  if (journal.scope !== candidate.scope) {
    throw new Error(`Experience Candidate scope ${candidate.scope} does not match QV5 revision scope ${journal.scope}`);
  }
  const targetKnowledgeIds = [...new Set(candidate.targetKnowledgeIds)];
  if (targetKnowledgeIds.length !== 1 || targetKnowledgeIds[0] !== journal.knowledgeId) {
    throw new Error(`Experience Candidate target ${targetKnowledgeIds.join(", ") || "(none)"} does not match QV5 revision target ${journal.knowledgeId}`);
  }
  if (journal.status !== "completed") {
    throw new Error(`QV5 revision journal ${journal.id} must be completed before resolving its hold`);
  }
  if (candidate.status !== "accepted" && candidate.status !== "applied") {
    throw new Error(`Experience Candidate ${candidate.id} must be accepted before its QV5 hold can resolve`);
  }
  if (!candidate.decision || candidate.decision.outcome !== "accepted" || candidate.decision.candidateContentHash !== candidate.contentHash) {
    throw new Error(`Experience Candidate ${candidate.id} does not have a current accepted decision`);
  }
  const reviewedArtifact = candidate.decision.reviewedArtifact;
  if (!reviewedArtifact) {
    throw new Error(`Experience Candidate ${candidate.id} must have a reviewed replacement before its QV5 hold can resolve`);
  }
  const expectedReviewedRef = `experiences/reviews/${candidate.id}/${reviewedArtifact.contentHash}.md`;
  if (reviewedArtifact.ref !== expectedReviewedRef) {
    throw new Error(`Experience Candidate ${candidate.id} reviewed replacement is not an immutable decision snapshot`);
  }
  const reviewedReplacement = readRegularFile(resolveRef(home, reviewedArtifact.ref), "Reviewed QV5 Candidate replacement");
  if (sha256(reviewedReplacement) !== reviewedArtifact.contentHash) {
    throw new Error(`Experience Candidate ${candidate.id} reviewed replacement hash changed after acceptance`);
  }
  const replacementArtifact = requireArtifact(store, journal.replacementArtifactId, "knowledge-qv5-replacement-draft");
  if (reviewedArtifact.contentHash !== replacementArtifact.contentHash) {
    throw new Error(`Experience Candidate ${candidate.id} reviewed replacement hash does not match QV5 replacement Artifact`);
  }
  const after = readRegularFile(resolveRef(home, journal.afterRef), "QV5 revision after snapshot");
  if (sha256(after) !== journal.afterHash) {
    throw new Error(`QV5 revision ${journal.id} after snapshot hash changed`);
  }
  const target = findKnowledge(home, journal.knowledgeId);
  if (!target || target.scope !== journal.scope) {
    throw new Error(`QV5 revision target is missing or has a mismatched scope: ${journal.knowledgeId}`);
  }
  const current = readRegularFile(target.path, `Knowledge ${target.id}`);
  if (sha256(current) !== journal.afterHash) {
    throw new Error(`Current Knowledge ${target.id} does not match completed QV5 revision after hash`);
  }
  return markExperienceCandidateApplied(home, store, candidate.id, {
    knowledgeIds: [journal.knowledgeId],
    revisionId: journal.id,
  });
}

function applyJournal(home: string, store: LedgerStore, journal: Qv5KnowledgeRevisionJournal): { journal: Qv5KnowledgeRevisionJournal; record: KnowledgeRecord; recovered: boolean } {
  const target = findKnowledge(home, journal.knowledgeId);
  if (!target || target.scope !== journal.scope) throw new Error(`QV5 revision target is missing: ${journal.knowledgeId}`);
  const before = readRegularFile(resolveRef(home, journal.beforeRef), "QV5 revision before snapshot");
  const after = readRegularFile(resolveRef(home, journal.afterRef), "QV5 revision after snapshot");
  if (sha256(before) !== journal.beforeHash || sha256(after) !== journal.afterHash) throw new Error("QV5 revision snapshot hash changed");
  const current = readRegularFile(target.path, `Knowledge ${target.id}`);
  const currentHash = sha256(current);
  if (currentHash !== journal.beforeHash && currentHash !== journal.afterHash) throw new Error(`Knowledge ${target.id} changed after the QV5 revision snapshot; refusing to overwrite it`);
  const recovered = journal.status !== "prepared" || currentHash === journal.afterHash;
  if (currentHash === journal.beforeHash) writePrivateAtomic(target.path, after);
  rebuildKnowledgeViews(home, journal.scope);
  const record = findKnowledge(home, target.id);
  if (!record || record.revision !== journal.afterRevision || record.status !== "draft") throw new Error("QV5 revision did not produce the expected Vault record");
  if (!store.listEvents().some((event) => event.eventType === "knowledge.revised" && event.aggregateId === record.id && event.payload.revisionId === journal.id)) {
    store.recordKnowledgeEvent(record.id, "knowledge.revised", {
      revisionId: journal.id, action: "revise", beforeHash: journal.beforeHash, afterHash: journal.afterHash,
      beforeRevision: journal.beforeRevision, afterRevision: journal.afterRevision, journalRef: `revisions/knowledge/${journal.scope}/${journal.id}/journal.json`,
      replacementArtifactId: journal.replacementArtifactId, validationArtifactId: journal.validationArtifactId,
      manifestArtifactId: journal.manifestArtifactId, compilationArtifactId: journal.compilationArtifactId, fidelityArtifactId: journal.fidelityArtifactId,
    });
  }
  if (journal.status !== "completed") { journal.status = "completed"; journal.updatedAt = new Date().toISOString(); writeJournal(home, journal); }
  return { journal, record, recovered };
}

function findQv5Revision(home: string, scope: string, id: string): Qv5KnowledgeRevisionJournal | null {
  const path = resolve(home, "revisions", "knowledge", scope, id, "journal.json");
  if (!existsSync(path)) return null;
  const value = readJson(path, "QV5 revision journal") as unknown as Qv5KnowledgeRevisionJournal;
  if (value.schema !== QV5_REVISION_VERSION || value.id !== id || !["prepared", "completed"].includes(value.status)) throw new Error(`Invalid QV5 revision journal: ${path}`);
  return value;
}
function requireArtifact(store: LedgerStore, id: string, kind: string) {
  const artifact = store.getArtifact(id);
  if (!artifact || artifact.kind !== kind || !artifact.contentHash) throw new Error(`Required immutable Artifact is missing or invalid: ${id}`);
  if (sha256(readRegularFile(artifact.path, `Artifact ${id}`)) !== artifact.contentHash) throw new Error(`Artifact bytes changed: ${id}`);
  return artifact;
}
function assertValidatedExtractionReplacement(parsed: KnowledgeRecord, manifestPath: string, compilationPath: string, fidelityPath: string): void {
  const manifest = readJson(manifestPath, "QV5 extraction manifest");
  const compilation = readJson(compilationPath, "QV5 extraction result");
  const results = Array.isArray(compilation) ? compilation : compilation && typeof compilation === "object" && Array.isArray((compilation as Record<string, unknown>).results) ? (compilation as Record<string, unknown>).results : [compilation];
  const validation = validateExtractionBatch(manifest, results);
  if (!validation.valid) throw new Error("QV5 extraction validation is not valid");
  const fidelity = verifyExtractionBatch(manifest, results);
  const storedFidelity = readJson(fidelityPath, "QV5 extraction fidelity");
  if (stableJson(storedFidelity) !== stableJson(fidelity)) throw new Error("QV5 stored information loss report does not match recomputed fidelity");
  if (!fidelity.valid) throw new Error("QV5 recomputed information loss report is not valid");
  const verdict = fidelity.verdicts.find((item) => item.caseId === parsed.compilationCaseId);
  if (!verdict || verdict.legacy || !verdict.publishable || verdict.disposition !== "admit") throw new Error(`QV5 extraction case is not publishable: ${parsed.compilationCaseId}`);
  const result = results.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>).case_id ?? "") === parsed.compilationCaseId) as Record<string, unknown> | undefined;
  if (!result) throw new Error(`QV5 compilation case does not match replacement: ${parsed.compilationCaseId}`);
  const product = Array.isArray(result.products) ? result.products.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>).product_id ?? "") === parsed.compilationProductId) as Record<string, unknown> | undefined : undefined;
  if (!product) throw new Error(`QV5 compilation product not found: ${parsed.compilationProductId}`);
  if (String(product.canonical_key ?? "") !== parsed.canonicalKey) throw new Error("QV5 canonical_key does not match the validated product");
  if (String(product.product_type ?? "") !== parsed.productType) throw new Error("QV5 product_type does not match the validated product");
  if (!sameStrings(product.fact_refs, parsed.factRefs) || !sameStrings(product.questions_answered, parsed.questionsAnswered)) throw new Error("QV5 product fact_refs or questions_answered do not match the validated product");
  if (parsed.body !== renderKnowledgeProductBody(result, parsed.compilationCaseId!, parsed.compilationProductId!)) throw new Error("QV5 replacement body does not exactly match the deterministic product view");
}
function readJson(path: string, label: string): Record<string, unknown> { try { return JSON.parse(readRegularFile(path, label)) as Record<string, unknown>; } catch { throw new Error(`${label} is not valid JSON`); } }
function writeJournal(home: string, journal: Qv5KnowledgeRevisionJournal): void { writePrivateAtomic(resolveRef(home, `revisions/knowledge/${journal.scope}/${journal.id}/journal.json`), `${JSON.stringify(journal, null, 2)}\n`); }
function writeImmutable(home: string, ref: string, content: string): void { const path = resolveRef(home, ref); if (existsSync(path)) { if (readRegularFile(path, "QV5 revision snapshot") !== content) throw new Error(`QV5 revision snapshot already exists with different bytes: ${ref}`); return; } writePrivateAtomic(path, content); }
function resolveRef(home: string, ref: string): string { const root = resolve(home); const path = resolve(root, ref); const rest = relative(root, path); if (!ref || rest.startsWith("..") || !rest || resolve(path) !== path) throw new Error(`QV5 revision ref escapes IKB home: ${ref}`); return path; }
function readRegularFile(path: string, label: string): string { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`${label} must be a regular file: ${path}`); return readFileSync(path, "utf8"); }
function writePrivateAtomic(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`; writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); chmodSync(path, 0o600); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameStrings(value: unknown, expected: string[] | undefined): boolean { return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length === (expected ?? []).length && value.every((item, index) => item === (expected ?? [])[index]); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
