export type Identity =
  | { kind: 'machine'; machineId: string; isAdmin: boolean; certFp?: string; certSlot: 'current' | 'grace'; actor?: string }
  | { kind: 'human'; actor: string }
  | { kind: 'anonymous' };

const AUDIENCES = {
  browser: 'urn:sessions:preview:browser:v1',
  action: 'urn:sessions:preview:action:v1',
  origin: 'urn:sessions:preview:origin:v1',
} as const;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type PreviewEnv = Env & {
  PREVIEW_ASSERTION_ISSUER?: string;
  PREVIEW_PR_NUMBER?: string;
  PREVIEW_HEAD_SHA?: string;
  PREVIEW_GENERATION?: string;
  PREVIEW_ARTIFACT_DIGEST?: string;
  PREVIEW_BROWSER_ASSERTION_JWKS?: string;
  PREVIEW_ACTION_ASSERTION_JWKS?: string;
  PREVIEW_ORIGIN_ASSERTION_JWKS?: string;
};

type AssertionKind = 'browser' | 'action' | 'origin';
type PreviewJwk = JsonWebKey & { kid: string; revoked?: boolean; notBefore?: number; notAfter?: number };
interface AssertionClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  jti: string;
  pr: number;
  head: string;
  generation: string;
  method: string;
  target: string;
  bodyDigest?: string;
  actor?: string;
  identity?: string;
  machineId?: string;
  isAdmin?: boolean;
  artifactDigest?: string;
}

function base64UrlBytes(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function jsonSegment<T>(value: string): T | null {
  const bytes = base64UrlBytes(value);
  if (!bytes) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return null; }
}

function configuredKeys(env: PreviewEnv, kind: AssertionKind): PreviewJwk[] | null {
  const source = kind === 'browser'
    ? env.PREVIEW_BROWSER_ASSERTION_JWKS
    : kind === 'action'
      ? env.PREVIEW_ACTION_ASSERTION_JWKS
      : env.PREVIEW_ORIGIN_ASSERTION_JWKS;
  if (!source) return null;
  try {
    const parsed = JSON.parse(source) as { keys?: PreviewJwk[] };
    return Array.isArray(parsed.keys) ? parsed.keys : null;
  } catch {
    return null;
  }
}

function canonicalRequestTarget(request: Request): string | null {
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  if (/%(?:2f|5c)/i.test(target) || /%(?![0-9a-f]{2})/i.test(target)) return null;
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) return null;
    seen.add(normalized);
  }
  return target;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyAssertionSignature(token: string, env: PreviewEnv, kind: AssertionKind, now: number): Promise<AssertionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = jsonSegment<{ alg?: string; typ?: string; kid?: string }>(encodedHeader);
  const claims = jsonSegment<AssertionClaims>(encodedClaims);
  const signature = base64UrlBytes(encodedSignature);
  if (!header || header.alg !== 'RS256' || header.typ !== 'JWT' || !header.kid || !claims || !signature) return null;
  const keys = configuredKeys(env, kind);
  const key = keys?.find((candidate) => candidate.kid === header.kid
    && !candidate.revoked
    && (candidate.notBefore === undefined || now >= candidate.notBefore)
    && (candidate.notAfter === undefined || now < candidate.notAfter));
  if (!key) return null;
  try {
    const imported = await crypto.subtle.importKey(
      'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', imported, signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    return valid ? claims : null;
  } catch {
    return null;
  }
}

async function verifiedPreviewAssertion(request: Request, env: PreviewEnv, kind: AssertionKind): Promise<AssertionClaims | null> {
  if (env.ENVIRONMENT !== 'preview') return null;
  const header = kind === 'browser'
    ? 'x-preview-browser-assertion'
    : kind === 'action'
      ? 'x-preview-action-assertion'
      : 'x-preview-origin-assertion';
  const token = request.headers.get(header);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const claims = await verifyAssertionSignature(token, env, kind, now);
  if (!claims) return null;
  const expectedAudience = AUDIENCES[kind];
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const target = canonicalRequestTarget(request);
  if (!env.PREVIEW_ASSERTION_ISSUER || claims.iss !== env.PREVIEW_ASSERTION_ISSUER || !audiences.includes(expectedAudience)) return null;
  if (!Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || now >= claims.exp || claims.exp - claims.iat > 60 || claims.iat > now + 5) return null;
  if (!claims.jti || claims.jti.length > 128 || !/^[A-Za-z0-9_-]+$/.test(claims.jti)) return null;
  if (claims.pr !== Number(env.PREVIEW_PR_NUMBER) || claims.head !== env.PREVIEW_HEAD_SHA || claims.generation !== env.PREVIEW_GENERATION) return null;
  if (!target || claims.method !== request.method || claims.target !== target) return null;
  const digest = MUTATING_METHODS.has(request.method) ? await sha256Hex(await request.clone().arrayBuffer()) : undefined;
  if (claims.bodyDigest !== digest) return null;
  if (kind === 'origin' && claims.artifactDigest !== env.PREVIEW_ARTIFACT_DIGEST) return null;
  return claims;
}

async function consumeAssertion(env: Env, claims: AssertionClaims): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING RETURNING key`,
  )
    .bind(`edge_assertion:${claims.jti}`, String(claims.exp))
    .first<{ key: string }>();
  return !!result;
}

/** Preview Workers accept traffic only when the trusted front door signed the exact request. */
export async function requirePreviewOrigin(request: Request, env: Env): Promise<boolean> {
  if (env.ENVIRONMENT !== 'preview') return true;
  return !!(await verifiedPreviewAssertion(request, env as PreviewEnv, 'origin'));
}

/** Resolve a human viewer identity solely from the front door's browser assertion. */
export async function previewHumanIdentity(request: Request, env: Env): Promise<Identity> {
  if (env.ENVIRONMENT !== 'preview') return { kind: 'anonymous' };
  const claims = await verifiedPreviewAssertion(request, env as PreviewEnv, 'browser');
  if (!claims || claims.identity !== 'human' || typeof claims.actor !== 'string' || !claims.actor) return { kind: 'anonymous' };
  if (!await consumeAssertion(env, claims)) return { kind: 'anonymous' };
  return { kind: 'human', actor: claims.actor };
}

/**
 * Production resolves machine identity only from verified mTLS. Development retains the
 * loopback-only x-dev-machine convenience. Preview accepts only a target-bound action assertion;
 * it never accepts a reusable bearer or a caller-supplied identity header by itself.
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
    const claims = await verifiedPreviewAssertion(request, env as PreviewEnv, 'action');
    if (!claims || claims.identity !== 'machine' || !claims.actor || !claims.machineId) return { kind: 'anonymous' };
    if (!await consumeAssertion(env, claims)) return { kind: 'anonymous' };
    await ensurePreviewMachine(env, claims.machineId);
    return {
      kind: 'machine', machineId: claims.machineId, isAdmin: claims.isAdmin === true,
      certSlot: 'current', actor: claims.actor,
    };
  }
  return { kind: 'anonymous' };
}

async function ensurePreviewMachine(env: Env, machineId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO machines (machine_id, os, hostname) VALUES (?1, 'linux', ?1)
     ON CONFLICT (machine_id) DO NOTHING`,
  ).bind(machineId).run();
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
