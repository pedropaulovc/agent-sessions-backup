import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSplittable,
  splitStatements,
  MIGRATE_OIDC_AUDIENCE,
  PREVIEW_MARKER_TABLE,
  PREVIEW_MARKER_VALUE,
} from '../src/api/migrate';

/** Stand in for the out-of-band seeding a human does once against the real preview database. */
async function seedPreviewMarker(value: string = PREVIEW_MARKER_VALUE): Promise<void> {
  await testEnv.DB.prepare(`CREATE TABLE IF NOT EXISTS ${PREVIEW_MARKER_TABLE} (value TEXT NOT NULL)`).run();
  await testEnv.DB.prepare(`DELETE FROM ${PREVIEW_MARKER_TABLE}`).run();
  await testEnv.DB.prepare(`INSERT INTO ${PREVIEW_MARKER_TABLE} (value) VALUES (?1)`).bind(value).run();
}

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
  await seedPreviewMarker();
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
    // A semicolon inside a literal used to be REFUSED because the splitter would have torn the
    // statement in half. The splitter is now quote-aware, so this is valid input, not a hazard —
    // see the 'statement splitting' block below for the assertion that it splits correctly.
    expect(assertSplittable('m', "INSERT INTO a VALUES ('x;y');")).toBeNull();
    expect(assertSplittable('m', "INSERT INTO a VALUES ('unterminated);")).toContain('unterminated quote');
    expect(assertSplittable('m', 'CREATE TABLE a (x INT);')).toBeNull();
  });

  it('accepts every migration this repo actually ships', async () => {
    // The splitter's simplicity is only safe while this holds; assert it rather than assume it.
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> })
      .glob('../migrations/*.sql', { query: '?raw', import: 'default', eager: true });
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(10);
    // Guard the test's own premise: if no migration still contains a `--`-leading literal, the
    // check below is vacuous and someone should be told rather than reassured.
    expect(
      Object.values(files).filter((sql) => /'--[^'\n]*'/.test(sql)).length,
      'no migration contains a --literal; this test no longer proves anything',
    ).toBeGreaterThan(0);
    for (const [name, sql] of Object.entries(files)) {
      expect(assertSplittable(name, sql), `${name} is not splittable`).toBeNull();
      // Quote-COUNT alone is not enough either: 0011 has two `'--…'` literals, so the naive
      // strip ate one quote from each and the total stayed even while the SQL was still mangled.
      // Assert the literals themselves survive the round trip.
      const rejoined = splitStatements(sql).join('\n');
      for (const literal of sql.match(/'--[^'\n]*'/g) ?? []) {
        expect(rejoined, `${name}: splitter destroyed the literal ${literal}`).toContain(literal);
      }
      // assertSplittable alone passed VACUOUSLY against the naive splitter: its comment strip
      // deleted `'--claude-worktrees-'` (migrations 0011/0012) along with the rest of the line, so
      // there was no literal left to object to — while splitStatements produced a truncated,
      // unbalanced statement. Checking the emitted statements is what actually catches that.
      for (const stmt of splitStatements(sql)) {
        expect((stmt.match(/'/g) ?? []).length % 2, `${name}: torn statement: ${stmt.slice(0, 80)}`).toBe(0);
      }
    }
  });
});

describe('statement splitting', () => {
  it('does not split or truncate on -- inside a quoted literal', () => {
    // Verbatim from migrations 0011/0012. A naive /--.*$/ strip cuts the line at the literal's
    // own dashes and leaves an unbalanced quote.
    const sql = `CREATE VIEW v AS SELECT instr(lower(cwd), '--claude-worktrees-') AS w FROM sessions;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("'--claude-worktrees-'");
    expect(assertSplittable('0011', sql)).toBe(null);
  });

  it('does not split on a semicolon inside a quoted literal', () => {
    const out = splitStatements(`INSERT INTO t (a, b) VALUES ('x;y', 1); INSERT INTO t (a) VALUES ('z');`);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'x;y'");
  });

  it("treats '' as an escaped quote, not a close-then-open", () => {
    const out = splitStatements(`INSERT INTO t (a) VALUES ('it''s; fine'); SELECT 1;`);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'it''s; fine'");
  });

  it('strips block comments, including their semicolons', () => {
    // Valid SQLite that wrangler applies fine. Leaving the comment intact makes its semicolon a
    // statement boundary and emits two invalid fragments.
    const out = splitStatements('CREATE TABLE a(x); /* rationale; details */ CREATE INDEX i ON a(x);');
    expect(out).toHaveLength(2);
    expect(out[1]).toBe('CREATE INDEX i ON a(x)');
    expect(out.join(' ')).not.toContain('rationale');
  });

  it('does not treat /* inside a literal as a block comment', () => {
    const out = splitStatements("INSERT INTO t (a) VALUES ('/* not a comment; */'); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'/* not a comment; */'");
  });

  it('does not split on a semicolon inside a quoted IDENTIFIER', () => {
    // Valid SQLite that wrangler applies fine. A scanner tracking only '…' tears each of these
    // into two invalid fragments, and a quote-parity check on ' alone cannot notice.
    for (const ddl of [
      'CREATE TABLE "audit;log" (id INT);',
      'CREATE TABLE `audit;log` (id INT);',
      'CREATE TABLE [audit;log] (id INT);',
    ]) {
      expect(splitStatements(ddl), ddl).toHaveLength(1);
      expect(assertSplittable('m', ddl), ddl).toBe(null);
    }
  });

  it('does not treat -- inside a quoted identifier as a comment', () => {
    const sql = 'CREATE TABLE "audit--log" (id INT);';
    expect(splitStatements(sql)[0]).toContain('"audit--log"');
  });

  it('flags an unterminated identifier, not just an unterminated literal', () => {
    expect(assertSplittable('m', 'CREATE TABLE "audit (id INT);')).toContain('unterminated');
  });

  it('still strips real comments', () => {
    expect(splitStatements("-- leading\nSELECT 1; -- trailing\nSELECT 2;")).toEqual(['SELECT 1', 'SELECT 2']);
  });

});

describe('bound-database check', () => {
  // The binding lives in hub/wrangler.jsonc, which a PR controls, and Workers Builds builds the
  // branch preview from the PR's own checkout — so a PR can point env.preview at the PRODUCTION
  // database id (it is committed in that same file) and reach production through this endpoint.
  // The binding is therefore NOT the isolation control; this check is.
  it('refuses when the bound database cannot prove it is the preview one', async () => {
    await testEnv.DB.prepare(`DROP TABLE IF EXISTS ${PREVIEW_MARKER_TABLE}`).run();
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const res = await post(token, [{ name: '9999_probe', sql: 'CREATE TABLE migrate_probe (a INT);' }]);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('not_preview_database');
  });

  it('refuses when the marker exists but names a different database', async () => {
    await seedPreviewMarker('sessions-index');
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const res = await post(token, [{ name: '9999_probe', sql: 'CREATE TABLE migrate_probe (a INT);' }]);
    expect(res.status).toBe(409);
  });

  it('authenticates BEFORE touching D1 at all', async () => {
    // This route has no mTLS and its workers.dev preview alias is publicly reachable. Running the
    // marker query first let any unauthenticated POST force a query against the shared preview
    // database, so a trivial flood could burn its quota and degrade every branch preview.
    await testEnv.DB.prepare(`DROP TABLE IF EXISTS ${PREVIEW_MARKER_TABLE}`).run();
    await testEnv.DB.prepare('DROP TABLE IF EXISTS migrate_probe').run();
    const res = await post('not-even-a-jwt', [{ name: '9999_probe', sql: 'CREATE TABLE migrate_probe (a INT);' }]);
    // 401, not 409: with the marker table absent, a 409 would prove the marker query ran for an
    // unauthenticated caller. Getting 401 is what shows it did not.
    expect(res.status).toBe(401);
    const probe = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'migrate_probe'")
      .first()
      .catch(() => null);
    expect(probe).toBe(null);
  });

  it('returns a JSON error envelope when D1 rejects the SQL, not a bare 500', () => {
    // CI classifies a response with no JSON `error` key as "preview not deployed yet" and retries
    // then passes. An uncaught batch rejection becomes Cloudflare's bodiless platform 500, so a
    // deterministic SQL failure would exit the job green with the schema stale.
    return (async () => {
      const token = await signJwt(keys.pair.privateKey, goodClaims());
      const res = await post(token, [
        { name: '9999_broken', sql: 'ALTER TABLE table_that_does_not_exist ADD COLUMN x INT;' },
      ]);
      expect(res.status).toBe(500);
      const body = await res.json<{ error: string; migration: string }>();
      expect(body.error).toBe('migration_failed');
      expect(body.migration).toBe('9999_broken');
      // The workflow's classifier keys off exactly this.
      expect(Object.keys(body)).toContain('error');
    })();
  });

  it('does not record a migration that failed to apply', async () => {
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    await post(token, [{ name: '9999_broken', sql: 'ALTER TABLE table_that_does_not_exist ADD COLUMN x INT;' }]);
    const row = await testEnv.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?1')
      .bind('9999_broken')
      .first()
      .catch(() => null);
    expect(row).toBe(null);
  });

  it('reports a name already recorded as skipped rather than replaying its DDL', async () => {
    // HONEST SCOPE. Two things I checked and want recorded, because both cut against the obvious
    // test. (1) The end-to-end race is not reproducible here: overlapping requests via Promise.all
    // still serialize inside the isolate, so the second one's snapshot already has the first's row
    // and it takes the ordinary skip path — that test passed against the unfixed code. (2) D1's
    // batch is transactional regardless of statement order, so putting the bookkeeping INSERT
    // first does NOT change rollback behaviour; a duplicate aborts the batch either way.
    //
    // So the load-bearing part of the fix is the catch branch: on a failed batch, re-read
    // d1_migrations and report `skipped` if the name is now present, instead of returning
    // migration_failed and reddening the check. That is what this asserts.
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const sql = 'CREATE TABLE migrate_probe (a INT);';
    expect((await post(token, [{ name: '9999_race', sql }])).status).toBe(200);
    const second = await post(token, [{ name: '9999_race', sql }]);
    expect(second.status).toBe(200);
    expect((await second.json<{ skipped: string[] }>()).skipped).toContain('9999_race');
  });

  it('reports an unreachable JWKS as retryable, not as a bad token', async () => {
    // CI treats any handler error as fatal, so a flat 401 here failed a valid run red during a
    // GitHub blip. 503 + retryable:true is what keeps it in the retry loop.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream sad', { status: 503 })));
    const token = await signJwt(keys.pair.privateKey, goodClaims());
    const res = await post(token, [{ name: '9999_probe', sql: 'CREATE TABLE migrate_probe (a INT);' }]);
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string; retryable: boolean }>();
    expect(body.error).toBe('oidc_unavailable');
    expect(body.retryable).toBe(true);
  });

  it('refetches the JWKS uncached when the kid is unknown, covering key rotation', async () => {
    // A newly rotated signing key is absent from the 10-minute cached set, so a perfectly valid
    // token looks forged. First call serves a stale set, second serves the real one.
    let call = 0;
    const realJwk = { ...keys.jwk, kid: 'rotated-key', alg: 'RS256', use: 'sig' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.includes('token.actions.githubusercontent.com')) return new Response('nf', { status: 404 });
        call++;
        const keySet = call === 1 ? [{ kty: 'RSA', kid: 'old-key', n: 'AQAB', e: 'AQAB' }] : [realJwk];
        return new Response(JSON.stringify({ keys: keySet }), { status: 200 });
      }),
    );
    const token = await signJwt(keys.pair.privateKey, goodClaims(), { alg: 'RS256', kid: 'rotated-key', typ: 'JWT' });
    const res = await post(token, [{ name: '9999_rot', sql: 'CREATE TABLE migrate_probe (a INT);' }]);
    expect(res.status, 'a rotated signing key was treated as a forged token').toBe(200);
    expect(call).toBeGreaterThanOrEqual(2);
  });
});
