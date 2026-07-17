/** GET /s/{id}/blob/{block_id}?v={hash} — serve a single image/document by range-reading its source line from R2. */

import { blobVersionOf } from './session';

// Only these raster types are safe to render inline from the viewer origin. Everything else —
// documents, SVG, text/html, unknown/absent — is transcript-controlled and could execute script
// same-origin, so it is forced to a download with an inert content-type.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface BlockRow {
  byte_start: number | null;
  byte_len: number | null;
  block_index: number;
  btype: string;
  r2_key: string;
  content_hash: string;
}

export async function blobEndpoint(sessionId: string, blockId: string, url: URL, env: Env): Promise<Response> {
  const id = Number(blockId);
  if (!Number.isInteger(id) || id < 0) return notFound();

  const row = await env.DB.prepare(
    `SELECT b.byte_start, b.byte_len, b.block_index, b.btype, f.r2_key, f.content_hash
     FROM blocks b JOIN files f ON f.id = b.file_id
     WHERE b.id = ?1 AND b.session_id = ?2`,
  )
    .bind(id, sessionId)
    .first<BlockRow>();
  if (!row || row.byte_start === null || row.byte_len === null) return notFound();
  if (row.btype !== 'image' && row.btype !== 'document') return notFound();

  // block ids are reused rowids, so the URL is versioned by the canonical file's content hash. A stale/absent
  // `v` (e.g. cached HTML after a reindex) redirects to the current URL; only an exact match earns immutable.
  const currentVersion = blobVersionOf(row.content_hash);
  const suppliedV = url.searchParams.get('v');
  if (currentVersion && suppliedV !== currentVersion) {
    return Response.redirect(new URL(`${url.pathname}?v=${currentVersion}`, url).toString(), 302);
  }

  const obj = await env.RAW.get(row.r2_key, { range: { offset: row.byte_start, length: row.byte_len } });
  if (!obj) return notFound();
  const text = await obj.text();

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text.replace(/\n$/, '')) as Record<string, unknown>;
  } catch {
    return notFound();
  }

  const media = extractMediaAt(envelope, row.block_index);
  if (!media) return notFound();

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(media.data);
  } catch {
    return notFound();
  }

  const mime = media.mediaType.toLowerCase();
  const inlineSafe = row.btype === 'image' && INLINE_IMAGE_TYPES.has(mime);

  const headers: Record<string, string> = {
    // We only reach here version-matched (mismatches redirected above); an unversionable file gets no-cache.
    'cache-control': currentVersion ? 'private, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (inlineSafe) {
    headers['content-type'] = mime;
    // Belt-and-suspenders: even a raster type renders in a scriptless sandbox.
    headers['content-security-policy'] = 'sandbox';
  } else {
    headers['content-type'] = 'application/octet-stream';
    headers['content-disposition'] = `attachment; filename="blob-${id}"`;
  }

  return new Response(bytes as BufferSource, { headers });
}

/**
 * Reproduce the parser's per-line block ordering and return the base64 media source at `blockIndex`.
 * Mirrors claude-code.ts blocksFrom yield conditions so block_index lines up with the indexed row.
 */
function extractMediaAt(envelope: Record<string, unknown>, blockIndex: number): { data: string; mediaType: string } | null {
  const msg = isObj(envelope.message) ? envelope.message : undefined;
  const content = msg?.content ?? envelope.content;
  const list: unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  let out = 0;
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const yielded = yieldsBlock(raw);
    if (!yielded) continue;
    if (out === blockIndex) {
      if (raw.type !== 'image' && raw.type !== 'document') return null;
      const source = isObj(raw.source) ? raw.source : undefined;
      const data = str(source?.data);
      if (!data) return null;
      return { data, mediaType: str(source?.media_type) ?? '' };
    }
    out++;
  }
  return null;
}

/**
 * True when the parser's blocksFrom() would emit a block for this content item, so extractMediaAt counts
 * block_index the same way the indexer did. This MUST stay case-for-case identical to blocksFrom() in
 * claude-code.ts — any drift silently misaligns block_index and 404s (or mis-serves) media. Pinned mapping:
 *   text     -> yields only when str(raw.text) is non-empty
 *   thinking -> yields only when str(raw.thinking) is non-empty
 *   tool_use / tool_result / image / document -> always yield
 *   default (unknown types, e.g. server_tool_use) -> parser's default now yields a capped-JSON TEXT block,
 *     so it MUST count here too (a prior version returned false and dropped media after an unknown item).
 * (blocksFrom also `continue`s on non-object items; extractMediaAt applies that same isObj() guard.)
 * Note: the synthetic btype='compaction' block rows the indexer writes for codex marker turns are NOT
 * produced by blocksFrom and never carry media, so they don't affect this claude-content parity — and the
 * blob endpoint rejects any non-image/document btype before it reaches here.
 */
function yieldsBlock(raw: Record<string, unknown>): boolean {
  switch (raw.type) {
    case 'text':
      return !!str(raw.text);
    case 'thinking':
      return !!str(raw.thinking);
    case 'tool_use':
    case 'tool_result':
    case 'image':
    case 'document':
      return true;
    default:
      return true;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
