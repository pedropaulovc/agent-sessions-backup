import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  freshAuthenticationOptions,
  verifyFreshAuthentication,
  webauthnRoute,
  type WebAuthnDeps,
} from './auth/webauthn';

const PURPOSE = 'preview-redirect';
const PREVIEW_HOST_SUFFIX = '.sessions-ppe.workers.dev';
const PR_PATTERN = /^[1-9][0-9]*$/;
const MIN_SEED_LENGTH = 32;
const TEXT = new TextEncoder();

interface JsonRecord {
  [key: string]: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

function pageHeaders(): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function parsePr(value: unknown): number | null {
  if (typeof value !== 'string' || !PR_PATTERN.test(value)) return null;
  const pr = Number(value);
  return Number.isSafeInteger(pr) && pr > 0 ? pr : null;
}

function queryPr(url: URL): number | null {
  const values = url.searchParams.getAll('id');
  return values.length === 1 ? parsePr(values[0]) : null;
}

function bodyPr(body: JsonRecord): number | null {
  return parsePr(body.pr);
}

function configuredHost(env: Env): string {
  return env.PPE_VIEWER_HOST ?? env.VIEWER_HOST;
}

function hostOk(url: URL, env: Env): boolean {
  return url.hostname === configuredHost(env);
}

function authEnv(env: Env): Env {
  const host = configuredHost(env);
  if (env.VIEWER_HOST === host && env.ENVIRONMENT === 'ppe') return env;
  return { ...env, ENVIRONMENT: 'ppe', VIEWER_HOST: host };
}

function bindingHash(pr: number): Promise<string> {
  return crypto.subtle.digest('SHA-256', TEXT.encode(`${PURPOSE}\0${pr}`)).then((digest) => {
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
  });
}

function seed(env: Env): string | null {
  const value = env.PREVIEW_BEARER_SEED?.trim();
  return value && value.length >= MIN_SEED_LENGTH ? value : null;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Must stay in lockstep with previewBearerToken in infra/cf/preview-trust.mjs. */
export async function previewBearer(seedValue: string, pr: number): Promise<string> {
  if (seedValue.trim().length < MIN_SEED_LENGTH) throw new Error('preview bearer seed must be at least 32 characters');
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR number must be a safe positive integer');
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT.encode(seedValue.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, TEXT.encode(`sessions-preview-bearer:pr-${pr}`));
  return base64url(new Uint8Array(signature));
}

export async function previewLocation(seedValue: string, pr: number): Promise<string> {
  const token = await previewBearer(seedValue, pr);
  return `https://pr-${pr}${PREVIEW_HOST_SUFFIX}/?token=${token}`;
}
function passkeyRequest(request: Request, response: AuthenticationResponseJSON): Request {
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(response),
  });
}

async function bodyJson(request: Request): Promise<JsonRecord | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as JsonRecord : null;
  } catch {
    return null;
  }
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('id' in value) || typeof value.id !== 'string') return false;
  if (!('response' in value) || !value.response || typeof value.response !== 'object' || Array.isArray(value.response)) {
    return false;
  }
  return true;
}

const CLIENT_HELPERS = `
function b64uToBuf(s){var p=s.replace(/-/g,'+').replace(/_/g,'/');p+='='.repeat((4-p.length%4)%4);var bin=atob(p);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;}
function bufToB64u(b){var u=new Uint8Array(b),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function say(t,err){var m=document.getElementById('msg');m.textContent=t;m.className='msg'+(err?' err':'');}
function serializeAuth(c){var r=c.response;return {id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),authenticatorData:bufToB64u(r.authenticatorData),signature:bufToB64u(r.signature),userHandle:r.userHandle?bufToB64u(r.userHandle):undefined}};}
`;

const REGISTRATION_SERIALIZER = `
function serializeReg(c){var r=c.response;return {id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),attestationObject:bufToB64u(r.attestationObject),transports:r.getTransports?r.getTransports():[]}};}
`;

function authPage(pr: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Open preview</title><style>:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6b6b70;--line:#e2e2df;--card:#fff;--accent:#3454d1;--err:#b42318}@media(prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e6e6e8;--muted:#9a9aa2;--line:#2c2e33;--card:#1d1f23;--accent:#7f9cff;--err:#ff8b7a}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px;width:min(92vw,420px)}h1{font-size:18px;margin:0 0 4px;letter-spacing:-.02em}p{color:var(--muted);margin:0 0 18px}button{width:100%;padding:11px 14px;border:1px solid var(--accent);border-radius:7px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}.msg{margin-top:14px;min-height:18px;font-size:12px}.msg.err{color:var(--err)}.links{margin-top:16px;font-size:12px}a{color:var(--accent)}</style></head><body><div class="card"><h1>Open preview PR ${pr}</h1><p>Authenticate with your passkey to open this pull request's isolated environment.</p><button id="go">Continue with passkey</button><div id="msg" class="msg"></div><div class="links"><a href="/register?setup=">Register a first passkey</a></div></div><script>${CLIENT_HELPERS}var PR=${scriptJson(pr)};document.getElementById('go').addEventListener('click',async function(){var btn=this;btn.disabled=true;say('Requesting…');try{var o=await fetch('/pr/auth/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pr:String(PR)})});if(!o.ok){var problem=await o.json().catch(function(){return {};});throw new Error(problem.error||'Authentication unavailable.');}var opt=await o.json();opt.challenge=b64uToBuf(opt.challenge);if(opt.allowCredentials)opt.allowCredentials=opt.allowCredentials.map(function(c){c.id=b64uToBuf(c.id);return c;});var cred=await navigator.credentials.get({publicKey:opt});var v=await fetch('/pr/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pr:String(PR),response:serializeAuth(cred)})});var result=await v.json().catch(function(){return {};});if(!v.ok||typeof result.location!=='string')throw new Error(result.error||'Authentication failed.');say('Authenticated. Redirecting…');location.replace(result.location);}catch(e){say(String(e&&e.message||e),true);btn.disabled=false;}});${REGISTRATION_SERIALIZER}</script></body></html>`;
  return new Response(html, { headers: pageHeaders() });
}

function registrationPage(setup: string | null): Response {
  const setupValue = setup ?? '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register passkey</title><style>:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6b6b70;--line:#e2e2df;--card:#fff;--accent:#3454d1;--err:#b42318}@media(prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e6e6e8;--muted:#9a9aa2;--line:#2c2e33;--card:#1d1f23;--accent:#7f9cff;--err:#ff8b7a}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px;width:min(92vw,420px)}h1{font-size:18px;margin:0 0 4px;letter-spacing:-.02em}p{color:var(--muted);margin:0 0 18px}button{width:100%;padding:11px 14px;border:1px solid var(--accent);border-radius:7px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}.msg{margin-top:14px;min-height:18px;font-size:12px}.msg.err{color:var(--err)}.links{margin-top:16px;font-size:12px}a{color:var(--accent)}</style></head><body><div class="card"><h1>Register a PPE passkey</h1><p>This one-time setup link enrolls the device used to open PR previews.</p><button id="go">Create passkey</button><div id="msg" class="msg"></div><div class="links"><a href="/pr?id=1">Open a preview</a></div></div><script>${CLIENT_HELPERS}${REGISTRATION_SERIALIZER}var SETUP=${scriptJson(setupValue)};document.getElementById('go').addEventListener('click',async function(){var btn=this;btn.disabled=true;say('Requesting…');try{var o=await fetch('/webauthn/register/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setup:SETUP})});if(!o.ok){var problem=await o.json().catch(function(){return {};});throw new Error(problem.error||'Registration is not allowed.');}var opt=await o.json();opt.challenge=b64uToBuf(opt.challenge);opt.user.id=b64uToBuf(opt.user.id);if(opt.excludeCredentials)opt.excludeCredentials=opt.excludeCredentials.map(function(c){c.id=b64uToBuf(c.id);return c;});var cred=await navigator.credentials.create({publicKey:opt});var v=await fetch('/webauthn/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(serializeReg(cred))});var result=await v.json().catch(function(){return {};});if(!v.ok||!result.verified)throw new Error(result.error||'Registration failed.');say('Passkey registered. You can now open a preview.');btn.disabled=true;}catch(e){say(String(e&&e.message||e),true);btn.disabled=false;}});</script></body></html>`;
  return new Response(html, { headers: pageHeaders() });
}

async function handle(request: Request, url: URL, env: Env, deps?: WebAuthnDeps): Promise<Response> {
  if (!hostOk(url, env)) return new Response('not found', { status: 404 });
  const authenticationEnv = authEnv(env);

  if (url.pathname === '/webauthn/register/options' || url.pathname === '/webauthn/register/verify') {
    return (await webauthnRoute(request, url, authenticationEnv, deps)) ?? new Response('not found', { status: 404 });
  }

  if (url.pathname === '/pr' && request.method === 'GET') {
    const pr = queryPr(url);
    return pr === null ? json({ error: 'bad_pr' }, 400) : authPage(pr);
  }

  if (url.pathname === '/register' && request.method === 'GET') {
    return registrationPage(url.searchParams.get('setup'));
  }

  if (url.pathname === '/pr/auth/options' && request.method === 'POST') {
    const body = await bodyJson(request);
    const pr = body ? bodyPr(body) : null;
    if (pr === null) return json({ error: 'bad_pr' }, 400);
    if (!seed(env)) return json({ error: 'preview_unconfigured' }, 503);
    return freshAuthenticationOptions(request, url, authenticationEnv, PURPOSE, await bindingHash(pr));
  }

  if (url.pathname === '/pr/auth/verify' && request.method === 'POST') {
    const body = await bodyJson(request);
    const pr = body ? bodyPr(body) : null;
    if (pr === null || !body || !isAuthenticationResponse(body.response)) return json({ error: 'bad_request' }, 400);
    const seedValue = seed(env);
    if (!seedValue) return json({ error: 'preview_unconfigured' }, 503);
    const verified = await verifyFreshAuthentication(
      passkeyRequest(request, body.response),
      url,
      authenticationEnv,
      PURPOSE,
      await bindingHash(pr),
      deps,
    );
    if (!verified.verified) return json({ error: verified.error }, verified.status);
    return json({ location: await previewLocation(seedValue, pr) });
  }

  return new Response('not found', { status: 404 });
}

export async function ppeRoute(request: Request, env: Env, deps?: WebAuthnDeps): Promise<Response> {
  return handle(request, new URL(request.url), env, deps);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return ppeRoute(request, env);
  },
} satisfies ExportedHandler<Env>;
