import { readSession } from '../auth/session';
import { webauthnRoute } from '../auth/webauthn';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage } from './session';

/**
 * Host-routed viewer. The auth surface (/login, /settings, /logout, /webauthn/*) is always
 * reachable so the owner can sign in. Everything else is gated by a valid passkey session
 * cookie in preview + production (and any non-'development' value — fail closed); development
 * stays open so the UI can be exercised without credentials. The machine API host is routed
 * away before reaching here, so no viewer session cookie is ever consulted on the API.
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const authResp = await webauthnRoute(request, url, env);
  if (authResp) return authResp;

  if (env.ENVIRONMENT !== 'development') {
    const session = await readSession(request, env);
    if (!session) return new Response(null, { status: 302, headers: { location: '/login' } });
  }

  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const path = url.pathname;
  if (path === '/' || path === '') return searchPage(url, env);
  if (path === '/machines') return machinesPage(env);

  const blob = path.match(/^\/s\/([^/]+)\/blob\/([^/]+)$/);
  if (blob) return blobEndpoint(decodeURIComponent(blob[1]!), decodeURIComponent(blob[2]!), url, env);

  const session = path.match(/^\/s\/([^/]+)\/?$/);
  if (session) return sessionPage(decodeURIComponent(session[1]!), url, env);

  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
