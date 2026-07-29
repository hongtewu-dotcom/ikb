import { existsSync, readFileSync } from "node:fs";
import { LedgerStore } from "../store.ts";
import { assertValue, printValue } from "../format.ts";
import { canonicalAgentId, validateAgentInvocation } from "../roles.ts";
import { finishRunAndAssess } from "../run-completion.ts";
import type { HarnessEventType } from "../../projects/eval-plane/src/harness-events.ts";
import { createDefaultEvalRegistry } from "../../projects/eval-plane/src/eval-registry.ts";
import { coordinateRunEvaluation } from "../../projects/eval-plane/src/evaluation-coordinator.ts";
import { IKB_RUN_QUALITY_SUITE_ID } from "../../projects/eval-plane/src/run-assessment.ts";
import { evalPlaneRoot } from "./evaluation.ts";
import {
  type ParsedArgs,
  optionalOption,
  outputFormat,
  pickOptions,
  requiredArg,
  requiredOption,
} from "./shared.ts";

export function handleTask(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "add": {
      const goal = requiredOption(parsed, "goal");
      const task = store.createTask({
        title: String(parsed.options.title ?? goal.slice(0, 72)),
        goal,
        acceptance: requiredOption(parsed, "accept", "acceptance"),
        type: optionalOption(parsed, "type"),
        priority: optionalOption(parsed, "priority"),
        risk: optionalOption(parsed, "risk"),
        scope: optionalOption(parsed, "scope"),
      });
      printValue(task, outputFormat(parsed));
      break;
    }
    case "list": {
      const tasks = store.listTasks({ status: optionalOption(parsed, "status"), type: optionalOption(parsed, "type") });
      printValue(tasks.map((task) => ({ id: task.id, status: task.status, type: task.type, priority: task.priority, title: task.title, updatedAt: task.updatedAt })), outputFormat(parsed));
      break;
    }
    case "show": {
      const task = store.requireTask(requiredArg(args, 0, "task id"));
      const value = { task, runs: store.listRuns({ taskId: task.id }), approvals: store.listApprovals({ taskId: task.id }), artifacts: store.listArtifacts({ taskId: task.id }), events: store.eventsFor(task.id) };
      printValue(value, outputFormat(parsed));
      break;
    }
    case "update": {
      const id = requiredArg(args, 0, "task id");
      const task = store.updateTask(id, pickOptions(parsed, ["title", "goal", "acceptance", "type", "priority", "risk", "scope"]));
      printValue(task, outputFormat(parsed));
      break;
    }
    case "start":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "active"), outputFormat(parsed));
      break;
    case "wait":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "waiting", requiredOption(parsed, "reason")), outputFormat(parsed));
      break;
    case "done":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "done", optionalOption(parsed, "reason"), optionalOption(parsed, "evidence")), outputFormat(parsed));
      break;
    case "cancel":
      printValue(store.transitionTask(requiredArg(args, 0, "task id"), "canceled", requiredOption(parsed, "reason")), outputFormat(parsed));
      break;
    default:
      throw new Error(`Unknown task action: ${action ?? ""}`);
  }
}

export function handleRun(store: LedgerStore, home: string, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "start": {
      const skill = optionalOption(parsed, "skill");
      const requestedAgent = String(parsed.options.agent ?? "ikb-operator");
      const taskId = requiredArg(args, 0, "task id");
      const task = store.requireTask(taskId);
      const invocation = validateAgentInvocation(requestedAgent, skill ? skill.split(",").filter(Boolean) : [], task.type);
      assertValue(invocation.ok, invocation.issues.join("; "));
      const run = store.createRun(taskId, invocation.agentId, invocation.skills);
      printValue(run, outputFormat(parsed));
      break;
    }
    case "list": {
      const runs = store.listRuns({ taskId: optionalOption(parsed, "task"), status: optionalOption(parsed, "status") });
      printValue(runs, outputFormat(parsed));
      break;
    }
    case "show":
    case "follow": {
      const run = store.requireRun(requiredArg(args, 0, "run id"));
      const value = { run, task: store.requireTask(run.taskId), approvals: store.listApprovals({ taskId: run.taskId }).filter((approval) => approval.runId === run.id), artifacts: store.listArtifacts({ runId: run.id }), events: store.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === run.id) };
      printValue(value, outputFormat(parsed));
      break;
    }
    case "checkpoint":
      printValue(store.checkpointRun(requiredArg(args, 0, "run id"), requiredOption(parsed, "step", "checkpoint")), outputFormat(parsed));
      break;
    case "event": {
      const runId = requiredArg(args, 0, "run id");
      const eventType = requiredOption(parsed, "type") as HarnessEventType;
      const payloadText = requiredOption(parsed, "payload");
      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        throw new Error(`--payload must be valid JSON: ${(error as Error).message}`);
      }
      printValue(store.recordHarnessEvent(runId, eventType, payload), outputFormat(parsed));
      break;
    }
    case "resume":
      printValue(store.resumeRun(requiredArg(args, 0, "run id")), outputFormat(parsed));
      break;
    case "retry": {
      const requestedAgent = optionalOption(parsed, "agent");
      let agent: string | undefined;
      if (requestedAgent) {
        const currentRun = store.requireRun(requiredArg(args, 0, "run id"));
        const task = store.requireTask(currentRun.taskId);
        const invocation = validateAgentInvocation(requestedAgent, [], task.type);
        assertValue(invocation.ok, invocation.issues.join("; "));
        agent = canonicalAgentId(requestedAgent);
      }
      printValue(store.retryRun(requiredArg(args, 0, "run id"), agent), outputFormat(parsed));
      break;
    }
    case "evaluate": {
      const runId = requiredArg(args, 0, "run id");
      const suiteId = optionalOption(parsed, "suite") ?? IKB_RUN_QUALITY_SUITE_ID;
      const result = coordinateRunEvaluation(store, createDefaultEvalRegistry(), runId, { projectRoot: evalPlaneRoot(), suiteId });
      printValue(result, outputFormat(parsed));
      break;
    }
    case "finish": {
      const status = requiredOption(parsed, "status");
      assertValue(["succeeded", "failed", "canceled"].includes(status), "--status must be succeeded, failed, or canceled");
      const run = finishRunAndAssess(store, requiredArg(args, 0, "run id"), status as "succeeded" | "failed" | "canceled", optionalOption(parsed, "summary"));
      printValue(run, outputFormat(parsed));
      break;
    }
    case "succeed": {
      const run = finishRunAndAssess(store, requiredArg(args, 0, "run id"), "succeeded", optionalOption(parsed, "summary"));
      printValue(run, outputFormat(parsed));
      break;
    }
    case "fail": {
      const run = finishRunAndAssess(store, requiredArg(args, 0, "run id"), "failed", requiredOption(parsed, "reason", "summary"));
      printValue(run, outputFormat(parsed));
      break;
    }
    case "cancel": {
      const run = finishRunAndAssess(store, requiredArg(args, 0, "run id"), "canceled", optionalOption(parsed, "reason"));
      printValue(run, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown run action: ${action ?? ""}`);
  }
}

export function handleApproval(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "request": {
      const payloadText = optionalOption(parsed, "payload");
      let payload: unknown = payloadText ?? {};
      if (payloadText) {
        try { payload = JSON.parse(payloadText); } catch { /* plain text payload is still hashable */ }
      }
      const approval = store.requestApproval({
        runId: requiredArg(args, 0, "run id"),
        action: requiredOption(parsed, "action"),
        target: requiredOption(parsed, "target"),
        payload,
        risk: optionalOption(parsed, "risk"),
      });
      printValue(approval, outputFormat(parsed));
      break;
    }
    case "list":
      printValue(store.listApprovals({ status: optionalOption(parsed, "status"), taskId: optionalOption(parsed, "task") }), outputFormat(parsed));
      break;
    case "show":
      printValue(store.requireApproval(requiredArg(args, 0, "approval id")), outputFormat(parsed));
      break;
    case "approve": {
      const approval = store.decideApproval(requiredArg(args, 0, "approval id"), "approved", optionalOption(parsed, "note"));
      printValue(approval, outputFormat(parsed));
      break;
    }
    case "reject": {
      const approval = store.decideApproval(requiredArg(args, 0, "approval id"), "rejected", requiredOption(parsed, "reason", "note"));
      printValue(approval, outputFormat(parsed));
      break;
    }
    default:
      throw new Error(`Unknown approval action: ${action ?? ""}`);
  }
}

export function handleArtifact(store: LedgerStore, action: string | undefined, args: string[], parsed: ParsedArgs): void {
  switch (action) {
    case "add":
      printValue(store.createArtifact({ runId: requiredArg(args, 0, "run id"), path: requiredOption(parsed, "path"), kind: optionalOption(parsed, "kind") ?? "file", label: optionalOption(parsed, "label") ?? requiredOption(parsed, "path") }), outputFormat(parsed));
      break;
    case "list":
      printValue(store.listArtifacts({ runId: requiredArg(args, 0, "run id"), taskId: optionalOption(parsed, "task") }), outputFormat(parsed));
      break;
    case "show":
      printValue(store.requireArtifact(requiredArg(args, 0, "artifact id")), outputFormat(parsed));
      break;
    case "open": {
      const artifact = store.requireArtifact(requiredArg(args, 0, "artifact id"));
      if (!existsSync(artifact.path)) throw new Error(`Artifact path does not exist: ${artifact.path}`);
      console.log(readFileSync(artifact.path, "utf8"));
      break;
    }
    default:
      throw new Error(`Unknown artifact action: ${action ?? ""}`);
  }
}

export function handleShow(store: LedgerStore, id: string, parsed: ParsedArgs): void {
  const task = store.getTask(id);
  if (task) {
    printValue({ task, runs: store.listRuns({ taskId: id }), approvals: store.listApprovals({ taskId: id }), artifacts: store.listArtifacts({ taskId: id }), events: store.eventsFor(id) }, outputFormat(parsed));
    return;
  }
  const run = store.getRun(id);
  if (run) {
    printValue({ run, task: store.requireTask(run.taskId), approvals: store.listApprovals({ taskId: run.taskId }).filter((approval) => approval.runId === run.id), artifacts: store.listArtifacts({ runId: run.id }), events: store.listEvents().filter((event) => event.aggregateType === "run" && event.aggregateId === id) }, outputFormat(parsed));
    return;
  }
  const approval = store.getApproval(id);
  if (approval) {
    printValue(approval, outputFormat(parsed));
    return;
  }
  const artifact = store.getArtifact(id);
  if (artifact) {
    printValue(artifact, outputFormat(parsed));
    return;
  }
  throw new Error(`No Task, Run, Approval or Artifact found for ${id}`);
}

export function handleTimeline(store: LedgerStore, id: string | undefined, parsed: ParsedArgs): void {
  assertValue(id, "Usage: ikb timeline <task-or-run-id>");
  const events = store.eventsFor(id);
  printValue(events.map((event) => ({ sequence: event.sequence, occurredAt: event.occurredAt, aggregate: `${event.aggregateType}:${event.aggregateId}`, event: event.eventType, actor: event.actor, eventId: event.eventId })), outputFormat(parsed));
}
