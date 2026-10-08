"""Configuration for cross-agent calls.

Resolution order (later wins): built-in defaults < config file < env vars.
Config file: $AGENT_CALL_CONFIG or ~/.config/agent-call/config.json.
Env overrides: AGENT_CALL_REVIEW_MODEL, AGENT_CALL_FALLBACK_MODELS (comma-separated),
AGENT_CALL_TIMEOUT_SECONDS.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULTS: dict = {
    # Default cross-review brain: IDE kimi-k3 at max reasoning (2026-09-03 user decision).
    "review_model": "catpaw-ide/kimi-k3:max",
    # Collision-avoidance candidates, in priority order (gpt-luna first per user decision).
    "fallback_models": [
        "catpaw-ide/gpt-6-luna:xhigh",
        "catpaw-ide/glm-5.3:max",
        "catpaw-ide/deepseek-v4-pro:max",
        "mccodex/gpt-5.4:xhigh",
        "catpaw-ide/gpt-5.6-terra:max",
    ],
    "timeout_seconds": 120,
}

_ENV_MAP = {
    "review_model": "AGENT_CALL_REVIEW_MODEL",
    "timeout_seconds": "AGENT_CALL_TIMEOUT_SECONDS",
}


def config_path() -> Path:
    override = os.environ.get("AGENT_CALL_CONFIG")
    if override:
        return Path(override)
    return Path.home() / ".config" / "agent-call" / "config.json"


def load_config(path: Path | None = None) -> dict:
    cfg = dict(DEFAULTS)
    p = path or config_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    if isinstance(data, dict):
        for key in DEFAULTS:
            if key in data and data[key] is not None:
                cfg[key] = data[key]
    for key, env_name in _ENV_MAP.items():
        raw = os.environ.get(env_name)
        if raw:
            cfg[key] = int(raw) if key == "timeout_seconds" else raw
    fallback_env = os.environ.get("AGENT_CALL_FALLBACK_MODELS")
    if fallback_env:
        cfg["fallback_models"] = [m.strip() for m in fallback_env.split(",") if m.strip()]
    if not isinstance(cfg.get("fallback_models"), list):
        cfg["fallback_models"] = list(DEFAULTS["fallback_models"])
    return cfg


def base_model_id(model: str) -> str:
    """Normalize 'provider/id:tag' → 'id' for collision comparison.

    Cross-review means a different brain; 'mccodex/kimi-k3' and
    'catpaw-ide/kimi-k3:max' are the same brain behind different bridges.
    """
    return model.strip().split("/")[-1].split(":")[0].lower()


def select_review_model(caller_model: str | None, cfg: dict) -> tuple[str, str | None]:
    """Pick the review model, avoiding collision with the caller's own model.

    Returns (model, note). note is None when the configured default is used,
    else a human-readable reason for the swap. Raises ModelConfigError when no
    non-colliding candidate exists — never silently downgrades off-list.
    """
    from tools.agent_call.errors import ModelConfigError

    review = str(cfg["review_model"])
    if not caller_model or base_model_id(caller_model) != base_model_id(review):
        return review, None
    caller_base = base_model_id(caller_model)
    for candidate in cfg["fallback_models"]:
        if base_model_id(candidate) != caller_base:
            return candidate, (
                f"review model {review} collides with caller model; "
                f"fell back to {candidate} per fallback_models priority"
            )
    raise ModelConfigError(
        f"review model {review} collides with caller model and every "
        "fallback_models entry shares the same base id; configure a distinct fallback"
    )
