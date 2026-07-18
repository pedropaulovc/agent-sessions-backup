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

function reqWithCert(tlsClientAuth: Record<string, string>): Request {
  return new Request('https://api.sessions.vza.net/api/v1/status', {
    cf: { tlsClientAuth },
  } as unknown as RequestInit);
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

  it('fails closed on an unrecognized ENVIRONMENT value, even with a dev header (an un-configured deploy must not accidentally grant admin)', async () => {
    const identity = await machineIdentity(
      reqWith({ 'x-dev-machine': 'staging-box' }),
      envWith({ ENVIRONMENT: 'staging' as Env['ENVIRONMENT'] }),
    );
    expect(identity).toEqual({ kind: 'anonymous' });
  });

  it('fails closed when ENVIRONMENT is missing entirely, even with a dev header (the checked-in wrangler.jsonc default must not be admin-open)', async () => {
    const env = envWith({});
    delete (env as { ENVIRONMENT?: string }).ENVIRONMENT;
    const identity = await machineIdentity(reqWith({ 'x-dev-machine': 'unconfigured-box' }), env);
    expect(identity).toEqual({ kind: 'anonymous' });
  });

  it('rejects a verified-but-REVOKED cert even when its fingerprint is enrolled', async () => {
    const fp = 'aa11revoketestfingerprint';
    await testEnv.DB.prepare(
      `INSERT INTO machines (machine_id, os, cert_fp_sha256, is_admin) VALUES ('revoked-box', 'linux', ?1, 1)
       ON CONFLICT (machine_id) DO UPDATE SET cert_fp_sha256 = excluded.cert_fp_sha256`,
    )
      .bind(fp)
      .run();
    const prod = envWith({ ENVIRONMENT: 'production' });

    // Positive control: the same enrolled cert, NOT revoked, authenticates as the machine —
    // proving the cf.tlsClientAuth path is reached and the fingerprint maps.
    const ok = await machineIdentity(reqWithCert({ certVerified: 'SUCCESS', certFingerprintSHA256: fp }), prod);
    // certFp echoes the authenticating fingerprint (threaded through for the certs/renew CAS).
    expect(ok).toEqual({ kind: 'machine', machineId: 'revoked-box', isAdmin: true, certFp: fp });

    // The fix: certVerified stays 'SUCCESS' for a revoked cert, so without the certRevoked
    // check the still-enrolled row would keep authenticating. It must fall through to anonymous.
    // '1' is Cloudflare's documented revoked value; 'true' is accepted too (doc-drift belt).
    const revoked1 = await machineIdentity(
      reqWithCert({ certVerified: 'SUCCESS', certRevoked: '1', certFingerprintSHA256: fp }),
      prod,
    );
    expect(revoked1).toEqual({ kind: 'anonymous' });
    const revokedTrue = await machineIdentity(
      reqWithCert({ certVerified: 'SUCCESS', certRevoked: 'true', certFingerprintSHA256: fp }),
      prod,
    );
    expect(revokedTrue).toEqual({ kind: 'anonymous' });
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
