"""Discover validated external raster images referenced by JSONL transcripts."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

from .scanner import first_matching_pattern

_DIGEST_RE = re.compile(r"^blob:sha256:([0-9a-fA-F]{64})$")
_BLOB_SEARCH_RE = re.compile(r"blob:sha256:[0-9a-fA-F]{64}")
_WINDOWS_ABS_RE = re.compile(r"^[A-Za-z]:[\\/]")
_SAFE_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_SAFE_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
             ".gif": "image/gif", ".webp": "image/webp"}
MAX_EXTERNAL_ASSET_BYTES = 5 * 1024 * 1024 * 1024
MAX_EXTERNAL_SCAN_LINE_CHARS = 16 * 1024 * 1024
MAX_EXTERNAL_ASSETS = 1024
MAX_EXTERNAL_EVENTS = 256


@dataclass(frozen=True)
class ExternalAsset:
    digest: str
    source_path: Path
    filename: str
    relpath: str
    size: int
    mtime_ns: int
    root_path: Path | None = None

@dataclass(frozen=True)
class AssetEvent:
    level: str
    code: str
    message: str


def safe_asset_filename(value: str | None) -> str:
    """Return the contract-safe basename for an external asset."""
    raw = str(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", raw)
    if len(safe) > 128:
        dot = safe.rfind(".")
        suffix = safe[dot:] if dot > 0 else ""
        safe = safe[:128 - len(suffix)] + suffix if suffix and len(suffix) < 128 else safe[:128]
    return safe or "asset"


def asset_relpath(parent_relpath: str, digest: str, filename: str) -> str:
    """Build the deterministic synthetic relpath used for an external asset."""
    digest = digest.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("digest must be 64-hex")
    return f"{parent_relpath}.assets/{digest}/{safe_asset_filename(filename)}"


def _windows_to_native(value: str) -> Path:
    if os.name == "nt":
        return Path(value.replace("/", "\\"))
    match = _WINDOWS_ABS_RE.match(value)
    if not match:
        return Path(value)
    drive = value[0].lower()
    tail = value[2:].replace("\\", "/").lstrip("/")
    return Path("/mnt") / drive / tail


def resolve_declared_path(value: str, cwd: str | Path) -> Path:
    """Resolve POSIX, native Windows, and WSL-shaped paths relative to declared cwd."""
    source = _windows_to_native(value)
    root = _windows_to_native(str(cwd))
    if not source.is_absolute():
        source = root / source

    return source

def _descriptor_target(fd: int) -> Path | None:
    """Return the canonical target of an open descriptor when the platform exposes one."""
    for link in (f"/proc/self/fd/{fd}", f"/dev/fd/{fd}"):
        try:
            target = os.readlink(link)
            if target:
                return Path(target).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
    return None


def open_external_asset(path: Path, root: Path | None = None) -> BinaryIO:
    """Open one validated asset without following a replacement symlink."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        opened_stat = os.fstat(fd)
        if not stat.S_ISREG(opened_stat.st_mode):
            raise OSError(f"external asset is not a regular file: {path}")
        if root is not None:
            root_real = root.resolve(strict=True)
            descriptor_target = _descriptor_target(fd)
            if descriptor_target is not None:
                try:
                    descriptor_target.relative_to(root_real)
                except ValueError as e:
                    raise OSError(f"external asset escaped declared root: {path}") from e
            else:
                # Without a descriptor link, verify both the resolved path boundary and that the
                # opened inode still belongs to the path we checked. Any uncertainty is a rejection.
                try:
                    path_real = path.resolve(strict=True)
                    path_real.relative_to(root_real)
                    path_stat = path.stat()
                except (OSError, RuntimeError, ValueError) as e:
                    raise OSError(f"external asset escaped declared root: {path}") from e
                path_identity = (getattr(path_stat, "st_dev", 0), getattr(path_stat, "st_ino", 0))
                opened_identity = (getattr(opened_stat, "st_dev", 0), getattr(opened_stat, "st_ino", 0))
                if path_identity == (0, 0) or opened_identity == (0, 0) or path_identity != opened_identity:
                    raise OSError(f"external asset changed while opening: {path}")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _walk_values(value) -> Iterator[str]:
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            yield current
            continue
        if isinstance(current, dict):
            stack.extend(reversed(list(current.values())))
            continue
        if isinstance(current, list):
            stack.extend(reversed(current))


def _image_items(value, inherited_source: str | None = None) -> Iterator[dict]:
    stack = [(value, inherited_source)]
    while stack:
        current, inherited = stack.pop()
        if isinstance(current, dict):
            details = current.get("details")
            own_details = isinstance(details, dict) and isinstance(details.get("meta"), dict)
            own_source = _source_value(current) if own_details else None
            source_value = own_source if own_details else inherited
            candidate = current
            if str(current.get("type", "")).lower() == "image":
                if source_value and not own_details:
                    candidate = {**current, "details": {"meta": {"source": {"value": source_value}}}}
                yield candidate
            children = list(candidate.values())
            stack.extend((child, source_value) for child in reversed(children))
            continue
        if isinstance(current, list):
            stack.extend((child, inherited) for child in reversed(current))

def _source_value(item: dict) -> str | None:
    details = item.get("details")
    if not isinstance(details, dict):
        return None
    meta = details.get("meta")
    if not isinstance(meta, dict):
        return None
    source = meta.get("source")
    if not isinstance(source, dict):
        return None
    value = source.get("value")
    return value if isinstance(value, str) and value else None

def _mime(item: dict, source: Path) -> str | None:
    values: list[str] = []
    keys = ("mime", "mime_type", "mimeType", "media_type", "mediaType")
    for key in keys:
        if isinstance(item.get(key), str):
            values.append(item[key])
    src = item.get("source")
    if isinstance(src, dict):
        sources = [src]
    else:
        details = item.get("details")
        meta = details.get("meta") if isinstance(details, dict) else None
        nested = meta.get("source") if isinstance(meta, dict) else None
        sources = [nested] if isinstance(nested, dict) else []
    for source_value in sources:
        for key in keys:
            if isinstance(source_value.get(key), str):
                values.append(source_value[key])
    ext_mime = _SAFE_EXT.get(source.suffix.lower())
    normalized = [v.lower().split(";", 1)[0].strip() for v in values]
    # Tool renderers can transcode the captured bytes before recording metadata (for example,
    # a PNG source may be reported as image/webp). The source extension is the storage/viewer
    # contract and the content hash below verifies the bytes; reject only unsupported declared
    # media types, then use the safe source extension as the canonical MIME.
    if ext_mime is None or any(v not in _SAFE_MIME for v in normalized):
        return None
    return ext_mime


def iter_jsonl_records(transcript: Path) -> Iterator[dict | None]:
    """Yield valid object records, or None for an oversized line, without retaining it."""
    limit = MAX_EXTERNAL_SCAN_LINE_CHARS
    with transcript.open("r", encoding="utf-8", errors="replace") as lines:
        while True:
            line = lines.readline(limit + 1)
            if not line:
                break
            oversized = len(line) > limit
            if len(line) == limit and not line.endswith("\n"):
                continuation = lines.read(1)
                oversized = bool(continuation)
                if oversized:
                    line = continuation
            if oversized:
                while line and not line.endswith("\n"):
                    line = lines.readline(limit + 1)
                yield None
                continue
            try:
                record = json.loads(line)
            except (ValueError, TypeError, RecursionError):
                continue
            if isinstance(record, dict):
                yield record


def _event(code: str, digest: str | None = None, filename: str | None = None) -> AssetEvent:
    bits = [x for x in (digest, safe_asset_filename(filename) if filename else None) if x]
    suffix = " " + "/".join(bits) if bits else ""
    return AssetEvent("warn", code, f"external asset rejected{suffix}")


def _append_event(events: list[AssetEvent], event: AssetEvent) -> None:
    if len(events) < MAX_EXTERNAL_EVENTS:
        events.append(event)


def discover_external_assets(transcript: Path, parent_relpath: str, cwd: str | Path | None,
                             excludes: list[str] | None = None) -> tuple[list[ExternalAsset], list[AssetEvent]]:
    """Stream a JSONL transcript and return validated external image refs plus safe events."""
    unique: dict[str, ExternalAsset] = {}
    events: list[AssetEvent] = []
    declared_cwd = str(cwd) if cwd else None
    try:
        for record in iter_jsonl_records(transcript):
            if record is None:
                _append_event(events, _event("line_too_large"))
                continue
            for candidate in (record.get("cwd"), record.get("payload", {}).get("cwd")
                              if isinstance(record.get("payload"), dict) else None):
                if declared_cwd is None and isinstance(candidate, str) and candidate.strip():
                    declared_cwd = candidate
            for item in _image_items(record):
                values = _walk_values(item)
                has_blob = False
                blob = None
                for value in values:
                    if value.startswith("blob:sha256:"):
                        has_blob = True
                    if blob is None and _BLOB_SEARCH_RE.fullmatch(value):
                        blob = value
                if not has_blob:
                    continue
                source_value = _source_value(item)
                filename = safe_asset_filename(source_value)
                match = _DIGEST_RE.fullmatch(blob or "")
                if not match:
                    _append_event(events, _event("invalid_digest", filename=filename))
                    continue
                digest = match.group(1).lower()
                if not source_value or not declared_cwd:
                    _append_event(events, _event("missing_source_or_cwd", digest, filename))
                    continue
                # Absolute Windows paths are normalized before applying the session-cwd boundary.
                source = resolve_declared_path(source_value, declared_cwd).expanduser()
                try:
                    root_real = Path(_windows_to_native(str(declared_cwd))).expanduser().resolve(strict=True)
                    if source.is_symlink():
                        _append_event(events, _event("not_regular_file", digest, filename))
                        continue
                    source_real = source.resolve(strict=True)
                    source_real.relative_to(root_real)
                except (OSError, RuntimeError, ValueError):
                    _append_event(events, _event("outside_cwd_or_missing", digest, filename))
                    continue
                if not source_real.is_file():
                    _append_event(events, _event("not_regular_file", digest, filename))
                    continue
                rel = source_real.relative_to(root_real).as_posix()
                if first_matching_pattern(rel, excludes or []):
                    _append_event(events, _event("excluded", digest, filename))
                    continue
                ext_mime = _SAFE_EXT.get(source_real.suffix.lower())
                mime = _mime(item, source_real)
                if not ext_mime or mime not in _SAFE_MIME:
                    _append_event(events, _event("unsupported_image_type", digest, filename))
                    continue
                relpath = asset_relpath(parent_relpath, digest, filename)
                if relpath in unique:
                    continue
                if len(unique) >= MAX_EXTERNAL_ASSETS:
                    _append_event(events, _event("asset_limit"))
                    break
                try:
                    with open_external_asset(source_real, root_real) as source_file:
                        file_stat = os.fstat(source_file.fileno())
                        if file_stat.st_size > MAX_EXTERNAL_ASSET_BYTES:
                            _append_event(events, _event("asset_too_large", digest, filename))
                            continue
                        h = hashlib.sha256()
                        size = 0
                        oversized = False
                        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                            if size + len(chunk) > MAX_EXTERNAL_ASSET_BYTES:
                                oversized = True
                                break
                            h.update(chunk)
                            size += len(chunk)
                    if oversized:
                        _append_event(events, _event("asset_too_large", digest, filename))
                        continue
                    if h.hexdigest() != digest:
                        _append_event(events, _event("digest_mismatch", digest, filename))
                        continue
                except OSError:
                    _append_event(events, _event("asset_read_failed", digest, filename))
                    continue
                unique[relpath] = ExternalAsset(digest, source_real, filename,
                                                relpath, size, file_stat.st_mtime_ns, root_real)
    except OSError:
        _append_event(events, _event("asset_read_failed"))
    return [unique[k] for k in sorted(unique)], events


