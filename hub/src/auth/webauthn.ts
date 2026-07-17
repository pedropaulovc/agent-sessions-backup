/**
 * Passkey (WebAuthn) auth for the viewer host.
 *
 * ## rpID / origin derivation
 * WebAuthn binds a credential to an rpID (a registrable-domain suffix of the page
 * origin) and verifies the assertion's origin server-side. We derive BOTH from the
 * incoming request URL — `rpID = url.hostname`, `expectedOrigin = url.origin` — rather
 * than from env.VIEWER_HOST. Why:
 *   - The viewer is host-routed: the router only reaches here for the viewer host, so
 *     on a real request `url.hostname` IS the viewer host. Deriving from the request
 *     therefore matches production exactly.
 *   - In `wrangler dev` the page is served from localhost:8787, and under the vitest
 *     workers pool it is served from the test host (sessions.vza.net via SELF). A
 *     hardcoded VIEWER_HOST would disagree with the browser's actual origin and every
 *     ceremony would fail the origin check. The browser already refuses to mint or
 *     offer a credential whose rpID isn't a suffix of the page origin, so trusting the
 *     request hostname adds no attack surface: a forged Host on some other domain can
 *     only produce credentials scoped to that other domain, never to the viewer's.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { esc } from '../viewer/layout';
import { createSession, destroySession, originOk, readSession } from './session';

const RP_NAME = 'Agent Sessions';
const CHALLENGE_TTL = 300; // seconds; single-use, deleted on verify
const OWNER = 'owner';

/**
 * Seams for the two SimpleWebAuthn crypto verifications, injectable so tests can drive
 * the endpoints without a real authenticator. Production always uses the real ones.
 */
export interface WebAuthnDeps {
  verifyRegistration: typeof verifyRegistrationResponse;
  verifyAuthentication: typeof verifyAuthenticationResponse;
}

const REAL_DEPS: WebAuthnDeps = {
  verifyRegistration: verifyRegistrationResponse,
  verifyAuthentication: verifyAuthenticationResponse,
};

interface CredentialRow {
  credential_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string | null;
}

function rp(url: URL): { rpID: string; origin: string } {
  return { rpID: url.hostname, origin: url.origin };
}

async function countCredentials(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first<{ n: number }>();
  return row?.n ?? 0;
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

/** The base64url challenge the browser echoes back inside clientDataJSON. */
function challengeOf(response: { response: { clientDataJSON: string } }): string {
  const clientData = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)) as { challenge: string };
  return clientData.challenge;
}

/** Read + delete (single-use) a stored challenge of the expected kind. */
async function consumeChallenge(env: Env, challenge: string, kind: 'register' | 'auth'): Promise<boolean> {
  const key = `chal:${challenge}`;
  const raw = await env.KV.get(key);
  if (!raw) return false;
  await env.KV.delete(key);
  return raw === kind;
}

/** Dispatch the viewer's auth surface. Returns null for paths it does not own. */
export async function webauthnRoute(
  request: Request,
  url: URL,
  env: Env,
  deps: WebAuthnDeps = REAL_DEPS,
): Promise<Response | null> {
  const path = url.pathname;

  if (path === '/login' && request.method === 'GET') return loginPage(request, url, env);
  if (path === '/settings' && request.method === 'GET') return settingsPage(request, env);

  if (path === '/logout' && request.method === 'POST') {
    if (!originOk(request)) return new Response('bad origin', { status: 403 });
    const clear = await destroySession(request, env);
    return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': clear } });
  }

  if (path === '/webauthn/register/options' && request.method === 'POST') return registerOptions(request, url, env);
  if (path === '/webauthn/register/verify' && request.method === 'POST') return registerVerify(request, url, env, deps);
  if (path === '/webauthn/auth/options' && request.method === 'POST') return authOptions(request, url, env);
  if (path === '/webauthn/auth/verify' && request.method === 'POST') return authVerify(request, url, env, deps);

  return null;
}

/**
 * Registration is authorized in exactly two ways, enforced here on the SERVER (the UI
 * is never trusted): the very first passkey needs the SETUP_TOKEN; every subsequent one
 * needs an authenticated session. Once any credential exists the SETUP_TOKEN is dead.
 */
async function authorizeRegistration(request: Request, env: Env, setup: string | null): Promise<boolean> {
  const count = await countCredentials(env);
  if (count > 0) return (await readSession(request, env)) !== null;
  return !!env.SETUP_TOKEN && setup === env.SETUP_TOKEN;
}

async function registerOptions(request: Request, url: URL, env: Env): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const body = (await request.json().catch(() => ({}))) as { setup?: string };
  const setup = body.setup ?? url.searchParams.get('setup');
  if (!(await authorizeRegistration(request, env, setup))) return json({ error: 'forbidden' }, 403);

  const { rpID } = rp(url);
  const existing = await env.DB.prepare('SELECT credential_id, transports FROM credentials').all<{
    credential_id: string;
    transports: string | null;
  }>();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: OWNER,
    userID: Uint8Array.from(new TextEncoder().encode(OWNER)) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    excludeCredentials: existing.results.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await env.KV.put(`chal:${options.challenge}`, 'register', { expirationTtl: CHALLENGE_TTL });
  return json(options);
}

async function registerVerify(request: Request, url: URL, env: Env, deps: WebAuthnDeps): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const response = (await request.json()) as RegistrationResponseJSON;
  const { rpID, origin } = rp(url);

  const challenge = challengeOf(response);
  if (!(await consumeChallenge(env, challenge, 'register'))) return json({ error: 'bad_challenge' }, 400);

  const verification = await deps.verifyRegistration({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) return json({ verified: false }, 400);

  const cred = verification.registrationInfo.credential;
  await env.DB.prepare(
    `INSERT INTO credentials (credential_id, user_id, public_key, counter, transports, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (credential_id) DO UPDATE SET counter = excluded.counter`,
  )
    .bind(cred.id, OWNER, cred.publicKey, cred.counter, cred.transports ? JSON.stringify(cred.transports) : null)
    .run();

  return json({ verified: true });
}

async function authOptions(request: Request, url: URL, env: Env): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const { rpID } = rp(url);
  const creds = await env.DB.prepare('SELECT credential_id, transports FROM credentials').all<{
    credential_id: string;
    transports: string | null;
  }>();

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: creds.results.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
  });

  await env.KV.put(`chal:${options.challenge}`, 'auth', { expirationTtl: CHALLENGE_TTL });
  return json(options);
}

async function authVerify(request: Request, url: URL, env: Env, deps: WebAuthnDeps): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const response = (await request.json()) as AuthenticationResponseJSON;
  const { rpID, origin } = rp(url);

  const challenge = challengeOf(response);
  if (!(await consumeChallenge(env, challenge, 'auth'))) return json({ error: 'bad_challenge' }, 400);

  const row = await env.DB.prepare(
    'SELECT credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?1',
  )
    .bind(response.id)
    .first<CredentialRow>();
  if (!row) return json({ error: 'unknown_credential' }, 400);

  const verification = await deps.verifyAuthentication({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: row.credential_id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: parseTransports(row.transports),
    },
  });
  if (!verification.verified) return json({ verified: false }, 400);

  await env.DB.prepare(
    "UPDATE credentials SET counter = ?1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE credential_id = ?2",
  )
    .bind(verification.authenticationInfo.newCounter, row.credential_id)
    .run();

  const cookie = await createSession(env);
  return json({ verified: true }, 200, { 'set-cookie': cookie });
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AuthenticatorTransportFuture[];
  } catch {
    return undefined;
  }
}

// ---- Pages -----------------------------------------------------------------

const AUTH_STYLE = `
:root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1d1d1f; --muted:#6b6b70; --line:#e2e2df; --card:#fff; --accent:#3454d1; --err:#b42318; }
@media (prefers-color-scheme: dark){ :root{ --bg:#16171a; --fg:#e6e6e8; --muted:#9a9aa2; --line:#2c2e33; --card:#1d1f23; --accent:#7f9cff; --err:#ff8b7a; } }
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:14px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px;width:min(92vw,380px)}
h1{font-size:18px;margin:0 0 4px;letter-spacing:-0.02em}
p{color:var(--muted);margin:0 0 18px}
button{width:100%;padding:11px 14px;border:1px solid var(--accent);border-radius:7px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.msg{margin-top:14px;min-height:18px;font-size:12px}
.msg.err{color:var(--err)}
.links{margin-top:16px;font-size:12px}
a{color:var(--accent)}
`;

function authDoc(title: string, bodyHtml: string, script: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${AUTH_STYLE}</style></head><body>` +
    `<div class="card">${bodyHtml}</div>` +
    `<script>${script}</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Shared browser-side base64url <-> ArrayBuffer helpers (no external @simplewebauthn/browser).
const CLIENT_HELPERS = `
function b64uToBuf(s){var p=s.replace(/-/g,'+').replace(/_/g,'/');p+='='.repeat((4-p.length%4)%4);var bin=atob(p);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;}
function bufToB64u(b){var u=new Uint8Array(b),s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function say(t,err){var m=document.getElementById('msg');m.textContent=t;m.className='msg'+(err?' err':'');}
`;

async function loginPage(request: Request, url: URL, env: Env): Promise<Response> {
  const count = await countCredentials(env);
  const setup = url.searchParams.get('setup');
  const bootstrap = count === 0 && !!env.SETUP_TOKEN && setup === env.SETUP_TOKEN;

  if (bootstrap) {
    const body =
      `<h1>Set up your first passkey</h1>` +
      `<p>No passkeys exist yet. Register this device to secure the viewer.</p>` +
      `<button id="go">Create passkey</button><div id="msg" class="msg"></div>`;
    const script =
      CLIENT_HELPERS +
      `var SETUP=${JSON.stringify(setup)};` +
      `document.getElementById('go').addEventListener('click',async function(){` +
      `var btn=this;btn.disabled=true;say('Requesting…');try{` +
      `var o=await fetch('/webauthn/register/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setup:SETUP})});` +
      `if(!o.ok){say('Registration not allowed.',1);btn.disabled=false;return;}var opt=await o.json();` +
      `opt.challenge=b64uToBuf(opt.challenge);opt.user.id=b64uToBuf(opt.user.id);` +
      `if(opt.excludeCredentials)opt.excludeCredentials=opt.excludeCredentials.map(function(c){c.id=b64uToBuf(c.id);return c;});` +
      `var cred=await navigator.credentials.create({publicKey:opt});` +
      `var v=await fetch('/webauthn/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(serializeReg(cred))});` +
      `var r=await v.json();if(r.verified){say('Passkey created. Redirecting…');location.href='/login';}else{say('Verification failed.',1);btn.disabled=false;}` +
      `}catch(e){say(String(e&&e.message||e),1);btn.disabled=false;}});` +
      SERIALIZE_REG;
    return authDoc('Set up passkey', body, script);
  }

  const body =
    `<h1>Sign in</h1>` +
    `<p>Authenticate with your passkey to view sessions.</p>` +
    `<button id="go">Sign in with passkey</button><div id="msg" class="msg"></div>` +
    (count === 0 ? `<div class="links muted">No passkeys registered. Open the setup link with your token.</div>` : '');
  const script =
    CLIENT_HELPERS +
    `document.getElementById('go').addEventListener('click',async function(){` +
    `var btn=this;btn.disabled=true;say('Requesting…');try{` +
    `var o=await fetch('/webauthn/auth/options',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});` +
    `if(!o.ok){say('Sign-in unavailable.',1);btn.disabled=false;return;}var opt=await o.json();` +
    `opt.challenge=b64uToBuf(opt.challenge);` +
    `if(opt.allowCredentials)opt.allowCredentials=opt.allowCredentials.map(function(c){c.id=b64uToBuf(c.id);return c;});` +
    `var cred=await navigator.credentials.get({publicKey:opt});` +
    `var v=await fetch('/webauthn/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(serializeAuth(cred))});` +
    `var r=await v.json();if(r.verified){say('Signed in. Redirecting…');location.href='/';}else{say('Sign-in failed.',1);btn.disabled=false;}` +
    `}catch(e){say(String(e&&e.message||e),1);btn.disabled=false;}});` +
    SERIALIZE_AUTH;
  return authDoc('Sign in', body, script);
}

async function settingsPage(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return new Response(null, { status: 302, headers: { location: '/login' } });
  const count = await countCredentials(env);

  const body =
    `<h1>Settings</h1>` +
    `<p>${count} passkey${count === 1 ? '' : 's'} registered for the owner.</p>` +
    `<button id="add">Add this device as a passkey</button>` +
    `<div id="msg" class="msg"></div>` +
    `<form method="post" action="/logout" style="margin-top:16px"><button type="submit" style="background:transparent;color:var(--fg)">Sign out</button></form>` +
    `<div class="links"><a href="/">← Back to sessions</a></div>`;
  const script =
    CLIENT_HELPERS +
    `document.getElementById('add').addEventListener('click',async function(){` +
    `var btn=this;btn.disabled=true;say('Requesting…');try{` +
    `var o=await fetch('/webauthn/register/options',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});` +
    `if(!o.ok){say('Not allowed.',1);btn.disabled=false;return;}var opt=await o.json();` +
    `opt.challenge=b64uToBuf(opt.challenge);opt.user.id=b64uToBuf(opt.user.id);` +
    `if(opt.excludeCredentials)opt.excludeCredentials=opt.excludeCredentials.map(function(c){c.id=b64uToBuf(c.id);return c;});` +
    `var cred=await navigator.credentials.create({publicKey:opt});` +
    `var v=await fetch('/webauthn/register/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(serializeReg(cred))});` +
    `var r=await v.json();if(r.verified){say('Passkey added.');btn.disabled=false;}else{say('Verification failed.',1);btn.disabled=false;}` +
    `}catch(e){say(String(e&&e.message||e),1);btn.disabled=false;}});` +
    SERIALIZE_REG;
  return authDoc('Settings', body, script);
}

const SERIALIZE_REG = `
function serializeReg(c){var r=c.response;return {id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),attestationObject:bufToB64u(r.attestationObject),transports:r.getTransports?r.getTransports():[]}};}
`;
const SERIALIZE_AUTH = `
function serializeAuth(c){var r=c.response;return {id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),authenticatorData:bufToB64u(r.authenticatorData),signature:bufToB64u(r.signature),userHandle:r.userHandle?bufToB64u(r.userHandle):undefined}};}
`;
