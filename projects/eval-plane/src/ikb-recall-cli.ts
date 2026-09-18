import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activateIkbUsageV2, readIkbUsageV2Activation, collectIkbRecallRollouts, collectIkbRecallRolloutsV2, IKB_RECALL_COLLECTION_SCHEMA } from "./ikb-recall.ts";
import { collectPiUserCorrections, PI_CORRECTION_COLLECTION_SCHEMA } from "./ikb-recall-pi.ts";
import { collectClaudeUserCorrections, CLAUDE_CORRECTION_COLLECTION_SCHEMA } from "./ikb-recall-claude.ts";

interface CliOptions {
  sessionRoots: string[];
  activeDataRoot: string;
  evaluationHome: string;
  from?: string;
  to?: string;
  lockTimeoutMs?: number;
  failOpen: boolean;
  activatedAt?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const options: CliOptions = {
    sessionRoots: [],
    activeDataRoot: resolve(repoRoot, "ikb-data"),
    evaluationHome: resolve(repoRoot, "ikb-data"),
    failOpen: false,
  };
  let evaluationHomeExplicit = false;
  const args = ["collect", "collect-v2", "activate-v2", "collect-pi", "collect-claude"].includes(argv[0]) ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (!next) throw new Error(`missing value for ${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--sessions" || arg === "--session-root") options.sessionRoots.push(resolve(value()));
    else if (arg === "--data-root") {
      options.activeDataRoot = resolve(value());
      if (!evaluationHomeExplicit) options.evaluationHome = options.activeDataRoot;
    } else if (arg === "--evaluation-home") {
      options.evaluationHome = resolve(value());
      evaluationHomeExplicit = true;
    } else if (arg === "--from") options.from = value();
    else if (arg === "--to") options.to = value();
    else if (arg === "--activated-at") options.activatedAt = value();
    else if (arg === "--lock-timeout-ms") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60_000) throw new Error("--lock-timeout-ms must be an integer between 0 and 60000");
      options.lockTimeoutMs = parsed;
    } else if (arg === "--fail-open") options.failOpen = true;
    else throw new Error(`unsupported argument: ${arg}`);
  }
  // 默认 session root 由调用方按采集对象决定（codex / pi 不同）
  return options;
}

export function runIkbRecallV2Cli(argv: string[], io: Pick<typeof process, "stdout" | "stderr"> = process): number {
  let failOpen = argv.includes("--fail-open");
  try {
    const command = argv[0] === "activate-v2" ? "activate-v2" : "collect-v2";
    const options = parseArgs(argv);
    failOpen = options.failOpen;
    if (command === "activate-v2") {
      const activation = activateIkbUsageV2(options.activeDataRoot, options.activatedAt);
      io.stdout.write(`${JSON.stringify(activation)}\n`);
      return 0;
    }
    const report = collectIkbRecallRolloutsV2({
      sessionRoots: options.sessionRoots.length > 0 ? options.sessionRoots : [resolve(homedir(), ".codex", "sessions")],
      activeDataRoot: options.activeDataRoot,
      evaluationHome: options.evaluationHome,
      from: options.from,
      to: options.to,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    io.stdout.write(`${JSON.stringify(report)}\n`);
    return failOpen || report.status === "ready" ? 0 : 1;
  } catch {
    const failure = { schema: "ikb-recall-usage-collection-v2", version: "v2", status: "degraded", issueCode: "collector_failed" };
    (failOpen ? io.stdout : io.stderr).write(`${JSON.stringify(failure)}\n`);
    return failOpen ? 0 : 1;
  }
}

export function runIkbRecallCli(argv: string[], io: Pick<typeof process, "stdout" | "stderr"> = process): number {
  if (argv[0] === "collect-v2" || argv[0] === "activate-v2") return runIkbRecallV2Cli(argv, io);
  let failOpen = argv.includes("--fail-open");
  try {
    const options = parseArgs(argv);
    if (readIkbUsageV2Activation(options.activeDataRoot)) return runIkbRecallV2Cli(argv, io);
    failOpen = options.failOpen;
    const report = collectIkbRecallRollouts({
      sessionRoots: options.sessionRoots.length > 0 ? options.sessionRoots : [resolve(homedir(), ".codex", "sessions")],
      activeDataRoot: options.activeDataRoot,
      evaluationHome: options.evaluationHome,
      from: options.from,
      to: options.to,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    io.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch {
    const failure = { schema: IKB_RECALL_COLLECTION_SCHEMA, status: "degraded", issueCode: "collector_failed" };
    (failOpen ? io.stdout : io.stderr).write(`${JSON.stringify(failure)}\n`);
    return failOpen ? 0 : 1;
  }
}

export async function runIkbRecallPiCli(argv: string[], io: Pick<typeof process, "stdout" | "stderr"> = process): Promise<number> {
  let failOpen = argv.includes("--fail-open");
  try {
    const options = parseArgs(argv);
    failOpen = options.failOpen;
    const report = await collectPiUserCorrections({
      sessionRoots: options.sessionRoots.length > 0 ? options.sessionRoots : undefined,
      activeDataRoot: options.activeDataRoot,
      from: options.from,
      to: options.to,
    });
    io.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch {
    const failure = { schema: PI_CORRECTION_COLLECTION_SCHEMA, status: "degraded", issueCode: "collector_failed" };
    (failOpen ? io.stdout : io.stderr).write(`${JSON.stringify(failure)}\n`);
    return failOpen ? 0 : 1;
  }
}

export async function runIkbRecallClaudeCli(argv: string[], io: Pick<typeof process, "stdout" | "stderr"> = process): Promise<number> {
  let failOpen = argv.includes("--fail-open");
  try {
    const options = parseArgs(argv);
    failOpen = options.failOpen;
    const report = await collectClaudeUserCorrections({
      sessionRoots: options.sessionRoots.length > 0 ? options.sessionRoots : undefined,
      activeDataRoot: options.activeDataRoot,
      from: options.from,
      to: options.to,
    });
    io.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch {
    const failure = { schema: CLAUDE_CORRECTION_COLLECTION_SCHEMA, status: "degraded", issueCode: "collector_failed" };
    (failOpen ? io.stdout : io.stderr).write(`${JSON.stringify(failure)}\n`);
    return failOpen ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "collect-pi") {
    process.exitCode = await runIkbRecallPiCli(args, process);
  } else if (args[0] === "collect-claude") {
    process.exitCode = await runIkbRecallClaudeCli(args, process);
  } else if (args[0] === "collect-v2" || args[0] === "activate-v2") {
    process.exitCode = runIkbRecallV2Cli(args, process);
  } else {
    process.exitCode = runIkbRecallCli(args, process);
  }
}
