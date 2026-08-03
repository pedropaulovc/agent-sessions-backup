import hashlib
import json
import os
from pathlib import Path

import pytest

from agent_collector import external_images
from agent_collector import config
from agent_collector import run as run_mod
from agent_collector.external_images import (
    ExternalAsset,
    asset_relpath,
    discover_external_assets,
    open_external_asset,
    resolve_declared_path,
    safe_asset_filename,
)
from agent_collector.state import State
from agent_collector.transport import Transport


def _transcript(path: Path, cwd: str, digest: str, source: str) -> None:
    path.write_text(
        json.dumps({"type": "session_meta", "cwd": cwd}) + "\n"
        + json.dumps({"type": "tool_result", "content": [{
            "type": "image", "data": f"blob:sha256:{digest}",
            "details": {"meta": {"source": {"value": source}}},
        }]}) + "\n"
    )


def test_discovery_validates_hash_containment_and_relpath(tmp_path):
    image = tmp_path / "001_img01.jpeg"
    body = b"jpeg bytes"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = tmp_path / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(image))

    assets, events = discover_external_assets(transcript, "projects/session.jsonl", None, [])

    assert not events
    assert assets[0].relpath == asset_relpath("projects/session.jsonl", digest, "001_img01.jpeg")
    assert assets[0].source_path == image


def test_discovery_inherits_tool_result_source_for_nested_image(tmp_path):
    image = tmp_path / "001_img01.jpeg"
    body = b"nested jpeg bytes"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({
        "type": "message",
        "cwd": str(tmp_path),
        "message": {
            "role": "toolResult",
            "content": [
                {"type": "text", "text": "Read image file [image/jpeg]"},
                {"type": "image", "data": f"blob:sha256:{digest}", "mimeType": "image/jpeg"},
            ],
            "details": {
                "fileSize": len(body),
                "meta": {"source": {"type": "path", "value": str(image)}},
            },
        },
    }) + "\n")

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not events
    assert assets[0].source_path == image


def test_discovery_requires_declared_cwd_for_absolute_source(tmp_path):
    image = tmp_path / "outside-workspace.jpeg"
    body = b"absolute jpeg bytes"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({
        "type": "tool_result",
        "content": [{
            "type": "image",
            "data": f"blob:sha256:{digest}",
            "mimeType": "image/jpeg",
            "details": {"meta": {"source": {"value": str(image)}}},
        }],
    }) + "\n")

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not assets
    assert any(e.code == "missing_source_or_cwd" for e in events)

def test_discovery_rejects_mismatch_and_escape(tmp_path):
    image = tmp_path / "image.png"
    image.write_bytes(b"not the digest")
    transcript = tmp_path / "session.jsonl"
    _transcript(transcript, str(tmp_path), "0" * 64, str(image))
    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])
    assert not assets
    assert any(e.code == "digest_mismatch" for e in events)

    outside = tmp_path.parent / "outside.jpeg"
    outside.write_bytes(b"outside")
    digest = hashlib.sha256(outside.read_bytes()).hexdigest()
    _transcript(transcript, str(tmp_path), digest, f"../{outside.name}")
    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])
    assert not assets
    assert any(e.code == "outside_cwd_or_missing" for e in events)


def test_discovery_rejects_symlink(tmp_path):
    target = tmp_path / "target.jpeg"
    target.write_bytes(b"target")
    link = tmp_path / "linked.jpeg"
    link.symlink_to(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    transcript = tmp_path / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(link))

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not assets
    assert any(e.code == "not_regular_file" for e in events)

def test_open_external_asset_rejects_symlink(tmp_path):
    if not getattr(os, "O_NOFOLLOW", 0):
        pytest.skip("O_NOFOLLOW is unavailable")
    target = tmp_path / "target.jpeg"
    target.write_bytes(b"target")
    link = tmp_path / "linked.jpeg"
    link.symlink_to(target)

    with pytest.raises(OSError):
        open_external_asset(link)



def test_open_external_asset_enforces_descriptor_root(tmp_path):
    if os.name != "posix":
        pytest.skip("/proc descriptor paths are unavailable")
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.jpeg"
    outside.write_bytes(b"outside")

    with pytest.raises(OSError):
        open_external_asset(outside, root)


def test_discovery_enforces_asset_size_during_hash(monkeypatch, tmp_path):
    monkeypatch.setattr(external_images, "MAX_EXTERNAL_ASSET_BYTES", 4)
    image = tmp_path / "001_img01.jpeg"
    body = b"12345"
    image.write_bytes(body)
    transcript = tmp_path / "session.jsonl"
    _transcript(transcript, str(tmp_path), hashlib.sha256(body).hexdigest(), str(image))

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not assets
    assert any(e.code == "asset_too_large" for e in events)


def test_snapshot_enforces_asset_size_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(run_mod, "MAX_EXTERNAL_ASSET_BYTES", 4)
    image = tmp_path / "001_img01.jpeg"
    body = b"12345"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    asset = ExternalAsset(
        digest,
        image,
        image.name,
        asset_relpath("session.jsonl", digest, image.name),
        len(body),
        image.stat().st_mtime_ns,
        tmp_path,
    )

    with run_mod.Scanner([]) as scanner:
        item, error = run_mod._snapshot_external_asset(scanner, "omp", asset)

    assert item is None
    assert error is not None and "size limit" in error


def test_discovery_does_not_inherit_explicit_empty_source(tmp_path):
    image = tmp_path / "001_img01.jpeg"
    body = b"jpeg bytes"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({
        "type": "message",
        "cwd": str(tmp_path),
        "details": {"meta": {"source": {"value": str(image)}}},
        "message": {"content": [{
            "type": "image",
            "data": f"blob:sha256:{digest}",
            "mimeType": "image/jpeg",
            "details": {"meta": {"source": {"value": ""}}},
        }]},
    }) + "\n")

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not assets
    assert any(e.code == "missing_source_or_cwd" for e in events)



def test_safe_filename_and_windows_path_shape(tmp_path):
    assert safe_asset_filename(r"C:\src\a b?.jpeg") == "a_b_.jpeg"
    assert safe_asset_filename("a" * 130 + ".jpeg") == "a" * 123 + ".jpeg"
    assert resolve_declared_path(r"C:\src\a.jpeg", r"C:\src") == Path("/mnt/c/src/a.jpeg")


def test_discovery_bounds_oversized_jsonl_lines(monkeypatch, tmp_path):
    monkeypatch.setattr(external_images, "MAX_EXTERNAL_SCAN_LINE_CHARS", 512)
    image = tmp_path / "001_img01.jpeg"
    body = b"bounded jpeg"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("x" * 600 + "\n")
    _transcript(transcript, str(tmp_path), digest, str(image))

    assets, events = discover_external_assets(transcript, "session.jsonl", None, [])

    assert not events
    assert assets[0].source_path == image


pytestmark = pytest.mark.skipif(not Transport.curl_available(), reason="system curl not available")


def test_run_uploads_external_asset_and_is_idempotent(tmp_path, hub):
    root = tmp_path / "omp"
    root.mkdir()
    image = tmp_path / "001_img01.jpeg"
    body = b"external jpeg"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = root / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(image))
    cfg = config.Config(machine_id="m1", hub_url=hub.url, auth="dev", stores={"omp": str(root)})

    with State(tmp_path / "state.db") as st:
        assert run_mod._do_run(cfg, st) == 0
        assert run_mod._do_run(cfg, st) == 0
    key = ("m1", "omp", f"session.jsonl.assets/{digest}/001_img01.jpeg")
    assert hub.files[key]["body"] == body


def test_run_retries_external_asset_after_source_appears(tmp_path, hub):
    root = tmp_path / "omp"
    root.mkdir()
    image = tmp_path / "001_img01.jpeg"
    body = b"late external jpeg"
    digest = hashlib.sha256(body).hexdigest()
    transcript = root / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(image))
    cfg = config.Config(machine_id="m1", hub_url=hub.url, auth="dev", stores={"omp": str(root)})

    with State(tmp_path / "state.db") as st:
        assert run_mod._do_run(cfg, st) == 0
        image.write_bytes(body)
        assert run_mod._do_run(cfg, st) == 0

    key = ("m1", "omp", f"session.jsonl.assets/{digest}/001_img01.jpeg")
    assert hub.files[key]["body"] == body


def test_backfill_uploads_external_asset_for_present_parent(tmp_path, hub):
    root = tmp_path / "omp"
    root.mkdir()
    image = tmp_path / "001_img01.jpeg"
    body = b"backfill jpeg"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = root / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(image))
    cfg = config.Config(machine_id="m1", hub_url=hub.url, auth="dev", stores={"omp": str(root)})

    with State(tmp_path / "state.db") as st:
        assert run_mod._do_backfill(cfg, st, 1, False) == 0
    key = ("m1", "omp", f"session.jsonl.assets/{digest}/001_img01.jpeg")
    assert hub.files[key]["body"] == body


def test_backfill_dry_run_counts_missing_external_asset(tmp_path, hub, capsys):
    root = tmp_path / "omp"
    root.mkdir()
    image = tmp_path / "001_img01.jpeg"
    body = b"dry-run jpeg"
    image.write_bytes(body)
    digest = hashlib.sha256(body).hexdigest()
    transcript = root / "session.jsonl"
    _transcript(transcript, str(tmp_path), digest, str(image))
    cfg = config.Config(machine_id="m1", hub_url=hub.url, auth="dev", stores={"omp": str(root)})

    with State(tmp_path / "state.db") as st:
        assert run_mod._do_backfill(cfg, st, 1, True) == 0
    assert '"would_upload": 2' in capsys.readouterr().out
    assert hub.files == {}
