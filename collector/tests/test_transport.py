import hashlib

import pytest

from agent_collector import transport as transport_mod
from agent_collector.transport import Transport, DevAuth, MtlsAuth, Upload

pytestmark = pytest.mark.skipif(
    not Transport.curl_available(), reason="system curl not available"
)


def _write_body(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return p, hashlib.sha256(data).hexdigest()


def _put(t, hub, machine, store, relpath, body_path, sha, mtime="2026-01-01T00:00:00Z"):
    url = f"{hub.url}/api/v1/files/{machine}/{store}/{relpath}"
    return t.put(url, body_path, {"x-content-hash": f"sha256:{sha}", "x-file-mtime": mtime})


def test_put_stores_then_idempotent(tmp_path, hub):
    t = Transport(DevAuth("m1"))
    body, sha = _write_body(tmp_path, "b1", b"hello world")
    status, _ = _put(t, hub, "m1", "claude", "a.jsonl", body, sha)
    assert status == 201
    status, _ = _put(t, hub, "m1", "claude", "a.jsonl", body, sha)
    assert status == 200  # same path+hash -> unchanged
    assert ("m1", "claude", "a.jsonl") in hub.files


def test_put_retries_on_flaky_500(tmp_path, hub, monkeypatch):
    monkeypatch.setattr(transport_mod, "BACKOFF", (0.01, 0.01, 0.01))
    hub.flaky_500_remaining = 1  # first PUT 500, retry succeeds
    t = Transport(DevAuth("m1"))
    body, sha = _write_body(tmp_path, "b1", b"retry me")
    status, _ = _put(t, hub, "m1", "claude", "a.jsonl", body, sha)
    assert status == 201


def test_post_json_check_reports_missing(tmp_path, hub):
    t = Transport(DevAuth("m1"))
    body, sha = _write_body(tmp_path, "b1", b"present")
    _put(t, hub, "m1", "claude", "here.jsonl", body, sha)
    obj = {"files": [
        {"store": "claude", "relpath": "here.jsonl", "sha256": sha},
        {"store": "claude", "relpath": "gone.jsonl", "sha256": "0" * 64},
    ]}
    status, resp = t.post_json(f"{hub.url}/api/v1/files/check", obj,
                               {"x-dev-machine": "m1"})
    assert status == 200
    import json
    missing = json.loads(resp)["missing"]
    assert missing == [{"store": "claude", "relpath": "gone.jsonl"}]


def test_upload_batch_parallel(tmp_path, hub):
    t = Transport(DevAuth("m1"), parallel_max=4)
    uploads = []
    for i in range(5):
        data = f"payload-{i}".encode()
        p = tmp_path / f"b{i}"
        p.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        url = f"{hub.url}/api/v1/files/m1/claude/f{i}.jsonl"
        uploads.append(Upload(url, str(p), {"x-content-hash": f"sha256:{sha}",
                                            "x-file-mtime": "2026-01-01T00:00:00Z"}))
    codes = t.upload_batch(uploads)
    assert all(c == 201 for c in codes.values()), codes
    assert len(hub.files) == 5


def test_get_healthz(hub):
    t = Transport(DevAuth("m1"))
    status, body = t.get(f"{hub.url}/healthz")
    assert status == 200
    assert '"ok": true' in body or '"ok":true' in body


def test_mtls_auth_not_implemented():
    with pytest.raises(NotImplementedError):
        MtlsAuth("tpm").curl_args()
