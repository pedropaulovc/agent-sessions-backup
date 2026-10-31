"""Heartbeat queue conservation, request limits, and bounded recovery work."""
import json
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
    with State(path) as st:
        # Larger than one pass, but real-sized repeating warnings, not tiny placeholders.
        st.buffer_events([event("missing source: " + "a" * 100)] * 100_000)
        assert run._heartbeat(cfg, st, transport, {}, [event(count=2)] * 26_000)
        assert 0 < st.pending_event_count() < 100_000
        assert sent_count(transport) + pending_count(st) == 152_000
        assert len(transport.bodies) <= 64
    # Resume from durable state, rather than an in-memory cursor.
    with State(path) as st:
        while st.pending_event_count():
            assert run._heartbeat(cfg, st, transport, {}, [])
        assert sent_count(transport) == 152_000
    assert any(e["count"] > 1 for body in transport.bodies for e in body["events"])


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


def test_oversized_prefix_does_not_starve_later_events_across_passes(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(run, "HEARTBEAT_MAX_BATCHES", 1)
    cfg = SimpleNamespace(hub_url="https://hub.invalid")
    path = tmp_path / "state.db"
    huge = event("x" * (256 * 1024))
    with State(path) as st:
        st.buffer_events([huge, huge, event("deliver me")])
        assert not run._heartbeat(cfg, st, RecordingTransport(), {}, [])
        assert st.pending_event_count() == 3
    with State(path) as st:
        assert not run._heartbeat(cfg, st, RecordingTransport(), {}, [])
        transport = RecordingTransport()
        assert run._heartbeat(cfg, st, transport, {}, [])
        assert sent_count(transport) == 1
        assert st.pending_event_count() == 2
        assert st.conn.execute("SELECT message FROM pending_events LIMIT 1").fetchone()[0] == huge["message"]
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
