"""Command implementations: run | backfill | status | doctor.

run       one incremental pass: lock -> scan all stores -> upload changed -> heartbeat.
backfill  hash everything, ask the hub which it lacks (files/check), upload only those.
status    last run, pending/error files, config summary.
doctor    preflight checks; prints top excluded patterns so nothing silently disappears.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import config as config_mod
from . import __version__
from .scanner import Scanner, ScanItem, read_exact, hash_bytes, hash_file_prefix
from .state import State, OverlapLock, now_iso, state_path
from .transport import Transport, DevAuth, MtlsAuth, Upload


def build_auth(cfg: config_mod.Config):
    if cfg.auth == "dev":
        return DevAuth(cfg.machine_id)
    if cfg.auth == "mtls":
        return MtlsAuth()
    raise ValueError(f"unknown auth mode {cfg.auth!r} (expected dev|mtls)")


def file_url(hub_url: str, machine_id: str, store: str, relpath: str) -> str:
    encoded = urllib.parse.quote(relpath, safe="/")
    return f"{hub_url}/api/v1/files/{machine_id}/{store}/{encoded}"


def mtime_iso(mtime_ns: int) -> str:
    dt = datetime.fromtimestamp(mtime_ns / 1e9, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _materialize(scanner: Scanner, data: bytes) -> str:
    fd, path = tempfile.mkstemp(dir=scanner.tmp_root, suffix=".body")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


@dataclass
class ItemResult:
    changed: bool = False
    uploaded: bool = False
    bytes: int = 0
    error: str | None = None


# --------------------------------------------------------------------------- run
def cmd_run(args) -> int:
    cfg = config_mod.load(getattr(args, "config", None))
    lock = OverlapLock()
    if not lock.acquire():
        print("another collector run holds the lock; exiting cleanly", file=sys.stderr)
        return 0
    try:
        with State() as st:
            return _do_run(cfg, st)
    finally:
        lock.release()


def _do_run(cfg: config_mod.Config, st: State) -> int:
    transport = Transport(build_auth(cfg))
    run_id = st.start_run("run")
    stats = {
        name: {"files_seen": 0, "files_uploaded": 0, "bytes_uploaded": 0}
        for name in cfg.stores
    }
    events: list[dict] = _windows_mount_events(cfg)
    scanned = changed = uploaded = total_bytes = errors = 0

    scanner = Scanner(cfg.effective_excludes())
    try:
        for store, root in cfg.store_roots().items():
            stats.setdefault(store, {"files_seen": 0, "files_uploaded": 0, "bytes_uploaded": 0})
            for item in scanner.scan_store(store, root):
                scanned += 1
                stats[store]["files_seen"] += 1
                res = _process_item(cfg, st, transport, scanner, item)
                if res.changed:
                    changed += 1
                if res.uploaded:
                    uploaded += 1
                    total_bytes += res.bytes
                    stats[store]["files_uploaded"] += 1
                    stats[store]["bytes_uploaded"] += res.bytes
                if res.error:
                    errors += 1
                    events.append({
                        "level": "error", "code": "upload_failed",
                        "message": res.error[:500], "count": 1, "store": store,
                    })
    finally:
        scanner.close()

    st.finish_run(run_id, scanned, changed, uploaded, total_bytes, errors)
    _heartbeat(cfg, st, transport, stats, events)
    print(json.dumps({
        "mode": "run", "files_scanned": scanned, "files_changed": changed,
        "files_uploaded": uploaded, "bytes_uploaded": total_bytes, "errors": errors,
    }))
    return 0


def _process_item(cfg, st: State, transport: Transport, scanner: Scanner, item: ScanItem) -> ItemResult:
    row = st.get_file(item.store, item.relpath)
    # Fast path: identical size+mtime and last upload succeeded -> no hash, no upload.
    # SQLite snapshots are EXCLUDED from the fast path: a WAL commit can change DB content
    # while the main file's size+mtime stay identical, so we always snapshot+hash and let
    # hash-idempotency below skip the upload when the (deterministic) snapshot is unchanged.
    if (not item.is_snapshot and row and row.size == item.size
            and row.mtime_ns == item.mtime_ns and row.status == "ok"):
        st.touch_seen(item.store, item.relpath)
        return ItemResult(changed=False)

    try:
        data = read_exact(item.source_path, item.size)
    except OSError as e:
        # File vanished/changed perms between scan and read: record and keep going.
        if row:
            st.upsert_file(row.store, row.relpath, row.size, row.mtime_ns, row.sha256,
                           "error", error=f"read failed: {e}")
        return ItemResult(error=f"{item.relpath}: read failed: {e}")
    sha = hash_bytes(data)

    if row and row.sha256 == sha and row.status == "ok":
        # Content identical though metadata changed: refresh state, skip the wire.
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok")
        return ItemResult(changed=True)

    body_path = _materialize(scanner, data)
    url = file_url(cfg.hub_url, cfg.machine_id, item.store, item.relpath)
    headers = {"x-content-hash": f"sha256:{sha}", "x-file-mtime": mtime_iso(item.mtime_ns)}
    status, body = transport.put(url, Path(body_path), headers)
    Path(body_path).unlink(missing_ok=True)

    if status == 201:
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                       uploaded_size=len(data), uploaded_at=now_iso())
        return ItemResult(changed=True, uploaded=True, bytes=len(data))
    if status == 200:  # hub already had this exact content (dedup)
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                       uploaded_size=len(data), uploaded_at=now_iso())
        return ItemResult(changed=True)

    st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "error",
                   error=f"{status}: {body[:400]}")
    return ItemResult(changed=True, error=f"{item.relpath}: HTTP {status} {body[:200]}")


def _heartbeat(cfg, st: State, transport: Transport, stats: dict, run_events: list[dict]) -> bool:
    ids, buffered = st.drain_events()
    body = {"collector_version": __version__, "stores": stats, "events": buffered + run_events}
    status, _resp = transport.post_json(f"{cfg.hub_url}/api/v1/heartbeat", body)
    if status == 200:
        st.delete_events(ids)  # previously-buffered events acknowledged
        return True
    # Heartbeat failed: persist this run's events so the next heartbeat drains them.
    st.buffer_events(run_events)
    return False


# ---------------------------------------------------------------------- backfill
BACKFILL_CHUNK = 500  # <= hub files/check batch limit (1000)


def _windows_mount_events(cfg) -> list[dict]:
    """Warning events for store roots dropped by the WSL windows-mount guard, so the skip
    is visible in the heartbeat (doctor already prints it)."""
    return [
        {"level": "warn", "code": "windows_mount_skipped",
         "message": f"store {name!r} root {root} under /mnt skipped "
                    "(include_windows_mounts=false)",
         "count": 1, "store": name}
        for name, root in cfg.dropped_store_roots().items()
    ]


def _safe_unlink(path) -> None:
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def _cleanup_snapshot(item: ScanItem) -> None:
    """Delete a DB snapshot temp file once we're done with it, bounding temp use."""
    if item.is_snapshot:
        _safe_unlink(item.source_path)


def _iter_store_items(cfg, scanner: Scanner):
    for store, root in cfg.store_roots().items():
        yield from scanner.scan_store(store, root)


def _chunked(iterable, n):
    batch = []
    for x in iterable:
        batch.append(x)
        if len(batch) == n:
            yield batch
            batch = []
    if batch:
        yield batch


def cmd_backfill(args) -> int:
    cfg = config_mod.load(getattr(args, "config", None))
    concurrency = getattr(args, "concurrency", 6)
    dry_run = getattr(args, "dry_run", False)
    lock = OverlapLock()
    if not lock.acquire():
        print("another collector run holds the lock; exiting cleanly", file=sys.stderr)
        return 0
    try:
        with State() as st:
            return _do_backfill(cfg, st, concurrency, dry_run)
    finally:
        lock.release()


def _do_backfill(cfg, st: State, concurrency: int, dry_run: bool) -> int:
    transport = Transport(build_auth(cfg), parallel_max=concurrency)
    scanner = Scanner(cfg.effective_excludes())
    totals = {"scanned": 0, "already_present": 0, "uploaded": 0, "failed": 0,
              "bytes_uploaded": 0, "would_upload": 0, "read_errors": 0}
    events = _windows_mount_events(cfg)
    try:
        # Bounded chunks: hash the chunk, ask the hub what it lacks (files/check),
        # materialize ONLY the missing bodies, upload, then delete them before the next
        # chunk. Peak temp/disk stays ~one chunk of missing files, never the whole corpus.
        for chunk in _chunked(_iter_store_items(cfg, scanner), BACKFILL_CHUNK):
            _backfill_chunk(cfg, st, transport, scanner, chunk, totals, events, dry_run)
    finally:
        scanner.close()

    if events:
        st.buffer_events(events)  # read/mount warnings surfaced on the next heartbeat
    summary = {"mode": "backfill", "scanned": totals["scanned"],
               "already_present": totals["already_present"],
               "read_errors": totals["read_errors"]}
    if dry_run:
        summary["dry_run"] = True
        summary["would_upload"] = totals["would_upload"]
    else:
        summary["uploaded"] = totals["uploaded"]
        summary["failed"] = totals["failed"]
        summary["bytes_uploaded"] = totals["bytes_uploaded"]
    print(json.dumps(summary))
    return 0


def _record_read_error(events, totals, item, e) -> None:
    totals["read_errors"] += 1
    events.append({"level": "error", "code": "read_failed",
                   "message": f"{item.relpath}: {e}"[:500], "count": 1, "store": item.store})


def _backfill_chunk(cfg, st: State, transport: Transport, scanner: Scanner,
                    items, totals: dict, events: list[dict], dry_run: bool) -> None:
    # Hash pass: stream each file's prefix (no bytes held, nothing written to disk).
    hashed: list[tuple[ScanItem, str]] = []
    for item in items:
        totals["scanned"] += 1
        if totals["scanned"] % 100 == 0:
            print(f"hashed {totals['scanned']} files...", file=sys.stderr)
        try:
            sha = hash_file_prefix(item.source_path, item.size)
        except OSError as e:
            _record_read_error(events, totals, item, e)
            _cleanup_snapshot(item)
            continue
        hashed.append((item, sha))

    missing = _check_missing_chunk(cfg, transport,
                                   [(it.store, it.relpath, sha) for it, sha in hashed])

    to_upload: list[tuple[ScanItem, str]] = []
    for item, sha in hashed:
        if (item.store, item.relpath) in missing:
            to_upload.append((item, sha))
            continue
        # Hub already has it: record ok locally so run mode fast-paths it. No disk write.
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                       uploaded_size=item.size)
        totals["already_present"] += 1
        _cleanup_snapshot(item)

    if dry_run:
        totals["would_upload"] += len(to_upload)
        for item, _sha in to_upload:
            _cleanup_snapshot(item)
        return

    # Materialize ONLY the missing bodies, upload, then delete each body.
    bodies = []  # (item, sha2, body_path, nbytes, headers)
    uploads = []
    for item, _sha in to_upload:
        try:
            data = read_exact(item.source_path, item.size)
        except OSError as e:
            _record_read_error(events, totals, item, e)
            _cleanup_snapshot(item)
            continue
        sha2 = hash_bytes(data)  # authoritative bytes+hash pair actually sent
        body_path = _materialize(scanner, data)
        headers = {"x-content-hash": f"sha256:{sha2}",
                   "x-file-mtime": mtime_iso(item.mtime_ns)}
        url = file_url(cfg.hub_url, cfg.machine_id, item.store, item.relpath)
        bodies.append((item, sha2, body_path, len(data), headers))
        uploads.append(Upload(url, body_path, headers))

    codes = transport.upload_batch(uploads) if uploads else {}
    for item, sha2, body_path, nbytes, headers in bodies:
        url = file_url(cfg.hub_url, cfg.machine_id, item.store, item.relpath)
        code = codes.get(url, 0)
        if code not in (200, 201):
            code, _b = transport.put(url, Path(body_path), headers)
        if code in (200, 201):
            totals["uploaded"] += 1
            totals["bytes_uploaded"] += nbytes
            st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha2, "ok",
                           uploaded_size=nbytes, uploaded_at=now_iso())
        else:
            totals["failed"] += 1
            st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha2,
                           "error", error=f"backfill HTTP {code}")
        _safe_unlink(body_path)
        _cleanup_snapshot(item)


def _check_missing_chunk(cfg, transport: Transport, triples) -> set[tuple[str, str]]:
    if not triples:
        return set()
    body = {"files": [{"store": s, "relpath": r, "sha256": h} for s, r, h in triples]}
    status, resp = transport.post_json(f"{cfg.hub_url}/api/v1/files/check", body)
    if status != 200:
        return {(s, r) for s, r, _ in triples}  # conservative: treat all as missing
    return {(m["store"], m["relpath"]) for m in json.loads(resp).get("missing", [])}


# ------------------------------------------------------------------------ status
def cmd_status(args) -> int:
    cfg = config_mod.load(getattr(args, "config", None))
    with State() as st:
        last = st.last_run()
        counts = st.counts_by_status()
        errors = st.error_files()
        pending = st.pending_event_count()

    print("config:")
    print(f"  machine_id: {cfg.machine_id}")
    print(f"  hub_url:    {cfg.hub_url}")
    print(f"  auth:       {cfg.auth}")
    print(f"  stores:     {', '.join(f'{k}={v}' for k, v in cfg.stores.items())}")
    print("last run:")
    print(f"  {json.dumps(last) if last else 'none'}")
    print("files by status:")
    for status, n in sorted(counts.items()):
        print(f"  {status}: {n}")
    print(f"pending heartbeat events: {pending}")
    if errors:
        print("error files:")
        for row in errors[:20]:
            print(f"  {row.store}/{row.relpath}: {row.error}")
    return 0


# ------------------------------------------------------------------------ doctor
def cmd_doctor(args) -> int:
    ok = True
    cfg = None
    try:
        cfg = config_mod.load(getattr(args, "config", None))
        print(f"[ok]   config readable: {cfg.source}")
    except Exception as e:  # noqa: BLE001 - doctor reports, never raises
        print(f"[FAIL] config: {e}")
        return 1

    try:
        # Opening State runs the schema DDL and commits, which proves writability
        # without polluting the runs table that `status` reports as the last run.
        with State() as st:
            st.pending_event_count()
        print(f"[ok]   state DB writable: {state_path()}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] state DB: {e}")
        ok = False

    try:
        transport = Transport(build_auth(cfg))
        status, _body = transport.get(f"{cfg.hub_url}/healthz")
        mark = "ok" if status == 200 else "FAIL"
        ok = ok and status == 200
        print(f"[{mark}] hub reachable: GET {cfg.hub_url}/healthz -> {status}")
    except NotImplementedError as e:
        print(f"[warn] hub check skipped: {e}")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] hub check: {e}")
        ok = False

    scanner = Scanner(cfg.effective_excludes())
    try:
        for store, root in cfg.store_roots().items():
            if not root.exists():
                print(f"[warn] store {store!r} root missing: {root}")
                continue
            included = sum(1 for _ in scanner.scan_store(store, root))
            excluded = sum(scanner.excluded_counts.get(store, {}).values())
            print(f"[ok]   store {store!r}: {included} files to capture, {excluded} excluded ({root})")
            for pat, n in scanner.top_excluded(store, 5):
                print(f"           excluded {n:>5}  {pat}")
    finally:
        scanner.close()

    tag = config_mod.detect_platform_tag()
    if tag == "wsl":
        if cfg.include_windows_mounts:
            print("[warn] WSL + include_windows_mounts=true: Windows-mount roots will be scanned")
        else:
            print("[ok]   WSL detected; include_windows_mounts=false (no /mnt/<drive> scanning)")
            for name, root in cfg.dropped_store_roots().items():
                print(f"[ok]   store {name!r} root {root} skipped (under /mnt)")

    return 0 if ok else 1
