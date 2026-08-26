---
description: "Delegate bounded work to native subagents when an independent branch materially reduces elapsed time or parent context pressure"
argument-hint: "<objective> [--read-only] [--parallel N]"
---

# Team Delegate

Delegate only when isolation, parallelism, verification, or a write boundary clearly pays off. The parent owns scope, decisions, synthesis, and final acceptance.

## 1. Run Delegation Preflight

Run this check only for a plausible independent side branch. The parent first names its immediate critical-path action, then any sidecar that can progress without blocking it. A branch qualifies only when it has its own acceptance check and is expected to materially reduce elapsed time or parent context pressure after spawn-and-join cost.

Useful signals include multiple repositories that yield two or more independent evidence streams, competing debugging hypotheses, an independent test, verification, or review, a large raw output stream, a permission boundary, or a frozen, disjoint implementation scope. Task level, repository count, source count, or file count does not by itself justify delegation. Keep simple, sequential, tightly coupled work, an immediate blocker, or a small change in one file local. Two or three short sources that fit in one bounded local read also stay local when no useful parent work can overlap. Do not spawn a writer before shared contracts are frozen.

Use at most four concurrent branches. Prefer readers; writers require the Writer Barrier and frozen shared contracts. Do not use a fixed total-spawn budget as a completion gate: reuse compatible children first, but start another bounded branch when acceptance genuinely requires it.

Descendant delegation is parent-authorized. A child normally returns a decomposition request; it may create bounded descendants only when its current contract says so. Every descendant stays within the inherited goal, scope, and write or permission boundary, reports to its immediate parent, and never assigns sibling or root-level work. There is no fixed descendant count or depth; every spawn remains subject to the shared four-concurrent-branch ceiling and a fresh explicit contract.

## 2. Freeze the Branch Contract

Every branch prompt must contain these fields:

```text
goal: one concrete outcome
scope: exact files, sources, or questions in scope
acceptance: observable completion checks
handoff: required compressed return format
```

For a writing branch, also include `write_scope`, `forbidden_scope`, `depends_on`, and `produces`. Add `first_checkpoint` only when concurrency, shared state, external side effects, or uncertain ownership makes an intermediate inspection materially safer. Pass paths, links, hashes, and exact ranges instead of copying the parent conversation.

Descendant delegation defaults to disabled. When it is genuinely useful, add `descendant_delegation: parent_authorized`; absence of that field means the child must return the decomposition request to the parent.

## 3. Choose Model and Reasoning Effort

The root parent selects the model and effort from the frozen branch shape before reuse or spawn. Do not let the child upgrade itself or compensate for unclear scope with more effort.

| Branch shape | Codex route |
| --- | --- |
| Deterministic command, targeted lookup, known test, or mechanical edit | `gpt-5.6-luna` with `low` |
| Ordinary bounded investigation or implementation with one stable goal | `gpt-5.6-luna` with `medium` |
| Fixed scope and hypothesis but complex evidence or debugging | `gpt-5.6-luna` with `high` |
| Ambiguity can change the scope, hypothesis, contract, or cross-module conclusion | `gpt-5.6-terra` with `medium` or `high` |
| Global decomposition, result arbitration, or high-risk final acceptance | keep in the root parent; use Sol `high` or `max` when the host exposes it |

Use `xhigh` only after representative evaluation shows a clear gain. If a Luna branch appears to need `xhigh` or `max`, route it to Terra or keep it in the parent instead. Record the chosen model and effort with the branch in the host plan.

## 4. Reuse Before Spawn

The root parent owns the branch registry and peer routing. Record each direct child's id, role, model, effort, goal, scope, status, write scope, and `reuse_count` in the host plan; children do not assign siblings.

Before any new `spawn_agent` call:

1. Call `list_agents`. A reusable child is completed or idle, has the same role, model, and effort, continues the same stable responsibility, has a scope compatible with its inherited read/permission boundary, keeps the same write scope, and has an accepted prior result.
2. Send its complete next contract with `followup_task`; increment `reuse_count` only after the call succeeds.
3. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible child ineligible.
4. Do not give new work to a running or blocked child. Use `send_message` only to correct current running work.
5. On any compatibility mismatch, unresolved ownership or dependency, or unavailable or failed follow-up, fall back to `spawn_agent` with isolated history.

Reuse is not a credit against a total-spawn budget and never transfers routing authority to a child. Only currently active children count toward the concurrency ceiling.

## 5. Use the Native Codex Lifecycle

1. After Reuse Before Spawn, call `spawn_agent` only on fallback: `explorer` for reading or `worker` for disjoint writing. Pass `model` and `reasoning_effort` explicitly. Model overrides use isolated or bounded history: `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI.
   Treat the branch as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join.
2. Record id, route, contract, owner, dependency, and `reuse_count = 0`; do not add another runtime or ledger. Continue useful parent work. Do not duplicate the child's full scan or implementation.
3. At a real join, call `wait_agent` with a bounded wait only for active children still missing a handoff. On target-capable hosts pass unresolved ids together. Repeat bounded joins only while completion-critical work remains active.
4. Use `send_message` to correct running work, `followup_task` only after return for compatible continuation, and `interrupt_agent` when a running branch must stop. If the same failure repeats without new evidence, change approach or return the verified gap.

## 6. Join Results

Ask each branch for a concise handoff covering:

```json
{
  "status": "completed | partial | blocked",
  "summary": "concise conclusion",
  "evidence": [{"claim": "verified claim", "ref": "path, line, URL, hash, run id, or test"}],
  "changes": [{"path": "absolute path", "summary": "actual change"}],
  "validation": [{"check": "command or consumer", "result": "pass | fail | not_run", "ref": "evidence"}],
  "gaps": [{"item": "unfinished or out-of-scope item", "reason": "reason", "suggest": "next action"}]
}
```

JSON is convenient but not mandatory. Blocked branches include a concrete reason and one suggested next action in `gaps`. Keep the result concise, store bulky raw output in artifacts, and return evidence references instead of making the parent reread the branch's full transcript.

## 7. Stop Conditions

- Do not widen scope or perform commit, push, deploy, or other unauthorized side effects.
- Continue replacements only when the hypothesis, contract, or observable progress changes; otherwise return the verified gap.
- Keep compatible completed children idle for reuse. Interrupt only abandoned or unsafe running work.
- Context-pressure signals are advisory; they cannot block completion-critical reads, joins, tests, or final verification. No plugin Hook may impose count-based stops.
