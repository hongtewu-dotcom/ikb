import { LedgerStore } from "../store.ts";
import { printValue } from "../format.ts";
import { buildObservabilityReport } from "../observability.ts";
import { type ParsedArgs, outputFormat } from "./shared.ts";

export function handleObserveReport(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  const period = action === "report" ? args[0] : action;
  if (!period || !["daily", "weekly"].includes(period)) throw new Error("Usage: ikb observe daily|weekly");
  printValue(buildObservabilityReport(store, period as "daily" | "weekly"), outputFormat(parsed));
}
