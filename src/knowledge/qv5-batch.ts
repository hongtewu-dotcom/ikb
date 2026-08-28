import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { LedgerStore } from "../store.ts";
import { findKnowledge } from "./records.ts";
import { applyReviewedQv5KnowledgeRevision, preflightReviewedQv5KnowledgeRevision } from "./qv5-revision.ts";

export const QV5_BATCH_PLAN_VERSION = "ikb-qv5-revision-batch-plan.v1";
export const QV5_BATCH_STATE_VERSION = "ikb-qv5-revision-batch-state.v1";

export interface Qv5KnowledgeRevisionBatchEntry {
  knowledgeId: string;
  expectedRevision: number;
  expectedKnowledgeHash: string;
  replacementArtifactId: string;
  validationArtifactId: string;
  manifestArtifactId: string;
  compilationArtifactId: string;
  fidelityArtifactId: string;
}

export interface Qv5KnowledgeRevisionBatchPlan {
  schema: typeof QV5_BATCH_PLAN_VERSION;
  entries: Qv5KnowledgeRevisionBatchEntry[];
}

export interface Qv5KnowledgeRevisionBatchStateEntry {
  knowledgeId: string;
  status: "pending" | "applied" | "blocked";
  attempt: number;
  error: string | null;
  journal: string | null;
}

export interface Qv5KnowledgeRevisionBatchState {
  schema: typeof QV5_BATCH_STATE_VERSION;
  batchId: string;
  planHash: string;
  createdAt: string;
  updatedAt: string;
  entries: Qv5KnowledgeRevisionBatchStateEntry[];
}

export interface Qv5KnowledgeRevisionBatchResult {
  batchId: string;
  dryRun: boolean;
  statePath: string;
  entries: Qv5KnowledgeRevisionBatchStateEntry[];
}

export function parseQv5KnowledgeRevisionBatchPlan(value: unknown): Qv5KnowledgeRevisionBatchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QV5 batch plan must be a JSON object");
  const plan = value as Record<string, unknown>;
  if (plan.schema !== QV5_BATCH_PLAN_VERSION || !Array.isArray(plan.entries) || plan.entries.length === 0) throw new Error(`QV5 batch plan schema must be ${QV5_BATCH_PLAN_VERSION} with at least one entry`);
  const seen = new Set<string>();
  const entries = plan.entries.map((value, index) => parseEntry(value, index, seen));
  return { schema: QV5_BATCH_PLAN_VERSION, entries };
}

export function applyQv5KnowledgeRevisionBatch(home: string, store: LedgerStore, planInput: Qv5KnowledgeRevisionBatchPlan, options: { dryRun?: boolean; resume?: boolean; limit?: number } = {}): Qv5KnowledgeRevisionBatchResult {
  const plan = parseQv5KnowledgeRevisionBatchPlan(planInput);
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)) throw new Error("QV5 batch limit must be an integer from 1 to 500");
  const normalizedPlan = stableJson(plan);
  const planHash = sha256(normalizedPlan);
  const batchId = `qv5-batch-${planHash.slice(0, 16)}`;
  const statePath = resolveBatchStatePath(home, batchId);
  const selected = plan.entries.slice(0, options.limit ?? plan.entries.length);
  if (options.dryRun) {
    return { batchId, dryRun: true, statePath, entries: selected.map((entry) => preflight(entry, home, store)) };
  }
  let state = readState(statePath, batchId, planHash, plan.entries) ?? newState(batchId, planHash, plan.entries);
  let changed = !existsSync(statePath);
  for (const entry of selected) {
    const item = state.entries.find((candidate) => candidate.knowledgeId === entry.knowledgeId)!;
    if (item.status === "applied") continue;
    if (options.resume && item.status !== "pending" && item.status !== "blocked") continue;
    item.attempt += 1;
    const checked = preflight(entry, home, store);
    if (checked.status === "blocked") {
      item.status = "blocked"; item.error = checked.error; item.journal = null; changed = true; continue;
    }
    try {
      const applied = applyReviewedQv5KnowledgeRevision(home, store, artifactInput(entry));
      item.status = "applied";
      item.error = null;
      item.journal = applied.journal.id;
    } catch (error) {
      item.status = "blocked";
      item.error = errorMessage(error);
      item.journal = null;
    }
    changed = true;
  }
  if (changed) { state.updatedAt = new Date().toISOString(); writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`); }
  return { batchId, dryRun: false, statePath, entries: state.entries };
}

function preflight(entry: Qv5KnowledgeRevisionBatchEntry, home: string, store: LedgerStore): Qv5KnowledgeRevisionBatchStateEntry {
  try {
    const target = findKnowledge(home, entry.knowledgeId);
    if (!target) throw new Error(`Knowledge not found: ${entry.knowledgeId}`);
    const bytes = readRegularFile(target.path, `Knowledge ${target.id}`);
    const targetMatchesPlan = target.revision === entry.expectedRevision && sha256(bytes) === entry.expectedKnowledgeHash;
    const artifacts = [
      [entry.replacementArtifactId, "knowledge-qv5-replacement-draft"], [entry.validationArtifactId, "knowledge-qv5-validation"],
      [entry.manifestArtifactId, "knowledge-extraction-manifest"], [entry.compilationArtifactId, "knowledge-extraction-result"],
      [entry.fidelityArtifactId, "knowledge-extraction-fidelity"],
    ] as const;
    const artifactHashes: string[] = [];
    for (const [id, kind] of artifacts) {
      const artifact = store.getArtifact(id);
      if (!artifact || artifact.kind !== kind || !artifact.contentHash) throw new Error(`Required immutable Artifact is missing or invalid: ${id}`);
      if (sha256(readRegularFile(artifact.path, `Artifact ${id}`)) !== artifact.contentHash) throw new Error(`Artifact bytes changed: ${id}`);
      artifactHashes.push(artifact.contentHash);
    }
    preflightReviewedQv5KnowledgeRevision(home, store, artifactInput(entry));
    if (!targetMatchesPlan) {
      const revisionId = `qv5-revision-${sha256([target.id, ...artifactHashes].join("|")).slice(0, 16)}`;
      const journalPath = join(resolve(home), "revisions", "knowledge", target.scope, revisionId, "journal.json");
      if (!existsSync(journalPath)) {
        if (target.revision !== entry.expectedRevision) throw new Error(`Knowledge ${target.id} revision does not match plan`);
        throw new Error(`Knowledge ${target.id} bytes do not match plan`);
      }
    }
    return { knowledgeId: entry.knowledgeId, status: "pending", attempt: 0, error: null, journal: null };
  } catch (error) {
    return { knowledgeId: entry.knowledgeId, status: "blocked", attempt: 0, error: errorMessage(error), journal: null };
  }
}

function parseEntry(value: unknown, index: number, seen: Set<string>): Qv5KnowledgeRevisionBatchEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`QV5 batch entry ${index} must be an object`);
  const entry = value as Record<string, unknown>;
  const names = ["knowledgeId", "expectedKnowledgeHash", "replacementArtifactId", "validationArtifactId", "manifestArtifactId", "compilationArtifactId", "fidelityArtifactId"] as const;
  for (const name of names) if (typeof entry[name] !== "string" || !entry[name]) throw new Error(`QV5 batch entry ${index} requires ${name}`);
  if (!Number.isInteger(entry.expectedRevision) || (entry.expectedRevision as number) < 1) throw new Error(`QV5 batch entry ${index} requires a positive expectedRevision`);
  if (!/^[a-f0-9]{64}$/.test(String(entry.expectedKnowledgeHash))) throw new Error(`QV5 batch entry ${index} expectedKnowledgeHash must be sha256 hex`);
  if (seen.has(String(entry.knowledgeId))) throw new Error(`QV5 batch plan duplicates knowledgeId: ${entry.knowledgeId}`);
  seen.add(String(entry.knowledgeId));
  return Object.fromEntries([...names.map((name) => [name, entry[name]]), ["expectedRevision", entry.expectedRevision]]) as unknown as Qv5KnowledgeRevisionBatchEntry;
}
function artifactInput(entry: Qv5KnowledgeRevisionBatchEntry) { return { knowledgeId: entry.knowledgeId, replacementArtifactId: entry.replacementArtifactId, validationArtifactId: entry.validationArtifactId, manifestArtifactId: entry.manifestArtifactId, compilationArtifactId: entry.compilationArtifactId, fidelityArtifactId: entry.fidelityArtifactId }; }
function newState(batchId: string, planHash: string, entries: Qv5KnowledgeRevisionBatchEntry[]): Qv5KnowledgeRevisionBatchState { const now = new Date().toISOString(); return { schema: QV5_BATCH_STATE_VERSION, batchId, planHash, createdAt: now, updatedAt: now, entries: entries.map((entry) => ({ knowledgeId: entry.knowledgeId, status: "pending", attempt: 0, error: null, journal: null })) }; }
function readState(path: string, batchId: string, planHash: string, planEntries: Qv5KnowledgeRevisionBatchEntry[]): Qv5KnowledgeRevisionBatchState | null { if (!existsSync(path)) return null; const state = JSON.parse(readRegularFile(path, "QV5 batch state")) as Qv5KnowledgeRevisionBatchState; if (state.schema !== QV5_BATCH_STATE_VERSION || state.batchId !== batchId || state.planHash !== planHash || !Array.isArray(state.entries) || state.entries.length !== planEntries.length || state.entries.some((entry, index) => entry.knowledgeId !== planEntries[index].knowledgeId || !["pending", "applied", "blocked"].includes(entry.status) || !Number.isInteger(entry.attempt) || entry.attempt < 0 || typeof entry.error !== "string" && entry.error !== null || typeof entry.journal !== "string" && entry.journal !== null)) throw new Error(`Invalid QV5 batch state: ${path}`); return state; }
function resolveBatchStatePath(home: string, batchId: string): string { const root = resolve(home); const path = resolve(root, "revisions", "knowledge", "batches", batchId, "state.json"); if (relative(root, path).startsWith("..")) throw new Error("QV5 batch state escapes IKB home"); return path; }
function readRegularFile(path: string, label: string): string { if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`${label} must be a regular file: ${path}`); return readFileSync(path, "utf8"); }
function writeAtomic(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`; writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); chmodSync(path, 0o600); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
