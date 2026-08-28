import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import {
  clusterExperienceRecords,
  findExperienceCandidate,
  findExperienceRecord,
  listExperienceCandidates,
  listExperienceRecords,
  markExperienceAnalyzed,
  triageSessions,
  type ExperienceAdapterSelection,
  type ExperienceScope,
} from "../experience.ts";
import {
  analyzeExperience,
  findLatestExperienceAnalysis,
  parseExperienceAnalysisInput,
  rankExperienceQueue,
  recordExperienceValidation,
} from "../experience-analysis.ts";
import { buildExperienceContext, materializeExperienceContext } from "../experience-context.ts";
import { decideReviewedExperienceCandidate, inspectCurrentExperienceReviewPackage, registerExperienceReviewPackage } from "../experience-review.ts";
import { readLatestReasoning, runReasoning } from "../reasoning.ts";
import {
  type ParsedArgs,
  historyAdapterSelection,
  optionalOption,
  optionalBoundedInteger,
  outputFormat,
  requiredArg,
  requiredOption,
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
    case "context": {
      const id = requiredArg(args, 0, "experience id");
      const record = findExperienceRecord(home, id);
      if (!record) throw new Error(`Experience Record not found: ${id}`);
      const limit = optionalBoundedInteger(parsed, "limit", 1, 500);
      const runId = optionalOption(parsed, "run");
      printValue(runId
        ? materializeExperienceContext(home, store, record, runId, limit)
        : { ...buildExperienceContext(home, record, limit, store), contextArtifact: null }, outputFormat(parsed));
      break;
    }
    case "queue": {
      const limitText = optionalOption(parsed, "limit");
      const limit = limitText === undefined ? 100 : Number(limitText);
      assertValue(Number.isInteger(limit) && limit >= 0, "--limit must be a non-negative integer");
      printValue(rankExperienceQueue(listExperienceRecords(home), scope, limit), outputFormat(parsed));
      break;
    }
    case "analyze": {
      const id = requiredArg(args, 0, "experience id");
      const record = findExperienceRecord(home, id);
      if (!record) throw new Error(`Experience Record not found: ${id}`);
      const input = parseExperienceAnalysisInput(requiredOption(parsed, "file"));
      printValue(analyzeExperience(home, store, record, input, (analysis) => markExperienceAnalyzed(home, analysis)), outputFormat(parsed));
      break;
    }
    case "analysis-show": {
      const id = requiredArg(args, 0, "experience id");
      const record = findExperienceRecord(home, id);
      if (!record) throw new Error(`Experience Record not found: ${id}`);
      const analysis = findLatestExperienceAnalysis(home, record);
      if (!analysis) throw new Error(`Experience Analysis not found: ${id}`);
      printValue(analysis, outputFormat(parsed));
      break;
    }
    case "analysis-list":
      printValue(listExperienceRecords(home, scope)
        .filter((record) => record.status === "analyzed" && Boolean(record.analysisRef))
        .map((record) => findLatestExperienceAnalysis(home, record))
        .filter(Boolean), outputFormat(parsed));
      break;
    case "validate": {
      const id = requiredArg(args, 0, "experience id");
      const record = findExperienceRecord(home, id);
      if (!record) throw new Error(`Experience Record not found: ${id}`);
      const result = requiredOption(parsed, "result");
      assertValue(result === "pass" || result === "fail", "--result must be pass or fail");
      printValue(recordExperienceValidation(home, store, record, {
        result,
        method: requiredOption(parsed, "method"),
        note: requiredOption(parsed, "note"),
        artifactId: requiredOption(parsed, "artifact"),
      }), outputFormat(parsed));
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
    case "candidate-review": {
      const id = requiredArg(args, 0, "experience candidate id");
      const validationArtifactIds = requiredOption(parsed, "validation").split(",").map((value) => value.trim()).filter(Boolean);
      printValue(registerExperienceReviewPackage(home, store, id, {
        draftArtifactId: optionalOption(parsed, "draft"),
        validationArtifactIds,
        guideArtifactId: requiredOption(parsed, "guide"),
        primaryKnowledgeId: optionalOption(parsed, "primary"),
      }), outputFormat(parsed));
      break;
    }
    case "candidate-review-show": {
      const id = requiredArg(args, 0, "experience candidate id");
      printValue(inspectCurrentExperienceReviewPackage(home, store, id), outputFormat(parsed));
      break;
    }
    case "candidate-decide": {
      const id = requiredArg(args, 0, "experience candidate id");
      const decision = requiredOption(parsed, "decision");
      assertValue(decision === "accept" || decision === "reject", "--decision must be accept or reject");
      printValue(decideReviewedExperienceCandidate(home, store, id, {
        decision,
        reason: requiredOption(parsed, "reason"),
        reviewedArtifactPath: optionalOption(parsed, "file"),
      }), outputFormat(parsed));
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
