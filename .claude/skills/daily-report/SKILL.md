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
   - `GET /api/v1/sessions?from=<date>&to=<date>` — session-level meta (counts, cwd, model,
     block/turn counts, duration). Meta-only, no R2 read, fast.
   - `GET /api/v1/usage?group_by=model&from=<date>&to=<date>` — token spend by model.
   - `GET /api/v1/status` — per-machine `indexed_through`, to check freshness before trusting
     the counts above.

3. **Always surface staleness**, don't silently present partial data as complete:
   - If any machine's `indexed_through` (from `/api/v1/status`) is before the end of the
     report date, say so and name the machine.
   - If the session list came back at exactly the request `limit` (there is no pagination on
     `/api/v1/sessions` — see the gap noted in `docs/agents-api.md`), say the count may be
     truncated rather than reporting it as final.
   - The built-in CLI report already does both of these under a "Staleness caveats" heading;
     if you're calling the API by hand, replicate the same checks.

4. **Treat `harness=prompt-log` sessions separately** from interactive ones — they're a
   synthetic running log (Codex's `history.jsonl`), not a bounded session, and will distort
   duration/size-based "notable sessions" rankings if mixed in with real sessions.

5. **Output markdown.** If asked to post or send the report somewhere (Slack, email, a repo
   file), use whatever channel the user specifies rather than assuming one — this skill only
   covers generating the report, not distributing it.
