import { machineIdentity } from './auth/identity';
import { checkFiles, putFile } from './api/upload';
import { heartbeat, listMachines, reindex, status, usage } from './api/ops';
import { search } from './api/search';
import { getSession, getSessionRaw, listSessions } from './api/sessions';
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

  if (url.pathname === '/healthz') {
    return Response.json({ ok: true, environment: env.ENVIRONMENT });
  }

  if (url.hostname === env.API_HOST || url.pathname.startsWith('/api/')) {
    return apiRoute(request, url, env);
  }
  return viewerRoute(request, url, env);
}


async function apiRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const identity = await machineIdentity(request, env);
  const path = url.pathname;
  const method = request.method;

  const fileMatch = path.match(/^\/api\/v1\/files\/([^/]+)\/([^/]+)\/(.+)$/);
  if (fileMatch && method === 'PUT') {
    const relpath = safeDecode(fileMatch[3]!);
    if (relpath === null) return Response.json({ error: 'bad_path' }, { status: 400 });
    return putFile(request, env, identity, fileMatch[1]!, fileMatch[2]!, relpath);
  }
  if (path === '/api/v1/files/check' && method === 'POST') return checkFiles(request, env, identity);
  if (path === '/api/v1/heartbeat' && method === 'POST') return heartbeat(request, env, identity);

  // Read APIs: any enrolled machine (or dev identity) may query.
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });

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
  if (path === '/api/v1/status' && method === 'GET') return status(env);
  if (path === '/api/v1/usage' && method === 'GET') return usage(url, env);
  if (path === '/api/v1/admin/reindex' && method === 'POST') return reindex(request, env, identity);

  return Response.json({ error: 'not_found' }, { status: 404 });
}
