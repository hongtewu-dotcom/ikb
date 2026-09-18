import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { validateReference } from "./eval-contract.ts";
import {
  EVAL_RECEIPT_SCHEMA,
  persistEvalReceipt,
  validateEvalReceipt,
  type EvalReceipt,
} from "./evaluation-receipt.ts";
import {
  activateIkbUsageV2,
  ikbUsageV2Paths,
  projectIkbUsageV2,
  projectIkbUsageV2Corrections,
  projectIkbUsageV2MissedLookups,
  readIkbUsageV2Summary,
  readIkbUsageV2Activation,
  type IkbUsageAttemptOutcome,
  type IkbUsageOperation,
  type IkbUsagePurpose,
  type IkbUsageRelationship,
  type IkbUsageV2Attempt,
  type IkbUsageV2EvidenceDetail,
  type IkbUsageV2Origin,
  type IkbUsageV2Read,
  type IkbUsageV2Search,
  type IkbUsageV2State,
} from "./ikb-usage-v2.ts";

export const IKB_RECALL_EVAL_DETAIL_SCHEMA = "ikb-recall-eval-detail-v1";
export const IKB_RECALL_COLLECTION_SCHEMA = "ikb-recall-rollout-collection-v1";
export const IKB_RECALL_CURSOR_SCHEMA = "ikb-recall-collector-cursor-v1";
export const IKB_RECALL_FEEDBACK_SCHEMA = "ikb-recall-evaluated-feedback-v1";
export const IKB_RECALL_CORRECTION_SCHEMA = "ikb-recall-user-correction-v1";
export const IKB_RECALL_FEEDBACK_SUMMARY_SCHEMA = "ikb-recall-feedback-summary-v1";
export const IKB_RECALL_SEARCH_RESULT_SCHEMA = "ikb-card-search-result-v1";
export const IKB_RECALL_READ_RESULT_SCHEMA = "ikb-card-read-result-v1";
export const IKB_RECALL_SUITE_ID = "ikb-recall-real-use";
export const IKB_RECALL_SUITE_VERSION = "v1";
export const IKB_RECALL_GRADER_VERSION = "recall-evidence-v2";
export const IKB_RECALL_MONITORING_START = "2026-09-01T00:00:00.000Z";

const MAX_JSONL_LINE_LENGTH = 8 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type Row = Record<string, unknown>;
export type IkbRecallCardState =
  | "recalled_not_read"
  | "read_adopted"
  | "read_unresolved"
  | "explicitly_rejected_stale"
  | "explicitly_rejected_incorrect";

interface SearchItem {
  cardId: string;
  path: string;
  contentHash: string;
}

interface SearchResult {
  retrievalId: string;
  scope: "work" | "personal";
  queryHash: string;
  total: number;
  zeroResult: boolean;
  items: SearchItem[];
}

interface ReadResult {
  retrievalId: string;
  scope: "work" | "personal";
  cardId: string;
  path: string;
  contentHash: string;
}

interface TurnFacts {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  finalText: string;
  userMessages: string[];
  feedbackTexts: string[];
  searches: SearchResult[];
  reads: ReadResult[];
  ikbCalls: number;
  issues: string[];
  usagePurpose?: IkbUsagePurpose;
  taskPurpose?: IkbUsagePurpose;
  attempts?: IkbUsageAttempt[];
}

interface IkbUsageAttempt {
  operation: IkbUsageOperation;
  outcome: IkbUsageAttemptOutcome;
  sourceEventRef: string;
  observedAt: string | null;
  purpose?: IkbUsagePurpose;
  reasonCode?: string;
  queryHash?: string;
  retrievalId?: string;
  cardId?: string;
  contentHash?: string;
  result?: SearchResult | ReadResult;
}

interface RolloutFacts {
  threadId: string;
  parentThreadId: string | null;
  // session_meta 里的字符串形态 source（"exec"/"vscode"/"cli"/"mcp"）；subagent 会话该字段是对象，记为 null。
  // 用于区分“真人在键盘前”的交互会话与批处理/工具调用会话——后者的“用户消息”是任务提示词本身。
  sessionSource: string | null;
  usagePurpose: IkbUsagePurpose;
  relationship: IkbUsageRelationship;
  subagentDepth: number | null;
  agentRole: string | null;
  turns: TurnFacts[];
}

export interface UserCorrectionRecord {
  schema: typeof IKB_RECALL_CORRECTION_SCHEMA;
  correctionKey: string;
  detectedAt: string;
  subjectRef: string;
  label: string;
  excerpt: string;
  hadIkbCall: boolean;
  classification?: "candidate";
  matchedRule?: string;
  matchedText?: string;
  sourceEventRef?: string;
}

// 模式库 v1：从吴鸿腾 2026-09-01/02 真实纠正原话提取（"这个有卡吗""别起到反效果"等）。
// 原则：宁可多记进待审清单，人审剔误报；不许为了精确率漏掉真纠正。
export const USER_CORRECTION_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "card_exists_question", pattern: /有卡[吗啊呢？?]|这个有卡|是不是有卡/ },
  { label: "missed_lookup", pattern: /(?:怎么|为什么|咋).{0,8}(?:没|不|不去|没有).{0,4}(?:查|搜|召回)/ },
  { label: "missed_lookup", pattern: /(?:没|不|不去|不主动|没有).{0,4}(?:查|搜|召回).{0,10}(?:卡|ikb|记忆|memory|知识库)/i },
  { label: "missed_lookup", pattern: /不.{0,2}主动.{0,6}(?:查|搜|召回)/ },
  { label: "lookup_question", pattern: /查过[吗了]|搜过[吗了]|召回过[吗了]/ },
  { label: "distrust", pattern: /(?<![候下])别信|不要信|不能信|别听它的/ },
  { label: "stale", pattern: /过期了|已过期|过时了|那都什么时候的/ },
  { label: "adverse_effect", pattern: /反效果|起反作用|帮倒忙/ },
  { label: "incorrect", pattern: /不是这么回事|说得不对|搞错了|弄错了|你搞错|(?:卡片|知识卡|这张卡|该卡).{0,16}(?:错误|有误|不正确)/ },
  // style_drift：判断/风格漂移纠正——不是事实错，是回答被染色（原则卡跑偏的主信号）。
  // 样本："不太讲人话你""别叫电池了"（2026-09-02 吴鸿腾原话）
  { label: "style_drift", pattern: /讲人话|说人话|不太.{0,4}人话/ },
  { label: "style_drift", pattern: /太啰嗦|别绕|简单点|说重点|直接说|长篇大论/ },
  { label: "style_drift", pattern: /不用这么复杂|过度设计|别加太多|搞这么复杂/ },
  { label: "style_drift", pattern: /别叫.{0,6}了|别再用.{0,4}词|哪来的.{0,6}词/ },
];

// 第三刀："该查没查"抽检。turn 内零 ikb 调用但用户消息出现工作类关键词 → 进待审清单。
// 自动判定"该不该查"做不准，这只是抽检清单，每周人审。
export const MISSED_LOOKUP_KEYWORDS = /服务归属|团队分工|职责边界|责任边界|排查|验价失败|预订失败|生单失败|评审意见|故障处置/;

export interface MissedLookupCandidate {
  schema: "ikb-recall-missed-lookup-candidate-v1";
  candidateKey: string;
  detectedAt: string;
  subjectRef: string;
  excerpt: string;
}

export function scanMissedLookup(threadId: string, turn: TurnFacts): MissedLookupCandidate | null {
  if (!turn.completedAt || turn.ikbCalls > 0) return null;
  const sources = [...turn.userMessages, ...turn.feedbackTexts];
  for (const text of sources) {
    if (!text || text.length > 20_000 || isInjectedContext(text)) continue;
    const match = MISSED_LOOKUP_KEYWORDS.exec(text);
    if (!match) continue;
    const excerpt = text.slice(0, CORRECTION_EXCERPT_MAX).replace(/\s+/g, " ").trim();
    return {
      schema: "ikb-recall-missed-lookup-candidate-v1",
      candidateKey: sha256(`${threadId}\n${turn.turnId}`),
      detectedAt: turn.completedAt,
      subjectRef: `run://codex/${threadId}/${turn.turnId}`,
      excerpt,
    };
  }
  return null;
}

const MISSED_LOOKUP_CAP = 200;

export function projectMissedLookups(activeDataRoot: string, incoming: MissedLookupCandidate[]): number {
  if (incoming.length === 0) return 0;
  const usageRoot = resolve(activeDataRoot, "usage");
  ensureDirectory(usageRoot);
  const path = resolve(usageRoot, "missed-lookup-candidates.jsonl");
  const existing: MissedLookupCandidate[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as MissedLookupCandidate;
        if (row.schema === "ikb-recall-missed-lookup-candidate-v1" && typeof row.candidateKey === "string") existing.push(row);
      } catch {
        // 跳过坏行
      }
    }
  }
  const byKey = new Map(existing.map((record) => [record.candidateKey, record]));
  let added = 0;
  for (const record of incoming) {
    if (!byKey.has(record.candidateKey)) added += 1;
    byKey.set(record.candidateKey, record);
  }
  if (added === 0) return 0;
  // 只保留最近 MISSED_LOOKUP_CAP 条——这是抽检清单不是档案，无限增长会失去可审性
  const merged = [...byKey.values()]
    .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.candidateKey.localeCompare(right.candidateKey))
    .slice(-MISSED_LOOKUP_CAP);
  atomicReplace(path, `${merged.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return added;
}


const CORRECTION_EXCERPT_MAX = 160;

// 系统注入的上下文会伪装成 user 消息进日志（AGENTS.md 全文、插件推荐、environment_context），
// 其中含我们自己的规则文本（“什么时候别信”），不过滤会把注入当成用户纠正。
const INJECTED_CONTEXT_MARKERS = [
  "# AGENTS.md instructions",
  "<INSTRUCTIONS>",
  "<recommended_plugins>",
  "environment_context",
  "<user_instructions>",
];

function isInjectedContext(text: string): boolean {
  const head = text.slice(0, 500);
  return INJECTED_CONTEXT_MARKERS.some((marker) => head.includes(marker));
}

// These two concrete shapes were observed in the 2026-09-15 diagnostic.  The
// first describes an expired login/session, not an expired knowledge card.  The
// second is a pasted maintenance report whose wording happens to contain a
// style rule.  Keep both out of the candidate stream while retaining ordinary
// explicit card corrections as candidates.
function isKnownNonCorrection(text: string, label: string): boolean {
  if (label === "stale" && /(?:认证|登录|授权|会话|token|auth|session).{0,24}(?:过期|失效|expired|stale)/iu.test(text)) return true;
  if (label === "style_drift" && /(?:IKB\s*反馈|候选卡|维护流程).{0,80}(?:落地|已按|说明|报告)/iu.test(text)) return true;
  return false;
}

export function scanUserCorrections(threadId: string, turn: TurnFacts): UserCorrectionRecord[] {
  if (!turn.completedAt) return [];
  // feedbackTexts = 后一轮用户消息（对本 turn 输出的反应），是纠正的主现场；
  // userMessages = 本 turn 内的用户消息（中途打断式纠正），一并扫。
  const sources = [...turn.feedbackTexts, ...turn.userMessages];
  const records: UserCorrectionRecord[] = [];
  const seen = new Set<string>();
  for (const text of sources) {
    if (!text || text.length > 20_000 || isInjectedContext(text)) continue;
    for (const { label, pattern } of USER_CORRECTION_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (isKnownNonCorrection(text, label)) continue;
      const excerpt = text.slice(0, CORRECTION_EXCERPT_MAX).replace(/\s+/g, " ").trim();
      const key = sha256(`${threadId}\n${turn.turnId}\n${label}\n${excerpt}`);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        schema: IKB_RECALL_CORRECTION_SCHEMA,
        correctionKey: key,
        detectedAt: turn.completedAt,
        subjectRef: `run://codex/${threadId}/${turn.turnId}`,
        label,
        excerpt,
        hadIkbCall: turn.ikbCalls > 0,
        classification: "candidate",
        matchedRule: label,
        matchedText: match[0],
        sourceEventRef: `run://codex/${threadId}/${turn.turnId}`,
      });
    }
  }
  return records;
}

export function projectCorrections(activeDataRoot: string, incoming: UserCorrectionRecord[]): number {
  if (incoming.length === 0) return 0;
  const usageRoot = resolve(activeDataRoot, "usage");
  ensureDirectory(usageRoot);
  const path = resolve(usageRoot, "user-corrections.jsonl");
  const existing: UserCorrectionRecord[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as UserCorrectionRecord;
        if (row.schema === IKB_RECALL_CORRECTION_SCHEMA && typeof row.correctionKey === "string") existing.push(row);
      } catch {
        // 跳过坏行，不阻断收集
      }
    }
  }
  const byKey = new Map(existing.map((record) => [record.correctionKey, record]));
  let added = 0;
  for (const record of incoming) {
    const prior = byKey.get(record.correctionKey);
    if (prior && correctionCanonical(prior) !== correctionCanonical(record)) throw new Error("IKB user correction key collision");
    if (!prior) added += 1;
    byKey.set(record.correctionKey, record);
  }
  if (added === 0) return 0;
  const merged = [...byKey.values()].sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.correctionKey.localeCompare(right.correctionKey));
  atomicReplace(path, `${merged.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return added;
}

interface CollectorCursor {
  schema: typeof IKB_RECALL_CURSOR_SCHEMA;
  lastCompletedAt: string;
  lastTurnKeys: string[];
}

export interface IkbRecallCardEvaluation {
  cardId: string;
  retrievalIds: string[];
  state: IkbRecallCardState;
  reasonCode:
    | "search_result_not_read"
    | "read_card_reference_listed_in_final"
    | "read_without_final_adoption_evidence"
    | "final_explicit_stale_rejection"
    | "final_explicit_incorrect_rejection";
}

export interface IkbRecallEvalDetail {
  schema: typeof IKB_RECALL_EVAL_DETAIL_SCHEMA;
  collectorVersion: "v1";
  subjectVersion: "codex-completed-turn.v1";
  subjectRef: string;
  subjectHash: string;
  completedAt: string;
  retrievals: Array<{
    retrievalId: string;
    scope: "work" | "personal";
    resultCardIds: string[];
    resultOrder?: string[];
    zeroResult: boolean;
  }>;
  cards: IkbRecallCardEvaluation[];
  metrics: {
    recallCount: number;
    resultCardCount: number;
    readCount: number;
    adoptedCount: number;
    recalledNotReadCount: number;
    readUnresolvedCount: number;
    zeroResultCount: number;
    explicitCorrectionCount: number;
  };
}

interface FeedbackRecord {
  schema: typeof IKB_RECALL_FEEDBACK_SCHEMA;
  evaluationKey: string;
  evaluatedAt: string;
  cardId: string;
  state: IkbRecallCardState;
  reasonCode: IkbRecallCardEvaluation["reasonCode"];
}

interface FeedbackSummary {
  schema: typeof IKB_RECALL_FEEDBACK_SUMMARY_SCHEMA;
  updatedAt: string;
  evaluationCount: number;
  feedbackCount: number;
  recallCount: number;
  resultCardCount: number;
  readCount: number;
  zeroResultCount: number;
  explicitCorrectionCount: number;
  states: Record<IkbRecallCardState, number>;
  cards: Array<{
    cardId: string;
    evaluationCount: number;
    states: Record<IkbRecallCardState, number>;
  }>;
  processedEvaluationKeys: string[];
}

export interface CollectIkbRecallOptions {
  sessionRoots: string[];
  activeDataRoot: string;
  evaluationHome?: string;
  from?: string;
  to?: string;
  lockTimeoutMs?: number;
}

export interface IkbRecallCollectionReport {
  schema: typeof IKB_RECALL_COLLECTION_SCHEMA;
  status: "ready" | "degraded" | "unavailable" | "busy";
  window: { from: string; to: string };
  scannedFiles: number;
  completedTurns: number;
  matchedTurns: number;
  persisted: number;
  reused: number;
  userCorrectionsFound: number;
  userCorrectionsAdded: number;
  missedLookupCandidatesFound: number;
  missedLookupCandidatesAdded: number;
  skippedIncomplete: number;
  issues: Array<{ reasonCode: string; count: number }>;
  evaluations: Array<{
    subjectRef: string;
    subjectHash: string;
    evaluationKey: string;
    detailHash: string;
    detailReused: boolean;
    receiptRef: string;
    receiptReused: boolean;
    feedbackCount: number;
  }>;
}

function objectValue(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Row;
}

function exactKeys(row: Row, allowed: readonly string[], label: string): void {
  const extras = Object.keys(row).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in row));
  if (extras.length > 0 || missing.length > 0) throw new Error(`${label} fields do not match the contract`);
}

function optionalObject(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifier(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!ID_PATTERN.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function absolutePath(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return resolve(result);
}

function hashValue(value: unknown, label: string): string {
  const result = nonEmptyString(value, label).toLowerCase();
  if (!HASH_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(Date.parse(result)).toISOString();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const row = value as Row;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function correctionCanonical(value: UserCorrectionRecord | Record<string, unknown>): string {
  const row = value as Record<string, unknown>;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    const row = optionalObject(item);
    return optionalString(row?.text) ?? optionalString(row?.content) ?? "";
  }).filter(Boolean).join("\n");
}

function toolMatches(name: string, suffix: "ikb_search_cards" | "ikb_get_card"): boolean {
  return name === suffix || name.endsWith(`__${suffix}`) || name.endsWith(`.${suffix}`) || name.endsWith(`/${suffix}`);
}

export type IkbCliOperation = "search" | "get";

type ShellWord = { value: string; quoted: boolean };

function shellWords(command: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let segment: ShellWord[] = [];
  let value = "";
  let quoted = false;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let comment = false;
  const flush = (): void => {
    if (value) segment.push({ value, quoted });
    value = "";
    quoted = false;
  };
  const flushSegment = (): void => {
    flush();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (comment) {
      if (char === "\n") comment = false;
      else continue;
    }
    if (escaped) {
      value += char;
      quoted = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
      quoted = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\") escaped = true;
      else value += char;
      quoted = true;
      continue;
    }
    if (quote === "`") {
      if (char === "`") quote = null;
      else value += char;
      quoted = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === "#" && !value && segment.length === 0) {
      comment = true;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      flushSegment();
      if ((char === "&" || char === "|") && command[index + 1] === char) index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    value += char;
  }
  if (escaped) value += "\\";
  flushSegment();
  return segments;
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1) ?? value;
}

function cliOperationFromWords(words: ShellWord[]): IkbCliOperation | null {
  if (words.length === 0) return null;
  let index = 0;
  while (index < words.length && !words[index].quoted && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index].value)) index += 1;
  if (index >= words.length) return null;
  let executable = basename(words[index].value);
  if (executable === "env" || executable === "command" || executable === "builtin" || executable === "sudo") {
    index += 1;
    while (index < words.length && (!words[index].quoted && (words[index].value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index].value)))) index += 1;
    if (index >= words.length) return null;
    executable = basename(words[index].value);
  }
  if (executable === "ikb") {
    const operation = words[index + 1]?.value;
    return operation === "search" || operation === "get" ? operation : null;
  }
  if (executable !== "node" && executable !== "nodejs") return null;
  const scriptIndex = nodeScriptIndex(words, index);
  if (scriptIndex < 0) return null;
  const operation = words[scriptIndex + 1]?.value;
  return operation === "search" || operation === "get" ? operation : null;
}

function nodeScriptIndex(words: ShellWord[], nodeIndex: number): number {
  const optionsWithValue = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
  for (let index = nodeIndex + 1; index < words.length; index += 1) {
    const value = words[index].value;
    if (value === "--") return basename(words[index + 1]?.value ?? "") === "ikb-cards-cli.mjs" ? index + 1 : -1;
    if (value === "-e" || value === "--eval" || value === "-p" || value === "--print" || value === "-c" || value === "--check") return -1;
    if (value.startsWith("-e=") || value.startsWith("--eval=") || value.startsWith("-p=") || value.startsWith("--print=")) return -1;
    if (optionsWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return basename(value) === "ikb-cards-cli.mjs" ? index : -1;
  }
  return -1;
}

function cliOperationsFromCommand(command: string): IkbCliOperation[] {
  return shellWords(command).map(cliOperationFromWords).filter((value): value is IkbCliOperation => value !== null);
}

function decodeCommandLiteral(quote: string, body: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${body}"`) as string;
    } catch {
      return body.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
  }
  return body.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

function commandLiterals(text: string): string[] {
  const values: string[] = [];
  const isIdentifierStart = (char: string): boolean => /[A-Za-z_$]/.test(char);
  const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (/\s/.test(text[index] ?? "")) index += 1;
    return index;
  };
  const readLiteral = (start: number, quote: string): { value: string; end: number } | null => {
    let body = "";
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        body += `\\${char}`;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return { value: decodeCommandLiteral(quote, body), end: index + 1 };
      } else {
        body += char;
      }
    }
    return null;
  };
  const readInvocation = (start: number): { value: string; end: number } | null => {
    if (!text.startsWith("exec_command", start)) return null;
    const before = text[start - 1] ?? "";
    const after = text[start + "exec_command".length] ?? "";
    if (isIdentifierPart(before) || isIdentifierPart(after)) return null;
    if (!/(?:^|[^A-Za-z0-9_$.])tools\s*\.\s*$/.test(text.slice(0, start))) return null;
    let cursor = skipWhitespace(start + "exec_command".length);
    if (text[cursor] !== "(") return null;
    cursor = skipWhitespace(cursor + 1);
    if (text[cursor] !== "{") return null;
    cursor = skipWhitespace(cursor + 1);
    const propertyStart = cursor;
    while (isIdentifierPart(text[cursor] ?? "")) cursor += 1;
    const property = text.slice(propertyStart, cursor);
    if (property !== "cmd" && property !== "command") return null;
    cursor = skipWhitespace(cursor);
    if (text[cursor] !== ":") return null;
    cursor = skipWhitespace(cursor + 1);
    const quote = text[cursor];
    if (quote !== "'" && quote !== '"' && quote !== "`") return null;
    return readLiteral(cursor + 1, quote);
  };
  for (let index = 0; index < text.length;) {
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index + 2);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    const char = text[index];
    if (char === "'" || char === '"' || char === "`") {
      const literal = readLiteral(index + 1, char);
      index = literal?.end ?? text.length;
      continue;
    }
    const invocation = readInvocation(index);
    if (invocation) {
      values.push(invocation.value);
      index = invocation.end;
      continue;
    }
    index += 1;
  }
  return values;
}

function commandStrings(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return found;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > MAX_JSONL_LINE_LENGTH) return found;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return commandStrings(parsed, found, depth + 1);
    } catch {
      // Direct shell tools carry a command as a string; functions.exec carries JS source.
    }
    found.push(text);
    found.push(...commandLiterals(text));
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) commandStrings(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;
  const row = value as Row;
  for (const key of ["cmd", "command", "commands"]) {
    if (key in row) commandStrings(row[key], found, depth + 1);
  }
  return found;
}

/** Returns only operations found in an actual shell command invocation. */
export function detectIkbCliOperations(value: unknown): IkbCliOperation[] {
  const operations: IkbCliOperation[] = [];
  for (const command of commandStrings(value)) operations.push(...cliOperationsFromCommand(command));
  return operations;
}

/**
 * Reads the explicit purpose marker from a recorded shell command.  A bare
 * source such as `exec` or `cli` carries no purpose information and therefore
 * intentionally returns null here.
 */
export function detectIkbUsagePurpose(value: unknown): IkbUsagePurpose | null {
  const purposes = new Set<IkbUsagePurpose>();
  for (const command of commandStrings(value)) {
    // The maintenance launcher also places the marker at the beginning of
    // the task prompt (`...=maintenance。执行 ...`).  Keep the marker
    // explicit while accepting shell and Chinese punctuation as boundaries.
    for (const match of command.matchAll(/(?:^|[\s"'`;&|])IKB_USAGE_PURPOSE=(interactive|maintenance|regression)(?=$|[\s"'`;&|,.:：,，;；。！？])/g)) {
      purposes.add(match[1] as IkbUsagePurpose);
    }
    for (const words of shellWords(command)) {
      for (const word of words) {
        const match = /^(?:IKB_USAGE_PURPOSE)=(interactive|maintenance|regression)$/.exec(word.value);
        if (match) purposes.add(match[1] as IkbUsagePurpose);
      }
    }
  }
  return purposes.size === 1 ? [...purposes][0] : null;
}

function detectIkbTaskPurpose(value: unknown): IkbUsagePurpose | null {
  // This marker is a task prefix, so inspect the original message only.  Do
  // not mine quoted command literals from a long prompt, which could turn an
  // example or pasted shell command into the task's default purpose.
  if (typeof value !== "string") return null;
  const match = /^\s*IKB_USAGE_PURPOSE=(interactive|maintenance|regression)(?=$|[\s"'`;&|,.:：,，;；。！？])/.exec(value.trim());
  return match ? match[1] as IkbUsagePurpose : null;
}

function parseSearchResult(value: unknown): SearchResult {
  const row = objectValue(value, "IKB search result");
  if (row.schema !== IKB_RECALL_SEARCH_RESULT_SCHEMA) throw new Error("IKB search result schema is invalid");
  const scope = nonEmptyString(row.scope, "IKB search scope");
  if (scope !== "work" && scope !== "personal") throw new Error("IKB search scope is invalid");
  hashValue(row.queryHash, "IKB search queryHash");
  const total = nonNegativeInteger(row.total, "IKB search total");
  const count = nonNegativeInteger(row.count, "IKB search count");
  nonNegativeInteger(row.offset, "IKB search offset");
  booleanValue(row.hasMore, "IKB search hasMore");
  if (row.nextOffset !== null) nonNegativeInteger(row.nextOffset, "IKB search nextOffset");
  const zeroResult = booleanValue(row.zeroResult, "IKB search zeroResult");
  if (!Array.isArray(row.items)) throw new Error("IKB search items must be an array");
  const items = row.items.map((value, index): SearchItem => {
    const item = objectValue(value, `IKB search item ${index}`);
    nonEmptyString(item.title, `IKB search item ${index} title`);
    if (!Array.isArray(item.matchedFields) || item.matchedFields.some((field) => typeof field !== "string")) throw new Error("IKB search matchedFields is invalid");
    if (typeof item.snippet !== "string") throw new Error("IKB search snippet is invalid");
    return {
      cardId: identifier(item.cardId, `IKB search item ${index} cardId`),
      path: absolutePath(item.path, `IKB search item ${index} path`),
      contentHash: hashValue(item.contentHash, `IKB search item ${index} contentHash`),
    };
  });
  if (count !== items.length || total < count || zeroResult !== (total === 0) || (zeroResult && items.length !== 0)) {
    throw new Error("IKB search result counts are inconsistent");
  }
  return { retrievalId: identifier(row.retrievalId, "IKB search retrievalId"), scope, queryHash: hashValue(row.queryHash, "IKB search queryHash"), total, zeroResult, items };
}

function parseReadResult(value: unknown): ReadResult {
  const row = objectValue(value, "IKB read result");
  if (row.schema !== IKB_RECALL_READ_RESULT_SCHEMA) throw new Error("IKB read result schema is invalid");
  const scope = nonEmptyString(row.scope, "IKB read scope");
  if (scope !== "work" && scope !== "personal") throw new Error("IKB read scope is invalid");
  const card = objectValue(row.card, "IKB read card");
  nonEmptyString(card.title, "IKB read card title");
  if (typeof card.whenNotTrust !== "string" || typeof card.markdown !== "string") throw new Error("IKB read card content is invalid");
  return {
    retrievalId: identifier(row.retrievalId, "IKB read retrievalId"),
    scope,
    cardId: identifier(card.cardId, "IKB read cardId"),
    path: absolutePath(card.path, "IKB read card path"),
    contentHash: hashValue(card.contentHash, "IKB read contentHash"),
  };
}

export function hasValidIkbCliResult(value: unknown, operation: IkbCliOperation): boolean {
  const expectedSchema = operation === "search" ? IKB_RECALL_SEARCH_RESULT_SCHEMA : IKB_RECALL_READ_RESULT_SCHEMA;
  const selected = new Map<string, unknown>();
  for (const candidate of candidateDocuments(value).filter((item) => optionalObject(item)?.schema === expectedSchema)) {
    selected.set(canonical(candidate), candidate);
  }
  if (selected.size !== 1) return false;
  try {
    if (operation === "search") parseSearchResult([...selected.values()][0]);
    else parseReadResult([...selected.values()][0]);
    return true;
  } catch {
    return false;
  }
}

function shellOutputLooksSuccessful(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.every(item => shellOutputLooksSuccessful(item, depth + 1));
  if (typeof value === "string") {
    try { return shellOutputLooksSuccessful(JSON.parse(value), depth + 1); } catch { return true; }
  }
  const row = optionalObject(value);
  if (row && ["input_text", "text"].includes(String(row.type)) && typeof row.text === "string") return shellOutputLooksSuccessful(row.text, depth + 1);
  if (!row) return true;
  if (row.is_error === true || row.isError === true || row.ok === false) return false;
  for (const key of ["status", "exitCode", "exit_code"]) {
    const status = row[key];
    if (typeof status === "number" && status !== 0) return false;
    if (typeof status === "string" && !["ok", "completed", "succeeded", "success", "0"].includes(status.toLowerCase())) return false;
  }
  return true;
}

function jsonObjectValuesFromText(text: string): unknown[] {
  const values: unknown[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
        continue;
      }
      if (char !== "}" && char !== "]") continue;
      if (stack.pop() !== char) break;
      if (stack.length !== 0) continue;
      try {
        values.push(JSON.parse(text.slice(start, index + 1)) as unknown);
      } catch {
        // A brace in prose or shell text is not a structured result.
      }
      break;
    }
  }
  return values;
}

function candidateDocuments(value: unknown, found: unknown[] = [], depth = 0): unknown[] {
  if (depth > 12 || value === null || value === undefined) return found;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text.length > MAX_JSONL_LINE_LENGTH) return found;
    for (const parsed of jsonObjectValuesFromText(text)) candidateDocuments(parsed, found, depth + 1);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) candidateDocuments(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;
  const row = value as Row;
  if (row.schema === IKB_RECALL_SEARCH_RESULT_SCHEMA || row.schema === IKB_RECALL_READ_RESULT_SCHEMA) found.push(row);
  for (const [key, nested] of Object.entries(row)) {
    if (key === "arguments" || key === "input" || key === "markdown" || key === "snippet" || key === "title") continue;
    candidateDocuments(nested, found, depth + 1);
  }
  return found;
}

function forEachJsonLine(path: string, visitor: (row: Row, lineNumber: number) => void): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 1;
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
        if (line.trim()) visitor(objectValue(JSON.parse(line), "rollout row"), lineNumber);
        lineNumber += 1;
      }
    }
    pending += decoder.end();
    if (pending.trim()) {
      visitor(objectValue(JSON.parse(pending), "rollout row"), lineNumber);
      lineNumber += 1;
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseRollout(path: string): RolloutFacts {
  let threadId = "";
  let parentThreadId: string | null = null;
  let sessionSource: string | null = null;
  let usagePurpose: IkbUsagePurpose = "unknown";
  let relationship: IkbUsageRelationship = "root";
  let subagentDepth: number | null = null;
  let agentRole: string | null = null;
  let currentTurnId: string | null = null;
  const turns = new Map<string, TurnFacts>();
  const calls = new Map<string, {
    turnId: string;
    name: string;
    cliOperations?: IkbCliOperation[];
    singleCommand?: string;
    nativeEventId?: string;
    sourceEventRef: string;
    purpose: IkbUsagePurpose;
  }>();
  const completedCallIds = new Set<string>();
  const acceptedResults = new Set<string>();
  const attempts = new Map<string, Map<string, IkbUsageAttempt>>();
  const ensureTurn = (turnId: string): TurnFacts => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const created: TurnFacts = { turnId, startedAt: "", completedAt: null, finalText: "", userMessages: [], feedbackTexts: [], searches: [], reads: [], ikbCalls: 0, issues: [], usagePurpose, attempts: [] };
    turns.set(turnId, created);
    return created;
  };
  const attemptRef = (turnId: string, sourceEventRef: string, operation: IkbUsageOperation): string => sha256(`${sourceEventRef}\n${operation}`);
  const recordAttempt = (turnId: string, operation: IkbUsageOperation, outcome: IkbUsageAttemptOutcome, sourceEventRef: string, observedAt: string | null, extra: Partial<IkbUsageAttempt> = {}): boolean => {
    const turn = ensureTurn(turnId);
    const key = attemptRef(turnId, sourceEventRef, operation);
    const byKey = attempts.get(turnId) ?? new Map<string, IkbUsageAttempt>();
    const prior = byKey.get(key);
    if (prior) {
      // A function_call output and its runtime completion can be two receipts
      // for one attempt.  Preserve the first outcome; a conflicting receipt
      // is retained as a diagnostic issue rather than guessed away.
      if (prior.outcome !== outcome) turn.issues.push("ikb_attempt_conflict");
      return false;
    }
    const attempt: IkbUsageAttempt = { operation, outcome, sourceEventRef, observedAt, ...extra };
    byKey.set(key, attempt);
    attempts.set(turnId, byKey);
    turn.attempts!.push(attempt);
    return true;
  };
  const setTurnPurpose = (turn: TurnFacts, purpose: IkbUsagePurpose): void => {
    if (!turn.usagePurpose || turn.usagePurpose === "unknown") turn.usagePurpose = purpose;
    else if (purpose !== "unknown" && turn.usagePurpose !== purpose) turn.usagePurpose = "unknown";
  };
  const sourceRefFor = (turnId: string, lineNumber: number, identity?: string, kind: "call" | "event" = "event"): string => {
    if (identity) return `run://codex/${threadId}/${turnId}/${kind}/${sha256(identity).slice(0, 24)}`;
    return `run://codex/${threadId}/${turnId}/event/${lineNumber}`;
  };
  const purposeForTurn = (turnId: string, markedPurpose: IkbUsagePurpose | null = null): IkbUsagePurpose => {
    const turn = ensureTurn(turnId);
    return markedPurpose ?? turn.taskPurpose ?? usagePurpose;
  };
  const safeEventTime = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    try { return timestamp(value, "IKB attempt timestamp"); } catch { return null; }
  };
  const acceptResult = (turnId: string, name: string, value: unknown, cli = false, sourceEventRef = `run://codex/${threadId}/${turnId}/unknown`, observedAt: string | null = null, purpose: IkbUsagePurpose = usagePurpose): void => {
    const operation: IkbCliOperation | null = toolMatches(name, "ikb_search_cards") ? "search"
      : toolMatches(name, "ikb_get_card") ? "get" : name === "search" || name === "get" ? name : null;
    if (!operation) return;
    const turn = ensureTurn(turnId);
    setTurnPurpose(turn, purpose);
    if (!shellOutputLooksSuccessful(value)) {
      turn.ikbCalls += 1;
      const reasonCode = cli ? "ikb_cli_failure" : "ikb_tool_failure";
      if (recordAttempt(turnId, operation, "failure", sourceEventRef, observedAt, { purpose, reasonCode })) turn.issues.push(reasonCode);
      else turn.ikbCalls -= 1;
      return;
    }
    const documents = candidateDocuments(value);
    const expectedSchema = operation === "search" ? IKB_RECALL_SEARCH_RESULT_SCHEMA : IKB_RECALL_READ_RESULT_SCHEMA;
    const selectedByContent = new Map<string, unknown>();
    for (const item of documents.filter((candidate) => optionalObject(candidate)?.schema === expectedSchema)) {
      selectedByContent.set(canonical(item), item);
    }
    const selected = [...selectedByContent.values()];
    if (selected.length !== 1) {
      turn.ikbCalls += 1;
      const ambiguous = selected.length > 1;
      const reasonCode = ambiguous ? "ikb_result_ambiguous" : "ikb_result_missing";
      if (recordAttempt(turnId, operation, ambiguous ? "unknown" : "missing", sourceEventRef, observedAt, { purpose, reasonCode })) turn.issues.push(reasonCode);
      else turn.ikbCalls -= 1;
      return;
    }
    try {
      const result = operation === "search" ? parseSearchResult(selected[0]) : parseReadResult(selected[0]);
      const resultRow = result as SearchResult | ReadResult;
      const isNewAttempt = recordAttempt(turnId, operation, "success", sourceEventRef, observedAt, {
        purpose,
        result: resultRow,
        ...(operation === "search" ? { queryHash: (resultRow as SearchResult).queryHash } : {}),
        ...(operation === "search" ? { retrievalId: resultRow.retrievalId } : { retrievalId: resultRow.retrievalId, cardId: resultRow.cardId, contentHash: resultRow.contentHash }),
      });
      if (!isNewAttempt) return;
      const resultKey = `${turnId}\n${operation}\n${canonical(result)}`;
      if (acceptedResults.has(resultKey)) return;
      acceptedResults.add(resultKey);
      turn.ikbCalls += 1;
      if (operation === "search") turn.searches.push(result as SearchResult);
      else turn.reads.push(result as ReadResult);
    } catch {
      turn.ikbCalls += 1;
      if (recordAttempt(turnId, operation, "invalid", sourceEventRef, observedAt, { purpose, reasonCode: "ikb_result_invalid" })) turn.issues.push("ikb_result_invalid");
      else turn.ikbCalls -= 1;
    }
  };

  const acceptCliResult = (turnId: string, operation: IkbCliOperation, value: unknown, sourceEventRef: string, observedAt: string | null, purpose: IkbUsagePurpose): void => {
    setTurnPurpose(ensureTurn(turnId), purpose);
    if (!shellOutputLooksSuccessful(value)) {
      const turn = ensureTurn(turnId);
      if (recordAttempt(turnId, operation, "failure", sourceEventRef, observedAt, { purpose, reasonCode: "ikb_cli_failure" })) {
        turn.ikbCalls += 1;
        turn.issues.push("ikb_cli_failure");
      }
      return;
    }
    acceptResult(turnId, operation, value, true, sourceEventRef, observedAt, purpose);
  };

  forEachJsonLine(path, (row, lineNumber) => {
    const payload = optionalObject(row.payload);
    const outerType = optionalString(row.type);
    if (outerType === "session_meta" && payload && !threadId) {
      threadId = optionalString(payload.id) ?? optionalString(payload.session_id) ?? "";
      sessionSource = optionalString(payload.source) ?? null;
      const source = optionalObject(payload.source);
      const subagent = optionalObject(source?.subagent);
      const spawn = optionalObject(subagent?.thread_spawn);
      parentThreadId = optionalString(spawn?.parent_thread_id) ?? optionalString(payload.parent_thread_id) ?? null;
      relationship = parentThreadId ? "subagent" : "root";
      const depth = spawn?.depth ?? subagent?.depth;
      subagentDepth = Number.isInteger(depth) && Number(depth) >= 0 ? Number(depth) : null;
      agentRole = optionalString(spawn?.agent_role) ?? optionalString(subagent?.agent_role) ?? optionalString(payload.agent_role) ?? null;
      const explicitPurpose = optionalString(payload.IKB_USAGE_PURPOSE) ?? optionalString(payload.ikb_usage_purpose)
        ?? optionalString(payload.usagePurpose) ?? optionalString(payload.usage_purpose)
        ?? optionalString(source?.IKB_USAGE_PURPOSE) ?? optionalString(source?.ikb_usage_purpose)
        ?? optionalString(source?.usagePurpose) ?? optionalString(source?.usage_purpose)
        ?? optionalString(source?.purpose)
        ?? optionalString(optionalObject(payload.hostProvenance)?.purpose)
        ?? optionalString(optionalObject(payload.host_provenance)?.purpose);
      if (explicitPurpose === "interactive" || explicitPurpose === "maintenance" || explicitPurpose === "regression") usagePurpose = explicitPurpose;
      return;
    }
    if (!payload) return;
    const payloadType = optionalString(payload.type);
    const metadata = optionalObject(payload.internal_chat_message_metadata_passthrough);
    const explicitTurnId = optionalString(payload.turn_id) ?? optionalString(metadata?.turn_id);
    const eventTime = optionalString(row.timestamp) ?? optionalString(payload.timestamp);
    if (outerType === "event_msg" && payloadType === "task_started") {
      if (!explicitTurnId || !eventTime) return;
      currentTurnId = explicitTurnId;
      const turn = ensureTurn(explicitTurnId);
      turn.startedAt ||= timestamp(eventTime, "task started timestamp");
      return;
    }
    if (outerType === "turn_context") {
      const turnId = explicitTurnId ?? currentTurnId;
      if (!turnId) return;
      currentTurnId = turnId;
      const turn = ensureTurn(turnId);
      if (eventTime) turn.startedAt ||= timestamp(eventTime, "turn context timestamp");
      return;
    }
    if (outerType === "response_item" && payloadType === "message" && payload.role === "user" && eventTime) {
      const feedback = textContent(payload.content);
      const turnId = explicitTurnId ?? currentTurnId;
      if (feedback && turnId) {
        const markedPurpose = detectIkbTaskPurpose(feedback);
        const turn = ensureTurn(turnId);
        if (markedPurpose) {
          turn.taskPurpose = markedPurpose;
          setTurnPurpose(turn, markedPurpose);
        }
        turn.userMessages.push(feedback);
      }
      return;
    }
    if (outerType === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
      const turnId = explicitTurnId ?? currentTurnId;
      const name = optionalString(payload.name) ?? optionalString(payload.tool_name);
      const callId = optionalString(payload.call_id) ?? optionalString(payload.id);
      if (turnId && name && callId) {
        const cliOperations = detectIkbCliOperations(payload.arguments ?? payload.input);
        const markedPurpose = detectIkbUsagePurpose(payload.arguments ?? payload.input);
        const purpose = purposeForTurn(turnId, markedPurpose);
        if (toolMatches(name, "ikb_search_cards") || toolMatches(name, "ikb_get_card") || cliOperations.length > 0) {
          setTurnPurpose(ensureTurn(turnId), purpose);
          const cliCommands = commandStrings(payload.arguments ?? payload.input).filter(command => cliOperationsFromCommand(command).length > 0);
          calls.set(callId, { turnId, name, ...(cliCommands.length === 1 ? { singleCommand: cliCommands[0] } : {}), sourceEventRef: sourceRefFor(turnId, lineNumber, callId, "call"), purpose, ...(cliOperations.length > 0 ? { cliOperations } : {}) });
        }
      }
      return;
    }
    if (outerType === "response_item" && (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")) {
      const callId = optionalString(payload.call_id);
      const call = callId ? calls.get(callId) : null;
      if (callId) completedCallIds.add(callId);
      if (call?.cliOperations && call.cliOperations.length > 0) {
        for (const operation of call.cliOperations) acceptCliResult(call.turnId, operation, payload.output, call.sourceEventRef, safeEventTime(eventTime), call.purpose);
      } else if (call) acceptResult(call.turnId, call.name, payload.output, false, call.sourceEventRef, safeEventTime(eventTime), call.purpose);
      return;
    }
    if (outerType === "event_msg" && payloadType === "mcp_tool_call_end") {
      const invocation = optionalObject(payload.invocation);
      const name = optionalString(invocation?.tool);
      const turnId = explicitTurnId ?? currentTurnId;
      if (name && turnId) {
        const callId = optionalString(invocation?.call_id);
        acceptResult(turnId, name, payload.result, false, sourceRefFor(turnId, lineNumber, callId, "call"), safeEventTime(eventTime), purposeForTurn(turnId));
      }
      return;
    }
    if (outerType === "event_msg" && payloadType === "item_completed") {
      const item = optionalObject(payload.item);
      const turnId = explicitTurnId ?? currentTurnId;
      if (optionalString(item?.type) === "McpToolCall") {
        const name = optionalString(item?.tool);
        if (name && turnId) {
          const callId = optionalString(item?.call_id);
          acceptResult(turnId, name, item?.result, false, sourceRefFor(turnId, lineNumber, callId, "call"), safeEventTime(eventTime), purposeForTurn(turnId));
        }
        return;
      }
      if (optionalString(item?.type) === "CommandExecution" && turnId) {
        const status = optionalString(item?.status);
        const exitCode = item?.exit_code ?? item?.exitCode;
        const command = Array.isArray(item?.command)
          ? item.command.filter((value): value is string => typeof value === "string").at(-1)
          : optionalString(item?.command) ?? optionalString(item?.cmd);
        const output = item?.output ?? item?.stdout ?? item?.aggregated_output;
        const markedPurpose = command ? detectIkbUsagePurpose(command) : null;
        const purpose = purposeForTurn(turnId, markedPurpose);
        const eventId = optionalString(item?.call_id) ?? optionalString(item?.id) ?? optionalString(payload.call_id) ?? optionalString(payload.id) ?? optionalString(row.id);
        // A native command event is emitted inside its enclosing tool call.
        // Bind only a unique open call with exactly the same single command.
        // Distinct executions (including identical commands) keep distinct IDs.
        const enclosing = [...calls.entries()].filter(([id, call]) => !completedCallIds.has(id) && call.turnId === turnId && call.singleCommand === command && (!call.nativeEventId || call.nativeEventId === eventId));
        const owner = command && enclosing.length === 1 ? enclosing[0][1] : null;
        if (owner) owner.nativeEventId = eventId ?? `line:${lineNumber}`;
        const sourceRef = owner?.sourceEventRef ?? sourceRefFor(turnId, lineNumber, eventId);
        const failed = Boolean(status && !["completed", "succeeded", "success", "ok"].includes(status.toLowerCase())) || (typeof exitCode === "number" && exitCode !== 0);
        if (command) for (const operation of detectIkbCliOperations(command)) {
          if (failed) acceptCliResult(turnId, operation, { is_error: true, status: status ?? exitCode ?? "failed" }, sourceRef, safeEventTime(eventTime), purpose);
          else acceptCliResult(turnId, operation, output, sourceRef, safeEventTime(eventTime), purpose);
        }
      }
      return;
    }
    if (outerType === "event_msg" && payloadType === "command_execution") {
      const turnId = explicitTurnId ?? currentTurnId;
      if (!turnId) return;
      const status = optionalString(payload.status);
      const exitCode = payload.exit_code ?? payload.exitCode;
      const command = Array.isArray(payload.command)
        ? payload.command.filter((value): value is string => typeof value === "string").at(-1)
        : optionalString(payload.command) ?? optionalString(payload.cmd);
      const output = payload.output ?? payload.stdout ?? payload.aggregated_output;
      const markedPurpose = command ? detectIkbUsagePurpose(command) : null;
      const purpose = purposeForTurn(turnId, markedPurpose);
      const eventId = optionalString(payload.call_id) ?? optionalString(payload.id) ?? optionalString(row.id);
      const failed = Boolean(status && !["completed", "succeeded", "success", "ok"].includes(status.toLowerCase())) || (typeof exitCode === "number" && exitCode !== 0);
      if (command) for (const operation of detectIkbCliOperations(command)) {
        if (failed) acceptCliResult(turnId, operation, { is_error: true, status: status ?? exitCode ?? "failed" }, sourceRefFor(turnId, lineNumber, eventId), safeEventTime(eventTime), purpose);
        else acceptCliResult(turnId, operation, output, sourceRefFor(turnId, lineNumber, eventId), safeEventTime(eventTime), purpose);
      }
      return;
    }
    if (outerType === "event_msg" && payloadType === "task_complete") {
      const turnId = explicitTurnId ?? currentTurnId;
      if (!turnId || !eventTime) return;
      const turn = ensureTurn(turnId);
      turn.completedAt = timestamp(eventTime, "task complete timestamp");
      turn.finalText = optionalString(payload.last_agent_message) ?? "";
      if (currentTurnId === turnId) currentTurnId = null;
    }
  });
  for (const [callId, call] of calls) {
    if (completedCallIds.has(callId)) continue;
    const operations = call.cliOperations && call.cliOperations.length > 0
      ? call.cliOperations
      : toolMatches(call.name, "ikb_search_cards") ? ["search" as const]
        : toolMatches(call.name, "ikb_get_card") ? ["get" as const] : [];
    for (const operation of operations) {
      const turn = ensureTurn(call.turnId);
      turn.ikbCalls += 1;
      turn.issues.push("ikb_result_unknown");
      recordAttempt(call.turnId, operation, "unknown", call.sourceEventRef, null, { purpose: call.purpose, reasonCode: "ikb_result_unknown" });
    }
  }
  if (!threadId) throw new Error("rollout session_meta id is missing");
  return {
    threadId: identifier(threadId, "rollout thread id"),
    parentThreadId,
    sessionSource,
    usagePurpose,
    relationship,
    subagentDepth,
    agentRole,
    turns: [...turns.values()].filter((turn) => turn.turnId && turn.startedAt).sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  };
}

function discoverRollouts(sessionRoots: string[], modifiedSince: string | null): { paths: string[]; missingRoots: number } {
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
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && lstatSync(path).mtimeMs >= minimumModifiedAt) {
        paths.push(path);
      }
    }
  };
  for (const value of sessionRoots) {
    const root = resolve(value);
    if (!existsSync(root)) missingRoots += 1;
    else visit(root);
  }
  return { paths: [...new Set(paths)].sort(), missingRoots };
}

function loadRollouts(sessionRoots: string[], modifiedSince: string | null): { facts: RolloutFacts[]; scannedFiles: number; missingRoots: number; issues: string[] } {
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
  for (const fact of facts) byThread.set(fact.threadId, mergeRolloutFacts(byThread.get(fact.threadId), fact));
  return { facts: [...byThread.values()].map(linkSubsequentUserFeedback), scannedFiles: discovery.paths.length, missingRoots: discovery.missingRoots, issues };
}

function linkSubsequentUserFeedback(fact: RolloutFacts): RolloutFacts {
  const turns = [...fact.turns].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  for (const turn of turns) turn.feedbackTexts = [];
  for (const turn of turns) {
    const previous = turns
      .filter((candidate) => candidate.completedAt && candidate.completedAt <= turn.startedAt)
      .sort((left, right) => right.completedAt!.localeCompare(left.completedAt!))[0];
    if (previous) previous.feedbackTexts.push(...turn.userMessages);
  }
  return { ...fact, turns };
}

function mergeRolloutFacts(existing: RolloutFacts | undefined, incoming: RolloutFacts): RolloutFacts {
  if (!existing) return incoming;
  if (existing.parentThreadId && incoming.parentThreadId && existing.parentThreadId !== incoming.parentThreadId) {
    throw new Error("rollout thread parent conflicts across files");
  }
  const turns = new Map<string, TurnFacts>();
  for (const turn of [...existing.turns, ...incoming.turns]) {
    const prior = turns.get(turn.turnId);
    if (!prior) {
      turns.set(turn.turnId, { ...turn, userMessages: [...turn.userMessages], feedbackTexts: [], searches: [...turn.searches], reads: [...turn.reads], issues: [...turn.issues], attempts: [...(turn.attempts ?? [])] });
      continue;
    }
    if (prior.startedAt !== turn.startedAt || (prior.completedAt && turn.completedAt && prior.completedAt !== turn.completedAt)
      || (prior.finalText && turn.finalText && prior.finalText !== turn.finalText)) {
      prior.issues.push("rollout_turn_conflict");
      continue;
    }
    prior.completedAt ||= turn.completedAt;
    prior.finalText ||= turn.finalText;
    prior.userMessages.push(...turn.userMessages);
    for (const search of turn.searches) if (!prior.searches.some((value) => canonical(value) === canonical(search))) prior.searches.push(search);
    for (const read of turn.reads) if (!prior.reads.some((value) => canonical(value) === canonical(read))) prior.reads.push(read);
    for (const attempt of turn.attempts ?? []) if (!prior.attempts?.some((value) => canonical(value) === canonical(attempt))) prior.attempts?.push(attempt);
    prior.ikbCalls = Math.max(prior.ikbCalls, turn.ikbCalls);
    prior.taskPurpose ||= turn.taskPurpose;
    if (prior.usagePurpose === "unknown" && turn.usagePurpose && turn.usagePurpose !== "unknown") prior.usagePurpose = turn.usagePurpose;
    for (const issue of turn.issues) if (!prior.issues.includes(issue)) prior.issues.push(issue);
  }
  return {
    threadId: existing.threadId,
    parentThreadId: existing.parentThreadId ?? incoming.parentThreadId,
    sessionSource: existing.sessionSource ?? incoming.sessionSource,
    usagePurpose: existing.usagePurpose !== "unknown" ? existing.usagePurpose : incoming.usagePurpose,
    relationship: existing.relationship === "subagent" || incoming.relationship === "subagent" ? "subagent" : "root",
    subagentDepth: existing.subagentDepth ?? incoming.subagentDepth,
    agentRole: existing.agentRole ?? incoming.agentRole,
    turns: [...turns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
  };
}

function stateCounts(): Record<IkbRecallCardState, number> {
  return {
    recalled_not_read: 0,
    read_adopted: 0,
    read_unresolved: 0,
    explicitly_rejected_stale: 0,
    explicitly_rejected_incorrect: 0,
  };
}

function classifyRead(path: string, finalText: string, feedbackTexts: string[]): Pick<IkbRecallCardEvaluation, "state" | "reasonCode"> {
  const classification = classifyPathReference(path, finalText, false);
  const feedbackClassification = feedbackTexts
    .map((feedback) => classifyPathReference(path, feedback, true))
    .filter((value): value is Pick<IkbRecallCardEvaluation, "state" | "reasonCode"> => value !== null)
    .sort((left, right) => classificationRank(right.state) - classificationRank(left.state))[0];
  return feedbackClassification && classificationRank(feedbackClassification.state) > classificationRank(classification.state)
    ? feedbackClassification
    : classification;
}

function classifyPathReference(path: string, text: string, isFeedback: boolean): Pick<IkbRecallCardEvaluation, "state" | "reasonCode"> | null {
  const unresolved = { state: "read_unresolved", reasonCode: "read_without_final_adoption_evidence" } as const;
  // Mask link labels and paths before parsing prose: filenames are not claims about card quality.
  const target = "\u0000IKB_TARGET\u0000";
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathPattern = new RegExp(`(?<![A-Za-z0-9._/-])${escapedPath}(?![A-Za-z0-9._/-])`, "g");
  const masked = text.replace(/\[[^\]\n]*\]\(<?([^\n)]+?)>?\)/g,
    (_link, destination: string) => destination === path ? target : "\u0000OTHER_LINK\u0000")
    .replace(pathPattern, target);
  const evidence: Array<Pick<IkbRecallCardEvaluation, "state" | "reasonCode">> = [];
  for (const sentence of masked.match(/[^\n。；;!?！？]+(?:[!?！？]|\.(?=\s|$))?/g) ?? []) {
    const references = sentence.split(target);
    for (let index = 1; index < references.length; index++) {
      const tail = references[index].replace(/^[\s`*<>):：]+/u, "").toLowerCase();
      if (/(?:是否|是不是|能否|可能|也许|吗|么|[?？])/u.test(references[index - 1] + tail)) {
        if (!isFeedback) evidence.push(unresolved);
        continue;
      }
      // Only a direct predicate on this exact reference can reject it. Never borrow a
      // negative word or refusal from a neighbouring sentence or another subject.
      const prefix = /(?:^|[，,:：])\s*(?:这张卡|该卡|本卡|卡片|this card|card)\s*([^\u0000]*?)[：:]\s*$/iu.exec(references[index - 1]);
      const predicate = prefix ? prefix[1].toLowerCase() : tail;
      const negative = /^(?:(?:的|内容|信息|已经|已|存在|事实|is|was)\s*)*(错误|不正确|有误|过期|陈旧|incorrect\b|wrong\b|stale\b|outdated\b)(.*)$/u.exec(predicate);
      const refused = negative && /^[\s，,]*(?:(?:所以|因此|本次|此次|请|and|is|was)\s*)*(?:未采用|不采用|不要采用|拒绝(?:采用)?|未采信|不能采用|不可采用|勿采用|rejected\b|reject\b|not used\b|not adopted\b)/u.test(negative[2]);
      if (refused) {
        evidence.push(/^(?:过期|陈旧|stale|outdated)$/u.test(negative[1])
          ? { state: "explicitly_rejected_stale", reasonCode: "final_explicit_stale_rejection" }
          : { state: "explicitly_rejected_incorrect", reasonCode: "final_explicit_incorrect_rejection" });
      } else if (!isFeedback) {
        evidence.push(negative || /^(?:未采用|不采用|拒绝|not used|not adopted)/u.test(predicate)
          ? unresolved : { state: "read_adopted", reasonCode: "read_card_reference_listed_in_final" });
      }
    }
  }
  return evidence.sort((left, right) => classificationRank(right.state) - classificationRank(left.state))[0]
    ?? (isFeedback ? null : unresolved);
}

function classificationRank(state: IkbRecallCardState): number {
  return {
    recalled_not_read: 0,
    read_unresolved: 1,
    read_adopted: 2,
    explicitly_rejected_stale: 3,
    explicitly_rejected_incorrect: 4,
  }[state];
}

function buildDetail(threadId: string, turn: TurnFacts): IkbRecallEvalDetail | null {
  const searchesByRetrieval = new Map<string, SearchResult>();
  for (const search of turn.searches) {
    const existing = searchesByRetrieval.get(search.retrievalId);
    if (existing && canonical(existing) !== canonical(search)) return null;
    searchesByRetrieval.set(search.retrievalId, search);
  }
  if (searchesByRetrieval.size === 0) return null;
  const readsByKey = new Map<string, ReadResult>();
  for (const read of turn.reads) readsByKey.set(`${read.retrievalId}\n${read.cardId}`, read);
  const invalidRead = [...readsByKey.values()].some((read) => {
    const search = searchesByRetrieval.get(read.retrievalId);
    const item = search?.items.find((candidate) => candidate.cardId === read.cardId);
    return !search || !item || read.scope !== search.scope || read.path !== item.path || read.contentHash !== item.contentHash;
  });
  if (invalidRead) return null;

  const cards = new Map<string, IkbRecallCardEvaluation>();
  for (const search of searchesByRetrieval.values()) {
    for (const item of search.items) {
      const retrievalIds = [...searchesByRetrieval.values()]
        .filter((candidate) => candidate.items.some((value) => value.cardId === item.cardId))
        .map((candidate) => candidate.retrievalId).sort();
      const reads = [...readsByKey.values()].filter((read) => read.cardId === item.cardId);
      let evaluation: IkbRecallCardEvaluation;
      if (reads.length === 0) {
        evaluation = { cardId: item.cardId, retrievalIds, state: "recalled_not_read", reasonCode: "search_result_not_read" };
      } else {
        const classified = reads.map((read) => classifyRead(read.path, turn.finalText, turn.feedbackTexts)).sort((left, right) => classificationRank(right.state) - classificationRank(left.state))[0];
        evaluation = { cardId: item.cardId, retrievalIds, ...classified };
      }
      const existing = cards.get(item.cardId);
      if (!existing || classificationRank(evaluation.state) > classificationRank(existing.state)) cards.set(item.cardId, evaluation);
    }
  }
  const cardValues = [...cards.values()].sort((left, right) => left.cardId.localeCompare(right.cardId));
  const retrievals = [...searchesByRetrieval.values()].sort((left, right) => left.retrievalId.localeCompare(right.retrievalId)).map((search) => ({
    retrievalId: search.retrievalId,
    scope: search.scope,
    resultCardIds: search.items.map((item) => item.cardId).sort(),
    resultOrder: search.items.map((item) => item.cardId),
    zeroResult: search.zeroResult,
  }));
  const core: Omit<IkbRecallEvalDetail, "subjectHash"> = {
    schema: IKB_RECALL_EVAL_DETAIL_SCHEMA,
    collectorVersion: "v1" as const,
    subjectVersion: "codex-completed-turn.v1" as const,
    subjectRef: validateReference(`run://codex/${threadId}/${turn.turnId}`, "IKB Recall subjectRef"),
    completedAt: timestamp(turn.completedAt, "IKB Recall completedAt"),
    retrievals,
    cards: cardValues,
    metrics: {
      recallCount: retrievals.length,
      resultCardCount: retrievals.reduce((total, retrieval) => total + retrieval.resultCardIds.length, 0),
      readCount: readsByKey.size,
      adoptedCount: cardValues.filter((card) => card.state === "read_adopted").length,
      recalledNotReadCount: cardValues.filter((card) => card.state === "recalled_not_read").length,
      readUnresolvedCount: cardValues.filter((card) => card.state === "read_unresolved").length,
      zeroResultCount: retrievals.filter((retrieval) => retrieval.zeroResult).length,
      explicitCorrectionCount: cardValues.filter((card) => card.state === "explicitly_rejected_stale" || card.state === "explicitly_rejected_incorrect").length,
    },
  };
  return validateIkbRecallEvalDetail({ ...core, subjectHash: sha256(canonical(core)) });
}

function usageV2AttemptKey(sourceEventRef: string, operation: IkbUsageOperation): string {
  return sha256(`${sourceEventRef}\n${operation}`);
}

function usageV2Origin(fact: RolloutFacts, turn: TurnFacts): IkbUsageV2Origin {
  return {
    host: "codex",
    sessionSource: fact.sessionSource,
    relationship: fact.relationship,
    parentThreadId: fact.parentThreadId,
    subagentDepth: fact.subagentDepth,
    agentRole: fact.agentRole,
    purpose: turn.usagePurpose ?? fact.usagePurpose,
  };
}

function buildUsageV2Detail(fact: RolloutFacts, turn: TurnFacts): IkbUsageV2EvidenceDetail | null {
  if (!turn.completedAt || !turn.startedAt || !turn.attempts || turn.attempts.length === 0) return null;
  const attempts: IkbUsageV2Attempt[] = turn.attempts.map((attempt) => ({
    attemptKey: usageV2AttemptKey(attempt.sourceEventRef, attempt.operation),
    operation: attempt.operation,
    outcome: attempt.outcome,
    sourceEventRef: attempt.sourceEventRef,
    observedAt: attempt.observedAt,
    ...(attempt.purpose ? { purpose: attempt.purpose } : {}),
    ...(attempt.reasonCode ? { reasonCode: attempt.reasonCode } : {}),
    ...(attempt.queryHash ? { queryHash: attempt.queryHash } : {}),
  }));
  const searches: IkbUsageV2Search[] = [];
  const reads: IkbUsageV2Read[] = [];
  for (const [index, attempt] of turn.attempts.entries()) {
    if (attempt.outcome !== "success" || !attempt.result) continue;
    const attemptKey = attempts[index].attemptKey;
    if (attempt.operation === "search") {
      const search = attempt.result as SearchResult;
      searches.push({
        unitKey: sha256(`${attemptKey}\nsearch`),
        attemptKey,
        retrievalId: search.retrievalId,
        queryHash: search.queryHash,
        observedAt: attempt.observedAt,
        total: search.total,
        zeroResult: search.zeroResult,
        resultCardIds: search.items.map((item) => item.cardId).sort(),
        resultOrder: search.items.map((item) => item.cardId),
      });
    } else {
      const read = attempt.result as ReadResult;
      reads.push({
        unitKey: sha256(`${attemptKey}\nread`),
        attemptKey,
        retrievalId: read.retrievalId,
        cardId: read.cardId,
        contentHash: read.contentHash,
        observedAt: attempt.observedAt,
      });
    }
  }
  const states: IkbUsageV2State[] = [];
  const v1Detail = buildDetail(fact.threadId, turn);
  if (v1Detail) {
    for (const card of v1Detail.cards) {
      const read = reads.find((candidate) => candidate.cardId === card.cardId);
      states.push({
        unitKey: sha256(`${turn.turnId}\n${card.cardId}\nstate`),
        attemptKey: read?.attemptKey ?? sha256(`${turn.turnId}\nstate`),
        cardId: card.cardId,
        state: card.state,
        reasonCode: card.reasonCode,
        observedAt: turn.completedAt,
      });
    }
  }
  const origin = usageV2Origin(fact, turn);
  const issues = [...new Set(turn.issues)];
  if (!v1Detail && turn.searches.length > 0) issues.push("ikb_trajectory_invalid");
  const core = {
    schema: "ikb-recall-usage-evidence-v2" as const,
    version: "v2" as const,
    subjectRef: `run://codex/${fact.threadId}/${turn.turnId}`,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    origin,
    provenance: origin,
    attempts,
    searches,
    reads,
    states,
    issues: [...new Set(issues)].sort(),
  };
  return { ...core, subjectHash: sha256(canonical(core)) };
}

export function validateIkbRecallEvalDetail(value: unknown): IkbRecallEvalDetail {
  const row = objectValue(value, "IKB Recall eval detail");
  exactKeys(row, ["schema", "collectorVersion", "subjectVersion", "subjectRef", "subjectHash", "completedAt", "retrievals", "cards", "metrics"], "IKB Recall eval detail");
  if (row.schema !== IKB_RECALL_EVAL_DETAIL_SCHEMA || row.collectorVersion !== "v1" || row.subjectVersion !== "codex-completed-turn.v1") {
    throw new Error("IKB Recall eval detail version is invalid");
  }
  if (!Array.isArray(row.retrievals) || !Array.isArray(row.cards)) throw new Error("IKB Recall eval detail collections are invalid");
  const retrievals = row.retrievals.map((value, index) => {
    const retrieval = objectValue(value, `IKB Recall retrieval ${index}`);
    exactKeys(retrieval, ["retrievalId", "scope", "resultCardIds", "zeroResult", ...("resultOrder" in retrieval ? ["resultOrder"] : [])], `IKB Recall retrieval ${index}`);
    const rawScope = nonEmptyString(retrieval.scope, `IKB Recall retrieval ${index} scope`);
    if (rawScope !== "work" && rawScope !== "personal") throw new Error("IKB Recall retrieval scope is invalid");
    const scope: "work" | "personal" = rawScope;
    if (!Array.isArray(retrieval.resultCardIds)) throw new Error("IKB Recall resultCardIds is invalid");
    const resultCardIds = retrieval.resultCardIds.map((cardId) => identifier(cardId, "IKB Recall result card id"));
    if (new Set(resultCardIds).size !== resultCardIds.length) throw new Error("IKB Recall resultCardIds contains duplicates");
    const zeroResult = booleanValue(retrieval.zeroResult, `IKB Recall retrieval ${index} zeroResult`);
    if (zeroResult !== (resultCardIds.length === 0)) throw new Error("IKB Recall zero-result flag is inconsistent");
    let resultOrder: string[] | undefined;
    if ("resultOrder" in retrieval) {
      if (!Array.isArray(retrieval.resultOrder)) throw new Error("IKB Recall resultOrder is invalid");
      resultOrder = retrieval.resultOrder.map((id) => identifier(id, "IKB Recall resultOrder card id"));
      if (resultOrder.length !== resultCardIds.length || new Set(resultOrder).size !== resultOrder.length || resultOrder.some((id) => !resultCardIds.includes(id))) {
        throw new Error("IKB Recall resultOrder must contain exactly the resultCardIds");
      }
    }
    return { retrievalId: identifier(retrieval.retrievalId, `IKB Recall retrieval ${index} id`), scope, resultCardIds: [...resultCardIds].sort(), zeroResult, ...(resultOrder === undefined ? {} : { resultOrder }) };
  });
  if (new Set(retrievals.map((retrieval) => retrieval.retrievalId)).size !== retrievals.length) throw new Error("IKB Recall retrieval ids contain duplicates");
  const allowedStates: IkbRecallCardState[] = ["recalled_not_read", "read_adopted", "read_unresolved", "explicitly_rejected_stale", "explicitly_rejected_incorrect"];
  const allowedReasons: IkbRecallCardEvaluation["reasonCode"][] = ["search_result_not_read", "read_card_reference_listed_in_final", "read_without_final_adoption_evidence", "final_explicit_stale_rejection", "final_explicit_incorrect_rejection"];
  const reasonForState: Record<IkbRecallCardState, IkbRecallCardEvaluation["reasonCode"]> = {
    recalled_not_read: "search_result_not_read",
    read_adopted: "read_card_reference_listed_in_final",
    read_unresolved: "read_without_final_adoption_evidence",
    explicitly_rejected_stale: "final_explicit_stale_rejection",
    explicitly_rejected_incorrect: "final_explicit_incorrect_rejection",
  };
  const retrievalIds = new Set(retrievals.map((retrieval) => retrieval.retrievalId));
  const cards = row.cards.map((value, index): IkbRecallCardEvaluation => {
    const card = objectValue(value, `IKB Recall card ${index}`);
    exactKeys(card, ["cardId", "retrievalIds", "state", "reasonCode"], `IKB Recall card ${index}`);
    if (!Array.isArray(card.retrievalIds) || card.retrievalIds.length === 0) throw new Error("IKB Recall card retrievalIds is invalid");
    const cardRetrievalIds = card.retrievalIds.map((retrievalId) => identifier(retrievalId, "IKB Recall card retrieval id"));
    if (new Set(cardRetrievalIds).size !== cardRetrievalIds.length || cardRetrievalIds.some((retrievalId) => !retrievalIds.has(retrievalId))) throw new Error("IKB Recall card retrieval linkage is invalid");
    const state = nonEmptyString(card.state, "IKB Recall card state") as IkbRecallCardState;
    const reasonCode = nonEmptyString(card.reasonCode, "IKB Recall card reasonCode") as IkbRecallCardEvaluation["reasonCode"];
    if (!allowedStates.includes(state) || !allowedReasons.includes(reasonCode) || reasonForState[state] !== reasonCode) throw new Error("IKB Recall card classification is invalid");
    return { cardId: identifier(card.cardId, "IKB Recall card id"), retrievalIds: [...cardRetrievalIds].sort(), state, reasonCode };
  });
  if (new Set(cards.map((card) => card.cardId)).size !== cards.length) throw new Error("IKB Recall card ids contain duplicates");
  const metricsRow = objectValue(row.metrics, "IKB Recall metrics");
  exactKeys(metricsRow, ["recallCount", "resultCardCount", "readCount", "adoptedCount", "recalledNotReadCount", "readUnresolvedCount", "zeroResultCount", "explicitCorrectionCount"], "IKB Recall metrics");
  const metrics = {
    recallCount: nonNegativeInteger(metricsRow.recallCount, "IKB Recall recallCount"),
    resultCardCount: nonNegativeInteger(metricsRow.resultCardCount, "IKB Recall resultCardCount"),
    readCount: nonNegativeInteger(metricsRow.readCount, "IKB Recall readCount"),
    adoptedCount: nonNegativeInteger(metricsRow.adoptedCount, "IKB Recall adoptedCount"),
    recalledNotReadCount: nonNegativeInteger(metricsRow.recalledNotReadCount, "IKB Recall recalledNotReadCount"),
    readUnresolvedCount: nonNegativeInteger(metricsRow.readUnresolvedCount, "IKB Recall readUnresolvedCount"),
    zeroResultCount: nonNegativeInteger(metricsRow.zeroResultCount, "IKB Recall zeroResultCount"),
    explicitCorrectionCount: nonNegativeInteger(metricsRow.explicitCorrectionCount, "IKB Recall explicitCorrectionCount"),
  };
  if (metrics.recallCount !== retrievals.length
    || metrics.resultCardCount !== retrievals.reduce((total, retrieval) => total + retrieval.resultCardIds.length, 0)
    || metrics.adoptedCount !== cards.filter((card) => card.state === "read_adopted").length
    || metrics.recalledNotReadCount !== cards.filter((card) => card.state === "recalled_not_read").length
    || metrics.readUnresolvedCount !== cards.filter((card) => card.state === "read_unresolved").length
    || metrics.zeroResultCount !== retrievals.filter((retrieval) => retrieval.zeroResult).length
    || metrics.explicitCorrectionCount !== cards.filter((card) => card.state === "explicitly_rejected_stale" || card.state === "explicitly_rejected_incorrect").length) {
    throw new Error("IKB Recall metrics are inconsistent");
  }
  const core: Omit<IkbRecallEvalDetail, "subjectHash"> = {
    schema: IKB_RECALL_EVAL_DETAIL_SCHEMA,
    collectorVersion: "v1" as const,
    subjectVersion: "codex-completed-turn.v1" as const,
    subjectRef: validateReference(row.subjectRef, "IKB Recall subjectRef"),
    completedAt: timestamp(row.completedAt, "IKB Recall completedAt"),
    retrievals,
    cards,
    metrics,
  };
  const result: IkbRecallEvalDetail = { ...core, subjectHash: hashValue(row.subjectHash, "IKB Recall subjectHash") };
  if (result.subjectHash !== sha256(canonical(core))) throw new Error("IKB Recall subjectHash is inconsistent");
  validateSafeProjection(result, "IKB Recall eval detail");
  return result;
}

export function buildIkbRecallEvalReceipt(detail: IkbRecallEvalDetail, reportHash: string): EvalReceipt {
  detail = validateIkbRecallEvalDetail(detail);
  const readResolved = detail.cards.filter((card) => card.state !== "recalled_not_read" && card.state !== "read_unresolved").length;
  const readUnresolved = detail.metrics.readUnresolvedCount;
  const readCards = readResolved + readUnresolved;
  const reasonCodes: Record<string, number> = { final_consumer_evidence_missing: 1 };
  if (detail.metrics.recalledNotReadCount > 0) reasonCodes.recalled_not_read = detail.metrics.recalledNotReadCount;
  if (readUnresolved > 0) reasonCodes.read_unresolved = readUnresolved;
  if (detail.metrics.adoptedCount > 0) reasonCodes.adoption_helpfulness_unproven = detail.metrics.adoptedCount;
  if (detail.metrics.zeroResultCount > 0) reasonCodes.zero_result = detail.metrics.zeroResultCount;
  if (detail.metrics.explicitCorrectionCount > 0) reasonCodes.explicit_correction = detail.metrics.explicitCorrectionCount;
  const evaluationKey = sha256(canonical({
    subjectHash: detail.subjectHash,
    suiteId: IKB_RECALL_SUITE_ID,
    suiteVersion: IKB_RECALL_SUITE_VERSION,
    graderVersion: IKB_RECALL_GRADER_VERSION,
  }));
  return validateEvalReceipt({
    schema: EVAL_RECEIPT_SCHEMA,
    harnessId: "ikb-recall",
    suiteId: IKB_RECALL_SUITE_ID,
    suiteVersion: IKB_RECALL_SUITE_VERSION,
    graderVersion: IKB_RECALL_GRADER_VERSION,
    subjectRef: detail.subjectRef,
    subjectHash: detail.subjectHash,
    evaluationKey,
    evaluatedAt: detail.completedAt,
    qualityOutcome: "inconclusive",
    hardGatePassed: false,
    levels: [
      { level: "L1", totalCases: 3, passedCases: 3, failedCases: 0, inconclusiveCases: 0 },
      { level: "L2", totalCases: readCards, passedCases: readResolved, failedCases: 0, inconclusiveCases: readUnresolved },
      { level: "L3", totalCases: 1, passedCases: 0, failedCases: 0, inconclusiveCases: 1 },
    ],
    reasonCodes,
    metrics: detail.metrics,
    reportRef: validateReference(`artifact://eval-detail/ikb-recall/${detail.subjectHash}`, "IKB Recall detail ref"),
    reportHash,
  });
}

function ensureDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("persistence directory must be absolute");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("persistence directory is unsafe");
  chmodSync(path, 0o700);
}

function readRegular(path: string, label: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function persistImmutable(path: string, bytes: string): { hash: string; reused: boolean } {
  const hash = sha256(bytes);
  if (existsSync(path)) {
    if (readRegular(path, "persisted artifact") !== bytes) throw new Error(`content-addressed artifact collision: ${path}`);
    return { hash, reused: true };
  }
  ensureDirectory(dirname(path));
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  return { hash, reused: false };
}

function atomicReplace(path: string, bytes: string): void {
  ensureDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function validateSafeProjection(value: unknown, label: string): void {
  const visit = (item: unknown, key = "", depth = 0): void => {
    if (depth > 16) throw new Error(`${label} is too deeply nested`);
    if (/(?:prompt|text|markdown|path|url|payload|query|title|snippet|contentHash|toolArgs|raw)/i.test(key)) throw new Error(`${label} contains an unsafe field`);
    if (typeof item === "string" && (/^(?:https?:|file:|\/|~|[A-Za-z]:[\\/])/i.test(item) || item.includes("\n"))) throw new Error(`${label} contains unsafe text`);
    if (Array.isArray(item)) for (const nested of item) visit(nested, key, depth + 1);
    else if (item && typeof item === "object") for (const [nestedKey, nested] of Object.entries(item as Row)) visit(nested, nestedKey, depth + 1);
  };
  visit(value);
}

function emptySummary(evaluatedAt: string): FeedbackSummary {
  return {
    schema: IKB_RECALL_FEEDBACK_SUMMARY_SCHEMA,
    updatedAt: evaluatedAt,
    evaluationCount: 0,
    feedbackCount: 0,
    recallCount: 0,
    resultCardCount: 0,
    readCount: 0,
    zeroResultCount: 0,
    explicitCorrectionCount: 0,
    states: stateCounts(),
    cards: [],
    processedEvaluationKeys: [],
  };
}

function readFeedbackRecords(path: string): FeedbackRecord[] {
  if (!existsSync(path)) return [];
  const lines = readRegular(path, "IKB Recall feedback").split(/\r?\n/).filter((line) => line.trim());
  return lines.map((line) => {
    const row = objectValue(JSON.parse(line), "IKB Recall feedback row") as unknown as FeedbackRecord;
    if (row.schema !== IKB_RECALL_FEEDBACK_SCHEMA) throw new Error("IKB Recall feedback schema is invalid");
    validateSafeProjection(row, "IKB Recall feedback");
    return row;
  });
}

function readSummary(path: string, evaluatedAt: string): FeedbackSummary {
  if (!existsSync(path)) return emptySummary(evaluatedAt);
  const value = objectValue(JSON.parse(readRegular(path, "IKB Recall summary")), "IKB Recall summary") as unknown as FeedbackSummary;
  if (value.schema !== IKB_RECALL_FEEDBACK_SUMMARY_SCHEMA || !Array.isArray(value.processedEvaluationKeys) || !Array.isArray(value.cards)) {
    throw new Error("IKB Recall feedback summary is invalid");
  }
  validateSafeProjection(value, "IKB Recall feedback summary");
  return value;
}

function projectFeedback(activeDataRoot: string, detail: IkbRecallEvalDetail, receipt: EvalReceipt): { feedbackCount: number; reused: boolean } {
  const usageRoot = resolve(activeDataRoot, "usage");
  ensureDirectory(usageRoot);
  const feedbackPath = resolve(usageRoot, "evaluated-feedback.jsonl");
  const summaryPath = resolve(usageRoot, "summary.json");
  const summary = readSummary(summaryPath, receipt.evaluatedAt);
  if (summary.processedEvaluationKeys.includes(receipt.evaluationKey)) return { feedbackCount: detail.cards.length, reused: true };
  const records = readFeedbackRecords(feedbackPath);
  const incoming = detail.cards.map((card): FeedbackRecord => ({
    schema: IKB_RECALL_FEEDBACK_SCHEMA,
    evaluationKey: receipt.evaluationKey,
    evaluatedAt: receipt.evaluatedAt,
    cardId: card.cardId,
    state: card.state,
    reasonCode: card.reasonCode,
  }));
  for (const record of incoming) validateSafeProjection(record, "IKB Recall feedback");
  const byKey = new Map(records.map((record) => [`${record.evaluationKey}\n${record.cardId}`, record]));
  for (const record of incoming) {
    const key = `${record.evaluationKey}\n${record.cardId}`;
    const existing = byKey.get(key);
    if (existing && canonical(existing) !== canonical(record)) throw new Error("IKB Recall feedback key collision");
    byKey.set(key, record);
  }
  const merged = [...byKey.values()].sort((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt) || left.evaluationKey.localeCompare(right.evaluationKey) || left.cardId.localeCompare(right.cardId));
  const nextSummary: FeedbackSummary = {
    ...summary,
    updatedAt: receipt.evaluatedAt > summary.updatedAt ? receipt.evaluatedAt : summary.updatedAt,
    evaluationCount: summary.evaluationCount + 1,
    feedbackCount: summary.feedbackCount + incoming.length,
    recallCount: summary.recallCount + detail.metrics.recallCount,
    resultCardCount: summary.resultCardCount + detail.metrics.resultCardCount,
    readCount: summary.readCount + detail.metrics.readCount,
    zeroResultCount: summary.zeroResultCount + detail.metrics.zeroResultCount,
    explicitCorrectionCount: summary.explicitCorrectionCount + detail.metrics.explicitCorrectionCount,
    states: { ...summary.states },
    cards: summary.cards.map((card) => ({ ...card, states: { ...card.states } })),
    processedEvaluationKeys: [...summary.processedEvaluationKeys, receipt.evaluationKey].sort(),
  };
  for (const record of incoming) {
    nextSummary.states[record.state] += 1;
    let card = nextSummary.cards.find((value) => value.cardId === record.cardId);
    if (!card) {
      card = { cardId: record.cardId, evaluationCount: 0, states: stateCounts() };
      nextSummary.cards.push(card);
    }
    card.evaluationCount += 1;
    card.states[record.state] += 1;
  }
  nextSummary.cards.sort((left, right) => left.cardId.localeCompare(right.cardId));
  validateSafeProjection(nextSummary, "IKB Recall feedback summary");
  atomicReplace(feedbackPath, merged.length > 0 ? `${merged.map((record) => JSON.stringify(record)).join("\n")}\n` : "");
  atomicReplace(summaryPath, `${JSON.stringify(nextSummary, null, 2)}\n`);
  return { feedbackCount: incoming.length, reused: false };
}

function cursorPath(home: string): string {
  return resolve(home, "evaluations", "collector-state", "ikb-recall.json");
}

function readCursor(home: string): CollectorCursor | null {
  const path = cursorPath(home);
  if (!existsSync(path)) return null;
  const row = objectValue(JSON.parse(readRegular(path, "IKB Recall cursor")), "IKB Recall cursor");
  if (row.schema !== IKB_RECALL_CURSOR_SCHEMA || !Array.isArray(row.lastTurnKeys) || row.lastTurnKeys.some((value) => typeof value !== "string")) {
    throw new Error("IKB Recall cursor is invalid");
  }
  return { schema: IKB_RECALL_CURSOR_SCHEMA, lastCompletedAt: timestamp(row.lastCompletedAt, "IKB Recall cursor timestamp"), lastTurnKeys: [...new Set(row.lastTurnKeys as string[])].sort() };
}

function writeCursor(home: string, cursor: CollectorCursor): void {
  atomicReplace(cursorPath(home), `${JSON.stringify(cursor, null, 2)}\n`);
}

function cursorScanStart(cursor: CollectorCursor | null): string {
  if (!cursor) return IKB_RECALL_MONITORING_START;
  return new Date(Math.max(Date.parse(IKB_RECALL_MONITORING_START), Date.parse(cursor.lastCompletedAt) - 24 * 60 * 60 * 1000)).toISOString();
}

function turnKey(fact: RolloutFacts, turn: TurnFacts): string {
  return `${fact.threadId}/${turn.turnId}`;
}

function afterCursor(fact: RolloutFacts, turn: TurnFacts, cursor: CollectorCursor | null): boolean {
  if (!cursor || !turn.completedAt) return true;
  if (turn.completedAt > cursor.lastCompletedAt) return true;
  return turn.completedAt === cursor.lastCompletedAt && !cursor.lastTurnKeys.includes(turnKey(fact, turn));
}

function nextCursor(current: CollectorCursor | null, completed: Array<{ fact: RolloutFacts; turn: TurnFacts }>): CollectorCursor | null {
  const lastCompletedAt = [...completed.flatMap(({ turn }) => turn.completedAt ? [turn.completedAt] : []), ...(current ? [current.lastCompletedAt] : [])].sort().at(-1);
  if (!lastCompletedAt) return current;
  const existing = current?.lastCompletedAt === lastCompletedAt ? current.lastTurnKeys : [];
  return {
    schema: IKB_RECALL_CURSOR_SCHEMA,
    lastCompletedAt,
    lastTurnKeys: [...new Set([...existing, ...completed.filter(({ turn }) => turn.completedAt === lastCompletedAt).map(({ fact, turn }) => turnKey(fact, turn))])].sort(),
  };
}

function countIssues(values: string[]): Array<{ reasonCode: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([reasonCode, count]) => ({ reasonCode, count }));
}

function acquireLock(home: string, timeoutMs: number): { acquired: boolean; release: () => void } {
  const root = resolve(home, "evaluations", "collector-state");
  ensureDirectory(root);
  const path = resolve(root, "ikb-recall.lock");
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(resolve(path, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
      return {
        acquired: true,
        release: () => {
          const owner = resolve(path, "owner.json");
          if (existsSync(owner)) unlinkSync(owner);
          if (existsSync(path)) rmdirSync(path);
        },
      };
    } catch (error) {
      const code = optionalString(optionalObject(error)?.code);
      if (code !== "EEXIST") throw error;
      try {
        const owner = resolve(path, "owner.json");
        let ownerDead = false;
        if (existsSync(owner)) {
          const ownerRow = optionalObject(JSON.parse(readRegular(owner, "IKB Recall lock owner")));
          const pid = ownerRow?.pid;
          if (Number.isInteger(pid) && Number(pid) > 0) {
            try {
              process.kill(Number(pid), 0);
            } catch (processError) {
              ownerDead = optionalString(optionalObject(processError)?.code) === "ESRCH";
            }
          }
        }
        if (ownerDead) {
          unlinkSync(owner);
          rmdirSync(path);
          continue;
        }
      } catch {
        // A concurrently-created owner file may not be readable yet; wait for
        // the bounded timeout instead of guessing that the lock is stale.
      }
      if (Date.now() - startedAt >= timeoutMs) return { acquired: false, release: () => {} };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, timeoutMs));
    }
  }
}

export function collectIkbRecallRollouts(options: CollectIkbRecallOptions): IkbRecallCollectionReport {
  if (readIkbUsageV2Activation(options.activeDataRoot)) throw new Error("usage v2 is active; use collectIkbRecallRolloutsV2");
  if (!Array.isArray(options.sessionRoots) || options.sessionRoots.length === 0) throw new Error("at least one Codex session root is required");
  const activeDataRoot = resolve(options.activeDataRoot);
  const evaluationHome = resolve(options.evaluationHome ?? activeDataRoot);
  if (!isAbsolute(options.activeDataRoot) || (options.evaluationHome && !isAbsolute(options.evaluationHome))) throw new Error("IKB Recall roots must be absolute");
  const explicitFrom = options.from !== undefined;
  const cursor = explicitFrom ? null : readCursor(evaluationHome);
  const from = timestamp(options.from ?? cursorScanStart(cursor), "IKB Recall collection from");
  const to = timestamp(options.to ?? new Date().toISOString(), "IKB Recall collection to");
  if (from > to) throw new Error("IKB Recall collection from must not be after to");
  const lock = acquireLock(evaluationHome, options.lockTimeoutMs ?? 500);
  if (!lock.acquired) {
    return {
      schema: IKB_RECALL_COLLECTION_SCHEMA,
      status: "busy",
      window: { from, to },
      scannedFiles: 0,
      completedTurns: 0,
      matchedTurns: 0,
      persisted: 0,
      reused: 0,
      userCorrectionsFound: 0,
      userCorrectionsAdded: 0,
      missedLookupCandidatesFound: 0,
      missedLookupCandidatesAdded: 0,
      skippedIncomplete: 0,
      issues: [{ reasonCode: "collector_busy", count: 1 }],
      evaluations: [],
    };
  }
  try {
    const loaded = loadRollouts(options.sessionRoots, explicitFrom ? null : from);
    const structuralIssues = [...loaded.issues, ...(loaded.missingRoots === options.sessionRoots.length ? ["session_root_missing"] : [])];
    const issues = [...structuralIssues];
    const roots = loaded.facts.filter((fact) => !fact.parentThreadId);
    const allTurns = roots.flatMap((fact) => fact.turns.map((turn) => ({ fact, turn })));
    const completed = allTurns.filter(({ fact, turn }) => turn.completedAt && turn.completedAt >= from && turn.completedAt <= to && afterCursor(fact, turn, cursor));
    const incomplete = allTurns.filter(({ turn }) => !turn.completedAt && turn.startedAt >= from && turn.startedAt <= to).length;
    const evaluations: IkbRecallCollectionReport["evaluations"] = [];
    let persisted = 0;
    let reused = 0;
    // 用户纠正扫描：覆盖所有完成的 turn（含零 ikb 调用——“该查没查”的纠正恰恰发生在那里）。
    // 但只扫真人在键盘前的交互会话：exec / mcp 等非交互会话的“用户消息”是任务提示词本身
    // （实测 200/200 条漏查噪音全部来自 source=exec 的批量调用），扫它只会把批量指令当成用户纠正。
    // 注意只影响纠正/漏查两条清单：召回 eval 与卡片采用状态仍统计这些会话（批量检索本身是有效数据）。
    const NON_INTERACTIVE_SESSION_SOURCES = new Set(["exec", "mcp"]);
    const corrections: UserCorrectionRecord[] = [];
    const missedLookups: MissedLookupCandidate[] = [];
    for (const { fact, turn } of completed) {
      if (fact.sessionSource !== null && NON_INTERACTIVE_SESSION_SOURCES.has(fact.sessionSource)) continue;
      corrections.push(...scanUserCorrections(fact.threadId, turn));
      const missed = scanMissedLookup(fact.threadId, turn);
      if (missed) missedLookups.push(missed);
    }
    const correctionsAdded = projectCorrections(activeDataRoot, corrections);
    const missedLookupsAdded = projectMissedLookups(activeDataRoot, missedLookups);
    for (const { fact, turn } of completed) {
      issues.push(...turn.issues);
      if (turn.ikbCalls === 0) continue;
      if (turn.issues.length > 0) continue;
      const detail = buildDetail(fact.threadId, turn);
      if (!detail) {
        issues.push("ikb_trajectory_invalid");
        continue;
      }
      validateSafeProjection(detail, "IKB Recall eval detail");
      const detailBytes = `${JSON.stringify(detail, null, 2)}\n`;
      const detailPath = resolve(evaluationHome, "evaluations", "details", "ikb-recall", `${detail.subjectHash}.json`);
      const detailPersistence = persistImmutable(detailPath, detailBytes);
      const receipt = buildIkbRecallEvalReceipt(detail, detailPersistence.hash);
      const receiptPersistence = persistEvalReceipt(evaluationHome, receipt);
      const feedback = projectFeedback(activeDataRoot, detail, receipt);
      if (detailPersistence.reused && receiptPersistence.reused && feedback.reused) reused += 1;
      else persisted += 1;
      evaluations.push({
        subjectRef: detail.subjectRef,
        subjectHash: detail.subjectHash,
        evaluationKey: receipt.evaluationKey,
        detailHash: detailPersistence.hash,
        detailReused: detailPersistence.reused,
        receiptRef: receiptPersistence.receiptRef,
        receiptReused: receiptPersistence.reused,
        feedbackCount: feedback.feedbackCount,
      });
    }
    evaluations.sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
    if (!explicitFrom && structuralIssues.length === 0 && !issues.some((issue) => issue.startsWith("ikb_"))) {
      const next = nextCursor(cursor, completed);
      if (next) writeCursor(evaluationHome, next);
    }
    const unavailable = loaded.scannedFiles === 0 && loaded.missingRoots === options.sessionRoots.length;
    return {
      schema: IKB_RECALL_COLLECTION_SCHEMA,
      status: unavailable ? "unavailable" : issues.length > 0 ? "degraded" : "ready",
      window: { from, to },
      scannedFiles: loaded.scannedFiles,
      completedTurns: completed.length,
      matchedTurns: evaluations.length,
      persisted,
      reused,
      userCorrectionsFound: corrections.length,
      userCorrectionsAdded: correctionsAdded,
      missedLookupCandidatesFound: missedLookups.length,
      missedLookupCandidatesAdded: missedLookupsAdded,
      skippedIncomplete: incomplete,
      issues: countIssues(issues),
      evaluations,
    };
  } finally {
    lock.release();
  }
}

export interface CollectIkbRecallV2Options extends CollectIkbRecallOptions {
  generatedAt?: string;
}

export interface IkbRecallV2CollectionReport {
  schema: "ikb-recall-usage-collection-v2";
  version: "v2";
  status: "ready" | "degraded" | "unavailable" | "busy";
  activation: { activatedAt: string; activationKey: string } | null;
  window: { from: string; to: string };
  scannedFiles: number;
  completedTurns: number;
  matchedTurns: number;
  attempts: number;
  searches: number;
  reads: number;
  states: number;
  correctionsFound: number;
  correctionsAdded: number;
  missedLookupCandidatesFound: number;
  missedLookupCandidatesAdded: number;
  skippedIncomplete: number;
  issues: Array<{ reasonCode: string; count: number }>;
}

interface IkbUsageV2Cursor {
  schema: "ikb-recall-usage-cursor-v2";
  lastCompletedAt: string;
  lastTurnKeys: string[];
}

function v2CursorScanStart(cursor: IkbUsageV2Cursor | null, activationAt: string): string {
  if (!cursor) return activationAt;
  return new Date(Math.max(Date.parse(activationAt), Date.parse(cursor.lastCompletedAt) - 24 * 60 * 60 * 1000)).toISOString();
}

function readV2Cursor(path: string): IkbUsageV2Cursor | null {
  if (!existsSync(path)) return null;
  const row = objectValue(JSON.parse(readRegular(path, "IKB usage v2 cursor")), "IKB usage v2 cursor");
  if (row.schema !== "ikb-recall-usage-cursor-v2" || !Array.isArray(row.lastTurnKeys) || row.lastTurnKeys.some((value) => typeof value !== "string")) throw new Error("IKB usage v2 cursor is invalid");
  return { schema: "ikb-recall-usage-cursor-v2", lastCompletedAt: timestamp(row.lastCompletedAt, "IKB usage v2 cursor timestamp"), lastTurnKeys: [...new Set(row.lastTurnKeys as string[])].sort() };
}

function writeV2Cursor(path: string, cursor: IkbUsageV2Cursor): void {
  atomicReplace(path, `${JSON.stringify(cursor, null, 2)}\n`);
}

function nextV2Cursor(current: IkbUsageV2Cursor | null, completed: Array<{ fact: RolloutFacts; turn: TurnFacts }>): IkbUsageV2Cursor | null {
  const lastCompletedAt = [...completed.flatMap(({ turn }) => turn.completedAt ? [turn.completedAt] : []), ...(current ? [current.lastCompletedAt] : [])].sort().at(-1);
  if (!lastCompletedAt) return current;
  const existing = current?.lastCompletedAt === lastCompletedAt ? current.lastTurnKeys : [];
  return {
    schema: "ikb-recall-usage-cursor-v2",
    lastCompletedAt,
    lastTurnKeys: [...new Set([...existing, ...completed.filter(({ turn }) => turn.completedAt === lastCompletedAt).map(({ fact, turn }) => turnKey(fact, turn))])].sort(),
  };
}

function emptyV2Report(activation: IkbRecallV2CollectionReport["activation"], status: IkbRecallV2CollectionReport["status"], from: string, to: string, issues: Array<{ reasonCode: string; count: number }>): IkbRecallV2CollectionReport {
  return { schema: "ikb-recall-usage-collection-v2", version: "v2", status, activation, window: { from, to }, scannedFiles: 0, completedTurns: 0, matchedTurns: 0, attempts: 0, searches: 0, reads: 0, states: 0, correctionsFound: 0, correctionsAdded: 0, missedLookupCandidatesFound: 0, missedLookupCandidatesAdded: 0, skippedIncomplete: 0, issues };
}

/** Collect the explicitly activated v2 diagnostic projection. */
export function collectIkbRecallRolloutsV2(options: CollectIkbRecallV2Options): IkbRecallV2CollectionReport {
  if (!Array.isArray(options.sessionRoots) || options.sessionRoots.length === 0) throw new Error("at least one Codex session root is required");
  const activeDataRoot = resolve(options.activeDataRoot);
  const evaluationHome = resolve(options.evaluationHome ?? activeDataRoot);
  if (!isAbsolute(options.activeDataRoot) || (options.evaluationHome && !isAbsolute(options.evaluationHome))) throw new Error("IKB usage v2 roots must be absolute");
  const activation = readIkbUsageV2Activation(activeDataRoot);
  const now = timestamp(options.generatedAt ?? new Date().toISOString(), "IKB usage v2 collection generated timestamp");
  const requestedFrom = timestamp(options.from ?? activation?.activatedAt ?? now, "IKB usage v2 collection from");
  const requestedTo = timestamp(options.to ?? now, "IKB usage v2 collection to");
  if (requestedFrom > requestedTo) throw new Error("IKB usage v2 collection from must not be after to");
  if (!activation) return emptyV2Report(null, "unavailable", requestedFrom, requestedTo, [{ reasonCode: "activation_required", count: 1 }]);
  const paths = ikbUsageV2Paths(activeDataRoot);
  const explicitFrom = options.from !== undefined;
  const cursor = explicitFrom ? null : readV2Cursor(paths.cursor);
  const from = timestamp(new Date(Math.max(Date.parse(activation.activatedAt), Date.parse(options.from ?? v2CursorScanStart(cursor, activation.activatedAt)))).toISOString(), "IKB usage v2 collection from");
  const to = requestedTo;
  if (from > to) throw new Error("IKB usage v2 collection from must not be after to");
  const lock = acquireLock(evaluationHome, options.lockTimeoutMs ?? 500);
  if (!lock.acquired) return emptyV2Report({ activatedAt: activation.activatedAt, activationKey: activation.activationKey }, "busy", from, to, [{ reasonCode: "collector_busy", count: 1 }]);
  try {
    const loaded = loadRollouts(options.sessionRoots, explicitFrom ? null : from);
    const structuralIssues = [...loaded.issues, ...(loaded.missingRoots === options.sessionRoots.length ? ["session_root_missing"] : [])];
    const issues = [...structuralIssues];
    // v2 deliberately retains root and subagent streams, with their relation
    // in each detail.  v1 continues to use its root-only compatibility path.
    const allTurns = loaded.facts.flatMap((fact) => fact.turns.map((turn) => ({ fact, turn })));
    const completed = allTurns.filter(({ fact, turn }) => Boolean(turn.completedAt) && turn.startedAt >= activation.activatedAt && turn.completedAt! >= from && turn.completedAt! <= to && afterCursor(fact, turn, cursor));
    const incomplete = allTurns.filter(({ turn }) => !turn.completedAt && turn.startedAt >= activation.activatedAt && turn.startedAt >= from && turn.startedAt <= to).length;
    const details: IkbUsageV2EvidenceDetail[] = [];
    for (const { fact, turn } of completed) {
      issues.push(...turn.issues);
      const detail = buildUsageV2Detail(fact, turn);
      if (!detail) continue;
      details.push(detail);
    }
    const corrections: UserCorrectionRecord[] = [];
    const missedLookups: MissedLookupCandidate[] = [];
    for (const { fact, turn } of completed) {
      corrections.push(...scanUserCorrections(fact.threadId, turn));
      const missed = scanMissedLookup(fact.threadId, turn);
      if (missed) missedLookups.push(missed);
    }
    const correctionsAdded = projectIkbUsageV2Corrections(activeDataRoot, corrections as unknown as Array<Record<string, unknown>>);
    const missedLookupsAdded = projectIkbUsageV2MissedLookups(activeDataRoot, missedLookups as unknown as Array<Record<string, unknown>>);
    const summary = projectIkbUsageV2(activeDataRoot, details, now);
    if (!explicitFrom && structuralIssues.length === 0) {
      const next = nextV2Cursor(cursor, completed);
      if (next) writeV2Cursor(paths.cursor, next);
    }
    const status: IkbRecallV2CollectionReport["status"] = structuralIssues.length > 0 || issues.length > 0 ? "degraded" : "ready";
    return {
      schema: "ikb-recall-usage-collection-v2",
      version: "v2",
      status,
      activation: { activatedAt: activation.activatedAt, activationKey: activation.activationKey },
      window: { from, to },
      scannedFiles: loaded.scannedFiles,
      completedTurns: completed.length,
      matchedTurns: details.length,
      attempts: summary.last7Days.attempts,
      searches: summary.last7Days.searches,
      reads: summary.last7Days.reads,
      states: summary.last7Days.states,
      correctionsFound: corrections.length,
      correctionsAdded,
      missedLookupCandidatesFound: missedLookups.length,
      missedLookupCandidatesAdded: missedLookupsAdded,
      skippedIncomplete: incomplete,
      issues: countIssues(issues),
    };
  } finally {
    lock.release();
  }
}

export { activateIkbUsageV2, ikbUsageV2Paths, projectIkbUsageV2Corrections, readIkbUsageV2Activation, readIkbUsageV2Summary };
