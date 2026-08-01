import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSplittable, splitStatements, MIGRATE_OIDC_AUDIENCE } from '../src/api/migrate';

/** The preview migration endpoint. The interesting tests here are the ones that FORGE tokens:
 * this route deliberately bypasses mTLS, so its OIDC verification is the only thing between a
 * caller and the preview database. */

const testEnv = env as unknown as Env & { MIGRATE_OIDC_REPOSITORY?: string; ENVIRONMENT: string };
const REPO = 'pedropaulovc/agent-sessions-backup';

/** A throwaway RSA keypair standing in for GitHub's signing key. */
async function makeKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { pair, jwk };
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signJwt(
  key: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'test-key', typ: 'JWT' },
): Promise<string> {
  const body = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(body) as BufferSource,
  );
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

function goodClaims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://token.actions.githubusercontent.com',
    aud: MIGRATE_OIDC_AUDIENCE,
    sub: `repo:${REPO}:ref:refs/heads/main`,
    repository: REPO,
    repository_owner: 'pedropaulovc',
    ref: 'refs/heads/main',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    ...over,
  };
}

let keys: Awaited<ReturnType<typeof makeKeys>>;

/** Serve our test JWKS in place of GitHub's. */
function stubJwks(jwk: JsonWebKey, kid = 'test-key'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('token.actions.githubusercontent.com')) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

async function post(token: string | null, migrations: Array<{ name: string; sql: string }>): Promise<Response> {
  return SELF.fetch('https://api.sessions.vza.net/api/v1/admin/migrate', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ migrations }),
  });
}

beforeEach(async () => {
  keys = await makeKeys();
  stubJwks(keys.jwk);
  testEnv.ENVIRONMENT = 'preview';
  testEnv.MIGRATE_OIDC_REPOSITORY = REPO;
  await testEnv.DB.prepare('DROP TABLE IF EXISTS migrate_probe').run();
  await testEnv.DB.prepare('DELETE FROM d1_migrations WHERE name LIKE ?1').bind('9999_%').run().catch(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  testEnv.ENVIRONMENT = 'development';
});

const PROBE = { name: '9999_probe.sql', sql: 'CREATE TABLE migrate_probe (id INTEGER PRIMARY KEY);' };

describe('preview migration endpoint: rejection', () => {
  it('404s outside the preview environment, before looking at the token', async () => {
    testEnv.ENVIRONMENT = 'production';
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    expect((await post(token, [PROBE])).status).toBe(404);
  });

  it('401s without a token', async () => {
    expect((await post(null, [PROBE])).status).toBe(401);
  });

  it('rejects a token signed by the wrong key', async () => {
    const attacker = await makeKeys();
    const token = await signJwt(attacker.pair.privateKey, goodClaims());
    const res = await post(token, [PROBE]);
    expect(res.status).toBe(401);
    expect((await res.json() as { reason: string }).reason).toBe('bad_signature');
  });

  it('rejects alg=none, the classic JWT bypass', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims(), { alg: 'none', kid: 'test-key' });
    expect((await (await post(token, [PROBE])).json() as { reason: string }).reason).toBe('unexpected_alg');
  });

  it('rejects a token minted by a different repository', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims({ repository: 'attacker/evil' }));
    expect((await (await post(token, [PROBE])).json() as { reason: string }).reason).toBe('bad_repository');
  });

  it('rejects a token minted for a different audience', async () => {
    // The same repo can mint tokens for any audience; without this check a token intended for
    // some other service would be replayable here.
    const token = await signJwt(keys.pair.privateKey, goodClaims({ aud: 'some-other-service' }));
    expect((await (await post(token, [PROBE])).json() as { reason: string }).reason).toBe('bad_audience');
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(keys.pair.privateKey, goodClaims({ exp: now - 1, nbf: now - 100 }));
    expect((await (await post(token, [PROBE])).json() as { reason: string }).reason).toBe('expired');
  });

  it('rejects a wrong issuer even when everything else lines up', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims({ iss: 'https://evil.example/' }));
    expect((await (await post(token, [PROBE])).json() as { reason: string }).reason).toBe('bad_issuer');
  });

  it('does not run when the repository allowlist is unset', async () => {
    testEnv.MIGRATE_OIDC_REPOSITORY = undefined;
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    expect((await post(token, [PROBE])).status).toBe(503);
  });
});

describe('preview migration endpoint: application', () => {
  it('applies a pending migration and records it', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const res = await post(token, [PROBE]);
    expect(res.status).toBe(200);
    expect((await res.json() as { applied: string[] }).applied).toEqual([PROBE.name]);

    const tbl = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrate_probe'",
    ).first();
    expect(tbl).toBeTruthy();
  });

  it('is idempotent — a second run skips what is already recorded', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    await post(token, [PROBE]);
    const again = await post(await signJwt(keys.pair.privateKey, goodClaims()), [PROBE]);
    const body = (await again.json()) as { applied: string[]; skipped: string[] };
    expect(body.applied).toEqual([]);
    expect(body.skipped).toEqual([PROBE.name]);
  });

  it('refuses a migration its splitter cannot handle, before applying anything', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const res = await post(token, [
      PROBE,
      { name: '9999_trigger.sql', sql: 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;' },
    ]);
    expect(res.status).toBe(422);
    // The whole batch is rejected: a half-applied set leaves a schema no migration file describes.
    const tbl = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='migrate_probe'",
    ).first();
    expect(tbl, 'the valid migration was applied despite the batch being rejected').toBeFalsy();
  });
});

describe('statement splitting', () => {
  it('splits plain DDL and drops comments', () => {
    expect(splitStatements('-- a comment\nCREATE TABLE a (x INT);\nCREATE INDEX i ON a (x);\n')).toEqual([
      'CREATE TABLE a (x INT)',
      'CREATE INDEX i ON a (x)',
    ]);
  });

  it('flags constructs it would tear in half', () => {
    expect(assertSplittable('m', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;')).toContain('trigger');
    expect(assertSplittable('m', "INSERT INTO a VALUES ('x;y');")).toContain('quoted literal');
    expect(assertSplittable('m', 'CREATE TABLE a (x INT);')).toBeNull();
  });

  it('accepts every migration this repo actually ships', async () => {
    // The splitter's simplicity is only safe while this holds; assert it rather than assume it.
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> })
      .glob('../migrations/*.sql', { query: '?raw', import: 'default', eager: true });
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(10);
    for (const [name, sql] of Object.entries(files)) {
      expect(assertSplittable(name, sql), `${name} is not splittable`).toBeNull();
    }
  });
});
