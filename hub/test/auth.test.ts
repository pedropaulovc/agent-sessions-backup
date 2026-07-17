import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { machineIdentity } from '../src/auth/identity';

const testEnv = env as unknown as Env;

function envWith(overrides: Partial<Env>): Env {
  return { ...testEnv, ...overrides };
}

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://api.sessions.vza.net/api/v1/status', { headers });
}

describe('machineIdentity', () => {
  it('development: trusts x-dev-machine with no bearer required', async () => {
    const identity = await machineIdentity(reqWith({ 'x-dev-machine': 'devbox' }), envWith({ ENVIRONMENT: 'development' }));
    expect(identity).toEqual({ kind: 'machine', machineId: 'devbox', isAdmin: true });
  });

  it('preview: denies x-dev-machine without a bearer token (would otherwise be unauthenticated admin on a public URL)', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'previewbox' }),
      envWith({ ENVIRONMENT: 'preview', DEV_AUTH: 'shh' }),
    );
    expect(identity).toEqual({ kind: 'anonymous' });
  });

  it('preview: denies x-dev-machine with a wrong bearer token', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'previewbox', authorization: 'Bearer wrong' }),
      envWith({ ENVIRONMENT: 'preview', DEV_AUTH: 'shh' }),
    );
    expect(identity).toEqual({ kind: 'anonymous' });
  });

  it('preview: denies even a correct bearer if DEV_AUTH is unset', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'previewbox', authorization: 'Bearer shh' }),
      envWith({ ENVIRONMENT: 'preview', DEV_AUTH: undefined }),
    );
    expect(identity).toEqual({ kind: 'anonymous' });
  });

  it('preview: accepts x-dev-machine with the correct bearer token', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'previewbox', authorization: 'Bearer shh' }),
      envWith({ ENVIRONMENT: 'preview', DEV_AUTH: 'shh' }),
    );
    expect(identity).toEqual({ kind: 'machine', machineId: 'previewbox', isAdmin: true });
  });

  it('production: never trusts x-dev-machine, bearer or not (mTLS only)', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'prodbox', authorization: 'Bearer anything' }),
      envWith({ ENVIRONMENT: 'production', DEV_AUTH: 'anything' }),
    );
    expect(identity).toEqual({ kind: 'anonymous' });
  });
});

describe('preview auth over HTTP', () => {
  it('401s x-dev-machine without a bearer', async () => {
    const original = testEnv.ENVIRONMENT;
    testEnv.ENVIRONMENT = 'preview';
    testEnv.DEV_AUTH = 'preview-secret';
    try {
      const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/status', {
        headers: { 'x-dev-machine': 'previewbox-http' },
      });
      expect(res.status).toBe(401);
    } finally {
      testEnv.ENVIRONMENT = original;
    }
  });

  it('200s x-dev-machine with the correct bearer', async () => {
    const original = testEnv.ENVIRONMENT;
    testEnv.ENVIRONMENT = 'preview';
    testEnv.DEV_AUTH = 'preview-secret';
    try {
      const res = await SELF.fetch('https://api.sessions.vza.net/api/v1/status', {
        headers: { 'x-dev-machine': 'previewbox-http', authorization: 'Bearer preview-secret' },
      });
      expect(res.status).toBe(200);
    } finally {
      testEnv.ENVIRONMENT = original;
    }
  });
});
