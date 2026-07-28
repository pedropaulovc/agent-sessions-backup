---
name: d1-usage-and-billing
description: How to read real D1 utilization/cost (GraphQL analytics, not the billing REST API), and which quota actually binds
metadata:
  type: reference
---

Checking D1 utilization for `sessions-index`:

- **Billing REST endpoints do not work** with the wrangler OAuth token — `/accounts/{id}/subscriptions`, `/user/subscriptions`, `/user/billing/{profile,history}` all return `{"code":10000,"message":"Authentication error"}`. It has account/workers/d1 scopes, nothing for billing. Getting an actual invoice line needs an API token with `Billing:Read`, or the dashboard.
- **Use the GraphQL analytics API instead** (the wrangler OAuth token DOES work there — `Authorization: Bearer $(rg -o 'oauth_token = "([^"]+)"' -r '$1' ~/.config/.wrangler/config/default.toml)` against `https://api.cloudflare.com/client/v4/graphql`):
  - `d1AnalyticsAdaptiveGroups` — `sum { readQueries writeQueries rowsRead rowsWritten }` by `dimensions { date databaseId }`. Note there is no `queryBatchTimeMs` field.
  - `d1StorageAdaptiveGroups` — `max { databaseSizeBytes }`; there is no `avg`.
- `wrangler d1 info <db>` gives a 24h snapshot plus `database_size` — fine for a glance, misleading for cost (a single day tells you nothing about a month that included a backfill).
- `dbstat` is NOT available in D1, so per-table size needs `SUM(LENGTH(col))` per table.

**Rows written is the binding quota, not storage or reads.** Workers Paid includes 25B rows read, 50M rows **written**, and 5GB storage per month; the hard per-database cap is 10GB. Measured 2026-07-28: reads ran ~3% of the allowance while writes were at 148% month-to-date.

**Cost model, measured in prod:** ~9.4 billed rows written per block — ~5.9 to insert one (base row + its `blocks_fts` shadow rows) and ~2.8 to delete one. FTS maintenance, invisible in the statement text, is most of the write bill. Use this to size any ingest change before building it.

The hub emits `hub.d1.write_cost` per session write (see [[deploy-migrations-gap]] for how it reaches prod); query it in Log Analytics workspace `8ea9a5fa-d706-4c12-b952-5b7ba9631221`. Watch for KQL reserved words — `kind` cannot be a column alias.
