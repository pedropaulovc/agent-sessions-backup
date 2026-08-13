import { env, SELF } from 'cloudflare:test';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { describe, expect, it } from 'vitest';
import { grantIdentity, readGrantApiRoute, readGrantBrowserRoute } from '../src/auth/read-grants';
import { viewerRoute } from '../src/viewer/router';
import type { WebAuthnDeps } from '../src/auth/webauthn';

const testEnv = env as unknown as Env;
const VIEWER = 'https://sessions.vza.net';
const API = 'https://api.sessions.vza.net';
const encoder = new TextEncoder();

const okDeps = {
  verifyAuthentication: async () => ({ verified: true, authenticationInfo: { newCounter: 7 } }),
} as unknown as WebAuthnDeps;

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mirrors grantTokenHash in read-grants.ts, so tests can seed reachable rows. */
async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`read-grant-token\0${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return { verifier, challenge };
}

function post(path: string, body: unknown, origin = VIEWER): Request {
  return new Request(`${VIEWER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body ?? {}),
  });
}

async function browserCall(request: Request, deps?: WebAuthnDeps, environment?: Env): Promise<Response> {
  const response = await readGrantBrowserRoute(request, new URL(request.url), environment ?? testEnv, deps);
  expect(response).not.toBeNull();
  return response!;
}

async function seedCredential(credentialId: string): Promise<void> {
  await testEnv.DB.prepare(
    'INSERT INTO credentials (credential_id, user_id, public_key, counter) VALUES (?1, ?2, ?3, 0)',
  ).bind(credentialId, 'owner', new Uint8Array([1, 2, 3, 4])).run();
}

/** Serialized assertion whose clientDataJSON echoes the given challenge. */
function fakeAssertion(challenge: string, credentialId: string): Record<string, unknown> {
  const stub = isoBase64URL.fromUTF8String('stub');
  return {
    id: credentialId,
    rawId: stub,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: isoBase64URL.fromUTF8String(JSON.stringify({ type: 'webauthn.get', challenge, origin: VIEWER })),
      authenticatorData: stub,
      signature: stub,
    },
  };
}

interface GrantParams { challenge: string; callback: string; label: string; ttl: number }

function grantParams(challenge: string, overrides: Partial<GrantParams> = {}): GrantParams {
  return { challenge, callback: 'http://127.0.0.1:43210/cb', label: 'claude on amet', ttl: 3600, ...overrides };
}

/** Drive the page's ceremony: options -> fake passkey assertion -> verify -> single-use code. */
async function approveGrant(params: GrantParams, credentialId: string): Promise<string> {
  const optionsResponse = await browserCall(post('/grant/options', params));
  expect(optionsResponse.status).toBe(200);
  const options = await optionsResponse.json() as { challenge: string };
  const verifyResponse = await browserCall(
    post('/grant/verify', { ...params, response: fakeAssertion(options.challenge, credentialId) }), okDeps,
  );
  expect(verifyResponse.status).toBe(200);
  const { code } = await verifyResponse.json() as { code: string };
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return code;
}

async function exchange(code: string, codeVerifier: string): Promise<Response> {
  const url = new URL('/api/v1/grants/exchange', API);
  const request = new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, codeVerifier }),
  });
  const response = await readGrantApiRoute(request, url, testEnv);
  expect(response).not.toBeNull();
  return response!;
}

function bearerRequest(path: string, token: string, method = 'GET'): Promise<Response> {
  return SELF.fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
}

describe('passkey-minted read grants', () => {
  it('mints a read bearer through the full PKCE ceremony and serves the read allow-list', async () => {
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const { verifier, challenge } = await pkcePair();
    const code = await approveGrant(grantParams(challenge), credentialId);

    const exchanged = await exchange(code, verifier);
    expect(exchanged.status).toBe(200);
    const grant = await exchanged.json() as { token: string; tokenType: string; label: string; expiresAt: number };
    expect(grant.token).toMatch(/^agsr_[A-Za-z0-9_-]{43}$/);
    expect(grant.tokenType).toBe('bearer');
    expect(grant.label).toBe('claude on amet');
    expect(grant.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(grant.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    // Replayed code is consumed.
    const replayed = await exchange(code, verifier);
    expect(replayed.status).toBe(400);
    await expect(replayed.json()).resolves.toEqual({ error: 'bad_code' });

    // The bearer reads sessions, search, usage, machines, and the identity echo.
    for (const path of ['/api/v1/sessions', '/api/v1/search?q=x', '/api/v1/usage', '/api/v1/machines']) {
      const response = await bearerRequest(path, grant.token);
      expect(response.status, path).toBe(200);
    }
    const status = await bearerRequest('/api/v1/status', grant.token);
    expect(status.status).toBe(200);
    const statusPayload = await status.json() as { identity: unknown; machines: unknown; sessions: unknown };
    expect(statusPayload.identity).toEqual({ kind: 'grant', label: 'claude on amet', expires_at: grant.expiresAt });
    // The fleet-freshness body is the same content-free shape machine callers get —
    // daily reports read staleness from it regardless of credential.
    expect(Array.isArray(statusPayload.machines)).toBe(true);
    expect(statusPayload.sessions).toBeTruthy();
  });

  it('rejects the exchange for a wrong or mismatched PKCE verifier', async () => {
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const { challenge } = await pkcePair();
    const code = await approveGrant(grantParams(challenge), credentialId);
    const wrong = await exchange(code, b64u(crypto.getRandomValues(new Uint8Array(32))));
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toEqual({ error: 'bad_code' });
  });

  it('binds the passkey assertion to every displayed parameter — a tampered ttl fails verification', async () => {
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const { challenge } = await pkcePair();
    const params = grantParams(challenge);
    const optionsResponse = await browserCall(post('/grant/options', params));
    const options = await optionsResponse.json() as { challenge: string };
    const tampered = await browserCall(
      post('/grant/verify', { ...params, ttl: 86_400, response: fakeAssertion(options.challenge, credentialId) }), okDeps,
    );
    expect(tampered.status).toBe(400);
    await expect(tampered.json()).resolves.toEqual({ error: 'bad_challenge' });
  });

  it('never authorizes writes, ingest, bootstrap, cert, or admin routes with a bearer', async () => {
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const { verifier, challenge } = await pkcePair();
    const code = await approveGrant(grantParams(challenge), credentialId);
    const { token } = await (await exchange(code, verifier)).json() as { token: string };

    // Exactly 401 everywhere: each of these must fail the machine-identity gate itself, not
    // 404/405 out of some unrelated route mismatch that would mask a widened grant surface.
    const denied: Array<[string, string]> = [
      ['GET', '/api/v1/bootstrap'],
      ['POST', '/api/v1/heartbeat'],
      ['PUT', '/api/v1/files/some-machine/claude-projects/a.jsonl'],
      ['POST', '/api/v1/certs/renew'],
      ['POST', '/api/v1/admin/reindex'],
      ['POST', '/api/v1/admin/machines'],
    ];
    for (const [method, path] of denied) {
      const response = await bearerRequest(path, token, method);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('revokes a grant from the settings surface and stops honoring its bearer immediately', async () => {
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const { verifier, challenge } = await pkcePair();
    const label = `revocable-${crypto.randomUUID().slice(0, 8)}`;
    const code = await approveGrant(grantParams(challenge, { label }), credentialId);
    const { token } = await (await exchange(code, verifier)).json() as { token: string };

    const row = await testEnv.DB.prepare('SELECT grant_id FROM read_grants WHERE label = ?1').bind(label)
      .first<{ grant_id: string }>();
    expect(row).not.toBeNull();
    const revoked = await browserCall(post(`/grants/${encodeURIComponent(row!.grant_id)}/revoke`, {}));
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: true });

    const identity = await grantIdentity(
      new Request(`${API}/api/v1/sessions`, { headers: { authorization: `Bearer ${token}` } }), testEnv,
    );
    expect(identity).toBeNull();

    const again = await browserCall(post(`/grants/${encodeURIComponent(row!.grant_id)}/revoke`, {}));
    expect(again.status).toBe(404);
  });

  it('rejects expired tokens and expired codes', async () => {
    const now = Date.now();
    const staleToken = `agsr_${'a'.repeat(43)}`;
    await testEnv.DB.prepare(
      'INSERT INTO read_grants (grant_id, token_hash, label, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(`expired-${crypto.randomUUID()}`, await tokenHash(staleToken), 'expired', now - 7_200_000, now - 3_600_000).run();
    const identity = await grantIdentity(
      new Request(`${API}/api/v1/sessions`, { headers: { authorization: `Bearer ${staleToken}` } }), testEnv,
    );
    expect(identity).toBeNull();

    const { verifier, challenge } = await pkcePair();
    const credentialId = `grant-cred-${crypto.randomUUID()}`;
    await seedCredential(credentialId);
    const code = await approveGrant(grantParams(challenge), credentialId);
    await testEnv.DB.prepare('UPDATE read_grant_codes SET expires_at = ?1 WHERE pkce_challenge = ?2')
      .bind(now - 1000, challenge).run();
    const expired = await exchange(code, verifier);
    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toEqual({ error: 'bad_code' });
  });

  it('validates the grant page request: loopback-only callback, charset-restricted label', async () => {
    const { challenge } = await pkcePair();
    const good = await browserCall(new Request(
      `${VIEWER}/grant?challenge=${challenge}&callback=${encodeURIComponent('http://127.0.0.1:43210/cb')}&label=${encodeURIComponent('claude on amet')}&ttl=3600`,
    ));
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('claude on amet');

    const badRequests = [
      `${VIEWER}/grant?challenge=${challenge}&callback=${encodeURIComponent('https://evil.example/cb')}&label=ok`,
      `${VIEWER}/grant?challenge=${challenge}&callback=${encodeURIComponent('http://localhost:1234/cb')}&label=ok`,
      `${VIEWER}/grant?challenge=${challenge}&callback=${encodeURIComponent('http://127.0.0.1:43210/cb')}&label=${encodeURIComponent('<img src=x>')}`,
      `${VIEWER}/grant?challenge=short&callback=${encodeURIComponent('http://127.0.0.1:43210/cb')}&label=ok`,
      `${VIEWER}/grant?challenge=${challenge}&callback=${encodeURIComponent('http://127.0.0.1:43210/cb')}&label=ok&ttl=999999`,
    ];
    for (const bad of badRequests) {
      const response = await browserCall(new Request(bad));
      expect(response.status, bad).toBe(400);
      expect(await response.text()).not.toContain('<img');
    }
  });

  it('is unreachable in preview: no page, no exchange, no bearer', async () => {
    const preview = { ...testEnv, ENVIRONMENT: 'preview' } as Env;
    const { challenge } = await pkcePair();

    const pageUrl = new URL(`/grant?challenge=${challenge}&callback=${encodeURIComponent('http://127.0.0.1:43210/cb')}&label=ok`, VIEWER);
    const page = await viewerRoute(new Request(pageUrl), pageUrl, preview);
    expect(page.status).toBe(401);

    const exchangeUrl = new URL('/api/v1/grants/exchange', API);
    const exchangeResponse = await readGrantApiRoute(
      new Request(exchangeUrl, { method: 'POST', body: '{}' }), exchangeUrl, preview,
    );
    expect(exchangeResponse).toBeNull();

    const identity = await grantIdentity(
      new Request(`${API}/api/v1/sessions`, { headers: { authorization: `Bearer agsr_${'a'.repeat(43)}` } }), preview,
    );
    expect(identity).toBeNull();
  });
});
