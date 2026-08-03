/** Signed same-origin links for externally captured raster assets. */

import { objectSha256 } from '../api/ops';
import { assetRelSuffix, type ExternalAssetRef } from '../ingest/normalize';

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

interface AssetFile {
  r2_key: string;
}

const MAX_ASSET_CANDIDATES = 32;

function signingSecret(env: Env): string | undefined {
  if (env.ENVIRONMENT === 'production') return env.ASSET_SIGNING_SECRET || undefined;
  if (env.ENVIRONMENT === 'preview') return env.ASSET_SIGNING_SECRET || env.DEV_AUTH || undefined;
  if (env.ENVIRONMENT === 'development') return env.ASSET_SIGNING_SECRET || DEV_ASSET_SECRET;
  return undefined;
}

function messageFor(sessionId: string, digest: string, fileName: string, exp: number): string {
  return `asset\n${sessionId}\n${digest}\n${fileName}\n${exp}`;
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

async function signature(sessionId: string, digest: string, fileName: string, exp: number, env: Env): Promise<string | undefined> {
  const secret = signingSecret(env);
  if (!secret) return undefined;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(messageFor(sessionId, digest, fileName, exp)));
  return bytesToBase64Url(signed);
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
  if (!DIGEST_RE.test(digest) || !FILENAME_RE.test(fileName) || fileName !== sanitizeFileName(fileName)) return forbidden();
  const expRaw = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const now = Math.floor(Date.now() / 1000);
  const exp = expRaw && /^\d+$/.test(expRaw) ? Number(expRaw) : NaN;
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + ASSET_LINK_TTL_SECONDS || !sig) return forbidden();
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const mediaType = MIME_BY_EXTENSION[extension];
  if (!mediaType) return forbidden();

  const candidates = await env.DB.prepare(
    `SELECT f.r2_key
     FROM files f
     WHERE f.id = (SELECT canonical_file_id FROM sessions WHERE session_id = ?1)
        OR f.session_id = ?1
     ORDER BY CASE WHEN f.id = (SELECT canonical_file_id FROM sessions WHERE session_id = ?1)
                   THEN 0 ELSE 1 END, f.id
     LIMIT ${MAX_ASSET_CANDIDATES}`,
  ).bind(sessionId).all<AssetFile>();
  if (candidates.results.length === 0) return notFound();
  const expected = await signature(sessionId, digest, fileName, exp, env);
  const supplied = base64UrlToBytes(sig);
  const secret = signingSecret(env);
  if (!expected || !supplied || !secret || !constantTimeEqual(expected, sig)) return forbidden();

  for (const candidate of candidates.results) {
    const object = await env.RAW.get(assetRelSuffix(candidate.r2_key, digest, fileName));
    if (!object || objectSha256(object) !== digest) continue;
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

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'asset';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function forbidden(): Response {
  return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
