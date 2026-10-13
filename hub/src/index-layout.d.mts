export declare const INDEX_LAYOUT: 'fnv1a32-utf8-mod256';
export declare const INDEX_HASH_BUCKETS: 256;
export declare const INDEX_MAX_SHARDS: 16;
export declare const INDEX_ID_SPAN: number;
export declare function parseIndexShardCount(value: unknown): number;
export declare function indexShardBindingName(shard: number): string;
export declare function indexHashBucket(sessionId: string): number;
export declare function indexShardForSessionId(sessionId: string, count: number): number;
export declare function indexIdBase(shard: number): number;
export declare function indexIdLimit(shard: number): number;
export declare const SHARD_META_INIT_SQL: string;
export declare const SHARD_META_SELECT_SQL: string;
export declare const BLOCK_COLUMNS: readonly string[];
export declare const SESSION_CATALOG_COLUMNS: readonly string[];
export declare const STAR_CATALOG_COLUMNS: readonly string[];
export declare const SESSION_CATALOG_PAYLOAD_BYTES: number;
export declare const SESSION_CATALOG_RETIRE_SQL: string;
export interface SessionCatalogEntry {
  sessionId: string;
  /** main session_catalog_versions.version */
  version: number;
  /** main sessions row (SESSION_CATALOG_COLUMNS), or null when absent on main */
  session: Readonly<Record<string, unknown>> | null;
  /** main starred_turns rows for the session */
  stars: readonly Readonly<Record<string, unknown>>[];
}
export interface SessionCatalogStatement {
  sql: string;
  params: unknown[];
}
export interface SessionCatalogBatch {
  /** Entries covered once EVERY shard accepted `statements`. */
  sessionIds: string[];
  /** ONE atomic batch to run on every shard. */
  statements: SessionCatalogStatement[];
}
export declare function sessionCatalogBatches(entries: readonly SessionCatalogEntry[]): SessionCatalogBatch[];
