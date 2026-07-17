import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { hex } from './ops';

const TERMINAL_PARSE_STATES = new Set(['parsed', 'skipped', 'superseded']);

/** PUT /api/v1/files/{machine_id}/{store}/{relpath...} */
export async function putFile(
  request: Request,
  env: Env,
  identity: Identity,
  machineId: string,
  store: string,
  relpath: string,
): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (identity.machineId !== machineId && !identity.isAdmin) {
    return Response.json({ error: 'machine_mismatch' }, { status: 403 });
  }

  const hashHeader = request.headers.get('x-content-hash') ?? '';
  const m = hashHeader.match(/^sha256:([0-9a-f]{64})$/i);
  if (!m) return Response.json({ error: 'missing_or_bad_x_content_hash' }, { status: 400 });
  const sha256 = m[1]!.toLowerCase();
  const mtime = request.headers.get('x-file-mtime');
  const sizeHeader = request.headers.get('content-length') ?? request.headers.get('x-file-size');
  // Number(null) is 0, not NaN — without the explicit presence check, a chunked/streaming
  // upload with neither header would silently record as a 0-byte file, which then loses the
  // canonical-copy size tiebreaker to a smaller duplicate that did provide a size.
  if (sizeHeader === null) return Response.json({ error: 'missing_content_length' }, { status: 400 });
  const size = Number(sizeHeader);
  // A fractional size (e.g. x-file-size: 1.5, only reachable via the chunked-upload header since
  // content-length itself can't carry a fraction) would otherwise pass Number.isFinite, land the
  // body in R2, and only then 500 at the INSERT — files.size is STRICT INTEGER — leaving an
  // orphaned R2 object with no files row and no parse message. Reject before RAW.put.
  if (!Number.isSafeInteger(size) || size < 0) return Response.json({ error: 'missing_content_length' }, { status: 400 });
  if (!request.body) return Response.json({ error: 'missing_body' }, { status: 400 });

  const existing = await env.DB.prepare(
    'SELECT id, content_hash, parse_state, r2_key FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
  )
    .bind(machineId, store, relpath)
    .first<{ id: number; content_hash: string; parse_state: string; r2_key: string }>();
  if (existing && existing.content_hash === sha256) {
    // A matching hash normally means nothing to do — but the raw R2 object can be lost or
    // corrupt independent of parse_state (e.g. the flagship r2_object_missing failure, or R2
    // pruned out from under us), even for a row already 'parsed'. Head it on every same-hash
    // resync, not just non-terminal ones, and restore from the request body if it's gone — this
    // path only fires on a resync (not steady-state uploads), so the extra R2 op is cheap
    // relative to leaving /raw and normalized session loads permanently broken.
    let restored = false;
    if (!(await env.RAW.head(existing.r2_key))) {
      try {
        await env.RAW.put(existing.r2_key, request.body, { sha256 });
      } catch (e) {
        return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
      }
      restored = true;
    }
    // A non-terminal state (a dropped/failed queue message) never finished indexing in the
    // first place; a just-restored object needs its (possibly different) bytes revalidated even
    // if the row was previously 'parsed'. Either way: re-enqueue.
    if (!TERMINAL_PARSE_STATES.has(existing.parse_state) || restored) {
      await env.PARSE_QUEUE.send({ file_id: existing.id, r2_key: existing.r2_key, reason: 'upload', content_hash: existing.content_hash });
      return Response.json({ status: 'unchanged', file_id: existing.id, requeued: true, restored });
    }
    return Response.json({ status: 'unchanged', file_id: existing.id });
  }

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  // R2 verifies the checksum server-side: a corrupt/truncated body never lands. Its returned
  // object's .size is the authoritative byte count — the x-file-size/content-length header
  // above is only an early sanity gate (rejects an obviously-bad value before we touch R2);
  // for a streamed/chunked upload the declared header could still be a wrong-but-integer
  // value, and files.size drives canonical-copy dedupe, so trusting a mismatched header over
  // what R2 actually stored could pick the wrong raw file as canonical.
  let put: R2Object;
  try {
    put = await env.RAW.put(r2Key, request.body, { sha256 });
  } catch (e) {
    return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
  }

  const det = detect(store, relpath);
  const row = await env.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
     ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
       parse_state = 'pending', parse_error = NULL,
       uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`,
  )
    .bind(machineId, store, relpath, r2Key, put.size, mtime, sha256, det.harness, det.sessionId ?? null)
    .first<{ id: number }>();

  await env.DB.prepare('UPDATE machines SET last_upload_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE machine_id = ?1')
    .bind(machineId)
    .run();
  await env.PARSE_QUEUE.send({ file_id: row!.id, r2_key: r2Key, reason: 'upload', content_hash: sha256 });

  console.log(
    JSON.stringify({ event: 'access.upload', machine: machineId, key: r2Key, bytes: put.size, status: existing ? 'updated' : 'created' }),
  );
  return Response.json({ status: 'stored', file_id: row!.id }, { status: 201 });
}

/** POST /api/v1/files/check — batch resync: which of these does the hub NOT have? */
export async function checkFiles(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json()) as { files?: Array<{ store: string; relpath: string; sha256: string }> };
  const items = body.files ?? [];
  if (items.length > 1000) return Response.json({ error: 'batch_too_large' }, { status: 400 });

  const missing: Array<{ store: string; relpath: string }> = [];
  for (const chunk of chunks(items, 50)) {
    const conditions = chunk.map((_, i) => `(store = ?${i * 3 + 2} AND relpath = ?${i * 3 + 3} AND content_hash = ?${i * 3 + 4})`);
    const binds: unknown[] = [identity.machineId];
    for (const it of chunk) binds.push(it.store, it.relpath, it.sha256.replace(/^sha256:/, '').toLowerCase());
    const rows = await env.DB.prepare(
      `SELECT id, store, relpath, r2_key, parse_state, content_hash FROM files WHERE machine_id = ?1 AND (${conditions.join(' OR ')})`,
    )
      .bind(...binds)
      .all<{ id: number; store: string; relpath: string; r2_key: string; parse_state: string; content_hash: string }>();
    // Keyed by store+relpath+hash, not just path: the D1 query above ORs together each item's
    // OWN (store, relpath, hash) condition, so a returned row only proves THAT SPECIFIC hash
    // matched. Keying by path alone would let one item's match get reused by a sibling item in
    // the same batch requesting a DIFFERENT hash for the same path (e.g. a collector scan racing
    // a local rewrite), wrongly reporting the changed file as present.
    const have = new Map(rows.results.map((r) => [`${r.store}\n${r.relpath}\n${r.content_hash}`, r]));
    // A matched D1 row is not proof the raw bytes still exist OR are still correct — head every
    // match in this chunk (bounded to ≤50, parallel) and compare R2's own sha256 checksum
    // (present because every PUT through this API passes {sha256}) against the row's
    // content_hash. A missing object, a missing checksum (shouldn't happen via our PUT path, but
    // conservative if it ever does), or a mismatch (e.g. the object was overwritten/replaced by
    // something outside this API) are all reported missing — a matching D1 row alone no longer
    // proves the right bytes are actually sitting in R2. That's what makes the collector re-send
    // the bytes; the upload path's same-hash restore logic then repairs R2 from that re-upload.
    const heads = await Promise.all(
      [...have.values()].map(async (r): Promise<[number, boolean]> => {
        const obj = await env.RAW.head(r.r2_key);
        const checksum = obj?.checksums.sha256 ? hex(obj.checksums.sha256) : undefined;
        return [r.id, checksum === r.content_hash];
      }),
    );
    const objectVerified = new Map(heads);
    for (const it of chunk) {
      const hash = it.sha256.replace(/^sha256:/, '').toLowerCase();
      const row = have.get(`${it.store}\n${it.relpath}\n${hash}`);
      if (!row || !objectVerified.get(row.id)) {
        missing.push({ store: it.store, relpath: it.relpath });
        continue;
      }
      // The raw bytes are already in R2 — a matching hash means present, but a row stuck at a
      // non-terminal parse_state (lost/exhausted queue message) would otherwise never get
      // reindexed: the collector sees "present" and never re-uploads, so nothing else requeues it.
      if (!TERMINAL_PARSE_STATES.has(row.parse_state)) {
        await env.PARSE_QUEUE.send({ file_id: row.id, r2_key: row.r2_key, reason: 'upload', content_hash: row.content_hash });
      }
    }
  }
  return Response.json({ missing });
}

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}
