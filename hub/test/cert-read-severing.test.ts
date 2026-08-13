import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { route } from '../src/router';

/**
 * "No agent moves prod bytes without my passkey": in production, machine certs are ingest
 * credentials only — session content (/api/v1/sessions*, /api/v1/search) requires a
 * passkey-minted read grant, while the content-free fleet aggregates stay cert-readable.
 * These tests drive route() directly with a production env (the SELF harness runs
 * ENVIRONMENT=development, where cert/dev reads deliberately remain for the local loop).
 */

const testEnv = env as unknown as Env;
const prodEnv = { ...testEnv, ENVIRONMENT: 'production' } as Env;
const ctx = {} as ExecutionContext;
const encoder = new TextEncoder();

function hexfp(label: string): string {
  let h = '';
  for (let i = 0; i < label.length; i++) h += label.charCodeAt(i).toString(16).padStart(2, '0');
  return (h + '0'.repeat(64)).slice(0, 64);
}

async function seedMachine(id: string, fp: string): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO machines (machine_id, os, cert_fp_sha256) VALUES (?1, 'linux', ?2)").bind(id, fp).run();
}

function certReq(path: string, fp: string): Request {
  return new Request(`https://api.sessions.vza.net${path}`, {
    cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fp } },
  } as unknown as RequestInit);
}

/** Mirrors grantTokenHash in read-grants.ts, so tests can seed reachable grant rows. */
async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`read-grant-token\0${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedGrant(token: string): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    'INSERT INTO read_grants (grant_id, token_hash, label, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(`sever-${crypto.randomUUID()}`, await tokenHash(token), 'severing test', now, now + 3_600_000).run();
}

describe('production machine certs cannot read session content', () => {
  const CONTENT_PATHS = [
    '/api/v1/sessions',
    '/api/v1/sessions?format=ndjson',
    '/api/v1/sessions/some-session-id',
    '/api/v1/sessions/some-session-id/raw',
    '/api/v1/search?q=secret',
  ];

  it('every content path returns 403 passkey_grant_required for an enrolled production cert', async () => {
    const fp = hexfp('sever-content');
    await seedMachine('sever-content', fp);
    for (const path of CONTENT_PATHS) {
      const response = await route(certReq(path, fp), prodEnv, ctx);
      expect(response.status, path).toBe(403);
      expect((await response.json<{ error: string }>()).error, path).toBe('passkey_grant_required');
    }
  });

  it('content-free aggregates stay cert-readable in production', async () => {
    const fp = hexfp('sever-aggregates');
    await seedMachine('sever-aggregates', fp);
    for (const path of ['/api/v1/status', '/api/v1/machines', '/api/v1/usage']) {
      const response = await route(certReq(path, fp), prodEnv, ctx);
      expect(response.status, path).toBe(200);
    }
  });

  it('a passkey-minted read grant still reaches session content in production', async () => {
    const token = `agsr_${'g'.repeat(43)}`;
    await seedGrant(token);
    const response = await route(
      new Request('https://api.sessions.vza.net/api/v1/sessions', { headers: { authorization: `Bearer ${token}` } }),
      prodEnv,
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it('an unrecognized ENVIRONMENT severs too (deny-unless-known-exempt)', async () => {
    const fp = hexfp('sever-staging');
    await seedMachine('sever-staging', fp);
    const stagingEnv = { ...testEnv, ENVIRONMENT: 'staging' as Env['ENVIRONMENT'] } as Env;
    // machineIdentity itself fails closed on an unknown ENVIRONMENT, so this lands in the 401
    // branch — the point is that no unknown value can fall into a cert-readable path.
    const response = await route(certReq('/api/v1/sessions', fp), stagingEnv, ctx);
    expect([401, 403]).toContain(response.status);
  });

  it('development keeps machine reads for the local loop', async () => {
    const response = await SELF.fetch('https://api.sessions.vza.net/api/v1/sessions', {
      headers: { 'x-dev-machine': 'dev-reader' },
    });
    expect(response.status).toBe(200);
  });
});
