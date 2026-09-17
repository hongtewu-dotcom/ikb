import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";

export const DEFAULT_CARDS_ROOT = fileURLToPath(new URL("../ikb-data/cards", import.meta.url));
export const DEFAULT_MAX_RETRIEVALS = 256;
export const DEFAULT_RETRIEVAL_TTL_MS = 30 * 60 * 1_000;
// Active CLI policy is separate from the backwards-compatible library parser.
export const DEFAULT_CLI_RETRIEVAL_POLICY = "entries";

const RESPONSE_FORMAT = z.enum(["markdown", "json"]);
const SCOPE = z.enum(["work", "personal"]);
const RETRIEVAL_POLICY = z.enum(["legacy", "entries"]);
const RetrievalEntrySchema = z.object({
  objects: z.array(z.string().trim().min(1)).min(1),
  intents: z.array(z.string().trim().min(1)),
}).strict();

export const SearchInputSchema = z
  .object({
    query: z.string(),
    scope: SCOPE,
    limit: z.number().int().min(1).max(20).default(8),
    offset: z.number().int().min(0).default(0),
    response_format: RESPONSE_FORMAT.default("markdown"),
  })
  .strict();

export const GetInputSchema = z
  .object({
    retrieval_id: z.string().min(1),
    card_id: z.string().min(1),
    response_format: RESPONSE_FORMAT.default("markdown"),
  })
  .strict();

const SearchItemSchema = z
  .object({
    cardId: z.string(),
    title: z.string(),
    path: z.string(),
    contentHash: z.string(),
    matchedFields: z.array(z.enum(["title", "aliases", "tags", "body"])),
    snippet: z.string(),
    matchedEntries: z.array(z.object({
      index: z.number().int().min(0),
      objects: z.array(z.string()).min(1),
      intents: z.array(z.string()),
    }).strict()).optional(),
  })
  .strict();

export const SearchOutputSchema = z
  .object({
    schema: z.literal("ikb-card-search-result-v1"),
    retrievalId: z.string(),
    scope: SCOPE,
    queryHash: z.string(),
    total: z.number().int().min(0),
    count: z.number().int().min(0),
    offset: z.number().int().min(0),
    hasMore: z.boolean(),
    nextOffset: z.number().int().min(0).nullable(),
    zeroResult: z.boolean(),
    items: z.array(SearchItemSchema),
  })
  .strict();

export const GetOutputSchema = z
  .object({
    schema: z.literal("ikb-card-read-result-v1"),
    retrievalId: z.string(),
    scope: SCOPE,
    card: z
      .object({
        cardId: z.string(),
        title: z.string(),
        path: z.string(),
        contentHash: z.string(),
        whenNotTrust: z.string(),
        markdown: z.string(),
      })
      .strict(),
  })
  .strict();

const FIELD_ORDER = ["title", "aliases", "tags", "body"];
const FIELD_WEIGHTS = { title: 5_000, aliases: 4_800, tags: 2_500, body: 800 };
const SEARCH_STOP_WORDS = new Set([
  "的",
  "了",
  "是",
  "和",
  "与",
  "或",
  "在",
  "从",
  "到",
  "哪些",
  "什么",
  "怎么",
  "如何",
  "一下",
  "一个",
]);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveCardsRoot(rootDir) {
  const candidate = rootDir ?? process.env.IKB_CARDS_ROOT ?? DEFAULT_CARDS_ROOT;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("IKB cards root must be a non-empty path");
  }
  return resolve(candidate);
}

function isWithin(childPath, parentPath) {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveSafeRoot(rootDir) {
  const root = await realpath(rootDir);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("IKB cards root is not a directory");
  return root;
}

async function safeReadUtf8(filePath, rootRealPath) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Card path is not a regular file");
  const resolvedFile = await realpath(filePath);
  if (!isWithin(resolvedFile, rootRealPath)) throw new Error("Card path escapes the configured cards root");

  const handle = await open(resolvedFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const [openedStat, currentStat, currentResolvedFile] = await Promise.all([
      handle.stat(),
      lstat(filePath),
      realpath(filePath),
    ]);
    if (!openedStat.isFile() || currentStat.isSymbolicLink() || !currentStat.isFile()) {
      throw new Error("Card path changed while it was being opened");
    }
    if (
      openedStat.dev !== currentStat.dev ||
      openedStat.ino !== currentStat.ino ||
      currentResolvedFile !== resolvedFile ||
      !isWithin(currentResolvedFile, rootRealPath)
    ) {
      throw new Error("Card path changed or escaped the configured cards root while it was being opened");
    }
    return { path: resolvedFile, markdown: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}

function asStringArray(value, fieldName, filePath) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Card ${fieldName} must be a string array: ${filePath}`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function parseRetrievalEntries(value, filePath) {
  const parsed = z.array(RetrievalEntrySchema).min(1).safeParse(value);
  if (!parsed.success) throw new Error(`Card retrieval is invalid: ${filePath}: ${parsed.error.message}`);
  return parsed.data;
}

export function parseCardMarkdown(markdown, filePath, options = {}) {
  const parseable = markdown.replace(/^\uFEFF/u, "");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(parseable);
  if (!frontmatterMatch) throw new Error(`Card is missing YAML frontmatter: ${filePath}`);

  const frontmatter = parseYaml(frontmatterMatch[1]);
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`Card frontmatter must be a mapping: ${filePath}`);
  }
  if (typeof frontmatter.id !== "string" || frontmatter.id.trim() === "") {
    throw new Error(`Card id must be a non-empty string: ${filePath}`);
  }
  if (typeof frontmatter.title !== "string" || frontmatter.title.trim() === "") {
    throw new Error(`Card title must be a non-empty string: ${filePath}`);
  }

  const aliases = asStringArray(frontmatter.aliases, "aliases", filePath);
  const tags = asStringArray(frontmatter.tags, "tags", filePath);
  const body = parseable.slice(frontmatterMatch[0].length).trim();
  const whenNotTrustHeading = /^## 什么时候别信[^\S\r\n]*$/mu.exec(body);
  let whenNotTrust = "";
  if (whenNotTrustHeading?.index !== undefined) {
    const sectionStart = whenNotTrustHeading.index + whenNotTrustHeading[0].length;
    const afterHeading = body.slice(sectionStart).replace(/^\r?\n/u, "");
    const nextHeading = /^##\s+/mu.exec(afterHeading);
    whenNotTrust = afterHeading.slice(0, nextHeading?.index ?? afterHeading.length).trim();
  }

  const cardId = frontmatter.id.trim();
  validateOpaqueCardId(cardId);
  let retrieval;
  if (RETRIEVAL_POLICY.parse(options.retrievalPolicy ?? "legacy") === "entries") {
    retrieval = parseRetrievalEntries(frontmatter.retrieval, filePath);
  }

  return {
    cardId,
    title: frontmatter.title.trim(),
    aliases,
    tags,
    body,
    whenNotTrust,
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

export function isActiveCardEntry(entry) {
  if (entry.isSymbolicLink()) return false;
  const name = entry.name.toLocaleLowerCase("en-US");
  if (entry.isDirectory()) return name !== "archive";
  return entry.isFile() && name !== "readme.md" && name.endsWith(".md");
}

async function listMarkdownFiles(directory, rootRealPath) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return files;
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  for (const entry of entries) {
    if (!isActiveCardEntry(entry)) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const resolvedDirectory = await realpath(entryPath);
      if (!isWithin(resolvedDirectory, rootRealPath)) continue;
      files.push(...(await listMarkdownFiles(resolvedDirectory, rootRealPath)));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

export async function scanCards(core, scope) {
  const parsedScope = SCOPE.parse(scope);
  const rootRealPath = await resolveSafeRoot(core.rootDir);
  const scopeDirectories = parsedScope === "work" ? ["work", "common"] : ["personal", "common"];
  const cards = [];
  const ids = new Set();

  for (const scopeDirectory of scopeDirectories) {
    const directory = join(rootRealPath, scopeDirectory);
    for (const filePath of await listMarkdownFiles(directory, rootRealPath)) {
      const loaded = await safeReadUtf8(filePath, rootRealPath);
      const parsed = parseCardMarkdown(loaded.markdown, loaded.path, {
        retrievalPolicy: parsedScope === "work" ? core.retrievalPolicy : "legacy",
      });
      if (ids.has(parsed.cardId)) throw new Error(`Duplicate card id in ${parsedScope} scope: ${parsed.cardId}`);
      ids.add(parsed.cardId);
      cards.push({
        ...parsed,
        path: loaded.path,
        markdown: loaded.markdown,
        contentHash: sha256(loaded.markdown),
      });
    }
  }
  return cards;
}

function queryTerms(query) {
  const fullQuery = normalize(query);
  if (!fullQuery) return { fullQuery, terms: [] };

  const terms = [];
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  for (const segment of segmenter.segment(fullQuery)) {
    if (!segment.isWordLike) continue;
    const term = normalize(segment.segment);
    if (!term || SEARCH_STOP_WORDS.has(term)) continue;
    if (term.length === 1 && /[a-z0-9]/u.test(term) && fullQuery.length > 1) continue;
    terms.push(term);
  }
  if (terms.length === 0) terms.push(fullQuery);
  return { fullQuery, terms: [...new Set(terms)] };
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += Math.max(needle.length, 1);
  }
  return count;
}

function fieldMatch(field, values, fullQuery, terms) {
  const normalizedValues = values.map(normalize).filter(Boolean);
  const combined = normalizedValues.join("\n");
  const matchedTerms = terms.filter((term) => combined.includes(term));
  const fullMatch = fullQuery !== "" && combined.includes(fullQuery);
  if (!fullMatch && matchedTerms.length === 0) return { matched: false, score: 0 };

  const exact = normalizedValues.some((value) => value === fullQuery);
  const coverage = terms.length === 0 ? 0 : matchedTerms.length / terms.length;
  const frequency = matchedTerms.reduce((sum, term) => sum + Math.min(occurrences(combined, term), 4), 0);
  const weight = FIELD_WEIGHTS[field];
  return {
    matched: true,
    score: (exact ? 100_000 : 0) + (fullMatch ? 25_000 : 0) + weight * coverage + frequency * Math.max(40, weight / 20),
  };
}

function makeSnippet(card, matchedFields, fullQuery, terms) {
  const preferredField = matchedFields.includes("body") ? "body" : matchedFields[0];
  const value =
    preferredField === "aliases"
      ? `aliases: ${card.aliases.join(", ")}`
      : preferredField === "tags"
        ? `tags: ${card.tags.join(", ")}`
        : preferredField === "title"
          ? card.title
          : card.body;
  const compact = value.replace(/\s+/gu, " ").trim();
  const needles = [fullQuery, ...terms].filter(Boolean).sort((left, right) => right.length - left.length);
  const normalizedCompact = normalize(compact);
  const index = needles.map((needle) => normalizedCompact.indexOf(needle)).find((candidate) => candidate >= 0) ?? 0;
  const start = Math.max(0, index - 60);
  const end = Math.min(compact.length, start + 180);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

function normalizeEntry(value) {
  return normalize(value).replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "");
}

function entryTermMatches(query, term) {
  const needle = normalizeEntry(term);
  let offset = 0;
  while (offset <= query.length) {
    const index = query.indexOf(needle, offset);
    if (index < 0) return false;
    const before = query[index - 1] ?? "";
    const after = query[index + needle.length] ?? "";
    if ((!/^[a-z0-9_]/u.test(needle) || !/[a-z0-9_]/u.test(before)) &&
        (!/[a-z0-9_]$/u.test(needle) || !/[a-z0-9_]/u.test(after))) return true;
    offset = index + Math.max(needle.length, 1);
  }
  return false;
}

function matchEntries(card, query) {
  const normalized = normalizeEntry(query);
  return parseRetrievalEntries(card.retrieval, card.path).flatMap((entry, index) => {
    const objects = entry.objects.filter((term) => entry.intents.length === 0
      ? normalized === normalizeEntry(term) : entryTermMatches(normalized, term));
    const intents = entry.intents.filter((term) => entryTermMatches(normalized, term));
    return objects.length && (!entry.intents.length || intents.length) ? [{ index, objects, intents }] : [];
  });
}

export function rankCards(cards, query, options = {}) {
  const policy = RETRIEVAL_POLICY.parse(options.retrievalPolicy ?? "legacy");
  const { fullQuery, terms } = queryTerms(query);
  if (!fullQuery) return [];

  return cards
    .map((card) => {
      const matchedEntries = policy === "entries" ? matchEntries(card, query) : undefined;
      if (matchedEntries?.length === 0) return null;
      const fields = {
        title: [card.title],
        aliases: card.aliases,
        tags: card.tags,
        body: [card.body],
      };
      let score = 0;
      const matchedFields = [];
      for (const field of FIELD_ORDER) {
        const match = fieldMatch(field, fields[field], fullQuery, terms);
        if (!match.matched) continue;
        matchedFields.push(field);
        score += match.score;
      }
      if (matchedFields.length === 0 && matchedEntries === undefined) return null;
      return {
        card,
        score,
        matchedFields,
        ...(matchedEntries === undefined ? {} : { matchedEntries }),
        snippet: makeSnippet(card, matchedFields, fullQuery, terms),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.card.title.localeCompare(right.card.title, "zh-CN") ||
        left.card.path.localeCompare(right.card.path, "en-US"),
    );
}

export function createIkbCardsCore(options = {}) {
  const maxRetrievals = options.maxRetrievals ?? DEFAULT_MAX_RETRIEVALS;
  const retrievalTtlMs = options.retrievalTtlMs ?? DEFAULT_RETRIEVAL_TTL_MS;
  if (!Number.isInteger(maxRetrievals) || maxRetrievals < 1) throw new Error("maxRetrievals must be a positive integer");
  if (!Number.isFinite(retrievalTtlMs) || retrievalTtlMs <= 0) throw new Error("retrievalTtlMs must be positive");
  return {
    rootDir: resolveCardsRoot(options.rootDir),
    retrievalPolicy: RETRIEVAL_POLICY.parse(options.retrievalPolicy ?? "legacy"),
    retrievals: new Map(),
    retrievalStore: options.retrievalStore,
    maxRetrievals,
    retrievalTtlMs,
    now: options.now ?? Date.now,
  };
}

function pruneRetrievals(core, reserveSlot = false) {
  const cutoff = core.now() - core.retrievalTtlMs;
  for (const [retrievalId, retrieval] of core.retrievals) {
    if (retrieval.createdAt <= cutoff) core.retrievals.delete(retrievalId);
  }
  const capacity = reserveSlot ? core.maxRetrievals - 1 : core.maxRetrievals;
  while (core.retrievals.size > capacity) {
    const oldest = core.retrievals.keys().next().value;
    if (oldest === undefined) break;
    core.retrievals.delete(oldest);
  }
}

export async function searchCards(core, input) {
  const params = SearchInputSchema.parse(input);
  const cards = await scanCards(core, params.scope);
  const ranked = rankCards(cards, params.query, { retrievalPolicy: params.scope === "work" ? core.retrievalPolicy : "legacy" });
  const page = ranked.slice(params.offset, params.offset + params.limit);
  const items = page.map(({ card, matchedFields, snippet, matchedEntries }) => ({
    cardId: card.cardId,
    title: card.title,
    path: card.path,
    contentHash: card.contentHash,
    matchedFields,
    snippet,
    ...(matchedEntries === undefined ? {} : { matchedEntries }),
  }));
  const retrievalId = randomUUID();
  pruneRetrievals(core, true);
  const retrieval = {
    scope: params.scope,
    createdAt: core.now(),
    cards: new Map(page.map(({ card }) => [card.cardId, { path: card.path, contentHash: card.contentHash }])),
  };
  if (core.retrievalStore) await core.retrievalStore.save(retrievalId, retrieval, core);
  else core.retrievals.set(retrievalId, retrieval);

  const hasMore = params.offset + items.length < ranked.length;
  return SearchOutputSchema.parse({
    schema: "ikb-card-search-result-v1",
    retrievalId,
    scope: params.scope,
    queryHash: sha256(normalize(params.query)),
    total: ranked.length,
    count: items.length,
    offset: params.offset,
    hasMore,
    nextOffset: hasMore ? params.offset + items.length : null,
    zeroResult: ranked.length === 0,
    items,
  });
}

function validateOpaqueCardId(cardId) {
  if (cardId === "." || cardId === ".." || cardId.includes("/") || cardId.includes("\\") || cardId.includes("\0")) {
    throw new Error("Invalid card_id: paths and traversal segments are not accepted");
  }
}

export async function getCard(core, input) {
  const params = GetInputSchema.parse(input);
  validateOpaqueCardId(params.card_id);
  pruneRetrievals(core);
  const retrieval = core.retrievalStore
    ? await core.retrievalStore.load(params.retrieval_id, core)
    : core.retrievals.get(params.retrieval_id);
  if (!retrieval) throw new Error("Unknown retrieval_id (missing or expired)");
  const binding = retrieval.cards.get(params.card_id);
  if (!binding) throw new Error("card_id was not returned by the specified retrieval");

  const rootRealPath = await resolveSafeRoot(core.rootDir);
  const allowedDirectories = retrieval.scope === "work" ? ["work", "common"] : ["personal", "common"];
  if (!allowedDirectories.some((directory) => isWithin(binding.path, join(rootRealPath, directory)))) {
    throw new Error("Stored card binding is outside the retrieval scope");
  }

  const loaded = await safeReadUtf8(binding.path, rootRealPath);
  const currentHash = sha256(loaded.markdown);
  if (currentHash !== binding.contentHash) {
    throw new Error("Card content changed after retrieval; search again before reading it");
  }
  const parsed = parseCardMarkdown(loaded.markdown, loaded.path);
  if (parsed.cardId !== params.card_id) throw new Error("Card id changed after retrieval; search again before reading it");

  return GetOutputSchema.parse({
    schema: "ikb-card-read-result-v1",
    retrievalId: params.retrieval_id,
    scope: retrieval.scope,
    card: {
      cardId: parsed.cardId,
      title: parsed.title,
      path: loaded.path,
      contentHash: currentHash,
      whenNotTrust: parsed.whenNotTrust,
      markdown: loaded.markdown,
    },
  });
}
