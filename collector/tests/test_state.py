from agent_collector.state import State, OverlapLock


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
