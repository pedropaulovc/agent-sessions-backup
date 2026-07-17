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
 * drainQueue() uses, for tests that need to redeliver a file regardless of its current row state. */
async function deliverOne(fileId: number, r2Key: string): Promise<void> {
  const message = {
    id: String(fileId),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: fileId, r2_key: r2Key, reason: 'upload' as const },
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

    // The row itself isn't touched by the response handler — only a queue message was sent.
    const stillError = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(stillError?.parse_state).toBe('error');

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
