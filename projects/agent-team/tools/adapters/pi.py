"""Pi coding-agent package adapter.

Pi discovers Agent Skills and TypeScript extensions from a local package's
``package.json``.  It has no native agents or commands, so agents are skipped
and commands are materialized as user-invocable skills.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from tools.adapters.base import EmitResult, HarnessAdapter, PluginSource, SkillSource

_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ID_MAX = 64


def _pi_skill_id(plugin: str, leaf: str) -> str:
    """Return a Pi-valid, deterministic skill id, shortening with a hash if needed."""
    raw = f"{plugin}-{leaf}".lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
    if not normalized:
        raise ValueError(f"Pi skill id from {plugin!r}/{leaf!r} is empty")
    if len(normalized) > _ID_MAX:
        suffix = hashlib.sha256(normalized.encode()).hexdigest()[:10]
        normalized = f"{normalized[: _ID_MAX - len(suffix) - 1].rstrip('-')}-{suffix}"
    if not _ID_RE.fullmatch(normalized):
        raise ValueError(f"invalid Pi skill id: {normalized!r}")
    return normalized


def _skill_text(skill_id: str, description: str, body: str) -> str:
    return f"---\nname: {skill_id}\ndescription: {description}\n---\n\n{body.strip()}\n"


class PiAdapter(HarnessAdapter):
    harness_id = "pi"

    def emit_plugin(self, plugin: PluginSource) -> EmitResult:
        result = EmitResult()
        root = Path(".pi") / "packages" / plugin.name
        skill_paths: list[str] = []
        seen: set[str] = set()

        for skill in plugin.skills:
            skill_id = _pi_skill_id(plugin.name, skill.name)
            if skill_id in seen:
                raise ValueError(f"Pi skill id collision: {skill_id}")
            seen.add(skill_id)
            self._emit_source_skill(root, skill_id, skill, result)
            skill_paths.append(f"skills/{skill_id}/SKILL.md")

        for command in plugin.commands:
            skill_id = _pi_skill_id(plugin.name, f"command-{command.name}")
            if skill_id in seen:
                raise ValueError(f"Pi skill id collision: {skill_id}")
            seen.add(skill_id)
            description = str(command.frontmatter.get("description", f"Run {command.name}."))
            path = self.write(root / "skills" / skill_id / "SKILL.md", _skill_text(skill_id, description, command.body))
            result.written.append(path)
            skill_paths.append(f"skills/{skill_id}/SKILL.md")
            result.warnings.append(
                f"command `{plugin.name}/{command.name}` degraded to user-invocable Pi skill `{skill_id}` (Pi has no native commands)"
            )

        for agent in plugin.agents:
            result.skipped.append(f"agent:{agent.name}")
            result.warnings.append(
                f"agent `{plugin.name}/{agent.name}` skipped: Pi has no native subagent resource; use an extension-mediated workflow where supplied"
            )

        extensions: list[str] = []
        if plugin.name == "agent-teams":
            adapter_root = plugin.dir / "adapters" / "pi"
            workflow = adapter_root / "skills" / "agent-teams-workflow" / "SKILL.md"
            workflow_id = _pi_skill_id(plugin.name, "workflow")
            workflow_body = (
                "# Agent-teams Pi workflow\n\n"
                "Use the `agent_teams_branch` extension for bounded delegation. It starts an isolated "
                "child Pi process with `--mode json -p --no-session`; validate the six-field receipt "
                "and keep writer scopes disjoint. Pi has no native subagent, task, MCP, or command resource.\n"
            )
            self._emit_source_skill(root, workflow_id, SkillSource(plugin.name, workflow_id, workflow.parent, {"description": "Run bounded agent-teams branches through the Pi extension."}, workflow_body), result)
            skill_paths.append(f"skills/{workflow_id}/SKILL.md")
            extension = adapter_root / "extensions" / "agent-teams-branch.ts"
            target = self.mirror_file(extension, root / "extensions" / extension.name)
            result.written.append(target)
            extensions.append(f"extensions/{extension.name}")

        manifest = {"name": plugin.name, "version": str(plugin.plugin_json.get("version", "0.0.0")), "pi": {"skills": skill_paths}}
        if extensions:
            manifest["pi"]["extensions"] = extensions
        path = self.write(root / "package.json", json.dumps(manifest, indent=2) + "\n")
        result.written.append(path)
        return result

    def _emit_source_skill(self, root: Path, skill_id: str, skill: SkillSource, result: EmitResult) -> None:
        description = str(skill.frontmatter.get("description", f"Use {skill_id}."))
        path = self.write(root / "skills" / skill_id / "SKILL.md", _skill_text(skill_id, description, skill.body))
        result.written.append(path)
        refs = skill.dir / "references"
        if refs.is_dir():
            for source in sorted(p for p in refs.rglob("*") if p.is_file()):
                target = self.mirror_file(source, root / "skills" / skill_id / "references" / source.relative_to(refs))
                result.written.append(target)
