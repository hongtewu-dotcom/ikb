import type { WorkEventSubject } from "./work-run-subject.ts";

export const WORK_RUN_QUALITY_SUITE_ID = "work-run-quality";

const TERMINAL_QUALITY_TRIGGER_PATTERN = /^evaluation\.trigger_(?:completed|failed|skipped)$/;

export interface WorkQualityAttempt {
  verification: WorkEventSubject;
  trigger: WorkEventSubject | null;
}

export function workQualityHistory(events: WorkEventSubject[], runId: string): WorkQualityAttempt[] {
  const attempts: WorkQualityAttempt[] = [];
  const pendingByVerificationId = new Map<string, number[]>();
  const pendingLegacy: number[] = [];
  for (const event of events) {
    if (event.event === "task.verified") {
      const attemptIndex = attempts.push({ verification: event, trigger: null }) - 1;
      if (event.verificationId) {
        const pending = pendingByVerificationId.get(event.verificationId) ?? [];
        pending.push(attemptIndex);
        pendingByVerificationId.set(event.verificationId, pending);
      } else {
        pendingLegacy.push(attemptIndex);
      }
      continue;
    }
    if (!isWorkRunQualityTrigger(event, runId)) continue;
    const pending = event.verificationId
      ? pendingByVerificationId.get(event.verificationId)
      : pendingLegacy;
    const attemptIndex = pending?.shift();
    if (attemptIndex === undefined) continue;
    attempts[attemptIndex].trigger = event;
    if (event.verificationId && pending?.length === 0) pendingByVerificationId.delete(event.verificationId);
  }
  return attempts;
}

export function isWorkRunQualityTrigger(event: WorkEventSubject, runId: string): boolean {
  if (!TERMINAL_QUALITY_TRIGGER_PATTERN.test(event.event) || event.suiteId !== WORK_RUN_QUALITY_SUITE_ID) return false;
  return event.event === "evaluation.trigger_completed"
    ? event.evaluationRunId === runId
    : event.evaluationRunId === null || event.evaluationRunId === runId;
}
