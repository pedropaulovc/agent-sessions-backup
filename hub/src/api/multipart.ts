import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { markPendingAndEnqueue } from '../queue';
import { hex } from './ops';
import { TERMINAL_PARSE_STATES, recordUploadedObject, restampIfStale } from './upload';

// R2 rejects a completed multipart whose non-final parts are under 5 MiB (and all non-final parts
// must be the same size). The collector uploads fixed-size parts >= this and a possibly-smaller
// final part, so both rules hold by construction — but we ALSO reject an under-sized non-final part
// at the edge (see uploadPart) for a clear, early 400 instead of a confusing failure at complete
// time. 5 MiB = 5 * 1024 * 1024.
export const MIN_PART_SIZE = 5 * 1024 * 1024;
// R2 caps a multipart upload at 10000 parts.
export const MAX_PART_NUMBER = 10000;

function r2MtimeMetadata(mtime: string | null): Record<string, string> | undefined {
  return mtime !== null ? { mtime } : undefined;
}

/** Parse+validate the create headers (identical contract to the simple PUT). */
function parseCreateHeaders(request: Request): { sha256: string; mtime: string | null; size: number } | { error: string } {
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

/**
 * POST /api/v1/files/{machine}/{store}/{relpath}?uploads — open a multipart upload.
 *
 * Same (path,hash) short-circuit as the simple PUT: if the hub already holds these exact bytes we
 * return {status:'unchanged'} and open NO multipart, so an unchanged 100MB file never re-uploads.
 * Otherwise we createMultipartUpload in R2 and record the uploadId (plus the declared hash/mtime/size)
 * in D1 so complete can verify against it and the prune cron can abort a dangling one.
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

  const parsed = parseCreateHeaders(request);
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { sha256, mtime, size } = parsed;

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

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  let mpu: R2MultipartUpload;
  try {
    mpu = await env.RAW.createMultipartUpload(r2Key, { customMetadata: r2MtimeMetadata(mtime) });
  } catch (e) {
    return Response.json({ error: 'create_multipart_failed', detail: String(e) }, { status: 400 });
  }
  await env.DB.prepare(
    `INSERT INTO multipart_uploads (upload_id, machine_id, store, relpath, r2_key, content_hash, mtime, size)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(mpu.uploadId, machineId, store, relpath, r2Key, sha256, mtime, size)
    .run();
  console.log(JSON.stringify({ event: 'access.multipart_create', machine: machineId, key: r2Key, size }));
  return Response.json({ status: 'created', upload_id: mpu.uploadId, key: r2Key, min_part_size: MIN_PART_SIZE }, { status: 201 });
}

/**
 * PUT /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id>&partNumber=<n> — stream one part to R2.
 * Header `x-part-is-last: 1` marks the final (possibly-small) part so we don't wrongly reject it for
 * being under MIN_PART_SIZE. Returns {part_number, etag}; the collector collects the etags for complete.
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
  if (!request.body) return Response.json({ error: 'missing_body' }, { status: 400 });

  // Buffer this one part (bounded by the collector's part size, default 25MiB — comfortably under
  // the 128MB isolate limit) so we can length-check it before handing it to R2.
  const body = await request.arrayBuffer();
  const isLast = request.headers.get('x-part-is-last') === '1';
  if (!isLast && body.byteLength < MIN_PART_SIZE) {
    return Response.json({ error: 'part_too_small', min_part_size: MIN_PART_SIZE, got: body.byteLength }, { status: 400 });
  }

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.RAW.resumeMultipartUpload(r2Key, uploadId).uploadPart(partNumber, body);
  } catch (e) {
    // A bad/expired uploadId or an R2 error — the collector aborts and retries from create.
    return Response.json({ error: 'upload_part_failed', detail: String(e) }, { status: 400 });
  }
  return Response.json({ part_number: uploaded.partNumber, etag: uploaded.etag });
}

/**
 * POST /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — finish the multipart upload.
 * Body: {parts:[{part_number, etag}, ...]}. After R2 assembles the object we stream it back through a
 * DigestStream and compare the whole-object sha256 to the hash the upload was OPENED with (from D1):
 * on mismatch we delete the object and return 422 so the collector retries; on match we upsert the
 * files row + enqueue the parse, identical to the simple path (recordUploadedObject).
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
  const rec = await env.DB.prepare(
    'SELECT r2_key, content_hash, mtime, store, relpath FROM multipart_uploads WHERE upload_id = ?1 AND machine_id = ?2',
  )
    .bind(uploadId, machineId)
    .first<{ r2_key: string; content_hash: string; mtime: string | null; store: string; relpath: string }>();
  // No tracking row: unknown/already-finished/pruned upload. The collector aborts + retries from create.
  if (!rec) return Response.json({ error: 'unknown_upload' }, { status: 404 });
  if (rec.store !== store || rec.relpath !== relpath) return Response.json({ error: 'path_mismatch' }, { status: 400 });

  const bodyJson = (await request.json().catch(() => null)) as { parts?: Array<{ part_number: number; etag: string }> } | null;
  const parts = bodyJson?.parts ?? [];
  if (parts.length === 0) return Response.json({ error: 'no_parts' }, { status: 400 });
  const r2Parts = parts.map((p) => ({ partNumber: p.part_number, etag: p.etag }));

  const existing = await env.DB.prepare('SELECT id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3')
    .bind(machineId, store, relpath)
    .first<{ id: number }>();

  let completed: R2Object;
  try {
    completed = await env.RAW.resumeMultipartUpload(rec.r2_key, uploadId).complete(r2Parts);
  } catch (e) {
    // Bad etags / part-size rule / R2 error. The multipart upload is still pending, so leave the
    // tracking row for the collector's abort (or the prune cron) and let the collector retry.
    return Response.json({ error: 'complete_failed', detail: String(e) }, { status: 400 });
  }

  // Whole-object verification: stream the assembled object through a DigestStream (never buffers the
  // whole 100MB+ body) and compare to the hash the upload was opened with. R2's simple PUT verifies
  // server-side via {sha256}; multipart has no equivalent, so this is the integrity gate.
  const obj = await env.RAW.get(rec.r2_key);
  if (!obj) {
    await env.DB.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?1').bind(uploadId).run();
    return Response.json({ error: 'object_missing_after_complete' }, { status: 500 });
  }
  const digestStream = new crypto.DigestStream('SHA-256');
  await obj.body.pipeTo(digestStream);
  const actual = hex(await digestStream.digest);
  if (actual !== rec.content_hash) {
    // Corrupt/mismatched assembly: delete the object and drop the tracking row (the upload is already
    // completed, so there is nothing left to abort). Collector retries from a fresh create.
    await env.RAW.delete(rec.r2_key);
    await env.DB.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?1').bind(uploadId).run();
    console.log(JSON.stringify({ event: 'access.multipart_mismatch', machine: machineId, key: rec.r2_key, expected: rec.content_hash, actual }));
    return Response.json({ error: 'checksum_mismatch', expected: rec.content_hash, actual }, { status: 422 });
  }

  await env.DB.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?1').bind(uploadId).run();
  return recordUploadedObject(env, {
    machineId,
    store,
    relpath,
    r2Key: rec.r2_key,
    size: completed.size,
    mtime: rec.mtime,
    sha256: rec.content_hash,
    existed: existing != null,
    convergeBody: null,
  });
}

/**
 * DELETE /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — abort a multipart upload.
 * Idempotent: an unknown/already-gone uploadId returns 200 (nothing to abort) so the collector's
 * retry/give-up path never has to special-case a missing upload.
 */
export async function abortMultipart(
  env: Env,
  identity: Identity,
  machineId: string,
  params: URLSearchParams,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ownsPath(identity, machineId)) return Response.json({ error: 'machine_mismatch' }, { status: 403 });

  const uploadId = params.get('uploadId')!;
  const rec = await env.DB.prepare('SELECT r2_key FROM multipart_uploads WHERE upload_id = ?1 AND machine_id = ?2')
    .bind(uploadId, machineId)
    .first<{ r2_key: string }>();
  if (!rec) return Response.json({ status: 'gone' });
  try {
    await env.RAW.resumeMultipartUpload(rec.r2_key, uploadId).abort();
  } catch (e) {
    // Already completed/aborted/expired at R2 — still drop the tracking row so it isn't re-pruned.
    console.log(JSON.stringify({ event: 'access.multipart_abort_warn', machine: machineId, key: rec.r2_key, error: String(e) }));
  }
  await env.DB.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?1').bind(uploadId).run();
  return Response.json({ status: 'aborted' });
}
