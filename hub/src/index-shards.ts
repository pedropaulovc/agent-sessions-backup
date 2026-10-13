// Routing and identity for the index shard databases that hold transcript blocks and their FTS.
//
// Main (`env.DB`) stays authoritative for metadata, usage, rollups and stars. Each session's blocks
// and blocks_fts rows live on exactly one shard, chosen by the pure layout in index-layout.mjs. A
// missing or extra shard binding, or a shard whose recorded layout disagrees with this Worker's
// configuration, is a hard failure: there is no fallback to main and no legacy read path.

import {
  INDEX_ID_SPAN,
  INDEX_LAYOUT,
  INDEX_MAX_SHARDS,
  SHARD_META_INIT_SQL,
  SHARD_META_SELECT_SQL,
  indexIdBase,
  indexIdLimit,
  indexShardBindingName,
  indexShardForSessionId,
  parseIndexShardCount,
} from './index-layout.mjs';

/** Raised when shard configuration or recorded layout is unusable; callers fail closed (503). */
export class IndexLayoutError extends Error {
  override name = 'IndexLayoutError';
}

const shardSets = new WeakMap<Env, readonly D1Database[]>();

/** Every configured shard, in shard order. Throws IndexLayoutError on any binding mismatch. */
export function indexDbs(env: Env): readonly D1Database[] {
  const cached = shardSets.get(env);
  if (cached) return cached;
  let count: number;
  try {
    count = parseIndexShardCount(env.INDEX_SHARD_COUNT);
  } catch (error) {
    throw new IndexLayoutError((error as Error).message);
  }
  const dbs: D1Database[] = [];
  const bindings = env as unknown as Record<string, D1Database | undefined>;
  for (let shard = 0; shard < INDEX_MAX_SHARDS; shard += 1) {
    const binding = bindings[indexShardBindingName(shard)];
    if (shard < count) {
      if (!binding) throw new IndexLayoutError(`index shard binding ${indexShardBindingName(shard)} is missing`);
      dbs.push(binding);
    } else if (binding) {
      throw new IndexLayoutError(
        `index shard binding ${indexShardBindingName(shard)} is bound but INDEX_SHARD_COUNT is ${count}`,
      );
    }
  }
  const frozen = Object.freeze(dbs);
  shardSets.set(env, frozen);
  return frozen;
}

/** The shard index that owns a session's blocks. */
export function indexShardFor(env: Env, sessionId: string): number {
  return indexShardForSessionId(sessionId, indexDbs(env).length);
}

/** The shard database that owns a session's blocks and FTS rows. */
export function indexDbFor(env: Env, sessionId: string): D1Database {
  const dbs = indexDbs(env);
  return dbs[indexShardForSessionId(sessionId, dbs.length)]!;
}

const MAX_SHARD_CONCURRENCY = 4;

/** Runs `read` against every shard with bounded concurrency; results stay in shard order. */
export async function mapIndexDbs<T>(
  env: Env,
  read: (db: D1Database, shard: number) => Promise<T>,
): Promise<T[]> {
  const dbs = indexDbs(env);
  const results = new Array<T>(dbs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < dbs.length) {
      const shard = next;
      next += 1;
      results[shard] = await read(dbs[shard]!, shard);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_SHARD_CONCURRENCY, dbs.length) }, worker));
  return results;
}

interface ShardMetaRow {
  shard_index: number;
  shard_count: number;
  layout: string;
  next_block_id: number;
}

// Verified (database, shard, count) identities for this isolate. A failed check is not cached.
const verifiedLayouts = new WeakMap<D1Database, Promise<string>>();

async function verifyShard(db: D1Database, shard: number, count: number): Promise<string> {
  // D1 batch returns one result per statement, in order.
  const [, selected] = await db.batch([
    db.prepare(SHARD_META_INIT_SQL).bind(shard, count, INDEX_LAYOUT, indexIdBase(shard)),
    db.prepare(SHARD_META_SELECT_SQL),
  ]) as [D1Result, D1Result<ShardMetaRow>];
  const meta = selected.results[0];
  const binding = indexShardBindingName(shard);
  if (!meta) throw new IndexLayoutError(`index shard ${binding} has no shard_meta row`);
  if (meta.layout !== INDEX_LAYOUT || meta.shard_index !== shard || meta.shard_count !== count) {
    throw new IndexLayoutError(
      `index shard ${binding} records layout ${meta.layout} shard ${meta.shard_index}/${meta.shard_count}, `
        + `expected ${INDEX_LAYOUT} shard ${shard}/${count}`,
    );
  }
  if (!(meta.next_block_id >= indexIdBase(shard) && meta.next_block_id <= indexIdLimit(shard))) {
    throw new IndexLayoutError(`index shard ${binding} block id counter ${meta.next_block_id} is outside its range`);
  }
  return `${shard}/${count}`;
}

/**
 * Records each shard's identity on first use (shard_meta is written only when absent) and verifies
 * the recorded layout, shard index and count against this Worker's bindings. Cached per isolate
 * after success: one D1 call per shard on first use, none afterwards.
 */
export async function assertIndexLayout(env: Env): Promise<void> {
  const count = indexDbs(env).length;
  await mapIndexDbs(env, async (db, shard) => {
    const identity = `${shard}/${count}`;
    let check = verifiedLayouts.get(db);
    if (!check) {
      check = verifyShard(db, shard, count);
      verifiedLayouts.set(db, check);
      check.catch(() => {
        if (verifiedLayouts.get(db) === check) verifiedLayouts.delete(db);
      });
    }
    const verified = await check;
    if (verified !== identity) {
      throw new IndexLayoutError(`index shard ${indexShardBindingName(shard)} was verified as ${verified}, now bound as ${identity}`);
    }
  });
}

/**
 * Reserves `count` new globally unique block ids on one shard and returns the first; the range is
 * [first, first + count). One atomic D1 statement. Unused ids are harmless gaps. Every shard
 * `blocks` insert binds an explicit id from here (or a copied legacy id), never a default rowid.
 */
export async function reserveBlockIds(db: D1Database, count: number): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`block id reservation count must be a positive integer, got ${count}`);
  }
  const row = await db.prepare(
    `UPDATE shard_meta SET next_block_id = next_block_id + ?1
      WHERE id = 1 AND next_block_id + ?1 <= (shard_index + 2) * ?2
      RETURNING next_block_id - ?1 AS first_id`,
  ).bind(count, INDEX_ID_SPAN).first<{ first_id: number }>();
  if (!row) throw new IndexLayoutError('index shard has no shard_meta row or its block id range is exhausted');
  return row.first_id;
}

/** A newer main write already holds this session's shard write fence; this writer must stop. */
export class IndexWriteSupersededError extends Error {
  override name = 'IndexWriteSupersededError';
}

/**
 * SQL predicate that is true only while `version` still holds the session's shard write fence.
 * Every shard blocks/blocks_fts mutation includes it, so a writer superseded mid-flight changes
 * nothing. Arguments are the statement's bind parameter numbers for session id and version.
 */
export function indexWriteFence(sessionParam: number, versionParam: number): string {
  return `EXISTS (SELECT 1 FROM index_write_versions WHERE session_id = ?${sessionParam} AND version = ?${versionParam})`;
}

/**
 * Claims the session's shard write fence for `version`, the main session_catalog_versions.version
 * read in the SAME main batch that committed this writer's sessions-row change. Monotonic: a newer
 * version replaces, an equal version re-claims, an older one throws IndexWriteSupersededError.
 * One D1 call on the session's shard.
 */
export async function claimIndexWrite(db: D1Database, sessionId: string, version: number): Promise<void> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(`index write version must be a positive integer, got ${version}`);
  }
  const [, held] = await db.batch([
    db.prepare(
      `INSERT INTO index_write_versions (session_id, version) VALUES (?1, ?2)
       ON CONFLICT (session_id) DO UPDATE SET version = excluded.version
       WHERE excluded.version > index_write_versions.version`,
    ).bind(sessionId, version),
    db.prepare('SELECT version FROM index_write_versions WHERE session_id = ?1').bind(sessionId),
  ]) as [D1Result, D1Result<{ version: number }>];
  const current = held.results[0]?.version;
  if (current !== version) {
    throw new IndexWriteSupersededError(
      `session ${sessionId} shard write fence is at version ${current}, not ${version}`,
    );
  }
}
