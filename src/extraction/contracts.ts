export const EXTRACTION_MANIFEST_VERSION = "ikb-knowledge-extraction-benchmark.v2";
export const EXTRACTION_RESULT_VERSION = "ikb-knowledge-compilation-result.v2";
export const EXTRACTION_VALIDATION_VERSION = "ikb-knowledge-extraction-validation.v2";
export const EXTRACTION_FIDELITY_VERSION = "ikb-knowledge-fidelity-report.v1";

export type JsonObject = Record<string, unknown>;

export interface ExtractionValidationIssue {
  code: string;
  caseId: string | null;
  path: string;
  message: string;
}

export interface ExtractionValidationReport {
  schema: typeof EXTRACTION_VALIDATION_VERSION;
  benchmarkId: string;
  valid: boolean;
  expectedCaseCount: number;
  caseCount: number;
  issues: ExtractionValidationIssue[];
}

export interface ExtractionFidelityVerdict {
  caseId: string;
  disposition: "admit" | "skip" | "invalid";
  publishable: boolean;
  checks: {
    evidenceIntegrity: boolean;
    coreCoverage: boolean;
    claimSupport: boolean;
    typeShape: boolean;
    personSelectivity: boolean;
  };
}

export interface ExtractionFidelityReport {
  schema: typeof EXTRACTION_FIDELITY_VERSION;
  benchmarkId: string;
  valid: boolean;
  expectedCaseCount: number;
  caseCount: number;
  publishableCount: number;
  retainedOnlyCount: number;
  verdicts: ExtractionFidelityVerdict[];
  issues: ExtractionValidationIssue[];
}

export const CLAIM_KINDS = new Set([
  "direct_fact",
  "attributed_statement",
  "decision",
  "synthesis",
  "inference",
  "unknown",
]);

export const FACT_DERIVATIONS = new Set(["direct", "synthesis", "inference"]);
export const FACT_IMPORTANCE = new Set(["core", "supporting", "context"]);
export const TEMPORAL_STATES = new Set([
  "current",
  "historical",
  "planned",
  "superseded",
  "conflicted",
  "unknown",
]);
export const ATTRIBUTION_ROLES = new Set([
  "speaker",
  "author",
  "creator",
  "owner",
  "modifier",
  "reviewer",
  "record_actor",
  "system",
  "context",
]);

export const PRODUCT_TYPES = new Set([
  "architecture_map",
  "domain_pack",
  "glossary",
  "entity_card",
  "flow_card",
  "entry_index",
  "service_data_fact",
  "decision_card",
  "playbook",
  "lesson",
  "project_goal",
  "review_writing",
  "experience_record",
  "person_evidence_view",
  "person_observation",
  "synthesis",
  "gap",
]);

export const MODE_PRODUCTS: Record<string, string[]> = {
  architecture: ["architecture_map"],
  domain_pack: ["domain_pack", "architecture_map"],
  glossary: ["glossary"],
  entity: ["entity_card", "domain_pack"],
  flow_entry: ["flow_card", "entry_index", "architecture_map"],
  service_data_fact: ["service_data_fact"],
  decision: ["decision_card"],
  playbook: ["playbook"],
  lesson: ["lesson"],
  project_goal: ["project_goal"],
  review_writing: ["review_writing"],
  agent_experience: ["experience_record"],
  person: ["person_evidence_view", "person_observation"],
  synthesis: ["synthesis"],
  gap: ["gap"],
};
