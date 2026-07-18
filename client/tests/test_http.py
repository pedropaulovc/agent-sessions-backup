import ssl
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from agent_sessions_client.config import AuthMode, ClientConfig
from agent_sessions_client.http import HubClient, HubError


def bearer_config(url: str) -> ClientConfig:
    return ClientConfig(hub_url=url, auth_mode=AuthMode.BEARER, bearer_token="tok", dev_machine="test-machine")


def test_get_json_and_headers(hub):
    hub.status_machines = [{"machine_id": "m1", "os": "linux"}]
    client = HubClient(bearer_config(hub.url))
    resp = client.get("/api/v1/status")
    assert resp.status == 200
    body = resp.json()
    assert body["machines"] == [{"machine_id": "m1", "os": "linux"}]


def test_bearer_and_dev_machine_headers_sent(hub):
    client = HubClient(bearer_config(hub.url))
    client.get("/api/v1/status").json()
    assert len(hub.requests) == 1
    headers = hub.requests[0]["headers"]
    assert headers["Authorization"] == "Bearer tok"
    assert headers["X-Dev-Machine"] == "test-machine"


def test_query_params_encoded_and_none_values_dropped(hub):
    client = HubClient(bearer_config(hub.url))
    client.get("/api/v1/sessions", {"from": "2026-07-18", "harness": None, "limit": 5}).json()
    params = hub.requests[0]["params"]
    assert params == {"from": ["2026-07-18"], "limit": ["5"]}


def test_response_header_case_insensitive_lookup(hub):
    hub.indexed_through = "2026-07-18T00:00:00.000Z"
    client = HubClient(bearer_config(hub.url))
    resp = client.get("/api/v1/sessions")
    resp.json()
    # re-request since json() closes the connection; header() must be checked before draining the body
    resp2 = client.get("/api/v1/sessions")
    assert resp2.header("X-Indexed-Through") == "2026-07-18T00:00:00.000Z"
    resp2.close()


def test_404_raises_hub_error_with_body(hub):
    client = HubClient(bearer_config(hub.url))
    with pytest.raises(HubError) as exc_info:
        client.get("/api/v1/sessions/nonexistent").json()
    assert exc_info.value.status == 404
    assert "not_found" in exc_info.value.body


def test_connection_refused_raises_hub_error_with_none_status():
    client = HubClient(bearer_config("http://127.0.0.1:1"))  # port 1 refuses
    with pytest.raises(HubError) as exc_info:
        client.get("/api/v1/status")
    assert exc_info.value.status is None


def test_mtls_config_builds_ssl_context_with_configured_paths(tmp_path, monkeypatch):
    cert = tmp_path / "client.pem"
    key = tmp_path / "client.key"
    cert.write_text("not-a-real-cert")
    key.write_text("not-a-real-key")

    calls = []
    original_load_cert_chain = ssl.SSLContext.load_cert_chain

    def fake_load_cert_chain(self, certfile=None, keyfile=None, **kwargs):
        calls.append((certfile, keyfile))
        # Don't actually call the real implementation — these aren't valid PEM files.

    monkeypatch.setattr(ssl.SSLContext, "load_cert_chain", fake_load_cert_chain)
    config = ClientConfig(hub_url="https://example", auth_mode=AuthMode.MTLS, client_cert_path=cert, client_key_path=key)
    HubClient(config)

    assert calls == [(str(cert), str(key))]
    monkeypatch.setattr(ssl.SSLContext, "load_cert_chain", original_load_cert_chain)


def test_mtls_config_with_missing_cert_raises_value_error(tmp_path):
    # A stale collector config pointing at a rotated/moved cert must fail with a config-class
    # error the CLI already maps to `error: ...` + exit 2, not a raw FileNotFoundError/
    # ssl.SSLError traceback out of the constructor.
    config = ClientConfig(
        hub_url="https://example",
        auth_mode=AuthMode.MTLS,
        client_cert_path=tmp_path / "nonexistent.pem",
        client_key_path=tmp_path / "nonexistent.key",
    )
    with pytest.raises(ValueError, match="failed to load mTLS client cert/key"):
        HubClient(config)


def test_read_timeout_raises_hub_error():
    # A connect-phase timeout is wrapped in URLError already, but a read-phase stall (the hub
    # accepts the connection, then hangs) raises the builtin TimeoutError directly out of
    # urlopen — must be caught and wrapped like every other transport failure.
    class SlowHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            time.sleep(0.5)
            self.send_response(200)
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        client = HubClient(bearer_config(f"http://127.0.0.1:{port}"), timeout=0.05)
        with pytest.raises(HubError):
            client.get("/api/v1/status")
    finally:
        server.shutdown()
        server.server_close()


@contextmanager
def _running_server(handler_cls: type[BaseHTTPRequestHandler]) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


def test_json_body_stall_after_headers_raises_hub_error():
    # HubClient.get()'s own try/except only covers urlopen() itself — the connect phase and
    # response headers. A server that sends 200 + headers and then stalls before any body
    # bytes must still raise HubError, not a raw TimeoutError, even though by the time the
    # stall happens get() has already returned a HubResponse to the caller.
    class HeadersThenStallHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b'{"ok": true}')

    with _running_server(HeadersThenStallHandler) as url:
        client = HubClient(bearer_config(url), timeout=0.05)
        resp = client.get("/api/v1/status")  # headers arrive fine; get() returns normally
        with pytest.raises(HubError):
            resp.json()


def test_ndjson_body_stall_after_headers_raises_hub_error():
    # Same failure mode as test_json_body_stall_after_headers_raises_hub_error, but for the
    # streaming iterator path (iter_sessions_ndjson's underlying primitive).
    class HeadersThenStallHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b'{"meta": {}}\n')

    with _running_server(HeadersThenStallHandler) as url:
        client = HubClient(bearer_config(url), timeout=0.05)
        resp = client.get("/api/v1/sessions", {"format": "ndjson"})
        with pytest.raises(HubError):
            list(resp.iter_lines())


def test_connection_reset_before_headers_raises_hub_error():
    # get()'s except clauses only covered HTTPError/TimeoutError/URLError. A connection
    # accepted then closed before any status line arrives raises http.client.RemoteDisconnected
    # directly (a ConnectionResetError/BadStatusLine subclass, so both an OSError AND an
    # HTTPException) rather than being wrapped in URLError like connect-refused/DNS failures.
    class SilentCloseHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.connection.close()

    with _running_server(SilentCloseHandler) as url:
        client = HubClient(bearer_config(url))
        with pytest.raises(HubError):
            client.get("/api/v1/status")


def test_truncated_content_length_raises_hub_error():
    # If a 200 advertises a Content-Length longer than what's actually sent before the
    # connection closes, HTTPResponse.read() raises http.client.IncompleteRead — an
    # HTTPException, NOT an OSError — so it bypassed _read_body()'s OSError-only wrapper.
    class TruncatedContentLengthHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", "1000")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')  # far short of the advertised 1000 bytes
            self.wfile.flush()
            self.connection.close()

    with _running_server(TruncatedContentLengthHandler) as url:
        client = HubClient(bearer_config(url))
        resp = client.get("/api/v1/status")  # headers arrive fine; get() returns normally
        with pytest.raises(HubError):
            resp.json()


def test_error_body_stall_raises_hub_error_with_status_preserved():
    # e.read() inside get()'s HTTPError handler reads the error body over the same
    # connection as a success body, and can stall the same way — TimeoutError there
    # previously escaped past every HubError-only handler. Status/reason must still survive
    # even when the body itself can't be read.
    class ErrorThenStallHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(500)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", "1000")
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.5)  # never writes the body

    with _running_server(ErrorThenStallHandler) as url:
        client = HubClient(bearer_config(url), timeout=0.05)
        with pytest.raises(HubError) as exc_info:
            client.get("/api/v1/status")
        assert exc_info.value.status == 500


def test_read_bytes_body_stall_after_headers_raises_hub_error():
    # get_session_raw()'s primitive — same wrapping as json()/iter_lines(), via _read_body().
    class HeadersThenStallHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b"raw bytes")

    with _running_server(HeadersThenStallHandler) as url:
        client = HubClient(bearer_config(url), timeout=0.05)
        resp = client.get("/api/v1/sessions/abc/raw")
        with pytest.raises(HubError):
            resp.read_bytes()
