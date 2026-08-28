#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { EvalResult } from "./eval-contract.ts";
import { DETERMINISTIC_GRADER_VERSION } from "./eval-contract.ts";
import { createDefaultEvalRegistry } from "./eval-registry.ts";
import { runEvalSuite } from "./eval-runner.ts";
import { loadSpecxChangeSubject, SPECX_CHANGE_SUBJECT_VERSION } from "./specx-change-subject.ts";
import { SPECX_CHANGE_QUALITY_SUITE_ID, SPECX_CHANGE_QUALITY_SUITE_VERSION } from "./specx-change-assessment.ts";

export const SPECX_EVAL_ENVELOPE_SCHEMA = "specx-eval-envelope-v1" as const;

export interface SpecxEvalEnvelope {
  schema: typeof SPECX_EVAL_ENVELOPE_SCHEMA;
  changeId: string;
  sourceSnapshotHash: string;
  subjectVersion: typeof SPECX_CHANGE_SUBJECT_VERSION;
  suiteId: typeof SPECX_CHANGE_QUALITY_SUITE_ID;
  suiteVersion: typeof SPECX_CHANGE_QUALITY_SUITE_VERSION;
  graderVersion: typeof DETERMINISTIC_GRADER_VERSION;
  hardGatePassed: boolean;
  verdict: "pass" | "fail" | "inconclusive";
  results: EvalResult[];
  evaluatedAt: string;
}

function verdict(hardGatePassed: boolean, results: EvalResult[]): SpecxEvalEnvelope["verdict"] {
  if (hardGatePassed) return "pass";
  if (results.some((result) => result.status === "fail")) return "fail";
  return "inconclusive";
}

export function evaluateSpecxChange(changeDir: string, evaluatedAt = new Date().toISOString()): SpecxEvalEnvelope {
  if (!isAbsolute(changeDir)) throw new Error("--change-dir must be an absolute path");
  const subject = loadSpecxChangeSubject(resolve(changeDir));
  const output = runEvalSuite(createDefaultEvalRegistry(), SPECX_CHANGE_QUALITY_SUITE_ID, {
    projectRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
    subject,
  });
  if (output.suite.suiteVersion !== SPECX_CHANGE_QUALITY_SUITE_VERSION
    || output.suite.graderVersion !== DETERMINISTIC_GRADER_VERSION
    || output.report.subjectHash !== subject.subjectHash
    || output.report.subjectVersion !== SPECX_CHANGE_SUBJECT_VERSION) {
    throw new Error("SpecX Eval output identity is inconsistent");
  }
  return {
    schema: SPECX_EVAL_ENVELOPE_SCHEMA,
    changeId: subject.data.changeId,
    sourceSnapshotHash: subject.subjectHash,
    subjectVersion: SPECX_CHANGE_SUBJECT_VERSION,
    suiteId: SPECX_CHANGE_QUALITY_SUITE_ID,
    suiteVersion: SPECX_CHANGE_QUALITY_SUITE_VERSION,
    graderVersion: DETERMINISTIC_GRADER_VERSION,
    hardGatePassed: output.report.hardGatePassed,
    verdict: verdict(output.report.hardGatePassed, output.results),
    results: output.results,
    evaluatedAt,
  };
}

function parseArgs(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--change-dir" || !argv[1]) {
    throw new Error("usage: specx-eval-cli.ts --change-dir <absolute-path>");
  }
  if (!isAbsolute(argv[1])) throw new Error("--change-dir must be an absolute path");
  return argv[1];
}

export function runSpecxEvalCli(argv: string[]): number {
  try {
    const envelope = evaluateSpecxChange(parseArgs(argv));
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) process.exitCode = runSpecxEvalCli(process.argv.slice(2));
