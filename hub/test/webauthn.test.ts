import { env, SELF } from 'cloudflare:test';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, sessionToken } from '../src/auth/session';
import { webauthnRoute, type WebAuthnDeps } from '../src/auth/webauthn';
import { viewerRoute } from '../src/viewer/router';

const testEnv = env as unknown as Env;
const VIEWER = 'https://sessions.vza.net';
const SETUP = 'test-setup-token'; // matches vitest.config.ts binding

// Mocked crypto seams: exercise every endpoint (challenge/KV/DB/session wiring) without
// a real authenticator. Production wires the genuine SimpleWebAuthn verifiers.
const okDeps = {
  verifyRegistration: async () => ({
    verified: true,
    registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] } },
  }),
  verifyAuthentication: async () => ({ verified: true, authenticationInfo: { newCounter: 7 } }),
} as unknown as WebAuthnDeps;

function post(path: string, body: unknown, origin = VIEWER, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin };
  if (cookie) headers.cookie = cookie;
  return new Request(`${VIEWER}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

/** Build a serialized WebAuthn response whose clientDataJSON carries the given challenge. */
function fakeResponse(challenge: string, type: 'webauthn.create' | 'webauthn.get'): Record<string, unknown> {
  const clientDataJSON = isoBase64URL.fromUTF8String(JSON.stringify({ type, challenge, origin: VIEWER }));
  const stub = isoBase64URL.fromUTF8String('stub');
  return type === 'webauthn.create'
    ? { id: 'cred-1', rawId: stub, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject: stub } }
    : { id: 'cred-1', rawId: stub, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: stub, signature: stub } };
}

async function call(request: Request, deps?: WebAuthnDeps): Promise<Response> {
  const res = await webauthnRoute(request, new URL(request.url), testEnv, deps);
  expect(res).not.toBeNull();
  return res!;
}

async function insertCredential(id = 'existing-1'): Promise<void> {
  await testEnv.DB.prepare(
    'INSERT INTO credentials (credential_id, user_id, public_key, counter) VALUES (?1, ?2, ?3, 0)',
  )
    .bind(id, 'owner', new Uint8Array([9, 9, 9]))
    .run();
}

describe('passkey auth', () => {
  // Storage persists across tests in a file; each case controls its own credential count.
  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM credentials').run();
  });

  it('bootstraps the first passkey with the SETUP_TOKEN when zero credentials exist', async () => {
    const optRes = await call(post('/webauthn/register/options', { setup: SETUP }));
    expect(optRes.status).toBe(200);
    const options = (await optRes.json()) as { challenge: string };
    expect(options.challenge).toBeTruthy();

    const verifyRes = await call(post('/webauthn/register/verify', fakeResponse(options.challenge, 'webauthn.create')), okDeps);
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({ verified: true });

    const row = await testEnv.DB.prepare('SELECT credential_id, counter FROM credentials WHERE credential_id = ?1')
      .bind('cred-1')
      .first<{ credential_id: string; counter: number }>();
    expect(row?.credential_id).toBe('cred-1');
  });

  it('rejects register/options with a wrong setup token', async () => {
    const res = await call(post('/webauthn/register/options', { setup: 'nope' }));
    expect(res.status).toBe(403);
  });

  it('kills the SETUP_TOKEN path once any credential exists (403 without a session)', async () => {
    await insertCredential();
    const res = await call(post('/webauthn/register/options', { setup: SETUP }));
    expect(res.status).toBe(403);
  });

  it('single-uses the challenge (a replayed verify fails)', async () => {
    const optRes = await call(post('/webauthn/register/options', { setup: SETUP }));
    const { challenge } = (await optRes.json()) as { challenge: string };
    const first = await call(post('/webauthn/register/verify', fakeResponse(challenge, 'webauthn.create')), okDeps);
    expect(first.status).toBe(200);
    const replay = await call(post('/webauthn/register/verify', fakeResponse(challenge, 'webauthn.create')), okDeps);
    expect(replay.status).toBe(400);
  });

  it('authenticates, issues a __Host-session cookie, and the gated page loads with it', async () => {
    await insertCredential('cred-1');

    const optRes = await call(post('/webauthn/auth/options', {}));
    const { challenge } = (await optRes.json()) as { challenge: string };
    const verifyRes = await call(post('/webauthn/auth/verify', fakeResponse(challenge, 'webauthn.get')), okDeps);
    expect(verifyRes.status).toBe(200);

    const setCookie = verifyRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    // counter advanced to the verifier's newCounter
    const row = await testEnv.DB.prepare('SELECT counter FROM credentials WHERE credential_id = ?1').bind('cred-1').first<{ counter: number }>();
    expect(row?.counter).toBe(7);

    const token = setCookie.match(/__Host-session=([^;]+)/)![1]!;
    const preview = { ...testEnv, ENVIRONMENT: 'preview' } as Env;
    const gated = await viewerRoute(
      new Request(`${VIEWER}/`, { headers: { cookie: `__Host-session=${token}` } }),
      new URL(`${VIEWER}/`),
      preview,
    );
    expect(gated.status).toBe(200);
  });

  it('redirects the gated page to /login without a session cookie', async () => {
    const preview = { ...testEnv, ENVIRONMENT: 'preview' } as Env;
    const res = await viewerRoute(new Request(`${VIEWER}/`), new URL(`${VIEWER}/`), preview);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('rejects a state-changing POST whose Origin does not match (CSRF guard)', async () => {
    const res = await call(post('/webauthn/auth/options', {}, 'https://evil.example'));
    expect(res.status).toBe(403);
  });

  it('logout deletes the session and clears the cookie', async () => {
    const cookie = await createSession(testEnv);
    const token = cookie.match(/__Host-session=([^;]+)/)![1]!;
    expect(await testEnv.KV.get(`sess:${token}`)).toBeTruthy();

    const res = await call(post('/logout', {}, VIEWER, `__Host-session=${token}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await testEnv.KV.get(`sess:${token}`)).toBeNull();
    expect(sessionToken(new Request(VIEWER, { headers: { cookie: `__Host-session=${token}` } }))).toBe(token);
  });

  it('login page shows the bootstrap flow only with a valid setup token', async () => {
    const withToken = await call(new Request(`${VIEWER}/login?setup=${SETUP}`, { method: 'GET' }));
    expect(await withToken.text()).toContain('first passkey');

    const withoutToken = await call(new Request(`${VIEWER}/login`, { method: 'GET' }));
    expect(await withoutToken.text()).toContain('Sign in');
  });

  it('serves /login through the full worker in production (auth surface is never gated)', async () => {
    const res = await SELF.fetch(`${VIEWER}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
