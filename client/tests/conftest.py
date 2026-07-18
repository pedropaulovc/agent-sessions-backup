import pytest

from fake_hub import FakeHub


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
