import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The v2 usage projection lives in usage/; legacy v1 files are archived under
 * usage/archive/v1/. It is
 * a diagnostic ledger, rather than a migration of the old evaluation data.
 * Keeping the writer here makes the activation boundary and the privacy rules
 * usable by all host adapters without making them share a summary format.
 */
export const IKB_USAGE_V2_VERSION = "v2" as const;
export const IKB_USAGE_V2_ACTIVATION_SCHEMA = "ikb-recall-usage-activation-v2" as const;
export const IKB_USAGE_V2_EVIDENCE_SCHEMA = "ikb-recall-usage-evidence-v2" as const;
export const IKB_USAGE_V2_SUMMARY_SCHEMA = "ikb-recall-usage-summary-v2" as const;
export const IKB_USAGE_V2_CURSOR_SCHEMA = "ikb-recall-usage-cursor-v2" as const;
export const IKB_USAGE_V2_DIRECTORY = "usage" as const;

export type IkbUsagePurpose = "interactive" | "maintenance" | "regression" | "unknown";
export type IkbUsageRelationship = "root" | "subagent";
export type IkbUsageAttemptOutcome = "success" | "failure" | "missing" | "invalid" | "unknown";
export type IkbUsageOperation = "search" | "get";

export interface IkbUsageV2Activation {
  schema: typeof IKB_USAGE_V2_ACTIVATION_SCHEMA;
  version: typeof IKB_USAGE_V2_VERSION;
  activatedAt: string;
  activationKey: string;
}

export interface IkbUsageV2Origin {
  host: string;
  sessionSource: string | null;
  relationship: IkbUsageRelationship;
  parentThreadId: string | null;
  subagentDepth: number | null;
  agentRole: string | null;
  purpose: IkbUsagePurpose;
}

export interface IkbUsageV2Attempt {
  attemptKey: string;
  operation: IkbUsageOperation;
  outcome: IkbUsageAttemptOutcome;
  sourceEventRef: string;
  observedAt: string | null;
  purpose?: IkbUsagePurpose;
  reasonCode?: string;
  queryHash?: string;
}

export interface IkbUsageV2Search {
  unitKey: string;
  attemptKey: string;
  retrievalId: string;
  queryHash: string;
  observedAt: string | null;
  total: number;
  zeroResult: boolean;
  resultCardIds: string[];
  resultOrder?: string[];
}

export interface IkbUsageV2Read {
  unitKey: string;
  attemptKey: string;
  retrievalId: string;
  cardId: string;
  contentHash: string;
  observedAt: string | null;
}

export interface IkbUsageV2State {
  unitKey: string;
  attemptKey: string;
  cardId: string;
  state: string;
  reasonCode: string;
  observedAt: string | null;
}

export interface IkbUsageV2EvidenceDetail {
  schema: typeof IKB_USAGE_V2_EVIDENCE_SCHEMA;
  version: typeof IKB_USAGE_V2_VERSION;
  subjectRef: string;
  subjectHash: string;
  startedAt: string;
  completedAt: string;
  origin: IkbUsageV2Origin;
  provenance: IkbUsageV2Origin;
  attempts: IkbUsageV2Attempt[];
  searches: IkbUsageV2Search[];
  reads: IkbUsageV2Read[];
  states: IkbUsageV2State[];
  issues: string[];
}

export interface IkbUsageV2Counts {
  attempts: number;
  searches: number;
  reads: number;
  states: number;
  zeroResults: number;
  outcomes: Record<IkbUsageAttemptOutcome, number>;
  origins: Record<string, number>;
  cards: Record<string, { reads: number; references: number; states: Record<string, number> }>;
}

export interface IkbUsageV2Summary {
  schema: typeof IKB_USAGE_V2_SUMMARY_SCHEMA;
  version: typeof IKB_USAGE_V2_VERSION;
  generatedAt: string;
  activation: { activatedAt: string; activationKey: string };
  window: { last7DaysUtc: { from: string; to: string }; cumulative: { from: string; to: string } };
  last7Days: IkbUsageV2Counts;
  cumulative: IkbUsageV2Counts;
  issueCounts: Record<string, number>;
  evidenceCount: number;
}

export interface IkbUsageV2Paths {
  root: string;
  activation: string;
  evidence: string;
  summary: string;
  cursor: string;
  corrections: string;
  missedLookups: string;
  details: string;
}

export function ikbUsageV2Paths(activeDataRoot: string): IkbUsageV2Paths {
  if (!isAbsolute(activeDataRoot)) throw new Error("IKB usage v2 data root must be absolute");
  const root = resolve(activeDataRoot, IKB_USAGE_V2_DIRECTORY);
  return {
    root,
    activation: resolve(root, "activation.json"),
    evidence: resolve(root, "evidence.jsonl"),
    summary: resolve(root, "summary.json"),
    cursor: resolve(root, "collector-state.json"),
    corrections: resolve(root, "user-corrections.jsonl"),
    missedLookups: resolve(root, "missed-lookup-candidates.jsonl"),
    details: resolve(root, "details"),
  };
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\n")) throw new Error(`${label} must be a safe string`);
  return value.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function atomicReplace(path: string, contents: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${sha256(String(Math.random())).slice(0, 12)}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

/** Fields that could retain prompts, card markdown, or machine-local paths. */
function validateRestricted(value: unknown, label: string, key = "", depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (key === "contentHash" && typeof value === "string" && V2_HASH.test(value)) return;
  if (/(?:prompt|markdown|path|url|title|snippet|content|command|arguments|input|raw|text)/i.test(key)) {
    throw new Error(`${label} contains a restricted field`);
  }
  if (typeof value === "string") {
    if (value.includes("\n") || /^\/?(?:Users|home|tmp|private|var)\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
      throw new Error(`${label} contains unsafe text`);
    }
    return;
  }
  if (key === "cards" && value && typeof value === "object" && !Array.isArray(value)) {
    // Card IDs are data keys, not field names (e.g. a valid ID may contain input).
    for (const [cardId, counts] of Object.entries(value as Record<string, unknown>)) {
      if (!V2_ID.test(cardId)) throw new Error(`${label} contains an invalid card ID`);
      validateRestricted(counts, label, "", depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => validateRestricted(item, label, key, depth + 1));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => validateRestricted(child, label, childKey, depth + 1));
  }
}

function readJson(path: string, label: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function validateActivation(value: unknown): IkbUsageV2Activation {
  const row = value as Record<string, unknown>;
  if (!row || row.schema !== IKB_USAGE_V2_ACTIVATION_SCHEMA || row.version !== IKB_USAGE_V2_VERSION) throw new Error("IKB usage v2 activation is invalid");
  const activatedAt = iso(row.activatedAt, "IKB usage v2 activation timestamp");
  const activationKey = safeString(row.activationKey, "IKB usage v2 activation key");
  if (activationKey !== sha256(`${IKB_USAGE_V2_VERSION}\n${activatedAt}`)) throw new Error("IKB usage v2 activation key is invalid");
  const normalized = { schema: IKB_USAGE_V2_ACTIVATION_SCHEMA, version: IKB_USAGE_V2_VERSION, activatedAt, activationKey } satisfies IkbUsageV2Activation;
  validateRestricted(normalized, "IKB usage v2 activation");
  return normalized;
}

const V2_HASH = /^[a-f0-9]{64}$/;
const V2_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function nullableIso(value: unknown, label: string): string | null {
  return value === null ? null : iso(value, label);
}

function validateEvidenceDetail(value: unknown): IkbUsageV2EvidenceDetail {
  const row = value as Record<string, unknown>;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("IKB usage v2 evidence must be an object");
  if (row.schema !== IKB_USAGE_V2_EVIDENCE_SCHEMA || row.version !== IKB_USAGE_V2_VERSION) throw new Error("IKB usage v2 evidence version is invalid");
  const subjectRef = safeString(row.subjectRef, "IKB usage v2 subjectRef");
  if (!subjectRef.startsWith("run://")) throw new Error("IKB usage v2 subjectRef is invalid");
  const subjectHash = safeString(row.subjectHash, "IKB usage v2 subjectHash");
  if (!V2_HASH.test(subjectHash)) throw new Error("IKB usage v2 subjectHash is invalid");
  const startedAt = iso(row.startedAt, "IKB usage v2 startedAt");
  const completedAt = iso(row.completedAt, "IKB usage v2 completedAt");
  const originValue = row.origin;
  const origin = originValue as Record<string, unknown>;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw new Error("IKB usage v2 origin is invalid");
  const host = safeString(origin.host, "IKB usage v2 origin host");
  const sessionSource = origin.sessionSource === null ? null : safeString(origin.sessionSource, "IKB usage v2 origin sessionSource");
  const relationship = origin.relationship;
  if (relationship !== "root" && relationship !== "subagent") throw new Error("IKB usage v2 origin relationship is invalid");
  const parentThreadId = origin.parentThreadId === null ? null : safeString(origin.parentThreadId, "IKB usage v2 origin parentThreadId");
  const subagentDepth = origin.subagentDepth === null ? null : origin.subagentDepth;
  if (subagentDepth !== null && (!Number.isInteger(subagentDepth) || Number(subagentDepth) < 0)) throw new Error("IKB usage v2 origin subagentDepth is invalid");
  const agentRole = origin.agentRole === null ? null : safeString(origin.agentRole, "IKB usage v2 origin agentRole");
  const purpose = origin.purpose;
  if (purpose !== "interactive" && purpose !== "maintenance" && purpose !== "regression" && purpose !== "unknown") throw new Error("IKB usage v2 origin purpose is invalid");
  const normalizedOrigin: IkbUsageV2Origin = { host, sessionSource, relationship, parentThreadId, subagentDepth: subagentDepth === null ? null : Number(subagentDepth), agentRole, purpose };
  const provenance = row.provenance as Record<string, unknown>;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new Error("IKB usage v2 provenance is invalid");
  if (canonical(provenance) !== canonical(normalizedOrigin)) throw new Error("IKB usage v2 provenance must match origin");
  const attemptsValue = row.attempts;
  if (!Array.isArray(attemptsValue)) throw new Error("IKB usage v2 attempts must be an array");
  const attempts = attemptsValue.map((item, index): IkbUsageV2Attempt => {
    const attempt = item as Record<string, unknown>;
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) throw new Error(`IKB usage v2 attempt ${index} is invalid`);
    const attemptKey = safeString(attempt.attemptKey, `IKB usage v2 attempt ${index} key`);
    if (!V2_HASH.test(attemptKey)) throw new Error(`IKB usage v2 attempt ${index} key is invalid`);
    const operation = attempt.operation;
    if (operation !== "search" && operation !== "get") throw new Error(`IKB usage v2 attempt ${index} operation is invalid`);
    const outcome = attempt.outcome;
    if (outcome !== "success" && outcome !== "failure" && outcome !== "missing" && outcome !== "invalid" && outcome !== "unknown") throw new Error(`IKB usage v2 attempt ${index} outcome is invalid`);
    const sourceEventRef = safeString(attempt.sourceEventRef, `IKB usage v2 attempt ${index} sourceEventRef`);
    if (!sourceEventRef.startsWith("run://")) throw new Error(`IKB usage v2 attempt ${index} sourceEventRef is invalid`);
    const observedAt = nullableIso(attempt.observedAt, `IKB usage v2 attempt ${index} observedAt`);
    const purpose = attempt.purpose === undefined ? undefined : attempt.purpose;
    if (purpose !== undefined && purpose !== "interactive" && purpose !== "maintenance" && purpose !== "regression" && purpose !== "unknown") throw new Error(`IKB usage v2 attempt ${index} purpose is invalid`);
    const reasonCode = attempt.reasonCode === undefined ? undefined : safeString(attempt.reasonCode, `IKB usage v2 attempt ${index} reasonCode`);
    const queryHash = attempt.queryHash === undefined ? undefined : safeString(attempt.queryHash, `IKB usage v2 attempt ${index} queryHash`);
    if (queryHash !== undefined && !V2_HASH.test(queryHash)) throw new Error(`IKB usage v2 attempt ${index} queryHash is invalid`);
    return { attemptKey, operation, outcome, sourceEventRef, observedAt, ...(purpose === undefined ? {} : { purpose }), ...(reasonCode === undefined ? {} : { reasonCode }), ...(queryHash === undefined ? {} : { queryHash }) };
  });
  const searchesValue = row.searches;
  if (!Array.isArray(searchesValue)) throw new Error("IKB usage v2 searches must be an array");
  const searches = searchesValue.map((item, index): IkbUsageV2Search => {
    const search = item as Record<string, unknown>;
    if (!search || typeof search !== "object" || Array.isArray(search)) throw new Error(`IKB usage v2 search ${index} is invalid`);
    const unitKey = safeString(search.unitKey, `IKB usage v2 search ${index} key`);
    const attemptKey = safeString(search.attemptKey, `IKB usage v2 search ${index} attempt key`);
    const retrievalId = safeString(search.retrievalId, `IKB usage v2 search ${index} retrievalId`);
    const queryHash = safeString(search.queryHash, `IKB usage v2 search ${index} queryHash`);
    if (!V2_HASH.test(unitKey) || !V2_HASH.test(attemptKey) || !V2_HASH.test(queryHash) || !V2_ID.test(retrievalId)) throw new Error(`IKB usage v2 search ${index} identity is invalid`);
    const observedAt = nullableIso(search.observedAt, `IKB usage v2 search ${index} observedAt`);
    const total = search.total;
    const zeroResult = search.zeroResult;
    if (!Number.isInteger(total) || Number(total) < 0 || typeof zeroResult !== "boolean" || zeroResult !== (Number(total) === 0)) throw new Error(`IKB usage v2 search ${index} counts are invalid`);
    if (!Array.isArray(search.resultCardIds) || search.resultCardIds.some((cardId) => typeof cardId !== "string" || !V2_ID.test(cardId))) throw new Error(`IKB usage v2 search ${index} result cards are invalid`);
    const resultOrder = search.resultOrder === undefined ? undefined : search.resultOrder;
    if (resultOrder !== undefined && (!Array.isArray(resultOrder) || resultOrder.some((cardId) => typeof cardId !== "string" || !V2_ID.test(cardId)))) throw new Error(`IKB usage v2 search ${index} result order is invalid`);
    return { unitKey, attemptKey, retrievalId, queryHash, observedAt, total: Number(total), zeroResult, resultCardIds: [...(search.resultCardIds as string[])], ...(resultOrder === undefined ? {} : { resultOrder: [...(resultOrder as string[])] }) };
  });
  const readsValue = row.reads;
  if (!Array.isArray(readsValue)) throw new Error("IKB usage v2 reads must be an array");
  const reads = readsValue.map((item, index): IkbUsageV2Read => {
    const read = item as Record<string, unknown>;
    if (!read || typeof read !== "object" || Array.isArray(read)) throw new Error(`IKB usage v2 read ${index} is invalid`);
    const unitKey = safeString(read.unitKey, `IKB usage v2 read ${index} key`);
    const attemptKey = safeString(read.attemptKey, `IKB usage v2 read ${index} attempt key`);
    const retrievalId = safeString(read.retrievalId, `IKB usage v2 read ${index} retrievalId`);
    const cardId = safeString(read.cardId, `IKB usage v2 read ${index} cardId`);
    const contentHash = safeString(read.contentHash, `IKB usage v2 read ${index} contentHash`);
    if (!V2_HASH.test(unitKey) || !V2_HASH.test(attemptKey) || !V2_ID.test(retrievalId) || !V2_ID.test(cardId) || !V2_HASH.test(contentHash)) throw new Error(`IKB usage v2 read ${index} identity is invalid`);
    return { unitKey, attemptKey, retrievalId, cardId, contentHash, observedAt: nullableIso(read.observedAt, `IKB usage v2 read ${index} observedAt`) };
  });
  const statesValue = row.states;
  if (!Array.isArray(statesValue)) throw new Error("IKB usage v2 states must be an array");
  const states = statesValue.map((item, index): IkbUsageV2State => {
    const state = item as Record<string, unknown>;
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error(`IKB usage v2 state ${index} is invalid`);
    const unitKey = safeString(state.unitKey, `IKB usage v2 state ${index} key`);
    const attemptKey = safeString(state.attemptKey, `IKB usage v2 state ${index} attempt key`);
    const cardId = safeString(state.cardId, `IKB usage v2 state ${index} cardId`);
    const stateValue = safeString(state.state, `IKB usage v2 state ${index} value`);
    const reasonCode = safeString(state.reasonCode, `IKB usage v2 state ${index} reasonCode`);
    if (!V2_HASH.test(unitKey) || !V2_HASH.test(attemptKey) || !V2_ID.test(cardId)) throw new Error(`IKB usage v2 state ${index} identity is invalid`);
    return { unitKey, attemptKey, cardId, state: stateValue, reasonCode, observedAt: nullableIso(state.observedAt, `IKB usage v2 state ${index} observedAt`) };
  });
  if (!Array.isArray(row.issues) || row.issues.some((issue) => typeof issue !== "string" || !issue.trim() || issue.includes("\n"))) throw new Error("IKB usage v2 evidence issues are invalid");
  const normalized = { schema: IKB_USAGE_V2_EVIDENCE_SCHEMA, version: IKB_USAGE_V2_VERSION, subjectRef, subjectHash, startedAt, completedAt, origin: normalizedOrigin, provenance: normalizedOrigin, attempts, searches, reads, states, issues: [...(row.issues as string[])] } satisfies IkbUsageV2EvidenceDetail;
  validateRestricted(normalized, "IKB usage v2 evidence");
  return normalized;
}

export function readIkbUsageV2Activation(activeDataRoot: string): IkbUsageV2Activation | null {
  if (existsSync(resolve(activeDataRoot, "usage-v2"))) throw new Error("usage-v2 directory requires migration to usage before collection");
  const path = ikbUsageV2Paths(activeDataRoot).activation;
  if (!existsSync(path)) return null;
  return validateActivation(readJson(path, "IKB usage v2 activation"));
}

export function activateIkbUsageV2(activeDataRoot: string, activatedAt = new Date().toISOString()): IkbUsageV2Activation {
  const paths = ikbUsageV2Paths(activeDataRoot);
  const normalizedAt = iso(activatedAt, "IKB usage v2 activation timestamp");
  const activation: IkbUsageV2Activation = {
    schema: IKB_USAGE_V2_ACTIVATION_SCHEMA,
    version: IKB_USAGE_V2_VERSION,
    activatedAt: normalizedAt,
    activationKey: sha256(`${IKB_USAGE_V2_VERSION}\n${normalizedAt}`),
  };
  const existing = readIkbUsageV2Activation(activeDataRoot);
  if (existing) {
    if (canonical(existing) !== canonical(activation)) throw new Error("IKB usage v2 is already activated at a different timestamp");
    return existing;
  }
  validateRestricted(activation, "IKB usage v2 activation");
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicReplace(paths.activation, `${JSON.stringify(activation, null, 2)}\n`);
  return activation;
}

function emptyCounts(): IkbUsageV2Counts {
  return {
    attempts: 0,
    searches: 0,
    reads: 0,
    states: 0,
    zeroResults: 0,
    outcomes: { success: 0, failure: 0, missing: 0, invalid: 0, unknown: 0 },
    origins: {},
    cards: {},
  };
}

function originKey(origin: IkbUsageV2Origin): string {
  return `${origin.host}|${origin.relationship}|${origin.purpose}`;
}

function addCard(counts: IkbUsageV2Counts, cardId: string, field: "reads" | "references", state?: string): void {
  const card = counts.cards[cardId] ?? { reads: 0, references: 0, states: {} };
  card[field] += 1;
  if (state) card.states[state] = (card.states[state] ?? 0) + 1;
  counts.cards[cardId] = card;
}

function addCardState(counts: IkbUsageV2Counts, cardId: string, state: string): void {
  const card = counts.cards[cardId] ?? { reads: 0, references: 0, states: {} };
  card.states[state] = (card.states[state] ?? 0) + 1;
  counts.cards[cardId] = card;
}

function aggregate(details: IkbUsageV2EvidenceDetail[], predicate: (time: string) => boolean): IkbUsageV2Counts {
  const counts = emptyCounts();
  const attemptKeys = new Set<string>();
  const searchKeys = new Set<string>();
  const readKeys = new Set<string>();
  const stateKeys = new Set<string>();
  for (const detail of details) {
    for (const attempt of detail.attempts) {
      const time = attempt.observedAt ?? detail.completedAt;
      if (!predicate(time) || attemptKeys.has(attempt.attemptKey)) continue;
      attemptKeys.add(attempt.attemptKey);
      counts.attempts += 1;
      counts.outcomes[attempt.outcome] += 1;
      const origin = originKey({ ...detail.origin, purpose: attempt.purpose ?? detail.origin.purpose });
      counts.origins[origin] = (counts.origins[origin] ?? 0) + 1;
    }
    for (const search of detail.searches) {
      const time = search.observedAt ?? detail.completedAt;
      if (!predicate(time) || searchKeys.has(search.unitKey)) continue;
      searchKeys.add(search.unitKey);
      counts.searches += 1;
      if (search.zeroResult) counts.zeroResults += 1;
    }
    for (const read of detail.reads) {
      const time = read.observedAt ?? detail.completedAt;
      if (!predicate(time) || readKeys.has(read.unitKey)) continue;
      readKeys.add(read.unitKey);
      counts.reads += 1;
      addCard(counts, read.cardId, "reads");
    }
    for (const state of detail.states) {
      const time = state.observedAt ?? detail.completedAt;
      if (!predicate(time) || stateKeys.has(state.unitKey)) continue;
      stateKeys.add(state.unitKey);
      counts.states += 1;
      if (state.state === "read_adopted") addCard(counts, state.cardId, "references", state.state);
      else addCardState(counts, state.cardId, state.state);
    }
  }
  return counts;
}

function readEvidence(path: string): IkbUsageV2EvidenceDetail[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    return validateEvidenceDetail(JSON.parse(line));
  });
}

export function projectIkbUsageV2(activeDataRoot: string, details: IkbUsageV2EvidenceDetail[], generatedAt = new Date().toISOString()): IkbUsageV2Summary {
  const activation = readIkbUsageV2Activation(activeDataRoot);
  if (!activation) throw new Error("IKB usage v2 activation is required");
  const paths = ikbUsageV2Paths(activeDataRoot);
  const generated = iso(generatedAt, "IKB usage v2 generated timestamp");
  const incoming = details.map((detail) => validateEvidenceDetail(detail));
  const merged = new Map<string, IkbUsageV2EvidenceDetail>();
  for (const detail of readEvidence(paths.evidence)) {
    const key = detail.subjectRef + "\n" + detail.subjectHash;
    merged.set(key, detail);
  }
  for (const detail of incoming) {
    const key = detail.subjectRef + "\n" + detail.subjectHash;
    merged.set(key, detail);
    mkdirSync(paths.details, { recursive: true, mode: 0o700 });
    const detailPath = resolve(paths.details, `${detail.subjectHash}.json`);
    if (!existsSync(detailPath)) atomicReplace(detailPath, `${JSON.stringify(detail, null, 2)}\n`);
  }
  const evidence = [...merged.values()].sort((left, right) => left.subjectRef.localeCompare(right.subjectRef) || left.subjectHash.localeCompare(right.subjectHash));
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicReplace(paths.evidence, evidence.length > 0 ? `${evidence.map((detail) => JSON.stringify(detail)).join("\n")}\n` : "");
  const generatedMs = Date.parse(generated);
  const fromMs = generatedMs - 7 * 86_400_000;
  const last7DaysPredicate = (time: string): boolean => {
    const value = Date.parse(time);
    return value >= fromMs && value <= generatedMs;
  };
  const cumulative = aggregate(evidence, () => true);
  const last7Days = aggregate(evidence, last7DaysPredicate);
  const issueCounts: Record<string, number> = {};
  for (const detail of evidence) for (const issue of detail.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
  const summary: IkbUsageV2Summary = {
    schema: IKB_USAGE_V2_SUMMARY_SCHEMA,
    version: IKB_USAGE_V2_VERSION,
    generatedAt: generated,
    activation: { activatedAt: activation.activatedAt, activationKey: activation.activationKey },
    window: {
      last7DaysUtc: { from: new Date(fromMs).toISOString(), to: generated },
      cumulative: { from: activation.activatedAt, to: generated },
    },
    last7Days,
    cumulative,
    issueCounts,
    evidenceCount: evidence.length,
  };
  validateRestricted(summary, "IKB usage v2 summary");
  atomicReplace(paths.summary, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function readIkbUsageV2Summary(activeDataRoot: string): IkbUsageV2Summary | null {
  const path = ikbUsageV2Paths(activeDataRoot).summary;
  if (!existsSync(path)) return null;
  const summary = readJson(path, "IKB usage v2 summary") as unknown as IkbUsageV2Summary;
  if (summary.schema !== IKB_USAGE_V2_SUMMARY_SCHEMA || summary.version !== IKB_USAGE_V2_VERSION) throw new Error("IKB usage v2 summary is invalid");
  validateRestricted(summary, "IKB usage v2 summary");
  return summary;
}

/** Project the frozen v1 correction envelope into the v2-only feedback file. */
export function projectIkbUsageV2Corrections(activeDataRoot: string, incoming: Array<Record<string, unknown>>): number {
  const paths = ikbUsageV2Paths(activeDataRoot);
  if (incoming.length === 0 && !existsSync(paths.corrections)) return 0;
  const rows: Array<Record<string, unknown>> = [];
  if (existsSync(paths.corrections)) {
    for (const line of readFileSync(paths.corrections, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.schema !== "ikb-recall-user-correction-v1" || typeof row.correctionKey !== "string") throw new Error("IKB usage v2 correction row is invalid");
      rows.push(row);
    }
  }
  const byKey = new Map(rows.map((row) => [String(row.correctionKey), row]));
  let added = 0;
  for (const row of incoming) {
    if (row.schema !== "ikb-recall-user-correction-v1" || typeof row.correctionKey !== "string" || !row.correctionKey) throw new Error("IKB usage v2 correction row is invalid");
    const key = row.correctionKey;
    const prior = byKey.get(key);
    if (prior && correctionCanonical(prior) !== correctionCanonical(row)) throw new Error("IKB usage v2 correction key collision");
    if (!prior) added += 1;
    byKey.set(key, row);
  }
  const merged = [...byKey.values()].sort((left, right) => String(left.detectedAt ?? "").localeCompare(String(right.detectedAt ?? "")) || String(left.correctionKey).localeCompare(String(right.correctionKey)));
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicReplace(paths.corrections, merged.length > 0 ? `${merged.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  return added;
}

function correctionCanonical(row: Record<string, unknown>): string {
  return canonical({
    schema: row.schema,
    correctionKey: row.correctionKey,
    detectedAt: row.detectedAt,
    subjectRef: row.subjectRef,
    label: row.label,
    excerpt: row.excerpt,
    hadIkbCall: row.hadIkbCall,
  });
}

export function projectIkbUsageV2MissedLookups(activeDataRoot: string, incoming: Array<Record<string, unknown>>): number {
  const paths = ikbUsageV2Paths(activeDataRoot);
  const rows: Array<Record<string, unknown>> = [];
  if (existsSync(paths.missedLookups)) {
    for (const line of readFileSync(paths.missedLookups, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.schema !== "ikb-recall-missed-lookup-candidate-v1" || typeof row.candidateKey !== "string") throw new Error("IKB usage v2 missed lookup row is invalid");
      rows.push(row);
    }
  }
  const byKey = new Map(rows.map((row) => [String(row.candidateKey), row]));
  let added = 0;
  for (const row of incoming) {
    if (row.schema !== "ikb-recall-missed-lookup-candidate-v1" || typeof row.candidateKey !== "string" || !row.candidateKey) throw new Error("IKB usage v2 missed lookup row is invalid");
    const key = row.candidateKey;
    const prior = byKey.get(key);
    if (prior && canonical(prior) !== canonical(row)) throw new Error("IKB usage v2 missed lookup key collision");
    if (!prior) added += 1;
    byKey.set(key, row);
  }
  const merged = [...byKey.values()].sort((left, right) => String(left.detectedAt ?? "").localeCompare(String(right.detectedAt ?? "")) || String(left.candidateKey).localeCompare(String(right.candidateKey)));
  if (merged.length > 0 || existsSync(paths.missedLookups)) {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    atomicReplace(paths.missedLookups, merged.length > 0 ? `${merged.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  }
  return added;
}
