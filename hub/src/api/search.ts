import { clampLimit, decodeCursor, encodeCursor } from './sessions';
import {
  buildSessionFilterSql,
  FACET_DEFINITIONS,
  facetExpressionSql,
  facetOrderSql,
  mergeFacetCounts,
  selectedValues,
  sessionDurationSql,
  totalTokensSql,
} from '../session-filters';

export const DEFAULT_RESULT_PAGE_SIZE = 100;

function searchOrder(sort: string | null): string {
  if (sort === 'session_time') return `ORDER BY ${sessionDurationSql('s')} DESC, rank, b.id`;
  if (sort === 'total_tokens') return `ORDER BY ${totalTokensSql('s')} DESC, rank, b.id`;
  return 'ORDER BY rank, b.id';
}

/** @internal Exported so the query-plan regression exercises the exact production query. */
export function searchHitsSql(where: string, sort: string | null, limit: number, offset: number): string {
  return `SELECT b.session_id, b.turn_index, b.block_index, b.role, b.btype, b.tool_name, b.ts,
                 snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16) AS snip,
                 bm25(blocks_fts) AS rank,
                 s.harness, s.machine_id, s.os, s.cwd, s.repo_url, s.primary_model,
                 s.first_interaction_title, s.title AS stored_title, s.started_at, s.index_state,
                 ${sessionDurationSql('s')} AS duration_seconds, ${totalTokensSql('s')} AS total_tokens
          FROM blocks_fts
          JOIN blocks b ON b.id = blocks_fts.rowid
          JOIN sessions s ON s.session_id = b.session_id
          WHERE blocks_fts MATCH ?1 ${where}
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
    index_state: string;
  };
}

export interface SearchResult {
  hits: SearchHit[];
  facets?: Record<string, Record<string, number>>;
  cursor?: string;
  error?: string;
}

/** Core FTS search over blocks with session-level filters and optional facet counts. Shared by the API and the viewer. */
export async function runSearch(url: URL, env: Env, opts: { facets?: boolean } = {}): Promise<SearchResult> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = clampLimit(url.searchParams.get('limit'), DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE);
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const wantFacets = opts.facets ?? url.searchParams.get('facets') === '1';

  const p = url.searchParams;
  const sessionFilter = buildSessionFilterSql(p, 's', 2);
  const binds = sessionFilter.binds;
  const where = sessionFilter.clause ? `AND ${sessionFilter.clause}` : '';

  if (!q) return { hits: [], error: 'missing_q' };

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
  const ftsProbeOk = async (match: string): Promise<boolean> => {
    try {
      await env.DB.prepare('SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?1 LIMIT 1').bind(match).all();
      return true;
    } catch {
      return false;
    }
  };
  const isInvalidUserQuery = async (match: string): Promise<boolean> => {
    if (await ftsProbeOk(match)) return false; // failure wasn't about this match text at all
    return ftsProbeOk('"x"'); // control: does blocks_fts work at all for a known-good match?
  };
  const run = async (match: string) => {
    try {
      return await env.DB.prepare(
        searchHitsSql(where, p.get('sort'), limit, offset),
      )
        .bind(match, ...binds)
        .all();
    } catch (e) {
      if (!(await isInvalidUserQuery(match))) throw e;
      return null;
    }
  };

  // User query wasn't valid FTS5 syntax — retry as a quoted phrase. That fallback can ALSO be
  // invalid (e.g. q is a single '"', producing an unterminated `""""` that FTS5 rejects too) —
  // a garbage query should read as "no results", not a 500. effectiveMatch stays null in that
  // case so the facets query below (which also runs against FTS5) doesn't inherit a match string
  // already known to be broken.
  let rows = await run(q);
  let effectiveMatch: string | null = q;
  if (!rows) {
    const quoted = `"${q.replaceAll('"', '""')}"`;
    rows = await run(quoted);
    effectiveMatch = rows ? quoted : null;
  }
  const results = rows?.results ?? [];

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
      title: (r.first_interaction_title as string | null) ?? (r.stored_title as string | null) ?? null,
      started_at: (r.started_at as string | null) ?? null,
      duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      total_tokens: Number(r.total_tokens),
      index_state: r.index_state as string,
    },
  }));

  const facets: Record<string, Record<string, number>> = {};
  // effectiveMatch is null when even the quoted-phrase fallback was invalid FTS5 — a query this
  // facets clause would ALSO reject. Skip it and report empty facets rather than retrying with a
  // match string already known to be broken.
  if (wantFacets && effectiveMatch !== null) {
    const statements = FACET_DEFINITIONS.map((definition) => {
      const filter = buildSessionFilterSql(p, 's', 2, definition.key);
      const filtered = filter.clause ? ` AND ${filter.clause}` : '';
      const expression = facetExpressionSql(definition, 's');
      return env.DB.prepare(
        `SELECT ${expression} AS v, COUNT(DISTINCT s.session_id) AS n
         FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sessions s ON s.session_id = b.session_id
         WHERE blocks_fts MATCH ?1${filtered} AND ${expression} IS NOT NULL
         GROUP BY v ORDER BY ${facetOrderSql(definition)} LIMIT ${definition.valueLimit ?? 20}`,
      ).bind(effectiveMatch, ...filter.binds);
    });
    const results = await env.DB.batch<{ v: string; n: number }>(statements);
    for (let index = 0; index < FACET_DEFINITIONS.length; index++) {
      const definition = FACET_DEFINITIONS[index]!;
      facets[definition.key] = mergeFacetCounts(
        results[index]!.results,
        selectedValues(p, definition),
      );
    }
  } else if (wantFacets) {
    for (const definition of FACET_DEFINITIONS) {
      facets[definition.key] = mergeFacetCounts([], selectedValues(p, definition));
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
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ hits: result.hits, facets: result.facets, cursor: result.cursor });
}
