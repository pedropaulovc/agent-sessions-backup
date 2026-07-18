import type { Identity } from '../auth/identity';
import { markPendingAndEnqueue } from '../queue';
import { objectSha256 } from './ops';
import { TERMINAL_PARSE_STATES, recordUploadedObject, restampIfStale } from './upload';

// R2 multipart part rules (developers.cloudflare.com/r2/objects/multipart-objects): every part
// except the last must be >= 5 MiB AND all be the same size; <= 10000 parts. The collector uploads
// fixed-size parts and declares that size in x-part-size, so we enforce BOTH here (uniform non-final
// parts, tail <= that size) for an early clear 400 rather than a confusing failure at complete time.
// R2's own complete-time check is the backstop.
export const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB
export const MAX_PART_NUMBER = 10000;
// R2's single put() (used for the staging->canonical copy below) caps at 5 GiB
// (developers.cloudflare.com/r2/platform/limits). A file larger than this can't be finalized onto the
// canonical key, so we refuse it at create. The realistic corpus max is single-digit GB.
export const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

function r2MtimeMetadata(mtime: string | null): Record<string, string> | undefined {
  return mtime !== null ? { mtime } : undefined;
}

/**
 * Multipart uploads assemble onto a STAGING key, never straight onto the canonical raw key, so an
 * unverified/corrupt assembly can never overwrite the previous good backup. The staging namespace is
 * a sibling of raw/ (NOT under it) so prefix-scoped reindex — which walks raw/ — never mistakes a
 * staging object for real data.
 *
 * The key is UPLOAD-UNIQUE: it carries a per-upload nonce so two overlapping uploads for the same
 * machine/store/relpath assemble onto DISTINCT staging objects and their complete/abort cleanup
 * (each deletes its own staging object) can never touch the other upload's bytes. We don't rely on
 * the collector's overlap lock for this — the hub must be correct under concurrent callers on its
 * own, same as every other convergence guard here. The nonce is generated at create time (the R2
 * uploadId doesn't exist until createMultipartUpload returns, so it can't be part of the key it
 * creates); create round-trips it to the collector inside the opaque upload token (see uploadToken).
 * The prune sweep still lists the mpu-staging/ prefix, so the nonce suffix doesn't affect it.
 */
function stagingKey(machineId: string, store: string, relpath: string, nonce: string): string {
  return `mpu-staging/${machineId}/${store}/${relpath}.${nonce}`;
}

/**
 * The collector treats the multipart "upload id" as an opaque token it echoes back on
 * part/complete/abort. We pack two things into it: the staging-key NONCE and R2's own uploadId,
 * as `<nonce>.<r2UploadId>`. The nonce is a UUID (no '.'), so splitting on the FIRST '.' recovers it
 * regardless of what R2's uploadId contains. The collector URL-encodes the whole token, so any
 * characters in R2's uploadId are transport-safe.
 */
function uploadToken(nonce: string, r2UploadId: string): string {
  return `${nonce}.${r2UploadId}`;
}

function parseUploadToken(token: string): { nonce: string; r2UploadId: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  return { nonce: token.slice(0, dot), r2UploadId: token.slice(dot + 1) };
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
  const { sha256, mtime, size } = parsed;
  // The staging->canonical finalize is a single put(), capped at 5 GiB. Refuse a larger file up front.
  if (size > MAX_SINGLE_PUT_BYTES) {
    return Response.json({ error: 'file_too_large', max_bytes: MAX_SINGLE_PUT_BYTES, got: size }, { status: 400 });
  }

  const key = r2Key(machineId, store, relpath);
  const existing = await env.DB.prepare(
    'SELECT id, content_hash, parse_state, r2_key, harness, session_id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
  )
    .bind(machineId, store, relpath)
    .first<{ id: number; content_hash: string; parse_state: string; r2_key: string; harness: string | null; session_id: string | null }>();
  if (existing && existing.content_hash === sha256) {
    // Hub's D1 says it has these bytes — but the raw R2 object can be MISSING or CORRUPT independent
    // of the row (a bad restore, a lost object). The simple PUT repairs from the request body; we have
    // no body yet, so verify R2 first: only short-circuit when the object is actually present AND its
    // verified hash matches. Otherwise fall through to open a fresh upload so the collector re-sends
    // the parts and repairs R2 (this is what makes files/check's large-file repair path work).
    const head = await env.RAW.head(key);
    if (head && objectSha256(head) === sha256) {
      // R2 has the right bytes. Still restamp a legacy row and re-enqueue a non-terminal/restamped one
      // so a 'skipped' or dropped-message row finally indexes.
      const restamped = await restampIfStale(existing, store, relpath, machineId, env);
      if (restamped || !TERMINAL_PARSE_STATES.has(existing.parse_state)) {
        await markPendingAndEnqueue(existing, 'upload', env);
        return Response.json({ status: 'unchanged', file_id: existing.id, requeued: true, restamped });
      }
      return Response.json({ status: 'unchanged', file_id: existing.id });
    }
    // else: R2 missing/corrupt — fall through to open a fresh multipart so the collector repairs it.
  }

  // Assemble onto an upload-unique STAGING key (no metadata — staging is throwaway; the canonical put
  // sets it). The nonce makes concurrent uploads for this same path use distinct staging objects.
  const nonce = crypto.randomUUID();
  let mpu: R2MultipartUpload;
  try {
    mpu = await env.RAW.createMultipartUpload(stagingKey(machineId, store, relpath, nonce));
  } catch (e) {
    return Response.json({ error: 'create_multipart_failed', detail: String(e) }, { status: 400 });
  }
  console.log(JSON.stringify({ event: 'access.multipart_create', machine: machineId, key, size }));
  return Response.json(
    { status: 'created', upload_id: uploadToken(nonce, mpu.uploadId), key, min_part_size: MIN_PART_SIZE },
    { status: 201 },
  );
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

  const token = parseUploadToken(params.get('uploadId') ?? '');
  if (!token) return Response.json({ error: 'bad_upload_id' }, { status: 400 });
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
    const stagKey = stagingKey(machineId, store, relpath, token.nonce);
    uploaded = await env.RAW.resumeMultipartUpload(stagKey, token.r2UploadId).uploadPart(partNumber, body);
  } catch (e) {
    // A bad/expired uploadId or an R2 error — the collector aborts and retries from create.
    return Response.json({ error: 'upload_part_failed', detail: String(e) }, { status: 400 });
  }
  return Response.json({ part_number: uploaded.partNumber, etag: uploaded.etag });
}

/**
 * POST /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — finish the multipart upload.
 * Headers carry the whole-object contract (x-content-hash / x-file-mtime / x-file-size); body is
 * {parts:[{part_number, etag}, ...]}.
 *
 * The multipart assembles onto the STAGING key. We then stream-copy staging -> canonical with a single
 * put({sha256}): R2 verifies the whole-object checksum server-side during the copy (the integrity
 * gate) AND records a NATIVE checksums.sha256 on the canonical object. A mismatch makes the put throw
 * ATOMICALLY — the previous canonical object (the prior backup) is left completely intact — and we
 * return 422 for the collector to retry. Only on a verified copy do we upsert files + enqueue the
 * parse (shared recordUploadedObject), identical to the simple path. The staging object is always
 * deleted (success or failure); a crash between complete and delete leaks one, swept by the prune cron.
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

  const token = parseUploadToken(params.get('uploadId') ?? '');
  if (!token) return Response.json({ error: 'bad_upload_id' }, { status: 400 });
  const parsed = parseObjectHeaders(request);
  if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { sha256, mtime } = parsed;

  const bodyJson = (await request.json().catch(() => null)) as { parts?: Array<{ part_number: number; etag: string }> } | null;
  const parts = bodyJson?.parts ?? [];
  if (parts.length === 0) return Response.json({ error: 'no_parts' }, { status: 400 });
  const r2Parts = parts.map((p) => ({ partNumber: p.part_number, etag: p.etag }));

  const canonicalKey = r2Key(machineId, store, relpath);
  const stagKey = stagingKey(machineId, store, relpath, token.nonce);
  const existing = await env.DB.prepare('SELECT id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3')
    .bind(machineId, store, relpath)
    .first<{ id: number }>();

  try {
    await env.RAW.resumeMultipartUpload(stagKey, token.r2UploadId).complete(r2Parts);
  } catch (e) {
    // Bad etags / part-size rule / unknown-or-expired uploadId / R2 error. Nothing landed on canonical.
    // The collector aborts + retries; R2 auto-aborts a leftover incomplete upload after 7 days.
    return Response.json({ error: 'complete_failed', detail: String(e) }, { status: 400 });
  }

  const staged = await env.RAW.get(stagKey);
  if (!staged) return Response.json({ error: 'staging_missing_after_complete' }, { status: 500 });

  // Verify-and-finalize in one pass: put({sha256}) verifies the whole object server-side while copying
  // staging -> canonical, and gives canonical a native checksum. On mismatch R2 throws WITHOUT touching
  // the existing canonical object (verified empirically — see the preservation test).
  let putOk = false;
  let putError: unknown;
  try {
    await env.RAW.put(canonicalKey, staged.body, { sha256, customMetadata: r2MtimeMetadata(mtime) });
    putOk = true;
  } catch (e) {
    putError = e;
  }
  await env.RAW.delete(stagKey).catch(() => {}); // staging is throwaway either way
  if (!putOk) {
    console.log(JSON.stringify({ event: 'access.multipart_mismatch', machine: machineId, key: canonicalKey, expected: sha256, error: String(putError) }));
    return Response.json({ error: 'checksum_mismatch', expected: sha256, detail: String(putError) }, { status: 422 });
  }

  return recordUploadedObject(env, {
    machineId,
    store,
    relpath,
    r2Key: canonicalKey,
    size: staged.size,
    mtime,
    sha256,
    existed: existing != null,
    // Canonical is now a single verified put with a native checksum, exactly like the simple path — but
    // we have no ArrayBuffer body to re-PUT, so converge on OBSERVED R2 state (see convergeMultipartRow).
    convergeBody: null,
    convergeObservedR2: true,
  });
}

/**
 * DELETE /api/v1/files/{machine}/{store}/{relpath}?uploadId=<id> — abort a multipart upload.
 * Aborts the staging multipart AND deletes any staging object a prior complete may have left (both
 * best-effort). Idempotent: an unknown/already-gone uploadId still returns 200 so the collector's
 * retry/give-up path never has to special-case a missing upload. R2 also auto-aborts an incomplete
 * upload after 7 days, and the prune cron sweeps a leaked staging object.
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

  // A malformed token can't identify a staging object; there's nothing to abort. Idempotent 'gone'.
  const token = parseUploadToken(params.get('uploadId') ?? '');
  if (!token) return Response.json({ status: 'gone' });
  const stagKey = stagingKey(machineId, store, relpath, token.nonce);
  let aborted = true;
  try {
    await env.RAW.resumeMultipartUpload(stagKey, token.r2UploadId).abort();
  } catch (e) {
    // Already completed/aborted/expired at R2 — nothing left to abort.
    aborted = false;
    console.log(JSON.stringify({ event: 'access.multipart_abort_warn', machine: machineId, error: String(e) }));
  }
  await env.RAW.delete(stagKey).catch(() => {}); // drop a staging object a completed-but-uncopied upload left
  return Response.json({ status: aborted ? 'aborted' : 'gone' });
}
