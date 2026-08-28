/**
 * Public Knowledge API.
 *
 * Domain implementations live under src/knowledge/. Keeping this file as a
 * compatibility facade gives callers one stable import path without turning
 * the facade into a second owner of domain state or behavior.
 */
export { resolveVault } from "./layout.ts";
export {
  KNOWLEDGE_CANDIDATE_TYPES,
  KNOWLEDGE_DIRECTORIES,
  type KnowledgeArchiveResult,
  type KnowledgeCandidateType,
  type KnowledgeDirectory,
  type KnowledgeInput,
  type KnowledgeLayoutInspection,
  type KnowledgeMigrationItem,
  type KnowledgeMigrationResult,
  type KnowledgeQualityIssue,
  type KnowledgeQualityIssueCode,
  type KnowledgeViewSummary,
} from "./knowledge/contracts.ts";
export { knowledgeDirectoryForType, resolveKnowledgeDirectory } from "./knowledge/catalog.ts";
export { knowledgeRetrievalEligibility, knowledgeRetrievalEligibilityAtHome } from "./knowledge/eligibility.ts";
export { assertPrincipleActivationReady, inspectPrincipleConfirmation, type PrincipleConfirmationIssue } from "./knowledge/principle-admission.ts";
export {
  checkPrincipleProjections,
  defaultPrincipleProjectionManifestPath,
  inspectAgentProjection,
  readPrincipleProjectionManifest,
  renderPrincipleProjectionBlock,
  writePrincipleProjectionReport,
  PRINCIPLE_PROJECTION_MANIFEST_VERSION,
  type AgentProjectionInspection,
  type PrincipleProjectionCheckResult,
  type PrincipleProjectionIssue,
  type PrincipleProjectionIssueCode,
  type PrincipleProjectionManifest,
  type PrincipleProjectionMapping,
} from "./knowledge/principle-projection.ts";
export { assertKnowledgeQuality, inspectKnowledgeQuality } from "./knowledge/quality.ts";
export { PERSONAL_FORMAL_QUALITY_VERSION, inspectPersonalAdmission, isPersonalAdmissionReady } from "./knowledge/personal-admission.ts";
export { findKnowledge, listKnowledge, reviewKnowledge, searchKnowledge } from "./knowledge/records.ts";
export { initializeKnowledgeLayout, rebuildKnowledgeViews } from "./knowledge/views.ts";
export { assertActiveCanonicalKeyAvailable, buildContextPack, captureKnowledge, ingestKnowledge, installReviewedKnowledge, relateKnowledge, updateKnowledgeStatus } from "./knowledge/repository.ts";
export { archiveRetiredKnowledge, completeKnowledgeMigration, inspectKnowledgeLayout, migrateLegacyKnowledge } from "./knowledge/lifecycle.ts";
export {
  applyAcceptedNewKnowledgeCandidate,
  applyKnowledgeCandidate,
  type KnowledgeCandidateApplicationResult,
  type NewKnowledgeCandidateApplicationResult,
} from "./knowledge/candidate-application.ts";
export { applyReviewedQv5KnowledgeRevision, preflightReviewedQv5KnowledgeRevision, resolveQv5KnowledgeCorrectionHold, QV5_REVISION_VERSION, type Qv5KnowledgeRevisionJournal } from "./knowledge/qv5-revision.ts";
export {
  applyQv5KnowledgeRevisionBatch,
  parseQv5KnowledgeRevisionBatchPlan,
  QV5_BATCH_PLAN_VERSION,
  QV5_BATCH_STATE_VERSION,
  type Qv5KnowledgeRevisionBatchEntry,
  type Qv5KnowledgeRevisionBatchPlan,
  type Qv5KnowledgeRevisionBatchResult,
  type Qv5KnowledgeRevisionBatchState,
} from "./knowledge/qv5-batch.ts";
export {
  applyKnowledgeCandidateRevision,
  applyPreparedKnowledgeRevision,
  findKnowledgeRevision,
  listKnowledgeRevisions,
  pendingKnowledgeRevisionJournals,
  prepareKnowledgeCandidateRevision,
  requestKnowledgeCorrection,
  KNOWLEDGE_REVISION_VERSION,
  type KnowledgeCorrectionAction,
  type KnowledgeCorrectionRequestInput,
  type KnowledgeRevisionJournal,
  type KnowledgeRevisionResult,
} from "./knowledge/revision.ts";
export { requestPrincipleAdmission, type PrincipleAdmissionRequestInput } from "./experience.ts";
