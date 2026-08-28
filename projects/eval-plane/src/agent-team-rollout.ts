import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CAMPAIGN_OBSERVATIONS_SCHEMA, evaluateCampaignFiles, type CampaignEnvelope } from "./campaign-cli.ts";
import {
  CAMPAIGN_OBSERVATION_SCHEMA,
  type CampaignL3Status,
  type CampaignManifest,
  type CampaignObservation,
  validateCampaignManifest,
} from "./campaign-contract.ts";
import { validateReference } from "./eval-contract.ts";

export const AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA = "ikb-agent-team-rollout-telemetry-v1";
export const AGENT_TEAM_ROLLOUT_COLLECTION_SCHEMA = "ikb-agent-team-rollout-collection-v1";
export const AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA = "ikb-agent-team-campaign-samples-v1";
export const AGENT_TEAM_CAMPAIGN_RESULT_SCHEMA = "ikb-agent-team-campaign-result-v1";
export const AGENT_TEAM_CAMPAIGN_ENVELOPE_SCHEMA = "ikb-agent-team-campaign-envelope-v1";
export const AGENT_TEAM_MONITORING_START = "2026-08-26T00:00:00.000Z";
export const AGENT_TEAM_SKILL_IDS = [
  "agent-teams:agent-team-delegate",
  "agent-teams:agent-team-feature",
  "agent-teams:agent-team-review",
] as const;
const AGENT_TEAM_SKILL_NAMES = ["agent-team-delegate", "agent-team-feature", "agent-team-review"] as const;

const COLLABORATION_TOOLS = {
  spawn_agent: "spawnAgent",
  followup_task: "followupTask",
  send_message: "sendMessage",
  wait_agent: "waitAgent",
  interrupt_agent: "interruptAgent",
  list_agents: "listAgents",
  send_input: "sendInput",
  close_agent: "closeAgent",
} as const;
const MAX_JSONL_LINE_LENGTH = 8 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type Row = Record<string, unknown>;
type SkillFilter = "installed" | "loaded" | "absent" | "any";
type PluginState = "installed" | "workspace" | "partial" | "absent";
type BinaryFinding = "present" | "absent" | "unknown";
type ExpectedSpawn = "spawn" | "no_spawn" | "not_scored";

interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface RuntimeFacts {
  model: string;
  effort: string;
  multiAgentVersion: string;
  sandboxType: string;
  permissionType: string;
  collaborationMode: string;
}

interface TurnFacts {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  baselineTokens: TokenUsage | null;
  finalTokens: TokenUsage | null;
  runtime: RuntimeFacts;
  calls: Record<string, number>;
}

interface PluginFacts {
  state: PluginState;
  marketplace: string | null;
  plugin: string | null;
  version: string | null;
  skillIds: string[];
}

interface RolloutFacts {
  threadId: string;
  sessionId: string;
  parentThreadId: string | null;
  depth: number;
  agentRole: string | null;
  cliVersion: string;
  cwd: string;
  plugin: PluginFacts;
  turns: TurnFacts[];
}

export interface AgentTeamInstallation {
  marketplace: string;
  plugin: string;
  version: string;
}

export interface AgentTeamTelemetry {
  schema: typeof AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA;
  collectorVersion: "v1";
  subjectVersion: "codex-rollout-turn.v1";
  subjectRef: string;
  completedAt: string;
  environment: "temporary" | "workspace" | "other";
  runtime: {
    cliVersion: string;
    model: string;
    effort: string;
    multiAgentVersion: string;
    sandboxType: string;
    permissionType: string;
    collaborationMode: string;
    controlHash: string;
  };
  plugin: PluginFacts;
  completeness: {
    terminal: true;
    tokens: boolean;
    descendants: boolean;
  };
  execution: {
    childThreads: number;
    childTurns: number;
    maxDepth: number;
    wallTimeMs: number;
  };
  cost: TokenUsage;
  collaboration: {
    totalCalls: number;
    spawnAgent: number;
    followupTask: number;
    sendMessage: number;
    waitAgent: number;
    interruptAgent: number;
    listAgents: number;
    sendInput: number;
    closeAgent: number;
  };
  diagnostics: {
    parentChildDuplicateReads: { status: "unknown"; value: null; reasonCode: "native_read_targets_not_structured" };
    writerConflict: "unknown";
    reviewSnapshotDrift: "unknown";
  };
  subjectHash: string;
  artifactRef: string;
}

interface Persistence {
  path: string;
  hash: string;
  reused: boolean;
}

export interface AgentTeamCollectionReport {
  schema: typeof AGENT_TEAM_ROLLOUT_COLLECTION_SCHEMA;
  status: "ready" | "degraded" | "unavailable";
  window: { from: string; to: string };
  scannedFiles: number;
  completedRootTurns: number;
  matchedRootTurns: number;
  persisted: number;
  reused: number;
  skippedIncomplete: number;
  issues: Array<{ reasonCode: string; count: number }>;
  artifacts: Array<{ subjectRef: string; artifactRef: string; subjectHash: string; persistence: Persistence }>;
}

export interface CollectAgentTeamOptions {
  sessionRoots: string[];
  outputRoot: string;
  from?: string;
  to?: string;
  skillFilter?: SkillFilter;
  expectedInstallation?: AgentTeamInstallation | null;
}

interface CampaignSample {
  variantId: string;
  rootThreadId: string;
  turnId: string;
  caseHash: string;
  trial: number;
  stratum: string;
  expectedSkillState: "loaded" | "absent";
  l1Passed: boolean;
  l3Status: CampaignL3Status;
  manualInterventions: number;
  expectedSpawn: ExpectedSpawn;
  writerConflict: BinaryFinding;
  reviewSnapshotDrift: BinaryFinding;
  parentChildDuplicateReads: number | null;
  outcomeEvidenceRef: string;
}

interface CampaignSamplesDocument {
  schema: typeof AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA;
  campaignId: string;
  samples: CampaignSample[];
}

export interface AgentTeamCampaignEnvelope {
  schema: typeof AGENT_TEAM_CAMPAIGN_ENVELOPE_SCHEMA;
  monitoring: {
    sampleCount: number;
    qualityLabelled: number;
    correctSpawnDecisions: number;
    falsePositiveSpawns: number;
    falseNegativeSpawns: number;
    spawnNotScored: number;
    writerConflicts: number;
    writerConflictUnknown: number;
    reviewSnapshotDrifts: number;
    reviewSnapshotDriftUnknown: number;
    duplicateReadLabels: number;
  };
  observationsPersistence: Persistence;
  campaign: CampaignEnvelope;
}

export interface RunAgentTeamCampaignOptions {
  manifestPath: string;
  samplesPath: string;
  sessionRoots: string[];
  telemetryRoot: string;
  resultRoot: string;
  observationsRoot: string;
  campaignReportRoot: string;
}

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Row;
}

function optionalObject(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function exactKeys(row: Row, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new Error(`${label} contains unsupported fields: ${unsupported.join(",")}`);
}

function stringValue(value: unknown, label: string, pattern = ID_PATTERN): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is unsupported`);
  return value as T;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const row = value as Row;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(Date.parse(value)).toISOString();
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
}

function rowTimestamp(row: Row, payload: Row | null): string | null {
  const direct = safeTimestamp(row.timestamp);
  if (direct) return direct;
  const nested = safeTimestamp(payload?.timestamp);
  if (nested) return nested;
  for (const key of ["started_at", "completed_at"]) {
    const epoch = payload?.[key];
    if (typeof epoch === "number" && Number.isFinite(epoch)) return new Date(epoch * 1000).toISOString();
  }
  return null;
}

function zeroTokens(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  const row = optionalObject(value);
  if (!row) return null;
  const number = (key: string): number => typeof row[key] === "number" && Number.isFinite(row[key]) && Number(row[key]) >= 0 ? Number(row[key]) : 0;
  const total = number("total_tokens");
  if (total === 0 && !Object.prototype.hasOwnProperty.call(row, "total_tokens")) return null;
  return {
    inputTokens: number("input_tokens"),
    cachedInputTokens: number("cached_input_tokens"),
    cacheWriteInputTokens: number("cache_write_input_tokens"),
    outputTokens: number("output_tokens"),
    reasoningOutputTokens: number("reasoning_output_tokens"),
    totalTokens: total,
  };
}

function deltaTokens(finalValue: TokenUsage | null, baselineValue: TokenUsage | null): TokenUsage | null {
  if (!finalValue) return null;
  const baseline = baselineValue ?? zeroTokens();
  const delta = (finalNumber: number, baselineNumber: number): number => finalNumber >= baselineNumber ? finalNumber - baselineNumber : finalNumber;
  return {
    inputTokens: delta(finalValue.inputTokens, baseline.inputTokens),
    cachedInputTokens: delta(finalValue.cachedInputTokens, baseline.cachedInputTokens),
    cacheWriteInputTokens: delta(finalValue.cacheWriteInputTokens, baseline.cacheWriteInputTokens),
    outputTokens: delta(finalValue.outputTokens, baseline.outputTokens),
    reasoningOutputTokens: delta(finalValue.reasoningOutputTokens, baseline.reasoningOutputTokens),
    totalTokens: delta(finalValue.totalTokens, baseline.totalTokens),
  };
}

function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("\n");
  const row = optionalObject(value);
  if (!row) return "";
  for (const key of ["text", "content", "message"]) {
    if (row[key] !== undefined) {
      const result = textContent(row[key]);
      if (result) return result;
    }
  }
  return "";
}

function parsePluginFacts(developerText: string): PluginFacts {
  const skillIds = AGENT_TEAM_SKILL_NAMES.flatMap((name) => {
    const namespaced = `agent-teams:${name}`;
    if (new RegExp(`^\\s*-\\s+${namespaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(developerText)) return [namespaced];
    if (new RegExp(`^\\s*-\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m").test(developerText)) return [name];
    return [];
  });
  const cachePattern = /\.codex\/plugins\/cache\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._+-]+)\/skills/g;
  const cacheMatches = [...developerText.matchAll(cachePattern)];
  const cache = cacheMatches.find((match) => match[2] === "agent-teams") ?? null;
  if (skillIds.length === 0) return { state: "absent", marketplace: null, plugin: null, version: null, skillIds: [] };
  if (skillIds.length !== AGENT_TEAM_SKILL_IDS.length) return { state: "partial", marketplace: cache?.[1] ?? null, plugin: cache?.[2] ?? null, version: cache?.[3] ?? null, skillIds: [...skillIds].sort() };
  return {
    state: cache ? "installed" : "workspace",
    marketplace: cache?.[1] ?? null,
    plugin: cache?.[2] ?? null,
    version: cache?.[3] ?? null,
    skillIds: [...skillIds].sort(),
  };
}

function defaultRuntime(): RuntimeFacts {
  return { model: "unknown", effort: "default", multiAgentVersion: "unknown", sandboxType: "unknown", permissionType: "unknown", collaborationMode: "unknown" };
}

function runtimeFromContext(payload: Row): RuntimeFacts {
  const collaboration = optionalObject(payload.collaboration_mode);
  const sandbox = optionalObject(payload.sandbox_policy);
  const permission = optionalObject(payload.permission_profile);
  return {
    model: optionalString(payload.model) ?? "unknown",
    effort: optionalString(payload.effort) ?? optionalString(collaboration?.reasoning_effort) ?? "default",
    multiAgentVersion: optionalString(payload.multi_agent_version) ?? "unknown",
    sandboxType: optionalString(sandbox?.type) ?? "unknown",
    permissionType: optionalString(permission?.type) ?? "unknown",
    collaborationMode: optionalString(collaboration?.mode) ?? "unknown",
  };
}

function forEachJsonLine(path: string, visitor: (row: Row, line: number) => void): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("rollout source must be a regular file");
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      pending += decoder.write(buffer.subarray(0, count));
      if (pending.length > MAX_JSONL_LINE_LENGTH && !pending.includes("\n")) throw new Error("rollout JSONL line exceeds the supported bound");
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        lineNumber += 1;
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as unknown;
        visitor(objectValue(parsed, `rollout line ${lineNumber}`), lineNumber);
      }
    }
    pending += decoder.end();
    if (pending.trim()) {
      lineNumber += 1;
      visitor(objectValue(JSON.parse(pending) as unknown, `rollout line ${lineNumber}`), lineNumber);
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseRollout(path: string): RolloutFacts {
  let threadId = "";
  let sessionId = "";
  let parentThreadId: string | null = null;
  let depth = 0;
  let agentRole: string | null = null;
  let cliVersion = "unknown";
  let cwd = "";
  let subagentHistoryStartOrdinal: number | null = null;
  let developerText = "";
  let currentTurnId: string | null = null;
  let lastTokens: TokenUsage | null = null;
  const turns = new Map<string, TurnFacts>();
  const ensureTurn = (turnId: string): TurnFacts => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const created: TurnFacts = { turnId, startedAt: "", completedAt: null, durationMs: null, baselineTokens: lastTokens, finalTokens: null, runtime: defaultRuntime(), calls: {} };
    turns.set(turnId, created);
    return created;
  };

  forEachJsonLine(path, (row) => {
    if (threadId && subagentHistoryStartOrdinal !== null && typeof row.ordinal === "number" && row.ordinal < subagentHistoryStartOrdinal) return;
    const payload = optionalObject(row.payload);
    const outerType = optionalString(row.type);
    if (outerType === "session_meta" && payload) {
      if (threadId) return;
      threadId = optionalString(payload.id) ?? optionalString(payload.session_id) ?? threadId;
      sessionId = optionalString(payload.session_id) ?? threadId;
      cliVersion = optionalString(payload.cli_version) ?? cliVersion;
      cwd = optionalString(payload.cwd) ?? cwd;
      const source = optionalObject(payload.source);
      const subagent = optionalObject(source?.subagent);
      const spawn = optionalObject(subagent?.thread_spawn);
      parentThreadId = optionalString(spawn?.parent_thread_id) ?? optionalString(payload.parent_thread_id) ?? null;
      depth = typeof spawn?.depth === "number" && Number.isInteger(spawn.depth) ? Number(spawn.depth) : parentThreadId ? 1 : 0;
      agentRole = optionalString(spawn?.agent_role) ?? null;
      subagentHistoryStartOrdinal = typeof payload.subagent_history_start_ordinal === "number" && Number.isInteger(payload.subagent_history_start_ordinal)
        ? Number(payload.subagent_history_start_ordinal)
        : null;
      return;
    }
    if (!payload) return;
    const payloadType = optionalString(payload.type);
    const eventTime = rowTimestamp(row, payload);
    if (outerType === "event_msg" && payloadType === "task_started") {
      const turnId = optionalString(payload.turn_id);
      if (!turnId || !eventTime) return;
      currentTurnId = turnId;
      const turn = ensureTurn(turnId);
      turn.startedAt ||= eventTime;
      turn.baselineTokens = lastTokens;
      return;
    }
    if (outerType === "turn_context") {
      const turnId = optionalString(payload.turn_id) ?? currentTurnId;
      if (!turnId) return;
      currentTurnId = turnId;
      const turn = ensureTurn(turnId);
      if (eventTime) turn.startedAt ||= eventTime;
      turn.runtime = runtimeFromContext(payload);
      return;
    }
    if (outerType === "response_item" && payloadType === "message" && optionalString(payload.role) === "developer") {
      developerText += `\n${textContent(payload.content ?? payload.message)}`;
      return;
    }
    if (outerType === "event_msg" && payloadType === "token_count") {
      const info = optionalObject(payload.info);
      const usage = parseTokenUsage(info?.total_token_usage);
      if (usage) {
        lastTokens = usage;
        if (currentTurnId) ensureTurn(currentTurnId).finalTokens = usage;
      }
      return;
    }
    if (outerType === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const name = optionalString(payload.name) ?? optionalString(payload.tool_name);
      if (currentTurnId && name) {
        const turn = ensureTurn(currentTurnId);
        turn.calls[name] = (turn.calls[name] ?? 0) + 1;
      }
      return;
    }
    if (outerType === "event_msg" && payloadType === "task_complete") {
      const turnId = optionalString(payload.turn_id) ?? currentTurnId;
      if (!turnId || !eventTime) return;
      const turn = ensureTurn(turnId);
      turn.completedAt = eventTime;
      turn.finalTokens = lastTokens;
      const duration = payload.duration_ms;
      turn.durationMs = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
        ? Math.round(duration)
        : turn.startedAt ? Math.max(0, Date.parse(eventTime) - Date.parse(turn.startedAt)) : null;
      if (currentTurnId === turnId) currentTurnId = null;
    }
  });
  if (!threadId) throw new Error("rollout session_meta id is missing");
  return {
    threadId,
    sessionId: sessionId || threadId,
    parentThreadId,
    depth,
    agentRole,
    cliVersion,
    cwd,
    plugin: parsePluginFacts(developerText),
    turns: [...turns.values()].filter((turn) => turn.turnId && turn.startedAt).sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  };
}

interface RolloutMeta {
  path: string;
  threadId: string;
  parentThreadId: string | null;
}

function readRolloutMeta(path: string): RolloutMeta {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("rollout source must be a regular file");
    while (!pending.includes("\n")) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      pending += decoder.write(buffer.subarray(0, count));
      if (pending.length > MAX_JSONL_LINE_LENGTH) throw new Error("rollout session_meta exceeds the supported bound");
    }
    pending += decoder.end();
  } finally {
    closeSync(descriptor);
  }
  const line = pending.split("\n", 1)[0]?.replace(/\r$/, "");
  const row = objectValue(JSON.parse(line) as unknown, "rollout session_meta");
  if (row.type !== "session_meta") throw new Error("rollout must start with session_meta");
  const payload = objectValue(row.payload, "rollout session_meta payload");
  const threadId = optionalString(payload.id) ?? optionalString(payload.session_id);
  if (!threadId) throw new Error("rollout session_meta id is missing");
  const source = optionalObject(payload.source);
  const subagent = optionalObject(source?.subagent);
  const spawn = optionalObject(subagent?.thread_spawn);
  return {
    path,
    threadId,
    parentThreadId: optionalString(spawn?.parent_thread_id) ?? optionalString(payload.parent_thread_id) ?? null,
  };
}

function discoverRollouts(sessionRoots: string[], modifiedSince: string | null = null): { paths: string[]; missingRoots: number } {
  const paths: string[] = [];
  let missingRoots = 0;
  const minimumModifiedAt = modifiedSince ? Date.parse(modifiedSince) : Number.NEGATIVE_INFINITY;
  const visit = (directory: string): void => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("session root contains an unsafe directory");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("backup-")) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && lstatSync(path).mtimeMs >= minimumModifiedAt) paths.push(path);
    }
  };
  for (const value of sessionRoots) {
    const root = resolve(value);
    if (!existsSync(root)) {
      missingRoots += 1;
      continue;
    }
    visit(root);
  }
  return { paths: [...new Set(paths)].sort(), missingRoots };
}

function loadRolloutFacts(sessionRoots: string[], modifiedSince: string | null = null): { facts: RolloutFacts[]; scannedFiles: number; issues: string[]; missingRoots: number } {
  const discovery = discoverRollouts(sessionRoots, modifiedSince);
  const facts: RolloutFacts[] = [];
  const issues: string[] = [];
  for (const path of discovery.paths) {
    try {
      facts.push(parseRollout(path));
    } catch {
      issues.push("rollout_parse_failed");
    }
  }
  const byThread = new Map<string, RolloutFacts>();
  for (const fact of facts) {
    const existing = byThread.get(fact.threadId);
    const score = (value: RolloutFacts): number => value.turns.filter((turn) => turn.completedAt).length * 1_000_000 + value.turns.length;
    if (!existing || score(fact) > score(existing)) byThread.set(fact.threadId, fact);
  }
  return { facts: [...byThread.values()], scannedFiles: discovery.paths.length, issues, missingRoots: discovery.missingRoots };
}

function loadSelectedRolloutFacts(sessionRoots: string[], selectedRootIds: Set<string>): { facts: RolloutFacts[]; issues: string[] } {
  const discovery = discoverRollouts(sessionRoots);
  const metadata: RolloutMeta[] = [];
  for (const path of discovery.paths) {
    try {
      metadata.push(readRolloutMeta(path));
    } catch {
      // An unrelated malformed rollout cannot invalidate a sealed sample.
      // If it is one of the selected roots it remains missing and fails below.
    }
  }
  const selectedThreadIds = new Set(selectedRootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const meta of metadata) {
      if (meta.parentThreadId && selectedThreadIds.has(meta.parentThreadId) && !selectedThreadIds.has(meta.threadId)) {
        selectedThreadIds.add(meta.threadId);
        changed = true;
      }
    }
  }
  const facts: RolloutFacts[] = [];
  const issues: string[] = [];
  for (const meta of metadata.filter((item) => selectedThreadIds.has(item.threadId))) {
    try {
      facts.push(parseRollout(meta.path));
    } catch {
      issues.push("selected_rollout_parse_failed");
    }
  }
  const byThread = new Map<string, RolloutFacts>();
  for (const fact of facts) {
    const existing = byThread.get(fact.threadId);
    const score = (value: RolloutFacts): number => value.turns.filter((turn) => turn.completedAt).length * 1_000_000 + value.turns.length;
    if (!existing || score(fact) > score(existing)) byThread.set(fact.threadId, fact);
  }
  for (const rootId of selectedRootIds) if (!byThread.has(rootId)) issues.push("selected_root_rollout_missing");
  return { facts: [...byThread.values()], issues };
}

function rootThreadId(fact: RolloutFacts, byThread: Map<string, RolloutFacts>): string | null {
  let current = fact;
  const seen = new Set<string>();
  while (current.parentThreadId) {
    if (seen.has(current.threadId)) return null;
    seen.add(current.threadId);
    const parent = byThread.get(current.parentThreadId);
    if (!parent) return null;
    current = parent;
  }
  return current.threadId;
}

function environmentFor(cwd: string): "temporary" | "workspace" | "other" {
  const absolute = resolve(cwd || "/");
  const temporary = resolve(tmpdir());
  const workspace = resolve(homedir(), "projects");
  if (absolute === temporary || absolute.startsWith(`${temporary}/`)) return "temporary";
  if (absolute === workspace || absolute.startsWith(`${workspace}/`)) return "workspace";
  return "other";
}

function collaborationCounts(turns: TurnFacts[]): AgentTeamTelemetry["collaboration"] {
  const result: AgentTeamTelemetry["collaboration"] = {
    totalCalls: 0,
    spawnAgent: 0,
    followupTask: 0,
    sendMessage: 0,
    waitAgent: 0,
    interruptAgent: 0,
    listAgents: 0,
    sendInput: 0,
    closeAgent: 0,
  };
  for (const turn of turns) {
    for (const [tool, target] of Object.entries(COLLABORATION_TOOLS) as Array<[keyof typeof COLLABORATION_TOOLS, Exclude<keyof AgentTeamTelemetry["collaboration"], "totalCalls">]>) {
      const count = turn.calls[tool] ?? 0;
      result[target] += count;
      result.totalCalls += count;
    }
  }
  return result;
}

function buildTelemetry(root: RolloutFacts, rootTurn: TurnFacts, facts: RolloutFacts[]): AgentTeamTelemetry | null {
  if (!rootTurn.completedAt || rootTurn.durationMs === null) return null;
  const byThread = new Map(facts.map((fact) => [fact.threadId, fact]));
  const descendants = facts.filter((fact) => fact.threadId !== root.threadId && rootThreadId(fact, byThread) === root.threadId);
  const childSegments = descendants.flatMap((fact) => fact.turns
    .filter((turn) => turn.startedAt >= rootTurn.startedAt && turn.startedAt <= rootTurn.completedAt!)
    .map((turn) => ({ fact, turn })));
  const allTurns = [rootTurn, ...childSegments.map((item) => item.turn)];
  const tokenDeltas = allTurns.map((turn) => deltaTokens(turn.finalTokens, turn.baselineTokens));
  const tokensComplete = tokenDeltas.every((value) => value !== null);
  const cost = tokenDeltas.reduce<TokenUsage>((total, value) => addTokens(total, value ?? zeroTokens()), zeroTokens());
  const collaboration = collaborationCounts(allTurns);
  const childThreadIds = new Set(childSegments.map((item) => item.fact.threadId));
  const descendantsComplete = childSegments.every((item) => Boolean(item.turn.completedAt)) && collaboration.spawnAgent <= childThreadIds.size;
  const environment = environmentFor(root.cwd);
  const runtime = {
    cliVersion: root.cliVersion,
    ...rootTurn.runtime,
    controlHash: sha256(canonical({
      schema: "agent-team-runtime-control-v1",
      cliVersion: root.cliVersion,
      ...rootTurn.runtime,
      environment,
    })),
  };
  const subjectRef = validateReference(`run://codex/${root.threadId}/${rootTurn.turnId}`, "Agent Team subjectRef");
  const core = {
    schema: AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA,
    collectorVersion: "v1" as const,
    subjectVersion: "codex-rollout-turn.v1" as const,
    subjectRef,
    completedAt: rootTurn.completedAt,
    environment,
    runtime,
    plugin: root.plugin,
    completeness: { terminal: true as const, tokens: tokensComplete, descendants: descendantsComplete },
    execution: {
      childThreads: childThreadIds.size,
      childTurns: childSegments.length,
      maxDepth: childSegments.reduce((maximum, item) => Math.max(maximum, item.fact.depth), 0),
      wallTimeMs: rootTurn.durationMs,
    },
    cost,
    collaboration,
    diagnostics: {
      parentChildDuplicateReads: { status: "unknown" as const, value: null, reasonCode: "native_read_targets_not_structured" as const },
      writerConflict: "unknown" as const,
      reviewSnapshotDrift: "unknown" as const,
    },
  };
  const subjectHash = sha256(canonical(core));
  return { ...core, subjectHash, artifactRef: validateReference(`artifact://agent-team-rollout/${subjectHash}`, "Agent Team artifactRef") };
}

function ensureDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("persistence directory must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("persistence directory is unsafe");
}

function persistBytes(directory: string, filename: string, bytes: string): Persistence {
  ensureDirectory(directory);
  const path = join(directory, filename);
  const hash = sha256(bytes);
  if (existsSync(path)) {
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error("persisted observation must be a regular file");
      if (readFileSync(descriptor, "utf8") !== bytes) throw new Error("content-addressed observation was modified");
    } finally {
      closeSync(descriptor);
    }
    return { path, hash, reused: true };
  }
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return { path, hash, reused: false };
}

function persistTelemetry(directory: string, telemetry: AgentTeamTelemetry): Persistence {
  return persistBytes(directory, `${telemetry.subjectHash}.json`, `${JSON.stringify(telemetry, null, 2)}\n`);
}

function matchesSkillFilter(plugin: PluginFacts, filter: SkillFilter, expected: AgentTeamInstallation | null | undefined): boolean {
  const loaded = plugin.state === "installed" || plugin.state === "workspace";
  if (filter === "any") return true;
  if (filter === "absent") return plugin.state === "absent";
  if (filter === "loaded") return loaded;
  if (plugin.state !== "installed") return false;
  if (!expected) return true;
  return plugin.marketplace === expected.marketplace && plugin.plugin === expected.plugin && plugin.version === expected.version;
}

function countIssues(values: string[]): Array<{ reasonCode: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([reasonCode, count]) => ({ reasonCode, count }));
}

function incrementalCollectionStart(outputRoot: string): string | null {
  if (!existsSync(outputRoot)) return null;
  const stat = lstatSync(outputRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Agent Team telemetry root is unsafe");
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = readRegularJson(join(outputRoot, entry.name), "Agent Team telemetry artifact");
    const row = objectValue(value, "Agent Team telemetry artifact");
    if (row.schema !== AGENT_TEAM_ROLLOUT_TELEMETRY_SCHEMA) throw new Error("Agent Team telemetry artifact schema is invalid");
    const completedAt = timestamp(row.completedAt, "Agent Team telemetry completedAt");
    latest = Math.max(latest, Date.parse(completedAt));
  }
  if (!Number.isFinite(latest)) return null;
  return new Date(Math.max(Date.parse(AGENT_TEAM_MONITORING_START), latest - 24 * 60 * 60 * 1000)).toISOString();
}

export function collectAgentTeamRollouts(options: CollectAgentTeamOptions): AgentTeamCollectionReport {
  if (!Array.isArray(options.sessionRoots) || options.sessionRoots.length === 0) throw new Error("at least one Codex session root is required");
  const from = timestamp(options.from ?? incrementalCollectionStart(resolve(options.outputRoot)) ?? AGENT_TEAM_MONITORING_START, "collection from");
  const to = timestamp(options.to ?? new Date().toISOString(), "collection to");
  if (from > to) throw new Error("collection from must not be after to");
  const loaded = loadRolloutFacts(options.sessionRoots, from);
  const issues = [...loaded.issues, ...(loaded.missingRoots === options.sessionRoots.length ? ["session_root_missing"] : [])];
  const rootFacts = loaded.facts.filter((fact) => !fact.parentThreadId);
  const rootTurns = rootFacts.flatMap((fact) => fact.turns.map((turn) => ({ fact, turn }))).filter(({ turn }) => turn.startedAt >= from && turn.startedAt <= to);
  const completedRootTurns = rootTurns.filter(({ turn }) => Boolean(turn.completedAt)).length;
  const incomplete = rootTurns.filter(({ turn }) => !turn.completedAt).length;
  const filter = options.skillFilter ?? "installed";
  const artifacts: AgentTeamCollectionReport["artifacts"] = [];
  let persisted = 0;
  let reused = 0;
  for (const { fact, turn } of rootTurns) {
    if (!turn.completedAt || !matchesSkillFilter(fact.plugin, filter, options.expectedInstallation)) continue;
    const telemetry = buildTelemetry(fact, turn, loaded.facts);
    if (!telemetry) continue;
    if (!telemetry.completeness.tokens) issues.push("token_usage_incomplete");
    if (!telemetry.completeness.descendants) issues.push("descendant_rollout_incomplete");
    const persistence = persistTelemetry(resolve(options.outputRoot), telemetry);
    if (persistence.reused) reused += 1;
    else persisted += 1;
    artifacts.push({ subjectRef: telemetry.subjectRef, artifactRef: telemetry.artifactRef, subjectHash: telemetry.subjectHash, persistence });
  }
  artifacts.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
  const unavailable = loaded.scannedFiles === 0 && loaded.missingRoots === options.sessionRoots.length;
  return {
    schema: AGENT_TEAM_ROLLOUT_COLLECTION_SCHEMA,
    status: unavailable ? "unavailable" : issues.length > 0 ? "degraded" : "ready",
    window: { from, to },
    scannedFiles: loaded.scannedFiles,
    completedRootTurns,
    matchedRootTurns: artifacts.length,
    persisted,
    reused,
    skippedIncomplete: incomplete,
    issues: countIssues(issues),
    artifacts,
  };
}

function readRegularJson(path: string, label: string): unknown {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function validateSamples(value: unknown): CampaignSamplesDocument {
  const row = objectValue(value, "AgentTeamCampaignSamples");
  exactKeys(row, ["schema", "campaignId", "samples"], "AgentTeamCampaignSamples");
  if (row.schema !== AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA) throw new Error(`AgentTeamCampaignSamples.schema must be ${AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA}`);
  const campaignId = stringValue(row.campaignId, "AgentTeamCampaignSamples.campaignId");
  if (!Array.isArray(row.samples) || row.samples.length === 0) throw new Error("AgentTeamCampaignSamples.samples must not be empty");
  const samples = row.samples.map((value, index): CampaignSample => {
    const sample = objectValue(value, `AgentTeamCampaignSamples.samples[${index}]`);
    exactKeys(sample, ["variantId", "rootThreadId", "turnId", "caseHash", "trial", "stratum", "expectedSkillState", "l1Passed", "l3Status", "manualInterventions", "expectedSpawn", "writerConflict", "reviewSnapshotDrift", "parentChildDuplicateReads", "outcomeEvidenceRef"], `AgentTeamCampaignSamples.samples[${index}]`);
    if (typeof sample.l1Passed !== "boolean") throw new Error(`AgentTeamCampaignSamples.samples[${index}].l1Passed must be boolean`);
    const duplicateReads = sample.parentChildDuplicateReads === null ? null : integer(sample.parentChildDuplicateReads, `AgentTeamCampaignSamples.samples[${index}].parentChildDuplicateReads`);
    return {
      variantId: stringValue(sample.variantId, `AgentTeamCampaignSamples.samples[${index}].variantId`),
      rootThreadId: stringValue(sample.rootThreadId, `AgentTeamCampaignSamples.samples[${index}].rootThreadId`),
      turnId: stringValue(sample.turnId, `AgentTeamCampaignSamples.samples[${index}].turnId`),
      caseHash: stringValue(sample.caseHash, `AgentTeamCampaignSamples.samples[${index}].caseHash`, HASH_PATTERN),
      trial: integer(sample.trial, `AgentTeamCampaignSamples.samples[${index}].trial`, 1),
      stratum: stringValue(sample.stratum, `AgentTeamCampaignSamples.samples[${index}].stratum`),
      expectedSkillState: enumValue(sample.expectedSkillState, ["loaded", "absent"] as const, `AgentTeamCampaignSamples.samples[${index}].expectedSkillState`),
      l1Passed: sample.l1Passed,
      l3Status: enumValue(sample.l3Status, ["pass", "fail", "inconclusive"] as const, `AgentTeamCampaignSamples.samples[${index}].l3Status`),
      manualInterventions: integer(sample.manualInterventions, `AgentTeamCampaignSamples.samples[${index}].manualInterventions`),
      expectedSpawn: enumValue(sample.expectedSpawn, ["spawn", "no_spawn", "not_scored"] as const, `AgentTeamCampaignSamples.samples[${index}].expectedSpawn`),
      writerConflict: enumValue(sample.writerConflict, ["present", "absent", "unknown"] as const, `AgentTeamCampaignSamples.samples[${index}].writerConflict`),
      reviewSnapshotDrift: enumValue(sample.reviewSnapshotDrift, ["present", "absent", "unknown"] as const, `AgentTeamCampaignSamples.samples[${index}].reviewSnapshotDrift`),
      parentChildDuplicateReads: duplicateReads,
      outcomeEvidenceRef: validateReference(sample.outcomeEvidenceRef, `AgentTeamCampaignSamples.samples[${index}].outcomeEvidenceRef`),
    };
  });
  const keys = samples.map((sample) => `${sample.variantId}|${sample.caseHash}|${sample.trial}`);
  if (new Set(keys).size !== keys.length) throw new Error("AgentTeamCampaignSamples contains a duplicate variant/case/trial sample");
  return { schema: AGENT_TEAM_CAMPAIGN_SAMPLES_SCHEMA, campaignId, samples };
}

function persistCampaignResult(directory: string, value: Omit<Row, "subjectHash" | "artifactRef">): { artifactRef: string; persistence: Persistence } {
  const subjectHash = sha256(canonical(value));
  const artifactRef = validateReference(`artifact://agent-team-campaign-result/${subjectHash}`, "Agent Team Campaign resultRef");
  const document = { ...value, subjectHash, artifactRef };
  return { artifactRef, persistence: persistBytes(directory, `${subjectHash}.json`, `${JSON.stringify(document, null, 2)}\n`) };
}

function persistObservationDocument(directory: string, campaignId: string, observations: CampaignObservation[]): Persistence {
  const document = { schema: CAMPAIGN_OBSERVATIONS_SCHEMA, campaignId, observations };
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  const hash = sha256(bytes);
  return persistBytes(join(directory, campaignId), `${hash}.json`, bytes);
}

function routingOutcome(expected: ExpectedSpawn, actualSpawnCount: number): "correct" | "false_positive" | "false_negative" | "not_scored" {
  if (expected === "not_scored") return "not_scored";
  const actual = actualSpawnCount > 0 ? "spawn" : "no_spawn";
  if (actual === expected) return "correct";
  return expected === "no_spawn" ? "false_positive" : "false_negative";
}

export function runAgentTeamCampaign(options: RunAgentTeamCampaignOptions): AgentTeamCampaignEnvelope {
  const manifest = validateCampaignManifest(readRegularJson(resolve(options.manifestPath), "Campaign manifest"));
  const sampleDocument = validateSamples(readRegularJson(resolve(options.samplesPath), "Agent Team Campaign samples"));
  if (sampleDocument.campaignId !== manifest.campaignId) throw new Error("Agent Team Campaign sample identity does not match the Campaign manifest");
  const loaded = loadSelectedRolloutFacts(options.sessionRoots, new Set(sampleDocument.samples.map((sample) => sample.rootThreadId)));
  if (loaded.issues.length > 0) throw new Error("Agent Team Campaign cannot use malformed rollout evidence");
  const byThread = new Map(loaded.facts.map((fact) => [fact.threadId, fact]));
  const observations: CampaignObservation[] = [];
  const outcomes: Array<ReturnType<typeof routingOutcome>> = [];
  for (const sample of sampleDocument.samples) {
    const variant = sample.variantId === manifest.baseline.id ? manifest.baseline : sample.variantId === manifest.candidate.id ? manifest.candidate : null;
    if (!variant) throw new Error(`Agent Team Campaign sample variant is not frozen by manifest: ${sample.variantId}`);
    const root = byThread.get(sample.rootThreadId);
    if (!root || root.parentThreadId) throw new Error("Agent Team Campaign root rollout was not found");
    const turn = root.turns.find((item) => item.turnId === sample.turnId);
    if (!turn) throw new Error("Agent Team Campaign turn was not found");
    const telemetry = buildTelemetry(root, turn, loaded.facts);
    if (!telemetry) throw new Error(`Agent Team Campaign turn is not terminal for run://codex/${sample.rootThreadId}/${sample.turnId}`);
    if (!telemetry.completeness.tokens || !telemetry.completeness.descendants) throw new Error(`Agent Team Campaign rollout evidence is incomplete for ${telemetry.subjectRef}: tokens=${telemetry.completeness.tokens}, descendants=${telemetry.completeness.descendants}`);
    const loadedSkill = telemetry.plugin.state === "installed" || telemetry.plugin.state === "workspace";
    if ((sample.expectedSkillState === "loaded") !== loadedSkill) throw new Error(`Agent Team Campaign Skill state does not match the labelled variant for ${telemetry.subjectRef}`);
    if (telemetry.runtime.controlHash !== manifest.controlHash) throw new Error("Agent Team Campaign runtime controls do not match the frozen manifest");
    persistTelemetry(resolve(options.telemetryRoot), telemetry);
    const outcome = routingOutcome(sample.expectedSpawn, telemetry.collaboration.spawnAgent);
    outcomes.push(outcome);
    const result = persistCampaignResult(resolve(options.resultRoot), {
      schema: AGENT_TEAM_CAMPAIGN_RESULT_SCHEMA,
      campaignId: manifest.campaignId,
      campaignVersion: manifest.campaignVersion,
      variantId: sample.variantId,
      variantRef: variant.harnessRef,
      caseRef: validateReference(`case://agent-team/${sample.caseHash}`, "Agent Team Campaign caseRef"),
      trial: sample.trial,
      stratum: sample.stratum,
      telemetryRef: telemetry.artifactRef,
      outcomeEvidenceRef: sample.outcomeEvidenceRef,
      quality: { l1Passed: sample.l1Passed, l3Status: sample.l3Status, manualInterventions: sample.manualInterventions },
      routing: { expectedSpawn: sample.expectedSpawn, actualSpawnCount: telemetry.collaboration.spawnAgent, outcome },
      safety: { writerConflict: sample.writerConflict, reviewSnapshotDrift: sample.reviewSnapshotDrift, parentChildDuplicateReads: sample.parentChildDuplicateReads },
    });
    observations.push({
      schema: CAMPAIGN_OBSERVATION_SCHEMA,
      campaignId: manifest.campaignId,
      variantId: sample.variantId,
      caseHash: sample.caseHash,
      trial: sample.trial,
      stratum: sample.stratum,
      controlHash: manifest.controlHash,
      l1Passed: sample.l1Passed,
      l3Status: sample.l3Status,
      l2: { tokens: telemetry.cost.totalTokens, wallTimeMs: telemetry.execution.wallTimeMs, manualInterventions: sample.manualInterventions },
      resultRef: result.artifactRef,
    });
  }
  const observationsPersistence = persistObservationDocument(resolve(options.observationsRoot), manifest.campaignId, observations);
  const campaign = evaluateCampaignFiles(resolve(options.manifestPath), observationsPersistence.path, resolve(options.campaignReportRoot));
  const writerConflicts = sampleDocument.samples.filter((sample) => sample.writerConflict === "present").length;
  const reviewDrifts = sampleDocument.samples.filter((sample) => sample.reviewSnapshotDrift === "present").length;
  return {
    schema: AGENT_TEAM_CAMPAIGN_ENVELOPE_SCHEMA,
    monitoring: {
      sampleCount: sampleDocument.samples.length,
      qualityLabelled: sampleDocument.samples.length,
      correctSpawnDecisions: outcomes.filter((value) => value === "correct").length,
      falsePositiveSpawns: outcomes.filter((value) => value === "false_positive").length,
      falseNegativeSpawns: outcomes.filter((value) => value === "false_negative").length,
      spawnNotScored: outcomes.filter((value) => value === "not_scored").length,
      writerConflicts,
      writerConflictUnknown: sampleDocument.samples.filter((sample) => sample.writerConflict === "unknown").length,
      reviewSnapshotDrifts: reviewDrifts,
      reviewSnapshotDriftUnknown: sampleDocument.samples.filter((sample) => sample.reviewSnapshotDrift === "unknown").length,
      duplicateReadLabels: sampleDocument.samples.filter((sample) => sample.parentChildDuplicateReads !== null).length,
    },
    observationsPersistence,
    campaign,
  };
}
