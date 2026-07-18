"""Command implementations: run | backfill | status | doctor.

run       one incremental pass: lock -> scan all stores -> upload changed -> heartbeat.
backfill  hash everything, ask the hub which it lacks (files/check), upload only those.
status    last run, pending/error files, config summary.
doctor    preflight checks; prints top excluded patterns so nothing silently disappears.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import config as config_mod
from . import __version__
from .scanner import Scanner, ScanItem, read_exact, read_range, hash_bytes, hash_file_prefix
from .state import State, OverlapLock, now_iso, state_path
from .transport import Transport, DevAuth, MtlsAuth, Upload, MIN_CURL_VERSION, normalize_thumbprint

# Multipart upload outcomes (enum, not a bool pair — a large file's fate is a small state machine:
# it either uploaded fresh bytes, matched bytes the hub already had, or failed).
MULTIPART_UPLOADED = "uploaded"
MULTIPART_UNCHANGED = "unchanged"
MULTIPART_FAILED = "failed"

# A verify-failure (hub reassembled the wrong bytes) or a transient error retries the whole
# create->parts->complete this many times before giving up and surfacing a heartbeat error.
MULTIPART_MAX_ATTEMPTS = 3

# R2 caps a multipart upload at 10000 parts. For a very large file the configured part size would
# blow past that, so we escalate the part size to ceil(size/10000); if even that exceeds the
# threshold (the safe ceiling under Cloudflare's 100MB edge cap) the file is unshippable and we
# refuse up front rather than upload thousands of parts only to fail on part 10001.
MULTIPART_MAX_PARTS = 10000

# The hub finalizes a multipart upload with a single R2 put (staging -> canonical), capped at 5 GiB
# (developers.cloudflare.com/r2/platform/limits). A larger file can't be finalized, so refuse it up
# front rather than upload gigabytes only for complete to fail. The realistic corpus max is a few GB.
MULTIPART_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024


def _oversize_refusal(size: int) -> str | None:
    """Refusal reason if `size` exceeds R2's 5GiB single-put finalize limit, else None. Callers check
    this BEFORE hashing so an unshippable multi-GB file isn't streamed end-to-end every run only to be
    refused; the recorded error state then keeps subsequent runs to a cheap size check."""
    if size > MULTIPART_MAX_FILE_BYTES:
        return (f"file of {size} bytes exceeds the {MULTIPART_MAX_FILE_BYTES}-byte R2 single-put "
                "finalize limit; not uploaded")
    return None


def _effective_part_size(size: int, configured: int, ceiling: int) -> tuple[int | None, str | None]:
    """(part_size, None) or (None, refusal_reason). Grows the part size just enough to keep the part
    count <= MULTIPART_MAX_PARTS, but never above `ceiling` (the multipart threshold, itself below the
    100MB edge cap). `configured` and `ceiling` are already floored at R2's 5MiB minimum by the config
    loader (see config._normalize_multipart), so a legal part is always produced."""
    needed = -(-size // MULTIPART_MAX_PARTS)  # ceil(size / 10000)
    if needed > ceiling:
        return None, (f"file of {size} bytes needs >= {needed}-byte parts to stay under "
                      f"{MULTIPART_MAX_PARTS} parts, exceeding the {ceiling}-byte part ceiling")
    return min(max(configured, needed), ceiling), None


# Warn-level scanner event codes that still mean a file was NOT captured this run (the DB was
# locked or its snapshot failed, so we skipped it). They gate backfill's exit code so an
# operator doesn't treat an incomplete pass as done. windows_mount_skipped is deliberately
# excluded: dropping /mnt/<drive> roots is expected policy, not an incomplete capture.
_SKIPPED_CODES = frozenset({"snapshot_timeout", "snapshot_failed"})


def build_auth(cfg: config_mod.Config):
    if cfg.auth == "dev":
        return DevAuth(cfg.machine_id)
    if cfg.auth == "mtls":
        return MtlsAuth(
            client_cert_path=cfg.client_cert_path,
            client_key_path=cfg.client_key_path,
            client_cert_thumbprint=cfg.client_cert_thumbprint,
        )
    raise ValueError(f"unknown auth mode {cfg.auth!r} (expected dev|mtls)")


def file_url(hub_url: str, machine_id: str, store: str, relpath: str) -> str:
    # machine_id and store are single path segments (encode '/' too); relpath keeps its '/'
    # separators. Otherwise a '/' in machine_id/store would shift the URL segments and the
    # hub would parse a different (machine, store, relpath) than local state / files/check.
    machine = urllib.parse.quote(machine_id, safe="")
    store_seg = urllib.parse.quote(store, safe="")
    encoded = urllib.parse.quote(relpath, safe="/")
    return f"{hub_url}/api/v1/files/{machine}/{store_seg}/{encoded}"


def mtime_iso(mtime_ns: int) -> str:
    dt = datetime.fromtimestamp(mtime_ns / 1e9, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _materialize(scanner: Scanner, data: bytes) -> str:
    fd, path = tempfile.mkstemp(dir=scanner.tmp_root, suffix=".body")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except OSError:
        _safe_unlink(path)
        raise
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
        with State(machine_id=cfg.machine_id, hub_url=cfg.hub_url) as st:
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
                # Snapshots bypass the fast path every run, so release each DB snapshot temp
                # file immediately — several large DBs would otherwise pile up under tmp_root
                # for the whole run and risk ENOSPC before later files are processed.
                _cleanup_snapshot(item)
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
        # Traversal/snapshot warnings (walk_error, snapshot_timeout) raised during the walk.
        events.extend(scanner.events)
        errors += sum(1 for e in scanner.events if e["level"] == "error")
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

    # Large files can't go through a single PUT: Cloudflare rejects a >100MB request body at the
    # edge with HTTP 413 before it reaches the Worker. Route them to the chunked multipart path,
    # which also never buffers the whole file (streaming hash + byte-range part reads).
    if item.size >= cfg.multipart_threshold_bytes:
        return _process_large_item(cfg, st, transport, item, row)

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

    try:
        body_path = _materialize(scanner, data)
    except OSError as e:
        # Temp dir full/unwritable (ENOSPC) mid-staging: record and keep going so the run
        # still finishes and heartbeats, rather than aborting all remaining files.
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "error",
                       error=f"stage failed: {e}")
        return ItemResult(changed=True, error=f"{item.relpath}: stage failed: {e}")
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


def _process_large_item(cfg, st: State, transport: Transport, item: ScanItem,
                        row) -> ItemResult:
    """Run-mode path for a file at/above the multipart threshold. Hashes by streaming (no full
    read), skips the wire when the hash is unchanged, else uploads via multipart. Memory stays
    bounded to one part throughout."""
    refusal = _oversize_refusal(item.size)
    if refusal is not None:
        # Unshippable — record the failure WITHOUT hashing the multi-GB file (every run would repeat
        # that full read). status='error' isn't fast-path-eligible, so a later run re-enters here and
        # re-refuses on the cheap size check alone, until size/mtime changes.
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns,
                       row.sha256 if row else "", "error", error=f"multipart: {refusal}"[:400])
        return ItemResult(changed=True, error=f"{item.relpath}: multipart failed: {refusal}")
    try:
        sha = hash_file_prefix(item.source_path, item.size)
    except OSError as e:
        if row:
            st.upsert_file(row.store, row.relpath, row.size, row.mtime_ns, row.sha256,
                           "error", error=f"read failed: {e}")
        return ItemResult(error=f"{item.relpath}: read failed: {e}")

    if row and row.sha256 == sha and row.status == "ok":
        # Content identical though metadata changed: refresh state, skip the wire.
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok")
        return ItemResult(changed=True)

    result, detail = _upload_multipart(cfg, transport, item, sha)
    if result == MULTIPART_UPLOADED:
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                       uploaded_size=item.size, uploaded_at=now_iso())
        return ItemResult(changed=True, uploaded=True, bytes=item.size)
    if result == MULTIPART_UNCHANGED:  # hub already had these exact bytes (dedup)
        st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                       uploaded_size=item.size, uploaded_at=now_iso())
        return ItemResult(changed=True)

    st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "error",
                   error=f"multipart: {detail}"[:400])
    return ItemResult(changed=True, error=f"{item.relpath}: multipart failed: {detail}")


def _multipart_query(base_url: str, upload_id: str, extra: str = "") -> str:
    return f"{base_url}?uploadId={urllib.parse.quote(upload_id, safe='')}{extra}"


def _multipart_create(transport: Transport, base_url: str, sha: str, mtime: str,
                      size: int) -> tuple[str | None, int, str]:
    """Open a multipart upload. Returns (upload_id, status, body). upload_id is None both when the
    hub already had these bytes (status 200) and on any error — the caller keys off status."""
    headers = {"x-content-hash": f"sha256:{sha}", "x-file-mtime": mtime, "x-file-size": str(size)}
    status, body = transport.request("POST", base_url + "?uploads", headers)
    if status == 201:
        try:
            return json.loads(body)["upload_id"], 201, body
        except (ValueError, KeyError, TypeError):
            return None, status, body
    return None, status, body


def _multipart_send_parts(transport: Transport, base_url: str, item: ScanItem, upload_id: str,
                          part_size: int, size: int) -> tuple[list[dict] | None, str | None]:
    """Upload every part sequentially via byte-range reads. Returns (parts, None) on success or
    (None, error_detail) on the first failure. Each part except the last is exactly part_size;
    the last carries the remainder and is flagged so the hub accepts it below the 5MiB floor."""
    num_parts = max(1, -(-size // part_size))
    parts: list[dict] = []
    for i in range(num_parts):
        offset = i * part_size
        length = min(part_size, size - offset)
        try:
            data = read_range(item.source_path, offset, length)
        except OSError as e:
            # Source truncated/removed/unreadable mid-upload: fail this file cleanly so the caller
            # aborts the upload and emits upload_failed, and the run continues to the next file.
            return None, f"read failed on part {i + 1}: {e}"
        if len(data) != length:
            return None, f"short read on part {i + 1}: got {len(data)} want {length}"
        part_no = i + 1
        # x-part-size lets the hub enforce R2's uniform-part-size rule server-side (every non-final
        # part == part_size); x-part-is-last flags the (possibly-smaller) tail so it isn't rejected.
        headers = {"x-part-size": str(part_size)}
        if i == num_parts - 1:
            headers["x-part-is-last"] = "1"
        url = _multipart_query(base_url, upload_id, f"&partNumber={part_no}")
        status, body = transport.put_part(url, data, headers)
        if status not in (200, 201):
            return None, f"part {part_no} HTTP {status}: {body[:200]}"
        try:
            etag = json.loads(body)["etag"]
        except (ValueError, KeyError, TypeError):
            return None, f"part {part_no} bad response: {body[:200]}"
        parts.append({"part_number": part_no, "etag": etag})
    return parts, None


def _multipart_abort(transport: Transport, base_url: str, upload_id: str) -> None:
    """Best-effort release of a dangling upload; the hub's abort is idempotent and the daily prune
    cron sweeps anything that still slips through, so a failure here is not fatal."""
    try:
        transport.request("DELETE", _multipart_query(base_url, upload_id))
    except Exception:  # noqa: BLE001 - abort is best-effort cleanup, never fail the run over it
        pass


def _upload_multipart(cfg, transport: Transport, item: ScanItem, sha: str) -> tuple[str, str | None]:
    """create -> parts -> complete, retried whole up to MULTIPART_MAX_ATTEMPTS. Any attempt that
    opened an upload but didn't complete is aborted before retrying (and on final give-up) so no
    dangling multipart is left. Returns (MULTIPART_*, detail)."""
    base_url = file_url(cfg.hub_url, cfg.machine_id, item.store, item.relpath)
    # Oversize (>5GiB) is refused by both callers BEFORE hashing (see _oversize_refusal); by here the
    # file is known-shippable, so we only need the part-size fit check.
    part_size, refusal = _effective_part_size(
        item.size, cfg.multipart_part_size_bytes, cfg.multipart_threshold_bytes)
    if part_size is None:
        return MULTIPART_FAILED, refusal  # too large to ship in <= 10000 parts; no bytes sent
    mtime = mtime_iso(item.mtime_ns)
    last_error: str | None = None
    for _attempt in range(MULTIPART_MAX_ATTEMPTS):
        upload_id, status, body = _multipart_create(transport, base_url, sha, mtime, item.size)
        if status == 200:  # hub already holds these exact bytes
            return MULTIPART_UNCHANGED, None
        if upload_id is None:  # transient create failure -> retry
            last_error = f"create HTTP {status}: {body[:200]}"
            continue

        parts, detail = _multipart_send_parts(transport, base_url, item, upload_id, part_size, item.size)
        if parts is not None:
            # complete re-declares the whole-object contract (hash/mtime/size) so the hub verifies
            # the reassembled object against the same sha256 the upload was opened with.
            complete_headers = {
                "x-content-hash": f"sha256:{sha}", "x-file-mtime": mtime, "x-file-size": str(item.size),
            }
            status, body = transport.post_json(_multipart_query(base_url, upload_id), {"parts": parts}, complete_headers)
            if status in (200, 201):
                return MULTIPART_UPLOADED, None
            detail = f"complete HTTP {status}: {body[:200]}"
        last_error = detail
        _multipart_abort(transport, base_url, upload_id)  # release before retrying
    return MULTIPART_FAILED, last_error or "multipart upload failed"


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
        with State(machine_id=cfg.machine_id, hub_url=cfg.hub_url) as st:
            return _do_backfill(cfg, st, concurrency, dry_run)
    finally:
        lock.release()


def _do_backfill(cfg, st: State, concurrency: int, dry_run: bool) -> int:
    transport = Transport(build_auth(cfg), parallel_max=concurrency)
    scanner = Scanner(cfg.effective_excludes())
    totals = {"scanned": 0, "already_present": 0, "uploaded": 0, "failed": 0,
              "bytes_uploaded": 0, "would_upload": 0, "read_errors": 0, "check_failures": 0}
    events = _windows_mount_events(cfg)
    try:
        # Bounded chunks: hash the chunk, ask the hub what it lacks (files/check),
        # materialize ONLY the missing bodies, upload, then delete them before the next
        # chunk. Peak temp/disk stays ~one chunk of missing files, never the whole corpus.
        for chunk in _chunked(_iter_store_items(cfg, scanner), BACKFILL_CHUNK):
            _backfill_chunk(cfg, st, transport, scanner, chunk, totals, events, dry_run)
        # Traversal/snapshot warnings (walk_error, snapshot_timeout) raised during the walk.
        events.extend(scanner.events)
    finally:
        scanner.close()

    if events:
        st.buffer_events(events)  # read/mount warnings surfaced on the next heartbeat
    summary = {"mode": "backfill", "scanned": totals["scanned"],
               "already_present": totals["already_present"],
               "read_errors": totals["read_errors"],
               "check_failures": totals["check_failures"]}
    if dry_run:
        summary["dry_run"] = True
        summary["would_upload"] = totals["would_upload"]
    else:
        summary["uploaded"] = totals["uploaded"]
        summary["failed"] = totals["failed"]
        summary["bytes_uploaded"] = totals["bytes_uploaded"]
    print(json.dumps(summary))
    # Nonzero when the backfill was incomplete, so scripts/operators don't move on: upload
    # failures, per-file read/staging errors, a files/check failure (the only source of truth
    # in dry-run), an error-level traversal event, or a DB we skipped because its snapshot
    # timed out / failed (those files never got captured this run — that's incomplete too).
    incomplete = (totals["failed"] or totals["read_errors"] or totals["check_failures"]
                  or any(e["level"] == "error" for e in events)
                  or any(e["code"] in _SKIPPED_CODES for e in events))
    return 1 if incomplete else 0


def _record_file_error(events, totals, item, e, code: str = "read_failed") -> None:
    totals["read_errors"] += 1
    events.append({"level": "error", "code": code,
                   "message": f"{item.relpath}: {e}"[:500], "count": 1, "store": item.store})


def _backfill_chunk(cfg, st: State, transport: Transport, scanner: Scanner,
                    items, totals: dict, events: list[dict], dry_run: bool) -> None:
    # Hash pass: stream each file's prefix (no bytes held, nothing written to disk).
    hashed: list[tuple[ScanItem, str]] = []
    for item in items:
        totals["scanned"] += 1
        if totals["scanned"] % 100 == 0:
            print(f"hashed {totals['scanned']} files...", file=sys.stderr)
        refusal = _oversize_refusal(item.size)
        if refusal is not None:
            # Unshippable — skip it BEFORE hashing (don't stream a multi-GB file just to refuse it).
            events.append({"level": "error", "code": "file_too_large",
                           "message": f"{item.relpath}: {refusal}"[:500], "count": 1, "store": item.store})
            if not dry_run:
                totals["failed"] += 1
                st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, "", "error",
                               error=f"backfill multipart: {refusal}"[:400])
            _cleanup_snapshot(item)
            continue
        try:
            sha = hash_file_prefix(item.source_path, item.size)
        except OSError as e:
            _record_file_error(events, totals, item, e)
            _cleanup_snapshot(item)
            continue
        hashed.append((item, sha))

    missing = _check_missing_chunk(cfg, transport,
                                   [(it.store, it.relpath, sha) for it, sha in hashed],
                                   totals, events)

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

    # Large files can't ride the parallel single-PUT batch (Cloudflare 413s a >100MB body); upload
    # each sequentially via multipart, reusing the streaming hash from the pass above. Small files
    # take the existing parallel batch path unchanged.
    large = [(it, sha) for it, sha in to_upload if it.size >= cfg.multipart_threshold_bytes]
    small = [(it, sha) for it, sha in to_upload if it.size < cfg.multipart_threshold_bytes]
    for item, sha in large:
        result, detail = _upload_multipart(cfg, transport, item, sha)
        if result in (MULTIPART_UPLOADED, MULTIPART_UNCHANGED):
            if result == MULTIPART_UPLOADED:
                totals["uploaded"] += 1
                totals["bytes_uploaded"] += item.size
            st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "ok",
                           uploaded_size=item.size, uploaded_at=now_iso())
        else:
            totals["failed"] += 1
            st.upsert_file(item.store, item.relpath, item.size, item.mtime_ns, sha, "error",
                           error=f"backfill multipart: {detail}"[:400])
        _cleanup_snapshot(item)

    # Materialize ONLY the missing small bodies, upload, then delete each body.
    bodies = []  # (item, sha2, body_path, nbytes, headers)
    uploads = []
    for item, _sha in small:
        try:
            data = read_exact(item.source_path, item.size)
        except OSError as e:
            _record_file_error(events, totals, item, e)
            _cleanup_snapshot(item)
            continue
        sha2 = hash_bytes(data)  # authoritative bytes+hash pair actually sent
        try:
            body_path = _materialize(scanner, data)
        except OSError as e:
            # Temp dir full/unwritable mid-staging: skip this file, keep going.
            _record_file_error(events, totals, item, e, code="write_failed")
            _cleanup_snapshot(item)
            continue
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


def _check_missing_chunk(cfg, transport: Transport, triples, totals: dict,
                         events: list[dict]) -> set[tuple[str, str]]:
    if not triples:
        return set()
    body = {"files": [{"store": s, "relpath": r, "sha256": h} for s, r, h in triples]}
    status, resp = transport.post_json(f"{cfg.hub_url}/api/v1/files/check", body)
    if status != 200:
        # files/check is the ONLY source of truth in dry-run; a non-200 must fail the command,
        # not silently report everything as would_upload. Non-dry-run still falls back to the
        # conservative treat-all-missing PUTs, but the failure is surfaced either way.
        totals["check_failures"] += 1
        events.append({"level": "error", "code": "check_failed",
                       "message": f"files/check HTTP {status}", "count": 1})
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
_CERT_EXPIRY_WARN_DAYS = 21


def _doctor_cert_store(thumbprint: str) -> bool:
    """Doctor check for the Windows/Schannel mTLS path: confirm the client cert is present in
    Cert:\\CurrentUser\\My and warn if it expires within ~3 weeks. Returns False only on a hard
    failure (cert missing / can't query) so a near-expiry warning doesn't fail the whole doctor."""
    tp = normalize_thumbprint(thumbprint)
    short = tp[:12] + ".."
    if not sys.platform.startswith("win"):
        print(f"[warn] client_cert_thumbprint set but this isn't Windows; can't verify the cert store ({short})")
        return True
    ps = (
        "$c = Get-Item ('Cert:\\CurrentUser\\My\\' + $env:AC_TP) -ErrorAction SilentlyContinue; "
        "if ($null -eq $c) { 'MISSING' } "
        "elseif (-not $c.HasPrivateKey) { 'NOPRIVKEY' } "
        "else { [int]($c.NotAfter - (Get-Date)).TotalDays }"
    )
    env = {**os.environ, "AC_TP": tp}
    try:
        proc = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
                              capture_output=True, text=True, env=env)
    except OSError as e:
        print(f"[FAIL] cert-store check couldn't run powershell: {e}")
        return False
    out = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""
    if out in ("", "MISSING"):
        print(f"[FAIL] mTLS cert not found in Cert:\\CurrentUser\\My ({short}); re-enroll with --import-pfx")
        return False
    if out == "NOPRIVKEY":
        # Cert present but no associated private key — Schannel can't complete the handshake, so the
        # first upload would fail with an opaque error. Happens when the .pem/.crt was imported instead
        # of the PFX. Point at the fix rather than letting doctor pass and the upload fail cryptically.
        print(f"[FAIL] mTLS cert {short} is in Cert:\\CurrentUser\\My but has NO private key; "
              f"import the PFX (not the .pem/.crt) via enroll --import-pfx")
        return False
    try:
        days = int(out)
    except ValueError:
        print(f"[warn] cert-store check returned unexpected output for {short}: {out[:80]}")
        return True
    if days < 0:
        print(f"[FAIL] mTLS cert {short} EXPIRED {-days}d ago; re-enroll")
        return False
    if days <= _CERT_EXPIRY_WARN_DAYS:
        print(f"[warn] mTLS cert {short} present but expires in {days}d — renew soon")
        return True
    print(f"[ok]   mTLS cert present in Cert:\\CurrentUser\\My ({short}), {days}d to expiry")
    return True


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

    transport = Transport(build_auth(cfg))
    try:
        version = transport.check_curl_version()
        print(f"[ok]   curl {'.'.join(map(str, version))} (>= "
              f"{'.'.join(map(str, MIN_CURL_VERSION))})")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] curl: {e}")
        ok = False

    # Windows/Schannel mTLS: the cert lives in the store, so verify it's actually there (and not
    # about to expire) — the analog of MtlsAuth's file-existence check for the PEM path.
    if cfg.auth == "mtls" and cfg.client_cert_thumbprint:
        ok = _doctor_cert_store(cfg.client_cert_thumbprint) and ok

    try:
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
            included = 0
            for item in scanner.scan_store(store, root):
                included += 1
                _cleanup_snapshot(item)  # doctor snapshots DBs too; delete each snap as we go
            excluded = sum(scanner.excluded_counts.get(store, {}).values())
            print(f"[ok]   store {store!r}: {included} files to capture, {excluded} excluded ({root})")
            for pat, n in scanner.top_excluded(store, 5):
                print(f"           excluded {n:>5}  {pat}")
        for e in scanner.events:
            is_error = e["level"] == "error"
            ok = ok and not is_error  # traversal errors mean the capture-all scan is incomplete
            print(f"[{'FAIL' if is_error else 'warn'}] {e['code']}: {e['message']}")
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
