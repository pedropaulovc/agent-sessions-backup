export type Identity =
  // certFp is the client-cert fingerprint that authenticated this request (current OR an
  // in-grace previous fp). certs/renew compare-and-swaps on it so a concurrent renew can't
  // strand a cert; absent for dev/preview header identities, which never rotate certs.
  // certSlot says WHICH fingerprint matched: 'current' or an in-grace 'grace' (previous) cert.
  // Admin routes require 'current' — a rotated-out admin cert must not run fleet writes during its
  // 7-day grace window. Uploads/heartbeat/renew accept either. Dev/preview identities are 'current'.
  | { kind: 'machine'; machineId: string; isAdmin: boolean; certFp?: string; certSlot: 'current' | 'grace' }
  | { kind: 'human' }
  | { kind: 'anonymous' };

/**
 * PR previews (Workers Builds) are publicly reachable and bind real -preview D1/R2, so both the API
 * and the viewer gate on a shared secret there. A missing/empty DEV_AUTH secret denies rather than
 * silently trusting the request. Used by machineIdentity() and the viewer router.
 */
export function previewBearerOk(request: Request, env: Env): boolean {
  return !!env.DEV_AUTH && request.headers.get('authorization') === `Bearer ${env.DEV_AUTH}`;
}

/**
 * Resolve the caller of a machine-API request.
 *
 * Production: Cloudflare mTLS — cert must be verified at the edge (WAF blocks
 * otherwise; this is defense in depth) and its fingerprint mapped to a machines row.
 * Development (local wrangler dev / vitest): `x-dev-machine` header names the machine
 * (auto-registered), no further auth — this environment is never publicly reachable.
 * Preview (Workers Builds PR previews, which ARE publicly reachable): `x-dev-machine`
 * is only trusted alongside a matching `authorization: Bearer ${env.DEV_AUTH}` header,
 * so a preview deployment doesn't grant unauthenticated admin access to anyone who finds
 * its URL. A missing/empty DEV_AUTH secret denies rather than silently trusting the header.
 *
 * `env.ENVIRONMENT` is an explicit allowlist, not a set of special cases carved out of an
 * otherwise-open default: only 'development' and 'preview' (with a verified bearer) ever
 * reach the dev-header path. Anything else — 'production', an unrecognized value, or a
 * missing binding (e.g. a `wrangler deploy` using the checked-in default without an
 * environment override) — falls through to the closed default of anonymous. This way a
 * misconfigured deploy fails closed instead of accidentally granting admin.
 */
export async function machineIdentity(request: Request, env: Env): Promise<Identity> {
  const tls = (
    request.cf as { tlsClientAuth?: { certVerified?: string; certRevoked?: string; certFingerprintSHA256?: string } } | undefined
  )?.tlsClientAuth;
  // certVerified stays 'SUCCESS' for a REVOKED but otherwise-valid cert — Cloudflare exposes
  // revocation as the separate certRevoked flag — so a decommissioned or compromised machine
  // whose row still exists in `machines` could otherwise keep authenticating. Reject revoked
  // certs here too; the edge WAF rule is the first line, this is defense in depth.
  // The client-certificate variables doc says certRevoked is the string '1' (revoked) / '0'
  // (not) — https://developers.cloudflare.com/ssl/client-certificates/client-certificate-variables/
  // — so '1' is the primary case; we also treat 'true' as revoked to be robust to doc drift
  // (fail closed on any truthy-looking value rather than admit a revoked cert).
  const revoked = tls?.certRevoked === '1' || tls?.certRevoked === 'true';
  if (tls?.certVerified === 'SUCCESS' && !revoked && tls.certFingerprintSHA256) {
    // During a cert-rotation grace window (see migrations/0005_cert_rotation.sql) a machine
    // has TWO valid fingerprints: the new current one and the previous one being retired.
    // Match either — the current cert_fp_sha256, OR the previous fingerprint while its
    // cert_revoke_at is still in the future — so an in-flight collector presenting the old
    // cert keeps authenticating until the +7d prune revokes it. This is the single place
    // every machine-authenticated route (uploads, heartbeat, renew itself) resolves identity.
    const row = await env.DB.prepare(
      `SELECT machine_id, is_admin,
              CASE WHEN cert_fp_sha256 = ?1 THEN 'current' ELSE 'grace' END AS cert_slot
         FROM machines
        WHERE cert_fp_sha256 = ?1
           OR (prev_cert_fp_sha256 = ?1 AND cert_revoke_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
      .bind(tls.certFingerprintSHA256)
      .first<{ machine_id: string; is_admin: number; cert_slot: 'current' | 'grace' }>();
    if (!row) return { kind: 'anonymous' };
    // isAdmin is gated on the CURRENT slot: a rotated-out admin cert loses admin power during its 7-day
    // grace window at the chokepoint, so putFile/ownsPath/multipart (which key on identity.isAdmin for
    // the cross-machine write bypass) inherit the restriction with no changes. An admin's own collector
    // still uploads to its own path via machineId match. The router's certSlot check is belt-and-braces.
    const isAdmin = row.is_admin === 1 && row.cert_slot === 'current';
    return { kind: 'machine', machineId: row.machine_id, isAdmin, certFp: tls.certFingerprintSHA256, certSlot: row.cert_slot };
  }

  if (env.ENVIRONMENT === 'development') return devHeaderIdentity(request, env);

  if (env.ENVIRONMENT === 'preview' && previewBearerOk(request, env)) return devHeaderIdentity(request, env);

  // 'production', or any unrecognized/missing value — fail closed.
  return { kind: 'anonymous' };
}

async function devHeaderIdentity(request: Request, env: Env): Promise<Identity> {
  const dev = request.headers.get('x-dev-machine');
  if (!dev) return { kind: 'anonymous' };
  await env.DB.prepare(
    `INSERT INTO machines (machine_id, os, hostname) VALUES (?1, ?2, ?1)
     ON CONFLICT (machine_id) DO NOTHING`,
  )
    .bind(dev, request.headers.get('x-dev-os') ?? 'linux')
    .run();
  return { kind: 'machine', machineId: dev, isAdmin: true, certSlot: 'current' };
}
