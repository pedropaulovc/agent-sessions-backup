import hashlib
import sqlite3

from agent_collector import config
from agent_collector.scanner import Scanner, path_matches, read_exact, hash_bytes


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
