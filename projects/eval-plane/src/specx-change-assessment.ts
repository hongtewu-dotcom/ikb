import type { AdapterEvaluation, EvalSubject } from "./eval-adapters.ts";
import {
  DETERMINISTIC_GRADER_VERSION,
  EVAL_CASE_SCHEMA,
  EVAL_SUITE_SCHEMA,
  type EvalCase,
  type EvalStatus,
  type EvalSuite,
} from "./eval-contract.ts";
import {
  SPECX_CHANGE_SUBJECT_VERSION,
  type SpecxArtifactUse,
  type SpecxChangeSubjectData,
  type SpecxCoreFileName,
  type SpecxWorkspaceFact,
} from "./specx-change-subject.ts";

export const SPECX_CHANGE_QUALITY_SUITE_ID = "specx-change-quality";
export const SPECX_CHANGE_QUALITY_SUITE_VERSION = "v1";

export const SPECX_CHANGE_QUALITY_CASE_IDS = [
  "specx-source-integrity",
  "specx-evidence-provenance",
  "specx-flight-outcome",
] as const;

type Row = Record<string, unknown>;

interface Findings {
  failures: string[];
  inconclusive: string[];
}

interface ManifestFacts {
  row: Row | null;
  services: string[];
  changeEntries: Array<{ id: string; service: string }>;
  acIds: string[];
}

interface VerificationArtifacts {
  ac: string;
  caseSpec: SpecxArtifactUse | null;
  caseResult: SpecxArtifactUse | null;
  logVerification: SpecxArtifactUse | null;
}

interface VerificationProvenanceAssessment {
  findings: Findings;
  caseFindings: Findings;
  logFindings: Findings;
  caseSpec: Row | null;
  caseResult: Row | null;
  log: Row | null;
}

const CLARIFY_LOCKS: SpecxCoreFileName[] = ["analyze.md", "clarify.md"];
const DESIGN_LOCKS: SpecxCoreFileName[] = ["analyze.md", "clarify.md", "design.md", "change-manifest.yaml"];
const READY_CHECKS = [
  "deploymentStateSeen",
  "totalCountPositive",
  "allReplicasRunning",
  "noErrors",
  "allRunnersRunning",
  "domainsPresent",
] as const;
const FLIGHT_OUTCOME_CAPABILITIES = new Set(["flight.chain.execute", "http.case.execute"]);
const CASE_RESULT_KEYS = [
  "schema", "caseId", "caseSpecHash", "runnerVersion", "runnerHash", "startedAt", "finishedAt",
  "environment", "cargoManifest", "status", "results", "budget",
] as const;
const LOG_VERIFICATION_KEYS = [
  "schema", "caseId", "caseResultHash", "environment", "status", "assertions", "verifiedAt",
] as const;

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hasExactKeys(value: Row, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function add(target: string[], code: string): void {
  if (code && !target.includes(code)) target.push(code);
}

function createFindings(): Findings {
  return { failures: [], inconclusive: [] };
}

function mergeFindings(target: Findings, source: Findings): void {
  source.failures.forEach((code) => add(target.failures, code));
  source.inconclusive.forEach((code) => add(target.inconclusive, code));
}

function decide(findings: Findings): EvalStatus {
  if (findings.failures.length > 0) return "fail";
  if (findings.inconclusive.length > 0) return "inconclusive";
  return "pass";
}

function safeChangeRef(changeId: string): string {
  const safe = changeId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown-change";
}

function artifactRefs(data: SpecxChangeSubjectData): string[] {
  return unique(data.artifactUses.flatMap((use) => use.read.declaration ? [`artifact://specx/${use.read.declaration.sha256}`] : []));
}

function evaluated(
  testCase: EvalCase,
  subject: SpecxChangeSubjectData,
  findings: Findings,
  metrics: AdapterEvaluation["metrics"],
  diagnosis?: AdapterEvaluation["diagnosis"],
): AdapterEvaluation {
  const status = decide(findings);
  const reasonCodes = unique(status === "fail" ? [...findings.failures, ...findings.inconclusive] : findings.inconclusive);
  return {
    observed: status,
    passed: status === "pass",
    status,
    reasonCodes,
    metrics,
    evidenceRefs: [`source://specx/${safeChangeRef(subject.changeId)}`, `case://${testCase.caseId}`],
    artifactRefs: artifactRefs(subject),
    diagnosis: diagnosis ?? (status === "inconclusive" ? "environment" : "subject"),
  };
}

function requireSpecxSubject(value: EvalSubject): SpecxChangeSubjectData {
  if (value.adapter !== "specx") throw new Error(`SpecX assessment requires adapter=specx, got ${value.adapter}`);
  if (value.subjectVersion !== SPECX_CHANGE_SUBJECT_VERSION) {
    throw new Error(`SpecX assessment requires ${SPECX_CHANGE_SUBJECT_VERSION}, got ${value.subjectVersion}`);
  }
  const data = value.data as unknown as SpecxChangeSubjectData;
  if (!data || typeof data !== "object" || !text(data.changeId)) throw new Error("SpecX subject data is invalid");
  return data;
}

function loadIssueRelevant(scope: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => scope === prefix || scope.startsWith(`${prefix}:`));
}

function addLoadIssues(data: SpecxChangeSubjectData, findings: Findings, prefixes: string[]): void {
  for (const issue of data.loadIssues) {
    if (loadIssueRelevant(issue.scope, prefixes)) add(findings.inconclusive, issue.code);
  }
}

function manifestFacts(data: SpecxChangeSubjectData, findings?: Findings): ManifestFacts {
  const manifest = row(data.manifest);
  const result: ManifestFacts = { row: manifest, services: [], changeEntries: [], acIds: [] };
  if (!manifest) {
    if (findings) add(findings.inconclusive, "manifest_invalid");
    return result;
  }
  if (manifest.version !== 2 && findings) add(findings.inconclusive, "manifest_version_invalid");
  const change = row(manifest.change);
  if (text(change?.name) !== data.changeId && findings) add(findings.inconclusive, "manifest_change_id_mismatch");
  const source = row(manifest.source);
  const retrieval = text(source?.retrieval);
  if (!source || !text(source.prd_url) || !["direct", "blocked", "code-reverse"].includes(retrieval)) {
    if (findings) add(findings.inconclusive, "manifest_source_invalid");
  } else if (["blocked", "code-reverse"].includes(retrieval) && !text(source.human_signoff)) {
    if (findings) add(findings.inconclusive, "manifest_source_signoff_missing");
  }

  const entries = array(manifest.entry_inventory);
  if (entries.length === 0 && findings) add(findings.inconclusive, "manifest_entries_missing");
  const entryIds = new Set<string>();
  for (const value of entries) {
    const entry = row(value);
    const id = text(entry?.id);
    const service = text(entry?.service);
    const disposition = text(entry?.disposition);
    if (!entry || !id || !service || !text(entry.kind) || !text(entry.symbol) || !["change", "no-change"].includes(disposition)) {
      if (findings) add(findings.inconclusive, "manifest_entry_invalid");
      continue;
    }
    if (entryIds.has(id) && findings) add(findings.inconclusive, "manifest_entry_duplicate");
    entryIds.add(id);
    result.services.push(service);
    if (disposition === "change") result.changeEntries.push({ id, service });
    if (disposition === "no-change" && !text(entry.reason) && findings) add(findings.inconclusive, "manifest_no_change_reason_missing");
  }

  const acs = array(manifest.acceptance_criteria);
  if (acs.length === 0 && findings) add(findings.inconclusive, "manifest_acceptance_criteria_missing");
  const seenAcs = new Set<string>();
  for (const value of acs) {
    const ac = row(value);
    const id = text(ac?.id);
    const entryRefs = array(ac?.entries).map(text).filter(Boolean);
    const prdRefs = array(ac?.prd_refs).map(text).filter(Boolean);
    if (!ac || !id || entryRefs.length === 0 || prdRefs.length === 0) {
      if (findings) add(findings.inconclusive, "manifest_acceptance_criterion_invalid");
      continue;
    }
    if (seenAcs.has(id) && findings) add(findings.inconclusive, "manifest_acceptance_criterion_duplicate");
    seenAcs.add(id);
    result.acIds.push(id);
    if (entryRefs.some((idRef) => !entryIds.has(idRef)) && findings) add(findings.inconclusive, "manifest_acceptance_entry_missing");
  }

  const coveredEntries = new Set<string>();
  const taskIds = new Set<string>();
  for (const value of array(manifest.tasks)) {
    const task = row(value);
    const id = text(task?.id);
    const service = text(task?.service);
    const refs = array(task?.entries).map(text).filter(Boolean);
    if (!task || !id || !service || refs.length === 0) {
      if (findings) add(findings.inconclusive, "manifest_task_invalid");
      continue;
    }
    if (taskIds.has(id) && findings) add(findings.inconclusive, "manifest_task_duplicate");
    taskIds.add(id);
    result.services.push(service);
    refs.forEach((entryId) => coveredEntries.add(entryId));
    if (refs.some((entryId) => !entryIds.has(entryId)) && findings) add(findings.inconclusive, "manifest_task_entry_missing");
  }
  if (result.changeEntries.some((entry) => !coveredEntries.has(entry.id)) && findings) add(findings.inconclusive, "manifest_change_entry_uncovered");
  result.services = unique(result.services).sort();
  result.acIds = unique(result.acIds);
  return result;
}

function coreHash(data: SpecxChangeSubjectData, name: SpecxCoreFileName): string | null {
  const fact = data.coreFiles.find((item) => item.name === name);
  return fact?.state === "present" && fact.sha256 ? `sha256:${fact.sha256}` : null;
}

function approvalRecord(data: SpecxChangeSubjectData, stage: string): Row | null {
  const approvals = row(data.approvals);
  const records = array(approvals?.records);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = row(records[index]);
    if (record?.kind === "stage" && record.stage === stage) return record;
  }
  return null;
}

function approvalMatches(data: SpecxChangeSubjectData, stage: string, locks: SpecxCoreFileName[]): boolean {
  if (row(data.approvals)?.version !== 1) return false;
  const record = approvalRecord(data, stage);
  const hashes = row(record?.artifact_hashes);
  if (!record || !text(record.approved_by) || !validRfc3339(record.approved_at) || !hashes) return false;
  return locks.every((name) => Boolean(coreHash(data, name)) && hashes[name] === coreHash(data, name));
}

function evidenceRow(data: SpecxChangeSubjectData, findings?: Findings): Row | null {
  const evidence = row(data.evidence);
  if (!evidence) {
    if (findings) add(findings.inconclusive, "execution_evidence_invalid");
    return null;
  }
  if (evidence.version !== 1 && findings) add(findings.inconclusive, "execution_evidence_version_invalid");
  return evidence;
}

function workspaceFor(data: SpecxChangeSubjectData, service: string): SpecxWorkspaceFact[] {
  return data.workspaces.filter((workspace) => workspace.declaration.service === service);
}

function sourceIntegrity(testCase: EvalCase, data: SpecxChangeSubjectData): AdapterEvaluation {
  const findings = createFindings();
  addLoadIssues(data, findings, ["core", "yaml:change-manifest.yaml", "yaml:approvals.yaml", "yaml:execution-evidence.yaml", "evidence:workspaces", "workspace"]);
  const missingCore = data.coreFiles.filter((file) => file.state !== "present" || !file.sha256).length;
  if (missingCore > 0) add(findings.inconclusive, "core_files_incomplete");
  if (!approvalMatches(data, "clarify", CLARIFY_LOCKS)) add(findings.inconclusive, "clarify_approval_invalid");
  if (!approvalMatches(data, "design", DESIGN_LOCKS)) add(findings.inconclusive, "design_approval_invalid");

  const manifest = manifestFacts(data, findings);
  const evidence = evidenceRow(data, findings);
  const implementations = array(evidence?.implementations);
  const reviews = array(evidence?.reviews);
  const implementationRows = implementations.map(row).filter((item): item is Row => Boolean(item));
  const reviewRows = reviews.map(row).filter((item): item is Row => Boolean(item));
  if (implementationRows.length !== implementations.length) add(findings.inconclusive, "implementation_record_invalid");
  if (reviewRows.length !== reviews.length) add(findings.inconclusive, "review_record_invalid");
  const expectedServices = new Set(manifest.services);
  const expectedEntries = new Set(manifest.changeEntries.map((entry) => entry.id));
  for (const workspace of data.workspaces) {
    if (!expectedServices.has(workspace.declaration.service)) add(findings.inconclusive, "workspace_unexpected");
  }
  for (const implementation of implementationRows) {
    if (!expectedEntries.has(text(implementation.entry))) add(findings.inconclusive, "implementation_unexpected");
  }

  for (const service of manifest.services) {
    const workspaces = workspaceFor(data, service);
    if (workspaces.length !== 1) {
      add(findings.inconclusive, workspaces.length === 0 ? "workspace_missing" : "workspace_duplicate");
      continue;
    }
    const workspace = workspaces[0];
    if (workspace.state !== "available") add(findings.inconclusive, "workspace_git_unavailable");
    if (workspace.actualHead !== workspace.declaration.head_commit) add(findings.inconclusive, "workspace_head_mismatch");
    if (workspace.actualBranch !== workspace.declaration.branch) add(findings.inconclusive, "workspace_branch_mismatch");
    if (workspace.baseIsAncestor !== true) add(findings.inconclusive, "workspace_base_not_ancestor");
    if (workspace.dirty !== false) add(findings.inconclusive, "workspace_dirty_or_unknown");
    if (!workspace.actualTree) add(findings.inconclusive, "workspace_tree_missing");

    const serviceReviews = reviewRows.filter((item) => text(item.service) === service);
    const latest = serviceReviews.at(-1);
    if (!latest) add(findings.inconclusive, "review_missing");
    else {
      if (text(latest.head_commit) !== workspace.declaration.head_commit) add(findings.inconclusive, "review_head_mismatch");
      if (text(latest.base_commit) !== workspace.declaration.base_commit) add(findings.inconclusive, "review_base_mismatch");
      const verdict = text(latest.verdict);
      if (verdict === "BLOCKED") add(findings.failures, "review_blocked");
      else if (!["LGTM", "APPROVED"].includes(verdict)) add(findings.inconclusive, "review_verdict_invalid");
    }
  }

  for (const entry of manifest.changeEntries) {
    const matches = implementationRows.filter((item) => text(item.entry) === entry.id);
    if (matches.length !== 1) {
      add(findings.inconclusive, matches.length === 0 ? "implementation_missing" : "implementation_duplicate");
      continue;
    }
    const implementation = matches[0];
    const workspace = workspaceFor(data, entry.service)[0];
    if (text(implementation.service) !== entry.service) add(findings.inconclusive, "implementation_service_mismatch");
    if (!workspace || text(implementation.commit) !== workspace.declaration.head_commit) add(findings.inconclusive, "implementation_commit_mismatch");
    const checks = array(implementation.checks).map(row).filter((item): item is Row => Boolean(item));
    if (checks.length === 0) add(findings.inconclusive, "implementation_checks_missing");
    for (const check of checks) {
      if (check.result === "fail") add(findings.failures, "implementation_check_failed");
      else if (check.result !== "pass") add(findings.inconclusive, "implementation_check_invalid");
    }
  }

  return evaluated(testCase, data, findings, {
    core_files: data.coreFiles.length,
    services: manifest.services.length,
    changed_entries: manifest.changeEntries.length,
    acceptance_criteria: manifest.acIds.length,
    workspaces: data.workspaces.length,
    implementations: implementations.length,
    reviews: reviews.length,
  }, findings.inconclusive.some((code) => code.includes("unavailable")) ? "environment" : "subject");
}

function artifactUseForDeployment(data: SpecxChangeSubjectData, service: string, index: number): SpecxArtifactUse | null {
  return data.artifactUses.find((use) => use.origin.type === "deployment" && use.origin.service === service && use.origin.index === index) ?? null;
}

function artifactUsesForVerification(data: SpecxChangeSubjectData, ac: string): SpecxArtifactUse[] {
  return data.artifactUses.filter((use) => use.origin.type === "verification" && use.origin.ac === ac);
}

function usableArtifact(use: SpecxArtifactUse | null, expectedKind: string, findings: Findings): Row | null {
  if (!use || !use.read.declaration || use.read.declaration.kind !== expectedKind || use.read.issues.length > 0 || !use.read.raw) {
    add(findings.inconclusive, "artifact_invalid");
    return null;
  }
  const value = row(use.read.value);
  if (!value) add(findings.inconclusive, "artifact_payload_invalid");
  return value;
}

function cargoManifestValid(value: Row, commit: string): boolean {
  const waitResult = row(value.waitResult);
  const selectedBuild = row(waitResult?.selectedBuild);
  const stack = row(waitResult?.stack);
  const checks = row(waitResult?.checks);
  const preflight = row(value.preflight);
  const stackUuid = text(value.stackUuid);
  const taskUuid = text(value.taskUuid);
  const swimlane = text(value.swimlane);
  return value.env === "test"
    && value.readyForAgent === true
    && text(preflight?.commit) === commit
    && Boolean(stackUuid && taskUuid && swimlane)
    && waitResult?.status === "ready"
    && text(selectedBuild?.taskUuid) === taskUuid
    && text(stack?.stackUUID ?? stack?.stackUuid) === stackUuid
    && text(stack?.swimlane) === swimlane
    && Boolean(checks)
    && READY_CHECKS.every((key) => checks?.[key] === true);
}

function verificationArtifacts(data: SpecxChangeSubjectData, manifest: ManifestFacts, findings: Findings): VerificationArtifacts[] {
  const evidence = evidenceRow(data, findings);
  const declared = array(evidence?.verification);
  const verifications = declared.map(row).filter((item): item is Row => Boolean(item));
  if (verifications.length !== declared.length) add(findings.inconclusive, "verification_record_invalid");
  const expectedAcs = new Set(manifest.acIds);
  if (verifications.some((verification) => !expectedAcs.has(text(verification.ac)))) {
    add(findings.inconclusive, "verification_unexpected");
  }
  const result: VerificationArtifacts[] = [];
  for (const ac of manifest.acIds) {
    const matches = verifications.filter((verification) => text(verification.ac) === ac);
    if (matches.length !== 1) {
      add(findings.inconclusive, matches.length === 0 ? "verification_missing" : "verification_duplicate");
      continue;
    }
    const uses = artifactUsesForVerification(data, ac);
    const byKind = (kind: string) => uses.filter((use) => use.read.declaration?.kind === kind);
    const caseSpecs = byKind("flight-case-spec");
    const caseResults = byKind("flight-case-result");
    const logs = byKind("flight-log-verification");
    if (uses.length !== 3 || caseSpecs.length !== 1 || caseResults.length !== 1 || logs.length !== 1) {
      add(findings.inconclusive, "verification_artifact_set_invalid");
    }
    result.push({ ac, caseSpec: caseSpecs.length === 1 ? caseSpecs[0] : null, caseResult: caseResults.length === 1 ? caseResults[0] : null, logVerification: logs.length === 1 ? logs[0] : null });
  }
  return result;
}

function deploymentCargo(data: SpecxChangeSubjectData, manifest: ManifestFacts, findings: Findings): Array<{ service: string; commit: string; hash: string }> {
  const evidence = evidenceRow(data, findings);
  const deployments = array(evidence?.deployments);
  const deploymentRows = deployments.map(row).filter((item): item is Row => Boolean(item));
  if (deploymentRows.length !== deployments.length) add(findings.inconclusive, "deployment_record_invalid");
  const expectedServices = new Set(manifest.services);
  if (deploymentRows.some((deployment) => !expectedServices.has(text(deployment.service)))) {
    add(findings.inconclusive, "deployment_unexpected");
  }
  const result: Array<{ service: string; commit: string; hash: string }> = [];
  for (const service of manifest.services) {
    const indexed = deployments.map((value, index) => ({ value: row(value), index })).filter((item) => item.value && text(item.value.service) === service);
    const latest = indexed.at(-1);
    if (!latest?.value) {
      add(findings.inconclusive, "deployment_missing");
      continue;
    }
    const commit = text(latest.value.commit);
    const workspace = workspaceFor(data, service)[0];
    if (!commit || !workspace || commit !== workspace.declaration.head_commit) add(findings.inconclusive, "deployment_commit_mismatch");
    const use = artifactUseForDeployment(data, service, latest.index);
    const cargo = usableArtifact(use, "cargo-manifest", findings);
    if (!cargo || !use?.read.declaration) continue;
    if (!cargoManifestValid(cargo, commit)) add(findings.inconclusive, "cargo_manifest_invalid");
    result.push({ service, commit, hash: use.read.declaration.sha256 });
  }
  return result;
}

function assessVerificationProvenance(
  item: VerificationArtifacts,
  cargos: Array<{ service: string; commit: string; hash: string }>,
): VerificationProvenanceAssessment {
  const caseFindings = createFindings();
  const logFindings = createFindings();
  const caseSpec = usableArtifact(item.caseSpec, "flight-case-spec", caseFindings);
  const caseResult = usableArtifact(item.caseResult, "flight-case-result", caseFindings);
  const log = usableArtifact(item.logVerification, "flight-log-verification", logFindings);
  const caseId = text(caseSpec?.caseId);
  const startedAtValid = validRfc3339(caseResult?.startedAt);
  const finishedAtValid = validRfc3339(caseResult?.finishedAt);

  if (caseSpec && caseResult && item.caseSpec?.read.declaration) {
    const capabilities = array(caseSpec.capabilities).map(text).filter(Boolean);
    if (caseSpec.schemaVersion !== 1 || caseSpec.environment !== "test" || !caseId || capabilities.length === 0
      || new Set(capabilities).size !== capabilities.length) {
      add(caseFindings.inconclusive, "case_spec_contract_invalid");
    }
    if (!hasExactKeys(caseResult, CASE_RESULT_KEYS)
      || caseResult.schema !== "flight-case-result-v2"
      || caseResult.environment !== "test"
      || text(caseResult.caseId) !== caseId
      || text(caseResult.caseSpecHash) !== item.caseSpec.read.declaration.sha256
      || text(caseResult.runnerVersion) !== "v2"
      || !/^[a-f0-9]{64}$/.test(text(caseResult.runnerHash))
      || !startedAtValid
      || !finishedAtValid
      || !Array.isArray(caseResult.results)
      || !row(caseResult.budget)) {
      add(caseFindings.inconclusive, "case_result_identity_invalid");
    }
    if (startedAtValid && finishedAtValid && Date.parse(text(caseResult.finishedAt)) < Date.parse(text(caseResult.startedAt))) {
      add(caseFindings.inconclusive, "case_result_time_order_invalid");
    }
    const cargo = row(caseResult.cargoManifest);
    if (!cargo || !cargos.some((candidate) => candidate.hash === text(cargo.sha256) && candidate.commit === text(cargo.commit))) {
      add(caseFindings.inconclusive, "case_result_cargo_mismatch");
    }
  }

  if (log && caseResult && item.caseResult?.read.declaration && caseId) {
    if (!hasExactKeys(log, LOG_VERIFICATION_KEYS)
      || log.schema !== "flight-log-verification-v1"
      || log.environment !== "test"
      || text(log.caseId) !== caseId
      || text(log.caseResultHash) !== item.caseResult.read.declaration.sha256) {
      add(logFindings.inconclusive, "log_verification_identity_invalid");
    }
    if (finishedAtValid && validRfc3339(log.verifiedAt)
      && Date.parse(text(log.verifiedAt)) < Date.parse(text(caseResult.finishedAt))) {
      add(logFindings.inconclusive, "log_verification_before_case_finished");
    }
  } else {
    add(logFindings.inconclusive, "log_verification_identity_invalid");
  }
  const findings = createFindings();
  mergeFindings(findings, caseFindings);
  mergeFindings(findings, logFindings);
  return { findings, caseFindings, logFindings, caseSpec, caseResult, log };
}

function provenanceFacts(data: SpecxChangeSubjectData): { findings: Findings; manifest: ManifestFacts; verifications: VerificationArtifacts[]; cargos: Array<{ service: string; commit: string; hash: string }> } {
  const findings = createFindings();
  addLoadIssues(data, findings, ["yaml:execution-evidence.yaml", "evidence:deployments", "evidence:verification", "artifact"]);
  const manifest = manifestFacts(data, findings);
  const cargos = deploymentCargo(data, manifest, findings);
  const verifications = verificationArtifacts(data, manifest, findings);
  for (const item of verifications) {
    mergeFindings(findings, assessVerificationProvenance(item, cargos).findings);
  }
  return { findings, manifest, verifications, cargos };
}

function evidenceProvenance(testCase: EvalCase, data: SpecxChangeSubjectData): AdapterEvaluation {
  const facts = provenanceFacts(data);
  return evaluated(testCase, data, facts.findings, {
    services: facts.manifest.services.length,
    deployments: facts.cargos.length,
    acceptance_criteria: facts.manifest.acIds.length,
    verification_sets: facts.verifications.length,
    artifact_uses: data.artifactUses.length,
  }, "subject");
}

function statusOf(value: unknown): string {
  return text(value).toLowerCase();
}

function explicitResultFailure(status: string): boolean {
  return status === "failed" || status === "cleanup_failed" || status === "fail";
}

function aggregateCaseStatus(results: Row[]): string {
  const statuses = results.map((result) => statusOf(result.status));
  if (statuses.includes("plan_invalid")) return "plan_invalid";
  if (statuses.includes("cleanup_failed")) return "cleanup_failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("required")) return "required";
  if (statuses.some((status) => status === "failed" || status === "fail")) return "failed";
  if (statuses.length > 0 && statuses.every((status) => status === "passed" || status === "ready")) return "passed";
  return "plan_invalid";
}

function validRfc3339(value: unknown): boolean {
  const input = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
    && Number.isFinite(Date.parse(input));
}

function evaluateCaseResult(caseSpec: Row, caseResult: Row, findings: Findings): void {
  const topStatus = statusOf(caseResult.status);
  if (explicitResultFailure(topStatus)) add(findings.failures, "flight_case_failed");
  else if (topStatus !== "passed") add(findings.inconclusive, "flight_case_not_completed");
  const declaredResults = array(caseResult.results);
  const parsedResults = declaredResults.map(row).filter((item): item is Row => Boolean(item));
  if (parsedResults.length !== declaredResults.length) add(findings.inconclusive, "flight_case_result_record_invalid");
  const latestByCapability = new Map<string, Row>();
  for (const result of parsedResults) {
    const capability = text(result.capability);
    if (!capability) add(findings.inconclusive, "flight_case_result_capability_missing");
    else latestByCapability.set(capability, result);
  }
  const results = [...latestByCapability.values()];
  if (results.length === 0) add(findings.inconclusive, "flight_case_results_missing");
  if (results.length > 0 && aggregateCaseStatus(results) !== topStatus) add(findings.inconclusive, "flight_case_status_aggregate_mismatch");
  for (const result of results) {
    const status = statusOf(result.status);
    if (explicitResultFailure(status)) add(findings.failures, "flight_capability_failed");
    else if (!["passed", "ready"].includes(status)) add(findings.inconclusive, "flight_capability_inconclusive");
    const evidence = row(result.evidence);
    if (evidence?.dryRun === true) add(findings.inconclusive, "dry_run_not_acceptable");
  }
  const observedCapabilities = new Set(latestByCapability.keys());
  const preflightEvidence = row(latestByCapability.get("case.preflight")?.evidence);
  for (const nested of array(preflightEvidence?.results).map(row).filter((item): item is Row => Boolean(item))) {
    const capability = text(nested.capability);
    if (capability) observedCapabilities.add(capability);
  }
  const capabilities = unique(array(caseSpec.capabilities).map(text));
  if (!capabilities.some((capability) => FLIGHT_OUTCOME_CAPABILITIES.has(capability))) {
    add(findings.inconclusive, "flight_outcome_capability_missing");
  }
  if (capabilities.some((capability) => !observedCapabilities.has(capability))) {
    add(findings.inconclusive, "flight_case_capability_coverage_missing");
  }
  if (capabilities.includes("flight.chain.execute")) {
    const cleanup = latestByCapability.get("cleanup.order");
    const cleanupEvidence = row(cleanup?.evidence);
    if (!cleanup) add(findings.inconclusive, "cleanup_result_missing");
    else if (explicitResultFailure(statusOf(cleanup.status))) add(findings.failures, "cleanup_failed");
    else if (statusOf(cleanup.status) !== "passed" || cleanupEvidence?.skipped === true) add(findings.inconclusive, "cleanup_not_proven");
  }
}

function evaluateLog(log: Row, findings: Findings): void {
  if (!validRfc3339(log.verifiedAt)) add(findings.inconclusive, "log_verified_at_invalid");
  const assertions = array(log.assertions).map(row).filter((item): item is Row => Boolean(item));
  if (assertions.length === 0) add(findings.inconclusive, "log_assertions_missing");
  let hasFailure = false;
  let hasInconclusive = false;
  const assertionIds = new Set<string>();
  for (const assertion of assertions) {
    const status = statusOf(assertion.status);
    const id = text(assertion.id);
    const evidenceRefs = array(assertion.evidenceRefs).map(text).filter(Boolean);
    const reasonCode = text(assertion.reasonCode);
    const assertionKeys = Object.prototype.hasOwnProperty.call(assertion, "reasonCode")
      ? ["id", "status", "evidenceRefs", "reasonCode"]
      : ["id", "status", "evidenceRefs"];
    if (!hasExactKeys(assertion, assertionKeys)
      || !id || !["pass", "fail", "inconclusive"].includes(status) || evidenceRefs.length === 0
      || (status !== "pass" && !reasonCode)) {
      add(findings.inconclusive, "log_assertion_invalid");
    }
    if (id && assertionIds.has(id)) add(findings.inconclusive, "log_assertion_duplicate");
    assertionIds.add(id);
    if (status === "fail") hasFailure = true;
    if (status === "inconclusive") hasInconclusive = true;
  }
  const topStatus = statusOf(log.status);
  if (topStatus === "fail" || hasFailure) add(findings.failures, "log_assertion_failed");
  else if (topStatus === "inconclusive" || hasInconclusive) add(findings.inconclusive, "log_assertion_inconclusive");
  else if (topStatus !== "pass") add(findings.inconclusive, "log_status_invalid");
  if ((topStatus === "pass" && (hasFailure || hasInconclusive))
    || (topStatus === "fail" && !hasFailure)
    || (topStatus === "inconclusive" && (hasFailure || !hasInconclusive))) {
    add(findings.inconclusive, "log_status_aggregate_mismatch");
  }
}

function flightOutcome(testCase: EvalCase, data: SpecxChangeSubjectData): AdapterEvaluation {
  const provenance = provenanceFacts(data);
  const findings = createFindings();
  if (provenance.findings.inconclusive.length > 0 || provenance.findings.failures.length > 0) add(findings.inconclusive, "evidence_provenance_not_established");
  for (const item of provenance.verifications) {
    const local = assessVerificationProvenance(item, provenance.cargos);
    const caseReady = local.caseFindings.failures.length === 0 && local.caseFindings.inconclusive.length === 0
      && local.caseSpec && local.caseResult;
    if (caseReady) evaluateCaseResult(local.caseSpec!, local.caseResult!, findings);
    else add(findings.inconclusive, "flight_case_identity_not_established");

    const logReady = caseReady && local.logFindings.failures.length === 0 && local.logFindings.inconclusive.length === 0
      && local.log;
    if (logReady) evaluateLog(local.log!, findings);
    else add(findings.inconclusive, "log_identity_not_established");
  }
  return evaluated(testCase, data, findings, {
    acceptance_criteria: provenance.manifest.acIds.length,
    evaluated_verifications: provenance.verifications.length,
    provenance_ready: provenance.findings.inconclusive.length === 0 && provenance.findings.failures.length === 0,
  }, findings.inconclusive.includes("evidence_provenance_not_established") ? "environment" : "subject");
}

export function specxChangeQualitySuite(): { suite: EvalSuite; cases: EvalCase[] } {
  const definitions = [
    {
      id: SPECX_CHANGE_QUALITY_CASE_IDS[0],
      title: "SpecX 源码与审批事实一致",
      description: "设计审批、Manifest、实现、评审和实际 Git 状态必须属于同一份 Change。",
      invariants: ["approval_current", "git_clean", "implementation_bound", "review_current"],
    },
    {
      id: SPECX_CHANGE_QUALITY_CASE_IDS[1],
      title: "SpecX 外部证据来源可追溯",
      description: "Artifact、Cargo、CaseSpec、CaseResult 和日志结果必须形成同一条身份链。",
      invariants: ["artifact_integrity", "cargo_commit_bound", "case_identity_bound", "log_identity_bound"],
    },
    {
      id: SPECX_CHANGE_QUALITY_CASE_IDS[2],
      title: "机票真实结果通过",
      description: "每条 AC 的业务执行、日志断言和清理终态必须明确通过。",
      invariants: ["flight_case_passed", "log_assertions_passed", "cleanup_passed"],
    },
  ];
  const cases = definitions.map((definition): EvalCase => ({
    schema: EVAL_CASE_SCHEMA,
    caseId: definition.id,
    suiteId: SPECX_CHANGE_QUALITY_SUITE_ID,
    suiteVersion: SPECX_CHANGE_QUALITY_SUITE_VERSION,
    level: "L1",
    title: definition.title,
    description: definition.description,
    inputRefs: ["source://specx/change"],
    expected: { outcome: "pass", invariants: definition.invariants },
    grader: { type: "deterministic", version: DETERMINISTIC_GRADER_VERSION },
    tags: ["specx", "real-change", "quality-gate"],
    adapter: "specx",
  }));
  return {
    suite: {
      schema: EVAL_SUITE_SCHEMA,
      kind: "run_assessment",
      suiteId: SPECX_CHANGE_QUALITY_SUITE_ID,
      suiteVersion: SPECX_CHANGE_QUALITY_SUITE_VERSION,
      harnessId: "specx",
      levels: ["L1"],
      graderVersion: DETERMINISTIC_GRADER_VERSION,
      cases: cases.map((item) => item.caseId),
      requiredCaseIds: cases.map((item) => item.caseId),
      thresholds: {},
      adapter: "specx",
    },
    cases,
  };
}

export function evaluateSpecxChangeCase(testCase: EvalCase, value: EvalSubject): AdapterEvaluation {
  const data = requireSpecxSubject(value);
  switch (testCase.caseId) {
    case "specx-source-integrity":
      return sourceIntegrity(testCase, data);
    case "specx-evidence-provenance":
      return evidenceProvenance(testCase, data);
    case "specx-flight-outcome":
      return flightOutcome(testCase, data);
    default:
      throw new Error(`SpecX Change adapter does not support case ${testCase.caseId}`);
  }
}
