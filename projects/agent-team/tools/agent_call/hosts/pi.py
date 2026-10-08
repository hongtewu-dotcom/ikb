"""Pi coding-agent backend.

Invokes `pi -p --mode json --no-session --no-tools --model <model> <prompt>`
and folds the NDJSON event stream into the six-field result receipt
(plugins/agent-teams/adapters/pi/policies/result-receipt.schema.json).

The callee is always read-only: --no-tools plus a frozen snapshot inlined
into the prompt. It never touches the caller's repository.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time

from tools.agent_call.errors import (
    CallCancelled,
    CallTimeout,
    HostUnavailable,
    ModelError,
    ProtocolError,
)

RECEIPT_FIELDS = ("status", "summary", "evidence", "changes", "validation", "gaps")
_RECEIPT_STATUSES = ("completed", "partial", "blocked")

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

_PROMPT_TEMPLATE = """\
You are a read-only cross-review agent running inside a frozen snapshot.
Respond with ONLY a JSON object — no markdown fences, no prose around it —
with exactly these keys:

- "status": "completed" | "partial" | "blocked"   (execution outcome)
- "summary": string                                (concise findings; no raw tool output)
- "evidence": [string, ...]                        (exact references: path:line, hash, id)
- "changes": []                                    (you are read-only; always empty)
- "validation": [string, ...]                      (checks you actually performed)
- "gaps": [string, ...]                            (assigned scope you could not cover)

Task:
{task}

Context (frozen snapshot supplied by the caller; do not request more):
{context}
"""


def _extract_json_object(text: str) -> dict | None:
    """Return the first balanced top-level JSON object in `text`, or None."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
                return obj if isinstance(obj, dict) else None
    return None


def _normalize_receipt(obj: dict) -> dict | None:
    """Coerce a parsed object into the six-field receipt, or None if unusable."""
    receipt: dict = {}
    status = obj.get("status")
    if status not in _RECEIPT_STATUSES:
        return None
    receipt["status"] = status
    summary = obj.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        return None
    receipt["summary"] = summary.strip()
    for key in ("evidence", "changes", "validation", "gaps"):
        value = obj.get(key, [])
        if not isinstance(value, list):
            value = [str(value)]
        receipt[key] = [str(item) for item in value]
    if receipt["changes"]:
        # Contract says read-only callees report no changes; keep the receipt
        # honest rather than trusting the model.
        receipt["gaps"].append("callee reported changes despite read-only contract; ignored")
        receipt["changes"] = []
    return receipt


def _assistant_text(events: list[dict]) -> tuple[str, dict]:
    """Pull final assistant text plus usage meta from pi NDJSON events."""
    for event in reversed(events):
        if event.get("type") not in ("turn_end", "agent_end"):
            continue
        messages = []
        if event.get("type") == "turn_end" and isinstance(event.get("message"), dict):
            messages = [event["message"]]
        elif isinstance(event.get("messages"), list):
            messages = event["messages"]
        for message in reversed(messages):
            if message.get("role") != "assistant":
                continue
            texts = [
                _ANSI_RE.sub("", block.get("text", ""))
                for block in message.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            ]
            text = "\n".join(t for t in texts if t).strip()
            if text:
                meta = {
                    "usage": message.get("usage"),
                    "response_id": message.get("responseId"),
                    "provider": message.get("provider"),
                    "callee_model": message.get("model"),
                }
                return text, meta
    return "", {}


class PiBackend:
    host = "pi"

    def __init__(self, pi_bin: str = "pi") -> None:
        self.pi_bin = pi_bin

    def call(self, *, model: str, task: str, context: str, timeout: int) -> dict:
        if shutil.which(self.pi_bin) is None:
            raise HostUnavailable(f"pi CLI not found on PATH ({self.pi_bin!r})")
        prompt = _PROMPT_TEMPLATE.format(task=task.strip(), context=context.strip() or "(none)")
        cmd = [
            self.pi_bin,
            "-p",
            "--mode",
            "json",
            "--no-session",
            "--no-tools",
            "--model",
            model,
            prompt,
        ]
        started = time.monotonic()
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise CallTimeout(
                f"pi call exceeded {timeout}s",
                detail=f"model={model}",
            ) from exc
        except KeyboardInterrupt as exc:
            raise CallCancelled(
                "pi call cancelled by caller",
                detail=f"model={model}",
            ) from exc
        latency_ms = int((time.monotonic() - started) * 1000)

        if proc.returncode != 0:
            stderr = (proc.stderr or "").strip()
            lowered = stderr.lower()
            if any(
                marker in lowered
                for marker in ("econnrefused", "connection refused", "fetch failed", "econnreset", "socket hang up")
            ):
                raise HostUnavailable(
                    "pi model bridge unreachable",
                    detail=stderr[:500],
                )
            raise ModelError(
                f"pi exited with code {proc.returncode}",
                detail=stderr[:500],
            )

        events: list[dict] = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        if not events:
            raise ProtocolError(
                "pi produced no parseable JSON events",
                detail=proc.stdout[:500],
            )

        text, meta = _assistant_text(events)
        if not text:
            raise ProtocolError(
                "pi event stream contained no assistant text",
                detail=f"{len(events)} events parsed",
            )

        structured = _extract_json_object(text)
        receipt = _normalize_receipt(structured) if structured else None
        structured_ok = receipt is not None
        if receipt is None:
            receipt = {
                "status": "partial",
                "summary": text,
                "evidence": [],
                "changes": [],
                "validation": [],
                "gaps": ["callee output was not a structured six-field receipt; raw text wrapped"],
            }

        return {
            "receipt": receipt,
            "meta": {
                "host": self.host,
                "model": model,
                "latency_ms": latency_ms,
                "structured": structured_ok,
                **meta,
            },
        }
