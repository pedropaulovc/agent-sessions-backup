from agent_sessions_client.config import AuthMode, ClientConfig
from agent_sessions_client.endpoints import MAX_SESSIONS_LIMIT, SessionsApi
from agent_sessions_client.http import HubClient
from conftest import make_session_row


def api_for(hub) -> SessionsApi:
    config = ClientConfig(hub_url=hub.url, auth_mode=AuthMode.BEARER, bearer_token="tok", dev_machine="m")
    return SessionsApi(HubClient(config))


def test_list_sessions_parses_rows_and_decodes_models(hub):
    hub.sessions = [make_session_row("s1", primary_model="claude-sonnet-5")]
    hub.indexed_through = "2026-07-18T00:00:00.000Z"
    page = api_for(hub).list_sessions(from_="2026-07-18", to="2026-07-18")
    assert len(page.sessions) == 1
    s = page.sessions[0]
    assert s.session_id == "s1"
    assert s.models == ["claude-sonnet-5"]
    assert s.duration_seconds() == 600.0
    assert page.indexed_through == "2026-07-18T00:00:00.000Z"
    assert page.truncated is False


def test_list_sessions_truncated_heuristic(hub):
    hub.sessions = [make_session_row(f"s{i}") for i in range(5)]
    page = api_for(hub).list_sessions(limit=5)
    assert len(page.sessions) == 5
    assert page.truncated is True


def test_list_sessions_default_limit_matches_hub_cap(hub):
    hub.sessions = []
    api_for(hub).list_sessions()
    assert hub.requests[-1]["params"]["limit"] == [str(MAX_SESSIONS_LIMIT)]


def test_list_sessions_filters_forwarded(hub):
    hub.sessions = []
    api_for(hub).list_sessions(harness="codex", machine="m1", repo="github.com/x/y")
    params = hub.requests[-1]["params"]
    assert params["harness"] == ["codex"]
    assert params["machine"] == ["m1"]
    assert params["repo"] == ["github.com/x/y"]


def test_iter_sessions_ndjson_streams_and_captures_header(hub):
    hub.sessions = [make_session_row("s1"), make_session_row("s2")]
    hub.normalized = {"s1": {"turns": []}, "s2": {"turns": [1]}}
    hub.indexed_through = "2026-07-18T05:00:00.000Z"
    api = api_for(hub)
    records = list(api.iter_sessions_ndjson())
    assert [r.meta.session_id for r in records] == ["s1", "s2"]
    assert records[0].session == {"turns": []}
    assert api.last_indexed_through == "2026-07-18T05:00:00.000Z"


def test_get_session(hub):
    hub.sessions = [make_session_row("s1")]
    hub.normalized = {"s1": {"turns": [1, 2]}}
    meta, session = api_for(hub).get_session("s1")
    assert meta.session_id == "s1"
    assert session == {"turns": [1, 2]}


def test_get_session_raw(hub):
    hub.sessions = [make_session_row("s1")]
    hub.normalized = {"s1": {"turns": [1, 2]}}
    raw = api_for(hub).get_session_raw("s1")
    assert b"turns" in raw


def test_search(hub):
    hub.search_hits = [
        {
            "session_id": "s1",
            "snippet": "<mark>hello</mark>",
            "block": {"turn_index": 0, "block_index": 0, "role": "user", "btype": "text", "tool_name": None, "ts": None},
            "session": {"harness": "claude-code"},
        }
    ]
    result = api_for(hub).search("hello", limit=10)
    assert len(result.hits) == 1
    assert result.hits[0].snippet == "<mark>hello</mark>"


def test_usage_group_by_model(hub):
    hub.usage_rows = [
        {
            "bucket": "claude-sonnet-5",
            "calls": 10,
            "input_tokens": 100,
            "output_tokens": 200,
            "reasoning_tokens": 0,
            "cache_read_tokens": 50,
            "cache_creation_5m_tokens": 5,
            "cache_creation_1h_tokens": 0,
        }
    ]
    report = api_for(hub).usage(group_by="model", from_="2026-07-18", to="2026-07-18")
    assert report.group_by == "model"
    assert report.rows[0].total_tokens == 100 + 200 + 0 + 50 + 5 + 0


def test_status_parses_machines_and_summary(hub):
    hub.status_machines = [
        {
            "machine_id": "amet-wsl",
            "os": "wsl",
            "last_seen_at": "2026-07-18T08:00:00.000Z",
            "last_upload_at": "2026-07-18T07:59:00.000Z",
            "files_pending": 0,
            "files_error": 0,
            "files_total": 100,
            "indexed_through": "2026-07-18T08:00:00.000Z",
        }
    ]
    hub.status_sessions = {"total": 5, "ready": 4, "error": 1}
    status = api_for(hub).status()
    assert status.machines[0].machine_id == "amet-wsl"
    assert status.sessions.total == 5
    assert status.sessions.error == 1
