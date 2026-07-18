import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineIdentity, type Identity } from '../src/auth/identity';
import { bootstrap, COLLECTOR_CONFIG_SCHEMA_VERSION, DEFAULT_COLLECTOR_CONFIG } from '../src/api/bootstrap';
import { renewCert, certFingerprint } from '../src/api/certs';
import { adminMachines } from '../src/api/ops';
import { runDailyPrune } from '../src/cron/prune';

const testEnv = env as unknown as Env;
const cfEnv = { ...testEnv, CF_ZONE_ID: 'zone-1', CF_CLIENT_CERT_TOKEN: 'cf-token' } as Env;
const prodEnv = { ...testEnv, ENVIRONMENT: 'production' } as Env;

const machine = (machineId: string, isAdmin = false, certFp?: string): Identity => ({ kind: 'machine', machineId, isAdmin, certFp });

function reqJson(body: unknown): Request {
  return new Request('https://api.sessions.vza.net/api/v1/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function reqWithCert(fp: string): Request {
  return new Request('https://api.sessions.vza.net/api/v1/status', {
    cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fp } },
  } as unknown as RequestInit);
}

// certFingerprint hashes the decoded DER bytes of the leaf PEM block — it doesn't parse X.509 —
// so an arbitrary base64 payload between the markers is enough to exercise the real code path.
function fakeCertPem(seed: string): string {
  const b64 = btoa(`der-bytes-${seed}`.padEnd(48, 'x'));
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

async function seedMachine(
  id: string,
  opts: { fp?: string; certId?: string; isAdmin?: boolean; prevFp?: string; prevCertId?: string; revokeAt?: string } = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO machines (machine_id, os, cert_fp_sha256, cert_id, is_admin, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at)
       VALUES (?1, 'linux', ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (machine_id) DO UPDATE SET
       cert_fp_sha256 = ?2, cert_id = ?3, is_admin = ?4, prev_cert_fp_sha256 = ?5, prev_cert_id = ?6, cert_revoke_at = ?7`,
  )
    .bind(id, opts.fp ?? null, opts.certId ?? null, opts.isAdmin ? 1 : 0, opts.prevFp ?? null, opts.prevCertId ?? null, opts.revokeAt ?? null)
    .run();
}

function row(id: string) {
  return testEnv.DB.prepare(
    'SELECT cert_fp_sha256, cert_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at, is_admin, os, priority FROM machines WHERE machine_id = ?1',
  )
    .bind(id)
    .first<{ cert_fp_sha256: string | null; cert_id: string | null; prev_cert_fp_sha256: string | null; prev_cert_id: string | null; cert_revoke_at: string | null; is_admin: number; os: string; priority: number }>();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/bootstrap', () => {
  it('serves the default collector config to an enrolled machine', async () => {
    const res = await bootstrap(testEnv, machine('boot-1'));
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as Record<string, unknown>;
    expect(cfg.schema_version).toBe(COLLECTOR_CONFIG_SCHEMA_VERSION);
    expect(cfg.scan_interval_seconds).toBe(DEFAULT_COLLECTOR_CONFIG.scan_interval_seconds);
    expect(cfg.max_upload_bytes).toBe(DEFAULT_COLLECTOR_CONFIG.max_upload_bytes);
    expect((cfg.stores as Record<string, boolean>)['claude-code']).toBe(true);
  });

  it('401s a non-machine identity', async () => {
    expect((await bootstrap(testEnv, { kind: 'anonymous' })).status).toBe(401);
    expect((await bootstrap(testEnv, { kind: 'human' })).status).toBe(401);
  });

  it('shallow-merges a meta override but keeps schema_version fixed', async () => {
    await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('collector_config', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind(JSON.stringify({ scan_interval_seconds: 60, redact_env: false, schema_version: 999 }))
      .run();
    try {
      const cfg = (await (await bootstrap(testEnv, machine('boot-2'))).json()) as Record<string, unknown>;
      expect(cfg.scan_interval_seconds).toBe(60); // override wins
      expect(cfg.redact_env).toBe(false);
      expect(cfg.schema_version).toBe(COLLECTOR_CONFIG_SCHEMA_VERSION); // override can't forge the version
      expect(cfg.heartbeat_interval_seconds).toBe(DEFAULT_COLLECTOR_CONFIG.heartbeat_interval_seconds); // untouched default
    } finally {
      await testEnv.DB.prepare("DELETE FROM meta WHERE key = 'collector_config'").run();
    }
  });

  it('falls back to defaults when the override is malformed', async () => {
    await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('collector_config', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
      .bind('{not valid json')
      .run();
    try {
      const cfg = (await (await bootstrap(testEnv, machine('boot-3'))).json()) as Record<string, unknown>;
      expect(cfg.scan_interval_seconds).toBe(DEFAULT_COLLECTOR_CONFIG.scan_interval_seconds);
      expect(cfg.schema_version).toBe(COLLECTOR_CONFIG_SCHEMA_VERSION);
    } finally {
      await testEnv.DB.prepare("DELETE FROM meta WHERE key = 'collector_config'").run();
    }
  });
});

describe('POST /api/v1/certs/renew', () => {
  function stubSign(cert: { id: string; certificate: string; expires_on?: string }) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/client_certificates') && init?.method !== 'DELETE') {
        return new Response(JSON.stringify({ success: true, result: { expires_on: '2027-01-01T00:00:00Z', ...cert } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('signs a successor, swaps in the new fp, and keeps the old fp valid for the grace window', async () => {
    await seedMachine('renew-1', { fp: 'r1-fpA', certId: 'r1-cert-A' });
    stubSign({ id: 'r1-cert-B', certificate: fakeCertPem('r1-B') });
    const expectedFp = await certFingerprint(fakeCertPem('r1-B'));

    // Authenticated on the current cert (r1-fpA) — the CAS conditions the swap on this fp.
    const res = await renewCert(reqJson({ csr: 'csr-body' }), cfEnv, machine('renew-1', false, 'r1-fpA'));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { fingerprint: string; cert_id: string };
    expect(out.fingerprint).toBe(expectedFp);
    expect(out.cert_id).toBe('r1-cert-B');

    const r = await row('renew-1');
    expect(r?.cert_fp_sha256).toBe(expectedFp);
    expect(r?.cert_id).toBe('r1-cert-B');
    expect(r?.prev_cert_fp_sha256).toBe('r1-fpA'); // old current retired into prev
    expect(r?.prev_cert_id).toBe('r1-cert-A');
    expect(r?.cert_revoke_at! > new Date().toISOString()).toBe(true); // ~+7d, in the future

    // Dual-fp window: BOTH the new cert AND the retired one still authenticate.
    expect(await machineIdentity(reqWithCert(expectedFp), prodEnv)).toMatchObject({ kind: 'machine', machineId: 'renew-1' });
    expect(await machineIdentity(reqWithCert('r1-fpA'), prodEnv)).toMatchObject({ kind: 'machine', machineId: 'renew-1' });
  });

  it('a second renew is authed by the CURRENT cert and REPLACES prev (never chains a third generation)', async () => {
    await seedMachine('renew-2', { fp: 'r2-fpA', certId: 'r2-cert-A' });

    // Renew #1: A -> B. Authenticate on the current cert (r2-fpA) via the real identity path.
    stubSign({ id: 'r2-cert-B', certificate: fakeCertPem('r2-B') });
    const fpB = await certFingerprint(fakeCertPem('r2-B'));
    const id1 = await machineIdentity(reqWithCert('r2-fpA'), prodEnv);
    expect(id1).toMatchObject({ kind: 'machine', machineId: 'renew-2' });
    await renewCert(reqJson({ csr: 'csr-1' }), cfEnv, id1);
    vi.unstubAllGlobals();

    // Renew #2: authenticate on the NEW current cert (fpB), mint C.
    stubSign({ id: 'r2-cert-C', certificate: fakeCertPem('r2-C') });
    const fpC = await certFingerprint(fakeCertPem('r2-C'));
    const id2 = await machineIdentity(reqWithCert(fpB), prodEnv);
    expect(id2).toMatchObject({ kind: 'machine', machineId: 'renew-2' });
    await renewCert(reqJson({ csr: 'csr-2' }), cfEnv, id2);

    const r = await row('renew-2');
    expect(r?.cert_fp_sha256).toBe(fpC); // current is C
    expect(r?.prev_cert_fp_sha256).toBe(fpB); // prev is B — A was displaced, not chained
    expect(r?.prev_cert_id).toBe('r2-cert-B');

    // A (the first generation) no longer authenticates; B (current prev) and C (current) do.
    expect(await machineIdentity(reqWithCert('r2-fpA'), prodEnv)).toEqual({ kind: 'anonymous' });
    expect(await machineIdentity(reqWithCert(fpB), prodEnv)).toMatchObject({ machineId: 'renew-2' });
    expect(await machineIdentity(reqWithCert(fpC), prodEnv)).toMatchObject({ machineId: 'renew-2' });
  });

  it('serializes concurrent renews off the same cert: loser 409s + orphan revoked, winner chain intact', async () => {
    await seedMachine('renew-race', { fp: 'rr-fpA', certId: 'rr-cert-A' });
    // Two requests that both authenticated while rr-fpA was current (resolved before either swaps).
    const id1 = await machineIdentity(reqWithCert('rr-fpA'), prodEnv);
    const id2 = await machineIdentity(reqWithCert('rr-fpA'), prodEnv);

    // Sign returns B then C on successive calls; DELETE (orphan revoke) succeeds and is recorded.
    const signed = [
      { id: 'rr-cert-B', certificate: fakeCertPem('rr-B') },
      { id: 'rr-cert-C', certificate: fakeCertPem('rr-C') },
    ];
    let signIdx = 0;
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          deletes.push(url.split('/').pop()!);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, result: { expires_on: '2027-01-01T00:00:00Z', ...signed[signIdx++]! } }), { status: 200 });
      }),
    );
    const fpB = await certFingerprint(fakeCertPem('rr-B'));
    const fpC = await certFingerprint(fakeCertPem('rr-C'));

    // Winner advances current A -> B. Loser's swap then finds current is no longer A -> 409.
    expect((await renewCert(reqJson({ csr: 'c1' }), cfEnv, id1)).status).toBe(200);
    expect((await renewCert(reqJson({ csr: 'c2' }), cfEnv, id2)).status).toBe(409);

    expect(deletes).toContain('rr-cert-C'); // the loser's just-signed cert was revoked, not stranded
    const r = await row('renew-race');
    expect(r?.cert_fp_sha256).toBe(fpB); // winner's chain
    expect(r?.prev_cert_fp_sha256).toBe('rr-fpA');
    expect(await machineIdentity(reqWithCert('rr-fpA'), prodEnv)).toMatchObject({ machineId: 'renew-race' });
    expect(await machineIdentity(reqWithCert(fpB), prodEnv)).toMatchObject({ machineId: 'renew-race' });
    expect(await machineIdentity(reqWithCert(fpC), prodEnv)).toEqual({ kind: 'anonymous' }); // C never installed
  });

  it('stops honoring the previous fp once its revoke_at has passed', async () => {
    await seedMachine('renew-3', { fp: 'fpCur', prevFp: 'fpExpired', prevCertId: 'cert-x', revokeAt: '2000-01-01T00:00:00.000Z' });
    expect(await machineIdentity(reqWithCert('fpCur'), prodEnv)).toMatchObject({ machineId: 'renew-3' });
    expect(await machineIdentity(reqWithCert('fpExpired'), prodEnv)).toEqual({ kind: 'anonymous' });
  });

  it('401s a non-machine caller', async () => {
    expect((await renewCert(reqJson({ csr: 'x' }), cfEnv, { kind: 'anonymous' })).status).toBe(401);
  });

  it('400s a missing CSR', async () => {
    await seedMachine('renew-4', { fp: 'fp4' });
    expect((await renewCert(reqJson({}), cfEnv, machine('renew-4'))).status).toBe(400);
  });

  it('503s when the renewal secret is not provisioned, dispatching nothing', async () => {
    await seedMachine('renew-5', { fp: 'fp5', certId: 'cert-5' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await renewCert(reqJson({ csr: 'x' }), testEnv, machine('renew-5')); // no CF_ZONE_ID/token
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await row('renew-5'))?.cert_fp_sha256).toBe('fp5'); // unchanged
  });

  it('502s and leaves the row unchanged when the CA rejects the CSR', async () => {
    await seedMachine('renew-6', { fp: 'fp6', certId: 'cert-6' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'bad csr' }] }), { status: 200 })));
    const res = await renewCert(reqJson({ csr: 'x' }), cfEnv, machine('renew-6'));
    expect(res.status).toBe(502);
    const r = await row('renew-6');
    expect(r?.cert_fp_sha256).toBe('fp6');
    expect(r?.prev_cert_fp_sha256).toBeNull();
  });
});

describe('POST /api/v1/admin/machines', () => {
  it('403s a non-admin machine cert (positive control: admin succeeds below)', async () => {
    const res = await adminMachines(reqJson({ machine_id: 'x' }), testEnv, machine('nonadmin', false));
    expect(res.status).toBe(403);
  });

  it('upserts a machine and returns the roster for an admin cert', async () => {
    const res = await adminMachines(
      reqJson({ machine_id: 'am-new', os: 'linux', cert_fp_sha256: 'fp-am-new', is_admin: true, priority: 50 }),
      testEnv,
      machine('am-admin', true),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { machines: Array<{ machine_id: string }> };
    expect(out.machines.some((m) => m.machine_id === 'am-new')).toBe(true);
    const r = await row('am-new');
    expect(r?.is_admin).toBe(1);
    expect(r?.priority).toBe(50);
    expect(r?.cert_fp_sha256).toBe('fp-am-new');
  });

  it('partial upsert preserves unspecified columns instead of resetting them', async () => {
    await adminMachines(reqJson({ machine_id: 'am-part', os: 'windows', is_admin: true, priority: 20 }), testEnv, machine('am-admin', true));
    await adminMachines(reqJson({ machine_id: 'am-part', priority: 5 }), testEnv, machine('am-admin', true));
    const r = await row('am-part');
    expect(r?.priority).toBe(5); // updated
    expect(r?.os).toBe('windows'); // preserved
    expect(r?.is_admin).toBe(1); // preserved
  });

  it('409s a duplicate CURRENT fingerprint (explicit pre-check, not a UNIQUE-violation catch)', async () => {
    await adminMachines(reqJson({ machine_id: 'am-a', cert_fp_sha256: 'fp-dup' }), testEnv, machine('am-admin', true));
    const res = await adminMachines(reqJson({ machine_id: 'am-b', cert_fp_sha256: 'fp-dup' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('fingerprint_in_use');
  });

  it("409s a fingerprint that is another machine's IN-GRACE previous cert (UNIQUE index misses this axis)", async () => {
    await seedMachine('am-grace', { fp: 'am-grace-cur', prevFp: 'am-grace-prev', prevCertId: 'x', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-other', cert_fp_sha256: 'am-grace-prev' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { machine_id: string }).machine_id).toBe('am-grace');
  });
});

describe('daily prune (cert revoke)', () => {
  // runDailyPrune scans the WHOLE machines table, so clear every row's rotation state first —
  // otherwise a due row left by an earlier test (e.g. a renew fixture with a past revoke_at)
  // would be revoked by this test's stub and throw off its call-count assertions.
  beforeEach(async () => {
    await testEnv.DB.prepare('UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL').run();
  });

  function stubDelete(success: boolean) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      expect(String(input)).toContain('/client_certificates/');
      return new Response(JSON.stringify({ success }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('revokes a due cert at the CA and clears the rotation columns', async () => {
    await seedMachine('prune-1', { fp: 'cur1', prevFp: 'old1', prevCertId: 'cert-old-1', revokeAt: '2000-01-01T00:00:00.000Z' });
    const fetchMock = stubDelete(true);
    await runDailyPrune(cfEnv);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/client_certificates/cert-old-1');
    const r = await row('prune-1');
    expect(r?.prev_cert_fp_sha256).toBeNull();
    expect(r?.prev_cert_id).toBeNull();
    expect(r?.cert_revoke_at).toBeNull();
    expect(r?.cert_fp_sha256).toBe('cur1'); // current cert untouched
  });

  it('keeps the columns (retries next run) when the CA revoke fails', async () => {
    await seedMachine('prune-2', { fp: 'cur2', prevFp: 'old2', prevCertId: 'cert-old-2', revokeAt: '2000-01-01T00:00:00.000Z' });
    stubDelete(false);
    await runDailyPrune(cfEnv);
    const r = await row('prune-2');
    expect(r?.prev_cert_fp_sha256).toBe('old2'); // untouched — will retry
    expect(r?.prev_cert_id).toBe('cert-old-2');
    expect(r?.cert_revoke_at).toBe('2000-01-01T00:00:00.000Z');
  });

  it('leaves a not-yet-due grace window alone (no CA call)', async () => {
    await seedMachine('prune-3', { fp: 'cur3', prevFp: 'old3', prevCertId: 'cert-old-3', revokeAt: '2999-01-01T00:00:00.000Z' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runDailyPrune(cfEnv);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await row('prune-3'))?.prev_cert_fp_sha256).toBe('old3');
  });

  it('a renew landing between prune select and clear survives (conditional clear no-ops)', async () => {
    await seedMachine('prune-race', { fp: 'pr-cur', prevFp: 'pr-old', prevCertId: 'pr-cert-old', revokeAt: '2000-01-01T00:00:00.000Z' });
    // The DELETE (revoke) succeeds, but simulates a concurrent renew that lands between prune's
    // SELECT and its clear — repopulating prev with a FRESH grace window. The conditional clear
    // (keyed on the OLD prev fp + revoke_at) must then no-op, leaving the fresh window intact.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe('DELETE');
        await testEnv.DB.prepare(
          `UPDATE machines SET prev_cert_fp_sha256 = 'pr-fresh', prev_cert_id = 'pr-cert-fresh', cert_revoke_at = '2999-01-01T00:00:00.000Z' WHERE machine_id = 'prune-race'`,
        ).run();
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }),
    );
    await runDailyPrune(cfEnv);
    const r = await row('prune-race');
    expect(r?.prev_cert_fp_sha256).toBe('pr-fresh'); // fresh window survived the stale clear
    expect(r?.prev_cert_id).toBe('pr-cert-fresh');
    expect(r?.cert_revoke_at).toBe('2999-01-01T00:00:00.000Z');
  });

  it('clears columns without a CA call when there is no prev_cert_id (pre-M4 enrolled cert)', async () => {
    await seedMachine('prune-4', { fp: 'cur4', prevFp: 'old4', prevCertId: undefined, revokeAt: '2000-01-01T00:00:00.000Z' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runDailyPrune(cfEnv);
    expect(fetchMock).not.toHaveBeenCalled(); // nothing to revoke at the CA
    expect((await row('prune-4'))?.prev_cert_fp_sha256).toBeNull(); // still cleared
  });
});
