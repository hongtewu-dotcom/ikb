/**
 * Pure maintenance dependency graph.
 *
 * This module must not read/write IKB state, invoke the CLI, or call external
 * connectors. Keeping the plan pure lets it be tested independently from the
 * runner and keeps historical evaluation repair out of knowledge maintenance.
 */
export function maintenanceSteps(mode = "daily") {
  const boundedFrom = process.env.IKB_MAINTENANCE_HISTORY_FROM;
  const boundedTo = process.env.IKB_MAINTENANCE_HISTORY_TO;
  const citadelLimit = process.env.IKB_MAINTENANCE_CITADEL_LIMIT ?? "10";
  const citadelDelayMs = process.env.IKB_MAINTENANCE_CITADEL_DELAY_MS ?? "2000";
  const citadelDryRun = process.env.IKB_MAINTENANCE_CITADEL_DRY_RUN === "true";
  const historyBounds = [
    ...(boundedFrom ? ["--from", boundedFrom] : []),
    ...(boundedTo ? ["--to", boundedTo] : []),
  ];
  const steps = [
    { name: "home-init", args: ["init"], dependsOn: [] },
    { name: "source-ingest", args: ["source", "ingest-history", "--adapter", "all", "--scope", "work", "--limit", "0", "--incremental", ...historyBounds], dependsOn: ["home-init"] },
    { name: "source-raw-dedup", args: ["source", "compact-raw"], dependsOn: ["source-ingest"] },
    { name: "experience-triage", args: ["experience", "triage", "--adapter", "all", "--scope", "work", "--limit", "500"], dependsOn: ["source-raw-dedup"] },
    { name: "candidate-discover", args: ["candidate", "discover-all", "--scope", "work"], dependsOn: ["experience-triage"] },
    { name: "candidate-resolve", args: ["candidate", "resolve-all", "--scope", "work", "--limit", citadelLimit, "--delay-ms", citadelDelayMs, ...(citadelDryRun ? ["--dry-run"] : [])], dependsOn: ["candidate-discover"] },
    { name: "people-rebuild", args: ["people", "rebuild", "--scope", "work", "--limit", "500"], dependsOn: ["candidate-resolve"] },
    { name: "knowledge-rebuild", args: ["knowledge", "rebuild", "--scope", "work"], dependsOn: ["people-rebuild"] },
    { name: "knowledge-archive", args: ["knowledge", "archive", "--scope", "work"], dependsOn: ["knowledge-rebuild"] },
    { name: "knowledge-lint", args: ["knowledge", "lint", "--scope", "work"], dependsOn: ["knowledge-archive"] },
    { name: "reasoning", args: ["reasoning", "run", "--scope", "work"], dependsOn: ["knowledge-lint"] },
    { name: "doctor", args: ["doctor"], dependsOn: ["reasoning"] },
    { name: "ledger", args: ["ledger", "verify"], dependsOn: ["doctor"] },
    { name: "report", args: ["report", "daily", "--format", "md"], dependsOn: ["ledger"], noJson: true },
  ];
  if (mode === "weekly") {
    steps.push({ name: "weekly-report", args: ["report", "weekly", "--format", "md"], dependsOn: ["report"], noJson: true });
    steps.push({ name: "experience-cluster", args: ["experience", "cluster", "--scope", "work", "--min-samples", "3"], dependsOn: ["weekly-report"] });
    steps.push({ name: "outer-patterns", args: ["harness", "patterns", "--min-samples", "3"], dependsOn: ["experience-cluster"] });
  }
  return steps;
}
