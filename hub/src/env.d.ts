interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  KV: KVNamespace;
  PARSE_QUEUE: Queue<ParseMessage>;
  ENVIRONMENT: 'development' | 'preview' | 'production';
  API_HOST: string;
  VIEWER_HOST: string;
  SETUP_TOKEN?: string;
  // Cloudflare zone id (public) + a zone-scoped token with SSL and Certificates:Edit,
  // used only by POST /api/v1/certs/renew to mint a successor client cert at the managed
  // CA. The token is a wrangler secret (`wrangler secret put CF_CLIENT_CERT_TOKEN`); unset
  // until the user provisions it, in which case cert renewal reports 503. See infra/cf/mtls.md.
  CF_ZONE_ID?: string;
  CF_CLIENT_CERT_TOKEN?: string;
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
}
