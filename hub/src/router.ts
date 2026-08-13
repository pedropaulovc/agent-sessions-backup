import { machineIdentity, requirePreviewOrigin } from './auth/identity';
import { grantIdentity, readGrantApiRoute, type GrantIdentity } from './auth/read-grants';
import {
  cloudflareOAuthStatus,
  completeCloudflareOAuth,
  disconnectCloudflareOAuth,
  startCloudflareOAuth,
} from './auth/cloudflare-oauth';
import { checkFiles, putFile } from './api/upload';
import { abortMultipart, completeMultipart, createMultipart, uploadPart } from './api/multipart';
import { adminMachines, heartbeat, listMachines, priceUsageSlice, reindex, status, usage } from './api/ops';
import { bootstrap } from './api/bootstrap';
import { probeClientCert, renewCert } from './api/certs';
import { search } from './api/search';
import { getSession, getSessionRaw, listSessions } from './api/sessions';
import { debugApiRoute } from './api/debug-exchange';
import { viewerRoute } from './viewer/router';

/** decodeURIComponent that returns null instead of throwing on a malformed %-sequence, so a bad
 * path/id segment becomes a 400 rather than an uncaught 500. */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}


export async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // Preview version URLs are public infrastructure endpoints. Only the trusted front
  // door may reach PR code; production/development deliberately ignore this header.
  if (!await requirePreviewOrigin(request, env)) {
    return Response.json({ error: 'direct_origin_denied' }, { status: 403 });
  }

  if (url.pathname === '/healthz') {
    if (env.ENVIRONMENT !== 'development') {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }
    return Response.json({
      ok: true,
      environment: env.ENVIRONMENT,
      environmentId: env.ENVIRONMENT_ID,
      environmentNonce: env.ENVIRONMENT_NONCE,
      buildInputDigest: env.BUILD_INPUT_DIGEST,
      artifactDigest: env.ARTIFACT_DIGEST,
      migrationDigest: env.MIGRATION_DIGEST,
      schemaDigest: env.SCHEMA_DIGEST,
      pendingMigrations: Number(env.PENDING_MIGRATIONS ?? -1),
      seedDigest: env.SEED_DIGEST,
    });
  }

  // Cloudflare's browser redirect cannot use the mTLS-only API hostname. The random, five-minute,
  // one-use OAuth state is created only by a current admin identity and validated inside the broker.
  if (url.hostname === env.VIEWER_HOST && url.pathname === '/oauth/cloudflare/callback' && request.method === 'GET') {
    return completeCloudflareOAuth(url, env);
  }

  const apiOAuthCallback = url.hostname === env.API_HOST && url.pathname === '/oauth/cloudflare/callback';
  if (url.pathname.startsWith('/api/')
      || apiOAuthCallback
      || (env.ENVIRONMENT !== 'development' && url.hostname === env.API_HOST)) {
    return apiRoute(request, url, env);
  }
  return viewerRoute(request, url, env);
}


async function apiRoute(request: Request, url: URL, env: Env): Promise<Response> {

  // Production debug exchange capabilities and signed destination assertions authenticate
  // themselves. Dispatch exact handlers before the machine API gate; they never mint a viewer,
  // search, or production machine bearer.
  const debug = await debugApiRoute(request, url, env);
  if (debug) return debug;

  if (url.pathname === '/api/v1/preview/diagnostics') return previewDiagnostics(request, env);

  // Read-grant exchange authenticates itself (single-use code + PKCE verifier); it never
  // mints anything beyond the read-only bearer the passkey ceremony approved.
  const grantExchange = await readGrantApiRoute(request, url, env);
  if (grantExchange) return grantExchange;

  const identity = await machineIdentity(request, env);
  const path = url.pathname;
  const method = request.method;

  // /api/v1/files/check is a single path segment after files/ — it does NOT match the 3-capture
  // file route below (which needs machine/store/relpath), so this ordering is unambiguous.
  if (path === '/api/v1/files/check' && method === 'POST') return checkFiles(request, env, identity);

  const fileMatch = path.match(/^\/api\/v1\/files\/([^/]+)\/([^/]+)\/(.+)$/);
  if (fileMatch) {
    const relpath = safeDecode(fileMatch[3]!);
    if (relpath === null) return Response.json({ error: 'bad_path' }, { status: 400 });
    const machineId = fileMatch[1]!;
    const store = fileMatch[2]!;
    const params = url.searchParams;
    // Multipart upload for files over the collector's threshold (Cloudflare caps a single request
    // body at 100MB — see multipart.ts). Same path, disambiguated by method + query:
    //   POST ?uploads              -> open      PUT ?uploadId&partNumber -> part
    //   POST ?uploadId             -> complete  DELETE ?uploadId         -> abort
    if (method === 'POST' && params.has('uploads')) return createMultipart(request, env, identity, machineId, store, relpath);
    if (method === 'PUT' && params.has('uploadId')) return uploadPart(request, env, identity, machineId, store, relpath, params);
    if (method === 'POST' && params.has('uploadId')) return completeMultipart(request, env, identity, machineId, store, relpath, params);
    if (method === 'DELETE' && params.has('uploadId')) return abortMultipart(env, identity, machineId, store, relpath, params);
    if (method === 'PUT') return putFile(request, env, identity, machineId, store, relpath);
  }
  if (path === '/api/v1/heartbeat' && method === 'POST') return heartbeat(request, env, identity);
  // Cert renewal authenticates on the still-valid old cert (current OR prev-in-window), so it
  // gates itself — kept out of the read-API block below like heartbeat/upload.
  if (path === '/api/v1/certs/renew' && method === 'POST') return renewCert(request, env, identity);

  // Read APIs: any enrolled machine (or dev identity) may query. A passkey-minted read
  // grant reaches ONLY the explicit allow-list below — never the machine/admin routes —
  // so anything added after this gate stays machine-only by construction.
  if (identity.kind !== 'machine') {
    const grant = await grantIdentity(request, env);
    const granted = grant ? await grantReadRoute(request, url, env, grant) : null;
    return granted ?? Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (path === '/api/v1/bootstrap' && method === 'GET') return bootstrap(env, identity);

  if (path === '/api/v1/search' && method === 'GET') return search(url, env);
  if (path === '/api/v1/sessions' && method === 'GET') return listSessions(url, env);
  const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)(\/raw)?$/);
  if (sessionMatch && method === 'GET') {
    // Decode the id segment: new prompt-log ids contain ':' (promptlog:machine:store), which a
    // correct client sends as promptlog%3A… — an un-decoded lookup would 404. Guard a malformed %
    // sequence to a 400 rather than letting decodeURIComponent throw a 500. (The viewer route already decodes.)
    const sessionId = safeDecode(sessionMatch[1]!);
    if (sessionId === null) return Response.json({ error: 'bad_session_id' }, { status: 400 });
    return sessionMatch[2] ? getSessionRaw(sessionId, request, env) : getSession(sessionId, env);
  }
  if (path === '/api/v1/machines' && method === 'GET') return listMachines(env);
  if (path === '/api/v1/status' && method === 'GET') return status(env, identity);
  if (path === '/api/v1/usage' && method === 'GET') return usage(url, env);
  // Admin routes require the CURRENT cert slot, not an in-grace previous one: a rotated-out admin cert
  // must not run fleet-wide writes/reindex during its 7-day grace window (identity.ts certSlot).
  if (path === '/api/v1/admin/reindex' && method === 'POST') {
    if (identity.certSlot !== 'current') return Response.json({ error: 'admin_requires_current_cert' }, { status: 403 });
    return reindex(request, env, identity);
  }
  if (path === '/api/v1/admin/price-usage' && method === 'POST') {
    if (identity.certSlot !== 'current') return Response.json({ error: 'admin_requires_current_cert' }, { status: 403 });
    return priceUsageSlice(request, env, identity);
  }
  if (path === '/api/v1/admin/machines' && method === 'POST') {
    if (identity.certSlot !== 'current') return Response.json({ error: 'admin_requires_current_cert' }, { status: 403 });
    return adminMachines(request, env, identity);
  }
  if (path.startsWith('/api/v1/admin/cloudflare-oauth')) {
    if (!identity.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 });
    if (identity.certSlot !== 'current') return Response.json({ error: 'admin_requires_current_cert' }, { status: 403 });
    if (path === '/api/v1/admin/cloudflare-oauth/start' && method === 'POST') return startCloudflareOAuth(env);
    if (path === '/api/v1/admin/cloudflare-oauth/status' && method === 'GET') return cloudflareOAuthStatus(env);
    if (path === '/api/v1/admin/cloudflare-oauth/probe' && method === 'GET') return probeClientCert(env, url.searchParams.get('cert_id') ?? '');
    if (path === '/api/v1/admin/cloudflare-oauth/disconnect' && method === 'POST') return disconnectCloudflareOAuth(env);
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
}

/**
 * The complete surface a passkey-minted read grant may reach: read-only session/usage/fleet
 * queries plus an identity echo. Uploads, heartbeat, bootstrap, cert renewal, and every
 * admin route are deliberately absent — those require machine identity.
 */
async function grantReadRoute(request: Request, url: URL, env: Env, grant: GrantIdentity): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const path = url.pathname;
  if (path === '/api/v1/search') return search(url, env);
  if (path === '/api/v1/sessions') return listSessions(url, env);
  const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)(\/raw)?$/);
  if (sessionMatch) {
    const sessionId = safeDecode(sessionMatch[1]!);
    if (sessionId === null) return Response.json({ error: 'bad_session_id' }, { status: 400 });
    return sessionMatch[2] ? getSessionRaw(sessionId, request, env) : getSession(sessionId, env);
  }
  if (path === '/api/v1/machines') return listMachines(env);
  if (path === '/api/v1/usage') return usage(url, env);
  if (path === '/api/v1/status') {
    return Response.json({
      ok: true,
      identity: { kind: 'grant', label: grant.label, expires_at: grant.expiresAt },
    });
  }
  return null;
}

/** Authenticated deployment evidence for trusted preview smoke only. Public health stays terse. */
export async function previewDiagnostics(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT !== 'preview' || request.method !== 'GET') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const identity = await machineIdentity(request, env);
  if (identity.kind !== 'machine' || !identity.actor) {
    return Response.json({ error: 'unauthorized' }, {
      status: 401,
      headers: { 'cache-control': 'no-store' },
    });
  }
  const required = [
    env.PREVIEW_HEAD_SHA,
    env.PREVIEW_ARTIFACT_DIGEST,
    env.PREVIEW_GENERATION,
    env.SCHEMA_DIGEST,
  ];
  if (required.some((value) => !value)) {
    return Response.json({ error: 'diagnostics_unconfigured' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json({
    headSha: env.PREVIEW_HEAD_SHA,
    artifactDigest: env.PREVIEW_ARTIFACT_DIGEST,
    generation: env.PREVIEW_GENERATION,
    schemaDigest: env.SCHEMA_DIGEST,
  }, { headers: { 'cache-control': 'no-store' } });
}
