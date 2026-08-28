import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { archiveInboxItem, findInboxItem, type InboxItem } from "./inbox.ts";
import {
  assertActiveCanonicalKeyAvailable,
  assertKnowledgeQuality,
  findKnowledge,
  installReviewedKnowledge,
  rebuildKnowledgeViews,
  updateKnowledgeStatus,
} from "./knowledge.ts";
import { parseKnowledge, renderKnowledge } from "./knowledge/codec.ts";
import { writeReceipt, type ReceiptOperation, type ReceiptValidation } from "./receipt.ts";
import type { LedgerStore } from "./store.ts";
import type { KnowledgeRecord } from "./types.ts";
import { HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION, writeHumanConfirmationBrief } from "./human-confirmation.ts";
import { confirmationKey, principleConfirmationItem } from "./principle-review.ts";

export const SEMANTIC_MAINTENANCE_SCHEMA = "ikb-semantic-maintenance.v1";

export interface SemanticMaintenanceDecision {
  inboxId: string;
  action: "new" | "update" | "keep" | "retire" | "ignore" | "principle_diff";
  knowledgeId?: string;
  replacementPath?: string;
  reason: string;
  validation: ReceiptValidation;
  confirmation?: {
    actor: string;
    confirmedAt: string;
    exactTextHash: string;
  };
}

export interface SemanticMaintenanceInput {
  schema: typeof SEMANTIC_MAINTENANCE_SCHEMA;
  scope: "personal" | "work";
  startedAt?: string;
  decisions: SemanticMaintenanceDecision[];
}

export function applySemanticMaintenance(home: string, store: LedgerStore, input: SemanticMaintenanceInput) {
  if (input.schema !== SEMANTIC_MAINTENANCE_SCHEMA) throw new Error(`Semantic maintenance requires ${SEMANTIC_MAINTENANCE_SCHEMA}`);
  if (input.scope !== "personal" && input.scope !== "work") throw new Error("Semantic maintenance scope must be personal or work");
  if (!Array.isArray(input.decisions) || input.decisions.length > 3) throw new Error("Semantic maintenance accepts at most three Inbox decisions");
  const duplicate = input.decisions.find((decision, index) => input.decisions.findIndex((candidate) => candidate.inboxId === decision.inboxId) !== index);
  if (duplicate) throw new Error(`Semantic maintenance repeats Inbox item ${duplicate.inboxId}`);
  const operations: ReceiptOperation[] = [];
  const archiveIds: string[] = [];
  const failures: Array<{ inboxId: string; error: string }> = [];
  for (const decision of input.decisions) {
    const inbox = findInboxItem(home, decision.inboxId);
    if (!inbox) {
      failures.push({ inboxId: decision.inboxId, error: "Inbox item not found" });
      operations.push(blockedOperation(decision, null, "inbox_item_not_found"));
      continue;
    }
    if (inbox.scope !== input.scope) {
      failures.push({ inboxId: decision.inboxId, error: `Inbox scope ${inbox.scope} does not match ${input.scope}` });
      operations.push(blockedOperation(decision, inbox, "inbox_scope_mismatch"));
      continue;
    }
    try {
      const result = applyDecision(home, store, inbox, decision);
      operations.push(result.operation);
      if (result.archive) archiveIds.push(inbox.id);
    } catch (error) {
      failures.push({ inboxId: inbox.id, error: (error as Error).message });
      operations.push(blockedOperation(decision, inbox, (error as Error).message));
    }
  }
  const pendingPrinciples = operations.filter((operation) => operation.action === "principle_diff").length;
  const confirmationBrief = pendingPrinciples === 0 ? null : writeHumanConfirmationBrief(home, {
    id: `semantic-maintenance-${hash(`${HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION}|${operations.filter((operation) => operation.action === "principle_diff").map((operation) => `${operation.subjectRef}:${operation.afterHash}`).join("|")}`).slice(0, 12)}`,
    scope: input.scope,
    title: "Principle 变更人工确认稿",
    purpose: "请按提议稿逐项确认或驳回；本稿不自动确认或修改 Knowledge。",
    items: operations.flatMap((operation, index) => {
      if (operation.action !== "principle_diff") return [];
      const decision = input.decisions[index];
      const replacement = decision?.replacementPath ? readReplacement(decision.replacementPath) : null;
      const current = decision?.knowledgeId ? findKnowledge(home, decision.knowledgeId) : null;
      const proposal = replacement ? parseKnowledge(replacement.text, replacement.path) : null;
      return [principleConfirmationItem({
        key: confirmationKey(operations.slice(0, index + 1).filter((item) => item.action === "principle_diff").length - 1),
        title: current?.title ?? proposal?.title ?? decision?.knowledgeId ?? "Principle proposal",
        text: replacement?.text ?? current?.body ?? "",
        applicability: current?.applicability ?? "",
        boundary: current?.boundary ?? "",
        proposalPath: operation.outputRefs[0] ?? "",
        proposalHash: operation.afterHash ?? "",
        sourceRefs: operation.sourceRefs,
      })];
    }),
  });
  const receipt = writeReceipt(home, store, {
    kind: "semantic_maintenance",
    scope: input.scope,
    command: "semantic-maintenance",
    startedAt: input.startedAt ?? new Date().toISOString(),
    outcome: failures.length > 0 || pendingPrinciples > 0 ? "partial" : "succeeded",
    operations,
  });
  const archived = archiveIds.map((id) => archiveInboxItem(home, id));
  return {
    schema: SEMANTIC_MAINTENANCE_SCHEMA,
    scope: input.scope,
    selected: input.decisions.length,
    changed: operations.filter((operation) => ["new", "update", "retire"].includes(operation.action)).length,
    pendingPrinciples,
    confirmationBrief,
    failures,
    archived,
    receipt,
  };
}

function applyDecision(
  home: string,
  store: LedgerStore,
  inbox: InboxItem & { path: string },
  decision: SemanticMaintenanceDecision,
): { operation: ReceiptOperation; archive: boolean } {
  if (!decision.reason?.trim()) throw new Error("Semantic decision reason must not be empty");
  if (!decision.validation || !["passed", "failed", "skipped"].includes(decision.validation.status)) throw new Error("Semantic decision validation is invalid");
  if (decision.action === "keep" || decision.action === "ignore") {
    return {
      operation: operationFor(inbox, decision, {
        action: decision.action,
        subject: decision.knowledgeId ? `knowledge://${decision.knowledgeId}` : `inbox://${inbox.id}`,
        outputRefs: [],
        sourceRefs: inbox.sourceRefs,
        beforeHash: null,
        afterHash: null,
        applicability: inbox.goal,
        boundary: decision.reason,
        outcome: decision.action,
      }),
      archive: true,
    };
  }
  if (decision.action === "principle_diff") {
    const replacement = readReplacement(decision.replacementPath);
    return {
      operation: operationFor(inbox, decision, {
        action: "principle_diff",
        subject: decision.knowledgeId ? `knowledge://${decision.knowledgeId}` : `inbox://${inbox.id}`,
        outputRefs: replacement ? [replacement.path] : [],
        sourceRefs: inbox.sourceRefs,
        beforeHash: decision.knowledgeId ? hashKnowledge(home, decision.knowledgeId) : null,
        afterHash: replacement?.hash ?? null,
        applicability: inbox.goal,
        boundary: "Principle exact text, scope and exceptions require human confirmation",
        outcome: "pending_confirmation",
      }),
      archive: false,
    };
  }
  if (decision.validation.status !== "passed") throw new Error(`${decision.action} requires validation.status=passed`);
  if (decision.action === "new") {
    const replacement = requireReplacement(decision.replacementPath);
    const parsed = parseKnowledge(replacement.text, replacement.path);
    requireSourceAndBoundary(parsed);
    if (isPrinciple(parsed) && !validConfirmation(decision, replacement.hash)) {
      return principleDiff(inbox, decision, null, replacement.hash, replacement.path);
    }
    const installed = installReviewedKnowledge(home, replacement.text, replacement.path);
    store.recordKnowledgeEvent(installed.record.id, "knowledge.created", knowledgeEventPayload(installed.record));
    const afterHash = hashFile(installed.record.path);
    return {
      operation: operationFor(inbox, decision, {
        action: "new",
        subject: `knowledge://${installed.record.id}`,
        outputRefs: [`knowledge://${installed.record.id}`],
        sourceRefs: installed.record.sourceRefs,
        beforeHash: null,
        afterHash,
        applicability: installed.record.applicability,
        boundary: installed.record.boundary,
        outcome: installed.recovered ? "recovered" : "created",
      }),
      archive: true,
    };
  }
  const knowledgeId = decision.knowledgeId?.trim();
  if (!knowledgeId) throw new Error(`${decision.action} requires knowledgeId`);
  const current = findKnowledge(home, knowledgeId);
  if (!current) throw new Error(`Knowledge not found: ${knowledgeId}`);
  if (current.scope !== inbox.scope) throw new Error(`Knowledge scope ${current.scope} does not match Inbox scope ${inbox.scope}`);
  const beforeHash = hashFile(current.path);
  if (decision.action === "retire") {
    if (isPrinciple(current) && !validConfirmation(decision, beforeHash)) {
      return principleDiff(inbox, decision, beforeHash, beforeHash, current.path);
    }
    requireSourceAndBoundary(current);
    const retired = updateKnowledgeStatus(home, current.id, "retired");
    store.recordKnowledgeEvent(retired.id, "knowledge.retired", {
      sourceRefs: retired.sourceRefs,
      reason: decision.reason,
      beforeHash,
      afterHash: hashFile(retired.path),
    });
    return {
      operation: operationFor(inbox, decision, {
        action: "retire",
        subject: `knowledge://${retired.id}`,
        outputRefs: [`knowledge://${retired.id}`],
        sourceRefs: retired.sourceRefs,
        beforeHash,
        afterHash: hashFile(retired.path),
        applicability: retired.applicability,
        boundary: retired.boundary,
        outcome: "retired",
      }),
      archive: true,
    };
  }
  const replacement = requireReplacement(decision.replacementPath);
  const parsed = parseKnowledge(replacement.text, replacement.path);
  if (parsed.id !== current.id) throw new Error(`Replacement Knowledge id ${parsed.id} must match ${current.id}`);
  if (parsed.scope !== current.scope) throw new Error(`Replacement Knowledge scope ${parsed.scope} must match ${current.scope}`);
  if (parsed.type !== current.type || parsed.collection !== current.collection) throw new Error("Knowledge update cannot change type or collection");
  requireSourceAndBoundary(parsed);
  if (isPrinciple(current) && !validConfirmation(decision, replacement.hash)) {
    return principleDiff(inbox, decision, beforeHash, replacement.hash, replacement.path);
  }
  const updated = writeKnowledgeUpdate(home, current, parsed);
  const afterHash = hashFile(updated.path);
  store.recordKnowledgeEvent(updated.id, "knowledge.revised", {
    sourceRefs: updated.sourceRefs,
    reason: decision.reason,
    beforeHash,
    afterHash,
    beforeRevision: current.revision,
    afterRevision: updated.revision,
  });
  return {
    operation: operationFor(inbox, decision, {
      action: "update",
      subject: `knowledge://${updated.id}`,
      outputRefs: [`knowledge://${updated.id}`],
      sourceRefs: updated.sourceRefs,
      beforeHash,
      afterHash,
      applicability: updated.applicability,
      boundary: updated.boundary,
      outcome: "updated",
    }),
    archive: true,
  };
}

function writeKnowledgeUpdate(home: string, current: KnowledgeRecord, replacement: KnowledgeRecord): KnowledgeRecord {
  const updated: KnowledgeRecord = {
    ...replacement,
    path: current.path,
    revision: current.revision + 1,
    revisionHistory: current.revisionHistory,
  };
  assertKnowledgeQuality(updated, { requireAdmission: true });
  assertActiveCanonicalKeyAvailable(home, updated);
  const text = renderKnowledge(updated);
  const temporary = `${current.path}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, current.path);
  chmodSync(current.path, 0o600);
  rebuildKnowledgeViews(home, updated.scope);
  return parseKnowledge(readFileSync(current.path, "utf8"), current.path);
}

function principleDiff(
  inbox: InboxItem,
  decision: SemanticMaintenanceDecision,
  beforeHash: string | null,
  afterHash: string,
  path: string,
): { operation: ReceiptOperation; archive: false } {
  return {
    operation: operationFor(inbox, decision, {
      action: "principle_diff",
      subject: decision.knowledgeId ? `knowledge://${decision.knowledgeId}` : `inbox://${inbox.id}`,
      outputRefs: [path],
      sourceRefs: inbox.sourceRefs,
      beforeHash,
      afterHash,
      applicability: inbox.goal,
      boundary: "Principle exact text, scope and exceptions require human confirmation",
      outcome: "pending_confirmation",
    }),
    archive: false,
  };
}

function operationFor(
  inbox: InboxItem,
  decision: SemanticMaintenanceDecision,
  value: {
    action: string;
    subject: string;
    outputRefs: string[];
    sourceRefs: string[];
    beforeHash: string | null;
    afterHash: string | null;
    applicability: string | null;
    boundary: string | null;
    outcome: string;
  },
): ReceiptOperation {
  return {
    action: value.action,
    subjectRef: value.subject,
    // Keep the exact reviewed replacement in the immutable Receipt input set.
    // This is the proof link consumed by Receipt-based Principle confirmation.
    inputRefs: [`inbox://${inbox.id}`, ...(decision.replacementPath ? [resolve(decision.replacementPath)] : [])],
    outputRefs: value.outputRefs,
    sourceRefs: value.sourceRefs,
    beforeHash: value.beforeHash,
    afterHash: value.afterHash,
    applicability: value.applicability,
    boundary: value.boundary,
    validation: decision.validation,
    outcome: value.outcome,
    confirmation: decision.confirmation ?? null,
  };
}

function blockedOperation(decision: SemanticMaintenanceDecision, inbox: InboxItem | null, issue: string): ReceiptOperation {
  return {
    action: "blocked",
    subjectRef: inbox ? `inbox://${inbox.id}` : null,
    inputRefs: inbox ? [`inbox://${inbox.id}`] : [],
    outputRefs: [],
    sourceRefs: inbox?.sourceRefs ?? [],
    beforeHash: null,
    afterHash: null,
    applicability: inbox?.goal ?? null,
    boundary: decision.reason?.trim() || null,
    validation: { status: "failed", checks: decision.validation?.checks ?? [], issues: [issue] },
    outcome: "blocked",
    confirmation: decision.confirmation ?? null,
  };
}

function readReplacement(path?: string): { path: string; text: string; hash: string } | null {
  return path ? requireReplacement(path) : null;
}

function requireReplacement(path?: string): { path: string; text: string; hash: string } {
  if (!path) throw new Error("Semantic decision requires replacementPath");
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Replacement file not found: ${path}`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Replacement must be a regular file: ${path}`);
  const text = readFileSync(resolved, "utf8");
  return { path: resolved, text, hash: createHash("sha256").update(text).digest("hex") };
}

function requireSourceAndBoundary(record: KnowledgeRecord): void {
  if (record.sourceRefs.length === 0) throw new Error(`Knowledge ${record.id} requires Source refs`);
  if (!record.applicability.trim()) throw new Error(`Knowledge ${record.id} requires applicability`);
  if (!record.boundary.trim()) throw new Error(`Knowledge ${record.id} requires boundary`);
}

function validConfirmation(decision: SemanticMaintenanceDecision, exactTextHash: string): boolean {
  const confirmation = decision.confirmation;
  return Boolean(confirmation?.actor.trim()
    && !Number.isNaN(Date.parse(confirmation.confirmedAt))
    && confirmation.exactTextHash === exactTextHash);
}

function isPrinciple(record: KnowledgeRecord): boolean {
  return record.type.trim().toLowerCase() === "principle";
}

function hashKnowledge(home: string, id: string): string | null {
  const record = findKnowledge(home, id);
  return record ? hashFile(record.path) : null;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function knowledgeEventPayload(record: KnowledgeRecord): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    type: record.type,
    collection: record.collection,
    scope: record.scope,
    status: record.status,
    sourceRefs: record.sourceRefs,
    path: record.path,
    revision: record.revision,
  };
}
