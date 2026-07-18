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

# The hub clamps `limit` at 1000 (see clampLimit() in hub/src/api/sessions.ts) and this
# endpoint has NO cursor/offset — unlike /api/v1/search. 1000 is the most a single call can
# ever return; see docs/agents-api.md for what to do about a day with more sessions than that.
MAX_SESSIONS_LIMIT = 1000


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
        stats. `page.truncated` is a heuristic (len(sessions) == limit): treat it as "there
        may be more sessions in this window than were returned."
        """
        resp = self._client.get(
            "/api/v1/sessions",
            {"from": from_, "to": to, "harness": harness, "machine": machine, "repo": repo, "limit": limit},
        )
        body = resp.json()
        sessions = [SessionMeta.from_row(r) for r in body.get("sessions", [])]
        return SessionsPage(
            sessions=sessions,
            indexed_through=body.get("indexed_through") or None,
            truncated=len(sessions) >= limit,
        )

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
        needs turn content, not just aggregate counts. Sets self.last_indexed_through from the
        response header once headers arrive (before the body streams), so callers may read it
        as soon as the first item comes back rather than waiting for exhaustion.
        """
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
            },
        )
        self.last_indexed_through = resp.header("x-indexed-through") or None
        for line in resp.iter_lines():
            row = json.loads(line)
            yield SessionRecord(meta=SessionMeta.from_row(row["meta"]), session=row.get("session"))

    def get_session(self, session_id: str) -> tuple[SessionMeta, dict | None]:
        """GET /api/v1/sessions/{id} — one fully parsed NormalizedSession."""
        resp = self._client.get(f"/api/v1/sessions/{quote(session_id, safe='')}")
        body = resp.json()
        return SessionMeta.from_row(body["meta"]), body.get("session")

    def get_session_raw(self, session_id: str) -> bytes:
        """GET /api/v1/sessions/{id}/raw — passthrough of the canonical R2 object's bytes
        (whole file; Range support exists server-side but isn't exposed by this helper)."""
        resp = self._client.get(f"/api/v1/sessions/{quote(session_id, safe='')}/raw")
        try:
            return resp._fp.read()  # noqa: SLF001 — no JSON body to parse, just raw bytes
        finally:
            resp.close()

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
        return UsageReport(group_by=body["group_by"], rows=[UsageRow.from_row(r) for r in body.get("rows", [])])

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
