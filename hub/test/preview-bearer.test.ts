import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { route } from '../src/router';
import { machineIdentity, PREVIEW_BEARER_MACHINE, PREVIEW_SESSION_COOKIE } from '../src/auth/identity';
import { viewerRoute } from '../src/viewer/router';
import { ccAssistantLine, ccUserLine } from './fixtures';

const testEnv = env as unknown as Env;
const TOKEN = 'T'.repeat(43);
const HOST = 'pr-42-app.agent-sessions-nonproduction.workers.dev';
const SESSION = 'beefbeef-1111-4111-8111-111111111111';
const MACHINE = 'original-prod-machine';

function previewEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...testEnv,
    ENVIRONMENT: 'preview',
    PREVIEW_BEARER: TOKEN,
    API_HOST: HOST,
    VIEWER_HOST: HOST,
    PREVIEW_HEAD_SHA: 'a'.repeat(40),
    PREVIEW_ARTIFACT_DIGEST: 'b'.repeat(64),
    PREVIEW_PR_NUMBER: '42',
    SCHEMA_DIGEST: 'c'.repeat(64),
    ...overrides,
  } as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('preview bearer auth', () => {
  it('resolves the bearer to an admin machine identity; wrong/missing tokens stay anonymous', async () => {
    const environment = previewEnv();
    const authed = await machineIdentity(
      new Request(`https://${HOST}/api/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      environment,
    );
    expect(authed).toMatchObject({ kind: 'machine', machineId: PREVIEW_BEARER_MACHINE, isAdmin: true });

    const headerCases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}x` },
      { cookie: `${PREVIEW_SESSION_COOKIE}=wrong` },
    ];
    for (const headers of headerCases) {
      expect(await machineIdentity(new Request(`https://${HOST}/api/v1/status`, { headers }), environment))
        .toEqual({ kind: 'anonymous' });
    }
  });

  it('serves diagnostics with the bearer and 401s without', async () => {
    const environment = previewEnv();
    const denied = await route(new Request(`https://${HOST}/api/v1/preview/diagnostics`), environment, ctx);
    expect(denied.status).toBe(401);

    const ok = await route(
      new Request(`https://${HOST}/api/v1/preview/diagnostics`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      environment,
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      headSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
      prNumber: 42,
      schemaDigest: 'c'.repeat(64),
    });
  });

  it('routes non-API paths to the viewer on the single preview hostname (no host-wide API catch)', async () => {
    const environment = previewEnv();
    // Without auth the viewer answers its own 401 — not the API's JSON — proving dispatch by path.
    const res = await route(new Request(`https://${HOST}/machines`), environment, ctx);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  });

  it('mints the session cookie from /?token=… and accepts the cookie for viewer pages', async () => {
    const environment = previewEnv();
    const url = new URL(`https://${HOST}/?token=${TOKEN}`);
    const minted = await viewerRoute(new Request(url.toString()), url, environment);
    expect(minted.status).toBe(302);
    expect(minted.headers.get('location')).toBe('/');
    const setCookie = minted.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PREVIEW_SESSION_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');

    const wrongUrl = new URL(`https://${HOST}/?token=nope`);
    const rejected = await viewerRoute(new Request(wrongUrl.toString()), wrongUrl, environment);
    expect(rejected.status).toBe(401);

    const pageUrl = new URL(`https://${HOST}/machines`);
    const page = await viewerRoute(
      new Request(pageUrl.toString(), { headers: { cookie: `${PREVIEW_SESSION_COOKIE}=${TOKEN}` } }),
      pageUrl,
      environment,
    );
    expect(page.status).toBe(200);
  });

  it('accepts a collector-path upload for a machine this preview never enrolled (hand-carried zip)', async () => {
    const environment = previewEnv();
    const relpath = `-home-tester-src-carried/${SESSION}.jsonl`;
    const content = `${[
      ccUserLine({ uuid: 'c-u1', text: 'carried question' }),
      ccAssistantLine({ uuid: 'c-a1', parentUuid: 'c-u1', text: 'carried answer' }),
    ].join('\n')}\n`;
    const body = new TextEncoder().encode(content);
    const put = await route(
      new Request(`https://${HOST}/api/v1/files/${MACHINE}/claude-projects/${encodeURIComponent(relpath)}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-content-hash': `sha256:${await sha256Hex(body)}`,
          'x-file-mtime': '2026-07-01T12:00:00Z',
          'content-length': String(body.length),
        },
        body,
      }),
      environment,
      ctx,
    );
    expect(put.status).toBe(201);

    // The machines row was auto-created so the files FK held.
    const machineRow = await testEnv.DB.prepare('SELECT machine_id FROM machines WHERE machine_id = ?1')
      .bind(MACHINE)
      .first<{ machine_id: string }>();
    expect(machineRow?.machine_id).toBe(MACHINE);

    // Drain the parse queue under the preview env and confirm the session indexed.
    const pending = await testEnv.DB.prepare(
      "SELECT id, r2_key FROM files WHERE parse_state = 'pending' AND machine_id = ?1",
    ).bind(MACHINE).all<{ id: number; r2_key: string }>();
    const messages = pending.results.map((r) => ({
      id: String(r.id),
      timestamp: new Date(),
      attempts: 1,
      body: { file_id: r.id, r2_key: r.r2_key, reason: 'upload' as const },
      ack() {},
      retry() {},
    }));
    await worker.queue(
      { queue: 'parse', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<ParseMessage>,
      environment,
    );
    const session = await route(
      new Request(`https://${HOST}/api/v1/sessions/${SESSION}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      environment,
      ctx,
    );
    expect(session.status).toBe(200);
    const parsed = await session.json() as { meta: { index_state: string } };
    expect(parsed.meta.index_state).toBe('ready');
  });

  it('production and development ignore the preview bearer entirely', async () => {
    for (const environment of ['production', 'development'] as const) {
      const identity = await machineIdentity(
        new Request('https://api.sessions.vza.net/api/v1/status', { headers: { authorization: `Bearer ${TOKEN}` } }),
        { ...testEnv, ENVIRONMENT: environment, PREVIEW_BEARER: TOKEN } as Env,
      );
      expect(identity).toEqual({ kind: 'anonymous' });
    }
  });
});
