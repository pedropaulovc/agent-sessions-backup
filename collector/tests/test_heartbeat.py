"""Heartbeat queue conservation, request limits, and bounded recovery work."""
from collections import Counter
import json
import sqlite3
from types import SimpleNamespace

import pytest

from agent_collector import run
from agent_collector.state import State


class RecordingTransport:
    def __init__(self, statuses=()):
        self.statuses = iter(statuses)
        self.bodies = []

    def post_json(self, url, body):
        encoded = json.dumps(body).encode("utf-8")
        assert len(encoded) <= 256 * 1024
        self.bodies.append(json.loads(encoded))
        return next(self.statuses, (200, "ok"))


def event(message="same warning", count=1, store="omp"):
    return {"level": "warn", "code": "missing_source", "message": message,
            "count": count, "store": store}


def pending_count(st):
    return st.conn.execute("SELECT coalesce(sum(count), 0) FROM pending_events").fetchone()[0]


def sent_count(transport):
    return sum(e["count"] for body in transport.bodies for e in body["events"])


def test_large_backlog_and_26000_new_events_shrink_with_count_conservation(tmp_path):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport()
    path = tmp_path / "state.db"
    messages = [
        f"missing source: C:/Users/collector/sessions/{i:04d}/" + "a" * 100 + ".jsonl"
        for i in range(3100)
    ]
    expected = Counter(messages[i % len(messages)] for i in range(100_000))
    expected["same warning"] += 52_000
    with State(path) as st:
        st.conn.executemany(
            "INSERT INTO pending_events (level, code, message, count, store, created_at) "
            "VALUES ('warn', 'missing_source', ?, 1, 'omp', '2026-01-01T00:00:00Z')",
            ((messages[i % len(messages)],) for i in range(100_000)),
        )
        st.conn.commit()
        assert run._heartbeat(cfg, st, transport, {}, [event(count=2)] * 26_000)
        assert st.pending_event_count() == 0
        assert len(transport.bodies) <= run.HEARTBEAT_MAX_BATCHES
    with State(path) as st:
        assert st.pending_event_count() == 0
    actual = Counter()
    for body in transport.bodies:
        for item in body["events"]:
            actual[item["message"]] += item["count"]
    assert actual == expected


def test_escaped_unique_events_split_by_encoded_bytes(tmp_path):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport()
    events = [event(f"{i}:" + "\u2028\\\n\"" * 300) for i in range(300)]
    with State(tmp_path / "state.db") as st:
        assert run._heartbeat(cfg, st, transport, {}, events)
        assert st.pending_event_count() == 0
    assert len(transport.bodies) > 1
    assert sent_count(transport) == len(events)


def test_failed_batch_preserves_old_and_current_events_and_escapes_diagnostic(tmp_path, capsys):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport([(413, "\x1b[31mBAD\n" + "x" * 2000)])
    with State(tmp_path / "state.db") as st:
        st.buffer_events([event("old", count=3)])
        assert not run._heartbeat(cfg, st, transport, {}, [event("current", count=5)])
        assert pending_count(st) == 8
        retry = RecordingTransport()
        assert run._heartbeat(cfg, st, retry, {}, [])
        assert sent_count(retry) == 8
        assert st.pending_event_count() == 0
    diagnostic = capsys.readouterr().err
    assert "HTTP 413" in diagnostic
    assert "\\u001b" in diagnostic
    assert "\x1b" not in diagnostic
    assert len(diagnostic) < 800


def test_later_failure_only_acknowledges_successful_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 2)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport([(200, "ok"), (500, "failed")])
    with State(tmp_path / "state.db") as st:
        assert not run._heartbeat(cfg, st, transport, {}, [event(str(i)) for i in range(5)])
        assert st.pending_event_count() == 3
        retry = RecordingTransport()
        assert run._heartbeat(cfg, st, retry, {}, [])
        assert sent_count(retry) == 3


def test_transport_exception_leaves_current_events_durable(tmp_path):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    def fail(*args):
        raise OSError("network unavailable")
    with State(tmp_path / "state.db") as st:
        with pytest.raises(OSError):
            run._heartbeat(cfg, st, SimpleNamespace(post_json=fail), {}, [event()])
        assert st.pending_event_count() == 1


def test_oversized_prefix_does_not_starve_later_events_across_passes(tmp_path, capsys):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    huge = event("x" * (256 * 1024))
    transport = RecordingTransport()
    with State(path) as st:
        st.buffer_events([huge, huge, event("deliver me")])
        assert not run._heartbeat(cfg, st, transport, {}, [])
        assert sent_count(transport) == 1
        assert st.pending_event_count() == 1
        assert pending_count(st) == 2
    with State(path) as st:
        assert not run._heartbeat(cfg, st, transport, {}, [])
        assert sent_count(transport) == 1
        assert pending_count(st) == 2
        assert st.conn.execute("SELECT message FROM pending_events").fetchone()[0] == huge["message"]
    assert "retained" in capsys.readouterr().err


def test_oversized_stats_preserve_events_without_request(tmp_path):
    transport = RecordingTransport()
    with State(tmp_path / "state.db") as st:
        assert not run._heartbeat(SimpleNamespace(hub_url="https://hub.invalid"), st,
                                  transport, {"huge": "x" * (256 * 1024)}, [event()])
        assert st.pending_event_count() == 1
    assert transport.bodies == []


def test_event_page_is_bounded_and_ack_does_not_use_variable_sized_in_clause(tmp_path):
    with State(tmp_path / "state.db") as st:
        st.buffer_events([event(str(i)) for i in range(2000)])
        statements = []
        st.conn.set_trace_callback(statements.append)
        ids, events = st.drain_events(limit=17)
        assert len(events) == 17
        assert st.pending_event_count() == 2000
        st.delete_events(ids)
        assert st.pending_event_count() == 1983
        assert any("LIMIT 17" in sql for sql in statements)
        assert not any(" IN (" in sql for sql in statements)


def event_counts(events):
    totals = Counter()
    for item in events:
        totals[(item["level"], item["code"], item["message"], item.get("store"))] += item["count"]
    return totals


def test_compacted_http_failure_and_restart_conserve_exact_identities(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 2)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    events = [
        event("same path", count=2, store=None),
        event("same path", count=3, store=""),
        event("same path", count=5, store=None),
        dict(event("same path", count=7), level="error"),
        dict(event("same path", count=11), code="other"),
        event("Same path", count=13),
        event("same path", count=17, store=""),
    ]
    expected = event_counts(events)
    failed = RecordingTransport([(200, "ok"), (503, "unavailable")])
    with State(path) as st:
        st.buffer_events(events[:3])
        assert not run._heartbeat(cfg, st, failed, {}, events[3:])
        acknowledged = event_counts(failed.bodies[0]["events"])
        _, remaining = st.drain_events()
        assert acknowledged + event_counts(remaining) == expected
        assert len(failed.bodies) == 2
    retry = RecordingTransport()
    with State(path) as st:
        assert run._heartbeat(cfg, st, retry, {}, [])
        assert st.pending_event_count() == 0
    delivered = event_counts(item for body in retry.bodies for item in body["events"])
    assert acknowledged + delivered == expected


def test_compaction_failure_retains_current_events_before_restart(tmp_path, monkeypatch):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    transport = RecordingTransport()
    original = State.compact_events

    def fail_compaction(self, *args, **kwargs):
        raise OSError("compaction unavailable")

    with State(path) as st:
        st.buffer_events([event(count=3)])
        with monkeypatch.context() as patch:
            patch.setattr(State, "compact_events", fail_compaction)
            with pytest.raises(OSError, match="compaction unavailable"):
                run._heartbeat(cfg, st, transport, {}, [event(count=5)])
        assert State.compact_events is original
        assert pending_count(st) == 8
        assert transport.bodies == []
    with State(path) as st:
        assert pending_count(st) == 8
        assert run._heartbeat(cfg, st, transport, {}, [])
        assert st.pending_event_count() == 0
    assert sent_count(transport) == 8


@pytest.mark.parametrize("cursor_at", ["last_delivered_id", "far_above"])
def test_stale_cursor_requeries_and_delivers_in_same_pass(tmp_path, cursor_at):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    with State(path) as st:
        st.buffer_events([event("previous")])
        ids, _ = st.drain_events()
        st.set_event_cursor(ids[-1] if cursor_at == "last_delivered_id" else 10_000)
        st.delete_events(ids)
    transport = RecordingTransport()
    with State(path) as st:
        st.buffer_events([event("new", count=7)])
        if cursor_at == "last_delivered_id":
            # AUTOINCREMENT: the emptied queue does not reissue the delivered ID.
            assert st.conn.execute("SELECT id FROM pending_events").fetchone()[0] == ids[-1] + 1
        assert run._heartbeat(cfg, st, transport, {}, [])
        assert st.pending_event_count() == 0
    assert event_counts(item for body in transport.bodies for item in body["events"]) == event_counts(
        [event("new", count=7)]
    )


def test_nonzero_cursor_compacts_only_unvisited_window_before_delivery(tmp_path, monkeypatch):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport()
    original = State.compact_events
    calls = []

    def record_compaction(self, after_id=0, limit=100_000):
        calls.append(after_id)
        return original(self, after_id=after_id, limit=limit)

    monkeypatch.setattr(State, "compact_events", record_compaction)
    with State(tmp_path / "state.db") as st:
        st.buffer_events([event("earlier"), event("later", count=2), event("later", count=3)])
        st.set_event_cursor(1)
        assert run._heartbeat(cfg, st, transport, {}, [])
        # The unvisited window above the cursor is compacted and delivered first; reaching its
        # end then wraps to ID 0 once, delivering the row below the cursor in the same pass.
        assert calls[0] == 1
        assert 0 in calls[1:]
        assert st.pending_event_count() == 0
        assert st.event_cursor() == 0
    assert event_counts(transport.bodies[0]["events"]) == event_counts([event("later", count=5)])
    assert event_counts(item for body in transport.bodies for item in body["events"]) == event_counts(
        [event("earlier"), event("later", count=5)]
    )


def test_compacted_window_exhaustion_advances_past_removed_high_water_id(tmp_path, monkeypatch):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport()
    original = State.compact_events
    calls = []

    def small_window(self, after_id=0, limit=100_000):
        calls.append(after_id)
        return original(self, after_id=after_id, limit=min(limit, 3))

    monkeypatch.setattr(State, "compact_events", small_window)
    events = [event("a", count=2), event("b", count=3), event("a", count=5)] * 4
    with State(tmp_path / "state.db") as st:
        assert run._heartbeat(cfg, st, transport, {}, events)
        assert st.pending_event_count() == 0
    assert calls[:4] == [0, 3, 6, 9]
    assert event_counts(item for body in transport.bodies for item in body["events"]) == event_counts(events)
    assert len(transport.bodies) <= run.HEARTBEAT_MAX_BATCHES


def test_page_budget_remains_bounded_with_compaction_and_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    budget = run.HEARTBEAT_MAX_BATCHES
    events = [event(f"path/{i}", count=i + 1) for i in range(2 * budget + 6)]
    passes = []
    with State(path) as st:
        first = RecordingTransport()
        assert run._heartbeat(cfg, st, first, {}, events)
        passes.append(first)
        assert len(first.bodies) == budget
        assert st.pending_event_count() == budget + 6
    # Each scheduled run is a fresh process: the backlog drains across restarts, one bounded
    # request budget per run, without losing or duplicating any event.
    for expected_pending in (6, 0):
        retry = RecordingTransport()
        with State(path) as st:
            assert run._heartbeat(cfg, st, retry, {}, [])
            assert len(retry.bodies) <= budget
            assert st.pending_event_count() == expected_pending
        passes.append(retry)
    assert event_counts(
        item for transport in passes for body in transport.bodies for item in body["events"]
    ) == event_counts(events)


def test_reviewer_stranded_reused_ids_scenario_drains_fully(tmp_path, monkeypatch):
    # Run A drains 16 rows exactly (cursor=16, queue empty). Run B queues 30 rows and sends 8
    # (cursor=24). Then 40 runs each add 10 fresh rows. With reused rowids B's rows landed at
    # IDs 1..30, so 1..16 sat below the cursor forever while fresh rows kept it busy above.
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    budget = run.HEARTBEAT_MAX_BATCHES
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 2)
    passes = []
    produced = [event(f"a/{i}") for i in range(2 * budget)]
    with State(path) as st:
        passes.append(RecordingTransport())
        assert run._heartbeat(cfg, st, passes[-1], {}, produced)
        assert st.pending_event_count() == 0
        assert st.event_cursor() == 2 * budget
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    b_rows = [event(f"b/{i}") for i in range(30)]
    produced += b_rows
    with State(path) as st:
        passes.append(RecordingTransport())
        assert run._heartbeat(cfg, st, passes[-1], {}, b_rows)
        assert min(r[0] for r in st.conn.execute("SELECT id FROM pending_events")) > 2 * budget
    for run_no in range(40):
        fresh = [event(f"fresh/{run_no}/{i}") for i in range(10)]
        produced += fresh
        with State(path) as st:
            passes.append(RecordingTransport())
            assert run._heartbeat(cfg, st, passes[-1], {}, fresh)
    with State(path) as st:
        stranded = st.conn.execute(
            "SELECT COUNT(*) FROM pending_events WHERE message LIKE 'b/%'").fetchone()[0]
        assert stranded == 0
    for _ in range(20):
        with State(path) as st:
            passes.append(RecordingTransport())
            assert run._heartbeat(cfg, st, passes[-1], {}, [])
            if st.pending_event_count() == 0:
                break
    else:
        pytest.fail("queue did not drain once fresh traffic stopped")
    assert event_counts(
        item for t in passes for body in t.bodies for item in body["events"]
    ) == event_counts(produced)


def test_rows_below_cursor_are_revisited_after_reaching_the_end_in_the_same_pass(tmp_path,
                                                                              monkeypatch):
    # Reaching the end on a later batch with budget left wraps to ID 0 once, so a row below the
    # cursor is delivered this run instead of waiting for a later one.
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    transport = RecordingTransport()
    with State(tmp_path / "state.db") as st:
        st.buffer_events([event("below"), event("above/1"), event("above/2")])
        st.set_event_cursor(1)
        assert run._heartbeat(cfg, st, transport, {}, [])
        assert st.pending_event_count() == 0
        assert st.event_cursor() == 0
    assert [body["events"][0]["message"] for body in transport.bodies] == [
        "above/1", "above/2", "below"]


def test_backlog_progresses_every_run_under_sustained_overflow(tmp_path, monkeypatch):
    # Every run adds more rows than its 8 requests can carry. Strict FIFO still sends the oldest
    # rows first each run, so the oldest pending ID always advances and nothing is starved.
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    budget = run.HEARTBEAT_MAX_BATCHES
    backlog = [event(f"old/{i}") for i in range(3)]
    with State(path) as st:
        st.buffer_events(backlog)
    for run_no in range(5):
        with State(path) as st:
            oldest = st.conn.execute("SELECT MIN(id) FROM pending_events").fetchone()[0]
            transport = RecordingTransport()
            fresh = [event(f"run{run_no}/{i}") for i in range(budget + 2)]
            assert run._heartbeat(cfg, st, transport, {}, fresh)
            assert len(transport.bodies) == budget
            assert st.conn.execute("SELECT MIN(id) FROM pending_events").fetchone()[0] == oldest + budget
        if run_no == 0:
            assert [b["events"][0]["message"] for b in transport.bodies[:3]] == [
                "old/0", "old/1", "old/2"]


def test_retained_oversized_row_costs_no_request_and_warns_once_per_pass(tmp_path, capsys):
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    huge = event("x" * (256 * 1024))
    with State(path) as st:
        st.buffer_events([huge])
    for run_no in range(3):
        transport = RecordingTransport()
        with State(path) as st:
            assert not run._heartbeat(cfg, st, transport, {}, [event(f"fresh/{run_no}")])
            assert st.pending_event_count() == 1
        # One request carrying the deliverable event; no trailing empty POST for the wrap
        # that revisits the retained row.
        assert [body["events"] for body in transport.bodies] == [[event(f"fresh/{run_no}")]]
        assert capsys.readouterr().err.count("exceeds payload budget; retained") == 1
    # With only the retained row queued, the heartbeat still proves liveness with one request.
    transport = RecordingTransport()
    with State(path) as st:
        assert not run._heartbeat(cfg, st, transport, {}, [])
    assert [body["events"] for body in transport.bodies] == [[]]


def test_legacy_stranded_rows_drain_after_migration_under_sustained_traffic(tmp_path, monkeypatch):
    # A legacy plain-rowid queue already stranded: cursor=16 with rows 9..30, so 9..16 sit below
    # the cursor while fresh rows keep the FIFO pass busy above it every run.
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    legacy = sqlite3.connect(path)
    legacy.executescript("""
        CREATE TABLE pending_events (
          id INTEGER PRIMARY KEY, level TEXT NOT NULL, code TEXT NOT NULL,
          message TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, store TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT;
        INSERT INTO meta VALUES ('heartbeat_event_cursor', '16');
    """)
    legacy.executemany(
        "INSERT INTO pending_events VALUES (?, 'warn', 'missing_source', ?, 1, 'omp', "
        "'2026-01-01T00:00:00Z')",
        ((i, f"legacy/{i}") for i in range(9, 31)),
    )
    legacy.commit()
    legacy.close()
    for run_no in range(30):
        with State(path) as st:
            assert run._heartbeat(cfg, st, RecordingTransport(), {},
                                  [event(f"fresh/{run_no}/{i}") for i in range(10)])
    with State(path) as st:
        assert st.conn.execute(
            "SELECT COUNT(*) FROM pending_events WHERE message LIKE 'legacy/%'").fetchone()[0] == 0


def test_oversized_only_pages_are_bounded_per_pass_and_resume_next_run(tmp_path, monkeypatch,
                                                                        capsys):
    # Pages of only retained oversized rows cost no request, so the page-read cap is what bounds
    # a pass. Reads stop at the cap; the next run resumes from the saved cursor.
    monkeypatch.setattr(run, "HEARTBEAT_MAX_EVENTS", 1)
    monkeypatch.setattr(run, "HEARTBEAT_MAX_BYTES", 1024)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    cap = run.HEARTBEAT_MAX_PAGES
    oversized = [event(f"{i}:" + "x" * 2000) for i in range(cap + 8)]
    original = State.drain_events
    pages = []

    def counting_drain(self, *args, **kwargs):
        ids, events = original(self, *args, **kwargs)
        if ids:
            pages.append(ids)
        return ids, events

    monkeypatch.setattr(State, "drain_events", counting_drain)
    first = RecordingTransport()
    with State(path) as st:
        st.buffer_events(oversized + [event("deliverable")])
        assert not run._heartbeat(cfg, st, first, {}, [])
        assert len(pages) == cap
        assert st.event_cursor() == cap
        assert st.pending_event_count() == cap + 9
    assert [body["events"] for body in first.bodies] == [[]]  # liveness only
    second = RecordingTransport()
    with State(path) as st:
        assert not run._heartbeat(cfg, st, second, {}, [])
        assert pages[cap][0] == cap + 1  # resumed after the saved cursor
        assert st.pending_event_count() == cap + 8
    assert event_counts(item for body in second.bodies for item in body["events"]) == event_counts(
        [event("deliverable")])
