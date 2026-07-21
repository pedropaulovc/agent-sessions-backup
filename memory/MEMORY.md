# Memory index

- [Machine inventory: amet is this Windows+WSL box](machine-inventory.md) — hostname "amet" = the RTX 3090 Windows machine; WSL2 runs on it (no TPM in WSL)
- [Approved plan location and key decisions](project-decisions.md) — Cloudflare serverless hub, vza.net, OIDC federation to Azure, no Gmail, 72h heartbeat tolerance
- [Use sonnet/opus subagents for implementation](workflow-subagents.md) — lead orchestrates, subagents implement
- [Codex review smart trigger](codex-review-trigger.md) — pushes may get no auto-review; @codex review forces one
- [D1 invocation cap counts subrequests](d1-invocation-limits.md) — db.batch = 1 subrequest regardless of statements; budget ~800/invocation; proven by 7,686-block positive control
