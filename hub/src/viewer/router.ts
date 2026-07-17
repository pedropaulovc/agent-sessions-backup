import { previewBearerOk } from '../auth/identity';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage } from './session';

/**
 * Host-routed viewer. Auth (passkeys) lands in M3; until then production is closed. Local development is
 * open (never publicly reachable). PR previews ARE publicly reachable and bind real -preview D1/R2, so they
 * require the same DEV_AUTH bearer the API uses — otherwise anyone with the preview URL could read transcripts.
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (env.ENVIRONMENT === 'production') {
    return new Response('auth not yet configured', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (env.ENVIRONMENT === 'preview' && !previewBearerOk(request, env)) {
    return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } });
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
