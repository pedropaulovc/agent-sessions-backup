"""SQLite state at $XDG_STATE_HOME/agent-collector/state.db (default ~/.local/state/...).

STRICT tables. WAL + NORMAL. The overlap lock lives in a SIBLING lock database so a held
BEGIN IMMEDIATE never blocks the main connection's per-file commits (same-file WAL allows
only one writer, which would self-deadlock).
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  store TEXT NOT NULL,
  relpath TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_size INTEGER,
  uploaded_at TEXT,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  UNIQUE (store, relpath)
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  files_uploaded INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS pending_events (
  id INTEGER PRIMARY KEY,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  store TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
) STRICT;
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def state_dir() -> Path:
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "agent-collector"


def state_path() -> Path:
    return state_dir() / "state.db"


@dataclass
class FileRow:
    store: str
    relpath: str
    size: int
    mtime_ns: int
    sha256: str
    uploaded_size: int | None
    uploaded_at: str | None
    last_seen_at: str
    status: str
    error: str | None


class State:
    def __init__(self, path: Path | None = None, machine_id: str | None = None,
                 hub_url: str | None = None):
        self.path = path or state_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA synchronous = NORMAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.machine_id_changed = False
        self.hub_url_changed = False
        if machine_id is not None or hub_url is not None:
            self._reconcile_identity(machine_id, hub_url)

    def _reconcile_identity(self, machine_id: str | None, hub_url: str | None) -> None:
        """Scope the local fast-path state by the hub IDENTITY (machine_id + hub_url). The hub
        object key includes machine_id, and re-pointing at a different hub_url is a different
        backend — either would leave 'ok' rows satisfying the size+mtime fast path so the new
        namespace never receives the corpus. On a change, re-offer every file (status='pending'
        defeats the fast path; files/check cheaply resyncs what the hub already has) and buffer
        an event. hub_url is normalized (trailing slash stripped) so a cosmetic edit is a no-op.
        """
        hub_url = hub_url.rstrip("/") if hub_url is not None else None
        events: list[dict] = []
        m_changed = self._reconcile_meta_key("machine_id", machine_id, "machine_id_changed", events)
        h_changed = self._reconcile_meta_key("hub_url", hub_url, "hub_url_changed", events)
        if not (m_changed or h_changed):
            self.conn.commit()  # persist any first-time meta inserts
            return
        self.conn.execute("UPDATE files SET status = 'pending', error = NULL")
        self.conn.commit()
        self.buffer_events(events)
        self.machine_id_changed = m_changed
        self.hub_url_changed = h_changed

    def _reconcile_meta_key(self, key: str, value: str | None, code: str,
                            events_out: list[dict]) -> bool:
        """Return True if a stored meta value changed (records the new value + an event)."""
        if value is None:
            return False
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        stored = row["value"] if row else None
        if stored is None:
            self.conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", (key, value))
            return False
        if stored == value:
            return False
        self.conn.execute("UPDATE meta SET value = ? WHERE key = ?", (value, key))
        events_out.append({
            "level": "warn", "code": code,
            "message": f"{key} changed {stored!r} -> {value!r}; re-offering all files",
            "count": 1,
        })
        return True

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "State":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- files ------------------------------------------------------------
    def get_file(self, store: str, relpath: str) -> FileRow | None:
        row = self.conn.execute(
            "SELECT * FROM files WHERE store = ? AND relpath = ?", (store, relpath)
        ).fetchone()
        if not row:
            return None
        return FileRow(
            store=row["store"],
            relpath=row["relpath"],
            size=row["size"],
            mtime_ns=row["mtime_ns"],
            sha256=row["sha256"],
            uploaded_size=row["uploaded_size"],
            uploaded_at=row["uploaded_at"],
            last_seen_at=row["last_seen_at"],
            status=row["status"],
            error=row["error"],
        )

    def upsert_file(
        self,
        store: str,
        relpath: str,
        size: int,
        mtime_ns: int,
        sha256: str,
        status: str,
        uploaded_size: int | None = None,
        uploaded_at: str | None = None,
        error: str | None = None,
    ) -> None:
        self.conn.execute(
            """
            INSERT INTO files (store, relpath, size, mtime_ns, sha256, uploaded_size,
                               uploaded_at, last_seen_at, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (store, relpath) DO UPDATE SET
              size = excluded.size, mtime_ns = excluded.mtime_ns, sha256 = excluded.sha256,
              uploaded_size = COALESCE(excluded.uploaded_size, files.uploaded_size),
              uploaded_at = COALESCE(excluded.uploaded_at, files.uploaded_at),
              last_seen_at = excluded.last_seen_at, status = excluded.status,
              error = excluded.error
            """,
            (store, relpath, size, mtime_ns, sha256, uploaded_size, uploaded_at,
             now_iso(), status, error),
        )
        self.conn.commit()

    def touch_seen(self, store: str, relpath: str) -> None:
        self.conn.execute(
            "UPDATE files SET last_seen_at = ? WHERE store = ? AND relpath = ?",
            (now_iso(), store, relpath),
        )
        self.conn.commit()

    def error_files(self) -> list[FileRow]:
        rows = self.conn.execute(
            "SELECT * FROM files WHERE status = 'error' ORDER BY store, relpath"
        ).fetchall()
        return [self._row_to_file(r) for r in rows]

    def counts_by_status(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT status, COUNT(*) AS n FROM files GROUP BY status"
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}

    @staticmethod
    def _row_to_file(row: sqlite3.Row) -> FileRow:
        return FileRow(
            store=row["store"], relpath=row["relpath"], size=row["size"],
            mtime_ns=row["mtime_ns"], sha256=row["sha256"],
            uploaded_size=row["uploaded_size"], uploaded_at=row["uploaded_at"],
            last_seen_at=row["last_seen_at"], status=row["status"], error=row["error"],
        )

    # -- runs -------------------------------------------------------------
    def start_run(self, mode: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO runs (mode, started_at) VALUES (?, ?)", (mode, now_iso())
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def finish_run(
        self,
        run_id: int,
        files_scanned: int,
        files_changed: int,
        files_uploaded: int,
        bytes_uploaded: int,
        errors: int,
    ) -> None:
        self.conn.execute(
            """
            UPDATE runs SET finished_at = ?, files_scanned = ?, files_changed = ?,
              files_uploaded = ?, bytes_uploaded = ?, errors = ? WHERE id = ?
            """,
            (now_iso(), files_scanned, files_changed, files_uploaded, bytes_uploaded,
             errors, run_id),
        )
        self.conn.commit()

    def last_run(self) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    # -- pending events (heartbeat buffer) --------------------------------
    def buffer_events(self, events: list[dict]) -> None:
        for e in events:
            self.conn.execute(
                """
                INSERT INTO pending_events (level, code, message, count, store, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (e["level"], e["code"], e["message"], e.get("count", 1),
                 e.get("store"), now_iso()),
            )
        self.conn.commit()

    def drain_events(self) -> tuple[list[int], list[dict]]:
        rows = self.conn.execute(
            "SELECT * FROM pending_events ORDER BY id"
        ).fetchall()
        ids = [r["id"] for r in rows]
        events = []
        for r in rows:
            e = {"level": r["level"], "code": r["code"], "message": r["message"],
                 "count": r["count"]}
            if r["store"]:
                e["store"] = r["store"]
            events.append(e)
        return ids, events

    def delete_events(self, ids: list[int]) -> None:
        if not ids:
            return
        self.conn.executemany(
            "DELETE FROM pending_events WHERE id = ?", [(i,) for i in ids]
        )
        self.conn.commit()

    def pending_event_count(self) -> int:
        return int(
            self.conn.execute("SELECT COUNT(*) FROM pending_events").fetchone()[0]
        )


class OverlapLock:
    """Cross-process mutual exclusion via BEGIN IMMEDIATE on a sibling lock database.

    A held write lock on the lock file never touches the main state.db, so the collector
    can still commit per-file inside a run while the lock is held.
    """

    def __init__(self, state_db: Path | None = None):
        base = state_db or state_path()
        self.path = base.with_name(base.name + ".lock")
        self.conn: sqlite3.Connection | None = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # timeout=0: another holder yields SQLITE_BUSY immediately instead of waiting.
        conn = sqlite3.connect(self.path, timeout=0)
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY)")
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT OR REPLACE INTO lock (id) VALUES (1)")
        except sqlite3.OperationalError:
            conn.close()
            return False
        self.conn = conn
        return True

    def release(self) -> None:
        if self.conn is None:
            return
        self.conn.rollback()
        self.conn.close()
        self.conn = None

    def __enter__(self) -> "OverlapLock":
        return self

    def __exit__(self, *exc) -> None:
        self.release()
