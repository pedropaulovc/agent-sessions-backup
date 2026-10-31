import os
import sqlite3

import pytest

from agent_collector.state import State, OverlapLock


def test_overlap_lock_raises_on_non_contention_error(tmp_path):
    if os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0):
        pytest.skip("permission-based test needs a non-root POSIX host")
    db = tmp_path / "state.db"
    first = OverlapLock(db)
    assert first.acquire() is True  # creates the sibling lock DB file
    first.release()
    lockfile = db.with_name(db.name + ".lock")
    os.chmod(lockfile, 0o400)  # read-only: BEGIN IMMEDIATE write fails (SQLITE_READONLY)
    try:
        with pytest.raises(sqlite3.OperationalError):
            OverlapLock(db).acquire()  # not contention -> fail loudly, don't skip silently
    finally:
        os.chmod(lockfile, 0o600)


def test_machine_id_change_reoffers_files_and_records_event(tmp_path):
    db = tmp_path / "state.db"
    with State(db, machine_id="A") as st:
        st.upsert_file("claude", "a.jsonl", 10, 123, "deadbeef", "ok",
                       uploaded_size=10, uploaded_at="2026-01-01T00:00:00Z")
        assert st.machine_id_changed is False  # first init just records the id

    # reopen as B: hub namespace changed -> re-offer every file + buffer an event
    with State(db, machine_id="B") as st:
        assert st.machine_id_changed is True
        row = st.get_file("claude", "a.jsonl")
        assert row.status == "pending"  # size+mtime fast path defeated -> re-uploaded
        _ids, events = st.drain_events()
        assert any(e["code"] == "machine_id_changed" for e in events)

    # reopen as A again after B was stored -> same reset semantics
    with State(db, machine_id="A") as st:
        assert st.machine_id_changed is True


def test_machine_id_unchanged_is_noop(tmp_path):
    db = tmp_path / "state.db"
    with State(db, machine_id="A") as st:
        st.upsert_file("claude", "a.jsonl", 10, 123, "deadbeef", "ok")
    with State(db, machine_id="A") as st:
        assert st.machine_id_changed is False
        assert st.get_file("claude", "a.jsonl").status == "ok"
        assert st.pending_event_count() == 0


def test_hub_url_change_reoffers_files_and_records_event(tmp_path):
    db = tmp_path / "state.db"
    with State(db, machine_id="A", hub_url="http://hub-a") as st:
        st.upsert_file("claude", "a.jsonl", 10, 123, "deadbeef", "ok")
        assert st.hub_url_changed is False

    # same machine, different hub backend -> re-offer every file + event
    with State(db, machine_id="A", hub_url="http://hub-b") as st:
        assert st.hub_url_changed is True
        assert st.machine_id_changed is False
        assert st.get_file("claude", "a.jsonl").status == "pending"
        _ids, events = st.drain_events()
        assert any(e["code"] == "hub_url_changed" for e in events)


@pytest.mark.parametrize("stored_version", ["0.4.2", None])
def test_asset_scan_cache_resets_after_collector_version_change(tmp_path, stored_version):
    db = tmp_path / "state.db"
    with State(db) as st:
        st.mark_asset_scan("omp", "session.jsonl", 10, 123)
        assert st.asset_scan_ok("omp", "session.jsonl", 10, 123)
        if stored_version is None:
            st.conn.execute("DELETE FROM meta WHERE key = 'asset_scan_rules_version'")
        else:
            st.conn.execute(
                "UPDATE meta SET value = ? WHERE key = 'asset_scan_rules_version'",
                (stored_version,),
            )
        st.conn.commit()

    with State(db) as st:
        assert not st.asset_scan_ok("omp", "session.jsonl", 10, 123)
        _ids, events = st.drain_events()
        assert any(e["code"] == "asset_scan_rules_changed" for e in events)

def test_hub_url_trailing_slash_is_noop(tmp_path):
    db = tmp_path / "state.db"
    with State(db, machine_id="A", hub_url="http://hub-a") as st:
        st.upsert_file("claude", "a.jsonl", 10, 123, "deadbeef", "ok")
    with State(db, machine_id="A", hub_url="http://hub-a/") as st:  # cosmetic edit only
        assert st.hub_url_changed is False
        assert st.get_file("claude", "a.jsonl").status == "ok"
        assert st.pending_event_count() == 0


def test_upsert_and_get(tmp_path):
    with State(tmp_path / "state.db") as st:
        assert st.get_file("claude", "a.jsonl") is None
        st.upsert_file("claude", "a.jsonl", 10, 123, "deadbeef", "ok",
                       uploaded_size=10, uploaded_at="2026-01-01T00:00:00Z")
        row = st.get_file("claude", "a.jsonl")
        assert row.size == 10 and row.mtime_ns == 123 and row.sha256 == "deadbeef"
        assert row.status == "ok" and row.uploaded_size == 10
        # update in place keeps prior uploaded_at when not supplied
        st.upsert_file("claude", "a.jsonl", 20, 456, "cafef00d", "ok")
        row = st.get_file("claude", "a.jsonl")
        assert row.size == 20 and row.uploaded_at == "2026-01-01T00:00:00Z"


def test_overlap_lock_prevents_second_holder(tmp_path):
    db = tmp_path / "state.db"
    a = OverlapLock(db)
    b = OverlapLock(db)
    assert a.acquire() is True
    assert b.acquire() is False  # busy while a holds it
    a.release()
    assert b.acquire() is True   # free again
    b.release()


def test_pending_events_buffer_drain_delete(tmp_path):
    with State(tmp_path / "state.db") as st:
        assert st.pending_event_count() == 0
        st.buffer_events([
            {"level": "error", "code": "upload_failed", "message": "boom", "store": "claude"},
            {"level": "warn", "code": "slow", "message": "meh", "count": 3},
        ])
        assert st.pending_event_count() == 2
        ids, events = st.drain_events()
        assert len(ids) == 2
        assert events[0]["store"] == "claude"
        assert events[1]["count"] == 3
        assert "store" not in events[1]
        st.delete_events(ids)
        assert st.pending_event_count() == 0


def test_runs_lifecycle(tmp_path):
    with State(tmp_path / "state.db") as st:
        rid = st.start_run("run")
        st.finish_run(rid, 5, 2, 1, 100, 0)
        last = st.last_run()
        assert last["mode"] == "run" and last["files_scanned"] == 5
        assert last["bytes_uploaded"] == 100 and last["finished_at"] is not None


def test_compact_events_preserves_exact_identity_counts_and_minimum_ids(tmp_path):
    path = tmp_path / "state.db"
    rows = [
        ("warn", "missing", "path/A", 2, None),
        ("warn", "missing", "path/A", 3, ""),
        ("warn", "missing", "path/A", 5, None),
        ("error", "missing", "path/A", 7, None),
        ("warn", "other", "path/A", 11, None),
        ("warn", "missing", "path/a", 13, None),
        ("warn", "missing", "path/A", 17, ""),
    ]
    with State(path) as st:
        st.conn.executemany(
            "INSERT INTO pending_events (level, code, message, count, store, created_at) "
            "VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')",
            rows,
        )
        st.conn.commit()
        assert st.compact_events() == 7
        expected = [
            (1, "warn", "missing", "path/A", 7, None),
            (2, "warn", "missing", "path/A", 20, ""),
            (4, "error", "missing", "path/A", 7, None),
            (5, "warn", "other", "path/A", 11, None),
            (6, "warn", "missing", "path/a", 13, None),
        ]
        actual = [tuple(row) for row in st.conn.execute(
            "SELECT id, level, code, message, count, store FROM pending_events ORDER BY id"
        )]
        assert actual == expected
        st.compact_events()
    with State(path) as st:
        assert [tuple(row) for row in st.conn.execute(
            "SELECT id, level, code, message, count, store FROM pending_events ORDER BY id"
        )] == expected


def test_compact_events_only_merges_first_bounded_window_after_cursor(tmp_path):
    with State(tmp_path / "state.db") as st:
        st.buffer_events([
            {"level": "warn", "code": "missing", "message": "same", "count": n}
            for n in (1, 2, 3, 4, 5, 6)
        ])
        assert st.compact_events(after_id=1, limit=3) == 4
        assert [tuple(row) for row in st.conn.execute(
            "SELECT id, count FROM pending_events ORDER BY id"
        )] == [(1, 1), (2, 9), (5, 5), (6, 6)]
        ids, events = st.drain_events(limit=100, after_id=1, through_id=4)
        assert ids == [2]
        assert events[0]["count"] == 9
        assert st.compact_events(after_id=4, limit=2) == 6
        assert [tuple(row) for row in st.conn.execute(
            "SELECT id, count FROM pending_events ORDER BY id"
        )] == [(1, 1), (2, 9), (5, 11)]
        assert st.compact_events(after_id=6, limit=2) is None


def test_compact_events_rolls_back_all_changes_and_retries_after_restart(tmp_path):
    path = tmp_path / "state.db"
    with State(path) as st:
        st.buffer_events([
            {"level": "warn", "code": "missing", "message": message, "count": count}
            for message, count in (("a", 2), ("a", 3), ("b", 5), ("b", 7))
        ])
        before = [tuple(row) for row in st.conn.execute(
            "SELECT * FROM pending_events ORDER BY id"
        )]
        st.conn.execute(
            "CREATE TRIGGER fail_compaction BEFORE DELETE ON pending_events "
            "BEGIN SELECT RAISE(ABORT, 'injected compaction failure'); END"
        )
        st.conn.commit()
        with pytest.raises(sqlite3.DatabaseError, match="injected compaction failure"):
            st.compact_events()
        assert [tuple(row) for row in st.conn.execute(
            "SELECT * FROM pending_events ORDER BY id"
        )] == before
    with State(path) as st:
        assert [tuple(row) for row in st.conn.execute(
            "SELECT * FROM pending_events ORDER BY id"
        )] == before
        st.conn.execute("DROP TRIGGER fail_compaction")
        st.conn.commit()
        st.compact_events()
    with State(path) as st:
        assert [tuple(row) for row in st.conn.execute(
            "SELECT id, message, count FROM pending_events ORDER BY id"
        )] == [(1, "a", 5), (3, "b", 12)]
