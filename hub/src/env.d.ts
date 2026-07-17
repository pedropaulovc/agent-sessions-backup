interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  KV: KVNamespace;
  PARSE_QUEUE: Queue<ParseMessage>;
  ENVIRONMENT: 'development' | 'preview' | 'production';
  API_HOST: string;
  VIEWER_HOST: string;
  SETUP_TOKEN?: string;
  CF_API_TOKEN?: string;
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
}
