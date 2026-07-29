import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalReport, EvalResult } from "../../projects/eval-plane/src/eval-contract.ts";
import { evalPlaneRoot } from "../evaluation-paths.ts";

export { evalPlaneRoot };

export function persistEvalReport(home: string, report: EvalReport): { ref: string; path: string; hash: string } {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const hash = createHash("sha256").update(serialized).digest("hex");
  const directory = join(home, "evaluations", report.suiteId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${hash.slice(0, 12)}.json`);
  writeFileSync(path, serialized, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ref: `artifact://evaluation/${report.suiteId}/${hash}`, path, hash };
}

export function readEvalResults(path: string): EvalResult[] {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as EvalResult[] | EvalReport;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as EvalReport).results)) return (value as EvalReport).results;
  throw new Error(`Evaluation artifact has no results: ${path}`);
}
