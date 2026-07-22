import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findKeyPerson, type KeyPerson } from "./people.ts";
import { resolveVault } from "./layout.ts";
import { listSources, readSourceRecords } from "./source.ts";
import type { SourceMessage, SourceRecord } from "./types.ts";

export interface PersonViewOptions {
  name?: string;
  uid?: string;
  mis?: string;
  sourceId?: string;
  scope?: string;
  from?: string;
  to?: string;
  contextWindow?: number;
  limit?: number;
}

export interface PersonViewResult {
  selector: { kind: "name" | "uid" | "mis"; value: string };
  scope: string;
  sourceCount: number;
  scannedRecordCount: number;
  matchedCount: number;
  duplicateCount: number;
  returnedCount: number;
  truncated: boolean;
  contextWindow: number;
  sources: Array<{
    sourceId: string;
    title: string;
    recordCount: number;
    matchedCount: number;
  }>;
  matches: Array<{
    sourceId: string;
    sourceTitle: string;
    record: PersonRecordView;
    context: PersonRecordView[];
  }>;
}

export interface PersonDossierOptions {
  personId: string;
  scope?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface PersonDossierSource {
  sourceId: string;
  title: string;
  kind: string;
  adapter: string;
  recordCount: number;
  matchedCount: number;
  directMatchedCount: number;
  contextMatchedCount: number;
  recordsPath: string;
}

export interface PersonDossierEntry {
  sourceId: string;
  sourceTitle: string;
  sourceKind: string;
  adapter: string;
  recordId: string;
  conversationId: string;
  role: string;
  actor: string;
  matchKind: "direct" | "context";
  timestamp: string;
  content: string;
  refs: string[];
  participants: string[];
}

export interface PersonDossierResult {
  person: KeyPerson;
  scope: "personal" | "work";
  path: string;
  generatedAt: string;
  sourceCount: number;
  matchedSourceCount: number;
  scannedRecordCount: number;
  matchedCount: number;
  directMatchedCount: number;
  contextMatchedCount: number;
  duplicateCount: number;
  returnedCount: number;
  truncated: boolean;
  sources: PersonDossierSource[];
  entries: PersonDossierEntry[];
}

interface PersonRecordView {
  id: string;
  conversationId: string;
  role: string;
  actor: string;
  timestamp: string;
  content: string;
  refs: string[];
  participants: string[];
}

interface PersonSelector {
  kind: "name" | "uid" | "mis";
  value: string;
}

export function buildElephantPersonView(home: string, options: PersonViewOptions = {}): PersonViewResult {
  const selector = normalizeSelector(options);
  const scope = normalizeScope(options.scope);
  const contextWindow = normalizeInteger(options.contextWindow ?? 2, 0, 10, "context-window");
  const limit = normalizeInteger(options.limit ?? 100, 1, 500, "limit");
  const from = parseBoundary(options.from, false, "from");
  const to = parseBoundary(options.to, true, "to");
  if (from !== undefined && to !== undefined && from > to) throw new Error("from must be less than or equal to to");

  const allSources = listSources(home);
  const sources = allSources.filter((source) => (
    (source.adapter === "elephant" || source.kind === "elephant")
    && (!scope || source.scope === scope)
    && (!options.sourceId || source.id === options.sourceId)
  ));
  if (options.sourceId && !sources.some((source) => source.id === options.sourceId)) {
    const selected = allSources.find((source) => source.id === options.sourceId);
    if (!selected) throw new Error(`Source not found: ${options.sourceId}`);
    if (selected.adapter !== "elephant" && selected.kind !== "elephant") throw new Error(`Source ${options.sourceId} is not an Elephant Source`);
    throw new Error(`Source ${options.sourceId} is outside scope ${scope}`);
  }

  const sourceViews: PersonViewResult["sources"] = [];
  const candidates: Array<{ source: SourceRecord; records: SourceMessage[]; index: number }> = [];
  let scannedRecordCount = 0;
  let candidateCount = 0;
  const uniqueCandidates = new Map<string, { source: SourceRecord; records: SourceMessage[]; index: number }>();
  for (const source of sources) {
    const records = readSourceRecords(home, source.id, { verifyRaw: false, source });
    scannedRecordCount += records.length;
    const matchedIndexes = records.flatMap((record, index) => (
      inTimeRange(record, from, to) && matchesSelector(record, selector) ? [index] : []
    ));
    candidateCount += matchedIndexes.length;
    sourceViews.push({ sourceId: source.id, title: source.title, recordCount: records.length, matchedCount: matchedIndexes.length });
    for (const index of matchedIndexes) {
      const candidate = { source, records, index };
      const identity = personRecordIdentity(records[index]);
      if (!uniqueCandidates.has(identity)) uniqueCandidates.set(identity, candidate);
    }
  }
  candidates.push(...uniqueCandidates.values());

  candidates.sort((left, right) => {
    const leftTime = left.records[left.index]?.timestamp ?? "";
    const rightTime = right.records[right.index]?.timestamp ?? "";
    return (leftTime || "9999").localeCompare(rightTime || "9999") || left.source.importedAt.localeCompare(right.source.importedAt);
  });
  const selected = candidates.slice(0, limit);
  const matches = selected.map(({ source, records, index }) => ({
    sourceId: source.id,
    sourceTitle: source.title,
    record: toPersonRecord(records[index]),
    context: records.slice(Math.max(0, index - contextWindow), Math.min(records.length, index + contextWindow + 1)).map(toPersonRecord),
  }));

  return {
    selector,
    scope,
    sourceCount: sources.length,
    scannedRecordCount,
    matchedCount: candidates.length,
    duplicateCount: candidateCount - candidates.length,
    returnedCount: matches.length,
    truncated: candidates.length > matches.length,
    contextWindow,
    sources: sourceViews,
    matches,
  };
}

export function writePersonDossier(home: string, personId: string, options: Omit<PersonDossierOptions, "personId"> = {}): PersonDossierResult {
  const result = buildPersonDossier(home, { ...options, personId });
  const vault = resolveVault(home, result.scope);
  const dossierDirectory = join(vault, "people", result.person.id);
  ensurePrivateDirectory(vault);
  ensurePrivateDirectory(join(vault, "people"));
  ensurePrivateDirectory(dossierDirectory);
  writeFileSync(result.path, renderPersonDossier(result), { mode: 0o600 });
  chmodSync(result.path, 0o600);
  return result;
}

export function buildPersonDossier(home: string, options: PersonDossierOptions): PersonDossierResult {
  const person = findKeyPerson(home, options.personId);
  if (!person) throw new Error(`Key person not found: ${options.personId}`);
  const requestedScope = normalizeScope(options.scope ?? person.scope);
  if (person.scope !== requestedScope) throw new Error(`Key person ${person.id} belongs to scope ${person.scope}, not ${requestedScope}`);
  if (!person.enabled) throw new Error(`Key person is disabled: ${person.id}`);

  const from = parseBoundary(options.from, false, "from");
  const to = parseBoundary(options.to, true, "to");
  if (from !== undefined && to !== undefined && from > to) throw new Error("from must be less than or equal to to");
  const limit = normalizeInteger(options.limit ?? 100, 1, 500, "limit");
  const allSources = listSources(home).filter((source) => source.scope === requestedScope);
  const identities = personIdentities(person);
  const sourceViews: PersonDossierSource[] = [];
  const uniqueEntries = new Map<string, PersonDossierEntry>();
  let scannedRecordCount = 0;
  let candidateCount = 0;

  for (const source of allSources) {
    const records = readSourceRecords(home, source.id, { verifyRaw: false, source });
    scannedRecordCount += records.length;
    let matchedCount = 0;
    let directMatchedCount = 0;
    let contextMatchedCount = 0;
    records.forEach((record) => {
      const matchKind = !inTimeRange(record, from, to) ? null : classifyPersonMatch(record, identities);
      if (!matchKind) return;
      matchedCount += 1;
      if (matchKind === "direct") directMatchedCount += 1;
      else contextMatchedCount += 1;
      candidateCount += 1;
      const entry = toPersonDossierEntry(source, record, matchKind);
      const identity = dossierRecordIdentity(source, record);
      const existing = uniqueEntries.get(identity);
      if (!existing || (existing.matchKind === "context" && entry.matchKind === "direct")) uniqueEntries.set(identity, entry);
    });
    if (matchedCount > 0) {
      sourceViews.push({
        sourceId: source.id,
        title: source.title,
        kind: source.kind,
        adapter: source.adapter ?? "direct",
        recordCount: source.recordCount,
        matchedCount,
        directMatchedCount,
        contextMatchedCount,
        recordsPath: source.recordsPath,
      });
    }
  }

  const entries = [...uniqueEntries.values()].sort(compareDossierEntries);
  const selected = entries.slice(0, limit);
  const generatedAt = new Date().toISOString();
  const vault = resolveVault(home, requestedScope);
  return {
    person: { ...person, aliases: [...person.aliases] },
    scope: requestedScope,
    path: join(vault, "people", person.id, "index.md"),
    generatedAt,
    sourceCount: allSources.length,
    matchedSourceCount: sourceViews.length,
    scannedRecordCount,
    matchedCount: uniqueEntries.size,
    directMatchedCount: entries.filter((entry) => entry.matchKind === "direct").length,
    contextMatchedCount: entries.filter((entry) => entry.matchKind === "context").length,
    duplicateCount: candidateCount - uniqueEntries.size,
    returnedCount: selected.length,
    truncated: uniqueEntries.size > selected.length,
    sources: sourceViews,
    entries: selected,
  };
}

function normalizeSelector(options: PersonViewOptions): PersonSelector {
  const values: Array<PersonSelector> = ([
    ["name", options.name],
    ["uid", options.uid],
    ["mis", options.mis],
  ] as const).flatMap(([kind, value]) => {
    const normalized = String(value ?? "").trim();
    return normalized ? [{ kind, value: normalized } as PersonSelector] : [];
  });
  if (values.length !== 1) throw new Error("Person view requires exactly one of --name, --uid, or --mis");
  return values[0];
}

function normalizeScope(scope: string | undefined): "personal" | "work" {
  const value = scope ?? "work";
  if (value !== "personal" && value !== "work") throw new Error(`Source scope must be personal or work: ${value}`);
  return value;
}

function normalizeInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function parseBoundary(value: string | undefined, endOfDay: boolean, label: string): number | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
    return date.getTime();
  }
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid ${label} time: ${text}`);
  return timestamp;
}

function inTimeRange(record: SourceMessage, from: number | undefined, to: number | undefined): boolean {
  if (from === undefined && to === undefined) return true;
  const timestamp = Date.parse(record.timestamp);
  if (Number.isNaN(timestamp)) return false;
  return (from === undefined || timestamp >= from) && (to === undefined || timestamp < to);
}

function matchesSelector(record: SourceMessage, selector: PersonSelector): boolean {
  const value = selector.value.toLocaleLowerCase();
  if (selector.kind === "name") return record.actor.trim().toLocaleLowerCase() === value;
  const prefixes = selector.kind === "uid" ? ["senderUid:", "senderId:", "uid:"] : ["senderMis:", "mis:"];
  return record.actor.trim().toLocaleLowerCase() === value || record.refs.some((ref) => prefixes.some((prefix) => ref.toLocaleLowerCase() === `${prefix.toLocaleLowerCase()}${value}`));
}

function personIdentities(person: KeyPerson): Set<string> {
  return new Set([person.id, person.mis, person.uid, person.name, ...person.aliases]
    .filter((value): value is string => Boolean(value))
    .map(normalizeIdentity));
}

function classifyPersonMatch(record: SourceMessage, identities: Set<string>): "direct" | "context" | null {
  const actor = normalizeIdentity(record.actor);
  if (actor && identities.has(actor)) return "direct";
  const directRefs = record.refs.filter(isDirectIdentityRef).flatMap(refIdentityValues);
  if (directRefs.some((candidate) => identities.has(normalizeIdentity(candidate)))) return "direct";
  const contextCandidates = [...record.participants, ...record.refs.filter((ref) => !isDirectIdentityRef(ref)).flatMap(refIdentityValues)];
  return contextCandidates.some((candidate) => identities.has(normalizeIdentity(candidate))) ? "context" : null;
}

function isDirectIdentityRef(ref: string): boolean {
  const separator = ref.indexOf(":");
  const key = separator > 0 ? ref.slice(0, separator).toLocaleLowerCase() : "";
  return ["author", "creator", "owner", "modifier", "senderuid", "sendermis", "senderid", "from"].includes(key);
}

function refIdentityValues(ref: string): string[] {
  const separator = ref.indexOf(":");
  if (separator <= 0) return [];
  const key = ref.slice(0, separator).toLocaleLowerCase();
  if (key === "daxiang") {
    const nested = ref.slice(separator + 1).split(":");
    const nestedKey = nested.shift()?.toLocaleLowerCase();
    const nestedValue = nested.join(":").trim();
    return nestedKey && ["uid", "mis", "name", "person", "personid"].includes(nestedKey) && nestedValue ? [nestedValue] : [];
  }
  if (!["id", "uid", "mis", "name", "alias", "person", "personid", "author", "creator", "owner", "modifier", "senderuid", "sendermis", "senderid", "participant", "participantid", "user", "from"].includes(key)) return [];
  const value = ref.slice(separator + 1).trim();
  return value ? [value] : [];
}

function normalizeIdentity(value: string): string {
  return String(value ?? "").trim().normalize("NFKC").toLocaleLowerCase();
}

function toPersonDossierEntry(source: SourceRecord, record: SourceMessage, matchKind: "direct" | "context"): PersonDossierEntry {
  return {
    sourceId: source.id,
    sourceTitle: source.title,
    sourceKind: source.kind,
    adapter: source.adapter ?? "direct",
    recordId: record.id,
    conversationId: record.conversationId,
    role: record.role,
    actor: record.actor,
    matchKind,
    timestamp: record.timestamp,
    content: record.content,
    refs: [...record.refs],
    participants: [...record.participants],
  };
}

function dossierRecordIdentity(source: SourceRecord, record: SourceMessage): string {
  const stableRefs = record.refs.filter((ref) => /^(messageId|uuid|mid|contentId|commentId|rootCommentId):/i.test(ref));
  const stable = stableRefs.join("|");
  const contentHash = createHash("sha256").update(record.content).digest("hex").slice(0, 16);
  return `${source.kind}|${normalizeConversationId(record.conversationId)}|${stable}|${record.timestamp}|${contentHash}`;
}

function compareDossierEntries(left: PersonDossierEntry, right: PersonDossierEntry): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  if (!Number.isNaN(leftTime) && Number.isNaN(rightTime)) return -1;
  if (Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return 1;
  return right.timestamp.localeCompare(left.timestamp) || left.sourceId.localeCompare(right.sourceId) || left.recordId.localeCompare(right.recordId);
}

function renderPersonDossier(result: PersonDossierResult): string {
  const personTitle = result.person.name ?? result.person.id;
  const lines = [
    `# ${personTitle}`,
    "",
    "> Generated by ikb. This is a rebuildable evidence view, not a Knowledge record.",
    "",
    `- Person ID: \`${result.person.id}\``,
    `- MIS: ${result.person.mis ?? "unknown"}`,
    `- UID: ${result.person.uid ?? "unknown"}`,
    `- Scope: ${result.scope}`,
    `- Generated: ${result.generatedAt}`,
    `- Sources scanned: ${result.sourceCount}`,
    `- Sources with evidence: ${result.matchedSourceCount}`,
    `- Records matched: ${result.matchedCount}`,
    `- Direct evidence: ${result.directMatchedCount}`,
    `- Context-only evidence: ${result.contextMatchedCount}`,
    `- Duplicates removed: ${result.duplicateCount}`,
    `- Records shown: ${result.returnedCount}${result.truncated ? " (truncated; use --limit to expand)" : ""}`,
    "",
    "## Evidence sources",
    "",
  ];
  if (result.sources.length === 0) lines.push("_No evidence matched this person in the selected scope._", "");
  else {
    lines.push("| Source | Kind | Adapter | Matched | Direct | Context |", "|---|---|---|---:|---:|---:|");
    for (const source of result.sources) {
      const recordsLink = relative(join(result.path, ".."), source.recordsPath).replaceAll("\\", "/");
      lines.push(`| [${escapeMarkdownCell(source.title)}](<${recordsLink}>) | ${source.kind} | ${source.adapter} | ${source.matchedCount} | ${source.directMatchedCount} | ${source.contextMatchedCount} |`);
    }
    lines.push("");
  }
  lines.push("## Records", "");
  if (result.entries.length === 0) lines.push("_No records shown._", "");
  result.entries.forEach((entry, index) => {
    const source = result.sources.find((candidate) => candidate.sourceId === entry.sourceId);
    const recordsLink = source ? relative(join(result.path, ".."), source.recordsPath).replaceAll("\\", "/") : "";
    lines.push(
      `### ${index + 1}. ${escapeMarkdownCell(entry.sourceTitle)}`,
      "",
      `- Source: \`${entry.sourceId}\`${recordsLink ? ` ([records](<${recordsLink}>))` : ""}`,
      `- Kind: ${entry.sourceKind}`,
      `- Adapter: ${entry.adapter}`,
      `- Record: \`${entry.recordId}\``,
     `- Conversation: \`${entry.conversationId}\``,
     `- Role / actor: ${entry.role} / ${entry.actor}`,
      `- Match: ${entry.matchKind === "direct" ? "direct attribution or speech" : "context only (participant or linked reference)"}`,
      `- Timestamp: ${entry.timestamp || "unknown"}`,
      `- Participants: ${entry.participants.join(", ") || "unknown"}`,
      `- Refs: ${entry.refs.join(", ") || "none"}`,
      "",
      ...quoteMarkdown(entry.content),
      "",
    );
  });
  return `${lines.join("\n")}\n`;
}

function quoteMarkdown(value: string): string[] {
  return value.split("\n").map((line) => `> ${line}`);
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "/").replaceAll("[", "").replaceAll("]", "").trim();
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Person dossier directory must be a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function toPersonRecord(record: SourceMessage): PersonRecordView {
  return {
    id: record.id,
    conversationId: record.conversationId,
    role: record.role,
    actor: record.actor,
    timestamp: record.timestamp,
    content: record.content,
    refs: [...record.refs],
    participants: [...record.participants],
  };
}

function personRecordIdentity(record: SourceMessage): string {
  const stableRef = record.refs.find((ref) => /^(messageId|uuid|mid):/.test(ref));
  if (stableRef) return `${normalizeConversationId(record.conversationId)}|${stableRef}`;
  return `${record.conversationId}|${record.timestamp}|${record.actor}|${record.content}`;
}

function normalizeConversationId(value: string): string {
  return value.replace(/^([a-z]+)=/, "$1:").replace(/:undefined$/, "");
}
