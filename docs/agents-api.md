# Agent-facing API guide

This hub exposes a read API for AI agents (not just the human viewer). This doc is written
for you, the calling agent — endpoint shapes here are verified against the *deployed* hub
code (`hub/src/api/*.ts`, `hub/src/router.ts`) and against a live smoke test on 2026-07-18,
not just the planning doc, which has since drifted in a few places (see "Known contract
gaps" below).

If you'd rather not hand-roll HTTP calls, `client/` ships a small stdlib-only Python package
that wraps everything here, plus an `agent-sessions daily-report` CLI. See the bottom of
this doc.

## Base URL & auth

Production: `https://api.sessions.vza.net`.

Every endpoint under `/api/v1/` — including plain reads like `/sessions` and `/search` —
requires an identity of kind `machine` (`hub/src/router.ts::apiRoute`). There is no
unauthenticated or human-cookie path into this API; the viewer's passkey session is a
completely separate auth path that doesn't apply here. Two ways to authenticate:

1. **mTLS (production).** Present a machine's client cert+key on every request. Any
   enrolled machine's paths are in `~/.config/agent-collector/config.toml`
   (`client_cert_path` / `client_key_path`), e.g.:
   ```bash
   curl --cert ~/.config/agent-collector/<machine>.client.pem \
        --key  ~/.config/agent-collector/<machine>.client.key \
        "https://api.sessions.vza.net/api/v1/status"
   ```
2. **Bearer (preview environments only).** Workers Builds PR previews
   (`https://<hash>-sessions-hub-preview.<account>.workers.dev`) gate on a shared
   `DEV_AUTH` secret instead of a real cert, since preview URLs are publicly reachable and
   don't have zone-level mTLS. Send **both** headers:
   ```
   Authorization: Bearer <DEV_AUTH>
   x-dev-machine: <any-identifier>
   ```
   `x-dev-machine` supplies the identity (auto-registered on first use, `isAdmin=true`).
   This path is closed in production — `env.ENVIRONMENT` there is `'production'`, which
   `machineIdentity()` doesn't allowlist for the bearer fallback.

## Endpoints

### `GET /api/v1/sessions`
Query params: `from`, `to` (ISO timestamp, or a bare `YYYY-MM-DD` which the hub expands to
end-of-day server-side), `harness`, `machine`, `repo`, `limit` (default 200, **hard max
1000**), `format=ndjson`.

Default (no `format`): JSON `{sessions: [...], indexed_through}` — every row is straight
from the `sessions` D1 table, no R2 read. Cheap; use this for aggregate counts/rollups.

`format=ndjson`: same filters, but the hub stream-parses each session's canonical R2 object
on demand and emits one `{"meta": {...}, "session": <NormalizedSession>}` line per session.
Much more expensive per row — only use it when you actually need turn content, not just
counts.

**This endpoint paginates with a keyset `cursor`**, not an offset. The JSON response is
`{sessions: [...], indexed_through, cursor}` — `cursor` is present only when more rows match
than fit in this page (internal page size = `limit`, default 200, hard max 1000 via
`clampLimit()`); when absent, you've seen everything. Pass it back as `?cursor=...` (plus the
same filters) to fetch the next page. The cursor encodes the last row's
`(started_at, session_id)` boundary rather than a row offset, so pages stay correct even while
the hub is actively ingesting new sessions concurrently (an offset would repeat or skip rows
under concurrent inserts; a keyset boundary can't be invalidated that way).

`format=ndjson` has its own, tighter cap: each request streams at most
`NDJSON_MAX_ROWS_PER_REQUEST` (300) rows regardless of `limit`. If more rows match, the last
line of the stream is a control line `{"cursor": "..."}` — no `meta`/`session` keys, so it's
distinguishable from a normal row — instead of the stream just silently stopping. Re-request
with `?cursor=...&format=ndjson` (same filters) to continue; a natural end-of-results page
(fewer than the cap) has no trailer line. `client/`'s `SessionsApi.list_sessions()` and
`iter_sessions_ndjson()` both follow this transparently — see "Python client" below — so you
only need to hand-roll cursor-following if you're calling the HTTP API directly.

The response's `X-Indexed-Through` header (mirrored as `indexed_through` in the JSON body)
is `MIN(COALESCE(last_seen_at, created_at))` across **every machine in the fleet**,
regardless of your `machine`/`harness` filter — see "Known contract gaps" below before
treating it as a per-filter freshness signal. The `created_at` fallback matters for a machine
that has enrolled but never actually heartbeated: don't read its `indexed_through` as "synced
through T," it's just enrollment time. This is easy to hit in dev/preview environments, where
ANY authenticated request from an unrecognized `x-dev-machine` auto-registers a `machines` row
for it (see `hub/src/auth/identity.ts::devHeaderIdentity`) without that machine ever having
sent a heartbeat — including a plain read like this one.

### `GET /api/v1/sessions/{id}`
One session, fully parsed: `{meta: <sessions row>, session: <NormalizedSession|null>}`.
`session` is `null` if the canonical R2 object went missing (rare — actual data loss, not a
parse failure). Either way the row's `index_state` is `'error'`; see `index_state` below for
why the two aren't distinguishable from `meta` alone, and how to tell them apart via `/raw`.

### `GET /api/v1/sessions/{id}/raw`
The response shape depends on what the session's canonical file actually is
(`hub/src/api/sessions.ts::getSessionRaw`):

- **Plain JSONL canonical** (claude-code, codex): a true R2 passthrough of the raw file
  bytes. `Range` is honored (206 partial content) since JSONL is byte-addressable.
- **Export-archive-backed session** (from an operator-dropped export ZIP in
  `export-inbox`): **not** a passthrough of anything — the canonical R2 object is the whole
  ZIP (every conversation in that export plus attachments), and returning it under one
  session's id would leak every other conversation. The hub extracts and returns **only that
  one conversation's JSON** via `extractConversationById`. Always 200, `Range` ignored
  (meaningless for an extracted fragment) — if you need the raw ZIP bytes themselves,
  this endpoint doesn't serve them.
- **chatgpt-web/claude-web session**: the canonical R2 object already IS that one
  conversation's JSON document (one file per session, unlike the archive case), so this is a
  passthrough — just of a much smaller object. Always 200, `Range` ignored (a JSON document
  isn't meant to be range-read).

### `GET /api/v1/search`
Params: `q` (FTS5 MATCH syntax — invalid syntax is retried as a quoted literal phrase, then
degrades to an empty result set rather than a 500), `harness`, `machine`, `os`, `model`,
`repo`, `cwd`, `from`, `to`, `limit` (default 100, max 100), `cursor` (opaque, paginates),
`facets=1` (adds facet counts over harness/machine_id/os/primary_model/repo_url).

### `GET /api/v1/usage?group_by=day|model|machine|repo&from&to`
Token accounting, one row per bucket: `bucket, calls, input_tokens, output_tokens,
reasoning_tokens, cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens`.
Raw token counts only — the hub has no pricing table, so there's no dollar figure anywhere
in this response. Compute cost yourself if you need it, and caveat that it's an estimate.

**`cache_read_tokens` and `reasoning_tokens` are not safe to sum into a total uniformly** —
their relationship to `input_tokens`/`output_tokens` is provider-specific:

- Anthropic (claude-code): `cache_read_tokens` is DISJOINT from `input_tokens` (a cache hit
  is billed/reported separately) — a real total adds it. `reasoning_tokens` is never
  populated for this harness (checked `hub/src/ingest/parsers/claude-code.ts` — no
  `reasoningTokens` field), always 0.
- OpenAI (codex): checked `hub/src/ingest/parsers/codex.ts` — `cache_read_tokens` comes from
  `cached_input_tokens`, a SUBSET of `input_tokens`, and `reasoning_tokens` comes from
  `reasoning_output_tokens`, a SUBSET of `output_tokens` (OpenAI's Responses API reports both
  as breakdowns of, not additions to, the input/output totals). Adding either on top
  double-counts. Verified against `hub/test/fixtures.ts`'s codex usage fixture: input=900,
  cached=500, output=80, reasoning=20 — the true total is 980 (900+80), not 1000 (reasoning
  double-counted) and not 1480 (both double-counted).

This response has no explicit provider field; the client (`UsageRow.total_tokens` in
`client/src/agent_sessions_client/models.py`) discriminates by whether `bucket` looks like an
Anthropic model name (starts with `claude`), which only works when the request used
`group_by=model` — verified against production usage rows on 2026-07-18 (every claude-code
model starts with `claude`, every codex model doesn't). For any other `group_by`, `bucket`
mixes providers under one aggregate and there's no correct per-row answer, so the client falls
back to the conservative OpenAI-style treatment (cache_read and reasoning excluded) for those
rows — undercount beats double-count for a spend ranking. If you're computing this yourself
instead of using the client, replicate the same heuristic and caveat, or cross-reference
`harness` via `/api/v1/sessions` to discriminate properly.

**No `machine`/`harness` filter.** Only `group_by`/`from`/`to` are accepted (see "Known
contract gaps" below) — if you're building a per-machine or per-harness token report, you
must fetch the fleet-wide rows and either accept that scope or cross-reference against
`/api/v1/sessions` yourself. The `daily-report` CLI does the honest thing here: when
`--machine`/`--harness` is passed, it labels the token section
"(fleet-wide — /api/v1/usage has no machine/harness filter)" rather than presenting
fleet-wide numbers as if they were scoped to your filter.

### `GET /api/v1/status`
Fleet freshness / index-completeness:
```jsonc
{
  "machines": [
    {"machine_id": "...", "os": "...", "last_seen_at": "...", "last_upload_at": "...",
     "files_pending": 0, "files_error": 0, "files_total": 34893, "indexed_through": "..."}
  ],
  "sessions": {"total": 2943, "ready": 2943, "error": 0}
}
```
`indexed_through` is currently identical to `last_seen_at` (the machine's last heartbeat
time) — there's no independent "scan actually finished through timestamp T" signal beyond
that. This is the right endpoint to answer "did machine X finish syncing before I trust its
counts for date D": compare its `indexed_through` to D's end-of-day bound.

### `index_state`
Every session row carries `index_state`: `parsing` (queued/reparsing — block/FTS content may
be stale or absent), `ready` (fully indexed), `error` (parse failed). A report that counts
sessions should count `error` ones too (as "present but not analyzable"), not silently drop
them.

`error` does NOT reliably mean the raw file is still safe in R2. Usually it does — a malformed
line or an empty parse leaves the canonical object untouched, just unindexed. But
`hub/src/ingest/consumer.ts` also flips a session to `error` when the canonical R2 object
itself is gone (`r2_object_missing`, e.g. deleted out from under the row) — actual data loss,
not a parse failure. The `sessions` row exposed by this API doesn't carry a field that
distinguishes the two cases. If you need to know, fetch `GET /api/v1/sessions/{id}/raw`: a 404
there on an `error` session means the object is gone — treat that as loss and don't retry-loop
on it, it will not come back.

## Known contract gaps (plan vs. deployed hub, as of 2026-07-18)

The planning doc's API-contract section describes a few things the deployed code doesn't
actually do yet. If you're implementing against this API, match the code (and this doc), not
the plan, until they're reconciled:

- `/api/v1/status`'s per-machine fields are named `last_seen_at`/`last_upload_at` (not the
  plan's `last_heartbeat`/`last_upload`), and there is no parse-queue-depth field.
- `X-Indexed-Through` on bulk `/api/v1/sessions` is an unfiltered fleet-wide minimum — it
  does **not** narrow to the machines matching your `machine`/`harness` query params, so it
  can read more stale than your actually-filtered data really is.
- `GET /api/v1/usage` accepts only `group_by`/`from`/`to` — no `machine`/`harness` filter at
  all, unlike `/api/v1/sessions` and `/api/v1/search`. A report scoped to one machine or
  harness still gets fleet-wide token totals from this endpoint; say so rather than
  presenting them as scoped (see the CLI's behavior above).
- `/api/v1/sessions`'s cursor is a keyset boundary `(started_at, session_id)`, not the opaque
  offset cursor `/api/v1/search` uses — the two endpoints' `cursor` params are not
  interchangeable or shaped the same, despite sharing a param name.
- `GET /api/v1/bootstrap`, `POST /api/v1/certs/renew`, and `POST /api/v1/admin/machines`
  (from the plan's API-contract section) aren't implemented. Only `POST /api/v1/admin/reindex`
  exists under `/admin`, and it requires `isAdmin` on the calling machine's cert.

## Harness-specific gotcha: `prompt-log` sessions

Codex's `history.jsonl` ingestion surfaces as a synthetic `harness=prompt-log` "session"
that's really a running log spanning the machine's *entire* prompt history — its
`started_at`/`ended_at` can span months and its `block_count` can dwarf any real interactive
session by orders of magnitude. If you rank sessions by size or duration for a report, either
filter `harness != prompt-log` first or bucket it separately — otherwise it will dominate
every "notable sessions" list and make the ranking meaningless.

## Python client

`client/` is a small stdlib-only package, `agent-sessions-client`, wrapping everything above:

```python
from agent_sessions_client import HubClient, SessionsApi, load_config

config = load_config()  # reads ~/.config/agent-collector/config.toml by default
api = SessionsApi(HubClient(config))

page = api.list_sessions(from_="2026-07-18", to="2026-07-18")
print(page.indexed_through, len(page.sessions))  # follows the hub's cursor internally; complete set

usage = api.usage(group_by="model", from_="2026-07-18", to="2026-07-18")
for row in usage.rows:
    print(row.bucket, row.total_tokens)

for record in api.iter_sessions_ndjson(from_="2026-07-18", harness="claude-code"):
    print(record.meta.session_id, record.session and len(record.session.get("turns", [])))
```

Against a PR preview instead of production:
```python
from agent_sessions_client import HubClient, SessionsApi, load_config

config = load_config(hub_url="https://<hash>-sessions-hub-preview.<account>.workers.dev",
                      bearer_token="<DEV_AUTH>", dev_machine="my-agent")
api = SessionsApi(HubClient(config))
```

CLI: `cd client && uv run agent-sessions daily-report [--date YYYY-MM-DD]` — see
`.claude/skills/daily-report/SKILL.md` for how an agent should drive it.

## curl examples

```bash
CERT=~/.config/agent-collector/amet-wsl.client.pem
KEY=~/.config/agent-collector/amet-wsl.client.key
BASE=https://api.sessions.vza.net

# today's sessions, meta only (cheap) — limit=1000 to match the CLI's request and hit the
# hard per-page cap, not the hub's 200-row default (which would need more page fetches on a
# busy day). If the response has a "cursor", more rows matched than fit in this page — pass
# it back as &cursor=... to continue.
curl --cert $CERT --key $KEY "$BASE/api/v1/sessions?from=2026-07-18&to=2026-07-18&limit=1000"

# streaming NDJSON with full parsed content (expensive per row)
curl --cert $CERT --key $KEY "$BASE/api/v1/sessions?from=2026-07-18&format=ndjson"

# per-model token usage for a day
curl --cert $CERT --key $KEY "$BASE/api/v1/usage?group_by=model&from=2026-07-18&to=2026-07-18"

# fleet freshness — check before trusting a report's counts
curl --cert $CERT --key $KEY "$BASE/api/v1/status"
```
