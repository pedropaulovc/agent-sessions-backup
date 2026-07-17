import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
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
});
