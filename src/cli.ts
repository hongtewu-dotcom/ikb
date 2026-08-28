import { join, resolve } from "node:path";
import { LedgerStore } from "./store.ts";
import { printValue } from "./format.ts";
import { handleApproval, handleArtifact, handleRun, handleShow, handleTask, handleTimeline } from "./commands/control.ts";
import { handleAgent, handleGate, handleLoop } from "./commands/catalog.ts";
import { handleHarness } from "./commands/harness-eval.ts";
import { handleExperience, handleReasoning } from "./commands/analysis.ts";
import { handleExtraction } from "./commands/extraction.ts";
import { handleObserveReport } from "./commands/observation.ts";
import { handleSource } from "./commands/source-intake.ts";
import { handleCandidate } from "./commands/candidate.ts";
import { handlePeople } from "./commands/people.ts";
import { handleCapture, handleContext, handleIngest, handleKnowledge, handleReview, handleSearch } from "./commands/knowledge.ts";
import { handlePublish } from "./commands/publication.ts";
import { handleBackup, handleDoctor, handleHealth, handleLedger, handleReport, handleRestore, handleStatus, handleStorage, initializeHome } from "./commands/system.ts";
import { outputFormat, parseArgs, requiredArg } from "./commands/shared.ts";
import { handleFeedback, handleRemember, handleUse } from "./commands/agent-facade.ts";
import { handleMaintenance } from "./commands/maintenance.ts";

const PUBLIC_HELP = `ikb - Agent knowledge facade

Usage:
  ikb remember <path|url|text> --scope personal|work
  ikb use --goal <goal> --accept <acceptance> --scope personal|work
  ikb feedback <usage-id> --outcome helpful|partial|incorrect|unused [--result <path>]

Global options:
  --home <path>        Override IKB_HOME (default: <project>/ikb-data)
  --output table|json  Select output format
  --json               Alias for --output json

Internal compatibility and maintenance commands:
  ikb --help --all
`;

const INTERNAL_HELP = `ikb - internal compatibility and maintenance commands

Usage:
  ikb init [--home <path>]
  ikb status [--output table|json]
  ikb health [--output table|json]
  ikb show <task-or-run-id>
  ikb task add|list|show|update|start|wait|done|cancel
  ikb run start|list|show|follow|plan|checkpoint|resume|retry|event|evaluate|finish|succeed|fail|cancel
  ikb agent list|show
  ikb gate list|show
  ikb loop list|show
  ikb harness suite list
  ikb harness eval [--case <case-id>] [--suite <suite-id>] [--run <run-id>|--task-dir <path>]
  ikb harness report --suite <suite-id> [--run <run-id>|--task-dir <path>] [--before <artifact-json>] [--after <artifact-json>]
  ikb harness repair [--suite <suite-id>] [--limit <n>]
  ikb harness patterns [--min-samples <n>]
  ikb harness campaign --manifest <json> --observations <json> [--report-dir <path>]
  ikb harness agent-team collect [--sessions-root <dir[,dir]>] [--from <time>] [--to <time>] [--fail-open]
  ikb harness agent-team campaign --manifest <json> --samples <json> [--sessions-root <dir[,dir]>]
  ikb experience triage|list|show|context|queue|analyze|analysis-list|analysis-show|validate|cluster|candidate-list|candidate-show|candidate-review|candidate-review-show|candidate-decide
  ikb experience context <experience-id> [--run <run-id>] [--limit <1-500>]
  ikb experience analyze <experience-id> --file <analysis.json>
  ikb experience validate <experience-id> --result pass|fail --method <how> --note <conclusion> --artifact <artifact-id>
  ikb experience candidate-review <candidate-id> [--draft <artifact-id>] --validation <artifact-id-or-comma-list> --guide <artifact-id> [--primary <knowledge-id>]
  ikb experience candidate-review-show <candidate-id>
  ikb experience candidate-decide <candidate-id> --decision accept|reject --reason <plain-language-reason> [--file <complete-reviewed-knowledge.md>]
  ikb extraction inventory <source-file> --source-id <source-id> [--file <inventory.json>]
  ikb extraction validate|verify <results.json> --manifest <benchmark-manifest.json> [--file <report.json>]
  ikb extraction render <results.json> --manifest <benchmark-manifest.json> --directory <path>
  ikb extraction product-view <results.json> --case-id <case-id> --product-id <product-id> [--file <knowledge-body.md>]
  ikb reasoning run|show [--scope personal|work]
  ikb observe daily|weekly|dashboard
  ikb approval request|list|show|approve|reject
  ikb artifact add|list|show|open
  ikb capture <source-file|text> --title <title> [--scope personal|work] [--collection <name>] [--source-kind document|review_comment|manual] [--quality-version <n>] [--product-type <type>] [--canonical-key <key>] [--compilation-schema <schema>] [--compilation-case-id <case>] [--compilation-product-id <product>] [--extraction-manifest-ref <artifact>] [--compilation-ref <artifact>] [--information-loss-ref <artifact>] [--fact-refs <ids>] [--questions-answered <items>] [--admission-reason <why>] [--applicability <when>] [--boundary <limits>] [--use-when <trigger>] [--use-inputs <items>] [--use-outputs <items>] [--use-steps <items>] [--use-checks <items>] [--use-stop-conditions <items>] [--confidence low|medium|high] [--confidence-basis <items>] [--temporal-state current|planned|historical|mixed|superseded|unknown] [--verification unverified|source_confirmed|task_validated|user_confirmed] [--identity-confidence low|medium|high] [--pattern-confidence low|medium|high] [--independent-episode-count <n>] [--independent-source-count <n>] [--distinct-date-count <n>] [--counterevidence-refs <refs>] [--counterevidence-search <scope>] [--do-not-use-for <items>]
  ikb ingest <markdown-file> [--scope personal|work] [--collection <name>] [--source-kind document|review_comment] [--admission-reason <why>] [--applicability <when>] [--boundary <limits>]
  ikb source ingest <jsonl|markdown-file> --kind elephant|ai_conversation|document|review_comment|artifact|manual [--adapter <name>] [--scope personal|work] [--incremental|--no-incremental] [--source-key <key>]
  ikb source compact-raw [--scope personal|work] [--dry-run]
  ikb source externalize-history-raw [--scope personal|work] [--dry-run]
  ikb source discover [--adapter claude|codex|desk|elephant|all] [--root <path>] [--from <time>] [--to <time>] [--limit <n>]
  ikb source ingest-history [--adapter claude|codex|desk|elephant|all] [--scope personal|work] [--root <path>] [--from <time>] [--to <time>] [--limit <n>] [--include-tools] [--summary] [--incremental|--no-incremental]
  ikb source sync-files <directory> --adapter <name> --kind document|review_comment|manual [--extensions md,txt] [--exclude archive,tmp] [--scope personal|work] [--limit <n>]
  ikb source target-list [--scope personal|work]
  ikb source sync-targets [--scope personal|work]
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
  ikb source lookup <title|url|alias> [--scope personal|work] [--include-quarantined] [--all-versions] [--limit <1-100>]
  ikb source receipt <source-id>
  ikb source alias-add <source-id> --alias <name[,name...]>
  ikb source alias-list [source-id]
  ikb source reference-lint --manifest <json> [--write]
  ikb source coverage [--scope personal|work] [--write]
  ikb people list|add|update|remove|view|rebuild [--summary]
  ikb people readiness [--scope personal|work] [--mode weekly|incremental] [--write]
  ikb people checkpoint <person-id> --artifact <path> --disposition evidence_only|no_change|candidates_produced [--views <items>] [--counterevidence-search <range>]
  ikb search <query> [--scope personal|work] [--status draft|verified] [--limit <1-50>]
  ikb context <task-id> [--run <run-id>] [--scope personal|work] [--limit <1-50>] [--verified-only]
  ikb review [--scope personal|work]
  ikb knowledge list|show|verify|retire|archive|review|lint|skip|relate|rebuild|migrate|use|usage-status|feedback|correction-request|principle-request|principle-projection-check|apply-candidate|revision-list|revision-show|revision-recover|qv5-revise|qv5-resolve-hold|qv5-batch
  ikb knowledge use <knowledge-id> --run <run-id> --artifact <artifact-id> --purpose decision|paragraph|check|action|code|review|other --note <how-it-was-used>
  ikb knowledge usage-status --run <run-id>
  ikb knowledge feedback <knowledge-id> --run <run-id> --outcome helpful|partial|incorrect|unused --reason-code <code> [--note <text>] [--evidence <artifact-id>] [--review-finding incorrect]
  ikb knowledge correction-request <knowledge-id> --run <run-id> --artifact <artifact-id> --action revise|retire --reason <text>
  ikb knowledge principle-request --run <run-id> --manifest-artifact <id> --compilation-artifact <id> --fidelity-artifact <id> --case <case-id> --product <product-id>
  ikb knowledge principle-projection-check --manifest <json> [--write]
  ikb knowledge skip --title <title> --reason <why-no-knowledge> --source-id <id> [--record-id <id>] [--scope personal|work]
  ikb knowledge relate <from-id> <to-id> --type related|derived_from|contradicts [--allow-cross-scope]
  ikb knowledge apply-candidate <candidate-id> --file <complete-reviewed-draft.md> [--primary <knowledge-id>]
  ikb knowledge revision-list|revision-show|revision-recover [<revision-id>]
  ikb knowledge qv5-revise <knowledge-id> --replacement-artifact <id> --validation-artifact <id> --manifest-artifact <id> --compilation-artifact <id> --fidelity-artifact <id>
  ikb knowledge qv5-resolve-hold <candidate-id> --revision <revision-id>
  ikb knowledge qv5-batch --plan <json> [--dry-run] [--resume] [--limit <1..500>]
  ikb knowledge memory-topic-audit --index <MEMORY.md> [--write]
  ikb knowledge memory-topic-sync --index <MEMORY.md> --run <run-id> [--offset <n>] [--limit <1..3>]
  ikb knowledge memory-topic-revise --index <MEMORY.md> --analyst-run <run-id> --curator-run <run-id> [--offset <n>] [--limit <1..3>]
  ikb knowledge rebuild|migrate [--scope personal|work]
  ikb publish build [--channel personal-github|daily-copilot] [--knowledge-id <id-or-comma-list>] [--migration-manifest <path>]
  ikb timeline <task-or-run-id>
  ikb doctor [--write-summary] [--compact]
  ikb backup [--full]
  ikb restore <backup-dir> --yes
  ikb ledger verify|rebuild [--write-summary]
  ikb storage audit|migrate-layout
  ikb storage relocate --from <old-project-root> --to <current-project-root>
  ikb maintenance refresh-inbox|semantic-select|semantic-apply|write-receipt|weekly-snapshot|principle-conflict-scan
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
    console.log(parsed.options.all === true ? INTERNAL_HELP : PUBLIC_HELP);
    return;
  }

  const projectRoot = process.env.IKB_PROJECT_ROOT ?? process.cwd();
  const home = resolve(String(parsed.options.home ?? process.env.IKB_HOME ?? join(projectRoot, "ikb-data")));
  if (command === "init") {
    initializeHome(home);
    const store = new LedgerStore({ home });
    try {
      printValue({ initialized: true, home, events: store.eventsPath }, outputFormat(parsed));
    } finally {
      store.close();
    }
    return;
  }

  const store = new LedgerStore({ home });
  try {
    switch (command) {
      case "remember":
        handleRemember(store, home, subcommand, parsed);
        break;
      case "use":
        handleUse(store, home, parsed);
        break;
      case "feedback":
        handleFeedback(store, home, subcommand, parsed);
        break;
      case "maintenance":
        handleMaintenance(store, home, subcommand, parsed);
        break;
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
      case "extraction":
        handleExtraction(subcommand, args, parsed);
        break;
      case "reasoning":
        handleReasoning(store, home, subcommand, parsed);
        break;
      case "observe":
        handleObserveReport(store, home, subcommand, args, parsed);
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
        handleSearch(store, home, [subcommand, ...args].filter(Boolean).join(" "), parsed);
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
      case "publish":
        handlePublish(store, home, subcommand, args, parsed);
        break;
      case "timeline":
        handleTimeline(store, subcommand, parsed);
        break;
      case "doctor":
        handleDoctor(store, home, parsed);
        break;
      case "health":
        handleHealth(home, parsed);
        break;
      case "backup":
        handleBackup(store, home, parsed);
        break;
      case "restore":
        handleRestore(store, home, subcommand, parsed);
        break;
      case "ledger":
        handleLedger(store, home, subcommand, parsed);
        break;
      case "storage":
        handleStorage(store, home, subcommand, parsed);
        break;
      case "report":
        handleReport(store, home, subcommand, parsed);
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${PUBLIC_HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`ikb: ${(error as Error).message}`);
  process.exitCode = 1;
});
