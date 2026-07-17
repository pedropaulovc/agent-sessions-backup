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

export async function consumeParseBatch(batch: MessageBatch<ParseMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await parseOne(msg.body, env);
      msg.ack();
    } catch (e) {
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
      msg.retry();
    }
  }
}

async function parseOne(job: ParseMessage, env: Env): Promise<void> {
  const file = await env.DB.prepare(
    'SELECT id, machine_id, store, relpath, r2_key, size, mtime, harness, session_id, content_hash FROM files WHERE id = ?1',
  )
    .bind(job.file_id)
    .first<FileRow>();
  if (!file) return;

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
  if (job.content_hash !== undefined && file.content_hash !== job.content_hash) return;

  const det = detect(file.store, file.relpath, file.machine_id);

  if (det.kind === 'subagent-meta') {
    await linkSubagentMeta(file, env);
    await markParsed(file.id, env, 'parsed', undefined, undefined, job.content_hash);
    return;
  }
  if (det.kind === 'export-archive') {
    await parseExportInto(file, env, job.content_hash);
    return;
  }
  if (!det.sessionId || !SINGLE_SESSION_HARNESSES.has(det.harness)) {
    await markParsed(file.id, env, 'skipped', undefined, undefined, job.content_hash);
    return;
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
    return;
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
    if (!updated) return;

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
    return;
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
    return;
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
    if (recheck?.content_hash !== job.content_hash) return;
  }

  await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(det.sessionId).run();
  await writeSession(parsed, file, env);
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
    return;
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
}

/**
 * Ingest an official-export ZIP: fan it out into per-conversation sessions. The archive itself
 * is not a single session (files.session_id stays NULL, so it never enters canonical dedupe), and
 * export only BACKFILLS — a conversation already owned by a live CDP capture (chatgpt-web/
 * claude-web store) is left untouched, so re-running an old export can't overwrite fresher
 * captured content. A conversation captured LATER by CDP still wins automatically: its own file
 * (session_id set) becomes canonical and its writeSession overwrites the export-written row.
 */
async function parseExportInto(file: FileRow, env: Env, contentHash?: string): Promise<void> {
  const obj = await env.RAW.get(file.r2_key);
  if (!obj) throw new Error(`r2_object_missing:${file.r2_key}`);
  const archive = parseExportArchive(new Uint8Array(await obj.arrayBuffer()));

  // Stale-parse guard (mirrors the single-session path): a re-upload can change this row's
  // content_hash while we were reading the OLD ZIP bytes. Recheck right before writing; if it
  // moved on, a fresher message already owns the current bytes and will do its own rewrite —
  // publishing this OLD archive's sessions now would advertise stale content as ready.
  if (contentHash !== undefined) {
    const recheck = await env.DB.prepare('SELECT content_hash FROM files WHERE id = ?1')
      .bind(file.id)
      .first<{ content_hash: string }>();
    if (recheck?.content_hash !== contentHash) return;
  }

  // A corrupt / missing-conversations.json / non-array archive is NOT a well-formed export: keep
  // whatever sessions this file already owns (preservation-first) but mark the file 'error' with
  // the reason, so /status surfaces it instead of silently reporting the replacement as parsed.
  // (An empty-but-valid array is `valid` and falls through to normal write + cleanup, clearing
  // everything this file used to own.)
  if (!archive.valid) {
    await markParsed(file.id, env, 'error', file.size, archive.error ?? 'invalid export archive', contentHash);
    console.log(JSON.stringify({ event: 'parse.export.error', file_id: file.id, error: archive.error }));
    return;
  }

  // Session ids we actually WROTE this parse (turns > 0 and not owned by a live CDP capture). A
  // conversation that is present in the new archive but now parses to zero turns is deliberately
  // NOT kept, so its stale rows get cleared below (same as the single-session empty-parse path).
  const written = new Set<string>();
  for (const session of archive.sessions) {
    if (session.turns.length === 0) continue;
    const existing = await env.DB.prepare(
      `SELECT f.store FROM sessions s JOIN files f ON f.id = s.canonical_file_id WHERE s.session_id = ?1`,
    )
      .bind(session.id)
      .first<{ store: string }>();
    if (existing && (existing.store === 'chatgpt-web' || existing.store === 'claude-web')) continue;
    await writeSession(session, file, env);
    written.add(session.id);
  }

  // A re-uploaded VALID archive that drops (or now-empties) a conversation must not leave its old
  // session behind: the ZIP's files row has session_id NULL, so the normal
  // reparse-clears-stale-rows path never touches per-conversation sessions. Delete any session
  // still owned by THIS file that we did NOT just (re)write — matching delete+reinsert reparse
  // semantics (derived rows + this session row; raw R2 untouched). Runs unconditionally now: the
  // invalid case already returned above, so a well-formed empty array correctly clears everything
  // this file owned, while a corrupt re-upload never reaches here.
  const recovered = new Set<string>();
  {
    const owned = await env.DB.prepare('SELECT session_id FROM sessions WHERE canonical_file_id = ?1')
      .bind(file.id)
      .all<{ session_id: string }>();
    for (const { session_id } of owned.results) {
      if (written.has(session_id)) continue;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO blocks_fts (blocks_fts, rowid, text) SELECT 'delete', id, text FROM blocks WHERE session_id = ?1 AND text IS NOT NULL`,
        ).bind(session_id),
        env.DB.prepare('DELETE FROM blocks WHERE session_id = ?1').bind(session_id),
        env.DB.prepare('DELETE FROM usage WHERE session_id = ?1').bind(session_id),
        env.DB.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(session_id),
      ]);
      recovered.add(session_id);
    }
  }

  // Overlapping archives: a session we just deleted may still live in an OLDER export file that
  // once lost ownership to this one (archives keep no files.session_id duplicates for the normal
  // recovery path to pick from). Re-enqueue the other export-inbox files on this machine so their
  // reparse re-claims any conversation they still contain — a transient absence self-heals.
  // Exports are few (one-time backfills), so this fan-out is cheap and rare.
  if (recovered.size > 0) {
    const others = await env.DB.prepare(
      `SELECT id, r2_key, content_hash FROM files WHERE machine_id = ?1 AND store = ?2 AND id != ?3 AND parse_state != 'error'`,
    )
      .bind(file.machine_id, file.store, file.id)
      .all<{ id: number; r2_key: string; content_hash: string }>();
    for (const other of others.results) await markPendingAndEnqueue(other, 'recover', env);
  }

  // Guarded markParsed: if a re-upload changed this row's hash while we were writing off the OLD
  // ZIP bytes, the fresh message owns the rewrite — flip the sessions we just wrote back to
  // 'parsing' so they don't advertise stale content as ready (upload.ts can't do this for an
  // archive, whose files row has no session_id). Safe under queue max_concurrency:1.
  const { updated } = await markParsed(file.id, env, 'parsed', file.size, null, contentHash);
  if (!updated) {
    for (const id of written) {
      await env.DB.prepare("UPDATE sessions SET index_state = 'parsing' WHERE session_id = ?1").bind(id).run();
    }
    return;
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

/** Replace a session's index rows atomically-enough: FTS delete → blocks delete → reinsert → FTS rebuild from blocks. */
async function writeSession(s: NormalizedSession, file: FileRow, env: Env): Promise<void> {
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

  for (const chunk of chunkArr(stmts, 90)) await db.batch(chunk);

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
}

function chunkArr<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
