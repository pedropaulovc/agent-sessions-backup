import { env } from 'cloudflare:test';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { beforeEach, describe, expect, it } from 'vitest';
import { type WebAuthnDeps } from '../src/auth/webauthn';
import { ppeRoute } from '../src/ppe';

const testEnv = env as unknown as Env;
const PPE = 'https://sessions.ppe.vza.net';
const SEED = 's'.repeat(48);
const SETUP = 'test-setup-token';

const okDeps = {
  verifyRegistration: async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: 'ppe-cred', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
    },
  }),
  verifyAuthentication: async () => ({ verified: true, authenticationInfo: { newCounter: 7 } }),
} as unknown as WebAuthnDeps;

const ppeEnv = {
  ...testEnv,
  ENVIRONMENT: 'ppe',
  VIEWER_HOST: 'sessions.ppe.vza.net',
  PPE_VIEWER_HOST: 'sessions.ppe.vza.net',
  SETUP_TOKEN: SETUP,
  PREVIEW_BEARER_SEED: SEED,
} as Env;

function post(path: string, body: unknown, origin = PPE): Request {
  return new Request(`${PPE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

function fakeResponse(challenge: string, type: 'webauthn.create' | 'webauthn.get', id = 'ppe-cred'): Record<string, unknown> {
  const clientDataJSON = isoBase64URL.fromUTF8String(JSON.stringify({ type, challenge, origin: PPE }));
  const stub = isoBase64URL.fromUTF8String('stub');
  return type === 'webauthn.create'
    ? { id, rawId: stub, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject: stub } }
    : { id, rawId: stub, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: stub, signature: stub } };
}

async function call(request: Request, deps = okDeps): Promise<Response> {
  return ppeRoute(request, ppeEnv, deps);
}

async function expectedLocation(pr: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SEED),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`sessions-preview-bearer:pr-${pr}`),
  ));
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  const token = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `https://pr-${pr}.sessions-ppe.workers.dev/?token=${token}`;
}

async function insertCredential(): Promise<void> {
  await testEnv.DB.prepare(
    'INSERT INTO credentials (credential_id, user_id, public_key, counter) VALUES (?1, ?2, ?3, 0)',
  ).bind('ppe-cred', 'owner', new Uint8Array([9, 9, 9])).run();
}

describe('shared PPE passkey redirect', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM credentials').run();
    await testEnv.DB.prepare('DELETE FROM webauthn_challenges').run();
    await testEnv.DB.prepare('DELETE FROM passkey_freshness_challenges').run();
  });

  it('serves the PR page only for a positive, safe PR id', async () => {
    const page = await call(new Request(`${PPE}/pr?id=42`));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Open preview PR 42');
    expect(html).not.toContain(SEED);
    expect(page.headers.get('cache-control')).toBe('no-store');
    for (const target of ['/pr', '/pr?id=0', '/pr?id=01', '/pr?id=42&id=43', `/pr?id=${Number.MAX_SAFE_INTEGER + 1}`]) {
      const response = await call(new Request(`${PPE}${target}`));
      expect(response.status, target).toBe(400);
      expect(await response.json()).toEqual({ error: 'bad_pr' });
    }
  });

  it('rejects the shared page and ceremonies on another host', async () => {
    const response = await ppeRoute(new Request('https://evil.example/pr?id=42'), ppeEnv, okDeps);
    expect(response.status).toBe(404);
  });

  it('registers the first PPE passkey through the setup link', async () => {
    const page = await call(new Request(`${PPE}/register?setup=${SETUP}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Register a PPE passkey');

    const optionsResponse = await call(post('/webauthn/register/options', { setup: SETUP }));
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json() as { challenge: string };
    const verifyResponse = await call(post('/webauthn/register/verify', fakeResponse(options.challenge, 'webauthn.create')));
    expect(verifyResponse.status).toBe(200);
    expect(await verifyResponse.json()).toEqual({ verified: true });
  });

  it('verifies the passkey and returns only the selected PR bearer URL', async () => {
    await insertCredential();
    const optionsResponse = await call(post('/pr/auth/options', { pr: '42' }));
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json() as { challenge: string };

    const response = await call(post('/pr/auth/verify', {
      pr: '42',
      response: fakeResponse(options.challenge, 'webauthn.get'),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ location: await expectedLocation(42) });
  });

  it('does not allow a PR-bound challenge to be replayed or used for another PR', async () => {
    await insertCredential();
    const optionsResponse = await call(post('/pr/auth/options', { pr: '42' }));
    const options = await optionsResponse.json() as { challenge: string };
    const response = fakeResponse(options.challenge, 'webauthn.get');

    const wrongPr = await call(post('/pr/auth/verify', { pr: '43', response }));
    expect(wrongPr.status).toBe(400);
    expect(await wrongPr.json()).toEqual({ error: 'bad_challenge' });

    const valid = await call(post('/pr/auth/verify', { pr: '42', response }));
    expect(valid.status).toBe(200);
    const replay = await call(post('/pr/auth/verify', { pr: '42', response }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'bad_challenge' });
  });

  it('fails closed when the PPE Worker has no bearer seed', async () => {
    const unconfigured = { ...ppeEnv, PREVIEW_BEARER_SEED: undefined } as Env;
    const response = await ppeRoute(post('/pr/auth/options', { pr: '42' }), unconfigured, okDeps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'preview_unconfigured' });
  });
});
