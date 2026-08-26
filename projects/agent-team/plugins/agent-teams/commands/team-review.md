---
description: "Run bounded parallel review on a frozen snapshot, then repair only after all readers join"
argument-hint: "<target> [--reviewers security,performance,architecture,testing,accessibility] [--base-branch main]"
---

# Team Review

Run independent read-only reviews against one frozen snapshot. Separate review execution status from the quality verdict, and prevent review-repair loops from expanding without bound.

## Phase 1: Freeze the Review Target

1. Resolve the target to exact files plus a commit, diff range, content hash, or working-tree snapshot identifier.
2. Freeze scope, requested dimensions, severity rules, and blocking criteria.
3. Pass reviewers target references and paths. Do not copy a full diff or raw repository output into the parent conversation unless a reviewer needs a small exact excerpt.
4. Use at most four concurrent reviewers in one wave. Preserve every requested review dimension; when more than four independent dimensions are requested, run additional waves rather than combining or dropping coverage.

## Phase 2: Spawn Read-Only Reviewers

Before spawning, freeze each reviewer contract:

```text
goal: review the frozen snapshot for one assigned dimension
scope: exact snapshot id, files, dimension, and exclusions
acceptance: inspect the complete assigned scope and support the verdict with exact evidence
handoff: status, verdict, snapshot, structured findings, and uncovered scope
```

Select model and effort per frozen dimension: use Luna `medium` for a narrow deterministic evidence check, Terra `medium` for a standard code-review dimension, and Terra `high` for security, concurrency, cross-module architecture, or another high-risk dimension. Keep deduplication, severity arbitration, and the final quality decision in the root parent. Use `xhigh` only after representative evaluation shows a clear gain.

1. The root parent owns reviewer routing. Call `list_agents` first; reuse an idle reviewer with `followup_task` only for the same frozen snapshot, same review dimension, same role, model, effort, and scope, after its prior result was accepted. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible reviewer ineligible. A new snapshot or dimension must use `spawn_agent`. Use `agent-teams__team-reviewer` only for its fixed Terra-medium route; otherwise use built-in `explorer` with the selected `model` and `reasoning_effort`. Model overrides require isolated or bounded history, so use `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI unless a minimum supported recent-history fork is essential. Treat a reviewer as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join.
2. Give every reviewer the same frozen snapshot id and blocking criteria in addition to its contract.
3. Require evidence with exact file and line references. Reviewers may inspect and report; they must not edit files or start repair work.

Use at most four concurrent reviewers. Reuse a compatible idle reviewer when possible, but do not impose a fixed total-spawn limit that can block completion. Reviewers return uncovered scope to the parent and never create their own review tree.

## Phase 3: Review Barrier

1. Call `wait_agent` with all active reviewer ids and a bounded wait. Repeat bounded joins while completion-critical reviewers remain active.
2. Do not start a repair when the first finding arrives. The Review Barrier remains closed until every reader has completed, blocked, or been terminated after a narrowing `send_message` failed to restore bounded progress; use `followup_task` only when an idle reviewer must finish the unchanged contract.
3. Collect compressed findings. Use `interrupt_agent` for a running reviewer that must stop; on legacy hosts, `send_input` and `close_agent` are the equivalent correction and retirement controls.
4. Deduplicate by root cause and location, calibrate severity, and separate blocking findings from non-blocking follow-up.

Every reviewer result must include both:

```text
status=completed|blocked
verdict=pass|block
snapshot=<frozen snapshot id>
findings=<structured evidence or none>
```

`status=completed` means the review ran; it never implies `verdict=pass`.

Return a concise review covering `status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`; JSON is optional. Put `verdict=pass|block`, the frozen snapshot id, and structured findings in `evidence` and `validation`; `changes` is empty for the read-only reviewer.

## Phase 4: Repair Barrier

Only after all readers join may one owner apply a consolidated repair batch. Do not let reviewers edit the target. Freeze a new snapshot after repair and run only the incremental dimensions affected by that batch.

After two review-repair rounds, pause and re-evaluate the root cause, frozen scope, and repair strategy. Continue when the remaining blocker is still inside the user's acceptance criteria and the next round tests a materially different fix; stop only for a real external blocker or an explicitly out-of-scope hardening task.

## Phase 5: Final Verification

Run one final verifier against the latest frozen snapshot and the original blocking criteria. The final verifier returns `verdict=pass|block` with evidence. The parent agent then reports:

- reviewed snapshot and dimensions;
- deduplicated blocking and non-blocking findings;
- repair rounds used;
- final verifier verdict;
- deferred work outside the frozen scope.
