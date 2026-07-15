import type { OutputFormat } from "./types.ts";

export function printValue(value: unknown, format: OutputFormat = "table"): void {
  if (format === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (Array.isArray(value)) {
    console.log(formatRows(value as Record<string, unknown>[]));
    return;
  }

  if (value && typeof value === "object") {
    console.log(formatObject(value as Record<string, unknown>));
    return;
  }

  console.log(String(value ?? ""));
}

export function formatRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)";
  const columns = Object.keys(rows[0]);
  const values = rows.map((row) => columns.map((column) => display(row[column])));
  const widths = columns.map((column, index) => Math.min(48, Math.max(column.length, ...values.map((row) => row[index].length))));
  const header = columns.map((column, index) => column.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = values.map((row) => row.map((value, index) => value.slice(0, widths[index]).padEnd(widths[index])).join("  "));
  return [header, divider, ...body].join("\n");
}

export function formatObject(value: Record<string, unknown>): string {
  const rows = Object.entries(value).map(([key, item]) => ({ field: key, value: display(item) }));
  return formatRows(rows);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.replaceAll("\n", "\\n");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function assertValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
