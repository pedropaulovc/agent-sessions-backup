# Memory index

- [Machine inventory: amet is this Windows+WSL box](machine-inventory.md) — hostname "amet" = the RTX 3090 Windows machine; WSL2 runs on it (no TPM in WSL)
- [Approved plan location and key decisions](project-decisions.md) — Cloudflare serverless hub, vza.net, OIDC federation to Azure, no Gmail, 72h heartbeat tolerance
- [Use sonnet/opus subagents for implementation](workflow-subagents.md) — lead orchestrates, subagents implement
- [Session-title precomputed at ingest](session-title-sql-size-limit.md) — title stored in sessions.first_interaction_title (TS at ingest), not derived in SQL; why query-time SQL was abandoned (D1 100KB limit / CTE NOMEM)
- [Deploy/migrations ordering gap](deploy-migrations-gap.md) — Workers Builds auto-deploys code but NOT D1 migrations; apply migrate:remote by hand or a migration-bearing merge breaks prod
- [Alert KQL doesn't auto-deploy](alert-kql-manual-apply.md) — editing infra/azure/alerts/*.kql needs a manual provision.sh or surgical az update; how to apply one alert + diagnose what fired
