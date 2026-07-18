/** Cursor pagination on /api/v1/sessions, its ndjson full-stream mode, filtered
 * indexed_through, and the machine/harness filters on /api/v1/usage — task #11 items (1),
 * (2), (5) from the M6 client work. No client-side changes here (hub only). */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ccLine, codexLines, CODEX_SESSION_ID } from './fixtures';

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
