import { detect } from './detect';
import type { NormalizedSession } from './normalize';
import { SINGLE_SESSION_HARNESSES, parseObject } from './parse';
import { parseExportArchive } from './parsers/export-inbox';
import { markPendingAndEnqueue } from '../queue';

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
}

/** Thrown by an export parse to signal a RETRYABLE (transient) failure: any throw out of an export parse
 * is a D1/queue outage, never a content error (bad ZIP / shape drift take the failExportFile+return path,
 * never throw). The file must NOT be marked 'error' — archive rows have session_id NULL, so the generic
 * catch can't reconcile their sessions, and an 'error' export with stale 'ready' rows is terminal (files/
 * check only re-enqueues NON-terminal rows). Every site that raises this first forces the file back to
 * 'pending' (hash-guarded); the consumer catch recognizes the sentinel and just retries the same message,
 * so redelivery re-runs the idempotent write/cleanup page. Two flavors, both retryable: the parseExportInto
 * wrapper raises it for any transient throw (after reverting THIS invocation's writes), and the cleanup
 * continuation-send path raises it directly (writes are complete + valid, so it does not revert). */
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
    }
    try {
      const spent = await parseOne(msg.body, env);
      msg.ack();
      if (!isExport) {
        invocationSpent += spent;
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
        // A retryable (transient) export failure. The raising site already forced the file back to
        // 'pending'; do NOT markError. Retry re-runs the same idempotent write/cleanup page. (Even if
        // retries exhaust to the DLQ, the file rests 'pending' — visible to the pipeline-stuck alert, never
        // silently errored with unreconciled stale sessions.)
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
          if (recovery) await markPendingAndEnqueue(recovery, 'recover', env);
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
    'SELECT id, machine_id, store, relpath, r2_key, size, mtime, harness, session_id, content_hash FROM files WHERE id = ?1',
  )
    .bind(job.file_id)
    .first<FileRow>();
  if (!file) return 1;

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

  const det = detect(file.store, file.relpath, file.machine_id);

  if (det.kind === 'subagent-meta') {
    await linkSubagentMeta(file, env);
    await markParsed(file.id, env, 'parsed', undefined, undefined, job.content_hash);
    return 4;
  }
  if (det.kind === 'export-archive') {
    // The one-export-slice-per-invocation reservation is applied by consumeParseBatch before we get here;
    // the actual per-invocation subrequest count comes back from parseExportInto for the batch budget.
    return 2 + (await parseExportInto(file, env, job.reason, job.content_hash, job.offset ?? 0, job.cleanup_cursor));
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
        if (recovery) await markPendingAndEnqueue(recovery, 'recover', env);
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
async function failExportFile(file: FileRow, env: Env, contentHash: string | undefined, reason: string): Promise<void> {
  const { updated } = await markParsed(file.id, env, 'error', file.size, reason, contentHash);
  // A fresher re-upload already owns this row (hash moved on) — its message handles the state.
  if (!updated) return;
  const owned = await env.DB.prepare('SELECT session_id FROM sessions WHERE canonical_file_id = ?1')
    .bind(file.id)
    .all<{ session_id: string }>();
  for (const { session_id } of owned.results) {
    await env.DB.prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1").bind(session_id).run();
  }
  if (owned.results.length > 0) {
    // Recover from export files on ANY machine, not just this one. Export rows carry
    // files.session_id = NULL (never in the normal duplicate-recovery pool), and conversation ids
    // are globally unique per account — so a same-account export uploaded from a DIFFERENT collector
    // can hold a conversation this errored file owned. Keeping the machine_id filter would strand
    // those sessions errored until a manual reindex. (self-exclusion + non-error kept.)
    const others = await env.DB.prepare(
      `SELECT id, r2_key, content_hash FROM files WHERE store = ?1 AND id != ?2 AND parse_state != 'error'`,
    )
      .bind(file.store, file.id)
      .all<{ id: number; r2_key: string; content_hash: string }>();
    for (const other of others.results) await markPendingAndEnqueue(other, 'recover', env);
  }
  console.log(JSON.stringify({ event: 'parse.export.error', file_id: file.id, error: reason, owned_errored: owned.results.length }));
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
// A single conversation estimated above this many SUBREQUESTS gets its OWN invocation (its writeSession
// can't be split), so it never rides alongside other work into the ~1000 cap. Measured max realistic
// export conversation is 304 blocks (~7 subrequests) — see the PR thread — so this is defensive.
export let EXPORT_OVERSIZED_CEILING = 700;
// Only a conversation whose subrequest cost exceeds this can't be written even alone under the ~1000 cap
// (~90k blocks — effectively unreachable). The destructive skip path is gated on this, so it never
// discards a large-but-writable conversation.
export let EXPORT_OVERSIZED_SUBREQUEST_CAP = 900;

/** Test-only: dial the export/invocation subrequest budgets down so slicing/cleanup/deferral can be
 * exercised with tiny fixtures instead of thousands of conversations. */
export function __setExportBudgetsForTest(o: { slice?: number; invocation?: number; ceiling?: number; cap?: number }): void {
  if (o.slice !== undefined) EXPORT_QUERY_BUDGET = o.slice;
  if (o.invocation !== undefined) INVOCATION_SUBREQUEST_BUDGET = o.invocation;
  if (o.ceiling !== undefined) EXPORT_OVERSIZED_CEILING = o.ceiling;
  if (o.cap !== undefined) EXPORT_OVERSIZED_SUBREQUEST_CAP = o.cap;
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
): Promise<number> {
  const written = new Set<string>();
  try {
    return await runExportParse(file, env, reason, contentHash, offset, cleanupCursor, written);
  } catch (e) {
    if (e instanceof ExportRetry) throw e; // raising site already reverted + forced 'pending'; pass through
    return await raiseExportRetry(file, env, written, contentHash, e);
  }
}

async function runExportParse(
  file: FileRow,
  env: Env,
  reason: ParseMessage['reason'],
  contentHash: string | undefined,
  offset: number,
  cleanupCursor: string | undefined,
  written: Set<string>,
): Promise<number> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) {
    // The raw ZIP is gone (e.g. a reindex after the R2 object was deleted). Do NOT throw into the
    // generic consumer catch: it flips sessions by files.session_id, which is NULL for an archive
    // row, so the sessions this ZIP is canonical for would keep a stale 'ready' state that
    // loadNormalized()/raw can no longer reconstruct. Handle it like an invalid archive instead.
    await failExportFile(file, env, contentHash, `r2_object_missing:${file.r2_key}`);
    return 4;
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
    await failExportFile(file, env, contentHash, archive.error ?? 'invalid export archive');
    return 4;
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
    await failExportFile(file, env, contentHash, 'export archive parsed to zero turns across all conversations (content-shape drift)');
    return 4;
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
      const existing = await env.DB.prepare(
        `SELECT f.store, f.parse_state AS canon_state, s.index_state, s.canonical_file_id
         FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
      )
        .bind(session.id)
        .first<{ store: string; canon_state: string; index_state: string; canonical_file_id: number }>();
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
      // canonically owned by another non-error file. (An 'upload'/'reindex' parse still wins normally.)
      const healthyOtherOwner =
        existing && existing.index_state === 'ready' && existing.canonical_file_id !== file.id && existing.canon_state !== 'error';
      if (reason === 'recover' && healthyOtherOwner) continue;

      // Preflight the conversation's SUBREQUEST cost. writeSession is atomic per conversation (no
      // intra-conversation cursor), so a single oversized conversation can't be sliced — it must either
      // run ALONE in its own invocation, or, if it can't fit even alone, be recorded and skipped.
      const estSubreq = estimateWriteSubrequests(session);
      if (estSubreq > EXPORT_OVERSIZED_SUBREQUEST_CAP) {
        // Cannot fit under the ~1000 SUBREQUEST cap even alone (~90k blocks). Record loudly and skip
        // (preservation-first: the raw ZIP stays in R2, nothing silently dropped); flip any existing row
        // for it to 'error'. Measured max export conversation is 304 blocks (~7 subrequests) — never today.
        await env.DB.prepare("UPDATE sessions SET index_state = 'error' WHERE session_id = ?1").bind(session.id).run();
        spent += 1;
        console.log(JSON.stringify({ event: 'parse.export.oversized_conversation', file_id: file.id, session: session.id, est_subrequests: estSubreq }));
        continue;
      }
      if (estSubreq > EXPORT_OVERSIZED_CEILING && written.size > 0) {
        // Big enough to deserve its own invocation and this slice already WROTE a conversation — cut BEFORE
        // it so the continuation runs it alone next invocation, keeping its writeSession clear of the cap.
        // Gate on written.size, NOT spent: `spent` was already bumped by THIS conversation's ownership
        // lookup, so `spent > 0` is true even when the oversized conversation is the FIRST in the slice —
        // which would break without advancing idx and re-enqueue the SAME offset forever (archive stuck
        // pending). written.size is 0 until a PRIOR conversation is written, so a leading oversized
        // conversation falls through and is written ALONE (it still fits under the cap), making progress.
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
    await raiseExportRetry(file, env, written, contentHash, e);
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
    await env.PARSE_QUEUE.send({ file_id: file.id, r2_key: file.r2_key, reason, content_hash: contentHash, offset: sliceEnd });
    console.log(
      JSON.stringify({ event: 'parse.export.slice', file_id: file.id, offset, slice_end: sliceEnd, total: archive.sessions.length, written: written.size }),
    );
    return spent;
  }

  // ── CLEANUP PHASE (budgeted + resumable) ─────────────────────────────────────────────────────────
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
  // parse can't delete a conversation the current bytes still contain, because its recheck returns
  // early). The residual window (bytes change AFTER this recheck but before markParsed) is harmless: the
  // fresh parse rewrites every conversation and re-runs cleanup against the new bytes.
  //
  // Two regimes per stale session:
  //  - archive.skipped === 0 (every row parsed): a GENUINE deletion — delete its derived rows + session
  //    row (matching delete+reinsert reparse semantics; raw R2 untouched). A well-formed empty array
  //    clears everything this file owned; the invalid case already returned above.
  //  - archive.skipped > 0 (a row was malformed / id renamed away): we can't match an id-less skipped row
  //    back to a prior session, so we must NOT delete (round-12's no-destructive-delete stance). Flip it
  //    to index_state='error' instead (rows kept for discoverability; state honestly says the canonical
  //    can't serve it).
  // Either way the session joins `recovered`, kicking the sibling-archive fan-out so a cross-machine or
  // older archive that still holds the conversation re-claims it (reason:'recover' guards a healthy owner).
  //
  // The keep-set is the WHOLE archive's non-empty conversations, not this invocation's `written` slice:
  // owned sessions include conversations written by EARLIER slices, so keying off `written` would wrongly
  // delete them. "Owned by this file AND not a non-empty conversation in the archive" is exactly stale.
  const keep = new Set(archive.sessions.filter((s) => s.turns.length > 0).map((s) => s.id));
  const CLEANUP_PAGE = 200;
  // TOCTOU guard on the deletes THEMSELVES (not just the per-page recheck above): a changed-hash upload
  // landing between that recheck and this batch would otherwise let us delete a session the NEW archive
  // still contains. db.batch runs in ONE transaction, so embedding `EXISTS (files.content_hash = expected)`
  // in every delete makes the ownership check and the deletes atomic — they all no-op together if the hash
  // moved on. (When the message carries no content_hash — legacy — there's nothing to guard against.)
  const cleanupGuardSql = contentHash !== undefined ? ' AND EXISTS (SELECT 1 FROM files WHERE id = ?2 AND content_hash = ?3)' : '';
  const bindCleanup = (stmt: D1PreparedStatement, sessionId: string): D1PreparedStatement =>
    contentHash !== undefined ? stmt.bind(sessionId, file.id, contentHash) : stmt.bind(sessionId);
  let cursor = cleanupCursor ?? '';
  const recovered = new Set<string>();
  let kicked = false; // kick sibling archives ONCE per invocation, before the first stale delete
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
    // Re-guard ownership on every page, AFTER fetching it: a re-upload landing during cleanup (between
    // the pre-cleanup recheck and here) moved this row's bytes on, so the sessions we're about to delete
    // may be ones the CURRENT archive still contains. Abort — delete nothing more, revert whatever THIS
    // invocation wrote (a pure cleanup pass wrote nothing → no-op), and let the fresh parse own the whole
    // archive end to end. This is what preserves "a stale parse never deletes a dropped conversation" now
    // that markParsed (with its atomic content_hash guard) runs AFTER cleanup rather than before it.
    if (contentHash !== undefined) {
      const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1').bind(file.id).first<{ content_hash: string }>();
      if (recheck?.content_hash !== contentHash) {
        await revertOwnedReady(file, env);
        console.log(JSON.stringify({ event: 'parse.export.superseded', file_id: file.id, phase: 'cleanup', cursor }));
        return spent;
      }
    }
    let budgetHit = false;
    for (const { session_id } of page.results) {
      if (spent >= EXPORT_QUERY_BUDGET) {
        budgetHit = true;
        break;
      }
      cursor = session_id; // advance past every row we've decided on (kept OR reconciled)
      if (keep.has(session_id)) continue;
      // This session is stale and about to be reconciled. Kick sibling archives FIRST (once per
      // invocation), BEFORE any delete, so an overlapping archive always has a 'pending' message to
      // re-claim it — the delete can never outrun the recovery (round 6 finding 4). A flip failure raises
      // ExportRetry here, with nothing deleted yet, so the retry re-runs the page cleanly.
      if (!kicked) {
        spent += await kickSiblings(file, env);
        kicked = true;
      }
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

  // Overlapping archives are recovered by kickSiblings ABOVE (called before the first delete of each
  // invocation), not here — deleting a session before its sibling has a 'pending' recovery message would
  // reintroduce the window where a lost flip strands the sibling terminal with its rows gone (finding 4).

  // Cleanup exhausted the budget with stale rows still remaining: re-enqueue a CLEANUP continuation
  // (offset pinned at the archive length marks the cleanup phase; cleanup_cursor resumes the scan) and
  // STOP — still WITHOUT markParsed, so the file stays 'pending' until cleanup drains.
  if (!cleanupComplete) {
    try {
      await env.PARSE_QUEUE.send({
        file_id: file.id,
        r2_key: file.r2_key,
        reason,
        content_hash: contentHash,
        offset: archive.sessions.length,
        cleanup_cursor: cursor,
      });
    } catch {
      // The cleanup continuation couldn't be enqueued. The archive is FULLY written — its 'ready' sessions
      // are valid — so, unlike a WRITE throw, we do NOT revert them: force the file back to 'pending'
      // (hash-guarded, so a fresher re-upload isn't clobbered) and raise the retry sentinel directly, so the
      // consumer skips markError and just retries this idempotent cleanup page (the same-cursor retry
      // resumes the scan). Even if retries exhaust to the DLQ it rests 'pending' (visible to the
      // pipeline-stuck alert), never terminal 'error' with unreconciled stale sessions.
      await forcePending(file, env, contentHash);
      console.log(JSON.stringify({ event: 'parse.export.cleanup_send_failed', file_id: file.id, cursor }));
      throw new ExportRetry(`cleanup continuation send failed at cursor ${cursor}`);
    }
    console.log(
      JSON.stringify({ event: 'parse.export.cleanup', file_id: file.id, cursor, recovered_kicked: recovered.size, done: false }),
    );
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

  console.log(
    JSON.stringify({
      event: 'parse.export',
      file_id: file.id,
      harness: archive.harness,
      conversations: archive.sessions.length,
      written: written.size,
      recovered_kicked: recovered.size,
      skipped: archive.skipped,
    }),
  );
  return spent;
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
  const sql = `UPDATE files SET parse_state = ?2, parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), parsed_size = ?3, parse_error = ?4
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

/** Force this file back to parse_state='pending' (hash-guarded when the message carries a hash, so a
 * concurrent fresh upload that already moved the row on is not clobbered). The invariant every retryable
 * export failure restores: a row with an outstanding parse message must be NON-TERMINAL, so files/check
 * and the same-hash upload fast path can re-enqueue it. */
async function forcePending(file: FileRow, env: Env, contentHash: string | undefined): Promise<void> {
  await env.DB.prepare(`UPDATE files SET parse_state = 'pending' WHERE id = ?1${contentHash !== undefined ? ' AND content_hash = ?2' : ''}`)
    .bind(...(contentHash !== undefined ? [file.id, contentHash] : [file.id]))
    .run();
}

/** Handle a transient (retryable) throw out of an export parse: revert THIS invocation's writes, force the
 * file 'pending', and raise the ExportRetry sentinel so the consumer retries the same idempotent message
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
async function raiseExportRetry(file: FileRow, env: Env, written: Set<string>, contentHash: string | undefined, e: unknown): Promise<never> {
  try {
    await revertSlice(written, env);
  } catch (revertErr) {
    console.log(JSON.stringify({ event: 'parse.export.revert_failed', file_id: file.id, error: String(revertErr) }));
  }
  try {
    await forcePending(file, env, contentHash);
  } catch (pendingErr) {
    console.log(JSON.stringify({ event: 'parse.export.force_pending_failed', file_id: file.id, error: String(pendingErr) }));
  }
  console.log(JSON.stringify({ event: 'parse.export.transient', file_id: file.id, error: String(e) }));
  throw new ExportRetry(String(e));
}

/** Re-enqueue the sibling export-inbox files (ANY machine — conversation ids are globally unique per
 * account, and a same-account export can be uploaded from a different collector) so their reparse re-claims
 * any conversation THIS file is about to delete as stale. Called BEFORE the first delete of a cleanup
 * invocation (see the call site): a session must never be removed before an overlapping archive has a
 * NON-terminal ('pending') message to recover it — otherwise a lost flip on the final reconciliation would
 * strand a sibling terminal with its rows gone, silently dropping them from the index (round 6 finding 4).
 *
 * Only siblings still parse_state='parsed' are selected — the fan-out is idempotent at the QUERY level, not
 * via the per-invocation flag alone (round 7 finding 1). Once we flip a sibling to 'pending', a later
 * cleanup continuation's SELECT excludes it, so a multi-page cleanup flips each sibling exactly once instead
 * of O(pages × siblings) times. The excluded states are all correct to skip: 'pending'/'parsing' siblings
 * already have (or will get, via files/check) an active parse message; 'error' can't recover; 'skipped'/
 * 'superseded' are dedup/replaced copies whose live content is owned by a 'parsed' file that IS in this set.
 * Returns the subrequest cost so the cleanup budget still bounds the invocation. markPendingAndEnqueue flips
 * a sibling to 'pending' THEN sends: a SEND failure after the flip is safe (files/check re-enqueues the
 * 'pending' row), so it's swallowed; a FLIP failure leaves the sibling terminal, so raise ExportRetry — and
 * because nothing has been deleted yet, the retry re-runs the whole idempotent cleanup page cleanly. */
async function kickSiblings(file: FileRow, env: Env): Promise<number> {
  const others = await env.DB.prepare(
    `SELECT id, r2_key, content_hash FROM files WHERE store = ?1 AND id != ?2 AND parse_state = 'parsed'`,
  )
    .bind(file.store, file.id)
    .all<{ id: number; r2_key: string; content_hash: string }>();
  let spent = 1; // the sibling SELECT
  let flipFailed = false;
  for (const other of others.results) {
    try {
      await markPendingAndEnqueue(other, 'recover', env);
      spent += 2; // flip UPDATE + queue send
    } catch (e) {
      const row = await env.DB.prepare('SELECT parse_state FROM files WHERE id = ?1').bind(other.id).first<{ parse_state: string }>();
      spent += 3; // the attempted flip/send + the state re-check
      console.log(JSON.stringify({ event: 'parse.export.recover_kick_failed', file_id: file.id, sibling: other.id, sibling_state: row?.parse_state ?? null, error: String(e) }));
      if (row?.parse_state !== 'pending') flipFailed = true;
    }
  }
  if (flipFailed) throw new ExportRetry('recovery fan-out: a sibling flip failed');
  return spent;
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
        `INSERT INTO sessions (session_id, harness, machine_id, os, canonical_file_id, cwd, repo_url, git_branch, models,
                               primary_model, title, started_at, ended_at, parent_session_id, parent_tool_use_id, is_sidechain,
                               turn_count, block_count, tokens_in, tokens_out, tokens_reasoning, tokens_cached, index_state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'ready',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT (session_id) DO UPDATE SET
           harness = excluded.harness, machine_id = excluded.machine_id, os = excluded.os,
           canonical_file_id = excluded.canonical_file_id, cwd = excluded.cwd, repo_url = excluded.repo_url,
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
