import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { isActiveCardEntry, parseCardMarkdown } from "../mcp/ikb-cards-core.mjs";

const SCOPES = ["work", "common", "personal"];
const WORK_CATEGORIES = ["domains", "practices", "services", "people", "team"];
const DAY = 24 * 60 * 60 * 1000;
const LEDGER_SCHEMA = "ikb-card-classification-v1";
const SHA256 = /^[a-f0-9]{64}$/u;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pathRef = (value) => typeof value === "string" && value.trim() ? resolve(value) : null;

function hashMarkdown(markdown) {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function frontmatter(markdown, filePath) {
  const parseable = markdown.replace(/^\uFEFF/u, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(parseable);
  if (!match) throw new Error(`Card is missing YAML frontmatter: ${filePath}`);
  const value = parseYaml(match[1]);
  if (!isObject(value)) throw new Error(`Card frontmatter must be a mapping: ${filePath}`);
  return value;
}

function meaningfulSources(value) {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim() !== "");
}

function nullMetrics(sourceRefs, warnings = []) {
  return {
    state: "invalid",
    total: null,
    byScope: { work: null, common: null, personal: null },
    byCategory: Object.fromEntries(WORK_CATEGORIES.map((category) => [category, null])),
    sourceMetadata: { present: null, missing: null, percent: null },
    updatedMetadata: { last30Days: null, older: null, unknown: null, future: null },
    knowledgeKinds: {
      normal: null,
      principle: null,
      unknown: null,
      workTotal: null,
      normalPercent: null,
      principlePercent: null,
    },
    classification: { sourcePath: sourceRefs.ledger, classifiedAt: null },
    warnings,
    sourceRefs,
  };
}

function missingMetrics(sourceRefs, warnings = []) {
  return { ...nullMetrics(sourceRefs, warnings), state: "missing" };
}

function ledgerPathFor(intakeRoot) {
  const root = pathRef(intakeRoot);
  return root ? join(root, "maintenance", "card-classification.json") : null;
}

function sourceReferences(cardsRoot, intakeRoot) {
  return {
    cardsRoot: pathRef(cardsRoot),
    ledger: ledgerPathFor(intakeRoot),
  };
}

function readActiveCards(cardsRoot) {
  const cards = [];
  const ids = new Set();

  const walk = (directory, scope, root) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`${directory}: unreadable (${error?.code ?? error?.message ?? String(error)})`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    for (const entry of entries) {
      if (!isActiveCardEntry(entry)) continue;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filePath, scope, root);
        continue;
      }

      let markdown;
      try {
        const stat = lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        markdown = readFileSync(filePath, "utf8");
      } catch (error) {
        throw new Error(`${filePath}: unreadable (${error?.code ?? error?.message ?? String(error)})`);
      }

      let parsed;
      let metadata;
      try {
        parsed = parseCardMarkdown(markdown, filePath);
        metadata = frontmatter(markdown, filePath);
      } catch (error) {
        throw new Error(`${filePath}: malformed card (${error?.message ?? String(error)})`);
      }
      if (ids.has(parsed.cardId)) throw new Error(`duplicate active card id: ${parsed.cardId}`);
      ids.add(parsed.cardId);
      const relativePath = relative(root, filePath);
      const segments = relativePath.split(sep);
      cards.push({
        cardId: parsed.cardId,
        scope,
        path: filePath,
        contentHash: hashMarkdown(markdown),
        sourcesPresent: meaningfulSources(metadata.sources),
        updatedAt: typeof metadata.updated_at === "string" ? metadata.updated_at.trim() : null,
        category: scope === "work" ? (segments.length > 1 ? segments[1] : "uncategorized") : null,
      });
    }
  };

  for (const scope of SCOPES) {
    const directory = join(cardsRoot, scope);
    if (!existsSync(directory)) continue;
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      throw new Error(`${directory}: unreadable (${error?.code ?? error?.message ?? String(error)})`);
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) throw new Error(`${directory}: regular directory required`);
    walk(directory, scope, cardsRoot);
  }
  return cards;
}

function validClassificationEntry(entry) {
  return isObject(entry) &&
    typeof entry.cardId === "string" && entry.cardId.trim() !== "" &&
    (entry.kind === "normal" || entry.kind === "principle") &&
    typeof entry.contentHash === "string" && SHA256.test(entry.contentHash);
}

function readLedger(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { valid: false, classifiedAt: null, entries: [], warning: "分类账本缺失，工作卡片暂显示为待分类" };
  }
  try {
    const stat = lstatSync(ledgerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("分类账本不是普通文件");
    const value = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (!isObject(value) || value.schema !== LEDGER_SCHEMA ||
        typeof value.classifiedAt !== "string" || !Number.isFinite(Date.parse(value.classifiedAt)) ||
        !Array.isArray(value.sourceRefs) || value.sourceRefs.some((ref) => typeof ref !== "string" || ref.trim() === "") ||
        !Array.isArray(value.cards) || value.cards.some((entry) => !validClassificationEntry(entry))) {
      throw new Error("分类账本格式不完整");
    }
    const ids = new Set();
    for (const entry of value.cards) {
      if (ids.has(entry.cardId)) throw new Error(`分类账本重复 cardId: ${entry.cardId}`);
      ids.add(entry.cardId);
    }
    return { valid: true, classifiedAt: value.classifiedAt, entries: value.cards, warning: null };
  } catch (error) {
    return {
      valid: false,
      classifiedAt: null,
      entries: [],
      warning: `分类账本读取失败：${error?.message ?? String(error)}`,
    };
  }
}

function applyClassifications(cards, ledgerEntries, classifications) {
  const byId = new Map(ledgerEntries.map((entry) => [entry.cardId, entry]));
  const currentWork = new Map(cards.filter((card) => card.scope !== "personal").map((card) => [card.cardId, card]));

  const kindFor = (entry) => {
    if (!validClassificationEntry(entry)) return null;
    const current = currentWork.get(entry.cardId);
    return current && current.contentHash === entry.contentHash ? entry.kind : null;
  };

  const kinds = new Map();
  for (const [cardId, entry] of byId) {
    const kind = kindFor(entry);
    if (kind) kinds.set(cardId, kind);
  }
  if (Array.isArray(classifications)) {
    for (const entry of classifications) {
      const kind = kindFor(entry);
      if (kind) kinds.set(entry.cardId, kind);
    }
  }
  return kinds;
}

function dateMetrics(cards, now) {
  const result = { last30Days: 0, older: 0, unknown: 0, future: 0 };
  const cutoff = now - 30 * DAY;
  for (const card of cards) {
    if (!card.updatedAt) {
      result.unknown += 1;
      continue;
    }
    const time = Date.parse(card.updatedAt);
    if (!Number.isFinite(time)) {
      result.unknown += 1;
    } else if (time > now) {
      result.future += 1;
    } else if (time >= cutoff) {
      result.last30Days += 1;
    } else {
      result.older += 1;
    }
  }
  return result;
}

function percent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function availableMetrics(cards, sourceRefs, ledger, classifications, generatedAt) {
  const byScope = { work: 0, common: 0, personal: 0 };
  const byCategory = Object.fromEntries(WORK_CATEGORIES.map((category) => [category, 0]));
  const extraCategories = new Map();
  let sourcePresent = 0;
  for (const card of cards) {
    byScope[card.scope] += 1;
    if (card.scope === "work") {
      if (Object.hasOwn(byCategory, card.category)) byCategory[card.category] += 1;
      else extraCategories.set(card.category, (extraCategories.get(card.category) ?? 0) + 1);
    }
    if (card.sourcesPresent) sourcePresent += 1;
  }
  for (const category of [...extraCategories.keys()].sort((left, right) => left.localeCompare(right, "zh-CN"))) {
    byCategory[category] = extraCategories.get(category);
  }

  const kinds = applyClassifications(cards, ledger.entries, classifications);
  const workCards = cards.filter((card) => card.scope !== "personal");
  let normal = 0;
  let principle = 0;
  for (const card of workCards) {
    if (kinds.get(card.cardId) === "normal") normal += 1;
    else if (kinds.get(card.cardId) === "principle") principle += 1;
  }
  const workTotal = workCards.length;
  const warningList = ledger.warning ? [ledger.warning] : [];
  const generatedTime = Date.parse(generatedAt);
  const result = {
    state: "available",
    total: cards.length,
    byScope,
    byCategory,
    sourceMetadata: {
      present: sourcePresent,
      missing: cards.length - sourcePresent,
      percent: percent(sourcePresent, cards.length),
    },
    updatedMetadata: dateMetrics(cards, generatedTime),
    knowledgeKinds: {
      normal,
      principle,
      unknown: workTotal - normal - principle,
      workTotal,
      normalPercent: percent(normal, workTotal),
      principlePercent: percent(principle, workTotal),
    },
    classification: { sourcePath: sourceRefs.ledger, classifiedAt: ledger.classifiedAt },
    warnings: warningList,
    sourceRefs,
  };
  return result;
}

export function buildStockMetrics({ cardsRoot, intakeRoot, generatedAt, classifications = [] } = {}) {
  const sourceRefs = sourceReferences(cardsRoot, intakeRoot);
  if (!sourceRefs.cardsRoot) return nullMetrics(sourceRefs, ["cardsRoot 必须是非空路径"]);
  if (!existsSync(sourceRefs.cardsRoot)) return missingMetrics(sourceRefs, ["cardsRoot 不存在，知识库库存暂不可用"]);
  let rootStat;
  try {
    rootStat = lstatSync(sourceRefs.cardsRoot);
  } catch (error) {
    return nullMetrics(sourceRefs, [`cardsRoot 读取失败：${error?.message ?? String(error)}`]);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return nullMetrics(sourceRefs, ["cardsRoot 必须是普通目录"]);
  }
  const generatedTime = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(generatedTime)) return nullMetrics(sourceRefs, ["generatedAt 必须是有效时间"]);

  let cards;
  try {
    cards = readActiveCards(sourceRefs.cardsRoot);
  } catch (error) {
    return nullMetrics(sourceRefs, [error?.message ?? String(error)]);
  }
  const ledger = readLedger(sourceRefs.ledger);
  return availableMetrics(cards, sourceRefs, ledger, classifications, generatedAt);
}
