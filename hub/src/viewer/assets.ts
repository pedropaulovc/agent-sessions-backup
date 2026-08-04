/** Signed same-origin links for externally captured raster assets. */

import { objectSha256 } from '../api/ops';
import { assetRelSuffix, safeAssetFilename, type ExternalAssetRef } from '../ingest/normalize';

export const ASSET_LINK_TTL_SECONDS = 15 * 60;
const DEV_ASSET_SECRET = 'agent-sessions-backup-development-asset-secret';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const FILENAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

interface CandidateFile {
  r2_key: string;
  machine_id: string;
  store: string;
  relpath: string;
}

interface AssetFile {
  r2_key: string;
  content_hash: string;
}

const MAX_ASSET_CANDIDATES = 32;
const HMAC_KEY_CACHE = new Map<string, Promise<CryptoKey>>();
const TEXT_ENCODER = new TextEncoder();

function signingSecret(env: Env): string | undefined {
  if (env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'preview') {
    return env.ASSET_SIGNING_SECRET || undefined;
  }
  if (env.ENVIRONMENT === 'development') return env.ASSET_SIGNING_SECRET || DEV_ASSET_SECRET;
  return undefined;
}

function messageFor(sessionId: string, digest: string, fileName: string, exp: number): Uint8Array {
  const fields = ['asset', sessionId, digest, fileName, String(exp)].map((value) => TEXT_ENCODER.encode(value));
  const framedLength = fields.reduce((total, field) => total + 4 + field.length, 0);
  const message = new Uint8Array(framedLength);
  const view = new DataView(message.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length);
    offset += 4;
    message.set(field, offset);
    offset += field.length;
  }
  return message;
}

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = HMAC_KEY_CACHE.get(secret);
  const pending = crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  ).catch((error) => {
    HMAC_KEY_CACHE.delete(secret);
    throw error;
  });
  HMAC_KEY_CACHE.set(secret, pending);
  return pending;
}

async function signature(sessionId: string, digest: string, fileName: string, exp: number, env: Env): Promise<string | undefined> {
  const secret = signingSecret(env);
  if (!secret) return undefined;
  let key: CryptoKey;
  try {
    key = await hmacKey(secret);
  } catch {
    return undefined;
  }
  const signed = await crypto.subtle.sign('HMAC', key, messageFor(sessionId, digest, fileName, exp));
  return bytesToBase64Url(signed);
}

async function verifySignature(
  sessionId: string,
  digest: string,
  fileName: string,
  exp: number,
  supplied: Uint8Array,
  env: Env,
): Promise<boolean> {
  const secret = signingSecret(env);
  if (!secret) return false;
  let key: CryptoKey;
  try {
    key = await hmacKey(secret);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, supplied, messageFor(sessionId, digest, fileName, exp));
}

/** Sign a viewer URL for an external asset. The source path is never included. */
export async function signExternalAssetUrl(
  sessionId: string,
  asset: ExternalAssetRef,
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<string | undefined> {
  if (!DIGEST_RE.test(asset.digest) || !FILENAME_RE.test(asset.fileName)) return undefined;
  const exp = now + ASSET_LINK_TTL_SECONDS;
  const sig = await signature(sessionId, asset.digest, asset.fileName, exp, env);
  if (!sig) return undefined;
  return `/s/${encodeURIComponent(sessionId)}/asset/${asset.digest}/${encodeURIComponent(asset.fileName)}?exp=${exp}&sig=${sig}`;
}

export async function assetEndpoint(sessionId: string, digest: string, fileName: string, url: URL, env: Env): Promise<Response> {
  if (!DIGEST_RE.test(digest) || !FILENAME_RE.test(fileName) || fileName !== safeAssetFilename(fileName)) return forbidden();
  const expRaw = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const now = Math.floor(Date.now() / 1000);
  const exp = expRaw && /^\d+$/.test(expRaw) ? Number(expRaw) : NaN;
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + ASSET_LINK_TTL_SECONDS || !sig) return forbidden();
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const mediaType = MIME_BY_EXTENSION[extension];
  if (!mediaType) return forbidden();
  const supplied = base64UrlToBytes(sig);
  if (!supplied || !(await verifySignature(sessionId, digest, fileName, exp, supplied, env))) return forbidden();

  const candidates = await env.DB.prepare(
    `SELECT f.r2_key, f.machine_id, f.store, f.relpath
     FROM files f
     WHERE f.id = (SELECT canonical_file_id FROM sessions WHERE session_id = ?1)
        OR f.session_id = ?1
     ORDER BY CASE WHEN f.id = (SELECT canonical_file_id FROM sessions WHERE session_id = ?1)
                   THEN 0 ELSE 1 END, f.id
     LIMIT ${MAX_ASSET_CANDIDATES}`,
  ).bind(sessionId).all<CandidateFile>();
  for (const candidate of candidates.results) {
    // Renderer blob digests identify the reference in the raw transcript. The external asset row
    // carries the SHA-256 of the source bytes the collector uploaded, which may differ when the
    // renderer transcoded the image before recording its blob digest.
    const assetRelpath = assetRelSuffix(candidate.relpath, digest, fileName);
    const asset = await env.DB.prepare(
      'SELECT r2_key, content_hash FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
    ).bind(candidate.machine_id, candidate.store, assetRelpath).first<AssetFile>();
    const object = await env.RAW.get(
      asset?.r2_key ?? assetRelSuffix(candidate.r2_key, digest, fileName),
    );
    const expectedHash = asset?.content_hash ?? digest;
    if (!object || objectSha256(object) !== expectedHash) continue;
    return new Response(object.body, {
      headers: {
        'content-type': mediaType,
        'cache-control': 'private, max-age=900',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      },
    });
  }
  return notFound();
}

function forbidden(): Response {
  return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
