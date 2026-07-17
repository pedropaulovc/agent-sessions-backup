import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { clampLimit } from '../src/api/sessions';
import { CODEX_SESSION_ID, ccAssistantLine, ccUserLine, codexLines } from './fixtures';

const testEnv = env as unknown as Env;
const MACHINE = 'regbox';

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function putFile(store: string, relpath: string, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${MACHINE}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': MACHINE,
      'x-content-hash': `sha256:${await sha256Hex(body)}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(body.length),
    },
    body,
  });
}

/** Drain: run the queue consumer over all currently-pending files. */
async function drainQueue(): Promise<void> {
  const pending = await testEnv.DB.prepare("SELECT id, r2_key FROM files WHERE parse_state = 'pending'").all<{
    id: number;
    r2_key: string;
  }>();
  const messages = pending.results.map((r) => ({
    id: String(r.id),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: r.id, r2_key: r.r2_key, reason: 'upload' as const },
    ack() {},
    retry() {},
  }));
  if (messages.length === 0) return;
  await worker.queue({ queue: 'parse', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
}

/** Deliver a single, explicitly-specified message — bypasses the parse_state='pending' filter
 * drainQueue() uses, for tests that need to redeliver a file regardless of its current row state.
 * An explicit contentHash simulates redelivering a message enqueued for a since-superseded
 * upload — the consumer's hash guards use it to detect the row has since moved on. */
async function deliverOne(fileId: number, r2Key: string, contentHash?: string): Promise<void> {
  const message = {
    id: String(fileId),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: fileId, r2_key: r2Key, reason: 'upload' as const, ...(contentHash !== undefined ? { content_hash: contentHash } : {}) },
    ack() {},
    retry() {},
  };
  await worker.queue(
    { queue: 'parse', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
    testEnv,
  );
}

describe('clampLimit', () => {
  it('clamps to [1, max], defaulting on missing/non-positive/NaN input', () => {
    expect(clampLimit(null, 20, 100)).toBe(20);
    expect(clampLimit('', 20, 100)).toBe(20);
    expect(clampLimit('abc', 20, 100)).toBe(20);
    expect(clampLimit('-5', 20, 100)).toBe(20);
    expect(clampLimit('0', 20, 100)).toBe(20);
    expect(clampLimit('1', 20, 100)).toBe(1);
    expect(clampLimit('100', 20, 100)).toBe(100);
    expect(clampLimit('101', 20, 100)).toBe(100);
    expect(clampLimit('1e9', 20, 100)).toBe(100);
    expect(clampLimit('3.7', 20, 100)).toBe(3);
  });

  it('a fractional limit below 1 floors to 1, not 0 (regression: limit=0.5 produced LIMIT 0 — empty pages plus a cursor that loops forever)', () => {
    expect(clampLimit('0.5', 20, 100)).toBe(1);
    expect(clampLimit('0.1', 20, 100)).toBe(1);
  });
});

describe('the local queue simulator does not auto-deliver PARSE_QUEUE messages on its own timer (regression: a real, uncontrolled background flush raced tests that deliberately leave a row pending, e.g. CI intermittently indexing a file the test never explicitly delivered)', () => {
  it('an uploaded file stays parse_state=pending across a real-time window well past the local queue\'s default auto-flush, since nothing here ever calls drainQueue/deliverOne', async () => {
    const content = `${ccUserLine({ uuid: 'noauto-u1', text: 'no automatic delivery test content' })}\n`;
    const relpath = 'noauto-demo/f0000000-0000-4000-8000-0000000000aa.jsonl';
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { file_id: number }).file_id;

    // The local queue simulator was observed auto-flushing a pending message well under 1.5s of
    // real wall-clock time when the consumer's max_batch_timeout is left at its (short) local
    // default. vitest.config.ts overrides queueConsumers.parse to the config maximums
    // (maxBatchTimeout: 60s, maxBatchSize: 100) specifically so this can't happen — this test
    // waits past the previously-observed auto-flush window to prove that override is in effect.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const row = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(row?.parse_state).toBe('pending');
  }, 10000);
});

describe('search/listSessions limit clamp over HTTP (regression: NaN/negative used to reach SQL as LIMIT NaN / LIMIT -1)', () => {
  it('search: a non-numeric limit no longer 500s', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=zzznonexistentzzz&limit=abc', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: unknown[] };
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('search: a negative limit no longer 500s', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=zzznonexistentzzz&limit=-5', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
  });

  it('listSessions: a non-numeric limit no longer 500s', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions?limit=abc', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
  });

  it('listSessions: a negative limit does not stream an unbounded ndjson response', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions?format=ndjson&limit=-1', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
  });
});

describe('codex ingestion: usage.ts', () => {
  it('usage rows carry a non-null ts (regression: response_item turns used to drop ts, breaking day-grouping)', async () => {
    const relpath = `2026/07/02/rollout-2026-07-02T09-00-00-${CODEX_SESSION_ID}.jsonl`;
    const res = await putFile('codex-sessions', relpath, `${codexLines().join('\n')}\n`);
    expect(res.status).toBe(201);
    await drainQueue();

    const rows = await testEnv.DB.prepare('SELECT ts FROM usage WHERE session_id = ?1')
      .bind(CODEX_SESSION_ID)
      .all<{ ts: string | null }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) expect(r.ts).not.toBeNull();
  });
});

describe('getSessionRaw range handling', () => {
  const RANGE_SESSION_ID = '33333333-4444-4444-8444-555555555555';
  const content = `${[
    ccUserLine({ uuid: 'r-u1', text: 'range test content, needs to be reasonably long for a meaningful byte range' }),
    ccAssistantLine({ uuid: 'r-a1', parentUuid: 'r-u1', text: 'range test response' }),
  ].join('\n')}\n`;

  beforeAll(async () => {
    const res = await putFile('claude-projects', `range-demo/${RANGE_SESSION_ID}.jsonl`, content);
    expect(res.status).toBe(201);
    await drainQueue();
  });

  it('returns 206 with Content-Range for a valid byte range', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${RANGE_SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': MACHINE, range: 'bytes=0-9' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toMatch(/^bytes 0-9\/\d+$/);
    const body = await res.text();
    expect(body.length).toBe(10);
  });

  it('falls back to a full 200 for an unparseable Range header (suffix form) — never a misleading 206', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${RANGE_SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': MACHINE, range: 'bytes=-500' },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBe(content.length);
  });

  it('plain 200 with no Range header at all', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${RANGE_SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
  });

  it('falls back to a full 200 for an inverted range (end < start) instead of forwarding a negative length to R2 (regression: bytes=100-50 computed {offset:100, length:-49})', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${RANGE_SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': MACHINE, range: 'bytes=100-50' },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBe(content.length);
  });
});

describe('upload unchanged fast-path re-enqueues stuck files', () => {
  const REQUEUE_SESSION_ID = '44444444-5555-4444-8444-555555555555';
  const relpath = `requeue-demo/${REQUEUE_SESSION_ID}.jsonl`;
  const content = `${ccUserLine({ uuid: 'q-u1', text: 'requeue test content' })}\n`;

  it('re-upload of a hash-matching row stuck at parse_state != parsed/skipped/superseded triggers a requeue', async () => {
    const first = await putFile('claude-projects', relpath, content);
    expect(first.status).toBe(201);
    const fileId = ((await first.json()) as { file_id: number }).file_id;
    await drainQueue();

    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed');

    // Simulate a lost/failed queue message: the row never finished indexing.
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'error' WHERE id = ?1").bind(fileId).run();

    const reupload = await putFile('claude-projects', relpath, content);
    expect(reupload.status).toBe(200);
    const reuploadBody = (await reupload.json()) as { status: string; file_id: number; requeued?: boolean };
    expect(reuploadBody.status).toBe('unchanged');
    expect(reuploadBody.requeued).toBe(true);

    // The response handler flips the row to 'pending' BEFORE sending the parse message (round 17:
    // a row with an outstanding message must be non-terminal, so files/check and this same fast
    // path can self-heal a lost/dead-lettered delivery) — no longer left at the stale 'error'.
    const nowPending = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(nowPending?.parse_state).toBe('pending');

    const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;
    await deliverOne(fileId, r2Key);

    const recovered = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(recovered?.parse_state).toBe('parsed');
  });

  it('re-upload of a hash-matching row already parsed does NOT requeue', async () => {
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; requeued?: boolean };
    expect(body.status).toBe('unchanged');
    expect(body.requeued).toBeUndefined();
  });

  it('re-upload of a hash-matching row errored because its R2 object was lost restores the object before requeueing, and the session recovers', async () => {
    const RESTORE_SESSION_ID = '44444444-5555-4444-8444-666666666666';
    const restoreRelpath = `restore-demo/${RESTORE_SESSION_ID}.jsonl`;
    const restoreContent = `${ccUserLine({ uuid: 'r-u1', text: 'restore test content' })}\n`;

    const first = await putFile('claude-projects', restoreRelpath, restoreContent);
    expect(first.status).toBe(201);
    const fileId = ((await first.json()) as { file_id: number }).file_id;
    await drainQueue();

    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed');

    // Simulate the flagship failure this recovers from: the row's own raw R2 object is gone
    // (lost/corrupted), and the row got marked 'error' as a result (e.g. by a reparse attempt).
    const r2Key = `raw/${MACHINE}/claude-projects/${restoreRelpath}`;
    await testEnv.RAW.delete(r2Key);
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'error' WHERE id = ?1").bind(fileId).run();
    expect(await testEnv.RAW.head(r2Key)).toBeNull();

    // The collector re-sends the identical bytes (same hash) — the unchanged fast path must
    // notice the object is missing and restore it before requeueing, not just requeue a parse
    // that will hit the same missing object again.
    const reupload = await putFile('claude-projects', restoreRelpath, restoreContent);
    expect(reupload.status).toBe(200);
    const reuploadBody = (await reupload.json()) as { status: string; file_id: number; requeued?: boolean; restored?: boolean };
    expect(reuploadBody.status).toBe('unchanged');
    expect(reuploadBody.requeued).toBe(true);
    expect(reuploadBody.restored).toBe(true);

    const restoredObj = await testEnv.RAW.head(r2Key);
    expect(restoredObj).not.toBeNull();

    // The response handler only sent a queue message and never touched parse_state (still
    // 'error'), so drainQueue()'s pending-only filter wouldn't pick this row up — deliver the
    // message explicitly, same as the existing stuck-file requeue test above.
    await deliverOne(fileId, r2Key);

    const recoveredFile = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(recoveredFile?.parse_state).toBe('parsed');

    const recoveredSession = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind(RESTORE_SESSION_ID)
      .first<{ index_state: string }>();
    expect(recoveredSession?.index_state).toBe('ready');
  });

  it('re-upload of a hash-matching row that is TERMINAL (already parsed) but whose R2 object was lost also restores the object and re-parses', async () => {
    const TERMINAL_RESTORE_SESSION_ID = '44444444-5555-4444-8444-777777777777';
    const terminalRelpath = `terminal-restore-demo/${TERMINAL_RESTORE_SESSION_ID}.jsonl`;
    const terminalContent = `${ccUserLine({ uuid: 'tr-u1', text: 'terminal restore test content' })}\n`;

    const first = await putFile('claude-projects', terminalRelpath, terminalContent);
    expect(first.status).toBe(201);
    const fileId = ((await first.json()) as { file_id: number }).file_id;
    await drainQueue();

    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed'); // terminal — the row itself is NOT touched

    // Lose the backing R2 object without touching the D1 row at all: parse_state stays 'parsed'.
    const r2Key = `raw/${MACHINE}/claude-projects/${terminalRelpath}`;
    await testEnv.RAW.delete(r2Key);
    expect(await testEnv.RAW.head(r2Key)).toBeNull();

    // A resync (e.g. the collector's periodic files/check) re-sends the identical bytes. The
    // terminal unchanged path must still notice the object is gone and restore + reparse it,
    // not just return the cheap "nothing to do" response it used to for a terminal row.
    const reupload = await putFile('claude-projects', terminalRelpath, terminalContent);
    expect(reupload.status).toBe(200);
    const reuploadBody = (await reupload.json()) as { status: string; requeued?: boolean; restored?: boolean };
    expect(reuploadBody.status).toBe('unchanged');
    expect(reuploadBody.requeued).toBe(true);
    expect(reuploadBody.restored).toBe(true);

    expect(await testEnv.RAW.head(r2Key)).not.toBeNull();

    await deliverOne(fileId, r2Key);

    const recoveredFile = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(recoveredFile?.parse_state).toBe('parsed');

    const recoveredSession = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind(TERMINAL_RESTORE_SESSION_ID)
      .first<{ index_state: string }>();
    expect(recoveredSession?.index_state).toBe('ready');
  });

  it('a restored terminal row is pending IMMEDIATELY after the response, not left terminal while its parse message is in flight — and a repeat same-hash reupload before delivery still requeues', async () => {
    const PENDING_RESTORE_SESSION_ID = '44444444-5555-4444-8444-999999999999';
    const pendingRestoreRelpath = `pending-restore-demo/${PENDING_RESTORE_SESSION_ID}.jsonl`;
    const pendingRestoreContent = `${ccUserLine({ uuid: 'pr-u1', text: 'pending restore test content' })}\n`;

    const first = await putFile('claude-projects', pendingRestoreRelpath, pendingRestoreContent);
    expect(first.status).toBe(201);
    const fileId = ((await first.json()) as { file_id: number }).file_id;
    await drainQueue();

    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed'); // terminal going in

    // Lose the backing R2 object without touching the D1 row at all: parse_state stays 'parsed'.
    const r2Key = `raw/${MACHINE}/claude-projects/${pendingRestoreRelpath}`;
    await testEnv.RAW.delete(r2Key);

    const reupload = await putFile('claude-projects', pendingRestoreRelpath, pendingRestoreContent);
    expect(reupload.status).toBe(200);
    const reuploadBody = (await reupload.json()) as { status: string; requeued?: boolean; restored?: boolean };
    expect(reuploadBody.requeued).toBe(true);
    expect(reuploadBody.restored).toBe(true);

    // Regression assertion: the row must be 'pending' IMMEDIATELY after the response, not still
    // 'parsed' while its freshly-sent parse message is in flight. Without markPendingAndEnqueue's
    // flip, a send failure (or a later dropped/dead-lettered message) would leave the row
    // terminal forever — a same-hash retry or files/check would both read a 'parsed' row as
    // "done, nothing to do" and never repair it.
    const nowPending = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(nowPending?.parse_state).toBe('pending');

    // Simulate the just-sent parse message getting lost: don't deliver it. A second same-hash
    // reupload before delivery must still see a non-terminal row and requeue via the plain
    // non-terminal branch — no restore needed this time, since the object is already correct.
    const secondReupload = await putFile('claude-projects', pendingRestoreRelpath, pendingRestoreContent);
    expect(secondReupload.status).toBe(200);
    const secondBody = (await secondReupload.json()) as { status: string; requeued?: boolean; restored?: boolean };
    expect(secondBody.requeued).toBe(true);
    expect(secondBody.restored).toBe(false);

    await deliverOne(fileId, r2Key);
    const recovered = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(recovered?.parse_state).toBe('parsed');
  });

  it('re-upload of a hash-matching row whose R2 object is PRESENT but CORRUPT (wrong bytes at the same key) also restores it, not just a missing object', async () => {
    const CHECKSUM_RESTORE_SESSION_ID = '44444444-5555-4444-8444-888888888888';
    const checksumRelpath = `checksum-restore-demo/${CHECKSUM_RESTORE_SESSION_ID}.jsonl`;
    const checksumContent = `${ccUserLine({ uuid: 'csr-u1', text: 'checksum restore test content' })}\n`;

    const first = await putFile('claude-projects', checksumRelpath, checksumContent);
    expect(first.status).toBe(201);
    const fileId = ((await first.json()) as { file_id: number }).file_id;
    await drainQueue();

    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed');

    // Corrupt the R2 object IN PLACE without touching the D1 row: same key, different bytes,
    // no sha256 option (simulating a bad manual restore/replacement outside this API). HEAD
    // still succeeds — this is exactly what a naive "does the object exist" check would miss.
    const r2Key = `raw/${MACHINE}/claude-projects/${checksumRelpath}`;
    await testEnv.RAW.put(r2Key, new TextEncoder().encode('corrupted bytes, wrong content entirely'));
    expect(await testEnv.RAW.head(r2Key)).not.toBeNull(); // present...
    const corruptedObj = await testEnv.RAW.get(r2Key);
    expect(await corruptedObj?.text()).not.toContain('checksum restore test content'); // ...but wrong

    // The collector re-sends the SAME (correct) bytes it always had — same hash from D1's
    // perspective, hitting the unchanged fast path — which must detect the checksum mismatch
    // and restore the correct bytes rather than trusting HEAD's mere existence.
    const reupload = await putFile('claude-projects', checksumRelpath, checksumContent);
    expect(reupload.status).toBe(200);
    const reuploadBody = (await reupload.json()) as { status: string; requeued?: boolean; restored?: boolean };
    expect(reuploadBody.status).toBe('unchanged');
    expect(reuploadBody.requeued).toBe(true);
    expect(reuploadBody.restored).toBe(true);

    const restoredObj = await testEnv.RAW.get(r2Key);
    expect(await restoredObj?.text()).toBe(checksumContent);

    await deliverOne(fileId, r2Key);

    const recoveredFile = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(recoveredFile?.parse_state).toBe('parsed');

    const recoveredSession = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind(CHECKSUM_RESTORE_SESSION_ID)
      .first<{ index_state: string }>();
    expect(recoveredSession?.index_state).toBe('ready');
  });
});

describe('failed reparse surfaces as session index_state=error', () => {
  const POISON_SESSION_ID = '55555555-6666-4444-8444-555555555555';
  const relpath = `poison-demo/${POISON_SESSION_ID}.jsonl`;
  const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;

  it('a reparse that throws (missing R2 object) marks the session index_state=error, not stuck at parsing', async () => {
    const content = `${ccUserLine({ uuid: 'p-u1', text: 'poison test content' })}\n`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { file_id: number }).file_id;
    await drainQueue();

    const ready = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind(POISON_SESSION_ID)
      .first<{ index_state: string }>();
    expect(ready?.index_state).toBe('ready');

    // Simulate corruption/loss of the backing R2 object, then force a reparse.
    await testEnv.RAW.delete(r2Key);
    await deliverOne(fileId, r2Key);

    const fileRow = await testEnv.DB.prepare('SELECT parse_state, parse_error FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string; parse_error: string | null }>();
    expect(fileRow?.parse_state).toBe('error');
    expect(fileRow?.parse_error).toContain('r2_object_missing');

    const sessionRow = await testEnv.DB.prepare('SELECT index_state FROM sessions WHERE session_id = ?1')
      .bind(POISON_SESSION_ID)
      .first<{ index_state: string }>();
    expect(sessionRow?.index_state).toBe('error');

    // The catch path deliberately keeps the OLD blocks/blocks_fts/usage rows rather than
    // deleting them (unlike parseOne's zero-turn branch): a throw here means we couldn't even
    // read the raw content, so those rows may be the only surviving trace of the session. The
    // stale hit must still carry index_state='error' so callers can tell it's not current.
    const search = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=poison', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as { hits: Array<{ session_id: string; session: { index_state: string } }> };
    const hit = searchBody.hits.find((h) => h.session_id === POISON_SESSION_ID);
    expect(hit?.session.index_state).toBe('error');
  });

  it('the catch-path UPDATE is a guarded no-op when the stored session_id is NULL (never crashes)', async () => {
    // detect() re-derives harness/sessionId fresh from the relpath at parse time, so it's the
    // STORED files.session_id column the catch's UPDATE subquery reads — inserting a row whose
    // relpath looks like a real session file (so parseOne passes the skip check and reaches the
    // throwing env.RAW.get) but whose stored session_id is NULL reproduces exactly the desync
    // the earlier reindex bug could leave behind (belt-and-suspenders after that fix).
    const nullSessionRelpath = `null-session-demo/${'c0000000-0000-4000-8000-000000000001'}.jsonl`;
    const r2Key = `raw/${MACHINE}/claude-projects/${nullSessionRelpath}`;
    const row = await testEnv.DB.prepare(
      `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, harness, session_id, parse_state)
       VALUES (?1, 'claude-projects', ?2, ?3, 0, 'unknown', 'claude-code', NULL, 'pending')
       RETURNING id`,
    )
      .bind(MACHINE, nullSessionRelpath, r2Key)
      .first<{ id: number }>();
    const fileId = row!.id;

    await expect(deliverOne(fileId, r2Key)).resolves.not.toThrow();

    const fileRow = await testEnv.DB.prepare('SELECT parse_state, parse_error FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string; parse_error: string | null }>();
    expect(fileRow?.parse_state).toBe('error');
    expect(fileRow?.parse_error).toContain('r2_object_missing');
  });
});

describe('upload requires an actual size header', () => {
  it('PUT with neither Content-Length nor x-file-size returns 400 missing_content_length (regression: Number(null) is 0, not NaN, so this silently passed as a 0-byte file)', async () => {
    const bytes = new TextEncoder().encode('{"type":"user"}\n');
    // A plain Uint8Array body has a known length, and fetch() auto-computes Content-Length for
    // it regardless of what headers we pass — that doesn't reproduce the bug. A streaming body
    // (unknown length up front) is what actually arrives without a Content-Length header, i.e.
    // the literal "chunked/streaming uploads" case the finding describes.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const res = await SELF.fetch(
      `https://api.sessions.vza.net/api/v1/files/${MACHINE}/claude-projects/${encodeURIComponent('no-size-demo/f0000000-0000-4000-8000-000000000001.jsonl')}`,
      {
        method: 'PUT',
        headers: {
          'x-dev-machine': MACHINE,
          'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
        },
        body: stream,
        duplex: 'half',
      } as RequestInit,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('missing_content_length');
  });

  it('a fractional x-file-size (e.g. 1.5) is rejected before the body ever reaches R2 (regression: it passed Number.isFinite, the body landed in R2, and only the STRICT INTEGER insert then 500d — an orphaned object with no files row and no parse message)', async () => {
    const bytes = new TextEncoder().encode('{"type":"user"}\n');
    const relpath = 'fractional-size-demo/f0000000-0000-4000-8000-000000000002.jsonl';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const res = await SELF.fetch(
      `https://api.sessions.vza.net/api/v1/files/${MACHINE}/claude-projects/${encodeURIComponent(relpath)}`,
      {
        method: 'PUT',
        headers: {
          'x-dev-machine': MACHINE,
          'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
          'x-file-size': '1.5',
        },
        body: stream,
        duplex: 'half',
      } as RequestInit,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('missing_content_length');

    const obj = await testEnv.RAW.get(`raw/${MACHINE}/claude-projects/${relpath}`);
    expect(obj).toBeNull();
    const row = await testEnv.DB.prepare('SELECT id FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind(MACHINE, relpath)
      .first();
    expect(row).toBeNull();
  });

  it('an upload declaring a wrong-but-integer size header still records the real R2 byte count, not the declared one (regression: files.size drives canonical dedupe, so trusting a bad header could pick the wrong raw file even though R2 stored the true bytes)', async () => {
    const bytes = new TextEncoder().encode('{"type":"user"}\n'); // 16 real bytes
    const relpath = 'wrong-size-demo/f0000000-0000-4000-8000-000000000003.jsonl';
    // A collector reporting a declared size (content-length, or x-file-size for a chunked
    // upload with no content-length) that doesn't match what it actually sends — the
    // scenario the finding describes for streamed/chunked uploads. R2 verifies the checksum
    // server-side but not the declared length against a header, so this is the only way to
    // reliably get a real byte mismatch to actually land in R2 in this test harness.
    const res = await SELF.fetch(
      `https://api.sessions.vza.net/api/v1/files/${MACHINE}/claude-projects/${encodeURIComponent(relpath)}`,
      {
        method: 'PUT',
        headers: {
          'x-dev-machine': MACHINE,
          'x-content-hash': `sha256:${await sha256Hex(bytes)}`,
          'content-length': '99999', // deliberately wrong but a valid safe integer
        },
        body: bytes,
      },
    );
    expect(res.status).toBe(201);

    const row = await testEnv.DB.prepare('SELECT size FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind(MACHINE, relpath)
      .first<{ size: number }>();
    expect(row?.size).toBe(bytes.length);
    expect(row?.size).not.toBe(99999);
  });
});

describe('date-only "to" bound is inclusive of the whole day', () => {
  const DATE_SESSION_ID = '019f0000-1111-7000-8000-000000000def';

  beforeAll(async () => {
    const lines = [
      { timestamp: '2026-07-17T09:00:00.000Z', type: 'session_meta', payload: { session_id: DATE_SESSION_ID, cwd: '/x' } },
      { timestamp: '2026-07-17T09:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-4' } },
      {
        timestamp: '2026-07-17T09:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'date bound test content' }],
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        timestamp: '2026-07-17T09:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 1 } } },
      },
    ].map((o) => JSON.stringify(o));

    const relpath = `2026/07/17/rollout-2026-07-17T09-00-00-${DATE_SESSION_ID}.jsonl`;
    const res = await putFile('codex-sessions', relpath, `${lines.join('\n')}\n`);
    expect(res.status).toBe(201);
    await drainQueue();

    // Sanity check the fixture itself actually indexed a usage row and a started_at on that date
    // before testing the date-bound query logic against it.
    const usageRows = await testEnv.DB.prepare('SELECT ts FROM usage WHERE session_id = ?1').bind(DATE_SESSION_ID).all();
    expect(usageRows.results.length).toBeGreaterThan(0);
  });

  it('usage: from=to=<date> is non-empty (regression: to=<date> lexicographically excluded the whole day against full ISO timestamps)', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/usage?group_by=day&from=2026-07-17&to=2026-07-17', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ bucket: string; calls: number }> };
    const bucket = body.rows.find((r) => r.bucket === '2026-07-17');
    expect(bucket).toBeTruthy();
    expect(bucket!.calls).toBeGreaterThan(0);
  });

  it('search: to=<date-only> includes a session started that same day', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=bound&from=2026-07-17&to=2026-07-17', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ session_id: string }> };
    expect(body.hits.some((h) => h.session_id === DATE_SESSION_ID)).toBe(true);
  });

  it('listSessions: to=<date-only> includes a session started that same day', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions?from=2026-07-17&to=2026-07-17', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ session_id: string }> };
    expect(body.sessions.some((s) => s.session_id === DATE_SESSION_ID)).toBe(true);
  });
});

describe('files/check re-enqueues unindexed matches instead of only reporting them present', () => {
  it('a matched row stuck at parse_state=pending is reported present AND gets a parse message sent', async () => {
    const CHECK_SESSION_ID = 'd0000000-0000-4000-8000-000000000003';
    const content = `${ccUserLine({ uuid: 'ck-u1', text: 'files check requeue test' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { file_id: number }).file_id;
    const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;
    // Deliberately never drained: the row sits at parse_state='pending', simulating a queue
    // message that was lost before it ever reached the consumer.
    const stillPending = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(stillPending?.parse_state).toBe('pending');

    const sha256 = await sha256Hex(new TextEncoder().encode(content));
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    try {
      const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
        method: 'POST',
        headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ store: 'claude-projects', relpath, sha256: `sha256:${sha256}` }] }),
      });
      expect(checkRes.status).toBe(200);
      const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
      // Reported present (a matching hash means the bytes exist), not missing.
      expect(body.missing).toHaveLength(0);
      // ...but since it was never actually indexed, files/check must have re-enqueued it itself.
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileId, r2_key: r2Key }));
    } finally {
      sendSpy.mockRestore();
    }

    // Prove the enqueued message actually indexes the file (drainQueue only re-derives from
    // files/parse_state='pending', which was already true before the check call — deliverOne
    // exercises the specific message files/check would have sent, independent of that).
    await deliverOne(fileId, r2Key);
    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed');
  });

  it('a matched row already parsed is reported present and does NOT get re-enqueued', async () => {
    const CHECK_SESSION_ID2 = 'd0000000-0000-4000-8000-000000000004';
    const content = `${ccUserLine({ uuid: 'ck2-u1', text: 'files check no-requeue test' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID2}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    await drainQueue();

    const sha256 = await sha256Hex(new TextEncoder().encode(content));
    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    try {
      const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
        method: 'POST',
        headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ store: 'claude-projects', relpath, sha256: `sha256:${sha256}` }] }),
      });
      expect(checkRes.status).toBe(200);
      const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
      expect(body.missing).toHaveLength(0);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('a matched row that is terminal (parsed) but whose R2 object was lost is reported MISSING, not present', async () => {
    const CHECK_SESSION_ID3 = 'd0000000-0000-4000-8000-000000000005';
    const content = `${ccUserLine({ uuid: 'ck3-u1', text: 'files check lost-object test' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID3}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    await drainQueue();
    const fileId = ((await res.json()) as { file_id: number }).file_id;
    const parsedRow = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(parsedRow?.parse_state).toBe('parsed'); // terminal

    // Lose the backing R2 object without touching the D1 row at all — a matched, terminal row
    // that would previously have been reported present regardless.
    const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;
    await testEnv.RAW.delete(r2Key);

    const sha256 = await sha256Hex(new TextEncoder().encode(content));
    const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ store: 'claude-projects', relpath, sha256: `sha256:${sha256}` }] }),
    });
    expect(checkRes.status).toBe(200);
    const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
    expect(body.missing).toEqual([{ store: 'claude-projects', relpath }]);
  });

  it('a matched row whose R2 object is intact is still reported present (positive control for the head check)', async () => {
    const CHECK_SESSION_ID4 = 'd0000000-0000-4000-8000-000000000006';
    const content = `${ccUserLine({ uuid: 'ck4-u1', text: 'files check intact-object test' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID4}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    await drainQueue();

    const sha256 = await sha256Hex(new TextEncoder().encode(content));
    const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ store: 'claude-projects', relpath, sha256: `sha256:${sha256}` }] }),
    });
    expect(checkRes.status).toBe(200);
    const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
    expect(body.missing).toHaveLength(0);
  });

  it('a matched row whose R2 object was overwritten with different bytes (same key, no checksum) is reported MISSING, not present (regression: HEAD existence alone does not prove the bytes are correct)', async () => {
    const CHECK_SESSION_ID5 = 'd0000000-0000-4000-8000-000000000007';
    const content = `${ccUserLine({ uuid: 'ck5-u1', text: 'files check checksum-mismatch test' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID5}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    await drainQueue();

    // Directly overwrite the R2 object with different bytes, bypassing the upload API entirely
    // (e.g. a bad manual restore/replacement outside our PUT path) and without a sha256 checksum
    // option — HEAD still succeeds (the object exists), but its checksum is now absent/wrong.
    const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;
    await testEnv.RAW.put(r2Key, new TextEncoder().encode('completely different bytes, no sha256 option'));

    const sha256 = await sha256Hex(new TextEncoder().encode(content));
    const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ store: 'claude-projects', relpath, sha256: `sha256:${sha256}` }] }),
    });
    expect(checkRes.status).toBe(200);
    const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
    expect(body.missing).toEqual([{ store: 'claude-projects', relpath }]);
  });

  it('a batch with the same path twice under different hashes only treats the D1-matching hash as present (regression: the have map was keyed by path only, so a match on one hash let a sibling item requesting a DIFFERENT, unmatched hash for the same path read as present too)', async () => {
    const CHECK_SESSION_ID6 = 'd0000000-0000-4000-8000-000000000008';
    const oldContent = `${ccUserLine({ uuid: 'ck6-u1', text: 'files check dup-path old content' })}\n`;
    const newContent = `${ccUserLine({ uuid: 'ck6-u1', text: 'files check dup-path NEW content' })}\n`;
    const relpath = `check-demo/${CHECK_SESSION_ID6}.jsonl`;
    const res = await putFile('claude-projects', relpath, oldContent);
    expect(res.status).toBe(201);
    await drainQueue();

    const oldSha = await sha256Hex(new TextEncoder().encode(oldContent));
    const newSha = await sha256Hex(new TextEncoder().encode(newContent));

    // D1 still only has the OLD hash for this path (the collector hasn't actually uploaded the
    // new bytes yet) — a batch requesting both hashes for the same path simulates a scan racing
    // a local rewrite.
    const checkRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/check', {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [
          { store: 'claude-projects', relpath, sha256: `sha256:${oldSha}` },
          { store: 'claude-projects', relpath, sha256: `sha256:${newSha}` },
        ],
      }),
    });
    expect(checkRes.status).toBe(200);
    const body = (await checkRes.json()) as { missing: Array<{ store: string; relpath: string }> };
    // The old-hash item matches D1's actual row and is present; the new-hash item does NOT
    // match (D1 still has the old bytes) and must be reported missing.
    expect(body.missing).toEqual([{ store: 'claude-projects', relpath }]);
  });
});

describe('reindex refreshes content_hash', () => {
  it('an existing row with a stale/unknown content_hash gets refreshed to the real sha256 on reindex', async () => {
    const HASH_SESSION_ID = 'e0000000-0000-4000-8000-000000000002';
    const content = `${ccUserLine({ uuid: 'h-u1', text: 'hash refresh test' })}\n`;
    const relpath = `hash-demo/${HASH_SESSION_ID}.jsonl`;
    const res = await putFile('claude-projects', relpath, content);
    expect(res.status).toBe(201);
    const fileId = ((await res.json()) as { file_id: number }).file_id;
    await drainQueue();

    const realHash = await sha256Hex(new TextEncoder().encode(content));

    await testEnv.DB.prepare("UPDATE files SET content_hash = 'unknown' WHERE id = ?1").bind(fileId).run();
    const before = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ content_hash: string }>();
    expect(before?.content_hash).toBe('unknown');

    const reindexRes = await SELF.fetch('https://api.sessions.vza.net/api/v1/admin/reindex', {
      method: 'POST',
      headers: { 'x-dev-machine': MACHINE, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(reindexRes.status).toBe(200);
    await drainQueue();

    const after = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ content_hash: string }>();
    expect(after?.content_hash).toBe(realHash);
  });
});

describe('subagent meta linking, both arrival orders', () => {
  const PROJECT_SLUG = '-home-tester-src-subagent-demo';
  const SUBAGENT_PARENT = '99999999-8888-4444-8444-777777777777';
  const SUBAGENT_A = 'aaaaaaaa-1111-4444-8444-222222222222';
  const SUBAGENT_B = 'bbbbbbbb-1111-4444-8444-222222222222';

  function subagentTranscript(tag: string): string {
    return `${[
      ccUserLine({ uuid: `${tag}-u1`, text: 'subagent task' }),
      ccAssistantLine({ uuid: `${tag}-a1`, parentUuid: `${tag}-u1`, text: 'subagent result' }),
    ].join('\n')}\n`;
  }
  function subagentMeta(toolUseId: string): string {
    return JSON.stringify({ toolUseId, agentType: 'general-purpose' });
  }
  async function parentToolUseId(sessionId: string): Promise<string | null | undefined> {
    const row = await testEnv.DB.prepare('SELECT parent_tool_use_id FROM sessions WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ parent_tool_use_id: string | null }>();
    return row?.parent_tool_use_id;
  }

  it('meta uploaded BEFORE the transcript still links (sibling-meta read at transcript parse time)', async () => {
    const metaRelpath = `${PROJECT_SLUG}/${SUBAGENT_PARENT}/subagents/agent-${SUBAGENT_A}.meta.json`;
    const transcriptRelpath = `${PROJECT_SLUG}/${SUBAGENT_PARENT}/subagents/agent-${SUBAGENT_A}.jsonl`;

    const metaRes = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_meta_first'));
    expect(metaRes.status).toBe(201);
    await drainQueue();

    const transcriptRes = await putFile('claude-projects', transcriptRelpath, subagentTranscript('a'));
    expect(transcriptRes.status).toBe(201);
    await drainQueue();

    expect(await parentToolUseId(SUBAGENT_A)).toBe('toolu_meta_first');
  });

  it('transcript uploaded BEFORE the meta still links (linkSubagentMeta updates the now-existing session)', async () => {
    const metaRelpath = `${PROJECT_SLUG}/${SUBAGENT_PARENT}/subagents/agent-${SUBAGENT_B}.meta.json`;
    const transcriptRelpath = `${PROJECT_SLUG}/${SUBAGENT_PARENT}/subagents/agent-${SUBAGENT_B}.jsonl`;

    const transcriptRes = await putFile('claude-projects', transcriptRelpath, subagentTranscript('b'));
    expect(transcriptRes.status).toBe(201);
    await drainQueue();
    expect(await parentToolUseId(SUBAGENT_B)).toBeNull();

    const metaRes = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_meta_second'));
    expect(metaRes.status).toBe(201);
    await drainQueue();

    expect(await parentToolUseId(SUBAGENT_B)).toBe('toolu_meta_second');
  });

  it('the API response for a linked subagent session carries parentToolUseId (regression: loadNormalized reparsed the JSONL and never hydrated it from the sessions row)', async () => {
    expect(await parentToolUseId(SUBAGENT_A)).toBe('toolu_meta_first');

    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${SUBAGENT_A}`, {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { parentToolUseId?: string } };
    expect(body.session.parentToolUseId).toBe('toolu_meta_first');
  });
});

describe('subagent meta parse is guarded by content_hash (regression: a stale in-flight meta parse could overwrite a fresher upload\'s link and mark the row parsed)', () => {
  const PROJECT_SLUG2 = '-home-tester-src-subagent-hash-guard';
  const SUBAGENT_PARENT2 = '99999999-8888-4444-8444-888888888888';
  const SUBAGENT_HASHGUARD = 'cccccccc-1111-4444-8444-222222222222';

  function subagentTranscript(tag: string): string {
    return `${[
      ccUserLine({ uuid: `${tag}-u1`, text: 'subagent task' }),
      ccAssistantLine({ uuid: `${tag}-a1`, parentUuid: `${tag}-u1`, text: 'subagent result' }),
    ].join('\n')}\n`;
  }
  function subagentMeta(toolUseId: string): string {
    return JSON.stringify({ toolUseId, agentType: 'general-purpose' });
  }
  async function parentToolUseId(sessionId: string): Promise<string | null | undefined> {
    const row = await testEnv.DB.prepare('SELECT parent_tool_use_id FROM sessions WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ parent_tool_use_id: string | null }>();
    return row?.parent_tool_use_id;
  }

  it('a stale meta message (content_hash no longer matches) does not overwrite the link or mark the row parsed; the fresh message still links correctly', async () => {
    const metaRelpath = `${PROJECT_SLUG2}/${SUBAGENT_PARENT2}/subagents/agent-${SUBAGENT_HASHGUARD}.meta.json`;
    const transcriptRelpath = `${PROJECT_SLUG2}/${SUBAGENT_PARENT2}/subagents/agent-${SUBAGENT_HASHGUARD}.jsonl`;

    const transcriptRes = await putFile('claude-projects', transcriptRelpath, subagentTranscript('hg'));
    expect(transcriptRes.status).toBe(201);
    await drainQueue();

    const metaRes1 = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_stale'));
    expect(metaRes1.status).toBe(201);
    const metaFileId = ((await metaRes1.json()) as { file_id: number }).file_id;
    const metaR2Key = `raw/${MACHINE}/claude-projects/${metaRelpath}`;
    await deliverOne(metaFileId, metaR2Key);
    expect(await parentToolUseId(SUBAGENT_HASHGUARD)).toBe('toolu_stale');

    const staleRow = await testEnv.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(metaFileId)
      .first<{ content_hash: string }>();
    const staleHash = staleRow!.content_hash;

    // Re-upload the meta with a DIFFERENT toolUseId — this changes the row's content_hash and
    // enqueues a fresh message for it, but the row is deliberately never drained here: we want
    // to redeliver the STALE (pre-reupload) message explicitly instead, simulating a delayed/
    // reordered delivery racing the fresh upload's own message.
    const metaRes2 = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_fresh'));
    expect(metaRes2.status).toBe(201);

    // Redeliver the OLD message, still carrying the now-stale content_hash. Without the guard,
    // linkSubagentMeta would re-read R2 live (now holding the FRESH bytes, since the fresh
    // upload already landed) and — worse — mark the row 'parsed' for content a fresher message
    // already owns. With the guard, the whole branch is skipped on mismatch.
    await deliverOne(metaFileId, metaR2Key, staleHash);

    // Link must NOT have been touched by the stale delivery — still whatever the last genuine
    // write left it at ('toolu_stale'), since the fresh message hasn't been delivered yet.
    expect(await parentToolUseId(SUBAGENT_HASHGUARD)).toBe('toolu_stale');
    const rowAfterStale = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(metaFileId)
      .first<{ parse_state: string }>();
    expect(rowAfterStale?.parse_state).toBe('pending'); // not marked parsed by the stale delivery

    // Now deliver the FRESH message (drainQueue picks up the still-pending row) — it should link
    // correctly and mark the row parsed.
    await drainQueue();
    expect(await parentToolUseId(SUBAGENT_HASHGUARD)).toBe('toolu_fresh');
    const rowAfterFresh = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(metaFileId)
      .first<{ parse_state: string }>();
    expect(rowAfterFresh?.parse_state).toBe('parsed');
  });
});

describe('a transcript reparse that reads a CORRECTED sibling meta repairs a stale parent_tool_use_id link (regression: the sessions upsert\'s COALESCE kept the OLD stored value over a fresh non-null one)', () => {
  const PROJECT_SLUG3 = '-home-tester-src-subagent-repair';
  const SUBAGENT_PARENT3 = '99999999-8888-4444-8444-999999999999';
  const SUBAGENT_REPAIR = 'dddddddd-1111-4444-8444-222222222222';

  function subagentTranscript(tag: string): string {
    return `${[
      ccUserLine({ uuid: `${tag}-u1`, text: 'subagent task' }),
      ccAssistantLine({ uuid: `${tag}-a1`, parentUuid: `${tag}-u1`, text: 'subagent result' }),
    ].join('\n')}\n`;
  }
  function subagentMeta(toolUseId: string): string {
    return JSON.stringify({ toolUseId, agentType: 'general-purpose' });
  }
  async function parentToolUseId(sessionId: string): Promise<string | null | undefined> {
    const row = await testEnv.DB.prepare('SELECT parent_tool_use_id FROM sessions WHERE session_id = ?1')
      .bind(sessionId)
      .first<{ parent_tool_use_id: string | null }>();
    return row?.parent_tool_use_id;
  }

  it('reparsing the transcript after the meta is corrected overwrites the stale link with the corrected one', async () => {
    const metaRelpath = `${PROJECT_SLUG3}/${SUBAGENT_PARENT3}/subagents/agent-${SUBAGENT_REPAIR}.meta.json`;
    const transcriptRelpath = `${PROJECT_SLUG3}/${SUBAGENT_PARENT3}/subagents/agent-${SUBAGENT_REPAIR}.jsonl`;
    const transcriptR2Key = `raw/${MACHINE}/claude-projects/${transcriptRelpath}`;

    // Link meta v1 and index the transcript.
    const metaRes1 = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_v1'));
    expect(metaRes1.status).toBe(201);
    await drainQueue();

    const transcriptRes = await putFile('claude-projects', transcriptRelpath, subagentTranscript('repair'));
    expect(transcriptRes.status).toBe(201);
    const transcriptFileId = ((await transcriptRes.json()) as { file_id: number }).file_id;
    await deliverOne(transcriptFileId, transcriptR2Key);

    expect(await parentToolUseId(SUBAGENT_REPAIR)).toBe('toolu_v1');

    // Correct the meta file (new tool id) — this alone doesn't touch the sessions row (its own
    // fresh message is never drained here; we care about the TRANSCRIPT reparse path).
    const metaRes2 = await putFile('claude-projects', metaRelpath, subagentMeta('toolu_v2'));
    expect(metaRes2.status).toBe(201);
    expect(await parentToolUseId(SUBAGENT_REPAIR)).toBe('toolu_v1'); // still stale — meta's own message hasn't run

    // Reparse the transcript (e.g. via a resync/reindex) — parseOne's subagent branch reads the
    // sibling meta LIVE from R2 (readSiblingMeta), so it picks up the corrected tool id and writes
    // it into `parsed.parentToolUseId`. The sessions upsert must let that fresh, non-null value
    // win over the stale one already stored, not keep the stale one just because it's non-null.
    await deliverOne(transcriptFileId, transcriptR2Key);

    expect(await parentToolUseId(SUBAGENT_REPAIR)).toBe('toolu_v2');
  });
});

describe('search cursor decoding rejects non-integer offsets (regression: a finite non-integer cursor reached SQL OFFSET and 500\'d)', () => {
  it('a hand-edited cursor decoding to 1.5 is treated as offset 0 (first page), not a 500', async () => {
    const withoutCursor = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=bound', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(withoutCursor.status).toBe(200);
    const firstPage = (await withoutCursor.json()) as { hits: Array<{ session_id: string }> };
    expect(firstPage.hits.length).toBeGreaterThan(0);

    const withBadCursor = await SELF.fetch(`https://api.sessions.vza.net/api/v1/search?q=bound&cursor=${btoa('1.5')}`, {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(withBadCursor.status).toBe(200);
    const badCursorPage = (await withBadCursor.json()) as { hits: Array<{ session_id: string }> };
    expect(badCursorPage.hits).toEqual(firstPage.hits);
  });

  it('a cursor that is not valid base64 at all (e.g. "not-base64!") is treated as offset 0, not a 500 (atob throws)', async () => {
    const withoutCursor = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=bound', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(withoutCursor.status).toBe(200);
    const firstPage = (await withoutCursor.json()) as { hits: Array<{ session_id: string }> };
    expect(firstPage.hits.length).toBeGreaterThan(0);

    const withInvalidCursor = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=bound&cursor=not-base64!', {
      headers: { 'x-dev-machine': MACHINE },
    });
    expect(withInvalidCursor.status).toBe(200);
    const invalidCursorPage = (await withInvalidCursor.json()) as { hits: Array<{ session_id: string }> };
    expect(invalidCursorPage.hits).toEqual(firstPage.hits);
  });
});

describe('a stale message (redelivered after a re-upload changed the row\'s hash) is rejected at the source — no session write at all, row untouched; the fresh message indexes normally', () => {
  it('a redelivered pre-reupload message makes zero writes: blocks/search still show the OLD content, the row is not marked parsed; the fresh message then indexes the NEW content', async () => {
    const SESSION_ID = 'e0000000-0000-4000-8000-000000000003';
    const relpath = `stale-write-demo/${SESSION_ID}.jsonl`;
    const CONTENT_V1 = `${ccUserLine({ uuid: 'sw-u1', text: 'unique-marker-stalewrite-v1 original content' })}\n`;
    const CONTENT_V2 = `${ccUserLine({ uuid: 'sw-u2', text: 'unique-marker-stalewrite-v2 replaced content' })}\n`;

    const res1 = await putFile('claude-projects', relpath, CONTENT_V1);
    expect(res1.status).toBe(201);
    const fileId = ((await res1.json()) as { file_id: number }).file_id;
    const r2Key = `raw/${MACHINE}/claude-projects/${relpath}`;
    await deliverOne(fileId, r2Key);

    const rowV1 = await testEnv.DB.prepare('SELECT content_hash, parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ content_hash: string; parse_state: string }>();
    expect(rowV1?.parse_state).toBe('parsed');
    const oldHash = rowV1!.content_hash;

    const searchV1Before = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-stalewrite-v1', {
      headers: { 'x-dev-machine': MACHINE },
    });
    const bodyV1Before = (await searchV1Before.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyV1Before.hits.some((h) => h.session_id === SESSION_ID)).toBe(true);

    // Re-upload with different content — changes content_hash and enqueues a FRESH message, but
    // we deliberately never drain it here.
    const res2 = await putFile('claude-projects', relpath, CONTENT_V2);
    expect(res2.status).toBe(201);

    // Redeliver the STALE (pre-reupload) message, still carrying the now-superseded oldHash —
    // simulates a delayed/reordered delivery racing the fresh upload's own message.
    await deliverOne(fileId, r2Key, oldHash);

    // No writes at all: the row is not marked parsed by the stale delivery...
    const rowAfterStale = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(rowAfterStale?.parse_state).toBe('pending');

    // ...and the session/blocks content is UNCHANGED (still V1) — the stale delivery must be
    // rejected before it ever calls writeSession, not just before markParsed.
    const searchV1After = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-stalewrite-v1', {
      headers: { 'x-dev-machine': MACHINE },
    });
    const bodyV1After = (await searchV1After.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyV1After.hits.some((h) => h.session_id === SESSION_ID)).toBe(true);

    const searchV2NotYet = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-stalewrite-v2', {
      headers: { 'x-dev-machine': MACHINE },
    });
    const bodyV2NotYet = (await searchV2NotYet.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyV2NotYet.hits.some((h) => h.session_id === SESSION_ID)).toBe(false);

    // The fresh message (still pending, since the stale delivery made no writes) now indexes the
    // current (V2) content correctly.
    await drainQueue();
    const rowFresh = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(rowFresh?.parse_state).toBe('parsed');

    const searchV2 = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-stalewrite-v2', {
      headers: { 'x-dev-machine': MACHINE },
    });
    const bodyV2 = (await searchV2.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyV2.hits.some((h) => h.session_id === SESSION_ID)).toBe(true);
  });
});
