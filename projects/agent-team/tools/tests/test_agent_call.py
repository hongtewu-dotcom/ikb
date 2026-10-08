"""Unit tests for the cross-agent call core (tools/agent_call).

CLI invocations are mocked; a real end-to-end pi call is verified manually
against a live bridge, not in CI.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from unittest import mock
from pathlib import Path

import pytest

from tools.agent_call import call as agent_call_mod
from tools.agent_call.config import (
    DEFAULTS,
    base_model_id,
    load_config,
    select_review_model,
)
from tools.agent_call.errors import (
    CallCancelled,
    CallTimeout,
    HostUnavailable,
    ModelConfigError,
    ModelError,
    ProtocolError,
)
from tools.agent_call.hosts.pi import PiBackend


# ── model selection rules ──────────────────────────────────────────────────


def test_base_model_id_normalizes_provider_and_tag():
    assert base_model_id("catpaw-ide/kimi-k3:max") == "kimi-k3"
    assert base_model_id("mccodex/kimi-k3") == "kimi-k3"
    assert base_model_id("gpt-5.6-luna") == "gpt-5.6-luna"


def test_default_review_model_used_when_no_collision():
    model, note = select_review_model("gpt-5.6-sol", dict(DEFAULTS))
    assert model == "catpaw-ide/kimi-k3:max"
    assert note is None


def test_no_caller_model_uses_default():
    model, note = select_review_model(None, dict(DEFAULTS))
    assert model == "catpaw-ide/kimi-k3:max"
    assert note is None


def test_collision_falls_back_to_gpt_luna_first():
    model, note = select_review_model("catpaw-ide/kimi-k3:max", dict(DEFAULTS))
    assert model == "catpaw-ide/gpt-6-luna:xhigh"
    assert note and "collides" in note


def test_collision_across_bridges_same_brain():
    # mccodex/kimi-k3 and catpaw-ide/kimi-k3:max are the same brain.
    model, _ = select_review_model("mccodex/kimi-k3", dict(DEFAULTS))
    assert base_model_id(model) != "kimi-k3"


def test_fallback_skips_candidates_sharing_caller_base():
    cfg = dict(DEFAULTS)
    cfg["review_model"] = "catpaw-ide/gpt-5.6-luna:max"
    cfg["fallback_models"] = ["mccodex/gpt-5.6-luna", "catpaw-ide/glm-5.3:max"]
    model, note = select_review_model("catpaw-ide/gpt-5.6-luna:max", cfg)
    assert model == "catpaw-ide/glm-5.3:max"
    assert note


def test_no_usable_candidate_raises_never_silent_downgrade():
    cfg = dict(DEFAULTS)
    cfg["review_model"] = "catpaw-ide/kimi-k3:max"
    cfg["fallback_models"] = ["mccodex/kimi-k3"]
    with pytest.raises(ModelConfigError):
        select_review_model("mccodex/kimi-k3", cfg)


def test_load_config_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_CALL_CONFIG", str(tmp_path / "missing.json"))
    monkeypatch.setenv("AGENT_CALL_REVIEW_MODEL", "mccodex/glm-5.3")
    monkeypatch.setenv("AGENT_CALL_FALLBACK_MODELS", "a/one:max, b/two")
    monkeypatch.setenv("AGENT_CALL_TIMEOUT_SECONDS", "30")
    cfg = load_config()
    assert cfg["review_model"] == "mccodex/glm-5.3"
    assert cfg["fallback_models"] == ["a/one:max", "b/two"]
    assert cfg["timeout_seconds"] == 30


# ── pi backend parsing ───────────────────────────────────────────────────────


def _pi_events(text: str, model: str = "kimi-k3") -> str:
    event = {
        "type": "turn_end",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "provider": "mccodex",
            "model": model,
            "usage": {"totalTokens": 10},
            "responseId": "resp-1",
        },
    }
    return json.dumps(event) + "\n" + json.dumps({"type": "agent_settled"}) + "\n"


def _run_backend(stdout: str, returncode: int = 0, stderr: str = "") -> dict:
    backend = PiBackend(pi_bin="pi")
    proc = mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)
    with mock.patch("shutil.which", return_value="/usr/bin/pi"), mock.patch(
        "subprocess.run", return_value=proc
    ) as run:
        result = backend.call(model="mccodex/kimi-k3", task="t", context="c", timeout=10)
    cmd = run.call_args[0][0]
    assert "--no-tools" in cmd and "--no-session" in cmd
    return result


def test_pi_backend_parses_structured_receipt():
    receipt = {
        "status": "completed",
        "summary": "no blocking findings",
        "evidence": ["a.py:12"],
        "changes": [],
        "validation": ["read diff"],
        "gaps": [],
    }
    result = _run_backend(_pi_events(json.dumps(receipt)))
    assert result["receipt"] == receipt
    assert result["meta"]["structured"] is True
    assert result["meta"]["host"] == "pi"
    assert result["meta"]["model"] == "mccodex/kimi-k3"
    assert result["meta"]["response_id"] == "resp-1"
    assert isinstance(result["meta"]["latency_ms"], int)


def test_pi_backend_wraps_unstructured_text_as_partial():
    result = _run_backend(_pi_events("looks fine to me"))
    assert result["receipt"]["status"] == "partial"
    assert result["receipt"]["summary"] == "looks fine to me"
    assert result["receipt"]["changes"] == []
    assert result["receipt"]["gaps"]
    assert result["meta"]["structured"] is False


def test_pi_backend_strips_ansi_and_ignores_thinking_blocks():
    receipt = {"status": "completed", "summary": "ok", "evidence": [], "changes": [],
               "validation": [], "gaps": []}
    event = {
        "type": "turn_end",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "\x1b[38;2;1;2;3mnoise\x1b[39m"},
                {"type": "text", "text": json.dumps(receipt)},
            ],
        },
    }
    result = _run_backend(json.dumps(event) + "\n")
    assert result["receipt"]["status"] == "completed"


def test_pi_backend_forces_changes_empty_for_read_only_callee():
    receipt = {"status": "completed", "summary": "ok", "evidence": [],
               "changes": ["x.py"], "validation": [], "gaps": []}
    result = _run_backend(_pi_events(json.dumps(receipt)))
    assert result["receipt"]["changes"] == []
    assert any("read-only" in g for g in result["receipt"]["gaps"])


def test_pi_backend_missing_cli_is_unavailable():
    with mock.patch("shutil.which", return_value=None):
        with pytest.raises(HostUnavailable):
            PiBackend().call(model="m", task="t", context="", timeout=1)


def test_pi_backend_bridge_refused_is_unavailable_not_model_error():
    proc = mock.Mock(returncode=1, stdout="", stderr="fetch failed: ECONNREFUSED 127.0.0.1:7878")
    with mock.patch("shutil.which", return_value="/usr/bin/pi"), mock.patch(
        "subprocess.run", return_value=proc
    ):
        with pytest.raises(HostUnavailable):
            PiBackend().call(model="mccodex/kimi-k3", task="t", context="", timeout=1)


def test_pi_backend_nonzero_exit_is_model_error():
    proc = mock.Mock(returncode=1, stdout="", stderr="invalid model id")
    with mock.patch("shutil.which", return_value="/usr/bin/pi"), mock.patch(
        "subprocess.run", return_value=proc
    ):
        with pytest.raises(ModelError):
            PiBackend().call(model="bad/model", task="t", context="", timeout=1)


def test_pi_backend_unparseable_stream_is_protocol_error():
    with mock.patch("shutil.which", return_value="/usr/bin/pi"), mock.patch(
        "subprocess.run", return_value=mock.Mock(returncode=0, stdout="not json\n", stderr="")
    ):
        with pytest.raises(ProtocolError):
            PiBackend().call(model="m", task="t", context="", timeout=1)


def test_pi_backend_keyboard_interrupt_is_cancelled():
    with mock.patch("shutil.which", return_value="/usr/bin/pi"), mock.patch(
        "subprocess.run", side_effect=KeyboardInterrupt
    ):
        with pytest.raises(CallCancelled) as error:
            PiBackend().call(model="m", task="t", context="", timeout=1)
    assert error.value.kind == "cancelled"


# ── entry point + CLI ────────────────────────────────────────────────────────


def _fake_backend_ok(captured: dict | None = None):
    class FakeBackend:
        def call(self, *, model, task, context, timeout):
            if captured is not None:
                captured["model"] = model
            return {
                "receipt": {"status": "completed", "summary": "s", "evidence": [],
                            "changes": [], "validation": [], "gaps": []},
                "meta": {"host": "pi", "model": model},
            }

    return FakeBackend()


def test_agent_call_review_applies_selection(monkeypatch):
    captured: dict = {}
    monkeypatch.setattr(agent_call_mod, "_backend", lambda host: _fake_backend_ok(captured))
    result = agent_call_mod.agent_call(
        host="pi", model="catpaw-ide/kimi-k3:max", task="t",
        caller_model="catpaw-ide/kimi-k3:max", review=True,
    )
    assert captured["model"] == "catpaw-ide/gpt-6-luna:xhigh"
    assert "model_note" in result["meta"]


def test_agent_call_unknown_host_is_unavailable():
    with pytest.raises(HostUnavailable):
        agent_call_mod.agent_call(host="magent", model="m", task="t")


def test_cli_error_exit_codes_and_error_envelope(capsys):
    rc = agent_call_mod.main(["call", "--host", "magent", "--model", "m", "--task", "t"])
    assert rc == 2
    out = json.loads(capsys.readouterr().out)
    assert out["error"]["kind"] == "unavailable"


def test_cli_review_mode_uses_config_default_model(capsys, monkeypatch):
    monkeypatch.setattr(agent_call_mod, "_backend", lambda host: _fake_backend_ok())
    rc = agent_call_mod.main(["review", "--caller-model", "gpt-5.6-sol", "--task", "t"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["meta"]["model"] == "catpaw-ide/kimi-k3:max"


def test_cli_timeout_keeps_classified_error_envelope(capsys, monkeypatch):
    def raise_timeout(**_kwargs):
        raise CallTimeout("pi call exceeded 1s", detail="model=m")

    monkeypatch.setattr(agent_call_mod, "agent_call", raise_timeout)
    rc = agent_call_mod.main(["call", "--model", "m", "--task", "t"])
    assert rc == 3
    out = json.loads(capsys.readouterr().out)
    assert out["error"] == {
        "kind": "timeout",
        "message": "pi call exceeded 1s",
        "detail": "model=m",
    }


def test_cli_keyboard_interrupt_is_classified_as_cancelled(capsys, monkeypatch):
    def raise_interrupt(**_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(agent_call_mod, "agent_call", raise_interrupt)
    rc = agent_call_mod.main(["call", "--model", "m", "--task", "t"])
    assert rc == 6
    out = json.loads(capsys.readouterr().out)
    assert out["error"]["kind"] == "cancelled"


def test_cli_missing_context_file_is_protocol_error(capsys):
    rc = agent_call_mod.main(
        ["call", "--model", "m", "--task", "t", "--context-file", "/no/such/snapshot"]
    )
    assert rc == 4
    out = json.loads(capsys.readouterr().out)
    assert out["error"]["kind"] == "protocol"


def test_repository_launcher_preserves_cli_contract():
    root = Path(__file__).parents[2]
    result = subprocess.run(
        [str(root / "bin" / "agent-call"), "call", "--host", "magent", "--model", "m", "--task", "t"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert json.loads(result.stdout)["error"]["kind"] == "unavailable"


def test_install_script_links_launcher_into_requested_directory(tmp_path):
    root = Path(__file__).parents[2]
    bin_dir = tmp_path / "bin"
    env = os.environ.copy()
    env["AGENT_CALL_BIN_DIR"] = str(bin_dir)
    result = subprocess.run(
        [str(root / "scripts" / "install-agent-call")],
        cwd=root,
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    installed = bin_dir / "agent-call"
    assert installed.is_symlink()
    assert installed.resolve() == (root / "bin" / "agent-call").resolve()


@pytest.mark.parametrize("cancel", [False, True], ids=["timeout", "sigint"])
def test_cli_reaps_actual_child_on_timeout_or_cancel(tmp_path, cancel):
    root = Path(__file__).parents[2]
    marker = tmp_path / "child.pid"
    fake_pi = tmp_path / "pi"
    fake_pi.write_text(
        f"#!{sys.executable}\nimport os, time\n"
        f"with open({str(marker)!r}, 'w') as f: f.write(str(os.getpid()))\n"
        "time.sleep(60)\n"
    )
    fake_pi.chmod(0o755)
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    proc = subprocess.Popen(
        [str(root / "bin/agent-call"), "call", "--host", "pi", "--model", "fixture",
         "--timeout", "20" if cancel else "1", "--task", "fixture"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    child_pid = None
    try:
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert marker.exists(), "callee did not start"
        child_pid = int(marker.read_text())
        if cancel:
            proc.send_signal(signal.SIGINT)
        stdout, stderr = proc.communicate(timeout=5)
        assert proc.returncode == (6 if cancel else 3), stderr
        assert json.loads(stdout)["error"]["kind"] == ("cancelled" if cancel else "timeout")
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if child_pid:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
