export type Identity =
  | { kind: 'machine'; machineId: string; isAdmin: boolean; certFp?: string; certSlot: 'current' | 'grace'; actor?: string }
  | { kind: 'human'; actor: string }
  | { kind: 'anonymous' };

/**
 * Preview auth is ONE per-PR bearer. Each self-contained preview Worker is deployed with
 * `PREVIEW_BEARER` — HMAC-SHA256(seed, pr) derived independently by the provisioner, CI,
 * and the owner's machines (`~/.config/agent-sessions/preview-seed`). The seed is never
 * distributed through the public repo's logs or artifacts; the derived bearer is intentionally
 * published as the disposable preview's public login code. It is presented either as an
 * `Authorization: Bearer` header (agents, CI) or via the `__Host-preview-session` cookie
 * a `/?token=…` visit sets (browsers). The blast radius of a leaked token is one
 * disposable preview holding only deliberately exported data.
 */
export const PREVIEW_SESSION_COOKIE = '__Host-preview-session';
/** The machine identity a preview bearer resolves to (admin: it re-uploads any machine's files). */
export const PREVIEW_BEARER_MACHINE = 'preview-bearer';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Constant-time-ish equality: compare fixed-length digests, not attacker-controlled strings. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/** True when `token` is this preview's bearer (used by the viewer's `/?token=…` cookie mint). */
export async function previewBearerTokenOk(token: string | null, env: Env): Promise<boolean> {
  if (env.ENVIRONMENT !== 'preview' || !env.PREVIEW_BEARER || !token) return false;
  return tokenMatches(token, env.PREVIEW_BEARER);
}

/**
 * True when the request presents the preview bearer via header or session cookie.
 * VIEWER pages only — the machine API deliberately never accepts the cookie
 * (see previewApiBearerOk), so a cross-site top-level GET riding the SameSite=Lax
 * cookie can reach nothing but pages same-origin policy already walls off.
 */
export async function previewBearerOk(request: Request, env: Env): Promise<boolean> {
  if (env.ENVIRONMENT !== 'preview' || !env.PREVIEW_BEARER) return false;
  const auth = request.headers.get('authorization');
  const presented = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : cookieValue(request, PREVIEW_SESSION_COOKIE);
  return previewBearerTokenOk(presented, env);
}

/** The machine-API gate: explicit `Authorization: Bearer` only, never the browser cookie. */
async function previewApiBearerOk(request: Request, env: Env): Promise<boolean> {
  if (env.ENVIRONMENT !== 'preview' || !env.PREVIEW_BEARER) return false;
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  return previewBearerTokenOk(auth.slice('Bearer '.length), env);
}

/** Resolve a human viewer identity in preview from the per-PR bearer. */
export async function previewHumanIdentity(request: Request, env: Env): Promise<Identity> {
  if (!(await previewBearerOk(request, env))) return { kind: 'anonymous' };
  return { kind: 'human', actor: PREVIEW_BEARER_MACHINE };
}

/**
 * Production resolves machine identity only from verified mTLS. Development retains the
 * loopback-only x-dev-machine convenience. Preview accepts the per-PR bearer as an admin
 * machine identity so the standard collector upload path can push hand-carried session
 * zips under their original machine ids.
 */
export async function machineIdentity(request: Request, env: Env): Promise<Identity> {
  const tls = (
    request.cf as { tlsClientAuth?: { certVerified?: string; certRevoked?: string; certFingerprintSHA256?: string } } | undefined
  )?.tlsClientAuth;
  const revoked = tls?.certRevoked === '1' || tls?.certRevoked === 'true';
  if (tls?.certVerified === 'SUCCESS' && !revoked && tls.certFingerprintSHA256) {
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
    const isAdmin = row.is_admin === 1 && row.cert_slot === 'current';
    return { kind: 'machine', machineId: row.machine_id, isAdmin, certFp: tls.certFingerprintSHA256, certSlot: row.cert_slot };
  }

  if (env.ENVIRONMENT === 'development') return devHeaderIdentity(request, env);
  if (env.ENVIRONMENT === 'preview') {
    if (!(await previewApiBearerOk(request, env))) return { kind: 'anonymous' };
    return {
      kind: 'machine', machineId: PREVIEW_BEARER_MACHINE, isAdmin: true,
      certSlot: 'current', actor: PREVIEW_BEARER_MACHINE,
    };
  }
  return { kind: 'anonymous' };
}

/**
 * The one preview gate both upload entry points share: an admin identity pushing a
 * hand-carried zip may name machines this environment has never seen, so the target
 * machine's row is created before the files-table FK needs it. Covers the synthetic
 * bearer machine itself too — machineIdentity no longer writes D1 on every request.
 */
export async function ensurePreviewUploadMachine(env: Env, identity: Identity, machineId: string): Promise<void> {
  if (env.ENVIRONMENT !== 'preview') return;
  if (identity.kind !== 'machine' || !identity.isAdmin) return;
  await ensureMachineRow(env, machineId, machineId === PREVIEW_BEARER_MACHINE ? 'synthetic' : 'unknown');
}

/**
 * The files table references machines(machine_id), and preview uploads legitimately name
 * machines the environment has never seen (a zip exported from production). Admin identities
 * in preview/development may create the row on first touch.
 */
export async function ensureMachineRow(env: Env, machineId: string, osName = 'unknown'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO machines (machine_id, os, hostname) VALUES (?1, ?2, ?1)
     ON CONFLICT (machine_id) DO NOTHING`,
  ).bind(machineId, osName).run();
}

async function devHeaderIdentity(request: Request, env: Env): Promise<Identity> {
  const dev = request.headers.get('x-dev-machine');
  if (!dev) return { kind: 'anonymous' };
  await ensureMachineRow(env, dev, request.headers.get('x-dev-os') ?? 'linux');
  return { kind: 'machine', machineId: dev, isAdmin: true, certSlot: 'current' };
}
