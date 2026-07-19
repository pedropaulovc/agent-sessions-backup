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

// A 401/403 from the CF API is operationally distinct from a transient error or a per-cert rejection:
// it means CF_CLIENT_CERT_TOKEN is expired, revoked, or under-scoped, so EVERY sign/revoke/poll will
// keep failing until the token is rotated. Emit a dedicated event (separate from the generic
// sign_failed / *_error logs) so an alert can page on a dead token instead of it hiding as a stream of
// per-call failures that look like ordinary CF flakiness. Returns whether it was an auth failure.
function reportCfAuthFailure(res: Response, op: 'sign' | 'revoke' | 'status', certId: string | null): boolean {
  if (res.status !== 401 && res.status !== 403) return false;
  console.log(JSON.stringify({ event: 'hub.certs.cf_auth_failed', op, cert_id: certId, http_status: res.status }));
  return true;
}

async function signClientCert(env: Env, csr: string, machineId: string): Promise<SignedCert> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ csr, validity_days: 365 }),
  });
  reportCfAuthFailure(res, 'sign', null);
  const data = (await res.json()) as { success?: boolean; result?: SignedCert; errors?: unknown };
  const r = data.result;
  // Validate the RESULT SHAPE, not just success. A success:true with a malformed result (missing id, or a
  // PEM-less certificate) must NOT flow on: renewCert would carry signed.id === undefined into the D1 write,
  // and the orphan cleanup would then try to revoke /client_certificates/undefined while the actually-minted
  // cert stays CA-valid — an unactionable orphan. Require id + certificate + expires_on to be present,
  // non-empty strings. Same fail-closed-on-absent-field pattern as getClientCertFingerprint (round 17).
  // Throw with the raw errors JSON (never the token) so a real CF error is still legible.
  if (
    !data.success ||
    r === undefined ||
    typeof r.id !== 'string' || r.id === '' ||
    typeof r.certificate !== 'string' || r.certificate === '' ||
    typeof r.expires_on !== 'string' || r.expires_on === ''
  ) {
    // If CF nonetheless MINTED a cert (a non-empty id present) but the rest of the result is malformed, that
    // cert is live yet absent from machines AND retired_certs — and we throw BEFORE renewCert receives
    // `signed`, so its fingerprint/reclaim cleanup never sees the id. Best-effort DIRECT revoke it here
    // first; revokeOrphanCert emits the alertable hub.certs.orphan_revoke_failed if the revoke can't be
    // confirmed, so a leaked live cert is at least loud. Then throw identically (renewCert still 502s).
    if (r && typeof r.id === 'string' && r.id !== '') {
      await revokeOrphanCert(env, r.id, machineId);
    }
    throw new Error(`cf client_certificates sign failed or returned a malformed result: ${JSON.stringify(data.errors ?? null)}`);
  }
  return r;
}

// Cloudflare's managed-CA client cert lifecycle. A DELETE (revoke) is ASYNCHRONOUS: it moves the
// cert to 'pending_revocation' and only later to 'revoked'. During that window the old cert can
// still pass mTLS, so a fingerprint is safe to reuse ONLY once the cert reports 'revoked' (or 404).
type CertStatus = 'active' | 'pending_reactivation' | 'pending_revocation' | 'revoked';
type RevokeResult = 'revoked' | 'pending_revocation' | 'failed' | 'unknown';

/** Revoke (DELETE) a client cert at the managed CA. Returns the resulting status: 'revoked' if the CA
 * already reports it fully revoked (rare — revocation is async) OR the cert is already GONE (HTTP 404);
 * 'pending_revocation' if the revoke was accepted and is in flight; 'failed' only if the API definitively
 * rejected it while the cert is still active; or 'unknown' when the response cannot prove whether the async
 * revoke started. Throws propagate to the caller (all callers wrap in try/catch). */
export async function revokeClientCert(env: Env, certId: string): Promise<RevokeResult> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates/${certId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}` } },
  );
  reportCfAuthFailure(res, 'revoke', certId);
  // A 404 means the cert is already GONE at the CA — SETTLED, identical to the poll path's terminal rule
  // (getClientCertStatus maps res.status === 404 → 'not_found', and pollRetired stampRevoked's it). DELETE
  // and poll MUST share 404 semantics because release-vs-settle feeds the reinstatement guard: settleRetired
  // maps 'revoked' → stampRevoked but 'failed' → RELEASE the claim, and a released same-machine reservation
  // can then be reinstated by adminMachines (the round-23 reinstatement path) onto a fingerprint whose CA
  // cert no longer exists — locking the machine onto an unauthenticatable current cert. So 404 → 'revoked',
  // never 'failed'. (The poll path matches only the HTTP 404, not a body error code — mirror it exactly.)
  if (res.status === 404) return 'revoked';
  const data = (await res.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null;
  // A 5xx or an unparseable response is ambiguous: Cloudflare may have accepted the asynchronous DELETE
  // before the response path failed. Keep that distinct from a parsed API rejection so callers retain the
  // retired-row claim and cannot reinstate a cert that may already be pending_revocation. A parsed
  // success:false on a non-5xx response is the positive proof that the API rejected the operation.
  if (res.status >= 500 || data === null) return 'unknown';
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
  reportCfAuthFailure(res, 'status', certId);
  if (res.status === 404) return 'not_found';
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: CertStatus } };
  if (!data.success || !data.result?.status) return 'unknown';
  return data.result.status;
}

/** Fetch a client cert by id and return the SHA-256 fingerprint of its PEM (the value mTLS reports and we
 * store), or 'not_found' (404) / 'unknown' (error, non-success, missing PEM, or unparseable). Used to
 * VERIFY that an admin-supplied cert_id actually resolves to the fingerprint it's being attached to —
 * comparing the CA cert's own PEM fingerprint (not a CF-provided field) keeps it byte-identical to how we
 * derive every stored fp. Closes the garbage-in case where a wrong/foreign id would later be revoked in
 * place of the real cert.
 *
 * Returns the fp AND the CA status (same object), so the caller can require an ACTIVE cert — a fp match on
 * a cert already pending_revocation/revoked must not be attached.
 *
 * result.certificate is the PEM: verified against the CF API docs + the sign-response shape (enroll-cert.sh
 * has always read result.certificate from this same object). No token exists to probe the live GET until
 * CF_CLIENT_CERT_TOKEN is minted post-merge (USER ACTIONS) — live-verify on first post-merge use. Fails
 * closed regardless: an absent/renamed field → 'unknown' → 422 (attach refused), never a lockout or leak. */
export async function getClientCertFingerprint(env: Env, certId: string): Promise<{ fp: string; status: CertStatus } | 'not_found' | 'unknown'> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates/${certId}`,
      { headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}` } },
    );
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.verify_error', cert_id: certId, error: String(e) }));
    return 'unknown';
  }
  reportCfAuthFailure(res, 'status', certId);
  if (res.status === 404) return 'not_found';
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { certificate?: string; status?: CertStatus } };
  if (!data.success || !data.result?.certificate || !data.result.status) return 'unknown';
  try {
    return { fp: await certFingerprint(data.result.certificate), status: data.result.status };
  } catch {
    return 'unknown';
  }
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

/** The full rotation state of a machines row: every column a cert rotation can change. All five must be
 * pinned by any compare-and-swap on the row, and any INSERT co-committed with a swap, so a concurrent
 * write to ANY of them is detected. */
export interface RotationState {
  cert_fp: string | null;
  cert_id: string | null;
  prev_fp: string | null;
  prev_id: string | null;
  revoke_at: string | null;
}

/** The full-observed-state CAS clause + binds, starting at placeholder index `start`. Pins ALL five
 * rotation columns (IS, so NULL matches NULL) — cert_fp, cert_id, prev_fp, prev_id, revoke_at — so a
 * concurrent change to any of them makes the swap miss (changes === 0 → the caller 409s and re-reads).
 * The single home for "what a rotation CAS must check", used by renew (normal + recovery), the admin
 * swap, and the co-committed retire INSERT — so no path can pin a partial subset of the state. */
export function rotationCas(state: RotationState, start: number): { clause: string; binds: (string | null)[] } {
  return {
    clause:
      `machines.cert_fp_sha256 IS ?${start} AND machines.cert_id IS ?${start + 1} ` +
      `AND machines.prev_cert_fp_sha256 IS ?${start + 2} AND machines.prev_cert_id IS ?${start + 3} ` +
      `AND machines.cert_revoke_at IS ?${start + 4}`,
    binds: [state.cert_fp, state.cert_id, state.prev_fp, state.prev_id, state.revoke_at],
  };
}

/** SQL fragment + binds that INSERT a displaced cert into the retired_certs queue, but ONLY if the
 * machine row is in the EXACT post-swap state `postSwap` that OUR displacement produced — checked in
 * the SAME db.batch, after the swap, so the INSERT sees the swap's effect. A lost CAS leaves the row in
 * the WINNER's state, so our full-state guard misses and we queue nothing (never queuing the stale
 * current/prev we read while another rotation kept one of them live). Co-commits the reservation with
 * the displacement so the fingerprint is never momentarily in neither a machines slot nor the queue. */
export function queueRetiredIfDisplaced(env: Env, fingerprint: string, certId: string | null, machineId: string, postSwap: RotationState) {
  const cas = rotationCas(postSwap, 5);
  return env.DB.prepare(
    `INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at)
     SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM machines WHERE machine_id = ?3 AND ${cas.clause})`,
  ).bind(fingerprint, certId, machineId, new Date().toISOString(), ...cas.binds);
}

/** Insert a displaced cert into the retired_certs queue, then settle it. Standalone (not batched) —
 * used by admin swaps, where the displacement already committed. */
export async function retireCert(env: Env, fingerprint: string, certId: string | null, machineId: string): Promise<void> {
  await env.DB.prepare('INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(fingerprint, certId, machineId, new Date().toISOString())
    .run();
  await settleRetired(env, certId);
}

/** THE single claim primitive. Every path that revokes a QUEUED cert (settleRetired's DELETE,
 * pollRetired's GET+DELETE) claims the row FIRST, so a concurrent admin un-queue — which requires
 * claimed_at IS NULL — can never delete + reinstate a fingerprint we're mid-revoke of. Returns false
 * (do NOT touch the CA) if the row is already claimed by another revoke in flight, already revoked, or
 * un-queued. A claim older than an hour (longer than any run — a crashed prune) is stale and
 * re-claimable so a failed revoke is retried, not wedged. Never throws. */
async function claimRetired(env: Env, certId: string): Promise<boolean> {
  try {
    const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await env.DB.prepare(
      `UPDATE retired_certs SET claimed_at = ?2
         WHERE cert_id = ?1 AND revoked_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?3)`,
    )
      .bind(certId, new Date().toISOString(), staleBefore)
      .run();
    return (r.meta.changes ?? 0) > 0;
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.claim_failed', cert_id: certId, error: String(e) }));
    return false;
  }
}

/** Release a claim only after the CA definitively rejected the DELETE without changing state, making
 * the still-active cert safe to reinstate. Ambiguous failures keep their claim until it becomes stale and
 * the next prune reclaims/re-polls it. Never touches a revoked row. Never throws. */
async function releaseRetired(env: Env, certId: string): Promise<void> {
  try {
    await env.DB.prepare('UPDATE retired_certs SET claimed_at = NULL WHERE cert_id = ?1 AND revoked_at IS NULL')
      .bind(certId)
      .run();
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.release_failed', cert_id: certId, error: String(e) }));
  }
}

/** Best-effort INITIATE revocation of a queued cert. CLAIMS the row before the CA DELETE (so an admin
 * un-queue can't reinstate it mid-revoke); a lost claim ('skipped') means another flow owns it — leave
 * it be. Revocation is async, so a successful DELETE usually returns 'pending_revocation': we stamp
 * revoked_at ONLY on a full 'revoked', release only a proven rejection, and keep ambiguous/in-flight
 * claims for a later stale-claim retry. NEVER throws — a committed renewal/admin swap waits on this and
 * must not 5xx on a cleanup hiccup. */
export async function settleRetired(env: Env, certId: string | null): Promise<RevokeResult | 'skipped'> {
  if (!certId) return 'failed'; // unknown id — nothing to revoke; stays reserved
  if (!(await claimRetired(env, certId))) return 'skipped'; // already revoking / un-queued — don't touch the CA
  let result: RevokeResult;
  try {
    result = await revokeClientCert(env, certId);
  } catch (e) {
    // Ambiguous whether the CA began revoking — KEEP the claim (never let a rollback reinstate a
    // maybe-revoking cert); the prune re-claims via the staleness threshold and retries.
    console.log(JSON.stringify({ event: 'hub.certs.retire_revoke_error', cert_id: certId, error: String(e) }));
    return 'failed';
  }
  // Release the claim ONLY when the DELETE was REJECTED with no CA state change ('failed'): the cert is
  // still fully active, so it's safe for an admin to reinstate/un-queue. On 'pending_revocation' the CA IS
  // revoking, and on 'revoked' it's gone — KEEP the claim so the un-queue's `claimed_at IS NULL` guard and
  // the rollback CAS block reinstating a dying/dead cert. Stamp on a full revoke (terminal).
  if (result === 'revoked') {
    await stampRevoked(env, certId);
    return 'revoked';
  }
  if (result === 'failed') {
    await releaseRetired(env, certId);
    return 'failed';
  }
  return result; // pending_revocation / unknown — claim held, prune re-polls to revoked
}

/** Poll a reserved cert and advance it toward settled. CLAIMS the row first (same primitive as
 * settleRetired); a lost claim → 'skipped' (un-queued or another revoke in flight). Stamps revoked_at
 * once the CA reports 'revoked' (or 404 — already gone). Releases the claim ONLY when a DELETE was
 * REJECTED ('failed' — cert still fully active, safe to reinstate). On 'pending_revocation' (the CA is
 * revoking) or 'unknown' (couldn't determine) it KEEPS the claim so a rollback can't reinstate a
 * dying/uncertain cert; the prune re-claims it next run via the staleness threshold. Used by the prune
 * drain. Never throws. */
export async function pollRetired(env: Env, certId: string): Promise<'revoked' | 'pending' | 'failed' | 'skipped'> {
  if (!(await claimRetired(env, certId))) return 'skipped';
  const status = await getClientCertStatus(env, certId);
  if (status === 'revoked' || status === 'not_found') {
    await stampRevoked(env, certId); // terminal on success; on failure the claim is kept, prune re-polls
    return 'revoked';
  }
  if (status === 'active' || status === 'pending_reactivation') {
    let result: RevokeResult;
    try {
      result = await revokeClientCert(env, certId);
    } catch (e) {
      console.log(JSON.stringify({ event: 'hub.certs.poll_revoke_error', cert_id: certId, error: String(e) }));
      return 'failed'; // ambiguous — KEEP the claim
    }
    if (result === 'revoked') {
      await stampRevoked(env, certId);
      return 'revoked';
    }
    if (result === 'failed') {
      await releaseRetired(env, certId); // DELETE rejected, cert still active — safe to reinstate
      return 'failed';
    }
    if (result === 'pending_revocation') return 'pending'; // CA is revoking, KEEP the claim
    return 'failed'; // ambiguous response — KEEP the claim
  }
  // 'pending_revocation' (async revoke in flight) or 'unknown' (GET error) — KEEP the claim; the prune
  // re-claims and re-polls next run (staleness threshold), and the un-queue/rollback stay blocked.
  return status === 'pending_revocation' ? 'pending' : 'failed';
}

/** Make a minted-but-unusable cert safe, NEVER throwing — so a cleanup failure can't change the
 * caller's already-decided response (a CAS-conflict 409, or a renew_write_failed 500). Shared by both
 * renew orphan sites. Primary path: queue it (retireCert) so the prune drives it to revoked. If the
 * queue INSERT throws (transient D1), fall back to a direct best-effort revoke so it isn't left live.
 * If BOTH fail the cert is leaked-but-loudly-logged (alertable) — strictly better than a silent
 * strand. */
/** Best-effort DIRECT revoke of a minted cert we can't (or won't) queue. A CA DELETE that returns
 * success:false surfaces as revokeClientCert → 'failed' WITHOUT throwing, which leaves the cert live
 * exactly like a thrown error would — so both the 'failed' enum and a throw emit the distinct,
 * alertable hub.certs.orphan_revoke_failed (a leaked live cert must be actionable). Never throws. */
async function revokeOrphanCert(env: Env, certId: string, machineId: string): Promise<void> {
  try {
    const result = await revokeClientCert(env, certId);
    if (result !== 'revoked' && result !== 'pending_revocation') {
      console.log(JSON.stringify({ event: 'hub.certs.orphan_revoke_failed', machine: machineId, cert_id: certId, result }));
    }
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.orphan_revoke_failed', machine: machineId, cert_id: certId, error: String(e) }));
  }
}

async function reclaimOrphan(env: Env, fingerprint: string, certId: string, machineId: string): Promise<void> {
  try {
    await retireCert(env, fingerprint, certId, machineId);
    return;
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.orphan_queue_failed', machine: machineId, cert_id: certId, error: String(e) }));
  }
  await revokeOrphanCert(env, certId, machineId);
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
  let cur: { cert_fp_sha256: string | null; cert_id: string | null; prev_cert_fp_sha256: string | null; prev_cert_id: string | null; cert_revoke_at: string | null; is_admin: number } | null;
  try {
    cur = await env.DB.prepare('SELECT cert_fp_sha256, cert_id, prev_cert_fp_sha256, prev_cert_id, cert_revoke_at, is_admin FROM machines WHERE machine_id = ?1')
      .bind(identity.machineId)
      .first();
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.renew_read_failed', machine: identity.machineId, error: String(e) }));
    return Response.json({ error: 'cert_renewal_unavailable' }, { status: 503 });
  }

  // An admin machine's in-grace PREVIOUS cert must NOT mint a new CURRENT cert. isAdmin is already
  // slot-gated in machineIdentity, but renew's recovery branch would install the caller's CSR as current,
  // and the NEXT request on that freshly minted cert resolves as admin again — a 7-day re-escalation for
  // whoever holds the retired admin cert. The grace window exists for in-flight COLLECTOR recovery; for
  // admin machines the asymmetry says block it (an intrusion signal — log it). Non-admin grace recovery is
  // untouched. Read is_admin straight from the row (identity.isAdmin is already false for a grace slot).
  if (cur?.is_admin === 1 && identity.certSlot === 'grace') {
    console.log(JSON.stringify({ event: 'hub.certs.admin_grace_renew_blocked', machine: identity.machineId, cert_fp: identity.certFp ?? null }));
    return Response.json({ error: 'admin_renew_requires_current_cert' }, { status: 403 });
  }

  let signed: SignedCert;
  try {
    signed = await signClientCert(env, body.csr, identity.machineId);
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.sign_failed', machine: identity.machineId, error: String(e) }));
    return Response.json({ error: 'cf_sign_failed' }, { status: 502 });
  }
  let newFp: string;
  try {
    newFp = await certFingerprint(signed.certificate);
  } catch (e) {
    // CF returned success:true but a malformed / PEM-less certificate. We hold signed.id but have NO
    // fingerprint, and retired_certs is keyed on fingerprint — so this cert can't be QUEUED. Go straight
    // to a best-effort direct revoke (no placeholder fp invented) plus a loud, distinct event. Near-never,
    // but a stranded live cert must never be the silent failure mode.
    console.log(JSON.stringify({ event: 'hub.certs.fingerprint_failed', machine: identity.machineId, cert_id: signed.id, error: String(e) }));
    await revokeOrphanCert(env, signed.id, identity.machineId);
    return Response.json({ error: 'cf_sign_failed' }, { status: 502 });
  }

  const authFp = identity.certFp ?? null;
  const onCurrent = authFp !== null && authFp === cur?.cert_fp_sha256;

  // The cert this rotation displaces out of a machines-row slot (queued for revoke so it can never
  // become an untracked-but-CA-valid fingerprint): the old in-grace prev on a normal rotation, or
  // the orphaned successor (old current) on a recovery.
  const displaced = onCurrent
    ? { fp: cur?.prev_cert_fp_sha256 ?? null, id: cur?.prev_cert_id ?? null }
    : { fp: cur?.cert_fp_sha256 ?? null, id: cur?.cert_id ?? null };

  // RECOVERY (installing a successor over the orphaned old current, authed on the in-grace prev) is only
  // legitimate when BOTH still hold at pre-sign-read time: the caller resolved on the GRACE slot, AND its
  // authenticating fp is STILL this row's prev. Two races otherwise slip a stale cert in as current:
  //  - renew-vs-renew: the loser authed on the CURRENT cert (certSlot 'current'); the winner committed
  //    before our read, so onCurrent is now false — but that's a 409, NOT a lost-response recovery. The
  //    certSlot gate keeps it out; on retry it resolves as grace and recovers legitimately IFF the response
  //    was truly lost.
  //  - recovery-vs-renewal: a concurrent current-cert renewal rotated our fp OUT of the prev slot between
  //    machineIdentity and this read; requiring cur.prev_cert_fp_sha256 === our authenticating fp rejects
  //    the now-stale caller instead of installing it over the legit new current.
  // Both conditions are then pinned for the write by the full rotationCas below.
  const isRecovery = !onCurrent && identity.certSlot === 'grace' && (cur?.prev_cert_fp_sha256 ?? null) === authFp;

  let changes = 0;
  let effectiveRevokeAt: string | null = null;
  try {
    if (onCurrent) {
      // NORMAL rotation: authenticated on the CURRENT cert. Retire it into a fresh grace window.
      // ISO8601 millis+'Z' matches strftime('%Y-%m-%dT%H:%M:%fZ') so the identity guard compares
      // chronologically. Compare-and-swap on the authenticating fp: two renews racing off the same
      // current cert serialize — the first flips current, the second's WHERE no longer matches
      // (changes === 0) and it 409s, rather than last-writer-wins stranding the winner's cert. The
      // guarded queue INSERT co-commits with the swap so a displaced in-grace prev is never dropped.
      // The CAS pins the FULL observed rotation state via rotationCas (not just the fp): a concurrent
      // change to ANY field — e.g. an admin attaching a CA id to this fingerprint — makes it miss and
      // 409 rather than move a stale value (a NULL cert_id) into the prev slot. The retry re-reads.
      effectiveRevokeAt = new Date(Date.now() + CERT_GRACE_DAYS * 86_400_000).toISOString();
      const observed: RotationState = { cert_fp: cur!.cert_fp_sha256, cert_id: cur!.cert_id, prev_fp: cur!.prev_cert_fp_sha256, prev_id: cur!.prev_cert_id, revoke_at: cur!.cert_revoke_at };
      const cas = rotationCas(observed, 7);
      const swap = env.DB.prepare(
        `UPDATE machines
           SET prev_cert_fp_sha256 = ?2, prev_cert_id = ?3, cert_revoke_at = ?4,
               cert_fp_sha256 = ?5, cert_id = ?6
         WHERE machine_id = ?1 AND ${cas.clause}`,
      ).bind(identity.machineId, cur!.cert_fp_sha256, cur!.cert_id, effectiveRevokeAt, newFp, signed.id, ...cas.binds);
      // The state OUR swap produces — the retire INSERT co-commits only if the row is exactly this.
      const postSwap: RotationState = { cert_fp: newFp, cert_id: signed.id, prev_fp: cur!.cert_fp_sha256, prev_id: cur!.cert_id, revoke_at: effectiveRevokeAt };
      const stmts = [swap];
      if (displaced.fp) stmts.push(queueRetiredIfDisplaced(env, displaced.fp, displaced.id, identity.machineId, postSwap));
      const results = await env.DB.batch(stmts);
      changes = results[0]!.meta.changes ?? 0;
    } else if (isRecovery) {
      // RECOVERY: authenticated on the IN-GRACE PREVIOUS cert. The successor from an earlier renewal
      // was never installed (lost response), so the machine is stuck holding the old cert and would
      // otherwise die at cert_revoke_at with no path forward. Replace the orphaned successor (the
      // current slot) with this new cert WITHOUT touching the prev slot or its cert_revoke_at — grace
      // must NOT extend, or repeated prev-auth renews would keep an old cert alive forever. Keep the
      // ORIGINAL revoke_at. Guarded on the FULL observed state via rotationCas (so a concurrent id
      // attach to the orphaned successor can't be lost) PLUS the grace window still being open, so
      // concurrent recoveries serialize. The displaced orphaned successor is queued (co-committed).
      effectiveRevokeAt = cur?.cert_revoke_at ?? null;
      const observed: RotationState = { cert_fp: cur?.cert_fp_sha256 ?? null, cert_id: cur?.cert_id ?? null, prev_fp: cur?.prev_cert_fp_sha256 ?? null, prev_id: cur?.prev_cert_id ?? null, revoke_at: cur?.cert_revoke_at ?? null };
      const cas = rotationCas(observed, 4);
      const swap = env.DB.prepare(
        `UPDATE machines
           SET cert_fp_sha256 = ?2, cert_id = ?3
         WHERE machine_id = ?1 AND ${cas.clause}
           AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(identity.machineId, newFp, signed.id, ...cas.binds);
      // Recovery replaces only the current slot; prev/revoke_at are unchanged from what we observed.
      const postSwap: RotationState = { cert_fp: newFp, cert_id: signed.id, prev_fp: cur?.prev_cert_fp_sha256 ?? null, prev_id: cur?.prev_cert_id ?? null, revoke_at: cur?.cert_revoke_at ?? null };
      const stmts = [swap];
      if (displaced.fp) stmts.push(queueRetiredIfDisplaced(env, displaced.fp, displaced.id, identity.machineId, postSwap));
      const results = await env.DB.batch(stmts);
      changes = results[0]!.meta.changes ?? 0;
    } else {
      // Neither a current-cert rotation nor a legitimate grace recovery: the row moved under our pre-sign
      // read (a renew-vs-renew loser whose fp already rotated into prev, or a grace caller whose fp was
      // displaced out of prev by a concurrent renewal). Do NOT install a successor over it — leave
      // changes = 0 so the minted cert is reclaimed and we 409; the retry re-reads reality.
      changes = 0;
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

  console.log(JSON.stringify({ event: 'hub.certs.renewed', machine: identity.machineId, recovery: isRecovery, revoke_at: effectiveRevokeAt }));
  return Response.json({
    ok: true,
    certificate: signed.certificate,
    fingerprint: newFp,
    cert_id: signed.id,
    expires_on: signed.expires_on,
    prev_revoke_at: effectiveRevokeAt,
  });
}
