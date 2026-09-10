import { logRollupOutcome, runSessionRollupPass, type RollupOutcome } from './cron/session-rollup';
import type { SessionRollupResult } from './session-rollup';

// Queue invocations have a 15-minute wall-time limit. Never take an active attempt's work:
// after 20 minutes its terminal result is unknown, so fail it rather than run a second pass.
const ATTEMPT_LEASE_MS = 20 * 60 * 1000;
const DISPATCH_DEADLINE_MS = 24 * 60 * 60 * 1000;

interface RollupJobRow {
  job_id: string;
  status: 'queued' | 'running' | 'complete' | 'partial' | 'failed';
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_until: number | null;
  result_json: string | null;
  error: string | null;
  ms: number | null;
}

export async function enqueueSessionRollup(env: Env, requestedBy: string): Promise<Response> {
  const jobId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO session_rollup_jobs (job_id, requested_by, status, created_at)
    VALUES (?1, ?2, 'queued', ?3)`).bind(jobId, requestedBy, createdAt).run();
  const statusUrl = `/api/v1/admin/session-rollup/${jobId}`;
  try {
    await env.ROLLUP_QUEUE.send({ kind: 'session-rollup', job_id: jobId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed = await env.DB.prepare(`UPDATE session_rollup_jobs SET status = 'failed', error = ?2,
      finished_at = ?3, ms = 0 WHERE job_id = ?1 AND status = 'queued'`)
      .bind(jobId, `Queue acceptance failed: ${detail}`, new Date().toISOString()).run();
    if ((failed.meta.changes ?? 0) > 0) {
      logRollupOutcome({ run_id: jobId, trigger: 'manual' },
        { outcome: 'failed', error: `Queue acceptance failed: ${detail}`, ms: 0 });
    }
    // A transport error can be ambiguous: the queue may already have received the message.
    // The durable row fences a late delivery, or exposes the running attempt to the caller.
    return Response.json({ error: 'queue_acceptance_failed', job_id: jobId, status_url: statusUrl }, { status: 503 });
  }
  return Response.json({ job_id: jobId, status: 'queued', status_url: statusUrl },
    { status: 202, headers: { Location: statusUrl, 'Cache-Control': 'no-store' } });
}

async function failExpiredJob(env: Env, jobId: string): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(`UPDATE session_rollup_jobs SET status = 'failed',
    error = CASE WHEN status = 'queued'
      THEN 'Job not started within 24 hours; late delivery will not run. Submit a new job to continue.'
      ELSE 'Attempt interrupted; committed checkpoints retained. Submit a new job to continue.' END,
    finished_at = ?3, ms = CASE WHEN started_at IS NULL THEN 0
      ELSE MAX(0, ?2 - CAST(strftime('%s', started_at) AS INTEGER) * 1000) END,
    lease_until = NULL, attempt_token = NULL
    WHERE job_id = ?1 AND ((status = 'running' AND lease_until <= ?2)
      OR (status = 'queued' AND created_at <= ?4))
    RETURNING error, ms`).bind(jobId, now, new Date(now).toISOString(),
      new Date(now - DISPATCH_DEADLINE_MS).toISOString()).first<{ error: string; ms: number }>();
  if (row) logRollupOutcome({ run_id: jobId, trigger: 'manual' }, { outcome: 'failed', ...row });
}

export async function getSessionRollupJob(env: Env, jobId: string): Promise<Response> {
  // Polling also expires jobs if queue retries were exhausted during a D1 outage.
  await failExpiredJob(env, jobId);
  const row = await env.DB.prepare(`SELECT job_id, status, created_at, started_at, finished_at,
    lease_until, result_json, error, ms FROM session_rollup_jobs WHERE job_id = ?1`)
    .bind(jobId).first<RollupJobRow>();
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  const { result_json, lease_until: _lease, ...job } = row;
  return Response.json({ ...job, result: result_json ? JSON.parse(result_json) as SessionRollupResult : null },
    { headers: { 'Cache-Control': 'no-store' } });
}

export async function consumeSessionRollup(message: Message<SessionRollupMessage>, env: Env): Promise<void> {
  const jobId = message.body.job_id;
  try {
    await failExpiredJob(env, jobId);
    const token = crypto.randomUUID();
    const now = Date.now();
    const claimed = await env.DB.prepare(`UPDATE session_rollup_jobs SET status = 'running',
      started_at = ?2, attempt_token = ?3, lease_until = ?4
      WHERE job_id = ?1 AND status = 'queued'`)
      .bind(jobId, new Date(now).toISOString(), token, now + ATTEMPT_LEASE_MS).run();
    if ((claimed.meta.changes ?? 0) === 0) {
      const current = await env.DB.prepare('SELECT status, lease_until FROM session_rollup_jobs WHERE job_id = ?1')
        .bind(jobId).first<{ status: string; lease_until: number }>();
      if (current?.status === 'running') {
        message.retry({ delaySeconds: Math.max(1, Math.ceil((current.lease_until - Date.now()) / 1000)) });
        return;
      }
      message.ack(); // Terminal replay (or no durable job) must never start another pass.
      return;
    }
    await runSessionRollupPass(env, { run_id: jobId, trigger: 'manual' }, async (outcome: RollupOutcome) => {
      const saved = await env.DB.prepare(`UPDATE session_rollup_jobs SET status = ?3, result_json = ?4,
        error = ?5, ms = ?6, finished_at = ?7, attempt_token = NULL, lease_until = NULL
        WHERE job_id = ?1 AND status = 'running' AND attempt_token = ?2`)
        .bind(jobId, token, outcome.outcome, 'result' in outcome ? JSON.stringify(outcome.result) : null,
          'error' in outcome ? outcome.error : null, outcome.ms, new Date().toISOString()).run();
      if ((saved.meta.changes ?? 0) !== 1) throw new Error('Rollup attempt lost its durable ownership');
    });
    message.ack();
  } catch (error) {
    // No success/ack until persistence succeeds. Redelivery will resolve a terminal commit
    // or fail the interrupted attempt after its lease, retaining all committed checkpoints.
    console.error(JSON.stringify({ event: 'hub.session_rollup.delivery_failed', run_id: jobId,
      trigger: 'manual', error: error instanceof Error ? error.message : String(error) }));
    message.retry({ delaySeconds: ATTEMPT_LEASE_MS / 1000 });
  }
}
