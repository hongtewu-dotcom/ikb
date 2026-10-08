---
name: agent-team-review
description: Use when a review target can be frozen and two or more independent quality dimensions materially benefit from read-only parallel inspection. Use one local review for a narrow target or a single dimension.
---

# Frozen-Snapshot Parallel Review

Before the first delegation, resolve the host route using [model-policy.md](references/model-policy.md). Before the first join, read [wait-policy.md](references/wait-policy.md). Reuse these rules within the same task while the host and policy remain unchanged; do not reload them for each branch.


Run independent read-only reviewers against one frozen snapshot, then consolidate before any repair. The root parent owns severity arbitration, repair scope, and final acceptance. Resolve reviewer models from the current host and model policy.

Root only: when using the optional delivery feedback, read the Start section of [delivery-receipt.md](references/delivery-receipt.md) and register before work. Children do not load or register it. Keep completion-record details until validation; feedback never gates execution.

## Freeze the target

Resolve exact files plus a commit, diff range, content hash, or explicit working-tree snapshot id. Freeze review dimensions, exclusions, severity rules, and the same blocking criteria for every reviewer.

Each reviewer receives:

```text
goal: inspect one assigned quality dimension
scope: snapshot id, exact files, dimension, and exclusions
acceptance: complete assigned inspection with exact evidence or explicit no findings
handoff: execution status, quality verdict, snapshot, findings, and uncovered scope
```

When delivery or completion is part of the request, include the original user request plus
any latest clarification that supersedes it, the intended final consumer, the explicit stop
condition, the evidence already collected, and the completion claims the root may make.
Reviewers compare each claim with its evidence. Missing evidence blocks a pass for that
claimed completion only; it does not block unrelated review findings or repair work.
Leave these fields out when delivery is not in scope rather than inventing a release gate.

Use the built-in `explorer` role and require read-only behavior. Do not package a custom reviewer solely to force a model or permission setting; the prompt and frozen scope own the review contract, while the host owns runtime enforcement.

Carry the user's applicable command, file, and side-effect restrictions verbatim
into each review request. Read-only review includes avoiding generated caches;
do not run imports or tests when validation is reserved to another phase. Check
reported command history and writes against the restrictions, and keep compliance
gaps visible even when functional tests pass.

## Review Barrier

Use `list_agents` and `followup_task` only for an idle reviewer continuing the same frozen snapshot and review dimension after its prior result was accepted. Otherwise use `spawn_agent` with `fork_turns: "none"` and put the complete snapshot contract in the request. Use the verified host route subject to model-policy.md. Give every reviewer the same snapshot id and same blocking criteria.

Use `send_message` for a narrowing correction inside the same dimension. Use `wait_agent` at the reader join and `interrupt_agent` only for abandoned, unsafe, or superseded work. Keep the Review Barrier closed until all readers have completed, blocked, or been explicitly stopped. Do not start repair after the first finding arrives.

A wait returning does not prove completion. A progress `MESSAGE` is not a reviewer handoff; only `FINAL_ANSWER` or an observed completed status closes that dimension. Continue the join while any required reader is active, and do not duplicate its full review in the root.

Every reviewer returns both fields:

```text
status=completed|blocked
verdict=pass|block
```

Execution status does not imply a passing quality verdict. Findings cite exact file and line references, explain impact, and identify uncovered scope. Reviewers do not edit files or create their own review tree.

If a concrete finding exposes a repeated or ambiguous failure, perform a narrow lookup for
relevant prior experience at that failure point and use it to choose the next discriminating
check. Do not preload all memory or add a reviewer solely for that lookup; prior experience is
context, not current-snapshot evidence.

## Cross-host review (default-on, advisory)

After freezing the snapshot, make exactly one on-demand `agent-call` CLI invocation so a different brain inspects the same dimensions:

```text
agent-call review --host pi \
  --caller-model <the root parent's own model id> \
  --task "<the same frozen review dimensions and blocking criteria>" \
  --context-file <the frozen snapshot file>
```

The CLI reads the configured review model (default `catpaw-ide/kimi-k3:max`) and automatically selects a listed fallback when it collides with `caller_model`; do not hardcode a model in this Skill. The external reviewer is read-only and receives no repository access — everything it needs is in the snapshot file. It starts and exits with this call; it does not create a background process.

Treat a successful JSON result's six-field `receipt` as one more reviewer: feed its findings into the same dedup-by-cause-and-location consolidation and mark them as external-origin. Its verdict is **advisory** — the root parent owns severity arbitration and final acceptance. If the command fails (`unavailable` / `timeout` / `protocol` / `model_error` / `cancelled`), record the failure kind in the final report and proceed without the external dimension; never silently retry into an unlisted model.

## Consolidate, then repair

After all readers join, the root deduplicates findings by cause and location, calibrates severity, and separates blocking findings from non-blocking follow-up. Only then may one owner apply one consolidated repair batch.

Freeze a new snapshot after repair and rerun only dimensions affected by the batch. Run one final verifier against the latest snapshot and the original blocking criteria. If the same semantic failure appears a second time without new evidence, change the repair strategy or report the blocker instead of opening an automatic review-repair loop.

The final report names the reviewed snapshot, dimensions, blocking and non-blocking findings, repair evidence if any, and the final verifier's `verdict=pass|block`.
