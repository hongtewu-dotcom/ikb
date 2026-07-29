/**
 * Public Knowledge API.
 *
 * Domain implementations live under src/knowledge/. Keeping this file as a
 * compatibility facade gives callers one stable import path without turning
 * the facade into a second owner of domain state or behavior.
 */
export { resolveVault } from "./layout.ts";
export {
  KNOWLEDGE_DIRECTORIES,
  type KnowledgeArchiveResult,
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
export { assertKnowledgeQuality, inspectKnowledgeQuality } from "./knowledge/quality.ts";
export { PERSONAL_FORMAL_QUALITY_VERSION, inspectPersonalAdmission, isPersonalAdmissionReady } from "./knowledge/personal-admission.ts";
export { findKnowledge, listKnowledge, reviewKnowledge, searchKnowledge } from "./knowledge/records.ts";
export { initializeKnowledgeLayout, rebuildKnowledgeViews } from "./knowledge/views.ts";
export { buildContextPack, captureKnowledge, ingestKnowledge, relateKnowledge, updateKnowledgeStatus } from "./knowledge/repository.ts";
export { archiveRetiredKnowledge, completeKnowledgeMigration, inspectKnowledgeLayout, migrateLegacyKnowledge } from "./knowledge/lifecycle.ts";
