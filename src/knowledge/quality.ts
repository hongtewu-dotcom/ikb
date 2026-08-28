import type {
  KnowledgeConfidence,
  KnowledgeRecord,
  KnowledgeTemporalState,
  KnowledgeVerification,
} from "../types.ts";
import type { KnowledgeQualityIssue, KnowledgeQualityIssueCode } from "./contracts.ts";
import { inspectPersonalAdmission } from "./personal-admission.ts";
import { EXTRACTION_RESULT_VERSION } from "../extraction/contracts.ts";

const SOURCE_DERIVED_KINDS = new Set(["elephant", "ai_conversation", "document", "review_comment", "artifact"]);

export function inspectKnowledgeQuality(record: KnowledgeRecord, options: { requireAdmission?: boolean } = {}): KnowledgeQualityIssue[] {
  const issues: KnowledgeQualityIssue[] = [];
  const add = (code: KnowledgeQualityIssueCode, detail: string) => issues.push({ knowledgeId: record.id, path: record.path, code, detail });
  const confidence = record.confidence ?? "medium";
  const temporalState = record.temporalState ?? "unknown";
  const verification = record.verification ?? (record.status === "verified" ? "source_confirmed" : "unverified");
  const principle = record.type.trim().toLowerCase() === "principle";
  const memoryTopic = record.tags.includes("memory-topic");
  const validConfidence: KnowledgeConfidence[] = ["low", "medium", "high"];
  const validTemporalState: KnowledgeTemporalState[] = ["current", "planned", "historical", "mixed", "superseded", "unknown"];
  const validVerification: KnowledgeVerification[] = ["unverified", "source_confirmed", "task_validated", "user_confirmed"];
  if (!record.body.trim()) add("body_empty", "knowledge body must not be empty");
  if (!Number.isInteger(record.revision) || record.revision < 1) add("revision_invalid", "knowledge revision must be a positive integer");
  if (!Array.isArray(record.revisionHistory) || record.revisionHistory.some((ref) => !/^revisions\/knowledge\/[A-Za-z0-9_./-]+\/journal\.json$/.test(ref))) add("revision_history_invalid", "revision_history must contain safe relative Knowledge revision journal refs");
  if (record.supersededBy && !/^kb-[A-Za-z0-9-]+$/.test(record.supersededBy)) add("superseded_by_invalid", "superseded_by must be a stable Knowledge id");
  if (containsLiteralEscapedNewline(record.body)) add("literal_escaped_newline", "normal prose contains a literal \\n or \\r\\n escape; write a real newline or wrap the token in code formatting");
  if (!validConfidence.includes(confidence as KnowledgeConfidence)) add("confidence_invalid", `confidence must be low, medium, or high: ${String(confidence)}`);
  if (!validTemporalState.includes(temporalState as KnowledgeTemporalState)) add("temporal_state_invalid", `temporal_state is not supported: ${String(temporalState)}`);
  if (!validVerification.includes(verification as KnowledgeVerification)) add("verification_invalid", `verification is not supported: ${String(verification)}`);
  if (principle && record.qualityVersion < 5) {
    add("principle_quality_version_insufficient", "principle knowledge requires quality_version 5 and a complete QV5 review package");
  }
  if (principle && record.status === "verified" && verification !== "user_confirmed") {
    add("principle_verification_insufficient", "verified principle knowledge requires verification=user_confirmed");
  }
  if (memoryTopic && record.status === "verified" && confidence !== "high") {
    add("memory_topic_confidence_insufficient", "verified Memory Topic knowledge requires confidence=high after fact-level review");
  }
  if (memoryTopic && record.status === "verified" && !["current", "historical"].includes(temporalState)) {
    add("memory_topic_temporal_state_unresolved", "verified Memory Topic knowledge requires temporal_state=current or historical");
  }
  if (record.qualityVersion >= 2 && (record.confidenceBasis ?? []).length === 0) add("confidence_basis_missing", "quality_version 2 knowledge requires confidence_basis");
  if (record.collection === "people" && (record.qualityVersion >= 2 || record.status === "verified")) {
    if (!record.identityConfidence) add("person_identity_confidence_missing", "quality_version 2 person knowledge requires identity_confidence");
    else if (record.identityConfidence !== "high") add("person_identity_confidence_insufficient", "person knowledge requires identity_confidence=high");
    if (!record.patternConfidence) add("person_pattern_confidence_missing", "quality_version 2 person knowledge requires pattern_confidence");
    else if (record.patternConfidence === "low") add("person_pattern_confidence_insufficient", "person knowledge requires pattern_confidence at least medium");
    const minimumEpisodes = record.qualityVersion >= 4 ? 3 : 2;
    if (!Number.isInteger(record.independentEpisodeCount) || Number(record.independentEpisodeCount) < minimumEpisodes) add("person_episode_count_insufficient", `person knowledge requires at least ${minimumEpisodes} independent episodes`);
    if (record.qualityVersion >= 4) {
      if (!Number.isInteger(record.independentSourceCount) || Number(record.independentSourceCount) < 2) add("person_source_count_insufficient", "quality_version 4 person observation requires at least two independent sources or source kinds");
      if (!Number.isInteger(record.distinctDateCount) || Number(record.distinctDateCount) < 2) add("person_date_count_insufficient", "quality_version 4 person observation requires at least two distinct dates");
      if (!(record.doNotUseFor ?? []).length) add("person_do_not_use_for_missing", "quality_version 4 person observation requires explicit prohibited uses");
      if (!record.counterevidenceSearch) add("person_counterevidence_search_missing", "quality_version 4 person observation must record the counterevidence search window");
    }
    if (record.status === "verified" && !["task_validated", "user_confirmed"].includes(verification)) add("person_verification_insufficient", "verified person knowledge requires task_validated or user_confirmed verification");
  }
  if ((isSourceDerived(record) || principle) && record.sourceRefs.length === 0) add("source_refs_missing", `${principle ? "principle" : `source-derived knowledge (${record.sourceKind})`} requires source_refs`);
  if (record.status === "verified" && record.sourceRefs.length === 0) add("verified_source_refs_missing", "verified knowledge requires source_refs");
  if (record.status === "verified" && verification === "unverified") add("verification_invalid", "verified knowledge cannot retain verification=unverified");
  const requireAdmission = (isSourceDerived(record) || principle) && (options.requireAdmission === true || record.qualityVersion >= 1);
  if (requireAdmission && !record.admissionReason) add("admission_reason_missing", "source-derived knowledge requires admission_reason explaining its durable value");
  if (requireAdmission && !record.applicability) add("applicability_missing", "source-derived knowledge requires applicability");
  if (requireAdmission && !record.boundary) add("boundary_missing", "source-derived knowledge requires boundary or known unknowns");
  if (record.qualityVersion === 3) {
    if (!record.useWhen) add("use_when_missing", "quality_version 3 knowledge requires a task trigger in use_when");
    if ((record.useInputs ?? []).length === 0) add("use_inputs_missing", "quality_version 3 knowledge requires concrete use_inputs");
    if ((record.useOutputs ?? []).length === 0) add("use_outputs_missing", "quality_version 3 knowledge requires concrete use_outputs");
    if ((record.useSteps ?? []).length === 0) add("use_steps_missing", "quality_version 3 knowledge requires ordered use_steps");
    if ((record.useChecks ?? []).length === 0) add("use_checks_missing", "quality_version 3 knowledge requires use_checks");
    if ((record.useStopConditions ?? []).length === 0) add("use_stop_conditions_missing", "quality_version 3 knowledge requires use_stop_conditions");
  }
  if (record.qualityVersion >= 4) {
    if (!record.productType) add("product_type_missing", "quality_version 4 knowledge requires a typed product_type");
    if (principle && record.productType !== "principle_card") {
      add("principle_product_type_mismatch", "principle knowledge requires product_type=principle_card");
    }
    if (!record.compilationRef) add("compilation_ref_missing", "quality_version 4 knowledge must point to its fact-preserving compilation");
    if ((record.factRefs ?? []).length === 0) add("fact_refs_missing", "quality_version 4 knowledge must cite fact_refs from the compilation");
    if ((record.questionsAnswered ?? []).length === 0) add("questions_answered_missing", "quality_version 4 knowledge must state which consumer questions it answers");
    if (record.productType === "playbook") {
      if (!record.useWhen) add("use_when_missing", "playbook requires a task trigger in use_when");
      if ((record.useInputs ?? []).length === 0) add("use_inputs_missing", "playbook requires concrete use_inputs");
      if ((record.useOutputs ?? []).length === 0) add("use_outputs_missing", "playbook requires concrete use_outputs");
      if ((record.useSteps ?? []).length === 0) add("use_steps_missing", "playbook requires ordered use_steps");
      if ((record.useChecks ?? []).length === 0) add("use_checks_missing", "playbook requires use_checks");
      if ((record.useStopConditions ?? []).length === 0) add("use_stop_conditions_missing", "playbook requires use_stop_conditions");
    }
  }
  if (record.qualityVersion >= 5) {
    if (!record.canonicalKey) add("canonical_key_missing", "quality_version 5 knowledge requires canonical_key");
    else if (!record.canonicalKey.startsWith(`${record.scope}:`)) add("canonical_key_scope_mismatch", `canonical_key must start with ${record.scope}:`);
    if (!record.compilationSchema) add("compilation_schema_missing", "quality_version 5 knowledge requires compilation_schema");
    else if (record.compilationSchema !== EXTRACTION_RESULT_VERSION) add("compilation_schema_unsupported", `quality_version 5 knowledge requires ${EXTRACTION_RESULT_VERSION}`);
    if (!record.compilationCaseId) add("compilation_case_id_missing", "quality_version 5 knowledge requires compilation_case_id");
    if (!record.compilationProductId) add("compilation_product_id_missing", "quality_version 5 knowledge requires compilation_product_id");
    if (!record.extractionManifestRef) add("extraction_manifest_ref_missing", "quality_version 5 knowledge requires extraction_manifest_ref");
    if (!record.informationLossRef) add("information_loss_ref_missing", "quality_version 5 knowledge requires information_loss_ref");
  }
  for (const issue of inspectPersonalAdmission(record)) add(issue.code, issue.detail);
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
