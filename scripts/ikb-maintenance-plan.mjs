/**
 * Pure maintenance dependency graph.
 *
 * This module must not read/write IKB state, invoke the CLI, or call external
 * connectors. Keeping the plan pure lets it be tested independently from the
 * runner and keeps historical evaluation repair out of knowledge maintenance.
 */
export function maintenanceSteps(mode = "source-sync") {
  const canonicalMode = mode === "daily" ? "source-sync" : mode === "weekly" ? "weekly-housekeeping" : mode;
  if (canonicalMode === "source-sync") {
    return [
      { name: "home-init", dependsOn: [] },
      { name: "local-memory-sync", dependsOn: ["home-init"] },
      { name: "registered-files-sync", dependsOn: ["home-init"] },
      { name: "source-history-sync", dependsOn: ["home-init"] },
      { name: "inbox-refresh", dependsOn: ["local-memory-sync", "registered-files-sync", "source-history-sync"] },
      { name: "final-receipt", dependsOn: ["inbox-refresh"] },
    ];
  }
  if (canonicalMode === "semantic-maintenance") {
    return [
      { name: "inbox-select", dependsOn: [] },
      { name: "knowledge-decisions", dependsOn: ["inbox-select"] },
      { name: "final-receipt", dependsOn: ["knowledge-decisions"] },
    ];
  }
  if (canonicalMode === "weekly-housekeeping") {
    return [
      { name: "source-coverage", dependsOn: [] },
      { name: "housekeeping-snapshot", dependsOn: ["source-coverage"] },
      { name: "final-receipt", dependsOn: ["housekeeping-snapshot"] },
    ];
  }
  throw new Error(`Unsupported maintenance mode: ${mode}`);
}

/** Read-only compatibility graph for historical Runs. It is not scheduled. */
export function legacyMaintenanceSteps(mode = "daily") {
  const catpawMemoryRoot = process.env.IKB_CATPAW_MEMORY_ROOT ?? `${process.env.HOME ?? "/Users/htwu"}/.catpaw/memory`;
  const boundedFrom = process.env.IKB_MAINTENANCE_HISTORY_FROM;
  const boundedTo = process.env.IKB_MAINTENANCE_HISTORY_TO;
  const agentTeamSessionRoots = process.env.IKB_AGENT_TEAM_SESSION_ROOTS;
  const agentTeamFrom = process.env.IKB_AGENT_TEAM_MONITOR_FROM;
  const agentTeamTo = process.env.IKB_AGENT_TEAM_MONITOR_TO;
  const citadelLimit = process.env.IKB_MAINTENANCE_CITADEL_LIMIT ?? "10";
  const citadelDelayMs = process.env.IKB_MAINTENANCE_CITADEL_DELAY_MS ?? "30000";
  const citadelDryRun = process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN === "true";
  const historyBounds = [
    ...(boundedFrom ? ["--from", boundedFrom] : []),
    ...(boundedTo ? ["--to", boundedTo] : []),
  ];
  const steps = [
    { name: "home-init", args: ["init"], dependsOn: [] },
    { name: "local-memory-sync", args: ["source", "sync-files", catpawMemoryRoot, "--adapter", "catpaw-memory-local", "--kind", "manual", "--extensions", "md", "--exclude", "archive,specx,openspec", "--scope", "work", "--limit", "0"], dependsOn: ["home-init"] },
    { name: "registered-files-sync", args: ["source", "sync-targets"], dependsOn: ["local-memory-sync"] },
    { name: "source-ingest", args: ["source", "ingest-history", "--adapter", "all", "--scope", "work", "--limit", "0", "--incremental", "--summary", ...historyBounds], dependsOn: ["registered-files-sync"] },
    { name: "agent-team-observe", args: ["harness", "agent-team", "collect", "--fail-open", ...(agentTeamSessionRoots ? ["--sessions-root", agentTeamSessionRoots] : []), ...(agentTeamFrom ? ["--from", agentTeamFrom] : []), ...(agentTeamTo ? ["--to", agentTeamTo] : [])], dependsOn: ["source-ingest"] },
    { name: "source-raw-dedup", args: ["source", "compact-raw"], dependsOn: ["agent-team-observe"] },
    { name: "experience-triage", args: ["experience", "triage", "--adapter", "all", "--scope", "work", "--limit", "0"], dependsOn: ["source-raw-dedup"] },
    { name: "experience-analysis-queue", args: ["experience", "queue", "--scope", "work", "--limit", "100"], dependsOn: ["experience-triage"] },
    { name: "candidate-discover", args: ["candidate", "discover-all", "--scope", "work"], dependsOn: ["experience-analysis-queue"] },
    { name: "candidate-resolve", args: ["candidate", "resolve-all", "--scope", "work", "--limit", citadelLimit, "--delay-ms", citadelDelayMs, ...(citadelDryRun ? ["--dry-run"] : [])], dependsOn: ["candidate-discover"] },
    { name: "source-coverage", args: ["source", "coverage", "--scope", "work", "--write"], dependsOn: ["candidate-resolve"] },
    { name: "people-rebuild", args: ["people", "rebuild", "--scope", "work", "--limit", "500", "--summary"], dependsOn: ["source-coverage"] },
    { name: "people-readiness", args: ["people", "readiness", "--scope", "work", "--mode", mode === "weekly" ? "weekly" : "incremental", "--write"], dependsOn: ["people-rebuild"] },
    { name: "knowledge-rebuild", args: ["knowledge", "rebuild", "--scope", "work"], dependsOn: ["people-readiness"] },
    { name: "knowledge-archive", args: ["knowledge", "archive", "--scope", "work"], dependsOn: ["knowledge-rebuild"] },
    { name: "knowledge-lint", args: ["knowledge", "lint", "--scope", "work"], dependsOn: ["knowledge-archive"] },
    { name: "reasoning", args: ["reasoning", "run", "--scope", "work"], dependsOn: ["knowledge-lint"] },
    { name: "doctor", args: ["doctor", "--write-summary", "--compact"], dependsOn: ["reasoning"] },
    { name: "ledger", args: ["ledger", "verify", "--write-summary"], dependsOn: ["doctor"] },
    { name: "report", args: ["report", "daily", "--format", "md"], dependsOn: ["ledger"], noJson: true },
  ];
  if (mode === "weekly") {
    steps.push({ name: "weekly-report", args: ["report", "weekly", "--format", "md"], dependsOn: ["report"], noJson: true });
    steps.push({ name: "experience-cluster", args: ["experience", "cluster", "--scope", "work", "--min-samples", "3"], dependsOn: ["weekly-report"] });
    steps.push({ name: "outer-patterns", args: ["harness", "patterns", "--min-samples", "3"], dependsOn: ["experience-cluster"] });
  }
  return steps;
}
