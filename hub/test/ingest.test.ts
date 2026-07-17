import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { CC_SESSION_ID, ccAssistantLine, ccNoiseLines, ccUserLine } from './fixtures';

const testEnv = env as unknown as Env;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function putFile(machine: string, store: string, relpath: string, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/${machine}/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': machine,
      'x-content-hash': `sha256:${await sha256Hex(body)}`,
      'x-file-mtime': '2026-07-01T12:00:00Z',
      'content-length': String(body.length),
    },
    body,
  });
}

/** Drain: run the queue consumer over all pending files (tests don't get automatic delivery). */
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

/** Deliver a single, explicitly-specified message — for tests that need to redeliver a
 * particular file regardless of its current parse_state (drainQueue only picks up 'pending').
 * An explicit contentHash simulates a message enqueued for a since-superseded upload — the
 * consumer's markParsed guard uses it to detect the row has since moved on. An explicit reason
 * simulates redelivering the exact message a prior recovery enqueue sent (reason: 'recover'),
 * which the consumer's catch path treats differently on failure than a plain 'upload' retry. */
async function deliverOne(fileId: number, r2Key: string, contentHash?: string, reason: ParseMessage['reason'] = 'upload'): Promise<void> {
  const message = {
    id: String(fileId),
    timestamp: new Date(),
    attempts: 1,
    body: { file_id: fileId, r2_key: r2Key, reason, ...(contentHash !== undefined ? { content_hash: contentHash } : {}) },
    ack() {},
    retry() {},
  };
  await worker.queue(
    { queue: 'parse', messages: [message], ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
    testEnv,
  );
}

const SESSION_CONTENT = [
  ...ccNoiseLines(),
  ccUserLine({ uuid: 'u1', text: 'find the melting point of gallium in our notes' }),
  ccAssistantLine({ uuid: 'a1', parentUuid: 'u1', toolUse: { id: 'toolu_9', name: 'Grep', input: { pattern: 'gallium' } } }),
  ccUserLine({
    uuid: 'u2',
    parentUuid: 'a1',
    toolResult: { toolUseId: 'toolu_9', content: 'notes.md: gallium melts at 29.76 C' },
  }),
  ccAssistantLine({ uuid: 'a2', parentUuid: 'u2', text: 'Gallium melts just below body temperature.' }),
].join('\n');

describe('ingest pipeline end-to-end', () => {
  beforeAll(async () => {
    const res = await putFile('testbox-wsl', 'claude-projects', `-home-tester-src-demo/${CC_SESSION_ID}.jsonl`, SESSION_CONTENT);
    expect(res.status).toBe(201);
    await drainQueue();
  });

  it('indexes the session with facet metadata and usage rollups', async () => {
    const row = await testEnv.DB.prepare('SELECT * FROM sessions WHERE session_id = ?1').bind(CC_SESSION_ID).first();
    expect(row).toBeTruthy();
    expect(row!.harness).toBe('claude-code');
    expect(row!.machine_id).toBe('testbox-wsl');
    expect(row!.index_state).toBe('ready');
    expect(row!.title).toBe('Demo session about parsing');
    expect(Number(row!.tokens_in)).toBeGreaterThan(0);

    const usage = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();
    expect(usage!.n).toBe(2); // two assistant turns
  });

  it('finds tool_result text through full-text search with snippets and facets', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=gallium&facets=1', {
      headers: { 'x-dev-machine': 'testbox-wsl' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ snippet: string; session_id: string }>; facets: Record<string, Record<string, number>> };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.session_id).toBe(CC_SESSION_ID);
    expect(body.hits.some((h) => h.snippet.includes('<mark>'))).toBe(true);
    expect(body.facets['harness']!['claude-code']).toBe(1);
  });

  it('is idempotent: unchanged re-upload is a no-op; changed re-upload replaces rows without duplication', async () => {
    const before = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();

    const unchanged = await putFile('testbox-wsl', 'claude-projects', `-home-tester-src-demo/${CC_SESSION_ID}.jsonl`, SESSION_CONTENT);
    expect(unchanged.status).toBe(200);
    expect(((await unchanged.json()) as { status: string }).status).toBe('unchanged');

    // Session grew by one turn (the append-only case).
    const grown = SESSION_CONTENT + '\n' + ccUserLine({ uuid: 'u3', parentUuid: 'a2', text: 'thanks, noted!' });
    const res = await putFile('testbox-wsl', 'claude-projects', `-home-tester-src-demo/${CC_SESSION_ID}.jsonl`, grown);
    expect(res.status).toBe(201);
    await drainQueue();

    const after = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();
    expect(after!.n).toBe(before!.n + 1);

    // FTS stayed in sync: the new text is findable, old text findable exactly once.
    const res2 = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=noted', {
      headers: { 'x-dev-machine': 'testbox-wsl' },
    });
    const body2 = (await res2.json()) as { hits: unknown[] };
    expect(body2.hits).toHaveLength(1);
  });

  it('dedupes the same session uploaded from a second machine (superseded, not double-indexed)', async () => {
    // A strictly smaller copy of the same session (as seen through the WSL /mnt/c double-mount):
    // the size tiebreak makes the fuller original canonical, deterministically.
    const truncatedCopy = SESSION_CONTENT.split('\n').slice(0, -1).join('\n');
    const res = await putFile('testbox-win', 'claude-projects', `C--src-demo/${CC_SESSION_ID}.jsonl`, truncatedCopy);
    expect(res.status).toBe(201);
    await drainQueue();

    const states = await testEnv.DB.prepare(
      'SELECT machine_id, parse_state FROM files WHERE session_id = ?1 ORDER BY machine_id',
    )
      .bind(CC_SESSION_ID)
      .all<{ machine_id: string; parse_state: string }>();
    const byMachine = Object.fromEntries(states.results.map((r) => [r.machine_id, r.parse_state]));
    expect(byMachine['testbox-wsl']).toBe('parsed');
    expect(byMachine['testbox-win']).toBe('superseded');

    const sessionCount = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();
    expect(sessionCount!.n).toBe(1);
  });

  it('reindex reproduces the same dedupe decision as normal ingest (regression: reindex used to drop harness/session_id)', async () => {
    const blocksBefore = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();

    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/admin/reindex', {
      method: 'POST',
      headers: { 'x-dev-machine': 'testbox-wsl', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    await drainQueue();

    const states = await testEnv.DB.prepare(
      'SELECT machine_id, parse_state FROM files WHERE session_id = ?1 ORDER BY machine_id',
    )
      .bind(CC_SESSION_ID)
      .all<{ machine_id: string; parse_state: string }>();
    const byMachine = Object.fromEntries(states.results.map((r) => [r.machine_id, r.parse_state]));
    expect(Object.values(byMachine).filter((s) => s === 'parsed')).toHaveLength(1);
    expect(Object.values(byMachine).filter((s) => s === 'superseded')).toHaveLength(1);
    expect(byMachine['testbox-wsl']).toBe('parsed');
    expect(byMachine['testbox-win']).toBe('superseded');

    const sessionCount = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();
    expect(sessionCount!.n).toBe(1);

    const blocksAfter = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1')
      .bind(CC_SESSION_ID)
      .first<{ n: number }>();
    expect(blocksAfter!.n).toBe(blocksBefore!.n);
  });

  it('serves the normalized session and raw passthrough', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${CC_SESSION_ID}`, {
      headers: { 'x-dev-machine': 'testbox-wsl' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { turns: unknown[]; harness: string } };
    expect(body.session.harness).toBe('claude-code');
    expect(body.session.turns.length).toBeGreaterThanOrEqual(4);

    const raw = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${CC_SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': 'testbox-wsl' },
    });
    expect(raw.status).toBe(200);
    expect((await raw.text()).split('\n').filter(Boolean).length).toBeGreaterThan(5);
  });

  it('rejects uploads with a wrong content hash', async () => {
    const body = new TextEncoder().encode('{"type":"user"}\n');
    const res = await SELF.fetch(
      `https://api.sessions.vza.net/api/v1/files/testbox-wsl/claude-projects/${encodeURIComponent('x/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')}`,
      {
        method: 'PUT',
        headers: {
          'x-dev-machine': 'testbox-wsl',
          'x-content-hash': `sha256:${'0'.repeat(64)}`,
          'content-length': String(body.length),
        },
        body,
      },
    );
    expect(res.status).toBe(400);
  });

  it('enforces machine identity on the upload path', async () => {
    const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/files/other-machine/claude-projects/x.jsonl', {
      method: 'PUT',
      headers: { 'x-content-hash': `sha256:${'0'.repeat(64)}`, 'content-length': '1' },
      body: 'x',
    });
    expect(res.status).toBe(401);
  });
});

describe('canonical selection ignores an errored copy (regression: an errored preferred-priority copy used to win, superseding a good duplicate unparsed)', () => {
  const CANON_SESSION_ID = '66666666-7777-4444-8444-999999999999';
  const CONTENT = [
    ccUserLine({ uuid: 'canon-u1', text: 'canonical selection test' }),
    ccAssistantLine({ uuid: 'canon-a1', parentUuid: 'canon-u1', text: 'canonical selection response' }),
  ].join('\n');

  beforeAll(async () => {
    // Lower priority number wins ties — machine A would normally beat machine B — but A's copy
    // will end up errored, so B must win despite its worse (higher) priority number.
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it('a valid duplicate from a worse-priority machine becomes canonical and parses when the better-priority copy is errored', async () => {
    // Machine A uploads first; its R2 object is deleted before the queue ever delivers it, so
    // its one and only parse attempt genuinely fails with r2_object_missing (parse_state='error'),
    // mirroring a permanently-failed copy after retries are exhausted.
    const resA = await putFile('canon-a', 'claude-projects', `demo-a/${CANON_SESSION_ID}.jsonl`, CONTENT);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/canon-a/claude-projects/demo-a/${CANON_SESSION_ID}.jsonl`;
    await testEnv.RAW.delete(r2KeyA);
    await drainQueue();

    const rowA1 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA1?.parse_state).toBe('error');

    // Machine B uploads a valid duplicate of the same session.
    const resB = await putFile('canon-b', 'claude-projects', `demo-b/${CANON_SESSION_ID}.jsonl`, CONTENT);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    await drainQueue();

    const rowB = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB?.parse_state).toBe('parsed');

    const session = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(CANON_SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(session?.canonical_file_id).toBe(fileIdB);
    expect(session?.index_state).toBe('ready');

    // A retry of A's message (Cloudflare Queues would redeliver it automatically up to
    // max_retries) now sees B as the non-errored canonical and marks A superseded — chooseCanonical
    // runs before the R2 fetch, so this doesn't depend on A's (deleted) object at all.
    await deliverOne(fileIdA, r2KeyA);
    const rowA2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA2?.parse_state).toBe('superseded');
  });
});

describe('canonical selection does not supersede a valid duplicate behind a still-pending preferred copy', () => {
  const CONTENT = [
    ccUserLine({ uuid: 'canon2-u1', text: 'pending-preferred canonical test' }),
    ccAssistantLine({ uuid: 'canon2-a1', parentUuid: 'canon2-u1', text: 'pending-preferred canonical response' }),
  ].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon2-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon2-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it('B (worse priority, delivered first) parses and indexes while A (better priority) is still pending; A catching up later supersedes B', async () => {
    const SESSION_ID = '77777777-8888-4444-8444-000000000001';

    // A is uploaded but its queue message is deliberately never delivered here — it just sits
    // 'pending', simulating the message not having run yet (not lost, just not-yet-processed).
    const resA = await putFile('canon2-a', 'claude-projects', `pend-a/${SESSION_ID}.jsonl`, CONTENT);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/canon2-a/claude-projects/pend-a/${SESSION_ID}.jsonl`;

    // B's message is delivered first (e.g. its queue consumer just happened to run sooner).
    const resB = await putFile('canon2-b', 'claude-projects', `pend-b/${SESSION_ID}.jsonl`, CONTENT);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/canon2-b/claude-projects/pend-b/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);

    // B must have parsed and indexed the session — NOT been superseded behind pending A.
    const rowB1 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB1?.parse_state).toBe('parsed');
    const session1 = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(session1?.canonical_file_id).toBe(fileIdB);
    expect(session1?.index_state).toBe('ready');

    // A eventually delivers and parses (it "is" the preferred candidate for its own processing —
    // chooseCanonical always resolves to a file's own id when comparing against itself for the
    // best-priority slot), which supersedes B via the supersede-losers step.
    await deliverOne(fileIdA, r2KeyA);
    const rowA = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA?.parse_state).toBe('parsed');
    const rowB2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB2?.parse_state).toBe('superseded');
    const session2 = await testEnv.DB.prepare('SELECT canonical_file_id FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number }>();
    expect(session2?.canonical_file_id).toBe(fileIdA);
  });

  it('A pending-then-error, B already indexed: the session stays indexed (index_state stays ready, not clobbered to error)', async () => {
    const SESSION_ID = '77777777-8888-4444-8444-000000000002';

    const resA = await putFile('canon2-a', 'claude-projects', `pend2-a/${SESSION_ID}.jsonl`, CONTENT);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/canon2-a/claude-projects/pend2-a/${SESSION_ID}.jsonl`;

    const resB = await putFile('canon2-b', 'claude-projects', `pend2-b/${SESSION_ID}.jsonl`, CONTENT);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/canon2-b/claude-projects/pend2-b/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);

    const session1 = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(session1?.canonical_file_id).toBe(fileIdB);
    expect(session1?.index_state).toBe('ready');

    // A's R2 object is gone by the time its (still-pending) message finally delivers — it fails,
    // but it was never the session's actual canonical (B already is), so the session must not
    // be marked index_state='error' over A's unrelated failure.
    await testEnv.RAW.delete(r2KeyA);
    await deliverOne(fileIdA, r2KeyA);

    const rowA = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA?.parse_state).toBe('error');

    const session2 = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(session2?.canonical_file_id).toBe(fileIdB);
    expect(session2?.index_state).toBe('ready');
  });
});

describe('canonical selection recheck guards against a concurrent-write race (queue max_concurrency > 1)', () => {
  const CONTENT = [
    ccUserLine({ uuid: 'canon3-u1', text: 'concurrent race canonical test' }),
    ccAssistantLine({ uuid: 'canon3-a1', parentUuid: 'canon3-u1', text: 'concurrent race canonical response' }),
  ].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon3-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('canon3-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it('a worse-priority copy whose pre-parse check already passed must not clobber canonical once the preferred copy finishes first', async () => {
    const SESSION_ID = '99999999-0000-4444-8444-000000000001';

    const resA = await putFile('canon3-a', 'claude-projects', `race-a/${SESSION_ID}.jsonl`, CONTENT);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/canon3-a/claude-projects/race-a/${SESSION_ID}.jsonl`;

    const resB = await putFile('canon3-b', 'claude-projects', `race-b/${SESSION_ID}.jsonl`, CONTENT);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/canon3-b/claude-projects/race-b/${SESSION_ID}.jsonl`;

    // Hold B's R2 fetch open — this happens right after B's pre-parse canonical check (which
    // passes, since A is still 'pending' at that point) but before B has parsed or written
    // anything. While B is blocked there, drive A to full completion. This deterministically
    // reproduces the interleaving a real concurrent consumer (max_concurrency: 2) can hit,
    // without depending on real scheduler timing.
    const originalGet = testEnv.RAW.get.bind(testEnv.RAW);
    let releaseB!: () => void;
    const bHeld = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const getSpy = vi.spyOn(testEnv.RAW, 'get').mockImplementation(async (key: unknown, ...rest: unknown[]) => {
      if (key === r2KeyB) await bHeld;
      return originalGet(key as string, ...(rest as []));
    });

    const bPromise = deliverOne(fileIdB, r2KeyB);
    await deliverOne(fileIdA, r2KeyA);

    const rowAMid = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowAMid?.parse_state).toBe('parsed');
    const sessionMid = await testEnv.DB.prepare('SELECT canonical_file_id FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number }>();
    expect(sessionMid?.canonical_file_id).toBe(fileIdA);

    releaseB();
    await bPromise;
    getSpy.mockRestore();

    // B's post-parse recheck must have caught A already being the parsed, better-priority
    // canonical, and discarded B's write instead of overwriting the session.
    const rowB = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB?.parse_state).toBe('superseded');

    const sessionFinal = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionFinal?.canonical_file_id).toBe(fileIdA);
    expect(sessionFinal?.index_state).toBe('ready');
  });
});

describe('a zero-turn parse (every line malformed) never becomes canonical over a valid duplicate', () => {
  const GARBAGE_CONTENT = ['not valid json at all {{{', 'still garbage ]]] not json', 'more garbage ###'].join('\n');
  const VALID_CONTENT = [
    ccUserLine({ uuid: 'garbage-u1', text: 'zero-turn canonical test' }),
    ccAssistantLine({ uuid: 'garbage-a1', parentUuid: 'garbage-u1', text: 'zero-turn canonical response' }),
  ].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('garbage-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('garbage-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it('the garbage copy is marked error (not parsed) and the lower-priority valid duplicate becomes/stays canonical', async () => {
    const SESSION_ID = '11111111-2222-4444-8444-000000000099';

    const resA = await putFile('garbage-a', 'claude-projects', `garbage-a/${SESSION_ID}.jsonl`, GARBAGE_CONTENT);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/garbage-a/claude-projects/garbage-a/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdA, r2KeyA);

    const rowA = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA?.parse_state).toBe('error');
    const sessionAfterA = await testEnv.DB.prepare('SELECT session_id FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first();
    expect(sessionAfterA).toBeNull(); // nothing indexable was ever written

    const resB = await putFile('garbage-b', 'claude-projects', `valid-b/${SESSION_ID}.jsonl`, VALID_CONTENT);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/garbage-b/claude-projects/valid-b/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);

    const rowB = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB?.parse_state).toBe('parsed');
    const session = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(session?.canonical_file_id).toBe(fileIdB);
    expect(session?.index_state).toBe('ready');
  });
});

describe('a stale parse message (content_hash no longer matches) does not mark the row parsed for content it did not parse', () => {
  it('the stale message is a no-op on the files row; the fresh message parses normally', async () => {
    const SESSION_ID = '22222222-3333-4444-8444-000000000001';
    const relpath = `stale-hash-demo/${SESSION_ID}.jsonl`;
    const CONTENT_OLD = [
      ccUserLine({ uuid: 'stale-u1', text: 'first version of the content' }),
      ccAssistantLine({ uuid: 'stale-a1', parentUuid: 'stale-u1', text: 'first version response' }),
    ].join('\n');
    const CONTENT_NEW = [
      ccUserLine({ uuid: 'stale-u2', text: 'second, newer version of the content' }),
      ccAssistantLine({ uuid: 'stale-a2', parentUuid: 'stale-u2', text: 'second version response' }),
    ].join('\n');

    const resOld = await putFile('stalehash', 'claude-projects', relpath, CONTENT_OLD);
    expect(resOld.status).toBe(201);
    const fileId = ((await resOld.json()) as { file_id: number }).file_id;
    const oldHash = await sha256Hex(new TextEncoder().encode(CONTENT_OLD));
    const r2Key = `raw/stalehash/claude-projects/${relpath}`;

    // Re-upload the SAME (machine, store, relpath) with different content — same files row, new
    // hash, new R2 bytes. The row is 'pending' again, now for the NEW content.
    const resNew = await putFile('stalehash', 'claude-projects', relpath, CONTENT_NEW);
    expect(resNew.status).toBe(201);
    const newHash = await sha256Hex(new TextEncoder().encode(CONTENT_NEW));
    const rowAfterReupload = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowAfterReupload?.parse_state).toBe('pending');
    expect(rowAfterReupload?.content_hash).toBe(newHash);

    // Deliver the STALE message — as if it had been enqueued for the OLD upload and only now
    // reaches the consumer, after the re-upload already changed the row's content_hash.
    await deliverOne(fileId, r2Key, oldHash);
    const rowAfterStale = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(rowAfterStale?.parse_state).toBe('pending'); // untouched — not misleadingly marked 'parsed'

    // Deliver the FRESH message — hash matches, parses normally.
    await deliverOne(fileId, r2Key, newHash);
    const rowAfterFresh = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileId)
      .first<{ parse_state: string }>();
    expect(rowAfterFresh?.parse_state).toBe('parsed');
  });
});

describe('a canonical file reparsed to zero turns clears the stale index and recovers via a duplicate', () => {
  const SESSION_ID = '33333333-4444-4444-8444-000000000001';
  const CONTENT_VALID_A = [
    ccUserLine({ uuid: 'recover-u1', text: 'unique-marker-alpha searchable content' }),
    ccAssistantLine({ uuid: 'recover-a1', parentUuid: 'recover-u1', text: 'unique-marker-alpha response' }),
  ].join('\n');
  const CONTENT_VALID_B = [
    ccUserLine({ uuid: 'recover-u2', text: 'unique-marker-alpha searchable content from B' }),
    ccAssistantLine({ uuid: 'recover-a2', parentUuid: 'recover-u2', text: 'unique-marker-alpha response from B' }),
  ].join('\n');
  const CONTENT_GARBAGE = ['not valid json at all {{{', 'still garbage ]]] not json'].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('recover-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('recover-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it('canonical A goes to garbage: old blocks/FTS/usage are cleared, index_state=error, and the re-enqueued duplicate B recovers the session', async () => {
    const resA = await putFile('recover-a', 'claude-projects', `recover-a-path/${SESSION_ID}.jsonl`, CONTENT_VALID_A);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/recover-a/claude-projects/recover-a-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdA, r2KeyA);

    const sessionAfterA = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionAfterA?.canonical_file_id).toBe(fileIdA);
    expect(sessionAfterA?.index_state).toBe('ready');

    // Confirm the original content is actually searchable before we blow it away.
    const searchBefore = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-alpha', {
      headers: { 'x-dev-machine': 'recover-a' },
    });
    const bodyBefore = (await searchBefore.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyBefore.hits.some((h) => h.session_id === SESSION_ID)).toBe(true);

    // A lower-priority duplicate exists too — it loses to A (already canonical+parsed) and gets
    // superseded, but it's still a valid parseable copy sitting in the wings.
    const resB = await putFile('recover-b', 'claude-projects', `recover-b-path/${SESSION_ID}.jsonl`, CONTENT_VALID_B);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/recover-b/claude-projects/recover-b-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);
    const rowB1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowB1?.parse_state).toBe('superseded');

    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    // The canonical file A gets re-uploaded as garbage.
    const resGarbage = await putFile('recover-a', 'claude-projects', `recover-a-path/${SESSION_ID}.jsonl`, CONTENT_GARBAGE);
    expect(resGarbage.status).toBe(201);
    await deliverOne(fileIdA, r2KeyA);

    const rowA = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string }>();
    expect(rowA?.parse_state).toBe('error');

    const sessionAfterGarbage = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionAfterGarbage?.index_state).toBe('error');
    expect(sessionAfterGarbage?.canonical_file_id).toBe(fileIdA); // kept so raw access still resolves

    const blocksLeft = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ n: number }>();
    expect(blocksLeft?.n).toBe(0);

    const searchAfterGarbage = await SELF.fetch('https://api.sessions.vza.net/api/v1/search?q=unique-marker-alpha', {
      headers: { 'x-dev-machine': 'recover-a' },
    });
    const bodyAfterGarbage = (await searchAfterGarbage.json()) as { hits: Array<{ session_id: string }> };
    expect(bodyAfterGarbage.hits.some((h) => h.session_id === SESSION_ID)).toBe(false);

    // Raw access still resolves — it just now serves the (garbage) current bytes.
    const rawAfterGarbage = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions/${SESSION_ID}/raw`, {
      headers: { 'x-dev-machine': 'recover-a' },
    });
    expect(rawAfterGarbage.status).toBe(200);

    // The recovery machinery should have automatically enqueued B's parse.
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdB, reason: 'recover' }));
    sendSpy.mockRestore();

    // Deliver that recovery message ourselves (the test harness doesn't auto-drain sends).
    await deliverOne(fileIdB, r2KeyB, rowB1!.content_hash);

    const rowB2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB2?.parse_state).toBe('parsed');

    const sessionRecovered = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionRecovered?.canonical_file_id).toBe(fileIdB);
    expect(sessionRecovered?.index_state).toBe('ready');
  });
});

describe('a canonical parse that throws (not just zero-turn) also recovers via a duplicate', () => {
  const SESSION_ID = '44444444-5555-4444-8444-000000000001';
  const CONTENT_VALID_A = [
    ccUserLine({ uuid: 'throwrecover-u1', text: 'unique-marker-beta searchable content' }),
    ccAssistantLine({ uuid: 'throwrecover-a1', parentUuid: 'throwrecover-u1', text: 'unique-marker-beta response' }),
  ].join('\n');
  const CONTENT_VALID_B = [
    ccUserLine({ uuid: 'throwrecover-u2', text: 'unique-marker-beta searchable content from B' }),
    ccAssistantLine({ uuid: 'throwrecover-a2', parentUuid: 'throwrecover-u2', text: 'unique-marker-beta response from B' }),
  ].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('throwrecover-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('throwrecover-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
    ]);
  });

  it("canonical A's R2 object goes missing: the catch path errors the session and automatically re-enqueues superseded duplicate B, which recovers it", async () => {
    const resA = await putFile('throwrecover-a', 'claude-projects', `throwrecover-a-path/${SESSION_ID}.jsonl`, CONTENT_VALID_A);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/throwrecover-a/claude-projects/throwrecover-a-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdA, r2KeyA);

    const sessionAfterA = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionAfterA?.canonical_file_id).toBe(fileIdA);
    expect(sessionAfterA?.index_state).toBe('ready');

    const resB = await putFile('throwrecover-b', 'claude-projects', `throwrecover-b-path/${SESSION_ID}.jsonl`, CONTENT_VALID_B);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/throwrecover-b/claude-projects/throwrecover-b-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);
    const rowB1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowB1?.parse_state).toBe('superseded'); // A was already canonical+parsed

    const sendSpy = vi.spyOn(testEnv.PARSE_QUEUE, 'send');

    // Simulate loss of the canonical's backing R2 object — its next parse attempt throws
    // r2_object_missing instead of producing a zero-turn parse.
    await testEnv.RAW.delete(r2KeyA);
    await deliverOne(fileIdA, r2KeyA);

    const rowA = await testEnv.DB.prepare('SELECT parse_state, parse_error FROM files WHERE id = ?1')
      .bind(fileIdA)
      .first<{ parse_state: string; parse_error: string | null }>();
    expect(rowA?.parse_state).toBe('error');
    expect(rowA?.parse_error).toContain('r2_object_missing');

    const sessionAfterThrow = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionAfterThrow?.index_state).toBe('error');
    expect(sessionAfterThrow?.canonical_file_id).toBe(fileIdA); // kept — old rows are the only surviving trace

    // The catch path should have automatically enqueued B's parse.
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdB, reason: 'recover' }));
    sendSpy.mockRestore();

    // Deliver that recovery message ourselves (the test harness doesn't auto-drain sends).
    await deliverOne(fileIdB, r2KeyB, rowB1!.content_hash);

    const rowB2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB2?.parse_state).toBe('parsed');

    const sessionRecovered = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionRecovered?.canonical_file_id).toBe(fileIdB);
    expect(sessionRecovered?.index_state).toBe('ready');
  });
});

describe('a recovery chain continues past a second failure (regression: canonical_file_id still points at the ORIGINAL failed file while a kicked duplicate is being recovery-parsed, so that duplicate throwing too made the guarded UPDATE match nothing and silently stopped the chain)', () => {
  const SESSION_ID = '44444444-5555-4444-8444-000000000002';
  const CONTENT_A = [
    ccUserLine({ uuid: 'chain-u1', text: 'unique-marker-chain searchable content from A' }),
    ccAssistantLine({ uuid: 'chain-a1', parentUuid: 'chain-u1', text: 'unique-marker-chain response from A' }),
  ].join('\n');
  const CONTENT_B = [
    ccUserLine({ uuid: 'chain-u2', text: 'unique-marker-chain searchable content from B' }),
    ccAssistantLine({ uuid: 'chain-a2', parentUuid: 'chain-u2', text: 'unique-marker-chain response from B' }),
  ].join('\n');
  const CONTENT_C = [
    ccUserLine({ uuid: 'chain-u3', text: 'unique-marker-chain searchable content from C' }),
    ccAssistantLine({ uuid: 'chain-a3', parentUuid: 'chain-u3', text: 'unique-marker-chain response from C' }),
  ].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain-c', 'linux', 2) ON CONFLICT (machine_id) DO UPDATE SET priority = 2",
      ),
    ]);
  });

  it('canonical A fails, kicked duplicate B ALSO fails (its object is also missing) → the chain continues to a third copy C, which recovers the session', async () => {
    const resA = await putFile('chain-a', 'claude-projects', `chain-a-path/${SESSION_ID}.jsonl`, CONTENT_A);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/chain-a/claude-projects/chain-a-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdA, r2KeyA);

    const resB = await putFile('chain-b', 'claude-projects', `chain-b-path/${SESSION_ID}.jsonl`, CONTENT_B);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/chain-b/claude-projects/chain-b-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);
    const rowB1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowB1?.parse_state).toBe('superseded'); // A (priority 0) beat B (priority 1)

    const resC = await putFile('chain-c', 'claude-projects', `chain-c-path/${SESSION_ID}.jsonl`, CONTENT_C);
    expect(resC.status).toBe(201);
    const fileIdC = ((await resC.json()) as { file_id: number }).file_id;
    const r2KeyC = `raw/chain-c/claude-projects/chain-c-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdC, r2KeyC);
    const rowC1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdC)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowC1?.parse_state).toBe('superseded'); // A (priority 0) beat C (priority 2) too

    // Canonical A's R2 object goes missing — its next parse throws, errors the session, and
    // kicks the best other candidate. Between B (priority 1) and C (priority 2), B is preferred.
    const sendSpyA = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    await testEnv.RAW.delete(r2KeyA);
    await deliverOne(fileIdA, r2KeyA);
    expect(sendSpyA).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdB, reason: 'recover' }));
    sendSpyA.mockRestore();

    const sessionAfterA = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionAfterA?.index_state).toBe('error');
    expect(sessionAfterA?.canonical_file_id).toBe(fileIdA); // untouched — B's recovery hasn't run yet

    // B's object is ALSO missing — its recovery-parse attempt throws too. canonical_file_id
    // still points at A (never got to update it), so the guarded UPDATE alone would match
    // nothing here; the reason: 'recover' fallback is what keeps the chain going to C.
    const sendSpyB = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    await testEnv.RAW.delete(r2KeyB);
    await deliverOne(fileIdB, r2KeyB, rowB1!.content_hash, 'recover');

    const rowB2 = await testEnv.DB.prepare('SELECT parse_state, parse_error FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string; parse_error: string | null }>();
    expect(rowB2?.parse_state).toBe('error');
    expect(rowB2?.parse_error).toContain('r2_object_missing');

    expect(sendSpyB).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdC, reason: 'recover' }));
    sendSpyB.mockRestore();

    // C is still intact — deliver its recovery message and the session should fully recover.
    await deliverOne(fileIdC, r2KeyC, rowC1!.content_hash, 'recover');

    const rowC2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdC)
      .first<{ parse_state: string }>();
    expect(rowC2?.parse_state).toBe('parsed');

    const sessionRecovered = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionRecovered?.canonical_file_id).toBe(fileIdC);
    expect(sessionRecovered?.index_state).toBe('ready');
  });
});

describe('a recovery chain continues past a second failure that is a zero-turn parse, not a throw', () => {
  const SESSION_ID = '44444444-5555-4444-8444-000000000003';
  const CONTENT_A = [
    ccUserLine({ uuid: 'chain2-u1', text: 'unique-marker-chain2 searchable content from A' }),
    ccAssistantLine({ uuid: 'chain2-a1', parentUuid: 'chain2-u1', text: 'unique-marker-chain2 response from A' }),
  ].join('\n');
  const CONTENT_B = [
    ccUserLine({ uuid: 'chain2-u2', text: 'unique-marker-chain2 searchable content from B' }),
    ccAssistantLine({ uuid: 'chain2-a2', parentUuid: 'chain2-u2', text: 'unique-marker-chain2 response from B' }),
  ].join('\n');
  const CONTENT_C = [
    ccUserLine({ uuid: 'chain2-u3', text: 'unique-marker-chain2 searchable content from C' }),
    ccAssistantLine({ uuid: 'chain2-a3', parentUuid: 'chain2-u3', text: 'unique-marker-chain2 response from C' }),
  ].join('\n');
  const GARBAGE_CONTENT = ['not valid json at all {{{', 'still garbage ]]] not json'].join('\n');

  beforeAll(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain2-a', 'linux', 0) ON CONFLICT (machine_id) DO UPDATE SET priority = 0",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain2-b', 'linux', 1) ON CONFLICT (machine_id) DO UPDATE SET priority = 1",
      ),
      testEnv.DB.prepare(
        "INSERT INTO machines (machine_id, os, priority) VALUES ('chain2-c', 'linux', 2) ON CONFLICT (machine_id) DO UPDATE SET priority = 2",
      ),
    ]);
  });

  it('canonical A fails (throws), kicks B; B parses to ZERO TURNS instead of throwing → the chain continues to C, which recovers the session', async () => {
    const resA = await putFile('chain2-a', 'claude-projects', `chain2-a-path/${SESSION_ID}.jsonl`, CONTENT_A);
    expect(resA.status).toBe(201);
    const fileIdA = ((await resA.json()) as { file_id: number }).file_id;
    const r2KeyA = `raw/chain2-a/claude-projects/chain2-a-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdA, r2KeyA);

    const resB = await putFile('chain2-b', 'claude-projects', `chain2-b-path/${SESSION_ID}.jsonl`, CONTENT_B);
    expect(resB.status).toBe(201);
    const fileIdB = ((await resB.json()) as { file_id: number }).file_id;
    const r2KeyB = `raw/chain2-b/claude-projects/chain2-b-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdB, r2KeyB);
    const rowB1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowB1?.parse_state).toBe('superseded'); // A (priority 0) beat B (priority 1)

    const resC = await putFile('chain2-c', 'claude-projects', `chain2-c-path/${SESSION_ID}.jsonl`, CONTENT_C);
    expect(resC.status).toBe(201);
    const fileIdC = ((await resC.json()) as { file_id: number }).file_id;
    const r2KeyC = `raw/chain2-c/claude-projects/chain2-c-path/${SESSION_ID}.jsonl`;
    await deliverOne(fileIdC, r2KeyC);
    const rowC1 = await testEnv.DB.prepare('SELECT parse_state, content_hash FROM files WHERE id = ?1')
      .bind(fileIdC)
      .first<{ parse_state: string; content_hash: string }>();
    expect(rowC1?.parse_state).toBe('superseded'); // A (priority 0) beat C (priority 2) too

    // Canonical A's R2 object goes missing — throws, errors the session, and kicks the best
    // other candidate. Between B (priority 1) and C (priority 2), B is preferred.
    const sendSpyA = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    await testEnv.RAW.delete(r2KeyA);
    await deliverOne(fileIdA, r2KeyA);
    expect(sendSpyA).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdB, reason: 'recover' }));
    sendSpyA.mockRestore();

    // Corrupt B's R2 object with garbage bytes WITHOUT touching its D1 row — content_hash stays
    // the original valid one, so redelivering the recovery message (which carries that same
    // hash) passes markParsed's guard and reaches the ZERO-TURN branch instead of throwing.
    const sendSpyB = vi.spyOn(testEnv.PARSE_QUEUE, 'send');
    await testEnv.RAW.put(r2KeyB, new TextEncoder().encode(GARBAGE_CONTENT));
    await deliverOne(fileIdB, r2KeyB, rowB1!.content_hash, 'recover');

    const rowB2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdB)
      .first<{ parse_state: string }>();
    expect(rowB2?.parse_state).toBe('error'); // every line malformed, not a throw

    // B's zero-turn parse did NOT match the canonical guard (canonical_file_id is still A), but
    // since it was itself a 'recover'-reason message, the chain must continue to C anyway.
    expect(sendSpyB).toHaveBeenCalledWith(expect.objectContaining({ file_id: fileIdC, reason: 'recover' }));
    sendSpyB.mockRestore();

    // C is still intact — deliver its recovery message and the session should fully recover.
    await deliverOne(fileIdC, r2KeyC, rowC1!.content_hash, 'recover');

    const rowC2 = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(fileIdC)
      .first<{ parse_state: string }>();
    expect(rowC2?.parse_state).toBe('parsed');

    const sessionRecovered = await testEnv.DB.prepare('SELECT canonical_file_id, index_state FROM sessions WHERE session_id = ?1')
      .bind(SESSION_ID)
      .first<{ canonical_file_id: number; index_state: string }>();
    expect(sessionRecovered?.canonical_file_id).toBe(fileIdC);
    expect(sessionRecovered?.index_state).toBe('ready');
  });
});
