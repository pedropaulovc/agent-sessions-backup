# Memory index

- [Machine inventory: amet is this Windows+WSL box](machine-inventory.md) — hostname "amet" = the RTX 3090 Windows machine; WSL2 runs on it (no TPM in WSL)
- [Approved plan location and key decisions](project-decisions.md) — Cloudflare serverless hub, vza.net, OIDC federation to Azure, no Gmail, 72h heartbeat tolerance
- [Use sonnet/opus subagents for implementation](workflow-subagents.md) — lead orchestrates, subagents implement
- [Session-title precomputed at ingest](session-title-sql-size-limit.md) — title stored in sessions.first_interaction_title (TS at ingest), not derived in SQL; why query-time SQL was abandoned (D1 100KB limit / CTE NOMEM)
- [CI deploys the hub Worker (migrate then deploy)](deploy-migrations-gap.md) — RESOLVED by PR #52: ci.yml is sole prod deployer via CLOUDFLARE_API_TOKEN (Workers Builds prod auto-deploy off); migrate-then-wrangler-deploy on merge to main
- [Alert KQL doesn't auto-deploy](alert-kql-manual-apply.md) — editing infra/azure/alerts/*.kql needs a manual provision.sh or surgical az update; how to apply one alert + diagnose what fired
- [Reading D1 usage and cost](d1-usage-and-billing.md) — billing REST 403s with the wrangler token; use GraphQL analytics. Rows WRITTEN is the binding quota; ~9.4 billed rows per block
- [wrangler d1 query gotchas](wrangler-d1-query-gotchas.md) — two SILENT failure modes: multi-account needs CLOUDFLARE_ACCOUNT_ID; `--file` returns batch stats, only `--command` returns rows
- [D1 preview/prod isolation limits](d1-preview-isolation.md) — D1 tokens are account-scoped (no per-db resource), no workload identity federation; Workers Builds builds previews from the PR checkout, so wrangler.jsonc is PR-controlled; only a separate account truly isolates
