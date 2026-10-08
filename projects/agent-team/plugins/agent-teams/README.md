# Agent Teams adapters

The source lives here; generated packages are not edited directly. See the [project README](../../README.md) for build requirements and validation scope.

## Codex

The adapter builds version 2.1.8 from `adapters/codex/plugin.json` and three Skills:

- `agent-team-delegate`: independent bounded branches and native handoffs.
- `agent-team-feature`: frozen shared contracts, disjoint writers and parent integration.
- `agent-team-review`: independent read-only review of a frozen target.

The package includes no custom agents, hooks, MCP server or second runtime. Roles describe responsibilities; model selection follows the host and [model policy](policies/model-policy.md). [Wait policy](policies/wait-policy.md) governs joins.

Run `make validate-codex` from the project root. Register the validated `dist/codex-marketplace` through the host's native marketplace mechanism, then install `agent-teams@ikb-agent-team`. Generation alone does not install or activate a plugin. Test a fresh task after installation.

## Pi

The [Pi adapter](adapters/pi/README.md) uses the existing dynamic-workflows runtime for explore, review and feature presets. `make generate-pi` produces `.pi/packages/agent-teams/`.

Small changes stay in the parent; a single independent branch uses the existing native call. Use the full feature preset only when multiple independent writers justify planning, review and integration. Forward user command, file and side-effect limits through every phase. Generated caches count as writes; functional success does not prove compliance.

## Interpreting results

Final acceptance and first-attempt success are different claims. Spawn/followup counts locate tasks for inspection but do not measure duplicate work or scope violations. Compare the original task with actual operations and file changes, preserve receipt gaps, and leave missing evidence unknown. Existing delivery feedback is optional; no automatic quality rate or long-term efficiency gain is claimed.

Initial upstream: [wshobson/agents](https://github.com/wshobson/agents), MIT [LICENSE](../../LICENSE). Historical private reports are not part of this snapshot.
