import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
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
