import { reservationCutoffIso } from './queue';

const PAGE_SIZE = 10;
const LEASE_MS = 5 * 60 * 1000;
const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const LEASE_NOW = "(unixepoch() * 1000)";

// Keep the archive predicate identical to detect(): export-inbox, case-sensitive .zip suffix.
// A shared file is unsafe even when all its currently known sessions fall inside the range.
const UNSUPPORTED = `(f.store = 'export-inbox' AND f.relpath GLOB '*.zip')
  OR EXISTS (SELECT 1 FROM sessions sibling
    WHERE sibling.canonical_file_id = f.id AND sibling.session_id != s.session_id)`;
const FAILURE = `CASE
  WHEN t.dispatch_state = 'ready' THEN NULL
  WHEN t.error_code IS NOT NULL THEN t.error_code
  WHEN s.session_id IS NULL THEN 'missing_session'
  WHEN f.id IS NULL THEN 'missing_file'
  WHEN s.canonical_file_id IS NOT t.file_id THEN 'changed_canonical'
  WHEN f.content_hash IS NOT t.content_hash THEN 'changed_hash'
  WHEN ${UNSUPPORTED} THEN 'unsupported_file'
  WHEN t.dispatched_at IS NOT NULL AND (f.parse_state = 'error' OR s.index_state = 'error') THEN 'parse_failed'
  WHEN t.dispatched_at IS NOT NULL AND f.parse_state IN ('skipped', 'superseded') THEN 'parse_not_indexed'
  ELSE NULL END`;
const READY = `t.dispatched_at IS NOT NULL AND f.parse_state = 'parsed' AND s.index_state = 'ready'
  AND f.parsed_at >= t.dispatched_at AND s.updated_at >= t.dispatched_at`;
const FRESH = "f.parse_state = 'reserved' AND f.reserved_at IS NOT NULL AND f.reserved_at > ?2";
// Terminal receipts are historical; later uploads cannot invalidate an observed successful parse.
const OBSERVATIONS = `WITH observed AS (
  SELECT t.*, f.parsed_at AS observed_parsed_at, s.updated_at AS observed_updated_at, ${FAILURE} AS failure,
    CASE WHEN t.dispatch_state = 'ready' OR (${READY}) THEN 1 ELSE 0 END AS ready,
    CASE WHEN ${FRESH} THEN 1 ELSE 0 END AS blocked
  FROM reindex_range_targets t
  LEFT JOIN sessions s ON s.session_id = t.session_id
  LEFT JOIN files f ON f.id = t.file_id
  WHERE t.job_id = ?1
), classified AS (
  SELECT *, CASE WHEN failure IS NOT NULL THEN 'error' WHEN ready = 1 THEN 'ready'
    WHEN blocked = 1 THEN 'blocked' ELSE 'pending' END AS outcome FROM observed
)`;

interface JobRow {
  job_id: string;
  from_at: string;
  to_at: string;
  status: 'dispatching' | 'complete' | 'partial' | 'failed';
  created_at: string;
  finished_at: string | null;
  unsupported_count: number;
}

function reconcileStatements(env: Env, jobId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`${OBSERVATIONS} UPDATE reindex_range_targets AS t SET
      dispatch_state = (SELECT outcome FROM classified c WHERE c.session_id = t.session_id),
      error_code = (SELECT failure FROM classified c WHERE c.session_id = t.session_id),
      completed_at = ${DB_NOW},
      ready_parsed_at = (SELECT CASE WHEN outcome = 'ready' THEN observed_parsed_at END FROM classified c WHERE c.session_id = t.session_id),
      ready_updated_at = (SELECT CASE WHEN outcome = 'ready' THEN observed_updated_at END FROM classified c WHERE c.session_id = t.session_id)
      WHERE t.job_id = ?1 AND t.dispatch_state NOT IN ('ready', 'error')
      AND EXISTS (SELECT 1 FROM classified c WHERE c.session_id = t.session_id AND c.outcome IN ('ready', 'error'))
      AND EXISTS (SELECT 1 FROM reindex_range_jobs WHERE job_id = ?1 AND status = 'dispatching')`)
      .bind(jobId, reservationCutoffIso()),
    env.DB.prepare(`UPDATE reindex_range_jobs SET status = CASE
        WHEN NOT EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1 AND dispatch_state != 'ready') THEN 'complete'
        WHEN EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1 AND dispatch_state = 'ready') THEN 'partial'
        ELSE 'failed' END, finished_at = ${DB_NOW}
      WHERE job_id = ?1 AND status = 'dispatching'
      AND NOT EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1 AND dispatch_state NOT IN ('ready', 'error'))
      RETURNING status`).bind(jobId),
  ];
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  const normalized = new Date(millis).toISOString();
  // Date.parse normalizes impossible dates such as February 30; reject rather than widen scope.
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

export async function createReindexRange(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad_range' }, 400);
  const range = body as Record<string, unknown>;
  const from = utcTimestamp(range.from);
  const to = utcTimestamp(range.to);
  if (!from || !to || from > to) return json({ error: 'bad_range' }, 400);
  const jobId = crypto.randomUUID();
  // D1 batch is transactional: snapshot, preflight and job disposition share one database view.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO reindex_range_jobs (job_id, from_at, to_at, status)
      VALUES (?1, ?2, ?3, 'dispatching')`).bind(jobId, from, to),
    env.DB.prepare(`INSERT INTO reindex_range_targets
      (job_id, session_id, file_id, content_hash, baseline_parsed_at, baseline_updated_at, dispatch_state, error_code)
      SELECT ?1, s.session_id, s.canonical_file_id, f.content_hash, f.parsed_at, s.updated_at,
        CASE WHEN ${UNSUPPORTED} THEN 'error' ELSE 'pending' END,
        CASE WHEN ${UNSUPPORTED} THEN 'unsupported_file' ELSE NULL END
      FROM sessions s LEFT JOIN files f ON f.id = s.canonical_file_id
      WHERE (julianday(s.ended_at) >= julianday(?2) OR julianday(s.started_at) >= julianday(?2))
        AND julianday(s.started_at) <= julianday(?3)`)
      .bind(jobId, from, to),
    env.DB.prepare(`UPDATE reindex_range_jobs SET
      unsupported_count = (SELECT COUNT(*) FROM reindex_range_targets WHERE job_id = ?1 AND error_code = 'unsupported_file'),
      status = CASE
        WHEN EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1 AND error_code = 'unsupported_file') THEN 'failed'
        WHEN NOT EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1) THEN 'complete'
        ELSE 'dispatching' END,
      finished_at = CASE
        WHEN EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1 AND error_code = 'unsupported_file')
          OR NOT EXISTS (SELECT 1 FROM reindex_range_targets WHERE job_id = ?1) THEN ${DB_NOW} END
      WHERE job_id = ?1 RETURNING status, unsupported_count,
        (SELECT COUNT(*) FROM reindex_range_targets WHERE job_id = ?1) AS selected`).bind(jobId),
    env.DB.prepare(`UPDATE reindex_range_targets SET dispatch_state = 'error',
      error_code = COALESCE(error_code, 'preflight_aborted'), completed_at = ${DB_NOW}
      WHERE job_id = ?1 AND EXISTS (SELECT 1 FROM reindex_range_jobs WHERE job_id = ?1 AND status = 'failed')`)
      .bind(jobId),
  ]);
  const job = result[2]!.results[0] as unknown as Pick<JobRow, 'status' | 'unsupported_count'> & { selected: number };
  console.log(JSON.stringify({ event: 'hub.reindex_range.job.created', job_id: jobId,
    status: job.status, selected: job.selected, unsupported: job.unsupported_count }));
  const statusUrl = `/api/v1/admin/reindex-range/${jobId}`;
  if (job.status === 'failed') return json({ error: 'unsupported_files', job_id: jobId,
    status: 'failed', status_url: statusUrl, unsupported_count: job.unsupported_count }, 422);
  return Response.json({ job_id: jobId, status: job.status, status_url: statusUrl },
    { status: 202, headers: { Location: statusUrl, 'Cache-Control': 'no-store' } });
}

export async function getReindexRange(env: Env, jobId: string): Promise<Response> {
  const [, completed, jobs, groups] = await env.DB.batch([
    ...reconcileStatements(env, jobId),
    env.DB.prepare(`SELECT job_id, from_at, to_at, status, created_at, finished_at, unsupported_count
      FROM reindex_range_jobs WHERE job_id = ?1`).bind(jobId),
    env.DB.prepare(`${OBSERVATIONS}
      SELECT outcome, failure, dispatch_state, enqueued_at IS NOT NULL AS accepted, COUNT(*) AS count FROM classified
      GROUP BY outcome, failure, dispatch_state, accepted`).bind(jobId, reservationCutoffIso()),
  ]);
  const job = jobs!.results[0] as unknown as JobRow | undefined;
  if (!job) return json({ error: 'not_found' }, 404);
  const counts = { selected: 0, enqueued: 0, ready: 0, pending: 0, error: 0, blocked: 0 };
  const errors: Record<string, number> = {};
  let undispatched = 0;
  for (const group of groups!.results as unknown as Array<{
    outcome: 'ready' | 'pending' | 'error' | 'blocked'; failure: string | null; dispatch_state: string; accepted: number; count: number;
  }>) {
    counts.selected += group.count;
    counts[group.outcome] += group.count;
    if (group.accepted) counts.enqueued += group.count;
    if (group.failure) errors[group.failure] = (errors[group.failure] ?? 0) + group.count;
    if ((group.outcome === 'pending' || group.outcome === 'blocked') && group.dispatch_state !== 'enqueued') undispatched += group.count;
  }
  const status = job.status !== 'dispatching' ? job.status
    : undispatched > 0 ? 'dispatching' : 'indexing';
  if (completed!.results.length > 0) {
    console.log(JSON.stringify({ event: 'hub.reindex_range.job.finished', job_id: jobId, status, counts, errors }));
  }
  return json({ job_id: jobId, from: job.from_at, to: job.to_at, status, counts, errors,
    unsupported_count: job.unsupported_count, created_at: job.created_at, finished_at: job.finished_at,
    status_url: `/api/v1/admin/reindex-range/${jobId}` });
}

export async function continueReindexRange(env: Env, jobId: string): Promise<Response> {
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE reindex_range_jobs SET lease_token = ?2, lease_until = ?3
    WHERE job_id = ?1 AND status = 'dispatching' AND (lease_token IS NULL OR lease_until <= ${LEASE_NOW})
    RETURNING job_id`).bind(jobId, token, Date.now() + LEASE_MS).first();
  if (!claimed) return getReindexRange(env, jobId);
  const summary = { attempted: 0, enqueued: 0, rejected: 0, skipped: 0, lost_lease: 0 };
  try {
    const reconciled = await env.DB.batch(reconcileStatements(env, jobId));
    const finished = reconciled[1]!.results[0];
    if (finished) console.log(JSON.stringify({ event: 'hub.reindex_range.job.finished', job_id: jobId, status: finished.status }));
    const page = await env.DB.prepare(`${OBSERVATIONS} SELECT session_id FROM classified
      WHERE outcome IN ('pending', 'blocked') AND dispatch_state != 'enqueued'
      ORDER BY blocked, last_attempt_at, session_id LIMIT ${PAGE_SIZE}`)
      .bind(jobId, reservationCutoffIso()).all<{ session_id: string }>();
    for (const target of page.results) {
      summary.attempted++;
      const outcome = await dispatchTarget(env, jobId, target.session_id, token);
      summary[outcome]++;
      if (outcome === 'lost_lease') break;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'hub.reindex_range.dispatch.failed', job_id: jobId, reason: 'dispatch_storage_error' }));
    throw error;
  } finally {
    console.log(JSON.stringify({ event: 'hub.reindex_range.dispatch.summary', job_id: jobId, ...summary }));
    await env.DB.prepare(`UPDATE reindex_range_jobs SET lease_token = NULL, lease_until = NULL
      WHERE job_id = ?1 AND lease_token = ?2`).bind(jobId, token).run();
  }
  return getReindexRange(env, jobId);
}

async function dispatchTarget(env: Env, jobId: string, sessionId: string, token: string): Promise<'enqueued' | 'rejected' | 'skipped' | 'lost_lease'> {
  const renewed = await env.DB.prepare(`UPDATE reindex_range_jobs SET lease_until = ?3
    WHERE job_id = ?1 AND status = 'dispatching' AND lease_token = ?2 AND lease_until > ${LEASE_NOW}`)
    .bind(jobId, token, Date.now() + LEASE_MS).run();
  if ((renewed.meta.changes ?? 0) !== 1) return 'lost_lease';
  const owned = `EXISTS (SELECT 1 FROM reindex_range_jobs j
    WHERE j.job_id = t.job_id AND j.status = 'dispatching' AND j.lease_token = ?4 AND j.lease_until > ${LEASE_NOW})`;
  // An attempt token on the target couples all three writes. A failed guard on the first
  // statement cannot accidentally invalidate the file/session using an older sending intent.
  const prepared = await env.DB.batch([
    env.DB.prepare(`UPDATE reindex_range_targets AS t SET last_attempt_at = ?5,
      dispatch_state = CASE WHEN EXISTS (SELECT 1 FROM files f WHERE f.id = t.file_id AND ${FRESH})
        THEN 'blocked' ELSE dispatch_state END
      WHERE job_id = ?1 AND session_id = ?3 AND dispatch_state NOT IN ('enqueued', 'ready', 'error') AND ${owned}`)
      .bind(jobId, reservationCutoffIso(), sessionId, token, Date.now()),
    env.DB.prepare(`UPDATE reindex_range_targets AS t SET dispatch_state = 'sending', attempt_token = ?4,
      dispatched_at = COALESCE(dispatched_at, ${DB_NOW}), send_failed = 0,
      reason = COALESCE((SELECT CASE WHEN f.parse_state IN ('reserved', 'pending') AND f.reserved_reason IN ('recover', 'upload')
        THEN f.reserved_reason END FROM files f WHERE f.id = t.file_id), t.reason, 'reindex')
      WHERE t.job_id = ?1 AND t.session_id = ?3 AND t.dispatch_state NOT IN ('enqueued', 'ready', 'error') AND ${owned}
      AND EXISTS (SELECT 1 FROM sessions s JOIN files f ON f.id = t.file_id
        WHERE s.session_id = t.session_id AND (${FAILURE}) IS NULL AND NOT (${FRESH}) AND NOT (COALESCE((${READY}), 0)))`)
      .bind(jobId, reservationCutoffIso(), sessionId, token),
    env.DB.prepare(`UPDATE files SET parse_state = 'pending', parse_error = NULL, reserved_at = NULL, reserved_by = NULL,
      reserved_reason = CASE WHEN parse_state IN ('reserved', 'pending') THEN reserved_reason ELSE NULL END,
      reservation_generation = CASE WHEN parse_state = 'reserved' THEN reservation_generation + 1 ELSE reservation_generation END
      WHERE id = (SELECT t.file_id FROM reindex_range_targets t WHERE t.job_id = ?1 AND t.session_id = ?2 AND t.attempt_token = ?3)`)
      .bind(jobId, sessionId, token),
    env.DB.prepare(`UPDATE sessions SET index_state = 'parsing'
      WHERE session_id = ?2 AND canonical_file_id = (SELECT t.file_id FROM reindex_range_targets t
        WHERE t.job_id = ?1 AND t.session_id = ?2 AND t.attempt_token = ?3)`)
      .bind(jobId, sessionId, token),
    env.DB.prepare(`SELECT t.file_id, f.r2_key, t.content_hash, t.reason FROM reindex_range_targets t
      JOIN files f ON f.id = t.file_id WHERE t.job_id = ?1 AND t.session_id = ?2 AND t.attempt_token = ?3`)
      .bind(jobId, sessionId, token),
  ]);
  const message = prepared[4]!.results[0] as unknown as ParseMessage | undefined;
  if (!message) return 'skipped';
  try {
    await env.PARSE_QUEUE.send(message);
  } catch {
    console.warn(JSON.stringify({ event: 'hub.reindex_range.queue.rejected', job_id: jobId, reason: 'queue_send_rejected' }));
    // A transport rejection can be ambiguous. Retain the original timestamp and intent; the
    // next continuation first observes any successful parse, otherwise safely replays the send.
    await env.DB.prepare(`UPDATE reindex_range_targets AS t SET send_failed = 1 WHERE job_id = ?1
      AND session_id = ?2 AND attempt_token = ?3 AND EXISTS (SELECT 1 FROM reindex_range_jobs j
        WHERE j.job_id = t.job_id AND j.status = 'dispatching' AND j.lease_token = ?3 AND j.lease_until > ${LEASE_NOW})`)
      .bind(jobId, sessionId, token).run();
    return 'rejected';
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE reindex_range_targets AS t SET
      dispatch_state = CASE WHEN dispatch_state = 'sending' THEN 'enqueued' ELSE dispatch_state END,
      enqueued_at = ${DB_NOW}, send_failed = 0
      WHERE job_id = ?1 AND session_id = ?2 AND attempt_token = ?3 AND EXISTS (SELECT 1 FROM reindex_range_jobs j
        WHERE j.job_id = t.job_id AND j.status = 'dispatching' AND j.lease_token = ?3 AND j.lease_until > ${LEASE_NOW})`)
      .bind(jobId, sessionId, token),
    env.DB.prepare(`UPDATE files SET reserved_reason = NULL WHERE id = ?1 AND content_hash = ?2
      AND parse_state = 'pending' AND reserved_reason = ?3
      AND EXISTS (SELECT 1 FROM reindex_range_jobs WHERE job_id = ?4 AND status = 'dispatching' AND lease_token = ?5 AND lease_until > ${LEASE_NOW})`)
      .bind(message.file_id, message.content_hash, message.reason, jobId, token),
  ]);
  return 'enqueued';
}
