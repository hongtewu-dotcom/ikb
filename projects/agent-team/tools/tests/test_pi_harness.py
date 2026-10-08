"""Red-contract tests for the first-class Pi harness adapter.

Pi packages native Agent Skills plus TypeScript extensions.  It does not have
native agents, commands, task spawning, parallel agents, or MCP bundling; the
adapter must state those degradations rather than silently emitting lookalikes.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from tools.adapters.base import PluginSource
from tools.generate import _HARNESS_TARGETS, clean_output, get_adapter, prune_orphans


_PI_SKILL_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _plugin_with_reference(tmp_path: Path) -> PluginSource:
    """Create the smallest complete source plugin that exercises Pi packaging."""
    from tools.tests.conftest import _make_agent, _make_command, _make_skill

    plugin_dir = tmp_path / "demo"
    (plugin_dir / ".claude-plugin").mkdir(parents=True)
    (plugin_dir / ".claude-plugin" / "plugin.json").write_text(
        '{"name":"demo","version":"1.2.3","description":"Pi test plugin"}',
        encoding="utf-8",
    )
    skill = _make_skill(
        plugin_dir,
        "hello",
        "name: hello\ndescription: Use when greeting users.",
        "# Hello\n\nRead `references/example.md` before greeting.\n",
    )
    (skill.dir / "references").mkdir()
    (skill.dir / "references" / "example.md").write_text("Reference payload.\n", encoding="utf-8")
    agent = _make_agent(
        plugin_dir,
        "greeter",
        "name: greeter\ndescription: A legacy agent source.",
        "# Greeter\n",
    )
    command = _make_command(
        plugin_dir,
        "say-hi",
        "description: A legacy command source.",
        "# Say hi\n",
    )
    return PluginSource(
        name="demo",
        dir=plugin_dir,
        plugin_json={"name": "demo", "version": "1.2.3", "description": "Pi test plugin"},
        agents=[agent],
        skills=[skill],
        commands=[command],
    )


def test_pi_is_registered_with_truthful_capabilities():
    from tools.adapters.capabilities import CAPABILITIES, supported_harnesses

    assert "pi" in supported_harnesses()
    pi = CAPABILITIES["pi"]
    assert pi.skills_native is True
    assert pi.agents_native is False
    assert pi.commands_native is False
    assert pi.parallel_agents is False
    assert pi.task_spawn is False
    assert pi.mcp_servers is False
    # The shared matrix has no separate extensions column: Pi's TypeScript
    # extension/lifecycle mediation is represented truthfully by `hooks`.
    assert pi.hooks is True
    assert "extension" in pi.notes.lower()


def test_pi_adapter_emits_a_self_contained_skill_package(tmp_path: Path):
    plugin = _plugin_with_reference(tmp_path)
    adapter = get_adapter("pi", tmp_path / "out")

    result = adapter.emit_plugin(plugin)
    package_root = tmp_path / "out" / ".pi" / "packages" / "demo"
    manifest_path = package_root / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert manifest_path in result.written
    assert manifest["name"] == "demo"
    assert manifest["version"] == "1.2.3"
    assert set(manifest["pi"]) == {"skills"}
    assert manifest["pi"]["skills"] == [
        "skills/demo-hello/SKILL.md",
        "skills/demo-command-say-hi/SKILL.md",
    ]
    for rel_path in manifest["pi"]["skills"]:
        skill_id = Path(rel_path).parent.name
        assert _PI_SKILL_ID.fullmatch(skill_id)
        assert len(skill_id) <= 64
        assert (package_root / rel_path).is_file()
    assert (package_root / "skills" / "demo-hello" / "references" / "example.md").read_text(
        encoding="utf-8"
    ) == "Reference payload.\n"


def test_pi_degrades_agents_and_commands_with_explicit_warnings(tmp_path: Path):
    result = get_adapter("pi", tmp_path / "out").emit_plugin(_plugin_with_reference(tmp_path))
    package_root = tmp_path / "out" / ".pi" / "packages" / "demo"

    assert not (package_root / "agents").exists()
    # Commands become explicitly user-invocable skills, never Pi command resources.
    assert not (package_root / "commands").exists()
    assert (package_root / "skills" / "demo-command-say-hi" / "SKILL.md").is_file()
    warning_text = " ".join(result.warnings).lower()
    assert "agent" in warning_text
    assert "command" in warning_text


def test_agent_teams_pi_package_uses_an_extension_runner_not_native_subagents(tmp_path: Path):
    """Package keeps the interop extension runner and ships the preset assets.

    `agent_teams_branch` stays as the cross-agent interop adapter; same-host
    delegation is the packaged preset workflow path, so workflows and policies
    must be mirrored into the package.
    """
    from tools.adapters.base import load_plugin

    plugin = load_plugin("agent-teams")
    assert plugin is not None
    package_root = tmp_path / ".pi" / "packages" / "agent-teams"
    get_adapter("pi", tmp_path).emit_plugin(plugin)
    manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))

    extensions = manifest["pi"]["extensions"]
    assert extensions, "agent-teams must supply an extension-mediated Pi runner"
    extension_text = "\n".join((package_root / rel).read_text(encoding="utf-8") for rel in extensions)
    assert "export default function" in extension_text
    assert ".registerTool(" in extension_text
    assert 'name: "agent_teams_branch"' in extension_text
    assert "--mode json" in extension_text
    assert "--no-session" in extension_text
    assert "--no-extensions" in extension_text
    assert 'options.writer ? "read,write,edit,bash" : "read,grep,find,ls"' in extension_text
    assert '"--tools", tools' in extension_text
    assert "message_end" in extension_text
    assert "JSON.parse(stdout)" not in extension_text
    assert "MAX_RECEIPT_BYTES" not in extension_text
    assert "Buffer.byteLength" not in extension_text
    assert not re.search(r"\b(?:Task|subagent)\s*\(", extension_text)
    workflow_files = sorted(p.name for p in (package_root / "workflows").glob("agent-teams-*.js"))
    assert workflow_files == [
        "agent-teams-explore.js",
        "agent-teams-feature.js",
        "agent-teams-review.js",
    ], "presets are the first-class Pi path and must ship inside the package"
    for policy in ("result-receipt", "spawn-contract", "writer-contract"):
        assert (package_root / "policies" / f"{policy}.schema.json").is_file(), (
            f"policies/{policy}.schema.json must ship inside the package"
        )

    skill_paths = manifest["pi"]["skills"]
    assert skill_paths == ["skills/agent-teams-workflow/SKILL.md"], (
        "Pi package must expose exactly the self-developed workflow skill"
    )
    source_skill = (
        plugin.dir / "adapters" / "pi" / "skills" / "agent-teams-workflow" / "SKILL.md"
    ).read_text(encoding="utf-8")
    skill_text = "\n".join((package_root / rel).read_text(encoding="utf-8") for rel in skill_paths)
    assert "pi-dynamic-workflows" not in skill_text or "pi-dynamic-workflows" in source_skill
    assert not re.search(r"\b(?:Task|subagent)\s*\(", skill_text)
    assert source_skill.split("---", 2)[-1].strip() in skill_text, (
        "shipped workflow skill must carry the real source body, not a stub"
    )


def test_pi_clean_prune_and_validator_registration(tmp_path: Path):
    import tools.validate_generated as generated

    assert _HARNESS_TARGETS["pi"] == [".pi/packages"]
    assert callable(generated.validate_pi)

    generated_file = tmp_path / ".pi" / "packages" / "demo" / "package.json"
    generated_file.parent.mkdir(parents=True)
    generated_file.write_text("{}", encoding="utf-8")
    orphan = tmp_path / ".pi" / "packages" / "old" / "package.json"
    orphan.parent.mkdir(parents=True)
    orphan.write_text("{}", encoding="utf-8")
    removed = prune_orphans("pi", tmp_path, {generated_file})
    assert orphan in removed
    assert generated_file.is_file()
    assert clean_output("pi", tmp_path) == 1
    assert not (tmp_path / ".pi" / "packages").exists()


def test_pi_wait_policy_packaged_from_canonical_source(tmp_path: Path):
    from tools.adapters.base import load_plugin

    plugin = load_plugin("agent-teams")
    adapter = get_adapter("pi", tmp_path)
    adapter.emit_plugin(plugin)
    root = tmp_path / ".pi/packages/agent-teams"
    matches = list(root.glob("skills/*/references/wait-policy.md"))
    assert len(matches) == 1
    policy = matches[0]
    assert not policy.is_symlink()
    assert policy.read_bytes() == (plugin.dir / "policies/wait-policy.md").read_bytes()
    assert "references/wait-policy.md" in (policy.parent.parent / "SKILL.md").read_text()
