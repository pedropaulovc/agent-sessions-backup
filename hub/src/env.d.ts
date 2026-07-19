interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  KV: KVNamespace;
  PARSE_QUEUE: Queue<ParseMessage>;
  ENVIRONMENT: 'development' | 'preview' | 'production';
  API_HOST: string;
  VIEWER_HOST: string;
  SETUP_TOKEN?: string;
  // Cloudflare's managed client-certificate lifecycle is authorized through a private
  // OAuth client. The singleton Durable Object owns the grant and never returns bearer
  // credentials to the main Worker; callers can invoke only its fixed certificate API.
  CF_ZONE_ID?: string;
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_REDIRECT_URI?: string;
  CF_OAUTH_SCOPES?: string;
  CF_OAUTH_BROKER?: DurableObjectNamespace;
  DEV_AUTH?: string;
}

interface ParseMessage {
  file_id: number;
  r2_key: string;
  reason: 'upload' | 'reindex' | 'recover';
  /** The files row's content_hash as of enqueue time. Lets the consumer detect a re-upload that
   * changed the row's hash while this message's parse was in flight, and avoid marking the row
   * 'parsed' for content it didn't actually parse. Optional so legacy in-flight messages (enqueued
   * before this field existed) still process with today's unconditional behavior. */
  content_hash?: string;
  /** Export-archive continuation cursor: the index of the first conversation this invocation should
   * write. An export ZIP fans out to hundreds of per-conversation writes (~5 D1 queries each), which
   * would blow the ~1000-queries/invocation cap in one shot — so parseExportInto processes a bounded
   * slice, then re-enqueues itself with offset advanced until the whole archive is written. Absent =
   * start at 0. `offset === archive.sessions.length` marks the CLEANUP phase (all conversations
   * written; now reconciling stale sessions). Only meaningful for export-archive files. */
  offset?: number;
  /** Export-archive CLEANUP-phase cursor: the last session_id already reconciled (deleted/flipped or
   * kept) by the budgeted stale-session cleanup. Present only on cleanup-phase continuations (paired
   * with offset === archive.sessions.length); the next invocation resumes deleting stale sessions at
   * `session_id > cleanup_cursor`. Absent on the first cleanup pass (starts at ''). markParsed runs
   * only once cleanup drains — so 'parsed' means every conversation written AND stale cleanup done. */
  cleanup_cursor?: string;
  /** Export-archive cleanup SUB-phase (only meaningful with offset === archive.sessions.length):
   *  - 'scan' (or absent on first cleanup entry) — walk this file's owned sessions looking for the first
   *    STALE one (owned, not in the archive). No sibling is touched and nothing is deleted while the scan
   *    finds only kept rows, so a clean re-parse (no dropped conversations) never kicks a sibling.
   *  - 'reserve' — a stale session was found; flip every sibling archive to 'pending' as a durable
   *    recovery RESERVATION, BEFORE any stale delete. No queue send here.
   *  - 'delete' — reservation is complete (every overlapping sibling is at least 'pending'); now delete
   *    the stale sessions and, once drained, best-effort send the recover messages.
   * Splitting flip-early / send-late is what keeps a recover message from ever existing before all the
   * deletes commit (round 11) — see the cleanup phase in consumer.ts. */
  cleanup_phase?: 'scan' | 'reserve' | 'delete' | 'send-late';
  /** Reservation-phase cursor: the last files.id already flipped to 'pending' by the sibling fan-out.
   * The next reserve continuation resumes at `id > kick_cursor`, so pages advance by id independent of
   * parse_state — a sibling that churns back to 'parsed' behind the cursor can't re-trigger a re-flip
   * (kills the livelock). Present only on 'reserve' continuations. */
  kick_cursor?: number;
  /** Number of sibling reservations this cleanup expects to still own. Carried on every reserve/delete
   *  continuation so a resumed invocation can detect partial as well as total reservation loss before it
   *  deletes anything. Each entry refreshes the owned rows' reserved_at; fewer refreshed rows than expected
   *  means a heal reclaimed part of the prefix, so the cleanup restarts from page zero. */
  reservation_count?: number;
  /** Send-late resume cursor: the last sibling files.id already handled by the recover fan-out. Present only
   *  on 'send-late' continuations (round 15, 3608955881) — the owner is already 'parsed'; the continuation
   *  resumes sendRecoverToReservedSiblings at `id > send_cursor` without re-reading R2 or re-running cleanup. */
  send_cursor?: number;
  /** Cleanup file whose durable reservation authorized this delivery. Pending uploads retain full upload
   * semantics, but only this owner-tagged send-late replacement may bypass the fresh-reservation guard. */
  reservation_owner?: number;
  /** Durable per-row reservation generation selected by send-late. Owner ids can be reused by a later cleanup
   * of the same archive, so both owner and generation must still match before this delivery may consume the row. */
  reservation_generation?: number;
}
