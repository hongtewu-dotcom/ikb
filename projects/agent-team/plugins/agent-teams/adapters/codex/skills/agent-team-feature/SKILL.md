---
name: agent-team-feature
description: Use when implementation has two or more independently testable write scopes whose shared contracts can be frozen before work begins. Keep tightly coupled features and shared-file changes in the root agent.
---

# Disjoint Parallel Feature Work

Before the first delegation, resolve the host route using [model-policy.md](references/model-policy.md). Before the first join, read [wait-policy.md](references/wait-policy.md). Reuse these rules within the same task while the host and policy remain unchanged; do not reload them for each branch.


Use native Codex workers only when parallel writing has a real integration benefit. The root parent owns decomposition, shared contracts, integration, and the final consumer check. Resolve child models from the current host and model policy.

Root only: when using the optional delivery feedback, read the Start section of [delivery-receipt.md](references/delivery-receipt.md) and register before work. Children do not load or register it. Keep completion-record details until validation; feedback never gates execution.

## Freeze the feature boundary

Resolve the requested behavior, exclusions, final consumer, acceptance checks, and stop condition. Inspect only enough code to identify stable responsibilities, shared state, affected files, tests, and integration seams.

If the work is sequential, tightly coupled, or converges on shared files or one state owner, keep it local. A worktree does not make overlapping ownership independent. A whole repository/service is not a sufficient write scope: name exact files or a bounded submodule. Each writer owns one independently testable behavior, not a collection of unrelated features. Resolve uncertain interfaces and ownership in the root or a read-only exploration before opening the barrier; do not delegate “design and implement the whole requirement” to a writer.

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

Preserve applicable user restrictions verbatim in every writer, reviewer, and
integration request: exact validation commands/environment, who may run them,
forbidden writes (including generated caches), and external effects. Planner
summaries cannot weaken them. At integration, verify these restrictions alongside
functional results; report violations or missing evidence explicitly.

## Execute with native workers

Use `list_agents` and `followup_task` only when an idle worker can continue the same accepted responsibility with the same permission and write boundary. Do not append a new objective through followup_task; decompose it separately. Otherwise use `spawn_agent` with the built-in `worker` role and `fork_turns: "none"`; the complete frozen writer contract is the child's input. Use the verified host route subject to model-policy.md.

Tell each worker that other workers may be active, it must preserve their changes, and it must stop at the edge of its declared write scope. Within that boundary it may implement, run targeted validation, and repair failures caused by its own changes in one local cycle. Acceptance ends the task. A new goal, changed shared contract, expanded write scope, unauthorized effect, unrelated failure, or repeated failure without new evidence requires a return to the root, not autonomous expansion. Declare first_checkpoint only for high-risk (including funds/security/state ownership) or uncertain integration work; ordinary writers need no intermediate confirmation. Batch known related edits with native tools, then inspect the diff and validate before choosing further repairs. Use `send_message` only for a correction inside the frozen contract, `wait_agent` at an actual integration dependency, and `interrupt_agent` for abandoned or unsafe work.

A wait returning does not prove completion. Treat a progress `MESSAGE` as activity, not a handoff; only `FINAL_ANSWER` or an observed completed status opens integration for that writer. Keep waiting while a completion-critical writer is active and do not duplicate its write or validation scope in the root.

## Integrate in the root

The root parent integrates after the relevant writers stop:

1. Consume the concise result, evidence references, and unresolved gaps; inspect each diff against `write_scope`, `forbidden_scope`, and acceptance.
2. Resolve cross-stream seams through their existing owner; do not create a new shared owner.
3. Run affected tests, the build required by risk, and one check through the final consumer.
4. Report local checks, external synchronization, and runtime evidence separately.

If delivery is in scope, carry the original/latest request, the already identified final
consumer, stop condition, current evidence, and proposed completion claims into this existing
integration check. Missing evidence blocks only the unsupported completion claim. If a next
step is still required by the user's acceptance, explicitly authorized, and safe to execute,
continue it; if authority or facts are missing, report the specific unfinished item without
expanding scope. At a concrete integration failure, make a narrow prior-experience lookup for
that failure if it can choose a better next check; do not preload all memory or add a reviewer
solely for lookup.

Do not commit, push, deploy, publish, or trigger other external side effects unless that action is explicitly inside the user's scope. A worker's `completed` status is not integration acceptance.
