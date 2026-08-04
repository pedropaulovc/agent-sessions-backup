import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineIdentity, previewHumanIdentity, requirePreviewOrigin } from '../src/auth/identity';
import { previewDiagnostics } from '../src/router';
import { viewerRoute } from '../src/viewer/router';

const ISSUER = 'https://preview-control.sessions.vza.net';
const PR = 42;
const HEAD = 'a'.repeat(40);
const GENERATION = 'g123-aaaaaaaaaaaa';
const ARTIFACT = 'd'.repeat(64);
const AUD = {
  browser: 'urn:sessions:preview:browser:v1',
  action: 'urn:sessions:preview:action:v1',
  origin: 'urn:sessions:preview:origin:v1',
};
const testEnv = env as unknown as Env;
let browserKeys: CryptoKeyPair;
let actionKeys: CryptoKeyPair;
let originKeys: CryptoKeyPair;
let browserJwk: JsonWebKey;
let actionJwk: JsonWebKey;
let originJwk: JsonWebKey;

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64json(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function keyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

async function sign(key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const input = `${b64json({ alg: 'RS256', typ: 'JWT', kid })}.${b64json(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

function previewEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    ...testEnv,
    ENVIRONMENT: 'preview',
    PREVIEW_ASSERTION_ISSUER: ISSUER,
    PREVIEW_PR_NUMBER: String(PR),
    PREVIEW_HEAD_SHA: HEAD,
    PREVIEW_GENERATION: GENERATION,
    PREVIEW_ARTIFACT_DIGEST: ARTIFACT,
    SCHEMA_DIGEST: 'e'.repeat(64),
    PREVIEW_BROWSER_ASSERTION_JWKS: JSON.stringify({ keys: [{ ...browserJwk, kid: 'browser-1' }] }),
    PREVIEW_ACTION_ASSERTION_JWKS: JSON.stringify({ keys: [{ ...actionJwk, kid: 'action-1' }] }),
    PREVIEW_ORIGIN_ASSERTION_JWKS: JSON.stringify({ keys: [{ ...originJwk, kid: 'origin-1' }] }),
    ...overrides,
  } as unknown as Env;
}

function baseClaims(kind: keyof typeof AUD, target: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER, aud: AUD[kind], exp: now + 45, iat: now, jti: `${kind}-${crypto.randomUUID()}`,
    pr: PR, head: HEAD, generation: GENERATION, method: 'GET', target,
    ...(kind === 'origin' ? { artifactDigest: ARTIFACT } : {}),
    ...overrides,
  };
}

async function sha256Hex(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  [browserKeys, actionKeys, originKeys] = await Promise.all([keyPair(), keyPair(), keyPair()]);
  browserJwk = await crypto.subtle.exportKey('jwk', browserKeys.publicKey) as JsonWebKey;
  actionJwk = await crypto.subtle.exportKey('jwk', actionKeys.publicKey) as JsonWebKey;
  originJwk = await crypto.subtle.exportKey('jwk', originKeys.publicKey) as JsonWebKey;
});

beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM meta WHERE key LIKE 'edge_assertion:%'").run();
});

describe('preview edge assertions', () => {
  it('accepts a signed browser assertion as a human viewer identity', async () => {
    const token = await sign(browserKeys.privateKey, 'browser-1', {
      ...baseClaims('browser', '/'), identity: 'human', actor: 'reviewer@example.test',
    });
    const request = new Request('https://candidate.preview.workers.dev/', {
      headers: { 'x-preview-browser-assertion': token },
    });
    expect(await previewHumanIdentity(request, previewEnv())).toEqual({ kind: 'human', actor: 'reviewer@example.test' });
  });

  it('routes the viewer only for a signed human assertion', async () => {
    const token = await sign(browserKeys.privateKey, 'browser-1', {
      ...baseClaims('browser', '/'), identity: 'human', actor: 'reviewer@example.test',
    });
    const url = new URL('https://candidate.preview.workers.dev/');
    const accepted = await viewerRoute(new Request(url, { headers: { 'x-preview-browser-assertion': token } }), url, previewEnv());
    expect(accepted.status).toBe(200);
    const deniedUrl = new URL('/login', url);
    const denied = await viewerRoute(new Request(deniedUrl), deniedUrl, previewEnv());
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(denied.headers.get('location')).toBeNull();
    expect(await denied.text()).toBe('unauthorized');
  });

  it('does not expose or mutate the passkey surface for an authenticated preview viewer', async () => {
    for (const path of ['/login', '/settings']) {
      const token = await sign(browserKeys.privateKey, 'browser-1', {
        ...baseClaims('browser', path),
        identity: 'human',
        actor: 'reviewer@example.test',
      });
      const url = new URL(`https://candidate.preview.workers.dev${path}`);
      const response = await viewerRoute(
        new Request(url, { headers: { 'x-preview-browser-assertion': token } }),
        url,
        previewEnv(),
      );
      expect(response.status).toBe(404);
    }

    const path = '/webauthn/auth/options';
    const body = '{}';
    const token = await sign(browserKeys.privateKey, 'browser-1', {
      ...baseClaims('browser', path, { method: 'POST', bodyDigest: await sha256Hex(body) }),
      identity: 'human',
      actor: 'reviewer@example.test',
    });
    const before = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').first<{ n: number }>();
    const url = new URL(`https://candidate.preview.workers.dev${path}`);
    const response = await viewerRoute(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-preview-browser-assertion': token,
        },
        body,
      }),
      url,
      previewEnv(),
    );
    const after = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').first<{ n: number }>();
    expect(response.status).toBe(404);
    expect(after?.n).toBe(before?.n);
  });

  it('rejects cross-audience and cross-key assertions', async () => {
    const crossAudience = await sign(browserKeys.privateKey, 'browser-1', {
      ...baseClaims('browser', '/'), aud: AUD.action, identity: 'human', actor: 'reviewer@example.test',
    });
    expect(await previewHumanIdentity(new Request('https://candidate.preview.workers.dev/', {
      headers: { 'x-preview-browser-assertion': crossAudience },
    }), previewEnv())).toEqual({ kind: 'anonymous' });

    const crossKey = await sign(actionKeys.privateKey, 'action-1', {
      ...baseClaims('browser', '/'), identity: 'human', actor: 'reviewer@example.test',
    });
    expect(await previewHumanIdentity(new Request('https://candidate.preview.workers.dev/', {
      headers: { 'x-preview-browser-assertion': crossKey },
    }), previewEnv())).toEqual({ kind: 'anonymous' });
  });

  it('consumes assertion jti once and rejects expiry and revoked keys', async () => {
    const claims = { ...baseClaims('browser', '/'), identity: 'human', actor: 'reviewer@example.test' };
    const token = await sign(browserKeys.privateKey, 'browser-1', claims);
    const request = new Request('https://candidate.preview.workers.dev/', { headers: { 'x-preview-browser-assertion': token } });
    expect((await previewHumanIdentity(request, previewEnv())).kind).toBe('human');
    expect(await previewHumanIdentity(request, previewEnv())).toEqual({ kind: 'anonymous' });

    const now = Math.floor(Date.now() / 1000);
    const expired = await sign(browserKeys.privateKey, 'browser-1', {
      ...claims, jti: 'expired', iat: now - 50, exp: now - 1,
    });
    expect(await previewHumanIdentity(new Request('https://candidate.preview.workers.dev/', {
      headers: { 'x-preview-browser-assertion': expired },
    }), previewEnv())).toEqual({ kind: 'anonymous' });

    const revokedEnv = previewEnv({
      PREVIEW_BROWSER_ASSERTION_JWKS: JSON.stringify({ keys: [{ ...browserJwk, kid: 'browser-1', revoked: true }] }),
    });
    const revoked = await sign(browserKeys.privateKey, 'browser-1', { ...claims, jti: 'revoked' });
    expect(await previewHumanIdentity(new Request('https://candidate.preview.workers.dev/', {
      headers: { 'x-preview-browser-assertion': revoked },
    }), revokedEnv)).toEqual({ kind: 'anonymous' });
  });

  it('binds method, full request target, and mutation body digest', async () => {
    const body = '{"fixture":true}';
    const digest = await sha256Hex(body);
    const claims = {
      ...baseClaims('action', '/api/v1/files/test/raw/file.json?uploads=1', {
        method: 'PUT', bodyDigest: digest, identity: 'machine', actor: 'ci', machineId: 'seed', isAdmin: true,
      }),
    };
    const token = await sign(actionKeys.privateKey, 'action-1', claims);
    const request = (target: string, value: string) => new Request(`https://candidate.preview.workers.dev${target}`, {
      method: 'PUT', body: value, headers: { 'x-preview-action-assertion': token },
    });
    expect(await machineIdentity(request(claims.target, body), previewEnv())).toMatchObject({
      kind: 'machine', machineId: 'seed', isAdmin: true, actor: 'ci',
    });

    const targetToken = await sign(actionKeys.privateKey, 'action-1', { ...claims, jti: 'wrong-target-check' });
    const wrongTarget = new Request('https://candidate.preview.workers.dev/api/v1/files/test/raw/file.json?uploads=2', {
      method: 'PUT', body, headers: { 'x-preview-action-assertion': targetToken },
    });
    expect(await machineIdentity(wrongTarget, previewEnv())).toEqual({ kind: 'anonymous' });

    const bodyToken = await sign(actionKeys.privateKey, 'action-1', { ...claims, jti: 'wrong-body-check' });
    expect(await machineIdentity(new Request(`https://candidate.preview.workers.dev${claims.target}`, {
      method: 'PUT', body: '{"fixture":false}', headers: { 'x-preview-action-assertion': bodyToken },
    }), previewEnv())).toEqual({ kind: 'anonymous' });
  });

  it('hashes one mutating body once when origin and action assertions share a request', async () => {
    const target = '/api/v1/files/seed/raw/large.bin';
    const body = 'the same body is covered by both assertions';
    const bodyDigest = await sha256Hex(body);
    const origin = await sign(originKeys.privateKey, 'origin-1', baseClaims('origin', target, {
      method: 'PUT',
      bodyDigest,
    }));
    const action = await sign(actionKeys.privateKey, 'action-1', baseClaims('action', target, {
      method: 'PUT',
      bodyDigest,
      identity: 'machine',
      actor: 'ci',
      machineId: 'seed',
      isAdmin: false,
    }));
    const request = new Request(`https://candidate.preview.workers.dev${target}`, {
      method: 'PUT',
      body,
      headers: {
        'x-preview-origin-assertion': origin,
        'x-preview-action-assertion': action,
      },
    });
    const clone = vi.spyOn(request, 'clone');
    expect(await requirePreviewOrigin(request, previewEnv())).toBe(true);
    expect(await machineIdentity(request, previewEnv())).toMatchObject({
      kind: 'machine',
      machineId: 'seed',
    });
    expect(clone).toHaveBeenCalledOnce();
  });

  it('requires a generation/artifact-bound origin assertion in preview', async () => {
    const token = await sign(originKeys.privateKey, 'origin-1', baseClaims('origin', '/healthz'));
    const request = new Request('https://candidate.preview.workers.dev/healthz', {
      headers: { 'x-preview-origin-assertion': token },
    });
    expect(await requirePreviewOrigin(request, previewEnv())).toBe(true);
    expect(await requirePreviewOrigin(new Request('https://candidate.preview.workers.dev/healthz'), previewEnv())).toBe(false);
    expect(await requirePreviewOrigin(request, previewEnv({ PREVIEW_ARTIFACT_DIGEST: 'e'.repeat(64) }))).toBe(false);
  });

  it('exposes preview diagnostics only to an exact signed action assertion', async () => {
    const target = '/api/v1/preview/diagnostics';
    const token = await sign(actionKeys.privateKey, 'action-1', {
      ...baseClaims('action', target),
      identity: 'machine', actor: 'ci', machineId: 'smoke', isAdmin: false,
    });
    const request = (assertion?: string) => new Request(`https://candidate.preview.workers.dev${target}`, {
      headers: assertion ? { 'x-preview-action-assertion': assertion } : {},
    });
    const accepted = await previewDiagnostics(request(token), previewEnv());
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toEqual({
      headSha: HEAD,
      artifactDigest: ARTIFACT,
      generation: GENERATION,
      schemaDigest: 'e'.repeat(64),
    });

    expect((await previewDiagnostics(request(), previewEnv())).status).toBe(401);
    const wrongTarget = await sign(actionKeys.privateKey, 'action-1', {
      ...baseClaims('action', '/api/v1/preview/other'),
      identity: 'machine', actor: 'ci', machineId: 'smoke', isAdmin: false,
    });
    expect((await previewDiagnostics(request(wrongTarget), previewEnv())).status).toBe(401);
    expect((await previewDiagnostics(request(token), {
      ...previewEnv(), ENVIRONMENT: 'production',
    } as Env)).status).toBe(404);
    expect((await previewDiagnostics(request(await sign(actionKeys.privateKey, 'action-1', {
      ...baseClaims('action', target),
      identity: 'machine', actor: 'ci', machineId: 'smoke-2', isAdmin: false,
    })), previewEnv({ SCHEMA_DIGEST: undefined }))).status).toBe(503);
  });

  it('production ignores all preview assertions', async () => {
    const browser = await sign(browserKeys.privateKey, 'browser-1', {
      ...baseClaims('browser', '/'), identity: 'human', actor: 'reviewer@example.test',
    });
    const action = await sign(actionKeys.privateKey, 'action-1', {
      ...baseClaims('action', '/'), identity: 'machine', actor: 'ci', machineId: 'seed', isAdmin: true,
    });
    const request = new Request('https://sessions.vza.net/', { headers: {
      'x-preview-browser-assertion': browser, 'x-preview-action-assertion': action,
      'x-preview-origin-assertion': await sign(originKeys.privateKey, 'origin-1', baseClaims('origin', '/')),
    } });
    const production = { ...previewEnv(), ENVIRONMENT: 'production' } as Env;
    expect(await requirePreviewOrigin(request, production)).toBe(true);
    expect(await previewHumanIdentity(request, production)).toEqual({ kind: 'anonymous' });
    expect(await machineIdentity(request, production)).toEqual({ kind: 'anonymous' });
  });
});
