---
name: agent-teams-workflow
description: Adapt agent-teams delegation and bounded writer rules to pi-dynamic-workflows. Use when running or adapting the explore, review, or feature presets.
metadata:
  version: 1.0.0
---

# agent-teams → Pi Workflow Adapter

Same-host Pi delegation uses `pi-dynamic-workflows` `agent()` session isolation
and `parallel()` joins. The `agent_teams_branch` extension is only for driving a
foreign agent binary. Do not add another runtime or port Codex hook events.

Before the first child run, read [model-policy.md](references/model-policy.md)
and apply the host route to inherited and explicit models. Read
[wait-policy.md](references/wait-policy.md) when handling branch joins. Reuse
both decisions for the task while the host and policy remain unchanged.

## Choose the smallest useful entry

Keep a small local change in the parent. For one independently useful branch,
use the existing native agent call with a bounded contract; do not start feature
just to obtain a worker. Use feature when multiple independent write streams
justify its planner, two reviewers, and integration call. A narrow review stays
local; do not run the review preset just to fill its phases.

The feature `args.brief` is forwarded unchanged to every phase. Keep it focused
on the current task and include all user command, file, and side-effect limits;
do not copy exploration history or manuals. Planner summaries cannot replace
these constraints. Explicit limits override generic permission to validate:
reserve checks to their named phase, preserve exact commands/environment, and
count generated files/caches as writes. Inspect behavior and compliance at
handoff; functional success alone does not establish both.

## Always-on boundaries

- Delegate only independent work whose isolation or parallel progress is worth
  the spawn-and-join cost. Keep simple, sequential, or tightly coupled work in
  the current agent call.
- Keep concurrency at four or fewer. Size the workflow's `maxAgents` from its
  planned graph, including internal calls. Feature with N writers needs room for
  N + 5 calls (plan, optional plan repair, two reviewers, integration); do not
  reuse the host default of five for a larger graph. This is invocation sizing,
  not a universal total-spawn gate.
- Before starting writers, freeze shared contracts and give each writer one
  independently testable behavior, a stable responsibility, and a precise
  module/file `write_scope`. Keep write scopes disjoint and name peer scopes in
  `forbidden_scope`.
- A writer is a leaf task. It may implement, run targeted validation, and repair
  failures caused by its own changes while its goal, write scope, and frozen
  contracts stay fixed. Return `blocked` if continuing needs a new goal, wider
  scope, a changed shared contract, an unauthorized side effect, or a repeated
  failure without new evidence. Use `partial` only when implementation is
  complete but external validation remains unavailable. A continuation or
  follow-up may continue only the same responsibility; do not accumulate goals
  or delegate child agents.
- `first_checkpoint` is optional. Declare it only when high risk or uncertain
  ownership makes intermediate inspection useful; ordinary bounded writers
  can finish without one. Routine baseline tests are not first_checkpoint.

## Contracts at each phase

Every delegated `agent()` prompt carries `goal`, `scope`, `acceptance`, and
`handoff`. Writers also carry `write_scope`, `forbidden_scope`, `depends_on`,
and `produces`. Consult
[spawn-contract.schema.json](../../policies/spawn-contract.schema.json) when
creating general branches and
[writer-contract.schema.json](../../policies/writer-contract.schema.json)
when planning writers. Contract indices in `consumes` and
`produces_contracts` drive feature scheduling; `depends_on` describes the same
inputs for people.

At handoff, validate ordinary branches against
[result-receipt.schema.json](../../policies/result-receipt.schema.json):
`status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`. Pass the
schema through `agent()`'s `schema` option. Preserve `null` results as missing
coverage, and do not reject receipts by byte or item count. Reviewers and the
final verifier use their domain result shapes; their prompts name this
exception. Workflow scripts keep inline receipt schemas because they cannot
import modules, and the adapter tests pin those copies to the policy schema.

The feature preset opens the writer barrier only after shared contract indices
and disjoint file ownership are valid. It runs producers before dependent
consumers, then reviews all completed writes before the one integration call.
Partial receipts retain completed code with external validation gaps; blocked,
failed, and unstarted writers stay visible as failures. A writer with a declared
`first_checkpoint` stops there and returns a blocked handoff. This preset has no
parent-acceptance input, so it does not start dependent writers, review, or
integration for that run. The parent can inspect the handoff and dispatch the
remaining work with the existing agent call after accepting it. Ordinary writers
do not need a checkpoint.

## Presets

- `workflows/agent-teams-explore.js` gathers read-only evidence from multiple
  sources and preserves coverage gaps.
- `workflows/agent-teams-review.js` reviews a frozen snapshot, joins reviewers,
  deduplicates findings, and runs a final verifier.
- `workflows/agent-teams-feature.js` plans and freezes contracts, runs bounded
  writers, reviews their changes, and performs one integration step.

Run a preset through the `workflow` tool by passing the script contents and
task-specific `args`. The package includes the three scripts and policy schemas.
Do not claim the adapter is production-ready until a real feature task completes
the workflow on its target repository with actual changes.

## Non-goals

- No second runtime or persistent task ledger; Pi owns execution and journaling.
- No Codex hook port.
- No global memory reload in branches unless the frozen contract names a
  decision they need.
