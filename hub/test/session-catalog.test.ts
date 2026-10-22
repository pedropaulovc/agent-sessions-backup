import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CATALOG_COLUMNS, SESSION_CATALOG_PAYLOAD_BYTES, sessionCatalogBatches,
  type SessionCatalogEntry,
} from '../src/index-layout.mjs';
import { assertIndexLayout, indexDbs } from '../src/index-shards';
import { drainIndexCatalog, syncSessionCatalog } from '../src/session-catalog';
import { API } from './hosts';

const testEnv = env as unknown as Env;
const ids = new Set<string>();
const directIds = new Set<string>();

function snapshot(id: string, starCount = 20): SessionCatalogEntry {
  directIds.add(id);
  return {
    sessionId: id, version: 10,
    session: {
      session_id: id, harness: 'omp', machine_id: 'catalog-test', os: 'linux',
      canonical_file_id: 42, cwd: null, repo_url: 'https://example.test/会話',
      git_branch: '', models: '["model-α","model-😀"]', primary_model: 'model-α',
      title: 'e\u0301 会話 😀', started_at: '2026-10-08T04:58:19.123Z', ended_at: null,
      parent_session_id: 'parent-会話', parent_tool_use_id: 'tool-α', is_sidechain: 0,
      turn_count: 21, block_count: 63, tokens_in: 4_294_967_297, tokens_out: 0,
      tokens_reasoning: null, tokens_cached: 9_876_543_210, index_state: 'ready',
      updated_at: '2026-10-08T04:58:20.456Z', project_name: '',
      first_interaction_title: 'first\u0000tail 😀', cost_usd: null, cost_calls: 21, cost_priced_calls: 0,
    },
    stars: Array.from({ length: starCount }, (_, index) => ({
      session_id: id,
      turn_key: index < 2 ? `public\u0000${index ? 'right' : 'left'}` : `turn-${index}-会話😀`,
      starred_at: '2026-10-08T05:00:00.001Z',
    })),
  };
}

function payloadBytes(entry: SessionCatalogEntry): number {
  return new TextEncoder().encode(JSON.stringify([{
    s: entry.sessionId, v: entry.version, p: entry.session ? 'present' : 'deleted',
    r: entry.session ? SESSION_CATALOG_COLUMNS.map((column) => entry.session![column] ?? null) : null,
    t: entry.stars.map((star) => [star.turn_key ?? null, star.starred_at ?? null]),
  }])).byteLength;
}

function preparedCatalog(db: D1Database, entry: SessionCatalogEntry): D1PreparedStatement[] {
  const batches = sessionCatalogBatches([entry]);
  expect(batches).toHaveLength(1);
  expect(batches[0]!.sessionIds).toEqual([entry.sessionId]);
  return batches[0]!.statements.map(({ sql, params }) => db.prepare(sql).bind(...params));
}

async function applyCatalog(db: D1Database, entry: SessionCatalogEntry) {
  const results = await db.batch(preparedCatalog(db, entry));
  for (const result of results) {
    expect(result.success).toBe(true);
    // These are actual workerd/D1 counters, not inferred counts of SQL statements or rows.
    expect(result.meta.rows_written).toBeTypeOf('number');
    expect(result.meta.changes).toBeTypeOf('number');
  }
  return {
    writes: results.map(({ meta }) => meta.rows_written),
    changes: results.map(({ meta }) => meta.changes),
  };
}

async function expectCatalog(db: D1Database, entry: SessionCatalogEntry): Promise<void> {
  const [sessions, stars, versions] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM sessions WHERE session_id = ?1').bind(entry.sessionId),
    db.prepare('SELECT * FROM starred_turns WHERE session_id = ?1').bind(entry.sessionId),
    db.prepare('SELECT * FROM catalog_versions WHERE session_id = ?1').bind(entry.sessionId),
  ]);
  expect(sessions!.results).toEqual(entry.session ? [entry.session] : []);
  expect(stars!.results).toHaveLength(entry.stars.length);
  const byTurnKey = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): number => {
    const a = left.turn_key as string, b = right.turn_key as string;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  expect(stars!.results.sort(byTurnKey)).toEqual([...entry.stars].sort(byTurnKey));
  expect(versions!.results).toEqual([{
    session_id: entry.sessionId, version: entry.version, presence: entry.session ? 'present' : 'deleted',
  }]);
}

beforeAll(() => assertIndexLayout(testEnv));

async function seed(id: string): Promise<void> {
  ids.add(id);
  await testEnv.DB.prepare(`INSERT INTO sessions
    (session_id, harness, machine_id, title, index_state)
    VALUES (?1, 'omp', 'catalog-test', 'old title', 'ready')`).bind(id).run();
}

/** Hold an already-prepared catalog write while another sync commits a newer version. */
async function holdCatalogWrite(id: string, change: () => Promise<void>): Promise<void> {
  const shard = indexDbs(testEnv)[0]!;
  const originalBatch = shard.batch.bind(shard);
  let release!: () => void;
  let captured!: () => void;
  const capturedPromise = new Promise<void>((resolve) => { captured = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const spy = vi.spyOn(shard, 'batch').mockImplementation(async (statements) => {
    if (!held) {
      held = true;
      captured();
      await releasePromise;
    }
    return originalBatch(statements);
  });
  const older = syncSessionCatalog(testEnv, [id]);
  try {
    await Promise.race([
      capturedPromise,
      older.then(() => { throw new Error('Catalog sync completed without a shard write'); }),
    ]);
    await change();
    await syncSessionCatalog(testEnv, [id]);
  } finally {
    release();
    try { await older; } finally { spy.mockRestore(); }
  }
}

async function catalogRows(id: string): Promise<Array<Record<string, unknown> | null>> {
  return Promise.all(indexDbs(testEnv).map((db) => db.prepare(
    'SELECT title, index_state, cost_usd FROM sessions WHERE session_id = ?1',
  ).bind(id).first<Record<string, unknown>>()));
}

afterEach(async () => {
  for (const id of ids) {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM starred_turns WHERE session_id = ?1').bind(id),
      testEnv.DB.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(id),
    ]);
  }
  await syncSessionCatalog(testEnv, [...ids]);
  ids.clear();
  for (const db of indexDbs(testEnv)) {
    for (const id of directIds) {
      await db.batch([
        db.prepare('DELETE FROM starred_turns WHERE session_id = ?1').bind(id),
        db.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(id),
        db.prepare('DELETE FROM catalog_versions WHERE session_id = ?1').bind(id),
      ]);
    }
  }
  directIds.clear();
});

describe('session catalog native D1 write reconciliation', () => {
  it('writes nothing for equal/older JSON replay and only changed rows for newer snapshots', async () => {
    const initial = snapshot('catalog-native-diff');
    for (const db of indexDbs(testEnv)) {
      let entry = initial;
      const inserted = await applyCatalog(db, entry);
      // JSON statements: version, tombstone delete, absent-star delete, session UPSERT, star UPSERT.
      expect(inserted.changes).toEqual([1, 0, 0, 1, 20]);
      expect(inserted.writes[4]).toBeGreaterThan(20);
      await expectCatalog(db, entry);
      expect((await applyCatalog(db, entry)).writes).toEqual([0, 0, 0, 0, 0]);
      expect((await applyCatalog(db, {
        ...entry, version: entry.version - 1, session: { ...entry.session, title: 'stale' }, stars: [],
      })).writes).toEqual([0, 0, 0, 0, 0]);
      await expectCatalog(db, entry);

      entry = { ...entry, version: entry.version + 1 };
      const identical = await applyCatalog(db, entry);
      expect(identical.changes).toEqual([1, 0, 0, 0, 0]);
      expect(identical.writes[0]).toBeGreaterThan(0);
      expect(identical.writes.slice(1)).toEqual([0, 0, 0, 0]);
      await expectCatalog(db, entry);

      entry = { ...entry, version: entry.version + 1, session: { ...entry.session, title: '' } };
      const title = await applyCatalog(db, entry);
      expect(title.changes).toEqual([1, 0, 0, 1, 0]);
      expect(title.writes[3]).toBeGreaterThan(0);
      expect([title.writes[1], title.writes[2], title.writes[4]]).toEqual([0, 0, 0]);
      await expectCatalog(db, entry);

      entry = {
        ...entry, version: entry.version + 1,
        stars: entry.stars.map((star, index) => index ? star : { ...star, starred_at: '' }),
      };
      const timestamp = await applyCatalog(db, entry);
      expect(timestamp.changes).toEqual([1, 0, 0, 0, 1]);
      expect(timestamp.writes[4]).toBeGreaterThan(0);
      expect(timestamp.writes[4]).toBeLessThan(inserted.writes[4]!);
      expect(timestamp.writes.slice(1, 4)).toEqual([0, 0, 0]);
      await expectCatalog(db, entry);

      // Remove just one NUL-bearing key; its same-prefix sibling and timestamp must survive.
      entry = { ...entry, version: entry.version + 1, stars: entry.stars.slice(1) };
      const removed = await applyCatalog(db, entry);
      expect(removed.changes).toEqual([1, 0, 1, 0, 0]);
      expect(removed.writes[2]).toBeGreaterThan(0);
      expect([removed.writes[1], removed.writes[3], removed.writes[4]]).toEqual([0, 0, 0]);
      await expectCatalog(db, entry);

      entry = {
        ...entry, version: entry.version + 1,
        stars: [...entry.stars, { session_id: entry.sessionId, turn_key: 'new-star', starred_at: 'new timestamp' }],
      };
      expect((await applyCatalog(db, entry)).changes).toEqual([1, 0, 0, 0, 1]);
      await expectCatalog(db, entry);
      entry = { ...entry, version: entry.version + 1, stars: [] };
      expect((await applyCatalog(db, entry)).changes).toEqual([1, 0, 20, 0, 0]);
      await expectCatalog(db, entry);
      expect((await applyCatalog(db, entry)).writes).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('repairs every non-key session column and a missing row at the same version', async () => {
    const entry = snapshot('catalog-native-column-repair');
    expect(Object.keys(entry.session!)).toEqual(SESSION_CATALOG_COLUMNS);
    expect(SESSION_CATALOG_COLUMNS).toHaveLength(29);
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, entry);
      for (const column of SESSION_CATALOG_COLUMNS.slice(1)) {
        const value = entry.session![column];
        const corrupted = typeof value === 'number' ? value + 1
          : value === null ? (column === 'tokens_reasoning' || column === 'cost_usd' ? 1 : '')
            : value === '' ? null : `${value}-corrupted`;
        await db.prepare(`UPDATE sessions SET ${column} = ?1 WHERE session_id = ?2`)
          .bind(corrupted, entry.sessionId).run();
        const repaired = await applyCatalog(db, entry);
        expect(repaired.changes, column).toEqual([0, 0, 0, 1, 0]);
        expect(repaired.writes[3], column).toBeGreaterThan(0);
        expect([repaired.writes[0], repaired.writes[1], repaired.writes[2], repaired.writes[4]], column)
          .toEqual([0, 0, 0, 0]);
        await expectCatalog(db, entry);
      }
      await db.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(entry.sessionId).run();
      expect((await applyCatalog(db, entry)).changes).toEqual([0, 0, 0, 1, 0]);
      await expectCatalog(db, entry);
      expect((await applyCatalog(db, entry)).writes).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('repairs missing/extra stars and an incorrect timestamp without rewriting correct rows', async () => {
    const entry = snapshot('catalog-native-star-repair');
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, entry);
      await db.batch([
        db.prepare('DELETE FROM starred_turns WHERE session_id = ?1 AND turn_key = ?2')
          .bind(entry.sessionId, entry.stars[0]!.turn_key),
        db.prepare('UPDATE starred_turns SET starred_at = ?3 WHERE session_id = ?1 AND turn_key = ?2')
          .bind(entry.sessionId, entry.stars[1]!.turn_key, ''),
        db.prepare('INSERT INTO starred_turns (session_id, turn_key, starred_at) VALUES (?1, ?2, ?3)')
          .bind(entry.sessionId, 'extra-star', 'wrong timestamp'),
      ]);
      const repaired = await applyCatalog(db, entry);
      expect(repaired.changes).toEqual([0, 0, 1, 0, 2]);
      expect(repaired.writes[2]).toBeGreaterThan(0);
      expect(repaired.writes[4]).toBeGreaterThan(0);
      expect([repaired.writes[0], repaired.writes[1], repaired.writes[3]]).toEqual([0, 0, 0]);
      await expectCatalog(db, entry);
      expect((await applyCatalog(db, entry)).writes).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('keeps tombstones and complete orphan-star snapshots replayable and repairable', async () => {
    const present = snapshot('catalog-native-orphan');
    const deleted: SessionCatalogEntry = {
      ...present, version: present.version + 1, session: null,
      stars: [present.stars[1]!, {
        session_id: present.sessionId, turn_key: 'orphan-star', starred_at: 'orphan timestamp',
      }],
    };
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, present);
      expect((await applyCatalog(db, deleted)).changes).toEqual([1, 1, 19, 0, 1]);
      await expectCatalog(db, deleted);
      expect((await applyCatalog(db, deleted)).writes).toEqual([0, 0, 0, 0, 0]);
      expect((await applyCatalog(db, present)).writes).toEqual([0, 0, 0, 0, 0]);
      await expectCatalog(db, deleted);

      await db.batch([
        db.prepare(`INSERT INTO sessions (${SESSION_CATALOG_COLUMNS.join(', ')})
          VALUES (${SESSION_CATALOG_COLUMNS.map((_, index) => `?${index + 1}`).join(', ')})`)
          .bind(...SESSION_CATALOG_COLUMNS.map((column) => present.session![column])),
        db.prepare('INSERT INTO starred_turns (session_id, turn_key, starred_at) VALUES (?1, ?2, ?3)')
          .bind(present.sessionId, 'obsolete-star', 'wrong timestamp'),
      ]);
      expect((await applyCatalog(db, deleted)).changes).toEqual([0, 1, 1, 0, 0]);
      await expectCatalog(db, deleted);
      const empty = { ...deleted, version: deleted.version + 1, stars: [] };
      expect((await applyCatalog(db, empty)).changes).toEqual([1, 0, 2, 0, 0]);
      await expectCatalog(db, empty);
      expect((await applyCatalog(db, empty)).writes).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('guards each entry independently when a JSON batch mixes older, newer, and missing versions', async () => {
    const first = snapshot('catalog-native-mixed-first', 3);
    const second = snapshot('catalog-native-mixed-second', 3);
    // Third retains the same key that newer removes from second: membership must include session_id.
    const third = snapshot('catalog-native-mixed-third', 3);
    const stale = { ...first, version: first.version - 1, session: null, stars: [] };
    const newer = {
      ...second, version: second.version + 1, session: { ...second.session, title: '' },
      stars: second.stars.slice(1),
    };
    const batches = sessionCatalogBatches([stale, newer, third]);
    expect(batches).toHaveLength(1);
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, first);
      await applyCatalog(db, second);
      const statements = batches[0]!.statements.map(({ sql, params }) => db.prepare(sql).bind(...params));
      const results = await db.batch(statements);
      expect(results.map(({ meta }) => meta.changes)).toEqual([2, 0, 1, 2, 3]);
      await expectCatalog(db, first);
      await expectCatalog(db, newer);
      await expectCatalog(db, third);
      expect((await db.batch(statements)).map(({ meta }) => meta.rows_written)).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('bounds full-batch native D1 reads for 64-session star replay and removal', async () => {
    const initial = Array.from({ length: 64 }, (_, index) => snapshot(`catalog-native-read-bound-${index}`));
    for (const db of indexDbs(testEnv)) {
      const apply = async (entries: SessionCatalogEntry[]) => {
        const batches = sessionCatalogBatches(entries);
        expect(batches).toHaveLength(1);
        return db.batch(batches[0]!.statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
      };
      expect((await apply(initial)).map(({ meta }) => meta.changes)).toEqual([64, 0, 0, 64, 1_280]);
      const half = initial.map((entry) => ({
        ...entry, version: entry.version + 1, stars: entry.stars.slice(10),
      }));
      const empty = half.map((entry) => ({ ...entry, version: entry.version + 1, stars: [] }));
      for (const [entries, changes] of [
        [initial, [0, 0, 0, 0, 0]],
        [half, [64, 0, 640, 0, 0]],
        [empty, [64, 0, 640, 0, 0]],
      ] as const) {
        const results = await apply(entries);
        expect(results.map(({ meta }) => meta.changes)).toEqual(changes);
        // Sum real D1 counters over every statement, not just the absent-star deletion.
        expect(results.reduce((sum, { meta }) => sum + meta.rows_read, 0)).toBeLessThan(50_000);
        for (const entry of entries) await expectCatalog(db, entry);
      }
    }
  });

  it('preserves the UTF-8 payload boundary and complete oversized snapshots across 48-star chunks', async () => {
    const initial = snapshot('catalog-native-oversized', 97);
    const unicode = { ...initial, session: { ...initial.session, title: '会話😀\u0000e\u0301' } };
    const boundary = {
      ...unicode,
      session: { ...unicode.session, title: unicode.session.title + 'x'.repeat(SESSION_CATALOG_PAYLOAD_BYTES - payloadBytes(unicode)) },
    };
    expect(payloadBytes(boundary)).toBe(SESSION_CATALOG_PAYLOAD_BYTES);
    expect(sessionCatalogBatches([boundary])[0]!.statements[0]!.params).toHaveLength(1);
    const oversized = {
      ...boundary, version: boundary.version + 1,
      session: { ...boundary.session, title: `${boundary.session.title}😀` },
    };
    expect(payloadBytes(oversized)).toBe(SESSION_CATALOG_PAYLOAD_BYTES + 4);
    const statements = sessionCatalogBatches([oversized])[0]!.statements;
    expect(statements[0]!.params).toHaveLength(3);
    expect(statements.slice(3).map(({ params }) => params.length)).toEqual([98, 98, 4]);

    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, boundary);
      await expectCatalog(db, boundary);
      expect((await applyCatalog(db, boundary)).writes).toEqual([0, 0, 0, 0, 0]);
      expect((await applyCatalog(db, oversized)).changes).toEqual([1, 1, 97, 48, 48, 1]);
      await expectCatalog(db, oversized);

      // The fallback deliberately still replaces all stars, even on equal replay.
      const replay = await applyCatalog(db, oversized);
      expect(replay.changes).toEqual([0, 0, 97, 48, 48, 1]);
      expect(replay.writes.slice(0, 2)).toEqual([0, 0]);
      expect(replay.writes.slice(2).every((writes) => writes > 0)).toBe(true);
      const newer = { ...oversized, version: oversized.version + 1 };
      const identical = await applyCatalog(db, newer);
      expect(identical.changes).toEqual([1, 0, 97, 48, 48, 1]);
      expect(identical.writes[1]).toBe(0);
      await expectCatalog(db, newer);
      expect((await applyCatalog(db, oversized)).writes).toEqual([0, 0, 0, 0, 0, 0]);
      expect((await applyCatalog(db, boundary)).writes).toEqual([0, 0, 0, 0, 0]);
      await expectCatalog(db, newer);

      await db.batch([
        db.prepare('UPDATE sessions SET cwd = ?2 WHERE session_id = ?1').bind(newer.sessionId, ''),
        db.prepare('DELETE FROM starred_turns WHERE session_id = ?1 AND turn_key = ?2')
          .bind(newer.sessionId, newer.stars[96]!.turn_key),
        db.prepare('UPDATE starred_turns SET starred_at = ?3 WHERE session_id = ?1 AND turn_key = ?2')
          .bind(newer.sessionId, newer.stars[0]!.turn_key, 'wrong timestamp'),
        db.prepare('INSERT INTO starred_turns (session_id, turn_key, starred_at) VALUES (?1, ?2, ?3)')
          .bind(newer.sessionId, 'extra-star', 'wrong timestamp'),
      ]);
      expect((await applyCatalog(db, newer)).changes).toEqual([0, 1, 97, 48, 48, 1]);
      await expectCatalog(db, newer);
      await db.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(newer.sessionId).run();
      expect((await applyCatalog(db, newer)).changes).toEqual([0, 1, 97, 48, 48, 1]);
      await expectCatalog(db, newer);
    }
  });

  it('applies oversized tombstones without dropping orphan stars beyond the first insert chunk', async () => {
    const present = snapshot('catalog-native-large-orphans', 1);
    const deleted: SessionCatalogEntry = {
      ...present, version: present.version + 1, session: null,
      stars: Array.from({ length: 1_001 }, (_, index) => ({
        session_id: present.sessionId, turn_key: `${index}-${'会'.repeat(333)}`,
        starred_at: '2026-10-08T05:00:00.001Z',
      })),
    };
    expect(payloadBytes(deleted)).toBeGreaterThan(SESSION_CATALOG_PAYLOAD_BYTES);
    const batches = sessionCatalogBatches([deleted]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.statements.every(({ params }) => params.length <= 100)).toBe(true);
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, present);
      const applied = await applyCatalog(db, deleted);
      expect(applied.changes.slice(0, 3)).toEqual([1, 1, 1]);
      expect(applied.changes.slice(3).reduce((sum, changes) => sum + changes, 0)).toBe(1_001);
      await expectCatalog(db, deleted);
      const replay = await applyCatalog(db, deleted);
      expect(replay.writes.slice(0, 2)).toEqual([0, 0]);
      expect(replay.changes[2]).toBe(1_001);
      expect(replay.changes.slice(3).reduce((sum, changes) => sum + changes, 0)).toBe(1_001);
      await expectCatalog(db, deleted);
      expect((await applyCatalog(db, present)).writes).toEqual([0, 0, 0, 0, 0]);
      await expectCatalog(db, deleted);
    }
  });

  it.each([
    { transport: 'json', invalidColumn: 'starred_at' },
    { transport: 'json', invalidColumn: 'turn_key' },
    { transport: 'oversized', invalidColumn: 'starred_at' },
    { transport: 'oversized', invalidColumn: 'turn_key' },
  ])('rolls back every $transport statement and its version when a later star has null $invalidColumn', async ({ transport, invalidColumn }) => {
    const original = snapshot(`catalog-native-atomic-${transport}-${invalidColumn}`, 49);
    const entry = transport === 'oversized'
      ? { ...original, session: { ...original.session, title: '😀'.repeat(250_001) } }
      : original;
    expect(payloadBytes(entry) > SESSION_CATALOG_PAYLOAD_BYTES).toBe(transport === 'oversized');
    const newer = {
      ...entry, version: entry.version + 1, session: { ...entry.session, cwd: '' },
      stars: entry.stars.map((star) => ({ ...star, starred_at: 'new timestamp' })),
    };
    const invalid = {
      ...newer, stars: newer.stars.map((star, index) => index === 48 ? { ...star, [invalidColumn]: null } : star),
    };
    for (const db of indexDbs(testEnv)) {
      await applyCatalog(db, entry);
      await expect(db.batch(preparedCatalog(db, invalid))).rejects.toThrow();
      // Includes full rows, all old timestamps, and the old version: no partial atomic apply.
      await expectCatalog(db, entry);
      await applyCatalog(db, newer);
      await expectCatalog(db, newer);
      const stale = await applyCatalog(db, entry);
      expect(stale.writes.every((writes) => writes === 0)).toBe(true);
      await expectCatalog(db, newer);
    }
  });
});

describe('session catalog concurrent version guards', () => {
  it('an older concurrent sync cannot degrade newer metadata or stars on either shard', async () => {
    const id = 'catalog-race-update';
    await seed(id);
    await holdCatalogWrite(id, async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare(`UPDATE sessions SET title = 'new title', cost_usd = 9,
          index_state = 'error' WHERE session_id = ?1`).bind(id),
        testEnv.DB.prepare(`INSERT INTO starred_turns (session_id, turn_key)
          VALUES (?1, 'turn-update')`).bind(id),
      ]);
    });
    expect(await catalogRows(id)).toEqual(indexDbs(testEnv).map(() => ({
      title: 'new title', index_state: 'error', cost_usd: 9,
    })));
    for (const db of indexDbs(testEnv)) {
      expect((await db.prepare('SELECT turn_key FROM starred_turns WHERE session_id = ?1')
        .bind(id).all<{ turn_key: string }>()).results).toEqual([{ turn_key: 'turn-update' }]);
    }
  });

  it('an older concurrent sync cannot resurrect a deleted session or its stars', async () => {
    const id = 'catalog-race-delete';
    await seed(id);
    await testEnv.DB.prepare("INSERT INTO starred_turns (session_id, turn_key) VALUES (?1, 'turn-delete')").bind(id).run();
    await syncSessionCatalog(testEnv, [id]);
    await holdCatalogWrite(id, async () => {
      await testEnv.DB.batch([
        testEnv.DB.prepare('DELETE FROM starred_turns WHERE session_id = ?1').bind(id),
        testEnv.DB.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(id),
      ]);
    });
    expect(await catalogRows(id)).toEqual(indexDbs(testEnv).map(() => null));
    for (const db of indexDbs(testEnv)) {
      expect((await db.prepare('SELECT turn_key FROM starred_turns WHERE session_id = ?1')
        .bind(id).all()).results).toEqual([]);
      expect(await db.prepare('SELECT presence FROM catalog_versions WHERE session_id = ?1')
        .bind(id).first()).toEqual({ presence: 'deleted' });
    }
  });

  it('retires only the captured version when main changes after the atomic snapshot was read', async () => {
    const id = 'catalog-race-outbox-retirement';
    await seed(id);
    const captured = await testEnv.DB.prepare('SELECT version FROM session_catalog_versions WHERE session_id = ?1')
      .bind(id).first<{ version: number }>();
    expect(captured).not.toBeNull();
    const shard = indexDbs(testEnv)[0]!;
    const originalBatch = shard.batch.bind(shard);
    const spy = vi.spyOn(shard, 'batch').mockImplementationOnce(async (statements) => {
      await testEnv.DB.prepare("UPDATE sessions SET title = 'changed after snapshot' WHERE session_id = ?1")
        .bind(id).run();
      return originalBatch(statements);
    });
    try {
      await syncSessionCatalog(testEnv, [id]);
    } finally {
      spy.mockRestore();
    }
    const current = await testEnv.DB.prepare('SELECT version FROM session_catalog_versions WHERE session_id = ?1')
      .bind(id).first<{ version: number }>();
    expect(current!.version).toBeGreaterThan(captured!.version);
    expect((await testEnv.DB.prepare('SELECT seq FROM session_catalog_outbox WHERE session_id = ?1 ORDER BY seq')
      .bind(id).all<{ seq: number }>()).results).toEqual([{ seq: current!.version }]);
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare('SELECT title FROM sessions WHERE session_id = ?1').bind(id).first())
        .toEqual({ title: 'old title' });
      expect(await db.prepare('SELECT version FROM catalog_versions WHERE session_id = ?1').bind(id).first())
        .toEqual({ version: captured!.version });
    }
    await syncSessionCatalog(testEnv, [id]);
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare('SELECT title FROM sessions WHERE session_id = ?1').bind(id).first())
        .toEqual({ title: 'changed after snapshot' });
    }
    expect((await testEnv.DB.prepare('SELECT seq FROM session_catalog_outbox WHERE session_id = ?1')
      .bind(id).all()).results).toEqual([]);
  });

  it('a capped sync retires only fully replicated sessions and leaves the remainder recoverable', async () => {
    const sessions = Array.from({ length: 65 }, (_, i) => `catalog-budget-${i}`);
    for (const id of sessions) ids.add(id);
    await testEnv.DB.batch(sessions.map((id) => testEnv.DB.prepare(`INSERT INTO sessions
      (session_id, harness, machine_id, title, index_state)
      VALUES (?1, 'omp', 'catalog-test', 'budgeted title', 'ready')`).bind(id)));

    // Four calls can read one round, atomically apply it on both shards, and retire it.
    // The next session must not be retired merely because its main row was committed.
    await syncSessionCatalog(testEnv, sessions, { maxSubrequests: 4 });
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM sessions
        WHERE session_id LIKE 'catalog-budget-%'`).first()).toEqual({ n: 64 });
      expect(await db.prepare('SELECT title FROM sessions WHERE session_id = ?1')
        .bind(sessions[64]).first()).toBeNull();
    }
    expect((await testEnv.DB.prepare(`SELECT session_id FROM session_catalog_outbox
      WHERE session_id LIKE 'catalog-budget-%' ORDER BY seq`).all<{ session_id: string }>()).results)
      .toEqual([{ session_id: sessions[64] }]);

    // An insufficient allowance cannot expose or discard the pending session either.
    await syncSessionCatalog(testEnv, [sessions[64]!], { maxSubrequests: 3 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM session_catalog_outbox WHERE session_id = ?1')
      .bind(sessions[64]).first()).toEqual({ n: 1 });
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare('SELECT title FROM sessions WHERE session_id = ?1')
        .bind(sessions[64]).first()).toBeNull();
    }

    await syncSessionCatalog(testEnv, [sessions[64]!], { maxSubrequests: 4 });
    expect(await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM session_catalog_outbox
      WHERE session_id LIKE 'catalog-budget-%'`).first()).toEqual({ n: 0 });
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM sessions
        WHERE session_id LIKE 'catalog-budget-%'`).first()).toEqual({ n: 65 });
      expect(await db.prepare('SELECT title FROM sessions WHERE session_id = ?1')
        .bind(sessions[64]).first()).toEqual({ title: 'budgeted title' });
    }
  });

  it('fails closed for a bounded backlog then recovers once a later read catches up', async () => {
    // One mutation per session exceeds the bounded 128-entry read drain without relying
    // on duplicate outbox entries or a fabricated database failure.
    while ((await drainIndexCatalog(testEnv)).state === 'pending') { /* drain earlier fixtures */ }
    const backlog = Array.from({ length: 129 }, (_, i) => `catalog-backlog-${i}`);
    for (const id of backlog) ids.add(id);
    await testEnv.DB.batch(backlog.map((id) => testEnv.DB.prepare(`INSERT INTO sessions
      (session_id, harness, machine_id, index_state)
      VALUES (?1, 'omp', 'catalog-test', 'ready')`).bind(id)));
    const request = () => SELF.fetch(`${API}/api/v1/search?q=catalogabsentneedle`, {
      headers: { 'x-dev-machine': 'catalog-test' },
    });
    const pending = await request();
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ error: 'index_catalog_pending' });
    const current = await request();
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ hits: [] });
    for (const db of indexDbs(testEnv)) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM sessions
        WHERE session_id LIKE 'catalog-backlog-%'`).first()).toEqual({ n: 129 });
    }
  });
});
