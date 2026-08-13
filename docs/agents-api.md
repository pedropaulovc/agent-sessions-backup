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

Every protected data endpoint under `/api/v1/` — including plain reads like `/sessions` and
`/search` — requires an authenticated identity (`hub/src/router.ts::apiRoute`). The one
exception is `POST /api/v1/grants/exchange`, which authenticates itself: the single-use
code plus the PKCE verifier that never left the agent's process IS the credential. There is
no unauthenticated data-read or human-cookie path into this API; the viewer's passkey
session is a completely separate auth path that doesn't apply here. Two ways to
authenticate:

1. **Read grant (preferred for agents).** A short-lived read-only bearer the owner mints
   with a passkey touch — the system rule is *machine certs ingest, passkeys egress*: no
   agent reads production session bytes without the owner approving a grant. Mint one with
   the shipped CLI (opens a browser approval page, delivers the token over a loopback PKCE
   callback, caches it in `~/.config/agent-sessions/grant.json`):
   ```bash
   cd client && uv run agent-sessions auth --ttl 4h   # --label defaults to agent@<hostname>
   ```
   Then send `Authorization: Bearer agsr_…` on every request. The grant reaches ONLY the
   read allow-list (`/sessions` list/get/raw, `/search`, `/usage`, `/machines`, `/status`)
   — never uploads, bootstrap, cert, or admin routes. Default TTL 4 h, max 24 h; active
   grants are listed and revocable on the viewer's `/settings` page.

   Run the auth CLI from a **trusted checkout** (`main`, or your own reviewed branch) —
   the CLI handles the minted token, so an untrusted PR branch's copy could leak it. This
   is a deliberately lighter bar than the signed `sessions-dev-bridge` (which stays the
   ONLY authorization client for prod→preview session export): a read grant is short-lived,
   read-only, revocable at `/settings`, and every mint requires the owner's fresh passkey
   on a page that displays the label/TTL being approved — it cannot move or mutate prod
   bytes.
2. **mTLS (ingest + fleet aggregates — collectors).** Present a machine's client cert+key
   on every request. Any enrolled machine's paths are in
   `~/.config/agent-collector/config.toml` (`client_cert_path` / `client_key_path`), e.g.:
   ```bash
   curl --cert ~/.config/agent-collector/<machine>.client.pem \
        --key  ~/.config/agent-collector/<machine>.client.key \
        "https://api.sessions.vza.net/api/v1/status"
   ```
   Machine certs are **ingest credentials**: upload, `files/check`, heartbeat, cert
   renewal, bootstrap, admin, plus the content-free aggregates (`/status`, `/machines`,
   `/usage`). In production a cert request to `/sessions*` or `/search` returns
   `403 {"error":"passkey_grant_required"}` — session content is read-grant-only
   (`hub/src/router.ts`; development keeps cert reads for the local loop).

The old preview-only `DEV_AUTH` bearer (`Authorization: Bearer <DEV_AUTH>` +
`x-dev-machine`) is gone along with the Workers Builds previews that used it; the current
per-PR preview stack authenticates through the preview front door, not this API.

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
`repo`, `project`, `cwd`, `session_date`, `session_time`, `has_star=1`, `subagent=no|yes`
(defaults to `no`), `from`, `to`, `limit` (default 100, max 100), `cursor` (opaque,
paginates), `facets=1` (adds counts for registered facets, including `has_star` and `subagent`).

### `GET /api/v1/usage?group_by=day|model|machine|repo&from&to&machine&harness&batch`

Token accounting, one row per bucket: `bucket, calls, input_tokens, output_tokens,
reasoning_tokens, cache_read_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens`,
plus costing: `cost_usd`, `billable_input_tokens`, `unpriced_calls`. Response-level:
`cost_basis` and `unpriced_models`.

**`cost_usd` is a list-price equivalent, not a bill.** It is what these tokens would have
cost on the metered API at the rates in `model_prices` (synced from LiteLLM, ccusage's
source), and the tokens were very likely burned under a flat-rate plan instead. Never present
it as spend without that qualifier.

`cost_basis` names the rate set that actually produced the dollars — it is not an echo of your
`batch` param, because `batch=1` is a request rather than a guarantee (a model with no
published batch tier falls back to its standard rates, and Anthropic publishes none at all):

- `litellm_list_price` — standard rates. Also what you get for `batch=1` when *nothing* in the
  response could be batch-priced.
- `litellm_list_price_batch` — every priced row used batch rates.
- `litellm_list_price_batch_partial` — a mix; some rows fell back to standard rates.

`unpriced_models` lists models with no usable rate; their calls are counted in `unpriced_calls`
and contribute 0 to `cost_usd`, so a non-empty list means every total is a floor. The literal
`(unknown)` appears there for usage rows with a NULL model (real tokens, undeterminable rate) —
`<synthetic>` and other `<…>` sentinels never appear, because they never hit an API and are not
coverage you lost. A row is also unpriced when its timestamp is NULL and its model has more
than one rate snapshot: a missing timestamp is not evidence the call predates every rate.

`billable_input_tokens` is the input actually charged at the input rate — under OpenAI's subset
cache accounting that is `input_tokens` minus the cached prefix, clamped per row, so it is not
derivable from the other columns once rows have been aggregated. It is 0 on unpriced rows.

Rows are priced at the rate in effect when the usage happened, not today's rate: the
aggregate carries a price-epoch dimension internally so a bucket spanning a rate change is
summed from correctly-priced parts, for every `group_by` and not just `day`.

Buckets are capped at 400, and the cap is applied to buckets — a returned bucket always
counts all of its models. A NULL bucket (e.g. `group_by=repo` over sessions with no
`repo_url`) is a real bucket and is returned like any other.

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

**`machine` and `harness` filters are supported** (they filter on the joined `sessions` row,
same values as `/api/v1/sessions`), so a per-machine or per-harness token report needs no
cross-referencing. `SessionsApi.usage()` exposes both, and `daily-report` forwards its
`--machine`/`--harness` flags, so its token section is scoped exactly like its session list.

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
- ~~`GET /api/v1/usage` accepts no `machine`/`harness` filter.~~ Closed — it takes both, and
  the client and `daily-report` forward them (see the endpoint section above).
- `/api/v1/sessions`'s cursor is a keyset boundary `(started_at, session_id)`, not the opaque
  offset cursor `/api/v1/search` uses — the two endpoints' `cursor` params are not
  interchangeable or shaped the same, despite sharing a param name.
- ~~`GET /api/v1/bootstrap`, `POST /api/v1/certs/renew`, and `POST /api/v1/admin/machines`
  aren't implemented.~~ Closed — all three exist now (`hub/src/router.ts`), but they are
  machine-cert-only (admin routes additionally require `isAdmin` + the current cert slot);
  none are reachable with a read grant.

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

# Auth resolution: --grant-token / $AGENT_SESSIONS_GRANT_TOKEN / the `agent-sessions auth`
# token cache first, then an mTLS cert from ~/.config/agent-collector/config.toml (which in
# production reaches only the content-free aggregates — session reads need a grant).
config = load_config()
api = SessionsApi(HubClient(config))

page = api.list_sessions(from_="2026-07-18", to="2026-07-18")
print(page.indexed_through, len(page.sessions))  # follows the hub's cursor internally; complete set

usage = api.usage(group_by="model", from_="2026-07-18", to="2026-07-18")
for row in usage.rows:
    print(row.bucket, row.total_tokens)

for record in api.iter_sessions_ndjson(from_="2026-07-18", harness="claude-code"):
    print(record.meta.session_id, record.session and len(record.session.get("turns", [])))
```

CLI: `cd client && uv run agent-sessions auth` mints and caches a read grant;
`uv run agent-sessions daily-report [--date YYYY-MM-DD]` uses it automatically — see
`.claude/skills/daily-report/SKILL.md` for how an agent should drive it.

## curl examples

```bash
# Read grant (preferred): mint once with `agent-sessions auth --print-token`, or read the
# cache the CLI wrote.
TOKEN=$(jq -r .token ~/.config/agent-sessions/grant.json)
AUTH="authorization: Bearer $TOKEN"
BASE=https://api.sessions.vza.net

# today's sessions, meta only (cheap) — limit=1000 to match the CLI's request and hit the
# hard per-page cap, not the hub's 200-row default (which would need more page fetches on a
# busy day). If the response has a "cursor", more rows matched than fit in this page — pass
# it back as &cursor=... to continue.
curl -H "$AUTH" "$BASE/api/v1/sessions?from=2026-07-18&to=2026-07-18&limit=1000"

# streaming NDJSON with full parsed content (expensive per row)
curl -H "$AUTH" "$BASE/api/v1/sessions?from=2026-07-18&format=ndjson"

# per-model token usage for a day
curl -H "$AUTH" "$BASE/api/v1/usage?group_by=model&from=2026-07-18&to=2026-07-18"

# fleet freshness — check before trusting a report's counts
curl -H "$AUTH" "$BASE/api/v1/status"

# mTLS works for the content-free aggregates only (/status, /machines, /usage): replace
# -H "$AUTH" with
#   --cert ~/.config/agent-collector/<machine>.client.pem \
#   --key  ~/.config/agent-collector/<machine>.client.key
# A cert request to /sessions* or /search returns 403 passkey_grant_required in production.
# (On a TPM-backed Windows enrollment there are no PEM files — use System32 curl with
#  --cert "CurrentUser\MY\<thumbprint>" — or just use a read grant, which needs neither.)
```
