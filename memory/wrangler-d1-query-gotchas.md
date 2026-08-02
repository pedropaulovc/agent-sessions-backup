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

**1. Set `CLOUDFLARE_ACCOUNT_ID` explicitly — and to `vezza.dev`, not the personal account.**
The login has two orgs, and `sessions-index` lives under **`vezza.dev`**:

```sh
export CLOUDFLARE_ACCOUNT_ID=d1db42c1ac42b3aee886f219b8f56e16   # vezza.dev — the D1 databases
# NOT 18ef3246e9f36d1560485ef53889c0ab (Pedro@vezza.com.br's Account) — that one holds the
# Workers/dash resources, and pointing d1 at it fails with a *different* error than the
# ambiguity one, so it does not look like an account-selection problem at all:
#   "The given account is not valid or is not authorized to access this service [code: 7403]"
```

Without the variable at all, wrangler errors with *"More than one account available but unable
to select one in non-interactive mode"*. It only self-selects when run from `hub/`, where
`wrangler.jsonc` supplies `account_id`; any tool that resets cwd between calls (the Bash tool
does) drops that.

**1b. Run from `hub/`, not the repo root.** Outside `hub/` there is no `wrangler.jsonc`, and the
failure names the database rather than the config — *"Couldn't find a D1 DB with name or binding
'sessions-index' in your config or the API. Run 'wrangler d1 create sessions-index'"* — which
invites you to create a second database over an existing one.

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
