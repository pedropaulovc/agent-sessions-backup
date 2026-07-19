import type { Identity } from '../auth/identity';
import { detect } from '../ingest/detect';
import { markPendingAndEnqueue, reservationCutoffIso } from '../queue';
import { hex, objectSha256 } from './ops';

export const TERMINAL_PARSE_STATES = new Set(['parsed', 'skipped', 'superseded']);

/** Finish a known non-parseable file without spending a queue delivery on it. A fresh export
 * cleanup reservation remains owner-controlled; every other row becomes terminal immediately and
 * sheds stale reservation/error metadata. */
export async function markKnownOtherSkipped(fileId: number, contentHash: string, env: Env): Promise<boolean> {
  const skipped = await env.DB.prepare(
    `UPDATE files SET parse_state = 'skipped', parse_error = NULL,
       reserved_at = NULL, reserved_by = NULL, reserved_reason = NULL
     WHERE id = ?1 AND content_hash = ?2
       AND NOT (parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?3)
     RETURNING id`,
  )
    .bind(fileId, contentHash, reservationCutoffIso())
    .first<{ id: number }>();
  return skipped !== null;
}

/** R2 customMetadata values must be strings, and the x-file-mtime header is optional — build the
 * {mtime} customMetadata object only when we actually have one to record. reindex() reads this
 * back (see ops.ts) to restore files.mtime for R2 objects whose D1 row was lost/wiped; a legacy
 * object written before this existed (or an upload that never sent x-file-mtime) simply has no
 * customMetadata, and reindex treats that as mtime IS NULL rather than failing. */
function r2MtimeMetadata(mtime: string | null): Record<string, string> | undefined {
  return mtime !== null ? { mtime } : undefined;
}

/** A legacy row (created before a detect() change / before machine-scoped prompt-log ids) can sit
 * TERMINAL 'skipped' with a stale/NULL harness/session_id even though its bytes are unchanged. On
 * any same-hash resync — a PUT of identical bytes OR a files/check batch — re-run detect() and, when
 * the stored identity is stale (or a 'skipped' row is now recognized), restamp those columns in
 * place. Returns whether a restamp was applied so BOTH resync paths can fold it into their
 * re-enqueue decision (a terminal-but-restamped row must still be requeued to finally index).
 * detect() is pure/cheap and only reached on a resync, never a steady-state upload. */
export async function restampIfStale(
  row: { id: number; parse_state: string; harness: string | null; session_id: string | null },
  store: string,
  relpath: string,
  machineId: string,
  env: Env,
): Promise<boolean> {
  const det = detect(store, relpath, machineId);
  const identityStale = det.harness !== row.harness || (det.sessionId ?? null) !== row.session_id;
  const skippedButNowRecognized = row.parse_state === 'skipped' && det.harness !== 'unknown';
  if (!identityStale && !skippedButNowRecognized) return false;
  await env.DB.prepare('UPDATE files SET harness = ?2, session_id = ?3 WHERE id = ?1')
    .bind(row.id, det.harness, det.sessionId ?? null)
    .run();
  return true;
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
    'SELECT id, content_hash, parse_state, r2_key, harness, session_id FROM files WHERE machine_id = ?1 AND store = ?2 AND relpath = ?3',
  )
    .bind(machineId, store, relpath)
    .first<{ id: number; content_hash: string; parse_state: string; r2_key: string; harness: string | null; session_id: string | null }>();
  if (existing && existing.content_hash === sha256) {
    const det = detect(store, relpath, machineId);
    // Restamp a legacy row whose stored identity drifted (see restampIfStale) before deciding
    // whether this unchanged upload still needs a re-enqueue.
    const restamped = await restampIfStale(existing, store, relpath, machineId, env);
    // A matching hash normally means nothing to do — but the raw R2 object can be lost, missing,
    // OR CORRUPT (present at the key with the wrong bytes — e.g. a bad manual restore outside this
    // API) independent of parse_state, even for a row already 'parsed'. Restore from the request
    // body on absence OR checksum mismatch, mirroring files/check's verification. Route it through
    // convergeR2WithRow (same idiom the changed-hash path uses on its way out) so the restore is
    // HASH-GUARDED: a stale same-hash retry of OLD bytes that raced a changed-hash upload which
    // already advanced the row + converged R2 to the new bytes bails instead of clobbering R2 with
    // the old body. This path only fires on a resync (not steady-state uploads), so buffering the
    // body + the extra R2 op is cheap relative to leaving /raw and session loads reading wrong bytes.
    let restored = false;
    let bodyBuf: ArrayBuffer;
    try {
      bodyBuf = await request.arrayBuffer();
    } catch (e) {
      return Response.json({ error: 'body_read_failure', detail: String(e) }, { status: 400 });
    }
    try {
      restored = await convergeR2WithRow(existing.id, existing.r2_key, existing.content_hash, bodyBuf, env);
    } catch (e) {
      // R2 rejects a body whose bytes don't match the declared sha256 (corrupt/truncated retry).
      return Response.json({ error: 'checksum_or_write_failure', detail: String(e) }, { status: 400 });
    }
    // A non-terminal state (a dropped/failed queue message) never finished indexing in the
    // first place; a just-restored object needs its (possibly different) bytes revalidated even
    // if the row was previously 'parsed'. Either way: re-enqueue. markPendingAndEnqueue flips
    // parse_state to 'pending' BEFORE sending — otherwise a restored row that was terminal
    // (e.g. 'parsed'/'skipped') would stay terminal while its parse message is in flight, and if
    // PARSE_QUEUE.send fails (or the message is later dropped), a client retry would see
    // 'unchanged' with the now-correct checksum and never requeue, same for files/check.
    // markPendingAndEnqueue applies the centralized fresh-reservation gate (round 15): a FRESH 'reserved' row
    // (a live cleanup's) is left to its owner's recover send and NOT requeued as 'upload' here, so it can't
    // escape the reserved set; a STALE reservation heals like any 'pending' row. `requeued` reflects whether
    // the gate let the requeue fire.
    if (det.kind === 'other') {
      await markKnownOtherSkipped(existing.id, sha256, env);
      return Response.json({ status: 'unchanged', file_id: existing.id, restored, restamped, skipped: true });
    }
    if (restamped || restored || !TERMINAL_PARSE_STATES.has(existing.parse_state)) {
      const requeued = await markPendingAndEnqueue(existing, 'upload', env);
      return Response.json({ status: 'unchanged', file_id: existing.id, requeued, restored, restamped });
    }
    return Response.json({ status: 'unchanged', file_id: existing.id });
  }

  const r2Key = `raw/${machineId}/${store}/${relpath}`;
  // Buffer the body up front rather than streaming it straight into RAW.put: the convergence
  // check below (see convergeR2WithRow) may need to re-PUT these exact bytes a second time if a
  // concurrent request's write interleaves with this one, and request.body is a single-use
  // stream — RAW.put already consumes it on the first PUT, so a second PUT needs its own copy.
  // This simple path only runs for files under the collector's multipart threshold (default
  // 90MB, kept below Cloudflare's 100MB request-body cap — see multipart.ts); the isolate's
  // 128MB memory limit gives headroom. Larger files never reach here: the collector routes them
  // through the streamed multipart path instead.
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

  return recordUploadedObject(env, {
    machineId,
    store,
    relpath,
    r2Key,
    size: put.size,
    mtime,
    sha256,
    existed: existing != null,
    // Simple path only: pass the buffered body so recordUploadedObject can converge R2 against a
    // concurrent same-path writer (see convergeR2WithRow). The multipart path passes null — it
    // controls its own object and never races a second full-file writer for the same 100MB file.
    convergeBody: bodyBuf,
  });
}

/**
 * Shared finalize for a raw object that has just landed in R2 (via the simple PUT or a completed
 * multipart upload): upsert the files row, converge R2 against a concurrent same-path writer (simple
 * path only), stamp last_upload, flip any owned session to 'parsing', enqueue the parse, and return
 * the 201 stored response. Keeping this in ONE place is what makes a >=90MB multipart upload index
 * byte-identically to a <90MB simple PUT — the only difference between the two paths is how the bytes
 * reach R2, never what happens after.
 */
export async function recordUploadedObject(
  env: Env,
  opts: {
    machineId: string;
    store: string;
    relpath: string;
    r2Key: string;
    size: number;
    mtime: string | null;
    sha256: string;
    existed: boolean;
    convergeBody: ArrayBuffer | null;
    // Multipart path: there is no body to re-PUT, so converge on OBSERVED R2 state instead (see
    // convergeMultipartRow). Two overlapping changed-hash completes for the same key can leave the
    // D1 row describing bytes R2 no longer holds; this realigns the row to whatever object survived.
    convergeObservedR2?: boolean;
  },
): Promise<Response> {
  const { machineId, store, relpath, r2Key, size, mtime, sha256, existed, convergeBody } = opts;
  // machineId is required so machine-global files (history.jsonl, identical relpath fleet-wide)
  // get a machine-scoped session_id stamped on the row — otherwise canonical/recovery/parsing
  // queries (which look files up BY session_id) can't find them.
  const det = detect(store, relpath, machineId);
  const targetParseState = det.kind === 'other' ? 'skipped' : 'pending';
  const row = await env.DB.prepare(
    `INSERT INTO files (machine_id, store, relpath, r2_key, size, mtime, content_hash, harness, session_id, parse_state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (machine_id, store, relpath) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, content_hash = excluded.content_hash,
       -- Refresh harness/session_id too: a row created before machine-scoped prompt-log ids
       -- existed (or before a detect() change) would otherwise keep a stale/NULL session_id even
       -- after re-upload, so canonical/recovery queries that join on files.session_id miss it.
       harness = excluded.harness, session_id = excluded.session_id,
       -- A live cleanup owns the reserve -> delete -> send-late window even when the collector uploads changed
       -- bytes meanwhile. Keep the row reserved until that cleanup drains; changed bytes upgrade the durable
       -- intent to 'upload', so the owner-tagged delivery runs full replacement semantics after the deletes.
       -- Same-hash repairs retain their original upload/recover intent (3609060881, 3609611899).
       parse_state = CASE
         WHEN files.parse_state = 'reserved'
           AND files.reserved_at IS NOT NULL AND files.reserved_at > ?11 THEN 'reserved'
         ELSE excluded.parse_state END,
       parse_error = CASE
         WHEN files.content_hash = excluded.content_hash AND files.parse_state = 'reserved'
           AND files.reserved_at IS NOT NULL AND files.reserved_at > ?11 THEN files.parse_error
         ELSE NULL END,
       reserved_at = CASE
         WHEN files.parse_state = 'reserved'
           AND files.reserved_at IS NOT NULL AND files.reserved_at > ?11 THEN files.reserved_at
         ELSE NULL END,
       reserved_by = CASE
         WHEN files.parse_state = 'reserved'
           AND files.reserved_at IS NOT NULL AND files.reserved_at > ?11 THEN files.reserved_by
         ELSE NULL END,
       reserved_reason = CASE
         WHEN files.parse_state = 'reserved' AND files.reserved_at IS NOT NULL AND files.reserved_at > ?11
           THEN CASE WHEN files.content_hash = excluded.content_hash THEN files.reserved_reason ELSE 'upload' END
         ELSE NULL END,
       uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     RETURNING id, parse_state, reserved_reason, reserved_by, reservation_generation`,
  )
    .bind(machineId, store, relpath, r2Key, size, mtime, sha256, det.harness, det.sessionId ?? null, targetParseState, reservationCutoffIso())
    .first<{
      id: number;
      parse_state: string;
      reserved_reason: string | null;
      reserved_by: number | null;
      reservation_generation: number;
    }>();
  const preservedReservation = row!.parse_state === 'reserved';
  const reservedUpload = preservedReservation && row!.reserved_reason === 'upload';

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
  // convergence completes. The multipart path passes convergeBody=null (no concurrent full-file
  // writer to race, and it never buffers the whole object) and skips this.
  if (convergeBody !== null) await convergeR2WithRow(row!.id, r2Key, sha256, convergeBody, env);

  await env.DB.prepare('UPDATE machines SET last_upload_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE machine_id = ?1')
    .bind(machineId)
    .run();
  if ((!preservedReservation || reservedUpload) && det.sessionId) {
    // A changed-hash re-upload of the session's CURRENT canonical file just overwrote the raw
    // object out from under the derived rows: files.parse_state flips to 'pending' above, but
    // sessions.index_state (and the blocks/FTS it advertises) would otherwise stay 'ready' —
    // describing the OLD bytes — until the queue consumer actually gets around to reparsing. If
    // that message is delayed or dropped, /search and /sessions keep serving stale-but-labeled-
    // ready content indefinitely. Flip to 'parsing' now: an honest in-progress signal, and if the
    // message never arrives, the session is visibly stuck 'parsing' (already alertable via
    // /status) instead of silently stale-'ready'. No-op for a brand-new session (no sessions row
    // yet) or a non-canonical duplicate (canonical_file_id != this file's id). Hash-guarded against
    // the concurrent-upsert-loser race — see flipOwnedSessionsToParsing.
    await flipOwnedSessionsToParsing(row!.id, det.sessionId, sha256, env);
  } else if ((!preservedReservation || reservedUpload) && det.kind === 'export-archive') {
    // An export ZIP fans out to many per-conversation sessions and carries no det.sessionId, so the
    // single-session flip above never runs. A changed-hash re-upload already overwrote the ZIP; flip
    // every session this archive is canonical for to 'parsing' so /search and /sessions stop
    // advertising the OLD bytes' blocks as 'ready' until the reparse lands (or, if the message is
    // dropped, the sessions are visibly stuck 'parsing' — alertable — instead of silently stale).
    await flipOwnedSessionsToParsing(row!.id, null, sha256, env);
  }
  // Enqueue the parse — but for the multipart path, converge FIRST so we never send a message that
  // describes bytes R2 no longer holds. Two racing completes for one path can leave this row's upsert
  // winning D1 while R2 ends up holding the OTHER upload's object; convergeMultipartRow detects that,
  // realigns the row to the surviving object, and enqueues a parse for ITS hash. Sending our own
  // sha256 message FIRST (the old order) could let the consumer parse the other object's bytes under
  // our hash before convergence repaired the row — or forever, if convergence threw mid-way. So:
  //   - convergence realigned + enqueued -> DON'T also send the stale-sha message (exactly one msg);
  //   - convergence made no change (no race / R2 already matches) -> send our hash as usual;
  //   - convergence threw -> nothing sent at all; the queue retry / next complete repairs it (that's
  //     the point of ordering converge ahead of the send).
  // The simple path has no observed-R2 convergence (convergeR2WithRow above only restores bytes, never
  // changes the row hash), so realigned is always false there and it enqueues our hash.
  const knownOther = det.kind === 'other';
  const realigned = opts.convergeObservedR2 === true && (await convergeMultipartRow(row!.id, r2Key, sha256, env, knownOther));
  if (knownOther) {
    console.log(
      JSON.stringify({ event: 'access.upload', machine: machineId, key: r2Key, bytes: size, status: existed ? 'updated' : 'created' }),
    );
    return Response.json({ status: 'stored', file_id: row!.id }, { status: 201 });
  }
  if (!realigned && preservedReservation && reservedUpload && row!.reserved_by !== null) {
    // The cleanup may already have selected an owner-tagged delivery for the old hash. Refresh it with the
    // current hash; parseOne waits for the owner to become terminal, so this is safe both before and after
    // its delete window drains (3609651684).
    await env.PARSE_QUEUE.send({
      file_id: row!.id,
      r2_key: r2Key,
      reason: 'upload',
      content_hash: sha256,
      reservation_owner: row!.reserved_by,
      reservation_generation: row!.reservation_generation,
    });
  } else if (!realigned && !preservedReservation) {
    await env.PARSE_QUEUE.send({ file_id: row!.id, r2_key: r2Key, reason: 'upload', content_hash: sha256 });
  }

  console.log(
    JSON.stringify({ event: 'access.upload', machine: machineId, key: r2Key, bytes: size, status: existed ? 'updated' : 'created' }),
  );
  return Response.json({ status: 'stored', file_id: row!.id }, { status: 201 });
}

/**
 * Multipart analog of convergeR2WithRow. The simple path re-PUTs its buffered body to restore R2 when
 * a concurrent same-path writer clobbered it; a multipart complete has no body to re-PUT, so instead
 * it aligns D1 to whatever object actually survived in R2. Two overlapping changed-hash completes for
 * the same key each write their object then upsert their row; the R2-last-writer and D1-last-writer
 * can differ, leaving files.content_hash describing bytes R2 no longer holds. After our own upsert we
 * HEAD the key: if it still carries THIS complete's hash (we are the current D1 owner) but R2 holds a
 * DIFFERENT object (identified by its native checksums.sha256), realign the row to the R2 hash and
 * enqueue a parse for it. Guarded on our own hash so the OTHER writer — which runs this same check —
 * owns convergence once its upsert wins the row. Exported for tests, which drive the interleaved end
 * state directly (row hash == ours, R2 object == the other writer's) the same way convergeR2WithRow does.
 *
 * Returns true when it realigned the row (and enqueued a parse for the observed R2 hash), false when
 * there was nothing to realign. recordUploadedObject runs this BEFORE its own parse-queue send and,
 * on a true return, SKIPS that send — so a realigned row is parsed under the R2 hash exactly once and
 * the stale-sha message is never emitted at all (not merely rejected later by the consumer guard).
 */
export async function convergeMultipartRow(
  fileId: number,
  r2Key: string,
  sha256: string,
  env: Env,
  knownOther = false,
): Promise<boolean> {
  const row = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(fileId).first<{ content_hash: string }>();
  if (row?.content_hash !== sha256) return false; // another writer's upsert won; they own convergence
  const head = await env.RAW.head(r2Key);
  const r2Hash = objectSha256(head);
  // No object (a concurrent delete) or R2 already matches our row: nothing to realign.
  if (!r2Hash || r2Hash === sha256) return false;
  // R2 holds a different upload's object. Point the row at what R2 actually holds and reparse it.
  // Realign size too (from head.size): chooseCanonical orders duplicates by `size DESC`, so a stale
  // size from the losing upload would corrupt canonical selection and leave metadata for the wrong object.
  const mtime = head!.customMetadata?.mtime ?? null;
  const updated = await env.DB.prepare(
    `UPDATE files SET content_hash = ?2, mtime = ?3, size = ?4,
       parse_state = CASE
         WHEN parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?6 THEN 'reserved'
         WHEN ?7 = 1 THEN 'skipped'
         ELSE 'pending' END,
       parse_error = NULL,
       reserved_at = CASE
         WHEN parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?6 THEN reserved_at
         ELSE NULL END,
       reserved_by = CASE
         WHEN parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?6 THEN reserved_by
         ELSE NULL END,
       reserved_reason = CASE
         WHEN parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?6 THEN 'upload'
         ELSE NULL END
     WHERE id = ?1 AND content_hash = ?5 RETURNING id, parse_state, reserved_by, reservation_generation`,
  )
    .bind(fileId, r2Hash, mtime, head!.size, sha256, reservationCutoffIso(), knownOther ? 1 : 0)
    .first<{ id: number; parse_state: string; reserved_by: number | null; reservation_generation: number }>();
  if (!updated) return false; // lost the row to the other writer in the meantime
  if (knownOther) {
    console.log(JSON.stringify({ event: 'access.multipart_converge', key: r2Key, from: sha256, to: r2Hash }));
    return true;
  }
  // If convergence discovers that R2 actually contains different bytes, this is a real changed-hash upload.
  // Flip every session the archive owns so ready rows never describe the pre-realignment object. A live
  // reservation remains owner-controlled and defers the enqueue; otherwise enqueue immediately.
  await flipOwnedSessionsToParsing(fileId, null, r2Hash, env);
  if (updated.parse_state === 'reserved' && updated.reserved_by !== null) {
    await env.PARSE_QUEUE.send({
      file_id: fileId,
      r2_key: r2Key,
      reason: 'upload',
      content_hash: r2Hash,
      reservation_owner: updated.reserved_by,
      reservation_generation: updated.reservation_generation,
    });
  } else {
    await env.PARSE_QUEUE.send({ file_id: fileId, r2_key: r2Key, reason: 'upload', content_hash: r2Hash });
  }
  console.log(JSON.stringify({ event: 'access.multipart_converge', key: r2Key, from: sha256, to: r2Hash }));
  return true;
}

/**
 * See the convergence comment at its call site above. Exported for tests, which simulate the
 * interleaved end-state directly (R2 holding one request's bytes, the row showing a different
 * request's hash) rather than racing real concurrent requests — there's no thread-level
 * concurrency to race in a single-isolate test environment, but the resulting DB/R2 state is
 * identical to what a real interleaving would produce, and this function is exactly what each
 * request runs to detect and repair it.
 */
/**
 * Flip the sessions a just-reuploaded file owns to index_state='parsing' — but ONLY while the file
 * row still carries THIS upload's content_hash. Two concurrent changed-hash uploads for the same
 * path upsert the SAME row; the upsert LOSER can reach the flip after the winner's hash already owns
 * the row (and the winner may have parsed it back to 'ready'). An unguarded flip would knock those
 * sessions to 'parsing' while the loser's stale queue message is rejected by parseOne's content_hash
 * guard — stranding them 'parsing' forever. The EXISTS makes the check+flip atomic in one statement.
 * sessionId set = single-session harness (filter by session_id too); null = export archive (fans out
 * to every session it's canonical for). Exported so tests can drive the loser end-state directly (row
 * hash already advanced to another request's) the same way convergeR2WithRow's tests do.
 */
export async function flipOwnedSessionsToParsing(
  fileId: number,
  sessionId: string | null,
  sha256: string,
  env: Env,
): Promise<void> {
  if (sessionId !== null) {
    await env.DB.prepare(
      "UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1 AND canonical_file_id = ?2 AND EXISTS (SELECT 1 FROM files WHERE id = ?2 AND content_hash = ?3)",
    )
      .bind(sessionId, fileId, sha256)
      .run();
    return;
  }
  await env.DB.prepare(
    "UPDATE sessions SET index_state = 'parsing' WHERE canonical_file_id = ?1 AND EXISTS (SELECT 1 FROM files WHERE id = ?1 AND content_hash = ?2)",
  )
    .bind(fileId, sha256)
    .run();
}

// Returns whether it (re)wrote R2. The `content_hash !== sha256` guard is load-bearing for BOTH
// callers: a changed-hash upload converging on its way out, AND a same-hash restore — a stale
// same-hash retry of OLD bytes that raced a changed-hash upload which already advanced the row and
// converged R2 to the new bytes must NOT write the old body back (the row no longer carries its
// hash), or R2 would serve old content while D1 claims the new hash.
export async function convergeR2WithRow(fileId: number, r2Key: string, sha256: string, body: ArrayBuffer, env: Env): Promise<boolean> {
  const current = await env.DB.prepare('SELECT content_hash, mtime FROM files WHERE id = ?1')
    .bind(fileId)
    .first<{ content_hash: string; mtime: string | null }>();
  if (current?.content_hash !== sha256) return false;
  const head = await env.RAW.head(r2Key);
  const headChecksum = head?.checksums.sha256 ? hex(head.checksums.sha256) : undefined;
  if (headChecksum === sha256) return false;
  await env.RAW.put(r2Key, body, { sha256, customMetadata: r2MtimeMetadata(current.mtime) });
  return true;
}

// Production D1 accepts numbered bind variables only through ?100. Each files/check item consumes
// three (store, relpath, content_hash), in addition to the chunk's single machine_id bind:
// 1 + 33 * 3 = 100 exactly. Keep the chunk bound derived from that invariant when this query changes.
const FILE_CHECK_CHUNK_SIZE = 33;

/** POST /api/v1/files/check — batch resync: which of these does the hub NOT have? */
export async function checkFiles(request: Request, env: Env, identity: Identity): Promise<Response> {
  if (identity.kind !== 'machine') return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json()) as { files?: Array<{ store: string; relpath: string; sha256: string }> };
  const items = body.files ?? [];
  if (items.length > 1000) return Response.json({ error: 'batch_too_large' }, { status: 400 });

  const missing: Array<{ store: string; relpath: string }> = [];
  for (const chunk of chunks(items, FILE_CHECK_CHUNK_SIZE)) {
    const conditions = chunk.map((_, i) => `(store = ?${i * 3 + 2} AND relpath = ?${i * 3 + 3} AND content_hash = ?${i * 3 + 4})`);
    const binds: unknown[] = [identity.machineId];
    for (const it of chunk) binds.push(it.store, it.relpath, it.sha256.replace(/^sha256:/, '').toLowerCase());
    const rows = await env.DB.prepare(
      `SELECT id, store, relpath, r2_key, parse_state, content_hash, harness, session_id FROM files WHERE machine_id = ?1 AND (${conditions.join(' OR ')})`,
    )
      .bind(...binds)
      .all<{
        id: number;
        store: string;
        relpath: string;
        r2_key: string;
        parse_state: string;
        content_hash: string;
        harness: string | null;
        session_id: string | null;
      }>();
    // Keyed by store+relpath+hash, not just path: the D1 query above ORs together each item's
    // OWN (store, relpath, hash) condition, so a returned row only proves THAT SPECIFIC hash
    // matched. Keying by path alone would let one item's match get reused by a sibling item in
    // the same batch requesting a DIFFERENT hash for the same path (e.g. a collector scan racing
    // a local rewrite), wrongly reporting the changed file as present.
    const have = new Map(rows.results.map((r) => [`${r.store}\n${r.relpath}\n${r.content_hash}`, r]));
    // A matched D1 row is not proof the raw bytes still exist OR are still correct — head every
    // match in this chunk (bounded to ≤33, parallel) and compare R2's own sha256 checksum
    // (present because every PUT through this API passes {sha256}) against the row's
    // content_hash. A missing object, a missing checksum (shouldn't happen via our PUT path, but
    // conservative if it ever does), or a mismatch (e.g. the object was overwritten/replaced by
    // something outside this API) are all reported missing — a matching D1 row alone no longer
    // proves the right bytes are actually sitting in R2. That's what makes the collector re-send
    // the bytes; the upload path's same-hash restore logic then repairs R2 from that re-upload.
    const heads = await Promise.all(
      [...have.values()].map(async (r): Promise<[number, boolean]> => {
        const obj = await env.RAW.head(r.r2_key);
        // objectSha256 reads R2's native checksum, present on every canonical object (simple PUT and
        // the multipart staging->canonical copy both use put({sha256})) — a real verification of the
        // stored bytes. A missing object, a legacy no-checksum object, or a mismatch all report missing.
        return [r.id, objectSha256(obj) === r.content_hash];
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
      // The raw bytes are already in R2 — a matching hash means present, but the row still needs a
      // re-enqueue in two cases the collector can't see (it got "present" and won't re-upload):
      //  - a non-terminal parse_state (lost/exhausted queue message) that never finished indexing;
      //  - a TERMINAL legacy row whose identity we just restamped (same as the PUT same-hash branch)
      //    — otherwise a 'skipped' history.jsonl row with NULL harness/session_id stays unindexed.
      const restamped = await restampIfStale(row, row.store, row.relpath, identity.machineId, env);
      if (detect(row.store, row.relpath, identity.machineId).kind === 'other') {
        await markKnownOtherSkipped(row.id, row.content_hash, env);
        continue;
      }
      // markPendingAndEnqueue applies the centralized fresh-reservation gate (round 15): a fresh 'reserved'
      // row is left to its owner's recover; a stale one heals. Same reasoning as the same-hash PUT branch.
      if (restamped || !TERMINAL_PARSE_STATES.has(row.parse_state)) {
        await markPendingAndEnqueue(row, 'upload', env);
      }
    }
  }
  return Response.json({ missing });
}

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}
