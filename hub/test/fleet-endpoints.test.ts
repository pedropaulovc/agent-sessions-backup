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

  // Sign-sequence stub: returns the given fake certs on successive sign POSTs and records DELETEs.
  function stubSignAndRevoke(seeds: Array<{ seed: string; id: string }>) {
    let i = 0;
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          deletes.push(url.split('/').pop()!);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        const s = seeds[i++]!;
        return new Response(JSON.stringify({ success: true, result: { id: s.id, certificate: fakeCertPem(s.seed), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
      }),
    );
    return { deletes };
  }

  it('recovers a lost-response renewal: a retry on the in-grace prev cert yields a working successor, grace clock unchanged, orphan revoked', async () => {
    // Renewed once (current = B) but the response was lost, so the machine still holds A — now the
    // in-grace prev — with revoke_at in the future.
    await seedMachine('renew-lost', { fp: 'lost-B', certId: 'cert-B', prevFp: 'lost-A', prevCertId: 'cert-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const id = await machineIdentity(reqWithCert('lost-A'), prodEnv); // authenticates on the in-grace prev
    expect(id).toMatchObject({ kind: 'machine', machineId: 'renew-lost', certFp: 'lost-A' });

    const { deletes } = stubSignAndRevoke([{ seed: 'lost-C', id: 'cert-C' }]);
    const fpC = await certFingerprint(fakeCertPem('lost-C'));

    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, id);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { fingerprint: string; prev_revoke_at: string };
    expect(out.fingerprint).toBe(fpC);
    expect(out.prev_revoke_at).toBe('2999-01-01T00:00:00.000Z'); // grace clock NOT extended

    const r = await row('renew-lost');
    expect(r?.cert_fp_sha256).toBe(fpC); // orphaned successor B replaced by C
    expect(r?.prev_cert_fp_sha256).toBe('lost-A'); // prev slot untouched
    expect(r?.cert_revoke_at).toBe('2999-01-01T00:00:00.000Z'); // original window kept
    expect(deletes).toContain('cert-B'); // displaced successor revoked
    expect(await machineIdentity(reqWithCert('lost-A'), prodEnv)).toMatchObject({ machineId: 'renew-lost' });
    expect(await machineIdentity(reqWithCert(fpC), prodEnv)).toMatchObject({ machineId: 'renew-lost' });
  });

  it('revokes the previous cert that a normal rotation displaces (no orphan left at the CA)', async () => {
    // Machine is mid-grace: current B, prev A still valid. A renew on the CURRENT cert rotates B->C,
    // which overwrites the grace slot with B and drops the row's only reference to A. A must be
    // revoked now, or it lingers at the CA until its 1-year expiry.
    await seedMachine('renew-disp', { fp: 'disp-B', certId: 'disp-cert-B', prevFp: 'disp-A', prevCertId: 'disp-cert-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const { deletes } = stubSignAndRevoke([{ seed: 'disp-C', id: 'disp-cert-C' }]);
    const fpC = await certFingerprint(fakeCertPem('disp-C'));

    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-disp', false, 'disp-B')); // authed on current
    expect(res.status).toBe(200);
    const r = await row('renew-disp');
    expect(r?.cert_fp_sha256).toBe(fpC); // C is current
    expect(r?.prev_cert_fp_sha256).toBe('disp-B'); // old current retired into grace
    expect(r?.prev_cert_id).toBe('disp-cert-B');
    expect(deletes).toContain('disp-cert-A'); // the displaced older prev was revoked
    expect(deletes).not.toContain('disp-cert-B'); // the fresh grace cert stays valid
  });

  it('repeated prev-auth retries do not extend the grace clock (no immortal old cert)', async () => {
    await seedMachine('renew-lost2', { fp: 'l2-B', certId: 'cert-l2-B', prevFp: 'l2-A', prevCertId: 'cert-l2-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    stubSignAndRevoke([{ seed: 'l2-C', id: 'cert-l2-C' }, { seed: 'l2-D', id: 'cert-l2-D' }]);
    // Retry twice, each still holding l2-A (the in-grace prev).
    await renewCert(reqJson({ csr: 'c1' }), cfEnv, await machineIdentity(reqWithCert('l2-A'), prodEnv));
    await renewCert(reqJson({ csr: 'c2' }), cfEnv, await machineIdentity(reqWithCert('l2-A'), prodEnv));
    const r = await row('renew-lost2');
    expect(r?.cert_revoke_at).toBe('2999-01-01T00:00:00.000Z'); // never extended
    expect(r?.prev_cert_fp_sha256).toBe('l2-A'); // prev unchanged
    expect(r?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('l2-D'))); // latest successor
  });

  it('409s a recovery whose grace window has already closed, revoking the just-signed orphan', async () => {
    await seedMachine('renew-expired', { fp: 're-B', certId: 'cert-re-B', prevFp: 're-A', prevCertId: 'cert-re-A', revokeAt: '2000-01-01T00:00:00.000Z' });
    const { deletes } = stubSignAndRevoke([{ seed: 're-C', id: 'cert-re-C' }]);
    // Construct the identity directly on the expired prev fp (machineIdentity would deny it).
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-expired', false, 're-A'));
    expect(res.status).toBe(409);
    expect(deletes).toContain('cert-re-C'); // orphan revoked
    expect((await row('renew-expired'))?.cert_fp_sha256).toBe('re-B'); // unchanged
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

  it('resets rotation metadata when the current fingerprint changes (prune then finds nothing to revoke)', async () => {
    await seedMachine('am-rot', { fp: 'am-rot-cur', certId: 'am-rot-certid', prevFp: 'am-rot-prev', prevCertId: 'am-rot-previd', revokeAt: '2000-01-01T00:00:00.000Z' });
    await adminMachines(reqJson({ machine_id: 'am-rot', cert_fp_sha256: 'am-rot-new' }), testEnv, machine('am-admin', true));
    const r = await row('am-rot');
    expect(r?.cert_fp_sha256).toBe('am-rot-new');
    expect(r?.cert_id).toBeNull(); // no body cert_id given -> reset to NULL
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace window cleared -> prune's WHERE won't match
    expect(r?.prev_cert_id).toBeNull();
    expect(r?.cert_revoke_at).toBeNull();
  });

  it('rollback: setting cert_fp back to the in-grace prev clears the window so prune never revokes the reinstated cert', async () => {
    await seedMachine('am-rollback', { fp: 'rb-B', certId: 'cert-rb-B', prevFp: 'rb-A', prevCertId: 'cert-rb-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-rollback', cert_fp_sha256: 'rb-A' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-rollback');
    expect(r?.cert_fp_sha256).toBe('rb-A'); // reinstated as current
    expect(r?.prev_cert_fp_sha256).toBeNull(); // no longer scheduled for revoke
    expect(r?.cert_revoke_at).toBeNull();
  });

  it('same-fp upsert preserves an active rotation window', async () => {
    await seedMachine('am-keep', { fp: 'keep-B', certId: 'cert-keep-B', prevFp: 'keep-A', prevCertId: 'cert-keep-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    await adminMachines(reqJson({ machine_id: 'am-keep', priority: 7 }), testEnv, machine('am-admin', true)); // no fp change
    const r = await row('am-keep');
    expect(r?.priority).toBe(7);
    expect(r?.cert_id).toBe('cert-keep-B'); // preserved
    expect(r?.prev_cert_fp_sha256).toBe('keep-A'); // preserved
    expect(r?.prev_cert_id).toBe('cert-keep-A');
    expect(r?.cert_revoke_at).toBe('2999-01-01T00:00:00.000Z');
  });

  it("409s a fingerprint still held as another machine's prev cert even past its grace window", async () => {
    // Grace expired (revoke_at in the past) but the prev cert is still recorded and not yet revoked.
    // A prev fp is reserved while prev_cert_fp_sha256 is set at all — the clash predicate is now the
    // simple `cert_fp_sha256 = ?1 OR prev_cert_fp_sha256 = ?1`.
    await seedMachine('am-exp', { fp: 'am-exp-cur', prevFp: 'am-exp-prev', prevCertId: 'am-exp-previd', revokeAt: '2000-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-exp-other', cert_fp_sha256: 'am-exp-prev' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { machine_id: string }).machine_id).toBe('am-exp');
  });

  it('409s a legacy NULL-id prev fp — unknown CA id is NOT "revoked", so the fp stays reserved (before AND after prune)', async () => {
    // Pre-M4 enroll cert: prev_cert_id NULL because the hub never recorded the CA id, not because the
    // cert is gone. Reusing it would let whoever still holds that old cert authenticate as the new row.
    // Case 1: out of grace, prune hasn't run (revoke_at in the past).
    await seedMachine('am-legacy', { fp: 'am-legacy-cur', prevFp: 'am-legacy-prev', revokeAt: '2000-01-01T00:00:00.000Z' }); // prevCertId omitted -> NULL
    const before = await adminMachines(reqJson({ machine_id: 'am-legacy-x', cert_fp_sha256: 'am-legacy-prev' }), testEnv, machine('am-admin', true));
    expect(before.status).toBe(409);
    // Case 2: after prune has tombstoned it (revoke_at cleared, prev fp + NULL id kept as reservation).
    await seedMachine('am-tomb', { fp: 'am-tomb-cur', prevFp: 'am-tomb-prev' }); // prevCertId + revokeAt NULL == tombstone
    const after = await adminMachines(reqJson({ machine_id: 'am-tomb-x', cert_fp_sha256: 'am-tomb-prev' }), testEnv, machine('am-admin', true));
    expect(after.status).toBe(409);
    expect(((await after.json()) as { machine_id: string }).machine_id).toBe('am-tomb');
  });

  it('carries the prev cert id into cert_id when rolling back to the in-grace prev fp', async () => {
    // Rollback: admin sets current back to the in-grace prev fp. Its CA id lives in prev_cert_id — it
    // must move into cert_id, or the row stores the reinstated cert with a NULL id and the next
    // renew/prune can never revoke the real cert.
    await seedMachine('am-rbid', { fp: 'rbid-B', certId: 'cert-rbid-B', prevFp: 'rbid-A', prevCertId: 'cert-rbid-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-rbid', cert_fp_sha256: 'rbid-A' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-rbid');
    expect(r?.cert_fp_sha256).toBe('rbid-A');
    expect(r?.cert_id).toBe('cert-rbid-A'); // carried over from prev_cert_id, not dropped to NULL
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace window cleared
  });

  it('first-insert race: the loser 409s instead of a silent 200 with nothing installed', async () => {
    // Two registrations race for the same NEW machine_id. The loser reads existing as null, then a
    // competing insert lands; its `cert_fp_sha256 IS NULL` CAS misses (changes === 0). With the
    // `existing &&` gate dropped, that zero-change result is a 409 rather than a 200 installing nothing.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('prev_cert_fp_sha256, prev_cert_id, cert_revoke_at')) return stmt;
      const realBind = stmt.bind.bind(stmt);
      (stmt as unknown as { bind: (...a: unknown[]) => unknown }).bind = (...b: unknown[]) => {
        const bound = (realBind as (...a: unknown[]) => { first: (...f: unknown[]) => Promise<unknown> })(...b);
        const realFirst = bound.first.bind(bound);
        bound.first = async (...f: unknown[]) => {
          const r = await realFirst(...f); // null — the row does not exist yet
          await realPrepare('INSERT INTO machines (machine_id, os, cert_fp_sha256, cert_id) VALUES (?1, ?2, ?3, ?4)')
            .bind('race-new', 'linux', 'race-winner-fp', 'race-winner-id')
            .run();
          return r;
        };
        return bound;
      };
      return stmt;
    });
    const res = await adminMachines(reqJson({ machine_id: 'race-new', cert_fp_sha256: 'race-loser-fp', cert_id: 'race-loser-id' }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('concurrent_rotation');
    expect((await row('race-new'))?.cert_fp_sha256).toBe('race-winner-fp'); // winner intact, loser NOT installed
  });

  it('metadata-only edit never writes cert columns, so a renew that lands mid-edit is not clobbered', async () => {
    // Reproduces the read-modify-write race: the handler reads the row, a renew rotates the cert
    // before the write lands. The fix routes cert-free edits down a write path that omits the cert
    // columns entirely, so the renewed chain survives instead of being rolled back to the snapshot.
    await seedMachine('meta-race', { fp: 'meta-A', certId: 'cid-A' });
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('is_admin, priority FROM machines WHERE machine_id = ?1')) return stmt;
      const realBind = stmt.bind.bind(stmt);
      (stmt as unknown as { bind: (...a: unknown[]) => unknown }).bind = (...b: unknown[]) => {
        const bound = (realBind as (...a: unknown[]) => { first: (...f: unknown[]) => Promise<unknown> })(...b);
        const realFirst = bound.first.bind(bound);
        bound.first = async (...f: unknown[]) => {
          const r = await realFirst(...f);
          await realPrepare('UPDATE machines SET cert_fp_sha256 = ?2, cert_id = ?3, prev_cert_fp_sha256 = ?4 WHERE machine_id = ?1')
            .bind('meta-race', 'meta-B', 'cid-B', 'meta-A')
            .run();
          return r;
        };
        return bound;
      };
      return stmt;
    });
    const res = await adminMachines(reqJson({ machine_id: 'meta-race', priority: 3 }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(200);
    const r = await row('meta-race');
    expect(r?.priority).toBe(3); // metadata change applied
    expect(r?.cert_fp_sha256).toBe('meta-B'); // renewed cert survived, NOT rolled back to meta-A
    expect(r?.cert_id).toBe('cid-B');
    expect(r?.prev_cert_fp_sha256).toBe('meta-A'); // renew's grace prev survived
  });

  it('cert-field edit racing a renew 409s (CAS on the observed fp) instead of clobbering the renewed chain', async () => {
    // Same interleave, but the admin request DOES carry cert fields. The write CASes on the fp the
    // handler observed; because a renew advanced current under it, the WHERE misses (changes === 0)
    // and we return concurrent_rotation rather than overwriting the renewed cert.
    await seedMachine('cas-race', { fp: 'cas-A', certId: 'cid-A' });
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('prev_cert_fp_sha256, prev_cert_id, cert_revoke_at')) return stmt;
      const realBind = stmt.bind.bind(stmt);
      (stmt as unknown as { bind: (...a: unknown[]) => unknown }).bind = (...b: unknown[]) => {
        const bound = (realBind as (...a: unknown[]) => { first: (...f: unknown[]) => Promise<unknown> })(...b);
        const realFirst = bound.first.bind(bound);
        bound.first = async (...f: unknown[]) => {
          const r = await realFirst(...f);
          await realPrepare('UPDATE machines SET cert_fp_sha256 = ?2, cert_id = ?3 WHERE machine_id = ?1')
            .bind('cas-race', 'cas-B', 'cid-B')
            .run();
          return r;
        };
        return bound;
      };
      return stmt;
    });
    const res = await adminMachines(reqJson({ machine_id: 'cas-race', cert_fp_sha256: 'cas-C', cert_id: 'cid-C' }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('concurrent_rotation');
    expect((await row('cas-race'))?.cert_fp_sha256).toBe('cas-B'); // renewed cert survived
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

  it('tombstones a NULL-id prev (pre-M4 enrolled cert): no CA call, only revoke_at cleared, fp stays reserved', async () => {
    // Unknown CA id ≠ revoked — the underlying cert may still be CA-valid. So we retire the grace
    // window but keep prev_cert_fp_sha256 (with NULL id) as a tombstone so no other machine can claim it.
    await seedMachine('prune-4', { fp: 'cur4', prevFp: 'old4', prevCertId: undefined, revokeAt: '2000-01-01T00:00:00.000Z' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await runDailyPrune(cfEnv);
    expect(fetchMock).not.toHaveBeenCalled(); // no recorded id -> nothing to revoke
    const r = await row('prune-4');
    expect(r?.prev_cert_fp_sha256).toBe('old4'); // KEPT — tombstone reservation
    expect(r?.prev_cert_id).toBeNull();
    expect(r?.cert_revoke_at).toBeNull(); // grace window retired (identity already stops honoring it)
    // The tombstoned fp remains unclaimable by another machine.
    const clash = await adminMachines(reqJson({ machine_id: 'prune-4-other', cert_fp_sha256: 'old4' }), testEnv, machine('am-admin', true));
    expect(clash.status).toBe(409);
  });

  it('a confirmed CA revoke frees the fingerprint for reuse by another machine', async () => {
    await seedMachine('prune-free', { fp: 'pf-cur', prevFp: 'pf-old', prevCertId: 'pf-cert-old', revokeAt: '2000-01-01T00:00:00.000Z' });
    stubDelete(true);
    await runDailyPrune(cfEnv);
    expect((await row('prune-free'))?.prev_cert_fp_sha256).toBeNull(); // freed once the CA cert is gone
    const reuse = await adminMachines(reqJson({ machine_id: 'prune-free-other', cert_fp_sha256: 'pf-old' }), testEnv, machine('am-admin', true));
    expect(reuse.status).toBe(200); // now claimable
  });
});
