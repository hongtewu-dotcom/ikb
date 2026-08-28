import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PersonScope = "personal" | "work";
export type PersonAnalysisDisposition = "evidence_only" | "no_change" | "candidates_produced";

export interface PersonEvidenceSnapshotInput {
  personId: string;
  name: string;
  scope: PersonScope;
  generatedAt: string;
  matchedCount: number;
  directMatchedCount: number;
  contextMatchedCount: number;
  directEpisodeKeys: string[];
  independentSourceKeys: string[];
  distinctDates: string[];
  sourceKinds: string[];
  sourceIds: string[];
  attributionCounts: Record<string, number>;
}

export interface PersonEvidenceSnapshot extends PersonEvidenceSnapshotInput {
  schema: "ikb-person-evidence.v1";
  fingerprint: string;
  directEpisodeCount: number;
  independentSourceCount: number;
  distinctDateCount: number;
}

export interface PersonAnalysisCheckpoint {
  schema: "ikb-person-analysis-checkpoint.v1";
  personId: string;
  scope: PersonScope;
  analyzedAt: string;
  evidenceFingerprint: string;
  directEpisodeKeys: string[];
  independentSourceKeys: string[];
  artifactPath: string;
  artifactHash: string;
  disposition: PersonAnalysisDisposition;
  viewsAnalyzed: string[];
  counterevidenceSearch: string;
}

export interface PersonReadinessReport {
  schema: "ikb-person-readiness.v1";
  generatedAt: string;
  scope: PersonScope;
  mode: "weekly" | "incremental";
  summary: { registeredEvidence: number; analysisDue: number; upToDate: number; insufficientEvidence: number; accumulating: number };
  people: Array<{
    personId: string;
    name: string;
    state: "analysis_due" | "up_to_date" | "insufficient_evidence" | "evidence_accumulating";
    directEpisodes: number;
    independentSources: number;
    distinctDates: number;
    newDirectEpisodes: number;
    newIndependentSources: number;
    lastAnalyzedAt: string | null;
    lastDisposition: PersonAnalysisDisposition | null;
    evidenceFingerprint: string;
    knowledgeAdmissionReady: false;
    nextAction: string;
  }>;
}

export function writePersonEvidenceSnapshot(home: string, input: PersonEvidenceSnapshotInput): PersonEvidenceSnapshot {
  const normalized = normalizeSnapshotInput(input);
  const { generatedAt: _generatedAt, ...evidenceIdentity } = normalized;
  const fingerprint = sha256(stableSerialize(evidenceIdentity));
  const snapshot: PersonEvidenceSnapshot = {
    schema: "ikb-person-evidence.v1",
    ...normalized,
    fingerprint,
    directEpisodeCount: normalized.directEpisodeKeys.length,
    independentSourceCount: normalized.independentSourceKeys.length,
    distinctDateCount: normalized.distinctDates.length,
  };
  const directory = evidenceDirectory(home, snapshot.scope, snapshot.personId);
  ensurePrivateDirectory(directory);
  const latestPath = join(directory, "latest.json");
  const previous = existsSync(latestPath) ? readEvidenceFile(latestPath) : null;
  writeJson(latestPath, snapshot);
  if (!previous || previous.fingerprint !== snapshot.fingerprint) {
    const historyPath = join(directory, "history.jsonl");
    assertWritableRegularFile(historyPath);
    appendFileSync(historyPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    chmodSync(historyPath, 0o600);
  }
  return snapshot;
}

export function recordPersonAnalysisCheckpoint(
  home: string,
  personId: string,
  options: { scope?: PersonScope; artifactPath: string; disposition: PersonAnalysisDisposition; viewsAnalyzed?: string[]; counterevidenceSearch?: string },
): PersonAnalysisCheckpoint {
  const scope = options.scope ?? "work";
  const evidence = readLatestEvidence(home, scope, personId);
  if (!evidence) throw new Error(`Person evidence snapshot not found: ${personId}`);
  const artifactPath = resolve(options.artifactPath);
  if (!existsSync(artifactPath) || lstatSync(artifactPath).isSymbolicLink() || !statSync(artifactPath).isFile()) throw new Error(`Person analysis Artifact must be a regular file: ${artifactPath}`);
  const viewsAnalyzed = unique(options.viewsAnalyzed ?? []);
  const counterevidenceSearch = String(options.counterevidenceSearch ?? "").trim();
  if (options.disposition === "candidates_produced" && viewsAnalyzed.length === 0) throw new Error("Person candidates require at least one analyzed view");
  if (options.disposition === "candidates_produced" && !counterevidenceSearch) throw new Error("Person candidates require a counterevidence search range");
  const checkpoint: PersonAnalysisCheckpoint = {
    schema: "ikb-person-analysis-checkpoint.v1",
    personId,
    scope,
    analyzedAt: new Date().toISOString(),
    evidenceFingerprint: evidence.fingerprint,
    directEpisodeKeys: [...evidence.directEpisodeKeys],
    independentSourceKeys: [...evidence.independentSourceKeys],
    artifactPath,
    artifactHash: sha256(readFileSync(artifactPath)),
    disposition: options.disposition,
    viewsAnalyzed,
    counterevidenceSearch,
  };
  const path = analysisPath(home, scope, personId);
  ensurePrivateDirectory(dirname(path));
  writeJson(path, checkpoint);
  return checkpoint;
}

export function buildPersonReadiness(home: string, options: { scope?: PersonScope; mode?: "weekly" | "incremental"; now?: Date } = {}): PersonReadinessReport {
  const scope = options.scope ?? "work";
  const mode = options.mode ?? "weekly";
  const people = listLatestEvidence(home, scope).map((evidence) => {
    const checkpoint = readCheckpoint(home, scope, evidence.personId);
    const newDirectEpisodes = difference(evidence.directEpisodeKeys, checkpoint?.directEpisodeKeys ?? []).length;
    const newIndependentSources = difference(evidence.independentSourceKeys, checkpoint?.independentSourceKeys ?? []).length;
    const structurallyEligible = evidence.directEpisodeCount >= 3 && evidence.independentSourceCount >= 2 && evidence.distinctDateCount >= 2;
    let state: PersonReadinessReport["people"][number]["state"];
    if (!structurallyEligible) state = "insufficient_evidence";
    else if (!checkpoint) state = "analysis_due";
    else if (checkpoint.evidenceFingerprint === evidence.fingerprint) state = "up_to_date";
    else if (mode === "weekly" || (newDirectEpisodes >= 3 && newIndependentSources >= 2)) state = "analysis_due";
    else state = "evidence_accumulating";
    return {
      personId: evidence.personId,
      name: evidence.name,
      state,
      directEpisodes: evidence.directEpisodeCount,
      independentSources: evidence.independentSourceCount,
      distinctDates: evidence.distinctDateCount,
      newDirectEpisodes,
      newIndependentSources,
      lastAnalyzedAt: checkpoint?.analyzedAt ?? null,
      lastDisposition: checkpoint?.disposition ?? null,
      evidenceFingerprint: evidence.fingerprint,
      knowledgeAdmissionReady: false as const,
      nextAction: readinessAction(state),
    };
  });
  const report: PersonReadinessReport = {
    schema: "ikb-person-readiness.v1",
    generatedAt: (options.now ?? new Date()).toISOString(),
    scope,
    mode,
    summary: {
      registeredEvidence: people.length,
      analysisDue: people.filter((person) => person.state === "analysis_due").length,
      upToDate: people.filter((person) => person.state === "up_to_date").length,
      insufficientEvidence: people.filter((person) => person.state === "insufficient_evidence").length,
      accumulating: people.filter((person) => person.state === "evidence_accumulating").length,
    },
    people,
  };
  return report;
}

export function writePersonReadiness(home: string, report: PersonReadinessReport): { jsonPath: string; markdownPath: string } {
  const directory = join(resolve(home), "governance", report.scope, "people");
  ensurePrivateDirectory(directory);
  const jsonPath = join(directory, "readiness.json");
  const markdownPath = join(directory, "readiness.md");
  writeJson(jsonPath, report);
  const rows = report.people.map((person) => `| ${person.name}（${person.personId}） | ${person.state} | ${person.directEpisodes} | ${person.independentSources} | ${person.distinctDates} | +${person.newDirectEpisodes} / +${person.newIndependentSources} | ${person.nextAction} |`);
  const markdown = [
    "# 人物周期分析就绪账",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 模式：${report.mode}`,
    `- 待语义分析：${report.summary.analysisDue}`,
    "- 说明：这里的 Episode/来源/日期只证明材料数量达到分析门槛，不证明某个稳定人物结论成立。",
    "- 准入：语义聚类、身份复核、时间变化和反证搜索完成前，knowledgeAdmissionReady 固定为 false。",
    "",
    "| 人物 | 状态 | 结构 Episode | 独立来源 | 日期 | 相对上次 +Episode/+来源 | 下一步 |",
    "|---|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(markdownPath, markdown, { mode: 0o600 });
  chmodSync(markdownPath, 0o600);
  return { jsonPath, markdownPath };
}

function normalizeSnapshotInput(input: PersonEvidenceSnapshotInput): PersonEvidenceSnapshotInput {
  if (!input.personId.trim()) throw new Error("Person evidence needs personId");
  if (input.scope !== "personal" && input.scope !== "work") throw new Error(`Invalid person evidence scope: ${input.scope}`);
  return {
    ...input,
    personId: input.personId.trim(),
    name: input.name.trim() || input.personId.trim(),
    directEpisodeKeys: unique(input.directEpisodeKeys),
    independentSourceKeys: unique(input.independentSourceKeys),
    distinctDates: unique(input.distinctDates),
    sourceKinds: unique(input.sourceKinds),
    sourceIds: unique(input.sourceIds),
    attributionCounts: Object.fromEntries(Object.entries(input.attributionCounts).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function listLatestEvidence(home: string, scope: PersonScope): PersonEvidenceSnapshot[] {
  const root = join(resolve(home), "governance", scope, "people", "evidence");
  if (!existsSync(root)) return [];
  assertDirectory(root);
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).flatMap((entry) => {
    const path = join(root, entry.name, "latest.json");
    return existsSync(path) ? [readEvidenceFile(path)] : [];
  }).sort((left, right) => left.personId.localeCompare(right.personId));
}

function readLatestEvidence(home: string, scope: PersonScope, personId: string): PersonEvidenceSnapshot | null {
  const path = join(evidenceDirectory(home, scope, personId), "latest.json");
  return existsSync(path) ? readEvidenceFile(path) : null;
}

function readEvidenceFile(path: string): PersonEvidenceSnapshot {
  const value = readJson<PersonEvidenceSnapshot>(path);
  if (value.schema !== "ikb-person-evidence.v1" || !value.personId || !Array.isArray(value.directEpisodeKeys)) throw new Error(`Invalid person evidence snapshot: ${path}`);
  return value;
}

function readCheckpoint(home: string, scope: PersonScope, personId: string): PersonAnalysisCheckpoint | null {
  const path = analysisPath(home, scope, personId);
  if (!existsSync(path)) return null;
  const value = readJson<PersonAnalysisCheckpoint>(path);
  if (value.schema !== "ikb-person-analysis-checkpoint.v1" || value.personId !== personId) throw new Error(`Invalid person analysis checkpoint: ${path}`);
  return value;
}

function readinessAction(state: PersonReadinessReport["people"][number]["state"]): string {
  if (state === "analysis_due") return "读取直接证据做多视角语义聚类，并完成时间变化与反证搜索；结果先写 Artifact";
  if (state === "up_to_date") return "证据未变化，不重复蒸馏";
  if (state === "evidence_accumulating") return "继续积累；未达到提前重跑的 3 Episode / 2 来源增量门槛";
  return "保持 Evidence-only；当前数量不足以做稳定观察";
}

function evidenceDirectory(home: string, scope: PersonScope, personId: string): string {
  return join(resolve(home), "governance", scope, "people", "evidence", personId);
}

function analysisPath(home: string, scope: PersonScope, personId: string): string {
  return join(resolve(home), "governance", scope, "people", "analysis", `${personId}.json`);
}

function writeJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson<T>(path: string): T {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Person governance file must be regular: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`Person governance directory must be real: ${path}`);
  chmodSync(path, 0o700);
}

function assertDirectory(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) throw new Error(`Person governance directory must be real: ${path}`);
}

function assertWritableRegularFile(path: string): void {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !statSync(path).isFile())) throw new Error(`Person governance file must be regular: ${path}`);
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))].sort(); }
function difference(values: string[], previous: string[]): string[] { const known = new Set(previous); return values.filter((value) => !known.has(value)); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
