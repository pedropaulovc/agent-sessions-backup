---
name: project-decisions
description: Approved architecture decisions for agent-sessions-backup (plan approved 2026-07-16)
metadata:
  type: project
---

Full plan: `~/.claude/plans/tidy-tinkering-bentley.md` (approved 2026-07-16). Non-obvious decisions confirmed by Pedro:

- Hub = Cloudflare Workers Paid + D1 (FTS5) + R2 (truth) + Queues; hostnames `api.sessions.vza.net` (mTLS) / `sessions.vza.net` (passkeys). Domain is **vza.net**, not vezza.dev.
- mTLS: TPM keygen → CSR → **Cloudflare managed CA** signs (own-CA root is Enterprise-only, accepted). Enrollment uses a just-in-time 1h Cloudflare API token; renewal is hub-mediated.
- **Zero Azure secrets**: OIDC issuer worker + Entra workload identity federation (managed identity, Monitoring Metrics Publisher on DCR) — patterns copied from `../youtube-mirror` (DCR OTLP protobuf, Bearer-only) and `../twitter-mirror` (provision script, keygen helper). No connection strings/instrumentation keys anywhere.
- Telemetry transport: Cloudflare **Workers observability export** (NOT Logpush) → `sessions-telemetry-gateway` worker → DCR. Hub is the sole Azure emitter; collectors heartbeat only to the hub over mTLS.
- Alerts: email, absence-KQL with **72h tolerance** (incl. webcapture-login-expired); App Insights availability test on /healthz is the hub-down watchdog.
- Collector: capture-ALL of ~/.claude + ~/.codex with exclude list (creds/caches/db-sidecars); toolUseResult preferred over truncated tool_result for indexing; per-turn `usage` table with reasoning/cache token split (max fidelity — user emphasized).
- **No Gmail access, no scheduled official exports** — one-time manual export backfill into export-inbox/ only.
- Public GitHub repo; Workers Builds auto-deploy from main + PR preview deployments (previews use bearer DEV_AUTH + -preview resources).
- `cleanupPeriodDays: 999999` already managed by chezmoi (`pedropaulovc/dotfiles`, dot_claude/settings.json) — no GC race; see [[machine-inventory]].
