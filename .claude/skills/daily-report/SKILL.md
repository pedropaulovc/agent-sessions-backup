---
name: daily-report
description: Generate a markdown daily activity report for the AI agent session hub (per-machine/harness session counts, notable sessions, token spend per model, staleness caveats). Use when asked for a daily report, activity summary, or usage/token summary of Claude Code, Codex, or web sessions tracked by the hub.
---

# Daily report

Produce a markdown report of AI agent activity for a given day, using the sessions hub's
machine API. Full endpoint contract, auth modes, and known gaps: `docs/agents-api.md`.

## Steps

1. **Prefer the shipped CLI** over hand-rolling API calls:
   ```bash
   cd client && uv run agent-sessions daily-report --date YYYY-MM-DD
   ```
   `--date` defaults to today. Requires an mTLS cert/key, resolved from
   `~/.config/agent-collector/config.toml` by default (already set up on any enrolled
   machine) — override with `--client-cert`/`--client-key` if needed. Against a PR preview
   instead of production, use `--hub-url <preview-url> --bearer-token $DEV_AUTH --dev-machine
   <any-id>`. `--out <path>` writes the markdown to a file instead of stdout.

2. **If the CLI isn't available** (no `client/` checkout, or you need a breakdown the built-in
   report doesn't produce), call the API directly per `docs/agents-api.md`. The three calls the
   built-in report makes:
   - `GET /api/v1/sessions?from=<date>&to=<date>&limit=1000` — session-level meta (counts,
     cwd, model, block/turn counts, duration). Meta-only, no R2 read, fast. Don't omit
     `limit`: the hub defaults to 200 rows per page, well under the 1000 hard per-request cap
     the shipped CLI requests — a smaller `limit` just means more page round-trips, not
     missing data, but there's no reason not to ask for the max page size up front. This
     endpoint paginates with a keyset `cursor`: if the response has a `cursor` field, more
     rows matched than fit in this page — re-request with `&cursor=...` (same filters) and
     keep going until a response has no `cursor`. The built-in client (`SessionsApi.
     list_sessions()`) does this automatically; if you're hand-rolling the call, you must
     loop yourself or you'll silently undercount on a busy day.
   - `GET /api/v1/usage?group_by=model&from=<date>&to=<date>` — token spend by model.
   - `GET /api/v1/status` — per-machine `indexed_through`, to check freshness before trusting
     the counts above.

3. **Always surface staleness**, don't silently present partial data as complete:
   - If any machine's `indexed_through` (from `/api/v1/status`) is before the end of the
     report date, say so and name the machine.
   - If an in-scope machine's `/api/v1/status` entry shows `files_pending` or `files_error`
     greater than 0, say the session counts may be incomplete and name the machine —
     uploaded files don't appear in `/api/v1/sessions` until the ingest consumer parses them,
     so a machine can look fresh by `indexed_through` while still hiding unparsed data.
   - The built-in CLI report already does these under a "Staleness caveats" heading;
     if you're calling the API by hand, replicate the same checks.

4. **Treat `harness=prompt-log` sessions separately** from interactive ones — they're a
   synthetic running log (Codex's `history.jsonl`), not a bounded session, and will distort
   duration/size-based "notable sessions" rankings if mixed in with real sessions.

5. **Output markdown.** If asked to post or send the report somewhere (Slack, email, a repo
   file), use whatever channel the user specifies rather than assuming one — this skill only
   covers generating the report, not distributing it.
