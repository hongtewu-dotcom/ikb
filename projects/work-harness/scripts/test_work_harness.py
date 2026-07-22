#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("work_harness.py")


def run(*args, cwd, env=None):
    process_env = os.environ.copy()
    process_env["WORK_HARNESS_EVAL_PLANE_SCRIPT"] = "off"
    if env:
        process_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=cwd,
        env=process_env,
        text=True,
        capture_output=True,
    )


def write_summary(path: Path, task_id: str, run_id: str, verdict: str = "pass", terminal_status: str = "completed"):
    path.write_text(json.dumps({
        "schema": "work-harness-run-summary-v1",
        "task_id": task_id,
        "run_id": run_id,
        "terminal_status": terminal_status,
        "verification": {"verdict": verdict, "note": "test"},
        "evidence_refs": ["artifact://test/evidence"],
        "artifact_refs": ["nodes/inspect/handoff.json"],
        "knowledge_refs": [],
        "correction_signals": [{
            "kind": "retry",
            "reason_code": "test_retry",
            "evidence_refs": ["artifact://test/evidence"],
        }],
    }), encoding="utf-8")


def prepare_task_for_verify(tmp: str, task_id: str, verdict: str = "pass") -> Path:
    root = Path(tmp) / ".agent-work"
    result = run("init", "--task-id", task_id, "--objective", task_id, "--root", str(root), cwd=tmp)
    assert result.returncode == 0, result.stdout + result.stderr
    summary = Path(tmp) / f"{task_id}-summary.json"
    terminal_status = "completed" if verdict == "pass" else "failed"
    write_summary(summary, task_id, f"run-{task_id}", verdict=verdict, terminal_status=terminal_status)
    task_dir = root / task_id
    result = run("record-summary", str(task_dir), "--file", str(summary), cwd=tmp)
    assert result.returncode == 0, result.stdout + result.stderr
    return task_dir


def fake_evaluator_env(tmp: str, stdout: str, returncode: int = 0, stderr: str = ""):
    root = Path(tmp)
    evaluator = root / "work-eval-cli.ts"
    evaluator.write_text("// fake evaluator entrypoint\n", encoding="utf-8")
    bin_dir = root / "bin"
    bin_dir.mkdir(exist_ok=True)
    node = bin_dir / "node"
    node.write_text(
        f"#!{sys.executable}\n"
        "import fcntl\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        "args_path = os.environ.get('FAKE_NODE_ARGS_PATH')\n"
        "if args_path:\n"
        "    Path(args_path).write_text(json.dumps(sys.argv[1:]), encoding='utf-8')\n"
        "if os.environ.get('FAKE_NODE_ASSERT_TERMINAL') == '1':\n"
        "    task_dir = Path(sys.argv[sys.argv.index('--task-dir') + 1])\n"
        "    with (task_dir / '.lock').open('a+', encoding='utf-8') as lock:\n"
        "        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
        "        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)\n"
        "    state = json.loads((task_dir / 'run-state.json').read_text(encoding='utf-8'))\n"
        "    assert state['status'] in {'completed', 'blocked'}\n"
        "    events = (task_dir / 'events.jsonl').read_text(encoding='utf-8')\n"
        "    assert '\"event\": \"task.verified\"' in events\n"
        "sys.stdout.write(os.environ.get('FAKE_NODE_STDOUT', ''))\n"
        "sys.stderr.write(os.environ.get('FAKE_NODE_STDERR', ''))\n"
        "raise SystemExit(int(os.environ.get('FAKE_NODE_EXIT', '0')))\n",
        encoding="utf-8",
    )
    node.chmod(0o755)
    args_path = root / "fake-node-args.json"
    return {
        "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        "WORK_HARNESS_EVAL_PLANE_SCRIPT": str(evaluator),
        "FAKE_NODE_ARGS_PATH": str(args_path),
        "FAKE_NODE_STDOUT": stdout,
        "FAKE_NODE_STDERR": stderr,
        "FAKE_NODE_EXIT": str(returncode),
    }, evaluator, args_path


def read_events(task_dir: Path):
    return [json.loads(line) for line in (task_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()]


def test_happy_path():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        result = run("init", "--task-id", "demo", "--objective", "demo task", "--root", str(root), cwd=tmp)
        assert result.returncode == 0, result.stderr
        task_dir = root / "demo"
        result = run("add-node", str(task_dir), "--node-id", "inspect", "--goal", "inspect", "--post-condition", "evidence", "--acceptance", "handoff exists", "--read-scope", "src/booking", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation", cwd=tmp)
        assert result.returncode == 0, result.stderr
        result = run("add-node", str(task_dir), "--node-id", "verify", "--goal", "verify", "--depends-on", "inspect", "--post-condition", "verification complete", "--acceptance", "verification is recorded", "--read-scope", "src/booking", "--dispatch-reason", "independent_verification", cwd=tmp)
        assert result.returncode == 0, result.stderr
        result = run("validate", str(task_dir), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(run("next", str(task_dir), cwd=tmp).stdout)["ready"] == ["inspect"]
        assert run("start-node", str(task_dir), "--node-id", "verify", cwd=tmp).returncode == 2
        assert run("start-node", str(task_dir), "--node-id", "inspect", cwd=tmp).returncode == 0

        handoff = task_dir / "handoff.json"
        handoff.write_text(json.dumps({
            "status": "completed",
            "conclusion": "done",
            "evidence": ["README.md"],
            "artifacts": [],
            "validation": ["checked"],
            "risks": [],
            "next_action": "continue",
        }), encoding="utf-8")
        result = run("record-handoff", str(task_dir), "--node-id", "inspect", "--file", str(handoff), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(run("next", str(task_dir), cwd=tmp).stdout)["ready"] == ["verify"]
        assert run("start-node", str(task_dir), "--node-id", "verify", cwd=tmp).returncode == 0
        result = run("record-handoff", str(task_dir), "--node-id", "verify", "--file", str(handoff), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        summary = Path(tmp) / "run-summary.json"
        write_summary(summary, "demo", "run-demo")
        result = run("record-summary", str(task_dir), "--file", str(summary), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        stored_summary = json.loads((task_dir / "run-summary.json").read_text(encoding="utf-8"))
        assert stored_summary["observed"]["retry_count"] == 0
        assert json.loads((task_dir / "task.json").read_text(encoding="utf-8"))["run_id"] == "run-demo"
        result = run("verify", str(task_dir), "--verdict", "pass", cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
        assert state["status"] == "completed"


def test_verify_triggers_evaluator_and_projects_completed_result():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-completed")
        evaluation = {
            "schema": "work-harness-evaluation-v1",
            "status": "completed",
            "suiteId": "work-run-quality",
            "runId": "evaluation-run-1",
            "evaluationKey": "evaluation-key-1",
            "hardGatePassed": True,
            "result": "pass",
            "reportRef": "evaluation://evaluation-key-1",
            "reportPath": str(task_dir / "evaluations" / "evaluation-key-1.json"),
            "reused": False,
        }
        env, evaluator, args_path = fake_evaluator_env(tmp, json.dumps(evaluation))
        env["FAKE_NODE_ASSERT_TERMINAL"] = "1"

        result = run("verify", str(task_dir), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 0, result.stdout + result.stderr
        payload = json.loads(result.stdout)
        assert payload["status"] == "completed"
        assert payload["verification"] == "passed"
        assert payload["evaluation"] == evaluation
        assert json.loads(args_path.read_text(encoding="utf-8")) == [
            "--no-warnings=ExperimentalWarning",
            "--experimental-strip-types",
            str(evaluator.resolve()),
            "--task-dir",
            str(task_dir.resolve()),
            "--suite",
            "work-run-quality",
        ]
        events = read_events(task_dir)
        names = [event["event"] for event in events]
        assert names.index("task.verified") < names.index("evaluation.trigger_completed")
        completed = next(event for event in events if event["event"] == "evaluation.trigger_completed")
        assert completed["evaluation_key"] == "evaluation-key-1"
        assert completed["hard_gate_passed"] is True
        assert "reportPath" not in completed
        assert "report_path" not in completed
        assert "stderr" not in completed


def test_verify_records_explicit_evaluation_skip():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-off")

        result = run(
            "verify",
            str(task_dir),
            "--verdict",
            "pass",
            cwd=tmp,
            env={"WORK_HARNESS_EVAL_PLANE_SCRIPT": "off"},
        )

        assert result.returncode == 0, result.stdout + result.stderr
        payload = json.loads(result.stdout)
        assert payload["evaluation"] == {
            "status": "skipped",
            "suiteId": "work-run-quality",
            "reason": "disabled",
        }
        events = read_events(task_dir)
        skipped = next(event for event in events if event["event"] == "evaluation.trigger_skipped")
        assert skipped["reason"] == "disabled"
        assert json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))["status"] == "completed"


def test_verify_returns_two_and_records_evaluator_failure():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-failed")
        secret_stderr = "internal evaluator details must not leak"
        env, _, _ = fake_evaluator_env(tmp, "not-json", returncode=7, stderr=secret_stderr)

        result = run("verify", str(task_dir), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 2, result.stdout + result.stderr
        assert json.loads(result.stdout)["evaluation"] == {
            "status": "failed",
            "suiteId": "work-run-quality",
            "reason": "nonzero_exit",
        }
        assert json.loads(result.stderr)["reason"] == "nonzero_exit"
        events = read_events(task_dir)
        failed = next(event for event in events if event["event"] == "evaluation.trigger_failed")
        assert failed["reason"] == "nonzero_exit"
        assert secret_stderr not in result.stderr
        assert secret_stderr not in (task_dir / "events.jsonl").read_text(encoding="utf-8")
        assert json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))["status"] == "completed"


def test_verify_quality_blocked_only_gates_passing_verdict():
    with tempfile.TemporaryDirectory() as tmp:
        evaluation = {
            "schema": "work-harness-evaluation-v1",
            "status": "completed",
            "suiteId": "work-run-quality",
            "runId": "evaluation-run-blocked",
            "evaluationKey": "evaluation-key-blocked",
            "hardGatePassed": False,
            "result": "blocked",
            "reportRef": "evaluation://evaluation-key-blocked",
            "reportPath": str(Path(tmp) / "evaluation-key-blocked.json"),
            "reused": False,
        }
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))
        passing_task = prepare_task_for_verify(tmp, "quality-pass")

        result = run("verify", str(passing_task), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 3, result.stdout + result.stderr
        assert json.loads(result.stdout)["evaluation"]["hardGatePassed"] is False
        assert json.loads(result.stderr)["reason"] == "quality_gate_blocked"
        assert json.loads((passing_task / "run-state.json").read_text(encoding="utf-8"))["status"] == "completed"
        assert any(event["event"] == "evaluation.trigger_completed" for event in read_events(passing_task))

        failing_task = prepare_task_for_verify(tmp, "quality-fail", verdict="fail")
        result = run("verify", str(failing_task), "--verdict", "fail", cwd=tmp, env=env)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads((failing_task / "run-state.json").read_text(encoding="utf-8"))["status"] == "blocked"


def test_summary_is_required_and_checked_at_verification():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "summary", "--objective", "summary", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "summary"
        assert run("verify", str(task_dir), "--verdict", "pass", cwd=tmp).returncode == 2

        summary = Path(tmp) / "bad-summary.json"
        write_summary(summary, "summary", "run-summary", verdict="fail", terminal_status="failed")
        assert run("record-summary", str(task_dir), "--file", str(summary), cwd=tmp).returncode == 0
        assert run("verify", str(task_dir), "--verdict", "pass", cwd=tmp).returncode == 2


def test_summary_rejects_missing_signal_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "summary-fields", "--objective", "summary", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "summary-fields"
        summary = Path(tmp) / "invalid-summary.json"
        summary.write_text(json.dumps({
            "schema": "work-harness-run-summary-v1",
            "task_id": "summary-fields",
            "run_id": "run-summary-fields",
            "terminal_status": "completed",
            "verification": {"verdict": "pass"},
            "evidence_refs": [],
            "artifact_refs": [],
            "knowledge_refs": [],
            "correction_signals": [{"kind": "manual_correction", "reason_code": "missing_evidence"}],
        }), encoding="utf-8")
        assert run("record-summary", str(task_dir), "--file", str(summary), cwd=tmp).returncode == 2


def test_long_task_id_gets_a_safe_default_run_id():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        task_id = "a" * 128
        result = run("init", "--task-id", task_id, "--objective", "long", "--root", str(root), cwd=tmp)
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert len(payload["run_id"]) <= 128
        assert payload["run_id"].startswith("run-")


def test_node_granularity_is_checked_at_creation():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "granularity", "--objective", "granularity", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "granularity"
        assert run("add-node", str(task_dir), "--node-id", "tiny", "--goal", "tiny", cwd=tmp).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "one-reason", "--goal", "one reason",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "parallelism", cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "valid", "--goal", "valid unit",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--read-scope", "src/a", "--dispatch-reason", "parallelism",
            "--dispatch-reason", "context_reduction", cwd=tmp,
        ).returncode == 0
        assert run("validate", str(task_dir), cwd=tmp).returncode == 0


def test_parallel_waves_and_write_scope_conflict():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "parallel", "--objective", "parallel", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "parallel"
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "parallelism", "--dispatch-reason", "context_reduction"]
        assert run("add-node", str(task_dir), "--node-id", "a", "--goal", "a", "--write-scope", "src/shared", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "b", "--goal", "b", "--write-scope", "src/shared/file", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "c", "--goal", "c", "--write-scope", "src/other", *common, cwd=tmp).returncode == 0
        next_payload = json.loads(run("next", str(task_dir), cwd=tmp).stdout)
        assert next_payload["parallel_waves"] == [["a", "c"], ["b"]]
        assert run("start-node", str(task_dir), "--node-id", "a", cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "b", cwd=tmp).returncode == 2
        assert run("start-node", str(task_dir), "--node-id", "c", cwd=tmp).returncode == 0


def test_cycle_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "cycle", "--objective", "cycle", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "cycle"
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation"]
        assert run("add-node", str(task_dir), "--node-id", "a", "--goal", "a", "--depends-on", "b", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "b", "--goal", "b", "--depends-on", "a", *common, cwd=tmp).returncode == 0
        result = run("validate", str(task_dir), cwd=tmp)
        assert result.returncode == 1
        assert "cycle" in result.stdout


def test_native_plan_sync():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "native", "--objective", "native", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "native"
        native = Path(tmp) / "native-plan.json"
        native.write_text(json.dumps({"steps": [
            {"id": "one", "step": "one", "status": "completed"},
            {"id": "two", "step": "two", "status": "pending", "depends_on": ["one"]},
        ]}), encoding="utf-8")
        result = run("sync-native-plan", str(task_dir), "--file", str(native), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        assert [node["id"] for node in plan["nodes"]] == ["one", "two"]
        assert json.loads(run("next", str(task_dir), cwd=tmp).stdout)["ready"] == ["two"]

        hidden = Path(tmp) / "hidden.json"
        hidden.write_text(json.dumps({"status": "completed", "conclusion": "done", "evidence": [], "artifacts": [], "validation": [], "risks": [], "next_action": "none"}), encoding="utf-8")
        assert run("add-node", str(task_dir), "--node-id", "hidden-agent", "--goal", "hidden", "--post-condition", "hidden handoff", "--acceptance", "handoff exists", "--dispatch-reason", "independent_retry", cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "hidden-agent", cwd=tmp).returncode == 0
        assert run("record-handoff", str(task_dir), "--node-id", "hidden-agent", "--file", str(hidden), cwd=tmp).returncode == 0
        result = run("sync-native-plan", str(task_dir), "--file", str(native), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        assert [node["id"] for node in plan["nodes"]] == ["one", "two", "hidden-agent"]


def test_guards():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        result = run("init", "--task-id", "../escape", "--objective", "bad", "--root", str(root), cwd=tmp)
        assert result.returncode == 2
        assert not (Path(tmp) / "escape").exists()

        assert run("init", "--task-id", "guard", "--objective", "guard", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "guard"
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation"]
        assert run("add-node", str(task_dir), "--node-id", "a", "--goal", "a", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "b", "--goal", "b", "--depends-on", "a", *common, cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "b", cwd=tmp).returncode == 2
        handoff = task_dir / "handoff.json"
        handoff.write_text(json.dumps({"status": "completed", "conclusion": "done", "evidence": [], "artifacts": [], "validation": [], "risks": [], "next_action": "none"}), encoding="utf-8")
        assert run("record-handoff", str(task_dir), "--node-id", "a", "--file", str(handoff), cwd=tmp).returncode == 2
        bad_native = Path(tmp) / "bad-native.json"
        bad_native.write_text(json.dumps({"steps": [{"step": "bad", "status": "unknown"}]}), encoding="utf-8")
        assert run("import-native-plan", str(task_dir), "--file", str(bad_native), cwd=tmp).returncode == 2


if __name__ == "__main__":
    test_happy_path()
    test_verify_triggers_evaluator_and_projects_completed_result()
    test_verify_records_explicit_evaluation_skip()
    test_verify_returns_two_and_records_evaluator_failure()
    test_verify_quality_blocked_only_gates_passing_verdict()
    test_summary_is_required_and_checked_at_verification()
    test_summary_rejects_missing_signal_evidence()
    test_long_task_id_gets_a_safe_default_run_id()
    test_node_granularity_is_checked_at_creation()
    test_parallel_waves_and_write_scope_conflict()
    test_cycle_is_rejected()
    test_native_plan_sync()
    test_guards()
    print("ok")
