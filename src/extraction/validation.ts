import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  ATTRIBUTION_ROLES,
  CLAIM_SUPPORT_STATUSES,
  CLAIM_KINDS,
  EXTRACTION_FIDELITY_VERSION,
  EXTRACTION_MANIFEST_VERSION,
  EXTRACTION_RESULT_VERSION,
  EXTRACTION_VALIDATION_VERSION,
  FACT_DERIVATIONS,
  FACT_IMPORTANCE,
  LEGACY_EXTRACTION_MANIFEST_VERSION,
  LEGACY_EXTRACTION_RESULT_VERSION,
  MODE_PRODUCTS,
  PRODUCT_OPERATIONS,
  PRODUCT_TYPES,
  QUESTION_DISPOSITIONS,
  REFERENCE_FACT_DISPOSITIONS,
  SOURCE_UNIT_DISPOSITIONS,
  SOURCE_UNIT_KINDS,
  SUPPORTED_EXTRACTION_MANIFEST_VERSIONS,
  TEMPORAL_STATES,
  type ExtractionFidelityReport,
  type ExtractionFidelityVerdict,
  type ExtractionInformationLossMetrics,
  type ExtractionValidationIssue,
  type ExtractionValidationReport,
  type JsonObject,
} from "./contracts.ts";
import {
  calculateInformationLossMetrics,
  emptyInformationLossMetrics,
  validateInformationLossResult,
  verifyFrozenSourceUnits,
} from "./information-loss.ts";

interface BatchInspection {
  benchmarkId: string;
  manifestSchema: string;
  manifestCases: JsonObject[];
  resultsById: Map<string, JsonObject>;
  issues: ExtractionValidationIssue[];
}

export function validateExtractionBatch(manifestValue: unknown, resultValues: unknown[]): ExtractionValidationReport {
  const inspection = inspectBatch(manifestValue, resultValues);
  return {
    schema: EXTRACTION_VALIDATION_VERSION,
    benchmarkId: inspection.benchmarkId,
    valid: inspection.issues.length === 0,
    expectedCaseCount: inspection.manifestCases.length,
    caseCount: inspection.resultsById.size,
    issues: inspection.issues,
  };
}

export function verifyExtractionBatch(manifestValue: unknown, resultValues: unknown[]): ExtractionFidelityReport {
  const inspection = inspectBatch(manifestValue, resultValues);
  const issues = [...inspection.issues];
  const verdicts: ExtractionFidelityVerdict[] = [];
  for (const manifestCase of inspection.manifestCases) {
    const caseId = String(manifestCase.case_id);
    const result = inspection.resultsById.get(caseId);
    if (!result) continue;
    verifyResultFidelity(result, manifestCase, issues);
    const legacy = inspection.manifestSchema === LEGACY_EXTRACTION_MANIFEST_VERSION;
    const metrics = legacy ? emptyInformationLossMetrics() : calculateInformationLossMetrics(manifestCase, result);
    const allCaseIssues = issues.filter((item) => item.caseId === caseId);
    const disposition = stringValue(result.disposition);
    verdicts.push({
      caseId,
      disposition: disposition === "admit" || disposition === "skip" ? disposition : "invalid",
      legacy,
      publishable: !legacy && disposition === "admit" && allCaseIssues.length === 0,
      checks: {
        evidenceIntegrity: !hasIssuePrefix(allCaseIssues, ["evidence_", "fact_evidence_"]),
        coreCoverage: !hasIssuePrefix(allCaseIssues, ["coverage_", "core_"]),
        claimSupport: !hasIssuePrefix(allCaseIssues, ["claim_", "product_fact_"]),
        typeShape: !hasIssuePrefix(allCaseIssues, ["product_", "architecture_", "domain_", "flow_", "decision_", "principle_", "playbook_", "gap_"]),
        personSelectivity: !hasIssuePrefix(allCaseIssues, ["person_"]),
        sourceCompleteness: !legacy && !hasIssuePrefix(allCaseIssues, ["source_unit_"]),
        informationLoss: !legacy && !hasIssuePrefix(allCaseIssues, ["information_loss_", "reference_fact_", "question_", "claim_support_"]),
        minimalSufficiency: !legacy && !hasIssuePrefix(allCaseIssues, ["canonical_", "product_operation_", "product_unique_value_", "product_question_ref_"]),
      },
      metrics,
    });
  }
  return {
    schema: EXTRACTION_FIDELITY_VERSION,
    benchmarkId: inspection.benchmarkId,
    valid: issues.length === 0,
    expectedCaseCount: inspection.manifestCases.length,
    caseCount: inspection.resultsById.size,
    publishableCount: verdicts.filter((item) => item.publishable).length,
    retainedOnlyCount: verdicts.filter((item) => item.disposition === "skip" && retainedChecksPass(item)).length,
    verdicts,
    issues,
  };
}

function retainedChecksPass(verdict: ExtractionFidelityVerdict): boolean {
  const baseChecks = [
    verdict.checks.evidenceIntegrity,
    verdict.checks.coreCoverage,
    verdict.checks.claimSupport,
    verdict.checks.typeShape,
    verdict.checks.personSelectivity,
  ];
  if (verdict.legacy) return baseChecks.every(Boolean);
  return [...baseChecks, verdict.checks.sourceCompleteness, verdict.checks.informationLoss, verdict.checks.minimalSufficiency].every(Boolean);
}

function inspectBatch(manifestValue: unknown, resultValues: unknown[]): BatchInspection {
  const manifest = objectValue(manifestValue);
  const benchmarkId = stringValue(manifest?.benchmark_id);
  const manifestSchema = stringValue(manifest?.schema);
  const manifestCases = arrayValue(manifest?.cases).flatMap((value) => {
    const row = objectValue(value);
    const caseId = stringValue(row?.case_id);
    return row && caseId ? [{ ...row, case_id: caseId }] : [];
  });
  const issues: ExtractionValidationIssue[] = [];
  if (!manifest || !benchmarkId) {
    issues.push(issue("manifest_invalid", null, "manifest", "Manifest must contain benchmark_id and cases."));
  } else if (!SUPPORTED_EXTRACTION_MANIFEST_VERSIONS.has(manifestSchema)) {
    issues.push(issue("manifest_schema_mismatch", null, "manifest.schema", `Manifest schema must be ${EXTRACTION_MANIFEST_VERSION} or ${LEGACY_EXTRACTION_MANIFEST_VERSION}.`));
  }
  const casesById = new Map(manifestCases.map((item) => [String(item.case_id), item]));
  const resultsById = new Map<string, JsonObject>();
  for (const value of resultValues) {
    const result = objectValue(value);
    const caseId = stringValue(result?.case_id);
    if (!result || !caseId) {
      issues.push(issue("result_invalid", null, "results", "Each result must be an object with case_id."));
      continue;
    }
    if (resultsById.has(caseId)) {
      issues.push(issue("case_duplicate", caseId, "case_id", `Case ${caseId} appears more than once.`));
      continue;
    }
    resultsById.set(caseId, result);
    const manifestCase = casesById.get(caseId);
    if (!manifestCase) {
      issues.push(issue("case_unknown", caseId, "case_id", `Case ${caseId} is not present in the frozen manifest.`));
      continue;
    }
    validateResult(result, manifestCase, benchmarkId, manifestSchema, issues);
  }
  for (const manifestCase of manifestCases) {
    const caseId = String(manifestCase.case_id);
    validateManifestCase(manifestCase, manifestSchema, issues);
    if (!resultsById.has(caseId)) issues.push(issue("case_missing", caseId, "results", `Frozen case ${caseId} has no extraction result.`));
  }
  return { benchmarkId, manifestSchema, manifestCases, resultsById, issues };
}

function validateManifestCase(manifestCase: JsonObject, manifestSchema: string, issues: ExtractionValidationIssue[]): void {
  const caseId = String(manifestCase.case_id);
  if (stringArray(manifestCase.source_ids).length === 0) {
    issues.push(issue("manifest_sources_missing", caseId, "manifest.source_ids", "A frozen case needs source_ids."));
  }
  if (stringArray(manifestCase.extraction_modes).length === 0) {
    issues.push(issue("manifest_modes_missing", caseId, "manifest.extraction_modes", "A frozen case needs extraction_modes."));
  }
  const obligations = arrayValue(manifestCase.obligations);
  if (obligations.length === 0) {
    issues.push(issue("manifest_obligations_missing", caseId, "manifest.obligations", "A v2 case needs independently frozen coverage obligations."));
    return;
  }
  const seen = new Set<string>();
  obligations.forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.obligations[${index}]`;
    const obligationId = stringValue(row?.obligation_id);
    if (!row || !obligationId || !stringValue(row.description)) {
      issues.push(issue("manifest_obligation_invalid", caseId, path, "Obligation needs obligation_id and description."));
      return;
    }
    if (seen.has(obligationId)) issues.push(issue("manifest_obligation_duplicate", caseId, `${path}.obligation_id`, `Duplicate obligation ${obligationId}.`));
    seen.add(obligationId);
    if (!["core", "supporting"].includes(stringValue(row.importance))) {
      issues.push(issue("manifest_obligation_importance_invalid", caseId, `${path}.importance`, "importance must be core or supporting."));
    }
  });
  const declaredSources = new Set(stringArray(manifestCase.source_ids));
  const snapshots = arrayValue(manifestCase.source_snapshots);
  const snapshotSources = new Set<string>();
  snapshots.forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.source_snapshots[${index}]`;
    const sourceId = stringValue(row?.source_id);
    if (!row || !sourceId || !stringValue(row.path) || !stringValue(row.content_sha256)) {
      issues.push(issue("manifest_source_snapshot_invalid", caseId, path, "Source snapshot needs source_id, path, and content_sha256."));
      return;
    }
    if (!declaredSources.has(sourceId)) issues.push(issue("manifest_source_snapshot_undeclared", caseId, `${path}.source_id`, `Snapshot source ${sourceId} is not declared.`));
    if (snapshotSources.has(sourceId)) issues.push(issue("manifest_source_snapshot_duplicate", caseId, `${path}.source_id`, `Duplicate snapshot for ${sourceId}.`));
    snapshotSources.add(sourceId);
  });
  for (const sourceId of declaredSources) {
    if (!snapshotSources.has(sourceId)) issues.push(issue("manifest_source_snapshot_missing", caseId, "manifest.source_snapshots", `Source ${sourceId} has no frozen snapshot.`));
  }
  if (manifestSchema === EXTRACTION_MANIFEST_VERSION) validateV3ManifestCase(manifestCase, declaredSources, issues);
}

function validateV3ManifestCase(
  manifestCase: JsonObject,
  declaredSources: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const caseId = String(manifestCase.case_id);
  const sourceUnits = arrayValue(manifestCase.source_units);
  const sourceUnitIds = new Set<string>();
  if (sourceUnits.length === 0) {
    issues.push(issue("source_units_missing", caseId, "manifest.source_units", "A v3 case needs a frozen source structure inventory."));
  }
  sourceUnits.forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.source_units[${index}]`;
    const unitId = stringValue(row?.unit_id);
    if (!row || !unitId || !stringValue(row.locator) || !stringValue(row.content_sha256)) {
      issues.push(issue("source_unit_invalid", caseId, path, "Source unit needs unit_id, locator, and content_sha256."));
      return;
    }
    if (sourceUnitIds.has(unitId)) issues.push(issue("source_unit_duplicate", caseId, `${path}.unit_id`, `Duplicate source unit ${unitId}.`));
    sourceUnitIds.add(unitId);
    if (!declaredSources.has(stringValue(row.source_id))) {
      issues.push(issue("source_unit_source_undeclared", caseId, `${path}.source_id`, "Source unit must reference a declared Source."));
    }
    if (!SOURCE_UNIT_KINDS.has(stringValue(row.unit_kind))) {
      issues.push(issue("source_unit_kind_invalid", caseId, `${path}.unit_kind`, "unit_kind is not supported."));
    }
    if (!FACT_IMPORTANCE.has(stringValue(row.importance))) {
      issues.push(issue("source_unit_importance_invalid", caseId, `${path}.importance`, "importance must be core, supporting, or context."));
    }
    const content = rawStringValue(row.content);
    const artifactPath = stringValue(row.artifact_path);
    if (!content && !artifactPath) {
      issues.push(issue("source_unit_content_missing", caseId, path, "Source unit needs content or artifact_path."));
    }
    if (content && sha256(content) !== stringValue(row.content_sha256)) {
      issues.push(issue("source_unit_hash_mismatch", caseId, `${path}.content_sha256`, "content_sha256 must bind source unit content."));
    }
  });

  const questions = arrayValue(manifestCase.questions);
  const questionIds = new Set<string>();
  if (questions.length === 0) issues.push(issue("questions_missing", caseId, "manifest.questions", "A v3 case needs frozen consumer questions."));
  questions.forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.questions[${index}]`;
    const questionId = stringValue(row?.question_id);
    if (!row || !questionId || !stringValue(row.text)) {
      issues.push(issue("question_invalid", caseId, path, "Question needs question_id and text."));
      return;
    }
    if (questionIds.has(questionId)) issues.push(issue("question_duplicate", caseId, `${path}.question_id`, `Duplicate question ${questionId}.`));
    questionIds.add(questionId);
    if (!["core", "supporting"].includes(stringValue(row.importance))) {
      issues.push(issue("question_importance_invalid", caseId, `${path}.importance`, "Question importance must be core or supporting."));
    }
    for (const type of stringArray(row.required_product_types)) {
      if (!PRODUCT_TYPES.has(type)) issues.push(issue("question_product_type_invalid", caseId, `${path}.required_product_types`, `Unsupported product type ${type}.`));
    }
  });

  const referenceFacts = arrayValue(manifestCase.reference_facts);
  const referenceFactIds = new Set<string>();
  if (referenceFacts.length === 0) {
    issues.push(issue("reference_facts_missing", caseId, "manifest.reference_facts", "A v3 case needs an independently frozen reference fact inventory."));
  }
  referenceFacts.forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.reference_facts[${index}]`;
    const referenceFactId = stringValue(row?.reference_fact_id);
    if (!row || !referenceFactId || !stringValue(row.statement)) {
      issues.push(issue("reference_fact_invalid", caseId, path, "Reference fact needs reference_fact_id and statement."));
      return;
    }
    if (referenceFactIds.has(referenceFactId)) issues.push(issue("reference_fact_duplicate", caseId, `${path}.reference_fact_id`, `Duplicate reference fact ${referenceFactId}.`));
    referenceFactIds.add(referenceFactId);
    if (!FACT_IMPORTANCE.has(stringValue(row.importance))) {
      issues.push(issue("reference_fact_importance_invalid", caseId, `${path}.importance`, "importance must be core, supporting, or context."));
    }
    const unitRefs = stringArray(row.source_unit_refs);
    if (unitRefs.length === 0) issues.push(issue("reference_fact_source_units_missing", caseId, `${path}.source_unit_refs`, "Reference fact needs source_unit_refs."));
    for (const ref of unitRefs) {
      if (!sourceUnitIds.has(ref)) issues.push(issue("reference_fact_source_unit_unknown", caseId, `${path}.source_unit_refs`, `Unknown source unit ${ref}.`));
    }
    for (const ref of stringArray(row.question_refs)) {
      if (!questionIds.has(ref)) issues.push(issue("reference_fact_question_unknown", caseId, `${path}.question_refs`, `Unknown question ${ref}.`));
    }
  });

  const existingIds = new Set<string>();
  const existingCanonicalKeys = new Set<string>();
  arrayValue(manifestCase.existing_knowledge).forEach((value, index) => {
    const row = objectValue(value);
    const path = `manifest.existing_knowledge[${index}]`;
    const knowledgeId = stringValue(row?.knowledge_id);
    const canonicalKey = stringValue(row?.canonical_key);
    if (!row || !knowledgeId || !canonicalKey) {
      issues.push(issue("canonical_existing_invalid", caseId, path, "Existing Knowledge needs knowledge_id and canonical_key."));
      return;
    }
    if (existingIds.has(knowledgeId)) issues.push(issue("canonical_existing_id_duplicate", caseId, `${path}.knowledge_id`, `Duplicate existing Knowledge ${knowledgeId}.`));
    existingIds.add(knowledgeId);
    if (existingCanonicalKeys.has(canonicalKey)) issues.push(issue("canonical_existing_key_duplicate", caseId, `${path}.canonical_key`, `Multiple existing Knowledge entries use ${canonicalKey}.`));
    existingCanonicalKeys.add(canonicalKey);
  });
}

function validateResult(
  result: JsonObject,
  manifestCase: JsonObject,
  benchmarkId: string,
  manifestSchema: string,
  issues: ExtractionValidationIssue[],
): void {
  const caseId = String(manifestCase.case_id);
  requireEqual(
    result,
    "schema",
    manifestSchema === EXTRACTION_MANIFEST_VERSION ? EXTRACTION_RESULT_VERSION : LEGACY_EXTRACTION_RESULT_VERSION,
    caseId,
    issues,
  );
  requireEqual(result, "benchmark_id", benchmarkId, caseId, issues);
  requireEqual(result, "input_fingerprint", stringValue(manifestCase.input_fingerprint), caseId, issues);
  const manifestModes = stringArray(manifestCase.extraction_modes);
  if (!sameStrings(stringArray(result.extraction_modes), manifestModes)) {
    issues.push(issue("extraction_modes_mismatch", caseId, "extraction_modes", "Result extraction_modes must match the frozen case."));
  }
  const disposition = stringValue(result.disposition);
  if (disposition !== "admit" && disposition !== "skip") {
    issues.push(issue("disposition_invalid", caseId, "disposition", "Disposition must be admit or skip."));
  }
  if (!stringValue(result.disposition_reason)) {
    issues.push(issue("disposition_reason_missing", caseId, "disposition_reason", "Disposition requires a concrete reason."));
  }
  if (!Array.isArray(result.unknowns)) issues.push(issue("unknowns_invalid", caseId, "unknowns", "unknowns must be an array."));
  if (stringArray(result.next_triggers).length === 0) {
    issues.push(issue("next_triggers_missing", caseId, "next_triggers", "At least one rerun or refresh trigger is required."));
  }

  const sourceIds = new Set(stringArray(manifestCase.source_ids));
  const evidenceIds = new Set<string>();
  arrayValue(result.evidence_units).forEach((value, index) => validateEvidence(value, index, caseId, sourceIds, evidenceIds, issues));
  if (arrayValue(result.evidence_units).length === 0) {
    issues.push(issue("evidence_units_missing", caseId, "evidence_units", "Every result must preserve at least one evidence unit."));
  }

  const factIds = new Set<string>();
  arrayValue(result.facts).forEach((value, index) => validateFact(value, index, caseId, evidenceIds, factIds, issues));
  if (arrayValue(result.facts).length === 0) {
    issues.push(issue("facts_missing", caseId, "facts", "Every result must retain a fact inventory, including skipped results."));
  }

  const claimIds = new Set<string>();
  arrayValue(result.claims).forEach((value, index) => validateClaim(value, index, caseId, factIds, claimIds, issues));
  if (disposition === "admit" && arrayValue(result.claims).length === 0) {
    issues.push(issue("claims_missing", caseId, "claims", "An admitted result needs at least one fact-backed claim."));
  }

  validateCoverage(result, manifestCase, caseId, factIds, disposition, issues);

  const productTypes = new Set<string>();
  const productIds = new Set<string>();
  arrayValue(result.products).forEach((value, index) => validateProduct(value, index, caseId, factIds, claimIds, productTypes, productIds, issues));
  validateRequiredProductCoverage(result, manifestCase, caseId, productTypes, issues);
  if (disposition === "admit" && productTypes.size === 0) {
    issues.push(issue("products_missing", caseId, "products", "An admitted result needs a typed product."));
  }
  if (disposition === "admit" && ![...productTypes].some((type) => type !== "gap" && type !== "person_evidence_view")) {
    issues.push(issue("publishable_product_missing", caseId, "products", "An admitted result needs a publishable typed product."));
  }
  if (disposition === "skip" && ![...productTypes].some((type) => ["gap", "experience_record", "person_evidence_view", "review_writing"].includes(type))) {
    issues.push(issue("skip_retention_product_missing", caseId, "products", "A skipped result must retain evidence in a Gap or evidence view."));
  }
  if (disposition === "admit") {
    for (const mode of manifestModes) {
      const expected = MODE_PRODUCTS[mode];
      if (expected && !expected.some((type) => productTypes.has(type))) {
        issues.push(issue("mode_product_missing", caseId, "products", `Extraction mode ${mode} has no matching typed product.`));
      }
    }
  }
  if (manifestSchema === EXTRACTION_MANIFEST_VERSION) {
    issues.push(...validateInformationLossResult(result, manifestCase, caseId, evidenceIds, factIds, productIds, disposition));
  }
}

function validateRequiredProductCoverage(
  result: JsonObject,
  manifestCase: JsonObject,
  caseId: string,
  productTypes: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const covered = new Set(arrayValue(result.coverage).flatMap((value) => {
    const row = objectValue(value);
    return row && stringValue(row.disposition) === "covered" ? [stringValue(row.obligation_id)] : [];
  }));
  for (const value of arrayValue(manifestCase.obligations)) {
    const obligation = objectValue(value);
    const obligationId = stringValue(obligation?.obligation_id);
    if (!obligation || !covered.has(obligationId)) continue;
    const required = stringArray(obligation.required_product_types);
    if (required.length > 0 && !required.some((type) => productTypes.has(type))) {
      issues.push(issue(
        "coverage_product_type_missing",
        caseId,
        `coverage.${obligationId}`,
        `Covered obligation ${obligationId} requires one of: ${required.join(", ")}.`,
      ));
    }
  }
}

function validateEvidence(
  value: unknown,
  index: number,
  caseId: string,
  sourceIds: Set<string>,
  seen: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const row = objectValue(value);
  const path = `evidence_units[${index}]`;
  if (!row) {
    issues.push(issue("evidence_invalid", caseId, path, "Evidence unit must be an object."));
    return;
  }
  const evidenceId = stringValue(row.evidence_id);
  if (!evidenceId) issues.push(issue("evidence_id_missing", caseId, `${path}.evidence_id`, "evidence_id is required."));
  else if (seen.has(evidenceId)) issues.push(issue("evidence_id_duplicate", caseId, `${path}.evidence_id`, `Duplicate evidence_id ${evidenceId}.`));
  else seen.add(evidenceId);
  const sourceId = stringValue(row.source_id);
  if (!sourceId) issues.push(issue("evidence_source_missing", caseId, `${path}.source_id`, "source_id is required."));
  else if (!sourceIds.has(sourceId)) issues.push(issue("evidence_source_undeclared", caseId, `${path}.source_id`, `Source ${sourceId} is outside the frozen case.`));
  for (const field of ["record_id", "locator", "excerpt", "excerpt_sha256", "actor", "occurred_at"] as const) {
    if (!stringValue(row[field])) issues.push(issue(`evidence_${field}_missing`, caseId, `${path}.${field}`, `${field} is required.`));
  }
  const excerpt = stringValue(row.excerpt);
  const expectedHash = excerpt ? createHash("sha256").update(excerpt).digest("hex") : "";
  if (expectedHash && stringValue(row.excerpt_sha256) !== expectedHash) {
    issues.push(issue("evidence_hash_mismatch", caseId, `${path}.excerpt_sha256`, "excerpt_sha256 must bind the preserved excerpt."));
  }
  if (!ATTRIBUTION_ROLES.has(stringValue(row.attribution_role))) {
    issues.push(issue("evidence_attribution_role_invalid", caseId, `${path}.attribution_role`, "attribution_role is not supported."));
  }
  if (stringValue(row.occurred_at) && Number.isNaN(Date.parse(stringValue(row.occurred_at)))) {
    issues.push(issue("evidence_time_invalid", caseId, `${path}.occurred_at`, "occurred_at must be an ISO-compatible timestamp."));
  }
}

function validateFact(
  value: unknown,
  index: number,
  caseId: string,
  evidenceIds: Set<string>,
  seen: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const row = objectValue(value);
  const path = `facts[${index}]`;
  if (!row) {
    issues.push(issue("fact_invalid", caseId, path, "Fact must be an object."));
    return;
  }
  const factId = stringValue(row.fact_id);
  if (!factId) issues.push(issue("fact_id_missing", caseId, `${path}.fact_id`, "fact_id is required."));
  else if (seen.has(factId)) issues.push(issue("fact_id_duplicate", caseId, `${path}.fact_id`, `Duplicate fact_id ${factId}.`));
  else seen.add(factId);
  if (!stringValue(row.fact_kind)) issues.push(issue("fact_kind_missing", caseId, `${path}.fact_kind`, "fact_kind is required."));
  if (!stringValue(row.statement)) issues.push(issue("fact_statement_missing", caseId, `${path}.statement`, "statement is required."));
  const refs = stringArray(row.evidence_ids);
  if (refs.length === 0) issues.push(issue("fact_evidence_missing", caseId, `${path}.evidence_ids`, "Fact needs evidence_ids."));
  for (const ref of refs) {
    if (!evidenceIds.has(ref)) issues.push(issue("fact_evidence_unknown", caseId, `${path}.evidence_ids`, `Unknown evidence_id ${ref}.`));
  }
  if (!FACT_DERIVATIONS.has(stringValue(row.derivation))) {
    issues.push(issue("fact_derivation_invalid", caseId, `${path}.derivation`, "derivation must be direct, synthesis, or inference."));
  }
  if (!TEMPORAL_STATES.has(stringValue(row.temporal_state))) {
    issues.push(issue("fact_temporal_state_invalid", caseId, `${path}.temporal_state`, "temporal_state is not supported."));
  }
  if (!FACT_IMPORTANCE.has(stringValue(row.importance))) {
    issues.push(issue("fact_importance_invalid", caseId, `${path}.importance`, "importance must be core, supporting, or context."));
  }
}

function validateClaim(
  value: unknown,
  index: number,
  caseId: string,
  factIds: Set<string>,
  seen: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const row = objectValue(value);
  const path = `claims[${index}]`;
  if (!row) {
    issues.push(issue("claim_invalid", caseId, path, "Claim must be an object."));
    return;
  }
  const claimId = stringValue(row.claim_id);
  if (!claimId) issues.push(issue("claim_id_missing", caseId, `${path}.claim_id`, "claim_id is required."));
  else if (seen.has(claimId)) issues.push(issue("claim_id_duplicate", caseId, `${path}.claim_id`, `Duplicate claim_id ${claimId}.`));
  else seen.add(claimId);
  if (!stringValue(row.text)) issues.push(issue("claim_text_missing", caseId, `${path}.text`, "text is required."));
  if (!CLAIM_KINDS.has(stringValue(row.claim_kind))) {
    issues.push(issue("claim_kind_invalid", caseId, `${path}.claim_kind`, "claim_kind is not supported."));
  }
  if (!TEMPORAL_STATES.has(stringValue(row.temporal_state))) {
    issues.push(issue("claim_temporal_state_invalid", caseId, `${path}.temporal_state`, "temporal_state is not supported."));
  }
  const refs = stringArray(row.fact_refs);
  if (refs.length === 0) issues.push(issue("claim_fact_refs_missing", caseId, `${path}.fact_refs`, "Claim must be derived from facts, not directly from free prose."));
  for (const ref of [...refs, ...stringArray(row.counterevidence_fact_refs)]) {
    if (!factIds.has(ref)) issues.push(issue("claim_fact_ref_unknown", caseId, `${path}.fact_refs`, `Unknown fact_ref ${ref}.`));
  }
  if (!stringValue(row.reasoning)) issues.push(issue("claim_reasoning_missing", caseId, `${path}.reasoning`, "Claim needs an explicit evidence-to-claim derivation."));
}

function validateCoverage(
  result: JsonObject,
  manifestCase: JsonObject,
  caseId: string,
  factIds: Set<string>,
  disposition: string,
  issues: ExtractionValidationIssue[],
): void {
  const obligations = arrayValue(manifestCase.obligations).flatMap((value) => {
    const row = objectValue(value);
    return row && stringValue(row.obligation_id) ? [row] : [];
  });
  const obligationsById = new Map(obligations.map((item) => [stringValue(item.obligation_id), item]));
  const seen = new Set<string>();
  arrayValue(result.coverage).forEach((value, index) => {
    const row = objectValue(value);
    const path = `coverage[${index}]`;
    const obligationId = stringValue(row?.obligation_id);
    if (!row || !obligationId) {
      issues.push(issue("coverage_invalid", caseId, path, "Coverage needs obligation_id."));
      return;
    }
    if (seen.has(obligationId)) issues.push(issue("coverage_duplicate", caseId, `${path}.obligation_id`, `Duplicate coverage for ${obligationId}.`));
    seen.add(obligationId);
    const obligation = obligationsById.get(obligationId);
    if (!obligation) {
      issues.push(issue("coverage_obligation_unknown", caseId, `${path}.obligation_id`, `Unknown obligation ${obligationId}.`));
      return;
    }
    const coverageDisposition = stringValue(row.disposition);
    if (!["covered", "omitted", "unknown"].includes(coverageDisposition)) {
      issues.push(issue("coverage_disposition_invalid", caseId, `${path}.disposition`, "Coverage disposition must be covered, omitted, or unknown."));
    }
    const refs = stringArray(row.fact_refs);
    if (coverageDisposition === "covered" && refs.length === 0) {
      issues.push(issue("coverage_fact_refs_missing", caseId, `${path}.fact_refs`, "Covered obligation needs fact_refs."));
    }
    for (const ref of refs) {
      if (!factIds.has(ref)) issues.push(issue("coverage_fact_ref_unknown", caseId, `${path}.fact_refs`, `Unknown fact_ref ${ref}.`));
    }
    if (coverageDisposition !== "covered" && !stringValue(row.reason)) {
      issues.push(issue("coverage_reason_missing", caseId, `${path}.reason`, "Omitted or unknown coverage needs a reason."));
    }
    if (disposition === "admit" && stringValue(obligation.importance) === "core" && coverageDisposition !== "covered") {
      issues.push(issue("core_obligation_unresolved", caseId, path, `Core obligation ${obligationId} is ${coverageDisposition}; result cannot be admitted.`));
    }
  });
  for (const obligationId of obligationsById.keys()) {
    if (!seen.has(obligationId)) issues.push(issue("coverage_missing", caseId, "coverage", `No coverage decision for obligation ${obligationId}.`));
  }
}

function validateProduct(
  value: unknown,
  index: number,
  caseId: string,
  factIds: Set<string>,
  claimIds: Set<string>,
  productTypes: Set<string>,
  productIds: Set<string>,
  issues: ExtractionValidationIssue[],
): void {
  const row = objectValue(value);
  const path = `products[${index}]`;
  if (!row) {
    issues.push(issue("product_invalid", caseId, path, "Product must be an object."));
    return;
  }
  const productId = stringValue(row.product_id);
  if (!productId) issues.push(issue("product_id_missing", caseId, `${path}.product_id`, "product_id is required."));
  else if (productIds.has(productId)) issues.push(issue("product_id_duplicate", caseId, `${path}.product_id`, `Duplicate product_id ${productId}.`));
  else productIds.add(productId);
  const type = stringValue(row.product_type);
  if (!PRODUCT_TYPES.has(type)) issues.push(issue("product_type_invalid", caseId, `${path}.product_type`, "product_type is not supported."));
  else productTypes.add(type);
  if (!stringValue(row.title)) issues.push(issue("product_title_missing", caseId, `${path}.title`, "title is required."));
  for (const field of ["consumer_tasks", "questions_answered", "boundaries", "verification_plan"] as const) {
    if (stringArray(row[field]).length === 0) issues.push(issue(`product_${field}_missing`, caseId, `${path}.${field}`, `${field} needs at least one item.`));
  }
  const factRefs = stringArray(row.fact_refs);
  if (type !== "gap" && factRefs.length === 0) issues.push(issue("product_fact_refs_missing", caseId, `${path}.fact_refs`, "Product must cite facts from the compilation."));
  for (const ref of factRefs) {
    if (!factIds.has(ref)) issues.push(issue("product_fact_ref_unknown", caseId, `${path}.fact_refs`, `Unknown fact_ref ${ref}.`));
  }
  for (const ref of stringArray(row.claim_refs)) {
    if (!claimIds.has(ref)) issues.push(issue("product_claim_ref_unknown", caseId, `${path}.claim_refs`, `Unknown claim_ref ${ref}.`));
  }
  switch (type) {
    case "architecture_map":
      validateArchitecture(row, path, caseId, issues);
      break;
    case "domain_pack":
      validateDomain(row, path, caseId, issues);
      break;
    case "entity_card":
      validateEntity(row, path, caseId, issues);
      break;
    case "flow_card":
      validateFlow(row, path, caseId, issues);
      break;
    case "decision_card":
      validateDecision(row, path, caseId, issues);
      break;
    case "principle_card":
      validatePrinciple(row, path, caseId, issues);
      break;
    case "playbook":
      validatePlaybook(row, path, caseId, issues);
      break;
    case "person_evidence_view":
      validatePersonEvidence(row, path, caseId, issues);
      break;
    case "person_observation":
      validatePersonObservation(row, path, caseId, issues);
      break;
    case "gap":
      validateGap(row, path, caseId, issues);
      break;
    default:
      if (!objectValue(row.details) || Object.keys(objectValue(row.details) ?? {}).length < 2) {
        issues.push(issue("product_details_missing", caseId, `${path}.details`, `${type || "This product"} needs a typed details object with retained facts.`));
      }
  }
}

function validateArchitecture(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const architecture = objectValue(product.architecture);
  if (!architecture) {
    issues.push(issue("architecture_missing", caseId, `${path}.architecture`, "architecture_map needs an architecture object."));
    return;
  }
  const nodes = arrayValue(architecture.nodes);
  const edges = arrayValue(architecture.edges);
  if (nodes.length < 2) issues.push(issue("architecture_nodes_insufficient", caseId, `${path}.architecture.nodes`, "Architecture needs at least two explicit nodes."));
  if (edges.length < 1) issues.push(issue("architecture_edges_insufficient", caseId, `${path}.architecture.edges`, "Architecture needs at least one explicit edge."));
  const nodeIds = new Set<string>();
  nodes.forEach((value, index) => {
    const row = objectValue(value);
    const nodePath = `${path}.architecture.nodes[${index}]`;
    const nodeId = stringValue(row?.node_id);
    if (!row || !nodeId || !stringValue(row.name) || !stringValue(row.layer) || !TEMPORAL_STATES.has(stringValue(row.temporal_state))) {
      issues.push(issue("architecture_node_invalid", caseId, nodePath, "Node needs node_id, name, layer, and temporal_state."));
      return;
    }
    nodeIds.add(nodeId);
  });
  edges.forEach((value, index) => {
    const row = objectValue(value);
    const edgePath = `${path}.architecture.edges[${index}]`;
    const from = stringValue(row?.from);
    const to = stringValue(row?.to);
    if (!row || !from || !to || !stringValue(row.relation)) {
      issues.push(issue("architecture_edge_invalid", caseId, edgePath, "Edge needs from, to, and relation."));
      return;
    }
    if (!nodeIds.has(from) || !nodeIds.has(to)) issues.push(issue("architecture_edge_node_unknown", caseId, edgePath, "Edge endpoints must reference declared nodes."));
  });
  if (!stringValue(architecture.version) || !stringValue(architecture.as_of)) {
    issues.push(issue("architecture_version_missing", caseId, `${path}.architecture`, "Architecture needs version and as_of."));
  }
}

function validateDomain(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const domain = objectValue(product.domain);
  if (!domain) {
    issues.push(issue("domain_missing", caseId, `${path}.domain`, "domain_pack needs a domain object."));
    return;
  }
  if (arrayValue(domain.entities).length === 0) issues.push(issue("domain_entities_missing", caseId, `${path}.domain.entities`, "Domain needs explicit entities."));
  if ([...arrayValue(domain.relations), ...arrayValue(domain.rules), ...arrayValue(domain.states), ...arrayValue(domain.invariants)].length === 0) {
    issues.push(issue("domain_structure_missing", caseId, `${path}.domain`, "Domain needs relations, rules, states, or invariants."));
  }
}

function validateEntity(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const entity = objectValue(product.entity);
  if (!entity || !stringValue(entity.name)) {
    issues.push(issue("entity_missing", caseId, `${path}.entity`, "entity_card needs entity.name."));
    return;
  }
  for (const field of ["fields", "relations", "lifecycle", "invariants"] as const) {
    if (arrayValue(entity[field]).length === 0) issues.push(issue(`entity_${field}_missing`, caseId, `${path}.entity.${field}`, `${field} must retain explicit knowledge.`));
  }
}

function validateFlow(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const flow = objectValue(product.flow);
  if (!flow || !stringValue(flow.trigger)) {
    issues.push(issue("flow_missing", caseId, `${path}.flow`, "flow_card needs flow.trigger."));
    return;
  }
  if (arrayValue(flow.nodes).length < 2) issues.push(issue("flow_nodes_insufficient", caseId, `${path}.flow.nodes`, "Flow needs ordered nodes."));
  if (arrayValue(flow.edges).length < 1) issues.push(issue("flow_edges_insufficient", caseId, `${path}.flow.edges`, "Flow needs explicit edges."));
  for (const field of ["exceptions", "recovery"] as const) {
    if (arrayValue(flow[field]).length === 0) issues.push(issue(`flow_${field}_missing`, caseId, `${path}.flow.${field}`, `${field} must be explicit; use Gap if unknown.`));
  }
}

function validateDecision(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const decision = objectValue(product.decision);
  if (!decision || !stringValue(decision.context) || !stringValue(decision.choice) || !stringValue(decision.state)) {
    issues.push(issue("decision_missing", caseId, `${path}.decision`, "decision_card needs context, choice, and state."));
    return;
  }
  for (const field of ["options", "rationale", "rejected", "impact"] as const) {
    if (arrayValue(decision[field]).length === 0) issues.push(issue(`decision_${field}_missing`, caseId, `${path}.decision.${field}`, `${field} must be explicit; use unknown when the source is silent.`));
  }
}

function validatePrinciple(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const principle = objectValue(product.principle);
  if (!principle || !stringValue(principle.statement)) {
    issues.push(issue("principle_missing", caseId, `${path}.principle`, "principle_card needs principle.statement."));
    return;
  }
  for (const field of ["triggers", "scope", "exceptions", "rationale", "retirement_signals"] as const) {
    if (arrayValue(principle[field]).length === 0) {
      issues.push(issue(`principle_${field}_missing`, caseId, `${path}.principle.${field}`, `${field} must be explicit; use none or unknown when the source is silent.`));
    }
  }
}

function validatePlaybook(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const procedure = objectValue(product.procedure);
  if (!procedure) {
    issues.push(issue("playbook_procedure_missing", caseId, `${path}.procedure`, "playbook needs a procedure object."));
    return;
  }
  for (const field of ["preconditions", "inputs", "steps", "checks", "branches", "rollback", "stop_conditions"] as const) {
    if (arrayValue(procedure[field]).length === 0) issues.push(issue(`playbook_${field}_missing`, caseId, `${path}.procedure.${field}`, `${field} needs at least one item.`));
  }
}

function validatePersonEvidence(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const evidence = objectValue(product.person_evidence);
  if (!evidence || !stringValue(evidence.person_id)) {
    issues.push(issue("person_evidence_missing", caseId, `${path}.person_evidence`, "person_evidence_view needs person_id."));
    return;
  }
  if (stringArray(evidence.identity_refs).length === 0) issues.push(issue("person_identity_refs_missing", caseId, `${path}.person_evidence.identity_refs`, "Identity refs are required."));
  if (arrayValue(evidence.timeline).length === 0) issues.push(issue("person_timeline_missing", caseId, `${path}.person_evidence.timeline`, "Evidence view needs a timeline."));
  if (!stringValue(evidence.from) || !stringValue(evidence.to)) issues.push(issue("person_time_range_missing", caseId, `${path}.person_evidence`, "Evidence view needs from and to."));
  if (!stringValue(evidence.counterevidence_search)) issues.push(issue("person_counterevidence_search_missing", caseId, `${path}.person_evidence.counterevidence_search`, "Record the searched counterevidence window."));
}

function validatePersonObservation(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const observation = objectValue(product.observation);
  if (!observation) {
    issues.push(issue("person_observation_missing", caseId, `${path}.observation`, "person_observation needs an observation object."));
    return;
  }
  for (const field of ["person_id", "view", "pattern", "trigger", "response_shape", "identity_confidence", "pattern_confidence", "counterevidence_search"] as const) {
    if (!stringValue(observation[field])) issues.push(issue(`person_${field}_missing`, caseId, `${path}.observation.${field}`, `${field} is required.`));
  }
  if (stringValue(observation.identity_confidence) !== "high") issues.push(issue("person_identity_confidence_insufficient", caseId, `${path}.observation.identity_confidence`, "Stable observation requires high identity confidence."));
  if (!["medium", "high"].includes(stringValue(observation.pattern_confidence))) issues.push(issue("person_pattern_confidence_insufficient", caseId, `${path}.observation.pattern_confidence`, "Stable observation requires at least medium pattern confidence."));
  for (const field of ["usable_for", "do_not_use_for"] as const) {
    if (stringArray(observation[field]).length === 0) issues.push(issue(`person_${field}_missing`, caseId, `${path}.observation.${field}`, `${field} must be explicit.`));
  }
  const episodes = arrayValue(observation.episodes);
  if (episodes.length < 3) issues.push(issue("person_episode_count_insufficient", caseId, `${path}.observation.episodes`, "Stable observation needs at least three semantically independent episodes."));
  const sourceIds = new Set<string>();
  const dates = new Set<string>();
  episodes.forEach((value, index) => {
    const row = objectValue(value);
    const episodePath = `${path}.observation.episodes[${index}]`;
    if (!row || !stringValue(row.episode_ref) || !stringValue(row.source_id) || !stringValue(row.date) || !stringValue(row.semantic_basis)) {
      issues.push(issue("person_episode_invalid", caseId, episodePath, "Episode needs episode_ref, source_id, date, and semantic_basis."));
      return;
    }
    sourceIds.add(stringValue(row.source_id));
    dates.add(stringValue(row.date).slice(0, 10));
  });
  if (sourceIds.size < 2) issues.push(issue("person_source_count_insufficient", caseId, `${path}.observation.episodes`, "Stable observation needs at least two sources or source types."));
  if (dates.size < 2) issues.push(issue("person_date_count_insufficient", caseId, `${path}.observation.episodes`, "Stable observation needs at least two distinct dates."));
}

function validateGap(product: JsonObject, path: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  const gap = objectValue(product.gap);
  if (!gap) {
    issues.push(issue("gap_missing", caseId, `${path}.gap`, "gap product needs a gap object."));
    return;
  }
  for (const field of ["missing", "why_it_matters", "next_evidence"] as const) {
    if (stringArray(gap[field]).length === 0) issues.push(issue(`gap_${field}_missing`, caseId, `${path}.gap.${field}`, `${field} needs at least one item.`));
  }
}

function verifyResultFidelity(result: JsonObject, manifestCase: JsonObject, issues: ExtractionValidationIssue[]): void {
  const caseId = String(manifestCase.case_id);
  const snapshots = new Map<string, string>();
  for (const value of arrayValue(manifestCase.source_snapshots)) {
    const snapshot = objectValue(value);
    const sourceId = stringValue(snapshot?.source_id);
    const path = stringValue(snapshot?.path);
    if (!snapshot || !sourceId || !path) continue;
    if (!existsSync(path)) {
      issues.push(issue("evidence_snapshot_missing", caseId, "manifest.source_snapshots", `Frozen source snapshot does not exist: ${path}.`));
      continue;
    }
    const content = readFileSync(path, "utf8");
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== stringValue(snapshot.content_sha256)) {
      issues.push(issue("evidence_snapshot_hash_mismatch", caseId, "manifest.source_snapshots", `Frozen source snapshot hash changed: ${sourceId}.`));
      continue;
    }
    snapshots.set(sourceId, content);
  }
  if (arrayValue(manifestCase.source_units).length > 0) {
    issues.push(...verifyFrozenSourceUnits(manifestCase, snapshots));
  }
  for (const value of arrayValue(result.evidence_units)) {
    const evidence = objectValue(value);
    if (!evidence) continue;
    const content = snapshots.get(stringValue(evidence.source_id));
    const excerpt = stringValue(evidence.excerpt);
    if (content !== undefined && excerpt && !content.includes(excerpt)) {
      issues.push(issue(
        "evidence_excerpt_not_in_snapshot",
        caseId,
        `evidence_units.${stringValue(evidence.evidence_id)}.excerpt`,
        "Preserved excerpt is not an exact substring of the frozen Source snapshot.",
      ));
    }
  }
  const facts = arrayValue(result.facts).flatMap((value) => {
    const row = objectValue(value);
    return row && stringValue(row.fact_id) ? [row] : [];
  });
  const factsById = new Map(facts.map((fact) => [stringValue(fact.fact_id), fact]));
  const usedFacts = new Set<string>();
  for (const claimValue of arrayValue(result.claims)) {
    const claim = objectValue(claimValue);
    for (const ref of [...stringArray(claim?.fact_refs), ...stringArray(claim?.counterevidence_fact_refs)]) usedFacts.add(ref);
  }
  for (const productValue of arrayValue(result.products)) {
    const product = objectValue(productValue);
    for (const ref of stringArray(product?.fact_refs)) usedFacts.add(ref);
  }
  for (const coverageValue of arrayValue(result.coverage)) {
    const coverage = objectValue(coverageValue);
    for (const ref of stringArray(coverage?.fact_refs)) usedFacts.add(ref);
  }
  for (const fact of facts) {
    const factId = stringValue(fact.fact_id);
    if (!usedFacts.has(factId) && stringValue(fact.importance) !== "context") {
      issues.push(issue("fact_orphaned", caseId, `facts.${factId}`, "Core/supporting fact is not consumed by coverage, claim, or product."));
    }
  }
  const obligations = new Map(arrayValue(manifestCase.obligations).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.obligation_id);
    return row && id ? [[id, row] as const] : [];
  }));
  for (const coverageValue of arrayValue(result.coverage)) {
    const coverage = objectValue(coverageValue);
    const obligation = obligations.get(stringValue(coverage?.obligation_id));
    if (!coverage || !obligation || stringValue(coverage.disposition) !== "covered" || stringValue(obligation.importance) !== "core") continue;
    const refs = stringArray(coverage.fact_refs).flatMap((ref) => factsById.get(ref) ? [factsById.get(ref)!] : []);
    if (refs.length > 0 && refs.every((fact) => stringValue(fact.derivation) === "inference")) {
      issues.push(issue("core_coverage_inference_only", caseId, `coverage.${stringValue(coverage.obligation_id)}`, "A core obligation cannot be covered only by inferred facts."));
    }
  }
  for (const productValue of arrayValue(result.products)) {
    const product = objectValue(productValue);
    if (stringValue(product?.product_type) !== "person_observation") continue;
    const observation = objectValue(product?.observation);
    const episodeRefs = new Set(arrayValue(observation?.episodes).flatMap((value) => {
      const row = objectValue(value);
      return row ? stringArray(row.evidence_ids) : [];
    }));
    if (episodeRefs.size < 3) {
      issues.push(issue("person_semantic_evidence_insufficient", caseId, "products.observation.episodes", "Three episode rows must point to at least three distinct evidence units."));
    }
  }
}

function requireEqual(result: JsonObject, field: string, expected: string, caseId: string, issues: ExtractionValidationIssue[]): void {
  if (stringValue(result[field]) !== expected) {
    issues.push(issue(`${field}_mismatch`, caseId, field, `${field} must match the frozen contract.`));
  }
}

function hasIssuePrefix(issues: ExtractionValidationIssue[], prefixes: string[]): boolean {
  return issues.some((item) => prefixes.some((prefix) => item.code.startsWith(prefix)));
}

export function issue(code: string, caseId: string | null, path: string, message: string): ExtractionValidationIssue {
  return { code, caseId, path, message };
}

export function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function rawStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stringArray(value: unknown): string[] {
  return arrayValue(value).flatMap((item) => {
    const text = stringValue(item);
    return text ? [text] : [];
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
