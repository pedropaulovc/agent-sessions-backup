# agent-sessions-backup

Backup, index, search, and render AI agent/chat sessions from every machine and harness in one place.

- **Harnesses**: Claude Code, Codex CLI, ChatGPT web, Claude web (more via raw-file capture)
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

## Update a Windows collector

Run this in PowerShell to update an enrolled collector to the current `main` branch, replace its scheduled task, and send an immediate heartbeat. It waits for an in-progress scheduled run before replacing the tool, so it never updates the executable under that process.

```powershell
$collector = Join-Path $env:USERPROFILE '.local\bin\agent-collector.exe'; while ((Get-ScheduledTask -TaskName agent-collector -ErrorAction SilentlyContinue).State -eq 'Running') { Start-Sleep -Seconds 2 }; uv tool install --force --reinstall --no-cache 'git+https://github.com/pedropaulovc/agent-sessions-backup.git@main#subdirectory=collector'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $collector install --interval 15; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $collector run --heartbeat-only; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

## Principles

- **R2 is truth.** The D1 index is derived and fully rebuildable from raw files alone.
- **Never delete.** Local GC or file deletion on a machine never propagates to the hub.
- **Capture all, exclude explicitly.** Whole `~/.claude` + `~/.codex` trees, minus credentials and caches.
- **Zero secrets where possible.** TPM-bound keys on machines; OIDC federation to Azure; no encryption at rest by design (searchability first).
