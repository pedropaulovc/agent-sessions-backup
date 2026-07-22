---
name: deploy-migrations-gap
description: hub code auto-deploys via Cloudflare Workers Builds but D1 migrations do NOT — apply them to prod manually or a migration-bearing merge breaks prod
metadata:
  type: project
---

**Merging a migration-bearing PR to main breaks production until the migration is applied by hand.**

Cloudflare Workers Builds auto-deploys the hub Worker on push to `main`, but that deploy does NOT
run D1 migrations, and `ci.yml` only runs tests (no migrate step). So new code that references a
new column/table hits the OLD prod schema → every affected request throws
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

**Durable fix (not yet done):** add a `wrangler d1 migrations apply --remote` step to the deploy
pipeline (CF API token secret), gated before the Workers Builds deploy, so migrations lead code.
