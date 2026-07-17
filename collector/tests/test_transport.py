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


def test_mtls_tpm_key_not_implemented():
    # TPM-backed keys can't be handed to curl as a file; that lands in M4.
    with pytest.raises(NotImplementedError):
        MtlsAuth(key_protection="tpm").curl_args()


def test_mtls_software_returns_cert_and_key_args(tmp_path):
    cert = tmp_path / "box.client.pem"
    key = tmp_path / "box.client.key"
    cert.write_text("cert")
    key.write_text("key")
    args = MtlsAuth(client_cert_path=str(cert), client_key_path=str(key)).curl_args()
    assert args == ["--cert", str(cert), "--key", str(key)]


def test_mtls_missing_one_path_errors():
    # Only a cert, no key -> a clear config error, not a cryptic curl failure.
    with pytest.raises(ValueError, match="client_key_path"):
        MtlsAuth(client_cert_path="/x/box.pem").curl_args()
    with pytest.raises(ValueError, match="client_cert_path"):
        MtlsAuth(client_key_path="/x/box.key").curl_args()


def test_mtls_missing_key_file_errors(tmp_path):
    cert = tmp_path / "box.client.pem"
    cert.write_text("cert")
    with pytest.raises(FileNotFoundError, match="client_key_path"):
        MtlsAuth(client_cert_path=str(cert), client_key_path=str(tmp_path / "absent.key")).curl_args()


def test_parse_curl_version():
    p = transport_mod._parse_curl_version
    assert p("curl 7.68.0 (x86_64-pc-linux-gnu) libcurl/7.68.0") == (7, 68, 0)
    assert p("curl 8.5.0 (x86_64) libcurl/8.5.0") == (8, 5, 0)
    assert p("curl 7.76 (x86_64)") == (7, 76, 0)  # missing patch -> 0
    assert p("not curl output") is None


def test_check_curl_version_raises_when_too_old():
    t = Transport(DevAuth("m1"))
    t._probe_curl_version = lambda: (7, 68, 0)
    with pytest.raises(RuntimeError) as ei:
        t.check_curl_version()
    msg = str(ei.value)
    assert "7.68" in msg and "7.76.0" in msg and "--fail-with-body" in msg


def test_check_curl_version_passes_when_new_enough():
    t = Transport(DevAuth("m1"))
    t._probe_curl_version = lambda: (7, 76, 0)
    assert t.check_curl_version() == (7, 76, 0)


def test_check_curl_version_raises_when_undetectable():
    t = Transport(DevAuth("m1"))
    t._probe_curl_version = lambda: None
    with pytest.raises(RuntimeError):
        t.check_curl_version()


def test_request_fails_loudly_on_old_curl(hub):
    # A too-old curl must NOT silently return status 0; the request path raises instead.
    t = Transport(DevAuth("m1"))
    t._probe_curl_version = lambda: (7, 68, 0)
    with pytest.raises(RuntimeError):
        t.get(f"{hub.url}/healthz")


def test_permanent_4xx_not_retried(tmp_path, hub, monkeypatch):
    # If backoff were entered, this would sleep; keep it fast so a regression is obvious.
    monkeypatch.setattr(transport_mod, "BACKOFF", (0.01, 0.01, 0.01))
    t = Transport(DevAuth("m1"))
    body, _real = _write_body(tmp_path, "b1", b"payload")
    # Declared hash != actual body -> hub returns a permanent 400.
    status, _ = _put(t, hub, "m1", "claude", "a.jsonl", body, "0" * 64)
    assert status == 400
    assert hub.put_attempts == 1  # exactly one attempt, no retry on 4xx


def test_timeout_flags_present():
    assert "--connect-timeout" in Transport._COMMON
    assert "--max-time" in Transport._COMMON


def test_subprocess_timeout_maps_to_status_zero(monkeypatch):
    def boom(*a, **k):
        raise transport_mod.subprocess.TimeoutExpired(cmd="curl", timeout=1)
    monkeypatch.setattr(transport_mod.subprocess, "run", boom)
    t = Transport(DevAuth("m1"))
    t._curl_version_ok = True  # skip the version probe; this test is about the transfer timeout
    rc, status, _body = t._run(["-sS", "http://127.0.0.1:1/x"])
    assert status == 0 and rc != 0  # no HTTP response -> treated as network failure


def test_curl_config_quote_roundtrips_backslashes_and_quotes():
    q = transport_mod._curl_config_quote
    assert q(r"C:\Users\a") == r"C:\\Users\\a"
    assert q('a"b') == r"a\"b"
    assert q(r'C:\x"y') == r"C:\\x\"y"


def test_upload_config_escapes_windows_paths_and_uses_null_device(monkeypatch):
    import os as _os
    monkeypatch.setattr(_os, "devnull", "NUL")  # simulate the Windows null device
    t = Transport(DevAuth("m1"))
    up = Upload("http://h/api/v1/files/m1/claude/a.jsonl",
                r"C:\Users\pedro\AppData\Local\Temp\body.bin",
                {"x-content-hash": "sha256:00"})
    text = t._build_upload_config([up])
    escaped = r"C:\\Users\\pedro\\AppData\\Local\\Temp\\body.bin"  # each backslash doubled
    assert f'upload-file = "{escaped}"' in text
    assert 'output = "NUL"' in text                       # platform null device
    assert 'write-out = "%{url_effective} %{http_code}\\n"' in text  # per-block


def test_retryable_decides_from_status_alone():
    # rc 22 (curl --fail-with-body on 4xx) must NOT retry a permanent 400/404.
    assert transport_mod._retryable(22, 400) is False
    assert transport_mod._retryable(22, 404) is False
    assert transport_mod._retryable(22, 429) is True
    assert transport_mod._retryable(0, 503) is True
    assert transport_mod._retryable(7, 0) is True   # no HTTP response -> network failure
