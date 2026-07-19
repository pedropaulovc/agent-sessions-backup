/** Cursor pagination on /api/v1/sessions, its ndjson full-stream mode, filtered
 * indexed_through, and the machine/harness filters on /api/v1/usage — task #11 items (1),
 * (2), (5) from the M6 client work. No client-side changes here (hub only). */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ccLine, codexLines, CODEX_SESSION_ID } from './fixtures';
import { chatgptExportZip } from './web-fixtures';

const testEnv = env as unknown as Env;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function putBytes(machine: string, store: string, relpath: string, body: Uint8Array): Promise<Response> {
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

async function putFile(machine: string, store: string, relpath: string, content: string): Promise<Response> {
  return putBytes(machine, store, relpath, new TextEncoder().encode(content));
}

async function drainQueue(): Promise<void> {
  // consumeParseBatch DEFERS (re-enqueues) an export whose per-invocation budget reservation would overflow
  // once earlier messages in the same batch have already spent budget — so a batch that mixes normal files
  // with an export leaves the export 'pending' for a later invocation. Prod redelivers those; mirror it by
  // re-delivering pending files until none remain (each invocation runs at least its first message, so an
  // export eventually leads a batch and runs; the cap is a safety net).
  for (let i = 0; i < 50; i++) {
    const pending = await testEnv.DB.prepare("SELECT id, r2_key FROM files WHERE parse_state = 'pending'").all<{
      id: number;
      r2_key: string;
    }>();
    if (pending.results.length === 0) return;
    const messages = pending.results.map((r) => ({
      id: String(r.id),
      timestamp: new Date(),
      attempts: 1,
      body: { file_id: r.id, r2_key: r.r2_key, reason: 'upload' as const },
      ack() {},
      retry() {},
    }));
    await worker.queue({ queue: 'parse', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>, testEnv);
  }
}

function get(qs: string): Promise<Response> {
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions?${qs}`, { headers: { 'x-dev-machine': 'reader' } });
}

/** A minimal one-line session: just enough for the claude-code parser to produce a row with
 * a controlled started_at (the parser takes the MIN line timestamp — see claude-code.ts). */
function soloSession(sessionId: string, ts: string): string {
  return ccLine(sessionId, { uuid: 'u1', role: 'user', text: 'hello', ts });
}

describe('/api/v1/sessions cursor pagination', () => {
  const MACHINE = 'pagebox';
  // 7 sessions: 5 with distinct started_at, plus 2 (…-006, …-007) sharing the SAME started_at
  // as each other (the newest) to exercise the session_id tiebreak. Expected DESC order (by
  // started_at, then session_id ASC on the tie) is 006, 007, 005, 004, 003, 002, 001.
  const IDS = [1, 2, 3, 4, 5, 6, 7].map((n) => `a0000000-0000-4000-8000-00000000000${n}`);
  const TS: Record<number, string> = {
    1: '2026-07-10T00:00:01.000Z',
    2: '2026-07-10T00:00:02.000Z',
    3: '2026-07-10T00:00:03.000Z',
    4: '2026-07-10T00:00:04.000Z',
    5: '2026-07-10T00:00:05.000Z',
    6: '2026-07-10T00:00:07.000Z',
    7: '2026-07-10T00:00:07.000Z',
  };
  const EXPECTED_ORDER = [6, 7, 5, 4, 3, 2, 1].map((n) => IDS[n - 1]!);

  beforeAll(async () => {
    for (let n = 1; n <= 7; n++) {
      const res = await putFile(MACHINE, 'claude-projects', `pg${n}/${IDS[n - 1]!}.jsonl`, soloSession(IDS[n - 1]!, TS[n]!));
      expect(res.status).toBe(201);
    }
    await drainQueue();
  });

  it('walks all pages with limit=3 in the expected deterministic order, no dupes or gaps', async () => {
    const seen: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const qs = new URLSearchParams({ machine: MACHINE, limit: '3' });
      if (cursor) qs.set('cursor', cursor);
      const res = await get(qs.toString());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: { session_id: string }[]; cursor?: string };
      pageSizes.push(body.sessions.length);
      seen.push(...body.sessions.map((s) => s.session_id));
      cursor = body.cursor;
      guard++;
    } while (cursor && guard < 10);

    expect(pageSizes).toEqual([3, 3, 1]); // 3 pages: 7 sessions at page size 3
    expect(seen).toEqual(EXPECTED_ORDER); // exact order, tiebreak included
    expect(new Set(seen).size).toBe(7); // no dupes across the page boundary
  });

  it('an invalid cursor resets to the first page instead of erroring (mirrors /api/v1/search)', async () => {
    const res = await get(`machine=${MACHINE}&limit=3&cursor=not-valid-base64!!!`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { session_id: string }[] };
    expect(body.sessions.map((s) => s.session_id)).toEqual(EXPECTED_ORDER.slice(0, 3));
  });

  it('the last page omits cursor entirely (end-of-results signal)', async () => {
    const res = await get(`machine=${MACHINE}&limit=100`); // one page covers all 7
    const body = (await res.json()) as { sessions: unknown[]; cursor?: string };
    expect(body.sessions.length).toBe(7);
    expect(body.cursor).toBeUndefined();
  });

  it('format=ndjson streams the COMPLETE filtered set across internal pages, ignoring limit as a total cap, with no trailer cursor when under NDJSON_MAX_ROWS_PER_REQUEST', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions?machine=${MACHINE}&limit=3&format=ndjson`, {
      headers: { 'x-dev-machine': 'reader' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(7); // NOT capped at limit=3 — that's the whole point of ndjson
    const parsed = lines.map((l) => JSON.parse(l) as { meta?: { session_id: string }; session?: unknown; cursor?: string });
    // 7 sessions is well under the 300-row cap, so every line is a normal row — no trailer.
    expect(parsed.every((l) => 'meta' in l)).toBe(true);
    expect(parsed.some((l) => 'cursor' in l)).toBe(false);
    const ids = parsed.map((l) => l.meta!.session_id);
    expect(ids).toEqual(EXPECTED_ORDER);
    expect(new Set(ids).size).toBe(7);
  });

  it('a keyset cursor is stable when a NEW session is ingested ahead of page 1, unlike an offset cursor (positive control)', async () => {
    const qs1 = new URLSearchParams({ machine: MACHINE, limit: '3' });
    const res1 = await get(qs1.toString());
    const body1 = (await res1.json()) as { sessions: { session_id: string }[]; cursor?: string };
    expect(body1.sessions.map((s) => s.session_id)).toEqual(EXPECTED_ORDER.slice(0, 3)); // [6, 7, 5]
    expect(body1.cursor).toBeDefined();

    // Positive control: an OFFSET-based cursor (the pre-redesign shape) for the SAME logical
    // page 2, computed before vs. after the insert below, to show the failure mode this
    // keyset design avoids. Simulated with a raw query (mirroring the old decodeCursor/OFFSET
    // implementation) since /api/v1/sessions no longer speaks offset cursors at all.
    const offsetQuery = () =>
      testEnv.DB.prepare(
        `SELECT session_id FROM sessions WHERE machine_id = ?1 ORDER BY started_at DESC, session_id ASC LIMIT 3 OFFSET 3`,
      )
        .bind(MACHINE)
        .all<{ session_id: string }>();
    const offsetPage2Before = (await offsetQuery()).results.map((r) => r.session_id);
    expect(offsetPage2Before).toEqual(EXPECTED_ORDER.slice(3, 6)); // [4, 3, 2] — matches keyset page 2 before any insert

    // A new session ingested BETWEEN page fetches, sorting ahead of everything on page 1.
    const NEW_ID = 'a0000000-0000-4000-8000-000000000099';
    const res = await putFile(MACHINE, 'claude-projects', `pg99/${NEW_ID}.jsonl`, soloSession(NEW_ID, '2026-07-10T00:00:09.000Z'));
    expect(res.status).toBe(201);
    await drainQueue();

    const offsetPage2After = (await offsetQuery()).results.map((r) => r.session_id);
    // The offset cursor now REPEATS a row from page 1 (5, already seen) and SKIPS one it never
    // saw (2) — exactly the shifted-ordering bug this endpoint's keyset cursor exists to avoid.
    expect(offsetPage2After).not.toEqual(offsetPage2Before);
    expect(offsetPage2After).toContain(IDS[5 - 1]!); // dup of an already-seen row
    expect(offsetPage2After).not.toContain(IDS[2 - 1]!); // skips a row it never saw

    // The real keyset-cursor page 2, fetched AFTER the concurrent insert, using the cursor
    // captured before it. No dupes of page 1, no skips, and the new session is correctly
    // excluded (it sorts ahead of the cursor's boundary, so it belongs on a re-fetched page 1,
    // not this page 2).
    const qs2 = new URLSearchParams({ machine: MACHINE, limit: '3', cursor: body1.cursor! });
    const res2 = await get(qs2.toString());
    const body2 = (await res2.json()) as { sessions: { session_id: string }[] };
    const page2Ids = body2.sessions.map((s) => s.session_id);
    expect(page2Ids).toEqual(EXPECTED_ORDER.slice(3, 6)); // [4, 3, 2] — unaffected by the insert
    expect(page2Ids.some((id) => body1.sessions.some((s) => s.session_id === id))).toBe(false); // no dupes
    expect(page2Ids).not.toContain(NEW_ID);
  });
});

describe('/api/v1/sessions keyset paging traverses NULL started_at rows (round-2 finding 1)', () => {
  const MACHINE = 'nullstartbox';
  // 3 dated sessions (DESC order: d3, d2, d1) followed by 3 undated ones, tiebroken by
  // session_id ASC among themselves (COALESCE(started_at,'') ties them all at ''). Full
  // expected order: d3, d2, d1, null-a, null-b, null-c.
  const DATED = [
    { id: 'd0000001-0000-4000-8000-000000000000', ts: '2026-07-10T00:00:01.000Z' },
    { id: 'd0000002-0000-4000-8000-000000000000', ts: '2026-07-10T00:00:02.000Z' },
    { id: 'd0000003-0000-4000-8000-000000000000', ts: '2026-07-10T00:00:03.000Z' },
  ];
  const UNDATED_IDS = ['null-a', 'null-b', 'null-c'];
  const EXPECTED_ORDER = ['d0000003-0000-4000-8000-000000000000', 'd0000002-0000-4000-8000-000000000000', 'd0000001-0000-4000-8000-000000000000', ...UNDATED_IDS];

  beforeAll(async () => {
    const stmts = [
      ...DATED.map(({ id, ts }) =>
        testEnv.DB.prepare('INSERT INTO sessions (session_id, harness, machine_id, started_at, index_state) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
          id,
          'claude-code',
          MACHINE,
          ts,
          'ready',
        ),
      ),
      ...UNDATED_IDS.map((id) =>
        testEnv.DB.prepare('INSERT INTO sessions (session_id, harness, machine_id, started_at, index_state) VALUES (?1, ?2, ?3, NULL, ?4)').bind(
          id,
          'claude-code',
          MACHINE,
          'ready',
        ),
      ),
    ];
    await testEnv.DB.batch(stmts);
  });

  it('walks all pages across a NULL-started_at boundary row, no drops, cursor round-trips through the undated region', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      // limit=4 makes page 1 end exactly ON a NULL row (d3, d2, d1, null-a) — the boundary
      // row itself is undated, which is the specific case that used to fail to decode.
      const qs = new URLSearchParams({ machine: MACHINE, limit: '4' });
      if (cursor) qs.set('cursor', cursor);
      const res = await get(qs.toString());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: { session_id: string }[]; cursor?: string };
      expect(body.sessions.length).toBeGreaterThan(0); // no silently-empty page while a cursor was still active
      seen.push(...body.sessions.map((s) => s.session_id));
      cursor = body.cursor;
      guard++;
    } while (cursor && guard < 10);

    expect(seen).toEqual(EXPECTED_ORDER); // exact order, undated rows last and internally tiebroken
    expect(new Set(seen).size).toBe(6); // no dupes
  });
});

/** Direct-DB fixture helper for the NDJSON cap tests below: 300+ real uploads through
 * putFile+drainQueue would be prohibitively slow for a single test, and none of the columns
 * these tests assert on (session_id, machine_id, harness, started_at) need a real parsed
 * canonical file — canonical_file_id is nullable (see migrations/0001_init.sql) and
 * loadNormalized() already tolerates a session with no resolvable file, returning `session:
 * null` for that row (same precedent as test/reindex.test.ts mocking R2 responses instead of
 * running the full ingest pipeline for volume tests). */
// Shared across every call in this file so ids never collide between separate
// insertSyntheticSessions invocations (e.g. two different-sized fixtures in sibling tests) —
// deriving the id from a per-call loop index alone would let both start at c0000000-...
let syntheticIdCounter = 0;

async function insertSyntheticSessions(machine: string, harness: string, count: number, startTs: number): Promise<string[]> {
  const ids: string[] = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const id = `c${String(syntheticIdCounter++).padStart(7, '0')}-0000-4000-8000-000000000000`;
    ids.push(id);
    const startedAt = new Date(startTs + i * 1000).toISOString();
    stmts.push(
      testEnv.DB.prepare('INSERT INTO sessions (session_id, harness, machine_id, started_at, index_state) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
        id,
        harness,
        machine,
        startedAt,
        'ready',
      ),
    );
  }
  // Chunked to stay well under D1's per-batch statement limits, mirroring the chunking
  // convention already used for D1 writes in consumer.ts/reindex.ts.
  for (let i = 0; i < stmts.length; i += 50) {
    await testEnv.DB.batch(stmts.slice(i, i + 50));
  }
  return ids;
}

describe('/api/v1/sessions keyset cursor round-trips a non-Latin-1 session_id (round-5 finding 2)', () => {
  const MACHINE = 'unicodebox';
  // Web-capture session ids come straight from a URL-decoded upload filename (detect.ts's
  // chatgpt-web/claude-web cases) — non-ASCII is a real, not hypothetical, case. One café-style
  // Latin-1-adjacent-but-not-actually-Latin-1 id and one CJK id, to hit both "a character btoa
  // would throw on outright" and "one that looks deceptively close to safe."
  const IDS = ['café-a0000000-0000-4000-8000-000000000001', '東京-a0000000-0000-4000-8000-000000000002'];

  beforeAll(async () => {
    await testEnv.DB.batch(
      IDS.map((id, i) =>
        testEnv.DB.prepare('INSERT INTO sessions (session_id, harness, machine_id, started_at, index_state) VALUES (?1, ?2, ?3, ?4, ?5)').bind(
          id,
          'chatgpt-web',
          MACHINE,
          `2026-07-11T00:00:0${i + 1}.000Z`,
          'ready',
        ),
      ),
    );
  });

  it('paginates across a boundary row with a non-Latin-1 session_id without 500ing, cursor round-trips', async () => {
    const res1 = await get(`machine=${MACHINE}&limit=1`);
    expect(res1.status).toBe(200); // NOT a 500 from btoa throwing on the boundary row
    const body1 = (await res1.json()) as { sessions: { session_id: string }[]; cursor?: string };
    expect(body1.sessions.map((s) => s.session_id)).toEqual([IDS[1]]); // newer started_at first
    expect(body1.cursor).toBeDefined();

    const res2 = await get(`machine=${MACHINE}&limit=1&cursor=${encodeURIComponent(body1.cursor!)}`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { sessions: { session_id: string }[]; cursor?: string };
    expect(body2.sessions.map((s) => s.session_id)).toEqual([IDS[0]]);
    expect(body2.cursor).toBeUndefined(); // last page
  });
});

describe('/api/v1/sessions format=ndjson bounds total rows per request at NDJSON_MAX_ROWS_PER_REQUEST', () => {
  const MACHINE = 'ndjsoncapbox';
  const HARNESS = 'claude-code';
  const CAP = 300; // must match NDJSON_MAX_ROWS_PER_REQUEST in src/api/sessions.ts
  const TOTAL = CAP + 7; // > cap, so the first request must trail off with a resume cursor
  let ids: string[] = [];

  beforeAll(async () => {
    // started_at ascending with i, so DESC order (the endpoint's sort) visits ids in REVERSE
    // insertion order: last-inserted (highest i, latest started_at) comes first.
    ids = await insertSyntheticSessions(MACHINE, HARNESS, TOTAL, Date.parse('2026-06-01T00:00:00.000Z'));
  });

  function ndjson(qs: string): Promise<Response> {
    return SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions?${qs}&format=ndjson`, {
      headers: { 'x-dev-machine': 'reader' },
    });
  }

  async function readLines(res: Response): Promise<{ meta?: { session_id: string }; cursor?: string }[]> {
    const text = await res.text();
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { meta?: { session_id: string }; cursor?: string });
  }

  it('> cap: stream ends with exactly one trailer cursor line at the cap; following it yields the remainder with no dupes/gaps', async () => {
    const res1 = await ndjson(`machine=${MACHINE}&limit=100`);
    expect(res1.status).toBe(200);
    const lines1 = await readLines(res1);
    // Exactly CAP data rows, then exactly one trailer control line (no meta/session keys).
    const dataLines1 = lines1.filter((l) => 'meta' in l);
    const trailerLines1 = lines1.filter((l) => 'cursor' in l && !('meta' in l));
    expect(dataLines1.length).toBe(CAP);
    expect(trailerLines1.length).toBe(1);
    expect(lines1.at(-1)).toBe(trailerLines1[0]); // trailer is the LAST line, not interleaved

    const page1Ids = dataLines1.map((l) => l.meta!.session_id);
    expect(new Set(page1Ids).size).toBe(CAP); // no dupes within page 1

    const res2 = await ndjson(`machine=${MACHINE}&limit=100&cursor=${encodeURIComponent(trailerLines1[0]!.cursor!)}`);
    expect(res2.status).toBe(200);
    const lines2 = await readLines(res2);
    const dataLines2 = lines2.filter((l) => 'meta' in l);
    const trailerLines2 = lines2.filter((l) => 'cursor' in l && !('meta' in l));
    expect(trailerLines2.length).toBe(0); // remainder (7 rows) is well under the cap -> no trailer

    const page2Ids = dataLines2.map((l) => l.meta!.session_id);
    expect(page2Ids.length).toBe(TOTAL - CAP); // exactly the remainder
    // No dupes and no gaps across the two requests: together they cover every id exactly once.
    const all = [...page1Ids, ...page2Ids];
    expect(new Set(all).size).toBe(TOTAL);
    expect(all.sort()).toEqual([...ids].sort());
  });

  it('<= cap: no trailer cursor line', async () => {
    const SMALL_MACHINE = 'ndjsonsmallbox';
    const SMALL_TOTAL = 50; // well under the 300 cap
    const smallIds = await insertSyntheticSessions(SMALL_MACHINE, HARNESS, SMALL_TOTAL, Date.parse('2026-05-01T00:00:00.000Z'));

    const res = await ndjson(`machine=${SMALL_MACHINE}&limit=100`);
    expect(res.status).toBe(200);
    const lines = await readLines(res);
    const dataLines = lines.filter((l) => 'meta' in l);
    const trailerLines = lines.filter((l) => 'cursor' in l && !('meta' in l));
    expect(dataLines.length).toBe(SMALL_TOTAL);
    expect(trailerLines.length).toBe(0);
    expect(new Set(dataLines.map((l) => l.meta!.session_id)).size).toBe(SMALL_TOTAL);
    expect(dataLines.map((l) => l.meta!.session_id).sort()).toEqual([...smallIds].sort());
  });
});

// One shared fixture pair (a claude-code-only machine and a codex-only machine) for both the
// indexed_through filter tests and the usage filter tests below — codexLines() hardcodes
// CODEX_SESSION_ID (not parametrized), so a second, independent codex upload under a
// different machine would collide on session_id and get silently reassigned to whichever
// upload wins canonical dedupe, corrupting both blocks' assertions. Sharing one fixture set
// sidesteps that entirely instead of routing around it per-block.
describe('X-Indexed-Through and /api/v1/usage respect the request machine/harness filter', () => {
  const MACHINE_A = 'filterbox-a'; // claude-code only
  const MACHINE_B = 'filterbox-b'; // codex only
  const CC_ID = 'b0000000-0000-4000-8000-000000000001';
  const STALE_TS = '2020-01-01T00:00:00.000Z';
  const FRESH_TS = '2026-07-18T12:00:00.000Z';

  beforeAll(async () => {
    // A two-line session (not soloSession) so the claude-code assistant turn also produces a
    // usage row — this fixture set doubles as the usage-filter tests' data below.
    const ccContent = [
      ccLine(CC_ID, { uuid: 'u1', role: 'user', text: 'hi', ts: '2026-07-01T00:00:00.000Z' }),
      ccLine(CC_ID, { uuid: 'a1', parentUuid: 'u1', role: 'assistant', text: 'hello back', ts: '2026-07-01T00:00:01.000Z' }),
    ].join('\n');
    const ccRes = await putFile(MACHINE_A, 'claude-projects', `filter-a/${CC_ID}.jsonl`, ccContent);
    expect(ccRes.status).toBe(201);
    const codexRes = await putFile(
      MACHINE_B,
      'codex-sessions',
      `2026/07/02/rollout-2026-07-02T09-00-00-${CODEX_SESSION_ID}.jsonl`,
      `${codexLines().join('\n')}\n`,
    );
    expect(codexRes.status).toBe(201);
    await drainQueue();
    // Direct DB writes for exact, known indexed_through values — heartbeat timing in a test
    // run isn't otherwise controllable to the millisecond this assertion needs.
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(STALE_TS, MACHINE_A).run();
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(FRESH_TS, MACHINE_B).run();
  });

  it('machine filter -> that machine\'s own indexed_through, not the fleet minimum', async () => {
    const resA = await get(`machine=${MACHINE_A}`);
    expect(((await resA.json()) as { indexed_through: string }).indexed_through).toBe(STALE_TS);
    expect(resA.headers.get('x-indexed-through')).toBe(STALE_TS);

    const resB = await get(`machine=${MACHINE_B}`);
    expect(((await resB.json()) as { indexed_through: string }).indexed_through).toBe(FRESH_TS);
  });

  it('harness filter -> MIN over machines that have sessions of that harness', async () => {
    const resCc = await get('harness=claude-code');
    const bodyCc = (await resCc.json()) as { indexed_through: string };
    expect(bodyCc.indexed_through).toBe(STALE_TS); // only MACHINE_A has claude-code sessions

    const resCodex = await get('harness=codex');
    const bodyCodex = (await resCodex.json()) as { indexed_through: string };
    expect(bodyCodex.indexed_through).toBe(FRESH_TS); // only MACHINE_B has codex sessions
  });

  it('harness filter -> also counts a machine with only a PENDING file of that harness (no sessions row yet)', async () => {
    const PENDING_MACHINE = 'filterbox-pending';
    const PENDING_TS = '2019-01-01T00:00:00.000Z'; // older than STALE_TS, so it must drag the MIN down
    // Uploaded but never drained through the queue: files.harness is detected/stamped at
    // upload time (see upload.ts's detectHarness call before the INSERT), so this machine has
    // a claude-code-harness `files` row while still having ZERO `sessions` rows.
    const res = await putFile(
      PENDING_MACHINE,
      'claude-projects',
      `pending/${'b0000000-0000-4000-8000-000000000099'}.jsonl`,
      soloSession('b0000000-0000-4000-8000-000000000099', '2026-07-15T00:00:00.000Z'),
    );
    expect(res.status).toBe(201);
    // Deliberately no drainQueue() call — the file stays parse_state='pending', no sessions row.
    const pending = await testEnv.DB.prepare('SELECT parse_state FROM files WHERE machine_id = ?1')
      .bind(PENDING_MACHINE)
      .first<{ parse_state: string }>();
    expect(pending?.parse_state).toBe('pending');
    const sessionCount = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE machine_id = ?1')
      .bind(PENDING_MACHINE)
      .first<{ n: number }>();
    expect(sessionCount?.n).toBe(0);
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(PENDING_TS, PENDING_MACHINE).run();

    const resCc = await get('harness=claude-code');
    const bodyCc = (await resCc.json()) as { indexed_through: string };
    // Without the files-table UNION, this machine (zero sessions rows) would be invisible to
    // the harness-scoped query and the MIN would stay at STALE_TS from MACHINE_A.
    expect(bodyCc.indexed_through).toBe(PENDING_TS);
  });

  it('harness filter -> excludes a machine whose only harness-X file is superseded (round-2 finding 2)', async () => {
    const SUPERSEDED_MACHINE = 'filterbox-superseded';
    const SUPERSEDED_TS = '2015-01-01T00:00:00.000Z'; // far older than everything else in this block
    const res = await putFile(
      SUPERSEDED_MACHINE,
      'claude-projects',
      `superseded/${'b0000000-0000-4000-8000-000000000098'}.jsonl`,
      soloSession('b0000000-0000-4000-8000-000000000098', '2026-07-14T00:00:00.000Z'),
    );
    expect(res.status).toBe(201);
    // Simulates the real outcome of canonical-dedupe demoting a lower-priority duplicate: a
    // terminal 'superseded' file that can NEVER produce a sessions row on this machine.
    await testEnv.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE machine_id = ?1").bind(SUPERSEDED_MACHINE).run();
    const sessionCount = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE machine_id = ?1')
      .bind(SUPERSEDED_MACHINE)
      .first<{ n: number }>();
    expect(sessionCount?.n).toBe(0);
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(SUPERSEDED_TS, SUPERSEDED_MACHINE).run();

    const resCc = await get('harness=claude-code');
    const bodyCc = (await resCc.json()) as { indexed_through: string };
    // The prior test in this block ('...only a PENDING file...') already set the
    // claude-code-harness MIN to PENDING_TS='2019-01-01...' via a still-pending file, which
    // remains the correct minimum here. If the files arm didn't filter by parse_state, this
    // ancient, terminal-state machine would drag it down further to SUPERSEDED_TS even
    // though nothing on it can ever surface under harness=claude-code.
    expect(bodyCc.indexed_through).not.toBe(SUPERSEDED_TS);
    expect(bodyCc.indexed_through).toBe('2019-01-01T00:00:00.000Z');
  });

  it('harness filter -> includes a machine whose only file is a pending unknown-harness export ZIP, until it parses (round-3 finding)', async () => {
    const WEBZIP_MACHINE = 'filterbox-webzip';
    const WEBZIP_TS = '2016-01-01T00:00:00.000Z'; // older than everything else in this block
    const zip = chatgptExportZip([
      { id: 'conv-unknown-1', title: 'pending export', turns: [{ node: 'n1', parent: 'root-node', role: 'user', text: 'hello' }] },
    ]);
    const res = await putBytes(WEBZIP_MACHINE, 'export-inbox', 'pending.zip', zip);
    expect(res.status).toBe(201);
    const fileRow = await testEnv.DB.prepare('SELECT harness, parse_state FROM files WHERE machine_id = ?1')
      .bind(WEBZIP_MACHINE)
      .first<{ harness: string; parse_state: string }>();
    // detect() (hub/src/ingest/detect.ts) stamps a .zip upload 'unknown' — its real
    // per-conversation harness isn't known until parseExportArchive() reads the archive.
    expect(fileRow?.harness).toBe('unknown');
    expect(fileRow?.parse_state).toBe('pending');
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(WEBZIP_TS, WEBZIP_MACHINE).run();

    // Included for harness=claude-web even though this ZIP will turn out to be chatgpt-web
    // content — a pending 'unknown' file could contain sessions of the OTHER web harness, so
    // it must count against every WEB-harness-scoped freshness read until parsed.
    const before = await get('harness=claude-web');
    const bodyBefore = (await before.json()) as { indexed_through: string };
    expect(bodyBefore.indexed_through).toBe(WEBZIP_TS);

    // NOT included for harness=codex (round-4 finding): parseExportArchive only ever
    // resolves an 'unknown' export to chatgpt-web or claude-web, never codex, so a stuck web
    // export must not make codex's freshness report stale over data that cannot exist there.
    const beforeCodex = await get('harness=codex');
    const bodyBeforeCodex = (await beforeCodex.json()) as { indexed_through: string };
    expect(bodyBeforeCodex.indexed_through).not.toBe(WEBZIP_TS);

    await drainQueue();
    const parsedFileRow = await testEnv.DB.prepare('SELECT harness, parse_state FROM files WHERE machine_id = ?1')
      .bind(WEBZIP_MACHINE)
      .first<{ harness: string; parse_state: string }>();
    expect(parsedFileRow?.parse_state).toBe('parsed');

    // Once parsed, the file is no longer 'pending'/'error' (excluded from the files arm) and
    // its actual content is chatgpt-web, not claude-web — the machine correctly drops out of
    // claude-web freshness, covered by the existing sessions/files arms.
    const after = await get('harness=claude-web');
    const bodyAfter = (await after.json()) as { indexed_through: string };
    expect(bodyAfter.indexed_through).not.toBe(WEBZIP_TS);
  });

  it('harness filter -> excludes unknown-harness files that can never resolve to a web session (round-5 finding)', async () => {
    // Case A: a non-.zip file dropped in export-inbox — detect() stamps it harness='unknown',
    // kind='other' (not 'export-archive'), so parseExportArchive() never even runs on it.
    const NONZIP_MACHINE = 'filterbox-nonzip';
    const NONZIP_TS = '2015-01-01T00:00:00.000Z';
    const nonzipRes = await putFile(NONZIP_MACHINE, 'export-inbox', 'notes.txt', 'not an export archive');
    expect(nonzipRes.status).toBe(201);
    const nonzipFile = await testEnv.DB.prepare('SELECT harness, parse_state FROM files WHERE machine_id = ?1')
      .bind(NONZIP_MACHINE)
      .first<{ harness: string; parse_state: string }>();
    expect(nonzipFile?.harness).toBe('unknown');
    expect(nonzipFile?.parse_state).toBe('skipped'); // known non-session shape bypasses the parse queue
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(NONZIP_TS, NONZIP_MACHINE).run();

    // Case B: an unrecognized path shape in an unrelated store (claude-projects) — also
    // harness='unknown', kind='other', same as case A but not even in export-inbox.
    const OTHERSTORE_MACHINE = 'filterbox-otherstore';
    const OTHERSTORE_TS = '2014-01-01T00:00:00.000Z';
    const otherRes = await putFile(OTHERSTORE_MACHINE, 'claude-projects', 'not-a-uuid.jsonl', 'irrelevant content');
    expect(otherRes.status).toBe(201);
    const otherFile = await testEnv.DB.prepare('SELECT harness, parse_state FROM files WHERE machine_id = ?1')
      .bind(OTHERSTORE_MACHINE)
      .first<{ harness: string; parse_state: string }>();
    expect(otherFile?.harness).toBe('unknown');
    expect(otherFile?.parse_state).toBe('skipped');
    await testEnv.DB.prepare('UPDATE machines SET last_seen_at = ?1 WHERE machine_id = ?2').bind(OTHERSTORE_TS, OTHERSTORE_MACHINE).run();

    // Neither is an export-archive-shaped row, so neither drags harness=claude-web's
    // freshness down. Both are terminal 'unknown' files and cannot resolve to a web session.
    const res = await get('harness=claude-web');
    const body = (await res.json()) as { indexed_through: string };
    expect(body.indexed_through).not.toBe(NONZIP_TS);
    expect(body.indexed_through).not.toBe(OTHERSTORE_TS);
  });

  it('no filter -> fleet-wide MIN across all machines (unchanged behavior)', async () => {
    const res = await get('');
    const body = (await res.json()) as { indexed_through: string };
    // Fleet-wide MIN must be <= the older of the two machines set up in this block (other
    // machines from earlier describe blocks in this file may be even older/newer; the
    // invariant that holds regardless is "no worse than the stalest one we know about here").
    expect(body.indexed_through <= STALE_TS).toBe(true);
  });

  function usage(qs: string): Promise<Response> {
    return SELF.fetch(`https://api.sessions.vza.net/api/v1/usage?${qs}`, { headers: { 'x-dev-machine': 'reader' } });
  }

  it('usage: machine filter scopes rows to that machine only', async () => {
    const res = await usage(`group_by=machine&machine=${MACHINE_A}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { bucket: string; calls: number }[] };
    const buckets = body.rows.map((r) => r.bucket);
    expect(buckets).toContain(MACHINE_A);
    expect(buckets).not.toContain(MACHINE_B);
  });

  it('usage: harness filter scopes rows to sessions of that harness only', async () => {
    const res = await usage('group_by=machine&harness=codex');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { bucket: string }[] };
    const buckets = body.rows.map((r) => r.bucket);
    expect(buckets).toContain(MACHINE_B);
    expect(buckets).not.toContain(MACHINE_A);
  });

  it('usage: no filter includes both machines (unchanged fleet-wide behavior)', async () => {
    const res = await usage('group_by=machine');
    const body = (await res.json()) as { rows: { bucket: string }[] };
    const buckets = body.rows.map((r) => r.bucket);
    expect(buckets).toContain(MACHINE_A);
    expect(buckets).toContain(MACHINE_B);
  });
});
