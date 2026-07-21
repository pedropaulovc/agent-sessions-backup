import { detect } from './detect';
import type { NormalizedSession } from './normalize';
import { SINGLE_SESSION_HARNESSES, parseObject } from './parse';
import { parseExportArchive } from './parsers/export-inbox';
import { isFreshReservation, markPendingAndEnqueue, reservationCutoffIso } from '../queue';
import { deriveProjectName } from '../project-name';

interface FileRow {
  id: number;
  machine_id: string;
  store: string;
  relpath: string;
  r2_key: string;
  size: number;
  mtime: string | null;
  harness: string | null;
  session_id: string | null;
  content_hash: string;
  parse_state: string;
  reserved_at: string | null;
  reserved_by: number | null;
  reservation_generation: number;
}

/** Thrown by an export parse to signal a RETRYABLE (transient) failure: any throw out of an export parse
 * is a D1/queue outage, never a content error (bad ZIP / shape drift take the failExportFile+return path,
 * never throw). The file must NOT be marked 'error' — archive rows have session_id NULL, so the generic
 * catch can't reconcile their sessions, and an 'error' export with stale 'ready' rows is terminal (files/
 * check only re-enqueues NON-terminal rows). Every site that raises this first forces the file back to
 * 'pending' (hash-guarded); the consumer catch recognizes the sentinel and just retries the same message.
 * A send-late continuation is the exception: its owner is already correctly 'parsed', so a transient fan-out
 * read raises this sentinel without changing owner state and retries only that continuation. An owner-tagged
 * reservation delivery that cannot re-enqueue behind its still-running owner is the other exception: it stays
 * reserved and retries the exact capability instead of falling into the generic file-error path. */
class ExportRetry extends Error {}

export async function consumeParseBatch(batch: MessageBatch<ParseMessage>, env: Env): Promise<void> {
  // The ~1000-per-invocation D1 cap is shared across the WHOLE batch (wrangler max_batch_size:5), so we
  // run a single INVOCATION-LEVEL budget across every message — export AND normal transcript — not just a
  // one-export-slice guard: an export slice plus a few chatty normal writes could otherwise still breach
  // the cap. Each parseOne reports the work it did; we accumulate it, and once the invocation crosses
  // INVOCATION_SUBREQUEST_BUDGET we DEFER every remaining message (ack + re-enqueue a fresh copy) rather
  // than run it here. Exports RESERVE their worst-case budget up front (on ATTEMPT, before parseOne), so a
  // slice that throws after doing work still can't free the invocation for a second heavy op — this
  // subsumes the round-2 one-export-slice-per-invocation rule. Deferral is NOT a failure: a fresh
  // re-enqueue resets the delivery-attempt budget (retry() would burn max_retries:3 and could DLQ a
  // message that never failed); if the re-send throws we fall back to retry() so nothing is lost. Progress
  // is guaranteed — each invocation runs at least the first message.
  let invocationSpent = 0;
  let deferRest = false;
  for (const msg of batch.messages) {
    if (deferRest) {
      await deferMessage(msg, env);
      continue;
    }
    const isExport = isExportArchiveKey(msg.body.r2_key);
    if (isExport) {
      // Reserve the export's worst-case budget on ATTEMPT. If that reservation would overflow the
      // invocation AND at least one message already did work this invocation (invocationSpent > 0), DEFER
      // the current export too — running its slice after prior D1 work could breach the ~1000-subrequest
      // cap. The invocationSpent > 0 guard is mandatory: an export whose reservation alone crosses the cap
      // must still run when it's the first to act this invocation, or it would defer forever (livelock).
      if (invocationSpent > 0 && invocationSpent + EXPORT_QUERY_BUDGET >= INVOCATION_SUBREQUEST_BUDGET) {
        await deferMessage(msg, env);
        deferRest = true;
        continue;
      }
      invocationSpent += EXPORT_QUERY_BUDGET; // reserve worst-case on ATTEMPT, before any work
      if (invocationSpent >= INVOCATION_SUBREQUEST_BUDGET) deferRest = true;
    } else {
      // Same reserve-on-attempt for a NORMAL transcript (Codex round 8): the invocation budget used to be
      // charged only AFTER parseOne returned, so a chatty transcript could enter the write path with almost
      // no headroom and issue hundreds of D1 batches past the cap the guard exists to enforce. Reserve
      // NORMAL_RESERVE up front; if that would cross the cap AND work already ran this invocation, DEFER.
      // The invocationSpent > 0 guard is the same first-message livelock exception exports use — the
      // first/sole message of an invocation must always run, or a single reservation over the cap would
      // defer it forever. The reservation is reconciled to the actual cost on return below.
      if (invocationSpent > 0 && invocationSpent + NORMAL_RESERVE >= INVOCATION_SUBREQUEST_BUDGET) {
        await deferMessage(msg, env);
        deferRest = true;
        continue;
      }
      invocationSpent += NORMAL_RESERVE; // reserve worst-case on ATTEMPT, before any work
    }
    try {
      const spent = await parseOne(msg.body, env);
      msg.ack();
      if (!isExport) {
        invocationSpent += spent - NORMAL_RESERVE; // release the up-front reserve, charge the ACTUAL cost
        if (invocationSpent >= INVOCATION_SUBREQUEST_BUDGET) deferRest = true;
      }
    } catch (e) {
      // This message threw after an unknown amount of D1 work (a chatty transcript can throw well past
      // writeSession's batches; parseOne returns no count on the throw path). Charge the invocation
      // conservatively by DEFERRING the rest of the batch BEFORE any branch/continue below — a failed heavy
      // or stale write must not be followed by more D1 work that re-hits the cap (Codex round 5 finding 3 /
      // round 6 finding 3: the guarded-stale `continue` used to exit before the defer flag was set).
      deferRest = true;
      if (e instanceof ExportRetry) {
        // A retryable transient failure. Export raising sites already forced the file back to 'pending';
        // an owner-tagged reservation deferral deliberately leaves it 'reserved'. Do NOT markError in either
        // case: retry the exact message/capability. Even if retries exhaust to the DLQ, the non-terminal row
        // remains visible to pipeline-stuck alerts and the files/check healing path.
        msg.retry();
        continue;
      }
      console.log(JSON.stringify({ event: 'parse.error', file_id: msg.body.file_id, error: String(e) }));
      // Guarded by content_hash (when the message carries one): a throw partway through parseOne
      // for a stale message must not clobber a row a re-upload has already moved on from — the
      // fresh message owns that row now and is responsible for its own success/failure outcome.
      // Without this guard, a slow/retried stale delivery throwing (e.g. r2_object_missing on an
      // R2 key a re-upload since overwrote) could flip a row the fresh parse already marked
      // 'parsed' back to 'error', or race the fresh parse's own writes.
      const guarded = msg.body.content_hash !== undefined;
      const errStmt = env.DB.prepare(
        `UPDATE files SET parse_state = 'error', parse_error = ?2 WHERE id = ?1${guarded ? ' AND content_hash = ?3' : ''}`,
      );
      const errUpdate = await (guarded
        ? errStmt.bind(msg.body.file_id, String(e).slice(0, 2000), msg.body.content_hash)
        : errStmt.bind(msg.body.file_id, String(e).slice(0, 2000))
      ).run();
      if (guarded && (errUpdate.meta?.changes ?? 0) === 0) {
        // The row has already moved on — the fresh message owns it. Skip the session-error flip
        // and recovery-kick below entirely: they exist to recover from THIS file's failure, and
        // this file's failure is stale (its bytes/row no longer describe current reality).
        msg.retry();
        continue;
      }
      // Otherwise a failed reparse leaves index_state='parsing' forever and /api/v1/status never
      // surfaces the error. No-op when the file has no session_id (nothing was ever indexed), and
      // — guarded — when a DIFFERENT file is already the session's canonical: that means some
      // other valid copy already indexed successfully and remains the source of truth, so this
      // failure (of a copy that was never canonical, or has since been superseded) must not
      // clobber a perfectly good session back to 'error'.
      //
      // Deliberately does NOT clear the session's old blocks/blocks_fts/usage rows here (unlike
      // the zero-turn branch in parseOne, which DOES clear them). The two cases differ: zero-turn
      // means we successfully read the new content and know it's genuinely empty; a throw here
      // (the flagship case is r2_object_missing) means we could NOT read the raw content at
      // all — the existing index rows may be the ONLY surviving trace of the session. This
      // system is preservation-first: serving stale-but-labeled (index_state='error') data beats
      // permanently destroying the last copy of a session that a transient/permanent read
      // failure happened to hit. search()/getSession()/listSessions() all surface index_state in
      // their response shape, so callers can filter or flag on it themselves.
      const fileRow = await env.DB.prepare('SELECT session_id FROM files WHERE id = ?1 AND session_id IS NOT NULL')
        .bind(msg.body.file_id)
        .first<{ session_id: string }>();
      if (fileRow) {
        const updated = await env.DB.prepare(
          `UPDATE sessions SET index_state = 'error'
           WHERE session_id = ?1 AND (canonical_file_id IS NULL OR canonical_file_id = ?2)
           RETURNING session_id`,
        )
          .bind(fileRow.session_id, msg.body.file_id)
          .first<{ session_id: string }>();
        // A recovery-kicked duplicate (reason: 'recover') failing does NOT match the guard above:
        // canonical_file_id still points at the session's ORIGINAL canonical file until some
        // recovery attempt actually succeeds, so this predicate would otherwise halt the chain the
        // moment a second (or third...) candidate also throws. Continue unconditionally for
        // 'recover' messages instead. Termination is guaranteed — each failed attempt flips exactly
        // one file to 'error', and chooseRecoveryCandidate excludes error/skipped files, so the
        // candidate pool strictly shrinks every time.
        if (updated || msg.body.reason === 'recover') {
          // This file was (or would have been) canonical for the session, or is itself a recovery
          // attempt that just failed — either way, look for another valid duplicate (even a
          // previously-superseded one, freed up now that this file is 'error') and kick its parse
          // so the session can recover automatically instead of staying errored until a manual
          // reindex. Runs on every retry attempt too; harmless — the hash-guarded markParsed and
          // idempotent writeSession absorb duplicate recovery attempts. markPendingAndEnqueue
          // flips the candidate to 'pending' before sending — chooseRecoveryCandidate can return a
          // 'superseded' (terminal) file, and leaving it terminal while its recovery message is
          // in flight would strand the session if that message is ever dropped/dead-lettered:
          // files/check only re-enqueues non-terminal rows.
          const recovery = await chooseRecoveryCandidate(fileRow.session_id, msg.body.file_id, env);
          // force: this recover kick IS the recovery mechanism, not a redundant heal — re-parse the chosen
          // candidate even if it happens to carry a fresh reservation (round 15, 3608955878 centralized gate).
          if (recovery) await markPendingAndEnqueue(recovery, 'recover', env, { force: true });
        }
      }
      // This message threw AFTER doing an unknown amount of D1 work (a chatty transcript can throw well
      // past writeSession's delete/insert batches), and parseOne returns no subrequest count on the throw
      // path — so we can't charge the invocation budget precisely. Conservatively DEFER the rest of the
      // batch: a failed heavy write must not be followed by more D1 work that re-hits the ~1000-subrequest
      msg.retry();
    }
  }
}

/** Defer a message to a later invocation without burning its delivery-attempt budget: ack + re-enqueue a
 * fresh copy (a fresh message resets max_retries). Fall back to retry() only if the re-send itself throws,
 * so the message is never dropped. */
async function deferMessage(msg: Message<ParseMessage>, env: Env): Promise<void> {
  try {
    await env.PARSE_QUEUE.send(msg.body);
    msg.ack();
  } catch {
    msg.retry();
  }
}

/** Cheap export-archive detection straight from the queue message's r2 key (raw/{machine}/{store}/
 * {relpath...}) — lets consumeParseBatch reserve the one-export-slice-per-invocation budget BEFORE any
 * DB read or parse, so a slice that throws after doing work can't free the budget for a second slice. */
function isExportArchiveKey(r2Key: string): boolean {
  const parts = r2Key.split('/');
  if (parts.length < 4 || parts[0] !== 'raw') return false;
  return detect(parts[2]!, parts.slice(3).join('/')).kind === 'export-archive';
}

// parseOne returns the approximate D1 SUBREQUEST count it issued (each .first / .run / db.batch is one),
// so consumeParseBatch can hold a single invocation-wide budget across every message in the batch (see
// INVOCATION_SUBREQUEST_BUDGET). The count is dominated by writeSession / parseExportInto; the surrounding
// lookups/guards are folded in as small fixed terms — precision isn't needed, the budget is a coarse gate.
async function parseOne(job: ParseMessage, env: Env): Promise<number> {
  const file = await env.DB.prepare(
    'SELECT id, machine_id, store, relpath, r2_key, size, mtime, harness, session_id, content_hash, parse_state, reserved_at, reserved_by, reservation_generation FROM files WHERE id = ?1',
  )
    .bind(job.file_id)
    .first<FileRow>();
  if (!file) return 1;

  // Consume-time reservation guard (round 15, 3608955874): a row a live export cleanup has FRESH-reserved
  // must be re-parsed ONLY by that cleanup's owner-tagged send-late message. A redundant queued 'upload'/'files-check'/
  // 'reindex' message — one that raced the reserve flip (which now also flips 'pending' siblings) — would
  // otherwise re-parse the sibling as an ordinary upload, mark it 'parsed' behind the reserve cursor, and let
  // it escape the send-late set while the owner's delete removes the shared session. No-op such a message; the
  // reservation owner's replacement re-parses the row later. A changed-bytes re-upload stays reserved but
  // upgrades its stored intent/hash to upload, so it also waits for the ordering-safe owner delivery.
  const ownsReservation =
    file.parse_state === 'reserved' &&
    job.reservation_owner !== undefined &&
    job.reservation_owner === file.reserved_by &&
    job.reservation_generation !== undefined &&
    job.reservation_generation === file.reservation_generation;
  const reservationTagged = job.reservation_owner !== undefined || job.reservation_generation !== undefined;
  // An owner-tagged message is a capability for one exact reservation generation. Once that reservation
  // has been refreshed, healed, or explicitly released for a restart, never let the old capability fall
  // through merely because the row is no longer fresh (3609611903).
  if (reservationTagged && !ownsReservation) {
    console.log(JSON.stringify({ event: 'parse.skipped_stale_reservation_delivery', file_id: file.id, reason: job.reason }));
    return 1;
  }
  if (!ownsReservation && isFreshReservation(file)) {
    console.log(JSON.stringify({ event: 'parse.skipped_fresh_reservation', file_id: file.id, reason: job.reason }));
    return 1;
  }
  const reservationDelivery: ReservationDelivery = ownsReservation
    ? { owner: job.reservation_owner!, generation: job.reservation_generation! }
    : null;

  // Reject a stale message at the source, before any R2 read or write: if this row's
  // content_hash has already moved on from what this message was enqueued for, a re-upload beat
  // this delivery and a fresher message already owns the current bytes. Catching this here — not
  // only in the per-branch hash-guarded markParsed calls below — matters most for the main parse
  // path, where writeSession() is otherwise unconditional: without this early return, a stale
  // parse could replace a session's blocks/FTS/usage with OLD content and flip index_state back
  // to 'ready' BEFORE markParsed ever notices the mismatch, serving stale search/session reads
  // even while the files row correctly stays 'pending'. The hash-guarded markParsed calls below
  // stay in place as defense in depth (e.g. a mismatch introduced mid-parse, after this check
  // already passed). Messages enqueued before content_hash existed carry it as undefined and
  // skip this check entirely, same as every other hash guard in this file.
  if (job.content_hash !== undefined && file.content_hash !== job.content_hash) return 2;

  // A changed upload refreshes its owner-tagged message immediately, including while the owner's cleanup is
  // still deleting. Keep that message behind the ordering barrier: only a parsed (successful cleanup) or error
  // (corrupt cleanup) owner has completed its reserve/delete window. Re-enqueueing retains the exact capability
  // and places it behind the owner's already-queued continuation (3609651684).
  if (reservationDelivery !== null) {
    const owner = await env.DB.prepare('SELECT parse_state FROM files WHERE id = ?1')
      .bind(reservationDelivery.owner)
      .first<{ parse_state: string }>();
    if (owner !== null && owner.parse_state !== 'parsed' && owner.parse_state !== 'error') {
      try {
        await env.PARSE_QUEUE.send(job);
      } catch (e) {
        console.log(JSON.stringify({ event: 'parse.reservation_owner_defer_retry', file_id: file.id, owner: reservationDelivery.owner, error: String(e) }));
        throw new ExportRetry('reservation-owner deferral send transient failure');
      }
      console.log(JSON.stringify({ event: 'parse.deferred_reservation_owner', file_id: file.id, owner: reservationDelivery.owner }));
      return 3;
    }
  }

  const det = detect(file.store, file.relpath, file.machine_id);

  if (det.kind === 'subagent-meta') {
    await linkSubagentMeta(file, env);
    await markParsed(file.id, env, 'parsed', undefined, undefined, job.content_hash);
    return 4;
  }
  if (det.kind === 'export-archive') {
    // A 'send-late' continuation (round 15, 3608955881) resumes ONLY the recover fan-out from the carried
    // cursor — the owner is already terminal 'parsed', so there is no R2 read, no write, no cleanup to redo.
    if (job.cleanup_phase === 'send-late') {
      try {
        return 2 + (await fanOutRecover(file, env, job.reason, job.content_hash ?? file.content_hash, 0, job.send_cursor ?? 0));
      } catch (e) {
        console.log(JSON.stringify({ event: 'parse.export.send_late_retry', file_id: file.id, cursor: job.send_cursor ?? 0, error: String(e) }));
        throw new ExportRetry('send-late fan-out transient failure');
      }
    }
    // The one-export-slice-per-invocation reservation is applied by consumeParseBatch before we get here;
    // the actual per-invocation subrequest count comes back from parseExportInto for the batch budget.
    //
    // PIN the guard hash (Codex round 8): a LEGACY message enqueued before ParseMessage carried
    // content_hash arrives with job.content_hash undefined. Propagating that undefined through a multi-slice
    // export parse disables EVERY per-slice recheck, cleanup guard and markParsed guard for the whole parse,
    // so a mid-parse re-upload could resume an old-ZIP offset against new bytes or run unguarded cleanup — a
    // real silent gap. Fall back to the file row's hash as loaded at THIS parse's start (file was read once
    // above, before any R2 read), so continuations are pinned to the bytes this parse actually read. NOT a
    // fresh read at send time, which would pin to post-re-upload bytes and defeat the guard. Only the first
    // legacy slice is unguarded; every continuation it enqueues carries this hash.
    return 2 + (await parseExportInto(
      file,
      env,
      job.reason,
      job.content_hash ?? file.content_hash,
      job.offset ?? 0,
      job.cleanup_cursor,
      job.cleanup_phase,
      job.kick_cursor,
      job.reservation_count ?? 0,
      reservationDelivery,
    ));
  }
  if (!det.sessionId || !SINGLE_SESSION_HARNESSES.has(det.harness)) {
    await markParsed(file.id, env, 'skipped', undefined, undefined, job.content_hash);
    return 2;
  }

  const canonical = await chooseCanonical(det.sessionId, env);
  // Only supersede this file in favor of an ALREADY-PARSED canonical. If the preferred copy is
  // still pending (or errored), superseding this valid duplicate now — before the preferred copy
  // has actually proven it can parse — would ack this message and, if the preferred copy then
  // fails permanently, leave the session unindexed with no valid copy left to recover it from.
  // Parse this file anyway; if a higher-priority copy parses successfully later, it supersedes
  // this one at that point (see the supersede-losers step below). With max_concurrency: 1 on the
  // parse queue (wrangler.jsonc) there's no other consumer running concurrently, so this and the
  // post-parse recheck below only matter across retries/redeliveries of THIS message, not a
  // concurrent writer — the canonical decision can still go stale between a retry attempt and an
  // intervening successful delivery of another copy.
  if (canonical !== null && canonical.id !== file.id && canonical.parseState === 'parsed') {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE id = ?1").bind(file.id).run();
    return 3;
  }

  const obj = await env.RAW.get(file.r2_key);
  if (!obj) throw new Error(`r2_object_missing:${file.r2_key}`);

  const parsed = await parseObject(det.harness, det.sessionId, obj);
  if (det.parentSessionId) parsed.parentSessionId = det.parentSessionId;

  if (parsed.turns.length === 0) {
    // Every line was malformed or an unsupported envelope shape — nothing indexable came out of
    // this parse. Marking it 'parsed' anyway would let it win canonical selection (by priority)
    // over a lower-priority duplicate that DID produce a real session, permanently losing that
    // session's content with no automatic recovery path. Neither 'error' nor 'skipped' is
    // canonical-eligible (chooseCanonical deprioritizes both below), so a valid duplicate — if
    // one exists — remains free to become or stay canonical.
    const state = parsed.stats.parseErrorLines > 0 ? 'error' : 'skipped';
    const parseError = state === 'error' ? `empty_parse:${parsed.stats.parseErrorLines}/${parsed.stats.lines} lines malformed` : null;
    const { updated } = await markParsed(file.id, env, state, file.size, parseError, job.content_hash);
    // A re-upload can change this row's content_hash while this parse was reading the OLD R2
    // body. If the row no longer matches the hash this message was enqueued for, a fresher
    // message already re-enqueued the new content — leave everything else alone.
    if (!updated) return 4;

    if (det.sessionId) {
      const session = await env.DB.prepare('SELECT canonical_file_id FROM sessions WHERE session_id = ?1')
        .bind(det.sessionId)
        .first<{ canonical_file_id: number | null }>();
      if (session?.canonical_file_id === file.id) {
        // This file WAS the session's canonical, and the search index still reflects its OLD,
        // actually-parseable content — now stale, since the current bytes produced nothing.
        // Clear the derived rows (keep the sessions row itself so facets/raw access still
        // resolve) and mark the session errored.
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
          ).bind(det.sessionId),
          env.DB.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(det.sessionId),
          env.DB.prepare('DELETE FROM usage WHERE session_id = ?1').bind(det.sessionId),
          env.DB.prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1").bind(det.sessionId),
        ]);
      }
      // A recovery-kicked duplicate (reason: 'recover') parsing to zero turns instead of throwing
      // doesn't match the canonical check above: canonical_file_id still points at the session's
      // ORIGINAL canonical file until some recovery attempt actually succeeds — same reasoning as
      // the catch path's 'recover' continuation. The session's index_state is already 'error'
      // from that original failure, so there's nothing of THIS file's to clear; just continue the
      // chain. Termination is guaranteed the same way: chooseRecoveryCandidate excludes
      // error/skipped files, and this parse just flipped this one to error/skipped above.
      if (session?.canonical_file_id === file.id || job.reason === 'recover') {
        // If a valid duplicate exists (even a previously-superseded one — this file's demise
        // frees it up again), kick its parse so the session recovers automatically instead of
        // staying errored until a manual reindex. See the catch path above for why
        // markPendingAndEnqueue (not a raw send) matters: the candidate can be terminal
        // ('superseded'), and it must not stay that way while its recovery message is in flight.
        const recovery = await chooseRecoveryCandidate(det.sessionId, file.id, env);
        // force: the recover kick IS the recovery mechanism (round 15, 3608955878) — see the catch path above.
        if (recovery) await markPendingAndEnqueue(recovery, 'recover', env, { force: true });
      }
    }
    return 10;
  }

  // The sibling .meta.json may have already been parsed (and found no sessions row yet,
  // see linkSubagentMeta below) — read it directly so meta-before-transcript ordering
  // doesn't lose the link. Transcript-before-meta is covered by linkSubagentMeta below.
  if (det.kind === 'subagent') {
    const meta = await readSiblingMeta(file.r2_key, env);
    if (meta?.toolUseId) parsed.parentToolUseId = meta.toolUseId;
  }

  // The parse queue runs with max_concurrency: 1 (wrangler.jsonc), so there's no other consumer
  // executing concurrently — this recheck is no longer closing a live concurrent-writer race.
  // What it still covers: this exact message being retried (e.g. after a transient failure past
  // this point on a previous attempt) with another, better copy having successfully delivered
  // and completed in between — the pre-parse check at the top of this function only reflects
  // state as of THIS attempt's start, which can be stale by the time a retry reaches here.
  // Recheck immediately before writeSession, but against the best ALREADY-PARSED candidate, not
  // chooseCanonical()'s single preferred row — that row can be merely 'pending' (e.g. A pending
  // at priority 0, B parsed and canonical at priority 1): chooseCanonical returns A (better
  // priority, regardless of state), so a naive `.parseState === 'parsed'` check on IT would miss
  // that B is the best PROVEN copy and let a lower-priority C clobber B anyway. chooseBestParsed
  // only considers 'parsed' rows, with this file folded into the same ranking, so it correctly
  // says "no" both when nothing beats this file AND when this file (not yet parsed) is itself the
  // best of the bunch (e.g. better-priority A parsing after worse-priority B already did — A must
  // proceed and later supersede B, not supersede itself).
  const outranking = await chooseBestParsed(det.sessionId, file.id, env);
  if (outranking !== null) {
    await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE id = ?1").bind(file.id).run();
    return 5;
  }

  // Recheck immediately before the index_state flip + writeSession: everything from R2.get()
  // through chooseBestParsed above is async and can take a while (large transcripts, D1
  // round-trips), so a re-upload can land at any point in that window. Catching it here — as
  // close to the write as the code structure allows — narrows, but per the belt-and-braces check
  // after writeSession below, doesn't have to fully close, the remaining gap.
  if (job.content_hash !== undefined) {
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(file.id)
      .first<{ content_hash: string }>();
    if (recheck?.content_hash !== job.content_hash) return 6;
  }

  await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(det.sessionId).run();
  const wrote = await writeSession(parsed, file, env);
  // Guarded by content_hash: if a re-upload changed this row's hash while writeSession above was
  // running off the OLD R2 body, don't claim 'parsed' for content that's no longer current — the
  // newer upload already enqueued its own fresh parse. The stale write to sessions/blocks/usage
  // above is superseded moments later when that fresh parse completes (writeSession is a full
  // delete+reinsert per session_id), so it's a harmless transient rather than a lasting error.
  const { updated } = await markParsed(file.id, env, 'parsed', file.size, undefined, job.content_hash);
  if (!updated) {
    // The recheck above passed, but the row moved on during writeSession itself (R2 read /
    // insert-heavy write can take a while). writeSession unconditionally just wrote this file's
    // OLD content and flipped index_state to 'ready' (see writeSession's ON CONFLICT clause) —
    // belt-and-braces: flip it back to 'parsing' so the session doesn't advertise stale content
    // as ready while the fresh message (which owns this row now) does its own rewrite. Safe to
    // do unconditionally: the parse queue runs with max_concurrency: 1 (wrangler.jsonc), so the
    // fresh message's own parseOne cannot be running concurrently with this one — it hasn't had
    // a chance to write its own 'ready' yet, so there's nothing legitimate to clobber here.
    await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(det.sessionId).run();
    return 8 + wrote;
  }
  // The recheck above already proved nothing PARSED outranks this file, so it's safe to claim the
  // supersede-others role unconditionally here (max_concurrency: 1 means nothing else could have
  // become 'parsed' in between). A worse-priority file that wrote because the preferred copy was
  // still unparsed must not claim that role — the preferred copy supersedes this one itself once
  // IT completes and runs its own recheck; that's exactly the case the recheck above filters out.
  await env.DB.prepare("UPDATE files SET parse_state = 'superseded' WHERE session_id = ?1 AND id != ?2 AND parse_state = 'parsed'")
    .bind(det.sessionId, file.id)
    .run();

  console.log(
    JSON.stringify({
      event: 'parse.done',
      file_id: file.id,
      session: det.sessionId,
      harness: det.harness,
      turns: parsed.turns.length,
      lines: parsed.stats.lines,
      parse_error_lines: parsed.stats.parseErrorLines,
      skipped: parsed.stats.skippedLineTypes,
    }),
  );
  return 11 + wrote;
}

/**
 * Ingest an official-export ZIP: fan it out into per-conversation sessions. The archive itself
 * is not a single session (files.session_id stays NULL, so it never enters canonical dedupe), and
 * export only BACKFILLS — a conversation already owned by a live CDP capture (chatgpt-web/
 * claude-web store) is left untouched, so re-running an old export can't overwrite fresher
 * captured content. A conversation captured LATER by CDP still wins automatically: its own file
 * (session_id set) becomes canonical and its writeSession overwrites the export-written row.
 */
/**
 * Fail an export file the preservation-first way: mark the file 'error' (hash-guarded), and if we
 * still own the row, flip every session it is canonical for to index_state='error' (their raw ZIP
 * can no longer reconstruct them — loadNormalized/raw return null), then kick the sibling-archive
 * recovery so an overlapping export copy can re-claim any of them. Shared by the corrupt/invalid
 * path and the missing-R2-object path; both leave archive rows (files.session_id NULL) that the
 * generic consumer catch can't flip on its own.
 */
// files.parse_state flips (failExportFile's owned-session errors; the cleanup RESERVE phase's sibling
// 'pending' reservations) go out in db.batch chunks of this many statements — one subrequest per chunk
// (mirrors writeSession's 90-row INSERT batching), keeping a flip over thousands of rows comfortably under
// the ~1000 subrequest cap.
const FLIP_BATCH_CHUNK = 90;

async function failExportFile(
  file: FileRow,
  env: Env,
  contentHash: string | undefined,
  errorLabel: string,
  msgReason: ParseMessage['reason'],
  kickCursor: number,
  reservationCount: number,
  reservationDelivery: ReservationDelivery,
): Promise<number> {
  let spent = 0;
  const owned = await env.DB.prepare('SELECT session_id FROM sessions WHERE canonical_file_id = ?1').bind(file.id).all<{ session_id: string }>();
  spent += 1;

  // FLIP-EARLY (round 12): if this corrupt file owned any conversations, RESERVE the store's 'parsed'
  // siblings BEFORE stamping 'error' — via the SAME paged, batched, hash-pinned reserveSiblings primitive as
  // the cleanup path (recover from ANY machine: export rows carry session_id NULL and conversation ids are
  // globally unique per account). This replaces the old unbounded `for (sibling) markPendingAndEnqueue` loop
  // (2 subrequests/sibling) that, running AFTER markParsed('error'), would breach the cap for a store with
  // many siblings, throw, and — because the retry found the file already 'error' → early-returned — never
  // complete the fan-out. Stamping 'error' only AFTER reservation completes makes that trap structurally
  // impossible: a retry re-enters with the file NOT yet 'error' and resumes the flips at kick_cursor. Same
  // flip-early invariant as the round-11 cleanup success path.
  if (owned.results.length > 0) {
    // Serialize per store (round 14): the corrupt-path fan-out honors the same defer-on-contention as the
    // cleanup path. Only on the INITIAL entry (kickCursor === 0) — a reserve continuation already owns the
    // store, so it must resume, not re-defer. If another cleanup holds the store, re-enqueue this corrupt
    // parse (no kick_cursor) with backoff and stop WITHOUT marking 'error' (nothing mutated).
    if (kickCursor === 0) {
      const contended = await anotherCleanupHoldsStore(file, env);
      spent += 1;
      if (contended) {
        try {
          await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason: msgReason, content_hash: contentHash, ...reservationFields(reservationDelivery) });
        } catch {
          await forcePending(file, env, contentHash, reservationDelivery);
          console.log(JSON.stringify({ event: 'parse.export.error_defer_send_failed', file_id: file.id }));
          throw new ExportRetry('failExportFile contention defer send failed');
        }
        console.log(JSON.stringify({ event: 'parse.export.error_deferred', file_id: file.id }));
        return spent;
      }
    }
    let expectedReservations = reservationCount;
    if (kickCursor > 0) {
      // Corrupt-archive reservation can span the same long queue windows as successful cleanup. Refresh the
      // pages already reserved before advancing the cursor; otherwise files/check may heal the prefix after
      // one hour and the eventual error fan-out can no longer recover sessions from it (3609060889).
      const refreshed = await refreshOwnedReservations(file, env);
      spent += 1;
      if (refreshed < expectedReservations) {
        // Some or all of the prefix was reclaimed before this continuation resumed. Release EVERY survivor
        // before restarting at page zero; otherwise the new attempt starts with reservation_count=0 while
        // silently inheriting an old prefix, and a second partial loss can satisfy the under-counted guard.
        // Released rows return to the state implied by their durable intent, and the
        // generation bump invalidates any owner-tagged delivery selected before the restart (3609611903).
        await releaseOwnedReservations(file, env);
        spent += 1;
        try {
          await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason: msgReason, content_hash: contentHash, ...reservationFields(reservationDelivery) });
        } catch {
          await forcePending(file, env, contentHash, reservationDelivery);
          throw new ExportRetry('failExportFile lost-reservation restart send failed');
        }
        console.log(
          JSON.stringify({
            event: 'parse.export.error_reservations_healed_away',
            file_id: file.id,
            kick_cursor: kickCursor,
            expected: expectedReservations,
            refreshed,
          }),
        );
        return spent;
      }
      expectedReservations = refreshed;
    }
    const r = await reserveSiblings(file, env, contentHash, kickCursor, spent);
    spent += r.spent;
    expectedReservations += r.reserved;
    if (r.superseded) return spent; // a fresher re-upload owns the file; it runs its own parse + fan-out
    if (!r.complete) {
      // Over budget mid-reservation → re-enqueue a continuation (kick_cursor advanced), STILL NOT 'error'.
      try {
        await env.PARSE_QUEUE.send({
          file_id: file.id,
          r2_key: file.r2_key,
          reason: msgReason,
          content_hash: contentHash,
          kick_cursor: r.kickCursor,
          reservation_count: expectedReservations,
          ...reservationFields(reservationDelivery),
        });
      } catch {
        await forcePending(file, env, contentHash, reservationDelivery);
        console.log(JSON.stringify({ event: 'parse.export.error_reserve_send_failed', file_id: file.id, kick_cursor: r.kickCursor }));
        throw new ExportRetry('failExportFile reserve continuation send failed');
      }
      console.log(JSON.stringify({ event: 'parse.export.error_reserve', file_id: file.id, kick_cursor: r.kickCursor, done: false }));
      return spent;
    }
  }

  // Reservation complete (or nothing to recover) → NOW stamp the file 'error' (hash-guarded).
  const { updated } = await markParsed(file.id, env, 'error', file.size, errorLabel, contentHash);
  spent += 1;
  if (!updated) return spent; // a fresher re-upload already owns this row — its message handles the state
  // Flip every owned session to 'error' in db.batch CHUNKS (round 9 finding 5): one subrequest per 90 rows,
  // so ~950 owned rows cost ~11 subrequests rather than one .run() each.
  for (let i = 0; i < owned.results.length; i += FLIP_BATCH_CHUNK) {
    const chunk = owned.results.slice(i, i + FLIP_BATCH_CHUNK);
    await env.DB.batch(chunk.map(({ session_id }) => env.DB.prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1").bind(session_id)));
    spent += 1;
  }
  // SEND-LATE (round 12): fan out recover messages to exactly the 'reserved' siblings via the SAME helper —
  // paged, failed sends charged to budget, aborting after EXPORT_SEND_FAILURE_LIMIT consecutive failures. A
  // reserved sibling holds a conversation this errored file owned; its recover parse re-claims it. Recheck
  // OUR hash first (round 12 finding 3608692134): a re-upload in the post-mark window means the fresh message
  // owns the file and runs its own fan-out, so skip ours (dropped 'reserved' rows heal via files/check).
  if (owned.results.length > 0) {
    let hashStillOurs = true;
    if (contentHash !== undefined) {
      const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
      spent += 1;
      hashStillOurs = recheck?.content_hash === contentHash;
    }
    if (hashStillOurs) spent += await fanOutRecover(file, env, msgReason, contentHash, spent);
  }
  console.log(JSON.stringify({ event: 'parse.export.error', file_id: file.id, error: errorLabel, owned_errored: owned.results.length }));
  return spent;
}

// An export ZIP fans out to one writeSession per conversation. Writing all of a large archive (the prod
// trigger: 783 conversations) in one consumer invocation blows the ~1000-SUBREQUESTS-per-invocation cap
// — and the original code marked the file 'parsed' AFTER an unbounded write loop, so a run that silently
// stopped short still ended 'parsed' with a partial index: a silent data gap. We slice each invocation
// and re-enqueue a continuation (offset advanced) until every conversation is written, THEN a budgeted
// CLEANUP phase drains stale sessions, and only when cleanup completes does the file mark 'parsed'. The
// slice is bounded by ACTUAL D1 SUBREQUESTS (each db.batch / .first / .run is ONE subrequest — see the
// counting-model note on writeSession), not conversation count: we accumulate writeSession's subrequest
// count against EXPORT_QUERY_BUDGET and cut the slice when it's spent. Against the ~1000 cap, an 800
// budget leaves headroom for one over-budget conversation plus the post-loop meta reads. Budgets are
// `let` so tests can dial them down (__setExportBudgetsForTest) to exercise slicing with small fixtures.
export let EXPORT_QUERY_BUDGET = 800;
export const EXPORT_MAX_CONVERSATIONS_PER_SLICE = 200;
// The per-invocation subrequest budget consumeParseBatch shares across the whole batch (export + normal).
export let INVOCATION_SUBREQUEST_BUDGET = 800;
// Worst-case subrequest reservation for a SINGLE normal (non-export) transcript, mirroring the export
// reserve-on-attempt. A normal parse writes one session; the largest real session measured (a 7,686-block
// prod claude-code transcript) costs writeSession ~89 subrequests (3 + ceil(7686/90)) plus a few detection
// reads — call it ~92. 128 covers that with headroom while staying small enough that several normal parses
// still share one invocation. Reserved before parseOne so a chatty transcript can't enter the write path
// with too little headroom and blow the ~1000 cap; the actual cost parseOne reports replaces the reserve.
export let NORMAL_RESERVE = 128;
// A single conversation estimated above this many SUBREQUESTS gets its OWN invocation (its writeSession
// can't be split), so it never rides alongside other work into the ~1000 cap. Measured max realistic
// export conversation is 304 blocks (~7 subrequests) — see the PR thread — so this is defensive.
export let EXPORT_OVERSIZED_CEILING = 700;
// Only a conversation whose subrequest cost exceeds this can't be written even alone under the ~1000 cap
// (~90k blocks — effectively unreachable). The destructive skip path is gated on this, so it never
// discards a large-but-writable conversation.
export let EXPORT_OVERSIZED_SUBREQUEST_CAP = 900;
// The cleanup sibling-recovery fan-out processes siblings in pages of this size so a store with many archive
// siblings can't spend the whole invocation budget in one unbounded fan-out (round 9 finding 4). Both passes
// page by files.id: the RESERVE phase flips 'parsed' siblings to 'reserved' (spanning reserve continuations
// when it can't fit), and the SEND-LATE pass enqueues recover messages to those 'reserved' siblings.
export let EXPORT_KICK_PAGE = 50;
// Abort the SEND-LATE recover fan-out after this many CONSECUTIVE failed queue sends — a queue outage, not a
// transient blip. Stopping bounds the subrequest spend (each attempt, success or fail, is charged); the
// siblings left 'reserved' heal via files/check. Not budget-dialed; a plain module const (exported for tests).
export const EXPORT_SEND_FAILURE_LIMIT = 5;

type ReservationDelivery = { owner: number; generation: number } | null;

function reservationFields(delivery: ReservationDelivery): Pick<ParseMessage, 'reservation_owner' | 'reservation_generation'> {
  if (delivery === null) return {};
  return { reservation_owner: delivery.owner, reservation_generation: delivery.generation };
}

/** Test-only: dial the export/invocation subrequest budgets down so slicing/cleanup/deferral can be
 * exercised with tiny fixtures instead of thousands of conversations. */
export function __setExportBudgetsForTest(o: { slice?: number; invocation?: number; ceiling?: number; cap?: number; normalReserve?: number; kickPage?: number }): void {
  if (o.slice !== undefined) EXPORT_QUERY_BUDGET = o.slice;
  if (o.invocation !== undefined) INVOCATION_SUBREQUEST_BUDGET = o.invocation;
  if (o.ceiling !== undefined) EXPORT_OVERSIZED_CEILING = o.ceiling;
  if (o.cap !== undefined) EXPORT_OVERSIZED_SUBREQUEST_CAP = o.cap;
  if (o.normalReserve !== undefined) NORMAL_RESERVE = o.normalReserve;
  if (o.kickPage !== undefined) EXPORT_KICK_PAGE = o.kickPage;
}

/** Real per-invocation SUBREQUEST cost of writeSession WITHOUT writing (each db.batch is ONE subrequest):
 * delete batch (1) + ceil(rows/90) insert batches + machine SELECT (1) + session/FTS batch (1), where
 * rows = one per block / compaction marker / usage row. Lets the export slicer preflight a conversation. */
function estimateWriteSubrequests(s: NormalizedSession): number {
  let rows = 0;
  for (const turn of s.turns) {
    rows += turn.blocks.length;
    if (turn.blocks.length === 0 && turn.compaction && turn.byteStart !== undefined && turn.byteLen !== undefined) rows += 1;
    if (turn.usage) rows += 1;
  }
  return 3 + Math.ceil(rows / 90);
}

/** True only when the current owner archive is STRICTLY newer than ours by file mtime. Equal, NULL, or
 * unparseable mtimes return false → the caller falls through to last-write-wins (see the ownership decision
 * in runExportParse). Compared as parsed timestamps rather than lexically so mixed ISO precisions can't
 * misorder. */
function isOwnerNewer(ownerMtime: string | null, ourMtime: string | null): boolean {
  if (ownerMtime === null || ourMtime === null) return false;
  const owner = Date.parse(ownerMtime);
  const ours = Date.parse(ourMtime);
  if (Number.isNaN(owner) || Number.isNaN(ours)) return false;
  return owner > ours;
}

/** Export-aware retryable wrapper around the whole parse. ANY throw out of runExportParse is a transient
 * D1/queue outage — content errors (bad ZIP / shape drift) take the failExportFile+return path and never
 * throw. Letting such a throw reach the generic consumer catch would mark a session_id-NULL archive
 * terminal 'error' with its 'ready' rows stranded and un-re-enqueueable. So on any non-sentinel throw we
 * revert THIS invocation's writes, force the file 'pending', and raise ExportRetry (round 6 findings 5/6:
 * post-write-recheck and cleanup-phase D1 throws; also covers the R2 read and pre-write recheck). `written`
 * lives here so the wrapper can revert exactly the slice this invocation wrote. */
async function parseExportInto(
  file: FileRow,
  env: Env,
  reason: ParseMessage['reason'],
  contentHash?: string,
  offset = 0,
  cleanupCursor?: string,
  cleanupPhase?: ParseMessage['cleanup_phase'],
  kickCursor?: number,
  reservationCount = 0,
  reservationDelivery: ReservationDelivery = null,
): Promise<number> {
  const written = new Set<string>();
  try {
    return await runExportParse(file, env, reason, contentHash, offset, cleanupCursor, cleanupPhase, kickCursor, reservationCount, written, reservationDelivery);
  } catch (e) {
    if (e instanceof ExportRetry) throw e; // raising site already reverted + restored retryable state; pass through
    return await raiseExportRetry(file, env, written, contentHash, e, reservationDelivery);
  }
}

async function runExportParse(
  file: FileRow,
  env: Env,
  reason: ParseMessage['reason'],
  contentHash: string | undefined,
  offset: number,
  cleanupCursor: string | undefined,
  cleanupPhase: ParseMessage['cleanup_phase'],
  kickCursor: number | undefined,
  reservationCount: number,
  written: Set<string>,
  reservationDelivery: ReservationDelivery,
): Promise<number> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) {
    // The raw ZIP is gone (e.g. a reindex after the R2 object was deleted). Do NOT throw into the
    // generic consumer catch: it flips sessions by files.session_id, which is NULL for an archive
    // row, so the sessions this ZIP is canonical for would keep a stale 'ready' state that
    // loadNormalized()/raw can no longer reconstruct. Handle it like an invalid archive instead.
    return await failExportFile(file, env, contentHash, `r2_object_missing:${file.r2_key}`, reason, kickCursor ?? 0, reservationCount, reservationDelivery);
  }
  const archive = parseExportArchive(new Uint8Array(await obj.arrayBuffer()));

  // Stale-parse guard (mirrors the single-session path): a re-upload can change this row's
  // content_hash while we were reading the OLD ZIP bytes. Recheck right before writing; if it
  // moved on, a fresher message already owns the current bytes and will do its own rewrite —
  // publishing this OLD archive's sessions now would advertise stale content as ready.
  if (contentHash !== undefined) {
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(file.id)
      .first<{ content_hash: string }>();
    if (recheck?.content_hash !== contentHash) return 2;
  }

  // A corrupt / missing-conversations.json / non-array archive is NOT a well-formed export: keep
  // whatever sessions this file owns (preservation-first) but error the file + its owned sessions,
  // so /status surfaces it instead of silently reporting the replacement as parsed. (An empty-but-
  // valid array is `valid` and falls through to normal write + cleanup, clearing what it owned.)
  if (!archive.valid) {
    return await failExportFile(file, env, contentHash, archive.error ?? 'invalid export archive', reason, kickCursor ?? 0, reservationCount, reservationDelivery);
  }

  // A NON-empty archive (recognized layout, conversations present) that parses to zero turns across
  // EVERY conversation is content-shape drift — mapping/chat_messages present but all blocks an
  // unsupported shape — not a genuinely empty export. Writing it would leave `written` empty and the
  // cleanup below would then DELETE every session this file owns, destroying good content over a
  // temporary parser gap. Treat it like an invalid archive: error the file, preserve existing
  // sessions, skip the destructive cleanup. A well-formed EMPTY array (archive.sessions.length === 0)
  // is a legitimate empty export and still falls through to clear what it owned; a MIXED archive with
  // at least one turn-bearing conversation writes normally.
  const totalTurns = archive.sessions.reduce((n, s) => n + s.turns.length, 0);
  if (archive.sessions.length > 0 && totalTurns === 0) {
    return await failExportFile(file, env, contentHash, 'export archive parsed to zero turns across all conversations (content-shape drift)', reason, kickCursor ?? 0, reservationCount, reservationDelivery);
  }

  // Session ids we actually WROTE this parse (turns > 0 and not owned by a HEALTHY live CDP
  // capture). A conversation present in the new archive but now parsing to zero turns is
  // deliberately NOT kept, so its stale rows get cleared below (same as the single-session
  // empty-parse path).
  // Process a slice of conversations starting at `offset`, bounded by BOTH the query budget (actual D1
  // work) and the conversation-count cap. `sliceEnd` is the ACTUAL position reached — the continuation
  // resumes there, not at a fixed offset+N. Any throw mid-slice (a transient D1 error) raises ExportRetry:
  // revert THIS invocation's writes and retry the same message at the same offset — never leaving a
  // half-written conversation 'ready', never reverting earlier slices a same-offset retry won't rewrite.
  const maxEnd = Math.min(offset + EXPORT_MAX_CONVERSATIONS_PER_SLICE, archive.sessions.length);
  let spent = 0;
  let idx = offset;
  try {
    for (; idx < maxEnd; idx++) {
      const session = archive.sessions[idx]!;
      if (session.turns.length === 0) continue; // empty conversation: consumed at zero D1 cost, cleared by cleanup
      // D1 work already done THIS invocation, EXCLUDING this conversation's own ownership lookup below — the
      // gate for the oversized cut (round 9 finding 2). `written.size` alone under-counts: a slice of many
      // healthy/oversized-skipped conversations spends real subrequests on their lookups while writing
      // nothing, so gating the cut on `written.size > 0` let a near-cap oversized conversation run after that
      // spend and breach the cap (then repeat at the same offset). `spent > 0` would over-count (this
      // conversation's own lookup), livelocking a leading oversized conversation. Snapshotting BEFORE the
      // lookup gates on prior work only, so a leading oversized conversation (spentBefore 0) still runs alone.
      const spentBefore = spent;
      const existing = await env.DB.prepare(
        `SELECT f.store, f.parse_state AS canon_state, f.mtime AS owner_mtime, s.index_state, s.canonical_file_id
         FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
      )
        .bind(session.id)
        .first<{ store: string; canon_state: string; owner_mtime: string | null; index_state: string; canonical_file_id: number }>();
      spent += 1; // the ownership lookup above
      // Skip only a HEALTHY live capture: a chatgpt-web/claude-web canonical whose index_state is
      // 'ready'. If that live session is instead 'error'/'parsing' (or absent), let this export write
      // RECOVER it — export archive rows carry files.session_id = NULL, so chooseRecoveryCandidate()
      // can never see this backfill copy, and re-skipping would strand the session empty/errored
      // despite a usable export. A later successful web reparse (canonical = its own file) overwrites
      // this export-written row again, so the live capture still wins once it is healthy.
      const healthyLiveCapture =
        existing && (existing.store === 'chatgpt-web' || existing.store === 'claude-web') && existing.index_state === 'ready';
      if (healthyLiveCapture) continue;
      // A reason='recover' parse fills GAPS: it must only CLAIM orphaned/broken sessions, never
      // clobber one already healthily owned by a DIFFERENT (e.g. newer) archive. The recover fan-out
      // re-enqueues every sibling archive without knowing WHICH conversation was lost, so an older
      // archive's stale copy of a still-healthy conversation would otherwise overwrite it. Generalize
      // the healthy-web-capture skip: skip any conversation whose live session is 'ready' and
      // canonically owned by another non-error file. An 'upload'/'reindex' parse still wins normally —
      // last-write-wins ownership is deliberate (web-ingest round 2/7/12 tests), so this stays gated on
      // reason==='recover'. (Round 9 finding 3b keeps a lost recover SEND from silently degrading a
      // recover into a files/check 'upload' reparse.)
      const healthyOtherOwner =
        existing && existing.index_state === 'ready' && existing.canonical_file_id !== file.id && existing.canon_state !== 'error';
      if (reason === 'recover' && healthyOtherOwner) continue;
      // mtime guard (round 9 finding 3a) — applies to EVERY reason, not just recover. This PR forces many
      // archives to 'pending' (ExportRetry, dropped continuations); files/check then HEALS each as reason
      // 'upload' and re-parses it. Without this, a healed OLDER archive re-executing AFTER a newer archive
      // already claimed a conversation would win on execution order alone and overwrite the newer content.
      // So skip claiming a conversation whose current owner archive is STRICTLY newer than ours (by file
      // mtime). Gate on `otherOwner`, NOT `healthyOtherOwner`: a newer archive re-uploaded mid-flight flips
      // its owned rows to 'parsing' until its parse finishes, so requiring index_state='ready' let an older
      // healed archive writeSession over a newer owner still parsing (round 11 finding 3608613136). Skip
      // regardless of the newer owner's index_state; only its being terminally 'error' (canon dead) lets us
      // reclaim. Ties and unknown (NULL/unparseable) mtimes fall through to last-write-wins: only a
      // strictly-OLDER archive displacing a strictly-newer one is the bug — a genuinely newer upload still
      // steals from older owners (web-ingest round 2/7/12 last-write-wins tests, all same-mtime, still hold).
      const otherOwner =
        existing && existing.canonical_file_id !== file.id && existing.canon_state !== 'error' && existing.index_state !== 'error';
      if (otherOwner && isOwnerNewer(existing!.owner_mtime, file.mtime)) continue;

      // Preflight the conversation's SUBREQUEST cost. writeSession is atomic per conversation (no
      // intra-conversation cursor), so a single oversized conversation can't be sliced — it must either
      // run ALONE in its own invocation, or, if it can't fit even alone, be recorded and skipped.
      const estSubreq = estimateWriteSubrequests(session);
      if (estSubreq > EXPORT_OVERSIZED_SUBREQUEST_CAP) {
        // Cannot fit under the ~1000 SUBREQUEST cap even alone (~90k blocks). Record loudly and skip
        // (preservation-first: the raw ZIP stays in R2, nothing silently dropped). Flip the existing row to
        // 'error' ONLY if THIS file owns it (round 9 finding 1): an unqualified UPDATE would flip a session
        // whose healthy canonical row belongs to ANOTHER archive — reporting good data broken while our
        // archive still marks parsed. Qualified by canonical_file_id, a row owned by another file is left
        // untouched (logged owned:false). Measured max export conversation is 304 blocks (~7 subrequests).
        const flip = await env.DB
          .prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1 AND canonical_file_id = ?2 RETURNING session_id")
          .bind(session.id, file.id)
          .first<{ session_id: string }>();
        spent += 1;
        console.log(JSON.stringify({ event: 'parse.export.oversized_conversation', file_id: file.id, session: session.id, est_subrequests: estSubreq, owned: flip !== null }));
        continue;
      }
      if (spentBefore > 0 && (estSubreq > EXPORT_OVERSIZED_CEILING || spent + estSubreq > EXPORT_QUERY_BUDGET)) {
        // Cut BEFORE writing this conversation, deferring it to the next invocation, when EITHER:
        //  - it is oversized (> CEILING) and deserves its own invocation for cap headroom; OR
        //  - its estimated cost would push THIS slice's cumulative spend past the budget (3608782615). Two
        //    sub-ceiling-but-heavy conversations (e.g. ~600 subrequests each, budget 800) otherwise both run
        //    here: the first leaves spent ~601, the second is not > CEILING so it isn't cut, and its write
        //    breaches the ~1000 cap BEFORE the post-write `spent >= budget` check — then the same-offset retry
        //    replays the identical over-budget pair forever. Cutting on the projected cumulative spend closes
        //    that deterministic overrun.
        // Both are gated on spentBefore > 0 (this conversation's own lookup excluded), so a LEADING heavy/
        // oversized conversation still runs ALONE (it fits under the CAP) rather than re-enqueuing forever.
        break;
      }

      // Track the conversations this slice commits to writing BEFORE the write: `written.size` gates the
      // oversized cut above (a leading oversized conversation must still be written) and is reported in the
      // slice/superseded logs, and it's the exact set revertSlice reverts if a write throws — including the
      // in-flight conversation whose blocks are half-rewritten. The skip-paths above (empty / healthy live
      // capture / healthy other owner) return before this line, so they never enter `written`.
      written.add(session.id);
      spent += await writeSession(session, file, env);
      // Cut once the query budget is spent — but only AFTER writing this conversation, so a single
      // over-budget conversation still makes progress alone rather than looping forever.
      if (spent >= EXPORT_QUERY_BUDGET) {
        idx++;
        break;
      }
    }
  } catch (e) {
    // A transient D1 throw mid-slice. Revert THIS invocation's writes (the in-flight conversation + this
    // slice) and retry the same message at the same offset — NOT a whole-file revert, which would strand
    // earlier slices a same-offset retry never rewrites (round 6 finding 2), and NOT a terminal 'error'.
    await raiseExportRetry(file, env, written, contentHash, e, reservationDelivery);
  }
  const sliceEnd = idx;
  const writesComplete = sliceEnd >= archive.sessions.length;

  // Post-write hash recheck (mirrors the pre-write guard, but covers the window DURING this slice's
  // writes): a re-upload landing after the pre-check but before here changed this row's bytes, so the
  // sessions we just wrote came from the OLD ZIP. Revert EVERY 'ready' row this file owns to 'parsing'
  // (not just this invocation's writes — the write phase may span invocations, so earlier slices' rows are
  // stale over the new bytes too), enqueue NO continuation and do NOT markParsed — the fresh message owns
  // the current bytes and does its own full write + cleanup. Runs on every slice AND every cleanup-phase
  // invocation, so the stale-delete guard below always sees fresh bytes.
  if (contentHash !== undefined) {
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
    if (recheck?.content_hash !== contentHash) {
      await revertOwnedReady(file, env);
      console.log(JSON.stringify({ event: 'parse.export.superseded', file_id: file.id, offset, written: written.size }));
      return spent;
    }
  }

  // Writes not yet complete: re-enqueue the WRITE continuation (offset advanced) and STOP — deliberately
  // WITHOUT markParsed and WITHOUT cleanup. The file stays 'pending' until every conversation is written,
  // so a crash, a dropped continuation, or an over-cap invocation can never leave the file 'parsed' over
  // a partially-written archive (the silent-data-gap guard). Under queue max_concurrency:1 the
  // continuation runs after this message acks, serially.
  if (!writesComplete) {
    // If the continuation can't be enqueued, let the send throw propagate to the wrapper: it reverts THIS
    // slice's writes (not earlier slices — they're valid for the current bytes, and the same-offset retry
    // rewrites this slice and re-sends), forces 'pending', and raises ExportRetry so the message retries.
    // Reverting earlier slices here would strand them, since the retry resumes at THIS offset (round 6
    // finding 2).
    await env.PARSE_QUEUE.send({
      file_id: file.id,
      r2_key: file.r2_key,
      reason,
      content_hash: contentHash,
      offset: sliceEnd,
      ...reservationFields(reservationDelivery),
    });
    console.log(
      JSON.stringify({ event: 'parse.export.slice', file_id: file.id, offset, slice_end: sliceEnd, total: archive.sessions.length, written: written.size }),
    );
    return spent;
  }

  // ── CLEANUP PHASE (budgeted + resumable, FLIP-EARLY / SEND-LATE) ─────────────────────────────────
  // Every conversation is written; now reconcile the sessions this file used to own but the archive no
  // longer contains (dropped / now-empty conversations). This is the DELETE side of the same cap the
  // write phase guards: a valid replacement archive that dropped hundreds of conversations issues one
  // delete-batch SUBREQUEST per stale session, which — done unbounded, AFTER markParsed as the old code
  // did — re-hits the ~1000-subrequest/invocation cap over an already-'parsed' file, silently leaving
  // stale sessions half-deleted. So cleanup runs as budgeted chunks (sharing THIS invocation's remaining
  // subrequest budget) over a deterministic session_id cursor, and markParsed happens ONLY once cleanup
  // fully drains. Invariant: parse_state='parsed' ⇒ every conversation written AND stale cleanup done.
  //
  // The hash recheck just above guards each cleanup invocation, so we only ever delete against bytes we
  // still own — this replaces the old "markParsed FIRST" ordering while keeping its protection (a stale
  // parse can't delete a conversation the current bytes still contain, because its recheck returns early).
  //
  // Sibling recovery is FLIP-EARLY / SEND-LATE (round 11), made explicit in durable state (round 12). Kicking
  // overlapping archives has two jobs with OPPOSITE ordering needs: the RESERVATION (durable 'reserved' state)
  // must precede the first delete so a dropped conversation always has a home to be re-claimed from; the
  // recovery MESSAGE must follow the LAST delete, because a recover parse that runs while our stale rows are
  // still owned+present would see them as healthy other-owner rows, skip them, and complete its one recovery
  // pass without re-claiming the sessions we then delete. The old flip+send-together kick violated this across
  // a multi-page fan-out (page-1 recover messages sat ahead of the cleanup continuation). So: (1) SCAN for the
  // first stale session — a clean re-parse that dropped nothing never advances past scan and never touches a
  // sibling; (2) on the first stale, RESERVE — flip every 'parsed' sibling to 'reserved' (paged by files.id,
  // hash-pinned, NO send), completing fully before any delete; a 'reserved' row is a durable reservation that
  // is its OWN marker (files/check treats it non-terminal and re-enqueues it as 'upload', SAFE because the
  // mtime guard gap-fills under every reason); (3) DELETE the stale sessions; (4) once cleanup drains and the
  // file is marked 'parsed', SEND-LATE — best-effort recover messages to exactly the 'reserved' siblings. No
  // send in the flip loop ⇒ no compensation/hash-recheck machinery.
  //
  // Two regimes per stale session:
  //  - archive.skipped === 0 (every row parsed): a GENUINE deletion — delete its derived rows + session
  //    row (matching delete+reinsert reparse semantics; raw R2 untouched). A well-formed empty array
  //    clears everything this file owned; the invalid case already returned above.
  //  - archive.skipped > 0 (a row was malformed / id renamed away): we can't match an id-less skipped row
  //    back to a prior session, so we must NOT delete (round-12's no-destructive-delete stance). Flip it
  //    to index_state='error' instead (rows kept for discoverability; state honestly says the canonical
  //    can't serve it).
  //
  // The keep-set is the WHOLE archive's non-empty conversations, not this invocation's `written` slice:
  // owned sessions include conversations written by EARLIER slices, so keying off `written` would wrongly
  // delete them. "Owned by this file AND not a non-empty conversation in the archive" is exactly stale.
  const keep = new Set(archive.sessions.filter((s) => s.turns.length > 0).map((s) => s.id));
  const CLEANUP_PAGE = 200;

  // Per-cleanup-invocation superseded recheck: a re-upload of OUR file moved its bytes on, so the sessions
  // we're about to reserve-for / delete came from the OLD ZIP. Stop, revert our 'ready' rows to 'parsing'
  // (a pure cleanup pass wrote nothing → no-op), and let the fresh parse own the whole archive.
  const supersededDuringCleanup = async (phaseLabel: string, at: string | number): Promise<boolean> => {
    if (contentHash === undefined) return false;
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
    if (recheck?.content_hash === contentHash) return false;
    await revertOwnedReady(file, env);
    console.log(JSON.stringify({ event: 'parse.export.superseded', file_id: file.id, phase: phaseLabel, at }));
    return true;
  };

  const phase: NonNullable<ParseMessage['cleanup_phase']> = cleanupPhase ?? 'scan';
  let reserved = phase === 'delete';
  // Exact number of sibling reservations this cleanup expects to own. Propagating the count lets a resumed
  // invocation detect a partially healed prefix; a boolean only detected the all-rows-lost case.
  let expectedReservations = reservationCount;

  // Round 15 (3608955877): a resumed cleanup (reserve/delete continuation) REFRESHES its reservations on entry
  // so a slow-but-live window (queue backlog can stretch it past STALE_RESERVATION_MS) is never healed out from
  // under it. If fewer rows refresh than the continuation expects, a heal reclaimed part of the prefix
  // mid-flight: do NOT delete (that would strand the healed siblings' shared sessions). Revert our 'ready'
  // rows and enqueue a plain parse, which re-reserves from a clean slate instead of retrying the stale cursor.
  if (phase === 'reserve' || phase === 'delete') {
    const refreshed = await refreshOwnedReservations(file, env);
    spent += 1;
    if (refreshed < expectedReservations) {
      await releaseOwnedReservations(file, env);
      spent += 1;
      await revertOwnedReady(file, env);
      try {
        await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: contentHash, ...reservationFields(reservationDelivery) });
      } catch {
        await forcePending(file, env, contentHash, reservationDelivery);
        throw new ExportRetry('cleanup lost-reservation restart send failed');
      }
      console.log(
        JSON.stringify({
          event: 'parse.export.reservations_healed_away',
          file_id: file.id,
          phase,
          expected: expectedReservations,
          refreshed,
        }),
      );
      return spent;
    }
    expectedReservations = refreshed;
  }

  // Resume a reservation that overflowed a prior invocation's budget ('reserve' continuation): finish
  // flipping the remaining siblings BEFORE any delete, then fall through to the delete sub-phase at the
  // carried cleanup cursor.
  if (phase === 'reserve') {
    const r = await reserveSiblings(file, env, contentHash, kickCursor ?? 0, spent);
    spent += r.spent;
    expectedReservations += r.reserved;
    if (r.superseded) return spent;
    if (!r.complete) {
      await sendCleanupContinuation(
        file,
        env,
        reason,
        contentHash,
        archive.sessions.length,
        'reserve',
        cleanupCursor ?? '',
        r.kickCursor,
        expectedReservations,
        'reserve',
        reservationDelivery,
      );
      console.log(JSON.stringify({ event: 'parse.export.reserve', file_id: file.id, kick_cursor: r.kickCursor, done: false }));
      return spent;
    }
    reserved = true; // reservation complete → delete at the carried cursor
  }

  // ── SCAN / DELETE loop ───────────────────────────────────────────────────────────────────────────
  // In the 'scan' phase (first cleanup entry) `reserved` is false, so the FIRST stale session triggers the
  // reservation — inline when it fits the remaining budget, else handed to a 'reserve' continuation — BEFORE
  // any delete. This is the round-6-finding-4 ordering in durable-'reserved'-state form: no session is
  // deleted until every overlapping sibling is at least 'reserved'. A clean re-parse (no stale) never reaches
  // the reserve branch, so it never touches a sibling.
  const cleanupGuardSql = contentHash !== undefined ? ' AND EXISTS (SELECT 1 FROM files WHERE id = ?2 AND content_hash = ?3)' : '';
  const bindCleanup = (stmt: D1PreparedStatement, sessionId: string): D1PreparedStatement =>
    contentHash !== undefined ? stmt.bind(sessionId, file.id, contentHash) : stmt.bind(sessionId);
  let cursor = phase === 'scan' ? '' : cleanupCursor ?? '';
  const recovered = new Set<string>();
  let cleanupComplete = false;
  while (spent < EXPORT_QUERY_BUDGET) {
    const page = await env.DB.prepare(
      'SELECT session_id FROM sessions WHERE canonical_file_id = ?1 AND session_id > ?2 ORDER BY session_id ASC LIMIT ?3',
    )
      .bind(file.id, cursor, CLEANUP_PAGE)
      .all<{ session_id: string }>();
    spent += 1; // the page query
    if (page.results.length === 0) {
      cleanupComplete = true;
      break;
    }
    if (await supersededDuringCleanup(reserved ? 'cleanup-delete' : 'cleanup-scan', cursor)) return spent;
    let budgetHit = false;
    for (const { session_id } of page.results) {
      if (spent >= EXPORT_QUERY_BUDGET) {
        budgetHit = true;
        break;
      }
      if (keep.has(session_id)) {
        cursor = session_id; // advance past a KEPT row (decided)
        continue;
      }
      // First STALE session: RESERVE every overlapping sibling ('parsed' → 'reserved') before deleting.
      if (!reserved) {
        // Serialize per store (round 14): if another cleanup already owns the store's reserve→delete→send-late
        // window, DEFER before touching anything and stop. Only reached once we HAVE a stale row to delete, so
        // a clean re-parse never defers; an unchanged recover parse has an empty delete set and never reaches
        // here either, so it drains the reserved set rather than deadlocking on it (no livelock).
        const contended = await anotherCleanupHoldsStore(file, env);
        spent += 1;
        if (contended) {
          // Re-enqueue as a PLAIN re-parse (no offset/cleanup_phase), NOT a cleanup continuation: the retry
          // re-runs the idempotent write phase and re-enters cleanup from scratch, re-checking contention. A
          // plain message carries no resume cursor, so it can't form a self-referential cleanup-continuation
          // loop — the store frees within a few invocations under max_concurrency:1 (the reserving cleanup's
          // own messages run ahead of this re-enqueue), and the retry proceeds then. Nothing was mutated here.
          try {
            await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: contentHash, ...reservationFields(reservationDelivery) });
          } catch {
            await forcePending(file, env, contentHash, reservationDelivery);
            throw new ExportRetry('cleanup contention defer re-enqueue send failed');
          }
          console.log(JSON.stringify({ event: 'parse.export.cleanup_deferred', file_id: file.id, cursor }));
          return spent;
        }
        const r = await reserveSiblings(file, env, contentHash, 0, spent);
        spent += r.spent;
        expectedReservations += r.reserved;
        if (r.superseded) return spent;
        if (!r.complete) {
          // Reservation overflowed the budget → hand off to a 'reserve' continuation that resumes deletes
          // HERE (cursor still at the last kept row before this stale one). NOTHING is deleted yet.
          await sendCleanupContinuation(
            file,
            env,
            reason,
            contentHash,
            archive.sessions.length,
            'reserve',
            cursor,
            r.kickCursor,
            expectedReservations,
            'reserve',
            reservationDelivery,
          );
          console.log(JSON.stringify({ event: 'parse.export.reserve', file_id: file.id, kick_cursor: r.kickCursor, cursor, done: false }));
          return spent;
        }
        reserved = true;
        if (spent >= EXPORT_QUERY_BUDGET) {
          budgetHit = true; // reservation consumed the budget → continue deletes on a 'delete' continuation
          break;
        }
      }
      cursor = session_id; // advance past a reconciled row (decided)
      if (archive.skipped === 0) {
        await env.DB.batch([
          bindCleanup(
            env.DB.prepare(
              `INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL${cleanupGuardSql}`,
            ),
            session_id,
          ),
          bindCleanup(env.DB.prepare(`DELETE FROM blocks WHERE session_id = ?1${cleanupGuardSql}`), session_id),
          bindCleanup(env.DB.prepare(`DELETE FROM usage WHERE session_id = ?1${cleanupGuardSql}`), session_id),
          bindCleanup(env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?1${cleanupGuardSql}`), session_id),
        ]);
        spent += 1; // one db.batch = one subrequest, regardless of the 4 statements inside it
      } else {
        await bindCleanup(env.DB.prepare(`UPDATE sessions SET index_state = 'error' WHERE session_id = ?1${cleanupGuardSql}`), session_id).run();
        spent += 1;
      }
      recovered.add(session_id);
    }
    if (budgetHit) break;
    if (page.results.length < CLEANUP_PAGE) {
      cleanupComplete = true; // drained the last (short) page within budget
      break;
    }
  }

  // Cleanup exhausted the budget with rows still to scan/delete: re-enqueue a continuation preserving the
  // phase (still 'scan' if no stale has been found yet, else 'delete') and STOP — still WITHOUT markParsed,
  // so the file stays 'pending' until cleanup drains.
  if (!cleanupComplete) {
    await sendCleanupContinuation(
      file,
      env,
      reason,
      contentHash,
      archive.sessions.length,
      reserved ? 'delete' : 'scan',
      cursor,
      undefined,
      expectedReservations,
      reserved ? 'delete' : 'scan',
      reservationDelivery,
    );
    console.log(JSON.stringify({ event: 'parse.export.cleanup', file_id: file.id, cursor, phase: reserved ? 'delete' : 'scan', recovered: recovered.size, done: false }));
    return spent;
  }

  // Cleanup fully drained → NOW mark 'parsed', guarded. markParsed's `UPDATE ... WHERE content_hash = ?`
  // is atomic: a re-upload that changed this row's bytes since the last recheck makes updated=false, so
  // we flip whatever this invocation wrote back to 'parsing' (a pure cleanup pass wrote nothing → no-op)
  // and let the fresh parse own the current bytes end to end.
  const { updated } = await markParsed(file.id, env, 'parsed', file.size, null, contentHash);
  if (!updated) {
    await revertOwnedReady(file, env);
    return spent;
  }

  // SEND-LATE: every delete has committed and the file is terminal 'parsed', so no recover parse can now
  // see a still-owned stale row. Best-effort enqueue recover messages for the siblings this cleanup reserved
  // ('reserved' state — round 12). Run UNCONDITIONALLY, not gated on THIS invocation's `recovered` set
  // (3608692127): when stale cleanup spans continuations, the delivery that deletes the last stale session
  // may stop on budget before seeing the empty page, so the NEXT delivery reaches here with recovered.size 0
  // even though earlier deliveries reserved siblings — the 'reserved' SELECT (1 subrequest, empty when
  // there's nothing) fans them out regardless.
  //
  // Recheck OUR hash immediately before the sends (3608692134): a re-upload in the post-markParsed window
  // means the fresh message owns the file and will run its OWN cleanup + reserve + fan-out, so skip ours. The
  // irreducible residual (bytes change AFTER this recheck) is self-healing: a stale recover claiming a
  // just-deleted session holds it only until the fresh upload parse runs (the every-reason mtime rule lets
  // the newer archive re-claim), and a dropped fresh parse is healed by files/check — never terminal staleness.
  let hashStillOurs = true;
  if (contentHash !== undefined) {
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
    spent += 1;
    hashStillOurs = recheck?.content_hash === contentHash;
    if (!hashStillOurs) console.log(JSON.stringify({ event: 'parse.export.send_late_skipped', file_id: file.id, reason: 'hash_changed' }));
  }
  if (hashStillOurs) spent += await fanOutRecover(file, env, reason, contentHash, spent);

  console.log(
    JSON.stringify({
      event: 'parse.export',
      file_id: file.id,
      harness: archive.harness,
      conversations: archive.sessions.length,
      written: written.size,
      recovered: recovered.size,
      skipped: archive.skipped,
    }),
  );
  return spent;
}

/** Enqueue a cleanup-phase continuation, or — if the send throws — force the file back to 'pending'
 * (hash-guarded, so a fresher re-upload isn't clobbered) and raise ExportRetry so the consumer skips
 * markError and just retries this idempotent phase. The archive is FULLY written, so its 'ready' sessions
 * stay valid; unlike a WRITE throw we do NOT revert them. Even if retries exhaust to the DLQ the file rests
 * 'pending' (visible to the pipeline-stuck alert), never terminal 'error' with unreconciled stale rows. */
async function sendCleanupContinuation(
  file: FileRow,
  env: Env,
  reason: ParseMessage['reason'],
  contentHash: string | undefined,
  offset: number,
  cleanupPhase: NonNullable<ParseMessage['cleanup_phase']>,
  cleanupCursor: string,
  kickCursor: number | undefined,
  reservationCount: number,
  label: string,
  reservationDelivery: ReservationDelivery,
): Promise<void> {
  try {
    await env.PARSE_QUEUE.send({
      file_id: file.id,
      r2_key: file.r2_key,
      reason,
      content_hash: contentHash,
      offset,
      cleanup_phase: cleanupPhase,
      cleanup_cursor: cleanupCursor,
      kick_cursor: kickCursor,
      reservation_count: reservationCount,
      ...reservationFields(reservationDelivery),
    });
  } catch {
    await forcePending(file, env, contentHash, reservationDelivery);
    console.log(JSON.stringify({ event: 'parse.export.cleanup_send_failed', file_id: file.id, phase: label, cursor: cleanupCursor }));
    throw new ExportRetry(`cleanup ${label} continuation send failed`);
  }
}

/** One-subrequest guard for the per-store cleanup serialization (round 14): does ANOTHER store sibling carry
 * a FRESH reservation? If so, a different cleanup owns the store's reserve → delete → send-late window, and
 * this cleanup (which has stale rows to delete, or a corrupt-file fan-out to run) must defer BEFORE any
 * mutation rather than reserve concurrently — concurrent reservations would let one cleanup's store-wide
 * send-late fire the other's rows early and cross-contaminate the 'reserved' set. Exclude both reservations
 * OWNED by this cleanup and the current row itself: an owner-tagged sibling delivery still carries the previous
 * cleanup's reserved_by until it finishes, and must not mistake itself for contention (3609611900). Stale
 * reservations (a crashed cleanup) fall past the reserved_at cutoff and never wedge the store. */
async function anotherCleanupHoldsStore(file: FileRow, env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS held FROM files WHERE store = ?1 AND id != ?2 AND reserved_by != ?2 AND parse_state = 'reserved' AND reserved_at IS NOT NULL AND reserved_at > ?3 LIMIT 1",
  )
    .bind(file.store, file.id, reservationCutoffIso())
    .first<{ held: number }>();
  return row !== null;
}

/** Drop every surviving reservation from a cleanup whose expected prefix was partially healed. Restarting
 * with a plain message then begins from an actually empty ownership set, so its reservation_count is exact.
 * Upload reservations become pending and recover reservations become parsed, so reserveSiblings reconstructs
 * the same intent on the next pass; either state is independently healable if the restart message is lost.
 * Incrementing the generation makes already-selected owner-tagged deliveries unusable after the release. One
 * set-based UPDATE keeps this bounded regardless of sibling count. */
async function releaseOwnedReservations(file: FileRow, env: Env): Promise<number> {
  const res = await env.DB.prepare(
    "UPDATE files SET parse_state = CASE reserved_reason WHEN 'upload' THEN 'pending' ELSE 'parsed' END, reserved_at = NULL, reserved_by = NULL, reserved_reason = NULL, reservation_generation = reservation_generation + 1 WHERE store = ?1 AND reserved_by = ?2 AND parse_state = 'reserved'",
  )
    .bind(file.store, file.id)
    .run();
  return res.meta?.changes ?? 0;
}

/** RESERVE pass: flip every 'parsed' sibling archive to 'reserved' — a DURABLE recovery reservation that is
 * its own explicit marker (round 12) — paged by files.id so pages advance independent of parse_state (a
 * sibling healed back to 'parsed' behind the cursor can't re-trigger a re-flip → no livelock). NO queue send
 * here; the owner-tagged deliveries go out later, keyed off exactly the 'reserved' state,
 * after every delete commits (see sendRecoverToReservedSiblings). The flip is hash-PINNED to the bytes read
 * (round 10): a sibling re-uploaded between the SELECT and the UPDATE has a new hash and is no longer
 * 'parsed', so the guarded UPDATE no-ops and never buries fresh upload bytes as a stale reservation. Returns
 * the subrequest cost, whether every sibling is now reserved, the advanced id cursor, and whether OUR file
 * was superseded mid-pass (a re-upload changed its bytes → reverted our 'ready' rows, caller must stop). */
async function reserveSiblings(
  file: FileRow,
  env: Env,
  contentHash: string | undefined,
  kickCursor: number,
  spentSoFar: number,
): Promise<{ spent: number; complete: boolean; kickCursor: number; superseded: boolean; reserved: number }> {
  let spent = 0;
  let kc = kickCursor;
  let reserved = 0; // rows actually flipped to 'reserved' this call (batch changes; hash-pinned no-ops excluded)
  while (spentSoFar + spent < EXPORT_QUERY_BUDGET) {
    if (contentHash !== undefined) {
      const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
      spent += 1;
      if (recheck?.content_hash !== contentHash) {
        await revertOwnedReady(file, env);
        console.log(JSON.stringify({ event: 'parse.export.superseded', file_id: file.id, phase: 'cleanup-reserve', at: kc }));
        return { spent, complete: false, kickCursor: kc, superseded: true, reserved };
      }
    }
    // Reserve BOTH 'parsed' AND 'pending' siblings (round 15, 3608955874). A sibling still 'pending' from an
    // upload/files-check heal has a queued parse message that could complete mid-window, land 'parsed' BEHIND
    // kickCursor, and escape both this reservation and the send-late set while the delete removes its shared
    // session. Selecting 'pending' too keeps the pager from advancing past an unreserved sibling. INVARIANT
    // this upholds: no sibling with id ≤ kickCursor is left in a parseable state that isn't 'reserved'. The
    // consume-time guard in parseOne is the other half — it no-ops the pending sibling's now-redundant queued
    // message once we've reserved it (the reserve flip races that message; the guard makes the flip safe).
    const sibs = await env.DB.prepare(
      "SELECT id, content_hash FROM files WHERE store = ?1 AND id != ?2 AND id > ?3 AND parse_state IN ('parsed','pending') ORDER BY id ASC LIMIT ?4",
    )
      .bind(file.store, file.id, kc, EXPORT_KICK_PAGE)
      .all<{ id: number; content_hash: string }>();
    spent += 1;
    if (sibs.results.length === 0) return { spent, complete: true, kickCursor: kc, superseded: false, reserved };
    for (let i = 0; i < sibs.results.length; i += FLIP_BATCH_CHUNK) {
      const chunk = sibs.results.slice(i, i + FLIP_BATCH_CHUNK);
      const batchRes = await env.DB.batch(
        chunk.map((s) =>
          env.DB
            // reserved_at stamps this reservation's owner-window and reserved_by stamps its OWNER = this cleanup's
            // file.id (round 14): fresh ⇒ a live cleanup owns it, so OTHER cleanups defer and the heal paths skip
            // it; stale ⇒ abandoned, heals normally. Owner-tagging lets a retry of THIS cleanup exclude its own
            // reservations (anotherCleanupHoldsStore) and lets send-late target exactly the rows WE reserved.
            // Both written in the SAME statement as the flip so neither marker can lag the state. Hash-PINNED and
            // state-guarded to 'parsed'/'pending' so a sibling re-uploaded (new hash) or already reserved between
            // the SELECT and here is not clobbered.
            .prepare("UPDATE files SET reserved_reason = CASE parse_state WHEN 'pending' THEN 'upload' ELSE 'recover' END, parse_state = 'reserved', reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reserved_by = ?3, reservation_generation = reservation_generation + 1 WHERE id = ?1 AND parse_state IN ('parsed','pending') AND content_hash = ?2")
            .bind(s.id, s.content_hash, file.id),
        ),
      );
      spent += 1;
      reserved += batchRes.reduce((n, r) => n + (r.meta?.changes ?? 0), 0); // count only rows that actually flipped
    }
    kc = sibs.results[sibs.results.length - 1]!.id;
    if (sibs.results.length < EXPORT_KICK_PAGE) return { spent, complete: true, kickCursor: kc, superseded: false, reserved };
  }
  return { spent, complete: false, kickCursor: kc, superseded: false, reserved };
}

/** Refresh THIS cleanup's reservations on continuation entry (round 15, 3608955877). Queue backoff/backlog can
 * legitimately stretch a cleanup's reserve → delete → send-late window past STALE_RESERVATION_MS; without this,
 * the heal paths would treat the still-live reservations as abandoned, strip reserved_by, and the delayed delete
 * would then strand the sibling (send-late only targets rows still reserved_by us). Re-stamping reserved_at on
 * every continuation makes PROGRESS the freshness signal: a live cleanup keeps its window open; a genuinely
 * crashed one stops refreshing and its rows go stale on schedule. The durable generation increments in the
 * same statement so deliveries selected before this refresh cannot consume the renewed reservation. Returns
 * the number of rows still owned. */
async function refreshOwnedReservations(file: FileRow, env: Env): Promise<number> {
  const res = await env.DB.prepare(
    "UPDATE files SET reserved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reservation_generation = reservation_generation + 1 WHERE store = ?1 AND reserved_by = ?2 AND parse_state = 'reserved'",
  )
    .bind(file.store, file.id)
    .run();
  return res.meta?.changes ?? 0;
}

/** SEND-LATE recovery pass: page the siblings THIS cleanup reserved (parse_state = 'reserved' AND
 * reserved_by = our file.id) and enqueue its stored upload/recover intent, best-effort. Runs only AFTER every stale
 * delete has committed, so ordering is guaranteed — a replacement parse can never see one of our stale rows still
 * owned+present.
 *
 * Owner-scoped by reserved_by (round 14, the STRONGER fix for the cross-cleanup send-late race 3608748301):
 * an interleaved cleanup B whose fan-out overlaps ours can NEVER select rows WE reserved, because B's SELECT is
 * pinned to reserved_by = B's id. The per-store serialization already keeps two delete-bearing cleanups from
 * overlapping in the first place; owner-scoping makes the send structurally incapable of firing another
 * cleanup's reservations early even if the windows ever did touch. (reserved_by = ?2 also implies id != file.id
 * — a cleanup never reserves its own row — so the self-exclusion the old id != ?2 gave us is preserved.)
 *
 * SELECTs exactly 'reserved', never a raw 'pending' row (3608692125). A pending row explicitly reserved before
 * deletes carries reserved_reason='upload'; an already-parsed sibling carries 'recover'. This keeps a genuinely
 * newer pending archive's full replacement semantics instead of converting it into gap-fill mode (3609060878).
 * On a successful send the row stays 'reserved' (no extra UPDATE): the consumed owner-tagged parse moves it
 * through parsing → terminal via its own markParsed, and if the message is dropped, files/check
 * re-enqueues 'reserved' as an 'upload' (it's non-terminal) — so leaving it 'reserved' is both cheaper (saves a
 * subrequest per send) and heals identically whether the send landed or not. A duplicate recover from a later
 * cleanup that re-selects a still-'reserved' row is harmless (recover is idempotent under the mtime guard).
 *
 * A FAILED send is charged to the budget too (3608692129) so a queue outage can't spin the pager issuing
 * thousands of failing sends while only the SELECTs advance `spent`; after EXPORT_SEND_FAILURE_LIMIT
 * consecutive failures we abort the fan-out (the 'reserved' rows heal via files/check). Bounded by the
 * invocation budget; any siblings not reached this invocation stay 'reserved' and are healed by files/check
 * (the durable reservation is the safety net). */
async function sendRecoverToReservedSiblings(
  file: FileRow,
  env: Env,
  spentSoFar: number,
  startCursor = 0,
): Promise<{ spent: number; cursor: number; cut: 'done' | 'budget' | 'outage' }> {
  let spent = 0;
  let cursor = startCursor;
  let consecutiveFailures = 0;
  while (spentSoFar + spent < EXPORT_QUERY_BUDGET) {
    const sibs = await env.DB.prepare(
      "SELECT id, r2_key, content_hash, reservation_generation, COALESCE(reserved_reason, 'recover') AS reserved_reason FROM files WHERE store = ?1 AND reserved_by = ?2 AND id > ?3 AND parse_state = 'reserved' AND reserved_at IS NOT NULL ORDER BY id ASC LIMIT ?4",
    )
      .bind(file.store, file.id, cursor, EXPORT_KICK_PAGE)
      .all<{ id: number; r2_key: string; content_hash: string; reservation_generation: number; reserved_reason: string }>();
    spent += 1;
    if (sibs.results.length === 0) return { spent, cursor, cut: 'done' }; // no more reserved siblings — fully drained
    for (const s of sibs.results) {
      if (spentSoFar + spent >= EXPORT_QUERY_BUDGET) return { spent, cursor, cut: 'budget' }; // budget hit mid-page → resume here
      try {
        const reservedReason: ParseMessage['reason'] = s.reserved_reason === 'upload' ? 'upload' : 'recover';
        await env.PARSE_QUEUE.send({
          file_id: s.id,
          r2_key: s.r2_key,
          reason: reservedReason,
          content_hash: s.content_hash,
          reservation_owner: file.id,
          reservation_generation: s.reservation_generation,
        });
        spent += 1;
        consecutiveFailures = 0;
        cursor = s.id; // advance the resume cursor only past a row we actually handled
      } catch (e) {
        spent += 1; // charge the attempted send even though it threw (3608692129)
        consecutiveFailures += 1;
        console.log(JSON.stringify({ event: 'parse.export.recover_send_failed', file_id: file.id, sibling: s.id, error: String(e) }));
        if (consecutiveFailures >= EXPORT_SEND_FAILURE_LIMIT) {
          console.log(JSON.stringify({ event: 'parse.export.recover_fan_out_aborted', file_id: file.id, reason: 'queue_outage', last_sibling: s.id }));
          return { spent, cursor, cut: 'outage' }; // queue outage — the 1h heal is the backstop; do NOT resume-enqueue
        }
      }
    }
    cursor = sibs.results[sibs.results.length - 1]!.id;
    if (sibs.results.length < EXPORT_KICK_PAGE) return { spent, cursor, cut: 'done' };
  }
  return { spent, cursor, cut: 'budget' }; // outer budget cut between pages → resume here
}

/** Run the send-late recover fan-out from `startCursor` and, if it stopped on the invocation BUDGET (not a full
 * drain, not a queue outage), enqueue a 'send-late' continuation to resume it (round 15, 3608955881). The owner
 * is already terminal 'parsed', so a stranded fresh reservation would otherwise wait up to STALE_RESERVATION_MS
 * for a collector files/check; the continuation drains the remainder without re-running cleanup. Best-effort: if
 * the continuation send itself throws, the 1h heal is still the backstop (we don't fail the owner over it). */
async function fanOutRecover(file: FileRow, env: Env, reason: ParseMessage['reason'], contentHash: string | undefined, spentSoFar: number, startCursor = 0): Promise<number> {
  const r = await sendRecoverToReservedSiblings(file, env, spentSoFar, startCursor);
  if (r.cut === 'budget') {
    try {
      await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: contentHash, offset: 0, cleanup_phase: 'send-late', send_cursor: r.cursor });
    } catch (e) {
      console.log(JSON.stringify({ event: 'parse.export.send_late_continuation_failed', file_id: file.id, cursor: r.cursor, error: String(e) }));
    }
  }
  return r.spent;
}

/**
 * Prefer a real copy first — neither 'error' nor 'skipped' (a zero-turn parse: every line
 * malformed or unsupported) wins over an actual 'parsed'/'pending' candidate, only wins if
 * EVERY candidate is error/skipped — otherwise a permanently-failed or empty copy could win
 * canonical selection and get a good duplicate from another machine marked superseded before
 * it's ever parsed. Then lowest machine priority, then largest file, then newest mtime.
 * Returns the preferred file id and its current parse_state — callers must not treat
 * "preferred" as "supersede everyone else" until that file has actually proven it can parse
 * (parse_state = 'parsed').
 */
async function chooseCanonical(sessionId: string, env: Env): Promise<{ id: number; parseState: string } | null> {
  const row = await env.DB.prepare(
    `SELECT f.id, f.parse_state FROM files f JOIN machines m ON m.machine_id = f.machine_id
     WHERE f.session_id = ?1 AND f.parse_state != 'superseded'
     ORDER BY (f.parse_state IN ('error', 'skipped')) ASC, m.priority ASC, f.size DESC, f.mtime DESC, f.id ASC LIMIT 1`,
  )
    .bind(sessionId)
    .first<{ id: number; parse_state: string }>();
  return row ? { id: row.id, parseState: row.parse_state } : null;
}

/**
 * Whether some OTHER candidate already marked 'parsed' for this session outranks `fileId` under
 * the same tie-break order as chooseCanonical (priority ASC, size DESC, mtime DESC, id ASC) —
 * null if none does. Unlike chooseCanonical, this only considers 'parsed' rows: a still-pending
 * row can rank ahead of an already-parsed one under chooseCanonical's ordering even though it
 * hasn't proven anything yet (e.g. A pending at priority 0, B parsed and canonical at priority 1)
 * — a naive "is chooseCanonical's top pick parsed?" check would then miss that B is the best
 * PROVEN copy and let a worse-priority C clobber B anyway.
 *
 * `fileId` is folded into the ranking itself (via UNION with its own row) rather than compared
 * against separately, so this also correctly answers "no" when fileId — though not yet marked
 * parsed — is actually the best copy once you account for it (e.g. better-priority A parsing
 * after worse-priority B already did): A must proceed and supersede B afterward, not supersede
 * itself just because SOME other parsed row happens to exist.
 */
async function chooseBestParsed(sessionId: string, fileId: number, env: Env): Promise<{ id: number } | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM (
       SELECT f.id AS id, m.priority AS priority, f.size AS size, f.mtime AS mtime
       FROM files f JOIN machines m ON m.machine_id = f.machine_id
       WHERE f.session_id = ?1 AND f.parse_state = 'parsed' AND f.id != ?2
       UNION ALL
       SELECT f2.id AS id, m2.priority AS priority, f2.size AS size, f2.mtime AS mtime
       FROM files f2 JOIN machines m2 ON m2.machine_id = f2.machine_id
       WHERE f2.id = ?2
     )
     ORDER BY priority ASC, size DESC, mtime DESC, id ASC LIMIT 1`,
  )
    .bind(sessionId, fileId)
    .first<{ id: number }>();
  return row && row.id !== fileId ? { id: row.id } : null;
}

/**
 * Find another file to re-parse after `excludeFileId` (the session's former canonical) just
 * turned out to be garbage. Unlike chooseCanonical, this DOES consider 'superseded' files —
 * a duplicate that lost to `excludeFileId` while it still looked good is exactly the kind of
 * copy that should get a second chance now. 'error'/'skipped' copies are still excluded; they
 * wouldn't produce anything better.
 */
async function chooseRecoveryCandidate(
  sessionId: string,
  excludeFileId: number,
  env: Env,
): Promise<{ id: number; r2_key: string; content_hash: string } | null> {
  const row = await env.DB.prepare(
    `SELECT f.id, f.r2_key, f.content_hash FROM files f JOIN machines m ON m.machine_id = f.machine_id
     WHERE f.session_id = ?1 AND f.id != ?2 AND f.parse_state NOT IN ('error', 'skipped')
     ORDER BY (f.parse_state = 'superseded') ASC, m.priority ASC, f.size DESC, f.mtime DESC, f.id ASC LIMIT 1`,
  )
    .bind(sessionId, excludeFileId)
    .first<{ id: number; r2_key: string; content_hash: string }>();
  return row ?? null;
}

async function linkSubagentMeta(file: FileRow, env: Env): Promise<void> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) return;
  try {
    const meta = (await obj.json()) as { toolUseId?: string; agentType?: string };
    const agentId = file.relpath.split('/').pop()?.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    if (agentId && meta.toolUseId) {
      // No-op (0 rows) if the subagent transcript hasn't been parsed into a sessions row
      // yet — that ordering is covered by the sibling-meta read in parseOne above instead.
      await env.DB.prepare('UPDATE sessions SET parent_tool_use_id = ?2 WHERE session_id = ?1')
        .bind(agentId, meta.toolUseId)
        .run();
    }
  } catch {
    // Malformed meta is non-fatal; the transcript itself still indexes.
  }
}

/** Read the .meta.json sibling of a subagent transcript's r2_key (agent-X.jsonl -> agent-X.meta.json), if present. */
async function readSiblingMeta(r2Key: string, env: Env): Promise<{ toolUseId?: string; agentType?: string } | null> {
  if (!r2Key.endsWith('.jsonl')) return null;
  const metaKey = `${r2Key.slice(0, -'.jsonl'.length)}.meta.json`;
  const obj = await env.RAW.get(metaKey);
  if (!obj) return null;
  try {
    return (await obj.json()) as { toolUseId?: string; agentType?: string };
  } catch {
    return null;
  }
}

/**
 * When `requireContentHash` is given, the UPDATE only applies if the row's content_hash still
 * matches — otherwise a re-upload changed the row's content while THIS message's parse was
 * reading the OLD R2 body, and writing 'parsed'/'error'/'skipped' now would describe content
 * that's no longer there. `updated: false` tells the caller to leave everything else alone; the
 * newer upload already enqueued its own fresh parse for the current bytes. Omitting
 * `requireContentHash` keeps the unconditional legacy behavior (messages enqueued before this
 * field existed, or call sites where matching content isn't the point, e.g. subagent-meta links).
 */
async function markParsed(
  fileId: number,
  env: Env,
  state: string,
  parsedSize?: number,
  parseError?: string | null,
  requireContentHash?: string,
): Promise<{ updated: boolean }> {
  const guarded = requireContentHash !== undefined;
  // Clear the reservation tuple as the row leaves 'reserved': its owner-tagged recover/upload parse ends here,
  // and clearing the owner, timestamp, and reason together stops it from
  // blocking new cleanups (contention probe) or being claimed by a stale send-late owner. A no-op for the common
  // case (already NULL).
  const sql = `UPDATE files SET parse_state = ?2, parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parsed_size = ?3, parse_error = ?4, reserved_at = NULL, reserved_by = NULL, reserved_reason = NULL
     WHERE id = ?1${guarded ? ' AND content_hash = ?5' : ''}`;
  const stmt = env.DB.prepare(sql);
  const result = await (guarded
    ? stmt.bind(fileId, state, parsedSize ?? null, parseError ?? null, requireContentHash)
    : stmt.bind(fileId, state, parsedSize ?? null, parseError ?? null)
  ).run();
  return { updated: !guarded || (result.meta?.changes ?? 0) > 0 };
}

/** Revert every 'ready' session this file is canonical for back to index_state='parsing', in ONE
 * subrequest. Used only on the SUPERSEDE paths — a re-upload changed the bytes (post-write recheck,
 * cleanup-page recheck) or markParsed lost the row to a fresher upload. There, a DIFFERENT message (the
 * fresh upload, offset 0) owns the current bytes and rewrites every conversation, so reverting the whole
 * file (all slices, across invocations) is correct: the old-byte rows are stale and must not stay
 * searchable in the gap. NOT used on transient-throw paths — those retry the SAME message at the SAME
 * offset, which never rewrites earlier slices, so reverting them would strand valid rows (see revertSlice
 * / raiseExportRetry, round 6 finding 2). */
async function revertOwnedReady(file: FileRow, env: Env): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE canonical_file_id = ?1 AND index_state = 'ready'").bind(file.id).run();
}

/** Revert ONLY the sessions THIS invocation wrote (its `written` set) back to 'parsing', batched (chunks
 * of 90) to stay within the subrequest budget. Used on transient-throw paths, where the SAME message
 * retries at the SAME offset and rewrites exactly this invocation's slice — so earlier slices (valid for
 * the current bytes, not in `written`, not rewritten by the retry) must be left 'ready'. */
async function revertSlice(written: Set<string>, env: Env): Promise<void> {
  if (written.size === 0) return;
  const stmts = [...written].map((id) => env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(id));
  for (const chunk of chunkArr(stmts, 90)) await env.DB.batch(chunk);
}

/** Restore the retryable state (hash-guarded when the message carries a hash, so a concurrent fresh upload
 * that already moved the row on is not clobbered). Ordinary parses return to pending. An exact owner-tagged
 * delivery remains reserved with its ownership tuple intact; changing it to pending would expose it to a
 * competing cleanup/files-check before the retry fills the sessions its owner deleted (3609651689). */
async function forcePending(
  file: FileRow,
  env: Env,
  contentHash: string | undefined,
  reservationDelivery: ReservationDelivery = null,
): Promise<void> {
  if (reservationDelivery !== null) {
    const hashGuard = contentHash !== undefined ? ' AND content_hash = ?2' : '';
    const ownerPosition = contentHash !== undefined ? 3 : 2;
    await env.DB.prepare(
      `UPDATE files SET parse_state = 'reserved' WHERE id = ?1${hashGuard} AND parse_state = 'reserved'
       AND reserved_by = ?${ownerPosition} AND reservation_generation = ?${ownerPosition + 1}`,
    )
      .bind(...(contentHash !== undefined
        ? [file.id, contentHash, reservationDelivery.owner, reservationDelivery.generation]
        : [file.id, reservationDelivery.owner, reservationDelivery.generation]))
      .run();
    return;
  }
  await env.DB.prepare(`UPDATE files SET parse_state = 'pending' WHERE id = ?1${contentHash !== undefined ? ' AND content_hash = ?2' : ''}`)
    .bind(...(contentHash !== undefined ? [file.id, contentHash] : [file.id]))
    .run();
}

/** Handle a transient (retryable) throw out of an export parse: revert THIS invocation's writes, restore the
 * file's retryable pending/reserved state, and raise the ExportRetry sentinel so the consumer retries the same idempotent message
 * rather than marking a session_id-NULL archive terminal 'error' with stranded 'ready' rows. Never reverts
 * earlier slices (revertSlice is per-invocation) — a same-offset retry rewrites only this slice.
 *
 * BOTH rollbacks are best-effort (round 7 finding 2): a second D1 failure or subrequest-cap hit inside
 * revertSlice/forcePending must NOT escape as a non-sentinel error, or the generic consumer catch would mark
 * this session_id-NULL archive terminal 'error' with its rows stranded — the exact outcome the sentinel
 * exists to prevent. Neither swallowed failure strands anything: a failed revertSlice leaves this slice's
 * rows 'ready', but the same-offset retry rewrites them idempotently; a failed forcePending leaves the file
 * non-terminal ('parsing'), which files/check re-enqueues, and the sentinel already retries this message.
 * Both converge on a clean reparse. So we log each failure and ALWAYS raise ExportRetry. */
async function raiseExportRetry(
  file: FileRow,
  env: Env,
  written: Set<string>,
  contentHash: string | undefined,
  e: unknown,
  reservationDelivery: ReservationDelivery,
): Promise<never> {
  try {
    await revertSlice(written, env);
  } catch (revertErr) {
    console.log(JSON.stringify({ event: 'parse.export.revert_failed', file_id: file.id, error: String(revertErr) }));
  }
  try {
    await forcePending(file, env, contentHash, reservationDelivery);
  } catch (pendingErr) {
    console.log(JSON.stringify({ event: 'parse.export.force_pending_failed', file_id: file.id, error: String(pendingErr) }));
  }
  console.log(JSON.stringify({ event: 'parse.export.transient', file_id: file.id, error: String(e) }));
  throw new ExportRetry(String(e));
}

/** Replace a session's index rows atomically-enough: FTS delete → blocks delete → reinsert → FTS
 * rebuild from blocks. Returns the number of D1 SUBREQUESTS it issued (one per db.batch / .first / .run
 * call) so the export slicer can budget by the ACTUAL per-invocation limit.
 *
 * COUNTING MODEL — the ~1000/invocation cap counts SUBREQUESTS, not SQL statements: a `db.batch([...])`
 * of any size is ONE subrequest (a single round trip). Positive control (measured 2026-07-18, prod
 * `sessions-index`): a claude-code session (id shape aaaaaaaa-…) with 7,686 blocks — ≈7,692 STATEMENTS
 * but only ≈89 batches/SUBREQUESTS — exists fully, written atomically by ONE writeSession invocation;
 * that is impossible under a 1,000-STATEMENT cap, so the statement-cap model is falsified. Corroboration:
 * the original export under-produced at ~245 conversations (~5 subrequests each ≈ 1,000), and PR #14's
 * 1101 was fixed by BATCHING unbatched per-object writes (fewer subrequests). So cost = delete batch (1)
 * + one batch per 90-block insert chunk + machine SELECT (1) + session/FTS batch (1). See
 * memory/d1-invocation-limits.md. */
async function writeSession(s: NormalizedSession, file: FileRow, env: Env): Promise<number> {
  const db = env.DB;

  await db.batch([
    db
      .prepare(
        `INSERT INTO blocks_fts (blocks_fts, rowid, text)
         SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
      )
      .bind(s.id),
    db.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(s.id),
    db.prepare('DELETE FROM usage WHERE session_id = ?1').bind(s.id),
  ]);

  const insertBlock = db.prepare(
    `INSERT INTO blocks (session_id, file_id, turn_index, block_index, role, btype, tool_name, ts, byte_start, byte_len, truncated, text, on_main_path)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  );
  const insertUsage = db.prepare(
    `INSERT INTO usage (session_id, turn_index, ts, model, service_tier, input_tokens, output_tokens, reasoning_tokens,
                        cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens, inference_geo, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (session_id, turn_index) DO UPDATE SET
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens, cache_read_tokens = excluded.cache_read_tokens`,
  );

  const stmts: D1PreparedStatement[] = [];
  let blockCount = 0;
  const totals = { in: 0, out: 0, reasoning: 0, cached: 0 };
  for (const turn of s.turns) {
    for (let bi = 0; bi < turn.blocks.length; bi++) {
      const b = turn.blocks[bi]!;
      blockCount++;
      stmts.push(
        insertBlock.bind(
          s.id,
          file.id,
          turn.index,
          bi,
          turn.role,
          b.type,
          b.toolName ?? null,
          turn.ts ?? null,
          b.byteStart,
          b.byteLen,
          b.truncated ? 1 : 0,
          b.text ?? null,
          turn.onMainPath ? 1 : 0,
        ),
      );
    }
    // Blockless compaction markers (codex) still get one text-less 'compaction' row so pagination and byte
    // windows account for the turn — otherwise a divider at a page boundary or after the last content block
    // is silently dropped. text stays NULL, so it never enters FTS; the viewer renders the divider from the
    // parsed turn, not this row.
    if (turn.blocks.length === 0 && turn.compaction && turn.byteStart !== undefined && turn.byteLen !== undefined) {
      stmts.push(
        insertBlock.bind(
          s.id,
          file.id,
          turn.index,
          0,
          turn.role,
          'compaction',
          null,
          turn.ts ?? null,
          turn.byteStart,
          turn.byteLen,
          0,
          null,
          turn.onMainPath ? 1 : 0,
        ),
      );
    }
    const u = turn.usage;
    if (u) {
      totals.in += u.inputTokens ?? 0;
      totals.out += u.outputTokens ?? 0;
      totals.reasoning += u.reasoningTokens ?? 0;
      totals.cached += u.cacheReadTokens ?? 0;
      stmts.push(
        insertUsage.bind(
          s.id,
          turn.index,
          turn.ts ?? null,
          u.model ?? null,
          u.serviceTier ?? null,
          u.inputTokens ?? null,
          u.outputTokens ?? null,
          u.reasoningTokens ?? null,
          u.cacheCreation5mTokens ?? null,
          u.cacheCreation1hTokens ?? null,
          u.cacheReadTokens ?? null,
          u.inferenceGeo ?? null,
          u.requestId ?? null,
        ),
      );
    }
  }

  const insertChunks = chunkArr(stmts, 90);
  for (const chunk of insertChunks) await db.batch(chunk);

  const machine = await db
    .prepare('SELECT os FROM machines WHERE machine_id = ?1')
    .bind(file.machine_id)
    .first<{ os: string }>();

  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, os, canonical_file_id, cwd, repo_url, project_name, git_branch, models,
                               primary_model, title, started_at, ended_at, parent_session_id, parent_tool_use_id, is_sidechain,
                               turn_count, block_count, tokens_in, tokens_out, tokens_reasoning, tokens_cached, index_state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, 'ready',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (session_id) DO UPDATE SET
           harness = excluded.harness, machine_id = excluded.machine_id, os = excluded.os,
           canonical_file_id = excluded.canonical_file_id, cwd = excluded.cwd, repo_url = excluded.repo_url,
           project_name = excluded.project_name,
           git_branch = excluded.git_branch, models = excluded.models, primary_model = excluded.primary_model,
           title = COALESCE(excluded.title, sessions.title), started_at = excluded.started_at, ended_at = excluded.ended_at,
           parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
           -- excluded wins when non-null: a transcript reparse reads the CURRENT sibling meta live
           -- (readSiblingMeta above), so a corrected .meta.json shows up here as a fresh, non-null
           -- excluded.parent_tool_use_id and must overwrite the stale stored value. Only fall back
           -- to the stored value when THIS write has no metadata of its own to offer (excluded is
           -- NULL) — e.g. a transcript reparse whose sibling meta hasn't landed (or was deleted),
           -- where linkSubagentMeta's own targeted UPDATE remains the source of truth instead.
           parent_tool_use_id = COALESCE(excluded.parent_tool_use_id, sessions.parent_tool_use_id),
           is_sidechain = excluded.is_sidechain, turn_count = excluded.turn_count, block_count = excluded.block_count,
           tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
           tokens_reasoning = excluded.tokens_reasoning, tokens_cached = excluded.tokens_cached,
           index_state = 'ready', updated_at = excluded.updated_at`,
      )
      .bind(
        s.id,
        s.harness,
        file.machine_id,
        machine?.os ?? null,
        file.id,
        s.cwd ?? null,
        s.repoUrl ?? null,
        deriveProjectName(s.cwd, s.repoUrl),
        s.gitBranch ?? null,
        JSON.stringify(s.models),
        s.primaryModel ?? null,
        s.title ?? null,
        s.startedAt ?? null,
        s.endedAt ?? null,
        s.parentSessionId ?? null,
        s.parentToolUseId ?? null,
        s.isSidechain ? 1 : 0,
        s.turns.length,
        blockCount,
        totals.in,
        totals.out,
        totals.reasoning,
        totals.cached,
      ),
    db
      .prepare(
        `INSERT INTO blocks_fts (rowid, text)
         SELECT id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
      )
      .bind(s.id),
  ]);

  // SUBREQUESTS (see the counting-model note above): delete batch (1) + one batch per 90-block insert
  // chunk (insertChunks.length) + machine SELECT (1) + session/FTS batch (1). A db.batch of N statements
  // is ONE subrequest, so a chatty conversation's cost grows with its BATCH count, not its statement count.
  return 3 + insertChunks.length;
}

function chunkArr<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
