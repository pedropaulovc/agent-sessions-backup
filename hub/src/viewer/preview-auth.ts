import { previewBearerOk } from '../auth/identity';

const PREVIEW_BOOTSTRAP_PATH = '/_preview/bootstrap';
const PREVIEW_BOOTSTRAP_KEY_PREFIX = 'preview_auth:';
const PREVIEW_COOKIE = '__Host-preview-auth';
const PREVIEW_COOKIE_MAX_AGE = 3600;

export async function previewBootstrapRoute(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname !== PREVIEW_BOOTSTRAP_PATH) return null;
  if (env.ENVIRONMENT !== 'preview') return rejectedBootstrap();
  if (request.method !== 'GET') return rejectedBootstrap();
  if (!env.DEV_AUTH) return rejectedBootstrap();

  const nonce = url.searchParams.get('token');
  if (!nonce) return rejectedBootstrap();

  const next = relativeNext(url);
  if (!next) return rejectedBootstrap();

  const key = `${PREVIEW_BOOTSTRAP_KEY_PREFIX}${await sha256Hex(nonce)}`;
  const consumed = await env.DB.prepare('DELETE FROM meta WHERE key = ?1 RETURNING value')
    .bind(key)
    .first<{ value: string }>();
  if (!consumed) return rejectedBootstrap();

  const expiresAt = Number(consumed.value);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return rejectedBootstrap();

  return withPreviewCookie(new Response(null, { status: 302, headers: { location: next } }), env);
}

export function previewAccess(request: Request, env: Env): 'pass' | 'issue-cookie' | 'deny' {
  if (previewBearerOk(request, env)) return 'issue-cookie';
  if (previewCookieOk(request, env)) return 'pass';
  return 'deny';
}

/** Re-emit `response` with the preview auth cookie set. */
export function withPreviewCookie(response: Response, env: Env): Response {
  const cookie =
    `${PREVIEW_COOKIE}=${env.DEV_AUTH}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${PREVIEW_COOKIE_MAX_AGE}`;
  const out = new Response(response.body, response);
  out.headers.append('set-cookie', cookie);
  return out;
}

function previewCookieOk(request: Request, env: Env): boolean {
  return !!env.DEV_AUTH && readCookie(request, PREVIEW_COOKIE) === env.DEV_AUTH;
}

function relativeNext(url: URL): string | null {
  const raw = url.searchParams.get('next') ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;

  const resolved = new URL(raw, url.origin);
  if (resolved.origin !== url.origin) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rejectedBootstrap(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
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
