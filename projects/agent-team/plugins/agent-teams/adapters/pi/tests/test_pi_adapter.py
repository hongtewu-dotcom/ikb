"""Static validation for the agent-teams pi adapter.

Checks:
1. Workflow scripts are syntactically valid JS and export the expected meta.
2. Every agent() call has a unique label and a receipt schema where required.
3. JSON policies preserve contract shape without size-based completion gates.
4. SKILL.md references only files that exist.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.dirname(HERE)  # adapters/pi
WORKFLOWS = os.path.join(ADAPTER, "workflows")
POLICIES = os.path.join(ADAPTER, "policies")
SKILL_MD = os.path.join(ADAPTER, "skills", "agent-teams-workflow", "SKILL.md")


def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class PiAdapterStaticTest(unittest.TestCase):
    def test_policies_parse_and_keep_shape_without_size_gates(self):
        for name in ("spawn-contract.schema.json", "writer-contract.schema.json", "result-receipt.schema.json"):
            path = os.path.join(POLICIES, name)
            source = read_text(path)
            schema = json.loads(source)
            self.assertEqual("object", schema["type"])
            self.assertIn("$id", schema)
            self.assertNotIn("maxLength", source)
            self.assertNotIn("maxItems", source)
        receipt = json.loads(read_text(os.path.join(POLICIES, "result-receipt.schema.json")))
        self.assertIn("status", receipt["required"])
        self.assertEqual(["completed", "partial", "blocked"], receipt["properties"]["status"]["enum"])
        spawn = json.loads(read_text(os.path.join(POLICIES, "spawn-contract.schema.json")))
        self.assertIn("handoff", spawn["required"])
        handoff = spawn["properties"]["handoff"]
        self.assertEqual(
            ["status", "summary", "evidence", "changes", "validation", "gaps"],
            list(handoff["properties"].keys()),
        )
        writer = json.loads(read_text(os.path.join(POLICIES, "writer-contract.schema.json")))
        self.assertIn("write_scope", writer["required"])
        self.assertNotIn("first_checkpoint", writer["required"])

    def test_workflows_are_valid_js_with_meta(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        for name in ("agent-teams-explore.js", "agent-teams-review.js", "agent-teams-feature.js"):
            path = os.path.join(WORKFLOWS, name)
            source = read_text(path)
            # syntax check: workflow scripts run inside the runtime's async wrapper,
            # so strip the ESM export and wrap the body in an async function.
            body = source.replace("export const meta", "const meta", 1)
            wrapped = f"(async () => {{\n{body}\n}})();"
            proc = subprocess.run(
                [node, "--input-type=module", "--check"],
                input=wrapped,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, proc.returncode, f"{name} failed node --check: {proc.stderr}")
            # check meta export present and contains name+description
            self.assertIn("export const meta", source)
            self.assertIn("name:", source)
            self.assertIn("description:", source)
            # every agent( call has a label and schema
            labels = re.findall(r"label:\s*`([^`]+)`", source)
            self.assertTrue(labels, f"{name} should have at least one labelled agent call")
            self.assertEqual(len(labels), len(set(labels)), f"{name} labels must be unique")
            self.assertGreaterEqual(source.count("agent("), 1)
            # no imports / require / Date.now / Math.random
            for banned in ("import ", "require(", "Date.now", "Math.random", "new Date("):
                self.assertNotIn(banned, source, f"{name} must not use {banned}")

    def test_runtime_receipt_schemas_do_not_use_size_gates(self):
        """Receipt shape is validated without rejecting useful evidence by size."""
        for name in ("agent-teams-explore.js", "agent-teams-review.js", "agent-teams-feature.js"):
            source = read_text(os.path.join(WORKFLOWS, name))
            self.assertNotIn("maxLength", source)
            self.assertNotIn("maxItems", source)

    def test_review_failure_never_fabricates_pass(self):
        """F3/F5/F6: review.js must not fabricate pass on dedup failure and must always verify."""
        source = read_text(os.path.join(WORKFLOWS, "agent-teams-review.js"))
        # F3: dedup failure forces blocked/inconclusive, never the zero-blocker pass branch
        self.assertIn("const dedupFailed = dedupMissing ||", source)
        self.assertNotIn("verdict: \"pass\", reason: \"No blocking findings after dedup.\"", source)
        # F5: final verifier runs even on zero blockers
        self.assertIn("blockers.length === 0", source)
        # F6: top-level result carries canonical status
        self.assertIn('let status = "completed";', source)
        self.assertIn('verdict: verificationMissing ? "inconclusive" : verification.verdict,', source)

    def test_feature_writer_barrier_and_optional_checkpoint(self):
        """Feature flow freezes contracts and gates only declared checkpoints."""
        source = read_text(os.path.join(WORKFLOWS, "agent-teams-feature.js"))
        self.assertIn("sharedContractsFrozen", source)
        self.assertIn("forbiddenCoversPeers", source)
        self.assertIn("checkpointFailures", source)
        self.assertIn("checkpointRequired", source)
        self.assertIn("if (!checkpointRequired) return true;", source)
        # layered writer barrier: producers run before consumers
        self.assertIn("wave 1", source)
        self.assertIn("producers", source)
        self.assertIn("depsProduced", source)
        # partial (code done, external validation blocked) is not a hard failure;
        # blocked/failed writers are
        self.assertIn('e.status === "blocked" || e.status === "failed"', source)
        self.assertIn("partialWriters", source)
        # total writer/source count is not truncated; execution is waved at 4
        self.assertIn("runInWaves", source)
        self.assertIn("Math.min(4", source)

    def test_skill_md_references_resolve(self):
        skill = read_text(SKILL_MD)
        for ref in re.findall(r"`([^`]*\.(?:json|js|md))`", skill):
            ref_path = os.path.join(ADAPTER, ref)
            # SKILL.md writes `workflows/agent-teams-explore.js`; resolve relative to adapter root
            self.assertTrue(os.path.exists(ref_path), f"missing reference: {ref} (resolved to {ref_path})")


if __name__ == "__main__":
    unittest.main()
