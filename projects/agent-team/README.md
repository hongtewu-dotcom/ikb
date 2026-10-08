# Agent Team

Bounded delegation for Codex native subagents and Pi dynamic workflows. The Codex adapter is version **2.1.8**. This directory is a reviewed source snapshot; private runtime evidence, local configuration and historical reports are not distributed.

The parent owns the user goal, branch contracts and final acceptance. Keep small or tightly coupled work in the parent. Delegate independently verifiable work with explicit file ownership. Workers may implement and repair within that boundary; new goals or changed shared contracts return to the parent.

The current update forwards the original task constraints through Pi planning, contract repair, writers, review and integration. Command, file and side-effect restrictions take precedence over generic validation instructions. Review functional behavior and constraint compliance separately. These instructions are not a filesystem sandbox.

## Source and build

- `plugins/agent-teams/`: shared policies and Codex/Pi adapters.
- `tools/`: package generators, validators and the optional cross-host `agent-call` CLI.
- `plugins/agent-teams/evals/`: synthetic behavior fixtures.

Requirements: Python 3.12+, uv, and Node.js for workflow runtime tests.

```sh
cd projects/agent-team
make test
make validate-codex
make generate-pi
```

Codex output is `dist/codex-marketplace/`; Pi output is `.pi/packages/agent-teams/`. Generation does not install either package. Source reference symlinks are materialized into regular files in generated packages. Install through the host's existing plugin/package mechanism, then verify a new task. The Pi source manifest retains its historical version; compare generated file contents when validating updates.

The optional delivery-feedback integration uses an existing local IKB CLI or `AGENT_TEAM_EVAL_CLI`; its absence does not block delegation. No collector or second runtime is installed by this project. Host-specific model availability must be checked locally.

## Validation scope

The reviewed snapshot passes 67 tests and 4 subtests. Local native canaries exercised bounded writers, checkpoint blocking and small-task routing; their private records are not included here. A Pi canary changed a comment while copying the preset, so byte-for-byte preset execution was not verified by that run. Test success does not establish long-term efficiency or universal instruction compliance.

## License

The initial plugin originated from [wshobson/agents](https://github.com/wshobson/agents). Local evolution preserves the MIT [LICENSE](LICENSE) and original attribution.
