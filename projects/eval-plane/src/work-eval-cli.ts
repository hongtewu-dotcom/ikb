#!/usr/bin/env node
import { resolve } from "node:path";
import { createDefaultEvalRegistry } from "./eval-registry.ts";
import { coordinateWorkRunEvaluation } from "./work-evaluation-coordinator.ts";
import { WORK_RUN_QUALITY_SUITE_ID } from "./work-run-assessment.ts";

const OUTPUT_SCHEMA = "work-harness-evaluation-v1";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const taskDir = option(args, "task-dir");
  if (!taskDir) throw new Error("--task-dir is required");
  const suiteId = option(args, "suite") ?? WORK_RUN_QUALITY_SUITE_ID;
  const verificationId = option(args, "verification-id");
  const projectRoot = resolve(import.meta.dirname, "..");
  const evaluation = coordinateWorkRunEvaluation(resolve(taskDir), createDefaultEvalRegistry(), { projectRoot, suiteId, verificationId });
  console.log(JSON.stringify({
    schema: OUTPUT_SCHEMA,
    status: "completed",
    suiteId: evaluation.report.suiteId,
    suiteVersion: evaluation.report.suiteVersion,
    runId: evaluation.report.runId,
    ...(evaluation.verificationId ? { verificationId: evaluation.verificationId } : {}),
    subjectHash: evaluation.report.subjectHash,
    subjectVersion: evaluation.report.subjectVersion,
    evaluationKey: evaluation.evaluationKey,
    hardGatePassed: evaluation.report.hardGatePassed,
    result: evaluation.result,
    reportRef: evaluation.reportRef,
    reportPath: evaluation.reportPath,
    reused: evaluation.reused,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`work-eval: ${(error as Error).message}`);
  process.exitCode = 1;
}
