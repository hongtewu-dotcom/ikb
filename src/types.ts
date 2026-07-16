export type OutputFormat = "table" | "json";

export type TaskStatus = "open" | "active" | "waiting" | "done" | "canceled";
export type RunStatus = "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "canceled";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Task {
  id: string;
  title: string;
  goal: string;
  acceptance: string;
  type: string;
  priority: string;
  risk: string;
  scope: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  evidenceArtifactId: string | null;
}

export interface Run {
  id: string;
  taskId: string;
  agentId: string;
  skillIds: string;
  status: RunStatus;
  retryOf: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  checkpoint: string | null;
  failureReason: string | null;
  runDir: string;
}

export interface Approval {
  id: string;
  taskId: string;
  runId: string;
  action: string;
  target: string;
  payloadHash: string;
  risk: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  runId: string;
  kind: string;
  label: string;
  path: string;
  contentHash: string | null;
  createdAt: string;
}

export interface EventRecord {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  eventType: string;
  actor: string;
  occurredAt: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  previousHash: string | null;
  eventHash: string;
}

export interface StoreOptions {
  home: string;
  actor?: string;
}

export type KnowledgeStatus = "draft" | "verified" | "retired";
export type KnowledgeRelationType = "related" | "derived_from" | "contradicts";
export type SourceKind = "elephant" | "ai_conversation" | "document" | "review_comment" | "artifact" | "manual" | string;
export type KnowledgeSourceKind = SourceKind;

export interface KnowledgeRecord {
  id: string;
  title: string;
  type: string;
  sourceKind: KnowledgeSourceKind;
  scope: string;
  sensitivity: string;
  status: KnowledgeStatus;
  sourceRefs: string[];
  validFrom: string;
  reviewAfter: string;
  tags: string[];
  aliases: string[];
  related: string[];
  derivedFrom: string[];
  contradicts: string[];
  path: string;
  body: string;
}

export interface KnowledgeRelationResult {
  relationType: KnowledgeRelationType;
  changed: boolean;
  reciprocal: boolean;
  source: KnowledgeRecord;
  target: KnowledgeRecord;
}

export interface SourceRecord {
  id: string;
  title: string;
  kind: SourceKind;
  scope: string;
  sensitivity: string;
  format: "jsonl" | "markdown";
  originalPath: string;
  rawPath: string;
  recordsPath: string;
  contentHash: string;
  recordCount: number;
  importedAt: string;
}

export interface SourceMessage {
  id: string;
  sourceId: string;
  conversationId: string;
  role: string;
  actor: string;
  timestamp: string;
  content: string;
  refs: string[];
  participants: string[];
}

export interface SourceContext {
  source: SourceRecord;
  records: SourceMessage[];
  markdown: string;
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  type: string;
  scope: string;
  status: KnowledgeStatus;
  path: string;
  score: number;
  snippet: string;
}
