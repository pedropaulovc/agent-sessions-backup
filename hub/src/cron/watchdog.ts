// Observability watchdog — runs on the */15 cron (see wrangler.jsonc triggers).
//
// Emits one structured `hub.machine.heartbeat_age` log per machine in the D1
// `machines` table on EVERY run, including machines that have gone silent. That
// is the whole point: it iterates the machine roster, not the incoming
// heartbeat stream, so a dead machine keeps producing a fresh, ever-growing
// age every 15 minutes. infra/azure/alerts/missed-heartbeat.kql thresholds on
// the latest emitted age per machine (age > 72h) over a short scan window.
//
// Why not an absence JOIN over raw hub.heartbeat events instead: Azure
// scheduled-query rules cap `overrideQueryTimeRange` at 2880 min (48h), which is
// shorter than the 72h heartbeat tolerance — a machine silent >48h would fall
// out of any self-referential baseline and the alert would self-silence. A
// per-machine gauge emitted every 15 min sidesteps that entirely.
//
// These console.log lines ride Cloudflare Workers observability → the
// sessions-telemetry-gateway → Azure Monitor OTelLogs (see infra/cf/telemetry.md).

interface MachineAgeRow {
  machine_id: string;
  last_ref: string | null;
  age_seconds: number | null;
}

export async function runWatchdog(env: Env): Promise<void> {
  // COALESCE(last_seen_at, created_at): a machine enrolled but never heard from
  // still gets an age (from enrollment), so a collector that never came up is
  // caught by the same alert rather than being invisible.
  const rows = await env.DB.prepare(
    `SELECT machine_id,
            COALESCE(last_seen_at, created_at) AS last_ref,
            CAST((julianday('now') - julianday(COALESCE(last_seen_at, created_at))) * 86400 AS INTEGER) AS age_seconds
     FROM machines`,
  ).all<MachineAgeRow>();

  for (const m of rows.results) {
    console.log(
      JSON.stringify({
        event: 'hub.machine.heartbeat_age',
        machine: m.machine_id,
        age_seconds: m.age_seconds,
        last_seen_at: m.last_ref,
      }),
    );
  }

  console.log(JSON.stringify({ event: 'hub.watchdog', machines: rows.results.length }));

  // D1 size gauge (plan wants an alert at ~7 GB). If the PRAGMA-backed
  // table-valued functions aren't available on D1 (or return nothing), emit an
  // explicit FAILING signal `bytes: -1` rather than dropping the metric — this
  // run never crashes on it (heartbeat-age above is load-bearing), but a silent
  // drop would make d1-size.kql see zero size rows exactly when the probe breaks
  // while heartbeat_age keeps missed-heartbeat.kql "healthy". d1-size.kql fires
  // on `bytes < 0` too, so a broken probe is alertable. The human-readable warn
  // is kept alongside the sentinel.
  try {
    const size = await env.DB.prepare(
      `SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes`,
    ).first<{ bytes: number }>();
    const bytes = size?.bytes ?? -1;
    console.log(JSON.stringify({ event: 'hub.d1.db_size_bytes', bytes }));
    if (bytes < 0) {
      console.log(JSON.stringify({ event: 'hub.watchdog.warn', tag: 'd1-size-unavailable', error: 'probe returned no bytes' }));
    }
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.d1.db_size_bytes', bytes: -1 }));
    console.log(JSON.stringify({ event: 'hub.watchdog.warn', tag: 'd1-size-unavailable', error: String(e) }));
  }
}
