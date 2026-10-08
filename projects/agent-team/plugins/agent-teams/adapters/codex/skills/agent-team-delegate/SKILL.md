---
name: agent-team-delegate
description: Use when a task has at least two independently verifiable branches and one can progress beside useful parent work, or when the user explicitly asks for subagents, delegation, or parallel agents. Do not use merely because a task is large, has many files, or spans repositories.
---

# Selective Native Delegation

Before the first delegation, resolve the host route using [model-policy.md](references/model-policy.md). Before the first join, read [wait-policy.md](references/wait-policy.md). Reuse these rules within the same task while the host and policy remain unchanged; do not reload them for each branch.


Codex already owns the subagent runtime. This skill only sharpens the decision, branch contract, join, and acceptance. The root parent retains the user goal, critical-path decisions, cross-branch arbitration, and final consumer verification.

Root only: when using the optional delivery feedback, read the Start section of [delivery-receipt.md](references/delivery-receipt.md) and register before work. Children do not load or register it. Keep completion-record details until validation; feedback never gates execution.

## Decide whether delegation pays

Delegate only when both conditions hold:

1. The branch has an independently checkable result and does not need unresolved output from the root or another branch.
2. It is likely to materially reduce elapsed time or parent context pressure after coordination cost, while the root continues useful work.

Use delegate for one useful independent branch; keep small local changes in the parent. Do not fill feature or review phases without a need.

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

Roles follow the work (reader or writer); model choice follows the host route and model-policy.md. Do not use a model-specific role or assume the parent's model is the child's default.

Pass applicable user command/file/side-effect limits verbatim to children,
continuations, reviewers, and integration. Keep validation with its named owner;
explicit limits override generic validation/repair permission. Preserve exact
commands/environment; no substitute inline checks. Generated caches count as
writes. Verify compliance as well as behavior; report violations and gaps.

Keep each branch to one independently testable outcome and one stable responsibility. A whole repository or service is not a sufficient write boundary: name the owned files or submodule and exclusions. Split unrelated outcomes before spawning; uncertain shared contracts need root investigation or a read-only branch first. Several files may implement one outcome; file count is not a splitting rule.

Within that boundary, a worker completes implementation, targeted validation, and repairs caused by its own changes without routine parent confirmation. Stop when acceptance is met. Return evidence and a decision request before changing the goal, shared contract, write scope, or authorized effects; unrelated failures do not authorize extra fixes. Repeated failure without new evidence returns to the root. Use an explicit first_checkpoint only for high-risk or uncertain ownership/integration work; do not add it to every writer.

Pass task-specific inputs and source references, not copied manuals or full exploration history. Batch already determined independent reads and related edits using native tools; retain separate batches for dependencies, shared writes, and new test evidence.

## Use the native lifecycle

Use Codex's native roles and lifecycle; do not add another runtime or ledger.

1. Call `list_agents` when an existing direct child might be reusable. Use `followup_task` only for an idle child with the same stable responsibility, role, permission boundary, and write scope whose prior result was accepted. A new objective requires fresh decomposition and a fresh branch, not an expanding followup_task.
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

`completed does not mean accepted`. The root consumes conclusions, evidence references, and gaps rather than repeating the full investigation. It checks the evidence required by risk: key references for reads; diff, ownership, and affected tests for code; real input through the final consumer for cross-module or external-side-effect work.

Start another branch only when it closes a still-required acceptance item and can change the result. When the same semantic failure appears a second time without new evidence, change the approach or report the verified gap. Stop when the user's acceptance is met.

When a handoff reveals a concrete delivery gap or repeated/ambiguous failure, make a narrow
lookup for relevant prior experience at that point before choosing the next discriminating
check. This is contextual input, not proof of current completion: do not preload all memory or
spawn an extra reviewer solely to perform the lookup. If delivery is in scope, keep any
unsupported completion claim separate from unrelated work. Continue a remaining next step when
it is required by the user's acceptance, explicitly authorized, and safe to execute; if
authority or facts are missing, report the specific unfinished item without expanding scope.
