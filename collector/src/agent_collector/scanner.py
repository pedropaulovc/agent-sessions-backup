"""Scanner: capture-ALL walk of each store tree, minus exclude globs.

- relpath is POSIX (forward slashes), relative to the store root.
- *.sqlite files are snapshot-copied via the sqlite3 backup API and the snapshot bytes
  are what get hashed/uploaded under the original relpath (never read a live DB directly).
- Live-file race: stat first, read exactly st_size bytes, hash THAT buffer. A file that
  grows between stat and read yields the captured prefix; uploaded_size == bytes sent.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import sqlite3
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

# Snapshot deadline: a DB held in BEGIN EXCLUSIVE would otherwise block backup() forever
# while the run holds the overlap lock. Past this we abort and skip the file this run.
SNAPSHOT_DEADLINE_S = 30.0
SNAPSHOT_PAGES = 128  # copy this many pages per backup step, so the progress abort fires often

# A directory is pruned during the walk iff a direct child file would be excluded. This
# neutral probe name can't accidentally match a filename glob (*.key, *-wal, .credentials…)
# but still matches every subtree pattern (cache/**) and the oauth* candidate.
_DIR_PROBE = "\x00"


def path_matches(relpath: str, pattern: str) -> bool:
    """Exclude match on a POSIX relpath. Superset of fnmatch so security excludes never
    silently miss: matches the full path AND the basename, and treats a leading ``**/`` as
    an optional prefix (so ``**/oauth*`` also catches a root-level ``oauth.json``)."""
    base = relpath.rsplit("/", 1)[-1]
    candidates = {pattern}
    if pattern.startswith("**/"):
        candidates.add(pattern[3:])
    for pat in candidates:
        if fnmatch.fnmatch(relpath, pat) or fnmatch.fnmatch(base, pat):
            return True
    return False


def first_matching_pattern(relpath: str, patterns: list[str]) -> str | None:
    for pat in patterns:
        if path_matches(relpath, pat):
            return pat
    return None


@dataclass
class ScanItem:
    store: str
    relpath: str
    size: int          # bytes to hash/send: st_size at stat time, or snapshot size
    mtime_ns: int      # from the ORIGINAL file, so change-detection tracks the live file
    source_path: Path  # where to read the bytes from (original file or snapshot temp file)
    is_snapshot: bool


def _snapshot_sqlite(src: Path, dst: Path, deadline_s: float = SNAPSHOT_DEADLINE_S) -> bool:
    """Bounded consistent snapshot via the backup API.

    Returns False if src is not a valid DB OR the backup can't complete within deadline_s
    (e.g. the source is held in BEGIN EXCLUSIVE) — the caller skips the file this run and
    retries next run rather than hanging while holding the overlap lock. The progress
    callback fires after every backup step, including on SQLITE_BUSY retries, so a locked
    source still hits the deadline and aborts.
    """
    try:
        src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=deadline_s)
    except sqlite3.Error:
        return False
    deadline = time.monotonic() + deadline_s

    def _progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            raise TimeoutError("sqlite snapshot exceeded deadline")

    try:
        src_conn.execute("PRAGMA busy_timeout = 1000")
        dst_conn = sqlite3.connect(str(dst))
        try:
            with dst_conn:
                src_conn.backup(dst_conn, pages=SNAPSHOT_PAGES, progress=_progress, sleep=0.1)
        finally:
            dst_conn.close()
    except (sqlite3.Error, TimeoutError):
        return False
    finally:
        src_conn.close()
    return True


def read_exact(path: Path, size: int) -> bytes:
    """Reader seam: read AT MOST size bytes (prefix capture on a growing file)."""
    with open(path, "rb") as f:
        return f.read(size)


def hash_file_prefix(path: Path, size: int) -> str:
    """Stream the first `size` bytes and return their sha256 without holding them in memory.

    Used by backfill so hashing the corpus never materializes it. Reads AT MOST size bytes,
    so growing-file prefix semantics match read_exact.
    """
    h = hashlib.sha256()
    remaining = size
    with open(path, "rb") as f:
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# SQLite-family databases we snapshot rather than read live. _snapshot_sqlite falls back
# to a raw read if the file is not actually a valid DB, so this list can be liberal.
DB_SUFFIXES = (".sqlite", ".sqlite3", ".db", ".vscdb")


class Scanner:
    def __init__(self, excludes: list[str]):
        self.excludes = excludes
        self._tmp = tempfile.TemporaryDirectory(prefix="agent-collector-")
        self.tmp_root = Path(self._tmp.name)
        self._snap_seq = 0
        # store -> pattern -> count
        self.excluded_counts: dict[str, dict[str, int]] = defaultdict(
            lambda: defaultdict(int)
        )

    def close(self) -> None:
        self._tmp.cleanup()

    def __enter__(self) -> "Scanner":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def scan_store(self, store: str, root: Path) -> Iterator[ScanItem]:
        if not root.exists():
            return
        # os.walk(topdown=True) so we can PRUNE excluded directories in-place before
        # descending — never pay the I/O of walking cache/**, statsig/**, etc. Names are
        # sorted at each level for deterministic order.
        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            rel_dir = Path(dirpath).relative_to(root)
            rel_prefix = "" if str(rel_dir) == "." else rel_dir.as_posix() + "/"

            kept = []
            for d in sorted(dirnames):
                child_rel = rel_prefix + d
                hit = first_matching_pattern(child_rel + "/" + _DIR_PROBE, self.excludes)
                if hit:
                    self.excluded_counts[store][hit] += 1  # count the pruned subtree once
                    continue
                kept.append(d)
            dirnames[:] = kept

            for fname in sorted(filenames):
                relpath = rel_prefix + fname
                hit = first_matching_pattern(relpath, self.excludes)
                if hit:
                    self.excluded_counts[store][hit] += 1
                    continue
                path = Path(dirpath) / fname
                if not path.is_file() or path.is_symlink():
                    continue
                item = self._make_item(store, relpath, path)
                if item:
                    yield item

    def _make_item(self, store: str, relpath: str, path: Path) -> ScanItem | None:
        try:
            st = path.stat()
        except OSError:
            return None
        if path.name.endswith(DB_SUFFIXES):
            self._snap_seq += 1
            dst = self.tmp_root / f"snap-{self._snap_seq}.sqlite"
            if _snapshot_sqlite(path, dst):
                snap_size = dst.stat().st_size
                return ScanItem(store, relpath, snap_size, st.st_mtime_ns, dst, True)
            # Not a real DB: fall through and capture raw bytes.
        return ScanItem(store, relpath, st.st_size, st.st_mtime_ns, path, False)

    def top_excluded(self, store: str, n: int = 10) -> list[tuple[str, int]]:
        counts = self.excluded_counts.get(store, {})
        return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:n]
