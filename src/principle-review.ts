import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertInboxItem } from "./inbox.ts";
import { listKnowledge } from "./knowledge.ts";
import { writeReceipt, type ReceiptOperation } from "./receipt.ts";
import type { LedgerStore } from "./store.ts";
import { ikbPaths } from "./layout.ts";
import {
  HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION,
  writeHumanConfirmationBrief,
  type HumanConfirmationBriefItem,
} from "./human-confirmation.ts";

const STALE_PENDING_LINE = "- 当前产物是 pending_review Principle 候选，未获用户逐项确认前不得进入默认检索。";
const STALE_PENDING_RE = new RegExp(`^${escapeRegExp(STALE_PENDING_LINE)}$`, "m");

export function scanPrincipleConfirmationConflicts(home: string, store: LedgerStore, scope: "personal" | "work" = "work", limit = 3) {
  const startedAt = new Date().toISOString();
  const candidates = listKnowledge(home, scope)
    .filter((record) => record.type.trim().toLowerCase() === "principle")
    .filter((record) => record.status === "verified" && record.verification === "user_confirmed")
    .filter((record) => STALE_PENDING_RE.test(readFileSync(record.path, "utf8")))
    .slice(0, limit);
  const directory = join(ikbPaths(home).inbox, scope, "principle-diffs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const operations: ReceiptOperation[] = [];
  const reviews = candidates.map((record) => {
    const currentText = readFileSync(record.path, "utf8");
    const proposedText = currentText.replace(`${STALE_PENDING_LINE}\n`, "");
    if (proposedText === currentText) throw new Error(`Principle conflict line was not removed: ${record.id}`);
    const currentHash = hash(currentText);
    const proposedHash = hash(proposedText);
    const proposedPath = join(directory, `${record.id}-proposed.md`);
    const reviewPath = join(directory, `${record.id}-review.md`);
    writeFileSync(proposedPath, proposedText, { mode: 0o600 });
    chmodSync(proposedPath, 0o600);
    const review = [
      `# ${record.title} 待确认差异`,
      "",
      "## 冲突",
      "",
      `- Knowledge：${record.id}`,
      `- 当前 metadata：status=${record.status}，verification=${record.verification}`,
      "- 当前正文仍声明 pending_review，二者不能同时成立。",
      `- 当前完整稿：${record.path}`,
      `- 当前 hash：${currentHash}`,
      `- 最小提议稿：${proposedPath}`,
      `- 提议稿 hash：${proposedHash}`,
      "",
      "## 最小差异",
      "",
      "```diff",
      "- 当前产物是 pending_review Principle 候选，未获用户逐项确认前不得进入默认检索。",
      "```",
      "",
      "提议只删除上面这条过时边界，其余字节保持不变。当前 Knowledge、status、projection 和 AGENTS.md 均未修改。",
      "",
      "## 需要的精确确认",
      "",
      `- 确认：接受提议稿完整字节（sha256=${proposedHash}），继续保持 verified/user_confirmed；或`,
      "- 驳回：不确认该完整稿，后续把 Knowledge 退回 draft 并移出默认召回与 AGENTS 投影。",
      "",
      "## Source refs",
      "",
      ...record.sourceRefs.map((ref) => `- ${ref}`),
      "",
    ].join("\n");
    writeFileSync(reviewPath, review, { mode: 0o600 });
    chmodSync(reviewPath, 0o600);
    const inbox = upsertInboxItem(home, {
      scope,
      trigger: "principle_confirmation",
      subject: record.title,
      goal: `确认提议稿完整字节 ${proposedHash}，或决定退回 draft`,
      sourceRefs: record.sourceRefs,
      knowledgeIds: [record.id],
      usageId: null,
      details: {
        conflict: "verified_metadata_with_pending_review_body",
        currentPath: record.path,
        currentHash,
        proposedPath,
        proposedHash,
        reviewPath,
      },
    });
    operations.push({
      action: "principle_diff",
      subjectRef: `knowledge://${record.id}`,
      inputRefs: [`knowledge://${record.id}`],
      outputRefs: [proposedPath, reviewPath, `inbox://${inbox.id}`],
      sourceRefs: record.sourceRefs,
      beforeHash: currentHash,
      afterHash: proposedHash,
      applicability: record.applicability || null,
      boundary: record.boundary || null,
      validation: {
        status: "passed",
        checks: ["metadata conflict located", "proposal removes only the stale pending_review line", "original Knowledge unchanged"],
        issues: [],
      },
      outcome: "pending_confirmation",
      confirmation: null,
    });
    return { knowledgeId: record.id, title: record.title, sourceRefs: record.sourceRefs, inboxId: inbox.id, currentPath: record.path, currentHash, proposedPath, proposedHash, reviewPath };
  });
  const confirmationBrief = reviews.length === 0 ? null : writeHumanConfirmationBrief(home, {
    id: `principle-conflict-scan-${hash(`${HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION}|${reviews.map((review) => `${review.knowledgeId}:${review.proposedHash}`).join("|")}`).slice(0, 12)}`,
    scope,
    title: "Principle 冲突人工确认稿",
    purpose: "请按提议稿逐项确认或驳回；本稿不自动修改 Knowledge、状态或 AGENTS。",
    items: reviews.map((review, index) => principleConfirmationItem({
      key: confirmationKey(index),
      title: review.title,
      text: readFileSync(review.proposedPath, "utf8"),
      applicability: "",
      boundary: "",
      proposalPath: review.proposedPath,
      proposalHash: review.proposedHash,
      sourceRefs: review.sourceRefs,
    })),
  });
  const receipt = writeReceipt(home, store, {
    kind: "semantic_maintenance",
    scope,
    command: "principle-conflict-scan",
    startedAt,
    outcome: reviews.length > 0 ? "partial" : "succeeded",
    operations: operations.length > 0 ? operations : [{
      action: "principle_diff",
      subjectRef: null,
      inputRefs: [],
      outputRefs: [],
      sourceRefs: [],
      beforeHash: null,
      afterHash: hash("no-conflict"),
      applicability: null,
      boundary: "No verified Principle contains the stale pending_review marker",
      validation: { status: "passed", checks: ["Principles scanned"], issues: [] },
      outcome: "nothing_to_do",
      confirmation: null,
    }],
  });
  return { scope, checked: listKnowledge(home, scope).filter((record) => record.type.trim().toLowerCase() === "principle").length, conflicts: reviews.length, reviews, confirmationBrief, receipt };
}

export function principleConfirmationItem(value: {
  key: string;
  title: string;
  text: string;
  applicability: string;
  boundary: string;
  proposalPath: string;
  proposalHash: string;
  sourceRefs: string[];
}): HumanConfirmationBriefItem {
  return {
    key: value.key,
    title: value.title,
    content: markdownSection(value.text, ["statement", "claim"]) || value.text.trim() || "未知",
    triggers: firstNonEmpty(sectionValues(markdownSection(value.text, ["triggers"])), sectionValues(value.applicability), ["未知"]),
    boundaries: firstNonEmpty([
      ...sectionValues(markdownSection(value.text, ["exceptions", "boundary", "边界"])),
      ...sectionValues(value.boundary),
    ].filter((item, index, values) => values.indexOf(item) === index), ["未知"]),
    retirementSignals: firstNonEmpty(sectionValues(markdownSection(value.text, ["retirement_signals", "retirement signals"])), ["未知"]),
    confirmEffect: "接受该提议稿的精确文本；不会自动执行确认或修改 Knowledge。",
    rejectEffect: "不接受该提议稿；保持当前 Knowledge 与待确认边界不变。",
    proposalPath: value.proposalPath,
    proposalHash: value.proposalHash,
    sourceRefs: value.sourceRefs,
  };
}

export function confirmationKey(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function markdownSection(text: string, names: string[]): string {
  const headings = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`^#{1,6}\\s*(?:${headings})\\s*$([\\s\\S]*?)(?=^#{1,6}\\s|(?![\\s\\S]))`, "im"));
  return match?.[1]?.trim() ?? "";
}

function sectionValues(value: string): string[] {
  const items = value.split("\n").map((line) => line.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  return items.length > 0 ? items : [];
}

function firstNonEmpty(...values: string[][]): string[] {
  return values.find((value) => value.length > 0) ?? [];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
