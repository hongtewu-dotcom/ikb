---
name: agent-teams-workflow
description: Adapt agent-teams main/sub-agent governance principles to pi-dynamic-workflows. Use when orchestrating pi workflows that need delegation preflight, spawn contracts, writer/review barriers, compressed handoffs, or bounded parallel agents — without copying the Codex hook runtime. Covers review/explore/feature preset workflows and their SpawnContract/ResultReceipt schemas.
metadata:
  version: 1.0.0
---

# Legacy pi-dynamic-workflows source preset

This source-only preset is retained for the third-party runtime and is not
installed by the first-class Pi adapter. The generated native Pi Skill uses
the `agent_teams_branch` TypeScript extension, which runs isolated
`pi --mode json -p --no-session` child processes rather than claiming a
native subagent feature.

# agent-teams → Pi Workflow Adapter

`pi-dynamic-workflows` is the execution runtime; this adapter carries the
host-independent governance principles of `agent-teams` into it. Do **not**
re-implement the Codex hook lifecycle (`PreToolUse`, `SubagentStart`,
`SubagentStop`, `PostCompact`); pi owns agent execution through
`agent()`, `parallel()`, `workflow()`, and lifecycle helpers.

## 1. Delegation preflight

Before fanning out, identify the parent's immediate critical-path action and
list bounded sidecar branches that can progress without blocking it. Positive
triggers may justify up to four concurrent branches:

- multiple repositories or source systems;
- two or more independent evidence streams;
- competing hypotheses;
- an independent verification or review;
- a large read that should stay out of the parent context;
- a permission boundary;
- a frozen, disjoint write scope.

Keep simple, sequential, tightly coupled, single-file, or immediate-blocker
work inside the workflow's own agent calls. Multiple sources are a trigger
only when isolation or parallelism materially beats the fixed spawn-and-join
cost. Set `maxAgents` from the planned graph and `concurrency <= 4`; neither a
universal total-spawn count nor a resource-budget counter may act as a
completion gate.

## 2. Spawn contract and result receipt

Every delegated `agent()` prompt must carry `goal`, `scope`, `acceptance`,
and `handoff`; writing branches also carry `write_scope`, `forbidden_scope`,
`depends_on`, and `produces`. Add `first_checkpoint` only for high-risk,
ownership-sensitive, or uncertain integration work (see
`policies/spawn-contract.schema.json` and `policies/writer-contract.schema.json`).

Ask every branch to return the six-field receipt validated against
`policies/result-receipt.schema.json`:

```json
{
  "status": "completed | partial | blocked",
  "summary": "concise outcome",
  "evidence": ["path, commit, hash, run id, or test ref"],
  "changes": ["file or artifact"],
  "validation": ["check and outcome"],
  "gaps": ["uncovered scope or open unknown"]
}
```

Pass the schema as the `agent()` `schema` option so the runtime validates the
shape before JavaScript reads fields. Keep raw tool output in artifacts and
return references, but do not reject an otherwise valid receipt solely because
of its byte or item count. Treat a recoverable `null` as missing coverage and
record its id in the failure ledger before filtering.

## 3. Runtime mapping

| agent-teams principle | pi-dynamic-workflows mechanism |
| --- | --- |
| Isolated subagent context | `agent()` fresh subagent session per call |
| Parallel independent branches | `parallel(thunks)`; preserve input order; record intended IDs before filtering |
| Frozen snapshot before review | Pass exact commit/diff/hash into reviewer prompts; reviewers are read-only |
| Review barrier: no repair until all readers finish | Join all reviewers first; partial/blocked reviewers are execution failures; deduplicate and calibrate findings; then one consolidated repair batch |
| Drift correction | Use semantic `retry()` or `gate()` while the hypothesis or observable progress changes; otherwise replan or return the verified gap |
| Human gate (checkpoint) | `checkpoint(prompt, { headless: "abort" })`; run with `background: false` when confirmation must reach the host |
| Verifier at the end | Final read-only `agent()` always runs against the latest snapshot and original acceptance criteria — never skipped on zero findings, never fabricated on dedup failure |
| Token/agent budget | `maxAgents`, `concurrency`, `agentRetries` on the invocation; optional `phase(..., { budget })` |

## 4. Preset workflows

Three bounded, tested scripts live in `workflows/`:

- `workflows/agent-teams-explore.js` — cross-repo / multi-source read-only evidence
  gathering, structured receipt join, no file changes.
- `workflows/agent-teams-review.js` — up to 4 read-only review dimensions on a frozen
  snapshot, finding dedup and severity calibration, one final verifier.
- `workflows/agent-teams-feature.js` — plan → writer barrier (parallel disjoint
  writers, with optional risk-based first_checkpoint) → read-only reviewers →
  single integration.

Run a preset from the `workflow` tool by reading the script and passing it
as `script` with `args`, or copy the pattern into a task-specific script.
Do not guess installed workflow names.

## 5. Non-goals

- No second runtime: execution stays on pi's `agent()`/`parallel()`.
- No persistent task ledger/state machine: journaling is pi's job.
- No Codex hook port: hook events do not exist in pi.
- No global memory reload in branches unless the contract names a decision.

## 6. Verification status (2026-08-10)

- Static: `tests/test_pi_adapter.py` validates schema shape without output-size
  gates, JS syntax, SKILL reference closure, and that
  review/feature scripts keep the failure-safe branches (F3/F5/F6, F1/F2).
- Smoke: `agent-teams-explore` ran a real 3-agent read-only evidence join on
  the agent-teams source skills — all receipts completed, coverage ledgers and
  gaps reported correctly, no file changes.
- Self-review: an adversarial 2-dimension review of this adapter itself
  (via the review preset pattern) surfaced GOV-1 (writer schema
  unsatisfiable), F1/F2 (writer barrier/checkpoint gaps), F3 (fabricated
  pass), F5 (skipped verifier), F6 (missing status), and receipt policy
  ambiguity; all fixed and re-verified. Receipt validity now depends on shape
  and semantics rather than byte or item counts.
- Thin `agent-teams-guard` extension is **deferred**: the runtime-enforced
  schema validation and in-script semantic barriers cover today's constraints. Add it only if
  a real smoke run shows a model bypassing the contract.

Do not claim the Pi adapter is production-ready until a real task runs the
review and feature presets end-to-end on a target repo with actual diffs.

## 7. Feature 冒烟发现：writer 依赖必须分层放行（2026-08-10）

真实 feature 冒烟（/tmp/pi-feature-smoke，src writer 生产契约 + tests writer 消费）
验证了 Writer Barrier 和依赖方阻塞，同时暴露：
- **并行启动所有 writer 是错的**：consumer writer 依赖 producer 的契约交接，
  全并行时 producer 停在 first_checkpoint 会让 consumer 必然 blocked。
- **Writer Barrier 的正确语义是分层放行**：无 depends_on 的 producer 先跑
  （可并行），全部通过 first_checkpoint 并完成实现后，consumer 再启动。
- **first_checkpoint 是可选中间态，不是通用门禁**：只有显式声明它的 writer
  才需要提交对应证据；普通 writer 可在一轮内完成，后续续跑次数由当前进展
  和宿主复用上限决定，不在 preset 内再锁死一轮。

当前预设按依赖拓扑分层启动 writers，并以最多 4 个并发的波次执行；总 writer
数量不由并发上限截断。
