import { previewBearerOk } from '../auth/identity';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage } from './session';

// __Host- prefix requires Secure + Path=/ + no Domain; the browser rejects it otherwise, which is exactly
// the hardening we want. Short-lived so a leaked cookie expires on its own.
const PREVIEW_COOKIE = '__Host-preview-auth';
const PREVIEW_COOKIE_MAX_AGE = 3600;

/**
 * Host-routed viewer. Access is an explicit fail-closed allowlist mirroring the API's machineIdentity:
 * only 'development' (never publicly reachable) and 'preview' with a verified DEV_AUTH credential may serve.
 * 'production' is closed until passkeys land (M3); any unrecognized/missing ENVIRONMENT — e.g. a deploy
 * using the checked-in default without an override — also fails closed rather than exposing transcripts.
 *
 * Preview auth: the browser can't attach `Authorization` to ordinary navigations or <img>/blob subresource
 * loads, so a bearer-only gate would 401 every click and lazy image after the first request. A request that
 * presents the valid bearer is issued a short-lived HttpOnly cookie; subsequent requests authorize via that
 * cookie OR the bearer. The machine API stays bearer-only (it never consults the cookie).
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  let issueCookie = false;
  if (env.ENVIRONMENT === 'development') {
    // open — never publicly reachable
  } else if (env.ENVIRONMENT === 'preview') {
    if (!previewViewerAuthorized(request, env)) {
      return new Response('unauthorized — send `Authorization: Bearer <DEV_AUTH>` once to obtain a session cookie', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // Persist auth in the browser only when it arrived via the bearer header (a cookie request is already set).
    issueCookie = previewBearerOk(request, env);
  } else {
    // 'production', an unrecognized value, or a missing binding — closed until passkeys (M3).
    return new Response('auth not yet configured', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const res = await handle(url, env);
  return issueCookie ? withPreviewCookie(res, env) : res;
}

function handle(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  if (path === '/' || path === '') return searchPage(url, env);
  if (path === '/machines') return machinesPage(env);

  const blob = path.match(/^\/s\/([^/]+)\/blob\/([^/]+)$/);
  if (blob) return blobEndpoint(decodeURIComponent(blob[1]!), decodeURIComponent(blob[2]!), url, env);

  const session = path.match(/^\/s\/([^/]+)\/?$/);
  if (session) return sessionPage(decodeURIComponent(session[1]!), url, env);

  return Promise.resolve(new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}

/** Viewer-only credential check: valid bearer header OR a matching preview cookie. The API path never calls this. */
function previewViewerAuthorized(request: Request, env: Env): boolean {
  if (previewBearerOk(request, env)) return true;
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
