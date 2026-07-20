/**
 * Stable front door for automatic Workers Builds branch previews.
 *
 * A request for `<branch>-preview.sessions.vza.net` is sent only to Cloudflare's
 * corresponding automatic alias:
 * `<branch>-sessions-hub-preview.pedro-18e.workers.dev`. The target suffix and
 * Worker name are constants, so this can never become a caller-controlled proxy.
 */

const PUBLIC_SUFFIX = '-preview.sessions.vza.net';
const UPSTREAM_SUFFIX = '-sessions-hub-preview.pedro-18e.workers.dev';
const MAX_BRANCH_LENGTH = 63 - '-sessions-hub-preview'.length;

type FetchUpstream = (request: Request) => Promise<Response>;

function branchFromHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(PUBLIC_SUFFIX)) return null;

  const branch = host.slice(0, -PUBLIC_SUFFIX.length);
  if (!branch || branch.includes('.') || branch.length > MAX_BRANCH_LENGTH) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(branch)) return null;
  return branch;
}

function rewriteLocation(headers: Headers, upstreamUrl: URL, publicUrl: URL): void {
  const location = headers.get('location');
  if (!location) return;

  let resolved: URL;
  try {
    resolved = new URL(location, upstreamUrl);
  } catch {
    return;
  }
  if (resolved.origin !== upstreamUrl.origin) return;

  // Relative redirects already resolve against the public request host and need no
  // rewriting. Only prevent an absolute/protocol-relative upstream alias from leaking
  // into browser navigation.
  if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return;
  resolved.protocol = publicUrl.protocol;
  resolved.host = publicUrl.host;
  headers.set('location', resolved.toString());
}

function rewriteOrigin(headers: Headers, upstreamUrl: URL, publicUrl: URL): void {
  const origin = headers.get('origin');
  if (origin === publicUrl.origin) headers.set('origin', upstreamUrl.origin);
}

export async function proxyPreview(request: Request, fetchUpstream: FetchUpstream = fetch): Promise<Response> {
  const publicUrl = new URL(request.url);
  const branch = branchFromHost(publicUrl.hostname);
  if (!branch) return new Response('not found', { status: 404 });

  const upstreamUrl = new URL(publicUrl);
  upstreamUrl.protocol = 'https:';
  upstreamUrl.host = `${branch}${UPSTREAM_SUFFIX}`;

  // Constructing from the incoming Request preserves method, headers, and streaming
  // body while changing only the fixed upstream URL.
  const requestHeaders = new Headers(request.headers);
  // The preview application performs exact same-origin CSRF checks. Translate only the
  // public front door's own Origin; an unrelated Origin remains unrelated and rejected.
  rewriteOrigin(requestHeaders, upstreamUrl, publicUrl);
  const upstreamRequest = new Request(new Request(upstreamUrl, request), {
    headers: requestHeaders,
    redirect: 'manual',
  });
  const upstream = await fetchUpstream(upstreamRequest);
  const responseHeaders = new Headers(upstream.headers);
  rewriteLocation(responseHeaders, upstreamUrl, publicUrl);

  // Do not buffer the body. Set-Cookie is intentionally passed through unchanged:
  // cookies without Domain (including both __Host-* preview cookies) become host-only
  // cookies for this branch front door, rather than for the workers.dev alias.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default {
  fetch(request: Request): Promise<Response> {
    return proxyPreview(request);
  },
};
