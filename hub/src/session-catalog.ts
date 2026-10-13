// Propagation of the authoritative session catalog (main `sessions` + `starred_turns`) to every
// index shard, so shard-local search can filter and cost-sort without cross-database joins.
//
// Main migration 0036 makes every INSERT/UPDATE/DELETE on `sessions` or `starred_turns` append the
// session id to the durable `session_catalog_outbox` and stamp `session_catalog_versions.version`
// with that outbox seq. The version is therefore strictly increasing per session across every
// change. A sync reads version + row + stars for a session in ONE main batch (one consistent
// snapshot), then applies them to every shard in batches guarded by the shard's `catalog_versions`
// (index-layout.mjs sessionCatalogBatches): a newer version replaces, an equal version re-applies
// identically, and an older (late, concurrent) sync changes nothing. A session absent from main is
// recorded as a tombstone (deleted = 1), so a late older sync cannot resurrect it. Stars always
// mirror main's starred_turns for the session, which survive a session delete exactly as on main.
//
// Writers call syncSessionCatalog with the ids they changed after their main commit. Once every
// shard has accepted a version, the sync retires that session's outbox entries up to it. The outbox
// is the durable backstop: drainIndexCatalog syncs the sessions of a bounded oldest-first slice.
//
// Every call spends at most its `maxSubrequests` allowance of D1 calls and reports what it spent.
// Sessions it could not afford keep their outbox entries and the result says 'pending'.

import {
  SESSION_CATALOG_COLUMNS,
  SESSION_CATALOG_RETIRE_SQL,
  STAR_CATALOG_COLUMNS,
  sessionCatalogBatches,
  type SessionCatalogEntry,
} from './index-layout.mjs';
import { indexDbs, mapIndexDbs } from './index-shards';

/** 'current': every requested session (or the whole outbox, for a drain) reached every shard.
 * 'pending': some did not within the allowance, or the outbox still holds entries. */
export type CatalogDrainState = 'current' | 'pending';

export interface CatalogSyncResult {
  state: CatalogDrainState;
  /** D1 calls actually made. */
  subrequests: number;
  /** Sessions whose catalog state every shard accepted and whose outbox entries were retired. */
  synced: number;
}

export interface CatalogSyncOptions {
  /** D1 call allowance for this call; defaults to DEFAULT_CATALOG_SUBREQUESTS. */
  maxSubrequests?: number;
}

export const DEFAULT_CATALOG_SUBREQUESTS = 256;

/** Session ids per main read round. */
export const SESSION_CATALOG_SYNC_CHUNK = 64;

// Sessions whose row plus stars measure above this many bytes are not fetched in the 64-id bulk
// read; each is read alone, bounding the bulk read's memory to about 64 * 64 KiB while a row of any
// valid size (D1 allows 2 MB) is still copied in full.
const CATALOG_BULK_ENTRY_BYTES = 64 * 1024;

/**
 * Cheapest D1 cost of syncing `uniqueIdCount` small sessions: per 64-id round one main read, one
 * batch per shard, one retirement. A planning estimate only; large rows cost more, and the
 * maxSubrequests allowance plus CatalogSyncResult.subrequests are what bound and report real spend.
 */
export function sessionCatalogSyncSubrequests(env: Env, uniqueIdCount: number): number {
  return Math.ceil(uniqueIdCount / SESSION_CATALOG_SYNC_CHUNK) * (2 + indexDbs(env).length);
}

type CatalogRow = Record<string, unknown>;

const SESSION_SELECT = `SELECT ${SESSION_CATALOG_COLUMNS.join(', ')} FROM sessions`;
const STAR_SELECT = `SELECT ${STAR_CATALOG_COLUMNS.join(', ')} FROM starred_turns`;
const ROW_BYTES = SESSION_CATALOG_COLUMNS.map((column) => `coalesce(length(CAST(s.${column} AS BLOB)), 0)`).join(' + ');
// ?1 = JSON array of session ids, ?2 = CATALOG_BULK_ENTRY_BYTES.
const BULK_IDS = `WITH ids AS (SELECT value AS session_id FROM json_each(?1)),
small AS (
  SELECT ids.session_id FROM ids
   WHERE coalesce((SELECT ${ROW_BYTES} FROM sessions s WHERE s.session_id = ids.session_id), 0)
       + (SELECT coalesce(sum(length(CAST(st.turn_key AS BLOB)) + length(CAST(st.starred_at AS BLOB))), 0)
            FROM starred_turns st WHERE st.session_id = ids.session_id) <= ?2)`;

function catalogEntries(
  sessionIds: readonly string[],
  versions: { session_id: string; version: number | null }[],
  sessions: CatalogRow[],
  stars: CatalogRow[],
): SessionCatalogEntry[] {
  const versionById = new Map(versions.map((row) => [row.session_id, row.version]));
  const sessionById = new Map(sessions.map((row) => [row.session_id as string, row]));
  const starsById = new Map<string, CatalogRow[]>();
  for (const star of stars) {
    const id = star.session_id as string;
    const list = starsById.get(id);
    if (list) list.push(star);
    else starsById.set(id, [star]);
  }
  const entries: SessionCatalogEntry[] = [];
  for (const sessionId of sessionIds) {
    const version = versionById.get(sessionId) ?? null;
    const session = sessionById.get(sessionId) ?? null;
    const sessionStars = starsById.get(sessionId) ?? [];
    if (version === null) {
      // Every sessions/starred_turns change stamps a version, so an id with none never existed.
      if (session || sessionStars.length > 0) {
        throw new Error(`session ${sessionId} has catalog rows but no catalog version on main`);
      }
      continue;
    }
    entries.push({ sessionId, version, session, stars: sessionStars });
  }
  return entries;
}

/** One consistent main snapshot of the small sessions among `sessionIds`, plus the large ids. */
async function readBulk(env: Env, sessionIds: readonly string[]): Promise<{ entries: SessionCatalogEntry[]; large: string[] }> {
  const ids = JSON.stringify(sessionIds);
  const [classified, sessions, stars] = await env.DB.batch([
    env.DB.prepare(`${BULK_IDS}
      SELECT ids.session_id, v.version, ids.session_id IN (SELECT session_id FROM small) AS small
        FROM ids LEFT JOIN session_catalog_versions v ON v.session_id = ids.session_id`).bind(ids, CATALOG_BULK_ENTRY_BYTES),
    env.DB.prepare(`${BULK_IDS} ${SESSION_SELECT} WHERE session_id IN (SELECT session_id FROM small)`)
      .bind(ids, CATALOG_BULK_ENTRY_BYTES),
    env.DB.prepare(`${BULK_IDS} ${STAR_SELECT} WHERE session_id IN (SELECT session_id FROM small) ORDER BY session_id, turn_key`)
      .bind(ids, CATALOG_BULK_ENTRY_BYTES),
  ]);
  const rows = classified.results as { session_id: string; version: number | null; small: number }[];
  const small = rows.filter((row) => row.small === 1);
  return {
    entries: catalogEntries(small.map((row) => row.session_id), small, sessions.results as CatalogRow[], stars.results as CatalogRow[]),
    large: rows.filter((row) => row.small !== 1).map((row) => row.session_id),
  };
}

/** One consistent main snapshot of a single (large) session. */
async function readOne(env: Env, sessionId: string): Promise<SessionCatalogEntry | undefined> {
  const [versions, sessions, stars] = await env.DB.batch([
    env.DB.prepare('SELECT session_id, version FROM session_catalog_versions WHERE session_id = ?1').bind(sessionId),
    env.DB.prepare(`${SESSION_SELECT} WHERE session_id = ?1`).bind(sessionId),
    env.DB.prepare(`${STAR_SELECT} WHERE session_id = ?1 ORDER BY turn_key`).bind(sessionId),
  ]);
  return catalogEntries(
    [sessionId],
    versions.results as { session_id: string; version: number }[],
    sessions.results as CatalogRow[],
    stars.results as CatalogRow[],
  )[0];
}

/**
 * Pushes the latest authoritative sessions row and stars for `sessionIds` to ALL shards, spending
 * at most `maxSubrequests` D1 calls. Monotonic per session; safe to call concurrently and
 * repeatedly. After every shard accepted a batch, retires the outbox entries its versions cover
 * (seq <= synced version, per session), so a writer's own sync leaves nothing for search to drain.
 * Sessions it could not afford are left to the outbox and reported as 'pending'. Throws if a D1
 * call fails; the outbox then keeps the change for the backstop drain.
 */
export async function syncSessionCatalog(
  env: Env,
  sessionIds: readonly string[],
  { maxSubrequests = DEFAULT_CATALOG_SUBREQUESTS }: CatalogSyncOptions = {},
): Promise<CatalogSyncResult> {
  const unique = [...new Set(sessionIds)];
  const shardCount = indexDbs(env).length;
  let subrequests = 0;
  let synced = 0;
  // Every step keeps one call in reserve for the round's retirement statement.
  const affordable = (calls: number): boolean => subrequests + calls + 1 <= maxSubrequests;
  const applyBatch = async (statements: { sql: string; params: unknown[] }[]): Promise<void> => {
    await mapIndexDbs(env, (db) => db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params))));
    subrequests += shardCount;
  };
  for (let start = 0; start < unique.length; start += SESSION_CATALOG_SYNC_CHUNK) {
    if (!affordable(1 + shardCount)) return { state: 'pending', subrequests, synced };
    const { entries, large } = await readBulk(env, unique.slice(start, start + SESSION_CATALOG_SYNC_CHUNK));
    subrequests += 1;
    const versionById = new Map(entries.map(({ sessionId, version }) => [sessionId, version]));
    const covered: string[] = [];
    let exhausted = false;
    for (const batch of sessionCatalogBatches(entries)) {
      if (!affordable(shardCount)) {
        exhausted = true;
        break;
      }
      await applyBatch(batch.statements);
      covered.push(...batch.sessionIds);
    }
    for (const sessionId of large) {
      if (exhausted || !affordable(1 + shardCount)) {
        exhausted = true;
        break;
      }
      const entry = await readOne(env, sessionId);
      subrequests += 1;
      if (!entry) continue;
      versionById.set(sessionId, entry.version);
      // A single entry always yields exactly one batch.
      for (const batch of sessionCatalogBatches([entry])) {
        await applyBatch(batch.statements);
        covered.push(...batch.sessionIds);
      }
    }
    if (covered.length > 0) {
      await env.DB.prepare(SESSION_CATALOG_RETIRE_SQL)
        .bind(JSON.stringify(covered.map((sessionId) => [sessionId, versionById.get(sessionId)]))).run();
      subrequests += 1;
      synced += covered.length;
    }
    if (exhausted) return { state: 'pending', subrequests, synced };
  }
  return { state: 'current', subrequests, synced };
}

export interface CatalogDrainOptions extends CatalogSyncOptions {
  /** Oldest outbox entries to capture; defaults to 128. */
  limit?: number;
}

/**
 * Syncs the sessions named by the oldest `limit` outbox entries to every shard within the
 * `maxSubrequests` allowance. The sync retires each captured entry: the version it reads is the
 * session's newest outbox seq, at or above every captured seq for that session, and it deletes only
 * seq <= that version, so a change committed after the read keeps its entry. Reports 'pending'
 * while entries remain.
 */
export async function drainIndexCatalog(
  env: Env,
  { limit = 128, maxSubrequests = DEFAULT_CATALOG_SUBREQUESTS }: CatalogDrainOptions = {},
): Promise<CatalogSyncResult> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`catalog drain limit must be a positive integer, got ${limit}`);
  }
  const captured = (await env.DB.prepare(
    'SELECT session_id FROM session_catalog_outbox ORDER BY seq LIMIT ?1',
  ).bind(limit).all<{ session_id: string }>()).results;
  if (captured.length === 0) return { state: 'current', subrequests: 1, synced: 0 };
  // Two calls of the allowance are this drain's own outbox read and remaining-entries check.
  const sync = await syncSessionCatalog(env, captured.map((row) => row.session_id), {
    maxSubrequests: maxSubrequests - 2,
  });
  if (sync.state === 'pending') return { ...sync, subrequests: sync.subrequests + 1 };
  const remaining = await env.DB.prepare('SELECT EXISTS (SELECT 1 FROM session_catalog_outbox) AS pending')
    .first<{ pending: number }>();
  return {
    state: remaining?.pending === 1 ? 'pending' : 'current',
    subrequests: sync.subrequests + 2,
    synced: sync.synced,
  };
}
