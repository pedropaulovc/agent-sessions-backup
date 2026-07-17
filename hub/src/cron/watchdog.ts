// Observability watchdog — runs on the */15 cron (see wrangler.jsonc triggers).
//
// Emits one structured `hub.machine.heartbeat_age` log per machine in the D1
// `machines` table on EVERY run, including machines that have gone silent. That
// is the whole point: it iterates the machine roster, not the incoming
// heartbeat stream, so a dead machine keeps producing a fresh, ever-growing
// age every 15 minutes. infra/azure/alerts/missed-heartbeat.kql thresholds on
// the latest emitted age per machine (age > 72h) over a short scan window.
//
// It ALSO emits an unconditional `hub.watchdog.run` beacon every run (even with
// zero enrolled machines). That beacon — not the presence of per-machine ages —
// is what missed-heartbeat.kql's pipeline-silent leg keys on: a fresh deploy
// with an empty roster is a legitimate live state, so liveness must be signalled
// independently of roster contents or the alert false-pages until the first
// machine enrolls. Absence of the beacon means the cron/gateway/export path
// itself is dead (the real dead-man condition).
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
  // Roster read is guarded so a D1 failure doesn't suppress the liveness beacon
  // below — an alive-but-D1-degraded hub should still read as "pipeline alive"
  // (the roster failure surfaces as its own warn), not as a dead pipeline.
  // COALESCE(last_seen_at, created_at): a machine enrolled but never heard from
  // still gets an age (from enrollment), so a collector that never came up is
  // caught by the same alert rather than being invisible.
  let machineCount = 0;
  let rosterOk = true;
  try {
    const rows = await env.DB.prepare(
      `SELECT machine_id,
              COALESCE(last_seen_at, created_at) AS last_ref,
              CAST((julianday('now') - julianday(COALESCE(last_seen_at, created_at))) * 86400 AS INTEGER) AS age_seconds
       FROM machines`,
    ).all<MachineAgeRow>();
    machineCount = rows.results.length;

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
  } catch (e) {
    // Roster read failed: no heartbeat_age rows this run, so stale-machine
    // monitoring is blind. Stamp roster_ok:false on the beacon below so
    // missed-heartbeat.kql can fire a __roster_unavailable__ row — a healthy
    // beacon alone would otherwise read as "pipeline alive, all machines fine".
    rosterOk = false;
    console.log(JSON.stringify({ event: 'hub.watchdog.warn', tag: 'machines-roster-unavailable', error: String(e) }));
  }

  // Unconditional liveness beacon (see the header). Emitted regardless of roster
  // size or a roster-read failure — its mere presence in the window tells
  // missed-heartbeat.kql the pipeline is alive; roster_ok distinguishes "alive
  // and roster readable" from "alive but roster read failed" (the latter blinds
  // stale-machine detection and must itself alert).
  console.log(JSON.stringify({ event: 'hub.watchdog.run', machine_count: machineCount, roster_ok: rosterOk }));

  // D1 size gauge (plan wants an alert at ~7 GB). Read the size from the query
  // result's `meta.size_after` (bytes after the statement ran) rather than a
  // PRAGMA: production D1 rejects `pragma_page_count()`/`pragma_page_size()` with
  // `D1_ERROR: not authorized: SQLITE_AUTH` (it worked under miniflare but is
  // blocked in prod), whereas every D1 result carries `meta.size_after` and needs
  // no special authorization. A trivial `SELECT 1` is enough to get the meta.
  // If `size_after` is somehow absent (an older/local D1 that doesn't populate it),
  // emit the explicit FAILING signal `bytes: -1` rather than dropping the metric —
  // this run never crashes on it (heartbeat-age above is load-bearing), but a
  // silent drop would make d1-size.kql see zero size rows exactly when the probe
  // breaks while heartbeat_age keeps missed-heartbeat.kql "healthy". d1-size.kql
  // fires on `bytes < 0` too, so a broken probe is alertable. The human-readable
  // warn is kept alongside the sentinel.
  try {
    const probe = await env.DB.prepare('SELECT 1').run();
    const sizeAfter = probe.meta?.size_after;
    const bytes = typeof sizeAfter === 'number' && sizeAfter >= 0 ? sizeAfter : -1;
    console.log(JSON.stringify({ event: 'hub.d1.db_size_bytes', bytes }));
    if (bytes < 0) {
      console.log(JSON.stringify({ event: 'hub.watchdog.warn', tag: 'd1-size-unavailable', error: 'meta.size_after absent from D1 result' }));
    }
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.d1.db_size_bytes', bytes: -1 }));
    console.log(JSON.stringify({ event: 'hub.watchdog.warn', tag: 'd1-size-unavailable', error: String(e) }));
  }
}
