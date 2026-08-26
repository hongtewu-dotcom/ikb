---
name: agent-team-review
description: Use when a review target can be frozen and two or more independent quality dimensions materially benefit from read-only parallel inspection. Use one local review for a narrow target or a single dimension.
---

# Frozen-Snapshot Parallel Review

Run independent read-only reviewers against one frozen snapshot, then consolidate before any repair. The root parent owns severity arbitration, repair scope, and final acceptance. Reviewers inherit the root parent's model and reasoning settings by default.

## Freeze the target

Resolve exact files plus a commit, diff range, content hash, or explicit working-tree snapshot id. Freeze review dimensions, exclusions, severity rules, and the same blocking criteria for every reviewer.

Each reviewer receives:

```text
goal: inspect one assigned quality dimension
scope: snapshot id, exact files, dimension, and exclusions
acceptance: complete assigned inspection with exact evidence or explicit no findings
handoff: execution status, quality verdict, snapshot, findings, and uncovered scope
```

Use the built-in `explorer` role and require read-only behavior. Do not package a custom reviewer solely to force a model or permission setting; the prompt and frozen scope own the review contract, while the host owns runtime enforcement.

## Review Barrier

Use `list_agents` and `followup_task` only for an idle reviewer continuing the same frozen snapshot and review dimension after its prior result was accepted. Otherwise use `spawn_agent` with `fork_turns: "none"` and put the complete snapshot contract in the request. Let model and reasoning settings inherit. Give every reviewer the same snapshot id and same blocking criteria.

Use `send_message` for a narrowing correction inside the same dimension. Use `wait_agent` at the reader join and `interrupt_agent` only for abandoned, unsafe, or superseded work. Keep the Review Barrier closed until all readers have completed, blocked, or been explicitly stopped. Do not start repair after the first finding arrives.

A wait returning does not prove completion. A progress `MESSAGE` is not a reviewer handoff; only `FINAL_ANSWER` or an observed completed status closes that dimension. Continue the join while any required reader is active, and do not duplicate its full review in the root.

Every reviewer returns both fields:

```text
status=completed|blocked
verdict=pass|block
```

Execution status does not imply a passing quality verdict. Findings cite exact file and line references, explain impact, and identify uncovered scope. Reviewers do not edit files or create their own review tree.

## Consolidate, then repair

After all readers join, the root deduplicates findings by cause and location, calibrates severity, and separates blocking findings from non-blocking follow-up. Only then may one owner apply one consolidated repair batch.

Freeze a new snapshot after repair and rerun only dimensions affected by the batch. Run one final verifier against the latest snapshot and the original blocking criteria. If the same semantic failure appears a second time without new evidence, change the repair strategy or report the blocker instead of opening an automatic review-repair loop.

The final report names the reviewed snapshot, dimensions, blocking and non-blocking findings, repair evidence if any, and the final verifier's `verdict=pass|block`.
