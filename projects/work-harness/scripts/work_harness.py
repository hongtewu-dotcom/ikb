#!/usr/bin/env python3
"""Deterministic task-directory helper for the Work Orchestrator skill."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Tuple


SCHEMA = "work-harness-v1"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
NODE_STATUSES = {"pending", "running", "completed", "blocked", "failed"}
HANDOFF_STATUSES = {"completed", "blocked", "failed"}
NATIVE_STATUSES = {"pending", "running", "in_progress", "completed", "blocked", "failed"}
RUN_STATUSES = {"initialized", "running", "verifying", "completed", "blocked", "failed"}
SUMMARY_STATUSES = {"completed", "blocked", "failed", "cancelled"}
SUMMARY_VERDICTS = {"pass", "fail", "not_run"}
HARD_DISPATCH_REASONS = {
    "independent_write",
    "approval_boundary",
    "independent_verification",
    "independent_retry",
}
SOFT_DISPATCH_REASONS = {
    "parallelism",
    "context_reduction",
    "evidence_separation",
    "owner_separation",
}
DISPATCH_REASONS = HARD_DISPATCH_REASONS | SOFT_DISPATCH_REASONS
EVALUATION_SUITE_ID = "work-run-quality"
EVALUATION_SCHEMA = "work-harness-evaluation-v1"
EVALUATION_TIMEOUT_SECONDS = 30
EVALUATION_SCRIPT_ENV = "WORK_HARNESS_EVAL_PLANE_SCRIPT"
EVALUATION_RESULT_FIELDS = (
    "schema",
    "status",
    "suiteId",
    "runId",
    "evaluationKey",
    "hardGatePassed",
    "result",
    "reportRef",
    "reportPath",
    "reused",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def require_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must match {ID_PATTERN.pattern}: {value!r}")
    return value


def default_run_id(task_id: str) -> str:
    candidate = f"run-{task_id}"
    if ID_PATTERN.fullmatch(candidate):
        return candidate
    digest = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:16]
    return f"run-{task_id[:107]}-{digest}"


def read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, value: Dict[str, Any]) -> None:
    write_text_atomic(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


@contextlib.contextmanager
def task_lock(task_dir: Path) -> Iterator[None]:
    task_dir.mkdir(parents=True, exist_ok=True)
    with (task_dir / ".lock").open("a+", encoding="utf-8") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def append_event(task_dir: Path, event: str, **fields: Any) -> None:
    record = {"at": now(), "event": event, **fields}
    with (task_dir / "events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def task_files(task_dir: Path) -> Tuple[Path, Path, Path]:
    return task_dir / "task.json", task_dir / "plan.json", task_dir / "run-state.json"


def init_task(args: argparse.Namespace) -> int:
    task_id = require_id(args.task_id, "task_id")
    run_id = require_id(args.run_id or default_run_id(task_id), "run_id")
    root = Path(args.root)
    task_dir = root / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    with task_lock(task_dir):
        if any(path.name != ".lock" for path in task_dir.iterdir()):
            raise ValueError(f"task directory already contains files: {task_dir}")
        (task_dir / "nodes").mkdir(exist_ok=True)
        (task_dir / "artifacts").mkdir(exist_ok=True)
        task = {
            "schema": "work-harness-task-v1",
            "task_id": task_id,
            "run_id": run_id,
            "objective": args.objective,
            "scope": args.scope or [],
            "acceptance": args.acceptance or [],
            "allowed_side_effects": args.allowed_side_effects or [],
            "budget": {"max_agents": args.max_agents, "max_retries": args.max_retries},
            "runtime": args.runtime,
            "created_at": now(),
        }
        plan = {
            "schema": "work-harness-plan-v1",
            "task_id": task_id,
            "native_plan": {"source": args.runtime, "steps": []},
            "nodes": [],
        }
        state = {
            "schema": SCHEMA,
            "task_id": task_id,
            "status": "initialized",
            "current_nodes": [],
            "completed_nodes": [],
            "attempts": {},
            "updated_at": now(),
        }
        task_file, plan_file, state_file = task_files(task_dir)
        write_json(task_file, task)
        write_json(plan_file, plan)
        write_json(state_file, state)
        write_text_atomic(
            task_dir / "context-pack.md",
            f"# ContextPack\n\n- task_id: {task_id}\n- run_id: {run_id}\n- objective: {args.objective}\n- scope: {', '.join(args.scope or []) or '待主 Agent 补充'}\n",
        )
        write_json(task_dir / "verification.json", {"status": "pending"})
        write_json(task_dir / "run-summary.template.json", {
            "schema": "work-harness-run-summary-v1",
            "task_id": task_id,
            "run_id": run_id,
            "terminal_status": "completed",
            "verification": {"verdict": "pass", "note": ""},
            "evidence_refs": [],
            "artifact_refs": [],
            "knowledge_refs": [],
            "correction_signals": [],
        })
        (task_dir / "events.jsonl").touch()
        append_event(task_dir, "task.initialized", runtime=args.runtime, run_id=run_id)
    print(json.dumps({"task_dir": str(task_dir), "task_id": task_id, "run_id": run_id}, ensure_ascii=False))
    return 0


def load_documents(task_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    task_file, plan_file, state_file = task_files(task_dir)
    return read_json(task_file), read_json(plan_file), read_json(state_file)


def save_plan(task_dir: Path, plan: Dict[str, Any]) -> None:
    plan["updated_at"] = now()
    write_json(task_dir / "plan.json", plan)


def save_state(task_dir: Path, state: Dict[str, Any]) -> None:
    state["updated_at"] = now()
    write_json(task_dir / "run-state.json", state)


def safe_node_dir(task_dir: Path, node_id: str) -> Path:
    node_dir = task_dir / "nodes" / require_id(node_id, "node_id")
    if node_dir.exists() and node_dir.is_symlink():
        raise ValueError(f"node directory cannot be a symlink: {node_id}")
    node_dir.mkdir(parents=True, exist_ok=True)
    root = task_dir.resolve()
    target = node_dir.resolve()
    if os.path.commonpath([str(root), str(target)]) != str(root):
        raise ValueError(f"node directory escapes task directory: {node_id}")
    return node_dir


def add_node(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    dependencies = [require_id(dep, "dependency") for dep in (args.depends_on or [])]
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, _ = load_documents(task_dir)
        nodes = plan.get("nodes")
        if not isinstance(nodes, list):
            raise ValueError("plan.nodes must be an array")
        if any(isinstance(node, dict) and node.get("id") == node_id for node in nodes):
            raise ValueError(f"node already exists: {node_id}")
        node = {
            "id": node_id,
            "kind": args.kind,
            "goal": args.goal,
            "depends_on": dependencies,
            "post_conditions": args.post_condition or [],
            "acceptance": args.acceptance or [],
            "read_scope": args.read_scope or [],
            "write_scope": args.write_scope or [],
            "dispatch_reasons": args.dispatch_reasons or [],
            "output_contract": {"handoff": f"nodes/{node_id}/handoff.json"},
            "allowed_side_effects": args.allowed_side_effects or [],
            "status": "pending",
        }
        errors = node_granularity_errors(node)
        if errors:
            raise ValueError("node rejected: " + "; ".join(errors))
        nodes.append(node)
        node_dir = safe_node_dir(task_dir, node_id)
        write_text_atomic(
            node_dir / "input.md",
            "\n".join(
                [
                    "# ContextPack",
                    f"\n- task_id: {task.get('task_id')}",
                    f"- run_id: {task.get('run_id')}",
                    f"- objective: {task.get('objective')}",
                    f"- scope: {', '.join(task.get('scope', [])) or '待主 Agent 补充'}",
                    f"- read_scope: {', '.join(args.read_scope or []) or '未声明（只读范围由主 Agent 约束）'}",
                    f"- write_scope: {', '.join(args.write_scope or []) or '无写入'}",
                    "- known_facts: 待主 Agent 补充，必须附证据引用",
                    "- decisions: 待主 Agent 补充",
                    "- evidence_refs: 待主 Agent 补充",
                    "- constraints: 遵守 task.json 和节点 allowed_side_effects",
                    "",
                    "## SpawnContract",
                    f"- goal: {args.goal}",
                    f"- post_conditions: {', '.join(args.post_condition or []) or '待补充'}",
                    f"- acceptance: {', '.join(args.acceptance or []) or '待补充'}",
                    f"- dispatch_reasons: {', '.join(args.dispatch_reasons or []) or '待补充'}",
                    "- 粒度约束: 节点是值得独立调度的最小工作单元；几条命令或同一文件内的小动作留在节点内部",
                    "- forbidden: 不读取兄弟节点结论；不执行未授权副作用",
                    "",
                ]
            ),
        )
        save_plan(task_dir, plan)
        append_event(
            task_dir,
            "node.added",
            node_id=node_id,
            depends_on=dependencies,
            read_scope=node["read_scope"],
            write_scope=node["write_scope"],
            dispatch_reasons=node["dispatch_reasons"],
        )
    print(json.dumps({"node_id": node_id}, ensure_ascii=False))
    return 0


def graph_errors(nodes: Any) -> List[str]:
    errors: List[str] = []
    if not isinstance(nodes, list):
        return ["plan.nodes must be an array"]
    ids: List[str] = []
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(f"node[{index}] must be an object")
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not ID_PATTERN.fullmatch(node_id):
            errors.append(f"node[{index}] has invalid id: {node_id!r}")
        else:
            ids.append(node_id)
    duplicates = sorted({node_id for node_id in ids if ids.count(node_id) > 1})
    errors.extend(f"duplicate node id: {node_id}" for node_id in duplicates)
    known = set(ids)
    edges: Dict[str, List[str]] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        if node_id not in known:
            continue
        deps = node.get("depends_on", [])
        if not isinstance(deps, list):
            errors.append(f"{node_id}: depends_on must be an array")
            continue
        valid_deps: List[str] = []
        for dep in deps:
            if not isinstance(dep, str) or not ID_PATTERN.fullmatch(dep):
                errors.append(f"{node_id}: invalid dependency: {dep!r}")
                continue
            valid_deps.append(dep)
            if dep not in known:
                errors.append(f"{node_id}: unknown dependency: {dep}")
            if dep == node_id:
                errors.append(f"{node_id}: self dependency")
        edges[node_id] = valid_deps

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visiting:
            errors.append(f"dependency cycle includes: {node_id}")
            return
        if node_id in visited or node_id not in edges:
            return
        visiting.add(node_id)
        for dep in edges[node_id]:
            visit(dep)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in edges:
        visit(node_id)
    return errors


def handoff_errors(handoff: Any) -> List[str]:
    errors: List[str] = []
    if not isinstance(handoff, dict):
        return ["handoff must be an object"]
    status = handoff.get("status")
    if status not in HANDOFF_STATUSES:
        errors.append(f"handoff.status must be one of {sorted(HANDOFF_STATUSES)}")
    if not isinstance(handoff.get("conclusion"), str) or not handoff.get("conclusion", "").strip():
        errors.append("handoff.conclusion must be a non-empty string")
    for field in ("evidence", "artifacts", "validation", "risks"):
        if not isinstance(handoff.get(field), list):
            errors.append(f"handoff.{field} must be an array")
    if not isinstance(handoff.get("next_action"), str) or not handoff.get("next_action", "").strip():
        errors.append("handoff.next_action must be a non-empty string")
    return errors


def string_list_errors(value: Any, field: str) -> List[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        return [f"{field} must be an array of non-empty strings"]
    return []


def required_string_list_errors(value: Any, field: str) -> List[str]:
    errors = string_list_errors(value, field)
    if not errors and not value:
        errors.append(f"{field} must contain at least one item")
    return errors


def dispatch_reason_errors(value: Any, field: str = "dispatch_reasons") -> List[str]:
    errors = required_string_list_errors(value, field)
    if errors:
        return errors
    unknown = sorted(set(value) - DISPATCH_REASONS)
    if unknown:
        errors.append(f"{field} contains unknown reason(s): {', '.join(unknown)}")
        return errors
    hard = sorted(set(value) & HARD_DISPATCH_REASONS)
    soft = sorted(set(value) & SOFT_DISPATCH_REASONS)
    if not hard and len(soft) < 2:
        errors.append(
            f"{field} needs one hard reason ({', '.join(sorted(HARD_DISPATCH_REASONS))}) "
            f"or at least two soft reasons ({', '.join(sorted(SOFT_DISPATCH_REASONS))})"
        )
    return errors


def node_granularity_errors(node: Dict[str, Any]) -> List[str]:
    if node.get("kind") == "native-plan-step":
        return []
    errors: List[str] = []
    errors.extend(required_string_list_errors(node.get("post_conditions"), f"{node.get('id', '<unknown>')}: post_conditions"))
    errors.extend(required_string_list_errors(node.get("acceptance"), f"{node.get('id', '<unknown>')}: acceptance"))
    errors.extend(string_list_errors(node.get("read_scope"), f"{node.get('id', '<unknown>')}: read_scope"))
    errors.extend(string_list_errors(node.get("write_scope"), f"{node.get('id', '<unknown>')}: write_scope"))
    errors.extend(dispatch_reason_errors(node.get("dispatch_reasons"), f"{node.get('id', '<unknown>')}: dispatch_reasons"))
    return errors


def scopes_overlap(left: Iterable[str], right: Iterable[str]) -> bool:
    for left_scope in left:
        for right_scope in right:
            left_value = left_scope.rstrip("/")
            right_value = right_scope.rstrip("/")
            if not left_value or not right_value:
                continue
            if (
                left_value == right_value
                or left_value.startswith(right_value + "/")
                or right_value.startswith(left_value + "/")
            ):
                return True
    return False


def parallel_waves(task_dir: Path) -> List[List[str]]:
    _, plan, _ = load_documents(task_dir)
    nodes = {
        node["id"]: node
        for node in plan.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    ready = [nodes[node_id] for node_id in ready_nodes(task_dir)]
    waves: List[List[str]] = []
    for node in ready:
        placed = False
        for wave in waves:
            if all(not scopes_overlap(node.get("write_scope", []), nodes[item_id].get("write_scope", [])) for item_id in wave):
                wave.append(node["id"])
                placed = True
                break
        if not placed:
            waves.append([node["id"]])
    return waves


def run_summary_errors(summary: Any, task_id: str | None = None, run_id: str | None = None, expected_verdict: str | None = None) -> List[str]:
    errors: List[str] = []
    if not isinstance(summary, dict):
        return ["run summary must be an object"]
    if summary.get("schema") != "work-harness-run-summary-v1":
        errors.append("run summary schema must be work-harness-run-summary-v1")
    for field in ("task_id", "run_id", "terminal_status", "verification", "evidence_refs", "artifact_refs", "knowledge_refs", "correction_signals"):
        if field not in summary:
            errors.append(f"run summary missing field: {field}")
    if not isinstance(summary.get("task_id"), str) or not summary.get("task_id", "").strip():
        errors.append("run summary task_id must be a non-empty string")
    elif task_id is not None and summary.get("task_id") != task_id:
        errors.append("run summary task_id does not match task.json")
    if not isinstance(summary.get("run_id"), str) or not summary.get("run_id", "").strip():
        errors.append("run summary run_id must be a non-empty string")
    elif run_id is not None and summary.get("run_id") != run_id:
        errors.append("run summary run_id does not match task.json")
    if summary.get("terminal_status") not in SUMMARY_STATUSES:
        errors.append(f"run summary terminal_status must be one of {sorted(SUMMARY_STATUSES)}")

    verification = summary.get("verification")
    if not isinstance(verification, dict):
        errors.append("run summary verification must be an object")
    elif verification.get("verdict") not in SUMMARY_VERDICTS:
        errors.append(f"run summary verification.verdict must be one of {sorted(SUMMARY_VERDICTS)}")
    elif expected_verdict is not None and verification.get("verdict") != expected_verdict:
        errors.append("run summary verification.verdict must match task verification verdict")
    if expected_verdict == "pass" and summary.get("terminal_status") != "completed":
        errors.append("a passing task must have terminal_status=completed")
    if expected_verdict == "fail" and summary.get("terminal_status") == "completed":
        errors.append("a failed task cannot have terminal_status=completed")

    for field in ("evidence_refs", "artifact_refs", "knowledge_refs"):
        errors.extend(string_list_errors(summary.get(field), f"run summary {field}"))
    signals = summary.get("correction_signals")
    if not isinstance(signals, list):
        errors.append("run summary correction_signals must be an array")
    else:
        for index, signal in enumerate(signals):
            if not isinstance(signal, dict):
                errors.append(f"run summary correction_signals[{index}] must be an object")
                continue
            for field in ("kind", "reason_code", "evidence_refs"):
                if field not in signal:
                    errors.append(f"run summary correction_signals[{index}] missing field: {field}")
            for field in ("kind", "reason_code"):
                if not isinstance(signal.get(field), str) or not signal.get(field, "").strip():
                    errors.append(f"run summary correction_signals[{index}].{field} must be a non-empty string")
            errors.extend(string_list_errors(signal.get("evidence_refs"), f"run summary correction_signals[{index}].evidence_refs"))
            if "artifact_refs" in signal:
                errors.extend(string_list_errors(signal.get("artifact_refs"), f"run summary correction_signals[{index}].artifact_refs"))
    return errors


def document_errors(task_dir: Path, task: Dict[str, Any], plan: Dict[str, Any], state: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    for field in ("task_id", "run_id", "objective", "acceptance", "budget"):
        if field not in task:
            errors.append(f"task missing field: {field}")
    task_id = task.get("task_id")
    if not isinstance(task_id, str) or not ID_PATTERN.fullmatch(task_id):
        errors.append("task.task_id is not a safe identifier")
    run_id = task.get("run_id")
    if not isinstance(run_id, str) or not ID_PATTERN.fullmatch(run_id):
        errors.append("task.run_id is not a safe identifier")
    budget = task.get("budget")
    if not isinstance(budget, dict) or not isinstance(budget.get("max_agents"), int) or budget.get("max_agents", 0) < 1:
        errors.append("task.budget.max_agents must be a positive integer")
    if not isinstance(budget, dict) or not isinstance(budget.get("max_retries"), int) or budget.get("max_retries", -1) < 0:
        errors.append("task.budget.max_retries must be a non-negative integer")
    if plan.get("task_id") != task_id or state.get("task_id") != task_id:
        errors.append("task_id must match across task.json, plan.json and run-state.json")
    nodes = plan.get("nodes")
    errors.extend(graph_errors(nodes))
    if not isinstance(nodes, list):
        nodes = []
    node_map = {node.get("id"): node for node in nodes if isinstance(node, dict) and isinstance(node.get("id"), str)}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id", "<unknown>")
        for field in ("kind", "goal", "depends_on", "post_conditions", "acceptance", "status"):
            if field not in node:
                errors.append(f"{node_id}: missing field: {field}")
        if not isinstance(node.get("goal"), str) or not node.get("goal", "").strip():
            errors.append(f"{node_id}: goal must be a non-empty string")
        errors.extend(node_granularity_errors(node))
        if node.get("status") not in NODE_STATUSES:
            errors.append(f"{node_id}: invalid status: {node.get('status')}")
        if node.get("status") == "completed" and node.get("kind") != "native-plan-step":
            handoff_path = task_dir / "nodes" / node_id / "handoff.json"
            if not handoff_path.exists():
                errors.append(f"{node_id}: completed node has no handoff.json")
            else:
                try:
                    errors.extend(f"{node_id}: {error}" for error in handoff_errors(read_json(handoff_path)))
                except ValueError as exc:
                    errors.append(str(exc))
    if state.get("status") not in RUN_STATUSES:
        errors.append(f"run-state: invalid status: {state.get('status')}")
    for field in ("current_nodes", "completed_nodes"):
        values = state.get(field, [])
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            errors.append(f"run-state.{field} must be an array of strings")
        elif len(values) != len(set(values)):
            errors.append(f"run-state.{field} must not contain duplicates")
    current = set(state.get("current_nodes", [])) if isinstance(state.get("current_nodes"), list) else set()
    completed = set(state.get("completed_nodes", [])) if isinstance(state.get("completed_nodes"), list) else set()
    for node_id in current | completed:
        if node_id not in node_map:
            errors.append(f"run-state references unknown node: {node_id}")
    for node_id, node in node_map.items():
        if node.get("status") == "running" and node_id not in current:
            errors.append(f"running node missing from run-state.current_nodes: {node_id}")
        if node.get("status") == "completed" and node_id not in completed:
            errors.append(f"completed node missing from run-state.completed_nodes: {node_id}")
        if node_id in current and node.get("status") != "running":
            errors.append(f"run-state.current_nodes contains non-running node: {node_id}")
        if node_id in completed and node.get("status") != "completed":
            errors.append(f"run-state.completed_nodes contains non-completed node: {node_id}")
    if state.get("status") == "completed" and any(node.get("status") != "completed" for node in nodes):
        errors.append("run-state.completed requires every node to be completed")
    return errors


def validate_task(task_dir: Path) -> int:
    try:
        task, plan, state = load_documents(task_dir)
        errors = document_errors(task_dir, task, plan, state)
    except ValueError as exc:
        print(json.dumps({"status": "invalid", "errors": [str(exc)]}, ensure_ascii=False))
        return 1
    result = {"status": "valid" if not errors else "invalid", "errors": errors, "node_count": len(plan.get("nodes", [])) if isinstance(plan.get("nodes"), list) else 0}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


def validate_command(args: argparse.Namespace) -> int:
    return validate_task(Path(args.task_dir))


def ready_nodes(task_dir: Path) -> List[str]:
    _, plan, _ = load_documents(task_dir)
    nodes = {node["id"]: node for node in plan.get("nodes", []) if isinstance(node, dict) and isinstance(node.get("id"), str)}
    return sorted(
        node_id
        for node_id, node in nodes.items()
        if node.get("status") == "pending"
        and all(nodes.get(dep, {}).get("status") == "completed" for dep in node.get("depends_on", []))
    )


def next_command(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    print(json.dumps({"ready": ready_nodes(task_dir), "parallel_waves": parallel_waves(task_dir)}, ensure_ascii=False, indent=2))
    return 0


def start_node(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        nodes = plan.get("nodes", [])
        node = next((item for item in nodes if isinstance(item, dict) and item.get("id") == node_id), None)
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        if node.get("status") not in {"pending", "failed", "blocked"}:
            raise ValueError(f"node cannot start from status: {node.get('status')}")
        node_map = {item.get("id"): item for item in nodes if isinstance(item, dict)}
        if any(node_map.get(dep, {}).get("status") != "completed" for dep in node.get("depends_on", [])):
            raise ValueError(f"node dependencies are not completed: {node.get('depends_on', [])}")
        current = set(state.get("current_nodes", []))
        for running_id in sorted(current):
            running_node = node_map.get(running_id, {})
            if scopes_overlap(node.get("write_scope", []), running_node.get("write_scope", [])):
                raise ValueError(f"write scope conflicts with running node: {running_id}")
        budget = task.get("budget", {})
        if len(current) >= budget.get("max_agents", 1):
            raise ValueError("max_agents budget reached")
        attempts = state.setdefault("attempts", {})
        attempt = int(attempts.get(node_id, 0)) + 1
        if attempt > 1 + int(budget.get("max_retries", 0)):
            raise ValueError(f"retry budget exhausted for node: {node_id}")
        attempts[node_id] = attempt
        node["status"] = "running"
        current.add(node_id)
        state["current_nodes"] = sorted(current)
        state["status"] = "running"
        save_plan(task_dir, plan)
        save_state(task_dir, state)
        append_event(task_dir, "node.started", node_id=node_id, attempt=attempt)
    print(json.dumps({"node_id": node_id, "status": "running", "attempt": attempt}, ensure_ascii=False))
    return 0


def record_handoff(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    handoff = read_json(Path(args.file))
    errors = handoff_errors(handoff)
    if errors:
        raise ValueError("; ".join(errors))
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        _, plan, state = load_documents(task_dir)
        node = next((item for item in plan.get("nodes", []) if isinstance(item, dict) and item.get("id") == node_id), None)
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        if node.get("status") != "running":
            raise ValueError(f"node must be running before handoff: {node_id} ({node.get('status')})")
        node_map = {item.get("id"): item for item in plan.get("nodes", []) if isinstance(item, dict)}
        if any(node_map.get(dep, {}).get("status") != "completed" for dep in node.get("depends_on", [])):
            raise ValueError(f"node dependencies are not completed: {node.get('depends_on', [])}")
        node_dir = safe_node_dir(task_dir, node_id)
        write_json(node_dir / "handoff.json", handoff)
        status = handoff["status"]
        node["status"] = status
        current = set(state.get("current_nodes", []))
        current.discard(node_id)
        state["current_nodes"] = sorted(current)
        completed = set(state.get("completed_nodes", []))
        if status == "completed":
            completed.add(node_id)
        state["completed_nodes"] = sorted(completed)
        if status == "blocked":
            state["status"] = "blocked"
            state["blocked_node"] = node_id
        elif status == "failed":
            state["status"] = "failed"
            state["failed_node"] = node_id
        elif all(item.get("status") == "completed" for item in plan.get("nodes", [])):
            state["status"] = "verifying"
        else:
            state["status"] = "running"
        save_plan(task_dir, plan)
        save_state(task_dir, state)
        append_event(task_dir, "node.handoff_recorded", node_id=node_id, status=status)
    print(json.dumps({"node_id": node_id, "status": status, "run_status": state["status"]}, ensure_ascii=False))
    return 0


def record_summary(args: argparse.Namespace) -> int:
    incoming = read_json(Path(args.file))
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        errors = run_summary_errors(incoming, task.get("task_id"), task.get("run_id"))
        if errors:
            raise ValueError("invalid run summary: " + "; ".join(errors))
        nodes = plan.get("nodes", [])
        attempts = state.get("attempts", {})
        retry_count = sum(max(int(value) - 1, 0) for value in attempts.values() if isinstance(value, int))
        summary = dict(incoming)
        summary["observed"] = {
            "task_status_at_recording": state.get("status"),
            "node_count": len(nodes),
            "completed_node_count": sum(1 for node in nodes if isinstance(node, dict) and node.get("status") == "completed"),
            "retry_count": retry_count,
        }
        summary["recorded_at"] = now()
        write_json(task_dir / "run-summary.json", summary)
        append_event(
            task_dir,
            "run.summary_recorded",
            run_id=task.get("run_id"),
            terminal_status=summary["terminal_status"],
            correction_signal_count=len(summary["correction_signals"]),
            evidence_ref_count=len(summary["evidence_refs"]),
        )
    print(json.dumps({"task_id": task.get("task_id"), "run_id": task.get("run_id"), "summary": str(task_dir / "run-summary.json")}, ensure_ascii=False))
    return 0


def evaluation_script() -> Tuple[Path | None, str | None]:
    override = os.environ.get(EVALUATION_SCRIPT_ENV)
    if override is not None and override.strip().lower() == "off":
        return None, "disabled"
    if override is not None and override.strip():
        script = Path(override.strip()).expanduser().resolve()
    else:
        script = Path(__file__).resolve().parents[2] / "eval-plane" / "src" / "work-eval-cli.ts"
    if not script.is_file():
        return None, "evaluator_not_found"
    return script, None


def evaluation_output_errors(value: Any, task_dir: Path, expected_run_id: str) -> List[str]:
    if not isinstance(value, dict):
        return ["evaluation output must be an object"]
    errors: List[str] = []
    if value.get("schema") != EVALUATION_SCHEMA:
        errors.append(f"evaluation schema must be {EVALUATION_SCHEMA}")
    if value.get("status") != "completed":
        errors.append("evaluation status must be completed")
    if value.get("suiteId") != EVALUATION_SUITE_ID:
        errors.append(f"evaluation suiteId must be {EVALUATION_SUITE_ID}")
    for field in ("runId", "evaluationKey", "reportRef", "reportPath"):
        if not isinstance(value.get(field), str) or not value.get(field, "").strip():
            errors.append(f"evaluation {field} must be a non-empty string")
    if not isinstance(value.get("hardGatePassed"), bool):
        errors.append("evaluation hardGatePassed must be a boolean")
    if value.get("result") not in {"pass", "partial", "blocked"}:
        errors.append("evaluation result must be pass, partial or blocked")
    if not isinstance(value.get("reused"), bool):
        errors.append("evaluation reused must be a boolean")
    if value.get("runId") != expected_run_id:
        errors.append("evaluation runId must match task.json")
    evaluation_key = value.get("evaluationKey")
    if isinstance(evaluation_key, str) and ID_PATTERN.fullmatch(evaluation_key):
        expected_ref = f"artifact://evaluation/{EVALUATION_SUITE_ID}/{evaluation_key}"
        if value.get("reportRef") != expected_ref:
            errors.append("evaluation reportRef must match suiteId and evaluationKey")
        expected_path = (task_dir.resolve() / "evaluations" / EVALUATION_SUITE_ID / f"{evaluation_key}.json").resolve()
        report_path = value.get("reportPath")
        if not isinstance(report_path, str) or Path(report_path).expanduser().resolve() != expected_path:
            errors.append("evaluation reportPath must match the current task directory and evaluationKey")
        elif not expected_path.is_file() or expected_path.is_symlink():
            errors.append("evaluation reportPath must be a regular report file")
    else:
        errors.append("evaluation evaluationKey must be a safe identifier")
    return errors


def evaluation_trigger_result(status: str, reason: str) -> Dict[str, Any]:
    return {"status": status, "suiteId": EVALUATION_SUITE_ID, "reason": reason}


def trigger_work_evaluation(task_dir: Path) -> Dict[str, Any]:
    script, skip_reason = evaluation_script()
    if skip_reason is not None:
        return evaluation_trigger_result("skipped", skip_reason)
    node = shutil.which("node")
    if node is None:
        return evaluation_trigger_result("skipped", "node_not_found")
    command = [
        node,
        "--no-warnings=ExperimentalWarning",
        "--experimental-strip-types",
        str(script),
        "--task-dir",
        str(task_dir.resolve()),
        "--suite",
        EVALUATION_SUITE_ID,
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=EVALUATION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return evaluation_trigger_result("failed", "timeout")
    except OSError:
        return evaluation_trigger_result("failed", "launch_error")
    if completed.returncode != 0:
        return evaluation_trigger_result("failed", "nonzero_exit")
    try:
        output = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return evaluation_trigger_result("failed", "invalid_output")
    task = read_json(task_dir / "task.json")
    if evaluation_output_errors(output, task_dir, str(task.get("run_id", ""))):
        return evaluation_trigger_result("failed", "invalid_output")
    return {field: output[field] for field in EVALUATION_RESULT_FIELDS}


def record_evaluation_trigger(task_dir: Path, evaluation: Dict[str, Any]) -> None:
    status = evaluation["status"]
    fields: Dict[str, Any] = {"suite_id": EVALUATION_SUITE_ID}
    if status == "completed":
        event = "evaluation.trigger_completed"
        fields.update({
            "evaluation_schema": evaluation["schema"],
            "evaluation_run_id": evaluation["runId"],
            "evaluation_key": evaluation["evaluationKey"],
            "hard_gate_passed": evaluation["hardGatePassed"],
            "result": evaluation["result"],
            "report_ref": evaluation["reportRef"],
            "reused": evaluation["reused"],
        })
    else:
        event = f"evaluation.trigger_{status}"
        fields["reason"] = evaluation["reason"]
    with task_lock(task_dir):
        append_event(task_dir, event, **fields)


def verify_task(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        errors = document_errors(task_dir, task, plan, state)
        if errors:
            raise ValueError("cannot verify invalid task: " + "; ".join(errors))
        if any(node.get("status") != "completed" for node in plan.get("nodes", [])):
            raise ValueError("cannot verify until every node is completed")
        summary_path = task_dir / "run-summary.json"
        if not summary_path.exists():
            raise ValueError("cannot verify without run-summary.json; record the terminal summary first")
        summary = read_json(summary_path)
        summary_errors = run_summary_errors(summary, task.get("task_id"), task.get("run_id"), args.verdict)
        if summary_errors:
            raise ValueError("cannot verify invalid run summary: " + "; ".join(summary_errors))
        passed = args.verdict == "pass"
        verification = dict(summary["verification"])
        verification["verdict"] = args.verdict
        if args.note:
            verification["note"] = args.note
        summary["verification"] = verification
        if passed:
            summary["terminal_status"] = "completed"
        summary["finalized_at"] = now()
        write_json(summary_path, summary)
        write_json(task_dir / "verification.json", {"status": "passed" if passed else "failed", "note": args.note or "", "at": now()})
        state["status"] = "completed" if passed else "blocked"
        save_state(task_dir, state)
        append_event(task_dir, "task.verified", verdict=args.verdict)
    evaluation = trigger_work_evaluation(task_dir)
    record_evaluation_trigger(task_dir, evaluation)
    print(json.dumps({
        "status": state["status"],
        "verification": "passed" if passed else "failed",
        "evaluation": evaluation,
    }, ensure_ascii=False))
    if evaluation["status"] == "failed":
        print(json.dumps({
            "status": "error",
            "error": "evaluation trigger failed",
            "reason": evaluation["reason"],
        }, ensure_ascii=False), file=sys.stderr)
        return 2
    if passed and evaluation["status"] == "completed" and not evaluation["hardGatePassed"]:
        print(json.dumps({
            "status": "blocked",
            "error": "evaluation quality gate blocked",
            "reason": "quality_gate_blocked",
        }, ensure_ascii=False), file=sys.stderr)
        return 3
    return 0


def import_native_plan(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    source = read_json(Path(args.file))
    steps = source.get("steps")
    if not isinstance(steps, list):
        raise ValueError("native plan snapshot must contain steps array")
    normalized_steps: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            raise ValueError(f"native plan step[{index}] must be an object")
        node_id = step.get("id") or f"native-step-{index:03d}"
        node_id = require_id(node_id, f"native step[{index}].id")
        if node_id in seen:
            raise ValueError(f"duplicate native plan id: {node_id}")
        seen.add(node_id)
        title = step.get("step") or step.get("goal")
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f"native plan step[{index}] needs a non-empty step")
        status = step.get("status", "pending")
        if status not in NATIVE_STATUSES:
            raise ValueError(f"unknown native plan status: {status}")
        dependencies = step.get("depends_on", [])
        if not isinstance(dependencies, list):
            raise ValueError(f"native plan step[{index}].depends_on must be an array")
        dependencies = [require_id(dep, "native dependency") for dep in dependencies]
        normalized_steps.append({"id": node_id, "step": title, "status": status, "depends_on": dependencies})

    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        existing = {node.get("id"): node for node in plan.get("nodes", []) if isinstance(node, dict)}
        incoming_ids = {step["id"] for step in normalized_steps}
        normalized_nodes: List[Dict[str, Any]] = []
        for step in normalized_steps:
            node_id = step["id"]
            existing_node = existing.get(node_id)
            if existing_node is not None and existing_node.get("kind") != "native-plan-step":
                existing_node["native_plan_status"] = step["status"]
                normalized_nodes.append(existing_node)
                continue
            mapped = {"in_progress": "running"}.get(step["status"], step["status"])
            normalized_nodes.append({
                **(existing_node or {}),
                "id": node_id,
                "kind": "native-plan-step",
                "goal": step["step"],
                "depends_on": step["depends_on"],
                "post_conditions": (existing_node or {}).get("post_conditions", []),
                "acceptance": (existing_node or {}).get("acceptance", []),
                "output_contract": (existing_node or {}).get("output_contract", {}),
                "allowed_side_effects": (existing_node or {}).get("allowed_side_effects", []),
                "status": mapped,
            })
        normalized_nodes.extend(
            node for node_id, node in existing.items()
            if node_id not in incoming_ids and node.get("kind") != "native-plan-step"
        )
        candidate_plan = dict(plan)
        candidate_plan["native_plan"] = {
            "source": source.get("source", "current-runtime"),
            "steps": normalized_steps,
            "imported_at": now(),
            "mode": "one-way-snapshot",
        }
        candidate_plan["nodes"] = normalized_nodes
        candidate_state = dict(state)
        candidate_state["current_nodes"] = sorted(node["id"] for node in normalized_nodes if node.get("status") == "running")
        candidate_state["completed_nodes"] = sorted(node["id"] for node in normalized_nodes if node.get("status") == "completed")
        if any(node.get("status") == "failed" for node in normalized_nodes):
            candidate_state["status"] = "failed"
        elif any(node.get("status") == "blocked" for node in normalized_nodes):
            candidate_state["status"] = "blocked"
        elif normalized_nodes and all(node.get("status") == "completed" for node in normalized_nodes):
            candidate_state["status"] = "verifying"
        elif any(node.get("status") == "running" for node in normalized_nodes):
            candidate_state["status"] = "running"
        else:
            candidate_state["status"] = state.get("status", "initialized")
        errors = document_errors(task_dir, task, candidate_plan, candidate_state)
        if errors:
            raise ValueError("native plan snapshot rejected: " + "; ".join(errors))
        save_plan(task_dir, candidate_plan)
        save_state(task_dir, candidate_state)
        append_event(task_dir, "native_plan.imported", step_count=len(normalized_steps))
    print(json.dumps({"imported": len(normalized_steps), "mode": "one-way-snapshot"}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Work Harness task-directory helper")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--task-id", required=True)
    init.add_argument("--run-id")
    init.add_argument("--objective", required=True)
    init.add_argument("--root", default=".agent-work")
    init.add_argument("--scope", action="append")
    init.add_argument("--acceptance", action="append")
    init.add_argument("--allowed-side-effect", dest="allowed_side_effects", action="append")
    init.add_argument("--max-agents", type=int, default=3)
    init.add_argument("--max-retries", type=int, default=1)
    init.add_argument("--runtime", choices=["auto", "codex", "claude-code"], default="auto")
    init.set_defaults(func=init_task)

    add = sub.add_parser("add-node")
    add.add_argument("task_dir")
    add.add_argument("--node-id", required=True)
    add.add_argument("--goal", required=True)
    add.add_argument("--kind", default="research", choices=["research", "implement", "verify", "approval", "native-plan-step"])
    add.add_argument("--depends-on", action="append")
    add.add_argument("--post-condition", action="append")
    add.add_argument("--acceptance", action="append")
    add.add_argument("--read-scope", dest="read_scope", action="append")
    add.add_argument("--write-scope", dest="write_scope", action="append")
    add.add_argument("--dispatch-reason", dest="dispatch_reasons", action="append")
    add.add_argument("--allowed-side-effect", dest="allowed_side_effects", action="append")
    add.set_defaults(func=add_node)

    start = sub.add_parser("start-node")
    start.add_argument("task_dir")
    start.add_argument("--node-id", required=True)
    start.set_defaults(func=start_node)

    for name, func in (("validate", validate_command), ("next", next_command)):
        command = sub.add_parser(name)
        command.add_argument("task_dir")
        command.set_defaults(func=func)

    record = sub.add_parser("record-handoff")
    record.add_argument("task_dir")
    record.add_argument("--node-id", required=True)
    record.add_argument("--file", required=True)
    record.set_defaults(func=record_handoff)

    summary = sub.add_parser("record-summary")
    summary.add_argument("task_dir")
    summary.add_argument("--file", required=True)
    summary.set_defaults(func=record_summary)

    verify = sub.add_parser("verify")
    verify.add_argument("task_dir")
    verify.add_argument("--verdict", choices=["pass", "fail"], required=True)
    verify.add_argument("--note")
    verify.set_defaults(func=verify_task)

    for name in ("import-native-plan", "sync-native-plan"):
        native = sub.add_parser(name, help="import a one-way snapshot; it does not update the runtime UI plan")
        native.add_argument("task_dir")
        native.add_argument("--file", required=True)
        native.set_defaults(func=import_native_plan)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        return args.func(args)
    except (OSError, TypeError, ValueError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
