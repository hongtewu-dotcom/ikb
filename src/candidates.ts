import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { findSource, listSources, readSourceRecords } from "./source.ts";
import type { Candidate, CandidateKind, CandidateLocator, CandidateOrigin, CandidateStatus, SourceMessage, SourceRecord } from "./types.ts";

const CANDIDATE_KINDS: readonly CandidateKind[] = ["citadel_document", "knowledge", "person", "external", "pattern"];
const CANDIDATE_STATUSES: readonly CandidateStatus[] = ["discovered", "queued", "ingested", "rejected", "blocked"];
const STATUS_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  discovered: ["queued", "rejected", "blocked"],
  queued: ["discovered", "ingested", "rejected", "blocked"],
  ingested: [],
  rejected: [],
  blocked: ["queued", "rejected"],
};

export interface CandidateInput {
  kind: CandidateKind;
  title: string;
  scope?: string;
  sensitivity?: string;
  locator: CandidateLocator;
  origin?: Partial<CandidateOrigin>;
  status?: CandidateStatus;
  nextAction?: string | null;
  reason?: string | null;
  resolution?: Candidate["resolution"];
}

export interface CandidateAddResult {
  candidate: Candidate;
  created: boolean;
  changed: boolean;
}

export interface CandidateUpdateInput {
  status?: CandidateStatus;
  nextAction?: string | null;
  reason?: string | null;
  resolution?: Candidate["resolution"];
}

export interface CandidateDiscoveryResult {
  sourceId: string;
  sourceScope: "personal" | "work";
  scannedRecords: number;
  foundLocators: number;
  created: number;
  updated: number;
  createdIds: string[];
  updatedIds: string[];
  candidates: Candidate[];
}

export interface CandidatePoolIssue {
  scope: string;
  path: string;
  line: number;
  code: "pool_not_file" | "pool_malformed" | "candidate_malformed" | "candidate_scope_mismatch" | "candidate_duplicate_revision";
  detail: string;
}

export function candidatePoolPath(home: string, scope: string): string {
  const normalizedScope = normalizeScope(scope);
  return join(resolve(home), "governance", normalizedScope, "candidates", "pool.jsonl");
}

export function ensureCandidateLayout(home: string, scope?: string): void {
  const scopes = scope ? [normalizeScope(scope)] : ["personal", "work"];
  for (const currentScope of scopes) {
    const directory = join(resolve(home), "governance", currentScope, "candidates");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Candidate directory must be a real directory: ${directory}`);
    chmodSync(directory, 0o700);
    const path = candidatePoolPath(home, currentScope);
    if (!existsSync(path)) writeFileSyncPrivate(path, "");
    else if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`Candidate pool must be a regular file: ${path}`);
    chmodSync(path, 0o600);
  }
}

export function listCandidates(home: string, scope?: string): Candidate[] {
  const scopes = scope ? [normalizeScope(scope)] : ["personal", "work"];
  const latest = new Map<string, Candidate>();
  for (const currentScope of scopes) {
    const path = candidatePoolPath(home, currentScope);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid candidate at ${path}:${index + 1}: ${(error as Error).message}`);
      }
      const candidate = parseCandidate(value, path, index + 1);
      const previous = latest.get(candidate.id);
      if (previous && previous.revision >= candidate.revision) return;
      latest.set(candidate.id, candidate);
    });
  }
  return [...latest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function findCandidate(home: string, id: string): Candidate | null {
  return listCandidates(home).find((candidate) => candidate.id === id) ?? null;
}

export function requireCandidate(home: string, id: string): Candidate {
  const candidate = findCandidate(home, id);
  if (!candidate) throw new Error(`Candidate not found: ${id}`);
  return candidate;
}

export function addCandidate(home: string, input: CandidateInput): CandidateAddResult {
  const normalized = normalizeInput(input);
  const cache = new Map(listCandidates(home, normalized.scope).map((candidate) => [candidate.fingerprint, candidate] as const));
  return addCandidateNormalized(home, normalized, cache);
}

function addCandidateNormalized(home: string, normalized: ReturnType<typeof normalizeInput>, cache: Map<string, Candidate>): CandidateAddResult {
  const fingerprint = candidateFingerprint(normalized.kind, normalized.scope, normalized.locator);
  const existing = cache.get(fingerprint);
  if (existing) {
    const merged = mergeCandidate(existing, normalized);
    if (!merged.changed) return { candidate: existing, created: false, changed: false };
    appendCandidateSnapshot(home, merged.candidate);
    cache.set(fingerprint, merged.candidate);
    return { candidate: merged.candidate, created: false, changed: true };
  }
  const timestamp = new Date().toISOString();
  const candidate: Candidate = {
    id: `cand-${randomUUID().slice(0, 12)}`,
    fingerprint,
    kind: normalized.kind,
    status: normalized.status,
    title: normalized.title,
    scope: normalized.scope,
    sensitivity: normalized.sensitivity,
    locator: normalized.locator,
    origin: normalized.origin,
    resolution: normalized.resolution,
    nextAction: normalized.nextAction,
    reason: normalized.reason,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  appendCandidateSnapshot(home, candidate);
  cache.set(fingerprint, candidate);
  return { candidate, created: true, changed: true };
}

export function updateCandidate(home: string, id: string, input: CandidateUpdateInput): Candidate {
  const current = requireCandidate(home, id);
  const nextStatus = input.status ?? current.status;
  if (nextStatus === "ingested" && (!input.resolution || input.resolution.sourceIds.length === 0) && !current.resolution) {
    throw new Error(`Candidate ${id} requires resolved Source IDs before it can become ingested`);
  }
  if (nextStatus !== current.status && !STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(`Candidate ${id} cannot move from ${current.status} to ${nextStatus}`);
  }
  const updated: Candidate = {
    ...current,
    status: nextStatus,
    nextAction: input.nextAction === undefined ? current.nextAction : input.nextAction,
    reason: input.reason === undefined ? current.reason : input.reason,
    resolution: input.resolution === undefined ? current.resolution : input.resolution,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  appendCandidateSnapshot(home, updated);
  return updated;
}

export function discoverCitadelCandidates(home: string, sourceId: string, options: { status?: CandidateStatus; sensitivity?: string; cache?: Map<string, Candidate>; existingSources?: SourceRecord[]; source?: SourceRecord } = {}): CandidateDiscoveryResult {
  const source = options.source ?? findSource(home, sourceId);
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  if (options.status && !["discovered", "queued"].includes(options.status)) throw new Error("Candidate discovery status must be discovered or queued");
  const records = readSourceRecords(home, sourceId, { verifyRaw: false, source });
  const locators = new Map<string, { locator: CandidateLocator; title: string; record: SourceMessage }>();
  for (const record of records) {
    for (const found of extractCitadelLocators(record)) {
      const key = found.locator.contentId ?? found.locator.url ?? "";
      if (!key || locators.has(key)) continue;
      locators.set(key, { ...found, record });
    }
  }
  const existingSources = options.existingSources ?? listSources(home).filter((candidate) => candidate.adapter === "citadel");
  const cache = options.cache ?? new Map(listCandidates(home, source.scope).map((candidate) => [candidate.fingerprint, candidate] as const));
  const candidates: Candidate[] = [];
  let created = 0;
  let updated = 0;
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  for (const found of locators.values()) {
    const resolvedSources = existingSources.filter((candidate) => sourceContainsCitadelId(candidate, found.locator.contentId));
    const result = addCandidateNormalized(home, normalizeInput({
      kind: "citadel_document",
      title: found.title || source.title.replace(/\s*-\s*评论$/, ""),
      scope: source.scope,
      sensitivity: options.sensitivity ?? source.sensitivity,
      locator: found.locator,
      status: resolvedSources.length > 0 ? "ingested" : options.status ?? "discovered",
      origin: { sourceIds: [source.id], recordIds: [found.record.id] },
      resolution: resolvedSources.length > 0 ? {
        sourceIds: resolvedSources.map((item) => item.id),
        commentSourceId: resolvedSources.find((item) => item.kind === "review_comment")?.id,
        ingestedAt: resolvedSources.map((item) => item.importedAt).sort().at(-1) ?? new Date().toISOString(),
      } : undefined,
      nextAction: resolvedSources.length > 0 ? null : "review candidate and queue before reading",
    }), cache);
    if (result.created) created += 1;
    else if (result.changed) updated += 1;
    if (result.created) createdIds.push(result.candidate.id);
    else if (result.changed) updatedIds.push(result.candidate.id);
    candidates.push(result.candidate);
  }
  return { sourceId: source.id, sourceScope: source.scope, scannedRecords: records.length, foundLocators: locators.size, created, updated, createdIds, updatedIds, candidates };
}

export function inspectCandidatePool(home: string, scope?: string): { candidates: Candidate[]; issues: CandidatePoolIssue[] } {
  const scopes = scope ? [normalizeScope(scope)] : ["personal", "work"];
  const candidates: Candidate[] = [];
  const issues: CandidatePoolIssue[] = [];
  for (const currentScope of scopes) {
    const path = candidatePoolPath(home, currentScope);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
      issues.push({ scope: currentScope, path, line: 0, code: "pool_not_file", detail: "candidate pool must be a regular file" });
      continue;
    }
    const seenRevision = new Map<string, number>();
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const candidate = parseCandidate(JSON.parse(line), path, index + 1);
        if (candidate.scope !== currentScope) issues.push({ scope: currentScope, path, line: index + 1, code: "candidate_scope_mismatch", detail: `${candidate.id} declares ${candidate.scope}` });
        if ((seenRevision.get(candidate.id) ?? 0) >= candidate.revision) issues.push({ scope: currentScope, path, line: index + 1, code: "candidate_duplicate_revision", detail: `${candidate.id} revision ${candidate.revision} is not newer` });
        seenRevision.set(candidate.id, Math.max(seenRevision.get(candidate.id) ?? 0, candidate.revision));
        candidates.push(candidate);
      } catch (error) {
        issues.push({ scope: currentScope, path, line: index + 1, code: "candidate_malformed", detail: (error as Error).message });
      }
    });
  }
  const latest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const previous = latest.get(candidate.id);
    if (!previous || candidate.revision > previous.revision) latest.set(candidate.id, candidate);
  }
  return { candidates: [...latest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), issues };
}

export function candidateEventType(status: CandidateStatus, created: boolean): "candidate.discovered" | "candidate.queued" | "candidate.ingested" | "candidate.rejected" | "candidate.blocked" | "candidate.updated" {
  if (!created) return "candidate.updated";
  return `candidate.${status}` as "candidate.discovered" | "candidate.queued" | "candidate.ingested" | "candidate.rejected" | "candidate.blocked";
}

function normalizeInput(input: CandidateInput): Required<Pick<CandidateInput, "kind" | "title" | "locator">> & { scope: "personal" | "work"; sensitivity: string; origin: CandidateOrigin; status: CandidateStatus; nextAction: string | null; reason: string | null; resolution: Candidate["resolution"] } {
  if (!CANDIDATE_KINDS.includes(input.kind)) throw new Error(`Candidate kind must be one of: ${CANDIDATE_KINDS.join(", ")}`);
  const locator = normalizeLocator(input.locator);
  const title = String(input.title ?? "").trim() || locator.contentId || locator.url || "Untitled candidate";
  const scope = normalizeScope(input.scope);
  const status = input.status ?? "discovered";
  if (!CANDIDATE_STATUSES.includes(status)) throw new Error(`Candidate status must be one of: ${CANDIDATE_STATUSES.join(", ")}`);
  if (status === "ingested" && (!input.resolution || input.resolution.sourceIds.length === 0)) throw new Error("An ingested candidate requires resolved Source IDs");
  const origin: CandidateOrigin = {
    sourceIds: uniqueStrings(input.origin?.sourceIds),
    recordIds: uniqueStrings(input.origin?.recordIds),
    ...(input.origin?.searchId ? { searchId: input.origin.searchId } : {}),
    ...(input.origin?.searchSnapshotPath ? { searchSnapshotPath: input.origin.searchSnapshotPath } : {}),
    ...(input.origin?.searchSnapshotHash ? { searchSnapshotHash: input.origin.searchSnapshotHash } : {}),
  };
  return {
    kind: input.kind,
    title,
    locator,
    scope,
    sensitivity: String(input.sensitivity ?? (scope === "work" ? "work-internal" : "private")),
    origin,
    status,
    nextAction: input.nextAction === undefined ? null : input.nextAction,
    reason: input.reason === undefined ? null : input.reason,
    resolution: input.resolution ?? null,
  };
}

function normalizeLocator(locator: CandidateLocator): CandidateLocator {
  const adapter = String(locator.adapter ?? "").trim();
  if (!adapter) throw new Error("Candidate locator adapter is required");
  const rawUrl = String(locator.url ?? "").trim() || undefined;
  const suppliedUrl = adapter === "citadel"
    ? rawUrl?.match(/^https?:\/\/km\.sankuai\.com\/(?:page|collabpage)\/\d{1,32}/)?.[0]
    : rawUrl;
  const contentId = normalizeCitadelContentId(locator.contentId) ?? contentIdFromUrl(suppliedUrl);
  const url = suppliedUrl ?? (contentId && adapter === "citadel" ? `https://km.sankuai.com/page/${contentId}` : undefined);
  const query = String(locator.query ?? "").trim() || undefined;
  if (!contentId && !url && !query) throw new Error("Candidate locator requires contentId, url, or query");
  return { adapter, ...(contentId ? { contentId } : {}), ...(url ? { url } : {}), ...(query ? { query } : {}) };
}

function candidateFingerprint(kind: CandidateKind, scope: "personal" | "work", locator: CandidateLocator): string {
  return `${scope}:${kind}:${locator.adapter}:${locator.contentId ?? locator.url ?? locator.query}`;
}

function mergeCandidate(existing: Candidate, input: ReturnType<typeof normalizeInput>): { candidate: Candidate; changed: boolean } {
  const sourceIds = uniqueStrings([...existing.origin.sourceIds, ...input.origin.sourceIds]);
  const recordIds = uniqueStrings([...existing.origin.recordIds, ...input.origin.recordIds]);
  const resolvedSourceIds = uniqueStrings([...(existing.resolution?.sourceIds ?? []), ...(input.resolution?.sourceIds ?? [])]);
  const commentSourceId = existing.resolution?.commentSourceId ?? input.resolution?.commentSourceId;
  const resolution = resolvedSourceIds.length > 0
    ? { sourceIds: resolvedSourceIds, ...(commentSourceId ? { commentSourceId } : {}), ingestedAt: existing.resolution?.ingestedAt ?? input.resolution?.ingestedAt ?? new Date().toISOString() }
    : null;
  const changed = sourceIds.length !== existing.origin.sourceIds.length
    || recordIds.length !== existing.origin.recordIds.length
    || (!existing.title && Boolean(input.title))
    || (existing.title.endsWith(" - 评论") && !input.title.endsWith(" - 评论"))
    || resolvedSourceIds.length !== (existing.resolution?.sourceIds.length ?? 0)
    || commentSourceId !== existing.resolution?.commentSourceId
    || (!existing.origin.searchSnapshotPath && Boolean(input.origin.searchSnapshotPath));
  if (!changed) return { candidate: existing, changed: false };
  const candidate: Candidate = {
    ...existing,
    title: existing.title.endsWith(" - 评论") && !input.title.endsWith(" - 评论") ? input.title : (existing.title || input.title),
    origin: {
      ...existing.origin,
      sourceIds,
      recordIds,
      ...(existing.origin.searchId ?? input.origin.searchId ? { searchId: existing.origin.searchId ?? input.origin.searchId } : {}),
      ...(existing.origin.searchSnapshotPath ?? input.origin.searchSnapshotPath ? { searchSnapshotPath: existing.origin.searchSnapshotPath ?? input.origin.searchSnapshotPath } : {}),
      ...(existing.origin.searchSnapshotHash ?? input.origin.searchSnapshotHash ? { searchSnapshotHash: existing.origin.searchSnapshotHash ?? input.origin.searchSnapshotHash } : {}),
    },
    status: resolution && existing.status !== "rejected" && existing.status !== "blocked" ? "ingested" : existing.status,
    resolution,
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  return { candidate, changed: true };
}

function appendCandidateSnapshot(home: string, candidate: Candidate): void {
  ensureCandidateLayout(home, candidate.scope);
  const path = candidatePoolPath(home, candidate.scope);
  appendFileSync(path, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseCandidate(value: unknown, path: string, line: number): Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Candidate must be an object at ${path}:${line}`);
  const candidate = value as Partial<Candidate>;
  if (typeof candidate.id !== "string" || !/^cand-[A-Za-z0-9._-]+$/.test(candidate.id)) throw new Error(`Candidate id is invalid at ${path}:${line}`);
  if (typeof candidate.fingerprint !== "string" || !candidate.fingerprint) throw new Error(`Candidate fingerprint is missing at ${path}:${line}`);
  if (!CANDIDATE_KINDS.includes(candidate.kind as CandidateKind)) throw new Error(`Candidate kind is invalid at ${path}:${line}`);
  if (!CANDIDATE_STATUSES.includes(candidate.status as CandidateStatus)) throw new Error(`Candidate status is invalid at ${path}:${line}`);
  if (candidate.scope !== "personal" && candidate.scope !== "work") throw new Error(`Candidate scope is invalid at ${path}:${line}`);
  if (typeof candidate.title !== "string" || !candidate.title.trim()) throw new Error(`Candidate title is missing at ${path}:${line}`);
  if (!candidate.locator || typeof candidate.locator !== "object" || Array.isArray(candidate.locator)) throw new Error(`Candidate locator is missing at ${path}:${line}`);
  if (!candidate.origin || typeof candidate.origin !== "object" || Array.isArray(candidate.origin)) throw new Error(`Candidate origin is missing at ${path}:${line}`);
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) throw new Error(`Candidate revision is invalid at ${path}:${line}`);
  for (const field of ["createdAt", "updatedAt", "sensitivity"] as const) if (typeof candidate[field] !== "string" || !candidate[field]) throw new Error(`Candidate ${field} is missing at ${path}:${line}`);
  const normalizedLocator = normalizeLocator(candidate.locator as CandidateLocator);
  return { ...(candidate as Candidate), locator: normalizedLocator };
}

function extractCitadelLocators(record: SourceMessage): Array<{ locator: CandidateLocator; title: string }> {
  const text = [record.refs.join("\n"), record.content].join("\n");
  const result = new Map<string, { locator: CandidateLocator; title: string }>();
  const titleRef = record.refs.find((ref) => ref.startsWith("title:"));
  const title = titleRef ? titleRef.slice("title:".length).trim() : "";
  const add = (contentId: string, url?: string) => {
    const normalized = normalizeCitadelContentId(contentId);
    if (!normalized) return;
    result.set(normalized, { locator: { adapter: "citadel", contentId: normalized, url: url ?? `https://km.sankuai.com/page/${normalized}` }, title });
  };
  const urlPattern = /https?:\/\/km\.sankuai\.com\/(?:page|collabpage)\/(\d{1,32})[^\s)\]}>"']*/g;
  for (const match of text.matchAll(urlPattern)) {
    const url = match[0].match(/^https?:\/\/km\.sankuai\.com\/(?:page|collabpage)\/\d{1,32}/)?.[0];
    add(match[1], url);
  }
  const idPattern = /(?:contentId|content_id)\s*[:=]\s*(\d{1,32})/gi;
  for (const match of text.matchAll(idPattern)) add(match[1]);
  return [...result.values()];
}

function sourceContainsCitadelId(source: { originalPath: string; adapter?: string }, contentId: string | undefined): boolean {
  if (!contentId || source.adapter !== "citadel") return false;
  return new RegExp(`(?:^|[\\\\/])citadel[\\\\/]${contentId}(?:\\.md|\\.comments\\.jsonl)$`).test(source.originalPath);
}

function normalizeCitadelContentId(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return /^\d{1,32}$/.test(normalized) ? normalized : undefined;
}

function contentIdFromUrl(value: unknown): string | undefined {
  const url = String(value ?? "");
  return url.match(/km\.sankuai\.com\/(?:page|collabpage)\/(\d{1,32})/)?.[1];
}

function normalizeScope(scope: string | undefined): "personal" | "work" {
  const value = scope ?? "work";
  if (value !== "personal" && value !== "work") throw new Error(`Candidate scope must be personal or work: ${value}`);
  return value;
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).filter((value): value is string => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function writeFileSyncPrivate(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
