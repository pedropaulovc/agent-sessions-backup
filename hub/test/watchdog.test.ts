import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runWatchdog } from '../src/cron/watchdog';

// runWatchdog only touches env.DB, so a hand-rolled stub exercises every branch
// without the workers D1. `prepare` dispatches on the SQL: the machines roster
// query (SELECT ... FROM machines) vs. the size probe (SELECT 1). The size probe
// reads bytes off the D1 result's `meta.size_after` (see watchdog.ts), so the
// stub models meta: a numeric size_after (real bytes), an absent size_after, or a
// throw (e.g. the production SQLITE_AUTH the PRAGMA form hit).
function makeEnv(opts: {
  machines: Array<{
    machine_id: string;
    os?: string;
    collector_version?: string | null;
    last_seen_at?: string | null;
    last_upload_at?: string | null;
    heartbeat_age_seconds: number | null;
    upload_age_seconds?: number | null;
    files_pending?: number;
    files_error?: number;
    files_parsed?: number;
    files_skipped?: number;
    files_superseded?: number;
    files_complete?: number;
    files_total?: number;
  }>;
  sessions?: { ready: number; parsing: number; error: number; total: number };
  rosterThrows?: boolean;
  size?: { throws?: boolean; bytes?: number; sizeAfterAbsent?: boolean };
}): Env {
  const sum = (key: 'files_pending' | 'files_error' | 'files_parsed' | 'files_skipped' | 'files_superseded' | 'files_complete' | 'files_total') =>
    opts.machines.reduce((total, machine) => total + (machine[key] ?? 0), 0);

  return {
    DB: {
      prepare(sql: string) {
        if (sql.includes('machines')) {
          return {
            all: async () => {
              if (opts.rosterThrows) throw new Error('no such table: machines');
              const machineRows = opts.machines.map((machine) => ({
                row_kind: 'machine',
                os: machine.os ?? 'linux',
                collector_version: machine.collector_version ?? '0.1.0',
                last_seen_at: machine.last_seen_at ?? null,
                last_upload_at: machine.last_upload_at ?? null,
                upload_age_seconds: machine.upload_age_seconds ?? null,
                files_pending: machine.files_pending ?? 0,
                files_error: machine.files_error ?? 0,
                files_parsed: machine.files_parsed ?? 0,
                files_skipped: machine.files_skipped ?? 0,
                files_superseded: machine.files_superseded ?? 0,
                files_complete: machine.files_complete ?? 0,
                files_total: machine.files_total ?? 0,
                ...machine,
              }));
              const sessions = opts.sessions ?? { ready: 0, parsing: 0, error: 0, total: 0 };
              return {
                results: [
                  ...machineRows,
                  {
                    row_kind: 'fleet',
                    machine_id: null,
                    machine_count: opts.machines.length,
                    files_pending: sum('files_pending'),
                    files_error: sum('files_error'),
                    files_parsed: sum('files_parsed'),
                    files_skipped: sum('files_skipped'),
                    files_superseded: sum('files_superseded'),
                    files_complete: sum('files_complete'),
                    files_total: sum('files_total'),
                    sessions_ready: sessions.ready,
                    sessions_parsing: sessions.parsing,
                    sessions_error: sessions.error,
                    sessions_total: sessions.total,
                  },
                ],
              };
            },
          };
        }
        // Size probe (`SELECT 1`): watchdog reads probe.meta.size_after.
        return {
          run: async () => {
            if (opts.size?.throws) throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
            const meta = opts.size?.sizeAfterAbsent ? {} : { size_after: opts.size?.bytes ?? 0 };
            return { success: true, results: [], meta };
          },
        };
      },
    },
  } as unknown as Env;
}

function captureLogs() {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* non-JSON log line, ignore */
    }
  });
  return events;
}

describe('watchdog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits exact per-machine and fleet health snapshots, heartbeat ages, and the real d1 size', async () => {
    const events = captureLogs();
    await runWatchdog(
      makeEnv({
        machines: [
          {
            machine_id: 'amet-linux',
            last_seen_at: '2026-07-17T00:00:00Z',
            last_upload_at: '2026-07-16T23:00:00Z',
            heartbeat_age_seconds: 3600,
            upload_age_seconds: 7200,
            files_pending: 2,
            files_error: 1,
            files_parsed: 90,
            files_skipped: 3,
            files_superseded: 4,
            files_complete: 97,
            files_total: 100,
          },
          {
            machine_id: 'win-host',
            os: 'windows',
            last_seen_at: '2026-07-10T00:00:00Z',
            heartbeat_age_seconds: 700000,
            files_pending: 8,
            files_parsed: 12,
            files_complete: 12,
            files_total: 20,
          },
        ],
        sessions: { ready: 50, parsing: 2, error: 1, total: 53 },
        size: { bytes: 123456 },
      }),
    );
    const machineHealth = events.filter((e) => e.event === 'hub.machine.health');
    expect(machineHealth).toHaveLength(2);
    expect(machineHealth.find((e) => e.machine === 'amet-linux')).toMatchObject({
      os: 'linux',
      last_seen_at: '2026-07-17T00:00:00Z',
      last_upload_at: '2026-07-16T23:00:00Z',
      heartbeat_age_seconds: 3600,
      upload_age_seconds: 7200,
      files_pending: 2,
      files_error: 1,
      files_parsed: 90,
      files_skipped: 3,
      files_superseded: 4,
      files_complete: 97,
      files_total: 100,
    });
    expect(events.find((e) => e.event === 'hub.fleet.health')).toMatchObject({
      machine_count: 2,
      files_pending: 10,
      files_error: 1,
      files_parsed: 102,
      files_complete: 109,
      files_total: 120,
      sessions_ready: 50,
      sessions_parsing: 2,
      sessions_error: 1,
      sessions_total: 53,
    });
    const ages = events.filter((e) => e.event === 'hub.machine.heartbeat_age');
    expect(ages.map((e) => e.machine).sort()).toEqual(['amet-linux', 'win-host']);
    expect(ages.find((e) => e.machine === 'win-host')?.age_seconds).toBe(700000);
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(123456);
    const run = events.find((e) => e.event === 'hub.watchdog.run');
    expect(run?.machine_count).toBe(2);
    expect(run?.roster_ok).toBe(true);
    expect(events.some((e) => e.event === 'hub.watchdog.warn')).toBe(false);
  });

  it('emits the hub.watchdog.run beacon and no heartbeat_age rows on an empty roster', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { bytes: 4096 } }));
    // Liveness beacon present even with zero machines — a fresh deploy before any
    // enrollment must not read as a dead pipeline (missed-heartbeat.kql keys its
    // pipeline-silent leg on this event's absence, not on missing ages).
    const run = events.find((e) => e.event === 'hub.watchdog.run');
    expect(run?.machine_count).toBe(0);
    expect(run?.roster_ok).toBe(true);
    expect(events.some((e) => e.event === 'hub.machine.heartbeat_age')).toBe(false);
    expect(events.find((e) => e.event === 'hub.fleet.health')).toMatchObject({
      machine_count: 0,
      files_pending: 0,
      files_complete: 0,
      files_total: 0,
      sessions_total: 0,
    });
  });

  it('stamps roster_ok:false on the beacon (and emits no ages) when the roster read throws', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], rosterThrows: true, size: { bytes: 4096 } }));
    const run = events.find((e) => e.event === 'hub.watchdog.run');
    // Beacon still goes out (pipeline is alive) but flags the blind spot so
    // missed-heartbeat.kql fires __roster_unavailable__ instead of reading healthy.
    expect(run?.roster_ok).toBe(false);
    expect(events.some((e) => e.event === 'hub.machine.heartbeat_age')).toBe(false);
    expect(events.some((e) => e.event === 'hub.machine.health')).toBe(false);
    expect(events.some((e) => e.event === 'hub.fleet.health')).toBe(false);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'machines-roster-unavailable')).toBe(true);
  });

  it('emits a bytes:-1 sentinel + warn when the size probe throws (e.g. SQLITE_AUTH)', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { throws: true } }));
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(-1);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'd1-size-unavailable')).toBe(true);
  });

  it('emits real bytes from meta.size_after when present', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { bytes: 5701632 } }));
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(5701632);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'd1-size-unavailable')).toBe(false);
  });

  it('emits a bytes:-1 sentinel + warn when the D1 result has no meta.size_after', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { sizeAfterAbsent: true } }));
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(-1);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'd1-size-unavailable')).toBe(true);
  });

  it('computes exact file-state and session-state counts in D1', async () => {
    const testEnv = env as unknown as Env;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO machines
           (machine_id, os, collector_version, last_seen_at, last_upload_at)
         VALUES
           ('health-linux', 'linux', '0.1.0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`,
      ),
      testEnv.DB.prepare("INSERT INTO machines (machine_id, os) VALUES ('health-windows', 'windows')"),
      ...['pending', 'reserved', 'error', 'parsed', 'skipped', 'superseded'].map((state, index) =>
        testEnv.DB.prepare(
          `INSERT INTO files
             (machine_id, store, relpath, r2_key, size, content_hash, parse_state)
           VALUES ('health-linux', 'codex-sessions', ?1, ?2, 100, ?3, ?4)`,
        ).bind(`health-${state}.jsonl`, `health/${state}.jsonl`, `hash-${index}`, state),
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, machine_id, index_state) VALUES ('health-ready', 'codex', 'health-linux', 'ready')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, machine_id, index_state) VALUES ('health-parsing', 'codex', 'health-linux', 'parsing')",
      ),
      testEnv.DB.prepare(
        "INSERT INTO sessions (session_id, harness, machine_id, index_state) VALUES ('health-error', 'codex', 'health-linux', 'error')",
      ),
    ]);

    const events = captureLogs();
    await runWatchdog(testEnv);

    const linux = events.find((event) => event.event === 'hub.machine.health' && event.machine === 'health-linux');
    expect(linux).toMatchObject({
      os: 'linux',
      collector_version: '0.1.0',
      files_pending: 2,
      files_error: 1,
      files_parsed: 1,
      files_skipped: 1,
      files_superseded: 1,
      files_complete: 3,
      files_total: 6,
    });
    expect(linux?.heartbeat_age_seconds).toBeGreaterThanOrEqual(3599);
    expect(linux?.upload_age_seconds).toBeGreaterThanOrEqual(7199);
    expect(events.find((event) => event.event === 'hub.machine.health' && event.machine === 'health-windows')).toMatchObject({
      files_pending: 0,
      files_error: 0,
      files_complete: 0,
      files_total: 0,
      last_seen_at: null,
      last_upload_at: null,
      upload_age_seconds: null,
    });
    expect(events.find((event) => event.event === 'hub.fleet.health')).toMatchObject({
      machine_count: 2,
      files_pending: 2,
      files_error: 1,
      files_parsed: 1,
      files_skipped: 1,
      files_superseded: 1,
      files_complete: 3,
      files_total: 6,
      sessions_ready: 1,
      sessions_parsing: 1,
      sessions_error: 1,
      sessions_total: 3,
    });

    const plan = await testEnv.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT machine_id,
              SUM(CASE WHEN parse_state IN ('pending', 'reserved') THEN 1 ELSE 0 END) AS files_pending,
              SUM(CASE WHEN parse_state = 'error' THEN 1 ELSE 0 END) AS files_error,
              SUM(CASE WHEN parse_state = 'parsed' THEN 1 ELSE 0 END) AS files_parsed,
              SUM(CASE WHEN parse_state = 'skipped' THEN 1 ELSE 0 END) AS files_skipped,
              SUM(CASE WHEN parse_state = 'superseded' THEN 1 ELSE 0 END) AS files_superseded,
              SUM(CASE WHEN parse_state IN ('parsed', 'skipped', 'superseded') THEN 1 ELSE 0 END) AS files_complete,
              COUNT(*) AS files_total
       FROM files
       GROUP BY machine_id`,
    ).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join('\n')).toContain(
      'SCAN files USING COVERING INDEX idx_files_machine_state',
    );
  });
});
