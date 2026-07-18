import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineIdentity, type Identity } from '../src/auth/identity';
import { bootstrap, COLLECTOR_CONFIG_SCHEMA_VERSION, DEFAULT_COLLECTOR_CONFIG } from '../src/api/bootstrap';
import { renewCert, certFingerprint, settleRetired, revokeClientCert, pollRetired } from '../src/api/certs';
import { adminMachines, heartbeat } from '../src/api/ops';
import { runDailyPrune } from '../src/cron/prune';
import { route } from '../src/router';

const testEnv = env as unknown as Env;
const cfEnv = { ...testEnv, CF_ZONE_ID: 'zone-1', CF_CLIENT_CERT_TOKEN: 'cf-token' } as Env;
const prodEnv = { ...testEnv, ENVIRONMENT: 'production' } as Env;

const machine = (machineId: string, isAdmin = false, certFp?: string, certSlot: 'current' | 'grace' = 'current'): Identity => ({
  kind: 'machine',
  machineId,
  isAdmin,
  certFp,
  certSlot,
});

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

// A deterministic, valid 64-lowercase-hex fingerprint from a short readable label. Real cf.tlsClientAuth
// fps are 64-hex, which the admin endpoint now validates (validateCertFields in ops.ts), so any fp passed
// THROUGH the endpoint as cert_fp_sha256 must be one of these; seed-only / displaced fps can stay short.
// Distinct labels -> distinct fps (labels are < 32 chars, so their hex never collides after padding).
function hexfp(label: string): string {
  let h = '';
  for (let i = 0; i < label.length; i++) h += label.charCodeAt(i).toString(16).padStart(2, '0');
  return (h + '0'.repeat(64)).slice(0, 64);
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

// The single retired_certs row for a fingerprint (reservation/revocation queue). revoked_at NULL =
// still reserved (unclaimable); set = confirmed revoked at the CA.
function retired(fingerprint: string) {
  return testEnv.DB.prepare(
    'SELECT fingerprint, cert_id, machine_id, retired_at, revoked_at, claimed_at FROM retired_certs WHERE fingerprint = ?1',
  )
    .bind(fingerprint)
    .first<{ fingerprint: string; cert_id: string | null; machine_id: string; retired_at: string; revoked_at: string | null; claimed_at: string | null }>();
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
    expect((cfg.stores as Record<string, boolean>)['claude']).toBe(true); // collector's local Claude Code store key
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

  it('every per-store toggle key is a real collector store name (fleet-config contract)', () => {
    // A toggle under a key the collector doesn't scan silently no-ops — the whole point of bootstrap is
    // central capture control, so the keys MUST be the collector's actual store names. The local Claude
    // Code store is keyed 'claude' (the ~/.claude dir), NOT the harness name 'claude-code'. Cross-language
    // (hub is TS, collector is Python), so mirror the set with a pointer instead of a shared import.
    // Source of truth: collector/src/agent_collector/config.py — DEFAULT_STORES {'claude','codex'} +
    // WEBCAPTURE_STORES ('chatgpt-web','claude-web','export-inbox').
    const COLLECTOR_STORES = new Set(['claude', 'codex', 'chatgpt-web', 'claude-web', 'export-inbox']);
    for (const key of Object.keys(DEFAULT_COLLECTOR_CONFIG.stores)) {
      expect(COLLECTOR_STORES.has(key)).toBe(true);
    }
    expect(Object.keys(DEFAULT_COLLECTOR_CONFIG.stores)).toContain('claude'); // the real local Claude Code store
    expect(Object.keys(DEFAULT_COLLECTOR_CONFIG.stores)).not.toContain('claude-code'); // harness name, not a store
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

  it('502s when the CA signs but returns a result with no id, minting no orphan to mis-revoke', async () => {
    // signClientCert must reject a success:true whose result is missing id: otherwise renewCert would carry
    // signed.id === undefined into the D1 write, and the orphan cleanup would DELETE /client_certificates/
    // undefined while the real cert stays active. It must throw BEFORE any write — so no DELETE is issued.
    await seedMachine('renew-noid', { fp: 'rni-fpA', certId: 'rni-cert-A' });
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
      // success:true but the result has NO id (certificate + expires_on present)
      return new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('rni-B'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'csr-body' }), cfEnv, machine('renew-noid', false, 'rni-fpA'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('cf_sign_failed');
    expect((await row('renew-noid'))?.cert_fp_sha256).toBe('rni-fpA'); // unchanged — no swap happened
    expect(seen.some((s) => s.includes('/undefined'))).toBe(false); // never tried to revoke undefined
    expect(seen.some((s) => s.startsWith('DELETE'))).toBe(false); // no revoke attempted at all
  });

  it('best-effort revokes a malformed-but-MINTED sign result (id present, no certificate) before 502', async () => {
    // CF minted a cert (id present) but the result is malformed (no certificate). signClientCert must DELETE
    // that id before throwing — otherwise the cert is stranded active, absent from machines AND retired_certs.
    await seedMachine('renew-mal', { fp: 'rm-fpA', certId: 'rm-cert-A' });
    const deletes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { id: 'minted-mal-id', expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'csr-body' }), cfEnv, machine('renew-mal', false, 'rm-fpA'));
    expect(res.status).toBe(502);
    expect(deletes.filter((u) => u.endsWith('/minted-mal-id'))).toHaveLength(1); // revoked exactly once
    expect((await row('renew-mal'))?.cert_fp_sha256).toBe('rm-fpA'); // no swap
  });

  it('logs the orphan event when the malformed-mint best-effort revoke itself fails', async () => {
    await seedMachine('renew-mal2', { fp: 'rm2-fpA', certId: 'rm2-cert-A' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: false }), { status: 200 }); // revoke rejected
      return new Response(JSON.stringify({ success: true, result: { id: 'minted-mal2-id', expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'csr-body' }), cfEnv, machine('renew-mal2', false, 'rm2-fpA'));
    spy.mockRestore();
    expect(res.status).toBe(502);
    const ev = logs.map((l) => JSON.parse(l) as { event: string; cert_id?: string });
    expect(ev.some((e) => e.event === 'hub.certs.orphan_revoke_failed' && e.cert_id === 'minted-mal2-id')).toBe(true);
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

  it('reserves a displaced prev in the queue when its immediate revoke fails (prune retries later)', async () => {
    await seedMachine('renew-resv', { fp: 'resv-B', certId: 'cert-resv-B', prevFp: 'resv-A', prevCertId: 'cert-resv-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    // Sign succeeds; the revoke DELETE fails — the displaced prev must stay reserved, not vanish.
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: false }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-resv-C', certificate: fakeCertPem('resv-C'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-resv', false, 'resv-B')); // authed on current
    expect(res.status).toBe(200);
    const q = await retired('resv-A');
    expect(q?.cert_id).toBe('cert-resv-A');
    expect(q?.revoked_at).toBeNull(); // revoke failed -> reserved, drained by a later prune
  });

  it('reclaims the signed cert when the D1 swap throws after signing (never an untracked live cert)', async () => {
    await seedMachine('renew-dberr', { fp: 'dberr-A', certId: 'cert-dberr-A' });
    const deletes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input).split('/').pop()!);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-dberr-B', certificate: fakeCertPem('dberr-B'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    // The CA signs, then the D1 swap batch throws (outage/lock) — the just-minted cert must not leak.
    const spy = vi.spyOn(testEnv.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: database is locked'));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-dberr', false, 'dberr-A'));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(deletes).toContain('cert-dberr-B'); // signed cert revoke initiated, not left untracked
    // Async revoke returns pending -> the cert is queued so the prune drives it to revoked.
    expect((await retired(await certFingerprint(fakeCertPem('dberr-B'))))?.cert_id).toBe('cert-dberr-B');
    expect((await row('renew-dberr'))?.cert_fp_sha256).toBe('dberr-A'); // row unchanged
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

  it('409s a recovery whose grace window has already closed, queuing + revoking the just-signed orphan', async () => {
    await seedMachine('renew-expired', { fp: 're-B', certId: 'cert-re-B', prevFp: 're-A', prevCertId: 'cert-re-A', revokeAt: '2000-01-01T00:00:00.000Z' });
    const { deletes } = stubSignAndRevoke([{ seed: 're-C', id: 'cert-re-C' }]);
    const fpReC = await certFingerprint(fakeCertPem('re-C'));
    // Construct the identity directly on the expired prev fp (machineIdentity would deny it).
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-expired', false, 're-A'));
    expect(res.status).toBe(409);
    expect(deletes).toContain('cert-re-C'); // orphan revoke initiated
    // The minted orphan is QUEUED (async revoke -> stub returns pending), never left untracked.
    expect((await retired(fpReC))?.cert_id).toBe('cert-re-C');
    expect((await row('renew-expired'))?.cert_fp_sha256).toBe('re-B'); // unchanged
  });

  it('a CAS-conflict cleanup whose queue INSERT fails still returns 409 and falls back to a direct revoke', async () => {
    // Closed-window recovery -> changes===0 -> orphan cleanup. If the retired_certs INSERT throws
    // (transient D1), the CAS-decided 409 must NOT become a 500, and the minted cert must still get a
    // best-effort revoke rather than being stranded live.
    await seedMachine('renew-cleanup', { fp: 'rc-B', certId: 'cert-rc-B', prevFp: 'rc-A', prevCertId: 'cert-rc-A', revokeAt: '2000-01-01T00:00:00.000Z' });
    const deletes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input).split('/').pop()!);
        return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-rc-C', certificate: fakeCertPem('rc-C'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    // Make ONLY the retireCert queue INSERT (VALUES form) throw; the swap batch + guarded INSERT
    // (SELECT form) are untouched.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO retired_certs') && sql.includes('VALUES')) throw new Error('D1_ERROR: database is locked');
      return realPrepare(sql);
    });
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-cleanup', false, 'rc-A'));
    spy.mockRestore();
    expect(res.status).toBe(409); // cleanup failure never changes the CAS-decided outcome
    expect(deletes).toContain('cert-rc-C'); // fell back to a direct best-effort revoke of the orphan
  });

  it('a renew whose post-revoke stamp throws still returns 200; the reservation stays for the prune', async () => {
    // Normal rotation displaces prev st-A; settleRetired revokes it and the CA reports 'revoked', so it
    // tries to stamp revoked_at. If that D1 UPDATE throws, the COMMITTED renewal must still return 200
    // with the new cert — the row just stays reserved for the next prune poll to re-stamp.
    await seedMachine('renew-stamp', { fp: 'st-B', certId: 'cert-st-B', prevFp: 'st-A', prevCertId: 'cert-st-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'revoked' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-st-C', certificate: fakeCertPem('st-C'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('UPDATE retired_certs SET revoked_at')) throw new Error('D1_ERROR: database is locked');
      return realPrepare(sql);
    });
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-stamp', false, 'st-B'));
    spy.mockRestore();
    expect(res.status).toBe(200); // stamp failure must NOT fail the committed renewal
    expect((await row('renew-stamp'))?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('st-C')));
    expect((await retired('st-A'))?.revoked_at).toBeNull(); // still reserved -> prune re-stamps next run
  });

  it('a failed pre-sign row read returns a retryable 503 and mints NOTHING (no orphan possible)', async () => {
    await seedMachine('renew-read', { fp: 'rr-A', certId: 'cert-rr-A' });
    let signCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'DELETE') signCalls++;
      return new Response(JSON.stringify({ success: true, result: { id: 'x', certificate: fakeCertPem('x'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    // The row read now runs BEFORE signing — make it throw and assert nothing was minted.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('is_admin FROM machines WHERE machine_id = ?1')) throw new Error('D1_ERROR: database is locked');
      return realPrepare(sql);
    });
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-read', false, 'rr-A'));
    spy.mockRestore();
    expect(res.status).toBe(503); // retryable — collector keeps its cert and retries
    expect(signCalls).toBe(0); // never reached the CA mint
    expect((await row('renew-read'))?.cert_fp_sha256).toBe('rr-A'); // unchanged
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

  it('409s when an admin attaches a cert_id between the pre-sign read and the swap; the retry carries the known id into prev', async () => {
    // Helper-enrolled row: current fp known, cert_id NULL. A renew reads the row (sees cert_id NULL),
    // then an admin attaches the CA id before the swap. The CAS pins the observed cert_id (IS NULL), so
    // the swap now misses rather than moving a stale NULL into prev_cert_id (which would make the old
    // cert an unrevocable unknown-id reservation despite the id now being known).
    await seedMachine('renew-idattach', { fp: 'ia-A' }); // cert_id NULL
    const deletes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input).split('/').pop()!);
        return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-ia-B', certificate: fakeCertPem('ia-B'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!(sql.includes('is_admin FROM machines WHERE machine_id = ?1') && sql.includes('prev_cert_id'))) return stmt;
      const realBind = stmt.bind.bind(stmt);
      (stmt as unknown as { bind: (...a: unknown[]) => unknown }).bind = (...args: unknown[]) => {
        const bound = realBind(...(args as [])) as D1PreparedStatement;
        const realFirst = bound.first.bind(bound) as (...a: unknown[]) => Promise<unknown>;
        (bound as unknown as { first: (...a: unknown[]) => Promise<unknown> }).first = async (...fa: unknown[]) => {
          const r = await realFirst(...fa);
          // Admin attaches the CA id to the current fp right after the pre-sign read observed it NULL.
          await realPrepare("UPDATE machines SET cert_id = 'cert-ia-A' WHERE machine_id = 'renew-idattach'").run();
          return r;
        };
        return bound;
      };
      return stmt;
    });
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('renew-idattach', false, 'ia-A'));
    spy.mockRestore();
    expect(res.status).toBe(409); // CAS on the observed NULL cert_id missed the now-attached id
    expect(deletes).toContain('cert-ia-B'); // the orphaned successor is reclaimed, not stranded
    const r1 = await row('renew-idattach');
    expect(r1?.cert_fp_sha256).toBe('ia-A'); // unchanged
    expect(r1?.cert_id).toBe('cert-ia-A'); // the admin's attach stuck

    // Retry: the pre-sign read now sees the attached id, so the swap moves the KNOWN id into prev.
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'cert-ia-C', certificate: fakeCertPem('ia-C'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res2 = await renewCert(reqJson({ csr: 'c2' }), cfEnv, machine('renew-idattach', false, 'ia-A'));
    expect(res2.status).toBe(200);
    const r2 = await row('renew-idattach');
    expect(r2?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('ia-C')));
    expect(r2?.prev_cert_fp_sha256).toBe('ia-A');
    expect(r2?.prev_cert_id).toBe('cert-ia-A'); // known id carried into prev, not a stale NULL
  });

  // CLASS B: the renew CAS pins the FULL observed rotation state (rotationCas). A concurrent change to
  // ANY of the five rotation columns between the pre-sign read and the swap must 409 (no partial pin).
  const rotationFieldFlips: Array<{ field: string; sql: string }> = [
    { field: 'cert_fp_sha256', sql: "UPDATE machines SET cert_fp_sha256 = 'cas-flip' WHERE machine_id = 'cas-box'" },
    { field: 'cert_id', sql: "UPDATE machines SET cert_id = 'cas-flip' WHERE machine_id = 'cas-box'" },
    { field: 'prev_cert_fp_sha256', sql: "UPDATE machines SET prev_cert_fp_sha256 = 'cas-flip' WHERE machine_id = 'cas-box'" },
    { field: 'prev_cert_id', sql: "UPDATE machines SET prev_cert_id = 'cas-flip' WHERE machine_id = 'cas-box'" },
    { field: 'cert_revoke_at', sql: "UPDATE machines SET cert_revoke_at = '2998-01-01T00:00:00.000Z' WHERE machine_id = 'cas-box'" },
  ];
  for (const { field, sql } of rotationFieldFlips) {
    it(`renew 409s when ${field} changes between the read and the swap (full-state CAS)`, async () => {
      await seedMachine('cas-box', { fp: 'cas-cur', certId: 'cas-cid', prevFp: 'cas-prev', prevCertId: 'cas-pid', revokeAt: '2999-01-01T00:00:00.000Z' });
      const deletes: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletes.push(String(input).split('/').pop()!);
          return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ success: true, result: { id: 'cas-new-id', certificate: fakeCertPem('cas-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
      }));
      const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
      const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((s: string) => {
        const stmt = realPrepare(s);
        if (!(s.includes('is_admin FROM machines WHERE machine_id = ?1') && s.includes('prev_cert_id'))) return stmt;
        const realBind = stmt.bind.bind(stmt);
        (stmt as unknown as { bind: (...a: unknown[]) => unknown }).bind = (...args: unknown[]) => {
          const bound = realBind(...(args as [])) as D1PreparedStatement;
          const realFirst = bound.first.bind(bound) as (...a: unknown[]) => Promise<unknown>;
          (bound as unknown as { first: (...a: unknown[]) => Promise<unknown> }).first = async (...fa: unknown[]) => {
            const r = await realFirst(...fa);
            await realPrepare(sql).run(); // flip exactly one rotation field after the read
            return r;
          };
          return bound;
        };
        return stmt;
      });
      const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('cas-box', false, 'cas-cur'));
      spy.mockRestore();
      expect(res.status).toBe(409); // any rotation-field change -> CAS miss -> conflict
      expect(deletes).toContain('cas-new-id'); // the minted successor is reclaimed, not stranded
    });
  }

  it('positive control: renew succeeds when the full rotation state is unchanged', async () => {
    await seedMachine('cas-ok', { fp: 'ok-cur', certId: 'ok-cid', prevFp: 'ok-prev', prevCertId: 'ok-pid', revokeAt: '2999-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'ok-new-id', certificate: fakeCertPem('ok-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('cas-ok', false, 'ok-cur'));
    expect(res.status).toBe(200);
    const r = await row('cas-ok');
    expect(r?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('ok-new')));
    expect(r?.prev_cert_fp_sha256).toBe('ok-cur'); // old current -> prev
    expect(r?.prev_cert_id).toBe('ok-cid'); // its id carried into prev
  });

  it('P1: a grace-slot ADMIN cert cannot renew — 403 and no cert minted', async () => {
    // renew's recovery branch installs the caller's CSR as CURRENT; on the next request that fresh admin
    // cert resolves as admin again — a 7-day re-escalation for whoever holds the retired admin cert. Block
    // it before signing anything.
    await seedMachine('adm-grace', { fp: 'ag-cur', certId: 'ag-cid', prevFp: 'ag-prev', prevCertId: 'ag-pid', revokeAt: '2999-01-01T00:00:00.000Z', isAdmin: true });
    let signCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'DELETE') signCalls++;
      return new Response(JSON.stringify({ success: true, result: { id: 'x', certificate: fakeCertPem('x'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('adm-grace', true, 'ag-prev', 'grace'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('admin_renew_requires_current_cert');
    expect(signCalls).toBe(0); // never reached the CA mint
    expect((await row('adm-grace'))?.cert_fp_sha256).toBe('ag-cur'); // unchanged
  });

  it('P1 positive control: a CURRENT-slot admin cert renews normally', async () => {
    await seedMachine('adm-cur', { fp: 'ac-cur', certId: 'ac-cid', isAdmin: true });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'ac-new-id', certificate: fakeCertPem('ac-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('adm-cur', true, 'ac-cur', 'current'));
    expect(res.status).toBe(200);
    expect((await row('adm-cur'))?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('ac-new')));
  });

  it('P1: a NON-admin grace cert still recovers (the legit lost-response path is unbroken)', async () => {
    await seedMachine('nonadm-grace', { fp: 'ng-cur', certId: 'ng-cid', prevFp: 'ng-prev', prevCertId: 'ng-pid', revokeAt: '2999-01-01T00:00:00.000Z' }); // is_admin 0
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'ng-new-id', certificate: fakeCertPem('ng-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('nonadm-grace', false, 'ng-prev', 'grace'));
    expect(res.status).toBe(200); // recovery on the in-grace prev
    expect((await row('nonadm-grace'))?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('ng-new')));
  });

  it('renew-vs-renew loser (current slot, fp already rotated to prev) 409s instead of recovering', async () => {
    // The loser authed on the CURRENT cert (certSlot 'current'); the winner committed before the loser's
    // pre-sign read, so the loser's fp is now the row's PREV with an open grace window. Without the certSlot
    // gate the loser would take the recovery branch, install a 2nd successor, and queue the winner's fresh
    // cert — locking out the collector that installed the winner. The gate makes it a 409.
    await seedMachine('rvr-loser', { fp: 'winner-fp', certId: 'winner-id', prevFp: 'loser-fp', prevCertId: 'loser-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'rvr-new-id', certificate: fakeCertPem('rvr-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('rvr-loser', false, 'loser-fp', 'current'));
    expect(res.status).toBe(409);
    expect((await row('rvr-loser'))?.cert_fp_sha256).toBe('winner-fp'); // winner's cert intact, NOT replaced
    expect(await retired('winner-fp')).toBeNull(); // winner's cert was NOT queued for revoke
    expect(await retired(await certFingerprint(fakeCertPem('rvr-new')))).not.toBeNull(); // loser's successor reclaimed
  });

  it('recovery-vs-renewal: a grace caller displaced out of the prev slot 409s (stale cert not installed)', async () => {
    // The grace caller's fp was rotated OUT of prev by a concurrent current renewal before the pre-sign
    // read. Requiring cur.prev_cert_fp_sha256 === identity.certFp rejects the now-stale caller instead of
    // installing its successor over the legit new current.
    await seedMachine('rvn', { fp: 'legit-new-cur', certId: 'legit-new-id', prevFp: 'other-prev', prevCertId: 'other-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'rvn-new-id', certificate: fakeCertPem('rvn-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('rvn', false, 'stale-fp', 'grace'));
    expect(res.status).toBe(409);
    expect((await row('rvn'))?.cert_fp_sha256).toBe('legit-new-cur'); // legit current untouched
  });

  it('positive control: a legit grace recovery (fp still the row prev) installs the successor', async () => {
    await seedMachine('rec-ok', { fp: 'orphan-succ', certId: 'orphan-succ-id', prevFp: 'rec-prev', prevCertId: 'rec-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'rec-new-id', certificate: fakeCertPem('rec-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('rec-ok', false, 'rec-prev', 'grace'));
    expect(res.status).toBe(200);
    const r = await row('rec-ok');
    expect(r?.cert_fp_sha256).toBe(await certFingerprint(fakeCertPem('rec-new'))); // successor installed
    expect(r?.prev_cert_fp_sha256).toBe('rec-prev'); // recovery leaves the grace prev untouched
  });

  type LogEvent = { event?: string; result?: string; cert_id?: string };
  const renewLogEvents = (logs: ReturnType<typeof vi.spyOn>): LogEvent[] =>
    logs.mock.calls.map((c: unknown[]) => { try { return JSON.parse(c[0] as string) as LogEvent; } catch { return {} as LogEvent; } });

  it('a malformed signed cert (fingerprint throws) revokes the minted id by hand and 502s', async () => {
    // CF returns success:true but a PEM-less certificate → certFingerprint throws AFTER signed.id exists.
    // No fingerprint means it can't be queued (retired_certs is fp-keyed), so the hub goes straight to a
    // direct revoke of signed.id + a distinct hub.certs.fingerprint_failed event. The machine is untouched.
    await seedMachine('fp-fail', { fp: 'fpf-cur', certId: 'fpf-cid' });
    const deletes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deletes.push(String(input).split('/').pop()!); return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 }); }
      return new Response(JSON.stringify({ success: true, result: { id: 'fpf-new-id', certificate: 'NOT-A-PEM', expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const logs = vi.spyOn(console, 'log');
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('fp-fail', false, 'fpf-cur'));
    const events = renewLogEvents(logs);
    logs.mockRestore();
    expect(res.status).toBe(502);
    expect(events.some((e) => e.event === 'hub.certs.fingerprint_failed')).toBe(true);
    expect(deletes).toContain('fpf-new-id'); // revoked the minted-but-unusable cert by its id
    expect(events.some((e) => e.event === 'hub.certs.orphan_revoke_failed')).toBe(false); // revoke confirmed
    expect((await row('fp-fail'))?.cert_fp_sha256).toBe('fpf-cur'); // machine unchanged
  });

  it('a malformed signed cert whose revoke is REJECTED logs orphan_revoke_failed (result failed)', async () => {
    // Same fingerprint failure, but the direct revoke returns HTTP-200 {success:false} — surfaced as
    // revokeClientCert → 'failed', NOT a throw. revokeOrphanCert must treat that enum the same as a throw
    // and emit the distinct, alertable orphan_revoke_failed so the leaked live cert is actionable.
    await seedMachine('fp-fail2', { fp: 'fpf2-cur', certId: 'fpf2-cid' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: false }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'fpf2-new-id', certificate: 'NOT-A-PEM', expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const logs = vi.spyOn(console, 'log');
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('fp-fail2', false, 'fpf2-cur'));
    const orphan = renewLogEvents(logs).filter((e) => e.event === 'hub.certs.orphan_revoke_failed');
    logs.mockRestore();
    expect(res.status).toBe(502);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.result).toBe('failed'); // success:false surfaced, not swallowed as terminal
    expect(orphan[0]!.cert_id).toBe('fpf2-new-id');
  });
});

describe('POST /api/v1/admin/machines', () => {
  // A cert swap retires the displaced old current/prev into retired_certs and best-effort revokes
  // them, so stub the CF DELETE to succeed. Tests that assert reservation-survives override this.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
  });

  it('403s a non-admin machine cert (positive control: admin succeeds below)', async () => {
    const res = await adminMachines(reqJson({ machine_id: 'x' }), testEnv, machine('nonadmin', false));
    expect(res.status).toBe(403);
  });

  it('upserts a machine and returns the roster for an admin cert', async () => {
    const res = await adminMachines(
      reqJson({ machine_id: 'am-new', os: 'linux', cert_fp_sha256: hexfp('fp-am-new'), is_admin: true, priority: 50, cert_id_unknown: true }),
      testEnv,
      machine('am-admin', true),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { machines: Array<{ machine_id: string }> };
    expect(out.machines.some((m) => m.machine_id === 'am-new')).toBe(true);
    const r = await row('am-new');
    expect(r?.is_admin).toBe(1);
    expect(r?.priority).toBe(50);
    expect(r?.cert_fp_sha256).toBe(hexfp('fp-am-new'));
  });

  it('partial upsert preserves unspecified columns instead of resetting them', async () => {
    await adminMachines(reqJson({ machine_id: 'am-part', os: 'windows', is_admin: true, priority: 20 }), testEnv, machine('am-admin', true));
    await adminMachines(reqJson({ machine_id: 'am-part', priority: 5 }), testEnv, machine('am-admin', true));
    const r = await row('am-part');
    expect(r?.priority).toBe(5); // updated
    expect(r?.os).toBe('windows'); // preserved
    expect(r?.is_admin).toBe(1); // preserved
  });

  it('422s a string is_admin flag instead of granting admin by truthiness', async () => {
    // A full-row form serializing is_admin as the string "false" is truthy — accepting it would store 1
    // and GRANT admin. Require an actual boolean; reject the string before any write.
    const res = await adminMachines(reqJson({ machine_id: 'ia-str', is_admin: 'false' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_is_admin');
    expect(await row('ia-str')).toBeNull(); // never created
  });

  it('is_admin: false CLEARS the admin flag (positive control: true sets it)', async () => {
    await adminMachines(reqJson({ machine_id: 'ia-clear', is_admin: true, priority: 4 }), testEnv, machine('am-admin', true));
    expect((await row('ia-clear'))?.is_admin).toBe(1); // set by boolean true
    await adminMachines(reqJson({ machine_id: 'ia-clear', is_admin: false }), testEnv, machine('am-admin', true));
    expect((await row('ia-clear'))?.is_admin).toBe(0); // cleared by boolean false, not left truthy
  });

  it('409s a duplicate CURRENT fingerprint (explicit pre-check, not a UNIQUE-violation catch)', async () => {
    await adminMachines(reqJson({ machine_id: 'am-a', cert_fp_sha256: hexfp('fp-dup'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    const res = await adminMachines(reqJson({ machine_id: 'am-b', cert_fp_sha256: hexfp('fp-dup') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('fingerprint_in_use');
  });

  it("409s a fingerprint that is another machine's IN-GRACE previous cert (UNIQUE index misses this axis)", async () => {
    await seedMachine('am-grace', { fp: 'am-grace-cur', prevFp: hexfp('am-grace-prev'), prevCertId: 'x', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-other', cert_fp_sha256: hexfp('am-grace-prev') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { machine_id: string }).machine_id).toBe('am-grace');
  });

  it('resets rotation metadata when the current fingerprint changes (prune then finds nothing to revoke)', async () => {
    await seedMachine('am-rot', { fp: 'am-rot-cur', certId: 'am-rot-certid', prevFp: 'am-rot-prev', prevCertId: 'am-rot-previd', revokeAt: '2000-01-01T00:00:00.000Z' });
    await adminMachines(reqJson({ machine_id: 'am-rot', cert_fp_sha256: hexfp('am-rot-new'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    const r = await row('am-rot');
    expect(r?.cert_fp_sha256).toBe(hexfp('am-rot-new'));
    expect(r?.cert_id).toBeNull(); // no body cert_id given -> reset to NULL
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace window cleared -> prune's WHERE won't match
    expect(r?.prev_cert_id).toBeNull();
    expect(r?.cert_revoke_at).toBeNull();
  });

  it('rollback: setting cert_fp back to the in-grace prev clears the window so prune never revokes the reinstated cert', async () => {
    await seedMachine('am-rollback', { fp: 'rb-B', certId: 'cert-rb-B', prevFp: hexfp('rb-A'), prevCertId: 'cert-rb-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-rollback', cert_fp_sha256: hexfp('rb-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-rollback');
    expect(r?.cert_fp_sha256).toBe(hexfp('rb-A')); // reinstated as current
    expect(r?.prev_cert_fp_sha256).toBeNull(); // no longer scheduled for revoke
    expect(r?.cert_revoke_at).toBeNull();
  });

  it('interleave: a prune draining the in-grace prev between read and swap 409s the rollback (widened CAS)', async () => {
    // Admin rolls am-race back to its in-grace prev rb2-A. Between adminMachines reading the row and its
    // swap, runDailyPrune drains rb2-A into retired_certs (reserved) and clears the prev/revoke columns.
    // The widened CAS (prev_cert_fp_sha256 + cert_revoke_at, not just current) must MISS so we 409 rather
    // than reinstate a just-queued cert the same prune would then revoke. The machine keeps its working
    // current cert; the reservation is left for the prune to revoke.
    await seedMachine('am-race', { fp: 'rb2-B', certId: 'cert-rb2-B', prevFp: hexfp('rb2-A'), prevCertId: 'cert-rb2-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementationOnce(async (stmts) => {
      // The "prune" fires after the row read but before this swap commits.
      await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('rb2-A')}', 'cert-rb2-A', 'am-race', '2000-01-01T00:00:00.000Z')`).run();
      await testEnv.DB.prepare("UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL WHERE machine_id = 'am-race'").run();
      return realBatch(stmts);
    });
    const res = await adminMachines(reqJson({ machine_id: 'am-race', cert_fp_sha256: hexfp('rb2-A') }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('concurrent_rotation');
    const r = await row('am-race');
    expect(r?.cert_fp_sha256).toBe('rb2-B'); // NOT rolled back onto the just-queued cert
    expect((await retired(hexfp('rb2-A')))?.revoked_at).toBeNull(); // reservation intact for the prune to revoke
  });

  it('rollback atomically un-queues a reservation of the reinstated fp created after the clash pre-check', async () => {
    // The clash pre-check passes (rb3-A not yet queued); then a prune queues rb3-A into retired_certs
    // (reserved) before the swap. Reinstating rb3-A as current must DELETE that reservation in the SAME
    // batch as the swap — otherwise the prune's drain revokes the now-current cert. Guarded on the swap
    // having landed, so a CAS miss would delete nothing.
    await seedMachine('am-unq', { fp: 'rb3-B', certId: 'cert-rb3-B', prevFp: hexfp('rb3-A'), prevCertId: 'cert-rb3-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    let batchLen = 0;
    const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementationOnce(async (stmts) => {
      batchLen = stmts.length;
      await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('rb3-A')}', 'cert-rb3-A', 'am-unq', '2000-01-01T00:00:00.000Z')`).run();
      return realBatch(stmts);
    });
    const res = await adminMachines(reqJson({ machine_id: 'am-unq', cert_fp_sha256: hexfp('rb3-A') }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect((await row('am-unq'))?.cert_fp_sha256).toBe(hexfp('rb3-A')); // reinstated as current
    expect(await retired(hexfp('rb3-A'))).toBeNull(); // reservation removed atomically with the swap
    expect((await retired('rb3-B'))?.revoked_at).toBeNull(); // old current queued as usual
    expect(batchLen).toBe(4); // swap + retire(old current rb3-B) + carry-id + un-queue(rb3-A)
  });

  it('positive control: a normal rollback with no stale reservation leaves the un-queue a no-op', async () => {
    await seedMachine('am-unq2', { fp: 'rb4-B', certId: 'cert-rb4-B', prevFp: hexfp('rb4-A'), prevCertId: 'cert-rb4-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-unq2', cert_fp_sha256: hexfp('rb4-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-unq2');
    expect(r?.cert_fp_sha256).toBe(hexfp('rb4-A')); // reinstated
    expect(r?.cert_id).toBe('cert-rb4-A'); // carried from prev_cert_id
    expect(r?.prev_cert_fp_sha256).toBeNull();
    expect(await retired(hexfp('rb4-A'))).toBeNull(); // nothing to un-queue; still absent
    expect((await retired('rb4-B'))?.cert_id).toBe('cert-rb4-B'); // old current queued as before
  });

  it('un-queue carries the reservation cert_id when the incoming rollback id is NULL (never silently drops it)', async () => {
    // Finding (b): a reinstated fp whose reservation holds the ONLY copy of its cert_id. The clash
    // pre-check passes (bk-A not yet queued); a prune then queues bk-A WITH its CA id (and had cleared
    // the prev slot) before the swap, so the handler computes cert_id = NULL. The un-queue must carry the
    // reservation's id into machines.cert_id in the same batch, or the reinstated cert is unrevocable.
    await seedMachine('am-carry', { fp: 'bk-B', certId: 'cert-bk-B' }); // current bk-B, no prev
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementationOnce(async (stmts) => {
      await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('bk-A')}', 'cert-bk-A', 'am-carry', '2000-01-01T00:00:00.000Z')`).run();
      return realBatch(stmts);
    });
    const res = await adminMachines(reqJson({ machine_id: 'am-carry', cert_fp_sha256: hexfp('bk-A'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(200);
    const r = await row('am-carry');
    expect(r?.cert_fp_sha256).toBe(hexfp('bk-A')); // reinstated as current
    expect(r?.cert_id).toBe('cert-bk-A'); // carried from the reservation, NOT silently NULL
    expect(await retired(hexfp('bk-A'))).toBeNull(); // reservation consumed by the un-queue
    expect((await retired('bk-B'))?.cert_id).toBe('cert-bk-B'); // displaced old current queued
  });

  it('rollback 409s when the reinstated fp is CLAIMED by a mid-revoke prune (machine keeps its current cert)', async () => {
    // The clash pre-check passes (cl-A not yet queued); then a prune queues AND claims cl-A (stamps
    // claimed_at right before its async CA revoke) before the swap. Reinstating a cert the drain is
    // mid-revoke of would race the DELETE, so the CAS's NOT EXISTS(...claimed_at IS NOT NULL) makes it
    // 409 — the admin re-reads reality after the drain settles, keeping the machine on its working cert.
    await seedMachine('am-claimed', { fp: 'cl-B', certId: 'cert-cl-B', prevFp: hexfp('cl-A'), prevCertId: 'cert-cl-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementationOnce(async (stmts) => {
      await testEnv.DB.prepare(
        `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at, claimed_at) VALUES ('${hexfp('cl-A')}', 'cert-cl-A', 'am-claimed', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      ).run();
      return realBatch(stmts);
    });
    const res = await adminMachines(reqJson({ machine_id: 'am-claimed', cert_fp_sha256: hexfp('cl-A') }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('concurrent_rotation');
    expect((await row('am-claimed'))?.cert_fp_sha256).toBe('cl-B'); // NOT reinstated onto the cert being revoked
    expect((await retired(hexfp('cl-A')))?.claimed_at).not.toBeNull(); // reservation still claimed; the drain proceeds
  });

  it('a CAS-losing admin swap queues nothing, even when the winner installed the same requested fp', async () => {
    // The dangerous case the post-swap guard closes: a winner installs the SAME fp cw-C we requested (so a
    // current==newFp-only guard would match), but in a DIFFERENT full state (its own cert_id). Our retire
    // INSERTs are guarded on OUR exact post-swap state, so they queue nothing — we never reserve the old
    // current/prev the winner may still be using. And our CAS (full state) misses, so we 409.
    await seedMachine('am-lose', { fp: 'cw-A', certId: 'cw-A-id', prevFp: 'cw-B', prevCertId: 'cw-B-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const realBatch = testEnv.DB.batch.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'batch').mockImplementationOnce(async (stmts) => {
      // Winner lands cw-C as current with ITS OWN cert_id, between our read and our swap.
      await testEnv.DB.prepare(
        `UPDATE machines SET cert_fp_sha256='${hexfp('cw-C')}', cert_id='winner-id', prev_cert_fp_sha256=NULL, prev_cert_id=NULL, cert_revoke_at=NULL WHERE machine_id='am-lose'`,
      ).run();
      return realBatch(stmts);
    });
    const res = await adminMachines(reqJson({ machine_id: 'am-lose', cert_fp_sha256: hexfp('cw-C'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409); // lost the full-state CAS
    expect(await retired('cw-A')).toBeNull(); // NOT queued by the loser
    expect(await retired('cw-B')).toBeNull(); // NOT queued by the loser
    const r = await row('am-lose');
    expect(r?.cert_fp_sha256).toBe(hexfp('cw-C'));
    expect(r?.cert_id).toBe('winner-id'); // winner's state intact
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
    await seedMachine('am-exp', { fp: 'am-exp-cur', prevFp: hexfp('am-exp-prev'), prevCertId: 'am-exp-previd', revokeAt: '2000-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-exp-other', cert_fp_sha256: hexfp('am-exp-prev') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { machine_id: string }).machine_id).toBe('am-exp');
  });

  it('409s a fingerprint still reserved in the retired_certs queue (revoke not yet confirmed)', async () => {
    // A displaced cert whose CA revoke hasn't landed lives in the queue with revoked_at NULL. It's
    // unclaimable regardless of cert_id (unknown-id legacy cert here), because the old cert may still
    // authenticate at the CA. This is the durable reservation that replaced the round-4 prev tombstone.
    await testEnv.DB.prepare(
      `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('q-reserved-fp')}', NULL, 'q-owner', '2000-01-01T00:00:00.000Z')`,
    ).run();
    const res = await adminMachines(reqJson({ machine_id: 'q-claimant', cert_fp_sha256: hexfp('q-reserved-fp') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('fingerprint_in_use');
  });

  it('allows a fingerprint once its retired_certs entry is confirmed revoked', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at, revoked_at) VALUES ('${hexfp('q-done-fp')}', 'q-done-id', 'q-owner', '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z')`,
    ).run();
    const res = await adminMachines(reqJson({ machine_id: 'q-done-claimant', cert_fp_sha256: hexfp('q-done-fp'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    expect((await row('q-done-claimant'))?.cert_fp_sha256).toBe(hexfp('q-done-fp'));
  });

  it('409s a body cert_id already owned as another machine\'s current cert_id', async () => {
    // A CA id is a REVOKE handle. Attaching machine A's id to B would make B's next rotation revoke A's
    // live cert (an A-side lockout). Reject before any write.
    await seedMachine('idown-a', { fp: 'ida-fp', certId: 'shared-cid' });
    const res = await adminMachines(reqJson({ machine_id: 'idown-b', cert_fp_sha256: hexfp('idb-fp'), cert_id: 'shared-cid' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string; machine_id: string }).error).toBe('cert_id_in_use');
    expect(await row('idown-b')).toBeNull(); // B never created
  });

  it('409s a body cert_id already owned as another machine\'s prev_cert_id', async () => {
    await seedMachine('idprev-a', { fp: 'idpa-cur', certId: 'idpa-cur-id', prevFp: 'idpa-prev', prevCertId: 'shared-prev-cid', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'idprev-b', cert_fp_sha256: hexfp('idpb-fp'), cert_id: 'shared-prev-cid' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_in_use');
  });

  it('409s a body cert_id sitting in an un-revoked retired_certs row (mid-revocation)', async () => {
    await testEnv.DB.prepare("INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('idq-fp', 'queued-cid', 'idq-owner', '2000-01-01T00:00:00.000Z')").run();
    const res = await adminMachines(reqJson({ machine_id: 'idq-b', cert_fp_sha256: hexfp('idqb-fp'), cert_id: 'queued-cid' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_in_use');
  });

  it('409s a body cert_id present in retired_certs even when already REVOKED (dead handle)', async () => {
    // A confirmed-revoked id is a DEAD CA handle. Attaching it to a fresh fp would let a later prune poll
    // that id, stamp the fresh reservation revoked, and free a still-live fingerprint. The id clash check
    // is not filtered on revoked_at: an id in retired_certs AT ALL is unusable.
    await testEnv.DB.prepare("INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at, revoked_at) VALUES ('idr-fp', 'revoked-cid', 'idr-owner', '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z')").run();
    const res = await adminMachines(reqJson({ machine_id: 'idr-b', cert_fp_sha256: hexfp('idrb-fp'), cert_id: 'revoked-cid' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_in_use');
    expect(await row('idr-b')).toBeNull(); // never created
  });

  it('409s a fp-change that reuses THIS row\'s own current cert_id (displaced-cert handle)', async () => {
    // fp changes to a brand-new cert but the body reuses the OLD current's id — the swap would retire the
    // displaced old current under that same id while also storing it on the new current: a dead/wrong
    // handle on a live cert. cert_id_belongs_to_displaced_cert, distinct from cert_id_in_use.
    await seedMachine('iddis-cur', { fp: 'idc-old', certId: 'idc-old-id' });
    const res = await adminMachines(reqJson({ machine_id: 'iddis-cur', cert_fp_sha256: hexfp('idc-new'), cert_id: 'idc-old-id' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_belongs_to_displaced_cert');
    expect((await row('iddis-cur'))?.cert_fp_sha256).toBe('idc-old'); // unchanged
  });

  it('409s a NON-rollback fp-change that reuses THIS row\'s own prev cert_id', async () => {
    // New fp is NOT the in-grace prev (so it's not a rollback), but the body reuses the prev's id — the
    // displaced prev would be retired under an id now also on the new current. Reject.
    await seedMachine('iddis-prev', { fp: 'idp-cur', certId: 'idp-cur-id', prevFp: 'idp-prev', prevCertId: 'idp-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'iddis-prev', cert_fp_sha256: hexfp('idp-brandnew'), cert_id: 'idp-prev-id' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_belongs_to_displaced_cert');
  });

  it('positive control: a rollback to the in-grace prev fp MAY reuse that prev\'s own id', async () => {
    // The one legit reuse: new fp IS the in-grace prev fp AND the body id IS that prev's id — reinstating
    // the prev with its live handle. Accepted.
    await seedMachine('idroll', { fp: 'idroll-cur', certId: 'idroll-cur-id', prevFp: hexfp('idroll-prev'), prevCertId: 'idroll-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'idroll', cert_fp_sha256: hexfp('idroll-prev'), cert_id: 'idroll-prev-id' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('idroll');
    expect(r?.cert_fp_sha256).toBe(hexfp('idroll-prev')); // rolled back
    expect(r?.cert_id).toBe('idroll-prev-id'); // its own live handle reattached
  });

  it('409s a SAME-fp edit that supplies this row\'s own prev_cert_id (guard not gated on fpChanged)', async () => {
    // Machine still has an in-grace prev. An unchanged-fp edit supplies cert_id == prev_cert_id: it would
    // store the prev's handle on the current fp while it still sits on the prev slot, so the next
    // rotation/prune revokes it out from under the live current. Rejected even though the fp didn't change.
    await seedMachine('samefp-prev', { fp: hexfp('sfp-cur'), certId: 'sfp-cur-id', prevFp: 'sfp-prev', prevCertId: 'sfp-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'samefp-prev', cert_fp_sha256: hexfp('sfp-cur'), cert_id: 'sfp-prev-id' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_belongs_to_displaced_cert');
    expect((await row('samefp-prev'))?.cert_id).toBe('sfp-cur-id'); // unchanged
  });

  it('allows a SAME-fp edit to re-supply this row\'s OWN current cert_id (idempotent)', async () => {
    await seedMachine('samefp-cur', { fp: hexfp('sfc-cur'), certId: 'sfc-cur-id', prevFp: 'sfc-prev', prevCertId: 'sfc-prev-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'samefp-cur', cert_fp_sha256: hexfp('sfc-cur'), cert_id: 'sfc-cur-id', priority: 5 }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('samefp-cur');
    expect(r?.cert_id).toBe('sfc-cur-id'); // preserved
    expect(r?.prev_cert_fp_sha256).toBe('sfc-prev'); // same-fp edit leaves the grace window intact
    expect(r?.priority).toBe(5);
  });

  it('verifies an admin-supplied cert_id against the CA and 200s on a matching fingerprint', async () => {
    // With CF creds configured, the endpoint fetches the cert by id and compares ITS fingerprint to the
    // one being attached. A match is accepted and stored.
    const fp = await certFingerprint(fakeCertPem('ver-match'));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ver-id')) return new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('ver-match'), status: 'active' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }));
    const res = await adminMachines(reqJson({ machine_id: 'ver-ok', cert_fp_sha256: fp, cert_id: 'ver-id' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    expect((await row('ver-ok'))?.cert_id).toBe('ver-id');
  });

  it('422s when the supplied cert_id resolves to a DIFFERENT fingerprint at the CA', async () => {
    const fp = await certFingerprint(fakeCertPem('ver-want'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('ver-other'), status: 'active' } }), { status: 200 })));
    const res = await adminMachines(reqJson({ machine_id: 'ver-mismatch', cert_fp_sha256: fp, cert_id: 'wrong-id' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_fingerprint_mismatch');
    expect(await row('ver-mismatch')).toBeNull(); // rejected before any write
  });

  it('422s when the supplied cert_id is not resolvable at the CA (404)', async () => {
    const fp = await certFingerprint(fakeCertPem('ver-404'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 404 })));
    const res = await adminMachines(reqJson({ machine_id: 'ver-nf', cert_fp_sha256: fp, cert_id: 'ghost-id' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_fingerprint_mismatch');
  });

  it('422s when the cert_id\'s fingerprint matches but the CA cert is already pending_revocation', async () => {
    // A fp-matching id whose CA status is not active would install the machine on a dying cert. Reject it
    // with the status in the error, even though the fingerprint verified.
    const fp = await certFingerprint(fakeCertPem('ver-dying'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('ver-dying'), status: 'pending_revocation' } }), { status: 200 })));
    const res = await adminMachines(reqJson({ machine_id: 'ver-dying-m', cert_fp_sha256: fp, cert_id: 'dying-id' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe('cert_id_not_active');
    expect(body.status).toBe('pending_revocation');
    expect(await row('ver-dying-m')).toBeNull(); // not stored
  });

  it('503s a GENUINELY-NEW cert_id attach when CF creds are unconfigured (fail closed, not stored)', async () => {
    // The pre-secret deploy window: an admin poke could slip an arbitrary/dead handle in unverified. We
    // can't reach the CA to verify, so we fail closed with 503 (the request may be valid — we just can't
    // confirm it yet) rather than accept it. testEnv has no CF_ZONE_ID/CF_CLIENT_CERT_TOKEN.
    await seedMachine('nc-attach', { fp: hexfp('nc-fp') }); // certId omitted -> NULL
    const res = await adminMachines(reqJson({ machine_id: 'nc-attach', cert_fp_sha256: hexfp('nc-fp'), cert_id: 'nc-new-id' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_verification_unavailable');
    expect((await row('nc-attach'))?.cert_id).toBeNull(); // NOT stored unverified
  });

  it('rolls back via the row\'s OWN prev_cert_id WITHOUT CF creds (trusted D1 state needs no CA reach)', async () => {
    // Positive control for the fail-closed gate: a rollback carries cert_id from prev_cert_id, which is
    // this machine's own trusted D1 state, so it is NOT a genuinely-new attach and never reaches the CA.
    // It must succeed even with no CF creds — the same deploy window the 503 above guards.
    await seedMachine('rbnc', { fp: hexfp('rbnc-B'), certId: 'rbnc-B-id', prevFp: hexfp('rbnc-A'), prevCertId: 'rbnc-A-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'rbnc', cert_fp_sha256: hexfp('rbnc-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('rbnc');
    expect(r?.cert_fp_sha256).toBe(hexfp('rbnc-A'));
    expect(r?.cert_id).toBe('rbnc-A-id'); // carried from prev_cert_id, no CA verification needed
  });

  it('idempotent resubmit of the row\'s OWN current cert_id WITHOUT CF creds does not 503', async () => {
    // Re-POSTing the id already stored on this row is not a genuinely-new attach (equals existing cert_id),
    // so the fail-closed gate is skipped and it succeeds without CF creds.
    await seedMachine('idem', { fp: hexfp('idem-fp'), certId: 'idem-cid' });
    const res = await adminMachines(reqJson({ machine_id: 'idem', cert_fp_sha256: hexfp('idem-fp'), cert_id: 'idem-cid', priority: 9 }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('idem');
    expect(r?.cert_id).toBe('idem-cid');
    expect(r?.priority).toBe(9);
  });

  it('422s an empty-string cert_id before it can be stored', async () => {
    // A full-row form serializing a blank cert-id field as '' must be rejected, not stored — a '' id reads
    // as "missing" to settleRetired/prune, so the real CA cert never gets revoked.
    const res = await adminMachines(reqJson({ machine_id: 'empty-cid', cert_fp_sha256: hexfp('ec-fp'), cert_id: '' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_cert_id');
    expect(await row('empty-cid')).toBeNull(); // never created
  });

  it('422s a malformed (empty) cert_fp_sha256 before it can trigger a swap', async () => {
    // A blank fingerprint field would otherwise be treated as the effective new current fp, retiring and
    // revoking the real certs while storing a value no mTLS fingerprint can match — a permanent lockout.
    const res = await adminMachines(reqJson({ machine_id: 'empty-fp', cert_fp_sha256: '' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_cert_fp');
    expect(await row('empty-fp')).toBeNull(); // never created
  });

  it('accepts an UPPERCASE 64-hex cert_fp_sha256 and stores it normalized to lowercase', async () => {
    // mTLS fingerprints arrive lowercase; accept an uppercase-typed valid fp but store it lowercase so it
    // matches request.cf.tlsClientAuth.certFingerprintSHA256.
    const upper = hexfp('upper-fp').toUpperCase();
    const res = await adminMachines(reqJson({ machine_id: 'upper-fp-m', cert_fp_sha256: upper, cert_id_unknown: true }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    expect((await row('upper-fp-m'))?.cert_fp_sha256).toBe(hexfp('upper-fp')); // stored lowercase
  });

  it('422s a NEW admin fingerprint installed without a cert_id (no NULL-handle orphan)', async () => {
    // Swapping to a brand-new fp with no cert_id would store a NULL CA handle; the displaced old current then
    // rides to prev/retired with a null id the prune skips, stranding a CA-valid cert. Require the id.
    await seedMachine('newfp-noid', { fp: hexfp('nfn-cur'), certId: 'nfn-cur-id' });
    const res = await adminMachines(reqJson({ machine_id: 'newfp-noid', cert_fp_sha256: hexfp('nfn-new') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_required_for_new_fp');
    expect((await row('newfp-noid'))?.cert_fp_sha256).toBe(hexfp('nfn-cur')); // unchanged
  });

  it('cert_id_unknown:true installs a NEW fp with a NULL handle and logs a distinct event (legacy import)', async () => {
    // The explicit legacy/unknown-id escape hatch: deliberately store NULL for a real M3-era cert with no
    // recorded id, log a greppable event, and leave the displaced cert's cleanup manual.
    await seedMachine('newfp-unknown', { fp: hexfp('nfu-cur'), certId: 'nfu-cur-id' });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    const res = await adminMachines(reqJson({ machine_id: 'newfp-unknown', cert_fp_sha256: hexfp('nfu-new'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(200);
    const r = await row('newfp-unknown');
    expect(r?.cert_fp_sha256).toBe(hexfp('nfu-new'));
    expect(r?.cert_id).toBeNull(); // deliberately NULL for a legacy import
    const events = logs.map((l) => JSON.parse(l) as { event: string });
    expect(events.some((e) => e.event === 'hub.admin.machines.cert_id_unknown_install')).toBe(true);
    expect((await retired(hexfp('nfu-cur')))?.cert_id).toBe('nfu-cur-id'); // displaced old current still reserved
  });

  it('422s a non-boolean cert_id_unknown (string-flag footgun, same class as is_admin)', async () => {
    const res = await adminMachines(reqJson({ machine_id: 'ciu-str', cert_fp_sha256: hexfp('ciu-new'), cert_id_unknown: 'false' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_cert_id_unknown');
    expect(await row('ciu-str')).toBeNull();
  });

  it('a RELEASED (unclaimed) same-machine reservation lets a rollback recover via unqueue', async () => {
    // Recovery path: a CA DELETE was rejected, so pollRetired released claimed_at (revoked_at still NULL).
    // The admin rollback to that same fingerprint must NOT 409 on the generic clash — its own unclaimed
    // reservation is excluded, so it falls through to the same-machine unqueue/CAS which claims + removes it.
    await seedMachine('rbrec', { fp: hexfp('rbrec-B'), certId: 'rbrec-B-id', prevFp: hexfp('rbrec-A'), prevCertId: 'rbrec-A-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('rbrec-A')}', 'rbrec-A-id', 'rbrec', '2000-01-01T00:00:00.000Z')`).run(); // unclaimed
    const res = await adminMachines(reqJson({ machine_id: 'rbrec', cert_fp_sha256: hexfp('rbrec-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('rbrec');
    expect(r?.cert_fp_sha256).toBe(hexfp('rbrec-A')); // reinstated
    expect(r?.cert_id).toBe('rbrec-A-id'); // carried from the reservation/prev
    expect(await retired(hexfp('rbrec-A'))).toBeNull(); // reservation unqueued atomically with the swap
  });

  it('a CLAIMED same-machine reservation still 409s (prune mid-revoke; reinstating would race the DELETE)', async () => {
    await seedMachine('rbclaim', { fp: hexfp('rbc-B'), certId: 'rbc-B-id', prevFp: hexfp('rbc-A'), prevCertId: 'rbc-A-id', revokeAt: '2999-01-01T00:00:00.000Z' });
    await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at, claimed_at) VALUES ('${hexfp('rbc-A')}', 'rbc-A-id', 'rbclaim', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`).run();
    const res = await adminMachines(reqJson({ machine_id: 'rbclaim', cert_fp_sha256: hexfp('rbc-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('fingerprint_in_use');
    expect((await row('rbclaim'))?.cert_fp_sha256).toBe(hexfp('rbc-B')); // unchanged
  });

  it('a cross-machine unclaimed reservation still 409s (only the SAME machine is excluded)', async () => {
    await testEnv.DB.prepare(`INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('${hexfp('xmach-fp')}', 'xmach-id', 'other-machine', '2000-01-01T00:00:00.000Z')`).run();
    const res = await adminMachines(reqJson({ machine_id: 'xmach-claimant', cert_fp_sha256: hexfp('xmach-fp') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(409); // generic clash still fires (before the new-fp cert_id guard)
    expect(((await res.json()) as { error: string }).error).toBe('fingerprint_in_use');
  });

  it('422s a body cert_id supplied with NO fingerprint to bind it to', async () => {
    // Row has no cert and the body omits cert_fp_sha256 → certFp is null. Storing the id would leave an
    // unbound handle a later fp-set silently drops, stranding the minted cert live-but-untracked.
    const res = await adminMachines(reqJson({ machine_id: 'bare-id', cert_id: 'orphan-handle' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('cert_id_requires_fingerprint');
    expect(await row('bare-id')).toBeNull(); // never created
  });

  it('positive control: a body cert_id owned by NO other row attaches cleanly', async () => {
    const fp = await certFingerprint(fakeCertPem('idfree'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('idfree'), status: 'active' } }), { status: 200 })));
    const res = await adminMachines(reqJson({ machine_id: 'idfree-b', cert_fp_sha256: fp, cert_id: 'fresh-unique-cid' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    expect((await row('idfree-b'))?.cert_id).toBe('fresh-unique-cid');
  });

  it("allows re-supplying a machine's OWN existing cert_id (self is not a clash)", async () => {
    await seedMachine('idself', { fp: hexfp('idself-fp'), certId: 'idself-cid' });
    const res = await adminMachines(reqJson({ machine_id: 'idself', cert_fp_sha256: hexfp('idself-fp'), cert_id: 'idself-cid' }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200); // the ownership check excludes machine_id == this row
    expect((await row('idself'))?.cert_id).toBe('idself-cid');
  });

  it('an admin cert swap reserves BOTH the displaced current and prev in the queue', async () => {
    // fp swap to a brand-new cert: old current AND old prev leave the row's slots. Both must be
    // reserved in the queue, or another machine could claim a still-CA-valid fingerprint. (The revoke
    // is async — the stub returns pending_revocation — so revoked_at stays NULL until a prune poll.)
    await seedMachine('am-swap', { fp: 'swap-cur', certId: 'cert-swap-cur', prevFp: 'swap-prev', prevCertId: 'cert-swap-prev', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-swap', cert_fp_sha256: hexfp('swap-new'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-swap');
    expect(r?.cert_fp_sha256).toBe(hexfp('swap-new'));
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace window cleared
    expect((await retired('swap-cur'))?.cert_id).toBe('cert-swap-cur'); // reserved
    expect((await retired('swap-prev'))?.cert_id).toBe('cert-swap-prev'); // reserved
  });

  it('reserves a NULL-id (pre-M4) current cert on an admin swap — unknown id is not treated as revoked', async () => {
    // Helper-enrolled row: cert_fp set, cert_id NULL, no prev. Swapping its fp must still queue the
    // old current, or a possibly-still-CA-valid legacy cert is dropped untracked and reclaimable.
    await seedMachine('am-nullid', { fp: hexfp('nullid-old') }); // certId + prev omitted -> NULL
    const res = await adminMachines(reqJson({ machine_id: 'am-nullid', cert_fp_sha256: hexfp('nullid-new'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    expect((await row('am-nullid'))?.cert_fp_sha256).toBe(hexfp('nullid-new'));
    const q = await retired(hexfp('nullid-old'));
    expect(q).not.toBeNull(); // queued despite the NULL id
    expect(q?.cert_id).toBeNull();
    expect(q?.revoked_at).toBeNull(); // unknown id -> reserved forever (until manual cleanup)
    // and it stays unclaimable by another machine
    const clash = await adminMachines(reqJson({ machine_id: 'am-nullid-other', cert_fp_sha256: hexfp('nullid-old') }), testEnv, machine('am-admin', true));
    expect(clash.status).toBe(409);
  });

  it('rolling back to the in-grace prev fp carries its cert id and queues only the displaced old current', async () => {
    // Rollback: current goes back to the in-grace prev fp. Its CA id (prev_cert_id) must move into
    // cert_id. Only the OLD current is displaced (the reinstated prev becomes current, not retired).
    await seedMachine('am-rbid', { fp: 'rbid-B', certId: 'cert-rbid-B', prevFp: hexfp('rbid-A'), prevCertId: 'cert-rbid-A', revokeAt: '2999-01-01T00:00:00.000Z' });
    const res = await adminMachines(reqJson({ machine_id: 'am-rbid', cert_fp_sha256: hexfp('rbid-A') }), testEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-rbid');
    expect(r?.cert_fp_sha256).toBe(hexfp('rbid-A'));
    expect(r?.cert_id).toBe('cert-rbid-A'); // carried over from prev_cert_id, not dropped to NULL
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace window cleared
    expect((await retired('rbid-B'))?.cert_id).toBe('cert-rbid-B'); // old current queued
    expect(await retired(hexfp('rbid-A'))).toBeNull(); // reinstated prev is current, NOT retired
  });

  it('attaches a body cert_id to an already-registered fingerprint (unchanged fp)', async () => {
    // A helper-enrolled row has cert_fp but a NULL cert_id. An admin re-POSTs the same fp with the CA
    // id to attach it; the write must honor body.cert_id even though the fingerprint didn't change.
    const fp = await certFingerprint(fakeCertPem('am-attach'));
    await seedMachine('am-attach', { fp }); // certId omitted -> NULL
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: { certificate: fakeCertPem('am-attach'), status: 'active' } }), { status: 200 })));
    const res = await adminMachines(reqJson({ machine_id: 'am-attach', cert_fp_sha256: fp, cert_id: 'attach-id' }), cfEnv, machine('am-admin', true));
    expect(res.status).toBe(200);
    const r = await row('am-attach');
    expect(r?.cert_fp_sha256).toBe(fp); // unchanged
    expect(r?.cert_id).toBe('attach-id'); // newly attached
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
    const res = await adminMachines(reqJson({ machine_id: 'race-new', cert_fp_sha256: hexfp('race-loser-fp'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
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
    const res = await adminMachines(reqJson({ machine_id: 'cas-race', cert_fp_sha256: hexfp('cas-C'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('concurrent_rotation');
    expect((await row('cas-race'))?.cert_fp_sha256).toBe('cas-B'); // renewed cert survived
    // CAS miss => the guarded retirement INSERTs in the same batch queued nothing.
    expect(await retired('cas-A')).toBeNull();
  });
});

describe('POST /api/v1/heartbeat collector-event relay', () => {
  function hbReq(events: unknown[]): Request {
    return new Request('https://api.sessions.vza.net/api/v1/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ collector_version: 'test', events }),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('nests collector-supplied fields under payload so a collector cannot forge a hub event', async () => {
    // A malicious/buggy collector puts event:'hub.certs.cf_auth_failed' + machine:'evil' in its event.
    // The relayed log line must keep event='collector.event' (hub-set) and machine from the cert identity;
    // the forged values can only ever appear INSIDE payload, where the alert queries never read them.
    await seedMachine('hb-spoof', { fp: hexfp('hb-fp') });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    const res = await heartbeat(
      hbReq([{ level: 'error', code: 'c', message: 'm', event: 'hub.certs.cf_auth_failed', machine: 'evil' }]),
      testEnv,
      machine('hb-spoof'),
    );
    spy.mockRestore();
    expect(res.status).toBe(200);
    const parsed = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const relayed = parsed.find((o) => o.event === 'collector.event') as { event: string; machine: string; payload: Record<string, unknown> };
    expect(relayed.event).toBe('collector.event'); // hub-controlled, NOT the forged value
    expect(relayed.machine).toBe('hb-spoof'); // from the cert identity, NOT 'evil'
    expect(relayed.payload.event).toBe('hub.certs.cf_auth_failed'); // forged value quarantined in payload
    expect(relayed.payload.level).toBe('error'); // real collector fields still present under payload
    // positive control: NO emitted line carries the forged event at top level (nothing to page on)
    expect(parsed.some((o) => o.event === 'hub.certs.cf_auth_failed')).toBe(false);
  });
});

describe('daily prune (cert revoke)', () => {
  // runDailyPrune scans the WHOLE machines table AND drains the WHOLE retired_certs queue, so clear
  // both first — otherwise a due row or a reserved queue entry left by an earlier test would be
  // revoked by this test's stub and throw off its call-count assertions.
  beforeEach(async () => {
    await testEnv.DB.prepare('UPDATE machines SET prev_cert_fp_sha256 = NULL, prev_cert_id = NULL, cert_revoke_at = NULL').run();
    await testEnv.DB.prepare('DELETE FROM retired_certs').run();
  });

  // Models the CF managed-CA cert lifecycle: GET returns the cert's current status (404 if absent);
  // DELETE moves it to `deleteTo` (default the realistic async 'pending_revocation'). Records calls.
  function stubCa(state: Record<string, string | undefined>, opts: { deleteTo?: 'revoked' | 'pending_revocation' | 'fail' } = {}) {
    const calls: Array<{ method: string; id: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const id = String(input).split('/').pop()!;
        const method = init?.method ?? 'GET';
        calls.push({ method, id });
        if (method === 'DELETE') {
          if (opts.deleteTo === 'fail') return new Response(JSON.stringify({ success: false }), { status: 200 });
          const s = opts.deleteTo ?? 'pending_revocation';
          state[id] = s;
          return new Response(JSON.stringify({ success: true, result: { status: s } }), { status: 200 });
        }
        const st = state[id];
        if (!st) return new Response(JSON.stringify({ success: false }), { status: 404 });
        return new Response(JSON.stringify({ success: true, result: { status: st } }), { status: 200 });
      }),
    );
    return { calls };
  }

  it('moves a due grace window into the queue and settles it when the CA reports revoked', async () => {
    await seedMachine('prune-1', { fp: 'cur1', prevFp: 'old1', prevCertId: 'cert-old-1', revokeAt: '2000-01-01T00:00:00.000Z' });
    const { calls } = stubCa({ 'cert-old-1': 'active' }, { deleteTo: 'revoked' });
    await runDailyPrune(cfEnv);
    expect(calls.some((c) => c.method === 'DELETE' && c.id === 'cert-old-1')).toBe(true); // revoke issued
    const r = await row('prune-1');
    expect(r?.prev_cert_fp_sha256).toBeNull(); // grace slot cleared — reservation lives in the queue
    expect(r?.prev_cert_id).toBeNull();
    expect(r?.cert_revoke_at).toBeNull();
    expect(r?.cert_fp_sha256).toBe('cur1'); // current cert untouched
    expect((await retired('old1'))?.revoked_at).not.toBeNull(); // CA reported revoked -> settled first pass
  });

  it('keeps a pending-revocation entry reserved until the CA confirms revoked (async revocation)', async () => {
    await seedMachine('prune-2', { fp: 'cur2', prevFp: 'old2', prevCertId: 'cert-old-2', revokeAt: '2000-01-01T00:00:00.000Z' });
    stubCa({ 'cert-old-2': 'active' }, { deleteTo: 'pending_revocation' });
    await runDailyPrune(cfEnv);
    const r = await row('prune-2');
    expect(r?.prev_cert_fp_sha256).toBeNull(); // moved out of the grace slot into the queue
    const q = await retired('old2');
    expect(q?.cert_id).toBe('cert-old-2');
    expect(q?.revoked_at).toBeNull(); // pending_revocation -> still reserved, NOT freed yet
  });

  it('re-polls a pending reservation and settles it once the CA reports revoked', async () => {
    // A cert retired + DELETE'd on a prior run sits pending_revocation at the CA.
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('poll-fp', 'poll-id', 'poll-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    const state: Record<string, string | undefined> = { 'poll-id': 'pending_revocation' };
    stubCa(state);
    await runDailyPrune(cfEnv);
    expect((await retired('poll-fp'))?.revoked_at).toBeNull(); // still pending -> reserved
    expect((await retired('poll-fp'))?.claimed_at).not.toBeNull(); // claim KEPT on pending (CA is revoking)
    state['poll-id'] = 'revoked'; // CA finishes the async revocation
    // Age the kept claim to simulate the next daily run (>1h later) — that's when the staleness threshold
    // lets prune re-claim a pending reservation; back-to-back runs within the hour would (correctly) skip.
    await testEnv.DB.prepare("UPDATE retired_certs SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE fingerprint = 'poll-fp'").run();
    await runDailyPrune(cfEnv);
    expect((await retired('poll-fp'))?.revoked_at).not.toBeNull(); // next run re-claims + settles it
  });

  it('keeps the claim on a reservation the CA is still revoking (pending_revocation)', async () => {
    // The crux of the un-queue safety: pollRetired must NOT release the claim while the CA revoke is in
    // flight. A released claim would let a racing rollback/un-queue reinstate a cert being revoked. The
    // claim is released ONLY when the DELETE call itself was rejected (no CA state change) — see below.
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('pk-fp', 'pk-id', 'pk-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    stubCa({ 'pk-id': 'active' }, { deleteTo: 'pending_revocation' });
    await runDailyPrune(cfEnv);
    const q = await retired('pk-fp');
    expect(q?.revoked_at).toBeNull(); // async revoke in flight
    expect(q?.claimed_at).not.toBeNull(); // claim KEPT (not released) -> un-queue guard stays effective
  });

  it('releases the claim only when the CA rejects the DELETE (cert still active — safe to reinstate)', async () => {
    // The single case the claim IS released back to NULL: the DELETE was rejected with no CA state
    // change, so the cert stays fully active and its reservation is safe for a later un-queue to reinstate.
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('rl-fp', 'rl-id', 'rl-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    stubCa({ 'rl-id': 'active' }, { deleteTo: 'fail' });
    await runDailyPrune(cfEnv);
    const q = await retired('rl-fp');
    expect(q?.revoked_at).toBeNull(); // DELETE rejected -> not revoked
    expect(q?.claimed_at).toBeNull(); // claim RELEASED -> reservation reinstatable
  });

  it('leaves a not-yet-due grace window alone (no CA call)', async () => {
    await seedMachine('prune-3', { fp: 'cur3', prevFp: 'old3', prevCertId: 'cert-old-3', revokeAt: '2999-01-01T00:00:00.000Z' });
    const { calls } = stubCa({});
    await runDailyPrune(cfEnv);
    expect(calls.length).toBe(0);
    expect((await row('prune-3'))?.prev_cert_fp_sha256).toBe('old3');
  });

  it('a renew repopulating a fresh window between select and batch survives (guarded move no-ops)', async () => {
    await seedMachine('prune-race', { fp: 'pr-cur', prevFp: 'pr-old', prevCertId: 'pr-cert-old', revokeAt: '2000-01-01T00:00:00.000Z' });
    stubCa({});
    // Wrap the "due" SELECT so that right after it returns the OLD window, a concurrent renew lands a
    // FRESH one. The batch's move+clear is keyed on the OLD prev fp + revoke_at, so it no-ops and the
    // fresh window survives — nothing is retired for the stale window.
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('WHERE prev_cert_fp_sha256 IS NOT NULL')) return stmt;
      const realAll = stmt.all.bind(stmt) as (...a: unknown[]) => Promise<unknown>;
      (stmt as unknown as { all: (...a: unknown[]) => Promise<unknown> }).all = async (...a: unknown[]) => {
        const r = await realAll(...a);
        await realPrepare(
          `UPDATE machines SET prev_cert_fp_sha256 = 'pr-fresh', prev_cert_id = 'pr-cert-fresh', cert_revoke_at = '2999-01-01T00:00:00.000Z' WHERE machine_id = 'prune-race'`,
        ).run();
        return r;
      };
      return stmt;
    });
    await runDailyPrune(cfEnv);
    spy.mockRestore();
    const r = await row('prune-race');
    expect(r?.prev_cert_fp_sha256).toBe('pr-fresh'); // fresh window survived
    expect(r?.cert_revoke_at).toBe('2999-01-01T00:00:00.000Z');
    expect(await retired('pr-old')).toBeNull(); // stale window was NOT retired
  });

  it('moves a NULL-id (pre-M4) prev into the queue as an unknown-id reservation, keeping the fp reserved', async () => {
    await seedMachine('prune-4', { fp: 'cur4', prevFp: hexfp('old4'), prevCertId: undefined, revokeAt: '2000-01-01T00:00:00.000Z' });
    const { calls } = stubCa({});
    await runDailyPrune(cfEnv);
    expect(calls.length).toBe(0); // unknown id -> no CA call at all (can't GET or DELETE it)
    const r = await row('prune-4');
    expect(r?.prev_cert_fp_sha256).toBeNull(); // moved out of the grace slot
    const q = await retired(hexfp('old4'));
    expect(q?.cert_id).toBeNull();
    expect(q?.revoked_at).toBeNull(); // unknown id -> stays reserved for manual cleanup
    // Still unclaimable by another machine (clash check consults the queue).
    const clash = await adminMachines(reqJson({ machine_id: 'prune-4-other', cert_fp_sha256: hexfp('old4') }), testEnv, machine('am-admin', true));
    expect(clash.status).toBe(409);
  });

  it('a confirmed CA revoke frees the fingerprint for reuse by another machine', async () => {
    await seedMachine('prune-free', { fp: 'pf-cur', prevFp: hexfp('pf-old'), prevCertId: 'pf-cert-old', revokeAt: '2000-01-01T00:00:00.000Z' });
    stubCa({ 'pf-cert-old': 'active' }, { deleteTo: 'revoked' });
    await runDailyPrune(cfEnv);
    expect((await row('prune-free'))?.prev_cert_fp_sha256).toBeNull(); // grace slot cleared
    expect((await retired(hexfp('pf-old')))?.revoked_at).not.toBeNull(); // revoked + stamped in the queue
    const reuse = await adminMachines(reqJson({ machine_id: 'prune-free-other', cert_fp_sha256: hexfp('pf-old'), cert_id_unknown: true }), testEnv, machine('am-admin', true));
    expect(reuse.status).toBe(200); // now claimable
  });

  it('an admin un-queue between the reserved select and the claim skips the revoke (no CA DELETE)', async () => {
    // The two-phase claim closes the TOCTOU: after the reserved SELECT materializes uq-fp but before the
    // per-row claim, an admin un-queues it (reinstated as current elsewhere). The claim UPDATE then
    // matches nothing, so the loop skips the row and never DELETEs the cert that is now current.
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('uq-fp', 'uq-id', 'uq-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    const { calls } = stubCa({ 'uq-id': 'active' }, { deleteTo: 'revoked' });
    const realPrepare = testEnv.DB.prepare.bind(testEnv.DB);
    const spy = vi.spyOn(testEnv.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('FROM retired_certs WHERE revoked_at IS NULL')) return stmt;
      const realAll = stmt.all.bind(stmt) as (...a: unknown[]) => Promise<unknown>;
      (stmt as unknown as { all: (...a: unknown[]) => Promise<unknown> }).all = async (...a: unknown[]) => {
        const r = await realAll(...a);
        await realPrepare("DELETE FROM retired_certs WHERE fingerprint = 'uq-fp'").run();
        return r;
      };
      return stmt;
    });
    await runDailyPrune(cfEnv);
    spy.mockRestore();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // claim missed -> cert never revoked
    expect(await retired('uq-fp')).toBeNull(); // stays un-queued (reinstated as current elsewhere)
  });

  it('positive control: an unclaimed reservation is claimed then revoked as before', async () => {
    await seedMachine('prune-claim', { fp: 'pc-cur', prevFp: 'pc-old', prevCertId: 'pc-cert-old', revokeAt: '2000-01-01T00:00:00.000Z' });
    const { calls } = stubCa({ 'pc-cert-old': 'active' }, { deleteTo: 'revoked' });
    await runDailyPrune(cfEnv);
    expect(calls.some((c) => c.method === 'DELETE' && c.id === 'pc-cert-old')).toBe(true); // claimed -> revoked
    const q = await retired('pc-old');
    expect(q?.claimed_at).not.toBeNull(); // claim stamped before the CA call
    expect(q?.revoked_at).not.toBeNull(); // then settled
  });
});

describe('admin routes require the current cert slot', () => {
  const ctx = {} as ExecutionContext;
  // A request authenticated by a specific client-cert fingerprint (mTLS), routed through the real router.
  function apiReq(path: string, fp: string, body?: unknown): Request {
    return new Request(`https://api.sessions.vza.net${path}`, {
      method: 'POST',
      cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fp } },
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    } as unknown as RequestInit);
  }

  beforeEach(async () => {
    // An admin machine mid-rotation: current cert rt-cur, in-grace previous cert rt-prev (both authenticate).
    await seedMachine('rt-admin', {
      fp: 'rt-cur',
      certId: 'cert-rt-cur',
      prevFp: 'rt-prev',
      prevCertId: 'cert-rt-prev',
      revokeAt: '2999-01-01T00:00:00.000Z',
      isAdmin: true,
    });
  });

  it('403s admin/machines on an in-grace previous cert, but the current cert works', async () => {
    const grace = await route(apiReq('/api/v1/admin/machines', 'rt-prev', { machine_id: 'rt-admin', priority: 9 }), prodEnv, ctx);
    expect(grace.status).toBe(403);
    expect(((await grace.json()) as { error: string }).error).toBe('admin_requires_current_cert');
    const current = await route(apiReq('/api/v1/admin/machines', 'rt-cur', { machine_id: 'rt-admin', priority: 9 }), prodEnv, ctx);
    expect(current.status).toBe(200);
  });

  it('403s admin/reindex on an in-grace previous cert, but the current cert is reachable', async () => {
    const grace = await route(apiReq('/api/v1/admin/reindex', 'rt-prev', {}), prodEnv, ctx);
    expect(grace.status).toBe(403);
    expect(((await grace.json()) as { error: string }).error).toBe('admin_requires_current_cert');
    const current = await route(apiReq('/api/v1/admin/reindex', 'rt-cur', {}), prodEnv, ctx);
    expect(current.status).not.toBe(403); // passes the slot gate (empty R2 -> done)
  });

  it('still accepts an in-grace previous cert on non-admin routes (heartbeat)', async () => {
    const res = await route(apiReq('/api/v1/heartbeat', 'rt-prev', { collector_version: 'x' }), prodEnv, ctx);
    expect(res.status).toBe(200); // grace certs keep working for upload/heartbeat/renew recovery
  });
});

describe('grace-slot certs lose cross-machine admin power (CLASS C)', () => {
  const ctx = {} as ExecutionContext;
  function fileReq(path: string, method: string, fp: string, body?: string): Request {
    return new Request(`https://api.sessions.vza.net${path}`, {
      method,
      cf: { tlsClientAuth: { certVerified: 'SUCCESS', certFingerprintSHA256: fp } },
      ...(body !== undefined ? { body } : {}),
    } as unknown as RequestInit);
  }

  it('an in-grace admin cert cannot write another machine path (putFile + multipart), but the current cert can', async () => {
    // gc-admin is an admin machine mid-rotation: current gc-cur, in-grace prev gc-prev. isAdmin is now
    // gated on the CURRENT slot at machineIdentity, so putFile/ownsPath (which key on identity.isAdmin
    // for the cross-machine bypass) inherit the fix with no changes.
    await seedMachine('gc-admin', { fp: 'gc-cur', certId: 'gc-cid', prevFp: 'gc-prev', prevCertId: 'gc-pid', revokeAt: '2999-01-01T00:00:00.000Z', isAdmin: true });
    // In-grace prev cert -> admin dropped -> cross-machine putFile is a 403 machine_mismatch.
    const gracePut = await route(fileReq('/api/v1/files/other-box/claude/x.jsonl', 'PUT', 'gc-prev', 'hello'), prodEnv, ctx);
    expect(gracePut.status).toBe(403);
    // Same for a multipart create (ownsPath).
    const graceMpu = await route(fileReq('/api/v1/files/other-box/claude/x.jsonl?uploads', 'POST', 'gc-prev', JSON.stringify({ size: 5, sha256: 'a'.repeat(64) })), prodEnv, ctx);
    expect(graceMpu.status).toBe(403);
    // The CURRENT admin cert keeps the cross-machine bypass -> NOT a machine_mismatch 403.
    const currentPut = await route(fileReq('/api/v1/files/other-box/claude/x.jsonl', 'PUT', 'gc-cur', 'hello'), prodEnv, ctx);
    expect(currentPut.status).not.toBe(403);
  });
});

describe('settleRetired claim invariant (CLASS A)', () => {
  it('claims the row before its CA revoke, so a concurrent un-queue no-ops (no mid-revoke lockout)', async () => {
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('sr-fp', 'sr-id', 'sr-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    let claimedAtRevokeTime: string | null = null;
    let unqueuedRows = -1;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        // At the moment of the CA revoke, the row must already be claimed...
        claimedAtRevokeTime = (await retired('sr-fp'))?.claimed_at ?? null;
        // ...so a concurrent admin un-queue (guarded on claimed_at IS NULL) deletes nothing.
        const res = await testEnv.DB.prepare(
          "DELETE FROM retired_certs WHERE fingerprint='sr-fp' AND machine_id='sr-m' AND revoked_at IS NULL AND claimed_at IS NULL",
        ).run();
        unqueuedRows = res.meta.changes ?? 0;
        return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }));
    const outcome = await settleRetired(cfEnv, 'sr-id');
    expect(claimedAtRevokeTime).not.toBeNull(); // claimed BEFORE the CA DELETE ran
    expect(unqueuedRows).toBe(0); // the racing un-queue found nothing to delete (row is claimed)
    expect(outcome).toBe('pending_revocation');
    expect(await retired('sr-fp')).not.toBeNull(); // reservation survived, not yanked mid-revoke
  });

  it('positive control: skips (no CA call) when the row was already un-queued', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await settleRetired(cfEnv, 'no-such-reservation-id');
    expect(outcome).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled(); // never touched the CA
  });
});

describe('CF API auth failures are distinctly alertable', () => {
  // A 401/403 from the CF API means CF_CLIENT_CERT_TOKEN is expired/revoked/under-scoped — EVERY
  // sign/revoke/poll fails until it's rotated. The hub emits hub.certs.cf_auth_failed (separate from the
  // generic sign_failed / *_error logs) so infra/azure/alerts/cf-auth-failed.kql can page on a dead token.
  const authFail = (status: number) =>
    vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status }));

  function authEvents(logs: ReturnType<typeof vi.spyOn>): Array<{ event?: string; op?: string; http_status?: number }> {
    return logs.mock.calls
      .map((c: unknown[]) => { try { return JSON.parse(c[0] as string); } catch { return {}; } })
      .filter((e: { event?: string }) => e.event === 'hub.certs.cf_auth_failed');
  }

  it('a 403 on the sign POST logs the event (op sign) and still 502s the renew', async () => {
    await seedMachine('cf-sign', { fp: 'cf-sign-cur', certId: 'cf-sign-cid' });
    vi.stubGlobal('fetch', authFail(403));
    const logs = vi.spyOn(console, 'log');
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('cf-sign', false, 'cf-sign-cur'));
    expect(res.status).toBe(502);
    const events = authEvents(logs);
    logs.mockRestore();
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe('sign');
    expect(events[0]!.http_status).toBe(403);
  });

  it('a 401 on the revoke DELETE logs the event (op revoke) and reports failed', async () => {
    vi.stubGlobal('fetch', authFail(401));
    const logs = vi.spyOn(console, 'log');
    const result = await revokeClientCert(cfEnv, 'cf-revoke-id');
    const events = authEvents(logs);
    logs.mockRestore();
    expect(result).toBe('failed');
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe('revoke');
    expect(events[0]!.http_status).toBe(401);
  });

  it('a 403 on the status GET (poll) logs the event (op status)', async () => {
    await testEnv.DB.prepare(
      "INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES ('cf-status-fp', 'cf-status-id', 'cf-status-m', '2000-01-01T00:00:00.000Z')",
    ).run();
    vi.stubGlobal('fetch', authFail(403));
    const logs = vi.spyOn(console, 'log');
    await pollRetired(cfEnv, 'cf-status-id');
    const events = authEvents(logs);
    logs.mockRestore();
    expect(events).toHaveLength(1);
    expect(events[0]!.op).toBe('status');
    expect(events[0]!.http_status).toBe(403);
  });

  it('positive control: a 200 sign logs NO cf_auth_failed event', async () => {
    await seedMachine('cf-ok', { fp: 'cf-ok-cur', certId: 'cf-ok-cid' });
    vi.stubGlobal('fetch', vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ success: true, result: { status: 'pending_revocation' } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, result: { id: 'cf-ok-new', certificate: fakeCertPem('cf-ok-new'), expires_on: '2027-01-01T00:00:00Z' } }), { status: 200 });
    }));
    const logs = vi.spyOn(console, 'log');
    const res = await renewCert(reqJson({ csr: 'c' }), cfEnv, machine('cf-ok', false, 'cf-ok-cur'));
    const events = authEvents(logs);
    logs.mockRestore();
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0); // a healthy token never trips the alert
  });
});
