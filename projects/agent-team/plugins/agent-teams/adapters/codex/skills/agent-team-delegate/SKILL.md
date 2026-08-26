---
name: agent-team-delegate
description: Use when a task has at least two independently verifiable branches and one can progress beside useful parent work, or when the user explicitly asks for subagents, delegation, or parallel agents. Do not use merely because a task is large, has many files, or spans repositories.
---

# Selective Native Delegation

Codex already owns the subagent runtime. This skill only sharpens the decision, branch contract, join, and acceptance. The root parent retains the user goal, critical-path decisions, cross-branch arbitration, and final consumer verification.

## Decide whether delegation pays

Delegate only when both conditions hold:

1. The branch has an independently checkable result and does not need unresolved output from the root or another branch.
2. It is likely to materially reduce elapsed time or parent context pressure after coordination cost, while the root continues useful work.

Useful shapes include multiple repositories that produce independent evidence streams, competing debugging hypotheses already framed by the root, an independent test, verification, or review, a large raw evidence stream with a compact handoff, and a frozen, disjoint implementation scope.

Task level, repository count, source count, or file count does not by itself justify delegation. Keep the work local for a small change in one file, an immediate blocker on the critical path, sequential or tightly coupled work, and a few short sources that fit in one bounded local read. Multiple repositories also stay local when no useful parent work can overlap. Do not spawn a writer before shared contracts are frozen.

Use the host's available concurrency; never turn spawn, wait, reuse, output size, or context counts into a completion gate. If a branch would only restate the full task or make the root repeat the same scan, do not create it.

## Freeze one branch contract

Every child receives a bounded request with:

```text
goal: one concrete outcome
scope: exact files, sources, or question; include exclusions
acceptance: observable checks for completion
handoff: concise result shape and required evidence references
```

A writer additionally receives `write_scope`, `forbidden_scope`, `depends_on`, and `produces`. Tell it that other workers may be active, it must preserve their changes, and it owns only its declared scope. A child may not widen the root goal, assign sibling work, or create descendants unless the current contract explicitly authorizes a bounded descendant.

Subagents inherit the root parent's model and reasoning settings by default. Do not override them as part of the delegation experiment. A lower-cost route is a separate experiment and is allowed only for a fixed, mechanical leaf with deterministic acceptance.

## Use the native lifecycle

Use Codex's native roles and lifecycle; do not add another runtime or ledger.

1. Call `list_agents` when an existing direct child might be reusable. Use `followup_task` only for an idle child with the same stable responsibility, role, permission boundary, and write scope whose prior result was accepted.
2. Otherwise call `spawn_agent`: prefer `explorer` for read-only evidence and `worker` for a disjoint writing scope. Pass the full frozen contract and use `fork_turns: "none"` so the independent child receives that Task Request instead of the parent's conversation. Use the smallest supported recent-turn fork only when an exact recent exchange is itself required input. Treat the branch as started only when the host returns an agent id.
3. Continue useful root work without duplicating the child's full scan or implementation.
4. Use `send_message` to correct a running branch without changing its contract. Use `interrupt_agent` when a running branch is abandoned, unsafe, or superseded.
5. Use `wait_agent` at a real dependency join for active children that have not handed off. A wait returning does not prove completion: a progress `MESSAGE` only reports activity. Only a `FINAL_ANSWER` handoff or an observed completed status satisfies the join. Continue waiting while a required child is still active; do not reread or redo its branch scope in the root merely because an intermediate message arrived.

## Join and accept

Ask for a compact handoff containing:

```text
status: completed | partial | blocked
summary: direct conclusion
evidence: claim plus path, line, URL, hash, run id, or test
changes: changed paths and ownership, or none
validation: check, result, and evidence reference
gaps: unfinished item, reason, and next discriminating action
```

`completed does not mean accepted`. The root checks the evidence required by risk: key references for reads; diff, ownership, and affected tests for code; real input through the final consumer for cross-module or external-side-effect work.

Start another branch only when it closes a still-required acceptance item and can change the result. When the same semantic failure appears a second time without new evidence, change the approach or report the verified gap. Stop when the user's acceptance is met.
