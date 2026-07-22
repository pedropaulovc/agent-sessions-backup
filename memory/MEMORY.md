# Memory index

- [Machine inventory: amet is this Windows+WSL box](machine-inventory.md) — hostname "amet" = the RTX 3090 Windows machine; WSL2 runs on it (no TPM in WSL)
- [Approved plan location and key decisions](project-decisions.md) — Cloudflare serverless hub, vza.net, OIDC federation to Azure, no Gmail, 72h heartbeat tolerance
- [Use sonnet/opus subagents for implementation](workflow-subagents.md) — lead orchestrates, subagents implement
- [Session-title SQL size limit](session-title-sql-size-limit.md) — title query inlined ~hundreds of times, near D1's 100KB limit; don't hoist into a CTE (NOMEM on D1)
