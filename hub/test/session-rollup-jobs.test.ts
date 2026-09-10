import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from '../src/router';
import { runSessionRollup } from '../src/session-rollup';
import { consumeSessionRollup, enqueueSessionRollup, getSessionRollupJob } from '../src/session-rollup-jobs';
import { API } from './hosts';

const testEnv = env as unknown as Env;
const db = testEnv.DB;
const PREFIX = 'rollup-job-regression-';
const ADMIN = PREFIX + 'admin';
const PATH = '/api/v1/admin/session-rollup';
const ctx = {} as ExecutionContext;

interface AcceptedJob {
  job_id: string;
  status_url: string;
}

function delivery(jobId: string) {
  return {
    id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
    body: { kind: 'session-rollup' as const, job_id: jobId },
    ack: vi.fn(), retry: vi.fn(),
  } satisfies Message<SessionRollupMessage>;
}

async function enqueue(): Promise<AcceptedJob> {
  const response = await enqueueSessionRollup(testEnv, ADMIN);
  expect(response.status).toBe(202);
  return response.json<AcceptedJob>();
}

async function job(jobId: string) {
  return (await getSessionRollupJob(testEnv, jobId)).json<{ result: unknown }>();
}

async function seedSession(suffix: string, blocks = 1): Promise<string> {
  const id = PREFIX + suffix;
  await db.batch([
    db.prepare(`INSERT INTO sessions (session_id, harness, index_state) VALUES (?1, 'omp', 'ready')`).bind(id),
    db.prepare('INSERT INTO session_rollup_state (session_id) VALUES (?1)').bind(id),
    ...Array.from({ length: blocks }, (_, turn) => db.prepare(`INSERT INTO blocks
      (session_id, file_id, turn_index, block_index, role, btype, ts, text, on_main_path)
      VALUES (?1, 0, ?2, 0, 'assistant', 'text', '2026-08-01T12:00:00Z', 'synthetic answer', 1)`)
      .bind(id, turn)),
  ]);
  return id;
}

async function checkpoint(sessionId: string) {
  return db.prepare(`SELECT status, cursor_turn, cursor_block, cursor_id, turn_state, last_attempt
    FROM session_rollup_state WHERE session_id = ?1`).bind(sessionId).first();
}

async function markRunning(jobId: string, leaseUntil: number): Promise<void> {
  await db.prepare(`UPDATE session_rollup_jobs SET status = 'running', started_at = ?2,
    lease_until = ?3, attempt_token = 'interrupted-attempt' WHERE job_id = ?1`)
    .bind(jobId, new Date(Date.now() - 25 * 60_000).toISOString(), leaseUntil).run();
}

function certRequest(path: string, method: string, fingerprint?: string): Request {
  return new Request(`${API}${path}`, {
    method,
    ...(fingerprint ? { cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fingerprint } } } : {}),
  } as unknown as RequestInit);
}

beforeEach(() => {
  // Never let the local queue auto-deliver; each test explicitly drives the real consumer.
  vi.spyOn(testEnv.ROLLUP_QUEUE, 'send').mockResolvedValue(undefined as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.batch([
    db.prepare('DELETE FROM session_rollup_jobs WHERE requested_by LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM blocks WHERE session_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM usage WHERE session_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM sessions WHERE session_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM machines WHERE machine_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM read_grants WHERE grant_id LIKE ?1').bind(PREFIX + '%'),
  ]);
});

describe('durable bounded session rollup jobs', () => {
  it('persists a pollable queued job before queue acceptance and commits the consumer result', async () => {
    const id = await seedSession('complete');
    vi.mocked(testEnv.ROLLUP_QUEUE.send).mockImplementation(async (message) => {
      expect(await job(message.job_id)).toMatchObject({ status: 'queued', result: null, finished_at: null });
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
    });
    const response = await enqueueSessionRollup(testEnv, ADMIN);
    expect(response.status).toBe(202);
    const accepted = await response.json<AcceptedJob & { status: string }>();
    expect(accepted).toEqual({ job_id: accepted.job_id, status: 'queued', status_url: `${PATH}/${accepted.job_id}` });
    expect(response.headers.get('Location')).toBe(accepted.status_url);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await checkpoint(id)).toMatchObject({ cursor_id: 0 });

    const message = delivery(accepted.job_id);
    await consumeSessionRollup(message, testEnv);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const completed = await job(accepted.job_id);
    expect(completed).toMatchObject({
      status: 'complete', error: null, started_at: expect.any(String), finished_at: expect.any(String),
      result: { examined: 1, completed: 1, failed: 0, pending: 0, remaining: 'complete' },
    });
    expect(await db.prepare('SELECT assistant_turns FROM session_rollup WHERE session_id = ?1')
      .bind(id).first()).toEqual({ assistant_turns: 1 });
  });

  it('persists rejected queue acceptance as failed and fences an ambiguously accepted late delivery', async () => {
    const id = await seedSession('rejected');
    const before = await checkpoint(id);
    vi.mocked(testEnv.ROLLUP_QUEUE.send).mockRejectedValue(new Error('queue unavailable'));
    const response = await enqueueSessionRollup(testEnv, ADMIN);
    expect(response.status).toBe(503);
    const rejected = await response.json<AcceptedJob & { error: string }>();
    expect(rejected.error).toBe('queue_acceptance_failed');
    const failed = await job(rejected.job_id);
    expect(failed).toMatchObject({ status: 'failed', result: null, finished_at: expect.any(String),
      error: expect.stringContaining('queue unavailable') });
    const message = delivery(rejected.job_id);
    await consumeSessionRollup(message, testEnv);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await job(rejected.job_id)).toEqual(failed);
    expect(await checkpoint(id)).toEqual(before);
  });

  it('records partial only for failed session work, while preserving healthy work and pending progress', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await seedSession('a-poison');
    const healthy = await seedSession('b-healthy');
    await db.prepare('UPDATE session_rollup_state SET turn_state = ?2 WHERE session_id = ?1')
      .bind(broken, '{invalid json').run();
    const accepted = await enqueue();
    const message = delivery(accepted.job_id);
    await consumeSessionRollup(message, testEnv);
    const partial = await job(accepted.job_id);
    expect(partial).toMatchObject({ status: 'partial', error: null,
      result: { failed: 1, completed: 1, pending: 1, remaining: 'pending' } });
    expect(await checkpoint(healthy)).toMatchObject({ status: 'ready' });
    expect(await checkpoint(broken)).toMatchObject({ cursor_id: 0 });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(errors.mock.calls.map(([entry]) => JSON.parse(String(entry)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'hub.session_rollup.page_failed', run_id: accepted.job_id,
        trigger: 'manual', session_id: broken }),
      expect.objectContaining({ event: 'hub.session_rollup.run', run_id: accepted.job_id,
        trigger: 'manual', outcome: 'partial', failed: 1, pending: 1 }),
    ]));

    // Making the failed session healthy cannot make a terminal duplicate start a second pass.
    await db.prepare('UPDATE session_rollup_state SET turn_state = NULL WHERE session_id = ?1').bind(broken).run();
    const before = await checkpoint(broken);
    const replay = delivery(accepted.job_id);
    await consumeSessionRollup(replay, testEnv);
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(await checkpoint(broken)).toEqual(before);
    expect(await job(accepted.job_id)).toEqual(partial);
  });

  it('completes a bounded pass with pending corpus work and never drains it on terminal replay', async () => {
    // Empty sessions consume a page each: exercise the real 80-page ceiling without a huge corpus.
    for (let index = 0; index < 81; index++) await seedSession(`bounded-${String(index).padStart(3, '0')}`, 0);
    const accepted = await enqueue();
    await consumeSessionRollup(delivery(accepted.job_id), testEnv);
    const completed = await job(accepted.job_id);
    expect(completed).toMatchObject({ status: 'complete',
      result: { pages: 80, completed: 80, failed: 0, pending: 1, remaining: 'pending' } });
    const pending = PREFIX + 'bounded-080';
    const before = await checkpoint(pending);
    const replay = delivery(accepted.job_id);
    await consumeSessionRollup(replay, testEnv);
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(replay.retry).not.toHaveBeenCalled();
    expect(await checkpoint(pending)).toEqual(before);
    expect(await job(accepted.job_id)).toEqual(completed);

    const continuation = await enqueue();
    await consumeSessionRollup(delivery(continuation.job_id), testEnv);
    expect(await job(continuation.job_id)).toMatchObject({ status: 'complete',
      result: { completed: 1, pending: 0, remaining: 'complete' } });
  });

  it('retries a late duplicate at the original lease deadline without extending crash recovery', async () => {
    const id = await seedSession('active');
    const accepted = await enqueue();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await markRunning(accepted.job_id, now + 1500);
    const before = await checkpoint(id);
    const running = await job(accepted.job_id);
    const message = delivery(accepted.job_id);
    await consumeSessionRollup(message, testEnv);
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 2 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(await job(accepted.job_id)).toEqual(running);
    expect(await checkpoint(id)).toEqual(before);
    clock.mockReturnValue(now + 2000);
    const expired = delivery(accepted.job_id);
    await consumeSessionRollup(expired, testEnv);
    expect(expired.ack).toHaveBeenCalledOnce();
    expect(expired.retry).not.toHaveBeenCalled();
    expect(await job(accepted.job_id)).toMatchObject({ status: 'failed', result: null });
    expect(await checkpoint(id)).toEqual(before);
  });

  it.each(['delivery', 'poll'] as const)('recovers an expired attempt through %s without rerunning its committed checkpoint', async (recovery) => {
    const id = await seedSession('interrupted', 2);
    await runSessionRollup(db, { maxBlocks: 1, maxPages: 1, pageSize: 1 });
    const before = await checkpoint(id);
    expect(before).toMatchObject({ status: 'building', cursor_turn: 0 });
    const accepted = await enqueue();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await markRunning(accepted.job_id, now); // Equality is expired, not an active lease.
    if (recovery === 'delivery') {
      const message = delivery(accepted.job_id);
      await consumeSessionRollup(message, testEnv);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    const failed = await job(accepted.job_id);
    expect(failed).toMatchObject({ status: 'failed', result: null, finished_at: expect.any(String),
      error: expect.stringContaining('interrupted') });
    expect(await checkpoint(id)).toEqual(before);
    await consumeSessionRollup(delivery(accepted.job_id), testEnv);
    expect(await job(accepted.job_id)).toEqual(failed);
    expect(await checkpoint(id)).toEqual(before);

    const continuation = await enqueue();
    await consumeSessionRollup(delivery(continuation.job_id), testEnv);
    expect(await job(continuation.job_id)).toMatchObject({ status: 'complete',
      result: { examined: 1, completed: 1, failed: 0, pending: 0 } });
    expect(await db.prepare('SELECT assistant_turns FROM session_rollup WHERE session_id = ?1')
      .bind(id).first()).toEqual({ assistant_turns: 2 });
  });

  it.each(['delivery', 'poll'] as const)('expires an undispatched job through %s and fences late delivery', async (recovery) => {
    const id = await seedSession('undispatched');
    const before = await checkpoint(id);
    const accepted = await enqueue();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await db.prepare('UPDATE session_rollup_jobs SET created_at = ?2 WHERE job_id = ?1')
      .bind(accepted.job_id, new Date(now - 24 * 60 * 60_000).toISOString()).run();
    if (recovery === 'delivery') await consumeSessionRollup(delivery(accepted.job_id), testEnv);
    const failed = await job(accepted.job_id);
    expect(failed).toMatchObject({ status: 'failed', result: null, started_at: null,
      finished_at: expect.any(String), error: expect.stringContaining('not started') });
    const late = delivery(accepted.job_id);
    await consumeSessionRollup(late, testEnv);
    expect(late.ack).toHaveBeenCalledOnce();
    expect(late.retry).not.toHaveBeenCalled();
    expect(await job(accepted.job_id)).toEqual(failed);
    expect(await checkpoint(id)).toEqual(before);
  });

  it('does not acknowledge or emit completion when the terminal result cannot be persisted', async () => {
    const id = await seedSession('result-write-failure');
    const accepted = await enqueue();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalPrepare = db.prepare.bind(db);
    const prepare = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes('UPDATE session_rollup_jobs SET status = ?3')) {
        const originalBind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          const bound = originalBind(...values);
          bound.run = async () => { throw new Error('terminal write unavailable'); };
          return bound;
        };
      }
      return statement;
    });
    const message = delivery(accepted.job_id);
    await consumeSessionRollup(message, testEnv);
    prepare.mockRestore();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 1200 });
    expect(await checkpoint(id)).toMatchObject({ status: 'ready' });
    expect(await job(accepted.job_id)).toMatchObject({ status: 'running', result: null, finished_at: null });
    const events = [...logs.mock.calls, ...errors.mock.calls].map(([entry]) => JSON.parse(String(entry)));
    expect(events).toContainEqual(expect.objectContaining({ event: 'hub.session_rollup.started',
      run_id: accepted.job_id, trigger: 'manual' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'hub.session_rollup.delivery_failed',
      run_id: accepted.job_id, error: 'terminal write unavailable' }));
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'hub.session_rollup.run' }));
  });
});

describe('rollup job route authorization', () => {
  const production = { ...testEnv, ENVIRONMENT: 'production' } as Env;
  const current = PREFIX + 'current';
  const previous = PREFIX + 'previous';
  const nonadmin = PREFIX + 'nonadmin';

  beforeEach(async () => {
    await db.batch([
      db.prepare(`INSERT INTO machines (machine_id, os, cert_fp_sha256, is_admin,
        prev_cert_fp_sha256, cert_revoke_at) VALUES (?1, 'linux', ?2, 1, ?3, '2999-01-01T00:00:00.000Z')`)
        .bind(ADMIN, current, previous),
      db.prepare(`INSERT INTO machines (machine_id, os, cert_fp_sha256, is_admin)
        VALUES (?1, 'linux', ?2, 0)`).bind(nonadmin, nonadmin),
    ]);
  });

  it('lets a current admin enqueue and poll the actual durable result', async () => {
    await seedSession('route');
    const response = await route(certRequest(PATH, 'POST', current), production, ctx);
    expect(response.status).toBe(202);
    const accepted = await response.json<AcceptedJob>();
    const poll = () => route(certRequest(accepted.status_url, 'GET', current), production, ctx);
    expect(await (await poll()).json()).toMatchObject({ job_id: accepted.job_id, status: 'queued' });
    await consumeSessionRollup(delivery(accepted.job_id), production);
    const completed = await poll();
    expect(completed.status).toBe(200);
    expect(completed.headers.get('Cache-Control')).toBe('no-store');
    expect(await completed.json()).toMatchObject({ status: 'complete', result: { completed: 1, pending: 0 } });
  });

  it.each([
    ['nonadmin current cert', nonadmin, 403],
    ['admin previous cert in grace', previous, 403],
    ['anonymous caller', undefined, 401],
  ] as const)('denies submission and polling to a %s', async (_label, fingerprint, status) => {
    const accepted = await enqueue();
    const queued = await job(accepted.job_id);
    vi.mocked(testEnv.ROLLUP_QUEUE.send).mockClear();
    for (const [path, method] of [[PATH, 'POST'], [accepted.status_url, 'GET']]) {
      const response = await route(certRequest(path!, method!, fingerprint), production, ctx);
      expect(response.status).toBe(status);
    }
    expect(testEnv.ROLLUP_QUEUE.send).not.toHaveBeenCalled();
    expect(await job(accepted.job_id)).toEqual(queued);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session_rollup_jobs WHERE requested_by LIKE ?1')
      .bind(PREFIX + '%').first()).toEqual({ n: 1 });
  });

  it('keeps a valid reader grant outside both admin job routes', async () => {
    const token = `agsr_${'r'.repeat(43)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`read-grant-token\0${token}`));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    await db.prepare(`INSERT INTO read_grants (grant_id, token_hash, label, created_at, expires_at)
      VALUES (?1, ?2, 'rollup reader', ?3, ?4)`).bind(PREFIX + 'grant', hash, now, now + 3_600_000).run();
    const accepted = await enqueue();
    vi.mocked(testEnv.ROLLUP_QUEUE.send).mockClear();
    const request = (path: string, method = 'GET') => new Request(`${API}${path}`, {
      method, headers: { authorization: `Bearer ${token}` },
    });
    // Positive control: denial below is admin isolation, not an invalid bearer fixture.
    const readable = await route(request('/api/v1/status'), production, ctx);
    expect(readable.status).toBe(200);
    expect(await readable.json()).toMatchObject({ identity: { kind: 'grant', label: 'rollup reader' } });
    expect((await route(request(PATH, 'POST'), production, ctx)).status).toBe(401);
    expect((await route(request(accepted.status_url), production, ctx)).status).toBe(401);
    expect(testEnv.ROLLUP_QUEUE.send).not.toHaveBeenCalled();
    expect(await job(accepted.job_id)).toMatchObject({ status: 'queued', result: null });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM session_rollup_jobs WHERE requested_by LIKE ?1')
      .bind(PREFIX + '%').first()).toEqual({ n: 1 });
  });
});
