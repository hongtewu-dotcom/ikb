"""Failure classification for cross-agent calls.

Every backend failure maps to one of these; callers decide degradation
from the class, never by parsing stderr text.
"""

from __future__ import annotations


class AgentCallError(Exception):
    """Base class; `kind` is the stable machine-readable failure class."""

    kind = "error"

    def __init__(self, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.detail = detail

    def to_dict(self) -> dict:
        return {"kind": self.kind, "message": str(self), "detail": self.detail}


class HostUnavailable(AgentCallError):
    """CLI missing, bridge down, or backend not implemented for the host."""

    kind = "unavailable"


class CallTimeout(AgentCallError):
    """Callee exceeded the configured timeout."""

    kind = "timeout"


class CallCancelled(AgentCallError):
    """The caller cancelled an in-flight agent call."""

    kind = "cancelled"


class ProtocolError(AgentCallError):
    """Callee ran but its output could not be interpreted."""

    kind = "protocol"


class ModelError(AgentCallError):
    """The model/provider reported an error (auth, quota, bad model id)."""

    kind = "model_error"


class ModelConfigError(AgentCallError):
    """No usable model after applying selection rules (never silently downgrade)."""

    kind = "model_error"
