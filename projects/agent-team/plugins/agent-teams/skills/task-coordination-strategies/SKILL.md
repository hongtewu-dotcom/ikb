---
name: task-coordination-strategies
description: Use when coordinating bounded native-subagent branches whose independent work materially reduces elapsed time or parent context pressure; keep sequential and tightly coupled work local.
metadata:
  version: 1.3.0
---

# Task Coordination Strategies

Strategies for decomposing complex tasks into parallelizable units, designing dependency graphs, writing effective task descriptions, and monitoring workload across agent teams.

## When to Use This Skill

- Breaking down a complex task for parallel execution
- Designing task dependency relationships (blockedBy/blocks)
- Writing task descriptions with clear acceptance criteria
- Monitoring and rebalancing workload across teammates
- Identifying the critical path in a multi-task workflow

## Conditional Delegation Decision and Native Lifecycle

Run this decision only for a plausible independent side branch. The parent first identifies its immediate critical-path action and bounded sidecars that can progress without blocking it. Delegate only a branch with its own acceptance check that should materially reduce elapsed time or parent context pressure after spawn-and-join cost.

Multiple repositories, two or more independent evidence streams, competing hypotheses, independent verification, large-read isolation, a permission boundary, or a frozen disjoint write scope can support delegation. Task level, repository count, source count, or file count does not by itself justify delegation. Keep the work local when it is simple, sequential, tightly coupled, single-file, an immediate blocker, or a short bounded read with no useful parent work to overlap. Writers still require frozen contracts and disjoint ownership.

Use at most four concurrent branches. Use no fixed total-spawn budget and no lifecycle Hook as a completion gate: reuse compatible idle children and synthesize accepted branches before expanding, but start another bounded branch when acceptance genuinely requires it.

Descendant delegation is parent-authorized. A subagent normally returns a decomposition request to its parent. It may spawn bounded descendants only when its current branch contract explicitly authorizes them. Every descendant stays inside the inherited goal, scope, and write or permission boundary, reports to its immediate parent, and never assigns sibling or root-level work. There is no fixed descendant count or depth; every spawn remains subject to the shared four-concurrent-branch ceiling and a fresh explicit contract.

Every delegated branch must define `goal`, `scope`, `acceptance`, and `handoff`. Writing branches also define `write_scope`, `forbidden_scope`, `depends_on`, and `produces`; add `first_checkpoint` only when risk, shared state, external side effects, or uncertain ownership makes an intermediate inspection materially safer.

Descendant delegation defaults to disabled. Authorize it only by adding `descendant_delegation: parent_authorized` to the branch contract.

### Model and Effort Routing on Codex

The root parent chooses the route before reuse or spawn. Match effort to the frozen branch shape, not the overall task level:

| Branch shape | Route |
| --- | --- |
| Deterministic command, targeted lookup, known test, or mechanical edit | Luna `low` |
| Ordinary bounded investigation or implementation with one stable goal | Luna `medium` |
| Fixed scope and hypothesis but complex evidence or debugging | Luna `high` |
| Ambiguity can change scope, hypothesis, contract, or a cross-module conclusion | Terra `medium` or `high` |
| Decomposition, result arbitration, or high-risk final acceptance | keep in the root parent; use Sol `high` or `max` when available |

Use the exact Codex model ids `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`. Use `xhigh` only after representative evaluation shows a clear gain. If Luna appears to need `xhigh` or `max`, change the model route instead of using effort to compensate for model tier or an unclear contract. Record model and effort in the host plan; the child does not choose or upgrade either.

### Reuse Before Spawn

The root parent owns the branch registry and peer routing. Track each direct child's agent id, role, model, effort, goal, scope, status, write scope, and `reuse_count` in the current host plan. A child does not route work to a sibling.

Before any new `spawn_agent` call:

1. Call `list_agents` once and compare existing direct children with the frozen branch contract.
2. Reuse a child only when it is completed or idle, keeps the same role, model, and effort, continues the same stable responsibility, has a next scope compatible with its inherited read/permission boundary, keeps the same write scope, and its prior result was accepted. Send the complete next contract with `followup_task`; increment `reuse_count` only after that follow-up starts successfully.
3. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible child ineligible.
4. Never put a new work unit onto a running child. Use `send_message` only to correct its current work. Do not reuse a blocked child or one whose prior ownership, dependency, or result is unresolved.
5. When any compatibility condition fails, the host lacks `followup_task`, or the follow-up call fails, fall back to `spawn_agent` with isolated history.

Reuse does not consume or refund a fictional total-spawn budget. It is a bounded continuation of an accepted responsibility, not a general-purpose persistent worker; only currently active children count toward concurrency.

On Codex:

1. Run Reuse Before Spawn. Call `spawn_agent` only on the fallback path, with built-in `explorer` for read-only work or `worker` for disjoint implementation. Pass the selected `model` and `reasoning_effort` explicitly. Model overrides require isolated or bounded history, so use `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI unless a minimum supported recent-history fork is essential. Treat the branch as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join.
2. Keep the parent responsible for decisions, joins, and final acceptance. Do not duplicate the branch locally. Narrow acceptance checks are valid; repeating the branch's complete scan, investigation, or implementation is not.
3. At a join point, call `wait_agent` with a bounded wait only for active children still missing a handoff. Pass unresolved targets together when the host supports targets and continue only while completion-critical work remains active.
4. Use `send_message` to narrow a running branch. If the same failure repeats without new evidence or progress, change the approach or return the verified gap. Use `followup_task` only for a bounded continuation after it returns; on a legacy host, `send_input` is the equivalent correction channel.
5. Request a concise result covering `status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`; JSON is optional. Never return bulky raw tool output by default; store it in an artifact and return references.
6. Use `interrupt_agent` when a running branch must stop. On a legacy host, `close_agent` is the equivalent retirement control after accepting or abandoning the handoff.

Subagents use only the branch contract, skip global memory unless named, and batch same-host reads.

## Context Pressure Guidance

Use host context-pressure signals as advisory checkpoints. Narrow bulk reads,
delegate genuinely independent evidence, or checkpoint durable results when
useful, but keep completion-critical reads, joins, tests, and final verification
available. This plugin installs no lifecycle Hook and has no count-based stop.

## Task Decomposition Strategies

### By Layer

Split work by architectural layer:

- Frontend components
- Backend API endpoints
- Database migrations/models
- Test suites

**Best for**: Full-stack features, vertical slices

### By Component

Split work by functional component:

- Authentication module
- User profile module
- Notification module

**Best for**: Microservices, modular architectures

### By Concern

Split work by cross-cutting concern:

- Security review
- Performance review
- Architecture review

**Best for**: Code reviews, audits

### By File Ownership

Split work by file/directory boundaries:

- `src/components/` — Implementer 1
- `src/api/` — Implementer 2
- `src/utils/` — Implementer 3

**Best for**: Parallel implementation, conflict avoidance

## Dependency Graph Design

### Principles

1. **Minimize chain depth** — Prefer wide, shallow graphs over deep chains
2. **Identify the critical path** — The longest chain determines minimum completion time
3. **Use blockedBy sparingly** — Only add dependencies that are truly required
4. **Avoid circular dependencies** — Task A blocks B blocks A is a deadlock

### Patterns

**Independent (Best parallelism)**:

```
Task A ─┐
Task B ─┼─→ Integration
Task C ─┘
```

**Sequential (Necessary dependencies)**:

```
Task A → Task B → Task C
```

**Diamond (Mixed)**:

```
        ┌→ Task B ─┐
Task A ─┤          ├→ Task D
        └→ Task C ─┘
```

### Expressing blockedBy/blocks

```
Build API endpoints      blocks: Integration testing
Build frontend           blocks: Integration testing
Integration testing      blockedBy: API endpoints, frontend
```

Record these relationships in the host plan. Do not start a blocked branch and ask it to wait.

## Task Description Best Practices

Every task should include:

1. **Objective** — What needs to be accomplished (1-2 sentences)
2. **Owned Files** — Explicit list of files/directories this teammate may modify
3. **Requirements** — Specific deliverables or behaviors expected
4. **Interface Contracts** — How this work connects to other teammates' work
5. **Acceptance Criteria** — How to verify the task is done correctly
6. **Scope Boundaries** — What is explicitly out of scope

### Template

```
## Objective
Build the user authentication API endpoints.

## Owned Files
- src/api/auth.ts
- src/api/middleware/auth-middleware.ts
- src/types/auth.ts (shared — read only, do not modify)

## Requirements
- POST /api/login — accepts email/password, returns JWT
- POST /api/register — creates new user, returns JWT
- GET /api/me — returns current user profile (requires auth)

## Interface Contract
- Import User type from src/types/auth.ts (owned by implementer-1)
- Export AuthResponse type for frontend consumption

## Acceptance Criteria
- All endpoints return proper HTTP status codes
- JWT tokens expire after 24 hours
- Passwords are hashed with bcrypt

## Out of Scope
- OAuth/social login
- Password reset flow
- Rate limiting
```

## Workload Monitoring

### Indicators of Imbalance

| Signal                     | Meaning             | Action                      |
| -------------------------- | ------------------- | --------------------------- |
| Teammate idle, others busy | Uneven distribution | Reassign pending tasks      |
| Teammate stuck on one task | Possible blocker    | Check in, offer help        |
| All tasks blocked          | Dependency issue    | Resolve critical path first |
| One teammate has 3x others | Overloaded          | Split tasks or reassign     |

### Rebalancing Steps

1. Assess active branch status at the next join point
2. Identify idle, overloaded, blocked, or drifting branches
3. Reassign only pending work whose contract and ownership remain unchanged
4. Notify an active branch through the host's native input channel
5. Stop branches that cannot make bounded progress instead of widening their scope
