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
        self.part_attempts = 0
        self.flaky_500_remaining = 0
        self.flaky_methods = {"PUT", "POST"}
        # In-flight multipart uploads: upload_id -> {machine, store, relpath, sha256, mtime, size, parts}
        self.multipart: dict[str, dict] = {}
        self._mp_seq = 0
        self.aborts: list[str] = []
        self.completes = 0
        # When > 0, complete returns 422 (as if the reassembled bytes failed verification) and
        # decrements — exercises the collector's verify-failure retry/abort loop.
        self.flaky_multipart_mismatch_remaining = 0
        # When set, complete always returns this status and LEAVES the upload pending (so the
        # collector's abort is observable) — exercises the give-up/abort path.
        self.force_complete_status: int | None = None
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
                    "identity": {
                        "machine_id": self.headers.get("x-dev-machine"),
                        "cert_fingerprint": None,
                        "cert_slot": "current",
                    },
                    "machines": [], "files": len(hub.files),
                    "keys": [list(k) for k in hub.files],
                })
            return self._json(404, {"error": "not_found"})

        def _split_path(self):
            """(path, query-dict) — query values are single strings. keep_blank_values so the
            valueless `?uploads` flag survives (parse_qs drops it otherwise)."""
            parts = urllib.parse.urlsplit(self.path)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query, keep_blank_values=True).items()}
            return parts.path, query

        def _files_target(self, path):
            """(machine, store, relpath) from /api/v1/files/{machine}/{store}/{relpath...}, or None."""
            m = path.split("/")
            try:
                idx = m.index("files")
            except ValueError:
                return None
            if len(m) < idx + 4:
                return None
            return (
                urllib.parse.unquote(m[idx + 1]),
                urllib.parse.unquote(m[idx + 2]),
                urllib.parse.unquote("/".join(m[idx + 3:])),
            )

        def do_PUT(self):
            path, query = self._split_path()
            body = self._read_body()
            if "uploadId" in query:
                return self._multipart_part(path, query, body)
            hub.put_attempts += 1
            if hub._should_fail("PUT"):
                return self._json(500, {"error": "flaky"})
            target = self._files_target(path)
            if target is None:
                return self._json(404, {"error": "not_found"})
            machine, store, relpath = target

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

        def _multipart_part(self, path, query, body):
            """PUT ?uploadId&partNumber — stash the part bytes for later reassembly."""
            hub.part_attempts += 1
            if hub._should_fail("PUT"):
                return self._json(500, {"error": "flaky"})
            up = hub.multipart.get(query.get("uploadId", ""))
            if up is None:
                return self._json(400, {"error": "unknown_upload"})
            part_no = int(query.get("partNumber", "0"))
            up["parts"][part_no] = body
            return self._json(200, {"part_number": part_no, "etag": hashlib.sha256(body).hexdigest()[:16]})

        def do_DELETE(self):
            path, query = self._split_path()
            up_id = query.get("uploadId", "")
            if up_id in hub.multipart:
                hub.multipart.pop(up_id, None)
                hub.aborts.append(up_id)
                return self._json(200, {"status": "aborted"})
            return self._json(200, {"status": "gone"})

        def do_POST(self):
            path, query = self._split_path()
            body = self._read_body()
            if "uploads" in query:
                return self._multipart_create(path, query)
            if "uploadId" in query:
                return self._multipart_complete(path, query, body)
            hub.post_attempts += 1
            if hub._should_fail("POST"):
                return self._json(500, {"error": "flaky"})
            obj = json.loads(body or b"{}")
            if path == "/api/v1/files/check":
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
            if path == "/api/v1/heartbeat":
                hub.heartbeats.append(obj)
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "not_found"})

        def _multipart_create(self, path, query):
            """POST ?uploads — open an upload (or 200-unchanged short-circuit on a matching hash)."""
            if hub._should_fail("POST"):
                return self._json(500, {"error": "flaky"})
            target = self._files_target(path)
            if target is None:
                return self._json(404, {"error": "not_found"})
            machine, store, relpath = target
            hdr = self.headers.get("x-content-hash", "")
            if not hdr.startswith("sha256:"):
                return self._json(400, {"error": "missing_or_bad_x_content_hash"})
            declared = hdr.split(":", 1)[1].lower()
            existing = hub.files.get((machine, store, relpath))
            if existing and existing["sha256"] == declared:
                return self._json(200, {"status": "unchanged"})
            hub._mp_seq += 1
            up_id = f"upload-{hub._mp_seq}"
            hub.multipart[up_id] = {
                "machine": machine, "store": store, "relpath": relpath,
                "sha256": declared, "mtime": self.headers.get("x-file-mtime"),
                "size": int(self.headers.get("x-file-size", "0")), "parts": {},
            }
            return self._json(201, {"status": "created", "upload_id": up_id, "key": path})

        def _multipart_complete(self, path, query, body):
            """POST ?uploadId — reassemble parts in order, verify sha256, store or 422."""
            hub.completes += 1
            up_id = query.get("uploadId", "")
            up = hub.multipart.get(up_id)
            if up is None:
                return self._json(404, {"error": "unknown_upload"})
            if hub.force_complete_status is not None:
                # Leave the upload pending so the collector's abort has something to release.
                return self._json(hub.force_complete_status, {"error": "forced"})
            if hub.flaky_multipart_mismatch_remaining > 0:
                # Simulate a verify failure: hub deletes the object, collector retries.
                hub.flaky_multipart_mismatch_remaining -= 1
                hub.multipart.pop(up_id, None)
                return self._json(422, {"error": "checksum_mismatch"})
            # The whole-object hash is re-declared on the complete request (stateless contract),
            # falling back to the create-time value only if a caller omits it.
            hdr = self.headers.get("x-content-hash", "")
            expected = hdr.split(":", 1)[1].lower() if hdr.startswith("sha256:") else up["sha256"]
            assembled = b"".join(up["parts"][n] for n in sorted(up["parts"]))
            actual = hashlib.sha256(assembled).hexdigest()
            if actual != expected:
                hub.multipart.pop(up_id, None)
                return self._json(422, {"error": "checksum_mismatch",
                                        "expected": expected, "actual": actual})
            hub.files[(up["machine"], up["store"], up["relpath"])] = {
                "sha256": expected, "body": assembled, "mtime": up["mtime"],
            }
            hub.multipart.pop(up_id, None)
            return self._json(201, {"status": "stored"})

    return Handler
