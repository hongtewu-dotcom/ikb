---
description: "Develop a feature with native subagents, frozen contracts, disjoint write scopes, and integration gates"
argument-hint: "<feature-description> [--parallel N] [--branch feature/name]"
---

# Team Feature

Coordinate feature work with native Codex subagents while preserving one owner per file and one parent-owned integration boundary.

## Phase 1: Freeze Scope and Acceptance

1. Resolve the requested feature, explicit exclusions, final consumer, acceptance checks, and stop condition.
2. Inspect the minimum code needed to identify stable responsibilities, affected files, shared state, tests, and integration points.
3. If the work is tightly coupled or has no disjoint branch, implement it directly with no subagent.
4. Use at most four concurrent branches. Reuse compatible idle workers and synthesize accepted branches before expanding; do not impose a fixed total-spawn limit that can block completion.

If a branch name was explicitly requested, create it with the repository's supported non-interactive Git command. Do not create branches merely to simulate parallelism.

## Phase 2: Decompose and Freeze the Shared Contract

For each candidate stream, define `goal`, `scope`, `acceptance`, and `handoff`. For writers also define:

```text
write_scope: exact files or modules this worker owns
forbidden_scope: files and responsibilities it must not modify
depends_on: frozen inputs required before writing
produces: artifacts and interfaces produced for consumers
first_checkpoint: optional failing test or minimum diff for high-risk or ownership-sensitive work
```

Freeze every shared contract before starting a consumer writer. Assign one owner to each shared file and state owner. A vertical slice is the parent's acceptance boundary; do not hand an entire cross-layer slice to one worker by default.

## Phase 3: Writer Barrier

Open the Writer Barrier only when all of these are true:

- the feature scope and acceptance are frozen;
- any shared contracts have one owner and are frozen; independent streams may have none;
- every writer has a disjoint `write_scope` and explicit `forbidden_scope`;
- all `depends_on` inputs exist and were accepted;
- the final consumer and integration test are known.

If any condition fails, keep the work sequential. Independent worktrees may isolate files, but they do not replace this barrier.

Before execution, the root parent selects each writer's model and effort from the frozen stream. Use Luna `low` for mechanical edits or known tests, Luna `medium` for ordinary bounded implementation, Luna `high` for fixed but complex code paths, and Terra `medium` or `high` when hard reasoning remains inside an otherwise frozen contract. If ambiguity can still change ownership or the shared contract, keep that decision in the parent and leave the Writer Barrier closed. If Luna appears to need `xhigh` or `max`, route the stream to Terra instead.

## Phase 4: Native Execution

1. The root parent owns worker routing. Call `list_agents` before each new worker: reuse an idle direct child with `followup_task` only when it has the same role, model, effort, scope, unchanged `write_scope`, and an accepted prior result; otherwise call `spawn_agent` with the selected `model` and `reasoning_effort`. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible worker ineligible. Model overrides require isolated or bounded history, so use `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI unless a minimum supported recent-history fork is essential. Treat a new worker as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join.
2. Tell every worker that other writers may be active, it must preserve their changes, and it owns only its declared files.
3. Require a stop at `first_checkpoint` only when the contract declares one because the work is high-risk, ownership-sensitive, or has an uncertain integration seam. Otherwise let the worker complete its bounded contract in one turn.
4. When a checkpoint exists, use a bounded `wait_agent` call at the checkpoint join and inspect the actual diff, state ownership, and downstream consumer before continuing.
5. Use `followup_task` to authorize an idle worker's bounded continuation only when the checkpoint stays within the same contract, and increment its `reuse_count`. Use `send_message` only to correct current work on a running worker.
6. Wait for all accepted streams. Use `interrupt_agent` when a running branch must stop. On legacy hosts, `send_input` and `close_agent` are the equivalent correction and retirement controls.

A worker normally returns a decomposition request. It may create bounded read-only or verification descendants only when its current frozen contract sets `descendant_delegation: parent_authorized`. Descendants cannot escape the inherited goal, scope, `write_scope`, or `forbidden_scope`; each reports to its immediate parent and cannot assign sibling or root-level work. There is no fixed descendant count or depth, but every spawn remains subject to the shared four-concurrent-branch ceiling and a fresh explicit contract.

Every checkpoint and final result concisely covers `status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`; JSON is optional. Save large diffs and test output as artifacts. Pass unresolved worker ids together when possible, and continue bounded joins while a completion-critical worker remains active.

## Phase 5: Parent Integration

The parent agent owns integration:

1. Compare every returned change against `write_scope`, `forbidden_scope`, and acceptance. Do not duplicate a worker's implementation; inspect its diff and run narrow final-consumer checks.
2. Resolve cross-stream issues only after all relevant writers have stopped.
3. Run the build, affected tests, and the final-consumer check required by task risk.
4. Report completed work, changed files, validation, and deferred non-blocking findings.

Do not commit, push, or deploy unless the user explicitly included that action in scope. Do not turn integration findings into an unbounded new implementation phase.
