import type { KnowledgeConfidence, KnowledgeTemporalState, KnowledgeVerification } from "../types.ts";

export const KNOWLEDGE_DIRECTORIES = [
  "domains", "projects", "people", "concepts", "decisions", "playbooks", "lessons", "syntheses",
] as const;
export type KnowledgeDirectory = typeof KNOWLEDGE_DIRECTORIES[number];

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
  qualityIssues: KnowledgeQualityIssue[];
}

export type KnowledgeQualityIssueCode =
  | "body_empty" | "literal_escaped_newline" | "source_refs_missing"
  | "admission_reason_missing" | "applicability_missing" | "boundary_missing"
  | "verified_source_refs_missing" | "confidence_invalid" | "confidence_basis_missing"
  | "temporal_state_invalid" | "verification_invalid" | "use_when_missing"
  | "use_inputs_missing" | "use_outputs_missing" | "use_steps_missing"
  | "use_checks_missing" | "use_stop_conditions_missing"
  | "person_identity_confidence_missing" | "person_identity_confidence_insufficient"
  | "person_pattern_confidence_missing" | "person_pattern_confidence_insufficient"
  | "person_episode_count_insufficient" | "person_verification_insufficient";

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
  body: string;
}
