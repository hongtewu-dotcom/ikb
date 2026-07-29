#!/usr/bin/env python3
"""Deterministic task-directory helper for the Work Orchestrator skill."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import ntpath
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
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
EVALUATION_SUITE_VERSION = "v4"
EVALUATION_SUBJECT_VERSION = "work-harness-run-subject.v4"
EVALUATION_SCHEMA = "work-harness-evaluation-v1"
EVALUATION_REPORT_SCHEMA = "ikb-eval-report-v1"
EVALUATION_RESULT_SCHEMA = "ikb-eval-result-v1"
EVALUATION_EVENT_SCHEMA = "work-harness-eval-event-v1"
EVALUATION_EVAL_VERSION = "v1"
EVALUATION_HARNESS_ID = "work-harness"
EVALUATION_GRADER_VERSION = "deterministic-v1"
EVALUATION_CASE_LEVELS = {
    "work-run-contract-integrity": "L1",
    "work-run-dag-scope": "L1",
    "work-run-node-closure": "L1",
    "work-run-verification-chain": "L1",
    "work-run-retry-budget": "L1",
    "work-run-recovery-quality": "L2",
    "work-run-domain-result": "L3",
}
EVALUATION_DIAGNOSES = {
    "subject",
    "grader",
    "ground_truth",
    "environment",
    "unknown",
}
EVALUATION_TIMEOUT_SECONDS = 30
EVALUATION_SCRIPT_ENV = "WORK_HARNESS_EVAL_PLANE_SCRIPT"
EVALUATION_SUBJECT_INSPECTOR = (
    "import { pathToFileURL } from 'node:url';"
    "const loaded = await import(pathToFileURL(process.argv[1]).href);"
    "const subject = loaded.loadWorkRunSubject(process.argv[2]);"
    "const verified = subject.data.events"
    ".filter((event) => event.event === 'task.verified').at(-1);"
    "process.stdout.write(JSON.stringify({"
    "schema:'work-harness-subject-snapshot-v1',"
    "runId:subject.runId,"
    "subjectVersion:subject.subjectVersion,"
    "subjectHash:subject.subjectHash,"
    "verificationId:subject.data.verification.verificationId,"
    "taskVerificationId:verified?.verificationId ?? null"
    "}));"
)
EVALUATION_RESULT_FIELDS = (
    "schema",
    "status",
    "suiteId",
    "suiteVersion",
    "runId",
    "verificationId",
    "subjectHash",
    "subjectVersion",
    "evaluationKey",
    "hardGatePassed",
    "result",
    "reportRef",
    "reportPath",
    "reused",
)
EXECUTOR_KINDS = {"parent", "subagent", "team"}
EXECUTOR_RUNTIMES = {"codex", "claude-code"}
DEFAULT_LEASE_SECONDS = 900
MIN_LEASE_SECONDS = 30
MAX_LEASE_SECONDS = 3600
DEFAULT_NODE_CONSTRAINT = "遵守 task.json 和节点 allowed_side_effects"
DOMAIN_EVALUATION_SCHEMA = "work-harness-domain-evaluation-v1"
DOMAIN_EVALUATION_RESULTS = {"pass", "blocked"}
DOMAIN_EVALUATION_FIELDS = {
    "schema",
    "task_id",
    "run_id",
    "suite_id",
    "suite_version",
    "grader_version",
    "required",
    "hard_gate_passed",
    "result",
    "report_ref",
    "report_hash",
    "metrics",
    "evidence_refs",
    "evaluated_at",
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SAFE_REFERENCE_PATTERN = re.compile(
    r"^(?:artifact|source|node|run|case|knowledge|candidate)://[A-Za-z0-9._~:/-]+$"
)
ISO_8601_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
TIMEZONE_SUFFIX_PATTERN = re.compile(
    r"(?:Z|[+-](?P<hour>\d{2}):(?P<minute>\d{2}))$"
)
UNSAFE_METRIC_KEY_PATTERN = re.compile(r"(?:prompt|output|path|url|payload)", re.IGNORECASE)
UNSAFE_APPROVAL_METRIC_KEY_PATTERN = re.compile(
    r"^(?:approval|approvalPayload|approvalRequest|approvalDecision)$",
    re.IGNORECASE,
)
UNSAFE_METRIC_STRING_PATTERN = re.compile(r"^(?:https?:|file:|/|~)", re.IGNORECASE)
PLACEHOLDER_PATTERN = re.compile(
    r"(待\s*主\s*Agent\s*补充|\bTODO\b|\bTBD\b|\bPLACEHOLDER\b)",
    re.IGNORECASE,
)
SCOPE_TOKEN_SPLIT_PATTERN = re.compile(r"[\s,，;|=]+")
SCOPE_LEADING_WRAPPER_PATTERN = re.compile(r"""^[("'[{]+""")
SCOPE_TRAILING_WRAPPER_PATTERN = re.compile(r"""[)"'\]}]+$""")
WINDOWS_DRIVE_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")
TRANSITION_SCHEMA = "work-harness-transition-v1"
TRANSITION_JOURNAL = ".transition-journal.json"
FAULT_STAGE_ENV = "WORK_HARNESS_FAULT_STAGE"
FAULT_TRANSITION_ENV = "WORK_HARNESS_FAULT_TRANSITION"
EXECUTION_DESCRIPTOR_SCHEMA = "work-harness-node-execution-v1"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def now() -> str:
    return format_timestamp(utc_now())


def parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty ISO-8601 timestamp")
    normalized = value.strip()
    timezone_match = TIMEZONE_SUFFIX_PATTERN.search(normalized)
    if timezone_match is None:
        raise ValueError(f"{field} must include a valid timezone")
    offset_hour = timezone_match.group("hour")
    offset_minute = timezone_match.group("minute")
    if (
        offset_hour is not None
        and (
            int(offset_hour) > 23
            or int(offset_minute) > 59
        )
    ):
        raise ValueError(f"{field} must include a valid timezone offset")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def require_non_empty_string(value: Any, field: str, max_length: int = 512) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > max_length:
        raise ValueError(f"{field} must be at most {max_length} characters")
    if "\n" in normalized or "\r" in normalized:
        raise ValueError(f"{field} must be a single line")
    return normalized


def require_lease_seconds(value: Any) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < MIN_LEASE_SECONDS
        or value > MAX_LEASE_SECONDS
    ):
        raise ValueError(
            f"lease_seconds must be between {MIN_LEASE_SECONDS} and {MAX_LEASE_SECONDS}"
        )
    return value


def require_positive_seconds(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{field} must be a positive integer")
    return value


def markdown_list(field: str, values: Any) -> List[str]:
    if not isinstance(values, list) or not values:
        return [f"- {field}: []"]
    return [f"- {field}:", *(f"  - {value}" for value in values)]


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
        fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, value: Dict[str, Any]) -> None:
    write_text_atomic(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def transition_id(prefix: str = "transition") -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


def journal_path(task_dir: Path) -> Path:
    return task_dir / TRANSITION_JOURNAL


def safe_transition_target(task_dir: Path, relative_path: Any) -> Path:
    if not isinstance(relative_path, str) or not relative_path:
        raise ValueError("transition target path must be a non-empty string")
    target = Path(relative_path)
    if target.is_absolute() or ".." in target.parts or relative_path == TRANSITION_JOURNAL:
        raise ValueError(f"unsafe transition target path: {relative_path!r}")
    return task_dir / target


def transition_journal_errors(value: Any) -> List[str]:
    if not isinstance(value, dict):
        return ["transition journal must be an object"]
    errors: List[str] = []
    if value.get("schema") != TRANSITION_SCHEMA:
        errors.append(f"transition journal schema must be {TRANSITION_SCHEMA}")
    identifier = value.get("transition_id")
    if not isinstance(identifier, str) or not ID_PATTERN.fullmatch(identifier):
        errors.append("transition journal transition_id must be a safe identifier")
    if not isinstance(value.get("kind"), str) or not value.get("kind", "").strip():
        errors.append("transition journal kind must be a non-empty string")
    targets = value.get("targets")
    if not isinstance(targets, list) or not targets:
        errors.append("transition journal targets must be a non-empty array")
    else:
        paths: List[str] = []
        for index, target in enumerate(targets):
            if not isinstance(target, dict):
                errors.append(f"transition journal target[{index}] must be an object")
                continue
            path = target.get("path")
            if not isinstance(path, str) or not path:
                errors.append(
                    f"transition journal target[{index}].path must be a non-empty string"
                )
            else:
                paths.append(path)
                if Path(path).is_absolute() or ".." in Path(path).parts:
                    errors.append(
                        f"transition journal target[{index}].path is unsafe"
                    )
            target_format = target.get("format")
            if target_format == "json":
                if not isinstance(target.get("snapshot"), dict):
                    errors.append(
                        f"transition journal target[{index}].snapshot must be an object"
                    )
            elif target_format == "text":
                if not isinstance(target.get("snapshot"), str):
                    errors.append(
                        f"transition journal target[{index}].snapshot must be a string"
                    )
            else:
                errors.append(
                    f"transition journal target[{index}].format must be json or text"
                )
        if len(paths) != len(set(paths)):
            errors.append("transition journal target paths must be unique")
    event = value.get("event")
    if not isinstance(event, dict):
        errors.append("transition journal event must be an object")
    else:
        if not isinstance(event.get("event"), str) or not event.get("event", "").strip():
            errors.append("transition journal event.event must be a non-empty string")
        if event.get("transition_id") != identifier:
            errors.append(
                "transition journal event.transition_id must match transition_id"
            )
    return errors


def maybe_inject_transition_fault(kind: str, stage: str) -> None:
    requested_stage = os.environ.get(FAULT_STAGE_ENV)
    requested_kind = os.environ.get(FAULT_TRANSITION_ENV)
    if requested_stage == stage and (not requested_kind or requested_kind == kind):
        raise OSError(f"injected transition fault: {kind} at {stage}")


def process_is_alive(process_id: Any) -> bool:
    if (
        not isinstance(process_id, int)
        or isinstance(process_id, bool)
        or process_id < 1
    ):
        return False
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def write_event_record_idempotent(task_dir: Path, record: Dict[str, Any]) -> None:
    records = read_event_records(task_dir)
    identifier = record.get("transition_id")
    for existing in records:
        if existing.get("transition_id") != identifier:
            continue
        if existing != record:
            raise ValueError(
                f"transition event conflict for transition_id: {identifier}"
            )
        return
    records.append(record)
    content = "".join(
        json.dumps(item, ensure_ascii=False) + "\n" for item in records
    )
    write_text_atomic(task_dir / "events.jsonl", content)


def apply_transition_journal(task_dir: Path, journal: Dict[str, Any]) -> None:
    errors = transition_journal_errors(journal)
    if errors:
        raise ValueError("invalid transition journal: " + "; ".join(errors))
    kind = journal["kind"]
    for target in journal["targets"]:
        relative_path = target["path"]
        target_path = safe_transition_target(task_dir, relative_path)
        if target["format"] == "json":
            write_json(target_path, target["snapshot"])
        else:
            write_text_atomic(target_path, target["snapshot"])
        maybe_inject_transition_fault(kind, f"after_target:{relative_path}")
    write_event_record_idempotent(task_dir, journal["event"])
    maybe_inject_transition_fault(kind, "after_event")
    journal_file = journal_path(task_dir)
    try:
        journal_file.unlink()
    except FileNotFoundError:
        pass
    fsync_directory(task_dir)


def recover_pending_transition(task_dir: Path) -> None:
    pending_path = journal_path(task_dir)
    if not pending_path.exists():
        return
    if pending_path.is_symlink() or not pending_path.is_file():
        raise ValueError(f"transition journal must be a regular file: {pending_path}")
    apply_transition_journal(task_dir, read_json(pending_path))


def commit_transition(
    task_dir: Path,
    kind: str,
    targets: List[Tuple[str, Any]],
    event: str,
    event_fields: Dict[str, Any],
    identifier: str | None = None,
) -> str:
    pending_path = journal_path(task_dir)
    if pending_path.exists():
        raise ValueError(
            "cannot begin transition while a pending journal exists"
        )
    current_id = identifier or transition_id()
    record = {
        "at": now(),
        "event": event,
        "transition_id": current_id,
        **event_fields,
    }
    journal = {
        "schema": TRANSITION_SCHEMA,
        "transition_id": current_id,
        "kind": kind,
        "created_at": now(),
        "targets": [
            {
                "path": relative_path,
                "format": "json" if isinstance(snapshot, dict) else "text",
                "snapshot": snapshot,
            }
            for relative_path, snapshot in targets
        ],
        "event": record,
    }
    errors = transition_journal_errors(journal)
    if errors:
        raise ValueError("invalid transition: " + "; ".join(errors))
    maybe_inject_transition_fault(kind, "before_journal")
    write_json(pending_path, journal)
    maybe_inject_transition_fault(kind, "after_journal")
    apply_transition_journal(task_dir, journal)
    return current_id


def pending_verification_entries(
    task_dir: Path,
) -> List[Tuple[str, Dict[str, Any]]]:
    verification_path = task_dir / "verification.json"
    if not verification_path.exists():
        return []
    verification = read_json(verification_path)
    if not isinstance(verification, dict):
        raise ValueError("verification.json must contain an object")
    triggers = verification.get("evaluation_triggers")
    if triggers is None:
        # Historical verification.json files used status=pending as an
        # initialization marker, not as an active evaluator lease.
        return []
    if not isinstance(triggers, dict):
        raise ValueError("verification.evaluation_triggers must be an object")
    return [
        (identifier, trigger)
        for identifier, trigger in triggers.items()
        if (
            isinstance(identifier, str)
            and isinstance(trigger, dict)
            and trigger.get("status") == "pending"
        )
    ]


@contextlib.contextmanager
def task_lock(
    task_dir: Path,
    *,
    allow_pending_verification: bool = False,
) -> Iterator[None]:
    task_dir.mkdir(parents=True, exist_ok=True)
    with (task_dir / ".lock").open("a+", encoding="utf-8") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            recover_pending_transition(task_dir)
            pending = pending_verification_entries(task_dir)
            if pending and not allow_pending_verification:
                identifiers = ", ".join(
                    sorted(identifier for identifier, _ in pending)
                )
                raise ValueError(
                    "task has a pending verification; only verify may resume "
                    f"or finish it: {identifiers}"
                )
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def task_read_lock(task_dir: Path) -> Iterator[None]:
    if not task_dir.is_dir():
        raise ValueError(f"missing task directory: {task_dir}")
    lock_path = task_dir / ".lock"
    try:
        stream = lock_path.open("r", encoding="utf-8")
    except FileNotFoundError:
        # Historical task directories may predate the lock file. Reading remains
        # compatible, but no file is created by this read-only command.
        if journal_path(task_dir).exists():
            raise ValueError(
                "task has a pending transition journal; run a mutating command to recover it"
            )
        yield
        return
    with stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_SH)
        try:
            if journal_path(task_dir).exists():
                raise ValueError(
                    "task has a pending transition journal; run a mutating command to recover it"
                )
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def task_files(task_dir: Path) -> Tuple[Path, Path, Path]:
    return task_dir / "task.json", task_dir / "plan.json", task_dir / "run-state.json"


def scope_tokens(value: str) -> List[str]:
    return [
        SCOPE_TRAILING_WRAPPER_PATTERN.sub(
            "",
            SCOPE_LEADING_WRAPPER_PATTERN.sub("", token),
        )
        for token in SCOPE_TOKEN_SPLIT_PATTERN.split(value)
        if token
    ]


def is_absolute_scope_token(value: str) -> bool:
    return (
        value.startswith("/")
        or bool(WINDOWS_DRIVE_PATH_PATTERN.match(value))
        or value.startswith("\\\\")
    )


def scope_write_errors(value: Any, field: str) -> List[str]:
    errors = string_list_errors(value, field)
    if errors:
        return errors
    for index, item in enumerate(value):
        if "," in item or "，" in item:
            errors.append(
                f"{field}[{index}] must contain one scope; pass repeated options instead of comma-joining scopes"
            )
        absolute_paths = [
            token for token in scope_tokens(item) if is_absolute_scope_token(token)
        ]
        if len(absolute_paths) > 1:
            errors.append(
                f"{field}[{index}] contains multiple absolute paths; pass each path as a separate option"
            )
    return errors


def real_context_list_errors(value: Any, field: str) -> List[str]:
    errors = required_string_list_errors(value, field)
    if errors:
        return errors
    for index, item in enumerate(value):
        if PLACEHOLDER_PATTERN.search(item):
            errors.append(f"{field}[{index}] must be real context, not a placeholder")
    return errors


def new_node_context_errors(node: Dict[str, Any]) -> List[str]:
    if node.get("kind") == "native-plan-step":
        return []
    errors: List[str] = []
    node_id = node.get("id", "<unknown>")
    errors.extend(real_context_list_errors(node.get("known_facts"), f"{node_id}: known_facts"))
    errors.extend(real_context_list_errors(node.get("evidence_refs"), f"{node_id}: evidence_refs"))
    return errors


def init_task(args: argparse.Namespace) -> int:
    task_id = require_id(args.task_id, "task_id")
    run_id = require_id(args.run_id or default_run_id(task_id), "run_id")
    scope_errors = scope_write_errors(args.scope or [], "scope")
    if scope_errors:
        raise ValueError("invalid scope: " + "; ".join(scope_errors))
    root = Path(args.root)
    task_dir = root / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    with task_lock(task_dir):
        existing = [
            path for path in task_dir.iterdir() if path.name != ".lock"
        ]
        reusable_empty_directories = {
            path.name
            for path in existing
            if path.name in {"nodes", "artifacts"}
            and path.is_dir()
            and not any(path.iterdir())
        }
        if any(
            path.name not in reusable_empty_directories for path in existing
        ):
            raise ValueError(f"task directory already contains files: {task_dir}")
        (task_dir / "nodes").mkdir(exist_ok=True)
        (task_dir / "artifacts").mkdir(exist_ok=True)
        initialized_at = now()
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
            "created_at": initialized_at,
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
            "executions": {},
            "updated_at": initialized_at,
        }
        context_pack = "\n".join([
            "# ContextPack",
            "",
            f"- task_id: {task_id}",
            f"- run_id: {run_id}",
            f"- objective: {args.objective}",
            *markdown_list("scope", args.scope or []),
            "",
        ])
        summary_template = {
            "schema": "work-harness-run-summary-v1",
            "task_id": task_id,
            "run_id": run_id,
            "terminal_status": "completed",
            "verification": {"verdict": "pass", "note": ""},
            "evidence_refs": [],
            "artifact_refs": [],
            "knowledge_refs": [],
            "correction_signals": [],
        }
        commit_transition(
            task_dir,
            "task.initialize",
            [
                ("task.json", task),
                ("plan.json", plan),
                ("run-state.json", state),
                ("context-pack.md", context_pack),
                ("verification.json", {"status": "pending"}),
                ("run-summary.template.json", summary_template),
            ],
            "task.initialized",
            {"runtime": args.runtime, "run_id": run_id},
        )
    print(json.dumps({"task_dir": str(task_dir), "task_id": task_id, "run_id": run_id}, ensure_ascii=False))
    return 0


def load_documents(task_dir: Path) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    task_file, plan_file, state_file = task_files(task_dir)
    return read_json(task_file), read_json(plan_file), read_json(state_file)


def safe_node_path(task_dir: Path, node_id: str) -> Path:
    node_dir = task_dir / "nodes" / require_id(node_id, "node_id")
    if node_dir.exists() and node_dir.is_symlink():
        raise ValueError(f"node directory cannot be a symlink: {node_id}")
    root = task_dir.resolve()
    target = node_dir.resolve()
    if os.path.commonpath([str(root), str(target)]) != str(root):
        raise ValueError(f"node directory escapes task directory: {node_id}")
    return node_dir


def safe_node_dir(task_dir: Path, node_id: str) -> Path:
    node_dir = safe_node_path(task_dir, node_id)
    node_dir.mkdir(parents=True, exist_ok=True)
    return node_dir


def execution_descriptor(
    task: Dict[str, Any],
    node_id: str,
    execution: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "schema": EXECUTION_DESCRIPTOR_SCHEMA,
        "task_id": task.get("task_id"),
        "run_id": task.get("run_id"),
        "node_id": node_id,
        **execution,
    }


def execution_descriptor_target(
    task: Dict[str, Any],
    node_id: str,
    execution: Dict[str, Any] | None,
) -> List[Tuple[str, Dict[str, Any]]]:
    if not isinstance(execution, dict) or not execution.get("execution_id"):
        return []
    return [
        (
            f"nodes/{node_id}/execution.json",
            execution_descriptor(task, node_id, execution),
        )
    ]


def add_node(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    dependencies = [require_id(dep, "dependency") for dep in (args.depends_on or [])]
    scope_errors = [
        *scope_write_errors(args.read_scope or [], "read_scope"),
        *scope_write_errors(args.write_scope or [], "write_scope"),
    ]
    if scope_errors:
        raise ValueError("invalid node scope: " + "; ".join(scope_errors))
    context_errors = [
        *string_list_errors(args.decisions or [], "decisions"),
        *string_list_errors(args.open_questions or [], "open_questions"),
        *string_list_errors(args.constraints or [], "constraints"),
    ]
    if context_errors:
        raise ValueError("invalid optional node context: " + "; ".join(context_errors))
    constraints = args.constraints or [DEFAULT_NODE_CONSTRAINT]
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, _ = load_documents(task_dir)
        nodes = plan.get("nodes")
        if not isinstance(nodes, list):
            raise ValueError("plan.nodes must be an array")
        if any(isinstance(node, dict) and node.get("id") == node_id for node in nodes):
            raise ValueError(f"node already exists: {node_id}")
        output_contract = {"handoff": f"nodes/{node_id}/handoff.json"}
        node = {
            "id": node_id,
            "kind": args.kind,
            "goal": args.goal,
            "depends_on": dependencies,
            "post_conditions": args.post_condition or [],
            "acceptance": args.acceptance or [],
            "read_scope": args.read_scope or [],
            "write_scope": args.write_scope or [],
            "known_facts": args.known_facts or [],
            "evidence_refs": args.evidence_refs or [],
            "decisions": args.decisions or [],
            "open_questions": args.open_questions or [],
            "constraints": constraints,
            "dispatch_reasons": args.dispatch_reasons or [],
            "output_contract": output_contract,
            "allowed_side_effects": args.allowed_side_effects or [],
            "status": "pending",
        }
        errors = [*node_granularity_errors(node), *new_node_context_errors(node)]
        if errors:
            raise ValueError("node rejected: " + "; ".join(errors))
        nodes.append(node)
        safe_node_path(task_dir, node_id)
        task_scope = task.get("scope", [])
        if not isinstance(task_scope, list):
            task_scope = []
        input_text = "\n".join(
            [
                "# ContextPack",
                "",
                f"- task_schema: {task.get('schema')}",
                f"- task_id: {task.get('task_id')}",
                f"- run_id: {task.get('run_id')}",
                f"- objective: {task.get('objective')}",
                f"- task_runtime: {task.get('runtime')}",
                f"- task_created_at: {task.get('created_at')}",
                *markdown_list("scope", task_scope),
                *markdown_list(
                    "task_acceptance",
                    task.get("acceptance", [])
                    if isinstance(task.get("acceptance"), list)
                    else [],
                ),
                *markdown_list(
                    "task_allowed_side_effects",
                    task.get("allowed_side_effects", [])
                    if isinstance(task.get("allowed_side_effects"), list)
                    else [],
                ),
                "- budget:",
                f"  - max_agents: {task.get('budget', {}).get('max_agents')}",
                f"  - max_retries: {task.get('budget', {}).get('max_retries')}",
                *markdown_list("read_scope", args.read_scope or []),
                *markdown_list("write_scope", args.write_scope or []),
                *markdown_list("known_facts", args.known_facts or []),
                *markdown_list("decisions", args.decisions or []),
                *markdown_list("open_questions", args.open_questions or []),
                *markdown_list("evidence_refs", args.evidence_refs or []),
                *markdown_list("constraints", constraints),
                "",
                "## SpawnContract",
                f"- node_id: {node_id}",
                f"- kind: {args.kind}",
                f"- goal: {args.goal}",
                *markdown_list("depends_on", dependencies),
                *markdown_list("post_conditions", args.post_condition or []),
                *markdown_list("acceptance", args.acceptance or []),
                *markdown_list("dispatch_reasons", args.dispatch_reasons or []),
                "- output_contract: "
                + json.dumps(
                    output_contract,
                    ensure_ascii=False,
                    sort_keys=True,
                ),
                *markdown_list(
                    "node_allowed_side_effects",
                    args.allowed_side_effects or [],
                ),
                "- initial_status: pending",
                "- 粒度约束: 节点是值得独立调度的最小工作单元；几条命令或同一文件内的小动作留在节点内部",
                "- forbidden: 不读取兄弟节点结论；不执行未授权副作用",
                "",
            ]
        )
        plan["updated_at"] = now()
        commit_transition(
            task_dir,
            "node.add",
            [
                ("plan.json", plan),
                (f"nodes/{node_id}/input.md", input_text),
            ],
            "node.added",
            {
                "node_id": node_id,
                "depends_on": dependencies,
                "read_scope": node["read_scope"],
                "write_scope": node["write_scope"],
                "dispatch_reasons": node["dispatch_reasons"],
                "known_fact_count": len(node["known_facts"]),
                "evidence_ref_count": len(node["evidence_refs"]),
                "decision_count": len(node["decisions"]),
                "open_question_count": len(node["open_questions"]),
            },
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
        errors.extend(
            string_list_errors(handoff.get(field), f"handoff.{field}")
        )
    if not isinstance(handoff.get("next_action"), str) or not handoff.get("next_action", "").strip():
        errors.append("handoff.next_action must be a non-empty string")
    return errors


def execution_identity_errors(
    task_dir: Path,
    task: Dict[str, Any],
    node_id: str,
    execution: Any,
) -> Tuple[List[str], str, Dict[str, Any] | None]:
    errors: List[str] = []
    descriptor_path = task_dir / "nodes" / node_id / "execution.json"
    descriptor: Dict[str, Any] | None = None
    if descriptor_path.exists():
        try:
            descriptor = read_json(descriptor_path)
        except ValueError as exc:
            errors.append(str(exc))
    try:
        identity_events = [
            event
            for event in read_event_records(task_dir)
            if (
                event.get("node_id") == node_id
                and event.get("event") in {
                    "node.started",
                    "node.handoff_recorded",
                }
            )
        ]
    except ValueError as exc:
        errors.append(str(exc))
        identity_events = []
    managed = any(
        isinstance(source, dict) and "execution_id" in source
        for source in [execution, descriptor, *identity_events]
    )
    if not managed:
        return (
            errors,
            "legacy",
            execution if isinstance(execution, dict) else None,
        )

    if not isinstance(execution, dict):
        errors.append(
            f"run-state.executions.{node_id} is required for managed execution"
        )
        return errors, "managed", None
    try:
        current_execution_id = require_id(
            execution.get("execution_id"),
            f"run-state.executions.{node_id}.execution_id",
        )
    except ValueError as exc:
        errors.append(str(exc))
        current_execution_id = None
    attempt = execution.get("attempt")

    if descriptor is None:
        errors.append(
            f"nodes/{node_id}/execution.json is required for managed execution"
        )
    elif current_execution_id is not None:
        expected_descriptor = execution_descriptor(
            task,
            node_id,
            execution,
        )
        if descriptor != expected_descriptor:
            errors.append(
                f"nodes/{node_id}/execution.json must match the current run-state execution"
            )

    if isinstance(attempt, int) and not isinstance(attempt, bool):
        started_events = [
            event
            for event in identity_events
            if (
                event.get("event") == "node.started"
                and event.get("attempt") == attempt
            )
        ]
        if not started_events:
            errors.append(
                f"node.started for {node_id} attempt {attempt} is required for managed execution"
            )
        elif current_execution_id is not None:
            for event in started_events:
                if event.get("execution_id") != current_execution_id:
                    errors.append(
                        f"node.started execution_id must match the current execution: {node_id}"
                    )
                    break
        handoff_events = [
            event
            for event in identity_events
            if (
                event.get("event") == "node.handoff_recorded"
                and event.get("attempt") == attempt
            )
        ]
        if current_execution_id is not None:
            for event in handoff_events:
                if event.get("execution_id") != current_execution_id:
                    errors.append(
                        f"node.handoff_recorded execution_id must match the current execution: {node_id}"
                    )
                    break
    return errors, "managed", execution


def handoff_execution_errors(
    handoff: Dict[str, Any],
    task_dir: Path,
    task: Dict[str, Any],
    state: Dict[str, Any],
    node_id: str,
    *,
    check_lease: bool,
    identity_checked: bool = False,
) -> Tuple[List[str], str, Dict[str, Any] | None]:
    executions = state.get("executions")
    execution = executions.get(node_id) if isinstance(executions, dict) else None
    identity_errors, identity_mode, execution = execution_identity_errors(
        task_dir,
        task,
        node_id,
        execution,
    )
    errors = [] if identity_checked else list(identity_errors)
    if identity_mode == "legacy":
        return errors, identity_mode, execution
    if not isinstance(execution, dict):
        return errors, identity_mode, None
    expected = {
        "task_id": task.get("task_id"),
        "run_id": task.get("run_id"),
        "node_id": node_id,
        "attempt": execution.get("attempt"),
        "execution_id": execution.get("execution_id"),
    }
    for field, expected_value in expected.items():
        if handoff.get(field) != expected_value:
            errors.append(
                f"handoff.{field} must match the current execution"
            )
    if check_lease:
        try:
            lease_expires = parse_timestamp(
                execution.get("lease_expires_at"),
                f"run-state.executions.{node_id}.lease_expires_at",
            )
            if lease_expires <= utc_now():
                errors.append(
                    f"handoff rejected because the current lease is stale: {node_id}"
                )
        except ValueError as exc:
            errors.append(str(exc))
    return errors, identity_mode, execution


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


def execution_record_errors(node_id: str, execution: Any) -> List[str]:
    if not isinstance(execution, dict):
        return [f"run-state.executions.{node_id} must be an object"]
    errors: List[str] = []
    if execution.get("executor_kind") not in EXECUTOR_KINDS:
        errors.append(
            f"run-state.executions.{node_id}.executor_kind must be one of {sorted(EXECUTOR_KINDS)}"
        )
    if execution.get("runtime") not in EXECUTOR_RUNTIMES:
        errors.append(
            f"run-state.executions.{node_id}.runtime must be one of {sorted(EXECUTOR_RUNTIMES)}"
        )
    executor_id = execution.get("executor_id")
    if execution.get("executor_kind") in {"subagent", "team"}:
        if not isinstance(executor_id, str) or not executor_id.strip():
            errors.append(
                f"run-state.executions.{node_id}.executor_id is required for subagent/team"
            )
    elif executor_id is not None and (not isinstance(executor_id, str) or not executor_id.strip()):
        errors.append(
            f"run-state.executions.{node_id}.executor_id must be null or a non-empty string"
        )
    attempt = execution.get("attempt")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        errors.append(f"run-state.executions.{node_id}.attempt must be a positive integer")
    if "execution_id" in execution:
        try:
            require_id(
                execution.get("execution_id"),
                f"run-state.executions.{node_id}.execution_id",
            )
        except ValueError as exc:
            errors.append(str(exc))
    try:
        require_lease_seconds(execution.get("lease_seconds"))
    except ValueError as exc:
        errors.append(f"run-state.executions.{node_id}.{exc}")
    for field in ("started_at", "last_heartbeat_at", "lease_expires_at"):
        try:
            parse_timestamp(execution.get(field), f"run-state.executions.{node_id}.{field}")
        except ValueError as exc:
            errors.append(str(exc))
    heartbeat_count = execution.get("heartbeat_count")
    if (
        not isinstance(heartbeat_count, int)
        or isinstance(heartbeat_count, bool)
        or heartbeat_count < 0
    ):
        errors.append(
            f"run-state.executions.{node_id}.heartbeat_count must be a non-negative integer"
        )
    if execution.get("status") not in NODE_STATUSES:
        errors.append(
            f"run-state.executions.{node_id}.status must be one of {sorted(NODE_STATUSES)}"
        )
    if execution.get("status") != "running":
        try:
            parse_timestamp(
                execution.get("finished_at"),
                f"run-state.executions.{node_id}.finished_at",
            )
        except ValueError as exc:
            errors.append(str(exc))
    return errors


def canonical_scope(value: str) -> Tuple[str, str, Tuple[str, ...]] | None:
    raw = value.strip()
    if not raw:
        return None
    if WINDOWS_DRIVE_PATH_PATTERN.match(raw) or raw.startswith("\\\\"):
        normalized = ntpath.normpath(raw.replace("/", "\\"))
        drive, tail = ntpath.splitdrive(normalized)
        parts = tuple(
            part.casefold()
            for part in tail.replace("/", "\\").split("\\")
            if part and part != "."
        )
        return "windows", drive.casefold(), parts
    if raw.startswith("/"):
        normalized = posixpath.normpath("/" + raw.lstrip("/"))
        parts = tuple(part for part in normalized.split("/") if part)
        return "posix", "", parts
    normalized = posixpath.normpath(raw)
    parts = tuple(
        part for part in normalized.split("/") if part and part != "."
    )
    return "relative", "", parts


def canonical_scopes_overlap(
    left: Tuple[str, str, Tuple[str, ...]],
    right: Tuple[str, str, Tuple[str, ...]],
) -> bool:
    left_flavor, left_root, left_parts = left
    right_flavor, right_root, right_parts = right
    if left_flavor != right_flavor or left_root != right_root:
        return False
    common_length = min(len(left_parts), len(right_parts))
    return left_parts[:common_length] == right_parts[:common_length]


def scopes_overlap(left: Iterable[str], right: Iterable[str]) -> bool:
    left_values = [
        canonical
        for item in left
        if isinstance(item, str)
        for canonical in [canonical_scope(item)]
        if canonical is not None
    ]
    right_values = [
        canonical
        for item in right
        if isinstance(item, str)
        for canonical in [canonical_scope(item)]
        if canonical is not None
    ]
    for left_value in left_values:
        for right_value in right_values:
            if canonical_scopes_overlap(left_value, right_value):
                return True
    return False


def ready_nodes_from_plan(plan: Dict[str, Any]) -> List[str]:
    nodes = {
        node["id"]: node
        for node in plan.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    return sorted(
        node_id
        for node_id, node in nodes.items()
        if node.get("status") == "pending"
        and all(
            nodes.get(dep, {}).get("status") == "completed"
            for dep in node.get("depends_on", [])
        )
    )


def parallel_waves_from_plan(plan: Dict[str, Any]) -> List[List[str]]:
    nodes = {
        node["id"]: node
        for node in plan.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    ready = [
        nodes[node_id]
        for node_id in ready_nodes_from_plan(plan)
    ]
    waves: List[List[str]] = []
    for node in ready:
        placed = False
        for wave in waves:
            if all(
                not scopes_overlap(
                    node.get("write_scope", []),
                    nodes[item_id].get("write_scope", []),
                )
                for item_id in wave
            ):
                wave.append(node["id"])
                placed = True
                break
        if not placed:
            waves.append([node["id"]])
    return waves


def parallel_waves(task_dir: Path) -> List[List[str]]:
    with task_read_lock(task_dir):
        _, plan, _ = load_documents(task_dir)
        return parallel_waves_from_plan(plan)


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
        executions = state.get("executions")
        execution = (
            executions.get(node_id)
            if isinstance(executions, dict)
            else None
        )
        identity_errors, _, _ = execution_identity_errors(
            task_dir,
            task,
            node_id,
            execution,
        )
        errors.extend(
            f"{node_id}: {error}" for error in identity_errors
        )
        if node.get("status") == "completed" and node.get("kind") != "native-plan-step":
            handoff_path = task_dir / "nodes" / node_id / "handoff.json"
            if not handoff_path.exists():
                errors.append(f"{node_id}: completed node has no handoff.json")
            else:
                try:
                    handoff = read_json(handoff_path)
                    errors.extend(
                        f"{node_id}: {error}"
                        for error in handoff_errors(handoff)
                    )
                    binding_errors, _, _ = handoff_execution_errors(
                        handoff,
                        task_dir,
                        task,
                        state,
                        node_id,
                        check_lease=False,
                        identity_checked=True,
                    )
                    errors.extend(
                        f"{node_id}: {error}" for error in binding_errors
                    )
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
    executions = state.get("executions")
    if executions is not None:
        if not isinstance(executions, dict):
            errors.append("run-state.executions must be an object")
        else:
            for node_id, execution in executions.items():
                if not isinstance(node_id, str) or node_id not in node_map:
                    errors.append(f"run-state.executions references unknown node: {node_id}")
                    continue
                errors.extend(execution_record_errors(node_id, execution))
                if isinstance(execution, dict):
                    if execution.get("status") != node_map[node_id].get("status"):
                        errors.append(
                            f"run-state.executions.{node_id}.status must match plan node status"
                        )
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
        with task_read_lock(task_dir):
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
    with task_read_lock(task_dir):
        _, plan, _ = load_documents(task_dir)
        return ready_nodes_from_plan(plan)


def next_command(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    with task_read_lock(task_dir):
        _, plan, _ = load_documents(task_dir)
        result = {
            "ready": ready_nodes_from_plan(plan),
            "parallel_waves": parallel_waves_from_plan(plan),
        }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def start_node(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    executor_kind = args.executor_kind
    runtime = args.runtime
    executor_id = args.executor_id
    if executor_kind not in EXECUTOR_KINDS:
        raise ValueError(f"executor_kind must be one of {sorted(EXECUTOR_KINDS)}")
    if runtime not in EXECUTOR_RUNTIMES:
        raise ValueError(f"runtime must be one of {sorted(EXECUTOR_RUNTIMES)}")
    if executor_id is not None:
        executor_id = require_non_empty_string(executor_id, "executor_id")
    if executor_kind in {"subagent", "team"} and executor_id is None:
        raise ValueError("executor_id is required for subagent/team")
    lease_seconds = require_lease_seconds(args.lease_seconds)
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        nodes = plan.get("nodes", [])
        node = next((item for item in nodes if isinstance(item, dict) and item.get("id") == node_id), None)
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        previous_status = node.get("status")
        if previous_status not in {"pending", "failed", "blocked"}:
            raise ValueError(f"node cannot start from status: {previous_status}")
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
        started = utc_now()
        started_at = format_timestamp(started)
        lease_expires_at = format_timestamp(started + timedelta(seconds=lease_seconds))
        execution_id = transition_id("execution")
        node["status"] = "running"
        for projection in ("failed_node", "blocked_node"):
            if state.get(projection) == node_id:
                state.pop(projection, None)
        current.add(node_id)
        state["current_nodes"] = sorted(current)
        state["status"] = "running"
        executions = state.setdefault("executions", {})
        if not isinstance(executions, dict):
            raise ValueError("run-state.executions must be an object")
        executions[node_id] = {
            "attempt": attempt,
            "execution_id": execution_id,
            "executor_kind": executor_kind,
            "runtime": runtime,
            "executor_id": executor_id,
            "status": "running",
            "started_at": started_at,
            "last_heartbeat_at": started_at,
            "heartbeat_count": 0,
            "lease_seconds": lease_seconds,
            "lease_expires_at": lease_expires_at,
        }
        execution = executions[node_id]
        plan["updated_at"] = started_at
        state["updated_at"] = started_at
        safe_node_dir(task_dir, node_id)
        commit_transition(
            task_dir,
            "node.start",
            [
                ("plan.json", plan),
                ("run-state.json", state),
                *execution_descriptor_target(task, node_id, execution),
            ],
            "node.started",
            {
                "node_id": node_id,
                "attempt": attempt,
                "execution_id": execution_id,
                "executor_kind": executor_kind,
                "runtime": runtime,
                "executor_id": executor_id,
                "lease_seconds": lease_seconds,
                "lease_expires_at": lease_expires_at,
            },
        )
    print(json.dumps({
        "node_id": node_id,
        "status": "running",
        "attempt": attempt,
        "execution_id": execution_id,
        "execution_descriptor": str(
            task_dir / "nodes" / node_id / "execution.json"
        ),
        "executor_kind": executor_kind,
        "runtime": runtime,
        "executor_id": executor_id,
        "lease_seconds": lease_seconds,
        "lease_expires_at": lease_expires_at,
    }, ensure_ascii=False))
    return 0


def heartbeat_node(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    requested_execution_id = (
        require_id(args.execution_id, "execution_id")
        if args.execution_id is not None
        else None
    )
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        node = next(
            (
                item
                for item in plan.get("nodes", [])
                if isinstance(item, dict) and item.get("id") == node_id
            ),
            None,
        )
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        if node.get("status") != "running" or node_id not in state.get("current_nodes", []):
            raise ValueError(f"node must be actively running before heartbeat: {node_id}")
        executions = state.get("executions")
        execution = executions.get(node_id) if isinstance(executions, dict) else None
        if not isinstance(execution, dict) or execution.get("status") != "running":
            raise ValueError(
                f"node has no managed lease: {node_id}; use check-stale and recover-stale"
            )
        identity_errors, identity_mode, _ = execution_identity_errors(
            task_dir,
            task,
            node_id,
            execution,
        )
        if identity_errors:
            raise ValueError("; ".join(identity_errors))
        if identity_mode == "managed":
            current_execution_id = require_id(
                execution.get("execution_id"),
                f"run-state.executions.{node_id}.execution_id",
            )
            if requested_execution_id is None:
                raise ValueError(
                    f"execution_id is required for the current execution: {node_id}"
                )
            if requested_execution_id != current_execution_id:
                raise ValueError(
                    f"execution_id does not match the current execution: {node_id}"
                )
        else:
            current_execution_id = None
            if requested_execution_id is not None:
                raise ValueError(
                    f"historical execution has no execution_id: {node_id}"
                )
        lease_seconds = require_lease_seconds(execution.get("lease_seconds"))
        heartbeat_at_value = utc_now()
        try:
            lease_expires = parse_timestamp(
                execution.get("lease_expires_at"),
                f"run-state.executions.{node_id}.lease_expires_at",
            )
        except ValueError as exc:
            raise ValueError(
                f"node lease metadata is invalid: {node_id}; use recover-stale"
            ) from exc
        if lease_expires <= heartbeat_at_value:
            raise ValueError(
                f"node lease is stale: {node_id}; use recover-stale before retrying"
            )
        heartbeat_at = format_timestamp(heartbeat_at_value)
        next_expiry = format_timestamp(
            heartbeat_at_value + timedelta(seconds=lease_seconds)
        )
        heartbeat_count = int(execution.get("heartbeat_count", 0)) + 1
        execution["last_heartbeat_at"] = heartbeat_at
        execution["heartbeat_count"] = heartbeat_count
        execution["lease_expires_at"] = next_expiry
        state["updated_at"] = heartbeat_at
        heartbeat_event_fields: Dict[str, Any] = {
            "node_id": node_id,
            "attempt": execution.get("attempt"),
            "identity_mode": identity_mode,
            "executor_kind": execution.get("executor_kind"),
            "runtime": execution.get("runtime"),
            "executor_id": execution.get("executor_id"),
            "heartbeat_at": heartbeat_at,
            "heartbeat_count": heartbeat_count,
            "lease_seconds": lease_seconds,
            "lease_expires_at": next_expiry,
        }
        if identity_mode == "managed":
            heartbeat_event_fields["execution_id"] = current_execution_id
        commit_transition(
            task_dir,
            "node.heartbeat",
            [
                ("run-state.json", state),
                *execution_descriptor_target(task, node_id, execution),
            ],
            "node.heartbeat",
            heartbeat_event_fields,
        )
    print(json.dumps({
        "node_id": node_id,
        "status": "running",
        "execution_id": current_execution_id,
        "identity_mode": identity_mode,
        "heartbeat_count": heartbeat_count,
        "lease_expires_at": next_expiry,
    }, ensure_ascii=False))
    return 0


def read_event_records(task_dir: Path) -> List[Dict[str, Any]]:
    path = task_dir / "events.jsonl"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    records: List[Dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"invalid events.jsonl line {line_number}: {exc}"
            ) from exc
        if not isinstance(record, dict):
            raise ValueError(f"events.jsonl line {line_number} must be an object")
        records.append(record)
    return records


def last_node_activity(
    task_dir: Path,
    state: Dict[str, Any],
    node_id: str,
) -> Tuple[datetime, str, str]:
    for event in reversed(read_event_records(task_dir)):
        if event.get("node_id") != node_id:
            continue
        if event.get("event") not in {"node.started", "node.heartbeat"}:
            continue
        timestamp = event.get("heartbeat_at") or event.get("at")
        return (
            parse_timestamp(timestamp, f"last activity for {node_id}"),
            str(timestamp),
            f"event:{event.get('event')}",
        )
    timestamp = state.get("updated_at")
    return (
        parse_timestamp(timestamp, "run-state.updated_at"),
        str(timestamp),
        "run-state.updated_at",
    )


def stale_snapshot(
    task_dir: Path,
    plan: Dict[str, Any],
    state: Dict[str, Any],
    checked_at_value: datetime,
    older_than_seconds: int | None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    nodes = {
        node.get("id"): node
        for node in plan.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    current_nodes = state.get("current_nodes", [])
    if not isinstance(current_nodes, list):
        raise ValueError("run-state.current_nodes must be an array")
    running_ids = sorted(
        set(current_nodes)
        | {
            node_id
            for node_id, node in nodes.items()
            if node.get("status") == "running"
        }
    )
    executions = state.get("executions")
    if not isinstance(executions, dict):
        executions = {}
    stale: List[Dict[str, Any]] = []
    unresolved: List[Dict[str, Any]] = []
    for node_id in running_ids:
        node = nodes.get(node_id)
        if node is None or node.get("status") != "running" or node_id not in current_nodes:
            unresolved.append({
                "node_id": node_id,
                "reason": "running_state_inconsistent",
            })
            continue
        execution = executions.get(node_id)
        if isinstance(execution, dict):
            lease_value = execution.get("lease_expires_at")
            try:
                lease_expires = parse_timestamp(
                    lease_value,
                    f"run-state.executions.{node_id}.lease_expires_at",
                )
            except ValueError:
                stale.append({
                    "node_id": node_id,
                    "reason": "invalid_lease_metadata",
                    "attempt": execution.get("attempt"),
                    "execution_id": execution.get("execution_id"),
                    "executor_kind": execution.get("executor_kind"),
                    "runtime": execution.get("runtime"),
                    "executor_id": execution.get("executor_id"),
                    "lease_expires_at": lease_value,
                })
                continue
            if lease_expires <= checked_at_value:
                stale.append({
                    "node_id": node_id,
                    "reason": "lease_expired",
                    "attempt": execution.get("attempt"),
                    "execution_id": execution.get("execution_id"),
                    "executor_kind": execution.get("executor_kind"),
                    "runtime": execution.get("runtime"),
                    "executor_id": execution.get("executor_id"),
                    "lease_expires_at": str(lease_value),
                    "overdue_seconds": max(
                        0,
                        int((checked_at_value - lease_expires).total_seconds()),
                    ),
                })
            continue
        if older_than_seconds is None:
            unresolved.append({
                "node_id": node_id,
                "reason": "lease_missing",
                "hint": "pass --older-than-seconds for historical running tasks",
            })
            continue
        try:
            activity, activity_at, activity_source = last_node_activity(
                task_dir,
                state,
                node_id,
            )
        except ValueError as exc:
            unresolved.append({
                "node_id": node_id,
                "reason": "activity_timestamp_invalid",
                "error": str(exc),
            })
            continue
        age_seconds = max(
            0,
            int((checked_at_value - activity).total_seconds()),
        )
        if age_seconds >= older_than_seconds:
            stale.append({
                "node_id": node_id,
                "reason": "legacy_activity_timeout",
                "attempt": state.get("attempts", {}).get(node_id)
                if isinstance(state.get("attempts"), dict)
                else None,
                "last_activity_at": activity_at,
                "activity_source": activity_source,
                "age_seconds": age_seconds,
                "older_than_seconds": older_than_seconds,
            })
    return stale, unresolved


def check_stale(args: argparse.Namespace) -> int:
    older_than_seconds = require_positive_seconds(
        args.older_than_seconds,
        "older_than_seconds",
    )
    task_dir = Path(args.task_dir)
    checked_at_value = utc_now()
    with task_read_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        stale, unresolved = stale_snapshot(
            task_dir,
            plan,
            state,
            checked_at_value,
            older_than_seconds,
        )
    print(json.dumps({
        "task_id": task.get("task_id"),
        "checked_at": format_timestamp(checked_at_value),
        "older_than_seconds": older_than_seconds,
        "stale_count": len(stale),
        "stale": stale,
        "unresolved": unresolved,
    }, ensure_ascii=False, indent=2))
    return 0


def recover_stale(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    older_than_seconds = require_positive_seconds(
        args.older_than_seconds,
        "older_than_seconds",
    )
    task_dir = Path(args.task_dir)
    recovered_at_value = utc_now()
    recovered_at = format_timestamp(recovered_at_value)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        nodes = plan.get("nodes", [])
        node = next(
            (
                item
                for item in nodes
                if isinstance(item, dict) and item.get("id") == node_id
            ),
            None,
        )
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        if node.get("status") != "running" or node_id not in state.get("current_nodes", []):
            raise ValueError(f"node is not actively running: {node_id}")
        stale, unresolved = stale_snapshot(
            task_dir,
            plan,
            state,
            recovered_at_value,
            older_than_seconds,
        )
        stale_record = next(
            (record for record in stale if record.get("node_id") == node_id),
            None,
        )
        if stale_record is None:
            unresolved_record = next(
                (
                    record
                    for record in unresolved
                    if record.get("node_id") == node_id
                ),
                None,
            )
            if unresolved_record is not None:
                raise ValueError(
                    f"cannot establish stale state for {node_id}: "
                    f"{unresolved_record.get('reason')}"
                )
            raise ValueError(f"node lease is not stale: {node_id}")
        executions = state.get("executions")
        execution = (
            executions.get(node_id)
            if isinstance(executions, dict)
            else None
        )
        identity_errors, identity_mode, execution = (
            execution_identity_errors(
                task_dir,
                task,
                node_id,
                execution,
            )
        )
        if identity_errors:
            raise ValueError("; ".join(identity_errors))
        attempts = state.get("attempts", {})
        if not isinstance(attempts, dict):
            raise ValueError("run-state.attempts must be an object")
        attempt = attempts.get(node_id, 0)
        if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 0:
            raise ValueError(f"invalid attempt count for node: {node_id}")
        budget = task.get("budget", {})
        max_retries = budget.get("max_retries", 0) if isinstance(budget, dict) else 0
        if not isinstance(max_retries, int) or isinstance(max_retries, bool) or max_retries < 0:
            raise ValueError("task.budget.max_retries must be a non-negative integer")
        retry_available = attempt < 1 + max_retries

        node["status"] = "failed"
        current = set(state.get("current_nodes", []))
        current.discard(node_id)
        state["current_nodes"] = sorted(current)
        state["status"] = "failed"
        state["failed_node"] = node_id
        if execution is not None:
            execution["status"] = "failed"
            execution["finished_at"] = recovered_at
            execution["recovered_at"] = recovered_at
            execution["recovery_reason"] = stale_record["reason"]
        plan["updated_at"] = recovered_at
        state["updated_at"] = recovered_at
        execution_id = (
            execution.get("execution_id")
            if identity_mode == "managed" and execution is not None
            else None
        )
        recovery_event_fields: Dict[str, Any] = {
            "node_id": node_id,
            "attempt": attempt,
            "identity_mode": identity_mode,
            "reason": stale_record["reason"],
            "executor_kind": execution.get("executor_kind")
            if execution
            else None,
            "runtime": execution.get("runtime") if execution else None,
            "executor_id": execution.get("executor_id")
            if execution
            else None,
            "lease_expires_at": execution.get("lease_expires_at")
            if execution
            else None,
            "older_than_seconds": older_than_seconds,
            "retry_available": retry_available,
        }
        if identity_mode == "managed":
            recovery_event_fields["execution_id"] = execution_id
        commit_transition(
            task_dir,
            "node.recover_stale",
            [
                ("plan.json", plan),
                ("run-state.json", state),
                *execution_descriptor_target(task, node_id, execution),
            ],
            "node.stale_recovered",
            recovery_event_fields,
        )
    print(json.dumps({
        "node_id": node_id,
        "status": "failed",
        "reason": stale_record["reason"],
        "attempt": attempt,
        "execution_id": execution_id,
        "identity_mode": identity_mode,
        "retry_available": retry_available,
    }, ensure_ascii=False))
    return 0


def record_handoff(args: argparse.Namespace) -> int:
    node_id = require_id(args.node_id, "node_id")
    handoff = read_json(Path(args.file))
    errors = handoff_errors(handoff)
    if errors:
        raise ValueError("; ".join(errors))
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, plan, state = load_documents(task_dir)
        node = next((item for item in plan.get("nodes", []) if isinstance(item, dict) and item.get("id") == node_id), None)
        if node is None:
            raise ValueError(f"unknown node: {node_id}")
        if node.get("status") != "running":
            raise ValueError(f"node must be running before handoff: {node_id} ({node.get('status')})")
        if node_id not in state.get("current_nodes", []):
            raise ValueError(
                f"node must be in run-state.current_nodes before handoff: {node_id}"
            )
        node_map = {item.get("id"): item for item in plan.get("nodes", []) if isinstance(item, dict)}
        if any(node_map.get(dep, {}).get("status") != "completed" for dep in node.get("depends_on", [])):
            raise ValueError(f"node dependencies are not completed: {node.get('depends_on', [])}")
        binding_errors, identity_mode, execution = handoff_execution_errors(
            handoff,
            task_dir,
            task,
            state,
            node_id,
            check_lease=True,
        )
        if binding_errors:
            raise ValueError("; ".join(binding_errors))
        node_dir = safe_node_dir(task_dir, node_id)
        status = handoff["status"]
        node["status"] = status
        finished_at = now()
        if execution is not None:
            execution["status"] = status
            execution["finished_at"] = finished_at
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
        plan["updated_at"] = finished_at
        state["updated_at"] = finished_at
        event_fields: Dict[str, Any] = {
            "node_id": node_id,
            "status": status,
            "identity_mode": identity_mode,
        }
        if execution is not None:
            execution_fields = {
                "attempt": execution.get("attempt"),
                "executor_kind": execution.get("executor_kind"),
                "runtime": execution.get("runtime"),
                "executor_id": execution.get("executor_id"),
            }
            if identity_mode == "managed":
                execution_fields["execution_id"] = execution.get(
                    "execution_id"
                )
            event_fields.update(execution_fields)
        commit_transition(
            task_dir,
            "node.handoff",
            [
                (f"nodes/{node_id}/handoff.json", handoff),
                ("plan.json", plan),
                ("run-state.json", state),
                *execution_descriptor_target(task, node_id, execution),
            ],
            "node.handoff_recorded",
            event_fields,
        )
    print(json.dumps({
        "node_id": node_id,
        "status": status,
        "run_status": state["status"],
        "execution_id": execution.get("execution_id") if execution else None,
        "identity_mode": identity_mode,
    }, ensure_ascii=False))
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
        commit_transition(
            task_dir,
            "run.summary",
            [("run-summary.json", summary)],
            "run.summary_recorded",
            {
                "run_id": task.get("run_id"),
                "terminal_status": summary["terminal_status"],
                "correction_signal_count": len(summary["correction_signals"]),
                "evidence_ref_count": len(summary["evidence_refs"]),
            },
        )
    print(json.dumps({"task_id": task.get("task_id"), "run_id": task.get("run_id"), "summary": str(task_dir / "run-summary.json")}, ensure_ascii=False))
    return 0


def safe_metric_scalar(value: Any) -> bool:
    if isinstance(value, bool):
        return True
    if isinstance(value, str):
        normalized = value.strip()
        return bool(normalized) and not UNSAFE_METRIC_STRING_PATTERN.search(normalized)
    if isinstance(value, int):
        try:
            return math.isfinite(float(value))
        except OverflowError:
            return False
    if isinstance(value, float):
        return math.isfinite(value)
    return False


def safe_file_reference(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.startswith("file://"):
        raise ValueError(f"{field} must be a file:// reference")
    reference = value.strip()
    raw_path = reference[len("file://"):]
    if not raw_path or "\x00" in raw_path:
        raise ValueError(f"{field} must contain a file path")
    return reference


def report_path_from_ref(task_dir: Path, report_ref: Any) -> Path:
    reference = safe_file_reference(
        report_ref,
        "domain evaluation report_ref",
    )
    raw_path = reference[len("file://"):]
    path = Path(raw_path)
    if not path.is_absolute():
        path = task_dir.resolve() / path
    return path


def evidence_reference_is_safe(value: str) -> bool:
    reference = value.strip()
    if SAFE_REFERENCE_PATTERN.fullmatch(reference):
        return True
    try:
        safe_file_reference(reference, "domain evaluation evidence_ref")
    except ValueError:
        return False
    return True


def hash_regular_file(path: Path) -> str:
    if path.is_symlink():
        raise ValueError("domain evaluation report must not be a symlink")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as exc:
        raise ValueError(f"domain evaluation report does not exist: {path}") from exc
    except OSError as exc:
        raise ValueError(f"domain evaluation report cannot be opened safely: {path}") from exc
    digest = hashlib.sha256()
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"domain evaluation report must be a regular file: {path}")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def domain_evaluation_errors(
    value: Any,
    task: Dict[str, Any],
    task_dir: Path,
) -> List[str]:
    if not isinstance(value, dict):
        return ["domain evaluation must be an object"]
    errors: List[str] = []
    missing = sorted(DOMAIN_EVALUATION_FIELDS - set(value))
    errors.extend(f"domain evaluation missing field: {field}" for field in missing)
    unknown = sorted(set(value) - DOMAIN_EVALUATION_FIELDS)
    errors.extend(f"domain evaluation has unknown field: {field}" for field in unknown)
    if value.get("schema") != DOMAIN_EVALUATION_SCHEMA:
        errors.append(f"domain evaluation schema must be {DOMAIN_EVALUATION_SCHEMA}")
    for field in ("task_id", "run_id", "suite_id"):
        field_value = value.get(field)
        if not isinstance(field_value, str) or not ID_PATTERN.fullmatch(field_value):
            errors.append(
                f"domain evaluation {field} must match {ID_PATTERN.pattern}"
            )
    for field in ("suite_version", "grader_version"):
        field_value = value.get(field)
        if not isinstance(field_value, str) or not VERSION_PATTERN.fullmatch(field_value):
            errors.append(
                f"domain evaluation {field} must match {VERSION_PATTERN.pattern}"
            )
    if value.get("task_id") != task.get("task_id"):
        errors.append("domain evaluation task_id must match task.json")
    if value.get("run_id") != task.get("run_id"):
        errors.append("domain evaluation run_id must match task.json")
    for field in ("required", "hard_gate_passed"):
        if not isinstance(value.get(field), bool):
            errors.append(f"domain evaluation {field} must be a boolean")
    if value.get("result") not in DOMAIN_EVALUATION_RESULTS:
        errors.append(
            f"domain evaluation result must be one of {sorted(DOMAIN_EVALUATION_RESULTS)}"
        )
    elif isinstance(value.get("hard_gate_passed"), bool) and (
        (value.get("result") == "pass") != value.get("hard_gate_passed")
    ):
        errors.append(
            "domain evaluation result=pass must be equivalent to hard_gate_passed=true"
        )
    report_hash = value.get("report_hash")
    if not isinstance(report_hash, str) or not SHA256_PATTERN.fullmatch(report_hash):
        errors.append("domain evaluation report_hash must be 64 lowercase sha256 characters")
    metrics = value.get("metrics")
    if not isinstance(metrics, dict):
        errors.append("domain evaluation metrics must be an object")
    else:
        for key, metric_value in metrics.items():
            if (
                not isinstance(key, str)
                or not ID_PATTERN.fullmatch(key)
                or UNSAFE_METRIC_KEY_PATTERN.search(key)
                or UNSAFE_APPROVAL_METRIC_KEY_PATTERN.fullmatch(key)
            ):
                errors.append(
                    f"domain evaluation metrics key is unsafe: {key!r}"
                )
                continue
            if not safe_metric_scalar(metric_value):
                errors.append(
                    f"domain evaluation metrics.{key} must be a finite number, boolean, "
                    "or non-empty non-path string"
                )
    evidence_errors = required_string_list_errors(
        value.get("evidence_refs"),
        "domain evaluation evidence_refs",
    )
    errors.extend(evidence_errors)
    if not evidence_errors:
        for index, evidence_ref in enumerate(value["evidence_refs"]):
            if not evidence_reference_is_safe(evidence_ref):
                errors.append(
                    f"domain evaluation evidence_refs[{index}] must be a safe URI or file:// reference"
                )
    try:
        evaluated_at = value.get("evaluated_at")
        if not isinstance(evaluated_at, str) or not ISO_8601_PATTERN.fullmatch(evaluated_at):
            raise ValueError(
                "domain evaluation evaluated_at must be an ISO-8601 timestamp with seconds and timezone"
            )
        parse_timestamp(evaluated_at, "domain evaluation evaluated_at")
    except ValueError as exc:
        errors.append(str(exc))
    try:
        report_path = report_path_from_ref(task_dir, value.get("report_ref"))
        computed_hash = hash_regular_file(report_path)
        if (
            isinstance(report_hash, str)
            and SHA256_PATTERN.fullmatch(report_hash)
            and computed_hash != report_hash
        ):
            errors.append("domain evaluation report_hash does not match report bytes")
    except ValueError as exc:
        errors.append(str(exc))
    return errors


def record_domain_evaluation(args: argparse.Namespace) -> int:
    incoming = read_json(Path(args.file))
    task_dir = Path(args.task_dir)
    with task_lock(task_dir):
        task, _, _ = load_documents(task_dir)
        errors = domain_evaluation_errors(incoming, task, task_dir)
        if errors:
            raise ValueError("invalid domain evaluation: " + "; ".join(errors))
        commit_transition(
            task_dir,
            "domain_evaluation.record",
            [("domain-evaluation.json", dict(incoming))],
            "domain_evaluation.recorded",
            {
                "evaluation_schema": incoming["schema"],
                "task_id": incoming["task_id"],
                "run_id": incoming["run_id"],
                "suite_id": incoming["suite_id"],
                "suite_version": incoming["suite_version"],
                "grader_version": incoming["grader_version"],
                "required": incoming["required"],
                "hard_gate_passed": incoming["hard_gate_passed"],
                "result": incoming["result"],
                "report_ref": incoming["report_ref"],
                "report_hash": incoming["report_hash"],
                "metric_count": len(incoming["metrics"]),
                "evidence_ref_count": len(incoming["evidence_refs"]),
                "evaluated_at": incoming["evaluated_at"],
            },
        )
    print(json.dumps({
        "task_id": incoming["task_id"],
        "run_id": incoming["run_id"],
        "domain_evaluation": str(task_dir / "domain-evaluation.json"),
        "result": incoming["result"],
        "hard_gate_passed": incoming["hard_gate_passed"],
    }, ensure_ascii=False))
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


def canonical_subject_module() -> Path:
    module = (
        Path(__file__).resolve().parents[2]
        / "eval-plane" / "src" / "work-run-subject.ts"
    )
    try:
        metadata = module.lstat()
    except OSError as exc:
        raise ValueError("canonical v4 subject projector is unavailable") from exc
    if module.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("canonical v4 subject projector must be a regular file")
    return module


def trusted_subject_hash(
    node: str,
    task_dir: Path,
    expected_run_id: str,
    expected_verification_id: str,
) -> str:
    command = [
        node,
        "--no-warnings=ExperimentalWarning",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        EVALUATION_SUBJECT_INSPECTOR,
        str(canonical_subject_module()),
        str(task_dir.resolve()),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=EVALUATION_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("canonical v4 subject projection failed") from exc
    if completed.returncode != 0:
        raise ValueError("canonical v4 subject projection failed")
    try:
        snapshot = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError("canonical v4 subject projection returned invalid output") from exc
    if not isinstance(snapshot, dict):
        raise ValueError("canonical v4 subject projection must return an object")
    if snapshot.get("schema") != "work-harness-subject-snapshot-v1":
        raise ValueError("canonical v4 subject projection schema mismatch")
    if snapshot.get("runId") != expected_run_id:
        raise ValueError("canonical v4 subject run identity mismatch")
    if snapshot.get("subjectVersion") != EVALUATION_SUBJECT_VERSION:
        raise ValueError("canonical v4 subject version mismatch")
    subject_hash = snapshot.get("subjectHash")
    if (
        not isinstance(subject_hash, str)
        or not SHA256_PATTERN.fullmatch(subject_hash)
    ):
        raise ValueError("canonical v4 subject hash is invalid")
    if (
        snapshot.get("verificationId") != expected_verification_id
        or snapshot.get("taskVerificationId") != expected_verification_id
    ):
        raise ValueError("canonical v4 subject verification identity mismatch")
    return subject_hash


def read_regular_bytes(path: Path, label: str) -> bytes:
    if path.is_symlink():
        raise ValueError(f"{label} must not be a symlink")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ValueError(f"{label} cannot be opened safely") from exc
    chunks: List[bytes] = []
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"{label} must be a regular file")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def string_list(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(isinstance(item, str) and bool(item.strip()) for item in value)
    )


def evaluation_report_errors(
    value: Dict[str, Any],
    task_dir: Path,
    expected_run_id: str,
    expected_subject_hash: str,
) -> List[str]:
    errors: List[str] = []
    evaluation_key = value.get("evaluationKey")
    if (
        not isinstance(evaluation_key, str)
        or not ID_PATTERN.fullmatch(evaluation_key)
    ):
        return ["evaluation report cannot be bound without a safe evaluationKey"]
    expected_path = (
        task_dir.resolve()
        / "evaluations" / EVALUATION_SUITE_ID / f"{evaluation_key}.json"
    )
    if value.get("reportPath") != str(expected_path):
        errors.append("evaluation reportPath must be the canonical report path")
        return errors
    try:
        report_bytes = read_regular_bytes(
            expected_path,
            "evaluation report",
        )
    except ValueError as exc:
        errors.append(str(exc))
        return errors
    report_hash = hashlib.sha256(report_bytes).hexdigest()
    try:
        report = json.loads(report_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        errors.append("evaluation report must be valid UTF-8 JSON")
        return errors
    if not isinstance(report, dict):
        return errors + ["evaluation report must be an object"]

    expected_report_fields = {
        "schema": EVALUATION_REPORT_SCHEMA,
        "evalVersion": EVALUATION_EVAL_VERSION,
        "kind": "run_assessment",
        "suiteId": EVALUATION_SUITE_ID,
        "suiteVersion": EVALUATION_SUITE_VERSION,
        "harnessId": EVALUATION_HARNESS_ID,
        "runId": expected_run_id,
        "subjectVersion": EVALUATION_SUBJECT_VERSION,
        "subjectHash": expected_subject_hash,
        "evaluationKey": evaluation_key,
    }
    for field, expected in expected_report_fields.items():
        if report.get(field) != expected:
            errors.append(f"evaluation report {field} mismatch")
    for field in (
        "runId",
        "suiteId",
        "suiteVersion",
        "subjectVersion",
        "subjectHash",
        "evaluationKey",
        "hardGatePassed",
    ):
        if report.get(field) != value.get(field):
            errors.append(f"evaluation stdout and report {field} mismatch")
    grader_version = report.get("graderVersion")
    if grader_version != EVALUATION_GRADER_VERSION:
        errors.append(
            "evaluation report graderVersion must be deterministic-v1"
        )
    derived_evaluation_key = hashlib.sha256("\n".join([
        expected_run_id,
        EVALUATION_SUITE_ID,
        EVALUATION_SUITE_VERSION,
        expected_subject_hash,
        EVALUATION_GRADER_VERSION,
    ]).encode("utf-8")).hexdigest()
    if evaluation_key != derived_evaluation_key:
        errors.append(
            "evaluation evaluationKey does not match the v4 identity"
        )
    if not isinstance(report.get("hardGatePassed"), bool):
        errors.append("evaluation report hardGatePassed must be a boolean")
    results = report.get("results")
    result_rows: List[Dict[str, Any]] = []
    result_case_ids: List[str] = []
    if not isinstance(results, list):
        errors.append("evaluation report results must be an array")
    else:
        result_identity = {
            "schema": EVALUATION_RESULT_SCHEMA,
            "evalVersion": EVALUATION_EVAL_VERSION,
            "suiteId": EVALUATION_SUITE_ID,
            "suiteVersion": EVALUATION_SUITE_VERSION,
            "harnessId": EVALUATION_HARNESS_ID,
            "runId": expected_run_id,
            "subjectVersion": EVALUATION_SUBJECT_VERSION,
            "graderVersion": grader_version,
        }
        for index, result in enumerate(results):
            if not isinstance(result, dict):
                errors.append(f"evaluation report result {index} must be an object")
                continue
            result_rows.append(result)
            for field, expected in result_identity.items():
                if result.get(field) != expected:
                    errors.append(
                        f"evaluation report result {index} {field} mismatch"
                    )
            if (
                not isinstance(result.get("caseId"), str)
                or not ID_PATTERN.fullmatch(result["caseId"])
            ):
                errors.append(
                    f"evaluation report result {index} caseId is invalid"
                )
            else:
                result_case_ids.append(result["caseId"])
            expected_level = EVALUATION_CASE_LEVELS.get(result.get("caseId"))
            if expected_level is None or result.get("level") != expected_level:
                errors.append(
                    f"evaluation report result {index} level does not match the fixed v4 case"
                )
            status_value = result.get("status")
            if status_value not in {"pass", "fail"}:
                errors.append(
                    f"evaluation report result {index} status is invalid"
                )
            for field in ("expected", "observed"):
                if (
                    not isinstance(result.get(field), str)
                    or not result[field].strip()
                ):
                    errors.append(
                        f"evaluation report result {index} {field} is invalid"
                    )
            if result.get("diagnosis") not in EVALUATION_DIAGNOSES:
                errors.append(
                    f"evaluation report result {index} diagnosis is invalid"
                )
            for field in ("reasonCodes", "evidenceRefs", "artifactRefs"):
                if not string_list(result.get(field)):
                    errors.append(
                        f"evaluation report result {index} {field} is invalid"
                    )
            if not isinstance(result.get("metrics"), dict):
                errors.append(
                    f"evaluation report result {index} metrics is invalid"
                )
        expected_case_ids = set(EVALUATION_CASE_LEVELS)
        actual_case_ids = set(result_case_ids)
        duplicates = sorted({
            case_id
            for case_id in result_case_ids
            if result_case_ids.count(case_id) > 1
        })
        missing = sorted(expected_case_ids - actual_case_ids)
        extra = sorted(actual_case_ids - expected_case_ids)
        if duplicates:
            errors.append(
                "evaluation report results contain duplicate caseId(s): "
                + ", ".join(duplicates)
            )
        if missing:
            errors.append(
                "evaluation report results are missing fixed v4 case(s): "
                + ", ".join(missing)
            )
        if extra:
            errors.append(
                "evaluation report results contain extra case(s): "
                + ", ".join(extra)
            )
        if len(results) != len(EVALUATION_CASE_LEVELS):
            errors.append(
                "evaluation report results must contain exactly the seven fixed v4 cases"
            )

    derived_hard_gate: bool | None = None
    derived_result: str | None = None
    derived_total_cases: int | None = None
    derived_passed_cases: int | None = None
    derived_failed_cases: int | None = None
    derived_reason_codes: List[str] | None = None
    complete_unique_cases = (
        len(result_rows) == len(EVALUATION_CASE_LEVELS)
        and len(result_case_ids) == len(EVALUATION_CASE_LEVELS)
        and len(set(result_case_ids)) == len(EVALUATION_CASE_LEVELS)
        and set(result_case_ids) == set(EVALUATION_CASE_LEVELS)
    )
    if complete_unique_cases:
        results_by_case = {
            result["caseId"]: result for result in result_rows
        }
        domain_metrics = results_by_case["work-run-domain-result"].get("metrics")
        domain_required = (
            domain_metrics.get("required")
            if isinstance(domain_metrics, dict)
            else None
        )
        if not isinstance(domain_required, bool):
            errors.append(
                "evaluation report work-run-domain-result metrics.required must be a boolean"
            )
        statuses_valid = all(
            result.get("status") in {"pass", "fail"}
            for result in result_rows
        )
        reasons_valid = all(
            string_list(result.get("reasonCodes"))
            for result in result_rows
        )
        if statuses_valid and isinstance(domain_required, bool):
            level_one_passed = all(
                results_by_case[case_id]["status"] == "pass"
                for case_id, level in EVALUATION_CASE_LEVELS.items()
                if level == "L1"
            )
            required_domain_passed = (
                not domain_required
                or results_by_case["work-run-domain-result"]["status"] == "pass"
            )
            derived_hard_gate = (
                level_one_passed and required_domain_passed
            )
            if report.get("hardGatePassed") != derived_hard_gate:
                errors.append(
                    "evaluation report hardGatePassed does not match fixed v4 results"
                )
            derived_result = (
                "blocked"
                if not derived_hard_gate
                else (
                    "pass"
                    if all(
                        result["status"] == "pass"
                        for result in result_rows
                    )
                    else "partial"
                )
            )
        if statuses_valid and reasons_valid:
            expected_levels: List[Dict[str, Any]] = []
            for level in ("L1", "L2", "L3"):
                level_results = [
                    result for result in result_rows
                    if result.get("level") == level
                ]
                failed_results = [
                    result for result in level_results
                    if result["status"] == "fail"
                ]
                reason_counts: Dict[str, int] = {}
                for result in failed_results:
                    for reason in result["reasonCodes"]:
                        reason_counts[reason] = (
                            reason_counts.get(reason, 0) + 1
                        )
                expected_levels.append({
                    "level": level,
                    "totalCases": len(level_results),
                    "passedCases": len(level_results) - len(failed_results),
                    "failedCases": len(failed_results),
                    "failedCaseIds": [
                        result["caseId"] for result in failed_results
                    ],
                    "reasonCodes": reason_counts,
                })
            if report.get("levels") != expected_levels:
                errors.append(
                    "evaluation report levels do not match the fixed v4 results"
                )
            failed_results = [
                result for result in result_rows
                if result["status"] == "fail"
            ]
            derived_total_cases = len(result_rows)
            derived_failed_cases = len(failed_results)
            derived_passed_cases = (
                derived_total_cases - derived_failed_cases
            )
            derived_reason_codes = []
            for result in failed_results:
                for reason in result["reasonCodes"]:
                    if reason not in derived_reason_codes:
                        derived_reason_codes.append(reason)
    elif not isinstance(report.get("levels"), list):
        errors.append("evaluation report levels must be an array")
    if derived_result is not None and value.get("result") != derived_result:
        errors.append("evaluation stdout result does not match report results")

    events_path = task_dir.resolve() / "evaluations" / "events.jsonl"
    try:
        event_bytes = read_regular_bytes(
            events_path,
            "evaluation event log",
        )
        event_text = event_bytes.decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        errors.append(str(exc))
        return errors
    matching_events: List[Dict[str, Any]] = []
    for index, line in enumerate(event_text.splitlines()):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            errors.append(f"evaluation event log line {index + 1} is invalid")
            continue
        if (
            not isinstance(event, dict)
            or event.get("schema") != EVALUATION_EVENT_SCHEMA
            or event.get("event") != "evaluation.completed"
        ):
            errors.append(f"evaluation event log line {index + 1} is invalid")
            continue
        if (
            event.get("suiteId") == EVALUATION_SUITE_ID
            and event.get("evaluationKey") == evaluation_key
        ):
            matching_events.append(event)
    if not matching_events:
        errors.append("evaluation completion event is missing")
        return errors
    event = matching_events[-1]
    event_hard_gate = event.get("hardGatePassed")
    if "hardGatePassed" not in event:
        # work-harness-eval-event-v1 historically omitted this field. Its
        # result is bijective with the hard gate and remains an explicit,
        # fail-closed compatibility source for existing Eval producers.
        if event.get("result") == "blocked":
            event_hard_gate = False
        elif event.get("result") in {"pass", "partial"}:
            event_hard_gate = True
    expected_event_fields = {
        "runId": expected_run_id,
        "suiteId": EVALUATION_SUITE_ID,
        "suiteVersion": EVALUATION_SUITE_VERSION,
        "graderVersion": grader_version,
        "subjectVersion": EVALUATION_SUBJECT_VERSION,
        "subjectHash": expected_subject_hash,
        "evaluationKey": evaluation_key,
        "hardGatePassed": value.get("hardGatePassed"),
        "result": derived_result,
        "totalCases": derived_total_cases,
        "passedCases": derived_passed_cases,
        "failedCases": derived_failed_cases,
        "reasonCodes": derived_reason_codes,
        "reportRef": value.get("reportRef"),
        "reportHash": report_hash,
    }
    for field, expected in expected_event_fields.items():
        actual = (
            event_hard_gate
            if field == "hardGatePassed"
            else event.get(field)
        )
        if actual != expected:
            errors.append(f"evaluation completion event {field} mismatch")
    expected_ref = (
        f"artifact://evaluation/{EVALUATION_SUITE_ID}/{evaluation_key}"
    )
    if value.get("reportRef") != expected_ref:
        errors.append("evaluation stdout reportRef mismatch")
    return errors


def evaluation_output_errors(
    value: Any,
    task_dir: Path,
    expected_run_id: str,
    expected_verification_id: str,
    expected_subject_hash: str,
) -> List[str]:
    if not isinstance(value, dict):
        return ["evaluation output must be an object"]
    errors: List[str] = []
    if value.get("schema") != EVALUATION_SCHEMA:
        errors.append(f"evaluation schema must be {EVALUATION_SCHEMA}")
    if value.get("status") != "completed":
        errors.append("evaluation status must be completed")
    if value.get("suiteId") != EVALUATION_SUITE_ID:
        errors.append(f"evaluation suiteId must be {EVALUATION_SUITE_ID}")
    if value.get("suiteVersion") != EVALUATION_SUITE_VERSION:
        errors.append(
            f"evaluation suiteVersion must be {EVALUATION_SUITE_VERSION}"
        )
    if value.get("verificationId") != expected_verification_id:
        errors.append(
            "evaluation verificationId must match the current verification"
        )
    subject_hash = value.get("subjectHash")
    if (
        not isinstance(subject_hash, str)
        or not SHA256_PATTERN.fullmatch(subject_hash)
    ):
        errors.append(
            "evaluation subjectHash must be a 64-character lowercase sha256"
        )
    elif subject_hash != expected_subject_hash:
        errors.append("evaluation subjectHash must match the current v4 subject")
    if value.get("subjectVersion") != EVALUATION_SUBJECT_VERSION:
        errors.append(
            f"evaluation subjectVersion must be {EVALUATION_SUBJECT_VERSION}"
        )
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
        expected_path = (
            task_dir.resolve()
            / "evaluations" / EVALUATION_SUITE_ID / f"{evaluation_key}.json"
        )
        report_path = value.get("reportPath")
        if not isinstance(report_path, str) or report_path != str(expected_path):
            errors.append("evaluation reportPath must match the current task directory and evaluationKey")
    else:
        errors.append("evaluation evaluationKey must be a safe identifier")
    errors.extend(
        evaluation_report_errors(
            value,
            task_dir,
            expected_run_id,
            expected_subject_hash,
        )
    )
    return errors


def evaluation_trigger_result(status: str, reason: str) -> Dict[str, Any]:
    return {"status": status, "suiteId": EVALUATION_SUITE_ID, "reason": reason}


def trigger_work_evaluation(
    task_dir: Path,
    verification_id: str,
    expected_run_id: str,
) -> Dict[str, Any]:
    script, skip_reason = evaluation_script()
    if skip_reason is not None:
        return evaluation_trigger_result("skipped", skip_reason)
    node = shutil.which("node")
    if node is None:
        return evaluation_trigger_result("skipped", "node_not_found")
    try:
        subject_hash_before = trusted_subject_hash(
            node,
            task_dir,
            expected_run_id,
            verification_id,
        )
    except ValueError:
        return evaluation_trigger_result("failed", "invalid_output")
    command = [
        node,
        "--no-warnings=ExperimentalWarning",
        "--experimental-strip-types",
        str(script),
        "--task-dir",
        str(task_dir.resolve()),
        "--suite",
        EVALUATION_SUITE_ID,
        "--verification-id",
        verification_id,
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
    try:
        subject_hash_after = trusted_subject_hash(
            node,
            task_dir,
            expected_run_id,
            verification_id,
        )
    except ValueError:
        return evaluation_trigger_result("failed", "invalid_output")
    if subject_hash_after != subject_hash_before:
        return evaluation_trigger_result("failed", "invalid_output")
    if evaluation_output_errors(
        output,
        task_dir,
        expected_run_id,
        verification_id,
        subject_hash_before,
    ):
        return evaluation_trigger_result("failed", "invalid_output")
    return {field: output[field] for field in EVALUATION_RESULT_FIELDS}


def record_evaluation_trigger_locked(
    task_dir: Path,
    evaluation: Dict[str, Any],
    verification_id: str,
) -> None:
    status = evaluation["status"]
    fields: Dict[str, Any] = {
        "suite_id": EVALUATION_SUITE_ID,
        "suite_version": EVALUATION_SUITE_VERSION,
        "subject_version": EVALUATION_SUBJECT_VERSION,
        "verification_id": verification_id,
    }
    if status == "completed":
        event = "evaluation.trigger_completed"
        fields.update({
            "evaluation_schema": evaluation["schema"],
            "evaluation_run_id": evaluation["runId"],
            "evaluation_key": evaluation["evaluationKey"],
            "subject_hash": evaluation["subjectHash"],
            "hard_gate_passed": evaluation["hardGatePassed"],
            "result": evaluation["result"],
            "report_ref": evaluation["reportRef"],
            "reused": evaluation["reused"],
        })
    else:
        event = f"evaluation.trigger_{status}"
        fields["reason"] = evaluation["reason"]
    verification = read_json(task_dir / "verification.json")
    triggers = verification.setdefault("evaluation_triggers", {})
    if not isinstance(triggers, dict):
        raise ValueError("verification.evaluation_triggers must be an object")
    existing_trigger = triggers.get(verification_id, {})
    if not isinstance(existing_trigger, dict):
        existing_trigger = {}
    trigger = {
        **existing_trigger,
        "status": status,
        "suite_id": EVALUATION_SUITE_ID,
        "suite_version": EVALUATION_SUITE_VERSION,
        "subject_version": EVALUATION_SUBJECT_VERSION,
        "verification_id": verification_id,
        "recorded_at": now(),
    }
    if status == "completed":
        trigger["subject_hash"] = evaluation["subjectHash"]
    triggers[verification_id] = trigger
    commit_transition(
        task_dir,
        "evaluation.trigger",
        [("verification.json", verification)],
        event,
        fields,
    )


def resumable_verification(
    verification: Dict[str, Any],
) -> Tuple[str, Dict[str, Any]] | None:
    triggers = verification.get("evaluation_triggers", {})
    if not isinstance(triggers, dict):
        raise ValueError("verification.evaluation_triggers must be an object")
    candidates: List[Tuple[str, Dict[str, Any]]] = []
    for identifier, trigger in triggers.items():
        if (
            isinstance(identifier, str)
            and isinstance(trigger, dict)
            and trigger.get("status") == "pending"
            and not process_is_alive(trigger.get("owner_pid"))
        ):
            candidates.append((identifier, trigger))
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda item: str(item[1].get("recorded_at", "")),
    )


def verify_task(args: argparse.Namespace) -> int:
    task_dir = Path(args.task_dir)
    with task_lock(task_dir, allow_pending_verification=True):
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
        existing_verification = read_json(task_dir / "verification.json")
        evaluation_triggers = existing_verification.get("evaluation_triggers", {})
        if not isinstance(evaluation_triggers, dict):
            raise ValueError("verification.evaluation_triggers must be an object")
        pending_entries = [
            (identifier, trigger)
            for identifier, trigger in evaluation_triggers.items()
            if (
                isinstance(identifier, str)
                and isinstance(trigger, dict)
                and trigger.get("status") == "pending"
            )
        ]
        if len(pending_entries) > 1:
            raise ValueError(
                "multiple pending verifications cannot be resumed safely"
            )
        resumable = resumable_verification(existing_verification)
        if pending_entries and resumable is None:
            raise ValueError(
                "pending verification is still owned by an active verify"
            )
        if resumable is not None:
            verification_id, pending = resumable
            pending_verdict = pending.get("verdict")
            if pending_verdict != args.verdict:
                raise ValueError(
                    "pending verification must be resumed with "
                    f"--verdict {pending_verdict}"
                )
            passed = pending_verdict == "pass"
            pending["owner_pid"] = os.getpid()
            pending["resumed_at"] = now()
            pending["verification_id"] = verification_id
            pending["suite_id"] = EVALUATION_SUITE_ID
            pending["suite_version"] = EVALUATION_SUITE_VERSION
            pending["subject_version"] = EVALUATION_SUBJECT_VERSION
            commit_transition(
                task_dir,
                "evaluation.resume",
                [("verification.json", existing_verification)],
                "evaluation.trigger_resumed",
                {
                    "task_id": task.get("task_id"),
                    "run_id": task.get("run_id"),
                    "verification_id": verification_id,
                    "suite_id": EVALUATION_SUITE_ID,
                    "suite_version": EVALUATION_SUITE_VERSION,
                    "subject_version": EVALUATION_SUBJECT_VERSION,
                },
            )
        else:
            verification_id = transition_id("verification")
            passed = args.verdict == "pass"
            verification = dict(summary["verification"])
            verification["verdict"] = args.verdict
            verification["verification_id"] = verification_id
            if args.note:
                verification["note"] = args.note
            summary["verification"] = verification
            if passed:
                summary["terminal_status"] = "completed"
            verified_at = now()
            summary["finalized_at"] = verified_at
            evaluation_triggers[verification_id] = {
                "status": "pending",
                "suite_id": EVALUATION_SUITE_ID,
                "suite_version": EVALUATION_SUITE_VERSION,
                "subject_version": EVALUATION_SUBJECT_VERSION,
                "verification_id": verification_id,
                "recorded_at": verified_at,
                "owner_pid": os.getpid(),
                "verdict": args.verdict,
                "note": args.note or "",
            }
            verification_document = {
                "status": "passed" if passed else "failed",
                "note": args.note or "",
                "at": verified_at,
                "verification_id": verification_id,
                "evaluation_triggers": evaluation_triggers,
            }
            state["status"] = "completed" if passed else "blocked"
            state["updated_at"] = verified_at
            state["latest_verification_id"] = verification_id
            commit_transition(
                task_dir,
                "task.verify",
                [
                    ("run-summary.json", summary),
                    ("verification.json", verification_document),
                    ("run-state.json", state),
                ],
                "task.verified",
                {
                    "task_id": task.get("task_id"),
                    "run_id": task.get("run_id"),
                    "verification_id": verification_id,
                    "verdict": args.verdict,
                },
            )
        evaluation = trigger_work_evaluation(
            task_dir,
            verification_id,
            str(task.get("run_id", "")),
        )
        record_evaluation_trigger_locked(
            task_dir,
            evaluation,
            verification_id,
        )
    print(json.dumps({
        "status": state["status"],
        "verification": "passed" if passed else "failed",
        "verification_id": verification_id,
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
        imported_at = now()
        candidate_plan["updated_at"] = imported_at
        candidate_state["updated_at"] = imported_at
        commit_transition(
            task_dir,
            "native_plan.import",
            [
                ("plan.json", candidate_plan),
                ("run-state.json", candidate_state),
            ],
            "native_plan.imported",
            {"step_count": len(normalized_steps)},
        )
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
    add.add_argument("--known-fact", dest="known_facts", action="append")
    add.add_argument("--evidence-ref", dest="evidence_refs", action="append")
    add.add_argument("--decision", dest="decisions", action="append")
    add.add_argument("--open-question", dest="open_questions", action="append")
    add.add_argument("--constraint", dest="constraints", action="append")
    add.add_argument("--dispatch-reason", dest="dispatch_reasons", action="append")
    add.add_argument("--allowed-side-effect", dest="allowed_side_effects", action="append")
    add.set_defaults(func=add_node)

    start = sub.add_parser("start-node")
    start.add_argument("task_dir")
    start.add_argument("--node-id", required=True)
    start.add_argument("--executor-kind", choices=sorted(EXECUTOR_KINDS), required=True)
    start.add_argument("--runtime", choices=sorted(EXECUTOR_RUNTIMES), required=True)
    start.add_argument("--executor-id")
    start.add_argument("--lease-seconds", type=int, default=DEFAULT_LEASE_SECONDS)
    start.set_defaults(func=start_node)

    for name, func in (("validate", validate_command), ("next", next_command)):
        command = sub.add_parser(name)
        command.add_argument("task_dir")
        command.set_defaults(func=func)

    heartbeat = sub.add_parser("heartbeat")
    heartbeat.add_argument("task_dir")
    heartbeat.add_argument("--node-id", required=True)
    heartbeat.add_argument("--execution-id")
    heartbeat.set_defaults(func=heartbeat_node)

    stale = sub.add_parser("check-stale")
    stale.add_argument("task_dir")
    stale.add_argument("--older-than-seconds", type=int)
    stale.set_defaults(func=check_stale)

    recover = sub.add_parser("recover-stale")
    recover.add_argument("task_dir")
    recover.add_argument("--node-id", required=True)
    recover.add_argument("--older-than-seconds", type=int)
    recover.set_defaults(func=recover_stale)

    record = sub.add_parser("record-handoff")
    record.add_argument("task_dir")
    record.add_argument("--node-id", required=True)
    record.add_argument("--file", required=True)
    record.set_defaults(func=record_handoff)

    summary = sub.add_parser("record-summary")
    summary.add_argument("task_dir")
    summary.add_argument("--file", required=True)
    summary.set_defaults(func=record_summary)

    domain_evaluation = sub.add_parser("record-domain-evaluation")
    domain_evaluation.add_argument("task_dir")
    domain_evaluation.add_argument("--file", required=True)
    domain_evaluation.set_defaults(func=record_domain_evaluation)

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
