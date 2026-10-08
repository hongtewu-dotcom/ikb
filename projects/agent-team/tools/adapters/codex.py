"""Build the minimal, installable Codex Agent Team marketplace.

The Claude-first source tree is retained for provenance and Pi experiments, but it is
never exposed wholesale to Codex.  Codex receives a physical allowlist maintained in
``plugins/agent-teams/adapters/codex`` and copied into a release candidate under
``dist/codex-marketplace``.
"""

from __future__ import annotations

import json
from pathlib import Path

from tools.adapters.base import EmitResult, HarnessAdapter, PluginSource


class CodexAdapter(HarnessAdapter):
    """Emit a self-contained local marketplace without touching user configuration."""

    harness_id = "codex"
    candidate_root = Path("dist") / "codex-marketplace"
    approved_skills = (
        "agent-team-delegate",
        "agent-team-feature",
        "agent-team-review",
    )

    def emit_plugin(self, plugin: PluginSource) -> EmitResult:
        result = EmitResult()
        source_root = plugin.dir / "adapters" / "codex"
        manifest_source = source_root / "plugin.json"
        skills_source = source_root / "skills"

        if not manifest_source.is_file():
            raise FileNotFoundError(
                f"missing Codex manifest source: {manifest_source}"
            )

        manifest = json.loads(manifest_source.read_text(encoding="utf-8"))
        if manifest.get("name") != plugin.name:
            raise ValueError(
                f"Codex manifest name {manifest.get('name')!r} does not match "
                f"plugin {plugin.name!r}"
            )

        candidate_plugin = self.candidate_root / "plugins" / plugin.name
        result.written.append(
            self.write(
                candidate_plugin / ".codex-plugin" / "plugin.json",
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            )
        )

        actual_skills = {
            path.name
            for path in skills_source.iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        }
        expected_skills = set(self.approved_skills)
        if actual_skills != expected_skills:
            raise ValueError(
                "Codex skill allowlist mismatch: "
                f"expected {sorted(expected_skills)}, got {sorted(actual_skills)}"
            )

        for skill_name in self.approved_skills:
            skill_root = skills_source / skill_name
            for source in sorted(skill_root.rglob("*")):
                if not source.is_file():
                    continue
                relative = source.relative_to(skill_root)
                result.written.append(
                    self.mirror_file(
                        source,
                        candidate_plugin / "skills" / skill_name / relative,
                    )
                )

        license_source = plugin.dir.parents[1] / "LICENSE"
        if license_source.is_file():
            result.written.append(
                self.mirror_file(license_source, candidate_plugin / "LICENSE")
            )
        return result

    def emit_global(self, plugins: list[PluginSource]) -> EmitResult:
        result = EmitResult()
        entries = []
        for plugin in plugins:
            if not (plugin.dir / "adapters" / "codex" / "plugin.json").is_file():
                result.skipped.append(plugin.name)
                continue
            entries.append(
                {
                    "name": plugin.name,
                    "source": {
                        "source": "local",
                        "path": f"./plugins/{plugin.name}",
                    },
                    "policy": {
                        "installation": "AVAILABLE",
                        "authentication": "ON_USE",
                    },
                    "category": "Coding",
                }
            )

        marketplace = {"name": "ikb-agent-team", "plugins": entries}
        result.written.append(
            self.write(
                self.candidate_root
                / ".agents"
                / "plugins"
                / "marketplace.json",
                json.dumps(marketplace, indent=2, ensure_ascii=False) + "\n",
            )
        )
        return result
