---
name: agent-team-feature
description: Use when implementation has two or more independently testable write scopes whose shared contracts can be frozen before work begins. Keep tightly coupled features and shared-file changes in the root agent.
---

# Disjoint Parallel Feature Work

Use native Codex workers only when parallel writing has a real integration benefit. The root parent owns decomposition, shared contracts, integration, and the final consumer check. Subagents inherit the root parent's model and reasoning settings by default.

## Freeze the feature boundary

Resolve the requested behavior, exclusions, final consumer, acceptance checks, and stop condition. Inspect only enough code to identify stable responsibilities, shared state, affected files, tests, and integration seams.

If the work is sequential, tightly coupled, or converges on shared files or one state owner, keep it local. A worktree does not make overlapping ownership independent.

Each candidate writer contract contains:

```text
goal: one independently testable outcome
scope: responsibility and relevant context
acceptance: affected tests and observable consumer behavior
handoff: status, evidence, changes, validation, and gaps
write_scope: exact files or modules owned by this worker
forbidden_scope: files and responsibilities it must not modify
depends_on: frozen inputs that must already exist
produces: artifacts or interfaces consumed during integration
```

## Writer Barrier

Open the Writer Barrier only when all of the following are true:

- scope, exclusions, acceptance, and final consumer are known;
- shared contracts are frozen and every shared file or state has one owner;
- writer `write_scope` values are disjoint and every `forbidden_scope` is explicit;
- each `depends_on` input exists and has been accepted;
- the root knows how it will integrate and test all `produces` outputs.

If any item is false, leave the barrier closed and work sequentially. Do not use more workers to compensate for unresolved ownership or architecture.

## Execute with native workers

Use `list_agents` and `followup_task` only when an idle worker can continue the same accepted responsibility with the same permission and write boundary. Otherwise use `spawn_agent` with the built-in `worker` role and `fork_turns: "none"`; the complete frozen writer contract is the child's input. Do not override model or reasoning settings during the base workflow; let them inherit.

Tell each worker that other workers may be active, it must preserve their changes, and it must stop at the edge of its declared write scope. Use `send_message` only for a correction inside the frozen contract, `wait_agent` at an actual integration dependency, and `interrupt_agent` for abandoned or unsafe work.

A wait returning does not prove completion. Treat a progress `MESSAGE` as activity, not a handoff; only `FINAL_ANSWER` or an observed completed status opens integration for that writer. Keep waiting while a completion-critical writer is active and do not duplicate its write or validation scope in the root.

## Integrate in the root

The root parent integrates after the relevant writers stop:

1. Inspect each diff against `write_scope`, `forbidden_scope`, and acceptance.
2. Resolve cross-stream seams through their existing owner; do not create a new shared owner.
3. Run affected tests, the build required by risk, and one check through the final consumer.
4. Report local checks, external synchronization, and runtime evidence separately.

Do not commit, push, deploy, publish, or trigger other external side effects unless that action is explicitly inside the user's scope. A worker's `completed` status is not integration acceptance.
