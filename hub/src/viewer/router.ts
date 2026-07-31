import { originOk, readSession } from '../auth/session';
import { webauthnRoute } from '../auth/webauthn';
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
    `SELECT f.content_hash, s.updated_at, s.index_state,
            EXISTS (
              SELECT 1 FROM blocks b
              WHERE b.session_id = s.session_id
                AND b.file_id = s.canonical_file_id
                AND b.turn_index = ?2
                AND b.btype != 'compaction'
            ) AS turn_present
     FROM sessions s
     JOIN files f ON f.id = s.canonical_file_id
     WHERE s.session_id = ?1`,
  )
    .bind(sessionId, turnIndex)
    .first<{
      content_hash: string;
      updated_at: string | null;
      index_state: string;
      turn_present: number;
    }>();
  if (!turn) return new Response('turn not found', { status: 404 });

  const form = await request.formData().catch(() => null);
  const turnKey = form?.get('turn_key');
  const transcriptRevision = form?.get('transcript_revision');
  if (typeof turnKey !== 'string' || turnKey.length === 0 || turnKey.length > 1024) {
    return new Response('bad turn key', { status: 400 });
  }
  const currentRevision = `${turn.content_hash}:${turn.updated_at ?? ''}`;
  if (
    turn.index_state !== 'ready' ||
    typeof transcriptRevision !== 'string' ||
    transcriptRevision !== currentRevision
  ) {
    return new Response('stale transcript', { status: 409 });
  }
  if (turn.turn_present !== 1) return new Response('turn not found', { status: 404 });

  let applied: { applied: number } | null;
  if (turnStar[3] === 'star') {
    applied = await env.DB.prepare(
      `INSERT INTO starred_turns (session_id, turn_key)
       SELECT ?1, ?2
       WHERE EXISTS (
         SELECT 1
         FROM sessions s
         JOIN files f ON f.id = s.canonical_file_id
         JOIN blocks b ON b.session_id = s.session_id AND b.file_id = s.canonical_file_id
         WHERE s.session_id = ?1
           AND s.index_state = 'ready'
           AND b.turn_index = ?3
           AND b.btype != 'compaction'
           AND f.content_hash || ':' || COALESCE(s.updated_at, '') = ?4
       )
       ON CONFLICT (session_id, turn_key) DO UPDATE SET turn_key = excluded.turn_key
       RETURNING 1 AS applied`,
    )
      .bind(sessionId, turnKey, turnIndex, transcriptRevision)
      .first<{ applied: number }>();
  } else {
    const [guard] = await env.DB.batch<{ applied: number }>([
      env.DB.prepare(
        `SELECT 1 AS applied
         FROM sessions s
         JOIN files f ON f.id = s.canonical_file_id
         JOIN blocks b ON b.session_id = s.session_id AND b.file_id = s.canonical_file_id
         WHERE s.session_id = ?1
           AND s.index_state = 'ready'
           AND b.turn_index = ?3
           AND b.btype != 'compaction'
           AND f.content_hash || ':' || COALESCE(s.updated_at, '') = ?4
         LIMIT 1`,
      ).bind(sessionId, turnKey, turnIndex, transcriptRevision),
      env.DB.prepare(
        `DELETE FROM starred_turns
         WHERE session_id = ?1
           AND turn_key = ?2
           AND EXISTS (
             SELECT 1
             FROM sessions s
             JOIN files f ON f.id = s.canonical_file_id
             JOIN blocks b ON b.session_id = s.session_id AND b.file_id = s.canonical_file_id
             WHERE s.session_id = ?1
               AND s.index_state = 'ready'
               AND b.turn_index = ?3
               AND b.btype != 'compaction'
               AND f.content_hash || ':' || COALESCE(s.updated_at, '') = ?4
           )`,
      ).bind(sessionId, turnKey, turnIndex, transcriptRevision),
    ]);
    applied = guard?.results[0] ?? null;
  }
  if (!applied) return new Response('stale transcript', { status: 409 });

  const page = Math.floor(turnIndex / TURNS_PER_PAGE) + 1;
  const view = url.searchParams.get('view') === 'effective' ? 'effective' : 'chronological';
  const location = `/s/${encodeURIComponent(sessionId)}?page=${page}&view=${view}#t${turnIndex}`;
  return new Response(null, { status: 303, headers: { location } });
}
