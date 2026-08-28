import type { KnowledgeConfidence, KnowledgeTemporalState, KnowledgeVerification } from "../types.ts";

export const KNOWLEDGE_DIRECTORIES = [
  "domains", "projects", "people", "concepts", "decisions", "principles", "playbooks", "lessons", "syntheses",
] as const;
export type KnowledgeDirectory = typeof KNOWLEDGE_DIRECTORIES[number];

/**
 * Formal Knowledge types that the Experience -> Candidate lifecycle can
 * propose.  The repository still reads legacy free-form types, but a new
 * Candidate must choose one explicit consumer-facing type instead of falling
 * back to a generic lesson or synthesis.
 */
export const KNOWLEDGE_CANDIDATE_TYPES = [
  "architecture",
  "decision",
  "entity",
  "fact",
  "goal",
  "lesson",
  "playbook",
  "preference",
  "principle",
  "synthesis",
] as const;
export type KnowledgeCandidateType = typeof KNOWLEDGE_CANDIDATE_TYPES[number];

export interface KnowledgeMigrationItem {
  id: string;
  scope: string;
  type: string;
  collection: KnowledgeDirectory;
  from: string;
  to: string;
}

export interface KnowledgeMigrationResult {
  moved: KnowledgeMigrationItem[];
  remainingLegacyFiles: string[];
  journalPath: string | null;
  recovered: boolean;
}

export interface KnowledgeViewSummary {
  scope: string;
  vault: string;
  indexPath: string;
  statusPath: string;
  total: number;
  draft: number;
  verified: number;
  retired: number;
  dueForReview: number;
  legacy: number;
}

export interface KnowledgeArchiveResult {
  scope: string;
  archived: Array<{ id: string; title: string; from: string; to: string }>;
  skipped: Array<{ id: string; title: string; path: string; reason: string }>;
  manifestPath: string;
}

export interface KnowledgeLayoutInspection {
  ok: boolean;
  missingPaths: string[];
  legacyFiles: string[];
  duplicateIds: string[];
  misplacedFiles: string[];
  invalidFiles: string[];
  scopeMismatchFiles: string[];
  pendingMigrationJournals: string[];
  pendingRevisionJournals: string[];
  qualityIssues: KnowledgeQualityIssue[];
}

export type KnowledgeQualityIssueCode =
  | "body_empty" | "literal_escaped_newline" | "source_refs_missing"
  | "revision_invalid" | "revision_history_invalid" | "superseded_by_invalid"
  | "admission_reason_missing" | "applicability_missing" | "boundary_missing"
  | "verified_source_refs_missing" | "confidence_invalid" | "confidence_basis_missing"
  | "temporal_state_invalid" | "verification_invalid" | "use_when_missing"
  | "use_inputs_missing" | "use_outputs_missing" | "use_steps_missing"
  | "use_checks_missing" | "use_stop_conditions_missing"
  | "product_type_missing" | "compilation_ref_missing" | "fact_refs_missing"
  | "canonical_key_missing" | "canonical_key_scope_mismatch"
  | "compilation_schema_missing" | "compilation_schema_unsupported"
  | "compilation_case_id_missing" | "compilation_product_id_missing"
  | "extraction_manifest_ref_missing" | "information_loss_ref_missing"
  | "active_canonical_key_duplicate"
  | "questions_answered_missing" | "person_do_not_use_for_missing"
  | "person_counterevidence_search_missing" | "person_source_count_insufficient"
  | "person_date_count_insufficient"
  | "person_identity_confidence_missing" | "person_identity_confidence_insufficient"
  | "person_pattern_confidence_missing" | "person_pattern_confidence_insufficient"
  | "person_episode_count_insufficient" | "person_verification_insufficient"
  | "personal_quality_version_insufficient" | "personal_source_refs_missing"
  | "personal_admission_reason_missing" | "personal_applicability_missing"
  | "personal_boundary_missing" | "personal_temporal_state_missing"
  | "personal_type_unsupported" | "personal_preference_evidence_insufficient"
  | "personal_goal_verification_insufficient"
  | "personal_decision_counterevidence_search_missing"
  | "personal_decision_verification_insufficient"
  | "personal_playbook_product_type_mismatch"
  | "personal_playbook_verification_insufficient"
  | "personal_lesson_episode_missing"
  | "personal_lesson_verification_insufficient"
  | "personal_synthesis_fact_refs_insufficient"
  | "personal_synthesis_verification_insufficient"
  | "personal_fact_confidence_insufficient"
  | "principle_quality_version_insufficient"
  | "principle_product_type_mismatch"
  | "principle_verification_insufficient"
  | "memory_topic_confidence_insufficient"
  | "memory_topic_temporal_state_unresolved"
  | "principle_confirmation_chain_invalid";

export interface KnowledgeQualityIssue {
  knowledgeId: string;
  path: string;
  code: KnowledgeQualityIssueCode;
  detail: string;
}

export interface KnowledgeInput {
  title: string;
  type?: string;
  collection?: string;
  sourceKind?: string;
  scope?: string;
  sensitivity?: string;
  status?: "draft" | "verified" | "retired";
  sourceRefs?: string[];
  tags?: string[];
  aliases?: string[];
  related?: string[];
  derivedFrom?: string[];
  contradicts?: string[];
  qualityVersion?: number;
  productType?: string;
  canonicalKey?: string;
  compilationSchema?: string;
  compilationCaseId?: string;
  compilationProductId?: string;
  extractionManifestRef?: string;
  compilationRef?: string;
  informationLossRef?: string;
  factRefs?: string[];
  questionsAnswered?: string[];
  admissionReason?: string;
  applicability?: string;
  boundary?: string;
  useWhen?: string;
  useInputs?: string[];
  useOutputs?: string[];
  useSteps?: string[];
  useChecks?: string[];
  useStopConditions?: string[];
  confidence?: KnowledgeConfidence;
  confidenceBasis?: string[];
  temporalState?: KnowledgeTemporalState;
  verification?: KnowledgeVerification;
  identityConfidence?: KnowledgeConfidence;
  patternConfidence?: KnowledgeConfidence;
  independentEpisodeCount?: number;
  independentSourceCount?: number;
  distinctDateCount?: number;
  counterevidenceRefs?: string[];
  counterevidenceSearch?: string;
  doNotUseFor?: string[];
  body: string;
}
