import { originOk, readSession } from '../auth/session';
import { webauthnRoute } from '../auth/webauthn';
import { downloadSessionRaw } from '../api/sessions';
import { blobEndpoint } from './blob';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { sessionPage, TURNS_PER_PAGE } from './session';
import { previewAccess, previewBootstrapRoute, withPreviewCookie } from './preview-auth';

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
  const previewBootstrap = await previewBootstrapRoute(request, url, env);
  if (previewBootstrap) return previewBootstrap;

  const authResp = await webauthnRoute(request, url, env);
  if (authResp) return authResp;

  const access = await viewerAccess(request, env);
  if (access === 'deny') return new Response(null, { status: 302, headers: { location: '/login' } });

  let res: Response;
  if (request.method === 'GET') {
    res = await handle(url, env);
  } else if (request.method === 'POST') {
    res = await handlePost(request, url, env);
  } else {
    res = new Response('method not allowed', { status: 405 });
  }
  return access === 'issue-cookie' ? withPreviewCookie(res, env) : res;
}

type Access = 'pass' | 'issue-cookie' | 'deny';

/** Decide viewer access without touching the response: pass, pass-and-set-cookie, or deny. */
async function viewerAccess(request: Request, env: Env): Promise<Access> {
  if (env.ENVIRONMENT === 'development') return 'pass';

  // A valid passkey session authorizes in every non-dev environment (the production path).
  if (await readSession(request, env)) return 'pass';

  // Preview-only DEV_AUTH fallback. Production ignores it entirely.
  if (env.ENVIRONMENT === 'preview') return previewAccess(request, env);

  return 'deny';
}

function handle(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  if (path === '/' || path === '') return searchPage(url, env);
  if (path === '/machines') return machinesPage(env);

  const download = path.match(/^\/s\/([^/]+)\/download$/);
  if (download) return downloadSessionRaw(decodeURIComponent(download[1]!), env);

  const blob = path.match(/^\/s\/([^/]+)\/blob\/([^/]+)$/);
  if (blob) return blobEndpoint(decodeURIComponent(blob[1]!), decodeURIComponent(blob[2]!), url, env);

  const session = path.match(/^\/s\/([^/]+)\/?$/);
  if (session) return sessionPage(decodeURIComponent(session[1]!), url, env);

  return Promise.resolve(
    new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
  );
}

async function handlePost(request: Request, url: URL, env: Env): Promise<Response> {
  const turnStar = url.pathname.match(/^\/s\/([^/]+)\/turns\/(\d+)\/(star|unstar)$/);
  if (!turnStar) return new Response('not found', { status: 404 });
  if (!originOk(request)) return new Response('forbidden', { status: 403 });

  const sessionId = decodeURIComponent(turnStar[1]!);
  const turnIndex = Number(turnStar[2]);
  const turn = await env.DB.prepare(
    `SELECT 1 AS present FROM blocks
     WHERE session_id = ?1 AND turn_index = ?2 AND btype != 'compaction'
     LIMIT 1`,
  )
    .bind(sessionId, turnIndex)
    .first<{ present: number }>();
  if (!turn) return new Response('turn not found', { status: 404 });

  if (turnStar[3] === 'star') {
    await env.DB.prepare(
      `INSERT INTO starred_turns (session_id, turn_index) VALUES (?1, ?2)
       ON CONFLICT (session_id, turn_index) DO NOTHING`,
    )
      .bind(sessionId, turnIndex)
      .run();
  } else {
    await env.DB.prepare('DELETE FROM starred_turns WHERE session_id = ?1 AND turn_index = ?2')
      .bind(sessionId, turnIndex)
      .run();
  }

  const page = Math.floor(turnIndex / TURNS_PER_PAGE) + 1;
  const view = url.searchParams.get('view') === 'effective' ? 'effective' : 'chronological';
  const location = `/s/${encodeURIComponent(sessionId)}?page=${page}&view=${view}#t${turnIndex}`;
  return new Response(null, { status: 303, headers: { location } });
}
