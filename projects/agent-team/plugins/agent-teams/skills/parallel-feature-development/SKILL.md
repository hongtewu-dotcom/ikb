---
name: parallel-feature-development
description: Coordinate parallel feature development with frozen contracts, writer barriers, file ownership, conflict avoidance, and parent-owned integration. Use this skill when decomposing a feature into independent write streams, when two or more agents may implement separate modules, when establishing ownership to prevent conflicts, or when deciding whether parallel writing is safe.
metadata:
  version: 1.2.0
---

# Parallel Feature Development

Strategies for decomposing features into parallel work streams, establishing file ownership boundaries, avoiding conflicts, and integrating results from multiple implementer agents.

## When to Use This Skill

- Decomposing a feature for parallel implementation
- Establishing file ownership boundaries between agents
- Designing interface contracts between parallel work streams
- Choosing integration strategies (vertical slice vs horizontal layer)
- Managing branch and merge workflows for parallel development

## File Ownership Strategies

### By Directory

Assign each implementer ownership of specific directories:

```
implementer-1: src/components/auth/
implementer-2: src/api/auth/
implementer-3: tests/auth/
```

**Best for**: Well-organized codebases with clear directory boundaries.

### By Module

Assign ownership of logical modules (which may span directories):

```
implementer-1: Authentication module (login, register, logout)
implementer-2: Authorization module (roles, permissions, guards)
```

**Best for**: Feature-oriented architectures, domain-driven design.

### By Layer

Assign ownership of architectural layers:

```
implementer-1: UI layer (components, styles, layouts)
implementer-2: Business logic layer (services, validators)
implementer-3: Data layer (models, repositories, migrations)
```

**Best for**: Traditional MVC/layered architectures.

## Conflict Avoidance Rules

### The Cardinal Rule

**One owner per file.** No file should be assigned to multiple implementers.

### When Files Must Be Shared

If a file genuinely needs changes from multiple implementers:

1. **Designate a single owner** — One implementer owns the file
2. **Other implementers request changes** — Message the owner with specific change requests
3. **Owner applies changes sequentially** — Prevents merge conflicts
4. **Alternative: Extract interfaces** — Create a separate interface file that the non-owner can import without modifying

### Interface Contracts

When implementers need to coordinate at boundaries:

```typescript
// src/types/auth-contract.ts (owned by parent/designated owner, read-only for implementers)
export interface AuthResponse {
  token: string;
  user: UserProfile;
  expiresAt: number;
}

export interface AuthService {
  login(email: string, password: string): Promise<AuthResponse>;
  register(data: RegisterData): Promise<AuthResponse>;
}
```

Both implementers import from the contract file but neither modifies it.

## Writer Barrier

Freeze task scope, acceptance, and every shared contract before starting consumer writers. Open the Writer Barrier only when each writer has:

- `goal`, `scope`, `acceptance`, and `handoff`;
- disjoint `write_scope` plus explicit `forbidden_scope`;
- accepted `depends_on` inputs and declared `produces` outputs;
- an optional `first_checkpoint` defined as a failing test or minimum diff when risk, shared state, or uncertain ownership justifies an intermediate inspection;
- a known final consumer and integration check.

Keep work sequential when a shared file, shared state owner, or interface is unresolved. Independent worktrees isolate files but do not replace contract freeze.

On Codex, the root parent selects each frozen stream's model and effort: Luna `low` for mechanical edits or known tests, Luna `medium` for ordinary bounded implementation, Luna `high` for fixed but complex code paths, and Terra `medium` or `high` when hard reasoning remains inside the frozen contract. If ambiguity can still change ownership or a shared contract, keep the decision in the parent and leave the Writer Barrier closed. If Luna appears to need `xhigh` or `max`, route the stream to Terra.

The root parent owns worker routing. Call `list_agents` before a new worker and use `followup_task` only for an idle direct child with the same role, model, effort, scope, unchanged write scope, and an accepted prior result; otherwise call `spawn_agent` with built-in `worker` plus the selected `model` and `reasoning_effort`. Track `reuse_count` for diagnostics only; it never makes an otherwise compatible worker ineligible. Model overrides require isolated or bounded history, so use `fork_context: false` on V1/App or `fork_turns: "none"` on MultiAgentV2/CLI unless a minimum supported recent-history fork is essential. Treat a new worker as started only after `spawn_agent` returns a nonempty agent id. Call `wait_agent` only while that child is active without a handoff; an arrived handoff satisfies the join. Require a worker to stop at `first_checkpoint` only when its contract declares one; otherwise let it complete the bounded contract in one turn. Inspect the actual diff and state ownership before using `followup_task` to continue the unchanged contract. Use `send_message` to correct a running worker, change approach when the same failure repeats without progress, use a bounded `wait_agent` at join points, and `interrupt_agent` when a running branch must stop. Legacy hosts may expose `send_input` and `close_agent` as equivalent controls. Keep the parent agent responsible for cross-stream integration and final-consumer verification.

Use at most four concurrent workers. Reuse compatible idle workers and synthesize accepted branches before expanding, but do not impose a fixed total-spawn or wait-count limit that can block completion. A worker normally returns a decomposition request and may create bounded descendants only when its current contract sets `descendant_delegation: parent_authorized`. Every descendant remains inside the inherited goal, scope, and write boundary, reports to its immediate parent, and cannot assign sibling or root-level work. There is no fixed descendant count or depth; every spawn remains subject to the shared four-concurrent-worker ceiling and a fresh explicit contract. Return a concise handoff covering `status`, `summary`, `evidence`, `changes`, `validation`, and `gaps`; JSON is optional and bulky evidence belongs in artifacts.

## Integration Patterns

### Vertical Slice

Each implementer builds a complete feature slice (UI + API + tests):

```
implementer-1: Login feature (login form + login API + login tests)
implementer-2: Register feature (register form + register API + register tests)
```

**Pros**: Each slice is independently testable, minimal integration needed.
**Cons**: May duplicate shared utilities, harder with tightly coupled features.

### Horizontal Layer

Each implementer builds one layer across all features:

```
implementer-1: All UI components (login form, register form, profile page)
implementer-2: All API endpoints (login, register, profile)
implementer-3: All tests (unit, integration, e2e)
```

**Pros**: Consistent patterns within each layer, natural specialization.
**Cons**: More integration points, layer 3 depends on layers 1 and 2.

### Hybrid

Mix vertical and horizontal based on coupling:

```
implementer-1: Login feature (vertical slice — UI + API + tests)
implementer-2: Shared auth infrastructure (horizontal — middleware, JWT utils, types)
```

**Best for**: Most real-world features with some shared infrastructure.

## Branch Management

### Single Branch Strategy

All implementers work on the same feature branch:

- Simple setup, no merge overhead
- Requires strict file ownership to avoid conflicts
- Best for: small teams (2-3), well-defined boundaries

### Multi-Branch Strategy

Each implementer works on a sub-branch:

```
feature/auth
  ├── feature/auth-login      (implementer-1)
  ├── feature/auth-register    (implementer-2)
  └── feature/auth-tests       (implementer-3)
```

- More isolation, explicit merge points
- Higher overhead, merge conflicts still possible in shared files
- Best for: larger teams (4+), complex features

## Troubleshooting

**Implementers are blocking each other waiting for shared code.**
Extract the shared piece into its own interface contract file owned by the parent or a designated writer. Freeze and accept it before consumer writers start; consumers import it without modification.

**Merge conflicts appear even with clear ownership rules.**
A file was assigned to two agents, or a config/index file (e.g., `index.ts`, `__init__.py`) that auto-imports everything was modified by both. Designate one owner for all barrel/index files, or have the parent merge them after writers stop.

**An implementer finishes early but the integration step is blocked.**
Use a staging interface: the finished implementer writes a stub or mock of the downstream dependency so the other implementer can continue working. Replace with the real implementation at integration time.

**The feature decomposition turned out wrong mid-stream.**
Stop new work, have the parent redistribute files, and send an explicit contract update. Sunk cost on partially written code is acceptable — continuing with the wrong split is worse.

**Tests written by one implementer fail against code written by another.**
Interface contracts drifted: the implementer who owns the API changed a signature without notifying the test implementer. Enforce the rule that contract files require a broadcast before modification.

## Related Skills

- [team-composition-patterns](../team-composition-patterns/SKILL.md) — Choose the right team size and agent types before decomposing work
- [team-communication-protocols](../team-communication-protocols/SKILL.md) — Coordinate integration handoffs and plan approvals between implementers
