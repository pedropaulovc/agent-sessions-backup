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

// Deps whose crypto step throws, as SimpleWebAuthn does on malformed authenticator data.
const throwingDeps = {
  verifyRegistration: async () => {
    throw new Error('malformed authenticator data');
  },
  verifyAuthentication: async () => {
    throw new Error('malformed authenticator data');
  },
} as unknown as WebAuthnDeps;

/** okDeps whose authentication verifier reports a specific newCounter. */
function authDepsWithCounter(newCounter: number): WebAuthnDeps {
  return {
    verifyRegistration: (okDeps as unknown as { verifyRegistration: unknown }).verifyRegistration,
    verifyAuthentication: async () => ({ verified: true, authenticationInfo: { newCounter } }),
  } as unknown as WebAuthnDeps;
}

/** okDeps that also records the options object each verifier was called with. */
function capturingDeps(): { deps: WebAuthnDeps; calls: { reg?: { requireUserVerification?: boolean }; auth?: { requireUserVerification?: boolean } } } {
  const calls: { reg?: { requireUserVerification?: boolean }; auth?: { requireUserVerification?: boolean } } = {};
  const deps = {
    verifyRegistration: async (opts: { requireUserVerification?: boolean }) => {
      calls.reg = opts;
      return { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] } } };
    },
    verifyAuthentication: async (opts: { requireUserVerification?: boolean }) => {
      calls.auth = opts;
      return { verified: true, authenticationInfo: { newCounter: 7 } };
    },
  } as unknown as WebAuthnDeps;
  return { deps, calls };
}

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
    await testEnv.DB.prepare('DELETE FROM webauthn_challenges').run();
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

  it('rejects a ceremony on a non-viewer host in preview, but allows it on VIEWER_HOST', async () => {
    const preview = { ...testEnv, ENVIRONMENT: 'preview' } as Env;

    // Alternate host (e.g. the workers.dev preview URL): 403, so it can't mint a
    // credential scoped to the wrong rpID and brick setup on the real viewer host.
    const alt = 'https://sessions-hub.workers.dev';
    const altReq = new Request(`${alt}/webauthn/register/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: alt },
      body: JSON.stringify({ setup: SETUP }),
    });
    const altRes = await webauthnRoute(altReq, new URL(altReq.url), preview, okDeps);
    expect(altRes?.status).toBe(403);
    expect(await altRes!.json()).toEqual({ error: 'bad_host' });

    // Same preview env on the pinned viewer host: passes the gate and reaches auth logic.
    const okReq = post('/webauthn/register/options', { setup: SETUP });
    const okRes = await webauthnRoute(okReq, new URL(okReq.url), preview, okDeps);
    expect(okRes?.status).toBe(200);
  });

  it('allows a ceremony on localhost in development (host fallback for wrangler dev)', async () => {
    const local = 'http://localhost:8787';
    const req = new Request(`${local}/webauthn/register/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: local },
      body: JSON.stringify({ setup: SETUP }),
    });
    // testEnv.ENVIRONMENT === 'development'
    const res = await webauthnRoute(req, new URL(req.url), testEnv, okDeps);
    expect(res?.status).toBe(200);
  });

  it('closes the pre-minted-challenge race: a second setup verify is rejected and does not enroll', async () => {
    // Two option calls while the table is empty — both mint valid register challenges.
    const c1 = ((await (await call(post('/webauthn/register/options', { setup: SETUP }))).json()) as { challenge: string }).challenge;
    const c2 = ((await (await call(post('/webauthn/register/options', { setup: SETUP }))).json()) as { challenge: string }).challenge;
    expect(c1).not.toBe(c2);

    const first = await call(post('/webauthn/register/verify', fakeResponse(c1, 'webauthn.create')), okDeps);
    expect(first.status).toBe(200);

    // The second pre-minted challenge is still consumable, but the atomic insert guard
    // (WHERE COUNT(*)=0) refuses to enroll a second unauthenticated credential.
    const second = await call(post('/webauthn/register/verify', fakeResponse(c2, 'webauthn.create')), okDeps);
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: 'setup_disabled' });

    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('returns 400 (not 500) when the registration verifier throws on malformed data', async () => {
    const { challenge } = (await (await call(post('/webauthn/register/options', { setup: SETUP }))).json()) as { challenge: string };
    const res = await call(post('/webauthn/register/verify', fakeResponse(challenge, 'webauthn.create')), throwingDeps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'verification_failed' });
  });

  it('returns 400 (not 500) when the authentication verifier throws on malformed data', async () => {
    await insertCredential('cred-1');
    const { challenge } = (await (await call(post('/webauthn/auth/options', {}))).json()) as { challenge: string };
    const res = await call(post('/webauthn/auth/verify', fakeResponse(challenge, 'webauthn.get')), throwingDeps);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'verification_failed' });
  });

  it('returns 400 (not 500) when a verify body is not valid JSON — both endpoints', async () => {
    for (const path of ['/webauthn/register/verify', '/webauthn/auth/verify']) {
      const req = new Request(`${VIEWER}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: VIEWER },
        body: 'not json at all {',
      });
      const res = await call(req, okDeps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('returns 400 (not 500) when clientDataJSON is not decodable — both endpoints', async () => {
    // Structurally valid JSON, but clientDataJSON is not base64url-of-JSON, so the
    // challenge extraction throws before any verifier runs.
    const bad = {
      id: 'cred-1',
      rawId: 'AA',
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: '@@@not-base64@@@', attestationObject: 'AA', authenticatorData: 'AA', signature: 'AA' },
    };
    for (const path of ['/webauthn/register/verify', '/webauthn/auth/verify']) {
      const res = await call(post(path, bad), okDeps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('returns 400 when clientDataJSON decodes to JSON without a string challenge — both endpoints', async () => {
    // Structurally valid, decodable clientDataJSON of `{}`: challengeOf returns undefined,
    // which must not reach D1 .bind(...) as an undefined value (that would 500).
    const emptyClientData = isoBase64URL.fromUTF8String(JSON.stringify({}));
    const stub = isoBase64URL.fromUTF8String('stub');
    const body = {
      id: 'cred-1',
      rawId: stub,
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: emptyClientData, attestationObject: stub, authenticatorData: stub, signature: stub },
    };
    for (const path of ['/webauthn/register/verify', '/webauthn/auth/verify']) {
      const res = await call(post(path, body), okDeps);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('rejects an auth verify with a missing credential id and does NOT consume the challenge', async () => {
    await insertCredential('cred-1');
    const { challenge } = (await (await call(post('/webauthn/auth/options', {}))).json()) as { challenge: string };

    // Valid challenge, but no `id` → 400 before consumeChallenge / the credentials query.
    const noId = fakeResponse(challenge, 'webauthn.get');
    delete (noId as { id?: unknown }).id;
    const bad = await call(post('/webauthn/auth/verify', noId), okDeps);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });

    // The same challenge still verifies → the failed request left it unconsumed.
    const good = await call(post('/webauthn/auth/verify', fakeResponse(challenge, 'webauthn.get')), okDeps);
    expect(good.status).toBe(200);
  });

  it('keeps the stored counter monotonic (a lower newCounter cannot regress it)', async () => {
    await insertCredential('cred-1'); // starts at counter 0

    const c1 = ((await (await call(post('/webauthn/auth/options', {}))).json()) as { challenge: string }).challenge;
    const r1 = await call(post('/webauthn/auth/verify', fakeResponse(c1, 'webauthn.get')), authDepsWithCounter(5));
    expect(r1.status).toBe(200);

    // A later ceremony that commits a LOWER newCounter (out-of-order concurrent logins).
    const c2 = ((await (await call(post('/webauthn/auth/options', {}))).json()) as { challenge: string }).challenge;
    const r2 = await call(post('/webauthn/auth/verify', fakeResponse(c2, 'webauthn.get')), authDepsWithCounter(3));
    expect(r2.status).toBe(200); // login still succeeds; the counter update is simply a no-op

    const row = await testEnv.DB.prepare('SELECT counter FROM credentials WHERE credential_id = ?1')
      .bind('cred-1')
      .first<{ counter: number }>();
    expect(row?.counter).toBe(5);
  });

  it('single-uses an auth challenge in D1 (a replayed verify fails)', async () => {
    await insertCredential('cred-1');
    const { challenge } = (await (await call(post('/webauthn/auth/options', {}))).json()) as { challenge: string };
    const first = await call(post('/webauthn/auth/verify', fakeResponse(challenge, 'webauthn.get')), okDeps);
    expect(first.status).toBe(200);
    const replay = await call(post('/webauthn/auth/verify', fakeResponse(challenge, 'webauthn.get')), okDeps);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'bad_challenge' });
  });

  it('requires user verification in both options and enforces it in both verifiers', async () => {
    const regOpt = (await (await call(post('/webauthn/register/options', { setup: SETUP }))).json()) as {
      challenge: string;
      authenticatorSelection?: { userVerification?: string };
    };
    expect(regOpt.authenticatorSelection?.userVerification).toBe('required');

    const cap = capturingDeps();
    const rv = await call(post('/webauthn/register/verify', fakeResponse(regOpt.challenge, 'webauthn.create')), cap.deps);
    expect(rv.status).toBe(200);
    expect(cap.calls.reg?.requireUserVerification).toBe(true);

    const authOpt = (await (await call(post('/webauthn/auth/options', {}))).json()) as {
      challenge: string;
      userVerification?: string;
    };
    expect(authOpt.userVerification).toBe('required');
    const av = await call(post('/webauthn/auth/verify', fakeResponse(authOpt.challenge, 'webauthn.get')), cap.deps);
    expect(av.status).toBe(200);
    expect(cap.calls.auth?.requireUserVerification).toBe(true);
  });
});
