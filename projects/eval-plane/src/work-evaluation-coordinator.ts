import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EVAL_REPORT_SCHEMA, validateEvalResult, type EvalDiagnosis, type EvalReport } from "./eval-contract.ts";
import type { EvalRegistry } from "./eval-registry.ts";
import { runEvalSuite, type EvalRunOutput } from "./eval-runner.ts";
import { WORK_RUN_QUALITY_SUITE_ID } from "./work-run-assessment.ts";
import { loadWorkRunSubject } from "./work-run-subject.ts";

export const WORK_EVAL_EVENT_SCHEMA = "work-harness-eval-event-v1";

const TERMINAL_WORK_STATES = new Set(["completed", "blocked", "failed"]);
const EVALUATION_LOCK_STALE_MS = 5 * 60 * 1000;
const EVALUATION_LOCK_WAIT_MS = 30 * 1000;
const EVALUATION_SUBJECT_RELOAD_LIMIT = 3;

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
}

export function coordinateWorkRunEvaluation(
  taskDirectory: string,
  registry: EvalRegistry,
  options: { projectRoot: string; suiteId?: string } = { projectRoot: process.cwd() },
): CoordinatedWorkEvaluation {
  const taskDir = resolve(taskDirectory);
  const suiteId = options.suiteId ?? WORK_RUN_QUALITY_SUITE_ID;
  const suite = registry.getSuite(suiteId);
  if (suite.kind !== "run_assessment" || suite.adapter !== "work-harness") throw new Error(`EvalSuite ${suiteId} cannot assess a Work Harness task directory`);
  let subject = loadWorkRunSubject(taskDir);
  assertTerminal(subject.data.state.status, subject.runId);
  let evaluationKey = evaluationIdentity(subject.runId, suite.suiteId, suite.suiteVersion, subject.subjectHash, suite.graderVersion);
  for (let attempt = 0; attempt < EVALUATION_SUBJECT_RELOAD_LIMIT; attempt += 1) {
    const release = acquireEvaluationLock(taskDir, evaluationKey);
    try {
      const currentSubject = loadWorkRunSubject(taskDir);
      assertTerminal(currentSubject.data.state.status, currentSubject.runId);
      const currentKey = evaluationIdentity(currentSubject.runId, suite.suiteId, suite.suiteVersion, currentSubject.subjectHash, suite.graderVersion);
      if (currentKey !== evaluationKey) {
        subject = currentSubject;
        evaluationKey = currentKey;
        continue;
      }
      subject = currentSubject;
      const existing = loadWorkEvaluationByKey(taskDir, registry, suiteId, evaluationKey, true);
      if (existing) return existing;

      const evaluated = runEvalSuite(registry, suiteId, { projectRoot: options.projectRoot, runId: subject.runId, subject });
      const report: EvalReport = { ...evaluated.report, evaluationKey };
      const output: EvalRunOutput = { ...evaluated, report };
      const reportPath = workEvaluationReportPath(taskDir, suiteId, evaluationKey);
      persistReport(reportPath, report);
      const reportBytes = readFileSync(reportPath);
      const reportHash = sha256(reportBytes);
      const reportRef = `artifact://evaluation/${suiteId}/${evaluationKey}`;
      const failedResults = output.results.filter((result) => result.status === "fail");
      const result = output.report.hardGatePassed ? (failedResults.length === 0 ? "pass" : "partial") : "blocked";
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
        totalCases: output.results.length,
        passedCases: output.results.length - failedResults.length,
        failedCases: failedResults.length,
        reasonCodes: unique(failedResults.flatMap((item) => item.reasonCodes)),
        reportRef,
        reportHash,
      };
      const concurrent = findEvaluationEvent(taskDir, suiteId, evaluationKey);
      if (concurrent) {
        assertReportIdentity(reportPath, concurrent, subject.runId, suiteId, evaluationKey);
        return { ...output, evaluationKey, reportPath, reportRef, reportHash, evaluationEvent: concurrent, result: concurrent.result, reused: true };
      }
      appendEvaluationEvent(taskDir, event);
      return { ...output, evaluationKey, reportPath, reportRef, reportHash, evaluationEvent: event, result, reused: false };
    } finally {
      release();
    }
  }
  throw new Error(`Work Harness Run ${subject.runId} changed repeatedly while its assessment was starting`);
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

function persistReport(path: string, report: EvalReport): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== serialized) throw new Error(`Work evaluation key collision at ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
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
    const value = JSON.parse(line) as WorkEvaluationEvent;
    if (!value || value.schema !== WORK_EVAL_EVENT_SCHEMA || value.event !== "evaluation.completed" || typeof value.evaluationKey !== "string" || typeof value.reportHash !== "string") throw new Error("Invalid Work evaluation event");
    return value;
  });
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
