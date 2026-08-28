import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { decideExperienceCandidate, findExperienceCandidate, listExperienceCandidates, type ExperienceKnowledgeCandidate } from "./experience.ts";
import type { LedgerStore } from "./store.ts";
import { parseKnowledge } from "./knowledge/codec.ts";
import { assertKnowledgeQuality, isSourceDerived } from "./knowledge/quality.ts";
import { findKnowledge } from "./knowledge/records.ts";
import {
  HUMAN_CONFIRMATION_BRIEF_SCHEMA,
  HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION,
  writeHumanConfirmationBrief,
  type HumanConfirmationBrief,
  type HumanConfirmationBriefItem,
} from "./human-confirmation.ts";
import {
  EXTRACTION_FIDELITY_VERSION,
  EXTRACTION_RESULT_VERSION,
  renderKnowledgeProductBody,
  verifyExtractionBatch,
} from "./extraction-result.ts";
import type { KnowledgeRecord } from "./types.ts";

export const EXPERIENCE_REVIEW_PACKAGE_VERSION = "ikb-experience-review-package.v1";

export interface ExperienceReviewPackage {
  schema: typeof EXPERIENCE_REVIEW_PACKAGE_VERSION;
  id: string;
  candidateId: string;
  candidateContentHash: string;
  scope: "personal" | "work";
  mode: "create" | "revision" | "retire";
  primaryKnowledgeId: string | null;
  runId: string;
  draftArtifactId: string | null;
  draftContentHash: string | null;
  validationArtifactIds: string[];
  validationContentHashes: string[];
  guideArtifactId: string;
  guideContentHash: string;
  createdAt: string;
}

export interface ExperienceReviewArtifactView {
  id: string;
  kind: string;
  label: string;
  path: string;
  contentHash: string;
}

export interface ExperienceReviewPackageView {
  package: ExperienceReviewPackage;
  path: string;
  draft: ExperienceReviewArtifactView | null;
  validations: ExperienceReviewArtifactView[];
  guide: ExperienceReviewArtifactView;
  confirmationBrief: HumanConfirmationBrief;
}

export interface ExperienceReviewInspection {
  package: ExperienceReviewPackageView | null;
  issues: string[];
}

export interface ExperienceConfirmationBatchEntry {
  candidate: ExperienceKnowledgeCandidate;
  review: ExperienceReviewPackageView;
  key?: string;
}

export interface ExperienceConfirmationBatch {
  brief: HumanConfirmationBrief;
  items: Array<{ candidateId: string; key: string }>;
}

export function registerExperienceReviewPackage(
  home: string,
  store: LedgerStore,
  candidateId: string,
  input: {
    draftArtifactId?: string;
    validationArtifactIds: string[];
    guideArtifactId: string;
    primaryKnowledgeId?: string;
  },
): { outcome: "created" | "unchanged"; review: ExperienceReviewPackageView } {
  const candidate = findExperienceCandidate(home, candidateId);
  if (!candidate) throw new Error(`Experience Candidate not found: ${candidateId}`);
  assertCandidateStorageKey(candidate);
  if (candidate.status !== "pending_review") throw new Error(`Experience Candidate ${candidateId} must be pending_review before registering a review package`);
  if (candidate.validationRefs.length === 0) throw new Error(`Experience Candidate ${candidateId} requires candidate-content validation before review packaging`);
  const mode = reviewMode(candidate);
  const validationArtifactIds = unique(input.validationArtifactIds);
  if (validationArtifactIds.length === 0) throw new Error("Experience review package requires at least one validation Artifact");
  const draft = input.draftArtifactId ? requireArtifact(home, store, input.draftArtifactId, "knowledge-candidate-draft", candidate.scope) : null;
  const validations = validationArtifactIds.map((id) => requireArtifact(home, store, id, "knowledge-candidate-validation", candidate.scope));
  const guide = requireArtifact(home, store, input.guideArtifactId, "knowledge-review-guide", candidate.scope);
  const artifacts = [...(draft ? [draft] : []), ...validations, guide];
  const runIds = unique(artifacts.map((artifact) => artifact.runId));
  if (runIds.length !== 1) throw new Error("Experience review package Artifacts must belong to one Curator Run");
  const runId = runIds[0];
  assertCuratorRun(store, runId);
  const primaryKnowledgeId = validateDraft(home, store, candidate, mode, draft?.path, input.primaryKnowledgeId, { requireCurrent: false });
  validateReviewDocuments(candidate, draft, validations, guide);
  const stable = {
    schema: EXPERIENCE_REVIEW_PACKAGE_VERSION,
    candidateId: candidate.id,
    candidateContentHash: candidate.contentHash,
    scope: candidate.scope,
    mode,
    primaryKnowledgeId,
    runId,
    draftArtifactId: draft?.id ?? null,
    draftContentHash: draft?.contentHash ?? null,
    validationArtifactIds: validations.map((artifact) => artifact.id),
    validationContentHashes: validations.map((artifact) => artifact.contentHash),
    guideArtifactId: guide.id,
    guideContentHash: guide.contentHash,
    createdAt: artifacts.map((artifact) => artifact.createdAt).sort().at(-1)!,
  };
  const id = `exp-review-${sha256(JSON.stringify(stable)).slice(0, 12)}`;
  const directory = reviewPackageDirectory(home, candidate.id, candidate.contentHash);
  ensureDirectory(home, directory);
  const path = join(directory, `${id}.json`);
  if (existsSync(path)) {
    const existing = readPackage(path);
    const inspected = inspectPackage(home, store, candidate, existing, path);
    if (!inspected.package || inspected.issues.length > 0) throw new Error(`Existing Experience review package is invalid: ${inspected.issues.join("; ")}`);
    ensureReviewEvent(store, existing);
    return { outcome: "unchanged", review: inspected.package };
  }
  validateDraft(home, store, candidate, mode, draft?.path, input.primaryKnowledgeId, { requireCurrent: true });
  const reviewPackage: ExperienceReviewPackage = { ...stable, id };
  writePrivateJson(path, reviewPackage);
  const inspected = inspectPackage(home, store, candidate, reviewPackage, path);
  if (!inspected.package || inspected.issues.length > 0) throw new Error(`Experience review package failed validation: ${inspected.issues.join("; ")}`);
  ensureReviewEvent(store, reviewPackage);
  return { outcome: "created", review: inspected.package };
}

/**
 * User-facing acceptance gate.  The lower-level lifecycle function remains
 * responsible for the immutable decision snapshot, while this function makes
 * sure the accepted bytes are the same QV5 draft that passed the current
 * Curator review and low-loss verification.
 */
export function decideReviewedExperienceCandidate(
  home: string,
  store: LedgerStore,
  candidateId: string,
  input: { decision: "accept" | "reject"; reason: string; reviewedArtifactPath?: string },
) {
  if (input.decision === "reject") return decideExperienceCandidate(home, store, candidateId, input);
  const review = inspectCurrentExperienceReviewPackage(home, store, candidateId);
  if (!review.package || review.issues.length > 0 || !review.package.draft) {
    throw new Error(`Experience Candidate ${candidateId} cannot be accepted without a current validated review package`);
  }
  const reviewedArtifactPath = input.reviewedArtifactPath ?? review.package.draft.path;
  const reviewedText = readRegularFile(resolve(reviewedArtifactPath), "Reviewed Knowledge draft");
  if (sha256(reviewedText) !== review.package.package.draftContentHash) {
    throw new Error("Reviewed Knowledge draft does not match the current review draft");
  }
  return decideExperienceCandidate(home, store, candidateId, { ...input, reviewedArtifactPath });
}

export function inspectCurrentExperienceReviewPackage(
  home: string,
  store: LedgerStore,
  candidateOrId: ExperienceKnowledgeCandidate | string,
): ExperienceReviewInspection {
  const candidate = typeof candidateOrId === "string" ? findExperienceCandidate(home, candidateOrId) : candidateOrId;
  if (!candidate) return { package: null, issues: [`Experience Candidate not found: ${candidateOrId}`] };
  try {
    assertCandidateStorageKey(candidate);
  } catch (error) {
    return { package: null, issues: [(error as Error).message] };
  }
  const directory = reviewPackageDirectory(home, candidate.id, candidate.contentHash);
  if (!existsSync(directory)) return { package: null, issues: [] };
  try {
    assertExistingPathWithinHome(home, directory, "Experience review package directory");
  } catch (error) {
    return { package: null, issues: [(error as Error).message] };
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    return { package: null, issues: [`Experience review package directory is invalid: ${directory}`] };
  }
  const packages: Array<{ value: ExperienceReviewPackage; path: string }> = [];
  const issues: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.push(`Experience review package entry must be a regular file: ${join(directory, entry.name)}`);
      continue;
    }
    const path = join(directory, entry.name);
    try {
      assertExistingPathWithinHome(home, path, "Experience review package");
      packages.push({ value: readPackage(path), path });
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  const ordered = packages.sort((left, right) => right.value.createdAt.localeCompare(left.value.createdAt) || right.value.id.localeCompare(left.value.id));
  for (const item of ordered) {
    const inspected = inspectPackage(home, store, candidate, item.value, item.path);
    if (inspected.package && inspected.issues.length === 0) return { package: inspected.package, issues };
    issues.push(...inspected.issues);
  }
  return { package: null, issues: unique(issues) };
}

export function inspectExperienceReviewRegistry(home: string, store: LedgerStore): {
  registered: number;
  current: number;
  issues: Array<{ candidateId: string; detail: string }>;
} {
  const candidates = listExperienceCandidates(home);
  let registered = 0;
  let current = 0;
  const issues: Array<{ candidateId: string; detail: string }> = [];
  for (const candidate of candidates) {
    const root = join(reviewPackageRoot(home), candidate.id);
    if (!existsSync(root)) continue;
    registered += 1;
    // Rejected and applied candidates are terminal. Their review packages are
    // historical evidence, so later retirement or archival of the target
    // Knowledge must not make the current registry unhealthy.
    if (candidate.status === "rejected" || candidate.status === "applied") continue;
    const inspection = inspectCurrentExperienceReviewPackage(home, store, candidate);
    if (inspection.package) current += 1;
    for (const detail of inspection.issues) issues.push({ candidateId: candidate.id, detail });
  }
  return { registered, current, issues };
}

export function writeExperienceCandidateConfirmationBatch(
  home: string,
  entries: ExperienceConfirmationBatchEntry[],
): ExperienceConfirmationBatch {
  if (entries.length === 0 || entries.length > 3) throw new Error("Experience confirmation batch requires one to three Candidates");
  const ordered = [...entries].sort((left, right) => left.candidate.createdAt.localeCompare(right.candidate.createdAt)
    || left.candidate.id.localeCompare(right.candidate.id));
  const scopes = new Set(ordered.map((entry) => entry.candidate.scope));
  const candidateIds = new Set<string>();
  for (const { candidate, review } of ordered) {
    if (candidate.status !== "pending_review") throw new Error(`Experience Candidate ${candidate.id} is not pending review`);
    if (candidateIds.has(candidate.id)) throw new Error(`Duplicate Experience Candidate in confirmation batch: ${candidate.id}`);
    candidateIds.add(candidate.id);
    if (review.package.candidateId !== candidate.id || review.package.candidateContentHash !== candidate.contentHash) {
      throw new Error(`Experience review package does not match Candidate ${candidate.id}`);
    }
  }
  if (scopes.size !== 1) throw new Error("Experience confirmation batch cannot cross scopes");
  const scope = ordered[0].candidate.scope;
  const availableKeys = ["A", "B", "C"];
  const usedKeys = new Set<string>();
  const items = ordered.map((entry) => {
    const requested = entry.key?.trim();
    const key = requested && availableKeys.includes(requested) && !usedKeys.has(requested)
      ? requested
      : availableKeys.find((candidate) => !usedKeys.has(candidate));
    if (!key) throw new Error("Experience confirmation batch has no available item key");
    usedKeys.add(key);
    return { candidateId: entry.candidate.id, key };
  });
  const allPrinciples = ordered.every(({ candidate }) => candidate.candidateKnowledge.type === "principle");
  const confirmationItems = ordered.map((entry, index) => candidateConfirmationItem(home, entry.candidate, entry.review, items[index].key));
  const title = `${ordered.length} 条${allPrinciples ? " Principle" : " Knowledge"} Candidate 人工确认稿`;
  const purpose = `请逐项确认或驳回 ${items.map((item) => item.key).join("/")}；确认只作用于点名项，不自动接受其他 Candidate，也不自动写 Knowledge、激活 Principle 或修改 AGENTS。`;
  const identity = sha256(JSON.stringify({
    schema: HUMAN_CONFIRMATION_BRIEF_SCHEMA,
    renderVersion: HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION,
    scope,
    title,
    purpose,
    confirmationItems,
    itemKeys: items.map((item) => [item.candidateId, item.key]),
    entries: ordered.map(({ candidate, review }) => ({
      candidateId: candidate.id,
      candidateContentHash: candidate.contentHash,
      reviewPackageId: review.package.id,
      draftContentHash: review.package.draftContentHash,
      validationContentHashes: review.package.validationContentHashes,
      guideContentHash: review.package.guideContentHash,
    })),
  })).slice(0, 12);
  const brief = writeHumanConfirmationBrief(home, {
    id: `candidate-batch-${identity}`,
    scope,
    title,
    purpose,
    items: confirmationItems,
  });
  return { brief, items };
}

function inspectPackage(
  home: string,
  store: LedgerStore,
  candidate: ExperienceKnowledgeCandidate,
  value: ExperienceReviewPackage,
  path: string,
): ExperienceReviewInspection {
  const issues: string[] = [];
  if (value.schema !== EXPERIENCE_REVIEW_PACKAGE_VERSION) issues.push(`Unsupported Experience review package schema: ${value.schema}`);
  if (value.candidateId !== candidate.id) issues.push("Experience review package candidate id mismatch");
  if (value.candidateContentHash !== candidate.contentHash) issues.push("Experience review package is stale for the current Candidate content hash");
  if (value.scope !== candidate.scope) issues.push("Experience review package scope mismatch");
  try {
    if (value.mode !== reviewMode(candidate)) issues.push("Experience review package mode mismatch");
  } catch (error) {
    issues.push((error as Error).message);
  }
  const expectedId = `exp-review-${sha256(JSON.stringify({
    schema: value.schema,
    candidateId: value.candidateId,
    candidateContentHash: value.candidateContentHash,
    scope: value.scope,
    mode: value.mode,
    primaryKnowledgeId: value.primaryKnowledgeId,
    runId: value.runId,
    draftArtifactId: value.draftArtifactId,
    draftContentHash: value.draftContentHash,
    validationArtifactIds: value.validationArtifactIds,
    validationContentHashes: value.validationContentHashes,
    guideArtifactId: value.guideArtifactId,
    guideContentHash: value.guideContentHash,
    createdAt: value.createdAt,
  })).slice(0, 12)}`;
  if (value.id !== expectedId) issues.push("Experience review package id does not match its content");
  let draft: ExperienceReviewArtifactView | null = null;
  const validations: ExperienceReviewArtifactView[] = [];
  let guide: ExperienceReviewArtifactView | null = null;
  try {
    if (value.draftArtifactId) {
      const artifact = requireArtifact(home, store, value.draftArtifactId, "knowledge-candidate-draft", candidate.scope);
      if (artifact.contentHash !== value.draftContentHash) issues.push("Experience review draft hash mismatch");
      draft = artifactView(artifact);
    }
    if (value.validationArtifactIds.length === 0 || value.validationArtifactIds.length !== value.validationContentHashes.length) {
      issues.push("Experience review validation Artifact contract is incomplete");
    }
    for (let index = 0; index < value.validationArtifactIds.length; index += 1) {
      const artifact = requireArtifact(home, store, value.validationArtifactIds[index], "knowledge-candidate-validation", candidate.scope);
      if (artifact.contentHash !== value.validationContentHashes[index]) issues.push(`Experience review validation hash mismatch: ${artifact.id}`);
      validations.push(artifactView(artifact));
    }
    const guideArtifact = requireArtifact(home, store, value.guideArtifactId, "knowledge-review-guide", candidate.scope);
    if (guideArtifact.contentHash !== value.guideContentHash) issues.push("Experience review guide hash mismatch");
    guide = artifactView(guideArtifact);
    const runIds = unique([...(draft ? [store.requireArtifact(draft.id).runId] : []), ...validations.map((artifact) => store.requireArtifact(artifact.id).runId), store.requireArtifact(guide.id).runId]);
    if (runIds.length !== 1 || runIds[0] !== value.runId) issues.push("Experience review package Run binding mismatch");
    assertCuratorRun(store, value.runId);
    validateDraft(home, store, candidate, value.mode, draft?.path, value.primaryKnowledgeId ?? undefined, { requireCurrent: false });
    validateReviewDocuments(
      candidate,
      draft ? store.requireArtifact(draft.id) : null,
      validations.map((artifact) => store.requireArtifact(artifact.id)),
      store.requireArtifact(guide.id),
    );
  } catch (error) {
    issues.push((error as Error).message);
  }
  if (issues.length > 0 || !guide) return { package: null, issues: unique(issues) };
  const packageView = { package: value, path, draft, validations, guide };
  try {
    return { package: { ...packageView, confirmationBrief: writeCandidateConfirmationBrief(home, candidate, packageView) }, issues: [] };
  } catch (error) {
    return { package: null, issues: [(error as Error).message] };
  }
}

/** The human entrance is derived only after the package has passed every
 * artifact, scope, Run, and hash check. Its appendix retains machine bindings. */
function writeCandidateConfirmationBrief(
  home: string,
  candidate: ExperienceKnowledgeCandidate,
  review: Omit<ExperienceReviewPackageView, "confirmationBrief">,
): HumanConfirmationBrief {
  const correction = candidate.changeTypes.some((changeType) => changeType === "revise" || changeType === "retire");
  const title = `Knowledge 候选确认：${candidate.title}`;
  const purpose = correction
    ? "请确认是否采用以下完整候选内容及其适用范围、边界；确认只会推进这一个 Candidate 的 Knowledge 修订事务。"
    : "请确认是否将以下完整候选内容纳入 Knowledge；确认只会推进这一个 Candidate 的 Knowledge 创建事务。";
  const item = candidateConfirmationItem(home, candidate, review, "A");
  const briefIdentity = sha256(JSON.stringify({
    schema: HUMAN_CONFIRMATION_BRIEF_SCHEMA,
    renderVersion: HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION,
    scope: candidate.scope,
    title,
    purpose,
    item,
    candidateId: candidate.id,
    candidateContentHash: candidate.contentHash,
    reviewPackageId: review.package.id,
    draftContentHash: review.package.draftContentHash,
    validationContentHashes: review.package.validationContentHashes,
    guideContentHash: review.package.guideContentHash,
  })).slice(0, 12);
  return writeHumanConfirmationBrief(home, {
    id: `candidate-${review.package.id}-${briefIdentity}`,
    scope: candidate.scope,
    title,
    purpose,
    items: [item],
  });
}

function candidateConfirmationItem(
  home: string,
  candidate: ExperienceKnowledgeCandidate,
  review: Omit<ExperienceReviewPackageView, "confirmationBrief"> | ExperienceReviewPackageView,
  key: string,
): HumanConfirmationBriefItem {
  const parsed = review.draft
    ? parseKnowledge(readRegularFile(review.draft.path, "Experience review draft"), review.draft.path)
    : null;
  const draftContent = parsed?.body ?? "本候选只退役现有 Knowledge，不包含替代完整稿。";
  const correction = candidate.changeTypes.some((changeType) => changeType === "revise" || changeType === "retire");
  const principle = candidate.candidateKnowledge.type === "principle";
  return {
    key,
    title: candidate.title,
    content: `以下是已审阅的完整候选内容：\n\n${draftContent}`,
    triggers: firstValues(
      sectionValues(markdownSection(draftContent, ["triggers"])),
      splitCandidateField(candidate.candidateKnowledge.applicability),
    ),
    boundaries: firstValues(
      sectionValues(markdownSection(draftContent, ["exceptions", "boundary", "边界"])),
      splitCandidateField(`${candidate.candidateKnowledge.boundary}；${candidate.candidateKnowledge.useContract}`),
    ),
    retirementSignals: firstValues(
      sectionValues(markdownSection(draftContent, ["retirement_signals", "retirement signals"])),
      splitCandidateField(candidate.candidateKnowledge.validationPlan),
    ),
    confirmEffect: `${correction
      ? "该项 Candidate 进入已接受状态，后续仅可按已绑定的完整稿推进对应 Knowledge 修订。"
      : "该项 Candidate 进入已接受状态，后续仅可按已绑定的完整稿创建对应 Knowledge。"}${principle ? " 确认本身不自动激活 Principle，也不修改 AGENTS。" : ""}`,
    rejectEffect: "该项 Candidate 进入已驳回状态，不会写入或修改 Knowledge；可基于新证据另建候选。",
    // Keep the confirmation bytes stable if an IKB root is relocated; the
    // path remains an audit reference, but is expressed inside that root.
    proposalPath: review.draft ? relative(resolve(home), review.draft.path) : null,
    proposalHash: review.draft?.contentHash ?? null,
    sourceRefs: [
      `experience-candidate:${candidate.id}`,
      ...candidate.sourceRecordRefs,
      ...candidate.evidenceEventIds,
      `artifact:${review.package.guideArtifactId}`,
      ...(review.package.draftArtifactId ? [`artifact:${review.package.draftArtifactId}`] : []),
      ...review.package.validationArtifactIds.map((id) => `artifact:${id}`),
    ],
  };
}

function markdownSection(text: string, names: string[]): string {
  const headings = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`^#{1,6}\\s*(?:${headings})\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|(?![\\s\\S]))`, "im"));
  return match?.[1]?.trim() ?? "";
}

function sectionValues(value: string): string[] {
  return value.split("\n").map(normalizeListValue).filter(Boolean);
}

function splitCandidateField(value: string): string[] {
  return value.split(/[；\n]/u).map(normalizeListValue).filter(Boolean);
}

function normalizeListValue(value: string): string {
  return value.replace(/^(?:(?:[-*+]|\d+\.)\s+)+/u, "").trim();
}

function firstValues(...groups: string[][]): string[] {
  return groups.find((group) => group.length > 0) ?? ["未知"];
}

function validateDraft(
  home: string,
  store: LedgerStore,
  candidate: ExperienceKnowledgeCandidate,
  mode: ExperienceReviewPackage["mode"],
  draftPath?: string,
  requestedPrimary?: string,
  options: { requireCurrent?: boolean } = {},
): string | null {
  if (mode === "retire") {
    if (draftPath) throw new Error("A retire-only Experience review package must not include a replacement draft");
    if (requestedPrimary) throw new Error("A retire-only Experience review package does not accept a primary Knowledge id");
    return null;
  }
  if (!draftPath) throw new Error(`A ${mode} Experience review package requires a complete Knowledge draft Artifact`);
  const parsed = parseKnowledge(readRegularFile(draftPath, "Experience review draft"), draftPath);
  if (parsed.qualityVersion < 4) throw new Error("Experience review draft must use quality_version >= 4");
  if (options.requireCurrent && parsed.qualityVersion < 5) throw new Error("New Experience review drafts must use quality_version >= 5 and bind a V3 information-loss report");
  if (parsed.status !== "draft") throw new Error("Experience review draft must remain draft");
  if (parsed.scope !== candidate.scope) throw new Error("Experience review draft scope does not match Candidate");
  if (parsed.type !== candidate.candidateKnowledge.type || parsed.collection !== candidate.candidateKnowledge.collection) {
    throw new Error("Experience review draft type or collection does not match Candidate");
  }
  const candidateRef = `experience-candidate:${candidate.id}`;
  if (!parsed.sourceRefs.includes(candidateRef)) throw new Error(`Experience review draft source_refs must include ${candidateRef}`);
  assertKnowledgeQuality(parsed, { requireAdmission: isSourceDerived(parsed) });
  if (parsed.qualityVersion >= 5) validateLowLossDraft(home, store, candidate, mode, parsed);
  if (mode === "create") {
    if (requestedPrimary) throw new Error("A new Knowledge review package does not accept a primary Knowledge id");
    if (findKnowledge(home, parsed.id)) throw new Error(`A new Knowledge review package cannot reuse existing Knowledge id ${parsed.id}`);
    return null;
  }
  const targets = unique(candidate.targetKnowledgeIds);
  const primary = requestedPrimary ?? (targets.length === 1 ? targets[0] : undefined);
  if (!primary || !targets.includes(primary)) throw new Error("A multi-target revision review package requires a valid primary Knowledge id");
  if (parsed.id !== primary) throw new Error(`Experience review draft id ${parsed.id} must match revision primary ${primary}`);
  const targetShapes = unique(targets.map((id) => {
    const target = findKnowledge(home, id);
    if (!target) throw new Error(`Experience review revision target not found: ${id}`);
    if (target.scope !== candidate.scope) throw new Error(`Experience review revision target scope mismatch: ${id}`);
    return `${target.type}|${target.collection}`;
  }));
  if (targetShapes.length !== 1) throw new Error("Experience review revision targets have conflicting Knowledge shapes");
  if (targetShapes[0] !== `${candidate.candidateKnowledge.type}|${candidate.candidateKnowledge.collection}`) {
    throw new Error("Experience review revision target type or collection does not match Candidate");
  }
  return primary;
}

function validateLowLossDraft(
  home: string,
  store: LedgerStore,
  candidate: ExperienceKnowledgeCandidate,
  mode: ExperienceReviewPackage["mode"],
  draft: KnowledgeRecord,
): void {
  if (draft.compilationSchema !== EXTRACTION_RESULT_VERSION) {
    throw new Error(`Experience review draft compilation_schema must be ${EXTRACTION_RESULT_VERSION}`);
  }
  const manifestArtifact = requireArtifact(home, store, draft.extractionManifestRef!, "knowledge-extraction-manifest", candidate.scope);
  const resultArtifact = requireArtifact(home, store, draft.compilationRef!, "knowledge-extraction-result", candidate.scope);
  const fidelityArtifact = requireArtifact(home, store, draft.informationLossRef!, "knowledge-extraction-fidelity", candidate.scope);
  const manifest = readJson(manifestArtifact.path, `Extraction manifest ${manifestArtifact.id}`);
  // Keep the manifest Artifact byte-for-byte immutable.  The copied value is
  // solely a local filesystem view for a project-root relocation.
  const localManifest = resolveFrozenSnapshotPaths(manifest, store);
  assertFrozenSnapshotsWithinHome(home, localManifest);
  const resultsValue = readJson(resultArtifact.path, `Extraction result ${resultArtifact.id}`);
  const results = normalizeExtractionResults(resultsValue);
  const report = verifyExtractionBatch(localManifest, results);
  const storedReport = readJson(fidelityArtifact.path, `Information loss report ${fidelityArtifact.id}`);
  if (stableJson(storedReport) !== stableJson(report)) {
    throw new Error("Experience review stored information loss report does not match recomputed fidelity");
  }
  if (report.schema !== EXTRACTION_FIDELITY_VERSION || !report.valid) {
    throw new Error("Experience review V3 information loss report is not valid");
  }
  const verdict = report.verdicts.find((item) => item.caseId === draft.compilationCaseId);
  if (!verdict || verdict.legacy || !verdict.publishable || verdict.disposition !== "admit") {
    throw new Error(`Experience review extraction case is not publishable: ${draft.compilationCaseId}`);
  }
  const result = results.flatMap((value) => value && typeof value === "object" ? [value as Record<string, unknown>] : [])
    .find((value) => String(value.case_id ?? "") === draft.compilationCaseId);
  if (!result || String(result.schema ?? "") !== draft.compilationSchema) {
    throw new Error(`Experience review compilation case does not match draft: ${draft.compilationCaseId}`);
  }
  const products = Array.isArray(result.products) ? result.products : [];
  const product = products.flatMap((value) => value && typeof value === "object" ? [value as Record<string, unknown>] : [])
    .find((value) => String(value.product_id ?? "") === draft.compilationProductId);
  if (!product) throw new Error(`Experience review compilation product not found: ${draft.compilationProductId}`);
  if (String(product.canonical_key ?? "") !== draft.canonicalKey) throw new Error("Experience review canonical_key does not match the validated product");
  if (String(product.product_type ?? "") !== draft.productType) throw new Error("Experience review product_type does not match the validated product");
  if (!sameStrings(product.fact_refs, draft.factRefs)) throw new Error("Experience review fact_refs do not match the validated product");
  if (!sameStrings(product.questions_answered, draft.questionsAnswered)) throw new Error("Experience review questions_answered do not match the validated product");
  const operation = String(product.operation ?? "");
  if ((mode === "create" && operation !== "new") || (mode === "revision" && !["revise", "merge"].includes(operation))) {
    throw new Error(`Experience review product operation ${operation} does not match ${mode}`);
  }
  const expectedBody = renderKnowledgeProductBody(result, draft.compilationCaseId!, draft.compilationProductId!);
  if (draft.body !== expectedBody) {
    throw new Error("Experience review draft body does not exactly match the deterministic product view");
  }
}

function normalizeExtractionResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).results)) {
    return (value as Record<string, unknown>).results as unknown[];
  }
  return [value];
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readRegularFile(path, label));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStrings(value: unknown, expected: string[] | undefined): boolean {
  if (!Array.isArray(value)) return false;
  const left = [...new Set(value.map((item) => String(item)))].sort();
  const right = [...new Set(expected ?? [])].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function resolveFrozenSnapshotPaths(manifest: unknown, store: LedgerStore): unknown {
  if (!manifest || typeof manifest !== "object") return manifest;
  const local = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  const cases = Array.isArray(local.cases) ? local.cases : [];
  for (const current of cases) {
    if (!current || typeof current !== "object") continue;
    const snapshots = Array.isArray((current as Record<string, unknown>).source_snapshots)
      ? (current as Record<string, unknown>).source_snapshots as unknown[]
      : [];
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const path = (snapshot as Record<string, unknown>).path;
      if (typeof path === "string") (snapshot as Record<string, unknown>).path = store.resolveStoragePath(path);
    }
  }
  return local;
}

function assertFrozenSnapshotsWithinHome(home: string, manifest: unknown): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Extraction manifest must be an object");
  const cases = Array.isArray((manifest as Record<string, unknown>).cases) ? (manifest as Record<string, unknown>).cases as unknown[] : [];
  for (const current of cases) {
    if (!current || typeof current !== "object") continue;
    const snapshots = Array.isArray((current as Record<string, unknown>).source_snapshots)
      ? (current as Record<string, unknown>).source_snapshots as unknown[]
      : [];
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const path = String((snapshot as Record<string, unknown>).path ?? "");
      assertExistingPathWithinHome(home, path, "Extraction frozen Source snapshot");
    }
  }
}

function reviewMode(candidate: ExperienceKnowledgeCandidate): ExperienceReviewPackage["mode"] {
  const changes = unique(candidate.changeTypes);
  if (changes.length === 1 && changes[0] === "new") return "create";
  if (!changes.includes("new") && changes.includes("revise")) return "revision";
  if (changes.length === 1 && changes[0] === "retire") return "retire";
  throw new Error(`Experience Candidate ${candidate.id} has an ambiguous change mode: ${changes.join(", ")}`);
}

function requireArtifact(home: string, store: LedgerStore, id: string, kind: string, scope: string) {
  const artifact = store.getArtifact(id);
  if (!artifact || !artifact.contentHash) throw new Error(`Experience review Artifact is not registered and hashed: ${id}`);
  if (artifact.kind !== kind) throw new Error(`Experience review Artifact ${id} must have kind ${kind}`);
  const run = store.getRun(artifact.runId);
  const task = run ? store.getTask(run.taskId) : null;
  if (!run || !task || task.scope !== scope) throw new Error(`Experience review Artifact ${id} does not belong to a same-scope Task/Run`);
  assertExistingPathWithinHome(home, artifact.path, `Experience review Artifact ${id}`);
  const content = readRegularFile(artifact.path, `Experience review Artifact ${id}`);
  if (sha256(content) !== artifact.contentHash) throw new Error(`Experience review Artifact hash changed: ${id}`);
  return artifact;
}

function assertCuratorRun(store: LedgerStore, runId: string): void {
  const run = store.getRun(runId);
  const skillIds = String(run?.skillIds ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!run || !skillIds.includes("ikb-knowledge-curator")) {
    throw new Error(`Experience review package Run ${runId} must use ikb-knowledge-curator`);
  }
}

function validateReviewDocuments(
  candidate: ExperienceKnowledgeCandidate,
  draft: ReturnType<LedgerStore["requireArtifact"]> | null,
  validations: Array<ReturnType<LedgerStore["requireArtifact"]>>,
  guide: ReturnType<LedgerStore["requireArtifact"]>,
): void {
  const guideText = readRegularFile(guide.path, `Experience review guide ${guide.id}`);
  if (!guideText.includes(candidate.id)) throw new Error(`Experience review guide must identify Candidate ${candidate.id}`);
  if (!/待确认|你确认的是什么|需要你决定什么/u.test(guideText) || !/^\s*1[.)]\s+/mu.test(guideText)) {
    throw new Error("Experience review guide must contain a concrete numbered confirmation list");
  }
  if (!/确认后|接受后|接受只表示|驳回|不表示|不授权/u.test(guideText)) {
    throw new Error("Experience review guide must explain what happens after the user's decision");
  }
  const validationTexts: string[] = [];
  for (const validation of validations) {
    const text = readRegularFile(validation.path, `Experience review validation ${validation.id}`);
    validationTexts.push(text);
    if (!text.includes(candidate.id) || !text.includes(candidate.contentHash)) {
      throw new Error(`Experience review validation ${validation.id} must bind the current Candidate id and content hash`);
    }
    if (draft?.contentHash && !text.includes(draft.contentHash)) {
      throw new Error(`Experience review validation ${validation.id} must bind the complete draft content hash`);
    }
  }
  assertPrincipleResponsibility(candidate, validationTexts);
}

function assertPrincipleResponsibility(candidate: ExperienceKnowledgeCandidate, validationTexts: string[]): void {
  if (candidate.candidateKnowledge.type !== "principle") return;
  const assessments = validationTexts.flatMap((text) => {
    const owner = text.match(/^Principle responsibility owner:\s*(human_policy|deterministic_contract|mixed)\s*$/mi)?.[1];
    return owner ? [{ owner, text }] : [];
  });
  if (assessments.length === 0) {
    throw new Error("Principle review requires one current-code responsibility assessment");
  }
  if (assessments.length !== 1) {
    throw new Error("Principle review requires exactly one current-code responsibility assessment");
  }
  const [{ owner, text }] = assessments;
  const rationale = text.match(/^Principle responsibility rationale:\s*(.+)$/mi)?.[1]?.trim();
  const evidence = text.match(/^Principle responsibility evidence:\s*(.+)$/mi)?.[1]?.trim();
  if (!rationale || !evidence) {
    throw new Error("Principle responsibility assessment requires rationale and current-code evidence");
  }
  if (owner !== "human_policy") {
    throw new Error(`Principle responsibility owner ${owner} must be resolved as code work or a narrower Candidate before human confirmation`);
  }
}

function artifactView(artifact: ReturnType<LedgerStore["requireArtifact"]>): ExperienceReviewArtifactView {
  return { id: artifact.id, kind: artifact.kind, label: artifact.label, path: artifact.path, contentHash: artifact.contentHash! };
}

function readPackage(path: string): ExperienceReviewPackage {
  const value = JSON.parse(readRegularFile(path, "Experience review package")) as ExperienceReviewPackage;
  if (!value || typeof value !== "object" || value.schema !== EXPERIENCE_REVIEW_PACKAGE_VERSION || typeof value.id !== "string"
    || typeof value.candidateId !== "string" || typeof value.candidateContentHash !== "string" || !["personal", "work"].includes(value.scope)
    || !["create", "revision", "retire"].includes(value.mode) || typeof value.runId !== "string"
    || ![null, "string"].includes(value.primaryKnowledgeId === null ? null : typeof value.primaryKnowledgeId)
    || ![null, "string"].includes(value.draftArtifactId === null ? null : typeof value.draftArtifactId)
    || ![null, "string"].includes(value.draftContentHash === null ? null : typeof value.draftContentHash)
    || !Array.isArray(value.validationArtifactIds) || value.validationArtifactIds.some((id) => typeof id !== "string")
    || !Array.isArray(value.validationContentHashes) || value.validationContentHashes.some((hash) => typeof hash !== "string")
    || typeof value.guideArtifactId !== "string" || typeof value.guideContentHash !== "string" || typeof value.createdAt !== "string") {
    throw new Error(`Invalid Experience review package: ${path}`);
  }
  return value;
}

function ensureReviewEvent(store: LedgerStore, review: ExperienceReviewPackage): void {
  const exists = store.listEvents().some((event) => event.aggregateType === "experience" && event.aggregateId === review.candidateId
    && event.eventType === "experience.candidate_review_registered" && event.payload.reviewPackageId === review.id);
  if (exists) return;
  store.recordExperienceEvent(review.candidateId, "experience.candidate_review_registered", {
    schema: review.schema,
    reviewPackageId: review.id,
    candidateContentHash: review.candidateContentHash,
    mode: review.mode,
    runId: review.runId,
    draftArtifactId: review.draftArtifactId,
    validationArtifactIds: review.validationArtifactIds,
    guideArtifactId: review.guideArtifactId,
    primaryKnowledgeId: review.primaryKnowledgeId,
    draftContentHash: review.draftContentHash,
    validationContentHashes: review.validationContentHashes,
    guideContentHash: review.guideContentHash,
  });
}

function reviewPackageRoot(home: string): string { return join(resolve(home), "experiences", "review-packages"); }
function reviewPackageDirectory(home: string, candidateId: string, contentHash: string): string {
  return join(reviewPackageRoot(home), candidateId, contentHash);
}
function ensureDirectory(home: string, path: string): void {
  const root = resolve(home);
  const target = resolve(path);
  const remainder = relative(root, target);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) throw new Error("Experience review package directory must stay inside IKB home");
  let cursor = root;
  for (const part of remainder.split(/[\\/]+/u)) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Experience review package directory component is invalid: ${cursor}`);
    } else {
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
  assertExistingPathWithinHome(home, path, "Experience review package directory");
  chmodSync(path, 0o700);
}
function writePrivateJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); chmodSync(path, 0o600); }
function readRegularFile(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
  return readFileSync(path, "utf8");
}
function assertExistingPathWithinHome(home: string, path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  const root = realpathSync(resolve(home));
  const actual = realpathSync(resolve(path));
  const remainder = relative(root, actual);
  if (!remainder || remainder.startsWith("..") || isAbsolute(remainder)) throw new Error(`${label} must stay inside IKB home`);
}
function assertCandidateStorageKey(candidate: ExperienceKnowledgeCandidate): void {
  if (!/^exp-cand-[a-z0-9-]+$/u.test(candidate.id)) throw new Error(`Invalid Experience Candidate id for review storage: ${candidate.id}`);
  if (!/^[a-f0-9]{64}$/u.test(candidate.contentHash)) throw new Error(`Invalid Experience Candidate content hash: ${candidate.id}`);
}
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
