/**
 * Passkey (WebAuthn) auth for the viewer host.
 *
 * ## rpID / origin derivation — pinned to VIEWER_HOST outside development
 * WebAuthn binds a credential to an rpID (a registrable-domain suffix of the page origin)
 * and verifies the assertion's origin server-side.
 *
 * In production/preview we pin BOTH to `env.VIEWER_HOST` (`rpID = VIEWER_HOST`,
 * `origin = https://VIEWER_HOST`) and 403 every `/webauthn/*` ceremony whose
 * `url.hostname` isn't the viewer host. The worker is reachable on non-API hostnames too
 * (the router sends every host other than `env.API_HOST` to the viewer, and the zone
 * routes are still commented in wrangler.jsonc), so deriving the rpID from `url.hostname`
 * would let a first setup on an alternate host — e.g. the `*.workers.dev` preview URL —
 * mint the sole credential scoped to the WRONG rpID. Because credentials are counted
 * globally, that bricks setup on the real viewer host (`sessions.vza.net`), where the
 * alternate-host passkey can't be offered, until the DB is manually cleaned up. Pinning
 * the ceremony host closes that lockout.
 *
 * In development (`ENVIRONMENT === 'development'`) we keep the `url.hostname` / `url.origin`
 * fallback: `wrangler dev` serves from localhost:8787 and the vitest workers pool serves
 * from the test host, and a hardcoded VIEWER_HOST would disagree with the browser's actual
 * origin and fail every origin check.
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

/** True when this host is allowed to run a passkey ceremony (pinned to VIEWER_HOST outside dev). */
function ceremonyHostOk(url: URL, env: Env): boolean {
  if (env.ENVIRONMENT === 'development') return true;
  return url.hostname === env.VIEWER_HOST;
}

function rp(url: URL, env: Env): { rpID: string; origin: string } {
  if (env.ENVIRONMENT === 'development') return { rpID: url.hostname, origin: url.origin };
  return { rpID: env.VIEWER_HOST, origin: `https://${env.VIEWER_HOST}` };
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

/** The base64url challenge the browser echoes back inside clientDataJSON, if present. */
function challengeOf(response: { response: { clientDataJSON: string } }): string | undefined {
  const clientData = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)) as { challenge?: string };
  return clientData.challenge;
}

/**
 * Parse a verify body and pull out its echoed challenge. Both steps — `request.json()`
 * and the base64url/JSON decode of clientDataJSON — run before any verifier and both
 * throw on garbage input; this is a public unauthenticated surface, so a malformed body
 * must surface as a JSON 400 (via the null return), never an uncaught 500. A body that
 * decodes cleanly but omits a string `challenge` (e.g. clientDataJSON of `{}`) also
 * returns null: an undefined challenge would otherwise reach D1 `.bind(...)` and 500.
 */
async function readVerifyBody<T extends { response: { clientDataJSON: string } }>(
  request: Request,
): Promise<{ response: T; challenge: string } | null> {
  try {
    const response = (await request.json()) as T;
    const challenge = challengeOf(response);
    if (typeof challenge !== 'string' || challenge.length === 0) return null;
    return { response, challenge };
  } catch {
    return null;
  }
}

/** Persist a single-use challenge in D1, pruning any that have already expired. */
async function storeChallenge(env: Env, challenge: string, kind: 'register' | 'auth'): Promise<void> {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?1').bind(now).run();
  await env.DB.prepare(
    'INSERT INTO webauthn_challenges (challenge, kind, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(challenge, kind, now, now + CHALLENGE_TTL * 1000)
    .run();
}

/**
 * Atomically consume (delete) a stored challenge of the expected kind. D1 serializes
 * writes, so `changes === 1` is a strongly-consistent single-use signal: concurrent
 * verifies can't both win, and a replay after consumption finds nothing to delete.
 */
async function consumeChallenge(env: Env, challenge: string, kind: 'register' | 'auth'): Promise<boolean> {
  const result = await env.DB.prepare(
    'DELETE FROM webauthn_challenges WHERE challenge = ?1 AND kind = ?2 AND expires_at > ?3',
  )
    .bind(challenge, kind, Date.now())
    .run();
  return result.meta.changes === 1;
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

  // Pin every credential ceremony to the viewer host so an alternate host (e.g. the
  // workers.dev preview URL) can't mint the sole credential scoped to the wrong rpID.
  if (path.startsWith('/webauthn/') && !ceremonyHostOk(url, env)) return json({ error: 'bad_host' }, 403);

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

  const { rpID } = rp(url, env);
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
    // UV required: the viewer's ONLY factor is the passkey, so a possession-only
    // (user-presence) authenticator must not be enrolled or accepted.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });

  await storeChallenge(env, options.challenge, 'register');
  return json(options);
}

async function registerVerify(request: Request, url: URL, env: Env, deps: WebAuthnDeps): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const parsed = await readVerifyBody<RegistrationResponseJSON>(request);
  if (!parsed) return json({ error: 'bad_request' }, 400);
  const { response, challenge } = parsed;
  const { rpID, origin } = rp(url, env);

  // An authenticated session skips the setup guard (owner adding another device); the
  // setup-token path is only for the first credential and is enforced atomically below.
  const authorized = (await readSession(request, env)) !== null;

  if (!(await consumeChallenge(env, challenge, 'register'))) return json({ error: 'bad_challenge' }, 400);

  // SimpleWebAuthn throws on malformed authenticator data / bad attestation. This is a
  // public unauthenticated surface, so a throw must surface as a 400, never a 500.
  let verification;
  try {
    verification = await deps.verifyRegistration({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // UV required: reject an enrollment whose authenticator didn't verify the user.
      requireUserVerification: true,
    });
  } catch {
    return json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) return json({ verified: false }, 400);

  const cred = verification.registrationInfo.credential;
  const transports = cred.transports ? JSON.stringify(cred.transports) : null;

  if (authorized) {
    await env.DB.prepare(
      `INSERT INTO credentials (credential_id, user_id, public_key, counter, transports, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (credential_id) DO UPDATE SET counter = excluded.counter`,
    )
      .bind(cred.id, OWNER, cred.publicKey, cred.counter, transports)
      .run();
    return json({ verified: true });
  }

  // Setup-token path: re-check the credential count AT INSERT TIME, atomically. D1
  // serializes writes, so a conditional `INSERT ... SELECT ... WHERE COUNT(*)=0` closes
  // the race where two challenges were minted while the table was empty — the second
  // insert lands 0 rows and we report setup_disabled instead of silently enrolling a
  // second unauthenticated credential.
  const result = await env.DB.prepare(
    `INSERT INTO credentials (credential_id, user_id, public_key, counter, transports, last_used_at)
     SELECT ?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE (SELECT COUNT(*) FROM credentials) = 0`,
  )
    .bind(cred.id, OWNER, cred.publicKey, cred.counter, transports)
    .run();
  if (result.meta.changes === 0) return json({ error: 'setup_disabled' }, 403);

  return json({ verified: true });
}

async function authOptions(request: Request, url: URL, env: Env): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const { rpID } = rp(url, env);
  const creds = await env.DB.prepare('SELECT credential_id, transports FROM credentials').all<{
    credential_id: string;
    transports: string | null;
  }>();

  const options = await generateAuthenticationOptions({
    rpID,
    // UV required: possession alone must not mint the viewer's only auth factor.
    userVerification: 'required',
    allowCredentials: creds.results.map((c) => ({
      id: c.credential_id,
      transports: parseTransports(c.transports),
    })),
  });

  await storeChallenge(env, options.challenge, 'auth');
  return json(options);
}

async function authVerify(request: Request, url: URL, env: Env, deps: WebAuthnDeps): Promise<Response> {
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  const parsed = await readVerifyBody<AuthenticationResponseJSON>(request);
  if (!parsed) return json({ error: 'bad_request' }, 400);
  const { response, challenge } = parsed;
  const { rpID, origin } = rp(url, env);

  // Guard the credential id BEFORE consuming the challenge: it's bound into D1 below, and a
  // missing/non-string id would raise a bind type error (500). Validating first also means a
  // request that fails this check does not burn the single-use challenge.
  if (typeof response.id !== 'string' || response.id.length === 0) return json({ error: 'bad_request' }, 400);

  if (!(await consumeChallenge(env, challenge, 'auth'))) return json({ error: 'bad_challenge' }, 400);

  const row = await env.DB.prepare(
    'SELECT credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?1',
  )
    .bind(response.id)
    .first<CredentialRow>();
  if (!row) return json({ error: 'unknown_credential' }, 400);

  // SimpleWebAuthn throws on bad signatures, counter regressions, or decode errors. This
  // is a public unauthenticated surface, so a throw must surface as a 400, never a 500.
  let verification;
  try {
    verification = await deps.verifyAuthentication({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // UV required: possession alone must not mint the viewer's only auth factor.
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
    });
  } catch {
    return json({ error: 'verification_failed' }, 400);
  }
  if (!verification.verified) return json({ verified: false }, 400);

  // Monotonic counter: the `AND counter < ?1` guard keeps the stored value from regressing
  // when two ceremonies for the same authenticator commit out of order (both read the old
  // value; the lower newCounter must not overwrite a higher one already committed) — a
  // regression would weaken clone/replay detection. A zero-change result is fine: login
  // still succeeds, and authenticators that don't implement counters legitimately stay at 0
  // (SimpleWebAuthn returns newCounter 0, so `counter < 0` never fires — no false regression).
  await env.DB.prepare(
    "UPDATE credentials SET counter = ?1, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE credential_id = ?2 AND counter < ?1",
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
