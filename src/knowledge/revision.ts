import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findExperienceCandidate, markExperienceCandidateApplied } from "../experience.ts";
export { requestKnowledgeCorrection, type KnowledgeCorrectionAction, type KnowledgeCorrectionRequestInput } from "../experience.ts";
import type { LedgerStore } from "../store.ts";
import type { KnowledgeRecord } from "../types.ts";
import { parseKnowledge, renderKnowledge } from "./codec.ts";
import { assertKnowledgeQuality, isSourceDerived } from "./quality.ts";
import { findKnowledge } from "./records.ts";
import { assertActiveCanonicalKeyAvailable } from "./repository.ts";
import { rebuildKnowledgeViews } from "./views.ts";

export const KNOWLEDGE_REVISION_VERSION = "ikb-knowledge-revision.v1";

export type KnowledgeRevisionStatus = "prepared" | "files_written" | "completed";

export interface KnowledgeRevisionItem {
  knowledgeId: string;
  action: "revise" | "retire";
  targetRef: string;
  beforeRef: string;
  afterRef: string;
  beforeHash: string;
  afterHash: string;
  beforeRevision: number;
  afterRevision: number;
}

export interface KnowledgeRevisionJournal {
  schema: typeof KNOWLEDGE_REVISION_VERSION;
  id: string;
  candidateId: string;
  candidateContentHash: string;
  reviewedArtifactRef: string | null;
  reviewedArtifactHash: string | null;
  scope: "personal" | "work";
  primaryKnowledgeId: string | null;
  status: KnowledgeRevisionStatus;
  items: KnowledgeRevisionItem[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRevisionResult {
  journal: KnowledgeRevisionJournal;
  candidateId: string;
  knowledgeIds: string[];
  records: KnowledgeRecord[];
  recovered: boolean;
}

export function prepareKnowledgeCandidateRevision(
  home: string,
  candidateId: string,
  input: { replacementPath?: string; primaryKnowledgeId?: string } = {},
): KnowledgeRevisionJournal {
  const candidate = findExperienceCandidate(home, candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found: ${candidateId}`);
  if (candidate.status !== "accepted" && candidate.status !== "applied") throw new Error(`Experience Candidate ${candidateId} must be accepted before preparing a Knowledge revision`);
  if (!candidate.decision || candidate.decision.outcome !== "accepted" || candidate.decision.candidateContentHash !== candidate.contentHash) {
    throw new Error(`Experience Candidate ${candidateId} does not have a current accepted decision`);
  }
  if (candidate.changeTypes.includes("new")) throw new Error(`Experience Candidate ${candidateId} creates new Knowledge and cannot use the revision transaction`);
  const targetIds = unique(candidate.targetKnowledgeIds);
  if (targetIds.length === 0) throw new Error(`Experience Candidate ${candidateId} has no target Knowledge`);
  const revisions = listKnowledgeRevisions(home).filter((journal) => journal.candidateId === candidateId);
  if (revisions.length > 1) throw new Error(`Experience Candidate ${candidateId} has multiple revision journals`);
  if (revisions[0]) {
    assertJournalMatchesCandidate(revisions[0], candidate.contentHash, input.primaryKnowledgeId);
    return revisions[0];
  }

  const hasRevision = candidate.changeTypes.includes("revise");
  const primaryKnowledgeId = hasRevision ? selectPrimaryKnowledgeId(targetIds, input.primaryKnowledgeId) : null;
  if (hasRevision && !input.replacementPath) throw new Error("A revise candidate requires --file with the complete replacement Knowledge");
  if (!hasRevision && input.replacementPath) throw new Error("A retire-only candidate does not accept a replacement file");
  const reviewedArtifact = candidate.decision.reviewedArtifact;
  if (hasRevision && !reviewedArtifact) {
    throw new Error(`Experience Candidate ${candidateId} was not accepted against a complete reviewed replacement`);
  }
  if (hasRevision) {
    const expectedReviewedRef = `experiences/reviews/${candidate.id}/${reviewedArtifact!.contentHash}.md`;
    if (reviewedArtifact!.ref !== expectedReviewedRef) {
      throw new Error(`Experience Candidate ${candidateId} reviewed artifact is not an immutable decision snapshot`);
    }
  }
  let replacementText: string | null = null;
  if (hasRevision) {
    const reviewedPath = resolveSafeRef(home, reviewedArtifact!.ref);
    const reviewedText = readRegularFile(reviewedPath, "Reviewed Candidate replacement");
    if (sha256(reviewedText) !== reviewedArtifact!.contentHash) {
      throw new Error(`Reviewed Candidate replacement changed after acceptance: ${reviewedArtifact!.ref}`);
    }
    replacementText = readRegularFile(resolveRequiredPath(input.replacementPath!), "Knowledge replacement");
    if (sha256(replacementText) !== reviewedArtifact!.contentHash) {
      throw new Error("Knowledge replacement bytes do not match the file accepted by the user");
    }
  }
  const targets = targetIds.map((id) => {
    const record = findKnowledge(home, id);
    if (!record) throw new Error(`Target Knowledge not found: ${id}`);
    if (record.scope !== candidate.scope) throw new Error(`Target Knowledge ${id} scope ${record.scope} does not match Candidate scope ${candidate.scope}`);
    return record;
  });
  if (hasRevision) {
    const targetShapes = unique(targets.map((record) => `${record.type}|${record.collection}`));
    if (targetShapes.length !== 1) {
      throw new Error("A Knowledge revision requires all targets to have the same type and collection");
    }
    const primary = targets.find((record) => record.id === primaryKnowledgeId)!;
    if (primary.type !== candidate.candidateKnowledge.type || primary.collection !== candidate.candidateKnowledge.collection) {
      throw new Error(`Candidate type or collection does not match revision target ${primary.id}`);
    }
  }
  const revisionId = `knowledge-revision-${sha256(`${candidate.id}|${candidate.contentHash}|${primaryKnowledgeId ?? "retire"}`).slice(0, 16)}`;
  const journalRef = `revisions/knowledge/${candidate.scope}/${revisionId}/journal.json`;
  const createdAt = new Date().toISOString();
  const finalRecords = new Map<string, KnowledgeRecord>();
  if (primaryKnowledgeId) {
    const primary = targets.find((record) => record.id === primaryKnowledgeId)!;
    const parsed = parseKnowledge(replacementText!, resolve(input.replacementPath!));
    if (parsed.id !== primary.id) throw new Error(`Replacement Knowledge id ${parsed.id} must match primary id ${primary.id}`);
    if (parsed.scope !== primary.scope) throw new Error(`Replacement Knowledge scope ${parsed.scope} must match primary scope ${primary.scope}`);
    if (parsed.status === "retired") throw new Error("Replacement Knowledge must not already be retired");
    if (parsed.type !== candidate.candidateKnowledge.type || parsed.collection !== candidate.candidateKnowledge.collection) {
      throw new Error("Replacement Knowledge type or collection does not match the accepted Candidate");
    }
    const finalRecord: KnowledgeRecord = {
      ...parsed,
      path: primary.path,
      status: "draft",
      revision: primary.revision + 1,
      revisionHistory: unique([...primary.revisionHistory, journalRef]),
      supersededBy: undefined,
      sourceRefs: unique([...primary.sourceRefs, ...parsed.sourceRefs, ...candidate.sourceRecordRefs, `experience-candidate:${candidate.id}`]),
      derivedFrom: unique([...parsed.derivedFrom, ...targetIds.filter((id) => id !== primary.id)]),
      confidenceBasis: unique([...(parsed.confidenceBasis ?? []), `Accepted Experience Candidate ${candidate.id}`]),
      verification: "unverified",
      counterevidenceRefs: unique([...(parsed.counterevidenceRefs ?? []), ...candidate.sourceRecordRefs]),
    };
    assertKnowledgeQuality(finalRecord, { requireAdmission: isSourceDerived(finalRecord) });
    assertActiveCanonicalKeyAvailable(home, finalRecord);
    finalRecords.set(primary.id, finalRecord);
  }
  for (const target of targets) {
    if (target.id === primaryKnowledgeId) continue;
    const retired: KnowledgeRecord = {
      ...target,
      status: "retired",
      temporalState: "superseded",
      supersededBy: primaryKnowledgeId ?? undefined,
      revision: target.revision + 1,
      revisionHistory: unique([...target.revisionHistory, journalRef]),
    };
    assertKnowledgeQuality(retired);
    finalRecords.set(target.id, retired);
  }

  const items = targets.map((target): KnowledgeRevisionItem => {
    const after = finalRecords.get(target.id);
    if (!after) throw new Error(`Knowledge revision did not produce a final record for ${target.id}`);
    const targetRef = safeRelative(home, target.path);
    const beforeRef = `revisions/knowledge/${candidate.scope}/${revisionId}/before/${target.id}.md`;
    const afterRef = `revisions/knowledge/${candidate.scope}/${revisionId}/after/${target.id}.md`;
    const before = readRegularFile(target.path, `Knowledge ${target.id}`);
    const afterText = renderKnowledge(after);
    writeImmutable(home, beforeRef, before);
    writeImmutable(home, afterRef, afterText);
    return {
      knowledgeId: target.id,
      action: target.id === primaryKnowledgeId ? "revise" : "retire",
      targetRef,
      beforeRef,
      afterRef,
      beforeHash: sha256(before),
      afterHash: sha256(afterText),
      beforeRevision: target.revision,
      afterRevision: after.revision,
    };
  });
  const journal: KnowledgeRevisionJournal = {
    schema: KNOWLEDGE_REVISION_VERSION,
    id: revisionId,
    candidateId: candidate.id,
    candidateContentHash: candidate.contentHash,
    reviewedArtifactRef: reviewedArtifact?.ref ?? null,
    reviewedArtifactHash: reviewedArtifact?.contentHash ?? null,
    scope: candidate.scope,
    primaryKnowledgeId,
    status: "prepared",
    items,
    createdAt,
    updatedAt: createdAt,
  };
  writeJournal(home, journal);
  return journal;
}

export function applyPreparedKnowledgeRevision(home: string, store: LedgerStore, revisionId: string): KnowledgeRevisionResult {
  const journal = findKnowledgeRevision(home, revisionId);
  if (!journal) throw new Error(`Knowledge revision journal not found: ${revisionId}`);
  const candidate = findExperienceCandidate(home, journal.candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found for revision ${revisionId}: ${journal.candidateId}`);
  if (candidate.contentHash !== journal.candidateContentHash) throw new Error(`Knowledge revision ${revisionId} is stale because Candidate content changed`);
  if (candidate.status !== "accepted" && candidate.status !== "applied") throw new Error(`Experience Candidate ${candidate.id} is ${candidate.status}; accepted state is required`);
  if (candidate.decision?.candidateContentHash !== candidate.contentHash) throw new Error(`Experience Candidate ${candidate.id} decision is stale`);
  if ((candidate.decision?.reviewedArtifact?.ref ?? null) !== journal.reviewedArtifactRef
    || (candidate.decision?.reviewedArtifact?.contentHash ?? null) !== journal.reviewedArtifactHash) {
    throw new Error(`Knowledge revision ${revisionId} does not match the reviewed artifact in the Candidate decision`);
  }

  const checked = journal.items.map((item) => {
    const currentRecord = findKnowledge(home, item.knowledgeId);
    if (!currentRecord) throw new Error(`Knowledge revision target is not an active Vault record: ${item.knowledgeId}`);
    if (currentRecord.scope !== journal.scope || safeRelative(home, currentRecord.path) !== item.targetRef) {
      throw new Error(`Knowledge revision target path does not match the current Vault record: ${item.knowledgeId}`);
    }
    const expectedBeforeRef = `revisions/knowledge/${journal.scope}/${journal.id}/before/${item.knowledgeId}.md`;
    const expectedAfterRef = `revisions/knowledge/${journal.scope}/${journal.id}/after/${item.knowledgeId}.md`;
    if (item.beforeRef !== expectedBeforeRef || item.afterRef !== expectedAfterRef) {
      throw new Error(`Knowledge revision snapshot refs are invalid: ${item.knowledgeId}`);
    }
    const targetPath = resolveSafeRef(home, item.targetRef);
    const beforePath = resolveSafeRef(home, item.beforeRef);
    const afterPath = resolveSafeRef(home, item.afterRef);
    const before = readRegularFile(beforePath, `Knowledge revision before snapshot ${item.knowledgeId}`);
    const after = readRegularFile(afterPath, `Knowledge revision after snapshot ${item.knowledgeId}`);
    if (sha256(before) !== item.beforeHash) throw new Error(`Knowledge revision before snapshot hash changed: ${item.knowledgeId}`);
    if (sha256(after) !== item.afterHash) throw new Error(`Knowledge revision after snapshot hash changed: ${item.knowledgeId}`);
    const beforeRecord = parseKnowledge(before, beforePath);
    const afterRecord = parseKnowledge(after, afterPath);
    if (beforeRecord.id !== item.knowledgeId || beforeRecord.scope !== journal.scope || beforeRecord.revision !== item.beforeRevision) {
      throw new Error(`Knowledge revision before snapshot contract is invalid: ${item.knowledgeId}`);
    }
    if (afterRecord.id !== item.knowledgeId || afterRecord.scope !== journal.scope || afterRecord.revision !== item.afterRevision) {
      throw new Error(`Knowledge revision after snapshot contract is invalid: ${item.knowledgeId}`);
    }
    if ((item.action === "revise" && (journal.primaryKnowledgeId !== item.knowledgeId || afterRecord.status !== "draft"))
      || (item.action === "retire" && afterRecord.status !== "retired")) {
      throw new Error(`Knowledge revision action contract is invalid: ${item.knowledgeId}`);
    }
    if (item.action === "revise"
      && (afterRecord.type !== candidate.candidateKnowledge.type || afterRecord.collection !== candidate.candidateKnowledge.collection)) {
      throw new Error(`Knowledge revision Candidate shape is invalid: ${item.knowledgeId}`);
    }
    const current = readRegularFile(targetPath, `Knowledge revision target ${item.knowledgeId}`);
    const currentHash = sha256(current);
    if (currentHash !== item.beforeHash && currentHash !== item.afterHash) {
      throw new Error(`Knowledge ${item.knowledgeId} changed after the revision snapshot; refusing to overwrite it`);
    }
    return { item, targetPath, after, currentHash };
  });
  const recovered = journal.status !== "prepared" || checked.some((value) => value.currentHash === value.item.afterHash);
  for (const value of checked) {
    if (value.currentHash === value.item.beforeHash) writePrivateAtomic(value.targetPath, value.after);
  }
  if (journal.status === "prepared") updateJournal(home, journal, "files_written");
  rebuildKnowledgeViews(home, journal.scope);
  const records = journal.items.map((item) => {
    const record = findKnowledge(home, item.knowledgeId);
    if (!record) throw new Error(`Knowledge disappeared after revision: ${item.knowledgeId}`);
    if (record.revision !== item.afterRevision) throw new Error(`Knowledge ${item.knowledgeId} revision did not advance to ${item.afterRevision}`);
    return record;
  });
  markExperienceCandidateApplied(home, store, candidate.id, { knowledgeIds: records.map((record) => record.id), revisionId: journal.id });
  for (const item of journal.items) {
    const eventType = item.action === "revise" ? "knowledge.revised" : "knowledge.retired";
    if (!store.listEvents().some((event) => event.aggregateType === "knowledge" && event.aggregateId === item.knowledgeId && event.eventType === eventType && event.payload.revisionId === journal.id)) {
      store.recordKnowledgeEvent(item.knowledgeId, eventType, {
        revisionId: journal.id,
        candidateId: journal.candidateId,
        action: item.action,
        beforeHash: item.beforeHash,
        afterHash: item.afterHash,
        beforeRevision: item.beforeRevision,
        afterRevision: item.afterRevision,
        journalRef: journalRef(journal),
        primaryKnowledgeId: journal.primaryKnowledgeId,
      });
    }
  }
  if (journal.status !== "completed") updateJournal(home, journal, "completed");
  return { journal, candidateId: journal.candidateId, knowledgeIds: records.map((record) => record.id), records, recovered };
}

export function applyKnowledgeCandidateRevision(
  home: string,
  store: LedgerStore,
  candidateId: string,
  input: { replacementPath?: string; primaryKnowledgeId?: string } = {},
): KnowledgeRevisionResult {
  const journal = prepareKnowledgeCandidateRevision(home, candidateId, input);
  return applyPreparedKnowledgeRevision(home, store, journal.id);
}

export function listKnowledgeRevisions(home: string): KnowledgeRevisionJournal[] {
  const root = join(resolve(home), "revisions", "knowledge");
  if (!existsSync(root)) return [];
  assertRealDirectory(root, "Knowledge revision root");
  const journals: KnowledgeRevisionJournal[] = [];
  for (const scopeEntry of readdirSync(root, { withFileTypes: true })) {
    if (!scopeEntry.isDirectory() || !["personal", "work"].includes(scopeEntry.name)) continue;
    const scopeRoot = join(root, scopeEntry.name);
    assertRealDirectory(scopeRoot, "Knowledge revision scope");
    for (const revisionEntry of readdirSync(scopeRoot, { withFileTypes: true })) {
      if (!revisionEntry.isDirectory() || !/^knowledge-revision-[a-f0-9]{16}$/.test(revisionEntry.name)) continue;
      const path = join(scopeRoot, revisionEntry.name, "journal.json");
      if (existsSync(path)) journals.push(readJournal(path));
    }
  }
  return journals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function findKnowledgeRevision(home: string, id: string): KnowledgeRevisionJournal | null {
  return listKnowledgeRevisions(home).find((journal) => journal.id === id) ?? null;
}

export function pendingKnowledgeRevisionJournals(home: string, scope?: string): string[] {
  return listKnowledgeRevisions(home)
    .filter((journal) => journal.status !== "completed" && (!scope || journal.scope === scope))
    .map((journal) => resolveSafeRef(home, journalRef(journal)));
}

function selectPrimaryKnowledgeId(targetIds: string[], requested?: string): string {
  if (requested) {
    if (!targetIds.includes(requested)) throw new Error(`Primary Knowledge ${requested} is not targeted by the Candidate`);
    return requested;
  }
  if (targetIds.length === 1) return targetIds[0];
  throw new Error("A revision with multiple target Knowledge records requires --primary");
}

function assertJournalMatchesCandidate(journal: KnowledgeRevisionJournal, contentHash: string, requestedPrimary?: string): void {
  if (journal.candidateContentHash !== contentHash) throw new Error(`Existing Knowledge revision ${journal.id} is stale for the current Candidate`);
  if (requestedPrimary && journal.primaryKnowledgeId !== requestedPrimary) throw new Error(`Existing Knowledge revision ${journal.id} uses primary ${journal.primaryKnowledgeId}, not ${requestedPrimary}`);
}

function journalRef(journal: Pick<KnowledgeRevisionJournal, "scope" | "id">): string {
  return `revisions/knowledge/${journal.scope}/${journal.id}/journal.json`;
}

function writeJournal(home: string, journal: KnowledgeRevisionJournal): void {
  writePrivateAtomic(resolveSafeRef(home, journalRef(journal)), `${JSON.stringify(journal, null, 2)}\n`);
}

function updateJournal(home: string, journal: KnowledgeRevisionJournal, status: KnowledgeRevisionStatus): void {
  journal.status = status;
  journal.updatedAt = new Date().toISOString();
  writeJournal(home, journal);
}

function readJournal(path: string): KnowledgeRevisionJournal {
  const value = JSON.parse(readRegularFile(path, "Knowledge revision journal")) as KnowledgeRevisionJournal;
  if (!value || value.schema !== KNOWLEDGE_REVISION_VERSION || !/^knowledge-revision-[a-f0-9]{16}$/.test(value.id)
    || typeof value.candidateId !== "string" || !/^exp-cand-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.candidateId)
    || !/^[a-f0-9]{64}$/.test(value.candidateContentHash)
    || !["personal", "work"].includes(value.scope) || !["prepared", "files_written", "completed"].includes(value.status)
    || !Object.hasOwn(value, "reviewedArtifactRef") || !Object.hasOwn(value, "reviewedArtifactHash")
    || (value.reviewedArtifactRef !== null && typeof value.reviewedArtifactRef !== "string")
    || (value.reviewedArtifactHash !== null && typeof value.reviewedArtifactHash !== "string")
    || !Array.isArray(value.items) || value.items.length === 0) throw new Error(`Invalid Knowledge revision journal: ${path}`);
  const hasPrimary = typeof value.primaryKnowledgeId === "string" && /^kb-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.primaryKnowledgeId);
  if (value.primaryKnowledgeId !== null && !hasPrimary) throw new Error(`Invalid Knowledge revision primary id: ${path}`);
  if (hasPrimary) {
    const expectedReviewedRef = `experiences/reviews/${value.candidateId}/${value.reviewedArtifactHash}.md`;
    if (!/^[a-f0-9]{64}$/.test(value.reviewedArtifactHash ?? "") || value.reviewedArtifactRef !== expectedReviewedRef) {
      throw new Error(`Invalid Knowledge revision reviewed artifact: ${path}`);
    }
  } else if (value.reviewedArtifactRef !== null || value.reviewedArtifactHash !== null) {
    throw new Error(`Retire-only Knowledge revision must not contain a reviewed replacement: ${path}`);
  }
  if (new Set(value.items.map((item) => item.knowledgeId)).size !== value.items.length
    || value.items.some((item) => !/^kb-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.knowledgeId)
      || !["revise", "retire"].includes(item.action)
      || !/^[a-f0-9]{64}$/.test(item.beforeHash)
      || !/^[a-f0-9]{64}$/.test(item.afterHash)
      || !Number.isInteger(item.beforeRevision) || !Number.isInteger(item.afterRevision)
      || item.afterRevision !== item.beforeRevision + 1)) {
    throw new Error(`Invalid Knowledge revision items: ${path}`);
  }
  return value;
}

function writeImmutable(home: string, ref: string, content: string): void {
  const path = resolveSafeRef(home, ref);
  if (existsSync(path)) {
    if (readRegularFile(path, "Knowledge revision snapshot") !== content) throw new Error(`Knowledge revision snapshot already exists with different bytes: ${ref}`);
    return;
  }
  writePrivateAtomic(path, content);
}

function writePrivateAtomic(path: string, content: string): void {
  ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readRegularFile(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return readFileSync(path, "utf8");
}

function resolveRequiredPath(path: string): string {
  const resolved = resolve(path);
  readRegularFile(resolved, "Knowledge replacement");
  return resolved;
}

function resolveSafeRef(home: string, ref: string): string {
  if (!ref || isAbsolute(ref)) throw new Error(`Knowledge revision ref must be relative: ${ref}`);
  const root = resolve(home);
  const path = resolve(root, ref);
  const remainder = relative(root, path);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) throw new Error(`Knowledge revision ref escapes IKB home: ${ref}`);
  return path;
}

function safeRelative(home: string, path: string): string {
  const root = resolve(home);
  const absolute = resolve(path);
  const ref = relative(root, absolute).split("\\").join("/");
  if (!ref || ref.startsWith("..") || isAbsolute(ref)) throw new Error(`Knowledge path escapes IKB home: ${path}`);
  return ref;
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
