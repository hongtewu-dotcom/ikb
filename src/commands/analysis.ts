import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import {
  clusterExperienceRecords,
  findExperienceCandidate,
  findExperienceRecord,
  listExperienceCandidates,
  listExperienceRecords,
  triageSessions,
  type ExperienceAdapterSelection,
  type ExperienceScope,
} from "../experience.ts";
import { readLatestReasoning, runReasoning } from "../reasoning.ts";
import {
  type ParsedArgs,
  historyAdapterSelection,
  optionalOption,
  outputFormat,
  requiredArg,
} from "./shared.ts";

export function handleExperience(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  const scopeValue = optionalOption(parsed, "scope");
  if (scopeValue) assertValue(["personal", "work"].includes(scopeValue), "--scope must be personal or work");
  const scope = scopeValue as ExperienceScope | undefined;
  switch (action) {
    case "triage": {
      const limitText = optionalOption(parsed, "limit");
      const limit = limitText === undefined ? undefined : Number(limitText);
      if (limit !== undefined) assertValue(Number.isInteger(limit) && limit >= 0, "--limit must be a non-negative integer");
      const adapterValue = optionalOption(parsed, "adapter");
      const adapter = adapterValue ? historyAdapterSelection(adapterValue) as ExperienceAdapterSelection : "all" as const;
      printValue(triageSessions(home, store, { scope, adapter, from: optionalOption(parsed, "from"), to: optionalOption(parsed, "to"), limit }), outputFormat(parsed));
      break;
    }
    case "list":
      printValue(listExperienceRecords(home, scope), outputFormat(parsed));
      break;
    case "show": {
      const id = requiredArg(args, 0, "experience id");
      const record = findExperienceRecord(home, id);
      if (!record) throw new Error(`Experience Record not found: ${id}`);
      printValue(record, outputFormat(parsed));
      break;
    }
    case "cluster": {
      const minimumText = optionalOption(parsed, "min-samples");
      const minimumSamples = minimumText === undefined ? 3 : Number(minimumText);
      assertValue(Number.isInteger(minimumSamples) && minimumSamples >= 2, "--min-samples must be an integer >= 2");
      printValue(clusterExperienceRecords(home, store, { scope, minimumSamples }), outputFormat(parsed));
      break;
    }
    case "candidate-list":
      printValue(listExperienceCandidates(home, scope), outputFormat(parsed));
      break;
    case "candidate-show": {
      const id = requiredArg(args, 0, "experience candidate id");
      const candidate = findExperienceCandidate(home, id);
      if (!candidate) throw new Error(`Experience Candidate not found: ${id}`);
      printValue(candidate, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown experience action: ${action ?? ""}`);
  }
}

export function handleReasoning(store: LedgerStore, home: string, action: string | undefined, parsed: ParsedArgs): void {
  const scopeValue = optionalOption(parsed, "scope") ?? "work";
  assertValue(["personal", "work"].includes(scopeValue), "--scope must be personal or work");
  if (action === "run") {
    printValue(runReasoning(home, store, { scope: scopeValue as "personal" | "work" }), outputFormat(parsed));
    return;
  }
  if (action === "show") {
    printValue(readLatestReasoning(home, scopeValue as "personal" | "work"), outputFormat(parsed));
    return;
  }
  throw new Error(`Unknown reasoning action: ${action ?? ""}`);
}
