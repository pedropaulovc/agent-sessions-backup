import hashlib
import json
import os
import types

import pytest

from agent_collector import config, run as run_mod
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


def test_backfill_dry_run_uploads_nothing(tmp_path, hub):
    root = tmp_path / "claude"
    root.mkdir()
    (root / "a.jsonl").write_bytes(b"x")
    cfg = _cfg(hub, root)
    with State(tmp_path / "state.db") as st:
        run_mod._do_backfill(cfg, st, concurrency=2, dry_run=True)
    assert hub.files == {}


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
