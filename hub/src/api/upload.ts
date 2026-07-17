import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { markPendingAndEnqueue } from '../queue';
import { hex } from './ops';

const TERMINAL_PARSE_STATES = new Set(['parsed', 'skipped', 'superseded']);

/** R2 customMetadata values must be strings, and the x-file-mtime header is optional — build the
 * {mtime} customMetadata object only when we actually have one to record. reindex() reads this
 * back (see ops.ts) to restore files.mtime for R2 objects whose D1 row was lost/wiped; a legacy
 * object written before this existed (or an upload that never sent x-file-mtime) simply has no
 * customMetadata, and reindex treats that as mtime IS NULL rather than failing. */
function r2MtimeMetadata(mtime: string | null): Record<string, string> | undefined {
  return mtime !== null ? { mtime } : undefined;
}

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
    // A matching hash normally means nothing to do — but the raw R2 object can be lost, missing,
    // OR CORRUPT (present at the key with the wrong bytes — e.g. a bad manual restore outside
    // this API) independent of parse_state, even for a row already 'parsed'. Head it on every
    // same-hash resync, not just non-terminal ones, and compare R2's own sha256 checksum against
    // existing.content_hash: restore from the request body on absence OR mismatch/missing
    // checksum, mirroring the same verification files/check does. This path only fires on a
    // resync (not steady-state uploads), so the extra R2 op is cheap relative to leaving /raw and
    // normalized session loads permanently reading wrong or missing bytes.
    let restored = false;
    const head = await env.RAW.head(existing.r2_key);
    const headChecksum = head?.checksums.sha256 ? hex(head.checksums.sha256) : undefined;
    if (!head || headChecksum !== existing.content_hash) {
      try {
        await env.RAW.put(existing.r2_key, request.body, { sha256, customMetadata: r2MtimeMetadata(mtime) });
      } catch (e) {
        return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
      }
      restored = true;
    }
    // A non-terminal state (a dropped/failed queue message) never finished indexing in the
    // first place; a just-restored object needs its (possibly different) bytes revalidated even
    // if the row was previously 'parsed'. Either way: re-enqueue. markPendingAndEnqueue flips
    // parse_state to 'pending' BEFORE sending — otherwise a restored row that was terminal
    // (e.g. 'parsed'/'skipped') would stay terminal while its parse message is in flight, and if
    // PARSE_QUEUE.send fails (or the message is later dropped), a client retry would see
    // 'unchanged' with the now-correct checksum and never requeue, same for files/check.
    if (!TERMINAL_PARSE_STATES.has(existing.parse_state) || restored) {
      await markPendingAndEnqueue(existing, 'upload', env);
      return Response.json({ status: 'unchanged', file_id: existing.id, requeued: true, restored });
    }
    return Response.json({ status: 'unchanged', file_id: existing.id });
  }

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  // Buffer the body up front rather than streaming it straight into RAW.put: the convergence
  // check below (see convergeR2WithRow) may need to re-PUT these exact bytes a second time if a
  // concurrent request's write interleaves with this one, and request.body is a single-use
  // stream — RAW.put already consumes it on the first PUT, so a second PUT needs its own copy.
  // Uploads are small today (well under 35MB); the isolate's 128MB memory limit gives comfortable
  // headroom — revisit (e.g. switch to a content-addressed key, avoiding the rewrite entirely) if
  // upload sizes grow enough for this to matter.
  const bodyBuf = await request.arrayBuffer();
  // R2 verifies the checksum server-side: a corrupt/truncated body never lands. Its returned
  // object's .size is the authoritative byte count — the x-file-size/content-length header
  // above is only an early sanity gate (rejects an obviously-bad value before we touch R2);
  // for a streamed/chunked upload the declared header could still be a wrong-but-integer
  // value, and files.size drives canonical-copy dedupe, so trusting a mismatched header over
  // what R2 actually stored could pick the wrong raw file as canonical.
  let put: R2Object;
  try {
    put = await env.RAW.put(r2Key, bodyBuf, { sha256, customMetadata: r2MtimeMetadata(mtime) });
  } catch (e) {
    return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
  }

  // machineId is required so machine-global files (history.jsonl, identical relpath fleet-wide)
  // get a machine-scoped session_id stamped on the row — otherwise canonical/recovery/parsing
  // queries (which look files up BY session_id) can't find them.
  const det = detect(store, relpath, machineId);
  const row = await env.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
     ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
       -- Refresh harness/session_id too: a row created before machine-scoped prompt-log ids
       -- existed (or before a detect() change) would otherwise keep a stale/NULL session_id even
       -- after re-upload, so canonical/recovery queries that join on files.session_id miss it.
       harness = excluded.harness, session_id = excluded.session_id,
       parse_state = 'pending', parse_error = NULL,
       uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id`,
  )
    .bind(machineId, store, relpath, r2Key, put.size, mtime, sha256, det.harness, det.sessionId ?? null)
    .first<{ id: number }>();

  // Two overlapping changed-hash uploads for the SAME path can interleave their R2 writes and D1
  // upserts arbitrarily — this request's RAW.put above can land before or after a concurrent
  // request's, independent of upsert order. That can leave files.content_hash describing bytes
  // R2 no longer holds at r2Key. Re-check right after our own upsert: if the row still shows
  // THIS request's hash, our upsert was the most recent (or only) writer and is authoritative for
  // what R2 SHOULD hold — restore it if a concurrent request's later R2 write clobbered ours in
  // between. If the row shows a DIFFERENT hash, some other request's upsert won after ours; THAT
  // request runs this exact same check on its own way out, so it (not us) owns convergence here.
  // Either way, a genuinely stale parse message is rejected at the source by the consumer's
  // content_hash guard, so no reparse can process the wrong bytes even in the brief window before
  // convergence completes.
  await convergeR2WithRow(row!.id, r2Key, sha256, bodyBuf, env);

  await env.DB.prepare('UPDATE machines SET last_upload_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE machine_id = ?1')
    .bind(machineId)
    .run();
  if (det.sessionId) {
    // A changed-hash re-upload of the session's CURRENT canonical file just overwrote the raw
    // object out from under the derived rows: files.parse_state flips to 'pending' above, but
    // sessions.index_state (and the blocks/FTS it advertises) would otherwise stay 'ready' —
    // describing the OLD bytes — until the queue consumer actually gets around to reparsing. If
    // that message is delayed or dropped, /search and /sessions keep serving stale-but-labeled-
    // ready content indefinitely. Flip to 'parsing' now: an honest in-progress signal, and if the
    // message never arrives, the session is visibly stuck 'parsing' (already alertable via
    // /status) instead of silently stale-'ready'. No-op for a brand-new session (no sessions row
    // yet) or a non-canonical duplicate (canonical_file_id != this file's id).
    await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1 AND canonical_file_id = ?2")
      .bind(det.sessionId, row!.id)
      .run();
  } else if (det.kind === 'export-archive') {
    // An export ZIP fans out to many per-conversation sessions and carries no det.sessionId, so the
    // single-session flip above never runs. A changed-hash re-upload already overwrote the ZIP; flip
    // every session this archive is canonical for to 'parsing' so /search and /sessions stop
    // advertising the OLD bytes' blocks as 'ready' until the reparse lands (or, if the message is
    // dropped, the sessions are visibly stuck 'parsing' — alertable — instead of silently stale).
    await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE canonical_file_id = ?1")
      .bind(row!.id)
      .run();
  }
  await env.PARSE_QUEUE.send({ file_id: row!.id, r2_key: r2Key, reason: 'upload', content_hash: sha256 });

  console.log(
    JSON.stringify({ event: 'access.upload', machine: machineId, key: r2Key, bytes: put.size, status: existing ? 'updated' : 'created' }),
  );
  return Response.json({ status: 'stored', file_id: row!.id }, { status: 201 });
}

/**
 * See the convergence comment at its call site above. Exported for tests, which simulate the
 * interleaved end-state directly (R2 holding one request's bytes, the row showing a different
 * request's hash) rather than racing real concurrent requests — there's no thread-level
 * concurrency to race in a single-isolate test environment, but the resulting DB/R2 state is
 * identical to what a real interleaving would produce, and this function is exactly what each
 * request runs to detect and repair it.
 */
export async function convergeR2WithRow(fileId: number, r2Key: string, sha256: string, body: ArrayBuffer, env: Env): Promise<void> {
  const current = await env.DB.prepare('SELECT content_hash, mtime FROM files WHERE id = ?1')
    .bind(fileId)
    .first<{ content_hash: string; mtime: string | null }>();
  if (current?.content_hash !== sha256) return;
  const head = await env.RAW.head(r2Key);
  const headChecksum = head?.checksums.sha256 ? hex(head.checksums.sha256) : undefined;
  if (headChecksum === sha256) return;
  await env.RAW.put(r2Key, body, { sha256, customMetadata: r2MtimeMetadata(current.mtime) });
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
        await markPendingAndEnqueue(row, 'upload', env);
      }
    }
  }
  return Response.json({ missing });
}

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}
