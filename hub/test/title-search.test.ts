import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { searchHitsSql, type SearchHit, type SearchResult } from '../src/api/search';
import { indexShardForSessionId } from '../src/index-layout.mjs';
import { assertIndexLayout, indexDbFor, indexDbs, reserveBlockIds } from '../src/index-shards';
import { syncSessionCatalog } from '../src/session-catalog';
import { API, VIEWER } from './hosts';

const testEnv = env as unknown as Env;
const MACHINE = 'title-search-machine';
const TITLE = 'SQUARE: Square up tapered bar stock';
const OMP_ID = '00000000-0000-4000-8000-000000000105';

beforeAll(async () => {
  await assertIndexLayout(testEnv);
  await testEnv.DB.prepare('INSERT INTO machines (machine_id, os) VALUES (?1, ?2)')
    .bind(MACHINE, 'linux').run();
});

async function search(q: string, extra: Record<string, string> = {}): Promise<SearchResult> {
  const response = await SELF.fetch(`${API}/api/v1/search?${new URLSearchParams({ q, ...extra })}`, {
    headers: { 'x-dev-machine': MACHINE },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<SearchResult>;
}

async function seed(id: string, title: string | null, options: {
  harness?: string; first?: string | null; parent?: string; tokens?: number; seconds?: number;
  cost?: number; repo?: string;
} = {}): Promise<void> {
  await testEnv.DB.prepare(`INSERT INTO sessions
    (session_id, harness, machine_id, os, title, first_interaction_title, parent_session_id,
     tokens_in, tokens_out, started_at, ended_at, cost_usd, cost_calls, cost_priced_calls, repo_url)
    VALUES (?1, ?2, ?3, 'linux', ?4, ?5, ?6, ?7, 0, '2026-07-01T10:00:00Z', ?8, ?9, ?10, ?10, ?11)`)
    .bind(id, options.harness ?? 'omp', MACHINE, title, options.first ?? null, options.parent ?? null,
      options.tokens ?? 0, new Date(Date.parse('2026-07-01T10:00:00Z') + (options.seconds ?? 60) * 1000).toISOString(),
      options.cost ?? null, options.cost === undefined ? 0 : 1, options.repo ?? null).run();
  await syncSessionCatalog(testEnv, [id]);
}

async function block(id: string, text: string, turn = 0): Promise<void> {
  const db = indexDbFor(testEnv, id);
  const rowid = await reserveBlockIds(db, 1);
  await db.batch([
    db.prepare(`INSERT INTO blocks (id, session_id, file_id, turn_index, block_index, role, btype, text)
      VALUES (?1, ?2, 1, ?3, 0, 'user', 'text', ?4)`).bind(rowid, id, turn, text),
    db.prepare('INSERT INTO blocks_fts (rowid, text) VALUES (?1, ?2)').bind(rowid, text),
  ]);
}

function onShard(shard: number, label: string): string {
  for (let n = 0; ; n++) {
    const id = `title-search-${label}-${n}`;
    if (indexShardForSessionId(id, 2) === shard) return id;
  }
}

function key(hit: SearchHit): string {
  return `${hit.session_id}:${hit.match_kind}:${hit.block?.turn_index ?? ''}:${hit.block?.block_index ?? ''}`;
}

describe('indexed session title search', () => {
  it('finds an ingested OMP title absent from every message, without fabricating blocks or anchors', async () => {
    const records = [
      { type: 'title', title: TITLE },
      { type: 'session', id: OMP_ID, version: 3, timestamp: '2026-07-01T10:00:00Z', cwd: '/synthetic/title-fixture' },
      { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-01T10:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Observe a synthetic lavender lantern.' }] } },
      { type: 'title_change', id: 'title1', parentId: 'u1', title: TITLE },
    ];
    const body = new TextEncoder().encode(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const digest = await crypto.subtle.digest('SHA-256', body);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const path = `synthetic/2026-07-01T10-00-00-000Z_${OMP_ID}.jsonl`;
    const uploaded = await SELF.fetch(`${API}/api/v1/files/${MACHINE}/omp/${encodeURIComponent(path)}`, {
      method: 'PUT', body,
      headers: { 'x-dev-machine': MACHINE, 'x-content-hash': `sha256:${hash}`,
        'x-file-mtime': '2026-07-01T10:00:00Z', 'content-length': String(body.length) },
    });
    expect(uploaded.status).toBe(201);
    const file = await testEnv.DB.prepare('SELECT id, r2_key FROM files WHERE machine_id = ?1 AND relpath = ?2')
      .bind(MACHINE, path).first<{ id: number; r2_key: string }>();
    expect(file).not.toBeNull();
    let retried = false;
    const message = { id: String(file!.id), timestamp: new Date(), attempts: 1,
      body: { file_id: file!.id, r2_key: file!.r2_key, reason: 'upload' as const },
      ack() {}, retry() { retried = true; } };
    await worker.queue({
      queue: 'parse', messages: [message], ackAll() {}, retryAll() { retried = true; },
    } as unknown as MessageBatch<ParseMessage>, testEnv);
    expect(retried).toBe(false);
    expect(await testEnv.DB.prepare('SELECT title, index_state FROM sessions WHERE session_id = ?1')
      .bind(OMP_ID).first()).toEqual({ title: TITLE, index_state: 'ready' });
    const db = indexDbFor(testEnv, OMP_ID);
    expect((await db.prepare('SELECT text FROM blocks WHERE session_id = ?1').bind(OMP_ID).all()).results)
      .toEqual([{ text: 'Observe a synthetic lavender lantern.' }]);
    // The original block-only path is the known-bad control: exactly the same literal-prefix MATCH
    // has no transcript hit. The title query below must add a genuinely new searchable source.
    expect((await db.prepare(`SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?1`)
      .bind(`"${TITLE}"*`).all()).results).toEqual([]);
    const result = await search(TITLE, { facets: '1' });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ session_id: OMP_ID, match_kind: 'title', block: null,
      session: { title: TITLE, harness: 'omp' } });
    expect(result.hits[0]!.snippet).toContain('<mark>');
    expect(result.facets!.harness).toEqual({ omp: 1 });
    expect(result.cursor).toBeUndefined();
    const html = await (await SELF.fetch(`${VIEWER}/?${new URLSearchParams({ q: TITLE })}`)).text();
    expect(html).toContain(`<a href="/s/${OMP_ID}">${TITLE}</a>`);
    expect(html).toContain('Title match');
    expect(html).not.toContain(`/s/${OMP_ID}?page=`);
    expect(html).not.toContain('#t0');
  });

  it('indexes stored titles and only the relevant displayed first-interaction titles', async () => {
    await seed('title-search-display-omp', 'ompstoredtitle', { first: 'omphiddenderived' });
    await seed('title-search-display-cc', 'ccstoredtitle', { harness: 'claude-code', first: 'ccdisplayedtitle' });
    await seed('title-search-display-empty', '', { first: 'ompdisplayedfallback' });
    for (const [query, id, displayed] of [
      ['ompstoredtitle', 'title-search-display-omp', 'ompstoredtitle'],
      ['ccstoredtitle', 'title-search-display-cc', 'ccdisplayedtitle'],
      ['ccdisplayedtitle', 'title-search-display-cc', 'ccdisplayedtitle'],
      ['ompdisplayedfallback', 'title-search-display-empty', 'ompdisplayedfallback'],
    ]) {
      const result = await search(query!);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]).toMatchObject({ session_id: id, match_kind: 'title', block: null,
        session: { title: displayed } });
    }
    expect((await search('omphiddenderived')).hits).toEqual([]);
    // Separate FTS columns must not invent a phrase crossing the two title fields.
    expect((await search('"ccstoredtitle ccdisplayedtitle"')).hits).toEqual([]);
  });

  it('tracks title changes, empty/NULL values, harness preference and deletions through catalog sync', async () => {
    const id = 'title-search-update';
    await seed(id, 'beforetitlereplacement', { first: 'derivedtitlereplacement' });
    expect((await search('beforetitlereplacement')).hits).toHaveLength(1);
    await testEnv.DB.prepare('UPDATE sessions SET title = ?2 WHERE session_id = ?1')
      .bind(id, 'aftertitlereplacement').run();
    // Search's normal drain, not a test-only rebuild, reconciles the mutation.
    expect((await search('beforetitlereplacement')).hits).toEqual([]);
    expect((await search('aftertitlereplacement')).hits).toHaveLength(1);
    for (const title of ['', null]) {
      await testEnv.DB.prepare('UPDATE sessions SET title = ?2 WHERE session_id = ?1').bind(id, title).run();
      expect((await search('aftertitlereplacement')).hits).toEqual([]);
      expect((await search('derivedtitlereplacement')).hits).toHaveLength(1);
    }
    await testEnv.DB.prepare("UPDATE sessions SET title = 'aftertitlereplacement', harness = 'claude-code' WHERE session_id = ?1")
      .bind(id).run();
    expect((await search('derivedtitlereplacement')).hits).toHaveLength(1);
    await testEnv.DB.prepare("UPDATE sessions SET harness = 'omp' WHERE session_id = ?1").bind(id).run();
    expect((await search('derivedtitlereplacement')).hits).toEqual([]);
    await testEnv.DB.prepare('DELETE FROM sessions WHERE session_id = ?1').bind(id).run();
    expect((await search('aftertitlereplacement', { facets: '1' })).hits).toEqual([]);
    for (const db of indexDbs(testEnv)) {
      expect((await db.prepare("SELECT rowid FROM session_titles_fts WHERE session_titles_fts MATCH 'aftertitlereplacement'").all()).results)
        .toEqual([]);
      await db.prepare("INSERT INTO session_titles_fts (session_titles_fts, rank) VALUES ('integrity-check', 1)").run();
    }
  });

  it.each(['relevance', 'session_time', 'total_tokens', 'cost'])(
    'paginates mixed title/block %s hits once and counts distinct sessions across shards', async (sort) => {
      const marker = `mixedtitlesearch${sort.replaceAll('_', '')}`;
      const titleOnly = onShard(1, `${sort}-titleonly`);
      const both0 = onShard(0, `${sort}-both0`);
      const both1 = onShard(1, `${sort}-both1`);
      const blockOnly = onShard(1, `${sort}-blockonly`);
      for (const [id, title, tokens] of [[titleOnly, marker, 40], [both0, marker, 30],
        [both1, marker, 20], [blockOnly, 'unrelated label', 10]] as const) {
        await seed(id, title, { tokens, seconds: tokens, cost: tokens, repo: 'https://example.test/title-search' });
      }
      await block(both0, marker, 7);
      await block(both1, marker, 8);
      await block(blockOnly, marker, 9);
      const all = await search(marker, { sort, facets: '1' });
      expect(all.hits).toHaveLength(6);
      expect(all.hits.filter((hit) => hit.match_kind === 'title')).toHaveLength(3);
      expect(all.hits.filter((hit) => hit.match_kind === 'block')).toHaveLength(3);
      expect(all.facets!.harness).toEqual({ omp: 4 });
      expect(all.facets!.repo_url).toEqual({ 'https://example.test/title-search': 4 });
      if (sort !== 'relevance') {
        expect(all.hits.map((hit) => hit.session_id)).toEqual([titleOnly, both0, both0, both1, both1, blockOnly]);
      }
      const paged: SearchHit[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page++) {
        const result = await search(marker, { sort, limit: '1', ...(cursor ? { cursor } : {}) });
        expect(result.hits).toHaveLength(1);
        paged.push(...result.hits);
        cursor = result.cursor;
        if (page < 5) expect(cursor).toBeDefined();
      }
      expect(cursor).toBeUndefined();
      expect(paged.map(key)).toEqual(all.hits.map(key));
      expect(new Set(paged.map(key)).size).toBe(6);
    },
  );

  it('applies selected filters and self-excluding facets to title-only sessions', async () => {
    const marker = 'titlefilterneedle';
    await seed('title-filter-parent', marker, { cost: 25, tokens: 100, seconds: 300 });
    await seed('title-filter-child', marker, { parent: 'title-filter-parent', cost: 5 });
    await seed('title-filter-cc', marker, { harness: 'claude-code', cost: 0.5 });
    await testEnv.DB.prepare("INSERT INTO starred_turns (session_id, turn_key) VALUES ('title-filter-parent', 'synthetic-star')").run();
    const result = await search(marker, { harness: 'omp', has_star: '1', cost: '10-100', facets: '1' });
    expect(result.hits.map((hit) => hit.session_id)).toEqual(['title-filter-parent']);
    expect(result.facets!.harness).toEqual({ omp: 1 });
    expect(result.facets!.has_star).toEqual({ '1': 1 });
    expect((await search(marker, { subagent: 'yes' })).hits.map((hit) => hit.session_id)).toEqual(['title-filter-child']);
    const harness = await search(marker, { harness: 'omp', facets: '1' });
    expect(harness.facets!.harness).toEqual({ omp: 1, 'claude-code': 1 });
    expect((await search(marker, { machine: 'missing-machine' })).hits).toEqual([]);
  });

  it('preserves MATCH/prefix semantics for title queries', async () => {
    await seed('title-search-syntax', 'syntaxprefix secondword');
    for (const query of ['text:syntaxprefix', 'syntaxpref', '"syntaxpref"', 'syntaxprefix OR absent',
      '(syntaxprefix OR absent)', 'NEAR(syntaxprefix secondword)']) {
      const result = await search(query, { facets: '1' });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]!.match_kind).toBe('title');
      expect(result.facets!.harness).toEqual({ omp: 1 });
    }
  });

  it('escapes title snippets while preserving generated highlight marks', async () => {
    const title = '<script>alert("titlehtmlneedle")</script> <img src=x onerror=alert(1)>';
    await seed('title-search-html', title);
    const html = await (await SELF.fetch(`${VIEWER}/?q=titlehtmlneedle`)).text();
    expect(html).toContain('<mark>titlehtmlneedle</mark>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(');
    expect(html).not.toContain('<img src=x');
  });

  it('drives title matching through FTS rather than a session-table scan', async () => {
    const plan = await indexDbs(testEnv)[0]!.prepare(`EXPLAIN QUERY PLAN ${searchHitsSql('', '', null, 20, 0)}`)
      .bind('titlequeryplan').all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join('\n');
    expect(detail).toContain('SCAN session_titles_fts VIRTUAL TABLE');
    expect(detail).toContain('SCAN blocks_fts VIRTUAL TABLE');
    expect(detail).not.toMatch(/SCAN (?:s|sessions)(?:\s|$)/m);
  });
});
