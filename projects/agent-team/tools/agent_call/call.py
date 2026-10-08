"""Single entry point for cross-agent calls: agent_call(host, model, task, context, timeout).

All cross-host logic lives here (see docs/cross-agent-l2-plan.md); the
repository launcher and installed console script only invoke this module.

Usage as CLI (used by the shells):
    agent-call --host pi --model catpaw-ide/kimi-k3:max \
        --task "review dimension" --context-file diff.patch
    agent-call review --caller-model gpt-5.6-sol \
        --task "..." --context-file diff.patch

Output on stdout: one JSON object {receipt, meta} on success, or
{"error": {kind, message, detail}} on classified failure. Exit code is 0 on
success, non-zero otherwise (kind → 2 unavailable, 3 timeout, 4 protocol,
5 model_error, 6 cancelled).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from tools.agent_call.config import load_config, select_review_model
from tools.agent_call.errors import AgentCallError, CallCancelled, HostUnavailable, ProtocolError

_EXIT_CODES = {
    "unavailable": 2,
    "timeout": 3,
    "protocol": 4,
    "model_error": 5,
    "cancelled": 6,
}


def _backend(host: str):
    if host == "pi":
        from tools.agent_call.hosts.pi import PiBackend

        return PiBackend()
    raise HostUnavailable(f"host {host!r} has no backend yet (P1 ships pi only)")


def agent_call(
    *,
    host: str,
    model: str,
    task: str,
    context: str = "",
    timeout: int | None = None,
    caller_model: str | None = None,
    review: bool = False,
) -> dict:
    """Call another agent host and return {receipt, meta}. Raises AgentCallError."""
    cfg = load_config()
    timeout = timeout or int(cfg["timeout_seconds"])
    note = None
    if review:
        model, note = select_review_model(caller_model, cfg)
    result = _backend(host).call(model=model, task=task, context=context, timeout=timeout)
    if note:
        result["meta"]["model_note"] = note
    return result


def _read_context(args: argparse.Namespace) -> str:
    if args.context_file:
        try:
            return Path(args.context_file).read_text(encoding="utf-8")
        except OSError as exc:
            raise ProtocolError(
                f"unable to read context file: {args.context_file}",
                detail=str(exc),
            ) from exc
    if args.context is not None:
        return args.context
    return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-call")
    parser.add_argument(
        "mode",
        nargs="?",
        choices=["call", "review"],
        default="call",
        help="review applies the configurable review-model selection rules",
    )
    parser.add_argument("--host", default="pi")
    parser.add_argument("--model", default=None)
    parser.add_argument("--caller-model", default=None)
    parser.add_argument("--task", required=True)
    parser.add_argument("--context", default=None)
    parser.add_argument("--context-file", default=None)
    parser.add_argument("--timeout", type=int, default=None)
    args = parser.parse_args(argv)

    review = args.mode == "review"
    model = args.model
    if not model:
        model = str(load_config()["review_model"]) if review else None
    if not model:
        parser.error("--model is required for mode=call")

    try:
        result = agent_call(
            host=args.host,
            model=model,
            task=args.task,
            context=_read_context(args),
            timeout=args.timeout,
            caller_model=args.caller_model,
            review=review,
        )
    except AgentCallError as exc:
        print(json.dumps({"error": exc.to_dict()}, ensure_ascii=False))
        return _EXIT_CODES.get(exc.kind, 1)
    except KeyboardInterrupt as exc:
        # Keep cancellation machine-readable when the caller presses Ctrl-C. A
        # cancelled call has no receipt, so use the same error envelope as all
        # backend failures and let the caller decide whether to continue.
        cancelled = CallCancelled("agent-call cancelled by caller")
        print(json.dumps({"error": cancelled.to_dict()}, ensure_ascii=False))
        return _EXIT_CODES[cancelled.kind]

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
