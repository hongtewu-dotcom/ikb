import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SOURCE_STRUCTURE_INVENTORY_VERSION = "ikb-source-structure-inventory.v1";

export type SourceUnitKind =
  | "section"
  | "paragraph"
  | "table"
  | "image"
  | "diagram"
  | "comment"
  | "message"
  | "tool_result"
  | "diff"
  | "test"
  | "other";

export type SourceUnitImportance = "core" | "supporting" | "context";

export interface SourceStructureUnit {
  unit_id: string;
  source_id: string;
  unit_kind: SourceUnitKind;
  locator: string;
  start_line: number;
  end_line: number;
  content: string;
  content_sha256: string;
  importance: SourceUnitImportance;
  importance_signals: string[];
}

export interface SourceStructureInventory {
  schema: typeof SOURCE_STRUCTURE_INVENTORY_VERSION;
  source_id: string;
  path: string;
  content_sha256: string;
  line_count: number;
  non_empty_line_count: number;
  units: SourceStructureUnit[];
}

interface Block {
  kind: SourceUnitKind;
  start: number;
  end: number;
  structured?: boolean;
}

export function buildSourceStructureInventory(sourcePath: string, sourceId: string): SourceStructureInventory {
  if (!sourceId.trim()) throw new Error("sourceId is required");
  const path = resolve(sourcePath);
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const blocks = isStructuredJson(content) ? splitStructuredJsonLines(lines) : splitMarkdownBlocks(lines);
  const units = blocks.map((block) => buildUnit(lines, block, sourceId));
  return {
    schema: SOURCE_STRUCTURE_INVENTORY_VERSION,
    source_id: sourceId,
    path,
    content_sha256: sha256(content),
    line_count: lines.length,
    non_empty_line_count: lines.filter((line) => line.trim()).length,
    units,
  };
}

function splitMarkdownBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const line = lines[index];
    if (isFenceStart(line)) {
      const end = findFenceEnd(lines, index);
      blocks.push({ kind: "other", start: index, end });
      index = end + 1;
      continue;
    }
    if (isHeading(line)) {
      blocks.push({ kind: "section", start: index, end: index });
      index += 1;
      continue;
    }
    if (isImage(line)) {
      blocks.push({ kind: isDiagram(line) ? "diagram" : "image", start: index, end: index });
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const end = findTableEnd(lines, index);
      blocks.push({ kind: "table", start: index, end });
      index = end + 1;
      continue;
    }
    const start = index;
    while (index + 1 < lines.length
      && lines[index + 1].trim()
      && !isFenceStart(lines[index + 1])
      && !isHeading(lines[index + 1])
      && !isImage(lines[index + 1])
      && !isTableStart(lines, index + 1)) {
      index += 1;
    }
    blocks.push({ kind: "paragraph", start, end: index });
    index += 1;
  }
  return blocks;
}

function buildUnit(lines: string[], block: Block, sourceId: string): SourceStructureUnit {
  const content = lines.slice(block.start, block.end + 1).join("\n");
  const contentHash = sha256(content);
  const { importance, signals } = classifyImportance(block.kind, content, block.structured === true);
  const startLine = block.start + 1;
  const endLine = block.end + 1;
  return {
    unit_id: `unit-${sha256(`${sourceId}:${startLine}:${endLine}:${contentHash}`).slice(0, 16)}`,
    source_id: sourceId,
    unit_kind: block.kind,
    locator: startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`,
    start_line: startLine,
    end_line: endLine,
    content,
    content_sha256: contentHash,
    importance,
    importance_signals: signals,
  };
}

function classifyImportance(kind: SourceUnitKind, content: string, structured = false): { importance: SourceUnitImportance; signals: string[] } {
  const signals: string[] = [];
  if (kind === "diagram") return { importance: "core", signals: ["结构图需单独解析"] };
  if (kind === "image") return { importance: "supporting", signals: ["视觉内容需单独解析"] };
  if (structured && kind === "other") return { importance: "context", signals: ["结构元数据"] };
  const semanticContent = structured ? structuredScalarValue(content) : content;
  const checks: Array<[string, RegExp]> = [
    ["强约束", /必须|不得|禁止|不能|不允许|只允许|除非/u],
    ["例外或失败", /例外|异常|失败|回滚|补偿|兜底|停止条件/u],
    ["状态或不变量", /状态|流转|跃迁|不变量|一致性/u],
    ["接口或数据契约", /接口|字段|枚举|协议|契约|生产者|消费者/u],
    ["资金或风险", /金额|资金|利润|安全|风险/u],
    ["精确数字", /(^|[^\p{L}\p{N}])\d+(?:\.\d+)?%?(?=$|[^\p{L}\p{N}])/u],
  ];
  for (const [label, pattern] of checks) if (pattern.test(semanticContent)) signals.push(label);
  if (signals.length > 0) return { importance: "core", signals };
  if (kind === "section") return { importance: "context", signals: ["结构标题"] };
  return { importance: "supporting", signals: ["默认保留"] };
}

function isStructuredJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    const lines = trimmed.split("\n").filter((line) => line.trim());
    return lines.length > 0 && lines.every((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    });
  }
}

function splitStructuredJsonLines(lines: string[]): Block[] {
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    const kind: SourceUnitKind = /"(?:quoteContent|content)"\s*:/u.test(line)
      ? "comment"
      : /"(?:text|message|prompt|response)"\s*:/u.test(line)
        ? "message"
        : /"(?:tool_result|toolResult|tool_output|toolOutput)"\s*:/u.test(line)
          ? "tool_result"
          : "other";
    return [{ kind, start: index, end: index, structured: true }];
  });
}

function structuredScalarValue(line: string): string {
  const separator = line.indexOf(":");
  if (separator < 0) return line;
  const raw = line.slice(separator + 1).trim().replace(/,$/u, "");
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return raw;
  }
}

function isFenceStart(line: string): boolean {
  return /^\s*(```|~~~)/u.test(line);
}

function findFenceEnd(lines: string[], start: number): number {
  const marker = lines[start].trim().startsWith("~~~") ? "~~~" : "```";
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith(marker)) return index;
  }
  return lines.length - 1;
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+/u.test(line);
}

function isImage(line: string): boolean {
  return /!\[[^\]]*\]\([^)]+\)|<img\b|!\[\[[^\]]+\]\]|\[DrawIO[^\]]*\]/iu.test(line);
}

function isDiagram(line: string): boolean {
  return /drawio|diagram|架构图|流程图/iu.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index];
  const next = lines[index + 1] ?? "";
  return line.includes("|") && (/^\s*\|?\s*:?-{3,}/u.test(next) || /^\s*\|?\s*:?-{3,}/u.test(line));
}

function findTableEnd(lines: string[], start: number): number {
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim() && lines[end + 1].includes("|")) end += 1;
  return end;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
