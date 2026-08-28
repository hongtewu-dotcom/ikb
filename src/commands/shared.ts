import { assertValue } from "../format.ts";
import type { HistoryAdapterSelection } from "../history.ts";
import type { OutputFormat } from "../types.ts";

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      options[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[raw] = next;
      index += 1;
    } else {
      options[raw] = true;
    }
  }
  if (options.json) options.output = "json";
  return { positionals, options };
}

export function outputFormat(parsed: ParsedArgs): OutputFormat {
  return parsed.options.output === "json" ? "json" : "table";
}

export function requiredOption(parsed: ParsedArgs, ...names: string[]): string {
  const value = names.map((name) => parsed.options[name]).find((candidate) => typeof candidate === "string" && candidate.length > 0);
  assertValue(value, `Missing required option: --${names[0]}`);
  return String(value);
}

export function optionalOption(parsed: ParsedArgs, ...names: string[]): string | undefined {
  const value = names.map((name) => parsed.options[name]).find((candidate) => typeof candidate === "string");
  return value === undefined ? undefined : String(value);
}

export function optionalBoundedInteger(parsed: ParsedArgs, name: string, minimum: number, maximum: number): number | undefined {
  const raw = optionalOption(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  assertValue(Number.isInteger(value) && value >= minimum && value <= maximum, `--${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export function incrementalOption(parsed: ParsedArgs): boolean {
  return parsed.options["no-incremental"] !== true;
}

export function historyAdapterSelection(value: string | undefined): HistoryAdapterSelection {
  const selection = value ?? "all";
  assertValue(["claude", "codex", "desk", "elephant", "all"].includes(selection), "--adapter must be claude, codex, desk, elephant, or all");
  return selection as HistoryAdapterSelection;
}

export function pickOptions(parsed: ParsedArgs, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => typeof parsed.options[name] === "string").map((name) => [name, String(parsed.options[name])]));
}

export function requiredArg(args: string[], index: number, label: string): string {
  assertValue(args[index], `Missing ${label}`);
  return args[index];
}

export function requiredValue(value: string | undefined, label: string): string {
  assertValue(value, `Missing ${label}`);
  return value;
}

export function sleepMs(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}
