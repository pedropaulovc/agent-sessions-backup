import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { viewerRoute } from '../src/viewer/router';
import { ccLine, ccLinearSession, TINY_PNG_B64 } from './fixtures';

const testEnv = env as unknown as Env;

const SEARCH_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111';
const BIG_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222';

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function putFile(store: string, relpath: string, content: string): Promise<Response> {
  const body = new TextEncoder().encode(content);
  return SELF.fetch(`https://api.sessions.vza.net/api/v1/files/testbox-wsl/${store}/${encodeURIComponent(relpath)}`, {
    method: 'PUT',
    headers: {
      'x-dev-machine': 'testbox-wsl',
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

// A session with searchable tool output, an inline image, and an abandoned (rewound) branch.
const SEARCH_CONTENT = [
  ccLine(SEARCH_SESSION, { uuid: 'u1', parentUuid: null, role: 'user', text: 'where is the xenondioxide note?' }),
  ccLine(SEARCH_SESSION, { uuid: 'a1', parentUuid: 'u1', role: 'assistant', text: 'searching', toolUse: { id: 'tu1', name: 'Grep', input: { pattern: 'xenondioxide' } } }),
  ccLine(SEARCH_SESSION, { uuid: 'uOld', parentUuid: 'a1', role: 'user', text: 'abandoned branch attempt' }),
  ccLine(SEARCH_SESSION, { uuid: 'aOld', parentUuid: 'uOld', role: 'assistant', text: 'abandoned assistant reply' }),
  ccLine(SEARCH_SESSION, { uuid: 'u2', parentUuid: 'a1', role: 'user', toolResult: { toolUseId: 'tu1', content: 'xenondioxide appears in notes.md line 12' } }),
  ccLine(SEARCH_SESSION, { uuid: 'a2', parentUuid: 'u2', role: 'assistant', text: 'found the reference' }),
  ccLine(SEARCH_SESSION, { uuid: 'uImg', parentUuid: 'a2', role: 'user', image: { mediaType: 'image/png', data: TINY_PNG_B64 } }),
].join('\n');

describe('viewer', () => {
  beforeAll(async () => {
    expect((await putFile('claude-projects', `-home-tester-src-demo/${SEARCH_SESSION}.jsonl`, SEARCH_CONTENT)).status).toBe(201);
    expect((await putFile('claude-projects', `-home-tester-src-demo/${BIG_SESSION}.jsonl`, ccLinearSession(BIG_SESSION, 450))).status).toBe(201);
    await drainQueue();
  });

  it('search page returns 200 with a highlighted snippet and a link to the session', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/?q=xenondioxide');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<mark>');
    expect(html).toContain('xenondioxide');
    expect(html).toContain(`/s/${SEARCH_SESSION}`);
  });

  it('empty query lists recent sessions', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Recent sessions');
    expect(html).toContain(`/s/${BIG_SESSION}`);
  });

  it('session page renders turns with role classes', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('turn user');
    expect(html).toContain('turn assistant');
    expect(html).toContain('found the reference');
    // inline image points at the blob endpoint
    expect(html).toMatch(new RegExp(`/s/${SEARCH_SESSION}/blob/\\d+`));
  });

  it('dims off-main-path (rewound) turns in the chronological view', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}?view=chronological`);
    const html = await res.text();
    expect(html).toContain('rewound');
    expect(html).toContain('abandoned assistant reply');
  });

  it('hides off-main-path turns in the effective view', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}?view=effective`);
    const html = await res.text();
    expect(html).not.toContain('abandoned assistant reply');
    expect(html).toContain('found the reference');
  });

  it('paginates a 450-turn session into 3 pages via byte offsets', async () => {
    const p1 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}`)).text();
    expect(p1).toContain('page 1 / 3');
    expect(p1).toContain('turn number 0 content');
    expect(p1).toContain('turn number 199 content');
    expect(p1).not.toContain('turn number 200 content');

    const p2 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}?page=2`)).text();
    expect(p2).toContain('page 2 / 3');
    expect(p2).toContain('turn number 200 content');
    expect(p2).toContain('turn number 399 content');
    expect(p2).not.toContain('turn number 400 content');

    const p3 = await (await SELF.fetch(`https://sessions.vza.net/s/${BIG_SESSION}?page=3`)).text();
    expect(p3).toContain('page 3 / 3');
    expect(p3).toContain('turn number 449 content');
  });

  it('blob endpoint round-trips a base64 png', async () => {
    const block = await testEnv.DB.prepare("SELECT id FROM blocks WHERE session_id = ?1 AND btype = 'image'")
      .bind(SEARCH_SESSION)
      .first<{ id: number }>();
    expect(block).toBeTruthy();
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/${block!.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const got = new Uint8Array(await res.arrayBuffer());
    const want = Uint8Array.from(atob(TINY_PNG_B64), (c) => c.charCodeAt(0));
    expect([...got]).toEqual([...want]);
  });

  it('blob endpoint 404s for an unknown block', async () => {
    const res = await SELF.fetch(`https://sessions.vza.net/s/${SEARCH_SESSION}/blob/99999999`);
    expect(res.status).toBe(404);
  });

  it('machines page lists the dev machine and corpus totals', async () => {
    const res = await SELF.fetch('https://sessions.vza.net/machines');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('testbox-wsl');
    expect(html).toContain('sessions ·');
  });

  it('returns 403 in production (auth not yet configured)', async () => {
    const url = new URL('https://sessions.vza.net/');
    const res = await viewerRoute(new Request(url.toString()), url, { ENVIRONMENT: 'production' } as Env);
    expect(res.status).toBe(403);
  });
});
