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
- **M1 gate results (2026-07-17, real 1.89 GB corpus / 3,618 files)**: 0 upload failures, 0.0% parse errors, 2,134 sessions, 332k blocks, 211k usage rows, 3 malformed JSON lines corpus-wide. **D1/raw size ratio measured 0.284 (above the 0.25 heuristic) — ACCEPTED, no cap tightening**: hard constraint is D1 10 GB ≈ ~35 GB raw at this ratio (~2 yrs out); 7 GB alert + cap/shard hatches cover it; search fidelity wins. Reindex initially failed the drift gate (1.1%) — root cause: reindex() omitted harness/session_id → dedupe disabled; fixed with regression test pinning "reindex reproduces ingest dedupe". Codex `response_item.agent_message`/`web_search_call` subtypes not extracted (low value, revisit in M5).
