# agent-sessions-backup

Backup, index, search, and render AI agent/chat sessions from every machine and harness in one place.

- **Harnesses**: Claude Code, Codex CLI, OMP (Oh My Pi), ChatGPT web, Claude web (more via raw-file capture)
- **Hub**: Cloudflare Workers + D1 (SQLite FTS5 index) + R2 (raw files, source of truth) + Queues
- **Collector**: Python (uv) agent on each machine — incremental uploads over mTLS (TPM-bound client certs), heartbeats
- **Viewer**: chat-style session rendering + faceted full-text search, passkey login
- **Agent API**: JSON search/fetch endpoints (e.g. everything from today as NDJSON) for downstream AI agents
- **Observability**: Cloudflare Workers observability → OTLP gateway → Azure Application Insights (Entra workload identity federation, zero Azure secrets), email alerts

## Layout

| Path | What |
|---|---|
| `hub/` | Cloudflare Workers: sessions hub (API + viewer + ingest), OIDC issuer, telemetry gateway |
| `collector/` | Per-machine Python collector (`agent-collector` CLI) |
| `infra/` | Azure provisioning (az CLI), Cloudflare mTLS/cert setup, install one-liners |
| `scripts/` | Local corpus seeding + verification tooling |
| `memory/` | Project memory for AI agents working on this repo |

## Cloudflare environments

Production Sessions resources live in Cloudflare account
`18ef3246e9f36d1560485ef53889c0ab` and deploy through the protected `production`
GitHub environment. Pull request previews live in the PPE account
`cbb04a26e6fa2d0cdc4eb67c735e5669`. Protected `preview-control` jobs provision and
migrate a dedicated set of `pr-<N>-*` Worker, D1, R2, KV, and queue resources for each
PR. Those resources persist across pushes and are deleted when the PR closes; the
janitor removes any resources left behind by failed close cleanup.

The old shared preview resources and GitHub `preview` environment are retired.

## Update a Windows collector

Run this in PowerShell to update an enrolled collector to the current `main` branch, replace its scheduled task, and send an immediate heartbeat. It waits for an in-progress scheduled run before replacing the tool, so it never updates the executable under that process.

```powershell
iwr https://raw.githubusercontent.com/pedropaulovc/agent-sessions-backup/main/scripts/setup-windows-collector.ps1 | iex
```

## Update a Linux or WSL collector

Run this in a Linux shell to update an enrolled collector to the current `main` branch, replace its systemd user timer, and send an immediate heartbeat. It requires `uv` and a working `systemctl --user` session; WSL must have systemd enabled.

```bash
curl -fsSL https://raw.githubusercontent.com/pedropaulovc/agent-sessions-backup/main/scripts/setup-linux-collector.sh | bash -s -- --interval 15
```

## Principles

- **R2 is truth.** The D1 index is derived and fully rebuildable from raw files alone.
- **Never delete.** Local GC or file deletion on a machine never propagates to the hub.
- **Capture all, exclude explicitly.** Whole `~/.claude` + `~/.codex` trees, minus credentials and caches.
- **Zero secrets where possible.** TPM-bound keys on machines; OIDC federation to Azure; no encryption at rest by design (searchability first).
