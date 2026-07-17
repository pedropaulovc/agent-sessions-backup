/** GET /s/{id}/blob/{block_id} — serve a single image/document by range-reading its source line from R2. */

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
}

export async function blobEndpoint(sessionId: string, blockId: string, env: Env): Promise<Response> {
  const id = Number(blockId);
  if (!Number.isInteger(id) || id < 0) return notFound();

  const row = await env.DB.prepare(
    `SELECT b.byte_start, b.byte_len, b.block_index, b.btype, f.r2_key
     FROM blocks b JOIN files f ON f.id = b.file_id
     WHERE b.id = ?1 AND b.session_id = ?2`,
  )
    .bind(id, sessionId)
    .first<BlockRow>();
  if (!row || row.byte_start === null || row.byte_len === null) return notFound();
  if (row.btype !== 'image' && row.btype !== 'document') return notFound();

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
    'cache-control': 'private, max-age=31536000, immutable',
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

/** True when blocksFrom() would emit a block for this content item (must match claude-code.ts exactly). */
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
      return false;
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
