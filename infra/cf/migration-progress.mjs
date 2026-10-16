// Aggregate-only migration copy progress. Every event is a flat, immutable record
// of public counters; no identity, cursor, digest, SQL or row data ever enters it.
// The reporter is telemetry only: it never awaits, never throws into its caller,
// and never authorizes, retries or reorders a copy step.

export const MIGRATION_PROGRESS_EVENT = 'migration.copy.progress';
export const MIGRATION_PROGRESS_SCHEMA_VERSION = 1;
// The finite public phase vocabulary. Anything else is reported as 'unknown'.
export const MIGRATION_COPY_PHASES = Object.freeze([
  'unknown', 'initializing', 'recovering', 'planning', 'copying', 'verifying', 'retiring', 'finalizing', 'complete',
]);
export const MIGRATION_COPY_STATUSES = Object.freeze(['running', 'complete', 'partial', 'failed']);
export const PROGRESS_HEARTBEAT_MS = 30_000;
export const PROGRESS_RATE_WINDOW_MS = 10 * 60_000;
const RATE_SAMPLES = 256;
// Per-page steps flip several times per page. They are visible in the next
// heartbeat's `phase` but never emitted on their own, so log volume stays bounded.
const PAGE_PHASES = new Set(['planning', 'copying', 'verifying', 'retiring']);
const stage = (phase) => (PAGE_PHASES.has(phase) ? 'page' : phase);
const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const iso = (at) => new Date(at).toISOString();

/**
 * `emit` receives each event synchronously; it must not await network I/O.
 * `observe(snapshot)` takes only durable public counters
 * `{ phase, acknowledgedRows, pendingRows, remainingRows }` (null = unknown).
 * `lastProgressAt` is the time this process observed a durable ACK increase, never
 * a heartbeat, phase change or the initially stored count. Rate and ETA are null
 * until such an increase exists; ETA also needs a known remaining count.
 */
export function createMigrationProgressReporter({
  emit, now = Date.now, setInterval: schedule = globalThis.setInterval,
  clearInterval: cancel = globalThis.clearInterval,
  heartbeatMs = PROGRESS_HEARTBEAT_MS, rateWindowMs = PROGRESS_RATE_WINDOW_MS,
} = {}) {
  if (typeof emit !== 'function') throw new TypeError('migration progress emit must be a function');
  const startedAt = now();
  let phase = 'initializing';
  let acknowledgedRows = null;
  let passBaseline = null;
  let pendingRows = null;
  let remainingRows = null;
  let lastProgressAt = null;
  let samples = [];
  let open = true;
  let timer = null;

  // Recent ACK rate over at most one window. Durable counts are a step function: a
  // sample's count held unchanged until the next sample. So the newest sample at or
  // before the window start gives the exact count there, measured over the full
  // window; otherwise the span since the oldest retained sample (startup, or after
  // the sample cap dropped older evidence) is the recent span available. A stall
  // therefore decays the rate to 0 instead of repeating the last burst.
  const rate = (at) => {
    if (lastProgressAt === null || !samples.length) return null;
    let reference = samples[0];
    for (const sample of samples) {
      if (sample.at > at - rateWindowMs) break;
      reference = sample;
    }
    const milliseconds = Math.min(rateWindowMs, at - reference.at);
    const value = milliseconds > 0 ? (acknowledgedRows - reference.rows) / (milliseconds / 1000) : null;
    return Number.isFinite(value) && value >= 0 ? value : null;
  };

  const send = (status) => {
    try {
      const at = now();
      const rowsPerSecond = rate(at);
      const etaSeconds = remainingRows === 0 ? 0
        : remainingRows !== null && rowsPerSecond > 0 ? Math.ceil(remainingRows / rowsPerSecond) : null;
      emit(Object.freeze({
        event: MIGRATION_PROGRESS_EVENT, schemaVersion: MIGRATION_PROGRESS_SCHEMA_VERSION, status, phase,
        recordedAt: iso(at), acknowledgedRows,
        passRows: acknowledgedRows === null || passBaseline === null ? null : acknowledgedRows - passBaseline,
        pendingRows, elapsedMs: Math.max(0, at - startedAt),
        // Unrounded: the published rate is exactly the one the ETA divides by.
        rowsPerSecond,
        remainingRows, etaSeconds, lastProgressAt: lastProgressAt === null ? null : iso(lastProgressAt),
      }));
    } catch { /* Telemetry never reaches the copy. */ }
  };

  const close = () => {
    open = false;
    if (timer === null) return;
    try { cancel(timer); } catch { /* Nothing else is scheduled. */ }
    timer = null;
  };

  send('running');
  try {
    timer = schedule(() => { if (open) send('running'); }, heartbeatMs);
    timer?.unref?.();
  } catch { timer = null; }

  return Object.freeze({
    observe(snapshot) {
      if (!open || snapshot === null || typeof snapshot !== 'object') return;
      try {
        const next = MIGRATION_COPY_PHASES.includes(snapshot.phase) ? snapshot.phase : 'unknown';
        const ack = counter(snapshot.acknowledgedRows);
        const remaining = counter(snapshot.remainingRows);
        const learned = acknowledgedRows === null && ack !== null || remainingRows === null && remaining !== null;
        if (ack !== null) {
          const at = now();
          if (acknowledgedRows === null || ack < acknowledgedRows) {
            // First durable count (or an impossible rewind): new evidence, no progress.
            passBaseline = ack;
            samples = [{ at, rows: ack }];
            lastProgressAt = null;
          } else if (ack > acknowledgedRows) {
            lastProgressAt = at;
            samples.push({ at, rows: ack });
            while (samples.length > 1 && (samples.length > RATE_SAMPLES || samples[1].at <= at - rateWindowMs)) samples.shift();
          }
          acknowledgedRows = ack;
        }
        pendingRows = counter(snapshot.pendingRows);
        remainingRows = remaining;
        const changed = stage(next) !== stage(phase);
        phase = next;
        // The terminal phase is reported once, by finish().
        if ((changed || learned) && next !== 'complete') send('running');
      } catch { /* Telemetry never reaches the copy. */ }
    },
    /** Emit the single terminal event and stop. Later calls are ignored. */
    finish(status) {
      if (!open) return;
      send(MIGRATION_COPY_STATUSES.includes(status) && status !== 'running' ? status : 'failed');
      close();
    },
    close,
  });
}
