# agent-teams → Pi adapter

## Current native Pi package

`make generate HARNESS=pi` packages the native Pi workflow Skill plus the
`agent_teams_branch` TypeScript extension at `.pi/packages/agent-teams/`.
Install it with `pi install ./.pi/packages/agent-teams` and reload Pi. The
extension runs isolated `pi --mode json -p --no-session` child processes;
Pi does not provide native subagents, commands, MCP, or background bash.

The `workflows/*.js` files below are legacy `pi-dynamic-workflows` source-only
presets. They are not installed or advertised as Pi-native resources.

Carries the host-independent governance principles of `agent-teams` into
[`pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows).
The Pi extension is the execution runtime; this adapter supplies contracts,
prompts, and three bounded preset workflows. It does **not** port the Codex
hook lifecycle — pi has no `PreToolUse`/`SubagentStart`/`SubagentStop`
events, and `agent()`/`parallel()` already own execution.

## Layout

```text
adapters/pi/
├── policies/                        # JSON Schema contracts
│   ├── spawn-contract.schema.json   # goal/scope/acceptance/handoff (all branches)
│   ├── writer-contract.schema.json  # + write_scope/forbidden_scope/depends_on/produces; optional checkpoint
│   └── result-receipt.schema.json   # six-field receipt without size-based rejection
├── prompts/                         # (reserved) reusable branch prompt templates
├── skills/agent-teams-workflow/
│   └── SKILL.md                     # how to run the presets and honor the principles
├── workflows/
│   ├── agent-teams-explore.js       # read-only multi-source evidence join
│   ├── agent-teams-review.js        # frozen-snapshot multi-dim review + dedup + verifier
│   └── agent-teams-feature.js       # plan → writer barrier → parallel write → review → integrate
└── tests/
    └── test_pi_adapter.py           # static validation (schemas, JS syntax, SKILL refs)
```

## How to use

From a Pi session, pass one of the preset scripts as `script` to the
`workflow` tool, or adapt the pattern into a task-specific script:

```text
workflow:
  script: <contents of adapters/pi/workflows/agent-teams-explore.js>
  args: { "question": "...", "sources": [{ "id": "s1", "path": "..." }] }
  maxAgents: 4
  concurrency: 2
```

Presets read `args` for their input; every script validates and bounds the
input before fan-out and returns a plain JSON result with a complete
coverage ledger (failed/null ids preserved).

## Governance guarantees (runtime-enforced by these scripts)

- **Spawn contract**: every branch prompt carries goal/scope/acceptance/
  handoff (writers add write_scope/forbidden_scope/depends_on/produces and use
  first_checkpoint only when intermediate inspection is materially safer).
- **Receipt shape**: every `agent()` result is validated against the
  six-field receipt schema before JavaScript reads fields; `null` is
  recorded as missing coverage, never filtered silently.
- **Writer barrier**: `agent-teams-feature` refuses to start writers until
  every declared shared contract is owned by at least one writer (as a
  consumer via depends_on or a producer via produces); an empty contract list
  is valid for truly independent streams,
  write scopes are disjoint (one owner per file) with each forbidden_scope
  covering all peer scopes, and every writer carries acceptance + handoff; a
  correction pass re-freezes unsafe decompositions. When a writer contract
  declares first_checkpoint, that checkpoint must pass before review/integration
  can start; ordinary bounded writers may finish in one pass.
- **Review barrier**: `agent-teams-review` joins all read-only reviewers on
  one frozen snapshot before deduplication; partial/blocked reviewers count
  as execution failures. One final verifier always runs against the latest
  snapshot and blocking criteria — never skipped on zero findings, and never
  replaced by a fabricated pass. Reviewer completion never implies a passing
  verdict (`status` vs `verdict` are separate fields).
- **Bounded concurrency**: run at most 4 children concurrently. Size
  `maxAgents` to the planned graph instead of using a universal total-spawn
  ceiling; a resource budget may trigger replanning but must not prove or block
  task completion by itself.

## Not in scope

- No second runtime or persistent task ledger (pi journals runs).
- No Codex hook port.
- No auto-update of the `agent-teams` source skills; this adapter consumes
  them, it does not duplicate them.
