import { join, resolve } from "node:path";
import { LedgerStore } from "./store.ts";
import { printValue } from "./format.ts";
import { handleApproval, handleArtifact, handleRun, handleShow, handleTask, handleTimeline } from "./commands/control.ts";
import { handleAgent, handleGate, handleLoop } from "./commands/catalog.ts";
import { handleHarness } from "./commands/harness-eval.ts";
import { handleExperience, handleReasoning } from "./commands/analysis.ts";
import { handleObserveReport } from "./commands/observation.ts";
import { handleSource } from "./commands/source-intake.ts";
import { handleCandidate } from "./commands/candidate.ts";
import { handlePeople } from "./commands/people.ts";
import { handleCapture, handleContext, handleIngest, handleKnowledge, handleReview, handleSearch } from "./commands/knowledge.ts";
import { handleBackup, handleDoctor, handleLedger, handleReport, handleRestore, handleStatus, initializeHome } from "./commands/system.ts";
import { outputFormat, parseArgs, requiredArg } from "./commands/shared.ts";

const HELP = `ikb - personal knowledge work operating system

Usage:
  ikb init [--home <path>]
  ikb status [--output table|json]
  ikb show <task-or-run-id>
  ikb task add|list|show|update|start|wait|done|cancel
  ikb run start|list|show|follow|checkpoint|resume|retry|event|evaluate|finish|succeed|fail|cancel
  ikb agent list|show
  ikb gate list|show
  ikb loop list|show
  ikb harness suite list
  ikb harness eval [--case <case-id>] [--suite <suite-id>] [--run <run-id>|--task-dir <path>]
  ikb harness report --suite <suite-id> [--run <run-id>|--task-dir <path>] [--before <artifact-json>] [--after <artifact-json>]
  ikb harness repair [--suite <suite-id>] [--limit <n>]
  ikb harness patterns [--min-samples <n>]
  ikb experience triage|list|show|cluster|candidate-list|candidate-show
  ikb reasoning run|show [--scope personal|work]
  ikb observe daily|weekly
  ikb approval request|list|show|approve|reject
  ikb artifact add|list|show|open
  ikb capture <source-file|text> --title <title> [--scope personal|work] [--collection <name>] [--source-kind document|review_comment|manual] [--admission-reason <why>] [--applicability <when>] [--boundary <limits>] [--use-when <trigger>] [--use-inputs <items>] [--use-outputs <items>] [--use-steps <items>] [--use-checks <items>] [--use-stop-conditions <items>] [--confidence low|medium|high] [--confidence-basis <items>] [--temporal-state current|planned|historical|mixed|superseded|unknown] [--verification unverified|source_confirmed|task_validated|user_confirmed] [--identity-confidence low|medium|high] [--pattern-confidence low|medium|high] [--independent-episode-count <n>]
  ikb ingest <markdown-file> [--scope personal|work] [--collection <name>] [--source-kind document|review_comment] [--admission-reason <why>] [--applicability <when>] [--boundary <limits>]
  ikb source ingest <jsonl|markdown-file> --kind elephant|ai_conversation|document|review_comment|artifact|manual [--adapter <name>] [--scope personal|work] [--incremental|--no-incremental] [--source-key <key>]
  ikb source compact-raw [--scope personal|work] [--dry-run]
  ikb source discover [--adapter claude|codex|desk|elephant|all] [--root <path>] [--from <time>] [--to <time>] [--limit <n>]
  ikb source ingest-history [--adapter claude|codex|desk|elephant|all] [--scope personal|work] [--root <path>] [--from <time>] [--to <time>] [--limit <n>] [--include-tools] [--incremental|--no-incremental]
  ikb source ingest-citadel <content-id> [--scope personal|work] [--no-comments] [--incremental|--no-incremental]
  ikb source search-citadel --keyword <word> [--search-title] [--offset <n>] [--limit <n>] [--space-url <url>|--space-id <id>] [--parent-urls <urls>|--parent-ids <ids>] [--enqueue] [--source-id <id>] [--record-id <id>] [--scope personal|work]
  ikb source ingest-elephant [--uid|--gid|--pid|--name|--mis <target>] [--type chat|group|pub] [--keyword <word>] [--from <time>] [--to <time>] [--limit <n>] [--scope personal|work] [--incremental|--no-incremental]
  ikb candidate add --kind citadel_document|knowledge|person|external|pattern --title <title> --adapter <name> [--content-id <id>|--url <url>|--query <text>] [--source-id <id>] [--record-id <id>] [--scope personal|work]
  ikb candidate list [--scope personal|work] [--kind <kind>] [--status <status>]
  ikb candidate show <candidate-id>
  ikb candidate update <candidate-id> --status discovered|queued|ingested|rejected|blocked [--reason <text>] [--next-action <text>]
  ikb candidate discover <source-id> [--status discovered|queued] [--scope personal|work]
  ikb candidate discover-all [--scope personal|work]
  ikb candidate resolve <candidate-id> [--no-comments]
  ikb candidate resolve-all [--scope personal|work] [--limit <n>] [--delay-ms <n>] [--no-comments] [--dry-run]
  ikb source person [--name|--uid|--mis <speaker>] [--source-id <id>] [--from <time>] [--to <time>] [--context-window <n>] [--limit <n>] [--scope personal|work]
  ikb source list|show|context [--include-quarantined]
  ikb people list|add|update|remove|view|rebuild
  ikb search <query> [--scope personal|work]
  ikb context <task-id> [--run <run-id>] [--verified-only]
  ikb review [--scope personal|work]
  ikb knowledge list|show|verify|retire|archive|review|lint|skip|relate|rebuild|migrate
  ikb knowledge feedback <knowledge-id> --run <run-id> --outcome helpful|partial|incorrect|unused --reason-code <code> [--note <text>]
  ikb knowledge skip --title <title> --reason <why-no-knowledge> --source-id <id> [--record-id <id>] [--scope personal|work]
  ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts [--allow-cross-scope]
  ikb knowledge rebuild|migrate [--scope personal|work]
  ikb timeline <task-or-run-id>
  ikb doctor
  ikb backup
  ikb restore <backup-dir> --yes
  ikb ledger verify|rebuild
  ikb report daily|weekly [--format md|json]
  ikb report serve [--port <port>]

Global options:
  --home <path>       Override IKB_HOME (default: <project>/ikb-data)
  --output table|json  Select output format
  --json               Alias for --output json
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, ...args] = parsed.positionals;
  if (!command || command === "help" || command === "--help" || parsed.options.help) {
    console.log(HELP);
    return;
  }

  const projectRoot = process.env.IKB_PROJECT_ROOT ?? process.cwd();
  const home = resolve(String(parsed.options.home ?? process.env.IKB_HOME ?? join(projectRoot, "ikb-data")));
  if (command === "init") {
    const store = new LedgerStore({ home });
    try {
      initializeHome(home);
      printValue({ initialized: true, home, events: store.eventsPath }, outputFormat(parsed));
    } finally {
      store.close();
    }
    return;
  }

  const store = new LedgerStore({ home });
  try {
    switch (command) {
      case "status":
        handleStatus(store, home, parsed);
        break;
      case "show":
        handleShow(store, requiredArg([subcommand, ...args], 0, "task or run id"), parsed);
        break;
      case "task":
        handleTask(store, subcommand, args, parsed);
        break;
      case "run":
        handleRun(store, home, subcommand, args, parsed);
        break;
      case "agent":
      case "role":
        handleAgent(subcommand, args, parsed);
        break;
      case "gate":
        handleGate(subcommand, args, parsed);
        break;
      case "loop":
        handleLoop(subcommand, args, parsed);
        break;
      case "harness":
        handleHarness(store, subcommand, args, parsed);
        break;
      case "experience":
        handleExperience(store, home, subcommand, args, parsed);
        break;
      case "reasoning":
        handleReasoning(store, home, subcommand, parsed);
        break;
      case "observe":
        handleObserveReport(store, subcommand, args, parsed);
        break;
      case "approval":
        handleApproval(store, subcommand, args, parsed);
        break;
      case "artifact":
        handleArtifact(store, subcommand, args, parsed);
        break;
      case "capture":
        handleCapture(store, home, subcommand, args, parsed);
        break;
      case "ingest":
        handleIngest(store, home, subcommand, parsed);
        break;
      case "source":
        handleSource(store, home, subcommand, args, parsed);
        break;
      case "candidate":
        handleCandidate(store, home, subcommand, args, parsed);
        break;
      case "people":
        handlePeople(store, home, subcommand, args, parsed);
        break;
      case "search":
        handleSearch(home, [subcommand, ...args].filter(Boolean).join(" "), parsed);
        break;
      case "context":
        handleContext(store, home, subcommand, parsed);
        break;
      case "review":
        handleReview(home, parsed);
        break;
      case "knowledge":
        handleKnowledge(store, home, subcommand, args, parsed);
        break;
      case "timeline":
        handleTimeline(store, subcommand, parsed);
        break;
      case "doctor":
        handleDoctor(store, home, parsed);
        break;
      case "backup":
        handleBackup(store, home, parsed);
        break;
      case "restore":
        handleRestore(store, home, subcommand, parsed);
        break;
      case "ledger":
        handleLedger(store, subcommand, parsed);
        break;
      case "report":
        handleReport(store, home, subcommand, parsed);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`ikb: ${(error as Error).message}`);
  process.exitCode = 1;
});
