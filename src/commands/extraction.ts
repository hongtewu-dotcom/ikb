import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderExtractionBatch, validateExtractionBatch, verifyExtractionBatch } from "../extraction-result.ts";
import { printValue } from "../format.ts";
import { outputFormat, requiredArg, requiredOption, type ParsedArgs } from "./shared.ts";

export function handleExtraction(action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (!["validate", "verify", "render"].includes(action ?? "")) throw new Error(`Unknown extraction action: ${action ?? ""}`);
  const resultPath = resolve(requiredArg(args, 0, "extraction result file"));
  const manifestPath = resolve(requiredOption(parsed, "manifest"));
  const manifest = readJson(manifestPath);
  const resultValue = readJson(resultPath);
  const results = normalizeResults(resultValue);
  if (action === "render") {
    const validation = validateExtractionBatch(manifest, results);
    if (!validation.valid) {
      printValue(validation, outputFormat(parsed));
      process.exitCode = 2;
      return;
    }
    printValue({
      rendered: renderExtractionBatch(manifest, results, requiredOption(parsed, "directory")),
    }, outputFormat(parsed));
    return;
  }
  const report = action === "verify"
    ? verifyExtractionBatch(manifest, results)
    : validateExtractionBatch(manifest, results);
  printValue(report, outputFormat(parsed));
  if (!report.valid) process.exitCode = 2;
}

function normalizeResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).results)) {
    return (value as Record<string, unknown>).results as unknown[];
  }
  return [value];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${path}: ${(error as Error).message}`);
  }
}
