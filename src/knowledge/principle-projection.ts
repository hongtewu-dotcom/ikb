import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { knowledgeRetrievalEligibilityAtHome } from "./eligibility.ts";
import { findKnowledge } from "./records.ts";

export const PRINCIPLE_PROJECTION_MANIFEST_VERSION = "ikb-principle-projection-manifest.v1";

export interface PrincipleProjectionMapping {
  id: string;
  principleId: string;
  startupRequired: boolean;
  rationale: string;
  agentsPath?: string;
  projection?: string;
}

export interface PrincipleProjectionManifest {
  schema: typeof PRINCIPLE_PROJECTION_MANIFEST_VERSION;
  scope: "personal" | "work";
  agentsPaths?: string[];
  mappings: PrincipleProjectionMapping[];
}

export type PrincipleProjectionIssueCode =
  | "principle_missing"
  | "principle_scope_mismatch"
  | "principle_type_mismatch"
  | "principle_not_active"
  | "required_projection_missing"
  | "agents_file_missing"
  | "agents_file_invalid"
  | "projection_block_missing"
  | "projection_block_invalid"
  | "projection_block_duplicate"
  | "projection_content_drift"
  | "projection_conflict"
  | "unmanaged_projection";

export interface PrincipleProjectionIssue {
  mappingId: string;
  principleId: string;
  code: PrincipleProjectionIssueCode;
  detail: string;
  agentsPath: string | null;
}

export interface AgentProjectionInspection {
  status: "current" | "missing" | "invalid" | "duplicate" | "drifted";
  expectedBlock: string;
  currentBlock: string | null;
}

export interface PrincipleProjectionCheckResult {
  schema: "ikb-principle-projection-drift.v1";
  manifestPath: string;
  scope: "personal" | "work";
  checked: number;
  current: number;
  issues: PrincipleProjectionIssue[];
  ok: boolean;
  mappings: Array<{
    mappingId: string;
    principleId: string;
    principleActive: boolean;
    agentsPath: string | null;
    projectionStatus: AgentProjectionInspection["status"] | "not_requested";
    expectedBlock: string | null;
    currentBlock: string | null;
    issues: PrincipleProjectionIssue[];
  }>;
}

interface ParsedProjectionBlock {
  principleId: string;
  block: string;
  body: string;
  valid: boolean;
}

export function readPrincipleProjectionManifest(path: string): PrincipleProjectionManifest {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Principle projection manifest not found: ${absolute}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Principle projection manifest must be a regular file: ${absolute}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Principle projection manifest is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Principle projection manifest must be an object");
  const manifest = value as PrincipleProjectionManifest;
  if (manifest.schema !== PRINCIPLE_PROJECTION_MANIFEST_VERSION || !["personal", "work"].includes(manifest.scope) || !Array.isArray(manifest.mappings)) {
    throw new Error(`Principle projection manifest must use ${PRINCIPLE_PROJECTION_MANIFEST_VERSION}`);
  }
  if (manifest.agentsPaths !== undefined && (!Array.isArray(manifest.agentsPaths) || manifest.agentsPaths.some((path) => typeof path !== "string" || !path.trim()))) {
    throw new Error("Principle projection manifest agentsPaths must contain non-empty paths");
  }
  const ids = new Set<string>();
  for (const mapping of manifest.mappings) {
    if (!mapping || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(mapping.id)) || ids.has(mapping.id)) {
      throw new Error(`Principle projection mapping id is invalid or duplicated: ${String(mapping?.id)}`);
    }
    ids.add(mapping.id);
    if (!/^kb-[A-Za-z0-9-]+$/.test(String(mapping.principleId))) throw new Error(`Principle projection ${mapping.id} has an invalid principleId`);
    if (typeof mapping.startupRequired !== "boolean") throw new Error(`Principle projection ${mapping.id} startupRequired must be boolean`);
    if (typeof mapping.rationale !== "string" || !mapping.rationale.trim()) throw new Error(`Principle projection ${mapping.id} requires a rationale`);
    if (mapping.agentsPath !== undefined && (typeof mapping.agentsPath !== "string" || !mapping.agentsPath.trim())) throw new Error(`Principle projection ${mapping.id} has an invalid agentsPath`);
    if (mapping.projection !== undefined && (typeof mapping.projection !== "string" || !mapping.projection.trim())) throw new Error(`Principle projection ${mapping.id} has an invalid projection`);
  }
  return manifest;
}

export function renderPrincipleProjectionBlock(principleId: string, projection: string): string {
  return `<!-- IKB Principle: ${principleId} -->\n${projection.trim()}\n<!-- /IKB Principle: ${principleId} -->`;
}

export function inspectAgentProjection(principleId: string, projection: string, agentsText: string): AgentProjectionInspection {
  const expectedBlock = renderPrincipleProjectionBlock(principleId, projection);
  const blocks = parseProjectionBlocks(agentsText).filter((block) => block.principleId === principleId);
  if (blocks.length === 0) return { status: "missing", expectedBlock, currentBlock: null };
  if (blocks.length > 1) return { status: "duplicate", expectedBlock, currentBlock: blocks.map((block) => block.block).join("\n\n") };
  const [block] = blocks;
  if (!block.valid) return { status: "invalid", expectedBlock, currentBlock: block.block };
  return normalizeProjection(block.body) === normalizeProjection(projection)
    ? { status: "current", expectedBlock, currentBlock: block.block }
    : { status: "drifted", expectedBlock, currentBlock: block.block };
}

export function checkPrincipleProjections(home: string, manifestPath: string): PrincipleProjectionCheckResult {
  const absoluteManifest = resolve(manifestPath);
  const manifest = readPrincipleProjectionManifest(absoluteManifest);
  const manifestDir = dirname(absoluteManifest);
  const issues: PrincipleProjectionIssue[] = [];
  const add = (mappingId: string, principleId: string, code: PrincipleProjectionIssueCode, detail: string, agentsPath: string | null) => {
    const item = { mappingId, principleId, code, detail, agentsPath };
    issues.push(item);
    return item;
  };

  const projectionsByPrinciple = new Map<string, Map<string, string[]>>();
  for (const mapping of manifest.mappings) {
    if (!mapping.projection) continue;
    const normalized = normalizeProjection(mapping.projection);
    const variants = projectionsByPrinciple.get(mapping.principleId) ?? new Map<string, string[]>();
    variants.set(normalized, [...(variants.get(normalized) ?? []), mapping.id]);
    projectionsByPrinciple.set(mapping.principleId, variants);
  }
  for (const [principleId, variants] of projectionsByPrinciple) {
    if (variants.size <= 1) continue;
    const mappingIds = [...variants.values()].flat();
    for (const mappingId of mappingIds) {
      const mapping = manifest.mappings.find((candidate) => candidate.id === mappingId)!;
      const path = mapping.agentsPath ? resolveManifestPath(manifestDir, mapping.agentsPath) : null;
      add(mappingId, principleId, "projection_conflict", `The same Principle has conflicting projection text across mappings: ${mappingIds.join(", ")}`, path);
    }
  }

  const mappingResults = manifest.mappings.map((mapping) => {
    const mappingIssues: PrincipleProjectionIssue[] = issues.filter((issue) => issue.mappingId === mapping.id);
    const agentsPath = mapping.agentsPath ? resolveManifestPath(manifestDir, mapping.agentsPath) : null;
    const record = findKnowledge(home, mapping.principleId);
    let principleActive = false;
    if (!record) mappingIssues.push(add(mapping.id, mapping.principleId, "principle_missing", `Principle Knowledge not found: ${mapping.principleId}`, agentsPath));
    else if (record.scope !== manifest.scope) mappingIssues.push(add(mapping.id, mapping.principleId, "principle_scope_mismatch", `Knowledge ${mapping.principleId} belongs to ${record.scope}, not manifest scope ${manifest.scope}`, agentsPath));
    else if (record.type.trim().toLowerCase() !== "principle") mappingIssues.push(add(mapping.id, mapping.principleId, "principle_type_mismatch", `Knowledge ${mapping.principleId} is type ${record.type}, not Principle`, agentsPath));
    else {
      const eligibility = knowledgeRetrievalEligibilityAtHome(home, record);
      principleActive = eligibility.eligible;
      if (!eligibility.eligible) mappingIssues.push(add(mapping.id, mapping.principleId, "principle_not_active", `Principle is not confirmed and default-eligible: ${eligibility.reason ?? "unknown"}`, agentsPath));
    }

    if (!agentsPath || !mapping.projection) {
      if (mapping.startupRequired) mappingIssues.push(add(mapping.id, mapping.principleId, "required_projection_missing", "A startup-required Principle needs both agentsPath and projection text", agentsPath));
      return {
        mappingId: mapping.id,
        principleId: mapping.principleId,
        principleActive,
        agentsPath,
        projectionStatus: "not_requested" as const,
        expectedBlock: mapping.projection ? renderPrincipleProjectionBlock(mapping.principleId, mapping.projection) : null,
        currentBlock: null,
        issues: dedupeIssues(mappingIssues),
      };
    }

    const expectedBlock = renderPrincipleProjectionBlock(mapping.principleId, mapping.projection);
    if (!existsSync(agentsPath)) {
      mappingIssues.push(add(mapping.id, mapping.principleId, "agents_file_missing", `AGENTS.md target not found: ${agentsPath}`, agentsPath));
      return { mappingId: mapping.id, principleId: mapping.principleId, principleActive, agentsPath, projectionStatus: "missing" as const, expectedBlock, currentBlock: null, issues: dedupeIssues(mappingIssues) };
    }
    const stat = lstatSync(agentsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      mappingIssues.push(add(mapping.id, mapping.principleId, "agents_file_invalid", `AGENTS.md target must be a regular file: ${agentsPath}`, agentsPath));
      return { mappingId: mapping.id, principleId: mapping.principleId, principleActive, agentsPath, projectionStatus: "invalid" as const, expectedBlock, currentBlock: null, issues: dedupeIssues(mappingIssues) };
    }
    const inspection = inspectAgentProjection(mapping.principleId, mapping.projection, readFileSync(agentsPath, "utf8"));
    const code = inspection.status === "missing" ? "projection_block_missing"
      : inspection.status === "invalid" ? "projection_block_invalid"
        : inspection.status === "duplicate" ? "projection_block_duplicate"
          : inspection.status === "drifted" ? "projection_content_drift"
            : null;
    if (code) mappingIssues.push(add(mapping.id, mapping.principleId, code, `Projection in ${agentsPath} is ${inspection.status}; review the expected block before editing AGENTS.md`, agentsPath));
    return { mappingId: mapping.id, principleId: mapping.principleId, principleActive, agentsPath, projectionStatus: inspection.status, expectedBlock: inspection.expectedBlock, currentBlock: inspection.currentBlock, issues: dedupeIssues(mappingIssues) };
  });

  const mappedPairs = new Set(manifest.mappings.flatMap((mapping) => mapping.agentsPath
    ? [`${resolveManifestPath(manifestDir, mapping.agentsPath)}\0${mapping.principleId}`]
    : []));
  const agentsPaths = [...new Set([
    ...(manifest.agentsPaths ?? []).map((path) => resolveManifestPath(manifestDir, path)),
    ...manifest.mappings.flatMap((mapping) => mapping.agentsPath ? [resolveManifestPath(manifestDir, mapping.agentsPath)] : []),
  ])];
  for (const agentsPath of agentsPaths) {
    if (!existsSync(agentsPath)) continue;
    const stat = lstatSync(agentsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    for (const block of parseProjectionBlocks(readFileSync(agentsPath, "utf8"))) {
      if (!mappedPairs.has(`${agentsPath}\0${block.principleId}`)) {
        add(`unmanaged:${block.principleId}`, block.principleId, "unmanaged_projection", `Projection block in ${agentsPath} is not represented by a manifest mapping`, agentsPath);
      }
    }
  }

  const uniqueIssues = dedupeIssues(issues);
  return {
    schema: "ikb-principle-projection-drift.v1",
    manifestPath: absoluteManifest,
    scope: manifest.scope,
    checked: manifest.mappings.length,
    current: mappingResults.filter((result) => result.principleActive && result.projectionStatus === "current").length,
    issues: uniqueIssues,
    ok: uniqueIssues.length === 0,
    mappings: mappingResults.map((result) => ({ ...result, issues: dedupeIssues(result.issues) })),
  };
}

export function writePrincipleProjectionReport(home: string, result: PrincipleProjectionCheckResult): { jsonPath: string; markdownPath: string } {
  const root = join(resolve(home), "governance", result.scope, "principles");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const jsonPath = join(root, "projection-drift.json");
  const markdownPath = join(root, "projection-drift.md");
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const markdown = [
    "# Principle → AGENTS.md 投影漂移报告",
    "",
    `- Manifest: ${result.manifestPath}`,
    `- Checked: ${result.checked}`,
    `- Current: ${result.current}`,
    `- Issues: ${result.issues.length}`,
    "- Safety: 本报告只读检查并生成建议块，不会改写 AGENTS.md。",
    "",
    ...result.mappings.flatMap((mapping) => [
      `## ${mapping.mappingId}`,
      `- Principle: ${mapping.principleId}`,
      `- Confirmed and retrievable: ${mapping.principleActive}`,
      `- AGENTS.md: ${mapping.agentsPath ?? "not requested"}`,
      `- Projection: ${mapping.projectionStatus}`,
      ...(mapping.issues.length === 0 ? ["- Result: current"] : mapping.issues.map((issue) => `- ${issue.code}: ${issue.detail}`)),
      ...(mapping.expectedBlock ? ["", "### 建议投影块", "", "```markdown", mapping.expectedBlock, "```"] : []),
      "",
    ]),
    ...(result.issues.filter((issue) => issue.code === "unmanaged_projection").length > 0
      ? ["## 未纳入 manifest 的投影", "", ...result.issues.filter((issue) => issue.code === "unmanaged_projection").map((issue) => `- ${issue.principleId}: ${issue.detail}`), ""]
      : []),
  ].join("\n");
  writeFileSync(markdownPath, `${markdown}\n`, { mode: 0o600 });
  return { jsonPath, markdownPath };
}

export function defaultPrincipleProjectionManifestPath(home: string, scope: "personal" | "work" = "work"): string {
  return join(resolve(home), "governance", scope, "principles", "projection-manifest.json");
}

function parseProjectionBlocks(text: string): ParsedProjectionBlock[] {
  const blocks: ParsedProjectionBlock[] = [];
  const startPattern = /<!--\s*IKB Principle:\s*(kb-[A-Za-z0-9-]+)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(text)) !== null) {
    const principleId = match[1];
    const closePattern = new RegExp(`<!--\\s*\\/IKB Principle:\\s*${escapeRegExp(principleId)}\\s*-->`, "g");
    closePattern.lastIndex = startPattern.lastIndex;
    const close = closePattern.exec(text);
    if (!close) {
      blocks.push({ principleId, block: text.slice(match.index), body: text.slice(startPattern.lastIndex), valid: false });
      continue;
    }
    blocks.push({
      principleId,
      block: text.slice(match.index, close.index + close[0].length),
      body: text.slice(startPattern.lastIndex, close.index).trim(),
      valid: true,
    });
    startPattern.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

function resolveManifestPath(manifestDir: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(manifestDir, path);
}

function normalizeProjection(value: string): string {
  return value.replaceAll("\r\n", "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeIssues(issues: PrincipleProjectionIssue[]): PrincipleProjectionIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.mappingId}\0${issue.principleId}\0${issue.code}\0${issue.agentsPath ?? ""}\0${issue.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
