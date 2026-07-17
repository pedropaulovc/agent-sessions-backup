import { previewBearerOk } from '../auth/identity';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage } from './session';

/**
 * Host-routed viewer. Access is an explicit fail-closed allowlist mirroring the API's machineIdentity:
 * only 'development' (never publicly reachable) and 'preview' with a verified DEV_AUTH bearer may serve.
 * 'production' is closed until passkeys land (M3); any unrecognized/missing ENVIRONMENT — e.g. a deploy
 * using the checked-in default without an override — also fails closed rather than exposing transcripts.
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  if (env.ENVIRONMENT === 'development') {
    // open — never publicly reachable
  } else if (env.ENVIRONMENT === 'preview') {
    if (!previewBearerOk(request, env)) {
      return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  } else {
    // 'production', an unrecognized value, or a missing binding — closed until passkeys (M3).
    return new Response('auth not yet configured', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
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
