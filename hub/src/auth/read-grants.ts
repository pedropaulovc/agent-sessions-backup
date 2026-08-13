/**
 * Passkey-minted read grants — the egress half of "machine certs ingest, passkeys egress":
 * no agent reads production session bytes without the owner approving the grant with a
 * fresh passkey touch.
 *
 * Flow (PKCE loopback, same trust model as the debug exchange):
 *   1. An agent generates a PKCE verifier, starts a loopback listener, and opens
 *      https://<viewer>/grant?challenge=<S256>&callback=http://127.0.0.1:<port>/cb&label=…&ttl=…
 *   2. The grant page shows exactly what is being granted; the owner approves with a fresh
 *      user-verifying passkey assertion whose binding hash covers every displayed parameter,
 *      so nothing shown can be swapped after approval.
 *   3. The page redirects to the loopback callback with a single-use authorization code.
 *   4. The agent exchanges code + verifier at POST /api/v1/grants/exchange — deliberately
 *      unauthenticated: the code+PKCE pair is the credential — for a bearer `agsr_…` valid
 *      for the approved TTL.
 *
 * The bearer authorizes READ routes only; the router dispatches an explicit allow-list and
 * everything else stays machine-cert-only by construction. Codes and tokens are stored as
 * domain-separated hashes; active grants are listed and revocable on /settings.
 */

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { freshAuthenticationOptions, verifyFreshAuthentication, type WebAuthnDeps } from './webauthn';
import { originOk, readSession } from './session';
import { canonicalDebugJson } from '../api/debug-exchange';
import { esc } from '../viewer/layout';

const PKCE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer (agsr_[A-Za-z0-9_-]{43})$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,63}$/;
const PURPOSE = 'read-grant';
const CODE_TTL_MS = 5 * 60_000;
const TTL_MIN_SECONDS = 300;
const TTL_MAX_SECONDS = 86_400;
export const TTL_DEFAULT_SECONDS = 14_400;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const TEXT = new TextEncoder();

export interface GrantIdentity { kind: 'grant'; grantId: string; label: string; expiresAt: number }

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

function pageHeaders(): Headers {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('x-frame-options', 'DENY');
  return headers;
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(data: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', TEXT.encode(data)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function codeHash(code: string): Promise<string> { return sha256Hex(`read-grant-code\0${code}`); }
async function grantTokenHash(token: string): Promise<string> { return sha256Hex(`read-grant-token\0${token}`); }

async function bodyJson<T>(request: Request): Promise<T | null> {
  try { return await request.json() as T; } catch { return null; }
}

/** Loopback-only callback, same rule as the debug exchange: literal 127.0.0.1 with a port. */
function exactLoopback(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !!url.port ? url : null;
  } catch {
    return null;
  }
}

function passkeyRequest(request: Request, response: AuthenticationResponseJSON): Request {
  return new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(response) });
}

interface GrantParams { challenge: string; callback: URL; label: string; ttl: number }

function validGrantParams(value: Record<string, unknown>): GrantParams | null {
  if (typeof value.challenge !== 'string' || !PKCE_RE.test(value.challenge)) return null;
  const callback = exactLoopback(value.callback);
  if (!callback) return null;
  if (typeof value.label !== 'string' || !LABEL_RE.test(value.label)) return null;
  const ttl = value.ttl === undefined ? TTL_DEFAULT_SECONDS : value.ttl;
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < TTL_MIN_SECONDS || ttl > TTL_MAX_SECONDS) return null;
  return { challenge: value.challenge, callback, label: value.label, ttl };
}

/** The exact server-side state the fresh passkey assertion approves — everything the page shows. */
async function bindingHash(params: GrantParams): Promise<string> {
  return sha256Hex(canonicalDebugJson({
    challenge: params.challenge,
    callback: params.callback.toString(),
    label: params.label,
    ttl: params.ttl,
  }));
}

async function grantUser(request: Request, env: Env): Promise<string | null> {
  if (env.ENVIRONMENT === 'development') return 'owner';
  return (await readSession(request, env))?.user ?? null;
}

/** Viewer-host surface: the grant approval page, its passkey ceremony, and grant revocation. */
export async function readGrantBrowserRoute(request: Request, url: URL, env: Env, deps?: WebAuthnDeps): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/grant' && request.method === 'GET') return grantPage(url);

  if (path === '/grant/options' && request.method === 'POST') {
    if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
    const body = await bodyJson<Record<string, unknown>>(request);
    const params = body ? validGrantParams(body) : null;
    if (!params) return json({ error: 'bad_request' }, 400);
    return freshAuthenticationOptions(request, url, env, PURPOSE, await bindingHash(params));
  }

  if (path === '/grant/verify' && request.method === 'POST') {
    if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
    const body = await bodyJson<Record<string, unknown> & { response?: AuthenticationResponseJSON }>(request);
    const params = body ? validGrantParams(body) : null;
    if (!params || !body?.response) return json({ error: 'bad_request' }, 400);
    const verified = await verifyFreshAuthentication(
      passkeyRequest(request, body.response), url, env, PURPOSE, await bindingHash(params), deps,
    );
    if (!verified.verified) return json({ error: verified.error }, verified.status);
    const code = randomToken();
    const now = Date.now();
    await env.DB.prepare('DELETE FROM read_grant_codes WHERE expires_at <= ?1').bind(now).run();
    await env.DB.prepare(
      'INSERT INTO read_grant_codes (code_hash, pkce_challenge, label, ttl_seconds, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(await codeHash(code), params.challenge, params.label, params.ttl, now, now + CODE_TTL_MS).run();
    return json({ code });
  }

  const revoke = path.match(/^\/grants\/([^/]+)\/revoke$/);
  if (revoke && request.method === 'POST') {
    if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
    if (!(await grantUser(request, env))) return json({ error: 'unauthorized' }, 401);
    let grantId: string;
    try { grantId = decodeURIComponent(revoke[1]!); } catch { return json({ error: 'bad_request' }, 400); }
    const revoked = await env.DB.prepare(
      'UPDATE read_grants SET revoked_at = ?2 WHERE grant_id = ?1 AND revoked_at IS NULL RETURNING grant_id',
    ).bind(grantId, Date.now()).first<{ grant_id: string }>();
    if (!revoked) return json({ error: 'not_found' }, 404);
    return json({ revoked: true });
  }

  return null;
}

/**
 * API-host surface: exchange a single-use authorization code + PKCE verifier for the bearer.
 * Deliberately unauthenticated — the code (delivered only to the approved loopback callback)
 * plus the verifier (never left the requesting process) is the credential.
 */
export async function readGrantApiRoute(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (env.ENVIRONMENT === 'preview') return null;
  if (url.pathname !== '/api/v1/grants/exchange' || request.method !== 'POST') return null;
  const body = await bodyJson<{ code?: unknown; codeVerifier?: unknown }>(request);
  if (!body || typeof body.code !== 'string' || !CODE_RE.test(body.code)
      || typeof body.codeVerifier !== 'string' || !VERIFIER_RE.test(body.codeVerifier)) {
    return json({ error: 'bad_request' }, 400);
  }
  const challenge = base64url(await crypto.subtle.digest('SHA-256', TEXT.encode(body.codeVerifier)));
  const now = Date.now();
  const row = await env.DB.prepare(
    'DELETE FROM read_grant_codes WHERE code_hash = ?1 AND pkce_challenge = ?2 AND expires_at > ?3 RETURNING label, ttl_seconds',
  ).bind(await codeHash(body.code), challenge, now).first<{ label: string; ttl_seconds: number }>();
  if (!row) return json({ error: 'bad_code' }, 400);

  const token = `agsr_${randomToken()}`;
  const grantId = randomToken(16);
  const expiresAt = now + row.ttl_seconds * 1000;
  await env.DB.prepare('DELETE FROM read_grants WHERE expires_at <= ?1').bind(now).run();
  await env.DB.prepare(
    'INSERT INTO read_grants (grant_id, token_hash, label, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  ).bind(grantId, await grantTokenHash(token), row.label, now, expiresAt).run();
  return json({ token, tokenType: 'bearer', label: row.label, expiresAt });
}

/** Resolve a read-grant bearer, or null. Preview never accepts production bearers. */
export async function grantIdentity(request: Request, env: Env): Promise<GrantIdentity | null> {
  if (env.ENVIRONMENT === 'preview') return null;
  const match = request.headers.get('authorization')?.match(BEARER_RE);
  if (!match) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT grant_id, label, expires_at FROM read_grants WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2',
  ).bind(await grantTokenHash(match[1]!), now).first<{ grant_id: string; label: string; expires_at: number }>();
  if (!row) return null;
  // Throttled liveness stamp: at most one write per grant per interval, so reads stay cheap.
  await env.DB.prepare(
    'UPDATE read_grants SET last_used_at = ?2 WHERE grant_id = ?1 AND (last_used_at IS NULL OR last_used_at < ?3)',
  ).bind(row.grant_id, now, now - LAST_USED_WRITE_INTERVAL_MS).run();
  return { kind: 'grant', grantId: row.grant_id, label: row.label, expiresAt: row.expires_at };
}

function grantPage(url: URL): Response {
  const params = validGrantParams({
    challenge: url.searchParams.get('challenge') ?? undefined,
    callback: url.searchParams.get('callback') ?? undefined,
    label: url.searchParams.get('label') ?? undefined,
    ttl: url.searchParams.has('ttl') ? Number(url.searchParams.get('ttl')) : undefined,
  });
  const style = 'body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}dt{color:#666;font-size:13px;margin-top:.6rem}dd{margin:0;font-weight:600}button{padding:.7rem 1rem;margin-right:.5rem}.error{color:#a00}.warn{background:#fff7e0;border:1px solid #e0c060;border-radius:6px;padding:.7rem;font-size:14px}';
  if (!params) {
    const html = `<!doctype html><meta charset="utf-8"><title>Grant read access</title><style>${style}</style><h1>Grant read access</h1><p class="error">Invalid grant request. Re-run the requesting tool to get a fresh link.</p>`;
    return new Response(html, { status: 400, headers: pageHeaders() });
  }
  const hours = params.ttl >= 3600 ? `${Math.round(params.ttl / 360) / 10} h` : `${Math.round(params.ttl / 60)} min`;
  const safeParams = JSON.stringify({
    challenge: params.challenge, callback: params.callback.toString(), label: params.label, ttl: params.ttl,
  }).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><title>Grant read access</title><style>${style}</style>
<h1>Grant read access</h1>
<p>Approve a short-lived <strong>read-only</strong> token for the sessions hub. It can read session transcripts, search, and usage — it cannot upload, delete, or administer anything.</p>
<dl>
<dt>Requested by</dt><dd>${esc(params.label)}</dd>
<dt>Valid for</dt><dd>${esc(hours)}</dd>
<dt>Delivered to</dt><dd>${esc(params.callback.toString())} (this machine)</dd>
</dl>
<p class="warn">Only approve if you just ran the auth command yourself. Approving hands the requesting process read access to every session in the hub for the shown duration.</p>
<button id="approve">Approve with passkey</button><button id="deny">Deny</button><p id="result"></p>
<script>
const params=${safeParams};
const b64uToBuf=s=>{let p=s.replace(/-/g,'+').replace(/_/g,'/');p+='='.repeat((4-p.length%4)%4);const b=atob(p),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer};
const bufToB64u=b=>{const u=new Uint8Array(b);let s='';for(const x of u)s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const serialize=c=>{const r=c.response;return{id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),authenticatorData:bufToB64u(r.authenticatorData),signature:bufToB64u(r.signature),userHandle:r.userHandle?bufToB64u(r.userHandle):undefined}}};
const finish=q=>{const target=new URL(params.callback);for(const[k,v]of Object.entries(q))target.searchParams.set(k,v);location.href=target.toString()};
deny.onclick=()=>finish({error:'denied'});
approve.onclick=async()=>{approve.disabled=true;try{
const o=await fetch('/grant/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});
const options=await o.json();if(!o.ok)throw new Error(options.error||'options failed');
options.challenge=b64uToBuf(options.challenge);options.allowCredentials=(options.allowCredentials||[]).map(x=>({...x,id:b64uToBuf(x.id)}));
const credential=await navigator.credentials.get({publicKey:options});
const v=await fetch('/grant/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...params,response:serialize(credential)})});
const verified=await v.json();if(!v.ok)throw new Error(verified.error||'verification failed');
finish({code:verified.code});
}catch(e){result.textContent=String(e);result.className='error';approve.disabled=false}};
</script>`;
  return new Response(html, { headers: pageHeaders() });
}
