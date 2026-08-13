import pytest

from fake_hub import FakeHub


@pytest.fixture(autouse=True)
def _isolated_auth_env(tmp_path_factory, monkeypatch):
    """Keep every test away from the developer's real auth state: the collector config,
    the grant token cache (both under XDG_CONFIG_HOME), and the AGENT_SESSIONS_* env vars.
    Without this, a cached `agent-sessions auth` token on the dev box would silently win
    load_config()'s precedence and flip tests into grant mode."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path_factory.mktemp("xdg-config")))
    for var in (
        "AGENT_SESSIONS_GRANT_TOKEN",
        "AGENT_SESSIONS_HUB_URL",
        "AGENT_SESSIONS_CLIENT_CERT",
        "AGENT_SESSIONS_CLIENT_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def hub():
    h = FakeHub().start()
    try:
        yield h
    finally:
        h.stop()


def make_session_row(
    session_id: str,
    *,
    harness: str = "claude-code",
    machine_id: str = "amet-wsl",
    started_at: str = "2026-07-18T01:00:00.000Z",
    ended_at: str | None = "2026-07-18T01:10:00.000Z",
    block_count: int = 10,
    turn_count: int = 5,
    primary_model: str | None = "claude-sonnet-5",
    **overrides,
) -> dict:
    """A `sessions` row shaped like GET /api/v1/sessions actually returns (verified against
    the production hub — see docs/agents-api.md)."""
    row = {
        "session_id": session_id,
        "harness": harness,
        "machine_id": machine_id,
        "os": "wsl",
        "canonical_file_id": 1,
        "cwd": "/home/pedro/src/example",
        "repo_url": None,
        "git_branch": "main",
        "models": f'["{primary_model}"]' if primary_model else "[]",
        "primary_model": primary_model,
        "title": None,
        "started_at": started_at,
        "ended_at": ended_at,
        "parent_session_id": None,
        "parent_tool_use_id": None,
        "is_sidechain": 0,
        "turn_count": turn_count,
        "block_count": block_count,
        "tokens_in": 100,
        "tokens_out": 200,
        "tokens_reasoning": 0,
        "tokens_cached": 0,
        "index_state": "ready",
        "updated_at": ended_at,
    }
    row.update(overrides)
    return row
