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


def test_run_returns_nonzero_when_authenticated_heartbeat_fails(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    cfg = _cfg(hub, root)
    monkeypatch.setattr(run_mod, "_heartbeat", lambda *_args, **_kwargs: False)
    with State(tmp_path / "state.db") as st:
        assert run_mod._do_run(cfg, st) == 1


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


def test_file_url_encodes_machine_and_store_segments():
    url = run_mod.file_url("http://h", "od/d", "st ore", "a b/c.jsonl")
    # machine_id and store are single segments (/ encoded); relpath keeps its separators
    assert url == "http://h/api/v1/files/od%2Fd/st%20ore/a%20b/c.jsonl"


def test_backfill_dry_run_fails_when_check_fails(tmp_path, hub, monkeypatch, capsys):
    import agent_collector.transport as transport_mod
    monkeypatch.setattr(transport_mod, "BACKOFF", (0.0, 0.0, 0.0))
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("x")
    cfg = _cfg(hub, root)
    hub.flaky_500_remaining = 999  # files/check returns 500
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=2, dry_run=True)
    assert rc == 1  # check is the only truth in dry-run -> its failure fails the command
    assert '"check_failures": 1' in capsys.readouterr().out
    assert hub.files == {}  # dry-run still uploads nothing


def test_backfill_dry_run_uploads_nothing(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"x")
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=True)
    assert hub.files == {}


def test_backfill_returns_nonzero_on_upload_failure(tmp_path, hub, monkeypatch):
    import agent_collector.transport as transport_mod
    monkeypatch.setattr(transport_mod, "BACKOFF", (0.0, 0.0, 0.0))
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("x")
    cfg = _cfg(hub, root)
    hub.flaky_500_remaining = 999  # every request 500 -> upload can't succeed
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
    assert rc == 1  # scripts must see the incomplete backfill


def test_backfill_returns_zero_on_clean_run(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_text("x")
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
    assert rc == 0
    assert ("m1", "claude", "a.jsonl") in hub.files


def test_run_releases_snapshot_after_each_item(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    for name in ("one.sqlite", "two.sqlite"):
        c = sqlite3.connect(root / name)
        c.execute("CREATE TABLE t(x)")
        c.commit()
        c.close()
    cfg = _cfg(hub, root)

    snap_counts = []
    real = run_mod._process_item

    def spy(cfg_, st_, tr_, scanner_, item_):
        # snapshot temp files present when each item STARTS processing
        snap_counts.append(len(list(scanner_.tmp_root.glob("snap-*.sqlite"))))
        return real(cfg_, st_, tr_, scanner_, item_)

    monkeypatch.setattr(run_mod, "_process_item", spy)
    with State(tmp_path / "state.db") as st:
        run_mod._do_run(cfg, st)
    # Each item's snapshot is released before the next is created; without the fix the second
    # item would start with 2 snapshots (the first left behind).
    assert snap_counts == [1, 1]


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


def test_run_materialize_oserror_skips_file_and_continues(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"aaa")
    (root / "b.jsonl").write_bytes(b"bbb")
    cfg = _cfg(hub, root)
    real = run_mod._materialize

    def flaky(scanner, data):
        if data == b"aaa":
            raise OSError(28, "No space left on device")
        return real(scanner, data)

    monkeypatch.setattr(run_mod, "_materialize", flaky)
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_run(cfg, st)
    assert rc == 0  # run finished despite the staging failure
    assert ("m1", "claude", "b.jsonl") in hub.files
    assert ("m1", "claude", "a.jsonl") not in hub.files
    assert any("stage failed" in e["message"] for e in hub.heartbeats[-1]["events"])


def test_backfill_materialize_oserror_skips_file_and_continues(tmp_path, hub, monkeypatch):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"aaa")
    (root / "b.jsonl").write_bytes(b"bbb")
    cfg = _cfg(hub, root)
    real = run_mod._materialize

    def flaky(scanner, data):
        if data == b"aaa":
            raise OSError(28, "No space left on device")
        return real(scanner, data)

    monkeypatch.setattr(run_mod, "_materialize", flaky)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
        assert st.pending_event_count() >= 1  # write_failed buffered for next heartbeat
    assert ("m1", "claude", "b.jsonl") in hub.files
    assert ("m1", "claude", "a.jsonl") not in hub.files


def test_doctor_fails_on_walk_error(tmp_path, hub, tmp_env, monkeypatch):
    import agent_collector.scanner as scanner_mod
    # config/state/hub checks all PASS, so only the walk error can make doctor fail.
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")
    claude = tmp_path / "home" / ".claude"
    claude.mkdir(parents=True)
    (claude / "s.jsonl").write_text("{}")

    real_walk = scanner_mod.os.walk

    def erroring_walk(top, topdown=True, onerror=None, followlinks=False):
        if onerror:
            err = OSError(13, "Permission denied")
            err.filename = str(top) + "/secret"
            onerror(err)
        yield from real_walk(top, topdown=topdown, onerror=onerror, followlinks=followlinks)

    monkeypatch.setattr(scanner_mod.os, "walk", erroring_walk)
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path)))
    assert rc == 1  # traversal error => incomplete scan => nonzero exit


def test_materialize_unlinks_body_when_write_fails(tmp_path, hub, monkeypatch):
    # A failed body write must not leave a *.body temp behind in the scanner tmp dir.
    root = tmp_path / "claude"
    root.mkdir()
    cfg = _cfg(hub, root)
    scanner = Scanner([])
    try:
        real_fdopen = os.fdopen

        def exploding_fdopen(fd, *a, **k):
            f = real_fdopen(fd, *a, **k)
            f.write = lambda _data: (_ for _ in ()).throw(OSError(28, "No space left on device"))
            return f

        monkeypatch.setattr(run_mod.os, "fdopen", exploding_fdopen)
        with pytest.raises(OSError):
            run_mod._materialize(scanner, b"payload")
        assert list(scanner.tmp_root.glob("*.body")) == []  # partial temp cleaned up on failure
    finally:
        scanner.close()


def test_doctor_cleans_up_db_snapshots_mid_scan(tmp_path, hub, tmp_env, monkeypatch):
    # doctor snapshots real DBs while counting them; each snapshot must be deleted as it goes
    # so a store full of DBs doesn't blow up temp usage during a preflight.
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")
    claude = tmp_path / "home" / ".claude"
    claude.mkdir(parents=True)
    db = claude / "sessions.sqlite"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE t(x)")
    c.commit()
    c.close()

    snap_paths = []
    real_cleanup = run_mod._cleanup_snapshot

    def spy(item):
        if item.is_snapshot:
            snap_paths.append(item.source_path)
        real_cleanup(item)

    monkeypatch.setattr(run_mod, "_cleanup_snapshot", spy)
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path)))
    assert rc == 0
    assert snap_paths, "the .sqlite DB should have been snapshotted during doctor"
    for p in snap_paths:
        assert not os.path.exists(p)  # each snapshot deleted mid-scan, not left to accumulate


def test_backfill_nonzero_when_db_snapshot_locked(tmp_path, hub, monkeypatch):
    # A DB we skip because its snapshot timed out was NOT captured this run -> incomplete ->
    # backfill must exit nonzero even though nothing errored outright.
    import agent_collector.scanner as scanner_mod
    root = tmp_path / "claude"
    root.mkdir()
    (root / "live.sqlite").write_bytes(b"")

    monkeypatch.setattr(scanner_mod, "_snapshot_sqlite",
                        lambda src, dst, deadline_s: scanner_mod.SNAPSHOT_LOCKED)
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)
    assert rc == 1  # snapshot_timeout event gates the exit code


def test_doctor_reports_old_curl_as_fail(tmp_path, hub, tmp_env, monkeypatch, capsys):
    import agent_collector.transport as transport_mod
    monkeypatch.setattr(transport_mod.Transport, "_probe_curl_version",
                        lambda self: (7, 68, 0))  # simulate Ubuntu 20.04 curl
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path)))
    out = capsys.readouterr().out
    assert "[FAIL] curl" in out and "7.76.0" in out
    assert rc == 1


def test_doctor_requires_authenticated_hub_route(tmp_path, hub, tmp_env, monkeypatch, capsys):
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")
    requested = []

    def unauthorized(_transport, url):
        requested.append(url)
        return 401, '{"error":"unauthorized"}'

    monkeypatch.setattr(Transport, "get", unauthorized)
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path)))
    out = capsys.readouterr().out
    assert requested == [f"{hub.url}/api/v1/status"]
    assert "[FAIL] authenticated hub identity" in out and "-> 401" in out
    assert rc == 1


def test_doctor_rejects_certificate_mapped_to_another_machine(tmp_path, hub, tmp_env, monkeypatch, capsys):
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")

    def wrong_identity(_transport, _url):
        return 200, json.dumps({
            "identity": {"machine_id": "other-machine", "cert_slot": "current"},
        })

    monkeypatch.setattr(Transport, "get", wrong_identity)
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path)))
    out = capsys.readouterr().out
    assert "machine='other-machine'" in out
    assert rc == 1


def test_doctor_can_require_current_certificate_slot(tmp_path, hub, tmp_env, monkeypatch, capsys):
    path = config.config_path()
    config.enroll(hub.url, dev=True, path=path, machine_id="m1")

    def grace_identity(_transport, _url):
        return 200, json.dumps({
            "identity": {"machine_id": "m1", "cert_slot": "grace"},
        })

    monkeypatch.setattr(Transport, "get", grace_identity)
    rc = run_mod.cmd_doctor(types.SimpleNamespace(config=str(path), require_current_cert=True))
    out = capsys.readouterr().out
    assert "cert_slot='grace'" in out
    assert rc == 1


# A realistic 40-hex SHA-1 cert thumbprint (normalize_thumbprint now requires exactly 40 hex).
_TP = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0"


def _cert_store_probe(monkeypatch, capsys, ps_stdout):
    # Drive _doctor_cert_store off-Windows by faking the platform and the powershell probe's stdout.
    monkeypatch.setattr(run_mod.sys, "platform", "win32")
    monkeypatch.setattr(run_mod.subprocess, "run",
                        lambda *a, **k: types.SimpleNamespace(stdout=ps_stdout, stderr="", returncode=0))
    ok = run_mod._doctor_cert_store(_TP)
    return ok, capsys.readouterr().out


def test_doctor_cert_store_ok(monkeypatch, capsys):
    # Positive control: cert present with a private key and comfortable expiry passes.
    ok, out = _cert_store_probe(monkeypatch, capsys, "364\n")
    assert ok is True
    assert "[ok]" in out and "364d" in out


def test_doctor_cert_store_missing_fails(monkeypatch, capsys):
    # Positive control (negative outcome): a cert not in the store is a hard failure.
    ok, out = _cert_store_probe(monkeypatch, capsys, "MISSING\n")
    assert ok is False
    assert "[FAIL]" in out and "not found" in out


def test_doctor_cert_store_no_private_key_fails(monkeypatch, capsys):
    # The gap: a cert in CurrentUser\My WITHOUT its private key (imported the .pem/.crt instead of the
    # PFX) must fail doctor with an actionable message, not pass and fail cryptically on first upload.
    # Revert the NOPRIVKEY branch and this flips to a passing warn (int('NOPRIVKEY') path), failing here.
    ok, out = _cert_store_probe(monkeypatch, capsys, "NOPRIVKEY\n")
    assert ok is False
    assert "[FAIL]" in out and "NO private key" in out and "--import-pfx" in out


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
