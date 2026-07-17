import { previewBearerOk } from '../auth/identity';
import { readSession } from '../auth/session';
import { webauthnRoute } from '../auth/webauthn';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage } from './session';

// __Host- prefix requires Secure + Path=/ + no Domain; the browser rejects it otherwise, which is
// exactly the hardening we want. Short-lived so a leaked cookie expires on its own.
const PREVIEW_COOKIE = '__Host-preview-auth';
const PREVIEW_COOKIE_MAX_AGE = 3600;

/**
 * Host-routed viewer. The auth surface (/login, /settings, /logout, /webauthn/*) is always
 * reachable so the owner can sign in. Everything else is gated:
 *
 *   - development: open (never publicly reachable).
 *   - production: a valid passkey session only — fail closed to /login otherwise.
 *   - preview (Workers Builds PR previews, served from *.workers.dev): a valid passkey
 *     session OR the DEV_AUTH bearer/cookie path. Passkey ceremonies are pinned to
 *     VIEWER_HOST (auth/webauthn.ts), and a sessions.vza.net session cookie is never sent
 *     to the *.workers.dev preview host, so a preview reviewer can never obtain a passkey
 *     session there — the DEV_AUTH bearer is their way in. A request that presents the
 *     valid bearer is issued a short-lived HttpOnly cookie (browsers can't attach
 *     Authorization to ordinary navigations or <img>/blob subresource loads, so a
 *     bearer-only gate would 401 every click and lazy image after the first request);
 *     subsequent requests authorize via that cookie OR the bearer.
 *
 * Any non-'development' value that isn't 'preview' (production, an unrecognized value, or a
 * missing binding) is treated as production: passkey session only, DEV_AUTH ignored. The
 * machine API host is routed away before reaching here, so no viewer cookie is ever
 * consulted on the API.
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const authResp = await webauthnRoute(request, url, env);
  if (authResp) return authResp;

  const access = await viewerAccess(request, env);
  if (access === 'deny') return new Response(null, { status: 302, headers: { location: '/login' } });

  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const res = await handle(url, env);
  return access === 'issue-cookie' ? withPreviewCookie(res, env) : res;
}

type Access = 'pass' | 'issue-cookie' | 'deny';

/** Decide viewer access without touching the response: pass, pass-and-set-cookie, or deny. */
async function viewerAccess(request: Request, env: Env): Promise<Access> {
  if (env.ENVIRONMENT === 'development') return 'pass';

  // A valid passkey session authorizes in every non-dev environment (the production path).
  if (await readSession(request, env)) return 'pass';

  // Preview-only DEV_AUTH fallback. Production ignores it entirely.
  if (env.ENVIRONMENT === 'preview') {
    if (previewBearerOk(request, env)) return 'issue-cookie';
    if (previewCookieOk(request, env)) return 'pass';
  }

  return 'deny';
}

function handle(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  if (path === '/' || path === '') return searchPage(url, env);
  if (path === '/machines') return machinesPage(env);

  const blob = path.match(/^\/s\/([^/]+)\/blob\/([^/]+)$/);
  if (blob) return blobEndpoint(decodeURIComponent(blob[1]!), decodeURIComponent(blob[2]!), url, env);

  const session = path.match(/^\/s\/([^/]+)\/?$/);
  if (session) return sessionPage(decodeURIComponent(session[1]!), url, env);

  return Promise.resolve(
    new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  );
}

/** Preview-cookie credential check: a matching preview cookie. The API path never calls this. */
function previewCookieOk(request: Request, env: Env): boolean {
  return !!env.DEV_AUTH && readCookie(request, PREVIEW_COOKIE) === env.DEV_AUTH;
}

/** Re-emit `res` with the preview auth cookie set. Clones so streaming bodies (session page) pass through. */
function withPreviewCookie(res: Response, env: Env): Response {
  const cookie =
    `${PREVIEW_COOKIE}=${env.DEV_AUTH}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${PREVIEW_COOKIE_MAX_AGE}`;
  const out = new Response(res.body, res);
  out.headers.append('set-cookie', cookie);
  return out;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
