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
const SESSION_USER = 'owner';

export interface Session {
  user: string;
  created: number;
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

/** Resolve the current session from the request cookie, or null if absent/expired. */
export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const raw = await env.KV.get(`sess:${token}`);
  if (!raw) return null;
  return JSON.parse(raw) as Session;
}

/** Mint a session in KV and return the `Set-Cookie` value that binds it to the browser. */
export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  const session: Session = { user: SESSION_USER, created: Date.now() };
  await env.KV.put(`sess:${token}`, JSON.stringify(session), { expirationTtl: TTL_SECONDS });
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
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
