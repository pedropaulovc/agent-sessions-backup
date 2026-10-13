import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { SearchHit, SearchResult } from '../src/api/search';
import { indexShardForSessionId } from '../src/index-layout.mjs';
import { assertIndexLayout, indexDbFor, indexDbs, reserveBlockIds } from '../src/index-shards';
import { drainIndexCatalog, syncSessionCatalog } from '../src/session-catalog';
import { API, VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const MACHINE = 'index-sharding-search-machine';
const HARNESS = 'index-sharding-search';
const UPDATED_AT = '2026-07-01T10:00:00Z';

interface SessionFixture {
  id: string;
  turns?: number;
  tokens?: number;
  seconds?: number | null;
  repo?: string;
  parent?: string;
  cost?: number | null;
  calls?: number;
  fileId?: number;
}

interface BlockFixture {
  id: number;
  session: SessionFixture;
  turn: number;
}

function sessionOn(shard: number, label: string): string {
  for (let suffix = 0; ; suffix++) {
    const id = `index-sharding-search-${label}-${suffix}`;
    if (indexShardForSessionId(id, 2) === shard) return id;
  }
}

/** Metadata is authoritative on main; each block and its FTS row land in one shard batch. */
async function seedSearch(marker: string, sessions: SessionFixture[]): Promise<BlockFixture[]> {
  await testEnv.DB.batch(sessions.map((session) => testEnv.DB.prepare(
    `INSERT INTO sessions
       (session_id, harness, machine_id, os, title, started_at, ended_at, index_state,
        updated_at, canonical_file_id, repo_url, parent_session_id, tokens_in, tokens_out,
        turn_count, block_count, cost_usd, cost_calls, cost_priced_calls)
     VALUES (?1, ?2, ?3, 'linux', ?1, ?4, ?5, 'ready', ?4, ?6, ?7, ?8, ?9, 0, ?10, ?10, ?11, ?12, ?13)`,
  ).bind(
    session.id, HARNESS, MACHINE, UPDATED_AT,
    session.seconds === null ? null : new Date(Date.parse(UPDATED_AT) + (session.seconds ?? 60) * 1000).toISOString(),
    session.fileId ?? null, session.repo ?? null, session.parent ?? null, session.tokens ?? 0,
    session.turns ?? 1, session.cost ?? null, session.calls ?? (session.cost == null ? 0 : 1),
    session.cost == null ? 0 : 1,
  )));
  await syncSessionCatalog(testEnv, sessions.map((session) => session.id));

  const blocks: BlockFixture[] = [];
  for (const db of indexDbs(testEnv)) {
    const local = sessions.filter((session) => indexDbFor(testEnv, session.id) === db);
    const count = local.reduce((sum, session) => sum + (session.turns ?? 1), 0);
    if (count === 0) continue;
    let nextId = await reserveBlockIds(db, count);
    const statements: D1PreparedStatement[] = [];
    for (const session of local) {
      for (let turn = 0; turn < (session.turns ?? 1); turn++) {
        const id = nextId++;
        const text = `${marker} identical searchable transcript`;
        blocks.push({ id, session, turn });
        statements.push(
          db.prepare(
            `INSERT INTO blocks
               (id, session_id, file_id, turn_index, block_index, role, btype, text, on_main_path)
             VALUES (?1, ?2, ?3, ?4, 0, 'user', 'text', ?5, 1)`,
          ).bind(id, session.id, session.fileId ?? 1, turn, text),
          db.prepare('INSERT INTO blocks_fts (rowid, text) VALUES (?1, ?2)').bind(id, text),
        );
      }
    }
    await db.batch(statements);
  }
  return blocks;
}

async function search(params: URLSearchParams): Promise<SearchResult> {
  const response = await SELF.fetch(`${API}/api/v1/search?${params}`, {
    headers: { 'x-dev-machine': MACHINE },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as SearchResult;
  expect(body.error).toBeUndefined();
  return body;
}

function hitKey(hit: SearchHit): string {
  return `${hit.session_id}:${hit.block.turn_index}:${hit.block.block_index}`;
}

function fixtureKey(block: BlockFixture): string {
  return `${block.session.id}:${block.turn}:0`;
}

async function expectedOrder(marker: string, blocks: BlockFixture[], sort = 'recent'): Promise<string[]> {
  // FTS scores depend on each shard's entire corpus, not only these identical fixture texts.
  // Read real local scores independently of the HTTP handler's filters, ordering and paging.
  const ranks = new Map<number, number>();
  for (const db of indexDbs(testEnv)) {
    const result = await db.prepare(
      `SELECT rowid AS id, bm25(blocks_fts) AS rank
       FROM blocks_fts WHERE blocks_fts MATCH ?1`,
    ).bind(marker).all<{ id: number; rank: number }>();
    for (const row of result.results) ranks.set(row.id, row.rank);
  }
  expect(ranks.size).toBe(blocks.length);
  for (const block of blocks) expect(ranks.has(block.id)).toBe(true);
  return [...blocks].sort((a, b) => {
    const primary = sort === 'total_tokens'
      ? b.session.tokens! - a.session.tokens!
      : sort === 'session_time'
        ? (b.session.seconds ?? -1) - (a.session.seconds ?? -1)
        : 0;
    return primary || ranks.get(a.id)! - ranks.get(b.id)! || a.id - b.id;
  }).map(fixtureKey);
}

async function walk(params: URLSearchParams, expectedCount: number): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const cursors = new Set<string>();
  const limit = Number(params.get('limit'));
  for (let page = 0; page <= Math.ceil(expectedCount / limit); page++) {
    const result = await search(params);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(limit);
    hits.push(...result.hits);
    if (!result.cursor) {
      expect(hits).toHaveLength(expectedCount);
      expect(new Set(hits.map(hitKey)).size).toBe(expectedCount);
      return hits;
    }
    expect(result.hits).toHaveLength(limit);
    expect(cursors.has(result.cursor)).toBe(false);
    expect(atob(result.cursor)).toBe(String(hits.length));
    cursors.add(result.cursor);
    params.set('cursor', result.cursor);
  }
  throw new Error('Search cursor did not terminate at the fixture boundary');
}

beforeAll(async () => {
  expect(indexDbs(testEnv)).toHaveLength(2);
  await assertIndexLayout(testEnv);
  await testEnv.DB.prepare('INSERT INTO machines (machine_id, os) VALUES (?1, ?2)')
    .bind(MACHINE, 'linux').run();
});

describe('cross-shard HTTP search', () => {
  it.each(['recent', 'total_tokens', 'session_time'])(
    'walks every global %s cursor without omissions or duplicates',
    async (sort) => {
      const marker = `globalshardcursorproof${sort}`;
      const sessions: SessionFixture[] = [
        { id: sessionOn(0, `cursor-high-${sort}`), turns: 3, tokens: 50, seconds: 300 },
        { id: sessionOn(1, `cursor-middle-a-${sort}`), turns: 4, tokens: 40, seconds: 240 },
        { id: sessionOn(0, `cursor-middle-b-${sort}`), turns: 2, tokens: 40, seconds: 240 },
        { id: sessionOn(1, `cursor-low-a-${sort}`), turns: 3, tokens: 30, seconds: 180 },
        { id: sessionOn(0, `cursor-low-b-${sort}`), turns: 2, tokens: 20, seconds: 120 },
        { id: sessionOn(1, `cursor-null-duration-${sort}`), turns: 1, tokens: 10, seconds: null },
      ];
      const blocks = await seedSearch(marker, sessions);
      const ordered = await expectedOrder(marker, blocks, sort);
      const complete = await search(new URLSearchParams({ q: marker, sort, limit: '100' }));
      expect(complete.cursor).toBeUndefined();
      expect(complete.hits.map(hitKey)).toEqual(ordered);

      for (const limit of [1, 4]) {
        const hits = await walk(new URLSearchParams({ q: marker, sort, limit: String(limit) }), blocks.length);
        expect(hits.map(hitKey)).toEqual(ordered);
      }
    },
  );

  it.each([0, 1])('walks beyond a lazy shard page with shard %s owning the long stream', async (longShard) => {
    const marker = `globalshardcursorrefill${longShard}`;
    // A lazy shard page holds at most 257 rows. Two session rows cross that cap
    // while keeping the streams uneven and exercising both long-stream owners.
    const blocks = await seedSearch(marker, [
      { id: sessionOn(longShard, `cursor-long-stream-${longShard}`), turns: 258 },
      { id: sessionOn(1 - longShard, `cursor-short-stream-${longShard}`), turns: 3 },
    ]);
    const ordered = await expectedOrder(marker, blocks);
    const hits = await walk(new URLSearchParams({ q: marker, limit: '100' }), blocks.length);
    expect(hits.map(hitKey)).toEqual(ordered);
  });

  it('aggregates a globally winning facet before applying either shard or global value caps', async () => {
    const marker = 'globalshardfacetwinner';
    const winner = 'https://example.test/zzz-shared-winner';
    const decoys = Array.from({ length: 20 }, (_, index) =>
      `https://example.test/decoy-${String(index).padStart(2, '0')}`);
    const sessions: SessionFixture[] = [];
    for (const [index, repo] of decoys.entries()) {
      for (let copy = 0; copy < 2; copy++) {
        sessions.push({ id: sessionOn(0, `facet-decoy-${index}-${copy}`), repo });
      }
    }
    sessions.push({ id: sessionOn(0, 'facet-winner-zero'), repo: winner });
    for (let copy = 0; copy < 2; copy++) {
      sessions.push({ id: sessionOn(1, `facet-winner-one-${copy}`), repo: winner });
    }
    await seedSearch(marker, sessions);

    // Shard 0 ranks the winner 21st (1 vs twenty counts of 2). Losing that contribution
    // leaves a count of 2, where its late name loses the global top-20 tie as well.
    const result = await search(new URLSearchParams({ q: marker, facets: '1', limit: '1' }));
    expect(result.hits).toHaveLength(1);
    const repos = result.facets!.repo_url!;
    expect(Object.keys(repos)).toEqual([winner, ...decoys.slice(0, 19)]);
    expect(repos[winner]).toBe(3);
    for (const repo of decoys.slice(0, 19)) expect(repos[repo]).toBe(2);
    expect(Object.hasOwn(repos, decoys[19]!)).toBe(false);

    const missing = 'https://example.test/not-in-the-index';
    const selected = await search(new URLSearchParams({ q: marker, facets: '1', repo: missing }));
    expect(selected.hits).toEqual([]);
    expect(selected.facets!.repo_url![winner]).toBe(3);
    expect(selected.facets!.repo_url![missing]).toBe(0);
    expect(Object.keys(selected.facets!.repo_url!)).toHaveLength(21);
  });

  it('sorts and filters parents by descendants on other shards, including catalog cost changes', async () => {
    const marker = 'globalshardsubtreecost';
    const parent = sessionOn(0, 'cost-parent');
    const child = sessionOn(1, 'cost-child');
    const grandchild = sessionOn(0, 'cost-grandchild');
    const competitor = sessionOn(1, 'cost-competitor');
    const unknown = sessionOn(0, 'cost-unknown');
    await seedSearch(marker, [
      { id: parent, cost: 1 },
      { id: child, parent, cost: 20 },
      { id: grandchild, parent: child, cost: 5 },
      { id: competitor, cost: 20 },
      { id: unknown, cost: null, calls: 1 },
    ]);

    const ordered = await walk(new URLSearchParams({ q: marker, sort: 'cost', limit: '1' }), 3);
    expect(ordered.map((hit) => hit.session_id)).toEqual([parent, competitor, unknown]);
    const band = await search(new URLSearchParams({ q: marker, sort: 'cost', cost: '10-100', facets: '1' }));
    expect(band.hits.map((hit) => hit.session_id)).toEqual([parent, competitor]);
    expect(band.facets!.cost).toEqual({ '10-100': 2 });
    const descendants = await search(new URLSearchParams({ q: marker, sort: 'cost', subagent: 'yes' }));
    expect(descendants.hits.map((hit) => hit.session_id)).toEqual([child, grandchild]);

    await testEnv.DB.prepare('UPDATE sessions SET cost_usd = 0 WHERE session_id = ?1').bind(child).run();
    await syncSessionCatalog(testEnv, [child]);
    const changed = await search(new URLSearchParams({ q: marker, sort: 'cost' }));
    expect(changed.hits.map((hit) => hit.session_id)).toEqual([competitor, parent, unknown]);
    const changedBand = await search(new URLSearchParams({ q: marker, cost: '1-10', sort: 'cost' }));
    expect(changedBand.hits.map((hit) => hit.session_id)).toEqual([parent]);
  });

  it('replicates HTTP star and unstar mutations and filters sessions on both shards exactly once', async () => {
    const marker = 'globalshardstarfilter';
    const starred = [sessionOn(0, 'star-zero'), sessionOn(1, 'star-one')];
    const plain = [sessionOn(0, 'plain-zero'), sessionOn(1, 'plain-one')];
    const files: Array<{ id: number; hash: string }> = [];
    for (const [index, sessionId] of starred.entries()) {
      const hash = `sha256:${String(index + 1).repeat(64)}`;
      const row = await testEnv.DB.prepare(
        `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, session_id, parse_state)
         VALUES (?1, 'claude-projects', ?2, ?3, 1, ?4, ?5, 'parsed') RETURNING id`,
      ).bind(MACHINE, `${sessionId}.jsonl`, `raw/${MACHINE}/${sessionId}.jsonl`, hash, sessionId).first<{ id: number }>();
      expect(row).not.toBeNull();
      files.push({ id: row!.id, hash });
    }
    await seedSearch(marker, [
      ...starred.map((id, index) => ({ id, turns: 2, fileId: files[index]!.id })),
      ...plain.map((id) => ({ id, turns: 2 })),
    ]);

    const post = async (index: number, action: 'star' | 'unstar') => {
      const sessionId = starred[index]!;
      const response = await SELF.fetch(`${VIEWER}/s/${sessionId}/turns/0/${action}`, {
        method: 'POST',
        headers: { origin: VIEWER, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ turn_key: `id:${sessionId}-turn`, transcript_revision: `${files[index]!.hash}:${UPDATED_AT}` }),
        redirect: 'manual',
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(`/s/${sessionId}?page=1&view=chronological#t0`);
    };
    const expectReplicas = async (expected: string[]) => {
      for (const db of [testEnv.DB, ...indexDbs(testEnv)]) {
        const rows = await db.prepare(
          'SELECT session_id FROM starred_turns WHERE session_id IN (?1, ?2, ?3, ?4) ORDER BY session_id',
        ).bind(...starred, ...plain).all<{ session_id: string }>();
        expect(rows.results.map((row) => row.session_id)).toEqual([...expected].sort());
      }
    };
    const params = new URLSearchParams({ q: marker, has_star: '1', facets: '1' });
    expect((await search(params)).hits).toEqual([]);
    await post(0, 'star');
    await post(1, 'star');
    await expectReplicas(starred);
    const result = await search(params);
    expect(result.hits.map(hitKey).sort()).toEqual(
      starred.flatMap((id) => [`${id}:0:0`, `${id}:1:0`]).sort(),
    );
    expect(result.facets!.has_star).toEqual({ '1': 2 });
    for (const id of plain) expect(result.hits.some((hit) => hit.session_id === id)).toBe(false);

    await post(0, 'unstar');
    await expectReplicas([starred[1]!]);
    const remaining = await search(params);
    expect(remaining.hits.map(hitKey).sort()).toEqual([`${starred[1]}:0:0`, `${starred[1]}:1:0`]);
    expect(remaining.facets!.has_star).toEqual({ '1': 1 });
    expect(indexDbFor(testEnv, starred[0]!)).not.toBe(indexDbFor(testEnv, starred[1]!));
  });

  it('keeps real consumer fractional costs and NULL versus empty catalog metadata through HTTP cost filters', async () => {
    const marker = 'globalshardfractionalconsumer';
    const model = 'index-sharding-fractional-model';
    const uuidOn = (shard: number, prefix: string) => {
      for (let suffix = 0; ; suffix++) {
        const id = `${prefix}-1111-4111-8111-${String(suffix).padStart(12, '0')}`;
        if (indexShardForSessionId(id, 2) === shard) return id;
      }
    };
    const parent = uuidOn(0, 'f1000000');
    const child = uuidOn(1, 'f2000000');
    const competitor = uuidOn(1, 'f3000000');
    await testEnv.DB.prepare(
      `INSERT INTO model_prices
         (model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
          cache_write_5m_cost, cache_write_1h_cost, source, fetched_at)
       VALUES (?1, '2026-01-01', ?1, 'anthropic', 1, 0, 0, 0, 0, 'test', ?2)`,
    ).bind(model, UPDATED_AT).run();

    const messages: Message<ParseMessage>[] = [];
    const acknowledgements: string[] = [];
    const retries: string[] = [];
    for (const fixture of [
      { id: parent, input: 625_000, relpath: `fractional/${parent}.jsonl` },
      { id: child, input: 625_000, relpath: `fractional/${parent}/subagents/agent-${child}.jsonl` },
      { id: competitor, input: 1_125_000, relpath: `fractional/${competitor}.jsonl` },
    ]) {
      // Thinking is searchable but cannot supply either a stored or display title.
      const content = JSON.stringify({
        type: 'assistant', uuid: `${fixture.id}-assistant`, parentUuid: null,
        sessionId: fixture.id, timestamp: UPDATED_AT,
        requestId: `${fixture.id}-request`,
        message: {
          id: `${fixture.id}-message`, role: 'assistant', model,
          content: [{ type: 'thinking', thinking: marker }],
          usage: { input_tokens: fixture.input, output_tokens: 0, service_tier: 'standard' },
        },
      }) + '\n';
      const bytes = new TextEncoder().encode(content);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      const r2Key = `raw/${MACHINE}/claude-projects/${fixture.relpath}`;
      await testEnv.RAW.put(r2Key, bytes);
      const file = await testEnv.DB.prepare(
        `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, harness, session_id, parse_state)
         VALUES (?1, 'claude-projects', ?2, ?3, ?4, ?5, 'claude-code', ?6, 'pending') RETURNING id`,
      ).bind(MACHINE, fixture.relpath, r2Key, bytes.length, hash, fixture.id).first<{ id: number }>();
      expect(file).not.toBeNull();
      messages.push({
        id: String(file!.id), timestamp: new Date(), attempts: 1,
        body: { file_id: file!.id, r2_key: r2Key, reason: 'upload', content_hash: hash },
        ack: () => { acknowledgements.push(fixture.id); },
        retry: () => { retries.push(fixture.id); },
      });
    }
    await worker.queue({
      queue: 'parse', messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll() {}, retryAll() {},
    }, testEnv);
    expect(acknowledgements.sort()).toEqual([parent, child, competitor].sort());
    expect(retries).toEqual([]);

    // Parsers normalize missing metadata to NULL. A later authoritative edit may legitimately
    // store empty strings; the catalog must preserve both rather than coalescing them together.
    await testEnv.DB.prepare("UPDATE sessions SET title = '', cwd = '' WHERE session_id = ?1").bind(child).run();
    const band = await search(new URLSearchParams({ q: marker, cost: '1-10', sort: 'cost' }));
    // The parent's two real $0.625 calls straddle shards. Truncating shard prices to integers
    // would lose its $1.25 band membership and its lead over the $1.125 competitor.
    expect(band.hits.map((hit) => hit.session_id)).toEqual([parent, competitor]);
    expect(band.hits[0]!.session.cwd).toBeNull();
    const descendants = await search(new URLSearchParams({ q: marker, subagent: 'yes', cost: 'under-1' }));
    expect(descendants.hits.map((hit) => hit.session_id)).toEqual([child]);
    expect(descendants.hits[0]!.session.cwd).toBe('');

    for (const db of [testEnv.DB, ...indexDbs(testEnv)]) {
      for (const expected of [
        { session_id: parent, title: null, cwd: null, parent_session_id: null, cost_usd: 0.625 },
        { session_id: child, title: '', cwd: '', parent_session_id: parent, cost_usd: 0.625 },
        { session_id: competitor, title: null, cwd: null, parent_session_id: null, cost_usd: 1.125 },
      ]) {
        const row = await db.prepare(
          `SELECT session_id, title, cwd, parent_session_id, cost_usd, cost_calls, cost_priced_calls, index_state
           FROM sessions WHERE session_id = ?1`,
        ).bind(expected.session_id).first();
        expect(row).toEqual({ ...expected, cost_calls: 1, cost_priced_calls: 1, index_state: 'ready' });
      }
    }
    const usage = await testEnv.DB.prepare(
      'SELECT session_id, usd FROM usage WHERE session_id IN (?1, ?2, ?3) ORDER BY session_id',
    ).bind(parent, child, competitor).all<{ session_id: string; usd: number }>();
    expect(usage.results).toEqual([
      { session_id: parent, usd: 0.625 },
      { session_id: child, usd: 0.625 },
      { session_id: competitor, usd: 1.125 },
    ]);
  });

  it.each([false, true])(
    'preserves a committed star when catalog replication fails (queue failure: %s), then recovers',
    async (queueFails) => {
      const marker = `globalshardcommittedstarfailure${queueFails}`;
      const sessionId = sessionOn(0, `committed-star-${queueFails}`);
      const turnKey = `id:${sessionId}-turn`;
      const hash = `sha256:${'3'.repeat(64)}`;
      const file = await testEnv.DB.prepare(
        `INSERT INTO files (machine_id, store, relpath, r2_key, size, content_hash, session_id, parse_state)
         VALUES (?1, 'claude-projects', ?2, ?3, 1, ?4, ?5, 'parsed') RETURNING id`,
      ).bind(MACHINE, `${sessionId}.jsonl`, `raw/${MACHINE}/${sessionId}.jsonl`, hash, sessionId).first<{ id: number }>();
      expect(file).not.toBeNull();
      await seedSearch(marker, [{ id: sessionId, fileId: file!.id }]);

      let catalogUnavailable = false;
      let failedBatches = 0;
      const shard = indexDbs(testEnv)[0]!;
      const faultyShard = new Proxy(shard, {
        get(target, property) {
          if (property === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              if (catalogUnavailable) {
                failedBatches++;
                throw new Error('D1_ERROR: Network connection lost during catalog batch');
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const attempts: HubQueueMessage[] = [];
      const queued: HubQueueMessage[] = [];
      const controlledQueue = new Proxy(testEnv.ROLLUP_QUEUE, {
        get(target, property) {
          if (property === 'send') {
            return async (message: HubQueueMessage) => {
              attempts.push(message);
              if (queueFails) throw new Error('Queue send unavailable');
              // As in bounded-ingest tests, retain accepted messages for explicit real delivery
              // instead of letting Miniflare race this test's transient database fault.
              queued.push(message);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const faultEnv: Env = { ...testEnv, IDX00: faultyShard, ROLLUP_QUEUE: controlledQueue };
      await assertIndexLayout(faultEnv);

      // These metadata-only mutations plus the star exceed the search drain's 128-entry
      // boundary. No transcript/index fixture bloat is needed to exercise pending503.
      await testEnv.DB.batch(Array.from({ length: 128 }, (_, index) => testEnv.DB.prepare(
        `INSERT INTO sessions (session_id, harness, machine_id, index_state)
         VALUES (?1, ?2, ?3, 'ready')`,
      ).bind(`index-sharding-search-star-backlog-${queueFails}-${index}`, HARNESS, MACHINE)));
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
        passThroughOnException() {}, props: {},
      } as ExecutionContext;
      catalogUnavailable = true;
      try {
        const response = await worker.fetch(new Request(`${VIEWER}/s/${sessionId}/turns/0/star`, {
          method: 'POST',
          headers: { origin: VIEWER, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ turn_key: turnKey, transcript_revision: `${hash}:${UPDATED_AT}` }),
          redirect: 'manual',
        }), faultEnv, ctx);
        await Promise.all(pending);
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`/s/${sessionId}?page=1&view=chronological#t0`);
        expect(failedBatches).toBeGreaterThan(0);
        expect(attempts).toEqual([{ kind: 'index-catalog' }]);
        expect(queued).toEqual(queueFails ? [] : [{ kind: 'index-catalog' }]);
        expect(await testEnv.DB.prepare('SELECT turn_key FROM starred_turns WHERE session_id = ?1')
          .bind(sessionId).first()).toEqual({ turn_key: turnKey });
        expect(await shard.prepare('SELECT turn_key FROM starred_turns WHERE session_id = ?1')
          .bind(sessionId).first()).toBeNull();
        expect(await testEnv.DB.prepare(
          'SELECT COUNT(*) AS n FROM session_catalog_outbox WHERE session_id = ?1',
        ).bind(sessionId).first()).toEqual({ n: 1 });

        catalogUnavailable = false;
        const request = () => new Request(`${API}/api/v1/search?${new URLSearchParams({
          q: marker, has_star: '1', facets: '1',
        })}`, { headers: { 'x-dev-machine': MACHINE } });
        const unavailable = await worker.fetch(request(), faultEnv, ctx);
        expect(unavailable.status).toBe(503);
        expect(await unavailable.json()).toEqual({ error: 'index_catalog_pending' });
        expect(await testEnv.DB.prepare(
          'SELECT COUNT(*) AS n FROM session_catalog_outbox WHERE session_id = ?1',
        ).bind(sessionId).first()).toEqual({ n: 1 });

        if (queueFails) {
          expect((await drainIndexCatalog(faultEnv)).state).toBe('current');
        } else {
          let acknowledged = 0;
          let retried = 0;
          const message = {
            id: 'committed-star-recovery', timestamp: new Date(), attempts: 1, body: queued[0]!,
            ack: () => { acknowledged++; }, retry: () => { retried++; },
          } satisfies Message<HubQueueMessage>;
          await worker.queue({
            queue: 'rollup', messages: [message], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            ackAll() {}, retryAll() {},
          }, faultEnv);
          expect(acknowledged).toBe(1);
          expect(retried).toBe(0);
        }
        const recovered = await worker.fetch(request(), faultEnv, ctx);
        expect(recovered.status).toBe(200);
        const body = await recovered.json() as SearchResult;
        expect(body.hits.map(hitKey)).toEqual([`${sessionId}:0:0`]);
        expect(body.facets!.has_star).toEqual({ '1': 1 });
        expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM session_catalog_outbox').first()).toEqual({ n: 0 });
        for (const db of indexDbs(testEnv)) {
          expect(await db.prepare('SELECT turn_key FROM starred_turns WHERE session_id = ?1')
            .bind(sessionId).first()).toEqual({ turn_key: turnKey });
        }
      } finally {
        catalogUnavailable = false;
        await Promise.all(pending);
      }
    },
  );
});
