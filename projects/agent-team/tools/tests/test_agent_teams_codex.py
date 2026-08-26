"""Release contract for the minimal Codex Agent Team plugin."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tools.adapters.base import load_plugin, parse_frontmatter
from tools.adapters.codex import CodexAdapter
from tools.generate import clean_output


APPROVED_SKILLS = {
    "agent-team-delegate",
    "agent-team-feature",
    "agent-team-review",
}

CLAUDE_RUNTIME_TERMS = (
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "TeamCreate",
    "TeamDelete",
    "TaskCreate",
    "TaskList",
    "TaskUpdate",
    "SendMessage",
    "ExitPlanMode",
    "~/.claude/teams",
)

FIXED_MODEL_TERMS = (
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    "reasoning_effort:",
    "model_reasoning_effort",
    "fork_context:",
)


@pytest.fixture
def generated_marketplace(tmp_path: Path) -> Path:
    plugin = load_plugin("agent-teams")
    assert plugin is not None
    adapter = CodexAdapter(output_root=tmp_path)
    adapter.emit_plugin(plugin)
    adapter.emit_global([plugin])
    return tmp_path / "dist" / "codex-marketplace"


@pytest.fixture
def generated_plugin(generated_marketplace: Path) -> Path:
    return generated_marketplace / "plugins" / "agent-teams"


def _skill_text(plugin_root: Path, name: str) -> str:
    return (plugin_root / "skills" / name / "SKILL.md").read_text(encoding="utf-8")


def _tree_digest(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_codex_clean_removes_legacy_project_discovery_outputs(tmp_path: Path):
    legacy_skill = tmp_path / ".codex" / "skills" / "legacy-team" / "SKILL.md"
    legacy_skill.parent.mkdir(parents=True)
    legacy_skill.write_text("legacy\n", encoding="utf-8")
    candidate = (
        tmp_path
        / "dist"
        / "codex-marketplace"
        / "plugins"
        / "agent-teams"
        / "LICENSE"
    )
    candidate.parent.mkdir(parents=True)
    candidate.write_text("candidate\n", encoding="utf-8")

    assert clean_output("codex", tmp_path) == 2
    assert not (tmp_path / ".codex").exists()
    assert not (tmp_path / "dist" / "codex-marketplace").exists()


def test_active_source_has_no_project_local_codex_discovery_tree():
    assert not (Path(__file__).parents[2] / ".codex").exists()


def test_candidate_physically_contains_only_approved_skills(generated_plugin: Path):
    skills_root = generated_plugin / "skills"
    assert {path.name for path in skills_root.iterdir() if path.is_dir()} == APPROVED_SKILLS
    assert not (generated_plugin / "agents").exists()
    assert not (generated_plugin / "commands").exists()
    assert not (generated_plugin / "hooks").exists()
    assert not (generated_plugin / "codex-hooks").exists()


@pytest.mark.parametrize("name", sorted(APPROVED_SKILLS))
def test_candidate_skills_are_codex_only_and_inherit_the_parent_model(
    generated_plugin: Path, name: str
):
    content = _skill_text(generated_plugin, name)
    frontmatter, body = parse_frontmatter(content)

    assert frontmatter["name"] == name
    assert frontmatter["description"]
    assert len(content.encode("utf-8")) <= 8 * 1024
    for term in CLAUDE_RUNTIME_TERMS + FIXED_MODEL_TERMS:
        assert term not in content
    assert "inherit" in body.lower()
    assert 'fork_turns: "none"' in body
    assert "wait returning does not prove completion" in body
    assert "FINAL_ANSWER" in body


def test_delegate_uses_economic_and_independence_gate(generated_plugin: Path):
    skill = _skill_text(generated_plugin, "agent-team-delegate")

    for term in (
        "goal",
        "scope",
        "acceptance",
        "handoff",
        "materially reduce elapsed time or parent context pressure",
        "independent evidence streams",
        "does not by itself justify delegation",
        "fit in one bounded local read",
        "Do not spawn a writer before shared contracts are frozen",
        "Keep the work local",
        "list_agents",
        "followup_task",
        "spawn_agent",
        "wait_agent",
        "send_message",
        "interrupt_agent",
        "completed does not mean accepted",
    ):
        assert term in skill

    assert "fixed total-spawn budget" not in skill
    assert "Mandatory Delegation Preflight" not in skill
    assert "at most four" not in skill


def test_feature_has_writer_barrier_and_parent_owned_integration(generated_plugin: Path):
    skill = _skill_text(generated_plugin, "agent-team-feature")

    for term in (
        "Writer Barrier",
        "write_scope",
        "forbidden_scope",
        "depends_on",
        "produces",
        "one owner",
        "shared contracts are frozen",
        "other workers may be active",
        "preserve their changes",
        "root parent integrates",
        "final consumer",
        "Do not commit, push, deploy",
    ):
        assert term in skill


def test_review_has_frozen_snapshot_reader_repair_barrier(generated_plugin: Path):
    skill = _skill_text(generated_plugin, "agent-team-review")

    for term in (
        "Review Barrier",
        "frozen snapshot",
        "read-only",
        "same blocking criteria",
        "status=completed|blocked",
        "verdict=pass|block",
        "does not imply",
        "all readers",
        "one owner",
        "final verifier",
        "same semantic failure",
    ):
        assert term in skill


def test_routing_eval_covers_spawn_and_no_spawn_cases(generated_plugin: Path):
    eval_path = (
        Path(__file__).parents[2]
        / "plugins"
        / "agent-teams"
        / "evals"
        / "delegation-routing.json"
    )
    evaluation = json.loads(eval_path.read_text(encoding="utf-8"))
    cases = evaluation["cases"]

    assert evaluation["version"] == 1
    assert len({case["id"] for case in cases}) == len(cases)
    assert {case["expected"] for case in cases} == {"spawn", "no_spawn"}
    assert sum(case["expected"] == "spawn" for case in cases) >= 4
    assert sum(case["expected"] == "no_spawn" for case in cases) >= 4

    delegate = _skill_text(generated_plugin, "agent-team-delegate").lower()
    for case in cases:
        assert case["role"] in {"explorer", "worker", "none"}
        assert (case["expected"] == "no_spawn") == (case["role"] == "none")
        for term in case["policy_terms"]:
            assert term.lower() in delegate, (
                f"routing case {case['id']} is not represented by {term!r}"
            )


def test_behavior_eval_has_false_positive_and_parallel_cases():
    eval_path = (
        Path(__file__).parents[2]
        / "plugins"
        / "agent-teams"
        / "evals"
        / "behavior-cases.json"
    )
    cases = {
        case["id"]: case
        for case in json.loads(eval_path.read_text(encoding="utf-8"))["cases"]
    }

    assert cases["simple-read"]["candidate_spawn_max"] == 0
    assert cases["short-independent-read"]["candidate_spawn_max"] == 0
    assert cases["parallel-contract-audit"]["candidate_spawn_min"] >= 1
    assert cases["parallel-contract-audit"]["expected_findings"] == ["A1", "B3"]
    assert cases["parallel-contract-audit"]["expected_ownership_conflict"] is False


def test_manifest_is_fixed_version_and_has_no_runtime_extensions(generated_plugin: Path):
    manifest = json.loads(
        (generated_plugin / ".codex-plugin" / "plugin.json").read_text(
            encoding="utf-8"
        )
    )

    assert manifest["name"] == "agent-teams"
    assert manifest["version"] == "2.0.0"
    assert manifest["skills"] == "./skills/"
    assert manifest["interface"]["developerName"] == "IKB Agent Team"
    assert manifest["interface"]["capabilities"] == [
        "Selective delegation",
        "Disjoint parallel development",
        "Frozen-snapshot review",
    ]
    for forbidden in ("hooks", "agents", "commands", "mcpServers"):
        assert forbidden not in manifest


def test_marketplace_installs_the_generated_candidate_not_active_source(
    generated_marketplace: Path,
):
    marketplace = json.loads(
        (
            generated_marketplace / ".agents" / "plugins" / "marketplace.json"
        ).read_text(encoding="utf-8")
    )
    assert marketplace["name"] == "ikb-agent-team"
    assert marketplace["plugins"] == [
        {
            "name": "agent-teams",
            "source": {"source": "local", "path": "./plugins/agent-teams"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
            "category": "Coding",
        }
    ]

    source_manifest = (
        Path(__file__).parents[2]
        / "plugins"
        / "agent-teams"
        / ".codex-plugin"
        / "plugin.json"
    )
    assert not source_manifest.exists(), "active source must not be directly installable"


def test_generation_is_reproducible(tmp_path: Path):
    plugin = load_plugin("agent-teams")
    assert plugin is not None
    roots = [tmp_path / "first", tmp_path / "second"]
    for root in roots:
        adapter = CodexAdapter(output_root=root)
        adapter.emit_plugin(plugin)
        adapter.emit_global([plugin])

    assert _tree_digest(roots[0]) == _tree_digest(roots[1])
