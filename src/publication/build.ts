import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { listKnowledge } from "../knowledge/records.ts";
import { ensurePrivateDirectory } from "../knowledge/storage.ts";
import type { KnowledgeRecord } from "../types.ts";
import { buildDailyCopilotOutput } from "./adapters/daily-copilot.ts";
import { buildPersonalGithubOutput } from "./adapters/personal-github.ts";
import type {
  DailyCopilotMigrationManifest,
  DailyCopilotPublicMapping,
  PublicationBuildOptions,
  PublicationBuildResult,
  PublicationBuildRecord,
  PublicationBundle,
  PublicKnowledgeEntry,
} from "./contracts.ts";
import { inspectPublicationEligibility, inspectPublicText } from "./safety.ts";

export function buildPublication(home: string, options: PublicationBuildOptions): PublicationBuildResult {
  const dailyCopilotMigration = options.channel === "daily-copilot"
    ? requireDailyCopilotMigration(options.dailyCopilotMigration)
    : undefined;
  const requestedIds = dailyCopilotMigration
    ? publishKnowledgeIds(dailyCopilotMigration)
    : options.knowledgeIds;
  const records = selectKnowledge(home, requestedIds);
  const entries = records.map(toPublicEntry).sort((left, right) => left.public_id.localeCompare(right.public_id));
  const bundle: PublicationBundle = {
    schema_version: "ikb-personal-publication.v1",
    entries,
  };
  const generatedPublicIds = entries.map((entry) => entry.public_id);
  const bundleBytes = stableJson(bundle);
  assertPublicBytes("bundle.json", bundleBytes, generatedPublicIds);
  const bundleHash = hash(bundleBytes);
  const migrationHash = dailyCopilotMigration ? hash(stableJson(dailyCopilotMigration)) : undefined;
  const adapter = options.channel === "daily-copilot"
    ? buildDailyCopilotOutput(
      bundle,
      bundleHash,
      dailyCopilotMigration!,
      publicMappings(dailyCopilotMigration!, records),
      migrationHash!,
    )
    : buildPersonalGithubOutput(bundle, bundleHash);
  const manifestBytes = stableJson(adapter.manifest);
  const outputFiles = [
    { path: "manifest.json", content: manifestBytes },
    ...adapter.files.sort((left, right) => left.path.localeCompare(right.path)),
  ];
  for (const file of outputFiles) {
    const content = options.channel === "daily-copilot" && file.path === "experience-data.js"
      ? stripGeneratedMiniProgramHtml(file.content)
      : file.content;
    assertPublicBytes(file.path, content, generatedPublicIds);
  }
  const outputHash = hashFileSet(outputFiles);
  const releaseId = `release-${hash(`${options.channel}\n${bundleHash}\n${outputHash}`).slice(0, 16)}`;
  const publicationRoot = join(resolve(home), "publications");
  const releaseDir = join(publicationRoot, releaseId);
  const bundlePath = join(releaseDir, "bundle.json");
  const outputDir = join(releaseDir, "output");
  const buildRecordPath = join(releaseDir, "build-record.json");

  assertSafeDirectoryIfExists(publicationRoot);
  if (existsSync(releaseDir)) {
    assertSafeDirectory(releaseDir);
    assertExistingBuild(bundlePath, bundleBytes, outputDir, outputFiles, buildRecordPath, {
      releaseId,
      channel: options.channel,
      bundleHash,
      outputHash,
    });
    return {
      releaseId,
      channel: options.channel,
      releaseDir,
      bundlePath,
      outputDir,
      buildRecordPath,
      bundleHash,
      outputHash,
      entryCount: entries.length,
      reused: true,
    };
  }

  ensurePrivateDirectory(publicationRoot);
  const stagingDir = join(publicationRoot, `.staging-${releaseId}-${randomUUID()}`);
  try {
    ensurePrivateDirectory(stagingDir);
    writePrivate(join(stagingDir, "bundle.json"), bundleBytes);
    for (const file of outputFiles) writePrivate(join(stagingDir, "output", file.path), file.content);
    const buildRecord: PublicationBuildRecord = {
      schemaVersion: "ikb-publication-build-record.v1",
      releaseId,
      channel: options.channel,
      state: "built",
      bundleHash,
      outputHash,
      knowledge: entries.map((entry) => {
        const record = records.find((candidate) => publicId(candidate.id) === entry.public_id)!;
        return {
          publicId: entry.public_id,
          knowledgeId: record.id,
          knowledgePath: record.path,
          sourceRefs: record.sourceRefs,
          compilationRef: record.compilationRef ?? "",
        };
      }),
      builtAt: new Date().toISOString(),
    };
    writePrivate(join(stagingDir, "build-record.json"), stableJson(buildRecord));
    renameSync(stagingDir, releaseDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return {
    releaseId,
    channel: options.channel,
    releaseDir,
    bundlePath,
    outputDir,
    buildRecordPath,
    bundleHash,
    outputHash,
    entryCount: entries.length,
    reused: false,
  };
}

function selectKnowledge(home: string, requestedIds?: string[]): KnowledgeRecord[] {
  const all = listKnowledge(home);
  if (requestedIds && requestedIds.length > 0) {
    const uniqueIds = [...new Set(requestedIds)].sort();
    const records = uniqueIds.map((id) => {
      const matches = all.filter((record) => record.id === id);
      if (matches.length === 0) throw new Error(`Knowledge not found: ${id}`);
      if (matches.length > 1) throw new Error(`Duplicate knowledge id: ${id}`);
      return matches[0];
    });
    for (const record of records) assertEligible(record);
    return records;
  }
  const records = all.filter((record) => inspectPublicationEligibility(record).length === 0);
  if (records.length === 0) throw new Error("No personal public verified Knowledge is eligible for publication");
  return records;
}

function requireDailyCopilotMigration(value: DailyCopilotMigrationManifest | undefined): DailyCopilotMigrationManifest {
  if (!value) throw new Error("Daily Copilot build requires a migration manifest");
  if (value.schema_version !== "ikb-daily-copilot-migration.v1") {
    throw new Error(`Unsupported Daily Copilot migration schema: ${String(value.schema_version)}`);
  }
  if (!value.source_snapshot?.trim()) throw new Error("Daily Copilot migration source_snapshot is required");
  const expected = validateLegacyIds(value.expected_legacy_ids, "expected_legacy_ids");
  const actual = validateLegacyIds(value.entries.map((entry) => entry.legacy_id), "entries");
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error(`Daily Copilot migration coverage mismatch: expected ${expected.join(",")} but got ${actual.join(",")}`);
  }
  if (new Set(value.category_order).size !== value.category_order.length || value.category_order.some((name) => !name.trim())) {
    throw new Error("Daily Copilot category_order must contain unique, non-empty category names");
  }
  for (const entry of value.entries) {
    if (!["publish", "skip", "private_rewrite"].includes(entry.disposition)) {
      throw new Error(`Unsupported Daily Copilot disposition for legacy id ${entry.legacy_id}: ${String(entry.disposition)}`);
    }
    if (!["none", "removed_unlicensed"].includes(entry.attachment_disposition)) {
      throw new Error(`Unsupported Daily Copilot attachment disposition for legacy id ${entry.legacy_id}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(entry.reason_code)) {
      throw new Error(`Daily Copilot reason_code must be a bounded token for legacy id ${entry.legacy_id}`);
    }
    if (entry.disposition === "publish") {
      if (!entry.knowledge_id?.trim()) throw new Error(`Daily Copilot publish entry ${entry.legacy_id} requires knowledge_id`);
      if (!entry.category?.trim()) throw new Error(`Daily Copilot publish entry ${entry.legacy_id} requires category`);
    } else if (entry.knowledge_id) {
      throw new Error(`Daily Copilot non-publish entry ${entry.legacy_id} cannot reference Knowledge`);
    }
  }
  return value;
}

function validateLegacyIds(values: number[], label: string): number[] {
  if (!Array.isArray(values) || values.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`Daily Copilot ${label} must contain positive integer legacy ids`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (new Set(sorted).size !== sorted.length) throw new Error(`Daily Copilot ${label} contains duplicate legacy ids`);
  return sorted;
}

function publishKnowledgeIds(migration: DailyCopilotMigrationManifest): string[] {
  return [...new Set(
    migration.entries
      .filter((entry) => entry.disposition === "publish")
      .map((entry) => entry.knowledge_id!),
  )].sort();
}

function publicMappings(
  migration: DailyCopilotMigrationManifest,
  records: KnowledgeRecord[],
): DailyCopilotPublicMapping[] {
  const publicIdByKnowledgeId = new Map(records.map((record) => [record.id, publicId(record.id)]));
  return migration.entries
    .filter((entry) => entry.disposition === "publish")
    .map((entry) => {
      const mappedPublicId = publicIdByKnowledgeId.get(entry.knowledge_id!);
      if (!mappedPublicId) throw new Error(`Daily Copilot mapping references unselected Knowledge: ${entry.knowledge_id}`);
      return {
        legacy_id: entry.legacy_id,
        public_id: mappedPublicId,
        title: entry.title,
        category: entry.category,
        attachment_disposition: entry.attachment_disposition,
        reason_code: entry.reason_code,
      };
    });
}

function assertEligible(record: KnowledgeRecord): void {
  const issues = inspectPublicationEligibility(record);
  if (issues.length > 0) {
    throw new Error(`Knowledge ${record.id} is not publishable: ${issues.map((issue) => `${issue.code} (${issue.detail})`).join("; ")}`);
  }
}

function toPublicEntry(record: KnowledgeRecord): PublicKnowledgeEntry {
  assertEligible(record);
  const semanticContent = {
    title: record.title,
    type: record.type,
    category: record.collection,
    product_type: record.productType ?? "",
    summary: firstParagraph(record.body),
    tags: [...record.tags].sort(),
    questions_answered: [...(record.questionsAnswered ?? [])],
    applicability: record.applicability,
    boundary: record.boundary,
    use_when: record.useWhen ?? "",
    use_inputs: [...(record.useInputs ?? [])],
    use_outputs: [...(record.useOutputs ?? [])],
    use_steps: [...(record.useSteps ?? [])],
    use_checks: [...(record.useChecks ?? [])],
    use_stop_conditions: [...(record.useStopConditions ?? [])],
    valid_from: record.validFrom,
    temporal_state: record.temporalState ?? "unknown",
    content_markdown: record.body.trim(),
  };
  return {
    public_id: publicId(record.id),
    ...semanticContent,
    content_hash: hash(stableJson(semanticContent)),
  };
}

function firstParagraph(body: string): string {
  const parts = body.trim().split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const paragraph = parts.find((part) => !/^#{1,6}\s+/.test(part)) ?? parts[0] ?? "";
  return paragraph.replace(/^>\s*/, "").replace(/\s+/g, " ").trim();
}

function publicId(knowledgeId: string): string {
  return `pub-${hash(`ikb-publication:${knowledgeId}`).slice(0, 16)}`;
}

function assertPublicBytes(label: string, content: string, generatedPublicIds: string[]): void {
  const issues = inspectPublicText(content, generatedPublicIds);
  if (issues.length > 0) {
    throw new Error(`Public output ${label} failed sensitive scan: ${issues.map((issue) => `${issue.code} (${issue.detail})`).join("; ")}`);
  }
}

function stripGeneratedMiniProgramHtml(content: string): string {
  return content.replace(/<\/?(?:h4|p|ul|ol|li|pre|code|b)>/g, "");
}

function assertExistingBuild(
  bundlePath: string,
  expectedBundle: string,
  outputDir: string,
  expectedOutput: Array<{ path: string; content: string }>,
  buildRecordPath: string,
  expected: { releaseId: string; channel: string; bundleHash: string; outputHash: string },
): void {
  assertSafeDirectory(outputDir);
  assertFileBytes(bundlePath, expectedBundle);
  for (const file of expectedOutput) assertFileBytes(join(outputDir, file.path), file.content);
  if (!existsSync(buildRecordPath)) throw new Error(`Existing publication is incomplete: ${buildRecordPath}`);
  const record = JSON.parse(readFileSync(buildRecordPath, "utf8")) as Partial<PublicationBuildRecord>;
  for (const [key, value] of Object.entries(expected)) {
    if (record[key as keyof PublicationBuildRecord] !== value) {
      throw new Error(`Existing publication release record mismatch: ${key}`);
    }
  }
}

function assertFileBytes(path: string, expected: string): void {
  if (!existsSync(path)) throw new Error(`Existing publication is incomplete: ${path}`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`Existing publication output cannot be a symbolic link: ${path}`);
  if (!metadata.isFile()) throw new Error(`Existing publication output must be a regular file: ${path}`);
  if (readFileSync(path, "utf8") !== expected) throw new Error(`Existing publication output was modified: ${path}`);
}

function assertSafeDirectoryIfExists(path: string): void {
  if (existsSync(path)) assertSafeDirectory(path);
}

function assertSafeDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`Publication directory cannot be a symbolic link: ${path}`);
  if (!metadata.isDirectory()) throw new Error(`Publication path must be a directory: ${path}`);
}

function writePrivate(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
}

function hashFileSet(files: Array<{ path: string; content: string }>): string {
  return hash(files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${hash(file.content)}`)
    .join("\n"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
