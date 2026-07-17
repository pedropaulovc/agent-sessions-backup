"""In-process fake hub mirroring the 3 collector endpoints (+ /healthz, /status).

Verifies x-content-hash against the received body (like R2's server-side checksum), so a
test that sends the wrong bytes fails loudly. Supports a flaky mode: the next N requests to
a matching method return 500 before succeeding, to exercise transport retry.
"""

from __future__ import annotations

import hashlib
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeHub:
    def __init__(self):
        # (machine_id, store, relpath) -> {"sha256", "body", "mtime"}
        self.files: dict[tuple[str, str, str], dict] = {}
        self.heartbeats: list[dict] = []
        self.checks: list[dict] = []
        self.put_attempts = 0
        self.post_attempts = 0
        self.flaky_500_remaining = 0
        self.flaky_methods = {"PUT", "POST"}
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address
        return f"http://127.0.0.1:{port}"

    def start(self) -> "FakeHub":
        hub = self
        handler = _make_handler(hub)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    def __enter__(self) -> "FakeHub":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    def _should_fail(self, method: str) -> bool:
        if self.flaky_500_remaining > 0 and method in self.flaky_methods:
            self.flaky_500_remaining -= 1
            return True
        return False


def _make_handler(hub: FakeHub):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def _json(self, status: int, obj: dict):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> bytes:
            n = int(self.headers.get("content-length", 0))
            return self.rfile.read(n) if n else b""

        def do_GET(self):
            if self.path == "/healthz":
                return self._json(200, {"ok": True, "environment": "test"})
            if self.path == "/api/v1/status":
                return self._json(200, {
                    "machines": [], "files": len(hub.files),
                    "keys": [list(k) for k in hub.files],
                })
            return self._json(404, {"error": "not_found"})

        def do_PUT(self):
            hub.put_attempts += 1
            body = self._read_body()
            if hub._should_fail("PUT"):
                return self._json(500, {"error": "flaky"})
            m = self.path.split("/")
            # /api/v1/files/{machine}/{store}/{relpath...}
            try:
                idx = m.index("files")
            except ValueError:
                return self._json(404, {"error": "not_found"})
            machine = urllib.parse.unquote(m[idx + 1])
            store = urllib.parse.unquote(m[idx + 2])
            relpath = urllib.parse.unquote("/".join(m[idx + 3:]))

            hdr = self.headers.get("x-content-hash", "")
            if not hdr.startswith("sha256:"):
                return self._json(400, {"error": "missing_or_bad_x_content_hash"})
            declared = hdr.split(":", 1)[1].lower()
            actual = hashlib.sha256(body).hexdigest()
            if declared != actual:
                return self._json(400, {"error": "checksum_mismatch",
                                        "declared": declared, "actual": actual})

            key = (machine, store, relpath)
            existing = hub.files.get(key)
            if existing and existing["sha256"] == declared:
                return self._json(200, {"status": "unchanged"})
            hub.files[key] = {
                "sha256": declared, "body": body,
                "mtime": self.headers.get("x-file-mtime"),
            }
            return self._json(201, {"status": "stored"})

        def do_POST(self):
            hub.post_attempts += 1
            body = self._read_body()
            if hub._should_fail("POST"):
                return self._json(500, {"error": "flaky"})
            obj = json.loads(body or b"{}")
            if self.path == "/api/v1/files/check":
                hub.checks.append(obj)
                machine = self.headers.get("x-dev-machine", "")
                items = obj.get("files", [])
                if len(items) > 1000:
                    return self._json(400, {"error": "batch_too_large"})
                missing = []
                for it in items:
                    key = (machine, it["store"], it["relpath"])
                    have = hub.files.get(key)
                    sha = it["sha256"].replace("sha256:", "").lower()
                    if not have or have["sha256"] != sha:
                        missing.append({"store": it["store"], "relpath": it["relpath"]})
                return self._json(200, {"missing": missing})
            if self.path == "/api/v1/heartbeat":
                hub.heartbeats.append(obj)
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "not_found"})

    return Handler
