import { originOk, readSession } from '../auth/session';
import { webauthnRoute } from '../auth/webauthn';
import { readGrantBrowserRoute } from '../auth/read-grants';
import { previewHumanIdentity } from '../auth/identity';
import { debugBrowserRoute } from '../api/debug-exchange';
import { assetEndpoint } from './assets';
import { blobEndpoint } from './blob';
import { exportZipEndpoint } from './export';
import { machinesPage } from './machines';
import { searchPage } from './search';
import { statsPage } from './stats';
import { sessionPage, TURNS_PER_PAGE } from './session';

/**
 * Host-routed viewer.
 *
 * Development is loopback-only and open. Production uses only its passkey session.
 * Preview authentication terminates at the trusted front door: PR code receives a
 * short-lived human assertion bound to this exact request, never an Access token,
 * production session, reusable bearer, or edge cookie.
 */
export async function viewerRoute(request: Request, url: URL, env: Env): Promise<Response> {
  // Preview has no local login or WebAuthn surface. Those routes would create/read a
  // production viewer session and must never be reachable through PR code.
  if (env.ENVIRONMENT !== 'preview') {
    const authResp = await webauthnRoute(request, url, env);
    if (authResp) return authResp;
    // The grant page needs no viewer session — the fresh passkey ceremony IS the auth,
    // exactly like /login. Preview must never reach it (same rule as webauthnRoute).
    const grantResp = await readGrantBrowserRoute(request, url, env);
    if (grantResp) return grantResp;
  }

  const access = await viewerAccess(request, env);
  if (access === 'deny') {
    if (env.ENVIRONMENT === 'preview') {
      return new Response('unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    return new Response(null, { status: 302, headers: { location: '/login' } });
  }

  const debug = await debugBrowserRoute(request, url, env);
  if (debug) return debug;

  let res: Response;
  if (request.method === 'GET') {
    res = await handle(url, env);
  } else if (request.method === 'POST') {
    res = await handlePost(request, url, env);
  } else {
    res = new Response('method not allowed', { status: 405 });
  }
  return res;
}

type Access = 'pass' | 'deny';

async function viewerAccess(request: Request, env: Env): Promise<Access> {
  if (env.ENVIRONMENT === 'development') return 'pass';
  if (env.ENVIRONMENT === 'preview') {
    return (await previewHumanIdentity(request, env)).kind === 'human' ? 'pass' : 'deny';
  }
  // Unknown or missing environments follow the production fail-closed path. Edge
  // assertions are deliberately ignored here.
  return (await readSession(request, env)) ? 'pass' : 'deny';
}

function handle(url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  if (path === '/' || path === '') return searchPage(url, env);
  if (path === '/machines') return machinesPage(env);
  if (path === '/stats') return statsPage(url, env);
  const asset = path.match(/^\/s\/([^/]+)\/asset\/([^/]+)\/([^/]+)$/);
  if (asset) {
    return assetEndpoint(
      decodeURIComponent(asset[1]!),
      decodeURIComponent(asset[2]!),
      decodeURIComponent(asset[3]!),
      url,
      env,
    );
  }

  const blob = path.match(/^\/s\/([^/]+)\/blob\/([^/]+)$/);
  if (blob) return blobEndpoint(decodeURIComponent(blob[1]!), decodeURIComponent(blob[2]!), url, env);
  const exportZip = path.match(/^\/s\/([^/]+)\/export\.zip$/);
  if (exportZip) return exportZipEndpoint(decodeURIComponent(exportZip[1]!), env);
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
