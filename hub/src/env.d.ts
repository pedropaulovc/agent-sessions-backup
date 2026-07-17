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
  reason: 'upload' | 'reindex';
}
