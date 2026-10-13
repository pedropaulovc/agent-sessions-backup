import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertIndexLayout, indexDbs } from '../src/index-shards';
import { drainIndexCatalog, syncSessionCatalog } from '../src/session-catalog';
import { API } from './hosts';

const testEnv = env as unknown as Env;
const ids = new Set<string>();

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
