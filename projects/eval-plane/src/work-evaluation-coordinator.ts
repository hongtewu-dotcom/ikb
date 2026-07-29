import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVAL_REPORT_SCHEMA, validateEvalResult, type EvalDiagnosis, type EvalReport, type EvalSuite } from "./eval-contract.ts";
import type { EvalRegistry } from "./eval-registry.ts";
import { runEvalSuite, type EvalRunOutput } from "./eval-runner.ts";
import { WORK_RUN_QUALITY_SUITE_ID } from "./work-run-assessment.ts";
import { loadWorkRunSubject, type WorkRunSubject } from "./work-run-subject.ts";

export const WORK_EVAL_EVENT_SCHEMA = "work-harness-eval-event-v1";

const TERMINAL_WORK_STATES = new Set(["completed", "blocked", "failed"]);
const EVALUATION_LOCK_STALE_MS = 5 * 60 * 1000;
const EVALUATION_LOCK_WAIT_MS = 30 * 1000;
const EVALUATION_SUBJECT_RELOAD_LIMIT = 3;
const VERIFICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkEvaluationEvent {
  schema: typeof WORK_EVAL_EVENT_SCHEMA;
  at: string;
  event: "evaluation.completed";
  runId: string;
  suiteId: string;
  suiteVersion: string;
  graderVersion: string;
  subjectVersion: string;
  subjectHash: string;
  evaluationKey: string;
  diagnosis: EvalDiagnosis;
  result: "pass" | "partial" | "blocked";
  hardGatePassed: boolean;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  reasonCodes: string[];
  reportRef: string;
  reportHash: string;
}

export interface CoordinatedWorkEvaluation extends EvalRunOutput {
  evaluationKey: string;
  reportPath: string;
  reportRef: string;
  reportHash: string;
  evaluationEvent: WorkEvaluationEvent;
  result: WorkEvaluationEvent["result"];
  reused: boolean;
  verificationId?: string;
}

interface BoundWorkEvaluationSubject {
  subject: WorkRunSubject;
  evaluationKey: string;
  documentVerificationId: string | null;
  taskVerificationId: string | null;
}

export function coordinateWorkRunEvaluation(
  taskDirectory: string,
  registry: EvalRegistry,
  options: { projectRoot: string; suiteId?: string; verificationId?: string } = { projectRoot: process.cwd() },
): CoordinatedWorkEvaluation {
  const taskDir = resolve(taskDirectory);
  const suiteId = options.suiteId ?? WORK_RUN_QUALITY_SUITE_ID;
  const suite = registry.getSuite(suiteId);
  if (suite.kind !== "run_assessment" || suite.adapter !== "work-harness") throw new Error(`EvalSuite ${suiteId} cannot assess a Work Harness task directory`);
  const verificationId = options.verificationId;
  if (verificationId !== undefined && !VERIFICATION_ID_PATTERN.test(verificationId)) throw new Error(`Work Harness verification id is invalid: ${verificationId}`);
  let binding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
  for (let attempt = 0; attempt < EVALUATION_SUBJECT_RELOAD_LIMIT; attempt += 1) {
    const evaluationKey = binding.evaluationKey;
    const release = acquireEvaluationLock(taskDir, evaluationKey);
    try {
      const lockedBinding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
      if (!sameWorkEvaluationBinding(binding, lockedBinding)) {
        binding = lockedBinding;
        continue;
      }
      const existing = loadWorkEvaluationByKey(taskDir, registry, suiteId, evaluationKey, true);
      if (existing) {
        assertEvaluationMatchesBinding(existing, lockedBinding, suite);
        const finalBinding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
        if (!sameWorkEvaluationBinding(lockedBinding, finalBinding)) {
          binding = finalBinding;
          continue;
        }
        return { ...existing, ...(verificationId ? { verificationId } : {}) };
      }

      const subject = lockedBinding.subject;
      const evaluated = runEvalSuite(registry, suiteId, { projectRoot: options.projectRoot, runId: subject.runId, subject });
      const report: EvalReport = { ...evaluated.report, evaluationKey };
      const output: EvalRunOutput = { ...evaluated, report };
      const evaluatedBinding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
      if (!sameWorkEvaluationBinding(lockedBinding, evaluatedBinding)) {
        binding = evaluatedBinding;
        continue;
      }
      const reportPath = workEvaluationReportPath(taskDir, suiteId, evaluationKey);
      const reportCreated = persistReport(reportPath, report);
      const reportBytes = readFileSync(reportPath);
      const reportHash = sha256(reportBytes);
      const reportRef = `artifact://evaluation/${suiteId}/${evaluationKey}`;
      const failedResults = output.results.filter((result) => result.status === "fail");
      const result = workEvaluationResult(output.report);
      const event: WorkEvaluationEvent = {
        schema: WORK_EVAL_EVENT_SCHEMA,
        at: new Date().toISOString(),
        event: "evaluation.completed",
        runId: subject.runId,
        suiteId: suite.suiteId,
        suiteVersion: suite.suiteVersion,
        graderVersion: suite.graderVersion,
        subjectVersion: subject.subjectVersion,
        subjectHash: subject.subjectHash,
        evaluationKey,
        diagnosis: aggregateDiagnosis(failedResults.map((item) => item.diagnosis)),
        result,
        hardGatePassed: output.report.hardGatePassed,
        totalCases: output.results.length,
        passedCases: output.results.length - failedResults.length,
        failedCases: failedResults.length,
        reasonCodes: unique(failedResults.flatMap((item) => item.reasonCodes)),
        reportRef,
        reportHash,
      };
      const concurrent = loadWorkEvaluationByKey(taskDir, registry, suiteId, evaluationKey, true);
      if (concurrent) {
        assertEvaluationMatchesBinding(concurrent, lockedBinding, suite);
        const finalBinding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
        if (!sameWorkEvaluationBinding(lockedBinding, finalBinding)) {
          binding = finalBinding;
          continue;
        }
        return { ...concurrent, ...(verificationId ? { verificationId } : {}) };
      }
      let finalBinding: BoundWorkEvaluationSubject;
      try {
        finalBinding = loadBoundWorkEvaluationSubject(taskDir, suite, verificationId);
      } catch (error) {
        if (reportCreated) discardUnboundReport(reportPath, reportHash);
        throw error;
      }
      if (!sameWorkEvaluationBinding(lockedBinding, finalBinding)) {
        if (reportCreated) discardUnboundReport(reportPath, reportHash);
        binding = finalBinding;
        continue;
      }
      // This check is the commit linearization point. The evaluation-key lock serializes
      // same-key publishers; bound Work Harness callers additionally hold the task lock
      // through stdout consumption and trigger persistence.
      appendEvaluationEvent(taskDir, event);
      return {
        ...output,
        evaluationKey,
        reportPath,
        reportRef,
        reportHash,
        evaluationEvent: event,
        result,
        reused: false,
        ...(verificationId ? { verificationId } : {}),
      };
    } finally {
      release();
    }
  }
  throw new Error(`Work Harness Run ${binding.subject.runId} changed repeatedly before its assessment could be committed`);
}

function loadBoundWorkEvaluationSubject(taskDir: string, suite: EvalSuite, expectedVerificationId?: string): BoundWorkEvaluationSubject {
  const subject = loadBoundWorkRunSubject(taskDir, expectedVerificationId);
  assertTerminal(subject.data.state.status, subject.runId);
  const taskVerificationId = subject.data.events
    .filter((event) => event.event === "task.verified")
    .at(-1)?.verificationId ?? null;
  return {
    subject,
    evaluationKey: evaluationIdentity(subject.runId, suite.suiteId, suite.suiteVersion, subject.subjectHash, suite.graderVersion),
    documentVerificationId: subject.data.verification.verificationId,
    taskVerificationId,
  };
}

function loadBoundWorkRunSubject(taskDir: string, expectedVerificationId?: string) {
  const subject = loadWorkRunSubject(taskDir);
  if (expectedVerificationId === undefined) return subject;
  const documentVerificationId = subject.data.verification.verificationId;
  const taskVerificationId = subject.data.events
    .filter((event) => event.event === "task.verified")
    .at(-1)?.verificationId ?? null;
  if (documentVerificationId !== expectedVerificationId || taskVerificationId !== expectedVerificationId) {
    throw new Error(
      `Work Harness verification identity mismatch: expected ${expectedVerificationId}, verification.json=${documentVerificationId ?? "missing"}, task.verified=${taskVerificationId ?? "missing"}`,
    );
  }
  return subject;
}

function sameWorkEvaluationBinding(left: BoundWorkEvaluationSubject, right: BoundWorkEvaluationSubject): boolean {
  return left.subject.runId === right.subject.runId
    && left.subject.subjectVersion === right.subject.subjectVersion
    && left.subject.subjectHash === right.subject.subjectHash
    && left.evaluationKey === right.evaluationKey
    && left.documentVerificationId === right.documentVerificationId
    && left.taskVerificationId === right.taskVerificationId;
}

function assertEvaluationMatchesBinding(
  evaluation: CoordinatedWorkEvaluation,
  binding: BoundWorkEvaluationSubject,
  suite: EvalSuite,
): void {
  const report = evaluation.report;
  const event = evaluation.evaluationEvent;
  if (
    evaluation.evaluationKey !== binding.evaluationKey
    || report.evaluationKey !== binding.evaluationKey
    || report.runId !== binding.subject.runId
    || report.subjectVersion !== binding.subject.subjectVersion
    || report.subjectHash !== binding.subject.subjectHash
    || report.suiteId !== suite.suiteId
    || report.suiteVersion !== suite.suiteVersion
    || report.graderVersion !== suite.graderVersion
    || event.runId !== binding.subject.runId
    || event.subjectVersion !== binding.subject.subjectVersion
    || event.subjectHash !== binding.subject.subjectHash
    || event.suiteId !== suite.suiteId
    || event.suiteVersion !== suite.suiteVersion
    || event.graderVersion !== suite.graderVersion
    || event.evaluationKey !== binding.evaluationKey
  ) {
    throw new Error(`Work evaluation ${binding.evaluationKey} is not bound to the current Work Harness subject`);
  }
}

export function loadLatestWorkRunEvaluation(taskDirectory: string, registry: EvalRegistry, suiteId = WORK_RUN_QUALITY_SUITE_ID): CoordinatedWorkEvaluation | null {
  const taskDir = resolve(taskDirectory);
  const events = readEvaluationEvents(taskDir).filter((event) => event.suiteId === suiteId).reverse();
  for (const event of events) {
    const result = loadWorkEvaluationByKey(taskDir, registry, suiteId, event.evaluationKey, false);
    if (result) return result;
  }
  return null;
}

function loadWorkEvaluationByKey(taskDir: string, registry: EvalRegistry, suiteId: string, evaluationKey: string, allowMissingFile: boolean): CoordinatedWorkEvaluation | null {
  const event = findEvaluationEvent(taskDir, suiteId, evaluationKey);
  if (!event) return null;
  const reportPath = workEvaluationReportPath(taskDir, suiteId, evaluationKey);
  if (!existsSync(reportPath)) {
    if (allowMissingFile) return null;
    throw new Error(`Work evaluation ${evaluationKey} references a missing report`);
  }
  const report = assertReportIdentity(reportPath, event, event.runId, suiteId, evaluationKey);
  const suite = registry.getSuite(report.suiteId, report.suiteVersion);
  return {
    suite,
    results: report.results,
    report,
    evaluationKey,
    reportPath,
    reportRef: event.reportRef,
    reportHash: event.reportHash,
    evaluationEvent: event,
    result: event.result,
    reused: true,
  };
}

function assertReportIdentity(path: string, event: WorkEvaluationEvent, runId: string, suiteId: string, evaluationKey: string): EvalReport {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Work evaluation ${evaluationKey} report must be a regular file`);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== event.reportHash) throw new Error(`Work evaluation ${evaluationKey} report content hash mismatch`);
  const report = readReport(path, bytes.toString("utf8"));
  if (report.runId !== runId || report.suiteId !== suiteId || report.evaluationKey !== evaluationKey || event.reportRef !== `artifact://evaluation/${suiteId}/${evaluationKey}`) {
    throw new Error(`Work evaluation ${evaluationKey} report identity mismatch`);
  }
  if (event.hardGatePassed !== report.hardGatePassed) {
    throw new Error(`Work evaluation ${evaluationKey} event hardGatePassed does not match its report`);
  }
  if (event.result !== workEvaluationResult(report)) {
    throw new Error(`Work evaluation ${evaluationKey} event result does not match its report`);
  }
  return report;
}

function readReport(path: string, text: string): EvalReport {
  const value = JSON.parse(text) as EvalReport;
  if (!value || typeof value !== "object" || value.schema !== EVAL_REPORT_SCHEMA || value.kind !== "run_assessment" || !Array.isArray(value.results)) throw new Error(`Invalid Work Run Assessment report: ${path}`);
  if (typeof value.evaluationKey !== "string" || typeof value.subjectHash !== "string" || typeof value.subjectVersion !== "string" || typeof value.hardGatePassed !== "boolean") throw new Error(`Invalid Work Run Assessment metadata: ${path}`);
  return { ...value, results: value.results.map((result) => validateEvalResult(result)) };
}

function workEvaluationReportPath(taskDir: string, suiteId: string, evaluationKey: string): string {
  return resolve(taskDir, "evaluations", safeSegment(suiteId), `${safeSegment(evaluationKey)}.json`);
}

function persistReport(path: string, report: EvalReport): boolean {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== serialized) throw new Error(`Work evaluation key collision at ${path}`);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return true;
}

function discardUnboundReport(path: string, expectedHash: string): void {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Unbound Work evaluation report must be a regular file: ${path}`);
  if (sha256(readFileSync(path)) !== expectedHash) throw new Error(`Unbound Work evaluation report changed before cleanup: ${path}`);
  unlinkSync(path);
}

function appendEvaluationEvent(taskDir: string, event: WorkEvaluationEvent): void {
  const path = resolve(taskDir, "evaluations", "events.jsonl");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
  chmodSync(path, 0o600);
}

function readEvaluationEvents(taskDir: string): WorkEvaluationEvent[] {
  const path = resolve(taskDir, "evaluations", "events.jsonl");
  if (!existsSync(path)) return [];
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Work evaluation event log must be a regular file");
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => {
    const value = JSON.parse(line) as Partial<WorkEvaluationEvent>;
    if (
      !value
      || value.schema !== WORK_EVAL_EVENT_SCHEMA
      || value.event !== "evaluation.completed"
      || typeof value.evaluationKey !== "string"
      || typeof value.reportHash !== "string"
      || !new Set(["pass", "partial", "blocked"]).has(value.result ?? "")
    ) {
      throw new Error("Invalid Work evaluation event");
    }
    const hardGatePassed = Object.hasOwn(value, "hardGatePassed")
      ? value.hardGatePassed
      : value.result !== "blocked";
    if (typeof hardGatePassed !== "boolean") throw new Error("Work evaluation event hardGatePassed must be a boolean");
    if (hardGatePassed !== (value.result !== "blocked")) {
      throw new Error("Work evaluation event hardGatePassed does not match result");
    }
    return { ...value, hardGatePassed } as WorkEvaluationEvent;
  });
}

function workEvaluationResult(report: Pick<EvalReport, "hardGatePassed" | "results">): WorkEvaluationEvent["result"] {
  if (!report.hardGatePassed) return "blocked";
  return report.results.some((result) => result.status === "fail") ? "partial" : "pass";
}

function findEvaluationEvent(taskDir: string, suiteId: string, evaluationKey: string): WorkEvaluationEvent | null {
  return readEvaluationEvents(taskDir).reverse().find((event) => event.suiteId === suiteId && event.evaluationKey === evaluationKey) ?? null;
}

function acquireEvaluationLock(taskDir: string, evaluationKey: string): () => void {
  const locks = resolve(taskDir, "evaluations", ".locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lock = resolve(locks, safeSegment(evaluationKey));
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
      if (Date.now() >= deadline) throw new Error(`Work evaluation ${evaluationKey} did not finish within ${EVALUATION_LOCK_WAIT_MS}ms`);
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

function assertTerminal(status: string, runId: string): void {
  if (!TERMINAL_WORK_STATES.has(status)) throw new Error(`Work Harness Run ${runId} must be terminal before assessment (got ${status})`);
}

function aggregateDiagnosis(values: EvalDiagnosis[]): EvalDiagnosis {
  for (const diagnosis of ["environment", "grader", "ground_truth", "subject", "unknown"] as EvalDiagnosis[]) if (values.includes(diagnosis)) return diagnosis;
  return "subject";
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function safeSegment(value: string): string {
  const result = value.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!result || result === "." || result === "..") throw new Error("Work evaluation file segment is unsafe");
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
