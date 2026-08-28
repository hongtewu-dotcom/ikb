import { LedgerStore } from "../store.ts";
import { printValue } from "../format.ts";
import { writePersonDossier, writePersonDossiers, type PersonDossierResult } from "../person.ts";
import { addKeyPerson, listKeyPeople, removeKeyPerson, updateKeyPerson, type KeyPersonInput } from "../people.ts";
import { buildPersonReadiness, recordPersonAnalysisCheckpoint, writePersonReadiness, type PersonAnalysisDisposition } from "../person-evidence.ts";
import { type ParsedArgs, optionalOption, outputFormat, requiredArg, requiredOption } from "./shared.ts";

export function handlePeople(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "list":
      printValue(listKeyPeople(home, optionalOption(parsed, "scope")), outputFormat(parsed));
      break;
    case "add": {
      const id = requiredArg(args, 0, "key person id");
      const person = addKeyPerson(home, id, {
        mis: optionalOption(parsed, "mis"),
        uid: optionalOption(parsed, "uid"),
        name: optionalOption(parsed, "name"),
        aliases: optionalOption(parsed, "aliases")?.split(",").map((value) => value.trim()).filter(Boolean),
        scope: optionalOption(parsed, "scope"),
      });
      store.recordPersonEvent(person.id, "person.added", { person });
      printValue(person, outputFormat(parsed));
      break;
    }
    case "update": {
      const fields: KeyPersonInput = {};
      for (const key of ["mis", "uid", "name", "scope"] as const) {
        if (parsed.options[key] !== undefined) fields[key] = String(parsed.options[key]);
      }
      if (parsed.options.aliases !== undefined) fields.aliases = String(parsed.options.aliases).split(",").map((value) => value.trim()).filter(Boolean);
      const person = updateKeyPerson(home, requiredArg(args, 0, "key person id"), fields);
      store.recordPersonEvent(person.id, "person.updated", { person });
      printValue(person, outputFormat(parsed));
      break;
    }
    case "remove": {
      const person = removeKeyPerson(home, requiredArg(args, 0, "key person id"));
      store.recordPersonEvent(person.id, "person.removed", { person });
      printValue(person, outputFormat(parsed));
      break;
    }
    case "view": {
      const person = writePersonDossier(home, requiredArg(args, 0, "key person id"), {
        scope: optionalOption(parsed, "scope"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
      });
      store.recordPersonEvent(person.person.id, "person.view_built", {
        path: person.path,
        scope: person.scope,
        matchedCount: person.matchedCount,
        returnedCount: person.returnedCount,
        sourceIds: person.sources.map((source) => source.sourceId),
      });
      if (outputFormat(parsed) === "json") printValue(person, "json");
      else printPersonDossier(person);
      break;
    }
    case "rebuild": {
      const people = listKeyPeople(home, optionalOption(parsed, "scope")).filter((person) => person.enabled);
      const batch = writePersonDossiers(home, people.map((person) => person.id), {
        scope: optionalOption(parsed, "scope"),
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
      });
      const results = batch.results;
      for (const person of results) {
        store.recordPersonEvent(person.person.id, "person.view_built", {
          path: person.path,
          scope: person.scope,
          matchedCount: person.matchedCount,
          returnedCount: person.returnedCount,
          sourceIds: person.sources.map((source) => source.sourceId),
          batch: {
            personCount: batch.personCount,
            scopeCount: batch.scopeCount,
            sourceCount: batch.sourceCount,
            sourceReadCount: batch.sourceReadCount,
            scannedRecordCount: batch.scannedRecordCount,
          },
        });
      }
      if (outputFormat(parsed) === "json") {
        printValue(parsed.options.summary === true ? {
          schema: batch.schema,
          generatedAt: batch.generatedAt,
          personCount: batch.personCount,
          scopeCount: batch.scopeCount,
          sourceCount: batch.sourceCount,
          sourceReadCount: batch.sourceReadCount,
          scannedRecordCount: batch.scannedRecordCount,
          quotedReplyRepairedCount: batch.quotedReplyRepairedCount,
          quotedReplyExcludedCount: batch.quotedReplyExcludedCount,
          results: results.map(personSummary),
        } : results, "json");
      }
      else {
        console.log(`Person dossier batch: people=${batch.personCount} scopes=${batch.scopeCount} sourceReads=${batch.sourceReadCount} recordsScanned=${batch.scannedRecordCount}`);
        results.forEach(printPersonDossier);
      }
      break;
    }
    case "readiness": {
      const mode = optionalOption(parsed, "mode") ?? "weekly";
      if (mode !== "weekly" && mode !== "incremental") throw new Error("--mode must be weekly or incremental");
      const report = buildPersonReadiness(home, { scope: (optionalOption(parsed, "scope") ?? "work") as "personal" | "work", mode });
      const paths = parsed.options.write === true ? writePersonReadiness(home, report) : null;
      printValue({ ...report, paths }, outputFormat(parsed));
      break;
    }
    case "checkpoint": {
      const disposition = (optionalOption(parsed, "disposition") ?? "evidence_only") as PersonAnalysisDisposition;
      if (!new Set(["evidence_only", "no_change", "candidates_produced"]).has(disposition)) throw new Error("--disposition must be evidence_only, no_change, or candidates_produced");
      const checkpoint = recordPersonAnalysisCheckpoint(home, requiredArg(args, 0, "key person id"), {
        scope: (optionalOption(parsed, "scope") ?? "work") as "personal" | "work",
        artifactPath: requiredOption(parsed, "artifact"),
        disposition,
        viewsAnalyzed: optionalOption(parsed, "views")?.split(",").map((value) => value.trim()).filter(Boolean),
        counterevidenceSearch: optionalOption(parsed, "counterevidence-search"),
      });
      store.recordPersonEvent(checkpoint.personId, "person.analysis_checkpointed", {
        scope: checkpoint.scope,
        analyzedAt: checkpoint.analyzedAt,
        evidenceFingerprint: checkpoint.evidenceFingerprint,
        artifactPath: checkpoint.artifactPath,
        artifactHash: checkpoint.artifactHash,
        disposition: checkpoint.disposition,
        viewsAnalyzed: checkpoint.viewsAnalyzed,
        counterevidenceSearch: checkpoint.counterevidenceSearch,
      });
      printValue(checkpoint, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown people action: ${action ?? ""}`);
  }
}

function personSummary(person: PersonDossierResult): Record<string, unknown> {
  return {
    personId: person.person.id,
    name: person.person.name ?? person.person.id,
    scope: person.scope,
    path: person.path,
    matchedSourceCount: person.matchedSourceCount,
    matchedCount: person.matchedCount,
    directMatchedCount: person.directMatchedCount,
    contextMatchedCount: person.contextMatchedCount,
    duplicateCount: person.duplicateCount,
    returnedCount: person.returnedCount,
    truncated: person.truncated,
    attributionCounts: person.attributionCounts,
    structuralEpisodes: person.evidenceMetrics.directEpisodeKeys.length,
    independentSources: person.evidenceMetrics.independentSourceKeys.length,
    distinctDates: person.evidenceMetrics.distinctDates.length,
  };
}

function printPersonDossier(view: PersonDossierResult): void {
  console.log(`Person dossier: ${view.person.name ?? view.person.id}`);
  console.log(`scope=${view.scope} sources=${view.matchedSourceCount}/${view.sourceCount} matched=${view.matchedCount} direct=${view.directMatchedCount} context=${view.contextMatchedCount} duplicates=${view.duplicateCount} shown=${view.returnedCount}`);
  console.log(`path=${view.path}`);
}
