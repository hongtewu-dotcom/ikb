import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCandidates } from "./candidates.ts";
import { discoverHistoryCandidates, type HistoryCandidate } from "./history.ts";
import { inspectIncrementalState, type IncrementalState } from "./incremental.ts";
import { listSources, normalizeSourceScope } from "./source.ts";
import { listSourceTargets, resolveTargetPath, type SourceTarget } from "./source-targets.ts";
import type { Candidate, SourceRecord } from "./types.ts";
import { resolvePeopleRoot } from "./layout.ts";

export type { SourceTarget } from "./source-targets.ts";

export interface SourceCoverageOptions {
  scope?: string;
  now?: Date;
  historyCandidates?: HistoryCandidate[];
  sources?: SourceRecord[];
  candidates?: Candidate[];
  incrementalStates?: IncrementalState[];
  targets?: SourceTarget[];
}

export interface SourceCoverageReport {
  schema: "ikb-source-coverage.v1";
  generatedAt: string;
  scope: "personal" | "work";
  histories: {
    discovered: number;
    covered: number;
    empty: number;
    backlog: number;
    byAdapter: Array<{ adapter: string; discovered: number; covered: number; empty: number; backlog: number }>;
    backlogItems: Array<Pick<HistoryCandidate, "id" | "adapter" | "path" | "size" | "modifiedAt">>;
  };
  sources: {
    total: number;
    records: number;
    byAdapter: Array<{ adapter: string; sources: number; records: number; lastImportedAt: string | null }>;
  };
  citadel: { total: number; byStatus: Record<string, number>; pending: number };
  catpawMemory: { snapshotPresent: boolean; retrievedAt: string | null; totalCount: number | null; ageHours: number | null; credentialAvailable: boolean };
  targets: Array<SourceTarget & { matchedSources: number; records: number; discoveredFiles?: number; lastImportedAt: string | null; coverageState: "covered" | "empty" | "backlog" | "federated" }>;
  keyPeople: { registered: number; withLocalEvidence: number; missingEvidenceIds: string[] };
  blockers: Array<{ code: string; detail: string }>;
  inventoryComplete: boolean;
  stockComplete: boolean;
}

export function buildSourceCoverage(home: string, options: SourceCoverageOptions = {}): SourceCoverageReport {
  const scope = normalizeSourceScope(options.scope, "work");
  const now = options.now ?? new Date();
  const histories = options.historyCandidates ?? discoverHistoryCandidates("all", { scope, limit: 0 });
  const sources = (options.sources ?? listSources(home, { includeQuarantined: true })).filter((source) => source.scope === scope);
  const candidates = (options.candidates ?? listCandidates(home, scope)).filter((candidate) => candidate.scope === scope);
  const states = (options.incrementalStates ?? inspectIncrementalState(home).entries).filter((state) => state.originalPath && state.logicalKey.startsWith("history:"));
  const targets = options.targets ?? listSourceTargets(home, scope);
  const sourcePaths = new Set(sources.filter((source) => ["claude", "codex", "desk"].includes(source.adapter ?? "") && !source.includeTools).map((source) => source.originalPath));
  const latestStateByPath = new Map<string, IncrementalState>();
  for (const state of states) {
    const previous = latestStateByPath.get(state.originalPath);
    if (!previous || previous.scannedAt < state.scannedAt) latestStateByPath.set(state.originalPath, state);
  }
  const historyRows = histories.map((candidate) => {
    if (sourcePaths.has(candidate.path)) return { candidate, state: "covered" as const };
    const state = latestStateByPath.get(candidate.path);
    if (state?.reason === "no-records" && state.sourceId === null) return { candidate, state: "empty" as const };
    return { candidate, state: "backlog" as const };
  });
  const adapterNames = [...new Set(historyRows.map((row) => row.candidate.adapter))].sort();
  const historyByAdapter = adapterNames.map((adapter) => {
    const rows = historyRows.filter((row) => row.candidate.adapter === adapter);
    return {
      adapter,
      discovered: rows.length,
      covered: rows.filter((row) => row.state === "covered").length,
      empty: rows.filter((row) => row.state === "empty").length,
      backlog: rows.filter((row) => row.state === "backlog").length,
    };
  });
  const adapterGroups = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    const adapter = source.adapter ?? "direct";
    adapterGroups.set(adapter, [...(adapterGroups.get(adapter) ?? []), source]);
  }
  const sourceByAdapter = [...adapterGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([adapter, rows]) => ({
    adapter,
    sources: rows.length,
    records: rows.reduce((sum, source) => sum + source.recordCount, 0),
    lastImportedAt: rows.map((source) => source.importedAt).sort().at(-1) ?? null,
  }));
  const citadelCandidates = candidates.filter((candidate) => candidate.kind === "citadel_document" && candidate.locator.adapter === "citadel");
  const citadelByStatus = countBy(citadelCandidates.map((candidate) => candidate.status));
  const targetCoverage = targets.filter((target) => target.enabled && target.scope === scope).map((target) => summarizeTarget(target, sources));
  const catpawMemory = readCatpawManifest(home, now);
  const keyPeople = readKeyPeopleCoverage(home, scope, sources);
  const backlogItems = historyRows.filter((row) => row.state === "backlog").map(({ candidate }) => ({ id: candidate.id, adapter: candidate.adapter, path: candidate.path, size: candidate.size, modifiedAt: candidate.modifiedAt }));
  const blockers: SourceCoverageReport["blockers"] = [];
  if (backlogItems.length > 0) blockers.push({ code: "agent_history_backlog", detail: `${backlogItems.length} 个本地 Agent 会话尚未分类或导入` });
  if (!catpawMemory.snapshotPresent) blockers.push({ code: "catpaw_snapshot_missing", detail: "CatPaw 远端记忆没有本地快照" });
  else if ((catpawMemory.ageHours ?? 0) > 48) blockers.push({ code: "catpaw_snapshot_stale", detail: `CatPaw 远端记忆快照已超过 48 小时（${Math.floor(catpawMemory.ageHours ?? 0)} 小时）` });
  for (const target of targetCoverage.filter((target) => target.coverageState === "backlog")) blockers.push({ code: `target_backlog:${target.id}`, detail: `${target.name ?? target.id} 尚无可用本地 Source` });
  if (keyPeople.missingEvidenceIds.length > 0) blockers.push({ code: "key_people_evidence_missing", detail: `${keyPeople.missingEvidenceIds.length} 个关键人物尚无本地人物证据` });
  const registryGaps = targetCoverage.filter((target) => target.status === "needs_explicit_path_registry");
  if (registryGaps.length > 0) blockers.push({ code: "source_registry_incomplete", detail: "重要文档与评论仍需维护显式路径清单" });
  const inventoryComplete = registryGaps.length === 0;
  return {
    schema: "ikb-source-coverage.v1",
    generatedAt: now.toISOString(),
    scope,
    histories: {
      discovered: historyRows.length,
      covered: historyRows.filter((row) => row.state === "covered").length,
      empty: historyRows.filter((row) => row.state === "empty").length,
      backlog: backlogItems.length,
      byAdapter: historyByAdapter,
      backlogItems,
    },
    sources: { total: sources.length, records: sources.reduce((sum, source) => sum + source.recordCount, 0), byAdapter: sourceByAdapter },
    citadel: { total: citadelCandidates.length, byStatus: citadelByStatus, pending: (citadelByStatus.discovered ?? 0) + (citadelByStatus.queued ?? 0) + (citadelByStatus.blocked ?? 0) },
    catpawMemory,
    targets: targetCoverage,
    keyPeople,
    blockers,
    inventoryComplete,
    stockComplete: blockers.length === 0,
  };
}

export function writeSourceCoverage(home: string, report: SourceCoverageReport): { jsonPath: string; markdownPath: string } {
  const directory = join(resolve(home), "governance", report.scope, "sources");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const jsonPath = join(directory, "coverage.json");
  const markdownPath = join(directory, "coverage.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdownPath, renderSourceCoverage(report), { mode: 0o600 });
  chmodSync(jsonPath, 0o600);
  chmodSync(markdownPath, 0o600);
  return { jsonPath, markdownPath };
}

export function renderSourceCoverage(report: SourceCoverageReport): string {
  const lines = [
    "# 来源覆盖账",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 范围：${report.scope}`,
    `- 已发现 Agent 会话：${report.histories.discovered}`,
    `- 已有 Source：${report.histories.covered}`,
    `- 无可见消息：${report.histories.empty}`,
    `- Agent 会话欠账：${report.histories.backlog}`,
    `- 学城候选欠账：${report.citadel.pending}`,
    "",
    "## Agent 会话",
    "",
    "| 适配器 | 发现 | 已覆盖 | 无可见消息 | 欠账 |",
    "|---|---:|---:|---:|---:|",
    ...report.histories.byAdapter.map((row) => `| ${row.adapter} | ${row.discovered} | ${row.covered} | ${row.empty} | ${row.backlog} |`),
    "",
    "## 外部与人工来源",
    "",
    "| 来源 | 状态 | Source | Records | 最后导入 |",
    "|---|---|---:|---:|---|",
    ...report.targets.map((target) => `| ${target.name ?? target.id} | ${target.coverageState} | ${target.matchedSources} | ${target.records} | ${target.lastImportedAt ?? "—"} |`),
    "",
    "## 阻断与欠账",
    "",
    ...(report.blockers.length > 0 ? report.blockers.map((blocker) => `- ${blocker.code}：${blocker.detail}`) : ["- 无"]),
    "",
  ];
  return lines.join("\n");
}

function summarizeTarget(target: SourceTarget, sources: SourceRecord[]): SourceTarget & { matchedSources: number; records: number; discoveredFiles?: number; lastImportedAt: string | null; coverageState: "covered" | "empty" | "backlog" | "federated" } {
  if (target.kind === "query_time_federation") return { ...target, matchedSources: 0, records: 0, lastImportedAt: null, coverageState: "federated" };
  const markers = [target.locator?.gid, target.locator?.uid, target.locator?.mis, target.locator?.path, target.name].filter((value): value is string => Boolean(value));
  const matches = sources.filter((source) => {
    if (target.adapter === "citadel") return source.adapter === "citadel";
    if (target.adapter === "catpaw-memory") return source.adapter === "catpaw-memory";
    if (target.adapter === "local-document") return source.adapter === "local-document";
    if (target.adapter === "elephant") return ["elephant", "elephant-browser"].includes(source.adapter ?? "") && markers.some((marker) => `${source.title}\n${source.originalPath}`.includes(marker));
    return source.adapter === target.adapter && (markers.length === 0 || markers.some((marker) => `${source.title}\n${source.originalPath}`.includes(marker)));
  });
  const localFileCount = target.kind === "local_directory" ? countTargetFiles(target) : undefined;
  const coverageState = matches.length > 0
    ? "covered" as const
    : target.kind === "local_directory" && localFileCount === 0
      ? "empty" as const
      : "backlog" as const;
  return {
    ...target,
    matchedSources: matches.length,
    records: matches.reduce((sum, source) => sum + source.recordCount, 0),
    ...(localFileCount !== undefined ? { discoveredFiles: localFileCount } : {}),
    lastImportedAt: matches.map((source) => source.importedAt).sort().at(-1) ?? null,
    coverageState,
  };
}

function countTargetFiles(target: SourceTarget): number | null {
  const pathValue = target.locator?.path;
  if (!pathValue) return null;
  const root = resolveTargetPath(pathValue);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) return null;
  const extensions = new Set((target.extensions?.length ? target.extensions : ["md"])
    .map((extension) => extension.toLowerCase().replace(/^\.?/, ".")));
  const exclude = target.exclude ?? [];
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const relativePath = path.slice(root.length + 1);
      if (exclude.some((marker) => relativePath.split(/[\\/]/).includes(marker) || relativePath.includes(marker))) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extensions.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) count += 1;
    }
  };
  visit(root);
  return count;
}

function readCatpawManifest(home: string, now: Date): SourceCoverageReport["catpawMemory"] {
  const path = join(resolve(home), "staging", "catpaw-memory", "latest.manifest.json");
  if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) return { snapshotPresent: false, retrievedAt: null, totalCount: null, ageHours: null, credentialAvailable: Boolean(process.env.IKB_CATPAW_MEMORY_PLUGIN_AUTH) };
  const value = JSON.parse(readFileSync(path, "utf8")) as { retrievedAt?: string; totalCount?: number };
  const retrievedAt = typeof value.retrievedAt === "string" ? value.retrievedAt : null;
  const timestamp = retrievedAt ? Date.parse(retrievedAt) : Number.NaN;
  return {
    snapshotPresent: true,
    retrievedAt,
    totalCount: Number.isInteger(value.totalCount) ? Number(value.totalCount) : null,
    ageHours: Number.isFinite(timestamp) ? Math.max(0, (now.getTime() - timestamp) / 3_600_000) : null,
    credentialAvailable: Boolean(process.env.IKB_CATPAW_MEMORY_PLUGIN_AUTH),
  };
}

function readKeyPeopleCoverage(home: string, scope: "personal" | "work", sources: SourceRecord[]): SourceCoverageReport["keyPeople"] {
  const path = join(resolve(home), "entities", "people", "key-people.json");
  if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) return { registered: 0, withLocalEvidence: 0, missingEvidenceIds: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as { people?: Array<{ id?: string; mis?: string; uid?: string; name?: string; enabled?: boolean }> };
  const people = (value.people ?? []).filter((person) => person.enabled !== false && person.id);
  const missingEvidenceIds = people.filter((person) => {
    const dossierPath = join(resolvePeopleRoot(home, scope), String(person.id), "index.md");
    if (existsSync(dossierPath) && statSync(dossierPath).isFile() && !lstatSync(dossierPath).isSymbolicLink()) {
      const directEvidence = Number(readFileSync(dossierPath, "utf8").match(/^- Direct evidence:\s*(\d+)$/m)?.[1] ?? "0");
      if (directEvidence > 0) return false;
    }
    const markers = [person.id, person.mis, person.uid, person.name].filter((marker): marker is string => Boolean(marker));
    return !sources.some((source) => ["elephant", "elephant-browser", "citadel"].includes(source.adapter ?? "") && markers.some((marker) => `${source.title}\n${source.originalPath}`.includes(marker)));
  }).map((person) => String(person.id));
  return { registered: people.length, withLocalEvidence: people.length - missingEvidenceIds.length, missingEvidenceIds };
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
