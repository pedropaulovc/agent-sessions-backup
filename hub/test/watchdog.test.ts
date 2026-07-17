import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWatchdog } from '../src/cron/watchdog';

// runWatchdog only touches env.DB, so a hand-rolled stub exercises every branch
// without the workers D1. `prepare` dispatches on the SQL: the size query
// (PRAGMA page_count/page_size) vs. the machines roster query.
function makeEnv(opts: {
  machines: Array<{ machine_id: string; last_ref: string | null; age_seconds: number | null }>;
  rosterThrows?: boolean;
  size?: { throws?: boolean; bytes?: number | null };
}): Env {
  return {
    DB: {
      prepare(sql: string) {
        if (sql.includes('page_count')) {
          return {
            first: async () => {
              if (opts.size?.throws) throw new Error('no such function: pragma_page_count');
              return { bytes: opts.size?.bytes ?? null };
            },
          };
        }
        return {
          all: async () => {
            if (opts.rosterThrows) throw new Error('no such table: machines');
            return { results: opts.machines };
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

  it('emits a heartbeat_age per machine and the real d1 size', async () => {
    const events = captureLogs();
    await runWatchdog(
      makeEnv({
        machines: [
          { machine_id: 'amet-linux', last_ref: '2026-07-17T00:00:00Z', age_seconds: 3600 },
          { machine_id: 'win-host', last_ref: '2026-07-10T00:00:00Z', age_seconds: 700000 },
        ],
        size: { bytes: 123456 },
      }),
    );
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
  });

  it('stamps roster_ok:false on the beacon (and emits no ages) when the roster read throws', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], rosterThrows: true, size: { bytes: 4096 } }));
    const run = events.find((e) => e.event === 'hub.watchdog.run');
    // Beacon still goes out (pipeline is alive) but flags the blind spot so
    // missed-heartbeat.kql fires __roster_unavailable__ instead of reading healthy.
    expect(run?.roster_ok).toBe(false);
    expect(events.some((e) => e.event === 'hub.machine.heartbeat_age')).toBe(false);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'machines-roster-unavailable')).toBe(true);
  });

  it('emits a bytes:-1 sentinel + warn when the size probe throws', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { throws: true } }));
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(-1);
    expect(events.some((e) => e.event === 'hub.watchdog.warn' && e.tag === 'd1-size-unavailable')).toBe(true);
  });

  it('emits a bytes:-1 sentinel when the size probe returns no bytes', async () => {
    const events = captureLogs();
    await runWatchdog(makeEnv({ machines: [], size: { bytes: null } }));
    expect(events.find((e) => e.event === 'hub.d1.db_size_bytes')?.bytes).toBe(-1);
    expect(events.some((e) => e.event === 'hub.watchdog.warn')).toBe(true);
  });
});
