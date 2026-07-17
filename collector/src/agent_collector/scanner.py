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
import sqlite3
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


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


def _snapshot_sqlite(src: Path, dst: Path) -> bool:
    """Consistent snapshot via the backup API. Returns False if src is not a valid DB."""
    try:
        src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    except sqlite3.Error:
        return False
    try:
        dst_conn = sqlite3.connect(str(dst))
        try:
            with dst_conn:
                src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    except sqlite3.Error:
        return False
    finally:
        src_conn.close()
    return True


def read_exact(path: Path, size: int) -> bytes:
    """Reader seam: read AT MOST size bytes (prefix capture on a growing file)."""
    with open(path, "rb") as f:
        return f.read(size)


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            relpath = path.relative_to(root).as_posix()
            hit = first_matching_pattern(relpath, self.excludes)
            if hit:
                self.excluded_counts[store][hit] += 1
                continue
            item = self._make_item(store, relpath, path)
            if item:
                yield item

    def _make_item(self, store: str, relpath: str, path: Path) -> ScanItem | None:
        try:
            st = path.stat()
        except OSError:
            return None
        if path.name.endswith(".sqlite"):
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
