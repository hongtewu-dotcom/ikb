#!/usr/bin/env python3
import hashlib
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("work_harness.py")
TEST_SUBJECT_HASH = "__SUBJECT_HASH__"
TEST_SUBJECT_VERSION = "work-harness-run-subject.v4"
TEST_SUITE_VERSION = "v4"
VERIFICATION_ID_PLACEHOLDER = "__VERIFICATION_ID__"
EVALUATION_KEY_PLACEHOLDER = "__EVALUATION_KEY__"
TEST_EVALUATION_CASE_LEVELS = {
    "work-run-contract-integrity": "L1",
    "work-run-dag-scope": "L1",
    "work-run-node-closure": "L1",
    "work-run-verification-chain": "L1",
    "work-run-retry-budget": "L1",
    "work-run-recovery-quality": "L2",
    "work-run-domain-result": "L3",
}


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


def fake_evaluator_env(
    tmp: str,
    stdout: str,
    returncode: int = 0,
    stderr: str = "",
    *,
    report_overrides=None,
    event_overrides=None,
    report_text=None,
    grader_version="deterministic-v1",
):
    root = Path(tmp)
    evaluator = root / "work-eval-cli.ts"
    evaluator.write_text("// fake evaluator entrypoint\n", encoding="utf-8")
    bin_dir = root / "bin"
    bin_dir.mkdir(exist_ok=True)
    node = bin_dir / "node"
    node.write_text(
        f"#!{sys.executable}\n"
        "import fcntl\n"
        "import hashlib\n"
        "import json\n"
        "import os\n"
        "import subprocess\n"
        "import sys\n"
        "import time\n"
        "from datetime import datetime, timezone\n"
        "from pathlib import Path\n"
        "real_node = os.environ.get('FAKE_REAL_NODE')\n"
        "if '--eval' in sys.argv and real_node:\n"
        "    os.execv(real_node, [real_node, *sys.argv[1:]])\n"
        "args_path = os.environ.get('FAKE_NODE_ARGS_PATH')\n"
        "if args_path:\n"
        "    Path(args_path).write_text(json.dumps(sys.argv[1:]), encoding='utf-8')\n"
        "verification_id = ''\n"
        "if '--verification-id' in sys.argv:\n"
        "    verification_id = sys.argv[sys.argv.index('--verification-id') + 1]\n"
        "coord_dir_value = os.environ.get('FAKE_NODE_COORD_DIR')\n"
        "if coord_dir_value:\n"
        "    coord_dir = Path(coord_dir_value)\n"
        "    first_started = coord_dir / 'first-started'\n"
        "    if not first_started.exists():\n"
        "        first_started.write_text(verification_id, encoding='utf-8')\n"
        "        release_first = coord_dir / 'release-first'\n"
        "        deadline = time.monotonic() + 5\n"
        "        while not release_first.exists() and time.monotonic() < deadline:\n"
        "            time.sleep(0.01)\n"
        "        assert release_first.exists(), 'timed out waiting to release first evaluator'\n"
        "    else:\n"
        "        (coord_dir / 'second-started').write_text(verification_id, encoding='utf-8')\n"
        "if os.environ.get('FAKE_NODE_ASSERT_LOCKED') == '1':\n"
        "    task_dir = Path(sys.argv[sys.argv.index('--task-dir') + 1])\n"
        "    with (task_dir / '.lock').open('a+', encoding='utf-8') as lock:\n"
        "        try:\n"
        "            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
        "        except BlockingIOError:\n"
        "            pass\n"
        "        else:\n"
        "            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)\n"
        "            raise AssertionError('evaluator must run while the task lock is held')\n"
        "    state = json.loads((task_dir / 'run-state.json').read_text(encoding='utf-8'))\n"
        "    assert state['status'] in {'completed', 'blocked'}\n"
        "    events = (task_dir / 'events.jsonl').read_text(encoding='utf-8')\n"
        "    assert '\"event\": \"task.verified\"' in events\n"
        "task_dir = Path(sys.argv[sys.argv.index('--task-dir') + 1])\n"
        "subject_source = (\n"
        "    \"import { pathToFileURL } from 'node:url';\"\n"
        "    \"const loaded = await import(pathToFileURL(process.argv[1]).href);\"\n"
        "    \"const subject = loaded.loadWorkRunSubject(process.argv[2]);\"\n"
        "    \"process.stdout.write(JSON.stringify({subjectHash: subject.subjectHash}));\"\n"
        ")\n"
        "subject_process = subprocess.run([\n"
        "    real_node,\n"
        "    '--no-warnings=ExperimentalWarning',\n"
        "    '--experimental-strip-types',\n"
        "    '--input-type=module',\n"
        "    '--eval',\n"
        "    subject_source,\n"
        "    os.environ['FAKE_SUBJECT_MODULE'],\n"
        "    str(task_dir.resolve()),\n"
        "], capture_output=True, text=True)\n"
        "assert subject_process.returncode == 0, subject_process.stderr\n"
        "subject_hash = json.loads(subject_process.stdout)['subjectHash']\n"
        "grader_version = os.environ.get('FAKE_GRADER_VERSION', 'deterministic-v1')\n"
        "stdout = os.environ.get('FAKE_NODE_STDOUT', '')\n"
        "stdout = stdout.replace('__VERIFICATION_ID__', verification_id)\n"
        "stdout = stdout.replace('__SUBJECT_HASH__', subject_hash)\n"
        "if '__EVALUATION_KEY__' in stdout:\n"
        "    identity = json.loads(stdout)\n"
        "    evaluation_key = hashlib.sha256('\\n'.join([\n"
        "        identity['runId'],\n"
        "        identity['suiteId'],\n"
        "        identity['suiteVersion'],\n"
        "        identity['subjectHash'],\n"
        "        grader_version,\n"
        "    ]).encode('utf-8')).hexdigest()\n"
        "    stdout = stdout.replace('__EVALUATION_KEY__', evaluation_key)\n"
        "try:\n"
        "    output = json.loads(stdout)\n"
        "except json.JSONDecodeError:\n"
        "    output = None\n"
        "if isinstance(output, dict) and isinstance(output.get('reportPath'), str):\n"
        "    report_path = Path(output['reportPath'])\n"
        "    report_path.parent.mkdir(parents=True, exist_ok=True)\n"
        "    configured_report = os.environ.get('FAKE_NODE_REPORT_TEXT')\n"
        "    if configured_report is None:\n"
        "        case_levels = {\n"
        "            'work-run-contract-integrity': 'L1',\n"
        "            'work-run-dag-scope': 'L1',\n"
        "            'work-run-node-closure': 'L1',\n"
        "            'work-run-verification-chain': 'L1',\n"
        "            'work-run-retry-budget': 'L1',\n"
        "            'work-run-recovery-quality': 'L2',\n"
        "            'work-run-domain-result': 'L3',\n"
        "        }\n"
        "        statuses = {case_id: 'pass' for case_id in case_levels}\n"
        "        if output.get('result') == 'partial':\n"
        "            statuses['work-run-recovery-quality'] = 'fail'\n"
        "        elif output.get('result') == 'blocked':\n"
        "            statuses['work-run-contract-integrity'] = 'fail'\n"
        "        results = []\n"
        "        for case_id, level in case_levels.items():\n"
        "            status = statuses[case_id]\n"
        "            metrics = (\n"
        "                {'domain_registered': False, 'required': False}\n"
        "                if case_id == 'work-run-domain-result'\n"
        "                else {}\n"
        "            )\n"
        "            results.append({\n"
        "                'schema': 'ikb-eval-result-v1',\n"
        "                'evalVersion': 'v1',\n"
        "                'suiteId': output.get('suiteId'),\n"
        "                'suiteVersion': output.get('suiteVersion'),\n"
        "                'caseId': case_id,\n"
        "                'harnessId': 'work-harness',\n"
        "                'runId': output.get('runId'),\n"
        "                'subjectVersion': output.get('subjectVersion'),\n"
        "                'graderVersion': grader_version,\n"
        "                'level': level,\n"
        "                'expected': 'pass',\n"
        "                'observed': status,\n"
        "                'status': status,\n"
        "                'reasonCodes': [] if status == 'pass' else ['fake_failure'],\n"
        "                'metrics': metrics,\n"
        "                'evidenceRefs': [],\n"
        "                'artifactRefs': [],\n"
        "                'diagnosis': 'subject',\n"
        "            })\n"
        "        def aggregate_levels(items):\n"
        "            levels = []\n"
        "            for level in ('L1', 'L2', 'L3'):\n"
        "                level_results = [item for item in items if item.get('level') == level]\n"
        "                failed = [item for item in level_results if item.get('status') != 'pass']\n"
        "                levels.append({\n"
        "                    'level': level,\n"
        "                    'totalCases': len(level_results),\n"
        "                    'passedCases': len(level_results) - len(failed),\n"
        "                    'failedCases': len(failed),\n"
        "                    'failedCaseIds': [item.get('caseId') for item in failed],\n"
        "                    'reasonCodes': ({'fake_failure': len(failed)} if failed else {}),\n"
        "                })\n"
        "            return levels\n"
        "        report = {\n"
        "            'schema': 'ikb-eval-report-v1',\n"
        "            'evalVersion': 'v1',\n"
        "            'kind': 'run_assessment',\n"
        "            'suiteId': output.get('suiteId'),\n"
        "            'suiteVersion': output.get('suiteVersion'),\n"
        "            'harnessId': 'work-harness',\n"
        "            'graderVersion': grader_version,\n"
        "            'runId': output.get('runId'),\n"
        "            'subjectVersion': output.get('subjectVersion'),\n"
        "            'subjectHash': output.get('subjectHash'),\n"
        "            'evaluationKey': output.get('evaluationKey'),\n"
        "            'hardGatePassed': output.get('hardGatePassed'),\n"
        "            'levels': aggregate_levels(results),\n"
        "            'results': results,\n"
        "        }\n"
        "        overrides = json.loads(os.environ.get('FAKE_NODE_REPORT_OVERRIDES', '{}'))\n"
        "        result_override = overrides.pop('__resultStatus', None)\n"
        "        if result_override in {'pass', 'fail'}:\n"
        "            report['results'][0]['status'] = result_override\n"
        "            report['results'][0]['observed'] = result_override\n"
        "        status_overrides = overrides.pop('__statuses', {})\n"
        "        for item in report['results']:\n"
        "            if item['caseId'] in status_overrides:\n"
        "                item['status'] = status_overrides[item['caseId']]\n"
        "                item['observed'] = status_overrides[item['caseId']]\n"
        "                item['reasonCodes'] = ([] if item['status'] == 'pass' else ['fake_failure'])\n"
        "        result_overrides = overrides.pop('__resultOverrides', {})\n"
        "        for item in report['results']:\n"
        "            item.update(result_overrides.get(item['caseId'], {}))\n"
        "        domain_required = overrides.pop('__domainRequired', None)\n"
        "        if domain_required is not None:\n"
        "            next(item for item in report['results'] if item['caseId'] == 'work-run-domain-result')['metrics']['required'] = domain_required\n"
        "        drop_case = overrides.pop('__dropCase', None)\n"
        "        if drop_case:\n"
        "            report['results'] = [item for item in report['results'] if item['caseId'] != drop_case]\n"
        "        duplicate_case = overrides.pop('__duplicateCase', None)\n"
        "        if duplicate_case:\n"
        "            duplicate = dict(next(item for item in report['results'] if item['caseId'] == duplicate_case))\n"
        "            duplicate['metrics'] = dict(duplicate['metrics'])\n"
        "            report['results'].append(duplicate)\n"
        "        if overrides.pop('__extraCase', False):\n"
        "            extra = dict(report['results'][0])\n"
        "            extra['caseId'] = 'work-run-extra-case'\n"
        "            extra['metrics'] = dict(extra['metrics'])\n"
        "            report['results'].append(extra)\n"
        "        wrong_level_case = overrides.pop('__wrongLevelCase', None)\n"
        "        if wrong_level_case:\n"
        "            item = next(item for item in report['results'] if item['caseId'] == wrong_level_case)\n"
        "            item['level'] = 'L2' if item['level'] == 'L1' else 'L1'\n"
        "        report['levels'] = aggregate_levels(report['results'])\n"
        "        report.update(overrides)\n"
        "        report_bytes = (json.dumps(report, indent=2) + '\\n').encode('utf-8')\n"
        "    else:\n"
        "        configured_report = configured_report.replace('__VERIFICATION_ID__', verification_id)\n"
        "        configured_report = configured_report.replace('__SUBJECT_HASH__', subject_hash)\n"
        "        report_bytes = configured_report.encode('utf-8')\n"
        "    report_path.write_bytes(report_bytes)\n"
        "    report_hash = hashlib.sha256(report_bytes).hexdigest()\n"
        "    failed_cases = sum(\n"
        "        1 for item in report.get('results', []) if item.get('status') != 'pass'\n"
        "    ) if configured_report is None else (0 if output.get('result') == 'pass' else 1)\n"
        "    total_cases = len(report.get('results', [])) if configured_report is None else 1\n"
        "    event = {\n"
        "        'schema': 'work-harness-eval-event-v1',\n"
        "        'at': datetime.now(timezone.utc).isoformat(),\n"
        "        'event': 'evaluation.completed',\n"
        "        'runId': output.get('runId'),\n"
        "        'suiteId': output.get('suiteId'),\n"
        "        'suiteVersion': output.get('suiteVersion'),\n"
        "        'graderVersion': grader_version,\n"
        "        'subjectVersion': output.get('subjectVersion'),\n"
        "        'subjectHash': output.get('subjectHash'),\n"
        "        'evaluationKey': output.get('evaluationKey'),\n"
        "        'hardGatePassed': output.get('hardGatePassed'),\n"
        "        'diagnosis': 'subject',\n"
        "        'result': output.get('result'),\n"
        "        'totalCases': total_cases,\n"
        "        'passedCases': total_cases - failed_cases,\n"
        "        'failedCases': failed_cases,\n"
        "        'reasonCodes': [] if failed_cases == 0 else ['fake_failure'],\n"
        "        'reportRef': output.get('reportRef'),\n"
        "        'reportHash': report_hash,\n"
        "    }\n"
        "    event.update(json.loads(os.environ.get('FAKE_NODE_EVENT_OVERRIDES', '{}')))\n"
        "    events_path = task_dir / 'evaluations' / 'events.jsonl'\n"
        "    events_path.parent.mkdir(parents=True, exist_ok=True)\n"
        "    with events_path.open('a', encoding='utf-8') as stream:\n"
        "        stream.write(json.dumps(event) + '\\n')\n"
        "sys.stdout.write(stdout)\n"
        "sys.stderr.write(os.environ.get('FAKE_NODE_STDERR', ''))\n"
        "raise SystemExit(int(os.environ.get('FAKE_NODE_EXIT', '0')))\n",
        encoding="utf-8",
    )
    node.chmod(0o755)
    args_path = root / "fake-node-args.json"
    real_node = shutil.which("node")
    assert real_node is not None
    subject_module = (
        SCRIPT.resolve().parents[2]
        / "eval-plane" / "src" / "work-run-subject.ts"
    )
    return {
        "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
        "WORK_HARNESS_EVAL_PLANE_SCRIPT": str(evaluator),
        "FAKE_NODE_ARGS_PATH": str(args_path),
        "FAKE_NODE_STDOUT": stdout,
        "FAKE_NODE_STDERR": stderr,
        "FAKE_NODE_EXIT": str(returncode),
        "FAKE_REAL_NODE": real_node,
        "FAKE_SUBJECT_MODULE": str(subject_module),
        "FAKE_GRADER_VERSION": grader_version,
        "FAKE_NODE_REPORT_OVERRIDES": json.dumps(report_overrides or {}),
        "FAKE_NODE_EVENT_OVERRIDES": json.dumps(event_overrides or {}),
        **(
            {"FAKE_NODE_REPORT_TEXT": report_text}
            if report_text is not None
            else {}
        ),
    }, evaluator, args_path


def work_evaluation_value(
    task_dir: Path,
    run_id: str,
    evaluation_key: str | None = None,
    *,
    verification_id: str = VERIFICATION_ID_PLACEHOLDER,
    hard_gate_passed: bool = True,
    result: str = "pass",
    reused: bool = False,
):
    evaluation_key = evaluation_key or EVALUATION_KEY_PLACEHOLDER
    return {
        "schema": "work-harness-evaluation-v1",
        "status": "completed",
        "suiteId": "work-run-quality",
        "suiteVersion": TEST_SUITE_VERSION,
        "runId": run_id,
        "verificationId": verification_id,
        "subjectHash": TEST_SUBJECT_HASH,
        "subjectVersion": TEST_SUBJECT_VERSION,
        "evaluationKey": evaluation_key,
        "hardGatePassed": hard_gate_passed,
        "result": result,
        "reportRef": (
            f"artifact://evaluation/work-run-quality/{evaluation_key}"
        ),
        "reportPath": str(
            task_dir.resolve() / "evaluations" / "work-run-quality"
            / f"{evaluation_key}.json"
        ),
        "reused": reused,
    }


def expected_evaluation_key(
    run_id: str,
    subject_hash: str,
    grader_version: str = "deterministic-v1",
) -> str:
    return hashlib.sha256("\n".join([
        run_id,
        "work-run-quality",
        TEST_SUITE_VERSION,
        subject_hash,
        grader_version,
    ]).encode("utf-8")).hexdigest()


def wait_for_path(path: Path, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(0.01)
    return path.exists()


def read_events(task_dir: Path):
    return [json.loads(line) for line in (task_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()]


def node_context_args():
    return [
        "--known-fact", "the repository evidence was inspected",
        "--evidence-ref", "file://artifacts/source-evidence.json",
    ]


def parent_executor_args():
    return ["--executor-kind", "parent", "--runtime", "codex"]


def handoff_value(task_dir: Path, node_id: str, status: str = "completed"):
    value = {
        "status": status,
        "conclusion": "done" if status == "completed" else status,
        "evidence": ["README.md"] if status == "completed" else [],
        "artifacts": [],
        "validation": ["checked"] if status == "completed" else [],
        "risks": [] if status == "completed" else ["waiting"],
        "next_action": "continue" if status == "completed" else "retry",
    }
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
    execution = state.get("executions", {}).get(node_id, {})
    if execution.get("execution_id"):
        value.update({
            "task_id": task["task_id"],
            "run_id": task["run_id"],
            "node_id": node_id,
            "attempt": execution["attempt"],
            "execution_id": execution["execution_id"],
        })
    return value


def write_handoff(path: Path, task_dir: Path, node_id: str, status: str = "completed"):
    value = handoff_value(task_dir, node_id, status)
    path.write_text(json.dumps(value), encoding="utf-8")
    return value


def set_managed_lease_expiry(
    task_dir: Path,
    node_id: str,
    expires_at: str,
):
    state_path = task_dir / "run-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["executions"][node_id]["lease_expires_at"] = expires_at
    state_path.write_text(json.dumps(state), encoding="utf-8")
    descriptor_path = task_dir / "nodes" / node_id / "execution.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["lease_expires_at"] = expires_at
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
    return state


def write_domain_evaluation(path: Path, task_id: str, run_id: str, report_ref: str, report_hash: str):
    value = {
        "schema": "work-harness-domain-evaluation-v1",
        "task_id": task_id,
        "run_id": run_id,
        "suite_id": "flight-domain-regression",
        "suite_version": "v1",
        "grader_version": "grader-v3",
        "required": True,
        "hard_gate_passed": True,
        "result": "pass",
        "report_ref": report_ref,
        "report_hash": report_hash,
        "metrics": {"case_count": 30, "pass_rate": 1.0, "stable": True},
        "evidence_refs": [report_ref],
        "evaluated_at": "2026-07-23T10:00:00Z",
    }
    path.write_text(json.dumps(value), encoding="utf-8")
    return value


def test_happy_path():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        result = run("init", "--task-id", "demo", "--objective", "demo task", "--root", str(root), cwd=tmp)
        assert result.returncode == 0, result.stderr
        task_dir = root / "demo"
        result = run("add-node", str(task_dir), "--node-id", "inspect", "--goal", "inspect", "--post-condition", "evidence", "--acceptance", "handoff exists", "--read-scope", "src/booking", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation", *node_context_args(), cwd=tmp)
        assert result.returncode == 0, result.stderr
        result = run("add-node", str(task_dir), "--node-id", "verify", "--goal", "verify", "--depends-on", "inspect", "--post-condition", "verification complete", "--acceptance", "verification is recorded", "--read-scope", "src/booking", "--dispatch-reason", "independent_verification", *node_context_args(), cwd=tmp)
        assert result.returncode == 0, result.stderr
        result = run("validate", str(task_dir), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(run("next", str(task_dir), cwd=tmp).stdout)["ready"] == ["inspect"]
        assert run("start-node", str(task_dir), "--node-id", "verify", *parent_executor_args(), cwd=tmp).returncode == 2
        assert run("start-node", str(task_dir), "--node-id", "inspect", *parent_executor_args(), cwd=tmp).returncode == 0

        handoff = task_dir / "handoff.json"
        write_handoff(handoff, task_dir, "inspect")
        result = run("record-handoff", str(task_dir), "--node-id", "inspect", "--file", str(handoff), cwd=tmp)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(run("next", str(task_dir), cwd=tmp).stdout)["ready"] == ["verify"]
        assert run("start-node", str(task_dir), "--node-id", "verify", *parent_executor_args(), cwd=tmp).returncode == 0
        write_handoff(handoff, task_dir, "verify")
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


def test_handoff_list_items_must_be_non_empty_strings():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        invalid_items = {
            "object": {"ref": "README.md"},
            "empty": "",
        }
        for field in ("evidence", "artifacts", "validation", "risks"):
            for label, invalid_item in invalid_items.items():
                task_id = f"handoff-{field}-{label}"
                result = run(
                    "init",
                    "--task-id", task_id,
                    "--objective", "reject invalid handoff list items",
                    "--root", str(root),
                    cwd=tmp,
                )
                assert result.returncode == 0, result.stdout + result.stderr
                task_dir = root / task_id
                result = run(
                    "add-node", str(task_dir),
                    "--node-id", "worker",
                    "--goal", "record a valid handoff",
                    "--post-condition", "handoff is recorded",
                    "--acceptance", "handoff schema is valid",
                    "--read-scope", "src",
                    "--dispatch-reason", "context_reduction",
                    "--dispatch-reason", "evidence_separation",
                    *node_context_args(),
                    cwd=tmp,
                )
                assert result.returncode == 0, result.stdout + result.stderr
                result = run(
                    "start-node", str(task_dir),
                    "--node-id", "worker",
                    *parent_executor_args(),
                    cwd=tmp,
                )
                assert result.returncode == 0, result.stdout + result.stderr
                handoff = Path(tmp) / f"{task_id}.json"
                value = handoff_value(task_dir, "worker")
                value[field] = [invalid_item]
                handoff.write_text(json.dumps(value), encoding="utf-8")

                result = run(
                    "record-handoff", str(task_dir),
                    "--node-id", "worker",
                    "--file", str(handoff),
                    cwd=tmp,
                )
                assert result.returncode == 2, (
                    f"{field}/{label} was accepted\n"
                    + result.stdout + result.stderr
                )
                assert (
                    f"handoff.{field} must be an array of non-empty strings"
                    in result.stderr
                ), result.stdout + result.stderr
                state = json.loads(
                    (task_dir / "run-state.json").read_text(encoding="utf-8")
                )
                assert state["current_nodes"] == ["worker"]
                assert not (task_dir / "nodes" / "worker" / "handoff.json").exists()


def test_verify_triggers_evaluator_and_projects_completed_result():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-completed")
        evaluation = work_evaluation_value(
            task_dir,
            "run-evaluation-completed",
        )
        env, evaluator, args_path = fake_evaluator_env(tmp, json.dumps(evaluation))
        env["FAKE_NODE_ASSERT_LOCKED"] = "1"

        result = run("verify", str(task_dir), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 0, result.stdout + result.stderr
        payload = json.loads(result.stdout)
        assert payload["status"] == "completed"
        assert payload["verification"] == "passed"
        verification_id = payload["verification_id"]
        subject_hash = payload["evaluation"]["subjectHash"]
        evaluation_key = expected_evaluation_key(
            "run-evaluation-completed",
            subject_hash,
        )
        assert len(subject_hash) == 64
        assert set(subject_hash) <= set("0123456789abcdef")
        assert payload["evaluation"] == {
            **evaluation,
            "verificationId": verification_id,
            "subjectHash": subject_hash,
            "evaluationKey": evaluation_key,
            "reportRef": (
                f"artifact://evaluation/work-run-quality/{evaluation_key}"
            ),
            "reportPath": str(
                task_dir.resolve() / "evaluations" / "work-run-quality"
                / f"{evaluation_key}.json"
            ),
        }
        assert json.loads(args_path.read_text(encoding="utf-8")) == [
            "--no-warnings=ExperimentalWarning",
            "--experimental-strip-types",
            str(evaluator.resolve()),
            "--task-dir",
            str(task_dir.resolve()),
            "--suite",
            "work-run-quality",
            "--verification-id",
            verification_id,
        ]
        events = read_events(task_dir)
        names = [event["event"] for event in events]
        assert names.index("task.verified") < names.index("evaluation.trigger_completed")
        completed = next(event for event in events if event["event"] == "evaluation.trigger_completed")
        assert completed["evaluation_key"] == evaluation_key
        assert completed["verification_id"] == verification_id
        assert completed["subject_hash"] == subject_hash
        assert completed["subject_version"] == TEST_SUBJECT_VERSION
        assert completed["suite_version"] == TEST_SUITE_VERSION
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
        passing_task = prepare_task_for_verify(tmp, "quality-pass")
        passing_evaluation = work_evaluation_value(
            passing_task,
            "run-quality-pass",
            hard_gate_passed=False,
            result="blocked",
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(passing_evaluation))

        result = run("verify", str(passing_task), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 3, result.stdout + result.stderr
        assert json.loads(result.stdout)["evaluation"]["hardGatePassed"] is False
        assert json.loads(result.stderr)["reason"] == "quality_gate_blocked"
        assert json.loads((passing_task / "run-state.json").read_text(encoding="utf-8"))["status"] == "completed"
        assert any(event["event"] == "evaluation.trigger_completed" for event in read_events(passing_task))

        failing_task = prepare_task_for_verify(tmp, "quality-fail", verdict="fail")
        failing_evaluation = work_evaluation_value(
            failing_task,
            "run-quality-fail",
            hard_gate_passed=False,
            result="blocked",
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(failing_evaluation))
        result = run("verify", str(failing_task), "--verdict", "fail", cwd=tmp, env=env)
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads((failing_task / "run-state.json").read_text(encoding="utf-8"))["status"] == "blocked"


def test_verify_rejects_evaluator_identity_mismatch():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-identity")
        evaluation = work_evaluation_value(
            task_dir,
            "run-other-task",
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))

        result = run("verify", str(task_dir), "--verdict", "pass", cwd=tmp, env=env)

        assert result.returncode == 2, result.stdout + result.stderr
        assert json.loads(result.stdout)["evaluation"]["reason"] == "invalid_output"
        assert any(event["event"] == "evaluation.trigger_failed" for event in read_events(task_dir))
        assert json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))["status"] == "completed"


def test_verify_rejects_valid_format_wrong_hash_and_empty_report():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-unbound-report")
        evaluation = work_evaluation_value(
            task_dir,
            "run-evaluation-unbound-report",
        )
        evaluation["subjectHash"] = "b" * 64
        env, _, _ = fake_evaluator_env(
            tmp,
            json.dumps(evaluation),
            report_text="{}\n",
        )

        result = run(
            "verify",
            str(task_dir),
            "--verdict",
            "pass",
            cwd=tmp,
            env=env,
        )

        assert result.returncode == 2, (
            "valid-format wrong subjectHash plus an empty report was accepted\n"
            + result.stdout + result.stderr
        )
        assert json.loads(result.stdout)["evaluation"]["reason"] == (
            "invalid_output"
        )
        events = read_events(task_dir)
        assert any(
            event["event"] == "evaluation.trigger_failed"
            and event["reason"] == "invalid_output"
            for event in events
        )
        assert not any(
            event["event"] == "evaluation.trigger_completed"
            for event in events
        )


def test_verify_rejects_arbitrary_well_formed_evaluation_key():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "evaluation-derived-key")
        evaluation = work_evaluation_value(
            task_dir,
            "run-evaluation-derived-key",
            "e" * 64,
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))

        result = run(
            "verify",
            str(task_dir),
            "--verdict",
            "pass",
            cwd=tmp,
            env=env,
        )

        assert result.returncode == 2, (
            "arbitrary well-formed evaluationKey was accepted\n"
            + result.stdout + result.stderr
        )
        assert json.loads(result.stdout)["evaluation"]["reason"] == (
            "invalid_output"
        )
        assert not any(
            event["event"] == "evaluation.trigger_completed"
            for event in read_events(task_dir)
        )


def test_verify_rejects_report_and_evaluation_event_binding_mismatches():
    cases = [
        (
            "report-schema",
            {},
            {"schema": "ikb-eval-report-v0"},
            {},
        ),
        (
            "report-run",
            {},
            {"runId": "run-other"},
            {},
        ),
        (
            "report-suite",
            {},
            {"suiteId": "other-suite"},
            {},
        ),
        (
            "report-suite-version",
            {},
            {"suiteVersion": "v3"},
            {},
        ),
        (
            "report-subject-version",
            {},
            {"subjectVersion": "work-harness-run-subject.v3"},
            {},
        ),
        (
            "report-subject-hash",
            {},
            {"subjectHash": "c" * 64},
            {},
        ),
        (
            "report-evaluation-key",
            {},
            {"evaluationKey": "other-evaluation-key"},
            {},
        ),
        (
            "report-hard-gate",
            {},
            {"hardGatePassed": False},
            {},
        ),
        (
            "report-derived-result",
            {},
            {"__resultStatus": "fail"},
            {},
        ),
        (
            "event-result",
            {},
            {},
            {"result": "partial"},
        ),
        (
            "event-hard-gate",
            {},
            {},
            {"hardGatePassed": False},
        ),
        (
            "event-report-ref",
            {},
            {},
            {"reportRef": "artifact://evaluation/work-run-quality/other"},
        ),
        (
            "event-report-hash",
            {},
            {},
            {"reportHash": "d" * 64},
        ),
        (
            "event-total-cases",
            {},
            {},
            {"totalCases": 6},
        ),
        (
            "event-passed-cases",
            {},
            {},
            {"passedCases": 6},
        ),
        (
            "event-failed-cases",
            {},
            {},
            {"failedCases": 1},
        ),
        (
            "event-reason-codes",
            {},
            {},
            {"reasonCodes": ["invented_reason"]},
        ),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        for label, output_overrides, report_overrides, event_overrides in cases:
            task_id = f"report-binding-{label}"
            task_dir = prepare_task_for_verify(tmp, task_id)
            evaluation = work_evaluation_value(
                task_dir,
                f"run-{task_id}",
            )
            evaluation.update(output_overrides)
            env, _, _ = fake_evaluator_env(
                tmp,
                json.dumps(evaluation),
                report_overrides=report_overrides,
                event_overrides=event_overrides,
            )

            result = run(
                "verify",
                str(task_dir),
                "--verdict",
                "pass",
                cwd=tmp,
                env=env,
            )

            assert result.returncode == 2, (
                f"{label} mismatch was accepted\n"
                + result.stdout + result.stderr
            )
            assert json.loads(result.stdout)["evaluation"]["reason"] == (
                "invalid_output"
            )

        task_dir = prepare_task_for_verify(tmp, "report-binding-path")
        evaluation = work_evaluation_value(
            task_dir,
            "run-report-binding-path",
        )
        evaluation["reportPath"] = str(
            task_dir.resolve() / "evaluations" / "work-run-quality"
            / ".." / "work-run-quality"
            / f"{EVALUATION_KEY_PLACEHOLDER}.json"
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))
        result = run(
            "verify",
            str(task_dir),
            "--verdict",
            "pass",
            cwd=tmp,
            env=env,
        )
        assert result.returncode == 2, (
            "non-canonical reportPath was accepted\n"
            + result.stdout + result.stderr
        )
        assert json.loads(result.stdout)["evaluation"]["reason"] == (
            "invalid_output"
        )


def test_verify_recomputes_fixed_v4_suite_and_rejects_self_reported_contradictions():
    all_pass = {
        case_id: "pass" for case_id in TEST_EVALUATION_CASE_LEVELS
    }
    invalid_reports = [
        (
            "wrong-grader",
            True,
            "pass",
            {},
            "deterministic-v2",
        ),
        (
            "missing-case",
            True,
            "pass",
            {"__dropCase": "work-run-retry-budget"},
            "deterministic-v1",
        ),
        (
            "duplicate-case",
            True,
            "pass",
            {"__duplicateCase": "work-run-retry-budget"},
            "deterministic-v1",
        ),
        (
            "extra-case",
            True,
            "pass",
            {"__extraCase": True},
            "deterministic-v1",
        ),
        (
            "wrong-level",
            True,
            "pass",
            {"__wrongLevelCase": "work-run-contract-integrity"},
            "deterministic-v1",
        ),
        (
            "empty-expected",
            True,
            "pass",
            {
                "__resultOverrides": {
                    "work-run-contract-integrity": {"expected": ""}
                }
            },
            "deterministic-v1",
        ),
        (
            "empty-observed",
            True,
            "pass",
            {
                "__resultOverrides": {
                    "work-run-contract-integrity": {"observed": ""}
                }
            },
            "deterministic-v1",
        ),
        (
            "unsupported-diagnosis",
            True,
            "pass",
            {
                "__resultOverrides": {
                    "work-run-contract-integrity": {
                        "diagnosis": "self_reported"
                    }
                }
            },
            "deterministic-v1",
        ),
        (
            "inconsistent-level-summary",
            True,
            "pass",
            {
                "levels": [
                    {
                        "level": "L1",
                        "totalCases": 7,
                        "passedCases": 7,
                        "failedCases": 0,
                        "failedCaseIds": [],
                        "reasonCodes": {},
                    },
                    {
                        "level": "L2",
                        "totalCases": 0,
                        "passedCases": 0,
                        "failedCases": 0,
                        "failedCaseIds": [],
                        "reasonCodes": {},
                    },
                    {
                        "level": "L3",
                        "totalCases": 0,
                        "passedCases": 0,
                        "failedCases": 0,
                        "failedCaseIds": [],
                        "reasonCodes": {},
                    },
                ],
            },
            "deterministic-v1",
        ),
        (
            "l1-fail-fake-gate",
            True,
            "partial",
            {"__statuses": {"work-run-contract-integrity": "fail"}},
            "deterministic-v1",
        ),
        (
            "required-domain-fail-fake-gate",
            True,
            "partial",
            {
                "__statuses": {"work-run-domain-result": "fail"},
                "__domainRequired": True,
            },
            "deterministic-v1",
        ),
        (
            "all-pass-fake-blocked",
            False,
            "blocked",
            {"__statuses": all_pass},
            "deterministic-v1",
        ),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        for label, hard_gate, result_name, overrides, grader in invalid_reports:
            task_id = f"fixed-suite-{label}"
            task_dir = prepare_task_for_verify(tmp, task_id)
            evaluation = work_evaluation_value(
                task_dir,
                f"run-{task_id}",
                hard_gate_passed=hard_gate,
                result=result_name,
            )
            env, _, _ = fake_evaluator_env(
                tmp,
                json.dumps(evaluation),
                report_overrides=overrides,
                grader_version=grader,
            )

            result = run(
                "verify",
                str(task_dir),
                "--verdict",
                "pass",
                cwd=tmp,
                env=env,
            )

            assert result.returncode == 2, (
                f"{label} fixed-suite contradiction was accepted\n"
                + result.stdout + result.stderr
            )
            assert json.loads(result.stdout)["evaluation"]["reason"] == (
                "invalid_output"
            )


def test_verify_holds_task_lock_across_delayed_v1_v2_evaluators():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "locked-verification")
        evaluation = work_evaluation_value(
            task_dir,
            "run-locked-verification",
            reused=True,
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))
        coord_dir = Path(tmp) / "coord"
        coord_dir.mkdir()
        env["FAKE_NODE_COORD_DIR"] = str(coord_dir)
        process_env = os.environ.copy()
        process_env.update(env)

        first = subprocess.Popen(
            [
                sys.executable, str(SCRIPT), "verify", str(task_dir),
                "--verdict", "pass",
            ],
            cwd=tmp,
            env=process_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert wait_for_path(coord_dir / "first-started"), (
            "first evaluator did not start"
        )
        second = subprocess.Popen(
            [
                sys.executable, str(SCRIPT), "verify", str(task_dir),
                "--verdict", "pass",
            ],
            cwd=tmp,
            env=process_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        second_started_while_first_pending = wait_for_path(
            coord_dir / "second-started",
            timeout=0.5,
        )
        (coord_dir / "release-first").write_text("release", encoding="utf-8")
        first_stdout, first_stderr = first.communicate(timeout=10)
        second_stdout, second_stderr = second.communicate(timeout=10)

        assert not second_started_while_first_pending, (
            "V2 evaluator started before V1 trigger committed"
        )
        assert first.returncode == 0, first_stdout + first_stderr
        assert second.returncode == 0, second_stdout + second_stderr
        assert (coord_dir / "second-started").is_file()
        bound_events = [
            event
            for event in read_events(task_dir)
            if event["event"] in {
                "task.verified",
                "evaluation.trigger_completed",
            }
        ]
        assert [event["event"] for event in bound_events] == [
            "task.verified",
            "evaluation.trigger_completed",
            "task.verified",
            "evaluation.trigger_completed",
        ]
        assert (
            bound_events[0]["verification_id"]
            == bound_events[1]["verification_id"]
        )
        assert (
            bound_events[2]["verification_id"]
            == bound_events[3]["verification_id"]
        )
        assert (
            bound_events[0]["verification_id"]
            != bound_events[2]["verification_id"]
        )


def test_pending_verification_blocks_plan_summary_and_domain_mutations():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "pending-mutations")
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "task.verify",
            "WORK_HARNESS_FAULT_STAGE": "after_event",
        }
        crashed = run(
            "verify", str(task_dir), "--verdict", "pass",
            cwd=tmp,
            env=fault,
        )
        assert crashed.returncode == 2

        plan_before = (task_dir / "plan.json").read_bytes()
        summary_before = (task_dir / "run-summary.json").read_bytes()
        replacement_summary = Path(tmp) / "replacement-summary.json"
        write_summary(
            replacement_summary,
            "pending-mutations",
            "run-pending-mutations",
        )
        replacement = json.loads(
            replacement_summary.read_text(encoding="utf-8")
        )
        replacement["verification"]["note"] = "must not replace pending input"
        replacement_summary.write_text(
            json.dumps(replacement),
            encoding="utf-8",
        )
        report = task_dir / "artifacts" / "domain-report.json"
        report.write_bytes(b'{"result":"pass"}\n')
        domain_input = Path(tmp) / "domain-evaluation.json"
        write_domain_evaluation(
            domain_input,
            "pending-mutations",
            "run-pending-mutations",
            "file://artifacts/domain-report.json",
            hashlib.sha256(report.read_bytes()).hexdigest(),
        )
        commands = [
            (
                "add-node", str(task_dir),
                "--node-id", "forbidden-plan-change",
                "--goal", "must not change the pending subject",
                "--post-condition", "not added",
                "--acceptance", "pending verification blocks mutation",
                "--read-scope", "src",
                "--dispatch-reason", "context_reduction",
                "--dispatch-reason", "evidence_separation",
                *node_context_args(),
            ),
            (
                "record-summary", str(task_dir),
                "--file", str(replacement_summary),
            ),
            (
                "record-domain-evaluation", str(task_dir),
                "--file", str(domain_input),
            ),
        ]
        for command in commands:
            result = run(*command, cwd=tmp)
            assert result.returncode == 2, result.stdout + result.stderr
            assert "pending verification" in result.stderr

        assert (task_dir / "plan.json").read_bytes() == plan_before
        assert (task_dir / "run-summary.json").read_bytes() == summary_before
        assert not (task_dir / "domain-evaluation.json").exists()


def test_crashed_verification_resumes_same_v4_binding():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "v4-resume")
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "task.verify",
            "WORK_HARNESS_FAULT_STAGE": "after_event",
        }
        crashed = run(
            "verify", str(task_dir), "--verdict", "pass",
            cwd=tmp,
            env=fault,
        )
        assert crashed.returncode == 2
        verified = [
            event for event in read_events(task_dir)
            if event["event"] == "task.verified"
        ]
        assert len(verified) == 1
        verification_id = verified[0]["verification_id"]
        evaluation = work_evaluation_value(
            task_dir,
            "run-v4-resume",
            verification_id=verification_id,
        )
        env, _, args_path = fake_evaluator_env(tmp, json.dumps(evaluation))

        resumed = run(
            "verify", str(task_dir), "--verdict", "pass",
            cwd=tmp,
            env=env,
        )

        assert resumed.returncode == 0, resumed.stdout + resumed.stderr
        assert json.loads(resumed.stdout)["verification_id"] == verification_id
        evaluator_args = json.loads(args_path.read_text(encoding="utf-8"))
        assert evaluator_args[-2:] == [
            "--verification-id",
            verification_id,
        ]
        events = read_events(task_dir)
        assert len([
            event for event in events if event["event"] == "task.verified"
        ]) == 1
        completed = next(
            event for event in events
            if event["event"] == "evaluation.trigger_completed"
        )
        assert completed["verification_id"] == verification_id
        subject_hash = json.loads(resumed.stdout)["evaluation"]["subjectHash"]
        assert completed["subject_hash"] == subject_hash
        assert completed["subject_version"] == TEST_SUBJECT_VERSION
        assert completed["suite_version"] == TEST_SUITE_VERSION
        verification = json.loads(
            (task_dir / "verification.json").read_text(encoding="utf-8")
        )
        trigger = verification["evaluation_triggers"][verification_id]
        assert trigger["status"] == "completed"
        assert trigger["subject_hash"] == subject_hash
        assert trigger["subject_version"] == TEST_SUBJECT_VERSION
        assert trigger["suite_version"] == TEST_SUITE_VERSION


def test_verify_rejects_mismatched_v4_evaluation_binding():
    invalid_fields = {
        "verification-id": ("verificationId", "verification-other"),
        "subject-hash": ("subjectHash", "A" * 64),
        "subject-version": (
            "subjectVersion",
            "work-harness-run-subject.v3",
        ),
        "suite-version": ("suiteVersion", "v3"),
    }
    with tempfile.TemporaryDirectory() as tmp:
        for label, (field, invalid_value) in invalid_fields.items():
            task_id = f"invalid-v4-{label}"
            task_dir = prepare_task_for_verify(tmp, task_id)
            evaluation = work_evaluation_value(
                task_dir,
                f"run-{task_id}",
            )
            evaluation[field] = invalid_value
            env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))

            result = run(
                "verify", str(task_dir), "--verdict", "pass",
                cwd=tmp,
                env=env,
            )

            assert result.returncode == 2, (
                f"{label} was accepted\n"
                + result.stdout + result.stderr
            )
            assert json.loads(result.stdout)["evaluation"]["reason"] == (
                "invalid_output"
            )
            events = read_events(task_dir)
            failed = next(
                event for event in events
                if event["event"] == "evaluation.trigger_failed"
            )
            assert failed["reason"] == "invalid_output"
            assert not any(
                event["event"] == "evaluation.trigger_completed"
                for event in events
            )


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
        assert run("add-node", str(task_dir), "--node-id", "tiny", "--goal", "tiny", *node_context_args(), cwd=tmp).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "one-reason", "--goal", "one reason",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "parallelism", *node_context_args(), cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "valid", "--goal", "valid unit",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--read-scope", "src/a", "--dispatch-reason", "parallelism",
            "--dispatch-reason", "context_reduction", *node_context_args(), cwd=tmp,
        ).returncode == 0
        assert run("validate", str(task_dir), cwd=tmp).returncode == 0


def test_parallel_waves_and_write_scope_conflict():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "parallel", "--objective", "parallel", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "parallel"
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "parallelism", "--dispatch-reason", "context_reduction", *node_context_args()]
        assert run("add-node", str(task_dir), "--node-id", "a", "--goal", "a", "--write-scope", "src/shared", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "b", "--goal", "b", "--write-scope", "src/shared/file", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "c", "--goal", "c", "--write-scope", "src/other", *common, cwd=tmp).returncode == 0
        next_payload = json.loads(run("next", str(task_dir), cwd=tmp).stdout)
        assert next_payload["parallel_waves"] == [["a", "c"], ["b"]]
        assert run("start-node", str(task_dir), "--node-id", "a", *parent_executor_args(), cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "b", *parent_executor_args(), cwd=tmp).returncode == 2
        assert run("start-node", str(task_dir), "--node-id", "c", *parent_executor_args(), cwd=tmp).returncode == 0


def test_cycle_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run("init", "--task-id", "cycle", "--objective", "cycle", "--root", str(root), cwd=tmp).returncode == 0
        task_dir = root / "cycle"
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation", *node_context_args()]
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
        assert run("add-node", str(task_dir), "--node-id", "hidden-agent", "--goal", "hidden", "--post-condition", "hidden handoff", "--acceptance", "handoff exists", "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "hidden-agent", *parent_executor_args(), cwd=tmp).returncode == 0
        write_handoff(hidden, task_dir, "hidden-agent")
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
        common = ["--post-condition", "done", "--acceptance", "handoff exists", "--dispatch-reason", "context_reduction", "--dispatch-reason", "evidence_separation", *node_context_args()]
        assert run("add-node", str(task_dir), "--node-id", "a", "--goal", "a", *common, cwd=tmp).returncode == 0
        assert run("add-node", str(task_dir), "--node-id", "b", "--goal", "b", "--depends-on", "a", *common, cwd=tmp).returncode == 0
        assert run("start-node", str(task_dir), "--node-id", "b", *parent_executor_args(), cwd=tmp).returncode == 2
        handoff = task_dir / "handoff.json"
        handoff.write_text(json.dumps({"status": "completed", "conclusion": "done", "evidence": [], "artifacts": [], "validation": [], "risks": [], "next_action": "none"}), encoding="utf-8")
        assert run("record-handoff", str(task_dir), "--node-id", "a", "--file", str(handoff), cwd=tmp).returncode == 2
        bad_native = Path(tmp) / "bad-native.json"
        bad_native.write_text(json.dumps({"steps": [{"step": "bad", "status": "unknown"}]}), encoding="utf-8")
        assert run("import-native-plan", str(task_dir), "--file", str(bad_native), cwd=tmp).returncode == 2


def test_context_pack_requires_real_facts_and_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "context", "--objective", "context",
            "--scope", "src/context", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "context"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_verification",
        ]
        assert run(
            "add-node", str(task_dir), "--node-id", "missing", "--goal", "missing",
            *common, cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "placeholder-fact", "--goal", "placeholder",
            *common, "--known-fact", "待主 Agent 补充",
            "--evidence-ref", "file://artifacts/evidence.json", cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "placeholder-evidence", "--goal", "placeholder",
            *common, "--known-fact", "a real fact", "--evidence-ref", "TBD", cwd=tmp,
        ).returncode == 2

        result = run(
            "add-node", str(task_dir), "--node-id", "real", "--goal", "real context",
            *common, "--read-scope", "src/context", *node_context_args(), cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        input_text = (task_dir / "nodes" / "real" / "input.md").read_text(encoding="utf-8")
        assert "待主 Agent 补充" not in input_text
        assert "the repository evidence was inspected" in input_text
        assert "file://artifacts/source-evidence.json" in input_text
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        real = next(node for node in plan["nodes"] if node["id"] == "real")
        assert real["known_facts"] == ["the repository evidence was inspected"]
        assert real["evidence_refs"] == ["file://artifacts/source-evidence.json"]

        result = run(
            "add-node", str(task_dir), "--node-id", "native", "--goal", "native projection",
            "--kind", "native-plan-step", cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        native_input = (task_dir / "nodes" / "native" / "input.md").read_text(encoding="utf-8")
        assert "待主 Agent 补充" not in native_input


def test_new_scope_items_reject_bundled_scopes_but_history_stays_readable():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "comma", "--objective", "bad",
            "--scope", "src/a,src/b", "--root", str(root), cwd=tmp,
        ).returncode == 2
        assert not (root / "comma").exists()
        assert run(
            "init", "--task-id", "absolute", "--objective", "bad",
            "--scope", "/repo/a /repo/b", "--root", str(root), cwd=tmp,
        ).returncode == 2
        assert not (root / "absolute").exists()

        assert run(
            "init", "--task-id", "scope", "--objective", "scope",
            "--scope", "/repo/a", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "scope"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_verification",
            *node_context_args(),
        ]
        assert run(
            "add-node", str(task_dir), "--node-id", "comma-node", "--goal", "bad",
            "--read-scope", "src/a,src/b", *common, cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "absolute-node", "--goal", "bad",
            "--write-scope", "/repo/a /repo/b", *common, cwd=tmp,
        ).returncode == 2
        assert run(
            "add-node", str(task_dir), "--node-id", "historical", "--goal", "history",
            "--read-scope", "/repo/a", *common, cwd=tmp,
        ).returncode == 0

        task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
        task["scope"] = ["/repo/a /repo/b"]
        (task_dir / "task.json").write_text(json.dumps(task), encoding="utf-8")
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        plan["nodes"][0]["read_scope"] = ["/repo/a /repo/b"]
        (task_dir / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        assert run("validate", str(task_dir), cwd=tmp).returncode == 0


def test_start_node_records_executor_identity_and_managed_lease():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "identity", "--objective", "identity",
            "--max-agents", "3", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "identity"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_verification",
            *node_context_args(),
        ]
        for node_id in ("parent", "subagent", "team"):
            assert run(
                "add-node", str(task_dir), "--node-id", node_id, "--goal", node_id,
                "--write-scope", f"src/{node_id}", *common, cwd=tmp,
            ).returncode == 0

        assert run("start-node", str(task_dir), "--node-id", "parent", cwd=tmp).returncode == 2
        assert run(
            "start-node", str(task_dir), "--node-id", "parent",
            "--executor-kind", "parent", "--runtime", "codex",
            "--lease-seconds", "29", cwd=tmp,
        ).returncode == 2
        assert run(
            "start-node", str(task_dir), "--node-id", "parent",
            "--executor-kind", "parent", "--runtime", "codex",
            "--lease-seconds", "3601", cwd=tmp,
        ).returncode == 2
        assert run(
            "start-node", str(task_dir), "--node-id", "parent",
            "--executor-kind", "parent", "--runtime", "codex",
            "--lease-seconds", "60", cwd=tmp,
        ).returncode == 0
        assert run(
            "start-node", str(task_dir), "--node-id", "subagent",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--lease-seconds", "60", cwd=tmp,
        ).returncode == 2
        assert run(
            "start-node", str(task_dir), "--node-id", "subagent",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--executor-id", "codex-agent-42", "--lease-seconds", "60", cwd=tmp,
        ).returncode == 0
        assert run(
            "start-node", str(task_dir), "--node-id", "team",
            "--executor-kind", "team", "--runtime", "claude-code",
            "--executor-id", "flight-team", cwd=tmp,
        ).returncode == 0

        state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
        parent = state["executions"]["parent"]
        assert parent["executor_kind"] == "parent"
        assert parent["runtime"] == "codex"
        assert parent["executor_id"] is None
        assert parent["lease_seconds"] == 60
        assert parent["status"] == "running"
        assert parent["lease_expires_at"].endswith("Z")
        assert state["executions"]["subagent"]["executor_id"] == "codex-agent-42"
        assert state["executions"]["team"]["runtime"] == "claude-code"
        assert state["executions"]["team"]["lease_seconds"] == 900
        started = [event for event in read_events(task_dir) if event["event"] == "node.started"]
        assert {event["executor_kind"] for event in started} == {"parent", "subagent", "team"}
        assert all("runtime" in event and "executor_id" in event for event in started)


def test_lease_heartbeat_read_only_stale_check_and_explicit_recovery():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "lease", "--objective", "lease",
            "--max-retries", "1", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "lease"
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "worker",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        start_args = [
            "start-node", str(task_dir), "--node-id", "worker",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--executor-id", "agent-one", "--lease-seconds", "60",
        ]
        started = run(*start_args, cwd=tmp)
        assert started.returncode == 0
        execution_id = json.loads(started.stdout)["execution_id"]
        assert run(
            "heartbeat", str(task_dir), "--node-id", "worker",
            "--execution-id", execution_id, cwd=tmp,
        ).returncode == 0
        state_path = task_dir / "run-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        assert state["executions"]["worker"]["heartbeat_count"] == 1

        state = set_managed_lease_expiry(
            task_dir,
            "worker",
            "2000-01-01T00:00:00Z",
        )
        guarded_paths = [
            task_dir / "task.json",
            task_dir / "plan.json",
            task_dir / "run-state.json",
            task_dir / "events.jsonl",
            task_dir / "nodes" / "worker" / "execution.json",
        ]
        before = {path: path.read_bytes() for path in guarded_paths}
        checked = run("check-stale", str(task_dir), cwd=tmp)
        assert checked.returncode == 0, checked.stdout + checked.stderr
        payload = json.loads(checked.stdout)
        assert payload["stale_count"] == 1
        assert payload["stale"][0]["node_id"] == "worker"
        assert payload["stale"][0]["reason"] == "lease_expired"
        assert before == {path: path.read_bytes() for path in guarded_paths}
        assert run("heartbeat", str(task_dir), "--node-id", "worker", cwd=tmp).returncode == 2
        assert run(*start_args, cwd=tmp).returncode == 2

        recovered = run("recover-stale", str(task_dir), "--node-id", "worker", cwd=tmp)
        assert recovered.returncode == 0, recovered.stdout + recovered.stderr
        assert json.loads(recovered.stdout)["retry_available"] is True
        state = json.loads(state_path.read_text(encoding="utf-8"))
        assert state["current_nodes"] == []
        assert state["executions"]["worker"]["status"] == "failed"
        assert run(*start_args, cwd=tmp).returncode == 0
        state = json.loads(state_path.read_text(encoding="utf-8"))
        assert state["attempts"]["worker"] == 2
        assert "failed_node" not in state
        set_managed_lease_expiry(
            task_dir,
            "worker",
            "2000-01-01T00:00:00Z",
        )
        recovered = run("recover-stale", str(task_dir), "--node-id", "worker", cwd=tmp)
        assert recovered.returncode == 0, recovered.stdout + recovered.stderr
        assert json.loads(recovered.stdout)["retry_available"] is False
        assert run(*start_args, cwd=tmp).returncode == 2
        recovered_events = [event for event in read_events(task_dir) if event["event"] == "node.stale_recovered"]
        assert [event["retry_available"] for event in recovered_events] == [True, False]


def test_check_stale_supports_historical_running_tasks_without_mutation():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "legacy-event", "--objective", "legacy",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "legacy-event"
        assert run(
            "add-node", str(task_dir), "--node-id", "old-worker", "--goal", "legacy",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        plan_path = task_dir / "plan.json"
        state_path = task_dir / "run-state.json"
        events_path = task_dir / "events.jsonl"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["nodes"][0]["status"] = "running"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state.pop("executions", None)
        state.update({
            "status": "running",
            "current_nodes": ["old-worker"],
            "attempts": {"old-worker": 1},
            "updated_at": "2020-01-01T00:00:00Z",
        })
        state_path.write_text(json.dumps(state), encoding="utf-8")
        with events_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({
                "at": "2020-01-02T00:00:00Z",
                "event": "node.started",
                "node_id": "old-worker",
                "attempt": 1,
            }) + "\n")
        guarded_paths = [task_dir / "task.json", plan_path, state_path, events_path]
        before = {path: path.read_bytes() for path in guarded_paths}
        checked = run(
            "check-stale", str(task_dir), "--older-than-seconds", "60", cwd=tmp,
        )
        assert checked.returncode == 0, checked.stdout + checked.stderr
        stale = json.loads(checked.stdout)["stale"][0]
        assert stale["node_id"] == "old-worker"
        assert stale["reason"] == "legacy_activity_timeout"
        assert stale["activity_source"] == "event:node.started"
        assert before == {path: path.read_bytes() for path in guarded_paths}
        assert run("validate", str(task_dir), cwd=tmp).returncode == 0
        assert run(
            "recover-stale", str(task_dir), "--node-id", "old-worker", cwd=tmp,
        ).returncode == 2
        assert run(
            "recover-stale", str(task_dir), "--node-id", "old-worker",
            "--older-than-seconds", "60", cwd=tmp,
        ).returncode == 0
        recovered_state = json.loads(state_path.read_text(encoding="utf-8"))
        assert recovered_state["status"] == "failed"
        assert recovered_state["current_nodes"] == []
        assert any(
            event["event"] == "node.stale_recovered"
            and event["reason"] == "legacy_activity_timeout"
            for event in read_events(task_dir)
        )

        fallback_root = Path(tmp) / ".agent-work-fallback"
        assert run(
            "init", "--task-id", "legacy-state", "--objective", "legacy",
            "--root", str(fallback_root), cwd=tmp,
        ).returncode == 0
        fallback_dir = fallback_root / "legacy-state"
        assert run(
            "add-node", str(fallback_dir), "--node-id", "old-worker", "--goal", "legacy",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        fallback_plan = json.loads((fallback_dir / "plan.json").read_text(encoding="utf-8"))
        fallback_plan["nodes"][0]["status"] = "running"
        (fallback_dir / "plan.json").write_text(json.dumps(fallback_plan), encoding="utf-8")
        fallback_state = json.loads((fallback_dir / "run-state.json").read_text(encoding="utf-8"))
        fallback_state.pop("executions", None)
        fallback_state.update({
            "status": "running",
            "current_nodes": ["old-worker"],
            "attempts": {"old-worker": 1},
            "updated_at": "2020-01-03T00:00:00Z",
        })
        (fallback_dir / "run-state.json").write_text(json.dumps(fallback_state), encoding="utf-8")
        checked = run(
            "check-stale", str(fallback_dir), "--older-than-seconds", "60", cwd=tmp,
        )
        assert checked.returncode == 0, checked.stdout + checked.stderr
        stale = json.loads(checked.stdout)["stale"][0]
        assert stale["activity_source"] == "run-state.updated_at"


def test_record_domain_evaluation_validates_and_atomically_projects_contract():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "domain-eval", "--objective", "domain",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "domain-eval"
        report = task_dir / "artifacts" / "domain-report.json"
        report_bytes = b'{"cases":30,"passed":30}\n'
        report.write_bytes(report_bytes)
        report_hash = hashlib.sha256(report_bytes).hexdigest()
        incoming = Path(tmp) / "domain-evaluation.json"
        expected = write_domain_evaluation(
            incoming,
            "domain-eval",
            "run-domain-eval",
            "file://artifacts/domain-report.json",
            report_hash,
        )
        result = run(
            "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        projected = json.loads((task_dir / "domain-evaluation.json").read_text(encoding="utf-8"))
        assert projected == expected
        events = read_events(task_dir)
        recorded = next(event for event in events if event["event"] == "domain_evaluation.recorded")
        assert recorded["suite_id"] == "flight-domain-regression"
        assert recorded["report_hash"] == report_hash
        assert recorded["hard_gate_passed"] is True
        assert not list(task_dir.glob(".domain-evaluation.json.*"))

        absolute_report = Path(tmp) / "absolute-domain-report.json"
        absolute_report.write_bytes(b"absolute report\n")
        absolute_hash = hashlib.sha256(absolute_report.read_bytes()).hexdigest()
        absolute_expected = write_domain_evaluation(
            incoming,
            "domain-eval",
            "run-domain-eval",
            f"file://{absolute_report}",
            absolute_hash,
        )
        absolute_expected["hard_gate_passed"] = False
        absolute_expected["result"] = "blocked"
        incoming.write_text(json.dumps(absolute_expected), encoding="utf-8")
        result = run(
            "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads(
            (task_dir / "domain-evaluation.json").read_text(encoding="utf-8")
        ) == absolute_expected


def test_record_domain_evaluation_rejects_invalid_fields_hash_and_symlink():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "domain-invalid", "--objective", "domain",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "domain-invalid"
        report = task_dir / "artifacts" / "domain-report.json"
        report.write_bytes(b"domain report\n")
        report_hash = hashlib.sha256(report.read_bytes()).hexdigest()
        incoming = Path(tmp) / "domain-evaluation.json"
        base = write_domain_evaluation(
            incoming,
            "domain-invalid",
            "run-domain-invalid",
            "file://artifacts/domain-report.json",
            report_hash,
        )
        mutations = [
            {"schema": "wrong"},
            {"task_id": "other-task"},
            {"run_id": "run-other-task"},
            {"suite_id": ""},
            {"suite_version": ""},
            {"grader_version": ""},
            {"required": 1},
            {"hard_gate_passed": "true"},
            {"result": "partial"},
            {"report_ref": "artifact://domain-report"},
            {"report_hash": report_hash.upper()},
            {"metrics": {"nested": {"value": 1}}},
            {"evidence_refs": []},
            {"evaluated_at": "2026-07-23T10:00:00"},
        ]
        for mutation in mutations:
            incoming.write_text(json.dumps({**base, **mutation}), encoding="utf-8")
            result = run(
                "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
            )
            assert result.returncode == 2, (mutation, result.stdout, result.stderr)
            assert not (task_dir / "domain-evaluation.json").exists()

        incoming.write_text(json.dumps({**base, "report_hash": "0" * 64}), encoding="utf-8")
        assert run(
            "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
        ).returncode == 2
        assert not (task_dir / "domain-evaluation.json").exists()

        symlink = task_dir / "artifacts" / "linked-report.json"
        symlink.symlink_to(report)
        linked_hash = hashlib.sha256(report.read_bytes()).hexdigest()
        linked = {
            **base,
            "report_ref": "file://artifacts/linked-report.json",
            "report_hash": linked_hash,
            "evidence_refs": ["file://artifacts/linked-report.json"],
        }
        incoming.write_text(json.dumps(linked), encoding="utf-8")
        assert run(
            "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
        ).returncode == 2
        assert not (task_dir / "domain-evaluation.json").exists()


def test_domain_evaluation_matches_typescript_consumer_contract():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "domain-ts", "--objective", "domain",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "domain-ts"
        report = task_dir / "artifacts" / "domain-report.json"
        report.write_bytes(b"domain report\n")
        report_hash = hashlib.sha256(report.read_bytes()).hexdigest()
        incoming = Path(tmp) / "domain-evaluation.json"
        base = write_domain_evaluation(
            incoming,
            "domain-ts",
            "run-domain-ts",
            "file://artifacts/domain-report.json",
            report_hash,
        )
        mutations = [
            {"metrics": {"null_metric": None}},
            {"metrics": {"prompt_tokens": 1}},
            {"metrics": {"output_count": 1}},
            {"metrics": {"report_path": "safe"}},
            {"metrics": {"source_url": "safe"}},
            {"metrics": {"payload_hash": "safe"}},
            {"metrics": {"approval": True}},
            {"metrics": {"status": ""}},
            {"metrics": {"status": "https://example.test/report"}},
            {"metrics": {"status": "file://artifacts/report.json"}},
            {"metrics": {"status": "/absolute/path"}},
            {"metrics": {"status": "~/report"}},
            {"hard_gate_passed": False, "result": "pass"},
            {"hard_gate_passed": True, "result": "blocked"},
            {"suite_id": "unsafe suite"},
            {"suite_version": "v/1"},
            {"grader_version": "g" * 65},
            {"evidence_refs": ["unsafe-reference"]},
            {"evidence_refs": ["https://example.test/evidence"]},
            {"evaluated_at": "2026-02-30T10:00:00Z"},
            {"evaluated_at": "2026-07-23T10:00:00-05:60"},
        ]
        for mutation in mutations:
            incoming.write_text(json.dumps({**base, **mutation}), encoding="utf-8")
            result = run(
                "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
            )
            assert result.returncode == 2, (mutation, result.stdout, result.stderr)
            assert not (task_dir / "domain-evaluation.json").exists()

        valid = {
            **base,
            "metrics": {
                "approval_present": True,
                "status": " stable ",
                "case_count": 30,
            },
            "evidence_refs": [
                "artifact://domain/report-1",
                "file://artifacts/domain-report.json",
            ],
        }
        incoming.write_text(json.dumps(valid), encoding="utf-8")
        result = run(
            "record-domain-evaluation", str(task_dir), "--file", str(incoming), cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr


def test_optional_context_fields_are_projected_without_becoming_required():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "optional-context", "--objective", "context",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "optional-context"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_verification",
            *node_context_args(),
        ]
        result = run(
            "add-node", str(task_dir), "--node-id", "explicit", "--goal", "explicit",
            "--decision", "reuse the existing state file",
            "--open-question", "whether the caller needs a verifier",
            "--constraint", "do not modify sibling outputs",
            *common, cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        result = run(
            "add-node", str(task_dir), "--node-id", "defaults", "--goal", "defaults",
            *common, cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        explicit = next(node for node in plan["nodes"] if node["id"] == "explicit")
        defaults = next(node for node in plan["nodes"] if node["id"] == "defaults")
        assert explicit["decisions"] == ["reuse the existing state file"]
        assert explicit["open_questions"] == ["whether the caller needs a verifier"]
        assert explicit["constraints"] == ["do not modify sibling outputs"]
        assert defaults["decisions"] == []
        assert defaults["open_questions"] == []
        assert defaults["constraints"] == [
            "遵守 task.json 和节点 allowed_side_effects"
        ]
        explicit_input = (
            task_dir / "nodes" / "explicit" / "input.md"
        ).read_text(encoding="utf-8")
        defaults_input = (
            task_dir / "nodes" / "defaults" / "input.md"
        ).read_text(encoding="utf-8")
        assert "reuse the existing state file" in explicit_input
        assert "whether the caller needs a verifier" in explicit_input
        assert "do not modify sibling outputs" in explicit_input
        assert "遵守 task.json 和节点 allowed_side_effects" in defaults_input


def test_restarting_blocked_node_clears_stale_projection():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "blocked-retry", "--objective", "retry",
            "--max-retries", "1", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "blocked-retry"
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "worker",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        assert run(
            "start-node", str(task_dir), "--node-id", "worker",
            *parent_executor_args(), cwd=tmp,
        ).returncode == 0
        handoff = Path(tmp) / "blocked-handoff.json"
        write_handoff(handoff, task_dir, "worker", status="blocked")
        assert run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(handoff), cwd=tmp,
        ).returncode == 0
        state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
        assert state["blocked_node"] == "worker"
        state["failed_node"] = "worker"
        (task_dir / "run-state.json").write_text(
            json.dumps(state),
            encoding="utf-8",
        )
        assert run(
            "start-node", str(task_dir), "--node-id", "worker",
            *parent_executor_args(), cwd=tmp,
        ).returncode == 0
        state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
        assert "blocked_node" not in state
        assert "failed_node" not in state


def test_execution_id_binds_heartbeat_and_handoff_to_current_attempt():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "execution-binding", "--objective", "binding",
            "--max-agents", "2", "--max-retries", "1", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "execution-binding"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry",
            *node_context_args(),
        ]
        for node_id in ("worker", "other"):
            assert run(
                "add-node", str(task_dir), "--node-id", node_id, "--goal", node_id,
                "--write-scope", f"src/{node_id}", *common, cwd=tmp,
            ).returncode == 0

        first = run(
            "start-node", str(task_dir), "--node-id", "worker",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--executor-id", "agent-one", "--lease-seconds", "60", cwd=tmp,
        )
        assert first.returncode == 0, first.stdout + first.stderr
        first_payload = json.loads(first.stdout)
        first_execution_id = first_payload["execution_id"]
        assert first_execution_id.startswith("execution-")
        descriptor_path = task_dir / "nodes" / "worker" / "execution.json"
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        assert descriptor["task_id"] == "execution-binding"
        assert descriptor["run_id"] == "run-execution-binding"
        assert descriptor["node_id"] == "worker"
        assert descriptor["attempt"] == 1
        assert descriptor["execution_id"] == first_execution_id
        state = json.loads((task_dir / "run-state.json").read_text(encoding="utf-8"))
        assert state["executions"]["worker"]["execution_id"] == first_execution_id

        assert run(
            "heartbeat", str(task_dir), "--node-id", "worker", cwd=tmp,
        ).returncode == 2
        assert run(
            "heartbeat", str(task_dir), "--node-id", "worker",
            "--execution-id", "execution-wrong", cwd=tmp,
        ).returncode == 2
        assert run(
            "heartbeat", str(task_dir), "--node-id", "worker",
            "--execution-id", first_execution_id, cwd=tmp,
        ).returncode == 0

        other = run(
            "start-node", str(task_dir), "--node-id", "other",
            *parent_executor_args(), "--lease-seconds", "60", cwd=tmp,
        )
        assert other.returncode == 0, other.stdout + other.stderr
        cross_node = Path(tmp) / "cross-node.json"
        cross_node.write_text(
            json.dumps(handoff_value(task_dir, "other")),
            encoding="utf-8",
        )
        assert run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(cross_node), cwd=tmp,
        ).returncode == 2

        current_handoff = Path(tmp) / "first-attempt.json"
        write_handoff(current_handoff, task_dir, "worker")
        state_path = task_dir / "run-state.json"
        set_managed_lease_expiry(
            task_dir,
            "worker",
            "2000-01-01T00:00:00Z",
        )
        assert run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(current_handoff), cwd=tmp,
        ).returncode == 2
        assert run(
            "recover-stale", str(task_dir), "--node-id", "worker", cwd=tmp,
        ).returncode == 0

        second = run(
            "start-node", str(task_dir), "--node-id", "worker",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--executor-id", "agent-two", "--lease-seconds", "60", cwd=tmp,
        )
        assert second.returncode == 0, second.stdout + second.stderr
        second_payload = json.loads(second.stdout)
        assert second_payload["attempt"] == 2
        assert second_payload["execution_id"] != first_execution_id
        assert run(
            "heartbeat", str(task_dir), "--node-id", "worker",
            "--execution-id", first_execution_id, cwd=tmp,
        ).returncode == 2
        assert run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(current_handoff), cwd=tmp,
        ).returncode == 2

        final_handoff = Path(tmp) / "second-attempt.json"
        write_handoff(final_handoff, task_dir, "worker")
        assert run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(final_handoff), cwd=tmp,
        ).returncode == 0
        recorded = [
            event for event in read_events(task_dir)
            if event["event"] == "node.handoff_recorded" and event["node_id"] == "worker"
        ]
        assert recorded[-1]["attempt"] == 2
        assert recorded[-1]["execution_id"] == second_payload["execution_id"]


def test_legacy_execution_without_execution_id_stays_explicitly_compatible():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "legacy-execution", "--objective", "legacy",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "legacy-execution"
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "worker",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        assert run(
            "start-node", str(task_dir), "--node-id", "worker",
            *parent_executor_args(), "--lease-seconds", "60", cwd=tmp,
        ).returncode == 0
        state_path = task_dir / "run-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["executions"]["worker"].pop("execution_id", None)
        state_path.write_text(json.dumps(state), encoding="utf-8")
        descriptor_path = task_dir / "nodes" / "worker" / "execution.json"
        if descriptor_path.exists():
            descriptor_path.unlink()
        events = read_events(task_dir)
        for event in events:
            if event.get("node_id") == "worker":
                event.pop("execution_id", None)
        (task_dir / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

        heartbeat = run("heartbeat", str(task_dir), "--node-id", "worker", cwd=tmp)
        assert heartbeat.returncode == 0, heartbeat.stdout + heartbeat.stderr
        assert json.loads(heartbeat.stdout)["identity_mode"] == "legacy"
        handoff = Path(tmp) / "legacy-handoff.json"
        handoff.write_text(json.dumps({
            "status": "completed",
            "conclusion": "legacy done",
            "evidence": [],
            "artifacts": [],
            "validation": [],
            "risks": [],
            "next_action": "continue",
        }), encoding="utf-8")
        result = run(
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(handoff), cwd=tmp,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        event = next(
            event for event in reversed(read_events(task_dir))
            if event["event"] == "node.handoff_recorded"
        )
        assert event["identity_mode"] == "legacy"


def test_any_execution_id_evidence_prevents_managed_to_legacy_downgrade():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        for source in ("run-state", "descriptor", "node-started", "handoff-event"):
            task_id = f"managed-evidence-{source}"
            assert run(
                "init", "--task-id", task_id, "--objective", "managed binding",
                "--root", str(root), cwd=tmp,
            ).returncode == 0
            task_dir = root / task_id
            assert run(
                "add-node", str(task_dir), "--node-id", "worker",
                "--goal", "worker", "--post-condition", "done",
                "--acceptance", "handoff exists",
                "--dispatch-reason", "independent_retry",
                *node_context_args(), cwd=tmp,
            ).returncode == 0
            started = run(
                "start-node", str(task_dir), "--node-id", "worker",
                *parent_executor_args(), "--lease-seconds", "60", cwd=tmp,
            )
            assert started.returncode == 0, started.stdout + started.stderr
            if source == "handoff-event":
                handoff_path = Path(tmp) / f"{task_id}-handoff.json"
                write_handoff(handoff_path, task_dir, "worker")
                recorded = run(
                    "record-handoff", str(task_dir), "--node-id", "worker",
                    "--file", str(handoff_path), cwd=tmp,
                )
                assert recorded.returncode == 0, recorded.stdout + recorded.stderr

            state_path = task_dir / "run-state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if source != "run-state":
                state["executions"]["worker"].pop("execution_id", None)
            state_path.write_text(json.dumps(state), encoding="utf-8")
            descriptor_path = task_dir / "nodes" / "worker" / "execution.json"
            if source != "descriptor" and descriptor_path.exists():
                descriptor_path.unlink()
            events = read_events(task_dir)
            for event in events:
                preserve = (
                    source == "node-started"
                    and event.get("event") == "node.started"
                ) or (
                    source == "handoff-event"
                    and event.get("event") == "node.handoff_recorded"
                )
                if event.get("node_id") == "worker" and not preserve:
                    event.pop("execution_id", None)
            (task_dir / "events.jsonl").write_text(
                "".join(json.dumps(event) + "\n" for event in events),
                encoding="utf-8",
            )

            validation = run("validate", str(task_dir), cwd=tmp)
            assert validation.returncode != 0, (
                f"{source} execution_id evidence downgraded to legacy\n"
                + validation.stdout + validation.stderr
            )
            if source in {"descriptor", "node-started"}:
                heartbeat = run(
                    "heartbeat", str(task_dir), "--node-id", "worker", cwd=tmp,
                )
                assert heartbeat.returncode == 2, (
                    f"{source} execution_id evidence allowed legacy heartbeat\n"
                    + heartbeat.stdout + heartbeat.stderr
                )


def test_scope_lexer_and_canonical_overlap_match_runtime_contract():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        invalid_scopes = [
            "/repo/a=/repo/b",
            "/repo/a;/repo/b",
            "/repo/a|/repo/b",
            r"C:\repo\a D:\repo\b",
        ]
        for index, scope in enumerate(invalid_scopes):
            result = run(
                "init", "--task-id", f"invalid-scope-{index}",
                "--objective", "invalid", "--scope", scope,
                "--root", str(root), cwd=tmp,
            )
            assert result.returncode == 2, (scope, result.stdout, result.stderr)

        assert run(
            "init", "--task-id", "canonical-scope", "--objective", "canonical",
            "--max-agents", "6", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "canonical-scope"
        common = [
            "--post-condition", "done",
            "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_write",
            *node_context_args(),
        ]
        scopes = {
            "alias-a": "/repo/a/../shared//",
            "alias-b": "/repo/shared/child/..",
            "root": "/",
            "root-child": "/elsewhere",
            "windows-a": r"C:\Repo\shared\..\target",
            "windows-b": "c:/repo/target/file",
        }
        for node_id, scope in scopes.items():
            assert run(
                "add-node", str(task_dir), "--node-id", node_id, "--goal", node_id,
                "--write-scope", scope, *common, cwd=tmp,
            ).returncode == 0
        payload = json.loads(run("next", str(task_dir), cwd=tmp).stdout)
        wave_by_node = {
            node_id: wave_index
            for wave_index, wave in enumerate(payload["parallel_waves"])
            for node_id in wave
        }
        assert wave_by_node["alias-a"] != wave_by_node["alias-b"]
        assert wave_by_node["root"] != wave_by_node["root-child"]
        assert wave_by_node["windows-a"] != wave_by_node["windows-b"]
        assert run(
            "start-node", str(task_dir), "--node-id", "alias-a",
            *parent_executor_args(), cwd=tmp,
        ).returncode == 0
        assert run(
            "start-node", str(task_dir), "--node-id", "alias-b",
            *parent_executor_args(), cwd=tmp,
        ).returncode == 2


def test_context_pack_projects_complete_task_and_spawn_contract():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "full-context", "--objective", "project every field",
            "--scope", "/repo", "--acceptance", "task accepted",
            "--allowed-side-effect", "task file writes",
            "--max-agents", "4", "--max-retries", "2", "--runtime", "codex",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "full-context"
        assert run(
            "add-node", str(task_dir), "--node-id", "dependency",
            "--goal", "native dependency", "--kind", "native-plan-step", cwd=tmp,
        ).returncode == 0
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "execute work",
            "--kind", "implement", "--depends-on", "dependency",
            "--post-condition", "work is complete",
            "--acceptance", "node accepted",
            "--read-scope", "/repo/input", "--write-scope", "/repo/output",
            "--known-fact", "known fact", "--evidence-ref", "source://repo/evidence",
            "--decision", "reuse state", "--open-question", "which verifier",
            "--constraint", "stay in scope", "--dispatch-reason", "independent_write",
            "--allowed-side-effect", "node file writes", cwd=tmp,
        ).returncode == 0
        plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
        node = next(item for item in plan["nodes"] if item["id"] == "worker")
        assert node == {
            "id": "worker",
            "kind": "implement",
            "goal": "execute work",
            "depends_on": ["dependency"],
            "post_conditions": ["work is complete"],
            "acceptance": ["node accepted"],
            "read_scope": ["/repo/input"],
            "write_scope": ["/repo/output"],
            "known_facts": ["known fact"],
            "evidence_refs": ["source://repo/evidence"],
            "decisions": ["reuse state"],
            "open_questions": ["which verifier"],
            "constraints": ["stay in scope"],
            "dispatch_reasons": ["independent_write"],
            "output_contract": {"handoff": "nodes/worker/handoff.json"},
            "allowed_side_effects": ["node file writes"],
            "status": "pending",
        }
        input_text = (task_dir / "nodes" / "worker" / "input.md").read_text(
            encoding="utf-8"
        )
        for fragment in (
            "- task_schema: work-harness-task-v1",
            "- task_id: full-context",
            "- run_id: run-full-context",
            "- objective: project every field",
            "- task_runtime: codex",
            "- task_created_at: ",
            "- scope:",
            "  - /repo",
            "- task_acceptance:",
            "  - task accepted",
            "- task_allowed_side_effects:",
            "  - task file writes",
            "- budget:",
            "  - max_agents: 4",
            "  - max_retries: 2",
            "- node_id: worker",
            "- kind: implement",
            "- goal: execute work",
            "- depends_on:",
            "  - dependency",
            "- post_conditions:",
            "  - work is complete",
            "- acceptance:",
            "  - node accepted",
            "- read_scope:",
            "  - /repo/input",
            "- write_scope:",
            "  - /repo/output",
            "- known_facts:",
            "  - known fact",
            "- evidence_refs:",
            "  - source://repo/evidence",
            "- decisions:",
            "  - reuse state",
            "- open_questions:",
            "  - which verifier",
            "- constraints:",
            "  - stay in scope",
            "- dispatch_reasons:",
            "  - independent_write",
            '- output_contract: {"handoff": "nodes/worker/handoff.json"}',
            "- node_allowed_side_effects:",
            "  - node file writes",
            "- initial_status: pending",
        ):
            assert fragment in input_text, fragment


def test_validate_and_next_take_one_shared_lock_snapshot():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "shared-snapshot", "--objective", "snapshot",
            "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "shared-snapshot"
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "worker",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_verification",
            *node_context_args(), cwd=tmp,
        ).returncode == 0
        process_env = os.environ.copy()
        process_env["WORK_HARNESS_EVAL_PLANE_SCRIPT"] = "off"
        for command in ("validate", "next"):
            with (task_dir / ".lock").open("a+", encoding="utf-8") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                process = subprocess.Popen(
                    [sys.executable, str(SCRIPT), command, str(task_dir)],
                    cwd=tmp,
                    env=process_env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                returned_while_locked = False
                try:
                    process.wait(timeout=0.25)
                    returned_while_locked = True
                except subprocess.TimeoutExpired:
                    pass
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
            stdout, stderr = process.communicate(timeout=5)
            assert not returned_while_locked, (command, stdout, stderr)
            assert process.returncode == 0, stdout + stderr


def test_node_add_journals_plan_and_context_pack_without_orphans():
    stages = {
        "before_journal": (False, False, False),
        "after_journal": (True, False, False),
        "after_target:plan.json": (True, True, False),
        "after_target:nodes/worker/input.md": (True, True, True),
    }
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        for index, (stage, expected) in enumerate(stages.items()):
            task_id = f"journal-add-{index}"
            assert run(
                "init", "--task-id", task_id, "--objective", "atomic node add",
                "--root", str(root), cwd=tmp,
            ).returncode == 0
            task_dir = root / task_id
            add_args = [
                "add-node", str(task_dir), "--node-id", "worker",
                "--goal", "worker", "--post-condition", "done",
                "--acceptance", "context is durable",
                "--dispatch-reason", "independent_retry",
                *node_context_args(),
            ]
            fault = {
                "WORK_HARNESS_FAULT_TRANSITION": "node.add",
                "WORK_HARNESS_FAULT_STAGE": stage,
            }

            interrupted = run(*add_args, cwd=tmp, env=fault)

            assert interrupted.returncode == 2, (
                f"node.add did not stop at {stage}\n"
                + interrupted.stdout + interrupted.stderr
            )
            journal_exists, plan_contains_node, input_exists = expected
            journal_path = task_dir / ".transition-journal.json"
            plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
            assert journal_path.exists() is journal_exists, stage
            assert any(
                node.get("id") == "worker" for node in plan["nodes"]
            ) is plan_contains_node, stage
            assert (
                task_dir / "nodes" / "worker" / "input.md"
            ).exists() is input_exists, stage
            if journal_exists:
                assert run("validate", str(task_dir), cwd=tmp).returncode != 0

            resumed = run(*add_args, cwd=tmp)
            assert resumed.returncode == (2 if journal_exists else 0), (
                stage + "\n" + resumed.stdout + resumed.stderr
            )
            assert not journal_path.exists(), stage
            plan = json.loads((task_dir / "plan.json").read_text(encoding="utf-8"))
            assert [
                node["id"] for node in plan["nodes"] if node["id"] == "worker"
            ] == ["worker"], stage
            input_path = task_dir / "nodes" / "worker" / "input.md"
            assert input_path.is_file(), stage
            assert "# ContextPack" in input_path.read_text(encoding="utf-8")
            assert len([
                event for event in read_events(task_dir)
                if event["event"] == "node.added"
                and event["node_id"] == "worker"
            ]) == 1, stage


def test_transition_journal_recovers_start_heartbeat_recover_handoff_and_verify():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / ".agent-work"
        assert run(
            "init", "--task-id", "journal-node", "--objective", "journal",
            "--max-retries", "1", "--root", str(root), cwd=tmp,
        ).returncode == 0
        task_dir = root / "journal-node"
        assert run(
            "add-node", str(task_dir), "--node-id", "worker", "--goal", "worker",
            "--post-condition", "done", "--acceptance", "handoff exists",
            "--dispatch-reason", "independent_retry", *node_context_args(), cwd=tmp,
        ).returncode == 0
        start_args = [
            "start-node", str(task_dir), "--node-id", "worker",
            "--executor-kind", "subagent", "--runtime", "codex",
            "--executor-id", "journal-agent", "--lease-seconds", "60",
        ]
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "node.start",
            "WORK_HARNESS_FAULT_STAGE": "after_target:plan.json",
        }
        assert run(*start_args, cwd=tmp, env=fault).returncode == 2
        journal_path = task_dir / ".transition-journal.json"
        assert journal_path.is_file()
        assert run("validate", str(task_dir), cwd=tmp).returncode != 0
        assert run(*start_args, cwd=tmp).returncode == 2
        assert not journal_path.exists()
        state_path = task_dir / "run-state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        execution_id = state["executions"]["worker"]["execution_id"]
        assert len([
            event for event in read_events(task_dir)
            if event["event"] == "node.started"
        ]) == 1

        heartbeat_args = [
            "heartbeat", str(task_dir), "--node-id", "worker",
            "--execution-id", execution_id,
        ]
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "node.heartbeat",
            "WORK_HARNESS_FAULT_STAGE": "after_target:run-state.json",
        }
        assert run(*heartbeat_args, cwd=tmp, env=fault).returncode == 2
        assert journal_path.is_file()
        assert run("next", str(task_dir), cwd=tmp).returncode != 0
        assert run(*heartbeat_args, cwd=tmp).returncode == 0
        assert not journal_path.exists()
        state = json.loads(state_path.read_text(encoding="utf-8"))
        assert state["executions"]["worker"]["heartbeat_count"] == 2

        state["executions"]["worker"]["lease_expires_at"] = "2000-01-01T00:00:00Z"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        descriptor_path = task_dir / "nodes" / "worker" / "execution.json"
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        descriptor["lease_expires_at"] = "2000-01-01T00:00:00Z"
        descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
        recover_args = ["recover-stale", str(task_dir), "--node-id", "worker"]
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "node.recover_stale",
            "WORK_HARNESS_FAULT_STAGE": "after_target:plan.json",
        }
        assert run(*recover_args, cwd=tmp, env=fault).returncode == 2
        assert journal_path.is_file()
        assert run("check-stale", str(task_dir), cwd=tmp).returncode != 0
        assert run(*recover_args, cwd=tmp).returncode == 2
        assert json.loads(state_path.read_text(encoding="utf-8"))["status"] == "failed"
        assert len([
            event for event in read_events(task_dir)
            if event["event"] == "node.stale_recovered"
        ]) == 1
        restarted = run(*start_args, cwd=tmp)
        assert restarted.returncode == 0, restarted.stdout + restarted.stderr

        handoff = Path(tmp) / "journal-handoff.json"
        write_handoff(handoff, task_dir, "worker")
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "node.handoff",
            "WORK_HARNESS_FAULT_STAGE": "after_target:nodes/worker/handoff.json",
        }
        record_args = [
            "record-handoff", str(task_dir), "--node-id", "worker",
            "--file", str(handoff),
        ]
        assert run(*record_args, cwd=tmp, env=fault).returncode == 2
        assert journal_path.is_file()
        assert run("validate", str(task_dir), cwd=tmp).returncode != 0
        assert run(*record_args, cwd=tmp).returncode == 2
        assert json.loads(state_path.read_text(encoding="utf-8"))["status"] == "verifying"
        assert len([
            event for event in read_events(task_dir)
            if event["event"] == "node.handoff_recorded"
        ]) == 1

        verify_dir = prepare_task_for_verify(tmp, "journal-verify")
        fault = {
            "WORK_HARNESS_FAULT_TRANSITION": "task.verify",
            "WORK_HARNESS_FAULT_STAGE": "after_target:verification.json",
        }
        assert run(
            "verify", str(verify_dir), "--verdict", "pass", cwd=tmp, env=fault,
        ).returncode == 2
        verify_journal = verify_dir / ".transition-journal.json"
        assert verify_journal.is_file()
        assert run("validate", str(verify_dir), cwd=tmp).returncode != 0
        assert run(
            "start-node", str(verify_dir), "--node-id", "missing",
            *parent_executor_args(), cwd=tmp,
        ).returncode == 2
        assert not verify_journal.exists()
        assert json.loads(
            (verify_dir / "run-state.json").read_text(encoding="utf-8")
        )["status"] == "completed"
        verified_events = [
            event for event in read_events(verify_dir)
            if event["event"] == "task.verified"
        ]
        assert len(verified_events) == 1
        recovered_verification_id = verified_events[0]["verification_id"]
        assert recovered_verification_id.startswith("verification-")
        resumed = run(
            "verify", str(verify_dir), "--verdict", "pass", cwd=tmp,
        )
        assert resumed.returncode == 0, resumed.stdout + resumed.stderr
        assert json.loads(resumed.stdout)["verification_id"] == recovered_verification_id
        paired = [
            event for event in read_events(verify_dir)
            if event["event"] == "evaluation.trigger_skipped"
            and event["verification_id"] == recovered_verification_id
        ]
        assert len(paired) == 1
        assert len([
            event for event in read_events(verify_dir)
            if event["event"] == "task.verified"
        ]) == 1

        for inspected_dir in (task_dir, verify_dir):
            transitioned = [
                event for event in read_events(inspected_dir)
                if "transition_id" in event
            ]
            assert len({event["transition_id"] for event in transitioned}) == len(
                transitioned
            )


def test_concurrent_verification_events_keep_verification_id_attribution():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = prepare_task_for_verify(tmp, "concurrent-verification")
        evaluation = work_evaluation_value(
            task_dir,
            "run-concurrent-verification",
            reused=True,
        )
        env, _, _ = fake_evaluator_env(tmp, json.dumps(evaluation))
        process_env = os.environ.copy()
        process_env.update(env)
        processes = [
            subprocess.Popen(
                [
                    sys.executable, str(SCRIPT), "verify", str(task_dir),
                    "--verdict", "pass",
                ],
                cwd=tmp,
                env=process_env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            for _ in range(2)
        ]
        outputs = [process.communicate(timeout=10) for process in processes]
        for process, (stdout, stderr) in zip(processes, outputs):
            assert process.returncode == 0, stdout + stderr
            assert json.loads(stdout)["verification_id"].startswith("verification-")
        events = read_events(task_dir)
        verified = [
            event for event in events if event["event"] == "task.verified"
        ]
        evaluated = [
            event for event in events
            if event["event"] == "evaluation.trigger_completed"
        ]
        verified_ids = [event["verification_id"] for event in verified]
        evaluated_ids = [event["verification_id"] for event in evaluated]
        assert len(verified_ids) == 2
        assert len(set(verified_ids)) == 2
        assert sorted(verified_ids) == sorted(evaluated_ids)


def test_docs_reference_final_v4_quality_and_subject_contract():
    project_root = SCRIPT.parent.parent
    for relative in (
        "README.md",
        "SKILL.md",
        "references/contracts.md",
        "references/runtime-adapter.md",
    ):
        text = (project_root / relative).read_text(encoding="utf-8")
        assert "work-run-quality@v4" in text, relative
        assert "work-run-quality@v3" not in text, relative
        assert "work-harness-run-subject.v4" in text, relative
        assert "work-harness-run-subject.v3" not in text, relative


def test_docs_disable_default_dual_agent_review():
    project_root = SCRIPT.parent.parent
    skill = (project_root / "SKILL.md").read_text(encoding="utf-8")
    readme = (project_root / "README.md").read_text(encoding="utf-8")
    adapter = (
        project_root / "references/runtime-adapter.md"
    ).read_text(encoding="utf-8")

    assert "默认不创建 reviewer 节点" in skill
    assert "最多一个独立 verifier" in skill
    assert "不得并行创建“双 Agent review”" in skill
    assert "默认不创建 reviewer 节点" in readme
    assert "默认不创建 reviewer 节点" in adapter


if __name__ == "__main__":
    tests = [
        test_happy_path,
        test_handoff_list_items_must_be_non_empty_strings,
        test_verify_triggers_evaluator_and_projects_completed_result,
        test_verify_records_explicit_evaluation_skip,
        test_verify_returns_two_and_records_evaluator_failure,
        test_verify_quality_blocked_only_gates_passing_verdict,
        test_verify_rejects_evaluator_identity_mismatch,
        test_verify_rejects_valid_format_wrong_hash_and_empty_report,
        test_verify_rejects_arbitrary_well_formed_evaluation_key,
        test_verify_rejects_report_and_evaluation_event_binding_mismatches,
        test_verify_recomputes_fixed_v4_suite_and_rejects_self_reported_contradictions,
        test_verify_holds_task_lock_across_delayed_v1_v2_evaluators,
        test_pending_verification_blocks_plan_summary_and_domain_mutations,
        test_crashed_verification_resumes_same_v4_binding,
        test_verify_rejects_mismatched_v4_evaluation_binding,
        test_summary_is_required_and_checked_at_verification,
        test_summary_rejects_missing_signal_evidence,
        test_long_task_id_gets_a_safe_default_run_id,
        test_node_granularity_is_checked_at_creation,
        test_parallel_waves_and_write_scope_conflict,
        test_cycle_is_rejected,
        test_native_plan_sync,
        test_guards,
        test_context_pack_requires_real_facts_and_evidence,
        test_new_scope_items_reject_bundled_scopes_but_history_stays_readable,
        test_start_node_records_executor_identity_and_managed_lease,
        test_lease_heartbeat_read_only_stale_check_and_explicit_recovery,
        test_check_stale_supports_historical_running_tasks_without_mutation,
        test_record_domain_evaluation_validates_and_atomically_projects_contract,
        test_record_domain_evaluation_rejects_invalid_fields_hash_and_symlink,
        test_domain_evaluation_matches_typescript_consumer_contract,
        test_optional_context_fields_are_projected_without_becoming_required,
        test_restarting_blocked_node_clears_stale_projection,
        test_execution_id_binds_heartbeat_and_handoff_to_current_attempt,
        test_legacy_execution_without_execution_id_stays_explicitly_compatible,
        test_any_execution_id_evidence_prevents_managed_to_legacy_downgrade,
        test_scope_lexer_and_canonical_overlap_match_runtime_contract,
        test_context_pack_projects_complete_task_and_spawn_contract,
        test_validate_and_next_take_one_shared_lock_snapshot,
        test_node_add_journals_plan_and_context_pack_without_orphans,
        test_transition_journal_recovers_start_heartbeat_recover_handoff_and_verify,
        test_concurrent_verification_events_keep_verification_id_attribution,
        test_docs_reference_final_v4_quality_and_subject_contract,
        test_docs_disable_default_dual_agent_review,
    ]
    for test_case in tests:
        test_case()
        print(f"ok {test_case.__name__}")
    print(f"ok {len(tests)} tests")
