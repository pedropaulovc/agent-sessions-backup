export type Identity =
  | { kind: 'machine'; machineId: string; isAdmin: boolean }
  | { kind: 'human' }
  | { kind: 'anonymous' };

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
 */
export async function machineIdentity(request: Request, env: Env): Promise<Identity> {
  const tls = (request.cf as { tlsClientAuth?: { certVerified?: string; certFingerprintSHA256?: string } } | undefined)
    ?.tlsClientAuth;
  if (tls?.certVerified === 'SUCCESS' && tls.certFingerprintSHA256) {
    const row = await env.DB.prepare(
      'SELECT machine_id, is_admin FROM machines WHERE cert_fp_sha256 = ?1',
    )
      .bind(tls.certFingerprintSHA256)
      .first<{ machine_id: string; is_admin: number }>();
    if (!row) return { kind: 'anonymous' };
    return { kind: 'machine', machineId: row.machine_id, isAdmin: row.is_admin === 1 };
  }

  if (env.ENVIRONMENT === 'production') return { kind: 'anonymous' };

  if (env.ENVIRONMENT === 'preview') {
    const auth = request.headers.get('authorization');
    if (!env.DEV_AUTH || auth !== `Bearer ${env.DEV_AUTH}`) return { kind: 'anonymous' };
  }

  const dev = request.headers.get('x-dev-machine');
  if (dev) {
    await env.DB.prepare(
      `INSERT INTO machines (machine_id, os, hostname) VALUES (?1, ?2, ?1)
       ON CONFLICT (machine_id) DO NOTHING`,
    )
      .bind(dev, request.headers.get('x-dev-os') ?? 'linux')
      .run();
    return { kind: 'machine', machineId: dev, isAdmin: true };
  }
  return { kind: 'anonymous' };
}
