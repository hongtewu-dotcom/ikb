import type { KnowledgeRecord } from "../types.ts";
import { inspectKnowledgeQuality } from "./quality.ts";
import { inspectPrincipleConfirmation } from "./principle-admission.ts";

export type KnowledgeRetrievalIneligibilityReason =
  | "memory_topic_status_not_verified"
  | "memory_topic_confidence_insufficient"
  | "memory_topic_temporal_state_unresolved"
  | "principle_status_not_verified"
  | "principle_verification_not_user_confirmed"
  | "principle_quality_contract_failed"
  | "principle_confirmation_chain_invalid"
  | "legacy_person_quality_version"
  | "person_product_type_not_observation"
  | "person_quality_contract_failed";

export interface KnowledgeRetrievalEligibility {
  eligible: boolean;
  reason: KnowledgeRetrievalIneligibilityReason | null;
}

/**
 * Decide whether a stored Knowledge record may influence a default Agent
 * retrieval. Storage and retrieval are deliberately separate: Principle
 * drafts and old person notes remain auditable through list/show, while both
 * higher-risk planes fail closed until their quality contracts are satisfied.
 */
export function knowledgeRetrievalEligibility(record: KnowledgeRecord): KnowledgeRetrievalEligibility {
  if (record.tags.includes("memory-topic")) {
    if (record.status !== "verified") return { eligible: false, reason: "memory_topic_status_not_verified" };
    if (record.confidence !== "high") return { eligible: false, reason: "memory_topic_confidence_insufficient" };
    if (!record.temporalState || !["current", "historical"].includes(record.temporalState)) {
      return { eligible: false, reason: "memory_topic_temporal_state_unresolved" };
    }
  }
  if (record.type.trim().toLowerCase() === "principle") {
    if (record.status !== "verified") return { eligible: false, reason: "principle_status_not_verified" };
    if (record.verification !== "user_confirmed") {
      return { eligible: false, reason: "principle_verification_not_user_confirmed" };
    }
    if (inspectKnowledgeQuality(record).length > 0) {
      return { eligible: false, reason: "principle_quality_contract_failed" };
    }
  }
  if (record.collection !== "people") return { eligible: true, reason: null };
  if (record.qualityVersion < 4) return { eligible: false, reason: "legacy_person_quality_version" };
  if (record.productType !== "person_observation") {
    return { eligible: false, reason: "person_product_type_not_observation" };
  }
  if (inspectKnowledgeQuality(record).length > 0) {
    return { eligible: false, reason: "person_quality_contract_failed" };
  }
  return { eligible: true, reason: null };
}

/** Home-aware retrieval gate for evidence that cannot be proven from a card's
 * frontmatter alone. */
export function knowledgeRetrievalEligibilityAtHome(home: string, record: KnowledgeRecord): KnowledgeRetrievalEligibility {
  const structural = knowledgeRetrievalEligibility(record);
  if (!structural.eligible) return structural;
  const problem = inspectPrincipleConfirmation(home, record, "retrieval");
  return problem
    ? { eligible: false, reason: "principle_confirmation_chain_invalid" }
    : structural;
}
