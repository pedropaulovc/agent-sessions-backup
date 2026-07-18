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

/** Revoke a previously-issued client cert at the managed CA (DELETE = revoke). Returns whether
 * Cloudflare reported success — the prune cron only clears the rotation columns on `true`, so a
 * transient failure retries next run. */
export async function revokeClientCert(env: Env, certId: string): Promise<boolean> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/client_certificates/${certId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_CLIENT_CERT_TOKEN}` } },
  );
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return data.success === true;
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

  let signed: SignedCert;
  try {
    signed = await signClientCert(env, body.csr);
  } catch (e) {
    console.log(JSON.stringify({ event: 'hub.certs.sign_failed', machine: identity.machineId, error: String(e) }));
    return Response.json({ error: 'cf_sign_failed' }, { status: 502 });
  }
  const newFp = await certFingerprint(signed.certificate);

  const cur = await env.DB.prepare('SELECT cert_fp_sha256, cert_id FROM machines WHERE machine_id = ?1')
    .bind(identity.machineId)
    .first<{ cert_fp_sha256: string | null; cert_id: string | null }>();

  // ISO8601 with millis + 'Z' — the exact shape strftime('%Y-%m-%dT%H:%M:%fZ') produces, so the
  // identity guard's lexicographic `cert_revoke_at > now` compares chronologically.
  const revokeAt = new Date(Date.now() + CERT_GRACE_DAYS * 86_400_000).toISOString();

  // Compare-and-swap on the fingerprint that authenticated THIS request: the swap only lands
  // while that fp is still current. Two renews racing off the same cert therefore serialize —
  // the first flips current to its new fp, the second's WHERE no longer matches (changes === 0)
  // and it loses. Without this, last-writer-wins would overwrite the winner's current/prev and
  // strand the loser's just-issued cert in neither slot → a locked-out machine.
  const swap = await env.DB.prepare(
    `UPDATE machines
       SET prev_cert_fp_sha256 = ?2, prev_cert_id = ?3, cert_revoke_at = ?4,
           cert_fp_sha256 = ?5, cert_id = ?6
     WHERE machine_id = ?1 AND cert_fp_sha256 = ?7`,
  )
    .bind(identity.machineId, cur?.cert_fp_sha256 ?? null, cur?.cert_id ?? null, revokeAt, newFp, signed.id, identity.certFp ?? null)
    .run();

  if (swap.meta.changes === 0) {
    // A competing rotation already advanced the current fp (or this request authenticated on an
    // already-retired prev cert). The cert we just minted is an orphan — best-effort revoke it so
    // it doesn't linger at the CA (it otherwise ages out at the 1-year validity). Never let a
    // revoke failure mask the 409.
    try {
      await revokeClientCert(env, signed.id);
    } catch (e) {
      console.log(JSON.stringify({ event: 'hub.certs.orphan_revoke_failed', machine: identity.machineId, cert_id: signed.id, error: String(e) }));
    }
    return Response.json({ error: 'renew_conflict' }, { status: 409 });
  }

  console.log(JSON.stringify({ event: 'hub.certs.renewed', machine: identity.machineId, revoke_at: revokeAt }));
  return Response.json({
    ok: true,
    certificate: signed.certificate,
    fingerprint: newFp,
    cert_id: signed.id,
    expires_on: signed.expires_on,
    prev_revoke_at: revokeAt,
  });
}
