import { LedgerStore } from "../store.ts";
import { printValue } from "../format.ts";
import { rebuildKnowledgeViews } from "../knowledge.ts";
import { writePersonDossier, type PersonDossierResult } from "../person.ts";
import { addKeyPerson, listKeyPeople, removeKeyPerson, updateKeyPerson, type KeyPersonInput } from "../people.ts";
import { type ParsedArgs, optionalOption, outputFormat, requiredArg } from "./shared.ts";

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
      rebuildKnowledgeViews(home, person.scope);
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
      const results = people.map((person) => writePersonDossier(home, person.id, {
        scope: person.scope,
        from: optionalOption(parsed, "from"),
        to: optionalOption(parsed, "to"),
        limit: optionalOption(parsed, "limit") ? Number(parsed.options.limit) : undefined,
      }));
      for (const person of results) {
        rebuildKnowledgeViews(home, person.scope);
        store.recordPersonEvent(person.person.id, "person.view_built", {
          path: person.path,
          scope: person.scope,
          matchedCount: person.matchedCount,
          returnedCount: person.returnedCount,
          sourceIds: person.sources.map((source) => source.sourceId),
        });
      }
      if (outputFormat(parsed) === "json") printValue(results, "json");
      else results.forEach(printPersonDossier);
      break;
    }
    default:
      throw new Error(`Unknown people action: ${action ?? ""}`);
  }
}

function printPersonDossier(view: PersonDossierResult): void {
  console.log(`Person dossier: ${view.person.name ?? view.person.id}`);
  console.log(`scope=${view.scope} sources=${view.matchedSourceCount}/${view.sourceCount} matched=${view.matchedCount} direct=${view.directMatchedCount} context=${view.contextMatchedCount} duplicates=${view.duplicateCount} shown=${view.returnedCount}`);
  console.log(`path=${view.path}`);
}
