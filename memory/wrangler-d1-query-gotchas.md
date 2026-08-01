---
name: wrangler-d1-query-gotchas
description: Two wrangler d1 execute failure modes — a loud account-selection error that gets swallowed by pipes, and --file silently returning batch stats instead of rows
metadata:
  type: reference
---

These fail differently, and it matters. **(1) is a loud configuration error** — wrangler
says exactly what is wrong; it only *looks* silent because the message goes to stdout
mixed with ANSI banners, so piping through `rg` for the fields you want swallows it.
**(2) is genuinely silent** — the command succeeds and returns the wrong *shape* of
output, so it reads as "the query returned nothing."

**1. Set `CLOUDFLARE_ACCOUNT_ID` explicitly.** This account has two orgs
(`Pedro@vezza.com.br's Account` = `18ef3246e9f36d1560485ef53889c0ab`, and `vezza.dev`), so
wrangler errors with *"More than one account available but unable to select one in
non-interactive mode"*. It only picks the right one when run from `hub/` where
`wrangler.jsonc` supplies `account_id`. Any tool that resets cwd between calls (the Bash
tool does) drops that. Export it:

```sh
export CLOUDFLARE_ACCOUNT_ID=18ef3246e9f36d1560485ef53889c0ab
```

**2. `--file` does NOT return rows; `--command` does.** `wrangler d1 execute --file q.sql`
runs the file as a *batch* and answers with summary stats
(`Total queries executed`, `Rows read`, `Database size (MB)`) — never the SELECT's rows. Use
`--command` for anything you need results from, and reserve `--file` for multi-statement
writes.

**3. Parsing `--json` output:** wrangler interleaves ANSI-coloured banners, and the escape
sequences contain `[`. Do not `indexOf('[')` to find the payload — strip
`/\x1b\[[0-9;]*m/g` first, then find the line that is exactly `[`. The `\x1b` has to be
inside the match: `/\[[0-9;]*m/g` removes `[0m` but leaves the ESC byte, so the banner line
reads as `\x1b[` and never equals `[`.

**Query shapes that time out on prod `sessions-index`** (~4 GB, 1.39M blocks): any
`SUM(LENGTH(text))` grouped by an unindexed column (e.g. `GROUP BY btype`). The same
aggregate grouped by an indexed/joined column works. Get per-type content sizes from a local
`~/.claude/projects` scan instead. See [[d1-usage-and-billing]].
