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
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.dirname(HERE)  # adapters/pi
WORKFLOWS = os.path.join(ADAPTER, "workflows")
POLICIES = os.path.join(ADAPTER, "policies")
SKILL_MD = os.path.join(ADAPTER, "skills", "agent-teams-workflow", "SKILL.md")


def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _run_workflow(testcase, workflow_name, workflow_args, harness):
    """Execute one real workflow script with deterministic host doubles.

    The workflow source stays untouched: only the Pi host functions are
    supplied by the generated Node harness.  Tests control deferred branches
    by resolving an explicit promise, so no wall-clock sleep or race is
    involved in asserting a join barrier.
    """
    node = shutil.which("node")
    if not node:
        testcase.skipTest("node not available")
    source = read_text(os.path.join(WORKFLOWS, workflow_name))
    node_script = textwrap.dedent(
        f"""
        const workflowSource = {json.dumps(source)};
        const workflowArgs = {json.dumps(workflow_args)};
        const phases = [];
        const phase = (name) => phases.push(name);
        const workflowFactory = new Function(
          "args",
          "phase",
          "parallel",
          "agent",
          "return (async () => {{\\n" +
            workflowSource.replace("export const meta", "const meta") +
            "\\n}})();",
        );

        {textwrap.dedent(harness)}
        """
    )
    proc = subprocess.run(
        [node, "--input-type=module"],
        input=node_script,
        capture_output=True,
        text=True,
        timeout=10,
    )
    testcase.assertEqual(
        0,
        proc.returncode,
        f"{workflow_name} runtime harness failed:\nstdout={proc.stdout}\nstderr={proc.stderr}",
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        testcase.fail(f"{workflow_name} runtime harness did not return JSON: {proc.stdout!r}: {exc}")


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

    def test_inline_receipt_schemas_match_policy(self):
        """Inline receiptSchema copies must not drift from the policy file.

        Workflow scripts cannot import at runtime, so explore/feature keep an
        inline copy of policies/result-receipt.schema.json. The policy file is
        the single source of truth; this test pins the copies field-for-field.
        """
        policy = json.loads(read_text(os.path.join(POLICIES, "result-receipt.schema.json")))
        expected_required = policy["required"]
        expected_props = set(policy["properties"].keys())
        for name in ("agent-teams-explore.js", "agent-teams-feature.js"):
            source = read_text(os.path.join(WORKFLOWS, name))
            block = re.search(r"const receiptSchema = \{(.*?)\n\};", source, re.S)
            self.assertIsNotNone(block, f"{name} must define an inline receiptSchema")
            body = block.group(1)
            required_match = re.search(r"required:\s*\[([^\]]+)\]", body)
            self.assertIsNotNone(required_match, f"{name} receiptSchema lacks required")
            actual_required = re.findall(r'"([^"]+)"', required_match.group(1))
            self.assertEqual(expected_required, actual_required, f"{name} receiptSchema.required drifted from policy")
            for prop in expected_props:
                self.assertIn(f"{prop}: {{", body, f"{name} receiptSchema missing property {prop}")
            self.assertIn('enum: ["completed", "partial", "blocked"]', body)
        # synthesis and integration reuse the shared inline schema rather than a subset
        feature = read_text(os.path.join(WORKFLOWS, "agent-teams-feature.js"))
        self.assertIn('label: "integrate-feature",\n          schema: receiptSchema', feature)
        explore = read_text(os.path.join(WORKFLOWS, "agent-teams-explore.js"))
        self.assertIn('label: "synthesize-exploration", schema: receiptSchema', explore)

    def test_agent_prompts_carry_contract_labels(self):
        """Every delegated agent() prompt carries goal/scope/acceptance/handoff.

        Static approximation: each contract label must appear at least as many
        times as there are agent( call sites (prompt builders included).
        """
        for name in ("agent-teams-explore.js", "agent-teams-review.js", "agent-teams-feature.js"):
            source = read_text(os.path.join(WORKFLOWS, name))
            agent_calls = source.count("agent(")
            for label in ("goal:", "scope:", "acceptance:", "handoff:"):
                self.assertGreaterEqual(
                    source.count(label),
                    agent_calls,
                    f"{name} has {agent_calls} agent( calls but only {source.count(label)} '{label}' labels",
                )

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
        self.assertIn("every started checkpoint writer remains", source)
        self.assertIn("independent of receipt status or", source)
        self.assertNotIn("mentionsDeclared", source)
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


class PiAdapterRuntimeTest(unittest.TestCase):
    """Exercise real preset scripts at their host await joins.

    These tests intentionally mock only the Pi runtime boundary.  A deferred
    child remains unresolved until the harness explicitly releases it, making
    an early synthesis/dedup/review call observable without timing sleeps.
    """

    def test_explore_waits_for_slow_source_before_synthesis(self):
        harness = """
        const calls = [];
        let releaseSlow;
        let slowReleased = false;
        const slowBranch = new Promise((resolve) => { releaseSlow = resolve; });
        const receipt = (summary) => ({
          status: "completed",
          summary,
          evidence: [`evidence:${summary}`],
          changes: [],
          validation: [`validation:${summary}`],
          gaps: [],
        });
        const agent = async (_prompt, options) => {
          calls.push(options.label);
          if (options.label === "explore:0:fast") return receipt("fast");
          if (options.label === "explore:1:slow") return slowBranch;
          if (options.label === "synthesize-exploration") {
            if (!slowReleased) throw new Error("synthesis started before slow source joined");
            return receipt("synthesis");
          }
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));

        const running = workflowFactory(workflowArgs, phase, parallel, agent);
        await Promise.resolve();
        if (JSON.stringify(calls) !== JSON.stringify(["explore:0:fast", "explore:1:slow"])) {
          throw new Error(`unexpected calls while slow branch is pending: ${JSON.stringify(calls)}`);
        }
        slowReleased = true;
        releaseSlow(receipt("slow"));
        const result = await running;
        if (result.complete !== true) throw new Error("explore did not complete after all branches joined");
        if (JSON.stringify(calls) !== JSON.stringify([
          "explore:0:fast",
          "explore:1:slow",
          "synthesize-exploration",
        ])) throw new Error(`unexpected final call order: ${JSON.stringify(calls)}`);
        console.log(JSON.stringify({ calls, phases, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-explore.js",
            {
                "question": "join all sources",
                "sources": [{"id": "fast"}, {"id": "slow"}],
                "concurrency": 2,
            },
            harness,
        )
        self.assertEqual(
            ["fast", "slow"],
            [entry["id"] for entry in payload["result"]["ledger"]],
        )

    def test_explore_explicit_null_branch_preserves_failure_ledger(self):
        harness = """
        const calls = [];
        const receipt = (summary) => ({
          status: "completed",
          summary,
          evidence: [`evidence:${summary}`],
          changes: [],
          validation: [`validation:${summary}`],
          gaps: [],
        });
        const agent = async (_prompt, options) => {
          calls.push(options.label);
          if (options.label === "explore:0:ok") return receipt("ok");
          if (options.label === "explore:1:failed") return null;
          if (options.label === "synthesize-exploration") return receipt("synthesis");
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));
        const result = await workflowFactory(workflowArgs, phase, parallel, agent);
        if (JSON.stringify(result.failures) !== JSON.stringify(["failed"])) {
          throw new Error(`failure ledger changed: ${JSON.stringify(result.failures)}`);
        }
        if (result.ledger[1].status !== "failed" || result.ledger[1].receipt !== null) {
          throw new Error("explicit null branch was not retained as failed coverage");
        }
        if (result.complete !== false) throw new Error("failed branch incorrectly produced complete=true");
        if (result.synthesis === null) throw new Error("synthesis should still run after joined null result");
        console.log(JSON.stringify({ calls, phases, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-explore.js",
            {
                "question": "retain explicit failure",
                "sources": [{"id": "ok"}, {"id": "failed"}],
                "concurrency": 2,
            },
            harness,
        )
        self.assertEqual(["failed"], payload["result"]["failures"])
        self.assertFalse(payload["result"]["complete"])

    def test_review_waits_for_slow_reviewer_before_dedup_and_verification(self):
        harness = """
        const calls = [];
        let releaseSlow;
        let slowReleased = false;
        const slowReviewer = new Promise((resolve) => { releaseSlow = resolve; });
        const review = (dimension) => ({
          status: "completed",
          verdict: "pass",
          findings: [],
          uncovered: [],
        });
        const agent = async (_prompt, options) => {
          calls.push(options.label);
          if (options.label === "review:0:correctness") return review("correctness");
          if (options.label === "review:1:architecture") return slowReviewer;
          if (options.label === "dedup-findings") {
            if (!slowReleased) throw new Error("dedup started before all reviewers joined");
            return { findings: [], totals: { critical: 0, high: 0, medium: 0, low: 0 } };
          }
          if (options.label === "final-verifier") {
            return { status: "completed", verdict: "pass", confirmed: [], reason: "verified" };
          }
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));

        const running = workflowFactory(workflowArgs, phase, parallel, agent);
        await Promise.resolve();
        if (JSON.stringify(calls) !== JSON.stringify([
          "review:0:correctness",
          "review:1:architecture",
        ])) throw new Error(`unexpected calls while reviewer is pending: ${JSON.stringify(calls)}`);
        slowReleased = true;
        releaseSlow(review("architecture"));
        const result = await running;
        if (result.complete !== true || result.status !== "completed") {
          throw new Error("review did not complete after all reviewers joined");
        }
        if (JSON.stringify(calls) !== JSON.stringify([
          "review:0:correctness",
          "review:1:architecture",
          "dedup-findings",
          "final-verifier",
        ])) throw new Error(`unexpected final call order: ${JSON.stringify(calls)}`);
        console.log(JSON.stringify({ calls, phases, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-review.js",
            {
                "target": "repo",
                "snapshot": "commit-1",
                "dimensions": ["correctness", "architecture"],
            },
            harness,
        )
        self.assertEqual("completed", payload["result"]["status"])

    def test_feature_waits_for_slow_producer_before_consumer_wave(self):
        harness = """
        const calls = [];
        let releaseProducer;
        let producerReleased = false;
        const producerBranch = new Promise((resolve) => { releaseProducer = resolve; });
        const receipt = (summary) => ({
          status: "completed",
          summary,
          evidence: [`evidence:${summary}`],
          changes: [],
          validation: [`validation:${summary}`],
          gaps: [],
        });
        const plan = {
          writers: [
            {
              id: "producer",
              goal: "produce contract",
              scope: "src",
              acceptance: ["producer accepted"],
              write_scope: ["src"],
              forbidden_scope: ["tests"],
              depends_on: [],
              produces: ["contract"],
              consumes: [],
              produces_contracts: [0],
            },
            {
              id: "consumer",
              goal: "consume contract",
              scope: "tests",
              acceptance: ["consumer accepted"],
              write_scope: ["tests"],
              forbidden_scope: ["src"],
              depends_on: ["contract"],
              produces: ["tests"],
              consumes: [0],
              produces_contracts: [],
            },
          ],
          shared_contracts: ["contract"],
          integration: "integrate contract",
        };
        const agent = async (_prompt, options) => {
          calls.push(options.label);
          if (options.label === "plan-feature") return plan;
          if (options.label === "writer:0:producer") return producerBranch;
          if (options.label === "writer:1:consumer") {
            if (!producerReleased) throw new Error("consumer started before producer joined");
            return receipt("consumer");
          }
          if (options.label.startsWith("review:")) return { verdict: "pass", findings: [] };
          if (options.label === "integrate-feature") return receipt("integration");
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));

        const running = workflowFactory(workflowArgs, phase, parallel, agent);
        await Promise.resolve();
        if (JSON.stringify(calls) !== JSON.stringify(["plan-feature", "writer:0:producer"])) {
          throw new Error(`unexpected calls while producer is pending: ${JSON.stringify(calls)}`);
        }
        producerReleased = true;
        releaseProducer(receipt("producer"));
        const result = await running;
        if (result.complete !== true) throw new Error("feature did not complete after writer waves joined");
        if (result.writerLedger[1].status !== "completed") throw new Error("consumer writer did not run");
        console.log(JSON.stringify({ calls, phases, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-feature.js",
            {"brief": "feature", "repoRoot": "/tmp/repo", "concurrency": 2},
            harness,
        )
        self.assertTrue(payload["result"]["complete"])

    def test_feature_plan_and_writer_receive_bounded_leaf_work_rules(self):
        harness = """
        const prompts = {};
        const receipt = (summary) => ({
          status: "completed",
          summary,
          evidence: [`evidence:${summary}`],
          changes: [`change:${summary}`],
          validation: [`validation:${summary}`],
          gaps: [],
        });
        const plan = {
          writers: [{
            id: "leaf",
            goal: "implement one behavior",
            scope: "src/feature.js",
            acceptance: ["targeted check passes"],
            write_scope: ["src/feature.js"],
            forbidden_scope: ["tests/", "src/other.js"],
            depends_on: [],
            produces: ["feature behavior"],
            consumes: [],
            produces_contracts: [],
          }],
          shared_contracts: [],
          integration: "integrate the feature",
        };
        const agent = async (prompt, options) => {
          if (options.label === "plan-feature") {
            prompts.plan = prompt;
            return plan;
          }
          if (options.label === "writer:0:leaf") {
            prompts.writer = prompt;
            return receipt("writer");
          }
          if (options.label.startsWith("review:")) return { verdict: "pass", findings: [] };
          if (options.label === "integrate-feature") return receipt("integration");
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));
        const result = await workflowFactory(workflowArgs, phase, parallel, agent);
        console.log(JSON.stringify({ prompts, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-feature.js",
            {"brief": "implement a bounded feature", "repoRoot": "/tmp/repo"},
            harness,
        )
        self.assertTrue(payload["result"]["complete"])
        plan_prompt = payload["prompts"]["plan"]
        writer_prompt = payload["prompts"]["writer"]
        for rule in (
            "one independently testable behavior",
            "Freeze shared contracts",
            "new goal",
            "wider write_scope",
            "unauthorized side effect",
            "repeated failure without new evidence",
            "first_checkpoint only when high risk or uncertain ownership",
            "must not accumulate new goals",
            "Stop with status blocked",
            "Use status partial only when implementation is complete",
        ):
            self.assertIn(rule, plan_prompt)
            self.assertIn(rule, writer_prompt)
        self.assertIn("write_scope: src/feature.js", writer_prompt)
        self.assertIn("run targeted validation", writer_prompt)
        self.assertIn("repair failures caused by its own changes", writer_prompt)
        self.assertIn("Do not pause for an intermediate checkpoint", writer_prompt)
        self.assertIn("first_checkpoint: not required", writer_prompt)

    def test_feature_preserves_user_limits_when_planner_omits_them(self):
        # Reproduce the native canary: planning retained behavior but lost the
        # exact command and generated-file restrictions before later phases.
        harness = """
        const prompts = {};
        const writer = (id, path) => ({
          id, goal: "fix behavior", scope: path,
          acceptance: ["behavior works"], write_scope: [path],
          forbidden_scope: [id === "a" ? "src/b.py" : "src/a.py"],
          depends_on: [], produces: [path], consumes: [], produces_contracts: [],
        });
        const good = [writer("a", "src/a.py"), writer("b", "src/b.py")];
        const receipt = () => ({status: "completed", summary: "done",
          evidence: ["observed extra cache file"], changes: [], validation: [], gaps: []});
        const agent = async (prompt, options) => {
          prompts[options.label] = prompt;
          if (options.label === "plan-feature") return {
            writers: workflowArgs.repair ? [good[0], {...good[1], write_scope:["src/a.py"]}] : good,
            shared_contracts: [], integration: "run tests",
          };
          if (options.label === "freeze-contracts") return {writers: good, shared_contracts: []};
          if (options.label.startsWith("review:")) return {verdict:"pass", findings:[]};
          return receipt();
        };
        const parallel = async (tasks) => Promise.all(tasks.map(t => t()));
        const result = await workflowFactory(workflowArgs, phase, parallel, agent);
        console.log(JSON.stringify({prompts, result}));
        """
        brief = ('Fix two behaviors. Only integration may run '
                 '`PYTHONDONTWRITEBYTECODE=1 python3 test_value.py`. '
                 'No other validation commands or new files, including caches.')
        for repair in (False, True):
            with self.subTest(repair=repair):
                payload = _run_workflow(self, "agent-teams-feature.js",
                    {"brief": brief, "repoRoot": "/tmp/repo", "repair": repair}, harness)
                self.assertTrue(payload["result"]["complete"])
                prompts = payload["prompts"]
                if repair:
                    self.assertIn("freeze-contracts", prompts)
                for label, prompt in prompts.items():
                    self.assertIn(brief, prompt, label)
                for label in ("review:0:correctness", "review:1:contract", "integrate-feature"):
                    self.assertIn('"write_scope":["src/a.py"]', prompts[label])
                    self.assertIn("observed extra cache file", prompts[label])

    def test_feature_checkpoint_receipts_cannot_release_consumers_or_integration(self):
        harness = """
        const calls = [];
        const prompts = {};
        const receipt = (status, summary) => ({
          status,
          summary,
          evidence: [`evidence:${summary}`],
          changes: [`change:${summary}`],
          validation: ["contract ready"],
          gaps: status === "partial" ? ["external validation remains"] : [],
        });
        const plan = {
          writers: [
            {
              id: "producer",
              goal: "implement one behavior to the contract checkpoint",
              scope: "src/producer.js",
              acceptance: ["checkpoint evidence returned"],
              write_scope: ["src/producer.js"],
              forbidden_scope: ["tests/"],
              depends_on: [],
              produces: ["contract"],
              consumes: [],
              produces_contracts: [0],
              first_checkpoint: "contract ready",
            },
            {
              id: "consumer",
              goal: "implement the dependent behavior",
              scope: "tests/consumer.js",
              acceptance: ["consumer validation passes"],
              write_scope: ["tests/consumer.js"],
              forbidden_scope: ["src/producer.js"],
              depends_on: ["contract"],
              produces: ["consumer"],
              consumes: [0],
              produces_contracts: [],
            },
          ],
          shared_contracts: ["contract"],
          integration: "integrate producer and consumer",
        };
        const agent = async (prompt, options) => {
          calls.push(options.label);
          if (options.label === "plan-feature") return plan;
          if (options.label === "writer:0:producer") {
            prompts.writer = prompt;
            return receipt(workflowArgs.receiptStatus, "producer checkpoint");
          }
          if (options.label === "writer:1:consumer") throw new Error("checkpoint released consumer without parent acceptance");
          if (options.label.startsWith("review:")) throw new Error("checkpoint reached review without parent acceptance");
          if (options.label === "integrate-feature") throw new Error("checkpoint reached integration without parent acceptance");
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));
        const result = await workflowFactory(workflowArgs, phase, parallel, agent);
        console.log(JSON.stringify({ calls, prompts, result }));
        """
        for status in ("completed", "partial"):
            with self.subTest(checkpoint_receipt_status=status):
                payload = _run_workflow(
                    self,
                    "agent-teams-feature.js",
                    {"brief": "feature with a risk checkpoint", "repoRoot": "/tmp/repo", "receiptStatus": status},
                    harness,
                )
                result = payload["result"]
                self.assertEqual(["plan-feature", "writer:0:producer"], payload["calls"])
                self.assertEqual("blocked", result["writerLedger"][0]["status"])
                self.assertEqual("not_started", result["writerLedger"][1]["status"])
                self.assertEqual(["producer"], result["checkpointFailures"])
                self.assertIn("Stop at this declared checkpoint", payload["prompts"]["writer"])
                self.assertFalse(result["complete"])
                self.assertIsNone(result["integration"])

    def test_feature_ordinary_partial_validation_still_unblocks_consumer(self):
        harness = """
        const calls = [];
        const receipt = (status, summary) => ({
          status,
          summary,
          evidence: [`evidence:${summary}`],
          changes: [`change:${summary}`],
          validation: status === "partial" ? ["external validator unavailable"] : ["consumer tests pass"],
          gaps: status === "partial" ? ["external validator unavailable"] : [],
        });
        const plan = {
          writers: [
            {
              id: "producer",
              goal: "complete producer code; external validation is unavailable",
              scope: "src/producer.js",
              acceptance: ["implementation is complete and validation gap is reported"],
              write_scope: ["src/producer.js"],
              forbidden_scope: ["tests/"],
              depends_on: [],
              produces: ["contract"],
              consumes: [],
              produces_contracts: [0],
            },
            {
              id: "consumer",
              goal: "implement the dependent behavior",
              scope: "tests/consumer.js",
              acceptance: ["consumer tests pass"],
              write_scope: ["tests/consumer.js"],
              forbidden_scope: ["src/producer.js"],
              depends_on: ["contract"],
              produces: ["consumer"],
              consumes: [0],
              produces_contracts: [],
            },
          ],
          shared_contracts: ["contract"],
          integration: "integrate both completed code streams",
        };
        const agent = async (_prompt, options) => {
          calls.push(options.label);
          if (options.label === "plan-feature") return plan;
          if (options.label === "writer:0:producer") return receipt("partial", "producer");
          if (options.label === "writer:1:consumer") return receipt("completed", "consumer");
          if (options.label.startsWith("review:")) return { verdict: "pass", findings: [] };
          if (options.label === "integrate-feature") return receipt("completed", "integration");
          throw new Error(`unexpected agent call: ${options.label}`);
        };
        const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));
        const result = await workflowFactory(workflowArgs, phase, parallel, agent);
        console.log(JSON.stringify({ calls, result }));
        """
        payload = _run_workflow(
            self,
            "agent-teams-feature.js",
            {"brief": "feature with an external validation gap", "repoRoot": "/tmp/repo"},
            harness,
        )
        result = payload["result"]
        self.assertIn("writer:1:consumer", payload["calls"])
        self.assertIn("integrate-feature", payload["calls"])
        self.assertEqual(["producer"], result["partialWriters"])
        self.assertEqual([], result["checkpointFailures"])
        self.assertTrue(result["complete"])


if __name__ == "__main__":
    unittest.main()
