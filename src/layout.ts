import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Filesystem layout and scope routing shared by projections. */
export function resolveVault(home: string, scope = "personal"): string {
  const config = readConfig(home);
  const envKey = scope === "work" ? "IKB_WORK_VAULT" : "IKB_PERSONAL_VAULT";
  return resolve(String(process.env[envKey] ?? config[scope === "work" ? "work_vault" : "personal_vault"] ?? join(home, "vaults", scope)));
}

function readConfig(home: string): Record<string, string> {
  const path = join(home, "config.yaml");
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : null;
  }).filter(Boolean) as [string, string][]);
}
