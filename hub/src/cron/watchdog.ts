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

interface HealthRow {
  row_kind: 'machine' | 'fleet';
  machine_id: string | null;
  os: string | null;
  collector_version: string | null;
  last_seen_at: string | null;
  last_upload_at: string | null;
  heartbeat_age_seconds: number | null;
  upload_age_seconds: number | null;
  machine_count: number | null;
  files_pending: number;
  files_error: number;
  files_parsed: number;
  files_skipped: number;
  files_superseded: number;
  files_complete: number;
  files_total: number;
  sessions_ready: number | null;
  sessions_parsing: number | null;
  sessions_error: number | null;
  sessions_total: number | null;
}

export async function runWatchdog(env: Env): Promise<void> {
  // Roster read is guarded so a D1 failure doesn't suppress the liveness beacon
  // below — an alive-but-D1-degraded hub should still read as "pipeline alive"
  // (the roster failure surfaces as its own warn), not as a dead pipeline.
  // The single aggregate statement returns machine rows and one fleet row. This
  // keeps the periodic snapshot to one D1 subrequest even though it covers the
  // files and sessions tables as well as the machine roster. `files_pending`
  // deliberately includes `reserved`, matching /api/v1/status: a reservation is
  // still non-terminal work until its send-late parse completes. `files_complete`
  // names the terminal non-error states explicitly so dashboard users do not
  // have to infer whether "complete" includes skipped/superseded files.
  //
  // COALESCE(last_seen_at, created_at) is used only for heartbeat age: a machine
  // enrolled but never heard from still ages from enrollment and remains
  // alertable. The exact last_seen_at remains null in the health snapshot.
  let machineCount = 0;
  let rosterOk = true;
  try {
    const rows = await env.DB.prepare(
      `WITH file_counts AS (
         SELECT machine_id,
                SUM(CASE WHEN parse_state IN ('pending', 'reserved') THEN 1 ELSE 0 END) AS files_pending,
                SUM(CASE WHEN parse_state = 'error' THEN 1 ELSE 0 END) AS files_error,
                SUM(CASE WHEN parse_state = 'parsed' THEN 1 ELSE 0 END) AS files_parsed,
                SUM(CASE WHEN parse_state = 'skipped' THEN 1 ELSE 0 END) AS files_skipped,
                SUM(CASE WHEN parse_state = 'superseded' THEN 1 ELSE 0 END) AS files_superseded,
                SUM(CASE WHEN parse_state IN ('parsed', 'skipped', 'superseded') THEN 1 ELSE 0 END) AS files_complete,
                COUNT(*) AS files_total
         FROM files
         GROUP BY machine_id
       ), session_counts AS (
         SELECT SUM(CASE WHEN index_state = 'ready' THEN 1 ELSE 0 END) AS sessions_ready,
                SUM(CASE WHEN index_state = 'parsing' THEN 1 ELSE 0 END) AS sessions_parsing,
                SUM(CASE WHEN index_state = 'error' THEN 1 ELSE 0 END) AS sessions_error,
                COUNT(*) AS sessions_total
         FROM sessions
       ), machine_health AS (
         SELECT m.machine_id, m.os, m.collector_version, m.last_seen_at, m.last_upload_at,
                CAST((julianday('now') - julianday(COALESCE(m.last_seen_at, m.created_at))) * 86400 AS INTEGER) AS heartbeat_age_seconds,
                CASE WHEN m.last_upload_at IS NULL THEN NULL
                     ELSE CAST((julianday('now') - julianday(m.last_upload_at)) * 86400 AS INTEGER)
                END AS upload_age_seconds,
                COALESCE(f.files_pending, 0) AS files_pending,
                COALESCE(f.files_error, 0) AS files_error,
                COALESCE(f.files_parsed, 0) AS files_parsed,
                COALESCE(f.files_skipped, 0) AS files_skipped,
                COALESCE(f.files_superseded, 0) AS files_superseded,
                COALESCE(f.files_complete, 0) AS files_complete,
                COALESCE(f.files_total, 0) AS files_total
         FROM machines m
         LEFT JOIN file_counts f ON f.machine_id = m.machine_id
       ), fleet_counts AS (
         SELECT COUNT(*) AS machine_count,
                COALESCE(SUM(files_pending), 0) AS files_pending,
                COALESCE(SUM(files_error), 0) AS files_error,
                COALESCE(SUM(files_parsed), 0) AS files_parsed,
                COALESCE(SUM(files_skipped), 0) AS files_skipped,
                COALESCE(SUM(files_superseded), 0) AS files_superseded,
                COALESCE(SUM(files_complete), 0) AS files_complete,
                COALESCE(SUM(files_total), 0) AS files_total
         FROM machine_health
       )
       SELECT 'machine' AS row_kind, machine_id, os, collector_version,
              last_seen_at, last_upload_at, heartbeat_age_seconds, upload_age_seconds,
              NULL AS machine_count, files_pending, files_error, files_parsed,
              files_skipped, files_superseded, files_complete, files_total,
              NULL AS sessions_ready, NULL AS sessions_parsing,
              NULL AS sessions_error, NULL AS sessions_total
       FROM machine_health
       UNION ALL
       SELECT 'fleet' AS row_kind, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              f.machine_count, f.files_pending,
              f.files_error, f.files_parsed,
              f.files_skipped, f.files_superseded,
              f.files_complete, f.files_total,
              COALESCE(s.sessions_ready, 0), COALESCE(s.sessions_parsing, 0),
              COALESCE(s.sessions_error, 0), COALESCE(s.sessions_total, 0)
       FROM fleet_counts f
       CROSS JOIN session_counts s`,
    ).all<HealthRow>();

    for (const m of rows.results) {
      if (m.row_kind === 'fleet') {
        machineCount = m.machine_count ?? 0;
        console.log(
          JSON.stringify({
            event: 'hub.fleet.health',
            machine_count: machineCount,
            files_pending: m.files_pending,
            files_error: m.files_error,
            files_parsed: m.files_parsed,
            files_skipped: m.files_skipped,
            files_superseded: m.files_superseded,
            files_complete: m.files_complete,
            files_total: m.files_total,
            sessions_ready: m.sessions_ready,
            sessions_parsing: m.sessions_parsing,
            sessions_error: m.sessions_error,
            sessions_total: m.sessions_total,
          }),
        );
        continue;
      }

      console.log(
        JSON.stringify({
          event: 'hub.machine.health',
          machine: m.machine_id,
          os: m.os,
          collector_version: m.collector_version,
          last_seen_at: m.last_seen_at,
          last_upload_at: m.last_upload_at,
          heartbeat_age_seconds: m.heartbeat_age_seconds,
          upload_age_seconds: m.upload_age_seconds,
          files_pending: m.files_pending,
          files_error: m.files_error,
          files_parsed: m.files_parsed,
          files_skipped: m.files_skipped,
          files_superseded: m.files_superseded,
          files_complete: m.files_complete,
          files_total: m.files_total,
        }),
      );

      // Kept for the existing missed-heartbeat alert contract. The richer
      // machine health event feeds the Workbook's OTel log queries, while this
      // log remains the alert's backwards-compatible input.
      console.log(
        JSON.stringify({
          event: 'hub.machine.heartbeat_age',
          machine: m.machine_id,
          age_seconds: m.heartbeat_age_seconds,
          last_seen_at: m.last_seen_at,
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
