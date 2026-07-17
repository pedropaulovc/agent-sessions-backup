export async function route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/healthz') {
    return Response.json({ ok: true, environment: env.ENVIRONMENT });
  }

  const host = url.hostname;
  if (host === env.API_HOST || url.pathname.startsWith('/api/')) {
    return apiRoute(request, url, env);
  }
  return viewerRoute(request, url, env);
}

async function apiRoute(_request: Request, url: URL, _env: Env): Promise<Response> {
  // M1 fills in: files PUT/check, heartbeat, search, sessions, usage, status, machines, admin.
  return Response.json({ error: 'not_implemented', path: url.pathname }, { status: 501 });
}

async function viewerRoute(_request: Request, url: URL, _env: Env): Promise<Response> {
  // M2 fills in: search UI, session renderer, machines page, login.
  return new Response(`sessions-hub scaffold — ${url.pathname}`, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
