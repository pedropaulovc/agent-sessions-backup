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

**There is no pagination on this endpoint** — no `cursor`/`offset`, just the hard 1000-row
`limit` cap (`clampLimit()` in `hub/src/api/sessions.ts`). If a query returns exactly
`limit` rows, treat it as possibly truncated and narrow the window (split by machine, by
harness, or into smaller time ranges) rather than trusting the count. `/api/v1/search`, by
contrast, *does* support a `cursor` — don't confuse the two.

The response's `X-Indexed-Through` header (mirrored as `indexed_through` in the JSON body)
is `MIN(last_seen_at)` across **every machine in the fleet**, regardless of your
`machine`/`harness` filter — see "Known contract gaps" below before treating it as a
per-filter freshness signal.

### `GET /api/v1/sessions/{id}`
One session, fully parsed: `{meta: <sessions row>, session: <NormalizedSession|null>}`.
`session` is `null` if the canonical R2 object went missing (rare; means data loss, not a
parse failure — those still return the row with `index_state='error'`).

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
`repo`, `cwd`, `from`, `to`, `limit` (default 20, max 100), `cursor` (opaque, paginates),
`facets=1` (adds facet counts over harness/machine_id/os/primary_model/repo_url).

### `GET /api/v1/usage?group_by=day|model|machine|repo&from&to`
Token accounting, one row per bucket: `bucket, calls, input_tokens, output_tokens,
reasoning_tokens, cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens`.
Raw token counts only — the hub has no pricing table, so there's no dollar figure anywhere
in this response. Compute cost yourself if you need it, and caveat that it's an estimate.

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
be stale or absent), `ready` (fully indexed), `error` (parse failed; the raw file is still
safe in R2, just not searchable/renderable). A report that counts sessions should count
`error` ones too (as "present but not analyzable"), not silently drop them.

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
- `/api/v1/sessions` has no cursor/pagination at all; the plan's endpoint list implies more
  uniform pagination across endpoints than exists.
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
print(page.indexed_through, page.truncated, len(page.sessions))

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

# today's sessions, meta only (cheap)
curl --cert $CERT --key $KEY "$BASE/api/v1/sessions?from=2026-07-18&to=2026-07-18"

# streaming NDJSON with full parsed content (expensive per row)
curl --cert $CERT --key $KEY "$BASE/api/v1/sessions?from=2026-07-18&format=ndjson"

# per-model token usage for a day
curl --cert $CERT --key $KEY "$BASE/api/v1/usage?group_by=model&from=2026-07-18&to=2026-07-18"

# fleet freshness — check before trusting a report's counts
curl --cert $CERT --key $KEY "$BASE/api/v1/status"
```
