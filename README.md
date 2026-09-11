# agent-sessions-backup

Backup, index, search, and render AI agent/chat sessions from every machine and harness in one place.

- **Harnesses**: Claude Code, Codex CLI, OMP (Oh My Pi), ChatGPT web, Claude web (more via raw-file capture)
- **Hub**: Cloudflare Workers + D1 (SQLite FTS5 index) + R2 (raw files, source of truth) + Queues
- **Collector**: Python (uv) agent on each machine — incremental uploads over mTLS (TPM-bound client certs), heartbeats
- **Viewer**: chat-style session rendering + faceted full-text search, passkey login
- **Agent API**: JSON search/fetch endpoints (e.g. everything from today as NDJSON) for downstream AI agents
- **Observability**: Cloudflare Workers observability → OTLP gateway → Azure Application Insights (Entra workload identity federation, zero Azure secrets), email alerts

Session details keep the transcript visible by default. Expand **Activity trace** for the current page's model and tool activity, event/error filters, and links back to turns. Duration shows recorded OMP timing spans or timestamp markers; Sequence also includes events without timestamps. Per-tool totals include only recorded durations and may overlap.

OMP's collapsed System entry includes captured tool declarations and tool configuration as formatted JSON when the raw `omp-system-prompt` record contains `data.providerContext`. Older records without those fields cannot recover historical schemas. After deploying a parser update, refresh affected sessions with the current admin machine certificate: `POST /api/v1/admin/reindex` with `{"prefix":"raw/<machine>/<omp-store>/"}`. Repeat while the response is `202` / `done:false`; `200` / `done:true` means enqueueing finished, not indexing. Wait for the sessions to return to `index_state: "ready"` before checking declaration search results and transcript links.

**Statistics** starts with usage counts, separate reported token counters, model shares, and linked session rankings. Rank by activity or known cost, or select a model to filter the page. Cost and context analysis stays available in a disclosure. Unpriced records are marked unknown; partial costs are subtotals, and overlapping input/cache counters are not added into a token total.

Nightly, checkpointed rollups supply rewound assistant turns, indexed tool-result source bytes, repeated complete tool calls, and tool calls per assistant turn without scanning transcript blocks on page loads. These diagnostics show their complete-UTC-day scope, publication time, and coverage. Repeated calls and source bytes are inspection signals, not proof of waste or quality. Direct-child spend uses the filtered usage window and retains unknown-price coverage; records without session metadata remain in usage totals but cannot enter linked rankings.

## Reindex sessions overlapping a date range

After deploying the migration and Worker, use the **current admin machine certificate** on the API host.
Reader grants, non-admin certificates, and the previous certificate slot cannot create, inspect, or continue these jobs.
`POST /api/v1/admin/reindex-range` accepts required UTC `from`/`to` timestamps and returns `202` with a
durable `job_id` and `status_url`; it snapshots targets but does not enqueue them. Selection is inclusive:
`(ended_at >= from OR started_at >= from) AND started_at <= to`. Sessions with unknown start dates are
excluded. New sessions and later date changes do not expand or shrink the snapshot.

The entire job is refused with `422`, a durable failed job, and an aggregate `unsupported_count` if any
selected canonical file is an export archive or is shared by multiple sessions, even when all those sessions
are in range. No target is dispatched in that case: reparsing a shared file could mutate sessions outside
the requested range. This endpoint does not read or return transcript content, titles, paths, or credentials.

For a rolling seven-day window, the following Bash example needs `curl`, `jq`, GNU `date`, and an authorized
client-certificate setup. Set `API` to the API origin (not the viewer), and `ADMIN_CERT`/`ADMIN_KEY` to the
current admin certificate and key; use the equivalent TPM-backed client invocation where the key is non-exportable.

```bash
set -euo pipefail
to=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
from=$(date -u -d "$to -7 days" +%Y-%m-%dT%H:%M:%S.000Z)
accepted=$(curl --fail-with-body --silent --show-error \
  --cert "$ADMIN_CERT" --key "$ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg from "$from" --arg to "$to" '{from:$from,to:$to}')" \
  "$API/api/v1/admin/reindex-range")
status_url=$(jq -er '.status_url' <<<"$accepted")
printf 'Resume/poll this job: %s%s\n' "$API" "$status_url"
while :; do
  progress=$(curl --fail-with-body --silent --show-error \
    --cert "$ADMIN_CERT" --key "$ADMIN_KEY" "$API$status_url")
  jq '{job_id,status,counts,errors,unsupported_count}' <<<"$progress"
  case $(jq -r '.status' <<<"$progress") in
    complete) break ;;
    partial|failed) exit 1 ;;
    dispatching)
      curl --fail-with-body --silent --show-error \
        --cert "$ADMIN_CERT" --key "$ADMIN_KEY" -X POST "$API$status_url"
      printf '\n' ;;
    indexing) ;;
    *) exit 1 ;;
  esac
  sleep 5
done
```

Each `POST` to the saved status URL continues at most ten files. `GET` records observed outcomes but never dispatches.
`dispatching` includes retryable queue failures and targets blocked by a live reservation; continue the same
job after the owner releases it. Interrupted dispatch is resumable; a concurrent caller may need to wait
for the dispatch lease to expire. Do not create a replacement job merely to resume.
`indexing` means dispatch has finished but successful parsing is still pending.
`counts.enqueued` is queue acceptance, not completion, and overlaps the outcome counts.
Only `complete` means every selected target has fresh successful file parsing **and** a ready session
with the snapshotted canonical file and hash; an empty snapshot is also complete.
Observed successful targets and terminal job results are durable: a later upload to an active session does
not undo the completed snapshot, and continuing a terminal job never reparses it.
`partial` means some targets completed and others failed; `failed` means no target completed or preflight
refused the job. Aggregate `errors` describe missing/changed targets and parse failures without identifiers.
Neither terminal failure state is successful indexing.

## Run a bounded session-rollup pass

Using the current admin machine certificate, send `POST /api/v1/admin/session-rollup`.
It returns `202` with `{ "job_id": "...", "status": "queued", "status_url": "/api/v1/admin/session-rollup/..." }`
only after the dedicated queue accepts the job. Queue acceptance errors return `503` with the job ID and poll URL.
`GET` the returned URL with the same current-admin authorization; reader grants, non-admin certificates,
and rotated-out certificates cannot submit or inspect jobs.

Poll until `status` is `complete`, `partial`, or `failed`; `queued` and `running` are nonterminal.
Each job attempts at most 20,000 blocks across 80 pages, not a full-corpus drain.
`complete` means that bounded pass had no session failures, even when `result.pending > 0`
and `result.remaining` is `pending`. `partial` means one or more sessions failed; `failed`
includes an error and may have committed checkpoints before interruption. Submit another job explicitly
to continue remaining work. Replayed deliveries never rerun a terminal job. An interrupted running
attempt is marked failed after 20 minutes, and a job not started within 24 hours expires; polling
also resolves these timeouts if queue retries were exhausted. Late deliveries cannot restart expired jobs.

Scheduled and manual passes emit `hub.session_rollup.started` and `hub.session_rollup.run` with
`run_id` (the job ID for manual runs) and `trigger` (`scheduled` or `manual`). Run summaries include
`outcome`, elapsed `ms`, and the available counters; partial/failed outcomes and page failures use error
severity. Successful manual completion is logged only after its durable result commits.

The `ROLLUP_QUEUE` consumer is separate from parsing, with one message per invocation.
Local development uses the local queue simulator without a Cloudflare login. Protected main CI
provisions the production queue before deployment; per-PR previews create their own queue.
For standing preview, `npm --prefix hub run deploy:preview` provisions `session-rollup-preview`
before deploying and requires an explicitly supplied preview-scoped `CLOUDFLARE_API_TOKEN`.

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
