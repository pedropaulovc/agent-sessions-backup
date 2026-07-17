import { clampLimit, normalizeToBound } from './sessions';

const FACET_COLUMNS = ['harness', 'machine_id', 'os', 'primary_model', 'repo_url'] as const;

/** GET /api/v1/search — FTS over blocks with session-level filters and facet counts. */
export async function search(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const limit = clampLimit(url.searchParams.get('limit'), 20, 100);
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const wantFacets = url.searchParams.get('facets') === '1';

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
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

  if (!q) return Response.json({ error: 'missing_q' }, { status: 400 });

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
                s.harness, s.machine_id, s.os, s.cwd, s.repo_url, s.primary_model, s.title, s.started_at, s.index_state
         FROM blocks_fts
         JOIN blocks b ON b.id = blocks_fts.rowid
         JOIN sessions s ON s.session_id = b.session_id
         WHERE blocks_fts MATCH ?1 ${where}
         ORDER BY rank LIMIT ${limit + 1} OFFSET ${offset}`,
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

  const hits = results.slice(0, limit).map((r) => ({
    session_id: r.session_id,
    snippet: r.snip,
    block: { turn_index: r.turn_index, block_index: r.block_index, role: r.role, btype: r.btype, tool_name: r.tool_name, ts: r.ts },
    session: {
      harness: r.harness,
      machine_id: r.machine_id,
      os: r.os,
      cwd: r.cwd,
      repo_url: r.repo_url,
      primary_model: r.primary_model,
      title: r.title,
      started_at: r.started_at,
      index_state: r.index_state,
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
  } else if (wantFacets) {
    for (const col of FACET_COLUMNS) facets[col] = {};
  }

  return Response.json({
    hits,
    facets: wantFacets ? facets : undefined,
    cursor: results.length > limit ? encodeCursor(offset + limit) : undefined,
  });
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}
function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    // Invalid base64 (e.g. a hand-edited cursor like "not-base64!") — reset to the first
    // page instead of 500ing.
    return 0;
  }
  const n = Number(decoded);
  // A finite non-integer (e.g. a hand-edited cursor decoding to 1.5) would otherwise pass
  // through into the SQL OFFSET, which SQLite rejects with a datatype mismatch — 500 instead
  // of just resetting to the first page.
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
