import { clampLimit, decodeCursor, encodeCursor, normalizeToBound } from './sessions';

const FACET_COLUMNS = ['harness', 'machine_id', 'os', 'primary_model', 'repo_url'] as const;
const SESSION_TIME_FACETS = [
  ['under-5m', 'Under 5 minutes', 0, 5 * 60],
  ['5m-30m', '5–30 minutes', 5 * 60, 30 * 60],
  ['30m-2h', '30 minutes–2 hours', 30 * 60, 2 * 60 * 60],
  ['over-2h', 'Over 2 hours', 2 * 60 * 60, null],
] as const;
const SESSION_TIME_SQL = "MAX(0, (julianday(s.ended_at) - julianday(s.started_at)) * 86400)";
// Reasoning output is already included in output tokens, and cached input is not new work.
const TOTAL_TOKENS_SQL = 'COALESCE(s.tokens_in, 0) + COALESCE(s.tokens_out, 0)';

function sessionTimeFilter(value: string | null, addFilter: (sql: string, value: unknown) => void): void {
  const facet = SESSION_TIME_FACETS.find(([key]) => key === value);
  if (!facet) return;
  const [, , min, max] = facet;
  if (max === null) {
    addFilter(`${SESSION_TIME_SQL} >= ?`, min);
    return;
  }
  addFilter(`${SESSION_TIME_SQL} >= ?`, min);
  addFilter(`${SESSION_TIME_SQL} < ?`, max);
}

function searchOrder(sort: string | null): string {
  if (sort === 'session_time') return `ORDER BY ${SESSION_TIME_SQL} DESC, rank, b.id`;
  if (sort === 'total_tokens') return `ORDER BY ${TOTAL_TOKENS_SQL} DESC, rank, b.id`;
  return 'ORDER BY rank, b.id';
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
  const limit = clampLimit(url.searchParams.get('limit'), 20, 100);
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const wantFacets = opts.facets ?? url.searchParams.get('facets') === '1';

  const filters: string[] = [];
  const binds: unknown[] = [];
  const addFilter = (sql: string, value: unknown) => {
    binds.push(value);
    filters.push(sql.replace('?', `?${binds.length + 1}`)); // ?1 reserved for the query text
  };
  const p = url.searchParams;
  if (p.get('harness')) addFilter('s.harness = ?', p.get('harness'));
  if (p.get('machine')) addFilter('s.machine_id = ?', p.get('machine'));
  if (p.get('os')) addFilter('s.os = ?', p.get('os'));
  if (p.get('model')) addFilter('s.primary_model = ?', p.get('model'));
  if (p.get('repo')) addFilter('s.repo_url = ?', p.get('repo'));
  if (p.get('cwd')) addFilter('s.cwd = ?', p.get('cwd'));
  if (p.get('from')) addFilter('s.started_at >= ?', p.get('from'));
  if (p.get('to')) addFilter('s.started_at <= ?', normalizeToBound(p.get('to')!));
  const sessionDate = p.get('session_date');
  if (sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    addFilter('s.started_at >= ?', sessionDate);
    addFilter("s.started_at < date(?, '+1 day')", sessionDate);
  }
  sessionTimeFilter(p.get('session_time'), addFilter);
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const order = searchOrder(p.get('sort'));

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
        `SELECT b.session_id, b.turn_index, b.block_index, b.role, b.btype, b.tool_name, b.ts,
                snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16) AS snip,
                bm25(blocks_fts) AS rank,
                s.harness, s.machine_id, s.os, s.cwd, s.repo_url, s.primary_model, s.title, s.started_at, s.index_state,
                ${SESSION_TIME_SQL} AS duration_seconds, ${TOTAL_TOKENS_SQL} AS total_tokens
         FROM blocks_fts
         JOIN blocks b ON b.id = blocks_fts.rowid
         JOIN sessions s ON s.session_id = b.session_id
         WHERE blocks_fts MATCH ?1 ${where}
         ${order} LIMIT ${limit + 1} OFFSET ${offset}`,
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

  const hits: SearchHit[] = results.slice(0, limit).map((r) => ({
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
      title: (r.title as string | null) ?? null,
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
    for (const col of FACET_COLUMNS) {
      const fr = await env.DB.prepare(
        `SELECT s.${col} AS v, COUNT(DISTINCT s.session_id) AS n
         FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sessions s ON s.session_id = b.session_id
         WHERE blocks_fts MATCH ?1 ${where} AND s.${col} IS NOT NULL
         GROUP BY s.${col} ORDER BY n DESC LIMIT 20`,
      )
        .bind(effectiveMatch, ...binds)
        .all<{ v: string; n: number }>();
      facets[col] = Object.fromEntries(fr.results.map((r) => [r.v, r.n]));
    }
    const dateFacets = await env.DB.prepare(
      `SELECT substr(s.started_at, 1, 10) AS v, COUNT(DISTINCT s.session_id) AS n
       FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sessions s ON s.session_id = b.session_id
       WHERE blocks_fts MATCH ?1 ${where} AND s.started_at IS NOT NULL
       GROUP BY v ORDER BY v DESC LIMIT 20`,
    )
      .bind(effectiveMatch, ...binds)
      .all<{ v: string; n: number }>();
    facets.session_date = Object.fromEntries(dateFacets.results.map((r) => [r.v, r.n]));
    const timeFacets: Record<string, number> = {};
    for (const [key, , min, max] of SESSION_TIME_FACETS) {
      const upper = max === null ? '' : ` AND ${SESSION_TIME_SQL} < ?${binds.length + 3}`;
      const fr = await env.DB.prepare(
        `SELECT COUNT(DISTINCT s.session_id) AS n
         FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sessions s ON s.session_id = b.session_id
         WHERE blocks_fts MATCH ?1 ${where} AND ${SESSION_TIME_SQL} >= ?${binds.length + 2}${upper}`,
      ).bind(effectiveMatch, ...binds, min, ...(max === null ? [] : [max])).first<{ n: number }>();
      if (fr?.n) timeFacets[key] = fr.n;
    }
    facets.session_time = timeFacets;
  } else if (wantFacets) {
    for (const col of FACET_COLUMNS) facets[col] = {};
    facets.session_date = {};
    facets.session_time = {};
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
