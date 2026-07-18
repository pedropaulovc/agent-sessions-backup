"""In-process fake hub covering the read endpoints the client library calls.

No TLS/mTLS is faked here — this listens on plain HTTP on 127.0.0.1, and auth headers are
simply recorded rather than verified. HubClient's mTLS path is unit-tested separately by
asserting it drives ssl.SSLContext.load_cert_chain with the configured paths (test_http.py);
this fake exists to catch client-side response-parsing bugs against realistic response
*shapes*, mirrored from hub/src/api/{sessions,search,ops}.ts and from a production smoke
test (see docs/agents-api.md), not to exercise the auth handshake itself.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeHub:
    def __init__(self):
        self.sessions: list[dict] = []  # rows shaped like the hub's `sessions` table
        self.normalized: dict[str, dict] = {}  # session_id -> NormalizedSession body
        self.indexed_through: str | None = None
        self.search_hits: list[dict] = []
        self.usage_rows: list[dict] = []
        self.status_machines: list[dict] = []
        self.status_sessions: dict = {"total": 0, "ready": 0, "error": 0}
        self.sessions_limit_cap = 1000  # mirrors clampLimit()'s hard max in sessions.ts
        # Mirrors NDJSON_MAX_ROWS_PER_REQUEST in hub/src/api/sessions.ts (300 in production) —
        # kept much smaller by default so a test can exercise multi-page cursor-following
        # without needing 300+ fixture rows.
        self.ndjson_max_rows_per_request = 10
        self.requests: list[dict] = []  # recorded {path, params, headers} for assertions
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address
        return f"http://127.0.0.1:{port}"

    def start(self) -> FakeHub:
        handler = _make_handler(self)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    def __enter__(self) -> FakeHub:
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    @staticmethod
    def _param(params: dict[str, list[str]], name: str) -> str | None:
        v = params.get(name)
        return v[0] if v else None

    def _filtered_sessions_all(self, params: dict[str, list[str]]) -> list[dict]:
        """Filtered + sorted rows, no limit/cursor slicing applied — mirrors the hub's
        `ORDER BY COALESCE(started_at, '') DESC, session_id ASC` (session_id tiebreak makes
        the order total, same reason the real keyset cursor needs it)."""
        one = lambda name: self._param(params, name)  # noqa: E731
        rows = self.sessions
        from_ = one("from")
        to = one("to")
        harness = one("harness")
        machine = one("machine")
        repo = one("repo")
        if from_:
            rows = [r for r in rows if (r.get("ended_at") or "") >= from_ or (r.get("started_at") or "") >= from_]
        if to:
            bound = to if len(to) > 10 else f"{to}T23:59:59.999Z"
            rows = [r for r in rows if (r.get("started_at") or "") <= bound]
        if harness:
            rows = [r for r in rows if r.get("harness") == harness]
        if machine:
            rows = [r for r in rows if r.get("machine_id") == machine]
        if repo:
            rows = [r for r in rows if r.get("repo_url") == repo]
        # Mirrors `ORDER BY COALESCE(started_at, '') DESC, session_id ASC` — started_at
        # descending, but session_id ASCENDING as the tiebreak (not also descending), so two
        # sorted() passes: session_id ascending first, then a stable started_at-descending
        # sort on top preserves that ascending tiebreak order within equal started_at values.
        rows = sorted(rows, key=lambda r: r["session_id"])
        return sorted(rows, key=lambda r: r.get("started_at") or "", reverse=True)

    def _paginate(self, rows: list[dict], params: dict[str, list[str]], cap: int) -> tuple[list[dict], str | None]:
        """Slice `rows` (already filtered+sorted) starting after an opaque `cursor` param —
        here just the last-seen session_id, since ids are unique — up to `cap` rows. Returns
        (page, next_cursor); next_cursor is None once nothing remains, same as the real hub
        omitting `cursor` from the response. Doesn't replicate the real hub's base64 keyset
        encoding: the client only ever treats this value as opaque, so a simpler stand-in is
        enough to test cursor-following behavior."""
        cursor = self._param(params, "cursor")
        if cursor:
            idx = next((i for i, r in enumerate(rows) if r["session_id"] == cursor), None)
            rows = rows[idx + 1 :] if idx is not None else rows
        page = rows[:cap]
        next_cursor = page[-1]["session_id"] if len(rows) > cap else None
        return page, next_cursor

    def _sessions_page(self, params: dict[str, list[str]]) -> tuple[list[dict], str | None]:
        limit = int(self._param(params, "limit") or 200)
        limit = min(max(limit, 1), self.sessions_limit_cap)
        return self._paginate(self._filtered_sessions_all(params), params, limit)

    def _ndjson_page(self, params: dict[str, list[str]]) -> tuple[list[dict], str | None]:
        return self._paginate(self._filtered_sessions_all(params), params, self.ndjson_max_rows_per_request)


def _make_handler(hub: FakeHub):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def _json(self, status: int, obj: dict, extra_headers: dict[str, str] | None = None) -> None:
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            parsed = urllib.parse.urlsplit(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            hub.requests.append({"path": parsed.path, "params": params, "headers": dict(self.headers.items())})

            if parsed.path == "/api/v1/sessions":
                self._handle_sessions(params)
                return
            if parsed.path.startswith("/api/v1/sessions/"):
                self._handle_session_detail(parsed.path)
                return
            if parsed.path == "/api/v1/search":
                self._json(200, {"hits": hub.search_hits, "facets": None, "cursor": None})
                return
            if parsed.path == "/api/v1/usage":
                group_by = (params.get("group_by") or ["day"])[0]
                self._json(200, {"group_by": group_by, "rows": hub.usage_rows})
                return
            if parsed.path == "/api/v1/status":
                self._json(200, {"machines": hub.status_machines, "sessions": hub.status_sessions})
                return
            self._json(404, {"error": "not_found"})

        def _handle_sessions(self, params: dict[str, list[str]]) -> None:
            headers = {"x-indexed-through": hub.indexed_through or ""}
            if params.get("format") == ["ndjson"]:
                rows, next_cursor = hub._ndjson_page(params)
                self.send_response(200)
                self.send_header("content-type", "application/x-ndjson; charset=utf-8")
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                for row in rows:
                    line = json.dumps({"meta": row, "session": hub.normalized.get(row["session_id"])})
                    self.wfile.write((line + "\n").encode())
                if next_cursor:
                    # Trailer control line: no `meta`/`session` keys, so the client can tell
                    # it apart from a normal row (see hub/src/api/sessions.ts).
                    self.wfile.write((json.dumps({"cursor": next_cursor}) + "\n").encode())
                return
            page, next_cursor = hub._sessions_page(params)
            body: dict = {"sessions": page, "indexed_through": hub.indexed_through}
            if next_cursor:
                body["cursor"] = next_cursor
            self._json(200, body, headers)

        def _handle_session_detail(self, path: str) -> None:
            rest = path[len("/api/v1/sessions/") :]
            is_raw = rest.endswith("/raw")
            session_id = urllib.parse.unquote(rest[: -len("/raw")] if is_raw else rest)
            match = next((r for r in hub.sessions if r["session_id"] == session_id), None)
            if not match:
                self._json(404, {"error": "not_found"})
                return
            if is_raw:
                body = json.dumps(hub.normalized.get(session_id)).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._json(200, {"meta": match, "session": hub.normalized.get(session_id)})

    return Handler
