import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareOAuthUnavailable,
  cloudflareClientCertificateRequest,
  cloudflareOAuthStatus,
  completeCloudflareOAuth,
  disconnectCloudflareOAuth,
  startCloudflareOAuth,
} from '../src/auth/cloudflare-oauth';
import { route } from '../src/router';

const testEnv = env as unknown as Env;
const grantedScope = 'ssl-and-certificates.write offline_access';

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: 'oauth-access',
    refresh_token: 'oauth-refresh',
    expires_in: 3600,
    scope: grantedScope,
    ...overrides,
  });
}

async function authorizationUrl(): Promise<URL> {
  const response = await startCloudflareOAuth(testEnv);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorization_url: string };
  return new URL(body.authorization_url);
}

async function authorize(overrides: Record<string, unknown> = {}): Promise<void> {
  const url = await authorizationUrl();
  vi.stubGlobal('fetch', vi.fn(async () => tokenResponse(overrides)));
  const callback = new URL('https://sessions.vza.net/oauth/cloudflare/callback');
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', url.searchParams.get('state')!);
  expect((await completeCloudflareOAuth(callback, testEnv)).status).toBe(200);
}

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  await disconnectCloudflareOAuth(testEnv);
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare OAuth broker', () => {
  it('creates a five-minute Authorization Code + PKCE request with the exact managed-CA scope', async () => {
    const url = await authorizationUrl();
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('test-oauth-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://sessions.vza.net/oauth/cloudflare/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(grantedScope);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exchanges a one-use callback without a client secret and stores only broker-visible status', async () => {
    const authorizeUrl = await authorizationUrl();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_id')).toBe('test-oauth-client');
      expect(form.get('client_secret')).toBeNull();
      expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
      return tokenResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const callback = new URL('https://sessions.vza.net/oauth/cloudflare/callback');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
    const connected = await completeCloudflareOAuth(callback, testEnv);
    expect(connected.status).toBe(200);
    expect(await connected.text()).not.toContain('oauth-access');
    const status = await cloudflareOAuthStatus(testEnv);
    expect(await status.json()).toMatchObject({ authorization: 'authorized', scopes: expect.arrayContaining(['ssl-and-certificates.write']) });

    const replay = await completeCloudflareOAuth(callback, testEnv);
    expect(replay.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a token response that omits the managed-CA permission', async () => {
    const url = await authorizationUrl();
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ scope: 'offline_access' })));
    const callback = new URL('https://sessions.vza.net/oauth/cloudflare/callback');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', url.searchParams.get('state')!);
    expect((await completeCloudflareOAuth(callback, testEnv)).status).toBe(502);
    expect(await (await cloudflareOAuthStatus(testEnv)).json()).toEqual({ authorization: 'missing' });
  });

  it('proxies only the configured zone and never returns its bearer credential', async () => {
    await authorize();
    const certId = '2544a51d-fc9e-47f0-966e-2a789155ade0';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        `https://api.cloudflare.com/client/v4/zones/6a56cdda4766c1d7b5ad0fbe8331048f/client_certificates/${certId}`,
      );
      expect(request.headers.get('authorization')).toBe('Bearer oauth-access');
      return Response.json({ success: true, result: { id: certId, status: 'active' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await cloudflareClientCertificateRequest(testEnv, { kind: 'get', cert_id: certId });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('oauth-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent refreshes and persists a rotated refresh token before CA calls', async () => {
    await authorize({ expires_in: 1 });
    let refreshes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://dash.cloudflare.com/oauth2/token') {
        refreshes++;
        return tokenResponse({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh' });
      }
      return Response.json({ success: true, result: { status: 'active' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      cloudflareClientCertificateRequest(testEnv, { kind: 'get', cert_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      cloudflareClientCertificateRequest(testEnv, { kind: 'get', cert_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    expect(refreshes).toBe(1);
  });

  it('marks invalid_grant as reauthorization-required and fails closed', async () => {
    await authorize({ expires_in: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    await expect(cloudflareClientCertificateRequest(testEnv, { kind: 'get', cert_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }))
      .rejects.toEqual(expect.objectContaining<Partial<CloudflareOAuthUnavailable>>({ reason: 'reauthorization_required' }));
    expect(await (await cloudflareOAuthStatus(testEnv)).json()).toMatchObject({ authorization: 'reauthorization_required' });
  });
});

describe('Cloudflare OAuth routes', () => {
  it('allows only a current admin certificate to begin authorization', async () => {
    const adminFp = 'a'.repeat(64);
    await testEnv.DB.prepare(
      `INSERT INTO machines (machine_id, os, cert_fp_sha256, is_admin)
       VALUES ('oauth-route-admin', 'windows', ?1, 1)
       ON CONFLICT (machine_id) DO UPDATE SET cert_fp_sha256 = ?1, is_admin = 1`,
    ).bind(adminFp).run();
    const current = new Request('https://api.sessions.vza.net/api/v1/admin/cloudflare-oauth/start', {
      method: 'POST',
      cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: adminFp } },
    } as unknown as RequestInit);
    expect((await route(current, testEnv, {} as ExecutionContext)).status).toBe(200);

    const anonymous = new Request('https://api.sessions.vza.net/api/v1/admin/cloudflare-oauth/start', { method: 'POST' });
    expect((await route(anonymous, testEnv, {} as ExecutionContext)).status).toBe(401);
  });

  it('accepts the browser callback only on the viewer hostname', async () => {
    const viewer = new Request('https://sessions.vza.net/oauth/cloudflare/callback?code=x&state=wrong');
    expect((await route(viewer, testEnv, {} as ExecutionContext)).status).toBe(400);
    const api = new Request('https://api.sessions.vza.net/oauth/cloudflare/callback?code=x&state=wrong');
    expect((await route(api, testEnv, {} as ExecutionContext)).status).toBe(401);
  });
});
