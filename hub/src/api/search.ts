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

  const run = async (match: string) =>
    env.DB.prepare(
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

  let rows;
  let effectiveMatch = q;
  try {
    rows = await run(q);
  } catch {
    // User query wasn't valid FTS5 syntax — retry as a quoted phrase.
    effectiveMatch = `"${q.replaceAll('"', '""')}"`;
    rows = await run(effectiveMatch);
  }

  const hits = rows.results.slice(0, limit).map((r) => ({
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
  if (wantFacets) {
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
  }

  return Response.json({
    hits,
    facets: wantFacets ? facets : undefined,
    cursor: rows.results.length > limit ? encodeCursor(offset + limit) : undefined,
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
