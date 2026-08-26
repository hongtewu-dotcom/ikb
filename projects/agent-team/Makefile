.PHONY: test generate-codex validate-codex generate-pi clean-generated

test:
	uv run pytest -q \
		tools/tests/test_agent_teams_codex.py \
		tools/tests/test_pi_harness.py \
		plugins/agent-teams/adapters/pi/tests/test_pi_adapter.py

generate-codex:
	uv run python tools/generate.py --harness codex --clean
	uv run python tools/generate.py --harness codex --plugin agent-teams

validate-codex: generate-codex
	uv run python tools/validate_generated.py --harness codex --strict

generate-pi:
	uv run python tools/generate.py --harness pi --plugin agent-teams

clean-generated:
	uv run python tools/generate.py --harness codex --clean
	uv run python tools/generate.py --harness pi --clean
