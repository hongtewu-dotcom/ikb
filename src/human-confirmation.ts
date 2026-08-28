import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ikbPaths } from "./layout.ts";

export const HUMAN_CONFIRMATION_BRIEF_SCHEMA = "ikb-human-confirmation-brief.v1";
export const HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION = 3;

export interface HumanConfirmationBriefItem {
  key: string;
  title: string;
  content: string;
  triggers: string[];
  boundaries: string[];
  retirementSignals: string[];
  confirmEffect: string;
  rejectEffect: string;
  proposalPath: string | null;
  proposalHash: string | null;
  sourceRefs: string[];
}

export interface HumanConfirmationBrief {
  schema: typeof HUMAN_CONFIRMATION_BRIEF_SCHEMA;
  id: string;
  scope: "personal" | "work";
  path: string;
  contentHash: string;
  itemCount: number;
}

export interface ArchivedHumanConfirmationFile {
  name: string;
  from: string;
  to: string;
  candidateIds: string[];
  reason: "resolved_candidate" | "invalid_candidate_brief" | "historical_json";
}

/** Writes one human-readable confirmation entrance. Audit bindings deliberately
 * live only in the final appendix, so they do not compete with the decision. */
export function writeHumanConfirmationBrief(home: string, input: {
  id: string;
  scope: "personal" | "work";
  title: string;
  purpose: string;
  items: HumanConfirmationBriefItem[];
}): HumanConfirmationBrief {
  validateInput(input);
  const path = join(ikbPaths(home).inbox, input.scope, "confirmations", `${input.id}.md`);
  const content = renderBrief(input);
  const contentHash = sha256(content);

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== content) throw new Error(`Human confirmation brief already exists with different content: ${input.id}`);
  } else {
    writeAtomic(path, content);
  }

  return { schema: HUMAN_CONFIRMATION_BRIEF_SCHEMA, id: input.id, scope: input.scope, path, contentHash, itemCount: input.items.length };
}

/** Candidate confirmation pages are actionable only while at least one bound
 * Candidate still waits for a decision/application.  Terminal or malformed
 * pages are audit history and must not stay in Inbox, where file presence
 * means pending work.  Non-candidate Markdown briefs are left untouched. */
export function archiveResolvedHumanConfirmationFiles(
  home: string,
  scope: "personal" | "work",
  candidateStatuses: ReadonlyMap<string, string>,
): ArchivedHumanConfirmationFile[] {
  const sourceDirectory = join(ikbPaths(home).inbox, scope, "confirmations");
  if (!existsSync(sourceDirectory)) return [];
  const sourceStat = lstatSync(sourceDirectory);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`Human confirmation directory must be a real directory: ${sourceDirectory}`);
  const targetDirectory = join(ikbPaths(home).archive, "inbox", scope, "confirmations");
  const archived: ArchivedHumanConfirmationFile[] = [];
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(sourceDirectory, entry.name);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`Human confirmation file must not be a symlink: ${from}`);
    const content = readFileSync(from, "utf8");
    const candidateIds = [...new Set([...content.matchAll(/experience-candidate:(exp-cand-[A-Za-z0-9]+)/g)].map((match) => match[1]))].sort();
    let reason: ArchivedHumanConfirmationFile["reason"] | null = null;
    if (entry.name.endsWith(".json")) reason = "historical_json";
    else if (entry.name.startsWith("candidate-") && candidateIds.length === 0) reason = "invalid_candidate_brief";
    else if (entry.name.startsWith("candidate-") && candidateIds.every((id) => ["applied", "rejected"].includes(candidateStatuses.get(id) ?? ""))) reason = "resolved_candidate";
    if (!reason) continue;
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    chmodSync(targetDirectory, 0o700);
    const to = join(targetDirectory, entry.name);
    if (existsSync(to)) {
      if (readFileSync(to, "utf8") !== content) throw new Error(`Archived human confirmation file differs: ${to}`);
      unlinkSync(from);
    } else {
      renameSync(from, to);
    }
    chmodSync(to, 0o600);
    archived.push({ name: entry.name, from, to, candidateIds, reason });
  }
  return archived;
}

function renderBrief(input: { id: string; scope: "personal" | "work"; title: string; purpose: string; items: HumanConfirmationBriefItem[] }): string {
  const sections = [
    `# ${input.title}`,
    "",
    "## 用户在确认什么",
    "",
    input.purpose,
    "",
    ...input.items.flatMap((item) => renderDecisionItem(item)),
    "## 简单回复格式",
    "",
    "请直接按 item key 回复；可在驳回后补充原因。",
    "",
    "```text",
    `确认：${input.items.map((item) => item.key).join("、")}`,
    `驳回：${input.items[0]?.key ?? "<item-key>"}（原因：<可选>）`,
    "```",
    "",
    "## 机器审计附录",
    "",
    `- Schema: ${HUMAN_CONFIRMATION_BRIEF_SCHEMA}`,
    `- Render version: ${HUMAN_CONFIRMATION_BRIEF_RENDER_VERSION}`,
    `- Brief ID: ${input.id}`,
    `- Scope: ${input.scope}`,
    "",
    ...input.items.flatMap((item) => renderAuditItem(item)),
  ];
  return `${sections.join("\n")}\n`;
}

function renderDecisionItem(item: HumanConfirmationBriefItem): string[] {
  return [
    `## ${item.key}. ${item.title}`,
    "",
    item.content,
    "",
    "### 触发条件",
    "",
    ...renderList(item.triggers),
    "",
    "### 边界",
    "",
    ...renderList(item.boundaries),
    "",
    "### 退役信号",
    "",
    ...renderList(item.retirementSignals),
    "",
    "### 确认后的影响",
    "",
    item.confirmEffect,
    "",
    "### 驳回后的影响",
    "",
    item.rejectEffect,
    "",
  ];
}

function renderAuditItem(item: HumanConfirmationBriefItem): string[] {
  return [
    `### ${item.key}`,
    "",
    `- Proposal path: ${item.proposalPath ?? "none"}`,
    `- Proposal hash: ${item.proposalHash ?? "none"}`,
    "- Source refs:",
    ...renderList(item.sourceRefs),
    "",
  ];
}

function renderList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- 无"];
}

function validateInput(input: { id: string; scope: "personal" | "work"; title: string; purpose: string; items: HumanConfirmationBriefItem[] }): void {
  if (!/^[a-z0-9._-]+$/u.test(input.id)) throw new Error(`Invalid human confirmation brief id: ${input.id}`);
  if (input.scope !== "personal" && input.scope !== "work") throw new Error(`Invalid human confirmation brief scope: ${input.scope}`);
  if (!input.title.trim()) throw new Error("Human confirmation brief title is required");
  if (!input.purpose.trim()) throw new Error("Human confirmation brief purpose is required");
  if (input.items.length === 0) throw new Error("Human confirmation brief requires at least one item");
  const keys = new Set<string>();
  for (const item of input.items) {
    if (!/^[A-Za-z0-9._-]+$/u.test(item.key) || keys.has(item.key)) throw new Error(`Human confirmation item key must be safe and unique: ${item.key}`);
    keys.add(item.key);
    if (!item.title.trim() || !item.content.trim() || !item.confirmEffect.trim() || !item.rejectEffect.trim()) {
      throw new Error(`Human confirmation item is incomplete: ${item.key}`);
    }
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
