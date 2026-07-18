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

  it('format=ndjson streams the COMPLETE filtered set across internal pages, ignoring limit as a total cap', async () => {
    const res = await SELF.fetch(`https://api.sessions.vza.net/api/v1/sessions?machine=${MACHINE}&limit=3&format=ndjson`, {
      headers: { 'x-dev-machine': 'reader' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(7); // NOT capped at limit=3 — that's the whole point of ndjson
    const ids = lines.map((l) => (JSON.parse(l) as { meta: { session_id: string } }).meta.session_id);
    expect(ids).toEqual(EXPECTED_ORDER);
    expect(new Set(ids).size).toBe(7);
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
