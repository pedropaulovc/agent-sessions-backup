import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSession, readSession } from '../src/auth/session';

const testEnv = env as unknown as Env;
const VIEWER_HOST = 'sessions.vza.net';
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SIGNING_KEY = bytesToBase64Url(KEY_BYTES);

interface TestEnvelope {
  version: number;
  claims: {
    issuer: string;
    audience: string;
    environment: string;
    user: string;
    issuedAt: number;
    expiresAt: number;
    sessionId: string;
  };
  signature: string;
}

function productionEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...testEnv,
    ENVIRONMENT: 'production',
    VIEWER_HOST,
    PRODUCTION_SESSION_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  };
}

function sessionRequest(token: string, host = VIEWER_HOST): Request {
  return new Request(`https://${host}/`, { headers: { cookie: `__Host-session=${token}` } });
}

async function mint(): Promise<{ token: string; envelope: TestEnvelope; environment: Env }> {
  const environment = productionEnv();
  const cookie = await createSession(environment);
  const token = cookie.match(/__Host-session=([^;]+)/)?.[1];
  if (!token) throw new Error('createSession did not return a session token');
  const raw = await environment.KV.get(`sess:${token}`);
  if (!raw) throw new Error('createSession did not persist its envelope');
  return { token, envelope: JSON.parse(raw) as TestEnvelope, environment };
}

async function resign(envelope: TestEnvelope): Promise<void> {
  const key = await crypto.subtle.importKey('raw', KEY_BYTES, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const authenticated = new TextEncoder().encode(JSON.stringify({ version: envelope.version, claims: envelope.claims }));
  envelope.signature = bytesToBase64Url(await crypto.subtle.sign('HMAC', key, authenticated));
}

function bytesToBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('production viewer session envelopes', () => {
  it('accepts a valid versioned production record with all authorization claims', async () => {
    const { token, envelope, environment } = await mint();

    expect(envelope).toMatchObject({
      version: 1,
      claims: {
        issuer: 'https://sessions.vza.net',
        audience: VIEWER_HOST,
        environment: 'production',
        user: 'owner',
        sessionId: token,
      },
    });
    expect(envelope.claims.expiresAt).toBeGreaterThan(envelope.claims.issuedAt);
    expect(await readSession(sessionRequest(token), environment)).toEqual({
      user: 'owner',
      created: envelope.claims.issuedAt,
    });
  });

  it('rejects unsigned envelopes and legacy records with no backward-compatibility path', async () => {
    const { token, envelope, environment } = await mint();
    await environment.KV.put(`sess:${token}`, JSON.stringify({ version: envelope.version, claims: envelope.claims }));
    expect(await readSession(sessionRequest(token), environment)).toBeNull();

    await environment.KV.put(`sess:${token}`, JSON.stringify({ user: 'owner', created: Date.now() }));
    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('rejects a modified authenticated record', async () => {
    const { token, envelope, environment } = await mint();
    envelope.claims.user = 'attacker';
    await environment.KV.put(`sess:${token}`, JSON.stringify(envelope));

    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('rejects malformed JSON and malformed envelope schemas', async () => {
    const { token, envelope, environment } = await mint();
    await environment.KV.put(`sess:${token}`, '{not-json');
    expect(await readSession(sessionRequest(token), environment)).toBeNull();

    await environment.KV.put(`sess:${token}`, JSON.stringify({ ...envelope, unexpected: true }));
    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('rejects a correctly signed expired record even when KV still retains it', async () => {
    const { token, envelope, environment } = await mint();
    envelope.claims.issuedAt = Date.now() - 120_000;
    envelope.claims.expiresAt = Date.now() - 60_000;
    await resign(envelope);
    await environment.KV.put(`sess:${token}`, JSON.stringify(envelope));

    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('rejects a wrong request host and a correctly signed wrong audience', async () => {
    const { token, envelope, environment } = await mint();
    expect(await readSession(sessionRequest(token, 'other.sessions.vza.net'), environment)).toBeNull();

    envelope.claims.audience = 'other.sessions.vza.net';
    await resign(envelope);
    await environment.KV.put(`sess:${token}`, JSON.stringify(envelope));
    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('rejects a correctly signed record claiming the wrong environment', async () => {
    const { token, envelope, environment } = await mint();
    envelope.claims.environment = 'preview';
    await resign(envelope);
    await environment.KV.put(`sess:${token}`, JSON.stringify(envelope));

    expect(await readSession(sessionRequest(token), environment)).toBeNull();
  });

  it('fails closed when the dedicated production signing key is absent or different', async () => {
    const { token, environment } = await mint();
    expect(
      await readSession(sessionRequest(token), productionEnv({ PRODUCTION_SESSION_SIGNING_KEY: undefined })),
    ).toBeNull();
    expect(
      await readSession(
        sessionRequest(token),
        productionEnv({ PRODUCTION_SESSION_SIGNING_KEY: bytesToBase64Url(new Uint8Array(32).fill(255)) }),
      ),
    ).toBeNull();
  });

  it('rejects preview-to-production and production-to-preview replay', async () => {
    const { token, envelope, environment } = await mint();

    const previewEnvelope = structuredClone(envelope);
    previewEnvelope.claims.environment = 'preview';
    await resign(previewEnvelope);
    await environment.KV.put(`sess:${token}`, JSON.stringify(previewEnvelope));
    expect(await readSession(sessionRequest(token), environment)).toBeNull();

    await environment.KV.put(`sess:${token}`, JSON.stringify(envelope));
    const storageThatMustNotBeRead = {
      get: () => {
        throw new Error('preview attempted to read production session storage');
      },
    } as unknown as KVNamespace;
    expect(
      await readSession(sessionRequest(token), productionEnv({ ENVIRONMENT: 'preview', KV: storageThatMustNotBeRead })),
    ).toBeNull();
  });
});
