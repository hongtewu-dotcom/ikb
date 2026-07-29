import type { KnowledgeRecord } from "../types.ts";

/**
 * Quality versions below this level are legacy/advisory personal notes. They
 * remain readable, but cannot be promoted to verified or published knowledge.
 */
export const PERSONAL_FORMAL_QUALITY_VERSION = 4;

export type PersonalAdmissionIssueCode =
  | "personal_quality_version_insufficient"
  | "personal_source_refs_missing"
  | "personal_admission_reason_missing"
  | "personal_applicability_missing"
  | "personal_boundary_missing"
  | "personal_temporal_state_missing"
  | "personal_type_unsupported"
  | "personal_preference_evidence_insufficient"
  | "personal_goal_verification_insufficient"
  | "personal_decision_counterevidence_search_missing"
  | "personal_decision_verification_insufficient"
  | "personal_playbook_product_type_mismatch"
  | "personal_playbook_verification_insufficient"
  | "personal_lesson_episode_missing"
  | "personal_lesson_verification_insufficient"
  | "personal_synthesis_fact_refs_insufficient"
  | "personal_synthesis_verification_insufficient"
  | "personal_fact_confidence_insufficient";

export interface PersonalAdmissionIssue {
  code: PersonalAdmissionIssueCode;
  detail: string;
}

const PERSONAL_TYPES = new Set([
  "fact",
  "decision",
  "preference",
  "playbook",
  "lesson",
  "synthesis",
  "entity",
  "goal",
]);

const VERIFIED_BY_TASK_OR_USER = new Set(["task_validated", "user_confirmed"]);

/**
 * The personal-admission seam. It checks only personal ownership rules;
 * generic source, compilation and playbook checks stay in quality.ts.
 *
 * Legacy drafts deliberately pass through. The gate becomes mandatory when a
 * personal record is formal (quality_version >= 4) or is being written as
 * verified. This keeps old notes readable while preventing them from silently
 * becoming trusted or public knowledge.
 */
export function inspectPersonalAdmission(record: KnowledgeRecord): PersonalAdmissionIssue[] {
  if (record.scope !== "personal") return [];

  const issues: PersonalAdmissionIssue[] = [];
  const add = (code: PersonalAdmissionIssueCode, detail: string) => issues.push({ code, detail });
  const formal = record.qualityVersion >= PERSONAL_FORMAL_QUALITY_VERSION;

  if (record.status === "verified" && !formal) {
    add(
      "personal_quality_version_insufficient",
      `personal verified knowledge requires quality_version >= ${PERSONAL_FORMAL_QUALITY_VERSION}`,
    );
  }
  if (!formal) return issues;

  if (record.sourceRefs.length === 0) add("personal_source_refs_missing", "formal personal knowledge requires source_refs, including user-confirmation refs for explicit choices");
  if (!record.admissionReason) add("personal_admission_reason_missing", "formal personal knowledge requires a durable-value admission reason");
  if (!record.applicability) add("personal_applicability_missing", "formal personal knowledge requires an explicit applicability");
  if (!record.boundary) add("personal_boundary_missing", "formal personal knowledge requires an explicit boundary");
  if (!record.temporalState || record.temporalState === "unknown") add("personal_temporal_state_missing", "formal personal knowledge requires a non-unknown temporal state");

  // Person observations have their own stricter identity/episode gate in
  // quality.ts. They still receive the common traceability checks above.
  if (record.collection === "people") return issues;

  if (!PERSONAL_TYPES.has(record.type)) {
    add("personal_type_unsupported", `personal knowledge type is not supported by the admission profile: ${record.type}`);
    return issues;
  }

  const verified = record.status === "verified";
  switch (record.type) {
    case "preference":
      if (verified && record.verification !== "user_confirmed" && !(record.verification === "task_validated" && (record.independentEpisodeCount ?? 0) >= 2 && (record.distinctDateCount ?? 0) >= 2)) {
        add("personal_preference_evidence_insufficient", "a verified preference requires user confirmation, or task validation backed by at least two independent episodes on two dates");
      }
      break;
    case "goal":
      if (verified && !VERIFIED_BY_TASK_OR_USER.has(record.verification ?? "")) add("personal_goal_verification_insufficient", "a verified goal requires user confirmation or a real task validation");
      break;
    case "decision":
      if (!record.counterevidenceSearch) add("personal_decision_counterevidence_search_missing", "a personal decision must record the search for alternatives, conflicts or expiry conditions");
      if (verified && !VERIFIED_BY_TASK_OR_USER.has(record.verification ?? "")) add("personal_decision_verification_insufficient", "a verified decision requires user confirmation or a real task validation");
      break;
    case "playbook":
      if (record.productType !== "playbook") add("personal_playbook_product_type_mismatch", "a personal playbook must use product_type=playbook");
      if (verified && !VERIFIED_BY_TASK_OR_USER.has(record.verification ?? "")) add("personal_playbook_verification_insufficient", "a verified personal playbook requires a successful task validation or user confirmation");
      break;
    case "lesson":
      if ((record.independentEpisodeCount ?? 0) < 1) add("personal_lesson_episode_missing", "a lesson must point to at least one concrete incident episode");
      if (verified && !VERIFIED_BY_TASK_OR_USER.has(record.verification ?? "")) add("personal_lesson_verification_insufficient", "a verified lesson requires a real task validation or user confirmation");
      break;
    case "synthesis":
      if ((record.factRefs ?? []).length < 2) add("personal_synthesis_fact_refs_insufficient", "a personal synthesis must preserve at least two source facts");
      if (verified && !VERIFIED_BY_TASK_OR_USER.has(record.verification ?? "")) add("personal_synthesis_verification_insufficient", "a verified synthesis requires a real task validation or user confirmation");
      break;
    case "fact":
    case "entity":
      if (verified && record.confidence !== "high") add("personal_fact_confidence_insufficient", "a verified personal fact or entity requires high confidence");
      break;
    default:
      // The set check above makes this unreachable, but keeps the switch
      // exhaustive if the supported type list changes later.
      break;
  }
  return issues;
}

export function isPersonalAdmissionReady(record: KnowledgeRecord): boolean {
  if (record.scope === "personal" && record.qualityVersion < PERSONAL_FORMAL_QUALITY_VERSION) return false;
  return inspectPersonalAdmission(record).length === 0;
}
