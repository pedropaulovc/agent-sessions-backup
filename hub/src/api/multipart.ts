import type { Identity } from '../auth/identity';
import { markPendingAndEnqueue } from '../queue';
import { hex } from './ops';
import { TERMINAL_PARSE_STATES, recordUploadedObject, restampIfStale } from './upload';

// R2 multipart part rules (developers.cloudflare.com/r2/objects/multipart-objects): every part
// except the last must be >= 5 MiB AND all be the same size; <= 10000 parts. The collector uploads
// fixed-size parts and declares that size in x-part-size, so we enforce BOTH here (uniform non-final
// parts, tail <= that size) for an early clear 400 rather than a confusing failure at complete time.
// R2's own complete-time check is the backstop.
export const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
export const MAX_PART_NUMBER = 10000;

function r2MtimeMetadata(mtime: string | null): Record<string, string> | undefined {
  return mtime !== null ? { mtime } : undefined;
}

/** Parse+validate the whole-object headers (identical contract to the simple PUT): the sha256 the
 * object must hash to, its source mtime, and its declared byte size. Used by create AND complete. */
function parseObjectHeaders(request: Request): { sha256: string; mtime: string | null; size: number } | { error: string } {
  const hashHeader = request.headers.get('x-content-hash') ?? '';
  const m = hashHeader.match(/^sha256:([0-9a-f]{64})$/i);
  if (!m) return { error: 'missing_or_bad_x_content_hash' };
  const sizeHeader = request.headers.get('x-file-size');
  if (sizeHeader === null) return { error: 'missing_x_file_size' };
  const size = Number(sizeHeader);
  if (!Number.isSafeInteger(size) || size < 0) return { error: 'bad_x_file_size' };
  return { sha256: m[1]!.toLowerCase(), mtime: request.headers.get('x-file-mtime'), size };
}

function ownsPath(identity: Identity, machineId: string): boolean {
  return identity.kind === 'machine' && (identity.machineId === machineId || identity.isAdmin);
}

function r2Key(machineId: string, store: string, relpath: string): string {
  return `raw/${machineId}/${store}/${relpath}`;
}

/**
 * POST /api/v1/files/{machine}/{store}/{relpath}?uploads — open a multipart upload.
 *
 * Same (path,hash) short-circuit as the simple PUT: if the hub already holds these exact bytes we
 * return {status:'unchanged'} and open NO multipart, so an unchanged 100MB+ file never re-uploads.
 * Otherwise we createMultipartUpload in R2 and return its uploadId. No server-side tracking table is
 * needed: R2 auto-aborts an incomplete upload after 7 days, and the collector aborts on failure.
 */
export async function createMultipart(
  request: Request,
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ownsPath(identity, machineId)) return Response.json({ error: 'machine_mismatch' }, { status: 403 });

  const parsed = parseObjectHeaders(request);
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { sha256, mtime } = parsed;

  const existing = await env.DB.prepare(
    'SELECT id, content_hash, parse_state, r2_key, harness, session_id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
  )
    .bind(machineId, store, relpath)
    .first<{ id: number; content_hash: string; parse_state: string; r2_key: string; harness: string | null; session_id: string | null }>();
  if (existing && existing.content_hash === sha256) {
    // Hub already has these exact bytes. Unlike the simple PUT's same-hash branch we have no body to
    // repair R2 from (the collector hasn't sent anything yet) — but we still restamp a legacy row and
    // re-enqueue a non-terminal/restamped one so a 'skipped' or dropped-message row finally indexes.
    const restamped = await restampIfStale(existing, store, relpath, machineId, env);
    if (restamped || !TERMINAL_PARSE_STATES.has(existing.parse_state)) {
      await markPendingAndEnqueue(existing, 'upload', env);
      return Response.json({ status: 'unchanged', file_id: existing.id, requeued: true, restamped });
    }
    return Response.json({ status: 'unchanged', file_id: existing.id });
  }

  const key = r2Key(machineId, store, relpath);
  let mpu: R2MultipartUpload;
  try {
    mpu = await env.RAW.createMultipartUpload(key, { customMetadata: r2MtimeMetadata(mtime) });
  } catch (e) {
    return Response.json({ error: 'create_multipart_failed', detail: String(e) }, { status: 400 });
  }
  console.log(JSON.stringify({ event: 'access.multipart_create', machine: machineId, key, size: parsed.size }));
  return Response.json({ status: 'created', upload_id: mpu.uploadId, key, min_part_size: MIN_PART_SIZE }, { status: 201 });
}

/**
 * PUT /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id>&partNumber=<n> — stream one part to R2.
 * `x-part-size` is the fixed part size the collector chose; `x-part-is-last: 1` marks the final part.
 * Enforced server-side: every non-final part is EXACTLY x-part-size (>= 5 MiB); the final part is
 * 1..x-part-size. Returns {part_number, etag}; the collector collects the etags for complete.
 */
export async function uploadPart(
  request: Request,
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
  params: URLSearchParams,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ownsPath(identity, machineId)) return Response.json({ error: 'machine_mismatch' }, { status: 403 });

  const uploadId = params.get('uploadId')!;
  const partNumber = Number(params.get('partNumber'));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
    return Response.json({ error: 'bad_part_number' }, { status: 400 });
  }
  const declaredPartSize = Number(request.headers.get('x-part-size'));
  if (!Number.isSafeInteger(declaredPartSize) || declaredPartSize < MIN_PART_SIZE) {
    return Response.json({ error: 'bad_or_small_part_size', min_part_size: MIN_PART_SIZE }, { status: 400 });
  }
  if (!request.body) return Response.json({ error: 'missing_body' }, { status: 400 });

  // Buffer this one part (bounded by the collector's part size, default 64MiB — under the 128MB
  // isolate limit) so we can length-check it before handing it to R2.
  const body = await request.arrayBuffer();
  const len = body.byteLength;
  const isLast = request.headers.get('x-part-is-last') === '1';
  if (isLast) {
    if (len === 0 || len > declaredPartSize) return Response.json({ error: 'bad_last_part', part_size: declaredPartSize, got: len }, { status: 400 });
  } else if (len !== declaredPartSize) {
    // Uniform-size rule: R2 requires every non-final part to be the same size. Reject early.
    return Response.json({ error: 'non_uniform_part', part_size: declaredPartSize, got: len }, { status: 400 });
  }

  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.RAW.resumeMultipartUpload(r2Key(machineId, store, relpath), uploadId).uploadPart(partNumber, body);
  } catch (e) {
    // A bad/expired uploadId or an R2 error — the collector aborts and retries from create.
    return Response.json({ error: 'upload_part_failed', detail: String(e) }, { status: 400 });
  }
  return Response.json({ part_number: uploaded.partNumber, etag: uploaded.etag });
}

/**
 * POST /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — finish the multipart upload.
 * Headers carry the whole-object contract (x-content-hash / x-file-mtime / x-file-size); body is
 * {parts:[{part_number, etag}, ...]}. After R2 assembles the object we stream it back through a
 * DigestStream and compare the whole-object sha256 to x-content-hash: on mismatch we delete the
 * object and return 422 (collector retries); on match we upsert files + enqueue the parse via the
 * shared recordUploadedObject, identical to the simple path.
 */
export async function completeMultipart(
  request: Request,
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
  params: URLSearchParams,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ownsPath(identity, machineId)) return Response.json({ error: 'machine_mismatch' }, { status: 403 });

  const uploadId = params.get('uploadId')!;
  const parsed = parseObjectHeaders(request);
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { sha256, mtime } = parsed;

  const bodyJson = (await request.json().catch(() => null)) as { parts?: Array<{ part_number: number; etag: string }> } | null;
  const parts = bodyJson?.parts ?? [];
  if (parts.length === 0) return Response.json({ error: 'no_parts' }, { status: 400 });
  const r2Parts = parts.map((p) => ({ partNumber: p.part_number, etag: p.etag }));

  const key = r2Key(machineId, store, relpath);
  const existing = await env.DB.prepare('SELECT id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3')
    .bind(machineId, store, relpath)
    .first<{ id: number }>();

  let completed: R2Object;
  try {
    completed = await env.RAW.resumeMultipartUpload(key, uploadId).complete(r2Parts);
  } catch (e) {
    // Bad etags / part-size rule / unknown-or-expired uploadId / R2 error. The upload is still pending
    // (or already gone); the collector aborts + retries, and R2 auto-aborts a leftover after 7 days.
    return Response.json({ error: 'complete_failed', detail: String(e) }, { status: 400 });
  }

  // Whole-object verification: stream the assembled object through a DigestStream (never buffers the
  // whole 100MB+ body) and compare to the declared hash. R2's simple PUT verifies server-side via
  // {sha256}; multipart has no equivalent, so this is the integrity gate.
  const obj = await env.RAW.get(key);
  if (!obj) return Response.json({ error: 'object_missing_after_complete' }, { status: 500 });
  const digestStream = new crypto.DigestStream('SHA-256');
  await obj.body.pipeTo(digestStream);
  const actual = hex(await digestStream.digest);
  if (actual !== sha256) {
    // Corrupt/mismatched assembly: delete the object (the multipart is already completed, so there is
    // nothing left to abort). Collector retries from a fresh create.
    await env.RAW.delete(key);
    console.log(JSON.stringify({ event: 'access.multipart_mismatch', machine: machineId, key, expected: sha256, actual }));
    return Response.json({ error: 'checksum_mismatch', expected: sha256, actual }, { status: 422 });
  }

  return recordUploadedObject(env, {
    machineId,
    store,
    relpath,
    r2Key: key,
    size: completed.size,
    mtime,
    sha256,
    existed: existing != null,
    convergeBody: null,
  });
}

/**
 * DELETE /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — abort a multipart upload.
 * Idempotent: an unknown/already-gone uploadId still returns 200 so the collector's retry/give-up
 * path never has to special-case a missing upload. R2 also auto-aborts anything left after 7 days.
 */
export async function abortMultipart(
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
  params: URLSearchParams,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ownsPath(identity, machineId)) return Response.json({ error: 'machine_mismatch' }, { status: 403 });

  const uploadId = params.get('uploadId')!;
  try {
    await env.RAW.resumeMultipartUpload(r2Key(machineId, store, relpath), uploadId).abort();
  } catch (e) {
    // Already completed/aborted/expired at R2 — treat as success (nothing left to abort).
    console.log(JSON.stringify({ event: 'access.multipart_abort_warn', machine: machineId, upload_id: uploadId, error: String(e) }));
    return Response.json({ status: 'gone' });
  }
  return Response.json({ status: 'aborted' });
}
