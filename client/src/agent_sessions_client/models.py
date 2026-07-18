"""Typed shapes for hub API responses.

These mirror the JSON hub/src/api/*.ts actually emit (verified against the running
production hub on 2026-07-18), not the aspirational field names in the planning doc — see
docs/agents-api.md for the specific reconciliation notes (e.g. status's `last_seen_at` vs
the plan's `last_heartbeat`). Every row-backed dataclass keeps the raw dict too, so a field
the hub adds later is never silently dropped — callers can always fall back to `.raw`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime


def _parse_models(raw: str | None) -> list[str]:
    """`models` ships as a JSON-encoded string (e.g. '["claude-sonnet-5"]') because D1/SQLite
    has no native array column — decode it here so callers get a real list."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [m for m in parsed if isinstance(m, str)] if isinstance(parsed, list) else []


@dataclass(frozen=True)
class SessionMeta:
    """One row of the `sessions` table, as returned by GET /api/v1/sessions (meta only — no
    R2 parse) and as the `meta` field of /api/v1/sessions/{id} and the NDJSON bulk stream."""

    session_id: str
    harness: str
    machine_id: str | None
    os: str | None
    cwd: str | None
    repo_url: str | None
    git_branch: str | None
    models: list[str]
    primary_model: str | None
    title: str | None
    started_at: str | None
    ended_at: str | None
    turn_count: int
    block_count: int
    tokens_in: int
    tokens_out: int
    tokens_reasoning: int
    tokens_cached: int
    index_state: str
    is_sidechain: bool
    parent_session_id: str | None
    parent_tool_use_id: str | None
    updated_at: str | None
    raw: dict = field(repr=False)

    @classmethod
    def from_row(cls, row: dict) -> SessionMeta:
        return cls(
            session_id=row["session_id"],
            harness=row["harness"],
            machine_id=row.get("machine_id"),
            os=row.get("os"),
            cwd=row.get("cwd"),
            repo_url=row.get("repo_url"),
            git_branch=row.get("git_branch"),
            models=_parse_models(row.get("models")),
            primary_model=row.get("primary_model"),
            title=row.get("title"),
            started_at=row.get("started_at"),
            ended_at=row.get("ended_at"),
            turn_count=row.get("turn_count") or 0,
            block_count=row.get("block_count") or 0,
            tokens_in=row.get("tokens_in") or 0,
            tokens_out=row.get("tokens_out") or 0,
            tokens_reasoning=row.get("tokens_reasoning") or 0,
            tokens_cached=row.get("tokens_cached") or 0,
            index_state=row.get("index_state", "unknown"),
            is_sidechain=bool(row.get("is_sidechain")),
            parent_session_id=row.get("parent_session_id"),
            parent_tool_use_id=row.get("parent_tool_use_id"),
            updated_at=row.get("updated_at"),
            raw=row,
        )

    def duration_seconds(self) -> float | None:
        if not self.started_at or not self.ended_at:
            return None
        try:
            start = datetime.fromisoformat(self.started_at.replace("Z", "+00:00"))
            end = datetime.fromisoformat(self.ended_at.replace("Z", "+00:00"))
        except ValueError:
            return None
        return max(0.0, (end - start).total_seconds())


@dataclass(frozen=True)
class SessionsPage:
    sessions: list[SessionMeta]
    indexed_through: str | None
    truncated: bool  # len(sessions) hit the requested limit — see docs/agents-api.md pagination note


@dataclass(frozen=True)
class SessionRecord:
    """One line of the NDJSON bulk stream: session meta plus the fully parsed session body."""

    meta: SessionMeta
    session: dict | None  # NormalizedSession JSON; schema owned by the hub's renderer/parser, not modeled here


@dataclass(frozen=True)
class SearchHit:
    session_id: str
    snippet: str
    block: dict
    session: dict
    raw: dict = field(repr=False)

    @classmethod
    def from_row(cls, row: dict) -> SearchHit:
        return cls(session_id=row["session_id"], snippet=row["snippet"], block=row["block"], session=row["session"], raw=row)


@dataclass(frozen=True)
class SearchResult:
    hits: list[SearchHit]
    facets: dict[str, dict[str, int]] | None
    cursor: str | None


@dataclass(frozen=True)
class UsageRow:
    bucket: str | None  # day string, model name, machine_id, or repo_url depending on group_by
    calls: int
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    cache_read_tokens: int
    cache_creation_5m_tokens: int
    cache_creation_1h_tokens: int

    @classmethod
    def from_row(cls, row: dict) -> UsageRow:
        return cls(
            bucket=row.get("bucket"),
            calls=row.get("calls") or 0,
            input_tokens=row.get("input_tokens") or 0,
            output_tokens=row.get("output_tokens") or 0,
            reasoning_tokens=row.get("reasoning_tokens") or 0,
            cache_read_tokens=row.get("cache_read_tokens") or 0,
            cache_creation_5m_tokens=row.get("cache_creation_5m_tokens") or 0,
            cache_creation_1h_tokens=row.get("cache_creation_1h_tokens") or 0,
        )

    @property
    def total_tokens(self) -> int:
        """Provider-aware token total — `cache_read_tokens` AND `reasoning_tokens` mean
        different things per provider and can't be summed uniformly on top of
        `input_tokens`/`output_tokens`:

        - Anthropic (claude-code): `cache_read_tokens` is DISJOINT from `input_tokens` (a
          cache hit is billed/reported separately) — must be added. `reasoning_tokens` is
          never populated for this harness (see `hub/src/ingest/parsers/claude-code.ts`, no
          `reasoningTokens` field) — always 0, so whether it's "added" is moot; kept additive
          here on the theory that if Anthropic ever reports a genuinely separate thinking-
          token count, it'd behave like cache_read (a disjoint category), not like codex's
          reasoning count.
        - OpenAI (codex): checked `hub/src/ingest/parsers/codex.ts` — `cacheReadTokens` comes
          from `cached_input_tokens`, a SUBSET of `input_tokens`, and `reasoningTokens` comes
          from `reasoning_output_tokens`, a SUBSET of `output_tokens` (OpenAI's Responses API
          reports both as breakdowns of, not additions to, `input_tokens`/`output_tokens`).
          Adding either on top double-counts. Verified against production and against
          `hub/test/fixtures.ts`'s codex usage fixture: input=900/cached=500/output=80/
          reasoning=20 has a real total of 980 (900+80), not 1000 (900+80+20, reasoning
          double-counted) and not 1480 (also double-counting cache_read).

        The only per-row discriminator this dataclass has is `bucket`, which is the model
        name ONLY when the request used `group_by=model` (the daily-report CLI always does —
        see cli.py). For any other `group_by` (day/machine/repo), `bucket` mixes rows from
        multiple providers under one aggregate, so there is no correct per-row answer;
        treating it as Anthropic-additive would be right for the Anthropic share and wrong
        for the OpenAI share. This falls back to the conservative (OpenAI-style, cache_read
        and reasoning excluded) treatment whenever `bucket` doesn't look like an Anthropic
        model name (i.e. doesn't start with `claude`) — undercounting a mixed/unresolved
        bucket is safer than double-counting it, since this value feeds "biggest spender"
        rankings. Verified against production usage rows (2026-07-18): every claude-code-
        harness model starts with `claude` (e.g. `claude-fable-5`); every codex-harness model
        does not (`gpt-5.x`, `gpt-5.x-codex`). Future provider/model-naming drift could break
        this — if a new provider's model names start with `claude` (unlikely) or an Anthropic
        model line drops the prefix, this heuristic needs revisiting.
        """
        is_anthropic_like = bool(self.bucket) and self.bucket.startswith("claude")
        total = self.input_tokens + self.output_tokens + self.cache_creation_5m_tokens + self.cache_creation_1h_tokens
        if is_anthropic_like:
            total += self.cache_read_tokens + self.reasoning_tokens
        return total


@dataclass(frozen=True)
class UsageReport:
    group_by: str
    rows: list[UsageRow]


@dataclass(frozen=True)
class MachineStatus:
    machine_id: str
    os: str | None
    last_seen_at: str | None
    last_upload_at: str | None
    files_pending: int
    files_error: int
    files_total: int
    indexed_through: str | None  # currently == last_seen_at server-side; see docs/agents-api.md

    @classmethod
    def from_row(cls, row: dict) -> MachineStatus:
        return cls(
            machine_id=row["machine_id"],
            os=row.get("os"),
            last_seen_at=row.get("last_seen_at"),
            last_upload_at=row.get("last_upload_at"),
            files_pending=row.get("files_pending") or 0,
            files_error=row.get("files_error") or 0,
            files_total=row.get("files_total") or 0,
            indexed_through=row.get("indexed_through"),
        )


@dataclass(frozen=True)
class SessionsSummary:
    total: int
    ready: int
    error: int


@dataclass(frozen=True)
class HubStatus:
    machines: list[MachineStatus]
    sessions: SessionsSummary
