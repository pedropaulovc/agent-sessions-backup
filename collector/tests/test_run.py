import hashlib
import json
import os
import sqlite3
import types

import pytest

from agent_collector import config, run as run_mod
from agent_collector.scanner import Scanner, ScanItem
from agent_collector.state import State, OverlapLock
from agent_collector.transport import Transport, DevAuth

pytestmark = pytest.mark.skipif(
    not Transport.curl_available(), reason="system curl not available"
)


def _cfg(hub, root, machine="m1"):
    return config.Config(machine_id=machine, hub_url=hub.url, auth="dev",
                         stores={"claude": str(root)}, exclude=[])


def test_run_uploads_then_change_detection_skips_hash(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("original")
    cfg = _cfg(hub, root)

    calls = {"hash": 0}
    real_hash = run_mod.hash_bytes
    monkeypatch.setattr(run_mod, "hash_bytes",
                        lambda d: (calls.__setitem__("hash", calls["hash"] + 1), real_hash(d))[1])

    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    assert calls["hash"] == 1
    assert ("m1", "claude", "a.jsonl") in hub.files

    # Second run, nothing changed -> fast path, no hashing, no new upload.
    calls["hash"] = 0
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    assert calls["hash"] == 0

    # Change content + mtime -> hash and re-upload.
    (root / "a.jsonl").write_text("changed content longer")
    os.utime(root / "a.jsonl", (2_000_000_000, 2_000_000_000))
    calls["hash"] = 0
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    assert calls["hash"] == 1
    assert hub.files[("m1", "claude", "a.jsonl")]["body"] == b"changed content longer"


def test_run_records_heartbeat_with_stats(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("data")
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    assert len(hub.heartbeats) == 1
    hb = hub.heartbeats[0]
    assert hb["stores"]["claude"]["files_uploaded"] == 1
    assert hb["stores"]["claude"]["bytes_uploaded"] == len(b"data")


def test_heartbeat_buffers_on_failure_then_drains(tmp_path, hub, monkeypatch):
    monkeypatch.setattr("agent_collector.transport.BACKOFF", (0.01, 0.01, 0.01))
    cfg = _cfg(hub, tmp_path / "claude")
    transport = Transport(DevAuth("m1"))
    with State(tmp_path / "state.db") as st:
        hub.flaky_500_remaining = 99  # heartbeat POST fails through all retries
        event = {"level": "error", "code": "upload_failed", "message": "boom",
                 "count": 1, "store": "claude"}
        ok = run_mod._heartbeat(cfg, st, transport, {"claude": {}}, [event])
        assert ok is False
        assert st.pending_event_count() == 1

        hub.flaky_500_remaining = 0  # hub healthy again
        before = len(hub.heartbeats)
        ok = run_mod._heartbeat(cfg, st, transport, {"claude": {}}, [])
        assert ok is True
        assert st.pending_event_count() == 0
    drained = hub.heartbeats[-1]["events"]
    assert any(e["code"] == "upload_failed" for e in drained)


def test_backfill_uses_check_and_uploads_only_missing(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"already there")
    (root / "b.jsonl").write_bytes(b"needs upload")
    cfg = _cfg(hub, root)

    # Pre-seed the hub with a.jsonl so backfill must skip it.
    t = Transport(DevAuth("m1"))
    sha_a = hashlib.sha256(b"already there").hexdigest()
    t.put(f"{hub.url}/api/v1/files/m1/claude/a.jsonl", root / "a.jsonl",
          {"x-content-hash": f"sha256:{sha_a}", "x-file-mtime": "2026-01-01T00:00:00Z"})

    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=4, dry_run=False)
    assert rc == 0
    assert len(hub.checks) >= 1  # files/check was consulted
    assert ("m1", "claude", "b.jsonl") in hub.files
    # b uploaded exactly once; a not re-uploaded (still the pre-seeded body)
    assert hub.files[("m1", "claude", "b.jsonl")]["body"] == b"needs upload"


def test_backfill_read_error_skips_file_and_continues(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("boom")
    (root / "b.jsonl").write_text("ok")
    cfg = _cfg(hub, root)
    real_read = run_mod.read_exact

    def flaky_read(path, size):
        if path.name == "a.jsonl":
            raise PermissionError("chmodded after scan")
        return real_read(path, size)

    monkeypatch.setattr(run_mod, "read_exact", flaky_read)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
        assert st.pending_event_count() == 1  # read error buffered for next heartbeat
    assert ("m1", "claude", "b.jsonl") in hub.files
    assert ("m1", "claude", "a.jsonl") not in hub.files


def test_backfill_dry_run_uploads_nothing(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"x")
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=True)
    assert hub.files == {}


def test_snapshot_item_never_fast_paths_on_identical_metadata(tmp_path, hub):
    # Regression for the P1: a DB snapshot whose (size, mtime_ns) are IDENTICAL to state
    # but whose content changed (WAL commit) must still upload. is_snapshot skips the fast
    # path and re-hashes; hash-idempotency then decides.
    cfg = _cfg(hub, tmp_path / "claude")
    transport = Transport(DevAuth("m1"))
    scanner = Scanner([])
    snap = tmp_path / "snap.sqlite"
    key = ("m1", "claude", "todos.sqlite")
    try:
        with State(tmp_path / "state.db") as st:
            snap.write_bytes(b"X" * 100)
            item1 = ScanItem("claude", "todos.sqlite", 100, 555, snap, True)
            run_mod._process_item(cfg, st, transport, scanner, item1)
            sha1 = hub.files[key]["sha256"]

            # Content changes but size (100) and mtime_ns (555) stay identical.
            snap.write_bytes(b"Y" * 100)
            item2 = ScanItem("claude", "todos.sqlite", 100, 555, snap, True)
            res = run_mod._process_item(cfg, st, transport, scanner, item2)
    finally:
        scanner.close()
    assert res.uploaded is True
    assert hub.files[key]["sha256"] != sha1


def test_wal_db_commit_reuploaded(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    db = root / "todos.sqlite"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t(x)")
    writer.execute("INSERT INTO t VALUES('a')")
    writer.commit()
    cfg = _cfg(hub, root)
    key = ("m1", "claude", "todos.sqlite")
    try:
        with State(tmp_path / "state.db") as st:
            run_mod._do_run(cfg, st)
            sha_a = hub.files[key]["sha256"]
            writer.execute("INSERT INTO t VALUES('b')")
            writer.commit()
            with State(tmp_path / "state.db") as st2:
                run_mod._do_run(cfg, st2)
    finally:
        writer.close()
    assert hub.files[key]["sha256"] != sha_a  # changed DB re-snapshotted and uploaded
    # the uploaded snapshot is a valid DB reflecting the new row
    out = tmp_path / "out.sqlite"
    out.write_bytes(hub.files[key]["body"])
    conn = sqlite3.connect(out)
    assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 2
    conn.close()


def test_read_race_records_error_and_continues(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("vanishes")
    (root / "b.jsonl").write_text("survives")
    cfg = _cfg(hub, root)

    real_read = run_mod.read_exact

    def flaky_read(path, size):
        if path.name == "a.jsonl":
            raise FileNotFoundError("gone between scan and read")
        return real_read(path, size)

    monkeypatch.setattr(run_mod, "read_exact", flaky_read)
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_run(cfg, st)
    assert rc == 0  # run completed despite the read failure
    assert ("m1", "claude", "b.jsonl") in hub.files      # other file still uploaded
    assert ("m1", "claude", "a.jsonl") not in hub.files
    events = hub.heartbeats[-1]["events"]
    assert any("read failed" in e["message"] for e in events)


def test_wsl_mount_root_skipped_and_event_emitted(tmp_path, hub, monkeypatch):
    monkeypatch.setattr(config, "detect_platform_tag", lambda: "wsl")
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("x")
    cfg = config.Config(machine_id="m1", hub_url=hub.url, auth="dev",
                        stores={"claude": str(root), "win": "/mnt/c/Users/x/.claude"})
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    events = hub.heartbeats[-1]["events"]
    assert any(e["code"] == "windows_mount_skipped" and e["store"] == "win" for e in events)
    assert ("m1", "claude", "a.jsonl") in hub.files  # the WSL-side store still captured


def test_backfill_batches_and_frees_temp_bodies(tmp_path, hub, monkeypatch):
    # Small chunk size so multiple chunks run; assert only missing bodies are materialized
    # and the scanner temp dir is empty of body files after each chunk (no whole-corpus copy).
    monkeypatch.setattr(run_mod, "BACKFILL_CHUNK", 2)
    root = tmp_path / "claude"
    root.mkdir()
    for i in range(5):
        (root / f"f{i}.jsonl").write_text(f"content-{i}")
    cfg = _cfg(hub, root)

    materialized = []
    real_materialize = run_mod._materialize

    def counting_materialize(scanner, data):
        p = real_materialize(scanner, data)
        materialized.append(p)
        return p

    monkeypatch.setattr(run_mod, "_materialize", counting_materialize)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)

    assert len({("m1", "claude", f"f{i}.jsonl") for i in range(5)} & set(hub.files)) == 5
    assert len(materialized) == 5           # every missing file materialized exactly once
    for p in materialized:
        assert not os.path.exists(p)        # each body deleted after its upload


def test_backfill_present_files_never_materialized(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"already there")
    cfg = _cfg(hub, root)
    # Pre-seed the hub so a.jsonl is present.
    t = Transport(DevAuth("m1"))
    sha_a = hashlib.sha256(b"already there").hexdigest()
    t.put(f"{hub.url}/api/v1/files/m1/claude/a.jsonl", root / "a.jsonl",
          {"x-content-hash": f"sha256:{sha_a}", "x-file-mtime": "2026-01-01T00:00:00Z"})

    calls = {"n": 0}
    real_materialize = run_mod._materialize

    def counting(scanner, data):
        calls["n"] += 1
        return real_materialize(scanner, data)

    monkeypatch.setattr(run_mod, "_materialize", counting)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
    assert calls["n"] == 0  # present file's body never written to disk


def test_run_surfaces_walk_error_in_heartbeat(tmp_path, hub, monkeypatch):
    import agent_collector.scanner as scanner_mod
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("x")
    real_walk = scanner_mod.os.walk

    def erroring_walk(top, topdown=True, onerror=None, followlinks=False):
        if onerror:
            err = OSError(13, "Permission denied")
            err.filename = str(top) + "/secret"
            onerror(err)
        yield from real_walk(top, topdown=topdown, onerror=onerror, followlinks=followlinks)

    monkeypatch.setattr(scanner_mod.os, "walk", erroring_walk)
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    events = hub.heartbeats[-1]["events"]
    assert any(e["code"] == "walk_error" for e in events)
    assert ("m1", "claude", "a.jsonl") in hub.files  # scan continued, file uploaded


def test_run_lock_prevents_overlap(tmp_path, hub, tmp_env, monkeypatch):
    # enroll writes a real config the CLI path will load
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")

    held = OverlapLock()  # same default state path (XDG_STATE_HOME from tmp_env)
    assert held.acquire() is True
    try:
        args = types.SimpleNamespace(config=str(path), once=True)
        rc = run_mod.cmd_run(args)
        assert rc == 0
        assert hub.heartbeats == []  # never ran: lock was held
    finally:
        held.release()
