import hashlib
import os
import sqlite3
import time

import pytest

from agent_collector import config
from agent_collector.scanner import (
    Scanner, path_matches, read_exact, hash_bytes, hash_file_prefix, _snapshot_sqlite,
    SNAPSHOT_OK, SNAPSHOT_NOT_A_DB, SNAPSHOT_LOCKED,
)


def _tree(root):
    root.mkdir(parents=True, exist_ok=True)


def test_path_matches_security_globs():
    # basename anchored even when nested
    assert path_matches("projects/x/.credentials.json", ".credentials.json")
    # **/oauth* also catches a root-level file (leading **/ optional)
    assert path_matches("oauth.json", "**/oauth*")
    assert path_matches("a/b/oauth-token", "**/oauth*")
    # extensions anywhere in the tree
    assert path_matches("a/b/private.key", "*.key")
    assert path_matches("deep/dir/id_rsa.pem", "*.pem")
    # sqlite sidecars excluded but the .sqlite itself is NOT
    assert path_matches("db.sqlite-wal", "*.sqlite-wal")
    assert not path_matches("db.sqlite", "*.sqlite-wal")
    # directory globs
    assert path_matches("cache/blob/x", "cache/**")
    assert path_matches("projects/a/b/backups/old.jsonl", "projects/**/backups/**")


def test_scan_includes_and_excludes_with_nested_subagents(tmp_path):
    root = tmp_path / ".claude"
    (root / "projects" / "slug").mkdir(parents=True)
    (root / "projects" / "slug" / "11111111-1111-1111-1111-111111111111.jsonl").write_text("{}")
    subdir = root / "projects" / "slug" / "subagents"
    subdir.mkdir()
    (subdir / "agent-22222222-2222-2222-2222-222222222222.jsonl").write_text("{}")
    # things that must be excluded
    (root / ".credentials.json").write_text("secret")
    (root / "cache").mkdir()
    (root / "cache" / "blob").write_text("x")
    (root / "oauth_state.json").write_text("token")
    (root / "id.pem").write_text("key")
    (root / "shell-snapshots").mkdir()
    (root / "shell-snapshots" / "snap.sh").write_text("x")

    scanner = Scanner(config.DEFAULT_EXCLUDES)
    try:
        found = {item.relpath for item in scanner.scan_store("claude", root)}
    finally:
        scanner.close()

    assert "projects/slug/11111111-1111-1111-1111-111111111111.jsonl" in found
    assert "projects/slug/subagents/agent-22222222-2222-2222-2222-222222222222.jsonl" in found
    assert ".credentials.json" not in found
    assert "cache/blob" not in found
    assert "oauth_state.json" not in found
    assert "id.pem" not in found
    assert "shell-snapshots/snap.sh" not in found


def test_prefix_capture_on_growing_file(tmp_path):
    root = tmp_path / ".claude"
    root.mkdir()
    f = root / "log.jsonl"
    f.write_bytes(b"A" * 50)

    scanner = Scanner([])
    try:
        items = list(scanner.scan_store("claude", root))
        assert len(items) == 1
        item = items[0]
        assert item.size == 50
        # File grows AFTER stat, before we read the bytes.
        with open(f, "ab") as fh:
            fh.write(b"B" * 50)
        data = read_exact(item.source_path, item.size)
    finally:
        scanner.close()

    assert data == b"A" * 50  # captured prefix, not the grown file
    assert hash_bytes(data) == hashlib.sha256(b"A" * 50).hexdigest()


def test_sqlite_snapshot_and_sidecar_exclusion(tmp_path):
    root = tmp_path / ".claude"
    root.mkdir()
    db = root / "todos.sqlite"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t (x TEXT)")
    conn.execute("INSERT INTO t VALUES ('hello')")
    conn.commit()
    conn.close()
    # sidecar files that must never be uploaded
    (root / "todos.sqlite-wal").write_bytes(b"junk")
    (root / "todos.sqlite-shm").write_bytes(b"junk")

    scanner = Scanner(config.DEFAULT_EXCLUDES)
    try:
        items = {item.relpath: item for item in scanner.scan_store("claude", root)}
        assert "todos.sqlite" in items
        assert "todos.sqlite-wal" not in items
        assert "todos.sqlite-shm" not in items
        snap = items["todos.sqlite"]
        assert snap.is_snapshot
        assert snap.source_path != db  # reads the snapshot copy, not the live DB
        data = read_exact(snap.source_path, snap.size)
        assert data.startswith(b"SQLite format 3\x00")
        # the snapshot is a real, queryable DB
        snap_conn = sqlite3.connect(snap.source_path)
        assert snap_conn.execute("SELECT x FROM t").fetchone()[0] == "hello"
        snap_conn.close()
    finally:
        scanner.close()


def test_snapshot_bounded_when_source_locked(tmp_path):
    # A DB held in BEGIN EXCLUSIVE must not hang backup() forever; the deadline aborts and
    # _snapshot_sqlite reports SNAPSHOT_LOCKED so the file is skipped this run.
    db = tmp_path / "locked.sqlite"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE t(x)")
    c.execute("INSERT INTO t VALUES('a')")
    c.commit()
    c.close()
    holder = sqlite3.connect(db, isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        start = time.monotonic()
        outcome = _snapshot_sqlite(db, tmp_path / "snap.sqlite", deadline_s=0.5)
        elapsed = time.monotonic() - start
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert outcome == SNAPSHOT_LOCKED  # distinct from not_a_db, so caller can skip not raw-upload
    assert elapsed < 10  # bounded by the deadline, not hanging on the exclusive lock


def test_snapshot_outcomes_ok_and_not_a_db(tmp_path):
    db = tmp_path / "real.sqlite"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE t(x)")
    c.commit()
    c.close()
    assert _snapshot_sqlite(db, tmp_path / "ok.sqlite") == SNAPSHOT_OK
    garbage = tmp_path / "junk.db"
    garbage.write_bytes(b"not a database at all")
    assert _snapshot_sqlite(garbage, tmp_path / "no.sqlite") == SNAPSHOT_NOT_A_DB


@pytest.mark.parametrize("name", ["weird?name.sqlite", "hash#name.sqlite"])
def test_snapshot_uri_delimiters_in_filename(tmp_path, name):
    # Codex repro: an unencoded '?'/'#' in the path is parsed as a URI query/fragment, so
    # the snapshot would come from an EMPTY 'weird'/'hash' DB. Assert the real tables survive.
    src = tmp_path / name
    try:
        c = sqlite3.connect(src)
    except sqlite3.OperationalError:
        pytest.skip("filesystem rejects this filename")
    c.execute("CREATE TABLE marker(x)")
    c.execute("INSERT INTO marker VALUES('present')")
    c.commit()
    c.close()

    dst = tmp_path / "snap.sqlite"
    assert _snapshot_sqlite(src, dst) == SNAPSHOT_OK
    snap = sqlite3.connect(dst)
    try:
        assert snap.execute("SELECT x FROM marker").fetchone()[0] == "present"
    finally:
        snap.close()


def test_locked_db_skipped_with_event_garbage_db_raw_captured(tmp_path):
    root = tmp_path / ".claude"
    root.mkdir()
    # a real DB, locked EXCLUSIVE -> must be skipped (not raw-uploaded) + snapshot_timeout event
    locked = root / "locked.sqlite"
    c = sqlite3.connect(locked)
    c.execute("CREATE TABLE t(x)")
    c.commit()
    c.close()
    holder = sqlite3.connect(locked, isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")
    # a non-DB file with a .db suffix -> raw-captured
    garbage = root / "notes.db"
    garbage.write_bytes(b"just text, not sqlite")

    scanner = Scanner([])
    scanner.snapshot_deadline_s = 0.3  # short deadline so the locked DB aborts fast
    try:
        items = {it.relpath: it for it in scanner.scan_store("claude", root)}
    finally:
        holder.execute("ROLLBACK")
        holder.close()
        scanner.close()

    assert "locked.sqlite" not in items  # skipped, never raw-uploaded
    assert "notes.db" in items
    assert items["notes.db"].is_snapshot is False  # garbage .db raw-captured
    codes = {e["code"] for e in scanner.events}
    assert "snapshot_timeout" in codes
    ev = next(e for e in scanner.events if e["code"] == "snapshot_timeout")
    assert ev["store"] == "claude" and "locked.sqlite" in ev["message"]


def test_hash_file_prefix_matches_read_exact(tmp_path):
    f = tmp_path / "f.bin"
    f.write_bytes(b"A" * 200)
    # streams the first `size` bytes; prefix semantics identical to read_exact
    assert hash_file_prefix(f, 120) == hash_bytes(read_exact(f, 120))
    assert hash_file_prefix(f, 200) == hash_bytes(b"A" * 200)


def test_scan_prunes_excluded_directories(tmp_path):
    root = tmp_path / ".claude"
    (root / "cache" / "deep").mkdir(parents=True)
    (root / "cache" / "deep" / "big.bin").write_text("x")
    (root / "statsig").mkdir()
    (root / "statsig" / "events.json").write_text("x")
    (root / "projects" / "slug").mkdir(parents=True)
    (root / "projects" / "slug" / "s.jsonl").write_text("{}")

    real_walk = os.walk
    walked = []

    def counting_walk(top, **kw):
        for dirpath, dirnames, filenames in real_walk(top, **kw):
            walked.append(dirpath)
            yield dirpath, dirnames, filenames

    import agent_collector.scanner as scanner_mod
    scanner = Scanner(config.DEFAULT_EXCLUDES)
    orig = scanner_mod.os.walk
    scanner_mod.os.walk = counting_walk
    try:
        found = {item.relpath for item in scanner.scan_store("claude", root)}
    finally:
        scanner_mod.os.walk = orig
        scanner.close()

    assert found == {"projects/slug/s.jsonl"}
    # excluded dirs are pruned: os.walk never descends into cache/deep or statsig
    assert not any(d.endswith("deep") for d in walked)
    assert not any(d.endswith("statsig") for d in walked)


def test_walk_error_recorded_as_event(tmp_path):
    root = tmp_path / ".claude"
    (root / "projects").mkdir(parents=True)
    (root / "projects" / "a.jsonl").write_text("{}")

    real_walk = os.walk

    def erroring_walk(top, topdown=True, onerror=None, followlinks=False):
        if onerror:  # simulate an unreadable subtree os.walk would otherwise drop silently
            err = OSError(13, "Permission denied")
            err.filename = str(top) + "/secret"
            onerror(err)
        yield from real_walk(top, topdown=topdown, onerror=onerror, followlinks=followlinks)

    import agent_collector.scanner as scanner_mod
    scanner = Scanner([])
    orig = scanner_mod.os.walk
    scanner_mod.os.walk = erroring_walk
    try:
        found = {it.relpath for it in scanner.scan_store("claude", root)}
    finally:
        scanner_mod.os.walk = orig
        scanner.close()

    assert "projects/a.jsonl" in found  # scan continues past the error
    ev = next(e for e in scanner.events if e["code"] == "walk_error")
    assert ev["store"] == "claude" and "secret" in ev["message"]
