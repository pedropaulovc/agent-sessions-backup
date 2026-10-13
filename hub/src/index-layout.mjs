// Fixed placement of searchable transcript blocks across the index shard databases.
//
// Pure and dependency-free so the Worker, the protected-CI provisioner, and the frozen copier route
// a session id to the same shard. The layout is immutable once data exists: every shard records it
// in `shard_meta`, and first use refuses a binding whose recorded layout disagrees.
//
// Placement: FNV-1a 32-bit over the UTF-8 bytes of the session id, reduced to one of 256 fixed
// buckets, then bucket modulo the configured shard count. The count divides 256, so a bucket never
// straddles shards.

export const INDEX_LAYOUT = 'fnv1a32-utf8-mod256';
export const INDEX_HASH_BUCKETS = 256;
export const INDEX_MAX_SHARDS = 16;

// Block ids are globally unique across shards. Ids copied from the legacy main `blocks` table are
// all below 2**40 and keep their values. New ids come from a per-shard counter that starts at
// (k + 1) * 2**40 and never crosses into the next shard's range, all below 2**53.
export const INDEX_ID_SPAN = 2 ** 40;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const encoder = new TextEncoder();

export function parseIndexShardCount(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`INDEX_SHARD_COUNT must be a positive decimal integer, got ${JSON.stringify(value)}`);
  }
  const count = Number(value);
  if (count > INDEX_MAX_SHARDS || INDEX_HASH_BUCKETS % count !== 0) {
    throw new Error(`INDEX_SHARD_COUNT ${count} must divide ${INDEX_HASH_BUCKETS} and be at most ${INDEX_MAX_SHARDS}`);
  }
  return count;
}

function assertShardIndex(shard) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= INDEX_MAX_SHARDS) {
    throw new Error(`invalid index shard ${shard}`);
  }
}

export function indexShardBindingName(shard) {
  assertShardIndex(shard);
  return `IDX${String(shard).padStart(2, '0')}`;
}

export function indexHashBucket(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('session id must be a non-empty string');
  }
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(sessionId)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash % INDEX_HASH_BUCKETS;
}

export function indexShardForSessionId(sessionId, count) {
  if (!Number.isInteger(count) || count < 1 || count > INDEX_MAX_SHARDS || INDEX_HASH_BUCKETS % count !== 0) {
    throw new Error(`invalid index shard count ${count}`);
  }
  return indexHashBucket(sessionId) % count;
}

export function indexIdBase(shard) {
  assertShardIndex(shard);
  return (shard + 1) * INDEX_ID_SPAN;
}

export function indexIdLimit(shard) {
  assertShardIndex(shard);
  return (shard + 2) * INDEX_ID_SPAN;
}

// Records a shard's identity exactly once. Params: shard_index, shard_count, layout, next_block_id.
// An existing row is never rewritten; callers read it back and compare.
export const SHARD_META_INIT_SQL =
  'INSERT INTO shard_meta (id, shard_index, shard_count, layout, next_block_id) VALUES (1, ?1, ?2, ?3, ?4) '
  + 'ON CONFLICT (id) DO NOTHING';

export const SHARD_META_SELECT_SQL =
  'SELECT shard_index, shard_count, layout, next_block_id FROM shard_meta WHERE id = 1';

// Column order matches main's `blocks` table after migration 0034, so table_info comparisons and
// canonical row digests line up column for column.
export const BLOCK_COLUMNS = Object.freeze([
  'id', 'session_id', 'file_id', 'turn_index', 'block_index', 'role', 'btype', 'tool_name', 'ts',
  'byte_start', 'byte_len', 'truncated', 'text', 'on_main_path', 'row_hash', 'media_byte_start',
  'media_byte_len', 'media_type',
]);

// Every column of main's authoritative `sessions` table, in main's column order.
export const SESSION_CATALOG_COLUMNS = Object.freeze([
  'session_id', 'harness', 'machine_id', 'os', 'canonical_file_id', 'cwd', 'repo_url', 'git_branch',
  'models', 'primary_model', 'title', 'started_at', 'ended_at', 'parent_session_id',
  'parent_tool_use_id', 'is_sidechain', 'turn_count', 'block_count', 'tokens_in', 'tokens_out',
  'tokens_reasoning', 'tokens_cached', 'index_state', 'updated_at', 'project_name',
  'first_interaction_title', 'cost_usd', 'cost_calls', 'cost_priced_calls',
]);

export const STAR_CATALOG_COLUMNS = Object.freeze(['session_id', 'turn_key', 'starred_at']);

// ---- Session catalog replication (shared by src/session-catalog.ts and the protected-CI copier) ----

/** UTF-8 byte cap of the JSON parameter one set-based shard catalog batch receives (D1 caps a value
 * at 2 MB). Entries beyond it go into further payloads. This is a transport limit only: an entry
 * that alone exceeds it is sent as its own batch with every value bound separately. */
export const SESSION_CATALOG_PAYLOAD_BYTES = 1_000_000;

// Payload: a JSON array of {s: session_id, v: main session_catalog_versions.version, p: presence,
// 'deleted' when the session row is absent on main else 'present', r: sessions row values in
// SESSION_CATALOG_COLUMNS order or null, t: [[turn_key, starred_at], ...] (main's complete
// starred_turns for the session)}.
// json_extract yields INTEGER, REAL, TEXT or NULL exactly as the JSON scalar was written, so every
// column keeps its value and NULL. `applied` holds the entries whose version the shard now records:
// a newer version just replaced the shard's, or the same version re-applies identically. An older
// version is absent from it, so every guarded statement skips it.
const CATALOG_APPLIED = `WITH applied AS (
  SELECT c.session_id, e.value AS entry
    FROM json_each(?1) e
    JOIN catalog_versions c
      ON c.session_id = json_extract(e.value, '$.s') AND c.version = json_extract(e.value, '$.v'))`;

// Set-based form: run in order as ONE shard batch, each statement bound to the same payload string.
const CATALOG_PAYLOAD_SQL = [
  `INSERT INTO catalog_versions (session_id, version, presence)
   SELECT json_extract(value, '$.s'), json_extract(value, '$.v'), json_extract(value, '$.p') FROM json_each(?1) WHERE true
   ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, presence = excluded.presence
   WHERE excluded.version > catalog_versions.version`,
  `${CATALOG_APPLIED} DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM applied)`,
  `${CATALOG_APPLIED} DELETE FROM starred_turns WHERE session_id IN (SELECT session_id FROM applied)`,
  `${CATALOG_APPLIED} INSERT INTO sessions (${SESSION_CATALOG_COLUMNS.join(', ')})
   SELECT ${SESSION_CATALOG_COLUMNS.map((_, index) => `json_extract(entry, '$.r[${index}]')`).join(', ')}
     FROM applied WHERE json_type(entry, '$.r') = 'array'`,
  `${CATALOG_APPLIED} INSERT INTO starred_turns (${STAR_CATALOG_COLUMNS.join(', ')})
   SELECT applied.session_id, json_extract(star.value, '$[0]'), json_extract(star.value, '$[1]')
     FROM applied, json_each(applied.entry, '$.t') AS star`,
];

// Single-entry form for an entry whose JSON exceeds the payload cap. Same guard: ?1 session_id,
// ?2 version. Each sessions value and each star value is its own bind, so only D1's per-value limit
// applies, which main's own row already satisfies.
const CATALOG_ENTRY_GUARD = 'EXISTS (SELECT 1 FROM catalog_versions WHERE session_id = ?1 AND version = ?2)';
const CATALOG_ENTRY_VERSION_SQL = `INSERT INTO catalog_versions (session_id, version, presence) VALUES (?1, ?2, ?3)
   ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, presence = excluded.presence
   WHERE excluded.version > catalog_versions.version`;
const CATALOG_ENTRY_SESSION_SQL = `INSERT INTO sessions (${SESSION_CATALOG_COLUMNS.join(', ')})
   SELECT ${SESSION_CATALOG_COLUMNS.map((_, index) => `?${index + 3}`).join(', ')} WHERE ${CATALOG_ENTRY_GUARD}`;
// 2 binds per star plus the 2 guard binds stays under D1's 100-bind limit.
const CATALOG_ENTRY_STARS_PER_INSERT = 48;

/** Main statement retiring outbox entries covered by synced versions, run only after EVERY shard
 * accepted them. ?1 = JSON array of [session_id, version] pairs; keeps entries with larger seqs. */
export const SESSION_CATALOG_RETIRE_SQL = `DELETE FROM session_catalog_outbox WHERE seq IN (
  SELECT o.seq FROM json_each(?1) e
    JOIN session_catalog_outbox o
      ON o.session_id = json_extract(e.value, '$[0]') AND o.seq <= json_extract(e.value, '$[1]'))`;

function entryStatements({ sessionId, version, session, stars }) {
  const statements = [
    { sql: CATALOG_ENTRY_VERSION_SQL, params: [sessionId, version, session ? 'present' : 'deleted'] },
    { sql: `DELETE FROM sessions WHERE session_id = ?1 AND ${CATALOG_ENTRY_GUARD}`, params: [sessionId, version] },
    { sql: `DELETE FROM starred_turns WHERE session_id = ?1 AND ${CATALOG_ENTRY_GUARD}`, params: [sessionId, version] },
  ];
  if (session) {
    statements.push({
      sql: CATALOG_ENTRY_SESSION_SQL,
      params: [sessionId, version, ...SESSION_CATALOG_COLUMNS.map((column) => session[column] ?? null)],
    });
  }
  for (let start = 0; start < stars.length; start += CATALOG_ENTRY_STARS_PER_INSERT) {
    const slice = stars.slice(start, start + CATALOG_ENTRY_STARS_PER_INSERT);
    const values = slice.map((_, index) => `(?${3 + index * 2}, ?${4 + index * 2})`).join(', ');
    statements.push({
      sql: `INSERT INTO starred_turns (${STAR_CATALOG_COLUMNS.join(', ')})
   SELECT ?1, column1, column2 FROM (VALUES ${values}) WHERE ${CATALOG_ENTRY_GUARD}`,
      params: [sessionId, version, ...slice.flatMap((star) => [star.turn_key ?? null, star.starred_at ?? null])],
    });
  }
  return statements;
}

/**
 * Builds the shard batches that apply catalog entries ({sessionId, version: main
 * session_catalog_versions.version, session: main sessions row object | null, stars: main
 * starred_turns row objects}). Each returned batch is {sessionIds, statements}: run `statements`
 * ({sql, params}) as ONE atomic batch on EVERY shard; once every shard accepted it, the entries in
 * `sessionIds` are synced and may be retired. Entries are packed into set-based JSON payload
 * batches of at most SESSION_CATALOG_PAYLOAD_BYTES; an entry larger than that gets its own
 * individually bound batch. Every form records the version first and changes rows only while the
 * shard holds that version.
 */
export function sessionCatalogBatches(entries) {
  const batches = [];
  let parts = [];
  let partIds = [];
  let bytes = 2;
  const flush = () => {
    if (parts.length === 0) return;
    const payload = `[${parts.join(',')}]`;
    batches.push({ sessionIds: partIds, statements: CATALOG_PAYLOAD_SQL.map((sql) => ({ sql, params: [payload] })) });
    parts = [];
    partIds = [];
    bytes = 2;
  };
  for (const entry of entries) {
    const { sessionId, version, session, stars } = entry;
    const part = JSON.stringify({
      s: sessionId,
      v: version,
      p: session ? 'present' : 'deleted',
      r: session ? SESSION_CATALOG_COLUMNS.map((column) => session[column] ?? null) : null,
      t: stars.map((star) => [star.turn_key ?? null, star.starred_at ?? null]),
    });
    const partBytes = encoder.encode(part).length;
    if (partBytes + 2 > SESSION_CATALOG_PAYLOAD_BYTES) {
      batches.push({ sessionIds: [sessionId], statements: entryStatements(entry) });
      continue;
    }
    if (parts.length > 0 && bytes + 1 + partBytes > SESSION_CATALOG_PAYLOAD_BYTES) flush();
    bytes += (parts.length > 0 ? 1 : 0) + partBytes;
    parts.push(part);
    partIds.push(sessionId);
  }
  flush();
  return batches;
}
