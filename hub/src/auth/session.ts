/**
 * Viewer sessions: a random opaque token in a `__Host-`-prefixed cookie, backed by KV.
 *
 * The API host never touches any of this — machine identity (mTLS) is resolved in
 * auth/identity.ts and the router never routes the API host through the viewer, so
 * cookies are meaningless there. Sessions belong to the single 'owner' user; the
 * distinction between passkeys is per-device, not per-user.
 */

const COOKIE = '__Host-session';
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const TTL_MILLISECONDS = TTL_SECONDS * 1000;
const SESSION_USER = 'owner';
const SESSION_VERSION = 1;
// Issuer and audience are derived from env.VIEWER_HOST, never hard-coded: a literal
// host silently bricks the viewer the moment VIEWER_HOST moves (readSession below
// rejects every request whose host is not the audience), which is exactly the
// lockout webauthn.ts already guards against for rpID. Moving the viewer host
// therefore invalidates outstanding sessions by design — the same cutover that
// invalidates passkeys.
const SESSION_ENVIRONMENT = 'production';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ENVELOPE_KEYS = ['claims', 'signature', 'version'];
const CLAIM_KEYS = ['audience', 'environment', 'expiresAt', 'issuedAt', 'issuer', 'sessionId', 'user'];
const TEXT_ENCODER = new TextEncoder();
const SIGNING_KEY_CACHE = new Map<string, Promise<CryptoKey>>();

export interface Session {
 user: string;
 created: number;
}

interface SessionClaims {
 issuer: string;
 audience: string;
 environment: string;
 user: string;
 issuedAt: number;
 expiresAt: number;
 sessionId: string;
}

interface SessionEnvelope {
 version: typeof SESSION_VERSION;
 claims: SessionClaims;
 signature: string;
}

/** Parse a Cookie header into a name→value map. */
function parseCookies(header: string | null): Record<string, string> {
 const out: Record<string, string> = {};
 if (!header) return out;
 for (const part of header.split(';')) {
  const eq = part.indexOf('=');
  if (eq < 0) continue;
  const name = part.slice(0, eq).trim();
  if (name) out[name] = part.slice(eq + 1).trim();
 }
 return out;
}

/** The session token carried by the request, if any. */
export function sessionToken(request: Request): string | null {
 return parseCookies(request.headers.get('cookie'))[COOKIE] ?? null;
}

/**
 * Resolve a production viewer session. Preview and development return before
 * touching KV, so even a mistakenly shared namespace cannot replay a production
 * cookie outside production.
 */
export async function readSession(request: Request, env: Env): Promise<Session | null> {
 if (env.ENVIRONMENT !== SESSION_ENVIRONMENT) return null;
 const audience = env.VIEWER_HOST;
 if (new URL(request.url).host !== audience) return null;

 const token = sessionToken(request);
 if (!token || !TOKEN_PATTERN.test(token)) return null;
 const raw = await env.KV.get(`sess:${token}`);
 if (!raw) return null;

 const envelope = parseEnvelope(raw);
 if (!envelope || envelope.claims.sessionId !== token) return null;
 if (!(await verifyEnvelope(envelope, env.PRODUCTION_SESSION_SIGNING_KEY))) return null;

 const { claims } = envelope;
 const now = Date.now();
 if (
  claims.issuer !== `https://${audience}` ||
  claims.audience !== audience ||
  claims.environment !== SESSION_ENVIRONMENT ||
  claims.user !== SESSION_USER ||
  claims.issuedAt < 0 ||
  claims.issuedAt > now ||
  claims.expiresAt <= now ||
  claims.expiresAt <= claims.issuedAt ||
  claims.expiresAt - claims.issuedAt > TTL_MILLISECONDS
 ) {
  return null;
 }
 return { user: claims.user, created: claims.issuedAt };
}

/** Mint an authenticated production session and return its browser cookie. */
export async function createSession(env: Env): Promise<string> {
 if (env.ENVIRONMENT !== SESSION_ENVIRONMENT) {
  throw new Error('viewer sessions may only be created in production');
 }
 const key = await signingKey(env.PRODUCTION_SESSION_SIGNING_KEY);
 if (!key) throw new Error('PRODUCTION_SESSION_SIGNING_KEY must be a base64url-encoded 32-byte secret');

 const token = randomToken();
 const issuedAt = Date.now();
 const claims: SessionClaims = {
  issuer: `https://${env.VIEWER_HOST}`,
  audience: env.VIEWER_HOST,
  environment: SESSION_ENVIRONMENT,
  user: SESSION_USER,
  issuedAt,
  expiresAt: issuedAt + TTL_MILLISECONDS,
  sessionId: token,
 };
 const authenticated = JSON.stringify({ version: SESSION_VERSION, claims });
 const signature = encodeBase64Url(await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(authenticated)));
 const envelope: SessionEnvelope = { version: SESSION_VERSION, claims, signature };
 await env.KV.put(`sess:${token}`, JSON.stringify(envelope), { expirationTtl: TTL_SECONDS });
 return sessionCookie(token, TTL_SECONDS);
}

/** Delete the request's session from KV and return a cookie value that clears it. */
export async function destroySession(request: Request, env: Env): Promise<string> {
 const token = sessionToken(request);
 if (token) await env.KV.delete(`sess:${token}`);
 return sessionCookie('', 0);
}

function sessionCookie(token: string, maxAge: number): string {
 // __Host- prefix requires Secure + Path=/ + no Domain; SameSite=Lax survives the
 // top-level redirect back from /login while still blocking cross-site POSTs.
 return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function randomToken(): string {
 const bytes = crypto.getRandomValues(new Uint8Array(32));
 let token = '';
 for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
 return token;
}

function parseEnvelope(raw: string): SessionEnvelope | null {
 let parsed: unknown;
 try {
  parsed = JSON.parse(raw);
 } catch {
  return null;
 }
 if (!hasExactKeys(parsed, ENVELOPE_KEYS)) return null;
 if (parsed.version !== SESSION_VERSION || typeof parsed.signature !== 'string' || !SIGNATURE_PATTERN.test(parsed.signature)) {
  return null;
 }
 const claims = parsed.claims;
 if (!hasExactKeys(claims, CLAIM_KEYS)) return null;
 if (
  typeof claims.issuer !== 'string' ||
  typeof claims.audience !== 'string' ||
  typeof claims.environment !== 'string' ||
  typeof claims.user !== 'string' ||
  typeof claims.issuedAt !== 'number' ||
  !Number.isSafeInteger(claims.issuedAt) ||
  typeof claims.expiresAt !== 'number' ||
  !Number.isSafeInteger(claims.expiresAt) ||
  typeof claims.sessionId !== 'string' ||
  !TOKEN_PATTERN.test(claims.sessionId)
 ) {
  return null;
 }
 return {
  version: SESSION_VERSION,
  claims: {
   issuer: claims.issuer,
   audience: claims.audience,
   environment: claims.environment,
   user: claims.user,
   issuedAt: claims.issuedAt,
   expiresAt: claims.expiresAt,
   sessionId: claims.sessionId,
  },
  signature: parsed.signature,
 };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
 if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
 const actual = Object.keys(value).sort();
 return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

async function verifyEnvelope(envelope: SessionEnvelope, secret: string | undefined): Promise<boolean> {
 let key: CryptoKey | null;
 try {
  key = await signingKey(secret);
 } catch {
  return false;
 }
 if (!key) return false;
 let signature: Uint8Array;
 try {
  signature = decodeBase64Url(envelope.signature);
 } catch {
  return false;
 }
 const authenticated = JSON.stringify({ version: envelope.version, claims: envelope.claims });
 return crypto.subtle.verify('HMAC', key, signature, TEXT_ENCODER.encode(authenticated));
}

async function signingKey(secret: string | undefined): Promise<CryptoKey | null> {
 if (!secret || !SIGNATURE_PATTERN.test(secret)) return null;
 const cached = SIGNING_KEY_CACHE.get(secret);
 if (cached) return cached;

 let bytes: Uint8Array;
 try {
  bytes = decodeBase64Url(secret);
 } catch {
  return null;
 }
 if (bytes.byteLength !== 32) return null;
 const pending = crypto.subtle
  .importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  .catch((error) => {
   SIGNING_KEY_CACHE.delete(secret);
   throw error;
  });
 SIGNING_KEY_CACHE.set(secret, pending);
 return pending;
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
 const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
 let binary = '';
 for (const byte of bytes) binary += String.fromCharCode(byte);
 return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
 const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
 const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
 if (encodeBase64Url(bytes) !== value) throw new Error('non-canonical base64url');
 return bytes;
}

/**
 * CSRF guard for state-changing viewer POSTs: the browser-set Origin header must
 * match the request's own origin. Fetches from the login/settings pages are
 * same-origin; a cross-site form/script cannot forge Origin.
 */
export function originOk(request: Request): boolean {
 const origin = request.headers.get('origin');
 if (!origin) return false;
 return origin === new URL(request.url).origin;
}
