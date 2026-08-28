import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LedgerStore } from "./store.ts";
import type { KnowledgeRecord, SourceRecord } from "./types.ts";
import {
  EXTRACTION_MANIFEST_VERSION,
  EXTRACTION_RESULT_VERSION,
} from "./extraction/contracts.ts";
import { renderKnowledgeProductBody } from "./extraction/render.ts";
import { validateExtractionBatch, verifyExtractionBatch } from "./extraction/validation.ts";
import { renderKnowledge } from "./knowledge/codec.ts";
import {
  applyReviewedQv5KnowledgeRevision,
  preflightReviewedQv5KnowledgeRevision,
} from "./knowledge/qv5-revision.ts";
import { captureKnowledge } from "./knowledge/repository.ts";
import { findKnowledge, listKnowledge } from "./knowledge/records.ts";
import { listSources } from "./source.ts";

export const MEMORY_TOPIC_MIGRATION_VERSION = "ikb-memory-topic-migration.v1";
export const MEMORY_TOPIC_MAX_BATCH_SIZE = 3;

export interface MemoryTopicIndexEntry {
  file: string;
  keywords: string;
  summary: string;
  rawRow: string;
  rowHash: string;
}

export type MemoryTopicMigrationStatus =
  | "ready"
  | "current"
  | "missing_file"
  | "missing_current_source"
  | "revision_required"
  | "ambiguous_knowledge";

export interface MemoryTopicMigrationEntry extends MemoryTopicIndexEntry {
  path: string;
  contentHash: string | null;
  sourceId: string | null;
  latestSourceId: string | null;
  canonicalKey: string;
  knowledgeIds: string[];
  status: MemoryTopicMigrationStatus;
  reason: string;
}

export interface MemoryTopicMigrationReport {
  schema: typeof MEMORY_TOPIC_MIGRATION_VERSION;
  generatedAt: string;
  indexPath: string;
  indexHash: string;
  indexSourceId: string | null;
  topicCount: number;
  counts: Record<MemoryTopicMigrationStatus, number>;
  entries: MemoryTopicMigrationEntry[];
}

export interface MemoryTopicBatchResult {
  schema: typeof MEMORY_TOPIC_MIGRATION_VERSION;
  disposition: "changed" | "no_change" | "needs_review";
  runId: string;
  offset: number;
  limit: number;
  selected: MemoryTopicMigrationEntry[];
  created: KnowledgeRecord[];
  artifacts: {
    manifest: string | null;
    compilation: string | null;
    validation: string | null;
    fidelity: string | null;
    receipt: string;
  };
  reportPaths: { json: string; markdown: string };
}

export interface MemoryTopicRevisionResult {
  schema: typeof MEMORY_TOPIC_MIGRATION_VERSION;
  disposition: "changed" | "no_change" | "needs_review";
  analystRunId: string;
  curatorRunId: string;
  offset: number;
  limit: number;
  selected: MemoryTopicMigrationEntry[];
  revised: Array<{ knowledgeId: string; revisionId: string; revision: number }>;
  artifacts: {
    manifest: string | null;
    compilation: string | null;
    validation: string | null;
    fidelity: string | null;
    replacements: string[];
    replacementValidations: string[];
    receipt: string;
  };
  reportPaths: { json: string; markdown: string };
}

export function parseMemoryTopicIndex(markdown: string): MemoryTopicIndexEntry[] {
  const entries: MemoryTopicIndexEntry[] = [];
  const byFile = new Map<string, MemoryTopicIndexEntry>();
  let inTopicIndex = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{2,3}\s+Topic Index\s*$/.test(line)) {
      inTopicIndex = true;
      continue;
    }
    if (inTopicIndex && /^#{1,6}\s+/.test(line)) {
      inTopicIndex = false;
      continue;
    }
    if (!inTopicIndex || !/^\s*\|/.test(line)) continue;
    const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length < 3 || !cells[0].endsWith(".md")) continue;
    const file = cells[0];
    if (file.startsWith("archive/")) continue;
    const entry: MemoryTopicIndexEntry = {
      file,
      keywords: cells[1],
      summary: cells[2],
      rawRow: line.trim(),
      rowHash: sha256(line.trim()),
    };
    const existing = byFile.get(file);
    if (existing) {
      if (existing.rawRow !== entry.rawRow) throw new Error(`Memory Topic Index contains conflicting rows for ${file}`);
      continue;
    }
    byFile.set(file, entry);
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error("Memory Topic Index has no active topic rows");
  return entries;
}

export function inspectMemoryTopicMigration(home: string, indexPath: string): MemoryTopicMigrationReport {
  const resolvedIndex = resolve(indexPath);
  assertRegularFile(resolvedIndex, "Memory Topic Index");
  const indexText = readFileSync(resolvedIndex, "utf8");
  const topics = parseMemoryTopicIndex(indexText);
  const root = dirname(resolvedIndex);
  const sources = listSources(home, { includeQuarantined: true });
  const knowledge = listKnowledge(home, "work").filter((record) => record.status !== "retired");
  const indexHash = sha256(readFileSync(resolvedIndex));
  const indexSource = currentSourceFor(sources, resolvedIndex, indexHash);
  const entries = topics.map((topic) => inspectTopic(root, topic, sources, knowledge));
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.status] += 1;
  return {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    generatedAt: new Date().toISOString(),
    indexPath: resolvedIndex,
    indexHash,
    indexSourceId: indexSource?.id ?? null,
    topicCount: entries.length,
    counts,
    entries,
  };
}

export function writeMemoryTopicMigrationReport(home: string, report: MemoryTopicMigrationReport): { json: string; markdown: string } {
  const directory = join(resolve(home), "governance", "work", "memory-topics");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const json = join(directory, "latest.json");
  const markdown = join(directory, "latest.md");
  writeAtomic(json, `${JSON.stringify(report, null, 2)}\n`);
  writeAtomic(markdown, renderReport(report));
  return { json, markdown };
}

export function migrateMemoryTopicBatch(
  home: string,
  store: LedgerStore,
  options: { indexPath: string; runId: string; offset?: number; limit?: number },
): MemoryTopicBatchResult {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MEMORY_TOPIC_MAX_BATCH_SIZE;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Memory Topic offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_TOPIC_MAX_BATCH_SIZE) {
    throw new Error(`Memory Topic batch limit must be from 1 to ${MEMORY_TOPIC_MAX_BATCH_SIZE}`);
  }
  const run = store.requireRun(options.runId);
  const task = store.requireTask(run.taskId);
  if (task.scope !== "work") throw new Error(`Memory Topic migration requires a work Task, got ${task.scope}`);
  if (run.status !== "running") throw new Error(`Memory Topic migration Run must be running, got ${run.status}`);

  const before = inspectMemoryTopicMigration(home, options.indexPath);
  if (!before.indexSourceId) throw new Error("Current MEMORY.md snapshot is not present in IKB Source; sync catpaw-memory-local first");
  const selected = before.entries.slice(offset, offset + limit);
  if (selected.length === 0) throw new Error(`Memory Topic offset ${offset} is outside ${before.topicCount} active topics`);
  const blocked = selected.filter((entry) => !["ready", "current"].includes(entry.status));
  const reportPaths = writeMemoryTopicMigrationReport(home, before);
  if (blocked.length > 0) {
    const receipt = writeBatchReceipt(run.runDir, {
      schema: MEMORY_TOPIC_MIGRATION_VERSION,
      disposition: "needs_review",
      offset,
      limit,
      selected: selected.map(receiptEntry),
    });
    const receiptArtifact = reuseOrCreateArtifact(store, run.id, "memory-topic-migration-receipt", "Memory Topic 迁移回执", receipt);
    return {
      schema: MEMORY_TOPIC_MIGRATION_VERSION,
      disposition: "needs_review",
      runId: run.id,
      offset,
      limit,
      selected,
      created: [],
      artifacts: { manifest: null, compilation: null, validation: null, fidelity: null, receipt: receiptArtifact.id },
      reportPaths,
    };
  }

  const ready = selected.filter((entry) => entry.status === "ready");
  if (ready.length === 0) {
    const receipt = writeBatchReceipt(run.runDir, {
      schema: MEMORY_TOPIC_MIGRATION_VERSION,
      disposition: "no_change",
      offset,
      limit,
      selected: selected.map(receiptEntry),
    });
    const receiptArtifact = reuseOrCreateArtifact(store, run.id, "memory-topic-migration-receipt", "Memory Topic 迁移回执", receipt);
    return {
      schema: MEMORY_TOPIC_MIGRATION_VERSION,
      disposition: "no_change",
      runId: run.id,
      offset,
      limit,
      selected,
      created: [],
      artifacts: { manifest: null, compilation: null, validation: null, fidelity: null, receipt: receiptArtifact.id },
      reportPaths,
    };
  }

  const indexSource = listSources(home, { includeQuarantined: true }).find((source) => source.id === before.indexSourceId)!;
  const compiled = compileBatch(home, before, ready, indexSource);
  if (!compiled.validation.valid) throw new Error(`Memory Topic compilation is invalid: ${compiled.validation.issues.map((issue) => issue.code).join(", ")}`);
  if (!compiled.fidelity.valid || compiled.fidelity.publishableCount !== ready.length) {
    throw new Error(`Memory Topic fidelity gate failed: ${compiled.fidelity.issues.map((issue) => issue.code).join(", ")}`);
  }

  const batchHash = sha256(JSON.stringify({ index: before.indexHash, offset, topics: ready.map((entry) => [entry.file, entry.contentHash]) }));
  const manifestPath = writeImmutableJson(run.runDir, `memory-topic-manifest-${batchHash.slice(0, 16)}.json`, compiled.manifest);
  const compilationPath = writeImmutableJson(run.runDir, `memory-topic-compilation-${batchHash.slice(0, 16)}.json`, { results: compiled.results });
  const validationPath = writeImmutableJson(run.runDir, `memory-topic-validation-${batchHash.slice(0, 16)}.json`, compiled.validation);
  const fidelityPath = writeImmutableJson(run.runDir, `memory-topic-fidelity-${batchHash.slice(0, 16)}.json`, compiled.fidelity);
  const manifestArtifact = reuseOrCreateArtifact(store, run.id, "knowledge-extraction-manifest", "Memory Topic QV5 manifest", manifestPath);
  const compilationArtifact = reuseOrCreateArtifact(store, run.id, "knowledge-extraction-result", "Memory Topic QV5 compilation", compilationPath);
  const validationArtifact = reuseOrCreateArtifact(store, run.id, "knowledge-qv5-validation", "Memory Topic QV5 validation", validationPath);
  const fidelityArtifact = reuseOrCreateArtifact(store, run.id, "knowledge-extraction-fidelity", "Memory Topic QV5 fidelity", fidelityPath);

  const created = ready.map((entry) => {
    const topic = compiled.byFile.get(entry.file)!;
    const body = renderKnowledgeProductBody(topic.result, topic.caseId, topic.productId);
    return captureKnowledge(home, {
      title: `Memory Topic：${entry.summary}`,
      type: "synthesis",
      collection: "syntheses",
      sourceKind: "artifact",
      scope: "work",
      status: "draft",
      sourceRefs: [entry.sourceId!, before.indexSourceId!],
      tags: ["memory-topic", "catpaw-memory"],
      aliases: [entry.file, `memory-topic:${entry.file}`, `memory-topic-row:${entry.rowHash}`, ...splitKeywords(entry.keywords)],
      qualityVersion: 5,
      productType: "synthesis",
      canonicalKey: entry.canonicalKey,
      compilationSchema: EXTRACTION_RESULT_VERSION,
      compilationCaseId: topic.caseId,
      compilationProductId: topic.productId,
      extractionManifestRef: manifestArtifact.id,
      compilationRef: compilationArtifact.id,
      informationLossRef: fidelityArtifact.id,
      factRefs: topic.factIds,
      questionsAnswered: [topic.question],
      admissionReason: "CatPaw Memory Topic Index 会按关键词把该主题注入 Agent；迁移为 IKB Knowledge 后可统一检索、追踪来源和维护版本。",
      applicability: `任务涉及 ${entry.keywords} 时，作为来源确认的背景知识使用。`,
      boundary: "完整内容来自当前 Memory Topic 快照；仅 source_confirmed，默认是 advisory，不等于事实已独立验证，也不会自动激活为 Principle 或 policy。",
      useWhen: entry.keywords,
      useInputs: ["当前任务目标或问题", "命中的 Topic Index 关键词"],
      useOutputs: ["可回溯到 Source 的 Memory Topic 完整内容"],
      useSteps: ["按关键词召回本卡", "先按 advisory 阅读并核对适用边界", "需要执行或高风险判断时回查 Source 或补真实任务验证"],
      useChecks: ["source_refs 指向当前 topic Source", "内容 hash 与 QV5 manifest 一致"],
      useStopConditions: ["来源已更新但本卡尚未完成 QV5 revision", "任务要求 verified-only"],
      confidence: "medium",
      confidenceBasis: [`Topic Source ${entry.sourceId} 与本地文件 SHA-256 一致`, `Topic Index Source ${before.indexSourceId} 显式引用该主题`],
      temporalState: "mixed",
      verification: "source_confirmed",
      body,
    });
  });

  const after = inspectMemoryTopicMigration(home, options.indexPath);
  const afterPaths = writeMemoryTopicMigrationReport(home, after);
  const receipt = writeBatchReceipt(run.runDir, {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition: "changed",
    offset,
    limit,
    selected: selected.map(receiptEntry),
    created: created.map((record) => ({ id: record.id, canonicalKey: record.canonicalKey, sourceRefs: record.sourceRefs, path: record.path })),
    gates: { validation: compiled.validation.valid, fidelity: compiled.fidelity.valid, publishableCount: compiled.fidelity.publishableCount },
  });
  const receiptArtifact = reuseOrCreateArtifact(store, run.id, "memory-topic-migration-receipt", "Memory Topic 迁移回执", receipt);
  return {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition: "changed",
    runId: run.id,
    offset,
    limit,
    selected: after.entries.slice(offset, offset + limit),
    created,
    artifacts: {
      manifest: manifestArtifact.id,
      compilation: compilationArtifact.id,
      validation: validationArtifact.id,
      fidelity: fidelityArtifact.id,
      receipt: receiptArtifact.id,
    },
    reportPaths: afterPaths,
  };
}

export function reviseMemoryTopicBatch(
  home: string,
  store: LedgerStore,
  options: { indexPath: string; analystRunId: string; curatorRunId: string; offset?: number; limit?: number },
): MemoryTopicRevisionResult {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? MEMORY_TOPIC_MAX_BATCH_SIZE;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Memory Topic offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_TOPIC_MAX_BATCH_SIZE) {
    throw new Error(`Memory Topic batch limit must be from 1 to ${MEMORY_TOPIC_MAX_BATCH_SIZE}`);
  }
  if (options.analystRunId === options.curatorRunId) throw new Error("Memory Topic QV5 revision requires separate Analyst and Curator Runs");
  const analystRun = requireMemoryTopicRun(store, options.analystRunId, "ikb-analyst", "ikb-conversation-analysis");
  const curatorRun = requireMemoryTopicRun(store, options.curatorRunId, "ikb-curator", "ikb-knowledge-curator");

  const before = inspectMemoryTopicMigration(home, options.indexPath);
  if (!before.indexSourceId) throw new Error("Current MEMORY.md snapshot is not present in IKB Source; sync catpaw-memory-local first");
  const selected = before.entries.slice(offset, offset + limit);
  if (selected.length === 0) throw new Error(`Memory Topic offset ${offset} is outside ${before.topicCount} active topics`);
  const blocked = selected.filter((entry) => !["current", "revision_required"].includes(entry.status));
  const reportPaths = writeMemoryTopicMigrationReport(home, before);
  if (blocked.length > 0) {
    return memoryTopicRevisionTerminalResult(store, curatorRun, analystRun.id, offset, limit, selected, reportPaths, "needs_review");
  }
  const pending = selected.filter((entry) => entry.status === "revision_required");
  if (pending.length === 0) {
    return memoryTopicRevisionTerminalResult(store, curatorRun, analystRun.id, offset, limit, selected, reportPaths, "no_change");
  }
  if (pending.some((entry) => entry.knowledgeIds.length !== 1 || !entry.sourceId)) {
    throw new Error("Memory Topic revision requires exactly one active Knowledge and one current Source per topic");
  }

  const indexSource = listSources(home, { includeQuarantined: true }).find((source) => source.id === before.indexSourceId)!;
  const compiled = compileBatch(home, before, pending, indexSource);
  if (!compiled.validation.valid) throw new Error(`Memory Topic compilation is invalid: ${compiled.validation.issues.map((issue) => issue.code).join(", ")}`);
  if (!compiled.fidelity.valid || compiled.fidelity.publishableCount !== pending.length) {
    throw new Error(`Memory Topic fidelity gate failed: ${compiled.fidelity.issues.map((issue) => issue.code).join(", ")}`);
  }

  const batchHash = sha256(JSON.stringify({ index: before.indexHash, offset, topics: pending.map((entry) => [entry.file, entry.contentHash, entry.knowledgeIds[0]]) }));
  const manifestPath = writeImmutableJson(analystRun.runDir, `memory-topic-revision-manifest-${batchHash.slice(0, 16)}.json`, compiled.manifest);
  const compilationPath = writeImmutableJson(analystRun.runDir, `memory-topic-revision-compilation-${batchHash.slice(0, 16)}.json`, { results: compiled.results });
  const validationPath = writeImmutableJson(analystRun.runDir, `memory-topic-revision-validation-${batchHash.slice(0, 16)}.json`, compiled.validation);
  const fidelityPath = writeImmutableJson(analystRun.runDir, `memory-topic-revision-fidelity-${batchHash.slice(0, 16)}.json`, compiled.fidelity);
  const manifestArtifact = reuseOrCreateArtifact(store, analystRun.id, "knowledge-extraction-manifest", "Memory Topic revision QV5 manifest", manifestPath);
  const compilationArtifact = reuseOrCreateArtifact(store, analystRun.id, "knowledge-extraction-result", "Memory Topic revision QV5 compilation", compilationPath);
  const validationArtifact = reuseOrCreateArtifact(store, analystRun.id, "knowledge-extraction-validation", "Memory Topic revision QV5 validation", validationPath);
  const fidelityArtifact = reuseOrCreateArtifact(store, analystRun.id, "knowledge-extraction-fidelity", "Memory Topic revision QV5 fidelity", fidelityPath);

  const revisionInputs = pending.map((entry) => {
    const target = findKnowledge(home, entry.knowledgeIds[0]);
    if (!target) throw new Error(`Memory Topic revision target disappeared: ${entry.knowledgeIds[0]}`);
    const topic = compiled.byFile.get(entry.file)!;
    const body = renderKnowledgeProductBody(topic.result, topic.caseId, topic.productId);
    const replacementText = renderKnowledge({
      ...target,
      title: `Memory Topic：${entry.summary}`,
      status: "draft",
      sourceRefs: uniqueStrings([...target.sourceRefs, entry.sourceId!, before.indexSourceId!]),
      tags: uniqueStrings([...target.tags, "memory-topic", "catpaw-memory"]),
      aliases: uniqueStrings([...target.aliases, entry.file, `memory-topic:${entry.file}`, `memory-topic-row:${entry.rowHash}`, ...splitKeywords(entry.keywords)]),
      qualityVersion: 5,
      productType: "synthesis",
      canonicalKey: entry.canonicalKey,
      compilationSchema: EXTRACTION_RESULT_VERSION,
      compilationCaseId: topic.caseId,
      compilationProductId: topic.productId,
      extractionManifestRef: manifestArtifact.id,
      compilationRef: compilationArtifact.id,
      informationLossRef: fidelityArtifact.id,
      factRefs: topic.factIds,
      questionsAnswered: [topic.question],
      admissionReason: "CatPaw Memory Topic Index 会按关键词把该主题注入 Agent；迁移为 IKB Knowledge 后可统一检索、追踪来源和维护版本。",
      applicability: `任务涉及 ${entry.keywords} 时，作为来源确认的背景知识使用。`,
      boundary: "完整内容来自当前 Memory Topic 快照；仅 source_confirmed，默认是 advisory，不等于事实已独立验证，也不会自动激活为 Principle 或 policy。",
      useWhen: entry.keywords,
      useInputs: ["当前任务目标或问题", "命中的 Topic Index 关键词"],
      useOutputs: ["可回溯到 Source 的 Memory Topic 完整内容"],
      useSteps: ["按关键词召回本卡", "先按 advisory 阅读并核对适用边界", "需要执行或高风险判断时回查 Source 或补真实任务验证"],
      useChecks: ["source_refs 指向当前 topic Source", "内容 hash 与 QV5 manifest 一致"],
      useStopConditions: ["来源已更新但本卡尚未完成 QV5 revision", "任务要求 verified-only"],
      confidence: "medium",
      confidenceBasis: uniqueStrings([...(target.confidenceBasis ?? []), `Topic Source ${entry.sourceId} 与本地文件 SHA-256 一致`, `Topic Index Source ${before.indexSourceId} 显式引用该主题`]),
      temporalState: "mixed",
      verification: "source_confirmed",
      body,
    });
    const replacementHash = sha256(replacementText);
    const replacementPath = writeImmutableText(curatorRun.runDir, `memory-topic-replacement-${target.id}-${replacementHash.slice(0, 16)}.md`, replacementText);
    const replacementArtifact = reuseOrCreateArtifact(store, curatorRun.id, "knowledge-qv5-replacement-draft", `Memory Topic replacement：${entry.file}`, replacementPath);
    const replacementValidationPath = writeImmutableJson(curatorRun.runDir, `memory-topic-replacement-validation-${target.id}-${replacementHash.slice(0, 16)}.json`, {
      schema: "ikb-qv5-replacement-validation.v1",
      knowledgeId: target.id,
      bodyExact: true,
      renderedHash: replacementHash,
      topicFile: entry.file,
      topicSourceId: entry.sourceId,
    });
    const replacementValidationArtifact = reuseOrCreateArtifact(store, curatorRun.id, "knowledge-qv5-validation", `Memory Topic replacement validation：${entry.file}`, replacementValidationPath);
    return {
      entry,
      replacementArtifact,
      replacementValidationArtifact,
      input: {
        knowledgeId: target.id,
        replacementArtifactId: replacementArtifact.id,
        validationArtifactId: replacementValidationArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        compilationArtifactId: compilationArtifact.id,
        fidelityArtifactId: fidelityArtifact.id,
      },
    };
  });

  for (const item of revisionInputs) preflightReviewedQv5KnowledgeRevision(home, store, item.input);
  const revised = revisionInputs.map((item) => {
    const result = applyReviewedQv5KnowledgeRevision(home, store, item.input);
    return { knowledgeId: result.record.id, revisionId: result.journal.id, revision: result.record.revision };
  });
  const after = inspectMemoryTopicMigration(home, options.indexPath);
  const afterPaths = writeMemoryTopicMigrationReport(home, after);
  const receipt = writeBatchReceipt(curatorRun.runDir, {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition: "changed",
    operation: "qv5_revision",
    analystRunId: analystRun.id,
    curatorRunId: curatorRun.id,
    offset,
    limit,
    selected: selected.map(receiptEntry),
    revised,
    gates: { validation: compiled.validation.valid, fidelity: compiled.fidelity.valid, publishableCount: compiled.fidelity.publishableCount },
  });
  const receiptArtifact = reuseOrCreateArtifact(store, curatorRun.id, "memory-topic-migration-receipt", "Memory Topic QV5 修订回执", receipt);
  return {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition: "changed",
    analystRunId: analystRun.id,
    curatorRunId: curatorRun.id,
    offset,
    limit,
    selected: after.entries.slice(offset, offset + limit),
    revised,
    artifacts: {
      manifest: manifestArtifact.id,
      compilation: compilationArtifact.id,
      validation: validationArtifact.id,
      fidelity: fidelityArtifact.id,
      replacements: revisionInputs.map((item) => item.replacementArtifact.id),
      replacementValidations: revisionInputs.map((item) => item.replacementValidationArtifact.id),
      receipt: receiptArtifact.id,
    },
    reportPaths: afterPaths,
  };
}

function inspectTopic(root: string, topic: MemoryTopicIndexEntry, sources: SourceRecord[], knowledge: KnowledgeRecord[]): MemoryTopicMigrationEntry {
  const path = resolve(root, topic.file);
  const rel = relative(root, path);
  const canonicalKey = memoryTopicCanonicalKey(topic.file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    return { ...topic, path, contentHash: null, sourceId: null, latestSourceId: null, canonicalKey, knowledgeIds: [], status: "missing_file", reason: "Topic Index 指向的文件不存在或不是普通文件。" };
  }
  const contentHash = sha256(readFileSync(path));
  const pathSources = sources.filter((source) => source.originalPath === path && source.adapter === "catpaw-memory-local");
  const currentSource = pathSources.find((source) => source.contentHash === contentHash) ?? null;
  const latestSource = pathSources[0] ?? null;
  const canonicalKnowledge = knowledge.filter((record) => record.canonicalKey === canonicalKey);
  const linkedKnowledge = currentSource ? knowledge.filter((record) => record.sourceRefs.includes(currentSource.id)) : [];
  const owners = [...new Map([...canonicalKnowledge, ...linkedKnowledge].map((record) => [record.id, record])).values()];
  const base = { ...topic, path, contentHash, sourceId: currentSource?.id ?? null, latestSourceId: latestSource?.id ?? null, canonicalKey, knowledgeIds: owners.map((record) => record.id).sort() };
  if (!currentSource) return { ...base, status: "missing_current_source", reason: latestSource ? "已有历史 Source，但当前本地文件 hash 尚未同步。" : "当前 Topic 文件尚未进入 IKB Source。" };
  if (canonicalKnowledge.length > 1 || linkedKnowledge.length > 1) return { ...base, status: "ambiguous_knowledge", reason: "同一 Topic 对应多个活动 Knowledge，需要先人工合并。" };
  const existing = canonicalKnowledge[0] ?? linkedKnowledge[0] ?? null;
  if (!existing) return { ...base, status: "ready", reason: "当前 Source 已就绪，尚无 Knowledge。" };
  if (existing.canonicalKey !== canonicalKey || existing.qualityVersion < 5 || existing.productType !== "synthesis") {
    return { ...base, status: "revision_required", reason: `现有 Knowledge ${existing.id} 未使用当前 Memory Topic QV5 合同。` };
  }
  const rowAlias = `memory-topic-row:${topic.rowHash}`;
  if (!existing.sourceRefs.includes(currentSource.id) || !existing.aliases.includes(rowAlias)) {
    return { ...base, status: "revision_required", reason: `现有 Knowledge ${existing.id} 的 Topic Source 或 Index 行已变化，必须走 QV5 revision。` };
  }
  return { ...base, status: "current", reason: `Knowledge ${existing.id} 已绑定当前 Topic Source 和 Index 行。` };
}

function compileBatch(home: string, report: MemoryTopicMigrationReport, entries: MemoryTopicMigrationEntry[], indexSource: SourceRecord) {
  const sources = listSources(home, { includeQuarantined: true });
  const knowledge = listKnowledge(home, "work").filter((record) => record.status !== "retired");
  const indexText = readFileSync(report.indexPath, "utf8");
  const indexHash = sha256(readFileSync(report.indexPath));
  const benchmarkId = `memory-topic-${sha256(entries.map((entry) => `${entry.file}:${entry.contentHash}`).join("|" )).slice(0, 16)}`;
  const manifestCases: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  const byFile = new Map<string, { caseId: string; productId: string; factIds: string[]; question: string; result: Record<string, unknown> }>();
  for (const entry of entries) {
    const topicSource = sources.find((source) => source.id === entry.sourceId)!;
    const existing = entry.knowledgeIds.length === 1 ? knowledge.find((record) => record.id === entry.knowledgeIds[0]) ?? null : null;
    const originalContent = readFileSync(entry.path, "utf8");
    if (sha256(Buffer.from(originalContent)) !== entry.contentHash) throw new Error(`Memory Topic changed during compilation: ${entry.file}`);
    const content = escapeLiteralNewlineTokensForMarkdown(originalContent);
    const topicExcerpt = originalContent.trim();
    const slug = topicSlug(entry.file);
    const suffix = entry.contentHash!.slice(0, 8);
    const caseId = `memory-topic-${slug}-${suffix}`;
    const productId = `product-${slug}-${suffix}`;
    const topicUnitId = `unit-topic-${slug}-${suffix}`;
    const indexUnitId = `unit-index-${slug}-${entry.rowHash.slice(0, 8)}`;
    const topicEvidenceId = `evidence-topic-${slug}-${suffix}`;
    const indexEvidenceId = `evidence-index-${slug}-${entry.rowHash.slice(0, 8)}`;
    const topicFactId = `fact-topic-${slug}-${suffix}`;
    const routeFactId = `fact-route-${slug}-${entry.rowHash.slice(0, 8)}`;
    const topicReferenceId = `reference-topic-${slug}-${suffix}`;
    const routeReferenceId = `reference-route-${slug}-${entry.rowHash.slice(0, 8)}`;
    const obligationId = `obligation-${slug}`;
    const questionId = `question-${slug}`;
    const claimId = `claim-${slug}`;
    const question = `当任务命中“${entry.keywords}”时，${entry.summary} 当前包含哪些可复用知识？`;
    const routeStatement = `Topic Index 将关键词“${entry.keywords}”路由到 ${entry.file}，摘要为“${entry.summary}”。`;
    const inputFingerprint = sha256(JSON.stringify({ indexHash: report.indexHash, rowHash: entry.rowHash, topicHash: entry.contentHash, existing: existing ? [existing.id, existing.revision] : null }));
    manifestCases.push({
      case_id: caseId,
      category: "memory_topic",
      title: entry.summary,
      input_fingerprint: inputFingerprint,
      extraction_modes: ["synthesis"],
      source_ids: [topicSource.id, indexSource.id],
      source_snapshots: [
        { source_id: topicSource.id, path: topicSource.rawPath, content_sha256: topicSource.contentHash },
        { source_id: indexSource.id, path: indexSource.rawPath, content_sha256: indexHash },
      ],
      consumer_tasks: ["根据任务关键词加载对应 Memory Topic", "在 IKB Context Pack 中提供可回溯背景"],
      obligations: [{ obligation_id: obligationId, description: "完整保留 Topic 内容、Index 路由和来源边界。", importance: "core", required_product_types: ["synthesis"] }],
      source_units: [
        { unit_id: topicUnitId, source_id: topicSource.id, unit_kind: "section", locator: entry.file, content: originalContent, content_sha256: sha256(originalContent), importance: "core" },
        { unit_id: indexUnitId, source_id: indexSource.id, unit_kind: "table", locator: `Topic Index:${entry.file}`, content: entry.rawRow, content_sha256: sha256(entry.rawRow), importance: "supporting" },
      ],
      reference_facts: [
        { reference_fact_id: topicReferenceId, statement: content, importance: "core", source_unit_refs: [topicUnitId], question_refs: [questionId] },
        { reference_fact_id: routeReferenceId, statement: routeStatement, importance: "supporting", source_unit_refs: [indexUnitId], question_refs: [questionId] },
      ],
      questions: [{ question_id: questionId, text: question, importance: "core", required_product_types: ["synthesis"] }],
      existing_knowledge: existing ? [{ knowledge_id: existing.id, canonical_key: entry.canonicalKey }] : [],
    });
    const result = {
      schema: EXTRACTION_RESULT_VERSION,
      benchmark_id: benchmarkId,
      case_id: caseId,
      input_fingerprint: inputFingerprint,
      extraction_modes: ["synthesis"],
      disposition: "admit",
      disposition_reason: "Topic Index 明确引用且当前 Source 完整可读；以来源确认草稿迁移，不提升为已验证规则。",
      evidence_units: [
        { evidence_id: topicEvidenceId, source_id: topicSource.id, record_id: `${topicSource.id}:1`, locator: entry.file, excerpt: topicExcerpt, excerpt_sha256: sha256(topicExcerpt), attribution_role: "author", actor: "CatPaw Memory", occurred_at: topicSource.importedAt, source_unit_refs: [topicUnitId] },
        { evidence_id: indexEvidenceId, source_id: indexSource.id, record_id: `${indexSource.id}:1`, locator: `Topic Index:${entry.file}`, excerpt: entry.rawRow, excerpt_sha256: sha256(entry.rawRow), attribution_role: "author", actor: "CatPaw Memory", occurred_at: indexSource.importedAt, source_unit_refs: [indexUnitId] },
      ],
      facts: [
        { fact_id: topicFactId, fact_kind: "source_snapshot", statement: content, evidence_ids: [topicEvidenceId], reference_fact_refs: [topicReferenceId], derivation: content === originalContent ? "direct" : "synthesis", temporal_state: "current", importance: "core" },
        { fact_id: routeFactId, fact_kind: "routing_rule", statement: routeStatement, evidence_ids: [indexEvidenceId], reference_fact_refs: [routeReferenceId], derivation: "direct", temporal_state: "current", importance: "supporting" },
      ],
      claims: [{ claim_id: claimId, text: `该卡完整投影 ${entry.file}，并保留 Topic Index 的关键词路由；仅作为来源确认的 advisory。`, claim_kind: "synthesis", fact_refs: [topicFactId, routeFactId], counterevidence_fact_refs: [], reasoning: "Topic Source 提供完整内容，Index Source 提供路由元数据；信任级别不高于来源确认。", temporal_state: "current", support_status: "supported" }],
      coverage: [{ obligation_id: obligationId, disposition: "covered", fact_refs: [topicFactId, routeFactId], reason: "完整内容和路由元数据均进入唯一 synthesis 产品。" }],
      source_unit_dispositions: [
        { unit_id: topicUnitId, disposition: "extracted", evidence_ids: [topicEvidenceId], fact_refs: [topicFactId], reason: "完整保留 Topic 文件。" },
        { unit_id: indexUnitId, disposition: "extracted", evidence_ids: [indexEvidenceId], fact_refs: [routeFactId], reason: "保留 Topic Index 路由行。" },
      ],
      reference_fact_dispositions: [
        { reference_fact_id: topicReferenceId, disposition: content === originalContent ? "preserved" : "paraphrased", fact_refs: [topicFactId], reason: content === originalContent ? "正文逐字进入产品。" : "仅把正文中的字面换行转义符改为 Markdown 等价实体，原始字节仍保留在 Source 与 Evidence。" },
        { reference_fact_id: routeReferenceId, disposition: "preserved", fact_refs: [routeFactId], reason: "路由语义逐字保留。" },
      ],
      products: [{
        product_id: productId,
        product_type: "synthesis",
        title: `Memory Topic：${entry.summary}`,
        canonical_key: entry.canonicalKey,
        operation: existing ? "revise" : "new",
        ...(existing ? { primary_knowledge_id: existing.id } : {}),
        unique_value: "把 CatPaw Memory 注入主题变成 IKB 可检索、可追踪且不提升信任级别的完整知识投影。",
        fact_refs: [topicFactId, routeFactId],
        claim_refs: [claimId],
        question_refs: [questionId],
        consumer_tasks: ["命中 Topic Index 关键词时加载完整背景", "需要来源时回溯到当前 Source"],
        questions_answered: [question],
        boundaries: ["draft + source_confirmed + advisory", "不自动激活为 Principle 或 policy", "高风险执行前回查 Source 或补任务验证"],
        verification_plan: ["核对 Topic 和 Index Source hash", "通过真实 IKB Context Pack 召回该卡"],
        details: {
          topic_file: entry.file,
          keywords: entry.keywords,
          summary: entry.summary,
          topic_source_id: topicSource.id,
          topic_content_sha256: entry.contentHash,
          trust: "source_confirmed_advisory",
          content,
        },
      }],
      question_results: [{ question_id: questionId, disposition: "answered", fact_refs: [topicFactId, routeFactId], product_refs: [productId], reason: "完整 Topic 内容和关键词路由都在产品中。" }],
      unknowns: ["Topic 内部事实尚未逐条经过独立任务验证。"],
      next_triggers: ["Topic 文件内容 hash 变化", "Topic Index 行变化", "真实任务反馈为 partial 或 incorrect"],
    };
    results.push(result);
    byFile.set(entry.file, { caseId, productId, factIds: [topicFactId, routeFactId], question, result });
  }
  const manifest = { schema: EXTRACTION_MANIFEST_VERSION, benchmark_id: benchmarkId, cases: manifestCases };
  const validation = validateExtractionBatch(manifest, results);
  const fidelity = verifyExtractionBatch(manifest, results);
  return { manifest, results, validation, fidelity, byFile };
}

function requireMemoryTopicRun(store: LedgerStore, runId: string, agentId: string, skillId: string) {
  const run = store.requireRun(runId);
  const task = store.requireTask(run.taskId);
  if (run.status !== "running") throw new Error(`Memory Topic ${agentId} Run must be running, got ${run.status}`);
  if (task.scope !== "work") throw new Error(`Memory Topic revision requires a work Task, got ${task.scope}`);
  if (run.agentId !== agentId || !run.skillIds.split(",").includes(skillId)) {
    throw new Error(`Memory Topic revision Run ${run.id} must use ${agentId} with ${skillId}`);
  }
  return run;
}

function memoryTopicRevisionTerminalResult(
  store: LedgerStore,
  curatorRun: ReturnType<LedgerStore["requireRun"]>,
  analystRunId: string,
  offset: number,
  limit: number,
  selected: MemoryTopicMigrationEntry[],
  reportPaths: { json: string; markdown: string },
  disposition: "no_change" | "needs_review",
): MemoryTopicRevisionResult {
  const receipt = writeBatchReceipt(curatorRun.runDir, {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition,
    operation: "qv5_revision",
    analystRunId,
    curatorRunId: curatorRun.id,
    offset,
    limit,
    selected: selected.map(receiptEntry),
  });
  const receiptArtifact = reuseOrCreateArtifact(store, curatorRun.id, "memory-topic-migration-receipt", "Memory Topic QV5 修订回执", receipt);
  return {
    schema: MEMORY_TOPIC_MIGRATION_VERSION,
    disposition,
    analystRunId,
    curatorRunId: curatorRun.id,
    offset,
    limit,
    selected,
    revised: [],
    artifacts: { manifest: null, compilation: null, validation: null, fidelity: null, replacements: [], replacementValidations: [], receipt: receiptArtifact.id },
    reportPaths,
  };
}

function currentSourceFor(sources: SourceRecord[], path: string, contentHash: string): SourceRecord | null {
  return sources.find((source) => source.originalPath === path && source.adapter === "catpaw-memory-local" && source.contentHash === contentHash) ?? null;
}

function memoryTopicCanonicalKey(file: string): string {
  return `work:memory-topic:synthesis:${topicSlug(file)}`;
}

function topicSlug(file: string): string {
  return file.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || sha256(file).slice(0, 12);
}

function splitKeywords(value: string): string[] {
  return [...new Set(value.split(/[\/,，、]/).map((item) => item.trim()).filter(Boolean))].slice(0, 24);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeLiteralNewlineTokensForMarkdown(content: string): string {
  // Fact statements are rendered into Markdown table cells. Once flattened,
  // a source code fence cannot protect literal `\\n` tokens from the prose
  // quality gate. Entities render equivalently; Source/Evidence keep bytes.
  return content.replace(/\\r\\n/g, "&#92;r&#92;n").replace(/\\n/g, "&#92;n");
}

function emptyCounts(): Record<MemoryTopicMigrationStatus, number> {
  return { ready: 0, current: 0, missing_file: 0, missing_current_source: 0, revision_required: 0, ambiguous_knowledge: 0 };
}

function renderReport(report: MemoryTopicMigrationReport): string {
  return [
    "# Memory Topic → IKB Knowledge 迁移状态",
    "",
    `- Schema: \`${report.schema}\``,
    `- Topic Index: \`${report.indexPath}\``,
    `- Index hash: \`${report.indexHash}\``,
    `- Index Source: \`${report.indexSourceId ?? "missing"}\``,
    `- Topics: ${report.topicCount}`,
    `- Ready: ${report.counts.ready}`,
    `- Current: ${report.counts.current}`,
    `- Needs attention: ${report.topicCount - report.counts.ready - report.counts.current}`,
    "",
    "| Topic | Source | Knowledge | Status | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...report.entries.map((entry) => `| ${escapeCell(entry.file)} | ${escapeCell(entry.sourceId ?? "missing")} | ${escapeCell(entry.knowledgeIds.join(", ") || "none")} | ${entry.status} | ${escapeCell(entry.reason)} |`),
    "",
  ].join("\n");
}

function receiptEntry(entry: MemoryTopicMigrationEntry) {
  return { file: entry.file, sourceId: entry.sourceId, contentHash: entry.contentHash, canonicalKey: entry.canonicalKey, knowledgeIds: entry.knowledgeIds, status: entry.status, reason: entry.reason };
}

function writeBatchReceipt(runDir: string, value: unknown): string {
  const hash = sha256(JSON.stringify(value));
  return writeImmutableJson(runDir, `memory-topic-receipt-${hash.slice(0, 16)}.json`, value);
}

function writeImmutableJson(directory: string, filename: string, value: unknown): string {
  return writeImmutableText(directory, filename, `${JSON.stringify(value, null, 2)}\n`);
}

function writeImmutableText(directory: string, filename: string, content: string): string {
  const path = join(directory, filename);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== content) throw new Error(`Immutable migration Artifact collision: ${path}`);
    return path;
  }
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  return path;
}

function reuseOrCreateArtifact(store: LedgerStore, runId: string, kind: string, label: string, path: string) {
  const contentHash = sha256(readFileSync(path));
  return store.listArtifacts({ runId }).find((artifact) => artifact.kind === kind && artifact.contentHash === contentHash)
    ?? store.createArtifact({ runId, kind, label, path });
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
