import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertValue, printValue } from "../format.ts";
import { buildPublicationRun } from "../publication/workflow.ts";
import type { DailyCopilotMigrationManifest, PublicationChannel } from "../publication/contracts.ts";
import type { LedgerStore } from "../store.ts";
import { optionalOption, outputFormat, type ParsedArgs } from "./shared.ts";

const IMPLEMENTED_BUILD_CHANNELS = new Set<PublicationChannel>(["personal-github", "daily-copilot"]);

export function handlePublish(
  store: LedgerStore,
  home: string,
  action: string | undefined,
  _args: string[],
  parsed: ParsedArgs,
): void {
  switch (action) {
    case "build": {
      const channel = String(optionalOption(parsed, "channel") ?? "personal-github") as PublicationChannel;
      assertValue(
        IMPLEMENTED_BUILD_CHANNELS.has(channel),
        "--channel must be personal-github or daily-copilot",
      );
      const knowledgeIds = splitList(optionalOption(parsed, "knowledge-id", "knowledge-ids"));
      const migration = channel === "daily-copilot"
        ? readDailyCopilotMigration(optionalOption(parsed, "migration-manifest"))
        : undefined;
      const result = buildPublicationRun(store, home, {
        channel,
        knowledgeIds: knowledgeIds.length > 0 ? knowledgeIds : undefined,
        dailyCopilotMigration: migration,
      });
      printValue(result, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown publish action: ${action ?? ""}`);
  }
}

function splitList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function readDailyCopilotMigration(path: string | undefined): DailyCopilotMigrationManifest {
  assertValue(path, "daily-copilot build requires --migration-manifest <path>");
  const absolutePath = resolve(path);
  assertValue(existsSync(absolutePath), `Daily Copilot migration manifest does not exist: ${absolutePath}`);
  const metadata = lstatSync(absolutePath);
  assertValue(metadata.isFile() && !metadata.isSymbolicLink(), "Daily Copilot migration manifest must be a regular file");
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8")) as DailyCopilotMigrationManifest;
  } catch (error) {
    throw new Error(`Daily Copilot migration manifest is not valid JSON: ${(error as Error).message}`);
  }
}
