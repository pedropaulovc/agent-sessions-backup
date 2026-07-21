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


def test_list_sessions_follows_cursor_across_pages(hub):
    # Ask for a page size (5) smaller than the total (12) so the fake hub's keyset pagination
    # must hand back a `cursor`, and list_sessions() must keep re-requesting with it rather
    # than returning just the first page. All rows share the same started_at, so the fake
    # hub's tiebreak sorts them by session_id ascending (s00, s01, ...) — same as the real
    # hub's `ORDER BY started_at DESC, session_id ASC`.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(12)]
    page = api_for(hub).list_sessions(limit=5)
    assert len(page.sessions) == 12
    assert [s.session_id for s in page.sessions] == [f"s{i:02d}" for i in range(12)]
    # 12 rows at 5/page: 5 + 5 + 2 = 3 requests, the first two's last row seeding the next
    # request's cursor.
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 3
    assert "cursor" not in session_requests[0]["params"]
    assert session_requests[1]["params"]["cursor"] == ["s04"]
    assert session_requests[2]["params"]["cursor"] == ["s09"]


def test_list_sessions_stops_when_response_has_no_cursor(hub):
    hub.sessions = [make_session_row(f"s{i}") for i in range(5)]
    api_for(hub).list_sessions(limit=5)
    # Exactly 5 rows at limit=5 with nothing left over -> one request, no cursor follow-up.
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 1


def test_list_sessions_past_server_cap_still_returns_everything(hub):
    # The hub silently clamps limit at MAX_SESSIONS_LIMIT (1000) server-side, so a caller
    # asking for more than that still only gets MAX_SESSIONS_LIMIT rows per request — but
    # cursor-following means the total returned is still complete, not capped.
    total = MAX_SESSIONS_LIMIT + 50
    hub.sessions = [make_session_row(f"s{i:04d}") for i in range(total)]
    page = api_for(hub).list_sessions(limit=5000)
    assert len(page.sessions) == total


def test_list_sessions_keeps_stalest_indexed_through_across_pages(hub):
    # A machine finishing its sync WHILE a multi-page call is in flight must not make the
    # final indexed_through look fresher than page 1 saw — keyset paging never revisits rows
    # inserted ahead of an already-consumed cursor boundary, so a later page's fresher value
    # would silently mask an undercount. The result must carry the EARLIEST value seen.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(8)]
    hub.indexed_through_by_request = ["2026-07-18T01:00:00.000Z", "2026-07-18T23:59:59.999Z"]
    page = api_for(hub).list_sessions(limit=5)
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 2  # sanity: this test only means something with >1 page
    assert page.indexed_through == "2026-07-18T01:00:00.000Z"


def test_list_sessions_none_indexed_through_on_any_page_wins(hub):
    # None ("never synced") from ANY page must dominate the result, even a later, fresher one.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(8)]
    hub.indexed_through_by_request = [None, "2026-07-18T23:59:59.999Z"]
    page = api_for(hub).list_sessions(limit=5)
    assert page.indexed_through is None


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


def test_iter_sessions_ndjson_follows_trailer_cursor_across_requests(hub):
    # The fake hub's default per-request ndjson cap is 10 (see FakeHub.__init__) — 25 rows
    # forces the hub to emit a trailer {"cursor": ...} line twice before naturally exhausting,
    # and iter_sessions_ndjson() must detect each one and transparently keep streaming.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(25)]
    hub.normalized = {f"s{i:02d}": {"turns": [i]} for i in range(25)}
    api = api_for(hub)
    records = list(api.iter_sessions_ndjson())
    assert [r.meta.session_id for r in records] == [f"s{i:02d}" for i in range(25)]
    assert [r.session for r in records] == [{"turns": [i]} for i in range(25)]
    # 25 rows at 10/request: 10 + 10 + 5 = 3 requests, the first two ending in a trailer.
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 3
    assert "cursor" not in session_requests[0]["params"]
    assert session_requests[1]["params"]["cursor"] == ["s09"]
    assert session_requests[2]["params"]["cursor"] == ["s19"]


def test_iter_sessions_ndjson_keeps_stalest_indexed_through_across_requests(hub):
    # Same keyset-pagination hazard as list_sessions() — a fresher header on a later request
    # must not overwrite a stale one seen earlier in the stream.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(15)]
    hub.indexed_through_by_request = ["2026-07-18T01:00:00.000Z", "2026-07-18T23:59:59.999Z"]
    api = api_for(hub)
    list(api.iter_sessions_ndjson())  # drain the generator
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 2  # sanity: 15 rows at the default 10/request cap
    assert api.last_indexed_through == "2026-07-18T01:00:00.000Z"


def test_iter_sessions_ndjson_no_trailer_when_exactly_at_cap(hub):
    # Exactly `ndjson_max_rows_per_request` rows and nothing left over must NOT emit a
    # trailer (the hub's "short page -> exhausted" check) — otherwise the client would issue
    # one pointless extra request that comes back empty.
    hub.sessions = [make_session_row(f"s{i:02d}") for i in range(10)]
    api = api_for(hub)
    records = list(api.iter_sessions_ndjson())
    assert len(records) == 10
    session_requests = [r for r in hub.requests if r["path"] == "/api/v1/sessions"]
    assert len(session_requests) == 1


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
    result = api_for(hub).search("hello")
    assert len(result.hits) == 1
    assert result.hits[0].snippet == "<mark>hello</mark>"
    request = hub.requests[-1]
    assert request["path"] == "/api/v1/search"
    assert request["params"]["limit"] == ["100"]


def test_search_preserves_explicit_lower_limit(hub):
    api_for(hub).search("hello", limit=10)
    assert hub.requests[-1]["params"]["limit"] == ["10"]


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
