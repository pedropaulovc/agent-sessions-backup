import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createReindexRange, continueReindexRange, getReindexRange } from '../src/reindex-range';
import { route } from '../src/router';
import { ccLine } from './fixtures';
import { API } from './hosts';
import { indexDbFor } from '../src/index-shards';
import { syncSessionCatalog } from '../src/session-catalog';

const testEnv = env as unknown as Env;
const db = testEnv.DB;
const PREFIX = 'reindex-range-test-';
const MACHINE = PREFIX + 'machine';
const PATH = '/api/v1/admin/reindex-range';
const FROM = '2026-09-03T12:00:00.000Z';
const TO = '2026-09-10T12:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';
const ctx = {} as ExecutionContext;

interface Accepted {
  job_id: string;
  status_url: string;
  status: string;
}
interface Status extends Accepted {
  from: string;
  to: string;
  counts: { selected: number; enqueued: number; ready: number; pending: number; error: number; blocked: number };
}
interface Fixture { sessionId: string; fileId: number; key: string; hash: string }
let fixtures: Fixture[];
let jobs: string[];
let sent: ParseMessage[];
let accept: (messages: ParseMessage[]) => Promise<void>;

function request(path = PATH, method = 'POST', fingerprint?: string, body?: unknown): Request {
  return new Request(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(fingerprint ? { cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fingerprint } } } : {}),
  } as unknown as RequestInit);
}

async function create(from = FROM, to = TO): Promise<Accepted> {
  const response = await createReindexRange(request(PATH, 'POST', undefined, { from, to }), testEnv);
  expect(response.status).toBe(202);
  const accepted = await response.json<Accepted>();
  jobs.push(accepted.job_id);
  expect(accepted.status_url).toBe(`${PATH}/${accepted.job_id}`);
  return accepted;
}

async function status(jobId: string): Promise<Status> {
  const response = await getReindexRange(testEnv, jobId);
  expect(response.status).toBe(200);
  return response.json<Status>();
}

async function resume(jobId: string): Promise<Status> {
  const response = await continueReindexRange(testEnv, jobId);
  expect([200, 202]).toContain(response.status);
  return response.json<Status>();
}

async function seed(started: string | null = FROM, ended: string | null = TO, store = 'claude-projects'): Promise<Fixture> {
  const sessionId = crypto.randomUUID();
  const relpath = store === 'export-inbox' ? `${sessionId}.zip` : `project/${sessionId}.jsonl`;
  const key = `raw/${MACHINE}/${store}/${relpath}`;
  const content = [
    ccLine(sessionId, { uuid: 'u1', role: 'user', text: 'private range fixture question', ts: FROM }),
    ccLine(sessionId, { uuid: 'a1', parentUuid: 'u1', role: 'assistant', text: 'private range fixture answer', ts: TO }),
  ].join('\n') + '\n';
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = 'sha256:' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await testEnv.RAW.put(key, bytes);
  const row = await db.prepare(`INSERT INTO files
    (machine_id, store, relpath, r2_key, size, content_hash, harness, session_id, parse_state, parsed_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claude-code', ?7, 'parsed', ?8) RETURNING id`)
    .bind(MACHINE, store, relpath, key, bytes.length, hash, sessionId, OLD).first<{ id: number }>();
  const fixture = { sessionId, fileId: row!.id, key, hash };
  fixtures.push(fixture);
  await db.prepare(`INSERT INTO sessions
    (session_id, harness, machine_id, canonical_file_id, started_at, ended_at, index_state, updated_at, title, cwd)
    VALUES (?1, 'claude-code', ?2, ?3, ?4, ?5, 'ready', ?6, 'private range fixture title', '/private/range/path')`)
    .bind(sessionId, MACHINE, fixture.fileId, started, ended, OLD).run();
  return fixture;
}

async function deliver(message: ParseMessage): Promise<void> {
  const delivery = { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: message, ack: vi.fn(), retry: vi.fn() };
  await worker.queue({ queue: 'parse', messages: [delivery], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
  expect(delivery.retry).not.toHaveBeenCalled();
  expect(delivery.ack).toHaveBeenCalledOnce();
}

async function state(fixture: Fixture) {
  return db.prepare(`SELECT f.parse_state, f.parsed_at, f.reserved_at, f.reserved_by, f.reserved_reason,
    f.reservation_generation, s.index_state, s.updated_at FROM files f
    LEFT JOIN sessions s ON s.session_id = ?2 WHERE f.id = ?1`)
    .bind(fixture.fileId, fixture.sessionId).first();
}

beforeEach(async () => {
  fixtures = [];
  jobs = [];
  sent = [];
  accept = async (messages) => { sent.push(...messages); };
  // Intercept both supported queue APIs; never let the simulator race explicit delivery.
  vi.spyOn(testEnv.PARSE_QUEUE, 'send').mockImplementation(async (body) => {
    await accept([body]);
    return undefined as never;
  });
  vi.spyOn(testEnv.PARSE_QUEUE, 'sendBatch').mockImplementation(async (messages) => {
    await accept(Array.from(messages, (message) => message.body));
    return undefined as never;
  });
  await db.prepare("INSERT INTO machines (machine_id, os) VALUES (?1, 'linux')").bind(MACHINE).run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { sessionId } of fixtures) {
    const indexDb = indexDbFor(testEnv, sessionId);
    await indexDb.batch([
      indexDb.prepare(
        "INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL",
      ).bind(sessionId),
      indexDb.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(sessionId),
    ]);
  }
  await db.batch([
    ...jobs.flatMap((jobId) => [
      db.prepare('DELETE FROM reindex_range_targets WHERE job_id = ?1').bind(jobId),
      db.prepare('DELETE FROM reindex_range_jobs WHERE job_id = ?1').bind(jobId),
    ]),
    ...fixtures.flatMap(({ sessionId }) => [
      db.prepare('DELETE FROM usage WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(sessionId),
    ]),
    db.prepare('DELETE FROM files WHERE machine_id = ?1').bind(MACHINE),
    db.prepare('DELETE FROM machines WHERE machine_id LIKE ?1').bind(PREFIX + '%'),
    db.prepare('DELETE FROM read_grants WHERE grant_id LIKE ?1').bind(PREFIX + '%'),
  ]);
  await syncSessionCatalog(testEnv, fixtures.map(({ sessionId }) => sessionId));
  for (const fixture of fixtures) await testEnv.RAW.delete(fixture.key);
});

describe('date-scoped reindex snapshots and parse completion', () => {
  it('selects inclusive overlap boundaries and excludes outside or unknown dates', async () => {
    const included = [
      await seed('2026-09-01T00:00:00.000Z', FROM),
      await seed(TO, TO),
      await seed('2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z'),
      await seed('2026-09-10T13:00:00+01:00', '2026-09-10T13:00:00+01:00'),
      await seed(FROM, null),
      await seed('2026-09-01T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
    ];
    const excluded = [
      await seed('2026-09-01T00:00:00.000Z', '2026-09-03T11:59:59.999Z'),
      await seed('2026-09-10T12:00:00.001Z', '2026-09-12T00:00:00.000Z'),
      await seed(null, null),
      await seed(null, TO),
    ];
    const accepted = await create();
    expect(sent).toEqual([]);
    expect(await status(accepted.job_id)).toMatchObject({ from: FROM, to: TO, counts: { selected: 6, enqueued: 0, ready: 0 } });
    await resume(accepted.job_id);
    expect(sent.map((message) => message.file_id).sort()).toEqual(included.map((fixture) => fixture.fileId).sort());
    for (const fixture of excluded) expect(await state(fixture)).toMatchObject({ parse_state: 'parsed', index_state: 'ready', parsed_at: OLD });
    const publicStatus = JSON.stringify(await status(accepted.job_id));
    for (const fixture of fixtures) {
      expect(publicStatus).not.toContain(fixture.sessionId);
      expect(publicStatus).not.toContain(fixture.key);
      expect(publicStatus).not.toContain(fixture.hash);
    }
    expect(publicStatus).not.toContain('private range fixture');
    expect(publicStatus).not.toContain('/private/range/path');
  });

  it('dispatches at most ten files per continue and never expands or reselects the snapshot', async () => {
    const selected: Fixture[] = [];
    for (let index = 0; index < 13; index++) selected.push(await seed());
    const accepted = await create();
    await resume(accepted.job_id);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(10);
    const late = await seed();
    await db.prepare("UPDATE sessions SET started_at = '2030-01-01T00:00:00.000Z', ended_at = '2030-01-02T00:00:00.000Z' WHERE machine_id = ?1")
      .bind(MACHINE).run();
    for (let page = 0; page < 13 && sent.length < 13; page++) await resume(accepted.job_id);
    expect(sent.map((message) => message.file_id).sort()).toEqual(selected.map((fixture) => fixture.fileId).sort());
    expect(await status(accepted.job_id)).toMatchObject({ status: 'indexing', counts: { selected: 13, enqueued: 13, ready: 0 } });
    expect(await state(late)).toMatchObject({ parse_state: 'parsed', index_state: 'ready' });
  });

  it('invalidates old-ready state before send and requires both fresh file and session success', async () => {
    const fixture = await seed();
    const accepted = await create();
    expect(await status(accepted.job_id)).toMatchObject({ counts: { ready: 0 } });
    accept = async (messages) => {
      expect(await state(fixture)).toMatchObject({ parse_state: 'pending', index_state: 'parsing' });
      sent.push(...messages);
    };
    await resume(accepted.job_id);
    expect(sent[0]).toMatchObject({ reason: 'reindex', content_hash: fixture.hash });
    await db.prepare("UPDATE files SET parse_state = 'parsed', parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
      .bind(fixture.fileId).run();
    expect(await status(accepted.job_id)).toMatchObject({ status: 'indexing', counts: { ready: 0 } });
    await db.prepare("UPDATE sessions SET index_state = 'ready' WHERE session_id = ?1").bind(fixture.sessionId).run();
    expect(await status(accepted.job_id)).toMatchObject({ counts: { ready: 0 } });
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { selected: 1, enqueued: 1, ready: 1, pending: 0, error: 0, blocked: 0 } });
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { ready: 1 } });
  });

  it('keeps rejected sends retryable without reporting queue acceptance', async () => {
    const fixture = await seed();
    const accepted = await create();
    accept = async () => { throw new Error('synthetic queue rejection'); };
    await continueReindexRange(testEnv, accepted.job_id);
    expect(await status(accepted.job_id)).toMatchObject({ counts: { selected: 1, enqueued: 0, ready: 0 } });
    expect(await state(fixture)).toMatchObject({ parse_state: 'pending', index_state: 'parsing' });
    accept = async (messages) => { sent.push(...messages); };
    await resume(accepted.job_id);
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { ready: 1 } });
  });

  it('fences a concurrent continue while queue acceptance is in flight', async () => {
    await seed();
    const accepted = await create();
    let entered!: () => void;
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    accept = async (messages) => { entered(); await gate; sent.push(...messages); };
    const first = continueReindexRange(testEnv, accepted.job_id);
    await sending;
    try {
      await continueReindexRange(testEnv, accepted.job_id);
    } finally {
      release();
    }
    await first;
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { ready: 1 } });
  });

  it('resumes an expired in-flight dispatch and fences the old owner from its remaining page', async () => {
    await seed();
    await seed();
    const accepted = await create();
    let entered!: () => void;
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    accept = async (messages) => { entered(); await gate; sent.push(...messages); };
    const interrupted = continueReindexRange(testEnv, accepted.job_id);
    await sending;
    try {
      // The original HTTP invocation outlives its lease while queue acceptance is ambiguous.
      await db.prepare('UPDATE reindex_range_jobs SET lease_until = 0 WHERE job_id = ?1').bind(accepted.job_id).run();
      accept = async (messages) => { sent.push(...messages); };
      await resume(accepted.job_id);
    } finally {
      release();
    }
    await interrupted;
    expect(sent).toHaveLength(3); // One ambiguous duplicate, not a second stale-owner page.
    expect(new Set(sent.map((message) => message.file_id)).size).toBe(2);
    for (const message of sent) await deliver(message);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { selected: 2, enqueued: 2, ready: 2 } });
    await resume(accepted.job_id);
    expect(sent).toHaveLength(3);
  });

  it('leaves a fresh reservation owned and retryable while unrelated targets progress', async () => {
    const reserved = await seed();
    const healthy = await seed();
    await db.prepare(`UPDATE files SET parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      reserved_by = 999999, reserved_reason = 'recover', reservation_generation = 7 WHERE id = ?1`).bind(reserved.fileId).run();
    const before = await state(reserved);
    const accepted = await create();
    await resume(accepted.job_id);
    expect(await state(reserved)).toEqual(before);
    expect(sent.map((message) => message.file_id)).toEqual([healthy.fileId]);
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ counts: { ready: 1, blocked: 1 } });
    // The owner releases its reservation; the same fixed job can now proceed.
    await db.prepare(`UPDATE files SET parse_state = 'parsed', reserved_at = NULL, reserved_by = NULL,
      reserved_reason = NULL WHERE id = ?1`).bind(reserved.fileId).run();
    await resume(accepted.job_id);
    expect(sent).toHaveLength(2);
    await deliver(sent[1]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { ready: 2, blocked: 0 } });
  });

  it('heals a stale reservation without losing recovery intent across a rejected send', async () => {
    const fixture = await seed();
    await db.prepare(`UPDATE files SET parse_state = 'reserved', reserved_at = ?2,
      reserved_by = 999999, reserved_reason = 'recover', reservation_generation = 7 WHERE id = ?1`)
      .bind(fixture.fileId, OLD).run();
    const accepted = await create();
    accept = async () => { throw new Error('synthetic recovery send rejection'); };
    await continueReindexRange(testEnv, accepted.job_id);
    expect(await state(fixture)).toMatchObject({
      parse_state: 'pending', index_state: 'parsing', reserved_at: null, reserved_by: null,
      reserved_reason: 'recover', reservation_generation: 8,
    });
    expect(await status(accepted.job_id)).toMatchObject({ counts: { enqueued: 0, blocked: 0, ready: 0 } });
    accept = async (messages) => { sent.push(...messages); };
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ file_id: fixture.fileId, reason: 'recover', content_hash: fixture.hash });
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { ready: 1 } });
  });

  it('reports changed hash, changed canonical file, and missing canonical targets while healthy work completes', async () => {
    const hashChanged = await seed();
    const canonicalChanged = await seed();
    const missing = await seed();
    const healthy = await seed();
    const replacement = await seed('2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');
    const accepted = await create();
    await db.batch([
      db.prepare("UPDATE files SET content_hash = 'sha256:changed' WHERE id = ?1").bind(hashChanged.fileId),
      db.prepare('UPDATE sessions SET canonical_file_id = ?2 WHERE session_id = ?1').bind(canonicalChanged.sessionId, replacement.fileId),
      db.prepare('UPDATE sessions SET canonical_file_id = NULL WHERE session_id = ?1').bind(missing.sessionId),
    ]);
    await resume(accepted.job_id);
    expect(sent.map((message) => message.file_id)).toEqual([healthy.fileId]);
    await deliver(sent[0]!);
    expect(await status(accepted.job_id)).toMatchObject({ status: 'partial', counts: { selected: 4, ready: 1, error: 3, pending: 0 } });
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
  });

  it('does not count a previously enqueued target after its content hash changes', async () => {
    const fixture = await seed();
    const accepted = await create();
    await resume(accepted.job_id);
    await deliver(sent[0]!);
    await db.prepare("UPDATE files SET content_hash = 'sha256:replacement' WHERE id = ?1").bind(fixture.fileId).run();
    expect(await status(accepted.job_id)).toMatchObject({ status: 'failed', counts: { ready: 0, error: 1 } });
  });

  it('preserves observed completion when an active session later uploads new content', async () => {
    const fixture = await seed();
    const accepted = await create();
    await resume(accepted.job_id);
    await deliver(sent[0]!);
    const completed = await status(accepted.job_id);
    let completionEvidence: string | undefined;
    if (completed.status !== 'complete' || completed.counts.ready !== 1) {
      // Read only on failure: successful runs retain the original delivery/status boundary.
      const observed = await db.prepare(`SELECT j.status AS stored_job_status, j.finished_at,
        t.job_id, t.session_id AS snapshot_session_id, t.file_id AS snapshot_file_id,
        t.content_hash AS snapshot_content_hash, t.baseline_parsed_at, t.baseline_updated_at,
        t.dispatch_state, t.dispatched_at, t.enqueued_at, t.completed_at,
        t.ready_parsed_at, t.ready_updated_at, t.error_code,
        f.id AS current_file_id, f.session_id AS file_session_id, f.content_hash AS current_content_hash,
        f.size, f.parsed_size, f.parse_state, f.parsed_at,
        s.session_id AS current_session_id, s.canonical_file_id, s.index_state, s.updated_at,
        f.content_hash IS t.content_hash AS snapshot_hash_matches,
        s.canonical_file_id IS t.file_id AS snapshot_canonical_matches,
        t.dispatched_at IS NOT NULL AS has_dispatch_timestamp,
        f.parse_state = 'parsed' AS file_is_parsed, s.index_state = 'ready' AS session_is_ready,
        f.parsed_at >= t.dispatched_at AS file_timestamp_is_fresh,
        s.updated_at >= t.dispatched_at AS session_timestamp_is_fresh,
        (t.dispatched_at IS NOT NULL AND f.parse_state = 'parsed' AND s.index_state = 'ready'
          AND f.parsed_at >= t.dispatched_at AND s.updated_at >= t.dispatched_at) AS ready_predicate
        FROM reindex_range_targets t JOIN reindex_range_jobs j ON j.job_id = t.job_id
        LEFT JOIN files f ON f.id = t.file_id LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE t.job_id = ?1 AND t.session_id = ?2`).bind(accepted.job_id, fixture.sessionId).first();
      completionEvidence = JSON.stringify({
        expected: { job_id: accepted.job_id, session_id: fixture.sessionId, file_id: fixture.fileId, content_hash: fixture.hash },
        sent: sent.map(({ file_id, content_hash, reason }) => ({ file_id, content_hash, reason })),
        observed,
      });
    }
    expect(completed, completionEvidence).toMatchObject({ status: 'complete', counts: { ready: 1 } });
    await db.batch([
      db.prepare("UPDATE files SET content_hash = 'sha256:later-upload', parse_state = 'pending' WHERE id = ?1").bind(fixture.fileId),
      db.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(fixture.sessionId),
    ]);
    expect(await status(accepted.job_id)).toEqual(completed);
    await resume(accepted.job_id);
    expect(sent).toHaveLength(1);
    expect(await state(fixture)).toMatchObject({ parse_state: 'pending', index_state: 'parsing' });
  });

  it('completes an empty snapshot without dispatching', async () => {
    const accepted = await create();
    expect(await status(accepted.job_id)).toMatchObject({ status: 'complete', counts: { selected: 0, enqueued: 0, ready: 0, pending: 0, error: 0, blocked: 0 } });
    await resume(accepted.job_id);
    expect(sent).toEqual([]);
  });

  it.each(['archive', 'shared file'] as const)('fails the whole snapshot closed for a selected %s before any dispatch', async (kind) => {
    // Put the unsupported target beyond a dispatch page, so page-local checks cannot pass.
    for (let index = 0; index < 11; index++) await seed();
    const unsupported = await seed(FROM, TO, kind === 'archive' ? 'export-inbox' : 'claude-projects');
    if (kind === 'shared file') {
      const outside = await seed('2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z');
      await db.prepare('UPDATE sessions SET canonical_file_id = ?2 WHERE session_id = ?1').bind(outside.sessionId, unsupported.fileId).run();
    }
    const response = await createReindexRange(request(PATH, 'POST', undefined, { from: FROM, to: TO }), testEnv);
    expect(response.status).toBe(422);
    const rejected = await response.json<Accepted>();
    jobs.push(rejected.job_id);
    expect(rejected).toMatchObject({ status: 'failed', unsupported_count: 1 });
    expect(await status(rejected.job_id)).toMatchObject({ status: 'failed', counts: { selected: 12, enqueued: 0, ready: 0 } });
    await continueReindexRange(testEnv, rejected.job_id);
    expect(sent).toEqual([]);
    for (const fixture of fixtures) expect(await state(fixture)).toMatchObject({ parse_state: 'parsed', index_state: 'ready' });
    const publicBody = JSON.stringify(rejected);
    expect(publicBody).not.toContain(unsupported.sessionId);
    expect(publicBody).not.toContain(unsupported.key);
  });

  it.each([
    {}, { from: FROM }, { from: TO, to: FROM },
    { from: 'not-a-date', to: TO }, { from: '2026-09-03', to: TO },
    { from: '2026-09-03T12:00:00+01:00', to: TO },
  ])('rejects invalid UTC range input %j without queue side effects', async (body) => {
    expect((await createReindexRange(request(PATH, 'POST', undefined, body), testEnv)).status).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe('date reindex route authorization', () => {
  const production = { ...testEnv, ENVIRONMENT: 'production' } as Env;
  const current = PREFIX + 'current';
  const previous = PREFIX + 'previous';
  const nonadmin = PREFIX + 'nonadmin';

  beforeEach(async () => {
    await db.batch([
      db.prepare(`UPDATE machines SET cert_fp_sha256 = ?2, is_admin = 1,
        prev_cert_fp_sha256 = ?3, cert_revoke_at = '2999-01-01T00:00:00.000Z' WHERE machine_id = ?1`)
        .bind(MACHINE, current, previous),
      db.prepare("INSERT INTO machines (machine_id, os, cert_fp_sha256, is_admin) VALUES (?1, 'linux', ?1, 0)").bind(nonadmin),
    ]);
  });

  it('allows only the current admin to create, dispatch and poll the real parse result', async () => {
    await seed();
    const response = await route(request(PATH, 'POST', current, { from: FROM, to: TO }), production, ctx);
    expect(response.status).toBe(202);
    const accepted = await response.json<Accepted>();
    jobs.push(accepted.job_id);
    expect(sent).toEqual([]);
    const continued = await route(request(accepted.status_url, 'POST', current), production, ctx);
    expect([200, 202]).toContain(continued.status);
    expect(await continued.json()).toMatchObject({ counts: { enqueued: 1, ready: 0 } });
    await deliver(sent[0]!);
    const polled = await route(request(accepted.status_url, 'GET', current), production, ctx);
    expect(polled.status).toBe(200);
    expect(polled.headers.get('Cache-Control')).toBe('no-store');
    expect(await polled.json()).toMatchObject({ status: 'complete', counts: { ready: 1 } });
  });

  it.each([
    ['nonadmin current cert', nonadmin, 403],
    ['admin previous cert during grace', previous, 403],
    ['anonymous caller', undefined, 401],
  ] as const)('denies create, GET and continue to %s', async (_label, fingerprint, code) => {
    await seed();
    const accepted = await create();
    const before = await status(accepted.job_id);
    for (const [path, method] of [[PATH, 'POST'], [accepted.status_url, 'GET'], [accepted.status_url, 'POST']] as const) {
      const response = await route(request(path, method, fingerprint, path === PATH ? { from: FROM, to: TO } : undefined), production, ctx);
      expect(response.status).toBe(code);
    }
    expect(sent).toEqual([]);
    expect(await status(accepted.job_id)).toEqual(before);
  });

  it('rejects a valid reader grant on create, GET and continue', async () => {
    const token = `agsr_${'q'.repeat(43)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`read-grant-token\0${token}`));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    await db.prepare(`INSERT INTO read_grants (grant_id, token_hash, label, created_at, expires_at)
      VALUES (?1, ?2, 'range reader', ?3, ?4)`).bind(PREFIX + 'grant', hash, now, now + 3_600_000).run();
    await seed();
    const accepted = await create();
    const before = await status(accepted.job_id);
    const grantRequest = (path: string, method = 'GET') => new Request(`${API}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(path === PATH ? { body: JSON.stringify({ from: FROM, to: TO }) } : {}),
    });
    const positive = await route(grantRequest('/api/v1/status'), production, ctx);
    expect(positive.status).toBe(200);
    expect(await positive.json()).toMatchObject({ identity: { kind: 'grant', label: 'range reader' } });
    for (const [path, method] of [[PATH, 'POST'], [accepted.status_url, 'GET'], [accepted.status_url, 'POST']] as const) {
      expect((await route(grantRequest(path, method), production, ctx)).status).toBe(401);
    }
    expect(sent).toEqual([]);
    expect(await status(accepted.job_id)).toEqual(before);
  });
});

describe('reindex-restored mtimes drive the canonical-copy tiebreak correctly (regression: with mtime always NULL post-reindex, the size/priority tiebreak fell through to an arbitrary id-ASC order, potentially keeping an OLDER duplicate canonical over a genuinely newer one)', () => {
  it('after both duplicates\' mtimes are lost and reindex restores them from R2, the NEWER-mtime copy is canonical, not the lower-id (older, first-uploaded) one', async () => {
    const SESSION_ID = 'e0000000-0000-4000-8000-000000000008';
    const OUTSIDE_SESSION_ID = 'e0000000-0000-4000-8000-000000000009';
    // Identical bytes keep priority and size equal, so canonical ranking must reach mtime.
    const content = `${ccLine(SESSION_ID, { uuid: 'dm-u1', role: 'user', text: 'duplicate mtime tiebreak content' })}\n`;
    const OLD_MTIME = '2019-01-01T00:00:00Z';
    const NEW_MTIME = '2026-01-01T00:00:00Z';
    const prefix = `raw/${MACHINE}/claude-projects/dup-mtime-demo/`;
    const oldRelpath = `dup-mtime-demo/copy-old/${SESSION_ID}.jsonl`;
    const newRelpath = `dup-mtime-demo/copy-new/${SESSION_ID}.jsonl`;
    const outsideRelpath = `outside-mtime-demo/${OUTSIDE_SESSION_ID}.jsonl`;

    async function putWithMtime(sessionId: string, relpath: string, mtime: string, text = content): Promise<Fixture> {
      const body = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', body);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const response = await route(new Request(`${API}/api/v1/files/${MACHINE}/claude-projects/${encodeURIComponent(relpath)}`, {
        method: 'PUT',
        headers: {
          'x-dev-machine': MACHINE,
          'x-content-hash': `sha256:${hash}`,
          'x-file-mtime': mtime,
          'content-length': String(body.length),
        },
        body,
      }), testEnv, ctx);
      expect(response.status).toBe(201);
      const { file_id: fileId } = await response.json<{ file_id: number }>();
      const fixture = { sessionId, fileId, key: `raw/${MACHINE}/claude-projects/${relpath}`, hash };
      fixtures.push(fixture);
      return fixture;
    }

    // This file intercepts both queue APIs before every test, so no earlier uploads can
    // leave simulator deliveries behind. Direct, awaited routes also avoid SELF's
    // background fetch callbacks. Register all uploads with the existing cleanup fixture.
    const older = await putWithMtime(SESSION_ID, oldRelpath, OLD_MTIME);
    const newer = await putWithMtime(SESSION_ID, newRelpath, NEW_MTIME);
    expect(older.fileId).toBeLessThan(newer.fileId);
    expect(older.hash).toBe(newer.hash);

    // Keep an actual R2 object and pending row outside the prefix even when running alone.
    // A broad reindex must expose its message; a global pending drain must alter its row.
    const outside = await putWithMtime(OUTSIDE_SESSION_ID, outsideRelpath, NEW_MTIME, 'not valid JSON\n');
    await db.batch([
      db.prepare('UPDATE files SET mtime = NULL WHERE id IN (?1, ?2)').bind(older.fileId, newer.fileId),
      db.prepare("UPDATE files SET mtime = NULL, content_hash = 'unknown' WHERE id = ?1").bind(outside.fileId),
    ]);
    // Discard setup uploads only. Everything emitted by reindex or its deliveries below
    // remains captured without prefix/file-id filtering, including an outside message.
    sent.length = 0;

    const response = await route(new Request(`${API}/api/v1/admin/reindex`, {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix }),
    }), testEnv, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enqueued: 2, done: true, cursor: null });
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([
      { file_id: older.fileId, r2_key: older.key, reason: 'reindex', content_hash: older.hash },
      { file_id: newer.fileId, r2_key: newer.key, reason: 'reindex', content_hash: newer.hash },
    ]));

    // Snapshot only the two actual messages; never drain all pending rows or append
    // continuation/recovery messages to the replay. deliver() asserts ack and no retry.
    const messages = sent.slice();
    for (const message of messages) await deliver(message);
    expect(sent).toHaveLength(2); // no unconsumed continuation/recovery work

    const oldRow = await db.prepare('SELECT mtime, size, content_hash, parse_state FROM files WHERE id = ?1')
      .bind(older.fileId).first();
    const newRow = await db.prepare('SELECT mtime, size, content_hash, parse_state FROM files WHERE id = ?1')
      .bind(newer.fileId).first();
    const size = new TextEncoder().encode(content).length;
    expect(oldRow).toEqual({ mtime: OLD_MTIME, size, content_hash: older.hash, parse_state: 'superseded' });
    expect(newRow).toEqual({ mtime: NEW_MTIME, size, content_hash: newer.hash, parse_state: 'parsed' });
    expect(await db.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID).first()).toEqual({ canonical_file_id: newer.fileId, index_state: 'ready' });

    // Neither R2 discovery nor queue delivery may repair/parse the outside-prefix file.
    expect(await db.prepare('SELECT mtime, content_hash, parse_state, parsed_at FROM files WHERE id = ?1')
      .bind(outside.fileId).first()).toEqual({ mtime: null, content_hash: 'unknown', parse_state: 'pending', parsed_at: null });
  });
});
