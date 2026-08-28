import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  CLAIM_SUPPORT_STATUSES,
  FACT_IMPORTANCE,
  PRODUCT_OPERATIONS,
  QUESTION_DISPOSITIONS,
  REFERENCE_FACT_DISPOSITIONS,
  SOURCE_UNIT_DISPOSITIONS,
  type ExtractionInformationLossMetrics,
  type ExtractionValidationIssue,
  type JsonObject,
} from "./contracts.ts";

const MATERIAL_PRESERVED = new Set(["preserved", "paraphrased", "aggregated", "view_omitted"]);
const NON_PUBLISHABLE_PRODUCTS = new Set(["gap", "person_evidence_view", "experience_record", "review_writing"]);

export function validateInformationLossResult(
  result: JsonObject,
  manifestCase: JsonObject,
  caseId: string,
  evidenceIds: Set<string>,
  factIds: Set<string>,
  productIds: Set<string>,
  disposition: string,
): ExtractionValidationIssue[] {
  const issues: ExtractionValidationIssue[] = [];
  const sourceUnits = indexedObjects(manifestCase.source_units, "unit_id");
  const referenceFacts = indexedObjects(manifestCase.reference_facts, "reference_fact_id");
  const questions = indexedObjects(manifestCase.questions, "question_id");

  validateEvidenceSourceUnits(result, sourceUnits, caseId, issues);
  validateFactReferences(result, referenceFacts, caseId, issues);
  validateSourceUnitDispositions(result, sourceUnits, caseId, evidenceIds, factIds, disposition, issues);
  const conflictedResultFactIds = validateReferenceFactDispositions(
    result,
    referenceFacts,
    caseId,
    factIds,
    disposition,
    issues,
  );
  validateClaimSupport(result, caseId, disposition, issues);
  const products = validateProducts(result, manifestCase, questions, caseId, issues);
  validateQuestionResults(result, questions, products, caseId, factIds, productIds, disposition, issues);
  validateConflictExposure(products, conflictedResultFactIds, caseId, issues);
  return issues;
}

function validateEvidenceSourceUnits(
  result: JsonObject,
  sourceUnits: Map<string, JsonObject>,
  caseId: string,
  issues: ExtractionValidationIssue[],
): void {
  arrayValue(result.evidence_units).forEach((value, index) => {
    const row = objectValue(value);
    const refs = stringArray(row?.source_unit_refs);
    const path = `evidence_units[${index}].source_unit_refs`;
    if (refs.length === 0) issues.push(issue("source_unit_evidence_refs_missing", caseId, path, "V3 evidence needs source_unit_refs."));
    for (const ref of refs) {
      if (!sourceUnits.has(ref)) issues.push(issue("source_unit_evidence_ref_unknown", caseId, path, `Unknown source unit ${ref}.`));
    }
  });
}

function validateFactReferences(
  result: JsonObject,
  referenceFacts: Map<string, JsonObject>,
  caseId: string,
  issues: ExtractionValidationIssue[],
): void {
  arrayValue(result.facts).forEach((value, index) => {
    const row = objectValue(value);
    const refs = stringArray(row?.reference_fact_refs);
    const path = `facts[${index}].reference_fact_refs`;
    if (stringValue(row?.importance) !== "context" && refs.length === 0) {
      issues.push(issue("reference_fact_refs_missing", caseId, path, "Core/supporting V3 fact needs reference_fact_refs."));
    }
    for (const ref of refs) {
      if (!referenceFacts.has(ref)) issues.push(issue("reference_fact_ref_unknown", caseId, path, `Unknown reference fact ${ref}.`));
    }
  });
}

function validateSourceUnitDispositions(
  result: JsonObject,
  sourceUnits: Map<string, JsonObject>,
  caseId: string,
  evidenceIds: Set<string>,
  factIds: Set<string>,
  disposition: string,
  issues: ExtractionValidationIssue[],
): void {
  const seen = new Set<string>();
  arrayValue(result.source_unit_dispositions).forEach((value, index) => {
    const row = objectValue(value);
    const path = `source_unit_dispositions[${index}]`;
    const unitId = stringValue(row?.unit_id);
    const sourceUnit = sourceUnits.get(unitId);
    if (!row || !unitId || !sourceUnit) {
      issues.push(issue("source_unit_disposition_invalid", caseId, path, "Disposition needs a known unit_id."));
      return;
    }
    if (seen.has(unitId)) issues.push(issue("source_unit_disposition_duplicate", caseId, `${path}.unit_id`, `Duplicate disposition for ${unitId}.`));
    seen.add(unitId);
    const unitDisposition = stringValue(row.disposition);
    if (!SOURCE_UNIT_DISPOSITIONS.has(unitDisposition)) {
      issues.push(issue("source_unit_disposition_value_invalid", caseId, `${path}.disposition`, "Unsupported source unit disposition."));
    }
    if (!stringValue(row.reason)) issues.push(issue("source_unit_disposition_reason_missing", caseId, `${path}.reason`, "Every source unit disposition needs a reason."));
    const evidenceRefs = stringArray(row.evidence_ids);
    const resultFactRefs = stringArray(row.fact_refs);
    if (unitDisposition === "extracted" && (evidenceRefs.length === 0 || resultFactRefs.length === 0)) {
      issues.push(issue("source_unit_extracted_refs_missing", caseId, path, "Extracted source unit needs evidence_ids and fact_refs."));
    }
    for (const ref of evidenceRefs) if (!evidenceIds.has(ref)) issues.push(issue("source_unit_evidence_unknown", caseId, `${path}.evidence_ids`, `Unknown evidence ${ref}.`));
    for (const ref of resultFactRefs) if (!factIds.has(ref)) issues.push(issue("source_unit_fact_unknown", caseId, `${path}.fact_refs`, `Unknown fact ${ref}.`));
    const importance = stringValue(sourceUnit.importance);
    if (disposition === "admit" && importance === "core" && ["unreadable", "blocked"].includes(unitDisposition)) {
      issues.push(issue("source_unit_material_unresolved", caseId, path, `${importance} source unit ${unitId} is ${unitDisposition}.`));
    }
  });
  for (const unitId of sourceUnits.keys()) {
    if (!seen.has(unitId)) issues.push(issue("source_unit_disposition_missing", caseId, "source_unit_dispositions", `No disposition for ${unitId}.`));
  }
}

function validateReferenceFactDispositions(
  result: JsonObject,
  referenceFacts: Map<string, JsonObject>,
  caseId: string,
  factIds: Set<string>,
  disposition: string,
  issues: ExtractionValidationIssue[],
): Set<string> {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  arrayValue(result.reference_fact_dispositions).forEach((value, index) => {
    const row = objectValue(value);
    const path = `reference_fact_dispositions[${index}]`;
    const referenceFactId = stringValue(row?.reference_fact_id);
    const referenceFact = referenceFacts.get(referenceFactId);
    if (!row || !referenceFactId || !referenceFact) {
      issues.push(issue("reference_fact_disposition_invalid", caseId, path, "Disposition needs a known reference_fact_id."));
      return;
    }
    if (seen.has(referenceFactId)) issues.push(issue("reference_fact_disposition_duplicate", caseId, `${path}.reference_fact_id`, `Duplicate disposition for ${referenceFactId}.`));
    seen.add(referenceFactId);
    const factDisposition = stringValue(row.disposition);
    if (!REFERENCE_FACT_DISPOSITIONS.has(factDisposition)) {
      issues.push(issue("reference_fact_disposition_value_invalid", caseId, `${path}.disposition`, "Unsupported reference fact disposition."));
    }
    if (!stringValue(row.reason)) issues.push(issue("reference_fact_disposition_reason_missing", caseId, `${path}.reason`, "Every reference fact disposition needs a reason."));
    const refs = stringArray(row.fact_refs);
    if ([...MATERIAL_PRESERVED, "conflicted"].includes(factDisposition) && refs.length === 0) {
      issues.push(issue("reference_fact_disposition_refs_missing", caseId, `${path}.fact_refs`, `${factDisposition} needs fact_refs.`));
    }
    for (const ref of refs) {
      if (!factIds.has(ref)) issues.push(issue("reference_fact_disposition_ref_unknown", caseId, `${path}.fact_refs`, `Unknown fact ${ref}.`));
      if (factDisposition === "conflicted") conflicts.add(ref);
    }
    const importance = stringValue(referenceFact.importance);
    if (factDisposition === "lost") {
      issues.push(issue(
        importance === "core" ? "information_loss_core_fact_lost" : "information_loss_fact_lost",
        caseId,
        path,
        `${importance} reference fact ${referenceFactId} was lost.`,
      ));
    }
    if (disposition === "admit" && importance === "core" && ["gap", "conflicted", "discarded"].includes(factDisposition)) {
      issues.push(issue("information_loss_core_fact_unresolved", caseId, path, `Core reference fact ${referenceFactId} is ${factDisposition}.`));
    }
  });
  for (const referenceFactId of referenceFacts.keys()) {
    if (!seen.has(referenceFactId)) issues.push(issue("reference_fact_disposition_missing", caseId, "reference_fact_dispositions", `No disposition for ${referenceFactId}.`));
  }
  return conflicts;
}

function validateClaimSupport(
  result: JsonObject,
  caseId: string,
  disposition: string,
  issues: ExtractionValidationIssue[],
): void {
  arrayValue(result.claims).forEach((value, index) => {
    const row = objectValue(value);
    const status = stringValue(row?.support_status);
    const path = `claims[${index}].support_status`;
    if (!CLAIM_SUPPORT_STATUSES.has(status)) issues.push(issue("claim_support_status_invalid", caseId, path, "V3 claim needs support_status."));
    else if (disposition === "admit" && status !== "supported") {
      issues.push(issue("claim_support_status_not_supported", caseId, path, `Admitted claim is ${status}.`));
    }
  });
}

function validateProducts(
  result: JsonObject,
  manifestCase: JsonObject,
  questions: Map<string, JsonObject>,
  caseId: string,
  issues: ExtractionValidationIssue[],
): JsonObject[] {
  const existingKnowledge = arrayValue(manifestCase.existing_knowledge).flatMap((value) => {
    const row = objectValue(value);
    return row ? [row] : [];
  });
  const existingById = new Map(existingKnowledge.map((row) => [stringValue(row.knowledge_id), row]));
  const existingByKey = new Map(existingKnowledge.map((row) => [stringValue(row.canonical_key), row]));
  const seenCanonicalKeys = new Set<string>();
  const products = arrayValue(result.products).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  products.forEach((product, index) => {
    const path = `products[${index}]`;
    const productType = stringValue(product.product_type);
    if (NON_PUBLISHABLE_PRODUCTS.has(productType)) return;
    const canonicalKey = stringValue(product.canonical_key);
    if (!canonicalKey) issues.push(issue("canonical_key_missing", caseId, `${path}.canonical_key`, "Publishable V3 product needs canonical_key."));
    else if (seenCanonicalKeys.has(canonicalKey)) issues.push(issue("canonical_key_duplicate", caseId, `${path}.canonical_key`, `Multiple products use ${canonicalKey}.`));
    else seenCanonicalKeys.add(canonicalKey);
    const operation = stringValue(product.operation);
    if (!PRODUCT_OPERATIONS.has(operation)) issues.push(issue("product_operation_invalid", caseId, `${path}.operation`, "operation must be new, revise, or merge."));
    if (!stringValue(product.unique_value)) issues.push(issue("product_unique_value_missing", caseId, `${path}.unique_value`, "Product must state its non-duplicated consumer value."));
    const questionRefs = stringArray(product.question_refs);
    if (questionRefs.length === 0) issues.push(issue("product_question_refs_missing", caseId, `${path}.question_refs`, "Publishable product needs question_refs."));
    for (const ref of questionRefs) {
      if (!questions.has(ref)) issues.push(issue("product_question_ref_unknown", caseId, `${path}.question_refs`, `Unknown question ${ref}.`));
    }
    const existing = existingByKey.get(canonicalKey);
    const primaryKnowledgeId = stringValue(product.primary_knowledge_id);
    if (operation === "new" && existing) {
      issues.push(issue("canonical_key_existing_collision", caseId, `${path}.canonical_key`, `${canonicalKey} already belongs to ${stringValue(existing.knowledge_id)}.`));
    }
    if (["revise", "merge"].includes(operation)) {
      if (!primaryKnowledgeId || !existingById.has(primaryKnowledgeId)) {
        issues.push(issue("product_operation_primary_missing", caseId, `${path}.primary_knowledge_id`, `${operation} needs an existing primary_knowledge_id.`));
      } else if (stringValue(existingById.get(primaryKnowledgeId)?.canonical_key) !== canonicalKey) {
        issues.push(issue("product_operation_canonical_mismatch", caseId, `${path}.canonical_key`, "Primary Knowledge canonical_key must match the product."));
      }
    }
  });
  validateDominatedProducts(products, caseId, issues);
  return products;
}

function validateDominatedProducts(products: JsonObject[], caseId: string, issues: ExtractionValidationIssue[]): void {
  for (let index = 0; index < products.length; index += 1) {
    const left = products[index];
    const type = stringValue(left.product_type);
    if (NON_PUBLISHABLE_PRODUCTS.has(type)) continue;
    for (let otherIndex = 0; otherIndex < products.length; otherIndex += 1) {
      if (index === otherIndex) continue;
      const right = products[otherIndex];
      if (stringValue(right.product_type) !== type) continue;
      if (isSubset(stringArray(left.question_refs), stringArray(right.question_refs))
        && isSubset(stringArray(left.fact_refs), stringArray(right.fact_refs))
        && isSubset(stringArray(left.consumer_tasks), stringArray(right.consumer_tasks))) {
        issues.push(issue(
          "product_dominated",
          caseId,
          `products[${index}]`,
          `${stringValue(left.product_id)} is fully covered by ${stringValue(right.product_id)}.`,
        ));
        break;
      }
    }
  }
}

function validateQuestionResults(
  result: JsonObject,
  questions: Map<string, JsonObject>,
  products: JsonObject[],
  caseId: string,
  factIds: Set<string>,
  productIds: Set<string>,
  disposition: string,
  issues: ExtractionValidationIssue[],
): void {
  const seen = new Set<string>();
  arrayValue(result.question_results).forEach((value, index) => {
    const row = objectValue(value);
    const path = `question_results[${index}]`;
    const questionId = stringValue(row?.question_id);
    const question = questions.get(questionId);
    if (!row || !questionId || !question) {
      issues.push(issue("question_result_invalid", caseId, path, "Question result needs a known question_id."));
      return;
    }
    if (seen.has(questionId)) issues.push(issue("question_result_duplicate", caseId, `${path}.question_id`, `Duplicate result for ${questionId}.`));
    seen.add(questionId);
    const questionDisposition = stringValue(row.disposition);
    if (!QUESTION_DISPOSITIONS.has(questionDisposition)) issues.push(issue("question_disposition_invalid", caseId, `${path}.disposition`, "Question disposition is not supported."));
    const resultFactRefs = stringArray(row.fact_refs);
    const resultProductRefs = stringArray(row.product_refs);
    if (questionDisposition === "answered" && (resultFactRefs.length === 0 || resultProductRefs.length === 0)) {
      issues.push(issue("question_answer_refs_missing", caseId, path, "Answered question needs fact_refs and product_refs."));
    }
    for (const ref of resultFactRefs) if (!factIds.has(ref)) issues.push(issue("question_fact_ref_unknown", caseId, `${path}.fact_refs`, `Unknown fact ${ref}.`));
    for (const ref of resultProductRefs) if (!productIds.has(ref)) issues.push(issue("question_product_ref_unknown", caseId, `${path}.product_refs`, `Unknown product ${ref}.`));
    if (questionDisposition !== "answered" && !stringValue(row.reason)) issues.push(issue("question_reason_missing", caseId, `${path}.reason`, "Unanswered question needs a reason."));
    if (disposition === "admit" && stringValue(question.importance) === "core" && questionDisposition !== "answered") {
      issues.push(issue("question_core_unanswered", caseId, path, `Core question ${questionId} is ${questionDisposition}.`));
    }
    if (questionDisposition === "answered") {
      const requiredTypes = stringArray(question.required_product_types);
      const answeredTypes = resultProductRefs.flatMap((ref) => {
        const product = products.find((item) => stringValue(item.product_id) === ref);
        return product ? [stringValue(product.product_type)] : [];
      });
      if (requiredTypes.length > 0 && !requiredTypes.some((type) => answeredTypes.includes(type))) {
        issues.push(issue("question_product_type_missing", caseId, `${path}.product_refs`, `Question ${questionId} requires one of: ${requiredTypes.join(", ")}.`));
      }
    }
  });
  for (const questionId of questions.keys()) {
    if (!seen.has(questionId)) issues.push(issue("question_result_missing", caseId, "question_results", `No result for ${questionId}.`));
  }
}

function validateConflictExposure(
  products: JsonObject[],
  conflictedResultFactIds: Set<string>,
  caseId: string,
  issues: ExtractionValidationIssue[],
): void {
  if (conflictedResultFactIds.size === 0) return;
  const exposed = new Set(products.flatMap((product) => [
    ...stringArray(product.conflict_refs),
    ...(stringValue(product.product_type) === "gap" ? stringArray(product.fact_refs) : []),
  ]));
  for (const ref of conflictedResultFactIds) {
    if (!exposed.has(ref)) issues.push(issue("information_loss_conflict_unexposed", caseId, "products", `Conflicted fact ${ref} is not exposed by a product or Gap.`));
  }
}

export function verifyFrozenSourceUnits(
  manifestCase: JsonObject,
  snapshotContents: Map<string, string>,
): ExtractionValidationIssue[] {
  const caseId = String(manifestCase.case_id);
  const issues: ExtractionValidationIssue[] = [];
  arrayValue(manifestCase.source_units).forEach((value, index) => {
    const row = objectValue(value);
    if (!row) return;
    const path = `manifest.source_units[${index}]`;
    const sourceId = stringValue(row.source_id);
    const expectedHash = stringValue(row.content_sha256);
    const content = rawStringValue(row.content);
    const artifactPath = stringValue(row.artifact_path);
    if (content) {
      if (sha256(content) !== expectedHash) issues.push(issue("source_unit_hash_mismatch", caseId, `${path}.content_sha256`, "Frozen source unit content hash changed."));
      const snapshot = snapshotContents.get(sourceId);
      if (snapshot !== undefined && !snapshot.includes(content)) issues.push(issue("source_unit_content_not_in_snapshot", caseId, `${path}.content`, "Source unit content is not present in its frozen Source snapshot."));
    } else if (artifactPath) {
      if (!existsSync(artifactPath)) issues.push(issue("source_unit_artifact_missing", caseId, `${path}.artifact_path`, `Source unit artifact does not exist: ${artifactPath}.`));
      else if (sha256(readFileSync(artifactPath)) !== expectedHash) issues.push(issue("source_unit_artifact_hash_mismatch", caseId, `${path}.content_sha256`, "Source unit artifact hash changed."));
    }
  });
  return issues;
}

export function calculateInformationLossMetrics(
  manifestCase: JsonObject,
  result: JsonObject,
): ExtractionInformationLossMetrics {
  const sourceUnits = arrayValue(manifestCase.source_units).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const sourceUnitDispositions = new Map(arrayValue(result.source_unit_dispositions).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.unit_id);
    return row && id ? [[id, row] as const] : [];
  }));
  const referenceFacts = arrayValue(manifestCase.reference_facts).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const referenceDispositions = new Map(arrayValue(result.reference_fact_dispositions).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.reference_fact_id);
    return row && id ? [[id, row] as const] : [];
  }));
  const coreFacts = referenceFacts.filter((fact) => stringValue(fact.importance) === "core");
  const supportingFacts = referenceFacts.filter((fact) => stringValue(fact.importance) === "supporting");
  const corePreserved = coreFacts.filter((fact) => MATERIAL_PRESERVED.has(stringValue(referenceDispositions.get(stringValue(fact.reference_fact_id))?.disposition))).length;
  const supportingDisposed = supportingFacts.filter((fact) => {
    const disposition = stringValue(referenceDispositions.get(stringValue(fact.reference_fact_id))?.disposition);
    return disposition && disposition !== "lost";
  }).length;
  const claims = arrayValue(result.claims).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const supportedClaims = claims.filter((claim) => stringValue(claim.support_status) === "supported").length;
  const questions = arrayValue(manifestCase.questions).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const questionResults = new Map(arrayValue(result.question_results).flatMap((value) => {
    const row = objectValue(value);
    const id = stringValue(row?.question_id);
    return row && id ? [[id, row] as const] : [];
  }));
  const answeredQuestions = questions.filter((question) => stringValue(questionResults.get(stringValue(question.question_id))?.disposition) === "answered").length;
  const conflicts = referenceFacts.filter((fact) => stringValue(referenceDispositions.get(stringValue(fact.reference_fact_id))?.disposition) === "conflicted");
  const products = arrayValue(result.products).flatMap((value) => objectValue(value) ? [objectValue(value)!] : []);
  const viewFactIds = new Set(products
    .filter((product) => !NON_PUBLISHABLE_PRODUCTS.has(stringValue(product.product_type)))
    .flatMap((product) => stringArray(product.fact_refs)));
  const visibleReferenceFacts = referenceFacts.filter((fact) => stringArray(referenceDispositions.get(stringValue(fact.reference_fact_id))?.fact_refs)
    .some((ref) => viewFactIds.has(ref)));
  const visibleCoreFacts = coreFacts.filter((fact) => stringArray(referenceDispositions.get(stringValue(fact.reference_fact_id))?.fact_refs)
    .some((ref) => viewFactIds.has(ref)));
  const exposedConflictFacts = new Set(products.flatMap((product) => [
    ...stringArray(product.conflict_refs),
    ...(stringValue(product.product_type) === "gap" ? stringArray(product.fact_refs) : []),
  ]));
  const exposedConflictCount = conflicts.filter((fact) => {
    const disposition = referenceDispositions.get(stringValue(fact.reference_fact_id));
    return stringArray(disposition?.fact_refs).some((ref) => exposedConflictFacts.has(ref));
  }).length;
  let totalWeight = 0;
  let lostWeight = 0;
  for (const fact of referenceFacts) {
    const weight = importanceWeight(stringValue(fact.importance));
    totalWeight += weight;
    if (stringValue(referenceDispositions.get(stringValue(fact.reference_fact_id))?.disposition) === "lost") lostWeight += weight;
  }
  const sourceCharacterCount = arrayValue(manifestCase.source_snapshots).reduce((total, value) => {
    const row = objectValue(value);
    const path = stringValue(row?.path);
    return total + (path && existsSync(path) ? readFileSync(path, "utf8").length : 0);
  }, 0);
  const knowledgeCharacterCount = JSON.stringify(arrayValue(result.products)).length;
  const extractedSourceUnits = sourceUnits.filter((unit) => stringValue(sourceUnitDispositions.get(stringValue(unit.unit_id))?.disposition) === "extracted");
  const materialSourceUnits = sourceUnits.filter((unit) => ["core", "supporting"].includes(stringValue(unit.importance)));
  const extractedMaterialSourceUnits = materialSourceUnits.filter((unit) => stringValue(sourceUnitDispositions.get(stringValue(unit.unit_id))?.disposition) === "extracted");
  const blockedSourceUnitCount = sourceUnits.filter((unit) => ["unreadable", "blocked"].includes(stringValue(sourceUnitDispositions.get(stringValue(unit.unit_id))?.disposition))).length;
  return {
    sourceUnitDispositionRate: ratio(sourceUnitDispositions.size, sourceUnits.length),
    sourceUnitExtractionRate: ratio(extractedSourceUnits.length, sourceUnits.length),
    materialSourceUnitExtractionRate: ratio(extractedMaterialSourceUnits.length, materialSourceUnits.length),
    blockedSourceUnitCount,
    coreFactRecall: ratio(corePreserved, coreFacts.length),
    supportingFactDispositionRate: ratio(supportingDisposed, supportingFacts.length, 1),
    viewFactRetention: ratio(visibleReferenceFacts.length, referenceFacts.length),
    viewCoreFactRetention: ratio(visibleCoreFacts.length, coreFacts.length),
    claimSupportPrecision: ratio(supportedClaims, claims.length, claims.length === 0 ? null : 1),
    questionCoverage: ratio(answeredQuestions, questions.length),
    conflictExposure: ratio(exposedConflictCount, conflicts.length, 1),
    semanticLoss: totalWeight === 0 ? null : lostWeight / totalWeight,
    sourceCharacterCount,
    knowledgeCharacterCount,
    compressionRatio: sourceCharacterCount === 0 ? null : knowledgeCharacterCount / sourceCharacterCount,
  };
}

export function emptyInformationLossMetrics(): ExtractionInformationLossMetrics {
  return {
    sourceUnitDispositionRate: null,
    sourceUnitExtractionRate: null,
    materialSourceUnitExtractionRate: null,
    blockedSourceUnitCount: 0,
    coreFactRecall: null,
    supportingFactDispositionRate: null,
    viewFactRetention: null,
    viewCoreFactRetention: null,
    claimSupportPrecision: null,
    questionCoverage: null,
    conflictExposure: null,
    semanticLoss: null,
    sourceCharacterCount: null,
    knowledgeCharacterCount: null,
    compressionRatio: null,
  };
}

function indexedObjects(value: unknown, key: string): Map<string, JsonObject> {
  return new Map(arrayValue(value).flatMap((item) => {
    const row = objectValue(item);
    const id = stringValue(row?.[key]);
    return row && id ? [[id, row] as const] : [];
  }));
}

function importanceWeight(importance: string): number {
  if (importance === "core") return 3;
  if (importance === "supporting") return 2;
  return 1;
}

function ratio(numerator: number, denominator: number, empty: number | null = null): number | null {
  return denominator === 0 ? empty : numerator / denominator;
}

function isSubset(left: string[], right: string[]): boolean {
  if (left.length === 0) return false;
  const values = new Set(right);
  return left.every((value) => values.has(value));
}

function issue(code: string, caseId: string, path: string, message: string): ExtractionValidationIssue {
  return { code, caseId, path, message };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).flatMap((item) => {
    const text = stringValue(item);
    return text ? [text] : [];
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
