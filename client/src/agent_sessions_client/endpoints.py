"""Typed helpers over the machine read API — the surface an agent actually calls."""

from __future__ import annotations

import json
from collections.abc import Iterator
from urllib.parse import quote

from .http import HubClient
from .models import (
    HubStatus,
    MachineStatus,
    SearchHit,
    SearchResult,
    SessionMeta,
    SessionRecord,
    SessionsPage,
    SessionsSummary,
    UsageReport,
    UsageRow,
)

# The hub clamps `limit` at 1000 (see clampLimit() in hub/src/api/sessions.ts) — that's the
# per-REQUEST page size, not a total cap. list_sessions() and iter_sessions_ndjson() below
# both follow the hub's cursor transparently across as many requests as needed, so a caller
# always gets the complete matching set regardless of how many rows that is; this constant is
# just the default page size used for each individual request. See docs/agents-api.md's
# pagination section.
MAX_SESSIONS_LIMIT = 1000


def _earlier_indexed_through(a: str | None, b: str | None) -> str | None:
    """The earlier ("stalest") of two `indexed_through` ISO timestamps — None always wins
    (treated as earlier than any real timestamp, since it means "never synced").

    Used to fold multiple pages of a paginated call into one `indexed_through` value. Keyset
    pagination never revisits a page once its boundary has advanced past it, so if a machine
    finishes syncing WHILE a multi-page call is in flight, later pages report a fresher
    `indexed_through` than earlier ones even though rows that machine ingested in between
    could have sorted ahead of a cursor boundary already consumed — those rows are silently
    missing from the result, exactly when the fresher-looking later value would suppress the
    staleness caveat that should catch it. Keeping the minimum across all pages instead means
    the caveat still fires whenever ANY page saw a not-fully-synced fleet.
    """
    if a is None or b is None:
        return None
    return min(a, b)


class SessionsApi:
    """Typed wrapper over one HubClient. Construct once, reuse across calls."""

    def __init__(self, client: HubClient):
        self._client = client
        self.last_indexed_through: str | None = None

    def list_sessions(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        harness: str | None = None,
        machine: str | None = None,
        repo: str | None = None,
        limit: int = MAX_SESSIONS_LIMIT,
    ) -> SessionsPage:
        """GET /api/v1/sessions — meta-only rows (no R2 parse), the cheap call for aggregate
        stats. Follows the hub's keyset `cursor` transparently: the JSON response includes a
        `cursor` field only when more rows matched than fit in one page, and this method
        keeps re-requesting with `?cursor=...` until a response has none, so the returned
        `SessionsPage` always holds the COMPLETE set of matching sessions — callers never see
        a partial page or need to know the hub's internal per-request page size (`limit`).
        `indexed_through` on the returned page is the EARLIEST (stalest) value seen across all
        pages, not just the last one — see _earlier_indexed_through's docstring for why a
        machine finishing its sync mid-pagination must not silently mask an undercount from
        rows keyset paging already skipped past.
        """
        sessions: list[SessionMeta] = []
        indexed_through: str | None = None
        first_page = True
        cursor: str | None = None
        while True:
            resp = self._client.get(
                "/api/v1/sessions",
                {
                    "from": from_,
                    "to": to,
                    "harness": harness,
                    "machine": machine,
                    "repo": repo,
                    "limit": limit,
                    "cursor": cursor,
                },
            )
            body = resp.json()
            sessions.extend(SessionMeta.from_row(r) for r in body.get("sessions", []))
            page_indexed_through = body.get("indexed_through") or None
            indexed_through = page_indexed_through if first_page else _earlier_indexed_through(indexed_through, page_indexed_through)
            first_page = False
            cursor = body.get("cursor") or None
            if not cursor:
                break
        return SessionsPage(sessions=sessions, indexed_through=indexed_through)

    def iter_sessions_ndjson(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        harness: str | None = None,
        machine: str | None = None,
        repo: str | None = None,
        limit: int = MAX_SESSIONS_LIMIT,
    ) -> Iterator[SessionRecord]:
        """GET /api/v1/sessions?format=ndjson — streams one fully parsed NormalizedSession per
        line. The hub stream-parses each session's canonical R2 object on demand, so this is
        far more expensive per-session than list_sessions() — only use it when the caller
        needs turn content, not just aggregate counts.

        Each request is capped at NDJSON_MAX_ROWS_PER_REQUEST (300, hub-side) rows regardless
        of `limit`; if more rows match, the hub's stream ends with one control line
        `{"cursor": "..."}` (no `meta` key, unlike every real row) instead of the caller's
        query silently truncating. This method detects that trailer and transparently issues
        another request with `?cursor=...` to keep streaming — callers get the full matching
        set without knowing the cap exists. Sets self.last_indexed_through from each request's
        response header as it starts, so callers may read it as soon as the first item of the
        CURRENT page comes back. Once more than one request has fired, the value is the
        EARLIEST (stalest) header seen so far, not just the latest — see
        _earlier_indexed_through's docstring for why (same keyset-pagination hazard as
        list_sessions()) — so it can only get staler as pagination continues, never look
        artificially fresher.
        """
        cursor: str | None = None
        first_page = True
        while True:
            resp = self._client.get(
                "/api/v1/sessions",
                {
                    "from": from_,
                    "to": to,
                    "harness": harness,
                    "machine": machine,
                    "repo": repo,
                    "limit": limit,
                    "format": "ndjson",
                    "cursor": cursor,
                },
            )
            page_indexed_through = resp.header("x-indexed-through") or None
            self.last_indexed_through = (
                page_indexed_through if first_page else _earlier_indexed_through(self.last_indexed_through, page_indexed_through)
            )
            first_page = False
            cursor = None
            for line in resp.iter_lines():
                row = json.loads(line)
                if "meta" not in row:
                    # Trailer control line, always the last line of a capped-out response
                    # (see hub/src/api/sessions.ts) — not a session row. Stop reading this
                    # response's lines and re-request with this cursor to continue.
                    cursor = row.get("cursor")
                    break
                yield SessionRecord(meta=SessionMeta.from_row(row["meta"]), session=row.get("session"))
            if not cursor:
                break

    def get_session(self, session_id: str) -> tuple[SessionMeta, dict | None]:
        """GET /api/v1/sessions/{id} — one fully parsed NormalizedSession."""
        resp = self._client.get(f"/api/v1/sessions/{quote(session_id, safe='')}")
        body = resp.json()
        return SessionMeta.from_row(body["meta"]), body.get("session")

    def get_session_raw(self, session_id: str) -> bytes:
        """GET /api/v1/sessions/{id}/raw. For a plain JSONL canonical (claude-code, codex):
        the raw file bytes, passthrough from R2 (Range support exists server-side but isn't
        exposed by this helper). For an export-archive-backed session: NOT a passthrough of
        the archive — the hub extracts and returns only that one conversation's JSON (see
        docs/agents-api.md). For a chatgpt-web/claude-web session: the canonical R2 object
        already IS that one conversation's JSON, so it is a passthrough, just of a smaller
        object than the archive case."""
        return self._client.get(f"/api/v1/sessions/{quote(session_id, safe='')}/raw").read_bytes()

    def search(
        self,
        q: str,
        *,
        harness: str | None = None,
        machine: str | None = None,
        os: str | None = None,
        model: str | None = None,
        repo: str | None = None,
        cwd: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
        facets: bool = False,
    ) -> SearchResult:
        """GET /api/v1/search — FTS5 over blocks with session-level filters and facet counts."""
        resp = self._client.get(
            "/api/v1/search",
            {
                "q": q,
                "harness": harness,
                "machine": machine,
                "os": os,
                "model": model,
                "repo": repo,
                "cwd": cwd,
                "from": from_,
                "to": to,
                "limit": limit,
                "cursor": cursor,
                "facets": "1" if facets else None,
            },
        )
        body = resp.json()
        return SearchResult(
            hits=[SearchHit.from_row(h) for h in body.get("hits", [])],
            facets=body.get("facets"),
            cursor=body.get("cursor"),
        )

    def usage(self, *, group_by: str = "day", from_: str | None = None, to: str | None = None) -> UsageReport:
        """GET /api/v1/usage?group_by=day|model|machine|repo&from&to"""
        resp = self._client.get("/api/v1/usage", {"group_by": group_by, "from": from_, "to": to})
        body = resp.json()
        # Thread the response's own group_by (not the request kwarg — same value in practice,
        # but this is what the hub actually says it grouped by) into every row: UsageRow.
        # total_tokens needs it to know whether `bucket` is safe to treat as a model name.
        resolved_group_by = body["group_by"]
        return UsageReport(
            group_by=resolved_group_by,
            rows=[UsageRow.from_row(r, group_by=resolved_group_by) for r in body.get("rows", [])],
        )

    def status(self) -> HubStatus:
        """GET /api/v1/status — per-machine index-completeness introspection."""
        resp = self._client.get("/api/v1/status")
        body = resp.json()
        machines = [MachineStatus.from_row(m) for m in body.get("machines", [])]
        s = body.get("sessions") or {}
        return HubStatus(
            machines=machines,
            sessions=SessionsSummary(total=s.get("total") or 0, ready=s.get("ready") or 0, error=s.get("error") or 0),
        )
