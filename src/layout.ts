import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface IkbPaths {
  home: string;
  knowledge: string;
  inbox: string;
  archive: string;
  system: string;
  sources: string;
  receipts: string;
  ledger: string;
  runs: string;
  cache: string;
  backups: string;
  compatibility: {
    sources: string;
    vaults: string;
    ledger: string;
    runs: string;
    backups: string;
  };
}

/** Target four-object layout plus explicit legacy read paths. New target
 * responsibilities must use this resolver instead of scattering paths. */
export function ikbPaths(home: string): IkbPaths {
  const root = resolve(home);
  const system = join(root, ".system");
  return {
    home: root,
    knowledge: join(root, "knowledge"),
    inbox: join(root, "inbox"),
    archive: join(root, "archive"),
    system,
    sources: join(system, "sources"),
    receipts: join(system, "receipts"),
    ledger: join(system, "ledger"),
    runs: join(system, "runs"),
    cache: join(system, "cache"),
    backups: join(system, "backups"),
    compatibility: {
      sources: join(root, "sources"),
      vaults: join(root, "vaults"),
      ledger: join(root, "ledger"),
      runs: join(root, "runs"),
      backups: join(root, "backups"),
    },
  };
}

/**
 * Runtime storage roots. Existing homes keep using their explicit legacy
 * config until the layout migration atomically switches those values; fresh
 * homes use the target layout immediately.
 */
export function resolveSourcesRoot(home: string): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  return resolve(String(process.env.IKB_SOURCES_ROOT ?? configuredPath(home, config, "sources_root") ?? (usesLegacyLayout(config, paths) ? paths.compatibility.sources : paths.sources)));
}

export function resolveLedgerPath(home: string): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  const fallback = usesLegacyLayout(config, paths)
    ? join(paths.compatibility.ledger, "events.jsonl")
    : join(paths.ledger, "events.jsonl");
  return resolve(String(process.env.IKB_LEDGER_PATH ?? configuredPath(home, config, "ledger") ?? fallback));
}

export function resolveLedgerRoot(home: string): string {
  return dirname(resolveLedgerPath(home));
}

export function resolveRunsRoot(home: string): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  return resolve(String(process.env.IKB_RUNS_ROOT ?? configuredPath(home, config, "runs_root") ?? (usesLegacyLayout(config, paths) ? paths.compatibility.runs : paths.runs)));
}

export function resolveBackupsRoot(home: string): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  return resolve(String(process.env.IKB_BACKUPS_ROOT ?? configuredPath(home, config, "backups_root") ?? (usesLegacyLayout(config, paths) ? paths.compatibility.backups : paths.backups)));
}

export function resolveCacheRoot(home: string): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  return resolve(String(process.env.IKB_CACHE_ROOT ?? configuredPath(home, config, "cache_root") ?? paths.cache));
}

export function resolvePeopleRoot(home: string, scope = "personal"): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  const configuredRoot = process.env.IKB_PEOPLE_ROOT ?? configuredPath(home, config, "people_root");
  if (configuredRoot) return join(resolve(String(configuredRoot)), scope);
  return usesLegacyLayout(config, paths)
    ? join(paths.compatibility.vaults, scope, "people")
    : join(paths.cache, "people", scope);
}

/** Filesystem layout and scope routing shared by Knowledge consumers. */
export function resolveVault(home: string, scope = "personal"): string {
  const paths = ikbPaths(home);
  const config = readConfig(home);
  const envKey = scope === "work" ? "IKB_WORK_VAULT" : "IKB_PERSONAL_VAULT";
  const configured = configuredPath(home, config, scope === "work" ? "work_vault" : "personal_vault");
  const fallback = usesLegacyLayout(config, paths)
    ? join(paths.compatibility.vaults, scope)
    : join(paths.knowledge, scope);
  return resolve(String(process.env[envKey] ?? configured ?? fallback));
}

export function readConfig(home: string): Record<string, string> {
  const path = join(home, "config.yaml");
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((line) => {
    const index = line.indexOf(":");
    return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : null;
  }).filter(Boolean) as [string, string][]);
}

function usesLegacyLayout(config: Record<string, string>, paths: IkbPaths): boolean {
  if (Object.keys(config).length === 0) return true;
  const configuredLedger = config.ledger ? resolve(config.ledger) : "";
  const configuredPersonal = config.personal_vault ? resolve(config.personal_vault) : "";
  const configuredWork = config.work_vault ? resolve(config.work_vault) : "";
  return configuredLedger === join(paths.compatibility.ledger, "events.jsonl")
    || configuredPersonal === join(paths.compatibility.vaults, "personal")
    || configuredWork === join(paths.compatibility.vaults, "work");
}

function configuredPath(home: string, config: Record<string, string>, key: string): string | undefined {
  const value = config[key];
  if (!value) return undefined;
  const configured = resolve(value);
  const previousHome = config.home ? resolve(config.home) : null;
  const currentHome = resolve(home);
  if (!previousHome || previousHome === currentHome) return configured;
  const suffix = relative(previousHome, configured);
  if (!suffix.startsWith("..") && !isAbsolute(suffix)) return resolve(currentHome, suffix);
  return configured;
}
