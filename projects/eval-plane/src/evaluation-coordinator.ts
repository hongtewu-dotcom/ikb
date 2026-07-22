import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVAL_REPORT_SCHEMA, validateEvalResult, type EvalDiagnosis, type EvalReport } from "./eval-contract.ts";
import type { EvalRegistry } from "./eval-registry.ts";
import { runEvalSuite, type EvalRunOutput } from "./eval-runner.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "./run-assessment.ts";
import { loadRunSubject, type ArtifactRecordLike, type EventRecordLike, type RunSubjectStore } from "./run-subject.ts";

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "canceled"]);
const EVALUATION_LOCK_STALE_MS = 5 * 60 * 1000;
const EVALUATION_LOCK_WAIT_MS = 30 * 1000;
const EVALUATION_SUBJECT_RELOAD_LIMIT = 3;

export interface EvaluationCoordinatorStore extends RunSubjectStore {
  readonly home: string;
  reload?(): void;
  createArtifact(input: { runId: string; kind: string; label: string; path: string }): ArtifactRecordLike;
  recordHarnessEvent(runId: string, eventType: "run.artifact_linked" | "run.evaluation_completed", payload: unknown): EventRecordLike;
}

export interface CoordinatedEvaluation extends EvalRunOutput {
  evaluationKey: string;
  artifact: ArtifactRecordLike & { ref: string };
  evaluationEvent: EventRecordLike;
  reused: boolean;
}

export interface RepairEvaluationSummary {
  suiteId: string;
  scanned: number;
  created: number;
  reused: number;
  failed: number;
  failures: Array<{ runId: string; reasonCode: string }>;
}

export function coordinateRunEvaluation(
  store: EvaluationCoordinatorStore,
  registry: EvalRegistry,
  runId: string,
  options: { projectRoot: string; suiteId?: string } = { projectRoot: process.cwd() },
): CoordinatedEvaluation {
  const suiteId = options.suiteId ?? IKB_RUN_QUALITY_SUITE_ID;
  const suite = registry.getSuite(suiteId);
  if (suite.kind !== "run_assessment") throw new Error(`EvalSuite ${suiteId} is a Regression Suite and cannot assess a real Run`);
  let run = store.requireRun(runId);
  if (!TERMINAL_RUN_STATES.has(run.status)) throw new Error(`Run ${runId} must be terminal before assessment (got ${run.status})`);
  let subject = loadRunSubject(store, runId);
  let evaluationKey = evaluationIdentity(runId, suite.suiteId, suite.suiteVersion, subject.subjectHash, suite.graderVersion);
  for (let attempt = 0; attempt < EVALUATION_SUBJECT_RELOAD_LIMIT; attempt += 1) {
    const release = acquireEvaluationLock(store.home, evaluationKey);
    try {
      store.reload?.();
      run = store.requireRun(runId);
      if (!TERMINAL_RUN_STATES.has(run.status)) throw new Error(`Run ${runId} must be terminal before assessment (got ${run.status})`);
      const currentSubject = loadRunSubject(store, runId);
      const currentEvaluationKey = evaluationIdentity(runId, suite.suiteId, suite.suiteVersion, currentSubject.subjectHash, suite.graderVersion);
      if (currentEvaluationKey !== evaluationKey) {
        subject = currentSubject;
        evaluationKey = currentEvaluationKey;
        continue;
      }
      subject = currentSubject;
    const existing = loadEvaluationByKey(store, registry, runId, suiteId, evaluationKey, { allowMissingFile: true });
    if (existing) {
      ensureArtifactLink(store, runId, existing.artifact.id);
      return existing;
    }

    const evaluated = runEvalSuite(registry, suiteId, { projectRoot: options.projectRoot, runId, subject });
    const report: EvalReport = { ...evaluated.report, evaluationKey };
    const output: EvalRunOutput = { ...evaluated, report };
    const reportPath = evaluationReportPath(store.home, suiteId, runId, evaluationKey);
    persistReport(reportPath, report);
    const artifactLabel = `${suite.suiteId}@${suite.suiteVersion}`;
    const artifactRecord = store.listArtifacts({ runId }).find((item) => item.kind === "evaluation_report" && resolve(item.path) === reportPath)
      ?? store.createArtifact({ runId, kind: "evaluation_report", label: artifactLabel, path: reportPath });
    const artifactRef = `artifact://${artifactRecord.id}`;
    const artifact = { ...artifactRecord, ref: artifactRef };
    assertArtifactContent(artifactRecord, reportPath, evaluationKey);

    ensureArtifactLink(store, runId, artifactRecord.id);

    const concurrent = evaluationEventByKey(store.listEvents(), runId, suiteId, evaluationKey);
    if (concurrent) {
      return { ...output, evaluationKey, artifact, evaluationEvent: concurrent, reused: true };
    }
    const failedResults = output.results.filter((result) => result.status === "fail");
    const recovery = output.results.find((result) => result.caseId === "run-recovery-quality");
    const eventResult = output.report.hardGatePassed
      ? (failedResults.length === 0 ? "pass" : "partial")
      : "blocked";
    const evaluationEvent = store.recordHarnessEvent(runId, "run.evaluation_completed", {
      evalVersion: `eval-plane.${output.report.evalVersion}`,
      suiteId: output.report.suiteId,
      suiteVersion: output.report.suiteVersion,
      graderVersion: output.report.graderVersion,
      subjectVersion: subject.subjectVersion,
      subjectHash: subject.subjectHash,
      evaluationKey,
      diagnosis: aggregateDiagnosis(failedResults.map((result) => result.diagnosis)),
      reasonCodes: unique(failedResults.flatMap((result) => result.reasonCodes)),
      result: eventResult,
      totalCases: output.results.length,
      passedCases: output.results.length - failedResults.length,
      failedCases: failedResults.length,
      failedCaseRefs: failedResults.map((result) => `case://${result.caseId}`),
      artifactRefs: [artifactRef],
      firstPass: booleanMetric(recovery?.metrics.firstPass),
      finalPass: booleanMetric(recovery?.metrics.finalPass),
      retryRounds: numberMetric(recovery?.metrics.retryRounds),
      repairRounds: numberMetric(recovery?.metrics.repairRounds),
      recoverySucceeded: booleanMetric(recovery?.metrics.recoverySucceeded),
    });
    return { ...output, evaluationKey, artifact, evaluationEvent, reused: false };
    } finally {
      release();
    }
  }
  throw new Error(`Run ${runId} changed repeatedly while its assessment was starting`);
}

export function loadLatestRunEvaluation(store: EvaluationCoordinatorStore, registry: EvalRegistry, runId: string, suiteId = IKB_RUN_QUALITY_SUITE_ID): CoordinatedEvaluation | null {
  const events = [...store.listEvents()].reverse().filter((item) => item.aggregateType === "run"
    && item.aggregateId === runId
    && item.eventType === "run.evaluation_completed"
    && item.payload.suiteId === suiteId
    && typeof item.payload.evaluationKey === "string");
  for (const event of events) {
    if (stringArray(event.payload.artifactRefs).length === 0) continue;
    return loadEvaluationByKey(store, registry, runId, suiteId, String(event.payload.evaluationKey));
  }
  return null;
}

export function repairRunEvaluations(
  store: EvaluationCoordinatorStore,
  registry: EvalRegistry,
  options: { projectRoot: string; suiteId?: string; limit?: number },
): RepairEvaluationSummary {
  const suiteId = options.suiteId ?? IKB_RUN_QUALITY_SUITE_ID;
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Evaluation repair limit must be an integer between 1 and 10000");
  const runs = store.listRuns().filter((run) => TERMINAL_RUN_STATES.has(run.status)).slice(0, limit);
  const summary: RepairEvaluationSummary = { suiteId, scanned: runs.length, created: 0, reused: 0, failed: 0, failures: [] };
  for (const run of runs) {
    try {
      const result = coordinateRunEvaluation(store, registry, run.id, { projectRoot: options.projectRoot, suiteId });
      if (result.reused) summary.reused += 1;
      else summary.created += 1;
    } catch {
      summary.failed += 1;
      summary.failures.push({ runId: run.id, reasonCode: "evaluation_repair_failed" });
      recordEvaluationFailure(store, registry, run.id, suiteId, "evaluation_repair_failed");
    }
  }
  return summary;
}

export function recordEvaluationFailure(store: EvaluationCoordinatorStore, registry: EvalRegistry, runId: string, suiteId: string, reasonCode = "evaluation_trigger_failed"): EventRecordLike {
  const suite = registry.getSuite(suiteId);
  const evaluationKey = sha256([runId, suite.suiteId, suite.suiteVersion, suite.graderVersion, reasonCode].join("\n"));
  const release = acquireEvaluationLock(store.home, evaluationKey);
  try {
    const existing = evaluationEventByKey(store.listEvents(), runId, suiteId, evaluationKey);
    if (existing) return existing;
    return store.recordHarnessEvent(runId, "run.evaluation_completed", {
      evalVersion: "eval-plane.v1",
      suiteId: suite.suiteId,
      suiteVersion: suite.suiteVersion,
      graderVersion: suite.graderVersion,
      evaluationKey,
      diagnosis: "environment",
      reasonCodes: [reasonCode],
      result: "blocked",
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      failedCaseRefs: [],
      artifactRefs: [],
    });
  } finally {
    release();
  }
}

function loadEvaluationByKey(store: EvaluationCoordinatorStore, registry: EvalRegistry, runId: string, suiteId: string, evaluationKey: string, options: { allowMissingFile?: boolean } = {}): CoordinatedEvaluation | null {
  const event = evaluationEventByKey(store.listEvents(), runId, suiteId, evaluationKey);
  if (!event) return null;
  const artifactId = stringArray(event.payload.artifactRefs)
    .map((reference) => reference.startsWith("artifact://") ? reference.slice("artifact://".length) : "")
    .find(Boolean);
  const artifactRecord = artifactId ? store.listArtifacts({ runId }).find((item) => item.id === artifactId) : undefined;
  if (!artifactRecord) throw new Error(`Evaluation ${evaluationKey} references a missing Artifact entity`);
  const expectedPath = evaluationReportPath(store.home, suiteId, runId, evaluationKey);
  if (artifactRecord.kind !== "evaluation_report" || artifactRecord.runId !== runId || resolve(artifactRecord.path) !== expectedPath) {
    throw new Error(`Evaluation ${evaluationKey} references an invalid Artifact identity`);
  }
  if (!existsSync(artifactRecord.path)) {
    if (options.allowMissingFile) return null;
    throw new Error(`Evaluation ${evaluationKey} references a missing Artifact file`);
  }
  const text = assertArtifactContent(artifactRecord, artifactRecord.path, evaluationKey);
  const report = readReport(artifactRecord.path, text);
  if (report.runId !== runId || report.suiteId !== suiteId || report.evaluationKey !== evaluationKey) throw new Error(`Evaluation Artifact does not match ${evaluationKey}`);
  const suite = registry.getSuite(report.suiteId, report.suiteVersion);
  return { suite, results: report.results, report, evaluationKey, artifact: { ...artifactRecord, ref: `artifact://${artifactRecord.id}` }, evaluationEvent: event, reused: true };
}

function assertArtifactContent(artifact: ArtifactRecordLike, path: string, evaluationKey: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Evaluation ${evaluationKey} Artifact must be a regular file`);
  const bytes = readFileSync(path);
  const currentHash = sha256(bytes);
  if (!artifact.contentHash || artifact.contentHash !== currentHash) throw new Error(`Evaluation ${evaluationKey} Artifact content hash mismatch`);
  return bytes.toString("utf8");
}

function evaluationEventByKey(events: EventRecordLike[], runId: string, suiteId: string, evaluationKey: string): EventRecordLike | null {
  return [...events].reverse().find((event) => event.aggregateType === "run"
    && event.aggregateId === runId
    && event.eventType === "run.evaluation_completed"
    && event.payload.suiteId === suiteId
    && event.payload.evaluationKey === evaluationKey) ?? null;
}

function evaluationReportPath(home: string, suiteId: string, runId: string, evaluationKey: string): string {
  return resolve(home, "evaluations", safeSegment(suiteId), `${safeSegment(runId)}-${evaluationKey}.json`);
}

function persistReport(path: string, report: EvalReport): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== serialized) throw new Error(`Evaluation key collision at ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readReport(path: string, text = readFileSync(path, "utf8")): EvalReport {
  const value = JSON.parse(text) as EvalReport;
  if (!value || typeof value !== "object" || value.schema !== EVAL_REPORT_SCHEMA || !Array.isArray(value.results) || value.kind !== "run_assessment") {
    throw new Error(`Invalid Run Assessment Artifact: ${path}`);
  }
  if (typeof value.hardGatePassed !== "boolean" || typeof value.runId !== "string" || typeof value.suiteId !== "string"
    || typeof value.suiteVersion !== "string" || typeof value.graderVersion !== "string" || typeof value.evaluationKey !== "string"
    || typeof value.subjectVersion !== "string" || typeof value.subjectHash !== "string") throw new Error(`Invalid Run Assessment metadata: ${path}`);
  return { ...value, results: value.results.map((result) => validateEvalResult(result)) };
}

function ensureArtifactLink(store: EvaluationCoordinatorStore, runId: string, artifactId: string): void {
  const existing = store.listEvents().find((event) => event.aggregateType === "run"
    && event.aggregateId === runId
    && event.eventType === "run.artifact_linked"
    && event.payload.artifactId === artifactId
    && event.payload.relation === "produced");
  if (existing) return;
  store.recordHarnessEvent(runId, "run.artifact_linked", {
    artifactId,
    relation: "produced",
    lineageRefs: [`run://${runId}`],
  });
}

function acquireEvaluationLock(home: string, evaluationKey: string): () => void {
  const locks = resolve(home, "evaluations", ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = join(locks, evaluationKey);
  const deadline = Date.now() + EVALUATION_LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > EVALUATION_LOCK_STALE_MS) {
        try {
          rmdirSync(lock);
        } catch (removeError) {
          if ((removeError as NodeJS.ErrnoException).code !== "ENOENT") throw removeError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Evaluation ${evaluationKey} did not finish within ${EVALUATION_LOCK_WAIT_MS}ms`);
      sleepSync(25);
    }
  }
  return () => {
    try {
      if (existsSync(lock)) rmdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

function evaluationIdentity(runId: string, suiteId: string, suiteVersion: string, subjectHash: string, graderVersion: string): string {
  return sha256([runId, suiteId, suiteVersion, subjectHash, graderVersion].join("\n"));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function aggregateDiagnosis(values: EvalDiagnosis[]): EvalDiagnosis {
  for (const diagnosis of ["environment", "grader", "ground_truth", "subject", "unknown"] as EvalDiagnosis[]) {
    if (values.includes(diagnosis)) return diagnosis;
  }
  return "subject";
}

function booleanMetric(value: unknown): boolean {
  return value === true;
}

function numberMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function safeSegment(value: string): string {
  const result = value.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!result || result === "." || result === "..") throw new Error("Evaluation file segment is unsafe");
  return result;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
