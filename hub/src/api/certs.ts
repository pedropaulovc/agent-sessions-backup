import type { Identity } from '../auth/identity';
import { hex } from './ops';

// Grace window a rotated-out cert stays valid after its successor is minted, before the
// daily prune revokes it at the managed CA. Long enough that an offline collector can come
// back and renew on its own current cert; see migrations/0005_cert_rotation.sql.
export const CERT_GRACE_DAYS = 7;

/** SHA-256 of the leaf certificate's DER, lowercase hex, no colons — byte-for-byte what
 * `request.cf.tlsClientAuth.certFingerprintSHA256` reports, so the value we store is the
 * value the edge will present on the next handshake. Takes the FIRST PEM block (the leaf);
 * a chain's intermediates are irrelevant to the client fingerprint. */
export async function certFingerprint(pem: string): Promise<string> {
  const block = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!block) throw new Error('no PEM certificate block');
  const bin = atob(block[1]!.replace(/\s+/g, ''));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return hex(await crypto.subtle.digest('SHA-256', der));
}

interface SignedCert {
  id: string;
  certificate: string;
  expires_on: string;
}

async function signClientCert(env: Env, csr: string): Promise<SignedCert> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ csr, validity_days: 365 }),
  });
  const data = (await res.json()) as { success?: boolean; result?: SignedCert; errors?: unknown };
  if (!data.success || !data.result) {
    throw new Error(`cf client_certificates sign failed: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

// Cloudflare's managed-CA client cert lifecycle. A DELETE (revoke) is ASYNCHRONOUS: it moves the
// cert to 'pending_revocation' and only later to 'revoked'. During that window the old cert can
// still pass mTLS, so a fingerprint is safe to reuse ONLY once the cert reports 'revoked' (or 404).
type CertStatus = 'active' | 'pending_reactivation' | 'pending_revocation' | 'revoked';
type RevokeResult = 'revoked' | 'pending_revocation' | 'failed';

/** Revoke (DELETE) a client cert at the managed CA. Returns the resulting status: 'revoked' if the
 * CA already reports it fully revoked (rare — revocation is async), 'pending_revocation' if the
 * revoke was accepted and is in flight, or 'failed' if the API rejected it. Throws propagate to the
 * caller (all callers wrap in try/catch). */
export async function revokeClientCert(env: Env, certId: string): Promise<RevokeResult> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates/${certId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}` } },
  );
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: string } };
  if (!data.success) return 'failed';
  return data.result?.status === 'revoked' ? 'revoked' : 'pending_revocation';
}

/** GET a client cert's current CA status. 404 → 'not_found' (already gone); any error or unparseable
 * body → 'unknown' (retry next run rather than assume a state). */
async function getClientCertStatus(env: Env, certId: string): Promise<CertStatus | 'not_found' | 'unknown'> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates/${certId}`,
      { headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}` } },
    );
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.status_error', cert_id: certId, error: String(e) }));
    return 'unknown';
  }
  if (res.status === 404) return 'not_found';
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: CertStatus } };
  if (!data.success || !data.result?.status) return 'unknown';
  return data.result.status;
}

/** Stamp a queued cert as revoked (returns its fingerprint to the reusable pool; the row is kept as
 * an audit trail). NEVER throws: a stamp failure just leaves the row reserved (revoked_at NULL) for
 * the next prune poll to re-stamp — so a post-revoke D1 hiccup can't propagate into a caller that has
 * already committed its main work (e.g. a completed renewal). Returns whether the stamp landed. */
async function stampRevoked(env: Env, certId: string): Promise<boolean> {
  try {
    await env.DB.prepare('UPDATE retired_certs SET revoked_at = ?1 WHERE cert_id = ?2 AND revoked_at IS NULL')
      .bind(new Date().toISOString(), certId)
      .run();
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.stamp_failed', cert_id: certId, error: String(e) }));
    return false;
  }
}

/** SQL fragment + binds that INSERT a displaced cert into the retired_certs queue, but ONLY if the
 * preceding displacement in the SAME db.batch landed (the machine's current fp is now `newFp`). This
 * co-commits the reservation with the displacement so the fingerprint is never momentarily in
 * neither a machines-row slot nor the queue. Params: (fingerprint, cert_id, machine_id, newFp). */
export function queueRetiredIfDisplaced(env: Env, fingerprint: string, certId: string | null, machineId: string, newFp: string) {
  return env.DB.prepare(
    `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at)
     SELECT ?1, ?2, ?3, ?5 WHERE EXISTS (SELECT 1 FROM machines WHERE machine_id = ?3 AND cert_fp_sha256 = ?4)`,
  ).bind(fingerprint, certId, machineId, newFp, new Date().toISOString());
}

/** Insert a displaced cert into the retired_certs queue, then settle it. Standalone (not batched) —
 * used by admin swaps, where the displacement already committed. */
export async function retireCert(env: Env, fingerprint: string, certId: string | null, machineId: string): Promise<void> {
  await env.DB.prepare('INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(fingerprint, certId, machineId, new Date().toISOString())
    .run();
  await settleRetired(env, certId);
}

/** Best-effort INITIATE revocation of a queued cert. Because revocation is async, a successful
 * DELETE usually returns 'pending_revocation' — we stamp revoked_at ONLY on a full 'revoked', so the
 * row otherwise stays reserved until a later prune poll confirms it. Returns the revoke result. */
export async function settleRetired(env: Env, certId: string | null): Promise<RevokeResult> {
  if (!certId) return 'failed'; // unknown id — nothing to revoke; stays reserved
  let result: RevokeResult;
  try {
    result = await revokeClientCert(env, certId);
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.retire_revoke_error', cert_id: certId, error: String(e) }));
    return 'failed';
  }
  // Stamp only on a full revoke, and never let a stamp failure throw out of a settle that a committed
  // renewal is waiting on — the row stays reserved and the prune re-stamps.
  if (result === 'revoked') return (await stampRevoked(env, certId)) ? 'revoked' : 'failed';
  return result;
}

/** Poll a reserved cert and advance it toward settled. Stamps revoked_at once the CA reports the
 * cert 'revoked' (or 404 — already gone). A cert still 'pending_revocation' stays reserved (re-polled
 * next run). One that never actually got revoked ('active'/'pending_reactivation') gets a fresh
 * revoke attempt. Used by the prune drain. */
export async function pollRetired(env: Env, certId: string): Promise<'revoked' | 'pending' | 'failed'> {
  const status = await getClientCertStatus(env, certId);
  if (status === 'revoked' || status === 'not_found') {
    return (await stampRevoked(env, certId)) ? 'revoked' : 'failed';
  }
  if (status === 'pending_revocation') return 'pending';
  if (status === 'active' || status === 'pending_reactivation') {
    const r = await settleRetired(env, certId);
    return r === 'revoked' ? 'revoked' : r === 'pending_revocation' ? 'pending' : 'failed';
  }
  return 'failed'; // 'unknown' — a GET error; retry next run without guessing
}

/** Make a minted-but-unusable cert safe, NEVER throwing — so a cleanup failure can't change the
 * caller's already-decided response (a CAS-conflict 409, or a renew_write_failed 500). Shared by both
 * renew orphan sites. Primary path: queue it (retireCert) so the prune drives it to revoked. If the
 * queue INSERT throws (transient D1), fall back to a direct best-effort revoke so it isn't left live.
 * If BOTH fail the cert is leaked-but-loudly-logged (alertable) — strictly better than a silent
 * strand. */
async function reclaimOrphan(env: Env, fingerprint: string, certId: string, machineId: string): Promise<void> {
  try {
    await retireCert(env, fingerprint, certId, machineId);
    return;
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.orphan_queue_failed', machine: machineId, cert_id: certId, error: String(e) }));
  }
  try {
    await revokeClientCert(env, certId);
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.orphan_revoke_failed', machine: machineId, cert_id: certId, error: String(e) }));
  }
}

/** POST /api/v1/certs/renew — a still-valid machine cert requests its own successor. The body
 * carries a fresh CSR; the hub has the managed CA sign it, swaps the new fingerprint in as
 * current, and keeps the OLD fingerprint valid for CERT_GRACE_DAYS (the prune revokes it then).
 *
 * The caller may authenticate with the current cert OR (inside a prior grace window) the previous
 * one — machineIdentity resolves both — but the cert we retire is always the CURRENT one. A second
 * renew inside the window is therefore authenticated by the current cert and REPLACES the existing
 * prev, resetting the +7d clock: at most one generation is ever in grace, never a chain of three. */
export async function renewCert(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!env.CF_ZONE_ID || !env.CF_CLIENT_CERT_TOKEN) {
    // The renewal secret isn't provisioned yet — genuinely can't mint a cert. 503 so the
    // collector keeps its current cert and retries later instead of treating this as fatal.
    console.log(JSON.stringify({ event: 'hub.certs.renew_unconfigured', machine: identity.machineId }));
    return Response.json({ error: 'cert_renewal_unavailable' }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as { csr?: string };
  if (!body.csr || typeof body.csr !== 'string') {
    return Response.json({ error: 'missing_csr' }, { status: 400 });
  }

  // Read the row BEFORE minting anything. The CSR doesn't depend on it, and if this D1 read fails we
  // bail with a retryable 503 having minted NOTHING — no orphan possible. (Doing it after signing
  // would strand a live cert on a transient read error.) The read→sign→CAS window is slightly wider,
  // but the swap's compare-and-swap on the observed fp is exactly what guards that.
  let cur: { cert_fp_sha256: string | null; cert_id: string | null; prev_cert_fp_sha256: string | null; prev_cert_id: string | null; cert_revoke_at: string | null } | null;
  try {
    cur = await env.DB.prepare('SELECT cert_fp_sha256, cert_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at FROM machines WHERE machine_id = ?1')
      .bind(identity.machineId)
      .first();
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.renew_read_failed', machine: identity.machineId, error: String(e) }));
    return Response.json({ error: 'cert_renewal_unavailable' }, { status: 503 });
  }

  let signed: SignedCert;
  try {
    signed = await signClientCert(env, body.csr);
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.sign_failed', machine: identity.machineId, error: String(e) }));
    return Response.json({ error: 'cf_sign_failed' }, { status: 502 });
  }
  const newFp = await certFingerprint(signed.certificate);

  const authFp = identity.certFp ?? null;
  const onCurrent = authFp !== null && authFp === cur?.cert_fp_sha256;

  // The cert this rotation displaces out of a machines-row slot (queued for revoke so it can never
  // become an untracked-but-CA-valid fingerprint): the old in-grace prev on a normal rotation, or
  // the orphaned successor (old current) on a recovery.
  const displaced = onCurrent
    ? { fp: cur?.prev_cert_fp_sha256 ?? null, id: cur?.prev_cert_id ?? null }
    : { fp: cur?.cert_fp_sha256 ?? null, id: cur?.cert_id ?? null };

  let changes = 0;
  let effectiveRevokeAt: string | null;
  try {
    if (onCurrent) {
      // NORMAL rotation: authenticated on the CURRENT cert. Retire it into a fresh grace window.
      // ISO8601 millis+'Z' matches strftime('%Y-%m-%dT%H:%M:%fZ') so the identity guard compares
      // chronologically. Compare-and-swap on the authenticating fp: two renews racing off the same
      // current cert serialize — the first flips current, the second's WHERE no longer matches
      // (changes === 0) and it 409s, rather than last-writer-wins stranding the winner's cert. The
      // guarded queue INSERT co-commits with the swap so a displaced in-grace prev is never dropped.
      // The CAS also pins the observed cert_id (IS, so NULL matches NULL): if an admin attaches a CA id
      // to this fingerprint between our read and here, the stale observed id no longer matches and we
      // 409 rather than move a stale NULL into prev_cert_id (which would make the old cert an
      // unrevocable unknown-id reservation at prune despite the id now being known). The retry re-reads
      // the fresh id and carries it into prev correctly.
      effectiveRevokeAt = new Date(Date.now() + CERT_GRACE_DAYS * 86_400_000).toISOString();
      const swap = env.DB.prepare(
        `UPDATE machines
           SET prev_cert_fp_sha256 = ?2, prev_cert_id = ?3, cert_revoke_at = ?4,
               cert_fp_sha256 = ?5, cert_id = ?6
         WHERE machine_id = ?1 AND cert_fp_sha256 = ?7 AND cert_id IS ?8`,
      ).bind(identity.machineId, cur!.cert_fp_sha256, cur!.cert_id, effectiveRevokeAt, newFp, signed.id, authFp, cur!.cert_id);
      const stmts = [swap];
      if (displaced.fp) stmts.push(queueRetiredIfDisplaced(env, displaced.fp, displaced.id, identity.machineId, newFp));
      const results = await env.DB.batch(stmts);
      changes = results[0]!.meta.changes ?? 0;
    } else {
      // RECOVERY: authenticated on the IN-GRACE PREVIOUS cert. The successor from an earlier renewal
      // was never installed (lost response), so the machine is stuck holding the old cert and would
      // otherwise die at cert_revoke_at with no path forward. Replace the orphaned successor (the
      // current slot) with this new cert WITHOUT touching the prev slot or its cert_revoke_at — grace
      // must NOT extend, or repeated prev-auth renews would keep an old cert alive forever. Guarded on
      // the observed current fp too so concurrent recoveries serialize. Keep the ORIGINAL revoke_at.
      // The displaced orphaned successor is queued (co-committed) rather than silently dropped.
      effectiveRevokeAt = cur?.cert_revoke_at ?? null;
      const swap = env.DB.prepare(
        `UPDATE machines
           SET cert_fp_sha256 = ?2, cert_id = ?3
         WHERE machine_id = ?1 AND prev_cert_fp_sha256 = ?4 AND cert_fp_sha256 = ?5
           AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(identity.machineId, newFp, signed.id, authFp, cur?.cert_fp_sha256 ?? null);
      const stmts = [swap];
      if (displaced.fp) stmts.push(queueRetiredIfDisplaced(env, displaced.fp, displaced.id, identity.machineId, newFp));
      const results = await env.DB.batch(stmts);
      changes = results[0]!.meta.changes ?? 0;
    }
  } catch (e) {
    // The CA already signed the successor but the D1 write threw (outage, constraint, lock). Without
    // this the cert would be live at the CA yet recorded nowhere — a per-retry leak. Reclaim it.
    console.log(JSON.stringify({ event: 'hub.certs.renew_write_failed', machine: identity.machineId, cert_id: signed.id, error: String(e) }));
    await reclaimOrphan(env, newFp, signed.id, identity.machineId);
    return Response.json({ error: 'renew_write_failed' }, { status: 500 });
  }

  if (changes === 0) {
    // Normal path: a competing rotation advanced current. Recovery path: the grace window closed or
    // the row moved under us. Either way the cert we just minted is an orphan. reclaimOrphan queues
    // it (so the async revoke is driven to completion by the prune) and NEVER throws — a cleanup
    // failure must not turn the CAS-decided 409 into a 500 that strands the cert.
    await reclaimOrphan(env, newFp, signed.id, identity.machineId);
    return Response.json({ error: 'renew_conflict' }, { status: 409 });
  }

  // The swap won and (if there was a displaced cert) it's now reserved in the queue — try to revoke
  // it immediately and stamp revoked_at. On failure it stays reserved for the daily prune to retry.
  if (displaced.fp) await settleRetired(env, displaced.id);

  console.log(JSON.stringify({ event: 'hub.certs.renewed', machine: identity.machineId, recovery: !onCurrent, revoke_at: effectiveRevokeAt }));
  return Response.json({
    ok: true,
    certificate: signed.certificate,
    fingerprint: newFp,
    cert_id: signed.id,
    expires_on: signed.expires_on,
    prev_revoke_at: effectiveRevokeAt,
  });
}
