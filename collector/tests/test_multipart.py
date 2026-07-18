"""Collector multipart-upload path: threshold routing, byte-range part splitting, retry, abort.

All tests use the `tmp_env` fixture so HOME/XDG point at a temp dir — otherwise the real webcapture
export-inbox store would leak into the scan (see conftest). The multipart threshold/part-size are
shrunk to a few KB so a "large" file and a ">2x threshold" file stay tiny; the fake hub does not
enforce R2's real 5MiB floor (that rule is enforced + tested on the hub side).
"""

import hashlib

import pytest

from agent_collector import config, run as run_mod
from agent_collector.state import State
from agent_collector.transport import Transport

pytestmark = pytest.mark.skipif(
    not Transport.curl_available(), reason="system curl not available"
)


@pytest.fixture
def tmp_env(tmp_path, monkeypatch):
    """Fully isolate HOME and every XDG dir (including XDG_DATA_HOME, which drives the webcapture
    staging stores) so store_roots() never picks up a real/leaked export-inbox or webcapture file —
    otherwise stray files would inflate the part/PUT-attempt assertions below."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    return tmp_path


THRESHOLD_BYTES = 2048
PART_BYTES = 1024


def _cfg(hub, root, machine="m1", threshold_bytes=THRESHOLD_BYTES, part_bytes=PART_BYTES):
    return config.Config(
        machine_id=machine, hub_url=hub.url, auth="dev",
        stores={"claude": str(root)}, exclude=[],
        multipart_threshold_mb=threshold_bytes / 1024 / 1024,
        multipart_part_size_mb=part_bytes / 1024 / 1024,
    )


def _write(root, name, data: bytes):
    (root / name).write_bytes(data)


def test_small_file_uses_simple_put_positive_control(tmp_env, hub):
    """A file JUST UNDER the threshold takes the simple PUT path and lands byte-identically —
    the multipart branch must not disturb the working simple path."""
    root = tmp_env / "claude"
    root.mkdir()
    body = bytes(range(256)) * 7  # 1792 bytes < 2048 threshold
    assert len(body) < THRESHOLD_BYTES
    _write(root, "small.jsonl", body)
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)

    assert hub.part_attempts == 0  # never used a multipart part
    assert not hub.multipart  # no upload opened
    stored = hub.files[("m1", "claude", "small.jsonl")]
    assert stored["body"] == body  # byte-identical


def test_large_file_uses_multipart_and_reassembles_identically(tmp_env, hub):
    """A file over 2x the threshold uploads via multipart, and the parts reassemble on the hub to
    the EXACT original bytes — proving the offset/length range reads split (and rejoin) correctly."""
    root = tmp_env / "claude"
    root.mkdir()
    # Deterministic but non-repeating-per-part content so a mis-ordered/overlapping range read would
    # corrupt the reassembly and fail the equality check below.
    body = hashlib.sha256(b"seed").digest()
    while len(body) < 5000:  # > 2 * THRESHOLD_BYTES
        body += hashlib.sha256(body[-32:]).digest()
    assert len(body) > 2 * THRESHOLD_BYTES
    _write(root, "big.jsonl", body)
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)

    expected_parts = -(-len(body) // PART_BYTES)
    assert hub.part_attempts == expected_parts
    assert hub.put_attempts == 0  # the big file never used a single PUT
    stored = hub.files[("m1", "claude", "big.jsonl")]
    assert stored["body"] == body  # reassembled == original, byte for byte
    assert stored["sha256"] == hashlib.sha256(body).hexdigest()


def test_multipart_records_state_and_stats(tmp_env, hub):
    root = tmp_env / "claude"
    root.mkdir()
    body = b"z" * 5000
    _write(root, "big.jsonl", body)
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        rc = run_mod._do_run(cfg, st)
        assert rc == 0
        row = st.get_file("claude", "big.jsonl")
    assert row.status == "ok"
    assert row.sha256 == hashlib.sha256(body).hexdigest()

    # Second run: unchanged -> fast path, no re-upload, no new parts.
    hub.part_attempts = 0
    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)
    assert hub.part_attempts == 0


def test_multipart_retries_then_succeeds_on_verify_failure(tmp_env, hub):
    """The hub rejects the first two completes (verify failure); the collector retries the whole
    create->parts->complete and succeeds on the third attempt within the 3-attempt budget."""
    root = tmp_env / "claude"
    root.mkdir()
    body = b"abcd" * 1500  # 6000 bytes
    _write(root, "big.jsonl", body)
    hub.flaky_multipart_mismatch_remaining = 2
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)
        row = st.get_file("claude", "big.jsonl")

    assert hub.completes == 3  # two rejected + one accepted
    assert ("m1", "claude", "big.jsonl") in hub.files
    assert hub.files[("m1", "claude", "big.jsonl")]["body"] == body
    assert row.status == "ok"


def test_multipart_aborts_and_errors_on_giveup(tmp_env, hub):
    """Every complete fails; after 3 attempts the collector gives up, aborts each dangling upload,
    marks the file errored, and surfaces an upload_failed heartbeat event (never silent)."""
    root = tmp_env / "claude"
    root.mkdir()
    body = b"q" * 5000
    _write(root, "big.jsonl", body)
    hub.force_complete_status = 400  # complete always fails, upload left pending for abort
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)
        row = st.get_file("claude", "big.jsonl")

    assert ("m1", "claude", "big.jsonl") not in hub.files  # never stored
    assert row.status == "error"
    assert len(hub.aborts) == 3  # one abort per attempt (dangling upload released each time)
    assert not hub.multipart  # nothing left pending on the hub

    # The failure reached the hub as a heartbeat event, not a silent drop.
    assert hub.heartbeats
    events = hub.heartbeats[-1]["events"]
    assert any(e["code"] == "upload_failed" and e.get("store") == "claude" for e in events)


def test_backfill_routes_large_file_through_multipart(tmp_env, hub):
    root = tmp_env / "claude"
    root.mkdir()
    small = b"tiny"
    big = b"w" * 6000
    _write(root, "small.jsonl", small)
    _write(root, "big.jsonl", big)
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        rc = run_mod._do_backfill(cfg, st, concurrency=2, dry_run=False)

    assert rc == 0
    assert hub.files[("m1", "claude", "big.jsonl")]["body"] == big  # multipart reassembled
    assert hub.files[("m1", "claude", "small.jsonl")]["body"] == small  # batch/simple path
    expected_parts = -(-len(big) // PART_BYTES)
    assert hub.part_attempts == expected_parts


def test_multipart_unchanged_shortcircuit_skips_reupload(tmp_env, hub):
    """When the hub already holds the bytes, create returns 200 unchanged and no parts are sent."""
    root = tmp_env / "claude"
    root.mkdir()
    body = b"m" * 5000
    _write(root, "big.jsonl", body)
    # Pre-seed the hub with the exact bytes so create short-circuits.
    hub.files[("m1", "claude", "big.jsonl")] = {
        "sha256": hashlib.sha256(body).hexdigest(), "body": body, "mtime": None,
    }
    cfg = _cfg(hub, root)

    with State(tmp_env / "state.db") as st:
        run_mod._do_run(cfg, st)
        row = st.get_file("claude", "big.jsonl")

    assert hub.part_attempts == 0  # unchanged: no parts uploaded
    assert not hub.multipart
    assert row.status == "ok"
