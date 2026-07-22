import type {
  KnowledgeConfidence,
  KnowledgeRecord,
  KnowledgeTemporalState,
  KnowledgeVerification,
} from "../types.ts";
import type { KnowledgeQualityIssue, KnowledgeQualityIssueCode } from "./contracts.ts";

const SOURCE_DERIVED_KINDS = new Set(["elephant", "ai_conversation", "document", "review_comment", "artifact"]);

export function inspectKnowledgeQuality(record: KnowledgeRecord, options: { requireAdmission?: boolean } = {}): KnowledgeQualityIssue[] {
  const issues: KnowledgeQualityIssue[] = [];
  const add = (code: KnowledgeQualityIssueCode, detail: string) => issues.push({ knowledgeId: record.id, path: record.path, code, detail });
  const confidence = record.confidence ?? "medium";
  const temporalState = record.temporalState ?? "unknown";
  const verification = record.verification ?? (record.status === "verified" ? "source_confirmed" : "unverified");
  const validConfidence: KnowledgeConfidence[] = ["low", "medium", "high"];
  const validTemporalState: KnowledgeTemporalState[] = ["current", "planned", "historical", "mixed", "superseded", "unknown"];
  const validVerification: KnowledgeVerification[] = ["unverified", "source_confirmed", "task_validated", "user_confirmed"];
  if (!record.body.trim()) add("body_empty", "knowledge body must not be empty");
  if (containsLiteralEscapedNewline(record.body)) add("literal_escaped_newline", "normal prose contains a literal \\n or \\r\\n escape; write a real newline or wrap the token in code formatting");
  if (!validConfidence.includes(confidence as KnowledgeConfidence)) add("confidence_invalid", `confidence must be low, medium, or high: ${String(confidence)}`);
  if (!validTemporalState.includes(temporalState as KnowledgeTemporalState)) add("temporal_state_invalid", `temporal_state is not supported: ${String(temporalState)}`);
  if (!validVerification.includes(verification as KnowledgeVerification)) add("verification_invalid", `verification is not supported: ${String(verification)}`);
  if (record.qualityVersion >= 2 && (record.confidenceBasis ?? []).length === 0) add("confidence_basis_missing", "quality_version 2 knowledge requires confidence_basis");
  if (record.collection === "people" && (record.qualityVersion >= 2 || record.status === "verified")) {
    if (!record.identityConfidence) add("person_identity_confidence_missing", "quality_version 2 person knowledge requires identity_confidence");
    else if (record.identityConfidence !== "high") add("person_identity_confidence_insufficient", "person knowledge requires identity_confidence=high");
    if (!record.patternConfidence) add("person_pattern_confidence_missing", "quality_version 2 person knowledge requires pattern_confidence");
    else if (record.patternConfidence === "low") add("person_pattern_confidence_insufficient", "person knowledge requires pattern_confidence at least medium");
    if (!Number.isInteger(record.independentEpisodeCount) || Number(record.independentEpisodeCount) < 2) add("person_episode_count_insufficient", "person knowledge requires at least two independent episodes");
    if (record.status === "verified" && !["task_validated", "user_confirmed"].includes(verification)) add("person_verification_insufficient", "verified person knowledge requires task_validated or user_confirmed verification");
  }
  if (isSourceDerived(record) && record.sourceRefs.length === 0) add("source_refs_missing", `source-derived knowledge (${record.sourceKind}) requires source_refs`);
  if (record.status === "verified" && record.sourceRefs.length === 0) add("verified_source_refs_missing", "verified knowledge requires source_refs");
  if (record.status === "verified" && verification === "unverified") add("verification_invalid", "verified knowledge cannot retain verification=unverified");
  const requireAdmission = isSourceDerived(record) && (options.requireAdmission === true || record.qualityVersion >= 1);
  if (requireAdmission && !record.admissionReason) add("admission_reason_missing", "source-derived knowledge requires admission_reason explaining its durable value");
  if (requireAdmission && !record.applicability) add("applicability_missing", "source-derived knowledge requires applicability");
  if (requireAdmission && !record.boundary) add("boundary_missing", "source-derived knowledge requires boundary or known unknowns");
  if (record.qualityVersion >= 3) {
    if (!record.useWhen) add("use_when_missing", "quality_version 3 knowledge requires a task trigger in use_when");
    if ((record.useInputs ?? []).length === 0) add("use_inputs_missing", "quality_version 3 knowledge requires concrete use_inputs");
    if ((record.useOutputs ?? []).length === 0) add("use_outputs_missing", "quality_version 3 knowledge requires concrete use_outputs");
    if ((record.useSteps ?? []).length === 0) add("use_steps_missing", "quality_version 3 knowledge requires ordered use_steps");
    if ((record.useChecks ?? []).length === 0) add("use_checks_missing", "quality_version 3 knowledge requires use_checks");
    if ((record.useStopConditions ?? []).length === 0) add("use_stop_conditions_missing", "quality_version 3 knowledge requires use_stop_conditions");
  }
  return issues;
}

export function assertKnowledgeQuality(record: KnowledgeRecord, options: { requireAdmission?: boolean } = {}): void {
  const issues = inspectKnowledgeQuality(record, options);
  if (issues.length > 0) throw new Error(`Knowledge quality gate failed: ${issues.map((issue) => `${issue.code}: ${issue.detail}`).join("; ")}`);
}

export function isSourceDerived(record: Pick<KnowledgeRecord, "sourceKind">): boolean {
  return SOURCE_DERIVED_KINDS.has(record.sourceKind);
}

function containsLiteralEscapedNewline(body: string): boolean {
  let inFence = false;
  const prose = body.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return "";
    }
    if (inFence) return "";
    return line.replace(/`[^`]*`/g, "");
  }).join("\n");
  return /\\r\\n|\\n/.test(prose);
}
