---
name: deploy-migrations-gap
description: CI (not Workers Builds) now deploys the hub Worker — migrate then wrangler deploy, in that order, on merge to main (PR #52, 2026-07-24)
metadata:
  type: project
---

**RESOLVED 2026-07-24 by PR #52.** CI is now the sole prod deployer: `.github/workflows/ci.yml`'s
`deploy` job (push to main, gated on the `hub` tests) runs `wrangler d1 migrations apply sessions-index
--remote` **then** `wrangler deploy`, in that order, in one job — so code never runs against an
un-migrated schema. Cloudflare Workers Builds auto-deploy for the **production** `sessions-hub` Worker
was turned OFF (git repo disconnected in the dashboard) so nothing races the workflow. The separate
`sessions-hub-preview` Worker keeps its own Workers Builds connection for PR preview URLs (harmless,
never touches prod). Auth is repo secret **`CLOUDFLARE_API_TOKEN`** (a user API token
`sessions-hub CI deploy + D1 migrate`, expires **2026-10-24** — recreate before then): account
`18ef3246…` scoped D1 / Workers Scripts / Queues / Workers R2 / Workers KV = Edit, Account Settings =
Read; zone vza.net = Workers Routes:Edit. `account_id` comes from wrangler.jsonc (so no
CLOUDFLARE_ACCOUNT_ID needed with this token).

--- Historical context (the incident this fixed) ---

**Before the fix:** Workers Builds auto-deployed the hub Worker on push to `main`, but that deploy did
NOT run D1 migrations, and `ci.yml` only ran tests (no migrate step). So new code that referenced a
new column/table hit the OLD prod schema → every affected request threw
(`D1_ERROR: table X has no column named Y: SQLITE_ERROR`). This fired the `agent-backup-parse-errors`
alert on 2026-07-22 when PR #51's migration 0013 (sessions.first_interaction_title) shipped without
being applied — the ingest writer's INSERT failed on every file.

**When you ship a migration, apply it to remote D1 as part of landing it:**
```
cd hub
CLOUDFLARE_ACCOUNT_ID=18ef3246e9f36d1560485ef53889c0ab \
  npx wrangler d1 migrations apply sessions-index --remote
```
(`sessions-index` = prod D1, id 5ff65cf3-89c8-4fe6-a3c2-a370293ecea6, in wrangler.jsonc. Two CF
accounts are configured, so CLOUDFLARE_ACCOUNT_ID must be set. `npm run migrate:remote` is the same
command.) `wrangler d1 migrations list sessions-index --remote` shows unapplied ones.

**Diagnosing a prod incident:** `az` is authed to the alerting sub. Query the actual error via
Log Analytics workspace `law-agent-backup` (customerId 8ea9a5fa-d706-4c12-b952-5b7ba9631221):
`OTelLogs | extend body=todynamic(Body) | where body.event=='parse.error' | project body.error`.

**Errored files don't auto-heal:** the `*/15` watchdog cron only REPORTS files_error; nothing
re-enqueues `parse_state='error'` rows. They recover on a collector re-upload or an admin reindex
(`POST /api/v1/admin/reindex`, which needs machine mTLS admin identity — not callable with a plain
token). Reindex is also the backfill path for derived columns (see [[session-title-sql-size-limit]]).

**Manual apply (still valid for out-of-band fixes):**
```
cd hub
CLOUDFLARE_ACCOUNT_ID=18ef3246e9f36d1560485ef53889c0ab \
  npx wrangler d1 migrations apply sessions-index --remote
```
`wrangler d1 migrations list sessions-index --remote` shows unapplied ones; `npm run migrate:remote`
is the same command. Two CF accounts are configured, so CLOUDFLARE_ACCOUNT_ID must be set when using
an OAuth login (the CI API token pins the account itself).
