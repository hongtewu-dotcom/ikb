import type { EventRecord, Run } from "./types.ts";
import { buildRunQualityProjection, type RunQualityProjection } from "./run-quality.ts";
import { buildImprovementCandidates, extractFailureObservations, type ImprovementCandidate, type OuterScope } from "./outer-loop.ts";
import type { LedgerStore } from "./store.ts";

export type ReportPeriod = "daily" | "weekly";

export interface RunObservation {
  runId: string;
  taskId: string;
  terminalState: string;
  qualityState: RunQualityProjection["quality"]["qualityState"];
  verifierResult: string;
  evaluationResult: string;
  evaluationTotalCases: number;
  evaluationPassedCases: number;
  evaluationFailedCases: number;
  evaluationEnvironmentFailures: number;
  firstPass: boolean | null;
  finalPass: boolean | null;
  retryRounds: number;
  repairRounds: number;
  recoverySucceeded: boolean | null;
  eventCount: number;
  passGateCount: number;
  artifactLinkCount: number;
}

export interface ObservabilityReport {
  version: "ikb-observability-report.v1";
  period: ReportPeriod;
  from: string;
  to: string;
  runs: {
    total: number;
    terminal: Record<string, number>;
    quality: Record<string, number>;
    evaluation: {
      eligible: number;
      assessed: number;
      environmentFailures: number;
      coverageRate: number;
      qualityPassed: number;
      qualityPassRate: number;
      firstPass: number;
      firstPassRate: number;
      finalPass: number;
      finalPassRate: number;
      recoveryAttempts: number;
      recoverySucceeded: number;
      recoverySuccessRate: number;
      averageRepairRounds: number;
    };
    observations: RunObservation[];
  };
  knowledgeUsage: {
    references: number;
    distinctKnowledge: number;
    feedback: Record<string, number>;
    feedbackByReason: Record<string, number>;
  };
  failures: {
    observations: number;
    byReason: Record<string, number>;
  };
  outer: {
    candidates: ImprovementCandidate[];
  };
}

/**
 * Build a local observability report from the Ledger.
 *
 * This report is computed directly from the local Ledger. The Ledger, Source,
 * Artifact and Knowledge stores remain the source of truth. The resulting
 * report is safe to export because it contains only enum/count data and
 * stable IDs, not source or knowledge bodies.
 */
export function buildObservabilityReport(store: LedgerStore, period: ReportPeriod, now = new Date()): ObservabilityReport {
  const to = now.toISOString();
  const windowMilliseconds = period === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const fromDate = new Date(now.getTime() - windowMilliseconds);
  const from = fromDate.toISOString();
  const allEvents = store.listEvents();
  const runs = store.listRuns({}).filter((run) => inWindow(run.finishedAt ?? run.startedAt, from, to));
  const runIds = new Set(runs.map((run) => run.id));
  const observations = runs.map((run) => toObservation(run, store, allEvents));
  const terminal = countBy(observations, (item) => item.terminalState);
  const quality = countBy(observations, (item) => item.qualityState);
  const evaluation = evaluationMetrics(observations);

  const knowledgeReferences = allEvents.filter((event) => event.eventType === "knowledge.referenced"
    && inWindow(event.occurredAt, from, to)
    && (!event.payload.runId || runIds.has(String(event.payload.runId))));
  const feedbackEvents = allEvents.filter((event) => event.eventType === "knowledge.feedback_recorded"
    && inWindow(event.occurredAt, from, to)
    && (!event.payload.runId || runIds.has(String(event.payload.runId))));
  const feedback = countBy(feedbackEvents, (event) => stringValue(event.payload.outcome) ?? "unknown");
  const feedbackByReason = countBy(feedbackEvents, (event) => stringValue(event.payload.reasonCode) ?? "unknown");

  const scopeByRun = new Map(store.listRuns({}).map((run) => {
    const scope = store.requireTask(run.taskId).scope;
    return [run.id, scope === "personal" || scope === "work" ? scope : "unknown"] as [string, OuterScope];
  }));
  const observationsInWindow = extractFailureObservations(allEvents, scopeByRun)
    .filter((item) => runIds.has(item.runId) || inWindow(eventTimeFor(item.eventId, allEvents), from, to));
  const byReason = countBy(observationsInWindow, (item) => item.reasonCode);
  const outerCandidates = buildImprovementCandidates(observationsInWindow, 3);

  return {
    version: "ikb-observability-report.v1",
    period,
    from,
    to,
    runs: { total: observations.length, terminal, quality, evaluation, observations },
    knowledgeUsage: {
      references: knowledgeReferences.length,
      distinctKnowledge: new Set(knowledgeReferences.map((event) => event.aggregateId)).size,
      feedback,
      feedbackByReason,
    },
    failures: { observations: observationsInWindow.length, byReason },
    outer: { candidates: outerCandidates },
  };
}

function toObservation(run: Run, store: LedgerStore, events: EventRecord[]): RunObservation {
  const task = store.requireTask(run.taskId);
  const scope = task.scope === "personal" || task.scope === "work" ? task.scope : "unknown";
  const projection = buildRunQualityProjection(run, events, scope);
  return {
    runId: run.id,
    taskId: run.taskId,
    terminalState: projection.quality.terminalState,
    qualityState: projection.quality.qualityState,
    verifierResult: projection.quality.verifierResult,
    evaluationResult: projection.quality.evaluationResult,
    evaluationTotalCases: projection.quality.evaluationTotalCases,
    evaluationPassedCases: projection.quality.evaluationPassedCases,
    evaluationFailedCases: projection.quality.evaluationFailedCases,
    evaluationEnvironmentFailures: projection.quality.evaluationEnvironmentFailures,
    firstPass: projection.quality.firstPass,
    finalPass: projection.quality.finalPass,
    retryRounds: projection.quality.retryRounds,
    repairRounds: projection.quality.repairRounds,
    recoverySucceeded: projection.quality.recoverySucceeded,
    eventCount: projection.quality.eventCount,
    passGateCount: projection.quality.passGateCount,
    artifactLinkCount: projection.quality.artifactLinkCount,
  };
}

function evaluationMetrics(observations: RunObservation[]): ObservabilityReport["runs"]["evaluation"] {
  const eligible = observations.filter((item) => ["succeeded", "failed", "canceled"].includes(item.terminalState));
  const assessed = eligible.filter((item) => item.evaluationResult !== "missing");
  const environmentFailures = eligible.reduce((total, item) => total + item.evaluationEnvironmentFailures, 0);
  const qualityPassed = assessed.filter((item) => item.qualityState === "pass").length;
  const firstPass = assessed.filter((item) => item.firstPass === true).length;
  const finalPass = assessed.filter((item) => item.finalPass === true).length;
  const recoveryAttempts = assessed.filter((item) => item.retryRounds > 0).length;
  const recoverySucceeded = assessed.filter((item) => item.retryRounds > 0 && item.recoverySucceeded === true).length;
  const repairRounds = assessed.reduce((total, item) => total + item.repairRounds, 0);
  return {
    eligible: eligible.length,
    assessed: assessed.length,
    environmentFailures,
    coverageRate: ratio(assessed.length, eligible.length),
    qualityPassed,
    qualityPassRate: ratio(qualityPassed, assessed.length),
    firstPass,
    firstPassRate: ratio(firstPass, assessed.length),
    finalPass,
    finalPassRate: ratio(finalPass, assessed.length),
    recoveryAttempts,
    recoverySucceeded,
    recoverySuccessRate: ratio(recoverySucceeded, recoveryAttempts),
    averageRepairRounds: assessed.length === 0 ? 0 : Number((repairRounds / assessed.length).toFixed(4)),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    const value = key(item);
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function inWindow(value: string | null | undefined, from: string, to: string): boolean {
  return typeof value === "string" && value >= from && value <= to;
}

function eventTimeFor(eventId: string, events: EventRecord[]): string | null {
  return events.find((event) => event.eventId === eventId)?.occurredAt ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
