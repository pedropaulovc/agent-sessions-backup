import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { originOk, readSession } from '../auth/session';
import { freshAuthenticationOptions, verifyFreshAuthentication, type WebAuthnDeps } from '../auth/webauthn';
import { assetRelSuffix, type ExternalAssetRef, type NormalizedSession } from '../ingest/normalize';
import { parseObject } from '../ingest/parse';
import { extractConversationById } from '../ingest/parsers/export-inbox';
import { recordUploadedObject } from './upload';
import { hex } from './ops';

const TEXT = new TextEncoder();
const MAX_SESSIONS = 16;
const MAX_OBJECTS = 256;
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ACTIVE_PER_USER = 2;
const MAX_DAILY_PER_USER = 10;
const PREPARE_TTL_MS = 15 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const EXCHANGE_TTL_MS = 10 * 60_000;
const IMPORT_TTL_MS = 30 * 60_000;
const USER = 'owner';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const PKCE_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const ID_RE = /^[A-Za-z0-9._:@/-]{1,256}$/;
const SAFE_STORE = new Set(['claude-projects', 'claude', 'codex-sessions', 'codex', 'omp', 'chatgpt-web', 'claude-web']);
const FORBIDDEN_KEY = /(?:credential|webauthn|authorization|cookie|oauth|setup.?token|private.?key|signing.?secret|admin|machine.?cert|alert|\bkv\b)/i;

interface Signed<T = Record<string, unknown>> { payload: T; signature: string }
interface DestinationPayload extends Record<string, unknown> {
  format: number; scope: string; kind: 'local' | 'remote'; jti: string; iat: number; exp: number;
  inventoryDigest: string | null; encryptionPublicJwk: JsonWebKey; environmentNonce: string;
  buildInputDigest?: string; artifactDigest: string; headSha?: string; deviceId?: string; deviceCounter?: number;
  releaseDigest?: string; keyProtection?: string; prNumber?: number; destinationId?: string;
  generation?: string; maxBytes?: number; sessionIds?: string[];
}
interface JobRow {
  job_id: string; user_id: string; selected_session_ids: string; destination_json: string;
  destination_hash: string; pkce_challenge: string; status: string; inventory_digest: string | null;
  inventory_size: number | null; inventory_count: number | null; final_destination_json: string | null;
  final_destination_hash: string | null; expires_at: number; grant_expires_at: number | null;
}
interface SnapshotObject {
  objectId: string; kind: 'source' | 'externalAsset'; store: string; relpath: string;
  bytes: Uint8Array; sha256: string; sessionIds: string[];
}
interface ManifestObject {
  objectId: string; kind: 'source' | 'externalAsset'; store: string; relpath: string; size: number;
  sha256: string; sessionIds: string[]; ciphertextSize: number; ciphertextSha256: string;
  wrappedKey: string; nonce: string; aad: string; url: string;
}
interface ExchangeManifest {
  format: 1; sessionIds: string[]; inventoryDigest: string; totalSize: number; objectCount: number;
  expiresAt: number; objects: ManifestObject[]; signature?: { alg: 'ES256'; value: string };
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers } });
}
function browserHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set('cache-control', 'no-store'); headers.set('referrer-policy', 'no-referrer');
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set('x-frame-options', 'DENY'); return headers;
}
export function canonicalDebugJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('undefined is not canonical JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalDebugJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalDebugJson(object[key])}`).join(',')}}`;
}
async function sha256(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? TEXT.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
export async function debugCapabilityHash(token: string): Promise<string> { return sha256(`debug-capability\0${token}`); }
const tokenHash = debugCapabilityHash;
function base64url(bytes: Uint8Array | ArrayBuffer): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try { const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); } catch { return null; }
}
function randomToken(bytes = 32): string { return base64url(crypto.getRandomValues(new Uint8Array(bytes))); }
function parseJson<T>(raw: string | null): T | null { if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } }
async function bodyJson<T>(request: Request): Promise<T | null> { try { return await request.json() as T; } catch { return null; } }
async function userFor(request: Request, env: Env): Promise<string | null> { if (env.ENVIRONMENT === 'development') return USER; return (await readSession(request, env))?.user ?? null; }
function cleanIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SESSIONS) return null;
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))].sort();
  return ids.length === value.length ? ids : null;
}
function exactLoopback(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && !!url.port ? url : null; } catch { return null; }
}
async function audit(env: Env, event: string, fields: { user?: string; device?: string; job?: string; detail?: unknown } = {}): Promise<void> {
  await env.DB.prepare('INSERT INTO debug_exchange_audit (event,user_id,device_id,job_id,detail,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(event, fields.user ?? null, fields.device ?? null, fields.job ?? null, fields.detail === undefined ? null : canonicalDebugJson(fields.detail), Date.now()).run();
}
async function verifySigned(signed: Signed, jwk: JsonWebKey): Promise<boolean> {
  const signature = fromBase64url(signed.signature);
  if (!signature) return false;
  try {
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
      const key = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
      );
      return crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, signature, TEXT.encode(canonicalDebugJson(signed.payload)),
      );
    }
    if (jwk.kty === 'RSA') {
      const key = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      );
      return crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', key, signature, TEXT.encode(canonicalDebugJson(signed.payload)),
      );
    }
    const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, signature, TEXT.encode(canonicalDebugJson(signed.payload)));
  } catch {
    return false;
  }
}
function publicRsaKey(jwk: unknown): jwk is JsonWebKey { const key = jwk as JsonWebKey | null; return !!key && key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string' && key.d === undefined; }
async function consumeReplay(env: Env, jti: string, kind: string, expiresAt: number): Promise<boolean> {
  try { const result = await env.DB.prepare('INSERT INTO debug_export_replays (jti,kind,expires_at) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING').bind(jti, kind, expiresAt).run(); return result.meta.changes === 1; } catch { return false; }
}

async function validateDestination(signed: Signed<DestinationPayload>, env: Env, inventoryDigest: string | null, consume = true): Promise<{ payload: DestinationPayload; digest: string } | { error: string }> {
  const payload = signed?.payload; const now = Date.now();
  if (!payload || payload.format !== 1 ||
      (payload.kind !== 'local' && payload.kind !== 'remote') ||
      (payload.kind === 'local' && payload.scope !== 'local-destination-attest') ||
      (payload.kind === 'remote' && payload.scope !== 'remote-destination-attest') ||
      !TOKEN_RE.test(payload.jti) || !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) || payload.iat > now + 30_000 ||
      payload.exp <= now || payload.exp - payload.iat > PREPARE_TTL_MS ||
      payload.inventoryDigest !== inventoryDigest || !TOKEN_RE.test(payload.environmentNonce) ||
      !DIGEST_RE.test(payload.artifactDigest) || !publicRsaKey(payload.encryptionPublicJwk)) {
    return { error: 'invalid_destination' };
  }
  let key: JsonWebKey | null = null;
  if (payload.kind === 'local') {
    if (!payload.buildInputDigest || !DIGEST_RE.test(payload.buildInputDigest) ||
        !payload.deviceId || !Number.isSafeInteger(payload.deviceCounter) || !payload.releaseDigest ||
        !payload.keyProtection || payload.keyProtection === 'software') return { error: 'invalid_device' };
    const device = await env.DB.prepare("SELECT public_jwk,release_digest,key_protection,last_counter FROM debug_export_devices WHERE device_id=?1 AND scope='local-destination-attest' AND revoked_at IS NULL AND expires_at>?2")
      .bind(payload.deviceId, now).first<{ public_jwk: string; release_digest: string; key_protection: string; last_counter: number }>();
    if (!device || device.release_digest !== payload.releaseDigest || device.key_protection !== payload.keyProtection) return { error: 'invalid_device' };
    const approved = (env.DEBUG_EXPORT_APPROVED_RELEASE_DIGESTS ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    if (env.ENVIRONMENT !== 'development' && !approved.includes(payload.releaseDigest)) {
      return { error: 'wrong_release' };
    }
    key = parseJson<JsonWebKey>(device.public_jwk);
    if (!key || !(await verifySigned(signed, key))) return { error: 'invalid_destination_signature' };
    if (consume) {
      const counter = await env.DB.prepare(
        `UPDATE debug_export_devices SET last_counter=?2
          WHERE device_id=?1 AND last_counter<?2 AND revoked_at IS NULL AND expires_at>?3
          RETURNING device_id`,
      ).bind(payload.deviceId, payload.deviceCounter, now).first<{ device_id: string }>();
      if (!counter) return { error: 'device_replay' };
    }
  } else {
    if (!Number.isSafeInteger(payload.prNumber) || !SHA_RE.test(payload.headSha ?? '') ||
        !payload.buildInputDigest || !DIGEST_RE.test(payload.buildInputDigest) ||
        !payload.destinationId || !TOKEN_RE.test(payload.destinationId) ||
        !payload.generation || !/^g\d+-[0-9a-f]{12}$/.test(payload.generation) ||
        !Number.isSafeInteger(payload.maxBytes) || payload.maxBytes! < 1 ||
        payload.maxBytes! > MAX_TOTAL_BYTES || cleanIds(payload.sessionIds) === null) {
      return { error: 'invalid_destination' };
    }
    key = parseJson<JsonWebKey>(env.DEBUG_EXPORT_REMOTE_ATTESTATION_PUBLIC_JWK ?? null);
    if (!key || !(await verifySigned(signed, key))) return { error: 'invalid_destination_signature' };
  }
  if (consume && !(await consumeReplay(env, payload.jti, 'destination', payload.exp))) return { error: 'destination_replay' };
  const digest = await sha256(canonicalDebugJson(payload)); await audit(env, 'destination.attested', { device: payload.deviceId, detail: { kind: payload.kind, digest, exp: payload.exp } });
  return { payload, digest };
}
function passkeyRequest(request: Request, response: AuthenticationResponseJSON): Request { return new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(response) }); }

export async function debugBrowserRoute(request: Request, url: URL, env: Env, deps?: WebAuthnDeps): Promise<Response | null> {
  if (!url.pathname.startsWith('/debug/')) return null;
  const user = await userFor(request, env); if (!user) return new Response(null, { status: 302, headers: { location: '/login' } });
  if (url.pathname === '/debug/prepare' && request.method === 'GET') return preparePage(url);
  const consentPageMatch = url.pathname.match(/^\/debug\/jobs\/([^/]+)\/consent$/);
  if (consentPageMatch && request.method === 'GET') {
    return finalConsentPage(url, decodeURIComponent(consentPageMatch[1]!), env, user);
  }
  if (url.pathname === '/debug/devices/enroll' && request.method === 'GET') {
    return deviceEnrollmentPage(url);
  }
  if (!originOk(request)) return json({ error: 'bad_origin' }, 403);
  if (url.pathname === '/debug/devices/enroll/options' && request.method === 'POST') {
    const metadata = validDeviceMetadata(await bodyJson<Record<string, unknown>>(request)); if (!metadata) return json({ error: 'bad_device_metadata' }, 400);
    return freshAuthenticationOptions(request, url, env, 'debug-device-enroll',
      await sha256(canonicalDebugJson({ metadata, scope: 'local-destination-attest', user })));
  }
  if (url.pathname === '/debug/devices/enroll/verify' && request.method === 'POST') {
    const body = await bodyJson<{ metadata?: Record<string, unknown>; response?: AuthenticationResponseJSON }>(request); const metadata = validDeviceMetadata(body?.metadata);
    if (!metadata || !body?.response) return json({ error: 'bad_request' }, 400);
    const verified = await verifyFreshAuthentication(passkeyRequest(request, body.response), url, env,
      'debug-device-enroll',
      await sha256(canonicalDebugJson({ metadata, scope: 'local-destination-attest', user })), deps);
    if (!verified.verified) return json({ error: verified.error }, verified.status);
    await env.DB.prepare("INSERT INTO debug_export_devices (device_id,user_id,label,public_jwk,release_digest,key_protection,scope,enrolled_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,'local-destination-attest',?7,?8)")
      .bind(metadata.deviceId, user, metadata.label, canonicalDebugJson(metadata.publicJwk), metadata.releaseDigest, metadata.keyProtection, Date.now(), metadata.expiresAt).run();
    await audit(env, 'device.enrolled', { user, device: metadata.deviceId, detail: { releaseDigest: metadata.releaseDigest, expiresAt: metadata.expiresAt } }); return json({ enrolled: true, deviceId: metadata.deviceId }, 201);
  }
  const revoke = url.pathname.match(/^\/debug\/devices\/([^/]+)\/revoke\/(options|verify)$/);
  if (revoke && request.method === 'POST') {
    const deviceId = decodeURIComponent(revoke[1]!); const row = await env.DB.prepare('SELECT device_id FROM debug_export_devices WHERE device_id=?1 AND user_id=?2 AND revoked_at IS NULL').bind(deviceId, user).first<{ device_id: string }>();
    if (!row) return json({ error: 'not_found' }, 404); const binding = await sha256(canonicalDebugJson({ deviceId, operation: 'revoke' }));
    if (revoke[2] === 'options') return freshAuthenticationOptions(request, url, env, 'debug-device-revoke', binding);
    const body = await bodyJson<{ response?: AuthenticationResponseJSON }>(request); if (!body?.response) return json({ error: 'bad_request' }, 400);
    const verified = await verifyFreshAuthentication(passkeyRequest(request, body.response), url, env, 'debug-device-revoke', binding, deps); if (!verified.verified) return json({ error: verified.error }, verified.status);
    await env.DB.prepare('UPDATE debug_export_devices SET revoked_at=?2 WHERE device_id=?1 AND revoked_at IS NULL').bind(deviceId, Date.now()).run(); await audit(env, 'device.revoked', { user, device: deviceId }); return json({ revoked: true });
  }
  if (url.pathname === '/debug/prepare' && request.method === 'POST') return prepareExport(request, env, user);
  const consent = url.pathname.match(/^\/debug\/jobs\/([^/]+)\/consent\/(options|verify)$/);
  if (consent && request.method === 'POST') return finalConsent(request, url, env, user, consent[1]!, consent[2] as 'options' | 'verify', deps);
  return new Response('not found', { status: 404, headers: browserHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
}

function validDeviceMetadata(value: unknown): { deviceId: string; label: string; publicJwk: JsonWebKey; releaseDigest: string; keyProtection: string; expiresAt: number } | null {
  const v = value as Record<string, unknown> | null; const allowedProtection = new Set(['windows-cng-tpm', 'tpm2-pkcs11']);
  if (!v || typeof v.deviceId !== 'string' || !TOKEN_RE.test(v.deviceId) || typeof v.label !== 'string' || v.label.length < 1 || v.label.length > 100 || !publicSigningJwk(v.publicJwk) || typeof v.releaseDigest !== 'string' || !DIGEST_RE.test(v.releaseDigest) || typeof v.keyProtection !== 'string' || !allowedProtection.has(v.keyProtection) || !Number.isSafeInteger(v.expiresAt) || (v.expiresAt as number) <= Date.now() || (v.expiresAt as number) > Date.now() + 366 * 86_400_000) return null;
  return v as unknown as { deviceId: string; label: string; publicJwk: JsonWebKey; releaseDigest: string; keyProtection: string; expiresAt: number };
}
function publicSigningJwk(value: unknown): value is JsonWebKey { const key = value as JsonWebKey | null; return !!key && key.d === undefined && ((key.kty === 'EC' && key.crv === 'P-256' && !!key.x && !!key.y) || (key.kty === 'RSA' && !!key.n && !!key.e) || (key.kty === 'OKP' && key.crv === 'Ed25519' && !!key.x)); }
function preparePage(url: URL): Response {
  const bytes = fromBase64url(url.searchParams.get('request') ?? ''); const requestText = bytes ? new TextDecoder().decode(bytes) : ''; let request: Record<string, unknown> | null = null;
  try { request = JSON.parse(requestText) as Record<string, unknown>; } catch { /* invalid */ }
  const safe = request ? JSON.stringify(request).replace(/</g, '\\u003c') : 'null';
  const html = `<!doctype html><meta charset="utf-8"><title>Prepare debug session</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto}pre{white-space:pre-wrap}button{padding:.7rem 1rem}</style><h1>Prepare production debug session</h1><p>This creates an immutable encrypted snapshot for the displayed destination. It grants no production browsing or search access.</p><pre id="summary"></pre><button id="approve">Prepare encrypted snapshot</button><p id="result"></p><script>const request=${safe};summary.textContent=request?JSON.stringify({sessionIds:request.sessionIds,destination:request.destinationAttestation&&request.destinationAttestation.payload},null,2):'Invalid request';approve.disabled=!request;approve.onclick=async()=>{approve.disabled=true;const r=await fetch('/debug/prepare',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(request)});const x=await r.json().catch(()=>({error:'request_failed'}));if(r.ok&&x.redirectTo){location.href=x.redirectTo;return}result.textContent=x.error||'Preparation failed';approve.disabled=false;};</script>`;
  return new Response(html, { headers: browserHeaders({ 'content-type': 'text/html; charset=utf-8' }) });
}

async function finalConsentPage(url: URL, capability: string, env: Env, user: string): Promise<Response> {
  const job = await jobByCapability(env, capability);
  if (!job || job.user_id !== user || job.status !== 'awaiting_consent' ||
      !job.inventory_digest || job.expires_at <= Date.now()) {
    return new Response('not found', { status: 404, headers: browserHeaders({ 'content-type': 'text/plain; charset=utf-8' }) });
  }
  const callback = exactLoopback(url.searchParams.get('callback'));
  const attestationBytes = fromBase64url(url.searchParams.get('attestation') ?? '');
  let attestation: Signed<DestinationPayload> | null = null;
  try {
    attestation = attestationBytes
      ? JSON.parse(new TextDecoder().decode(attestationBytes)) as Signed<DestinationPayload>
      : null;
  } catch {
    attestation = null;
  }
  const safeAttestation = attestation ? JSON.stringify(attestation).replace(/</g, '\\u003c') : 'null';
  const safeCallback = JSON.stringify(callback?.toString() ?? '');
  const selected = parseJson<string[]>(job.selected_session_ids) ?? [];
  const sessionRows = selected.length === 0 ? { results: [] as Array<{ session_id: string; title: string | null }> }
    : await env.DB.prepare(
      `SELECT session_id,title FROM sessions WHERE session_id IN (${selected.map((_, index) => `?${index + 1}`).join(',')}) ORDER BY session_id`,
    ).bind(...selected).all<{ session_id: string; title: string | null }>();
  const safeInventory = JSON.stringify({
    sessions: sessionRows.results.map((session) => ({ sessionId: session.session_id, title: session.title })),
    totalSize: job.inventory_size,
    objectCount: job.inventory_count,
    inventoryDigest: job.inventory_digest,
    expiresAt: job.expires_at,
  }).replace(/</g, '\u005cu003c');
  const safeCapability = JSON.stringify(capability);
  const html = `<!doctype html><meta charset="utf-8"><title>Approve debug export</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto}pre{white-space:pre-wrap}button{padding:.7rem 1rem}.error{color:#a00}</style><h1>Final production export approval</h1><p>Confirm the exact immutable inventory and destination with a fresh passkey touch.</p><pre id="summary"></pre><button id="approve">Approve and encrypt</button><p id="result"></p><script>
const attestation=${safeAttestation},callback=${safeCallback},capability=${safeCapability},inventory=${safeInventory};
const b64uToBuf=s=>{let p=s.replace(/-/g,'+').replace(/_/g,'/');p+='='.repeat((4-p.length%4)%4);const b=atob(p),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer};
const bufToB64u=b=>{const u=new Uint8Array(b);let s='';for(const x of u)s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const serialize=c=>{const r=c.response;return{id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),authenticatorData:bufToB64u(r.authenticatorData),signature:bufToB64u(r.signature),userHandle:r.userHandle?bufToB64u(r.userHandle):undefined}}};
summary.textContent=attestation?JSON.stringify({inventory,destination:attestation.payload},null,2):'Invalid destination attestation';
approve.disabled=!attestation||!callback;
approve.onclick=async()=>{approve.disabled=true;try{const o=await fetch('/debug/jobs/'+encodeURIComponent(capability)+'/consent/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({destinationAttestation:attestation})});const options=await o.json();if(!o.ok)throw new Error(options.error||'options failed');options.challenge=b64uToBuf(options.challenge);options.allowCredentials=(options.allowCredentials||[]).map(x=>({...x,id:b64uToBuf(x.id)}));const credential=await navigator.credentials.get({publicKey:options});const v=await fetch('/debug/jobs/'+encodeURIComponent(capability)+'/consent/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({destinationAttestation:attestation,response:serialize(credential)})});const verified=await v.json();if(!v.ok)throw new Error(verified.error||'verification failed');const target=new URL(callback);target.searchParams.set('code',verified.authorizationCode);target.searchParams.set('state',capability);location.href=target.toString()}catch(e){result.textContent=String(e);result.className='error';approve.disabled=false}};
</script>`;
  return new Response(html, { headers: browserHeaders({ 'content-type': 'text/html; charset=utf-8' }) });
}

function deviceEnrollmentPage(url: URL): Response {
  const metadataBytes = fromBase64url(url.searchParams.get('request') ?? '');
  const callback = exactLoopback(url.searchParams.get('callback'));
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = metadataBytes
      ? JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>
      : null;
  } catch {
    metadata = null;
  }
  const safeMetadata = metadata ? JSON.stringify(metadata).replace(/</g, '\u005cu003c') : 'null';
  const safeCallback = JSON.stringify(callback?.toString() ?? '');
  const html = `<!doctype html><meta charset="utf-8"><title>Enroll debug bridge</title><style>body{font:16px system-ui;max-width:48rem;margin:3rem auto}pre{white-space:pre-wrap}button{padding:.7rem 1rem}.error{color:#a00}</style><h1>Enroll signed debug bridge</h1><p>Approve the exact non-exportable bridge public key, protected release digest, label, scope, and expiry with a fresh passkey touch.</p><pre id="summary"></pre><button id="approve">Enroll device</button><p id="result"></p><script>
const metadata=${safeMetadata},callback=${safeCallback};
const b64uToBuf=s=>{let p=s.replace(/-/g,'+').replace(/_/g,'/');p+='='.repeat((4-p.length%4)%4);const b=atob(p),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer};
const bufToB64u=b=>{const u=new Uint8Array(b);let s='';for(const x of u)s+=String.fromCharCode(x);return btoa(s).replace(/\u005c+/g,'-').replace(/\u005c//g,'_').replace(/=+$/,'')};
const serialize=c=>{const r=c.response;return{id:c.id,rawId:bufToB64u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:bufToB64u(r.clientDataJSON),authenticatorData:bufToB64u(r.authenticatorData),signature:bufToB64u(r.signature),userHandle:r.userHandle?bufToB64u(r.userHandle):undefined}}};
summary.textContent=metadata?JSON.stringify(metadata,null,2):'Invalid enrollment request';approve.disabled=!metadata||!callback;
approve.onclick=async()=>{approve.disabled=true;try{const o=await fetch('/debug/devices/enroll/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(metadata)});const options=await o.json();if(!o.ok)throw new Error(options.error||'options failed');options.challenge=b64uToBuf(options.challenge);options.allowCredentials=(options.allowCredentials||[]).map(x=>({...x,id:b64uToBuf(x.id)}));const credential=await navigator.credentials.get({publicKey:options});const v=await fetch('/debug/devices/enroll/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({metadata,response:serialize(credential)})});const verified=await v.json();if(!v.ok)throw new Error(verified.error||'verification failed');const target=new URL(callback);target.searchParams.set('device_id',verified.deviceId);location.href=target.toString()}catch(e){result.textContent=String(e);result.className='error';approve.disabled=false}};
</script>`;
  return new Response(html, { headers: browserHeaders({ 'content-type': 'text/html; charset=utf-8' }) });
}

async function prepareExport(request: Request, env: Env, user: string): Promise<Response> {
  const body = await bodyJson<{ sessionIds?: unknown; destinationAttestation?: Signed<DestinationPayload>; pkceChallenge?: unknown; callback?: unknown }>(request); const sessionIds = cleanIds(body?.sessionIds); const callback = exactLoopback(body?.callback);
  if (!sessionIds || !callback || typeof body?.pkceChallenge !== 'string' || !PKCE_RE.test(body.pkceChallenge) || !body.destinationAttestation) return json({ error: 'bad_request' }, 400);
  const destination = await validateDestination(body.destinationAttestation, env, null); if ('error' in destination) return json({ error: destination.error }, 403); const now = Date.now();
  const quota = await env.DB.prepare("SELECT SUM(CASE WHEN status IN ('preparing','awaiting_consent') AND expires_at>?2 THEN 1 ELSE 0 END) active, COUNT(*) daily FROM debug_export_jobs WHERE user_id=?1 AND created_at>?3").bind(user, now, now - 86_400_000).first<{ active: number; daily: number }>();
  if ((quota?.active ?? 0) >= MAX_ACTIVE_PER_USER || (quota?.daily ?? 0) >= MAX_DAILY_PER_USER) { await audit(env, 'export.quota_rejected', { user }); return json({ error: 'quota_exceeded' }, 429); }
  if (destination.payload.kind === 'remote' &&
      canonicalDebugJson(cleanIds(destination.payload.sessionIds)) !== canonicalDebugJson(sessionIds)) {
    return json({ error: 'wrong_session' }, 403);
  }
  const found = await env.DB.prepare(`SELECT session_id FROM sessions WHERE index_state='ready' AND session_id IN (${sessionIds.map((_, i) => `?${i + 1}`).join(',')})`).bind(...sessionIds).all<{ session_id: string }>();
  if (found.results.length !== sessionIds.length) return json({ error: 'selection_unavailable' }, 404);
  const jobId = crypto.randomUUID(); const prepareCode = randomToken(); const capability = randomToken();
  await env.DB.prepare("INSERT INTO debug_export_jobs (job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,prepare_code_hash,capability_hash,status,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'preparing',?9,?10)")
    .bind(jobId, user, canonicalDebugJson(sessionIds), canonicalDebugJson(body.destinationAttestation), destination.digest, body.pkceChallenge, await tokenHash(prepareCode), await tokenHash(capability), now, now + PREPARE_TTL_MS).run();
  await env.PARSE_QUEUE.send({ debug: 'export-snapshot', job_id: jobId }); await audit(env, 'export.prepared', { user, job: jobId, detail: { destination: destination.digest, sessionCount: sessionIds.length } });
  callback.searchParams.set('code', prepareCode);
  callback.searchParams.set('state', jobId);
  if (request.headers.get('accept')?.includes('application/json')) {
    return json({ redirectTo: callback.toString() });
  }
  return new Response(null, { status: 303, headers: browserHeaders({ location: callback.toString() }) });
}
async function jobByCapability(env: Env, capability: string): Promise<JobRow | null> {
  if (!TOKEN_RE.test(capability)) return null;
  return env.DB.prepare('SELECT job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,status,inventory_digest,inventory_size,inventory_count,final_destination_json,final_destination_hash,expires_at,grant_expires_at FROM debug_export_jobs WHERE capability_hash=?1').bind(await tokenHash(capability)).first<JobRow>();
}
async function finalConsent(request: Request, url: URL, env: Env, user: string, capability: string, action: 'options' | 'verify', deps?: WebAuthnDeps): Promise<Response> {
  const job = await jobByCapability(env, capability); if (!job || job.user_id !== user || job.status !== 'awaiting_consent' || !job.inventory_digest || job.expires_at <= Date.now()) return json({ error: 'not_found' }, 404);
  const body = await bodyJson<{ destinationAttestation?: Signed<DestinationPayload>; response?: AuthenticationResponseJSON }>(request); if (!body?.destinationAttestation) return json({ error: 'bad_request' }, 400);
  const destination = await validateDestination(body.destinationAttestation, env, job.inventory_digest, action === 'options'); if ('error' in destination) return json({ error: destination.error }, 403);
  const initial = parseJson<Signed<DestinationPayload>>(job.destination_json)?.payload; if (!initial || !sameDestination(initial, destination.payload)) return json({ error: 'wrong_destination' }, 403);
  const destinationJson = canonicalDebugJson(body.destinationAttestation); const binding = await sha256(canonicalDebugJson({ jobId: job.job_id, user, sessionIds: parseJson(job.selected_session_ids), inventoryDigest: job.inventory_digest, inventorySize: job.inventory_size, destinationHash: destination.digest, pkceChallenge: job.pkce_challenge, expiresAt: job.expires_at }));
  if (action === 'options') { await env.DB.prepare('UPDATE debug_export_jobs SET final_destination_json=?2,final_destination_hash=?3 WHERE job_id=?1').bind(job.job_id, destinationJson, destination.digest).run(); return freshAuthenticationOptions(request, url, env, `debug-export-final:${job.job_id}`, binding); }
  if (!body.response || job.final_destination_json !== destinationJson || job.final_destination_hash !== destination.digest) return json({ error: 'destination_changed' }, 409);
  const verified = await verifyFreshAuthentication(passkeyRequest(request, body.response), url, env, `debug-export-final:${job.job_id}`, binding, deps); if (!verified.verified) return json({ error: verified.error }, verified.status);
  const code = randomToken(); const jti = randomToken(18); const expires = Math.min(Date.now() + CODE_TTL_MS, job.expires_at);
  const granted = await env.DB.prepare("UPDATE debug_export_jobs SET grant_code_hash=?2,grant_jti=?3,grant_expires_at=?4,status='authorized' WHERE job_id=?1 AND status='awaiting_consent' RETURNING job_id").bind(job.job_id, await tokenHash(code), jti, expires).first<{ job_id: string }>();
  if (!granted) return json({ error: 'not_found' }, 404); await audit(env, 'grant.created', { user, job: job.job_id, detail: { jti, inventoryDigest: job.inventory_digest, expiresAt: expires } }); return json({ authorizationCode: code, expiresAt: expires });
}
function sameDestination(a: DestinationPayload, b: DestinationPayload): boolean {
  const omit = (value: DestinationPayload): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...value };
    delete copy.inventoryDigest;
    delete copy.jti;
    delete copy.iat;
    delete copy.exp;
    if (copy.kind === 'local') delete copy.deviceCounter;
    return copy;
  };
  return canonicalDebugJson(omit(a)) === canonicalDebugJson(omit(b));
}

export async function debugApiRoute(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/v1/debug/')) return null; await expireDebugState(env, 8);
  if (url.pathname === '/api/v1/debug/prepare/exchange' && request.method === 'POST') return exchangePrepareCode(request, env);
  const job = url.pathname.match(/^\/api\/v1\/debug\/jobs\/([^/]+)$/); if (job && request.method === 'GET') return pollExportJob(env, decodeURIComponent(job[1]!));
  if (url.pathname === '/api/v1/debug/exchange' && request.method === 'POST') return exchangeGrant(request, env);
  const object = url.pathname.match(/^\/api\/v1\/debug\/exchanges\/([^/]+)\/objects\/([^/]+)$/); if (object && request.method === 'GET') return downloadCiphertext(env, decodeURIComponent(object[1]!), decodeURIComponent(object[2]!));
  if (url.pathname === '/api/v1/debug/imports' && request.method === 'POST') return createImport(request, env);
  const importObject = url.pathname.match(/^\/api\/v1\/debug\/imports\/([^/]+)\/objects\/([^/]+)$/); if (importObject && request.method === 'PUT') return uploadImportObject(request, env, decodeURIComponent(importObject[1]!), decodeURIComponent(importObject[2]!));
  const importCommit = url.pathname.match(/^\/api\/v1\/debug\/imports\/([^/]+)\/commit$/); if (importCommit && request.method === 'POST') return commitImport(env, decodeURIComponent(importCommit[1]!));
  const importPoll = url.pathname.match(/^\/api\/v1\/debug\/imports\/([^/]+)$/); if (importPoll && request.method === 'GET') return pollImport(env, decodeURIComponent(importPoll[1]!));
  return json({ error: 'not_found' }, 404);
}
async function exchangePrepareCode(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ code?: string; codeVerifier?: string }>(request); if (!body?.code || !TOKEN_RE.test(body.code) || !body.codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)) return json({ error: 'invalid_grant' }, 400);
  const challenge = base64url(await crypto.subtle.digest('SHA-256', TEXT.encode(body.codeVerifier))); const capability = randomToken();
  const row = await env.DB.prepare("UPDATE debug_export_jobs SET prepare_code_hash=?3,capability_hash=?4 WHERE prepare_code_hash=?1 AND pkce_challenge=?2 AND expires_at>?5 AND status IN ('preparing','awaiting_consent') RETURNING job_id,expires_at")
    .bind(await tokenHash(body.code), challenge, await tokenHash(randomToken()), await tokenHash(capability), Date.now()).first<{ job_id: string; expires_at: number }>();
  if (!row) return json({ error: 'invalid_grant' }, 400); await audit(env, 'prepare.exchanged', { job: row.job_id }); return json({ jobCapability: capability, expiresAt: row.expires_at });
}
async function pollExportJob(env: Env, capability: string): Promise<Response> {
  const job = await jobByCapability(env, capability); if (!job) return json({ error: 'not_found' }, 404); if (job.expires_at <= Date.now()) return json({ status: 'expired' }); if (job.status === 'failed') return json({ status: 'failed' }); if (job.status === 'preparing') return json({ status: 'preparing' });
  if (job.status === 'awaiting_consent') return json({ status: 'awaiting_consent', inventoryDigest: job.inventory_digest, totalSize: job.inventory_size, objectCount: job.inventory_count, approvalUrl: `/debug/jobs/${encodeURIComponent(capability)}/consent` });
  return json({ status: job.status === 'authorized' ? 'awaiting_exchange' : job.status });
}
async function exchangeGrant(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ authorizationCode?: string; codeVerifier?: string }>(request);
  if (!body?.authorizationCode || !TOKEN_RE.test(body.authorizationCode) || !body.codeVerifier ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier)) {
    return json({ error: 'invalid_grant' }, 400);
  }
  const challenge = base64url(await crypto.subtle.digest('SHA-256', TEXT.encode(body.codeVerifier)));
  const job = await env.DB.prepare(
    `SELECT job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,status,
            inventory_digest,inventory_size,inventory_count,final_destination_json,final_destination_hash,
            expires_at,grant_expires_at
       FROM debug_export_jobs
      WHERE grant_code_hash=?1 AND pkce_challenge=?2 AND status='authorized'
        AND grant_expires_at>?3 AND expires_at>?3`,
  ).bind(await tokenHash(body.authorizationCode), challenge, Date.now()).first<JobRow>();
  if (!job || !job.inventory_digest || !job.final_destination_json) {
    return json({ error: 'invalid_grant' }, 400);
  }
  const capability = randomToken();
  const consumed = await env.DB.prepare(
    `UPDATE debug_export_jobs
        SET grant_code_hash=NULL,status='encrypting',exchange_capability_hash=?2,exchanged_at=?3
      WHERE job_id=?1 AND status='authorized' AND grant_code_hash IS NOT NULL
      RETURNING job_id`,
  ).bind(job.job_id, await tokenHash(capability), Date.now()).first<{ job_id: string }>();
  if (!consumed) return json({ error: 'invalid_grant' }, 400);
  try {
    const manifest = await encryptSnapshot(job, capability, env);
    await env.DB.prepare(
      "UPDATE debug_export_jobs SET status='exchanged',expires_at=?2 WHERE job_id=?1",
    ).bind(job.job_id, manifest.expiresAt).run();
    await audit(env, 'export.exchanged', {
      user: job.user_id,
      job: job.job_id,
      detail: { inventoryDigest: job.inventory_digest },
    });
    return json({ exchangeCapability: capability, expiresAt: manifest.expiresAt, manifest });
  } catch (error) {
    await failJob(env, job.job_id, error);
    return json({ error: 'exchange_failed' }, 500);
  }
}
async function encryptSnapshot(job: JobRow, capability: string, env: Env): Promise<ExchangeManifest> {
  const destination = parseJson<Signed<DestinationPayload>>(job.final_destination_json!)?.payload; if (!destination || !publicRsaKey(destination.encryptionPublicJwk)) throw new Error('missing destination key');
  const wrappingKey = await crypto.subtle.importKey('jwk', destination.encryptionPublicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const rows = await env.DB.prepare('SELECT object_id,kind,store,relpath,snapshot_r2_key,size,sha256,session_ids FROM debug_export_objects WHERE job_id=?1 ORDER BY object_id').bind(job.job_id).all<{ object_id: string; kind: 'source'|'externalAsset'; store: string; relpath: string; snapshot_r2_key: string; size: number; sha256: string; session_ids: string }>();
  const objects: ManifestObject[] = [];
  const expiresAt = Math.min(Date.now() + EXCHANGE_TTL_MS, job.expires_at, destination.exp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('destination attestation expired');
  for (const row of rows.results) {
    const source = await env.RAW.get(row.snapshot_r2_key); if (!source) throw new Error('snapshot object missing'); const plaintext = await source.arrayBuffer(); if (await sha256(plaintext) !== row.sha256) throw new Error('snapshot object changed');
    const aes = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt'],
    ) as CryptoKey;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = canonicalDebugJson({
      format: 1,
      jobId: job.job_id,
      objectId: row.object_id,
      inventoryDigest: job.inventory_digest,
      sha256: row.sha256,
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: TEXT.encode(aad), tagLength: 128 }, aes, plaintext,
    );
    const rawKey = await crypto.subtle.exportKey('raw', aes) as ArrayBuffer;
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, rawKey);
    const encryptedKey = `debug-export/ciphertext/${job.job_id}/${row.object_id}`; const ciphertextHash = await sha256(ciphertext); await env.RAW.put(encryptedKey, ciphertext, { sha256: ciphertextHash });
    await env.DB.prepare('UPDATE debug_export_objects SET encrypted_r2_key=?3,wrapped_key=?4,nonce=?5,ciphertext_sha256=?6,ciphertext_size=?7 WHERE job_id=?1 AND object_id=?2').bind(job.job_id, row.object_id, encryptedKey, base64url(wrapped), base64url(nonce), ciphertextHash, ciphertext.byteLength).run();
    await env.RAW.delete(row.snapshot_r2_key);
    objects.push({ objectId: row.object_id, kind: row.kind, store: row.store, relpath: row.relpath, size: row.size, sha256: row.sha256, sessionIds: parseJson<string[]>(row.session_ids) ?? [], ciphertextSize: ciphertext.byteLength, ciphertextSha256: ciphertextHash, wrappedKey: base64url(wrapped), nonce: base64url(nonce), aad, url: `/api/v1/debug/exchanges/${encodeURIComponent(capability)}/objects/${encodeURIComponent(row.object_id)}` });
  }
  const manifest: ExchangeManifest = { format: 1, sessionIds: parseJson<string[]>(job.selected_session_ids) ?? [], inventoryDigest: job.inventory_digest!, totalSize: job.inventory_size!, objectCount: objects.length, expiresAt, objects }; manifest.signature = await signManifest(manifest, env); return manifest;
}
async function signManifest(manifest: ExchangeManifest, env: Env): Promise<{ alg: 'ES256'; value: string }> {
  const jwk = parseJson<JsonWebKey>(env.DEBUG_EXPORT_MANIFEST_SIGNING_PRIVATE_JWK ?? null); if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('manifest signer unavailable');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, TEXT.encode(canonicalDebugJson(manifest))); return { alg: 'ES256', value: base64url(signature) };
}
async function downloadCiphertext(env: Env, capability: string, objectId: string): Promise<Response> {
  if (!TOKEN_RE.test(capability) || !ID_RE.test(objectId)) return json({ error: 'not_found' }, 404);
  const row = await env.DB.prepare('SELECT o.encrypted_r2_key,o.ciphertext_sha256,j.job_id,j.expires_at,j.status FROM debug_export_objects o JOIN debug_export_jobs j ON j.job_id=o.job_id WHERE j.exchange_capability_hash=?1 AND o.object_id=?2').bind(await tokenHash(capability), objectId).first<{ encrypted_r2_key: string|null; ciphertext_sha256: string|null; job_id: string; expires_at: number; status: string }>();
  if (!row || row.status !== 'exchanged' || row.expires_at <= Date.now() || !row.encrypted_r2_key) return json({ error: 'not_found' }, 404); const object = await env.RAW.get(row.encrypted_r2_key); if (!object) return json({ error: 'not_found' }, 404); const bytes = await object.arrayBuffer(); if (row.ciphertext_sha256 && await sha256(bytes) !== row.ciphertext_sha256) return json({ error: 'not_found' }, 404);
  await env.DB.prepare('UPDATE debug_export_objects SET downloaded_at=?3 WHERE job_id=?1 AND object_id=?2 AND downloaded_at IS NULL').bind(row.job_id, objectId, Date.now()).run(); return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-ciphertext-sha256': row.ciphertext_sha256 ?? '' } });
}

export async function consumeDebugExchangeMessage(message: DebugExchangeMessage, env: Env): Promise<void> { if (message.debug === 'export-snapshot') return buildSnapshot(message.job_id, env); return processImport(message.job_id, env); }
async function buildSnapshot(jobId: string, env: Env): Promise<void> {
  const job = await env.DB.prepare('SELECT job_id,user_id,selected_session_ids,destination_json,destination_hash,pkce_challenge,status,inventory_digest,inventory_size,inventory_count,final_destination_json,final_destination_hash,expires_at,grant_expires_at FROM debug_export_jobs WHERE job_id=?1').bind(jobId).first<JobRow>(); if (!job || job.status !== 'preparing' || job.expires_at <= Date.now()) return;
  try {
    const selected = parseJson<string[]>(job.selected_session_ids) ?? [];
    const objects = await collectSnapshotObjects(selected, env);
    if (objects.length < 1 || objects.length > MAX_OBJECTS) throw new Error('object quota exceeded');
    const total = objects.reduce((sum, object) => sum + object.bytes.byteLength, 0);
    if (total > MAX_TOTAL_BYTES || objects.some((object) => object.bytes.byteLength > MAX_OBJECT_BYTES)) {
      throw new Error('byte quota exceeded');
    }
    const attestedDestination = parseJson<Signed<DestinationPayload>>(job.destination_json)?.payload;
    if (attestedDestination?.kind === 'remote' && total > (attestedDestination.maxBytes ?? 0)) {
      throw new Error('destination byte ceiling exceeded');
    }
    const inventory = objects.map((object) => ({ objectId: object.objectId, kind: object.kind, store: object.store, relpath: object.relpath, size: object.bytes.byteLength, sha256: object.sha256, sessionIds: object.sessionIds })); const inventoryDigest = await sha256(canonicalDebugJson({ format: 1, sessionIds: selected, objects: inventory }));
    for (const object of objects) { const key = `debug-export/snapshots/${jobId}/${object.objectId}`; await env.RAW.put(key, object.bytes, { sha256: object.sha256 }); await env.DB.prepare('INSERT INTO debug_export_objects (job_id,object_id,kind,store,relpath,snapshot_r2_key,size,sha256,session_ids) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)').bind(jobId, object.objectId, object.kind, object.store, object.relpath, key, object.bytes.byteLength, object.sha256, canonicalDebugJson(object.sessionIds)).run(); }
    await env.DB.prepare("UPDATE debug_export_jobs SET status='awaiting_consent',inventory_digest=?2,inventory_size=?3,inventory_count=?4 WHERE job_id=?1 AND status='preparing'").bind(jobId, inventoryDigest, total, objects.length).run(); await audit(env, 'snapshot.created', { user: job.user_id, job: jobId, detail: { inventoryDigest, totalSize: total, objectCount: objects.length } });
  } catch (error) { await failJob(env, jobId, error); }
}
async function collectSnapshotObjects(selected: string[], env: Env): Promise<SnapshotObject[]> {
  const placeholders = selected.map((_, i) => `?${i + 1}`).join(',');
  const fileRows = await env.DB.prepare(
    `SELECT DISTINCT f.id,f.machine_id,f.store,f.relpath,f.r2_key,f.size,f.content_hash,f.harness
     FROM files f
     WHERE f.id IN (
       SELECT canonical_file_id FROM sessions WHERE session_id IN (${placeholders})
       UNION
       SELECT file_id FROM blocks WHERE session_id IN (${placeholders})
     )
     ORDER BY f.id`,
  ).bind(...selected).all<{
    id: number;
    machine_id: string;
    store: string;
    relpath: string;
    r2_key: string;
    size: number;
    content_hash: string;
    harness: string | null;
  }>();
  const objects: SnapshotObject[] = []; const assetKeys = new Set<string>();
  for (const file of fileRows.results) {
    const linked = await env.DB.prepare('SELECT DISTINCT session_id FROM blocks WHERE file_id=?1 ORDER BY session_id')
      .bind(file.id).all<{ session_id: string }>();
    const linkedIds = linked.results.map((row) => row.session_id);
    const approvedForFile = linkedIds.filter((id) => selected.includes(id));
    if (approvedForFile.length === 0) continue;
    const raw = await env.RAW.get(file.r2_key);
    if (!raw) throw new Error('source object missing');
    const bytes = new Uint8Array(await raw.arrayBuffer());
    const sharedWithUnselected = linkedIds.some((id) => !selected.includes(id));
    for (const sessionId of approvedForFile) {
      const isolated = await isolateAndValidate(file, bytes, sessionId, sharedWithUnselected);
      const objectId = await sha256(`source\0${file.id}\0${sessionId}\0${isolated.store}\0${isolated.relpath}\0${isolated.sha256}`);
      objects.push({
        objectId,
        kind: 'source',
        store: isolated.store,
        relpath: isolated.relpath,
        bytes: isolated.bytes,
        sha256: isolated.sha256,
        sessionIds: [sessionId],
      });
      for (const asset of externalAssets(isolated.session)) { const suffix = assetRelSuffix(file.relpath, asset.digest, asset.fileName); const assetRow = await env.DB.prepare('SELECT store,relpath,r2_key,content_hash,size FROM files WHERE machine_id=?1 AND store=?2 AND relpath=?3').bind(file.machine_id, file.store, suffix).first<{store:string;relpath:string;r2_key:string;content_hash:string;size:number}>(); const key = assetRow?.r2_key ?? assetRelSuffix(file.r2_key, asset.digest, asset.fileName); if (assetKeys.has(key)) continue; const object = await env.RAW.get(key); if (!object) throw new Error('externalAsset closure incomplete'); const assetBytes = new Uint8Array(await object.arrayBuffer()); const digest = await sha256(assetBytes); if (assetRow && digest !== assetRow.content_hash) throw new Error('externalAsset hash mismatch'); const targetRelpath = assetRelSuffix(isolated.relpath, asset.digest, asset.fileName); const assetId = await sha256(`externalAsset\0${targetRelpath}\0${digest}`); objects.push({ objectId: assetId, kind: 'externalAsset', store: isolated.store, relpath: targetRelpath, bytes: assetBytes, sha256: digest, sessionIds: [sessionId] }); assetKeys.add(key); }
    }
  }
  const covered = new Set(objects.flatMap((object) => object.kind === 'source' ? object.sessionIds : [])); if (selected.some((id) => !covered.has(id))) throw new Error('selected session cannot be isolated'); objects.sort((a, b) => a.objectId.localeCompare(b.objectId)); return objects;
}
async function isolateAndValidate(
  file: { store: string; relpath: string; harness: string | null },
  bytes: Uint8Array,
  sessionId: string,
  sharedWithUnselected: boolean,
): Promise<{ store: string; relpath: string; bytes: Uint8Array; sha256: string; session: NormalizedSession }> {
  let store = file.store;
  let relpath = file.relpath;
  let harness = file.harness;
  let text: string;
  if (store === 'export-inbox') {
    const extracted = extractConversationById(bytes, sessionId);
    if (!extracted) throw new Error('shared archive isolation failed');
    const conversation = JSON.parse(extracted) as Record<string, unknown>;
    harness = conversation.mapping && typeof conversation.mapping === 'object' ? 'chatgpt-web'
      : Array.isArray(conversation.chat_messages) ? 'claude-web' : null;
    if (!harness) throw new Error('unsupported archive conversation');
    text = JSON.stringify(sanitizeDebugObject(conversation));
    store = harness;
    relpath = `${safeRelComponent(sessionId)}.json`;
  } else if (harness === 'chatgpt-web' || harness === 'claude-web') {
    text = JSON.stringify(sanitizeDebugObject(JSON.parse(new TextDecoder().decode(bytes))));
    store = harness;
    relpath = `${safeRelComponent(sessionId)}.json`;
  } else {
    const input = new TextDecoder().decode(bytes).split(/\r?\n/).filter(Boolean);
    const output: string[] = [];
    for (const line of input) {
      const value = JSON.parse(line) as Record<string, unknown>;
      const declared = typeof value.sessionId === 'string' ? value.sessionId
        : typeof value.session_id === 'string' ? value.session_id
        : typeof value.conversation_id === 'string' ? value.conversation_id : null;
      if (declared && declared !== sessionId) continue;
      if (sharedWithUnselected && !declared) {
        throw new Error('lossless shared transcript isolation unavailable');
      }
      output.push(JSON.stringify(sanitizeDebugObject(value)));
    }
    if (output.length === 0) throw new Error('empty isolated transcript');
    text = `${output.join('\n')}\n`;
  }
  const cleanBytes = TEXT.encode(text);
  const fake = { body: new Response(cleanBytes).body!, text: async () => text } as unknown as R2ObjectBody;
  if (!harness || harness === 'unknown') throw new Error('unsupported source harness');
  const session = await parseObject(harness as Parameters<typeof parseObject>[0], sessionId, fake);
  if (session.id !== sessionId) throw new Error('parser round-trip changed selected session');
  if (JSON.stringify(session).match(FORBIDDEN_KEY)) throw new Error('forbidden normalized state');
  return { store, relpath, bytes: cleanBytes, sha256: await sha256(cleanBytes), session };
}
export function sanitizeDebugObject(value: unknown): unknown {
  return sanitizeDebugValue(value, '');
}
function sanitizeDebugValue(value: unknown, parentKey: string): unknown {
  if (Array.isArray(value)) return value.map((child) => sanitizeDebugValue(child, parentKey));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (parentKey === 'source' && key === 'value' && typeof child === 'string') {
      output[key] = child.replaceAll('\\', '/').split('/').pop() ?? 'asset';
      continue;
    }
    output[key] = sanitizeDebugValue(child, key);
  }
  return output;
}
function safeRelComponent(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200); }
function externalAssets(session: NormalizedSession): ExternalAssetRef[] { const unique = new Map<string, ExternalAssetRef>(); for (const turn of session.turns) for (const block of turn.blocks) if (block.externalAsset) unique.set(`${block.externalAsset.digest}/${block.externalAsset.fileName}`, block.externalAsset); return [...unique.values()]; }
async function failJob(env: Env, jobId: string, error: unknown): Promise<void> { const reason = error instanceof Error ? error.message.slice(0, 300) : 'failed'; await env.DB.prepare("UPDATE debug_export_jobs SET status='failed',error=?2 WHERE job_id=?1").bind(jobId, reason).run(); await audit(env, 'export.failed', { job: jobId, detail: { reason } }); }

async function verifyImportAssertion(signed: Signed, env: Env): Promise<Record<string, unknown> | null> {
  const key = parseJson<JsonWebKey>(env.DEBUG_IMPORT_ASSERTION_PUBLIC_JWK ?? null);
  const payload = signed?.payload;
  if (!key || !payload || !(await verifySigned(signed, key))) return null;
  const now = Date.now();
  const destination = payload.destination as Record<string, unknown> | null;
  if (payload.scope !== 'session-debug-import' || payload.format !== 1 ||
      typeof payload.jti !== 'string' || !TOKEN_RE.test(payload.jti) ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      (payload.exp as number) <= now || (payload.iat as number) > now + 30_000 ||
      (payload.exp as number) - (payload.iat as number) > IMPORT_TTL_MS ||
      !destination || typeof destination !== 'object') return null;
  if (env.ENVIRONMENT !== 'development' && (!env.ENVIRONMENT_NONCE || !env.ARTIFACT_DIGEST)) return null;
  if ((env.ENVIRONMENT_NONCE && destination.environmentNonce !== env.ENVIRONMENT_NONCE) ||
      (env.ARTIFACT_DIGEST && destination.artifactDigest !== env.ARTIFACT_DIGEST) ||
      (env.BUILD_INPUT_DIGEST && destination.buildInputDigest !== env.BUILD_INPUT_DIGEST)) return null;
  return payload;
}
async function verifyManifest(manifest: ExchangeManifest, env: Env): Promise<boolean> { const signature = manifest.signature; const key = parseJson<JsonWebKey>(env.DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK ?? null); if (!signature || signature.alg !== 'ES256' || !key) return false; const unsigned = { ...manifest }; delete unsigned.signature; return verifySigned({ payload: unsigned, signature: signature.value }, key); }
async function createImport(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ assertion?: Signed; manifest?: ExchangeManifest }>(request);
  if (!body?.assertion || !body.manifest || !(await verifyManifest(body.manifest, env))) {
    return json({ error: 'invalid_assertion' }, 403);
  }
  const payload = await verifyImportAssertion(body.assertion, env);
  if (!payload) return json({ error: 'invalid_assertion' }, 403);
  const sessionIds = cleanIds(body.manifest.sessionIds);
  const objectIds = new Set(body.manifest.objects.map((object) => object.objectId));
  if (!sessionIds || !DIGEST_RE.test(body.manifest.inventoryDigest) ||
      payload.inventoryDigest !== body.manifest.inventoryDigest ||
      canonicalDebugJson(cleanIds(payload.sessionIds)) !== canonicalDebugJson(sessionIds) ||
      body.manifest.objectCount !== body.manifest.objects.length ||
      body.manifest.objects.length < 1 || body.manifest.objects.length > MAX_OBJECTS ||
      objectIds.size !== body.manifest.objects.length) return json({ error: 'inventory_mismatch' }, 400);
  const total = body.manifest.objects.reduce((sum, object) => sum + object.size, 0);
  if (!Number.isSafeInteger(total) || total !== body.manifest.totalSize || total > MAX_TOTAL_BYTES ||
      body.manifest.objects.some((object) =>
        !Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_OBJECT_BYTES ||
        !DIGEST_RE.test(object.sha256) || !ID_RE.test(object.objectId) ||
        (object.kind !== 'source' && object.kind !== 'externalAsset') ||
        !SAFE_STORE.has(object.store) || !safeRelativePath(object.relpath) ||
        cleanIds(object.sessionIds) === null)) return json({ error: 'invalid_manifest' }, 400);
  const inventory = body.manifest.objects.map((object) => ({
    objectId: object.objectId,
    kind: object.kind,
    store: object.store,
    relpath: object.relpath,
    size: object.size,
    sha256: object.sha256,
    sessionIds: object.sessionIds,
  }));
  const computedInventory = await sha256(canonicalDebugJson({ format: 1, sessionIds, objects: inventory }));
  if (computedInventory !== body.manifest.inventoryDigest) return json({ error: 'inventory_mismatch' }, 400);
  if (!(await consumeReplay(env, payload.jti as string, 'import-assertion', payload.exp as number))) {
    return json({ error: 'invalid_assertion' }, 403);
  }
  const jobId = crypto.randomUUID();
  const capability = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO debug_import_jobs
     (job_id,capability_hash,assertion_jti,destination_json,selected_session_ids,inventory_digest,
      status,object_count,total_size,created_at,expires_at)
     VALUES (?1,?2,?3,?4,?5,?6,'uploading',?7,?8,?9,?10)`,
  ).bind(jobId, await tokenHash(capability), payload.jti, canonicalDebugJson(payload.destination ?? {}),
    canonicalDebugJson(sessionIds), body.manifest.inventoryDigest, body.manifest.objects.length, total,
    now, Math.min(payload.exp as number, now + IMPORT_TTL_MS)).run();
  for (let ordinal = 0; ordinal < body.manifest.objects.length; ordinal++) {
    const object = body.manifest.objects[ordinal]!;
    await env.DB.prepare(
      `INSERT INTO debug_import_objects
       (job_id,ordinal,object_id,kind,store,relpath,staging_r2_key,size,sha256,expected_session_ids)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(jobId, ordinal, object.objectId, object.kind, object.store, object.relpath,
      `debug-import/staging/${jobId}/${object.objectId}`, object.size, object.sha256,
      canonicalDebugJson(object.sessionIds)).run();
  }
  await audit(env, 'import.created', { job: jobId, detail: {
    inventoryDigest: body.manifest.inventoryDigest, objectCount: body.manifest.objects.length,
  } });
  return json({
    importCapability: capability,
    requiredObjectIds: body.manifest.objects.map((object) => object.objectId),
    expiresAt: Math.min(payload.exp as number, now + IMPORT_TTL_MS),
  }, 201);
}
function safeRelativePath(value: string): boolean { return value.length > 0 && value.length <= 1024 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'); }
async function importJobByCap(env: Env, capability: string): Promise<{job_id:string;status:string;expires_at:number;checkpoint:number;object_count:number}|null> { if (!TOKEN_RE.test(capability)) return null; return env.DB.prepare('SELECT job_id,status,expires_at,checkpoint,object_count FROM debug_import_jobs WHERE capability_hash=?1').bind(await tokenHash(capability)).first(); }
async function uploadImportObject(request: Request, env: Env, capability: string, objectId: string): Promise<Response> {
  const job = await importJobByCap(env, capability); if (!job || job.status !== 'uploading' || job.expires_at <= Date.now()) return json({ error: 'not_found' }, 404); const object = await env.DB.prepare('SELECT staging_r2_key,size,sha256 FROM debug_import_objects WHERE job_id=?1 AND object_id=?2').bind(job.job_id, objectId).first<{ staging_r2_key:string;size:number;sha256:string }>(); const declared = request.headers.get('x-content-hash')?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase(); if (!object || declared !== object.sha256) return json({ error: 'object_mismatch' }, 400); const bytes = await request.arrayBuffer(); if (bytes.byteLength !== object.size || await sha256(bytes) !== object.sha256) return json({ error: 'object_mismatch' }, 400); await env.RAW.put(object.staging_r2_key, bytes, { sha256: object.sha256 }); await audit(env, 'import.object_staged', { job: job.job_id, detail: { objectId, size: object.size } }); return json({ stored: true }, 201);
}
async function commitImport(env: Env, capability: string): Promise<Response> {
  const job = await importJobByCap(env, capability); if (!job || job.status !== 'uploading' || job.expires_at <= Date.now()) return json({ error: 'not_found' }, 404); const objects = await env.DB.prepare('SELECT staging_r2_key,size,sha256 FROM debug_import_objects WHERE job_id=?1').bind(job.job_id).all<{staging_r2_key:string;size:number;sha256:string}>(); for (const object of objects.results) { const head = await env.RAW.head(object.staging_r2_key); if (!head || head.size !== object.size) return json({ error: 'objects_missing' }, 409); }
  const queued = await env.DB.prepare("UPDATE debug_import_jobs SET status='queued' WHERE job_id=?1 AND status='uploading' RETURNING job_id").bind(job.job_id).first<{job_id:string}>(); if (!queued) return json({ error: 'not_found' }, 404); await env.PARSE_QUEUE.send({ debug: 'import-promote', job_id: job.job_id }); await audit(env, 'import.queued', { job: job.job_id }); return json({ status: 'queued' }, 202);
}
async function processImport(jobId: string, env: Env): Promise<void> {
  const job = await env.DB.prepare('SELECT selected_session_ids,status,expires_at FROM debug_import_jobs WHERE job_id=?1').bind(jobId).first<{selected_session_ids:string;status:string;expires_at:number}>(); if (!job || job.status !== 'queued' || job.expires_at <= Date.now()) return; await env.DB.prepare("UPDATE debug_import_jobs SET status='validating' WHERE job_id=?1 AND status='queued'").bind(jobId).run();
  try { const allowlist = parseJson<string[]>(job.selected_session_ids) ?? []; const rows = await env.DB.prepare('SELECT ordinal,object_id,kind,store,relpath,staging_r2_key,size,sha256,expected_session_ids FROM debug_import_objects WHERE job_id=?1 ORDER BY ordinal').bind(jobId).all<{ordinal:number;object_id:string;kind:'source'|'externalAsset';store:string;relpath:string;staging_r2_key:string;size:number;sha256:string;expected_session_ids:string}>(); const parsedIds = new Set<string>();
    for (const row of rows.results) { const object = await env.RAW.get(row.staging_r2_key); if (!object) throw new Error('staged object missing'); const bytes = new Uint8Array(await object.arrayBuffer()); if (await sha256(bytes) !== row.sha256) throw new Error('staged object hash mismatch'); if (row.kind === 'source') { const expected = parseJson<string[]>(row.expected_session_ids) ?? []; if (expected.length !== 1 || !allowlist.includes(expected[0]!)) throw new Error('source allowlist mismatch'); const harness = row.store === 'chatgpt-web' ? 'chatgpt-web' : row.store === 'claude-web' ? 'claude-web' : row.store.startsWith('codex') ? 'codex' : row.store === 'omp' ? 'omp' : 'claude-code'; const text = new TextDecoder().decode(bytes); const fake = { body: new Response(bytes).body!, text: async () => text } as unknown as R2ObjectBody; const parsed = await parseObject(harness, expected[0]!, fake); if (parsed.id !== expected[0] || JSON.stringify(parsed).match(FORBIDDEN_KEY)) throw new Error('parser allowlist mismatch'); parsedIds.add(parsed.id); } await env.DB.prepare('UPDATE debug_import_jobs SET checkpoint=?2 WHERE job_id=?1').bind(jobId, row.ordinal + 1).run(); }
    if (canonicalDebugJson([...parsedIds].sort()) !== canonicalDebugJson(allowlist)) {
      throw new Error('exact session allowlist mismatch');
    }
    const collisions = await env.DB.prepare(
      `SELECT COUNT(*) n FROM sessions WHERE session_id IN (${allowlist.map((_, index) => `?${index + 1}`).join(',')})`,
    ).bind(...allowlist).first<{ n: number }>();
    if ((collisions?.n ?? 0) !== 0) throw new Error('destination session id collision');
    await env.DB.prepare("UPDATE debug_import_jobs SET status='promoting',checkpoint=0 WHERE job_id=?1")
      .bind(jobId).run();
    const machineId = `debug-import-${jobId}`;
    await env.DB.prepare("INSERT INTO machines (machine_id,os,hostname,key_protection,is_admin,priority) VALUES (?1,'synthetic','debug-session-import','synthetic',0,1000) ON CONFLICT DO NOTHING").bind(machineId).run();
    for (const row of rows.results) {
      const object = await env.RAW.get(row.staging_r2_key);
      if (!object) throw new Error('staged object missing during promotion');
      const bytes = await object.arrayBuffer();
      const targetKey = `raw/${machineId}/${row.store}/${row.relpath}`;
      await env.RAW.put(targetKey, bytes, { sha256: row.sha256 });
      const response = await recordUploadedObject(env, {
        machineId,
        store: row.store,
        relpath: row.relpath,
        r2Key: targetKey,
        size: row.size,
        mtime: null,
        sha256: row.sha256,
        existed: false,
        convergeBody: bytes,
      });
      if (!response.ok) throw new Error('normal ingest staging failed');
      const payload = await response.json() as { file_id?: number };
      await env.DB.prepare('UPDATE debug_import_objects SET promoted_file_id=?3 WHERE job_id=?1 AND ordinal=?2')
        .bind(jobId, row.ordinal, payload.file_id ?? null).run();
      await env.RAW.delete(row.staging_r2_key);
      await env.DB.prepare('UPDATE debug_import_jobs SET checkpoint=?2 WHERE job_id=?1')
        .bind(jobId, row.ordinal + 1).run();
    }
    await audit(env, 'import.promoted', { job: jobId, detail: { sessionCount: allowlist.length } });
  } catch (error) { const reason = error instanceof Error ? error.message.slice(0, 300) : 'failed'; await env.DB.prepare("UPDATE debug_import_jobs SET status='failed',error=?2 WHERE job_id=?1").bind(jobId, reason).run(); await audit(env, 'import.failed', { job: jobId, detail: { reason } }); }
}
async function pollImport(env: Env, capability: string): Promise<Response> {
  const job = await importJobByCap(env, capability); if (!job) return json({ error: 'not_found' }, 404); if (job.expires_at <= Date.now()) return json({ status: 'expired', checkpoint: job.checkpoint, objectCount: job.object_count }); if (job.status === 'promoting') await refreshImportCompletion(env, job.job_id); const current = await env.DB.prepare('SELECT status,checkpoint,object_count FROM debug_import_jobs WHERE job_id=?1').bind(job.job_id).first<{status:string;checkpoint:number;object_count:number}>(); return json({ status: current?.status ?? 'failed', checkpoint: current?.checkpoint ?? job.checkpoint, objectCount: current?.object_count ?? job.object_count });
}
async function refreshImportCompletion(env: Env, jobId: string): Promise<void> {
  const state = await env.DB.prepare(
    `SELECT SUM(CASE WHEN f.parse_state='parsed' THEN 1 ELSE 0 END) parsed,
            SUM(CASE WHEN f.parse_state='error' THEN 1 ELSE 0 END) errors,
            COUNT(*) total
       FROM debug_import_objects i LEFT JOIN files f ON f.id=i.promoted_file_id
      WHERE i.job_id=?1 AND i.kind='source'`,
  ).bind(jobId).first<{ parsed: number; errors: number; total: number }>();
  if ((state?.errors ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE debug_import_jobs SET status='failed',error='normal parser rejected promoted object' WHERE job_id=?1 AND status='promoting'",
    ).bind(jobId).run();
    await audit(env, 'import.failed', { job: jobId, detail: { reason: 'normal parser rejected promoted object' } });
    return;
  }
  if ((state?.total ?? 0) === 0 || state!.parsed !== state!.total) return;
  const job = await env.DB.prepare('SELECT selected_session_ids FROM debug_import_jobs WHERE job_id=?1')
    .bind(jobId).first<{ selected_session_ids: string }>();
  const allowlist = parseJson<string[]>(job?.selected_session_ids ?? null) ?? [];
  const placeholders = allowlist.map((_, index) => `?${index + 1}`).join(',');
  const ready = await env.DB.prepare(
    `SELECT COUNT(*) n FROM sessions WHERE index_state='ready' AND session_id IN (${placeholders})`,
  ).bind(...allowlist).first<{ n: number }>();
  if (ready?.n !== allowlist.length) return;
  await env.DB.prepare(
    "UPDATE debug_import_jobs SET status='complete',completed_at=?2 WHERE job_id=?1 AND status='promoting'",
  ).bind(jobId, Date.now()).run();
  await audit(env, 'import.completed', { job: jobId });
}
export async function expireDebugState(env: Env, limit = 100): Promise<void> {
  const now = Date.now(); await env.DB.prepare('DELETE FROM debug_export_passkey_challenges WHERE expires_at<=?1').bind(now).run(); await env.DB.prepare('DELETE FROM debug_export_replays WHERE expires_at<=?1').bind(now).run(); const exports = await env.DB.prepare('SELECT job_id FROM debug_export_jobs WHERE expires_at<=?1 AND deleted_at IS NULL LIMIT ?2').bind(now, limit).all<{job_id:string}>();
  for (const job of exports.results) { const objects = await env.DB.prepare('SELECT snapshot_r2_key,encrypted_r2_key FROM debug_export_objects WHERE job_id=?1').bind(job.job_id).all<{snapshot_r2_key:string;encrypted_r2_key:string|null}>(); for (const object of objects.results) { await env.RAW.delete(object.snapshot_r2_key); if (object.encrypted_r2_key) await env.RAW.delete(object.encrypted_r2_key); } await env.DB.prepare("UPDATE debug_export_jobs SET status='expired',deleted_at=?2 WHERE job_id=?1 AND deleted_at IS NULL").bind(job.job_id, now).run(); await audit(env, 'export.expired_deleted', { job: job.job_id }); }
  const imports = await env.DB.prepare("SELECT job_id FROM debug_import_jobs WHERE expires_at<=?1 AND status!='expired' LIMIT ?2").bind(now, limit).all<{job_id:string}>(); for (const job of imports.results) { const objects = await env.DB.prepare('SELECT staging_r2_key FROM debug_import_objects WHERE job_id=?1').bind(job.job_id).all<{staging_r2_key:string}>(); for (const object of objects.results) await env.RAW.delete(object.staging_r2_key); await env.DB.prepare("UPDATE debug_import_jobs SET status='expired' WHERE job_id=?1").bind(job.job_id).run(); await audit(env, 'import.expired_deleted', { job: job.job_id }); }
}
