import { indexDbs, mapIndexDbs } from '../index-shards';
import { drainIndexCatalog } from '../session-catalog';
import { clampLimit, decodeCursor, encodeCursor } from './sessions';
import {
  buildSessionFilterSql,
  COST_BUCKETS,
  FACET_DEFINITIONS,
  facetExpressionSql,
  facetOrderSql,
  mergeFacetCounts,
  selectedValues,
  sessionDurationSql,
  subagentSessionSql,
  SESSION_TIME_BUCKETS,
  SUBTREE_COST_ALIAS,
  totalTokensSql,
  type MultiValueFilterDefinition,
} from '../session-filters';
import { sessionDisplayTitle } from '../session-title';
import { subtreeCostCte } from '../session-cost';

export const DEFAULT_RESULT_PAGE_SIZE = 100;
const SHARD_HIT_PAGE_SIZE = 256;

interface SearchRow {
  id: number;
  rank: number;
  duration_seconds: number | null;
  total_tokens: number;
  subtree_usd: number | null;
  [key: string]: unknown;
}

/** SQLite orders NULL before numbers in ASC and after numbers in DESC. */
function compareNumber(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

function compareHits(a: SearchRow, b: SearchRow, sort: string | null): number {
  let primary = 0;
  if (sort === 'session_time') primary = compareNumber(b.duration_seconds, a.duration_seconds);
  if (sort === 'total_tokens') primary = compareNumber(b.total_tokens, a.total_tokens);
  if (sort === 'cost') primary = compareNumber(b.subtree_usd, a.subtree_usd);
  return primary || compareNumber(a.rank, b.rank) || a.id - b.id;
}

/** BINARY text order is UTF-8/code-point order, not locale or JS UTF-16 order. */
function compareText(a: string, b: string): number {
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const ac = a.codePointAt(i)!;
    const bc = b.codePointAt(j)!;
    if (ac !== bc) return ac - bc;
    i += ac > 0xffff ? 2 : 1;
    j += bc > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

function compareFacets(
  a: { v: string; n: number },
  b: { v: string; n: number },
  definition: MultiValueFilterDefinition,
): number {
  if (definition.facetOrder === 'value-desc') return compareText(b.v, a.v);
  if (definition.facetOrder === 'bucket') {
    const buckets = definition.kind === 'cost' ? COST_BUCKETS : SESSION_TIME_BUCKETS;
    return buckets.findIndex((bucket) => bucket.value === a.v) -
      buckets.findIndex((bucket) => bucket.value === b.v);
  }
  return b.n - a.n || compareText(a.v, b.v);
}

/** The rolled-up cost the `cost` sort orders by, joined in only for that sort.
 *
 * The other sorts order by an expression over the session row this query already joins. Cost
 * cannot: the figure the list shows includes a session's subagent DESCENDANTS, which lives in the
 * recursive CTE in src/session-cost.ts rather than in a column. Its roots are every session the
 * caller's filter matches — the same clause and the same bound parameters as the outer WHERE,
 * reused rather than re-bound — so an unfiltered search rolls up `sessions` and nothing else. It
 * never reads `usage`, which is the point of storing the per-session subtotal on the row.
 *
 * Rooted at `sessions`, NOT at the sessions the FTS query hits, even though the hit set is the
 * smaller root set for a selective term. Deriving the roots from `blocks_fts` would have to
 * DISTINCT the term's whole postings list — unbounded by the page's LIMIT, because the ordering
 * depends on every hit session's cost — and `blocks` is the largest table in the schema. On the
 * sanitized local corpus (15 sessions, 6,351 blocks) the term `result` matches 4,450 blocks in 10
 * sessions: ~8,900 rows read to name 10 roots, against 15 to name every root there is. The
 * sessions-rooted form has a ceiling that does not move with the query; the hit-rooted one is a
 * scan whose size the caller chooses.
 */
function costRollupCte(where: string): string {
  return `WITH RECURSIVE ${subtreeCostCte(`SELECT s.session_id FROM sessions s WHERE 1 = 1 ${where}`)} `;
}

function costRollupJoin(): string {
  return `JOIN session_subtree_cost ${SUBTREE_COST_ALIAS} ON ${SUBTREE_COST_ALIAS}.session_id = s.session_id`;
}

function searchOrder(sort: string | null): string {
  if (sort === 'session_time') return `ORDER BY ${sessionDurationSql('s')} DESC, rank, b.id`;
  if (sort === 'total_tokens') return `ORDER BY ${totalTokensSql('s')} DESC, rank, b.id`;
  // Unpriced subtrees last: sorting "no known cost" as if it were $0 would bury every session we
  // could not price at the cheap end of a cost ranking. `rank` still breaks ties, so hits within
  // one session stay in relevance order.
  if (sort === 'cost') return 'ORDER BY (c.usd IS NULL) ASC, c.usd DESC, rank, b.id';
  return 'ORDER BY rank, b.id';
}

/** @internal Exported so the query-plan regression exercises the exact production query. */
export function searchHitsSql(
  where: string,
  costWhere: string,
  sort: string | null,
  limit: number,
  offset: number,
): string {
  // The rollup is joined for the cost sort and for a selected cost band; `where` never contains
  // the band, so the CTE's roots stay independent of what the band filters.
  const cost = sort === 'cost' || costWhere !== '';
  return `${cost ? costRollupCte(where) : ''}SELECT b.id, b.session_id, b.turn_index, b.block_index, b.role, b.btype, b.tool_name, b.ts,
                 snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16) AS snip,
                 bm25(blocks_fts) AS rank,
                 s.harness, s.machine_id, s.os, s.cwd, s.repo_url, s.primary_model, ${subagentSessionSql('s')} AS subagent,
                 s.first_interaction_title, s.title AS stored_title, s.started_at, s.index_state,
                 ${sessionDurationSql('s')} AS duration_seconds, ${totalTokensSql('s')} AS total_tokens,
                 ${cost ? `${SUBTREE_COST_ALIAS}.usd` : 'NULL'} AS subtree_usd
          FROM blocks_fts
          JOIN blocks b ON b.id = blocks_fts.rowid
          JOIN sessions s ON s.session_id = b.session_id
          ${cost ? costRollupJoin() : ''}
          WHERE blocks_fts MATCH ?1 ${where} ${costWhere ? `AND ${costWhere}` : ''}
          ${searchOrder(sort)} LIMIT ${limit + 1} OFFSET ${offset}`;
}

export interface SearchHit {
  session_id: string;
  snippet: string;
  block: { turn_index: number; block_index: number; role: string; btype: string; tool_name: string | null; ts: string | null };
  session: {
    harness: string;
    machine_id: string | null;
    os: string | null;
    cwd: string | null;
    repo_url: string | null;
    primary_model: string | null;
    title: string | null;
    started_at: string | null;
    duration_seconds: number | null;
    total_tokens: number;
    subagent: 'no' | 'yes';
    index_state: string;
  };
}

export interface SearchResult {
  hits: SearchHit[];
  facets?: Record<string, Record<string, number>>;
  cursor?: string;
  error?: string;
  status?: 400 | 503;
}

/** Core FTS search over blocks with session-level filters and optional facet counts. Shared by the API and the viewer. */
export async function runSearch(url: URL, env: Env, opts: { facets?: boolean } = {}): Promise<SearchResult> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = clampLimit(url.searchParams.get('limit'), DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE);
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const shardPageSize = Math.min(SHARD_HIT_PAGE_SIZE, offset + limit);
  const wantFacets = opts.facets ?? url.searchParams.get('facets') === '1';

  const p = url.searchParams;
  const sessionFilter = buildSessionFilterSql(p, 's', 2);
  const binds = sessionFilter.binds;
  const where = sessionFilter.clause ? `AND ${sessionFilter.clause}` : '';
  const costWhere = sessionFilter.costClause;

  if (!q) return { hits: [], error: 'missing_q' };
  // Only a bounded reconciliation slice belongs on a read request. A remaining backlog is an
  // unavailable index, not permission to return hits with stale metadata, stars or costs.
  const catalog = await drainIndexCatalog(env);
  if (catalog.state === 'pending') {
    console.warn(JSON.stringify({
      event: 'hub.search.unavailable',
      code: 'index_catalog_pending',
      status: 503,
      catalog_synced: catalog.synced,
      catalog_subrequests: catalog.subrequests,
    }));
    return { hits: [], error: 'index_catalog_pending', status: 503 };
  }

  // Returns null (rather than throwing) on invalid FTS5 syntax, so the two-step fallback below
  // can tell "this match string didn't work" apart from a genuine infra error without a second
  // layer of try/catch at each call site.
  //
  // Classification used to be a regex over the caught error's message (see git history), but
  // 'no such column: X' is genuinely ambiguous by message alone: FTS5 emits it for a bad
  // column-filter in the user's MATCH text (e.g. q="badcol:term") AND SQLite emits the exact same
  // shape for a real schema break on the query's own hardcoded outer-SELECT columns (e.g. after a
  // bad migration references s.primary_model before it exists) — a regex swallows both, hiding a
  // real outage as an empty result set. Classify deterministically instead: on any failure, run a
  // probe against FIXED minimal SQL (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?1 LIMIT
  // 1) that exercises ONLY the user's match text, nothing else about this query's shape.
  //   - Probe succeeds → the real query's failure had nothing to do with the user's MATCH text
  //     (it's schema/infra on the outer query) → rethrow the original error.
  //   - Probe ALSO throws → run a control probe with a known-good MATCH ('"x"').
  //       - Control succeeds → blocks_fts itself is fine; the user's match text specifically is
  //         invalid FTS5 syntax → swallow (return null).
  //       - Control ALSO throws → blocks_fts/D1 itself is down, unrelated to any specific match
  //         text → rethrow the original error.
  // Verified empirically (see the regression tests) that this probe throws identically to the
  // real query for every captured bad-MATCH case (NUL byte, bare '*', 'badcol:term', a lone
  // unescaped quote, NEAR(/parens/backslash/AND/OR/NOT/-/^/:), and that it does NOT throw when
  // the real query's failure is a genuine bad column on the outer SELECT — FTS5 parses MATCH
  // arguments when the cursor opens (i.e. at .all() time), not at statement prepare, so a minimal
  // probe sharing only the MATCH clause reproduces exactly the same class of failure the real
  // query would hit from that same text, no more and no less.
  const ftsProbeOk = async (db: D1Database, match: string): Promise<boolean> => {
    try {
      await db.prepare('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?1 LIMIT 1').bind(match).all();
      return true;
    } catch {
      return false;
    }
  };
  const isInvalidUserQuery = async (db: D1Database, match: string): Promise<boolean> => {
    if (await ftsProbeOk(db, match)) return false;
    return ftsProbeOk(db, '"x"');
  };
  const sort = p.get('sort');
  const readPage = async (db: D1Database, match: string, localOffset: number): Promise<SearchRow[] | null> => {
    try {
      const rows = await db.prepare(
        searchHitsSql(where, costWhere, sort, shardPageSize, localOffset),
      ).bind(match, ...binds).all<SearchRow>();
      return rows.results;
    } catch (e) {
      if (!(await isInvalidUserQuery(db, match))) throw e;
      return null;
    }
  };
  const run = async (match: string): Promise<SearchRow[] | null> => {
    // Do not allocate offset+limit hits per shard. Each sorted stream holds one bounded page;
    // only the stream whose head wins the merge can need another page.
    const dbs = indexDbs(env);
    const initial = await mapIndexDbs(env, (db) => readPage(db, match, 0));
    if (initial.some((rows) => rows === null)) return null;
    const streams = initial.map((rows, shard) => ({
      db: dbs[shard]!,
      rows: rows!,
      position: 0,
      nextOffset: rows!.length,
      done: rows!.length <= shardPageSize,
    }));
    const head = (shard: number): SearchRow => {
      const stream = streams[shard]!;
      return stream.rows[stream.position]!;
    };
    const compare = (a: number, b: number) => compareHits(head(a), head(b), sort);
    // A sorted array is also a valid min-heap. Thereafter only its root can change.
    const heap = streams.flatMap((stream, shard) => stream.rows.length ? [shard] : []).sort(compare);
    const merged: SearchRow[] = [];
    let consumed = 0;
    while (heap.length > 0) {
      const shard = heap[0]!;
      const stream = streams[shard]!;
      if (consumed >= offset) merged.push(head(shard));
      consumed++;
      if (merged.length === limit + 1) break;
      stream.position++;
      if (stream.position === stream.rows.length && !stream.done) {
        const rows = await readPage(stream.db, match, stream.nextOffset);
        if (rows === null) return null;
        stream.rows = rows;
        stream.position = 0;
        stream.nextOffset += rows.length;
        stream.done = rows.length <= shardPageSize;
      }
      if (stream.position === stream.rows.length) {
        const last = heap.pop()!;
        if (heap.length === 0) break;
        heap[0] = last;
      }
      for (let parent = 0;;) {
        const left = parent * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && compare(heap[right]!, heap[left]!) < 0 ? right : left;
        if (compare(heap[parent]!, heap[child]!) <= 0) break;
        [heap[parent], heap[child]] = [heap[child]!, heap[parent]!];
        parent = child;
      }
    }
    return merged;
  };

  // Prefix-match the final term (including a quoted phrase's final term), leaving explicit
  // wildcards and queries ending in ')' (groups/NEAR expressions) unchanged to preserve syntax.
  // Retry invalid syntax using the ORIGINAL query as a quoted phrase, with the wildcard outside
  // its closing quote so FTS5 treats it as a prefix operator.
  // The fallback can also be invalid (e.g. an embedded NUL); keep effectiveMatch null then so
  // facets do not inherit a match string already known to be broken.
  const match = q.endsWith('*') || q.endsWith(')') ? q : `${q}*`;
  let rows = await run(match);
  let effectiveMatch: string | null = match;
  if (!rows) {
    const quoted = `"${q.replaceAll('"', '""')}"*`;
    rows = await run(quoted);
    effectiveMatch = rows ? quoted : null;
  }
  const results = rows ?? [];

  const returnedResults = results.slice(0, limit);

  const hits: SearchHit[] = returnedResults.map((r) => ({
    session_id: r.session_id as string,
    snippet: r.snip as string,
    block: {
      turn_index: r.turn_index as number,
      block_index: r.block_index as number,
      role: r.role as string,
      btype: r.btype as string,
      tool_name: (r.tool_name as string | null) ?? null,
      ts: (r.ts as string | null) ?? null,
    },
    session: {
      harness: r.harness as string,
      machine_id: (r.machine_id as string | null) ?? null,
      os: (r.os as string | null) ?? null,
      cwd: (r.cwd as string | null) ?? null,
      repo_url: (r.repo_url as string | null) ?? null,
      primary_model: (r.primary_model as string | null) ?? null,
      title: sessionDisplayTitle(
        r.first_interaction_title as string | null,
        r.stored_title as string | null,
        r.session_id as string,
        r.harness as string,
      ),
      started_at: (r.started_at as string | null) ?? null,
      duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      total_tokens: Number(r.total_tokens),
      subagent: r.subagent === 'yes' ? 'yes' : 'no',
      index_state: r.index_state as string,
    },
  }));

  const facets: Record<string, Record<string, number>> = {};
  // effectiveMatch is null when even the quoted-phrase fallback was invalid FTS5 — a query this
  // facets clause would ALSO reject. Skip it and report empty facets rather than retrying with a
  // match string already known to be broken.
  if (wantFacets && effectiveMatch !== null) {
    const shardFacets = await mapIndexDbs(env, async (db) => {
      const statements = FACET_DEFINITIONS.map((definition) => {
        const filter = buildSessionFilterSql(p, 's', 2, definition.key);
        const filtered = filter.clause ? ` AND ${filter.clause}` : '';
        const expression = facetExpressionSql(definition, 's');
        // Complete catalog replicas keep descendant costs exact even when a child belongs
        // to another shard. Omit only this facet's own selected predicate, as before.
        const rollup = definition.kind === 'cost' || filter.costClause !== '';
        const banded = filter.costClause ? ` AND ${filter.costClause}` : '';
        return db.prepare(
          `${rollup ? costRollupCte(filter.clause ? `AND ${filter.clause}` : '') : ''}` +
          `SELECT ${expression} AS v, COUNT(DISTINCT s.session_id) AS n
           FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sessions s ON s.session_id = b.session_id
           ${rollup ? costRollupJoin() : ''}
           WHERE blocks_fts MATCH ?1${filtered}${banded} AND ${expression} IS NOT NULL
           GROUP BY v ORDER BY ${facetOrderSql(definition)}`,
        ).bind(effectiveMatch, ...filter.binds);
      });
      return db.batch<{ v: string; n: number }>(statements);
    });
    for (let index = 0; index < FACET_DEFINITIONS.length; index++) {
      const definition = FACET_DEFINITIONS[index]!;
      const counts = new Map<string, number>();
      for (const shard of shardFacets) {
        for (const row of shard[index]!.results) {
          counts.set(row.v, (counts.get(row.v) ?? 0) + Number(row.n));
        }
      }
      // A value below every shard's local top-N can still be a global winner. Apply the
      // established ordering/limit only after summing ALL groups, then retain selections.
      const ordered = [...counts].map(([v, n]) => ({ v, n }))
        .sort((a, b) => compareFacets(a, b, definition))
        .slice(0, definition.valueLimit ?? 20);
      facets[definition.key] = mergeFacetCounts(ordered, selectedValues(p, definition));
    }
  } else if (wantFacets) {
    for (const definition of FACET_DEFINITIONS) {
      // An invalid MATCH expression has no meaningful result set to facet. Keep the established
      // empty-facet response for an implicit default, while retaining any explicit selection.
      const selected = definition.kind === 'subagent' && !p.has(definition.param)
        ? []
        : selectedValues(p, definition);
      facets[definition.key] = mergeFacetCounts([], selected);
    }
  }

  return {
    hits,
    facets: wantFacets ? facets : undefined,
    cursor: results.length > limit ? encodeCursor(offset + limit) : undefined,
  };
}

/** GET /api/v1/search — FTS over blocks with session-level filters and facet counts. */
export async function search(url: URL, env: Env): Promise<Response> {
  const result = await runSearch(url, env);
  if (result.error) return Response.json({ error: result.error }, { status: result.status ?? 400 });
  return Response.json({ hits: result.hits, facets: result.facets, cursor: result.cursor });
}
