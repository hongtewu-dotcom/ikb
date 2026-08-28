import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderExtractionBatch, renderKnowledgeProductBody, validateExtractionBatch, verifyExtractionBatch } from "../extraction-result.ts";
import { buildSourceStructureInventory } from "../extraction/inventory.ts";
import { printValue } from "../format.ts";
import { optionalOption, outputFormat, requiredArg, requiredOption, type ParsedArgs } from "./shared.ts";

export function handleExtraction(action: string | undefined, args: string[], parsed: ParsedArgs): void {
  if (!["inventory", "validate", "verify", "render", "product-view"].includes(action ?? "")) throw new Error(`Unknown extraction action: ${action ?? ""}`);
  if (action === "inventory") {
    const sourcePath = resolve(requiredArg(args, 0, "source file"));
    const inventory = buildSourceStructureInventory(sourcePath, requiredOption(parsed, "source-id"));
    const outputPath = optionalOption(parsed, "file");
    if (outputPath) {
      const path = resolve(outputPath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      printValue({ path, inventory }, outputFormat(parsed));
      return;
    }
    printValue(inventory, outputFormat(parsed));
    return;
  }
  const resultPath = resolve(requiredArg(args, 0, "extraction result file"));
  const resultValue = readJson(resultPath);
  const results = normalizeResults(resultValue);
  if (action === "product-view") {
    const caseId = requiredOption(parsed, "case-id");
    const productId = requiredOption(parsed, "product-id");
    const result = results.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).case_id === caseId);
    if (!result) throw new Error(`Extraction result case not found: ${caseId}`);
    const body = renderKnowledgeProductBody(result, caseId, productId);
    const outputPath = optionalOption(parsed, "file");
    if (outputPath) {
      const path = resolve(outputPath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, body, { mode: 0o600 });
      chmodSync(path, 0o600);
      printValue({ path, caseId, productId }, outputFormat(parsed));
      return;
    }
    printValue(body, outputFormat(parsed));
    return;
  }
  const manifestPath = resolve(requiredOption(parsed, "manifest"));
  const manifest = readJson(manifestPath);
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
  const outputPath = optionalOption(parsed, "file");
  if (outputPath) {
    const path = resolve(outputPath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    printValue({ path, report }, outputFormat(parsed));
  } else {
    printValue(report, outputFormat(parsed));
  }
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
