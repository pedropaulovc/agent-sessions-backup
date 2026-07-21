import { runSearch, type SearchHit } from '../api/search';
import { clampLimit, decodeCursor, encodeCursor, normalizeToBound } from '../api/sessions';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';
import { firstInteractionTitleCandidateSql, sessionDisplayTitle } from '../session-title';

const DEFAULT_PAGE_SIZE = 20;

const FILTERS = [
  { param: 'harness', col: 'harness', label: 'Harness' },
  { param: 'machine', col: 'machine_id', label: 'Machine' },
  { param: 'os', col: 'os', label: 'OS' },
  { param: 'model', col: 'primary_model', label: 'Model' },
] as const;

const SESSION_FILTERS = [
  ...FILTERS,
  { param: 'repo', col: 'repo_url', label: 'Repo' },
  { param: 'cwd', col: 'cwd', label: 'Working directory' },
] as const;
const DATE_FILTERS = ['from', 'to'] as const;
const SORT_OPTIONS = [
  ['recent', 'Recent'],
  ['session_time', 'Session time'],
  ['total_tokens', 'Total tokens'],
] as const;
const SESSION_TIME_FACETS: Record<string, string> = {
  'under-5m': 'Under 5 minutes',
  '5m-30m': '5–30 minutes',
  '30m-2h': '30 minutes–2 hours',
  'over-2h': 'Over 2 hours',
};
const SESSION_TIME_SQL = "MAX(0, (julianday(ended_at) - julianday(started_at)) * 86400)";
// Reasoning output is already included in output tokens, and cached input is not new work.
const TOTAL_TOKENS_SQL = 'COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)';

// Facet column name (as returned by runSearch) → query param the viewer filters on.
const FACET_PARAM: Record<string, string> = {
  harness: 'harness',
  machine_id: 'machine',
  os: 'os',
  primary_model: 'model',
  repo_url: 'repo',
  session_date: 'session_date',
  session_time: 'session_time',
};
const FACET_LABEL: Record<string, string> = {
  harness: 'Harness',
  machine_id: 'Machine',
  os: 'OS',
  primary_model: 'Model',
  repo_url: 'Repo',
  session_date: 'Session date/time',
  session_time: 'Session time',
};

interface RecentRow {
  session_id: string;
  harness: string;
  machine_id: string | null;
  primary_model: string | null;
  title_candidate: string | null;
  stored_title: string | null;
  started_at: string | null;
  cwd: string | null;
  duration_seconds: number | null;
  total_tokens: number;
}

interface RecentResult {
  rows: RecentRow[];
  previousCursor?: string;
  nextCursor?: string;
  page: number;
  limit: number;
}

interface RecentCursor {
  direction: 'after' | 'before';
  startedAt: string;
  sessionId: string;
  page: number;
}

/** GET / — paginated recent sessions or full-text results, with filters and facets in a left sidebar. */
export async function searchPage(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const query = p.get('q')?.trim() ?? '';
  const active = activeFilters(p);
  const options = await filterOptions(env);
  const searchForm = renderSearchForm(query, active);

  if (!query) {
    const [recent, facets] = await Promise.all([recentSessions(p, env), sessionFacets(p, env)]);
    const list = recent.rows.length
      ? recent.rows.map(renderRecent).join('')
      : `<p class="muted">No sessions match these filters.</p>`;
    const firstResult = (recent.page - 1) * recent.limit + 1;
    const summary = recent.rows.length
      ? `<p class="muted small">Showing ${firstResult}–${firstResult + recent.rows.length - 1} recent sessions</p>`
      : '';
    const body = searchForm + renderSearchLayout(
      renderSidebar(url, query, active, options, facets),
      `<h3 class="muted small">Recent sessions</h3>${summary}${list}` +
        recentPager(url, recent.previousCursor, recent.nextCursor, recent.page),
    );
    return page({ title: 'Search — sessions', nav: 'search', body });
  }

  const result = await runSearch(url, env, { facets: true });
  const offset = decodeCursor(p.get('cursor'));
  const limit = clampLimit(p.get('limit'), DEFAULT_PAGE_SIZE, 100);
  const hits = result.hits.map(renderHit).join('');
  const summary = result.hits.length
    ? `<p class="muted small">Showing ${offset + 1}–${offset + result.hits.length} for “${esc(query)}”</p>`
    : '';
  const list = result.hits.length
    ? hits
    : `<p class="muted">No matches for “${esc(query)}”.</p>`;
  const body = searchForm + renderSearchLayout(
    renderSidebar(url, query, active, options, result.facets),
    `${summary}${list}${searchPager(url, result.cursor, offset, limit)}`,
  );
  return page({ title: `${query} — sessions`, nav: 'search', body });
}

function activeFilters(p: URLSearchParams): Record<string, string> {
  const active: Record<string, string> = {};
  const params = new Set<string>([
    ...SESSION_FILTERS.map((f) => f.param),
    ...DATE_FILTERS,
    'session_time',
    'session_date',
    'sort',
    ...Object.values(FACET_PARAM),
  ]);
  for (const param of params) {
    const value = p.get(param);
    if (value) active[param] = value;
  }
  return active;
}

async function filterOptions(env: Env): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const f of FILTERS) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT ${f.col} AS v FROM sessions WHERE ${f.col} IS NOT NULL ORDER BY ${f.col} LIMIT 200`,
    ).all<{ v: string }>();
    out[f.param] = rows.results.map((r) => r.v);
  }
  return out;
}

function renderSearchForm(query: string, active: Record<string, string>): string {
  const hidden = Object.entries(active)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('');
  return `<form class="search" method="get" action="/">` +
    `<input type="search" name="q" value="${esc(query)}" placeholder="Full-text search across sessions…" autofocus>` +
    hidden +
    `<button type="submit">Search</button></form>`;
}

function renderSearchLayout(sidebar: string, content: string): string {
  return `<div class="row search-layout">` +
    `<aside class="sidebar facets">${sidebar}</aside>` +
    `<section class="content search-results">${content}</section>` +
    `</div>`;
}

function renderSidebar(
  url: URL,
  query: string,
  active: Record<string, string>,
  options: Record<string, string[]>,
  facets: Record<string, Record<string, number>> | undefined,
): string {
  const preserved = Object.entries(active)
    .filter(([name]) => name !== 'sort' && !FILTERS.some((f) => f.param === name))
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('');
  const selects = FILTERS.map((f) => {
    const opts = [`<option value="">All</option>`]
      .concat(
        (options[f.param] ?? []).map(
          (value) => `<option value="${esc(value)}"${active[f.param] === value ? ' selected' : ''}>${esc(value)}</option>`,
        ),
      )
      .join('');
    return `<label><span>${f.label}</span>` +
      `<select name="${f.param}" aria-label="Filter by ${f.label}" onchange="this.form.requestSubmit()">${opts}</select>` +
      `</label>`;
  }).join('');
  const sort = active.sort ?? 'recent';
  const sortOptions = SORT_OPTIONS.map(([value, label]) =>
    // Full-text searches use FTS relevance unless an explicit non-default sort is selected.
    value === 'recent' && query ? [value, 'Relevance'] : [value, label],
  ).map(([value, label]) =>
    `<option value="${value}"${sort === value ? ' selected' : ''}>${label}</option>`,
  ).join('');
  const clear = new URL(url);
  clear.search = '';
  if (query) clear.searchParams.set('q', query);
  const controls = `<form class="facet-controls" method="get" action="/">` +
    `<input type="hidden" name="q" value="${esc(query)}">${preserved}` +
    `<div class="facet-selects">${selects}</div>` +
    `<label><span>Sort by</span><select name="sort" aria-label="Sort sessions" onchange="this.form.requestSubmit()">${sortOptions}</select></label>` +
    `<noscript><button type="submit">Apply filters</button></noscript>` +
    (Object.keys(active).length ? `<a class="clear-filters small" href="${esc(clear.pathname + clear.search)}">Clear filters</a>` : '') +
    `</form>`;
  return controls + renderFacets(url, facets, active);
}

async function recentSessions(p: URLSearchParams, env: Env): Promise<RecentResult> {
  if (p.get('sort') === 'session_time' || p.get('sort') === 'total_tokens') return sortedRecentSessions(p, env);
  const limit = clampLimit(p.get('limit'), DEFAULT_PAGE_SIZE, 100);
  const cursor = decodeRecentCursor(p.get('cursor'));
  const page = cursor?.page ?? 1;
  const { where: baseWhere, binds } = sessionWhere(p);
  const boundary = cursor ? recentBoundary(cursor.direction, cursor.startedAt, cursor.sessionId, binds) : '';
  const where = boundary ? `${baseWhere || 'WHERE'}${baseWhere ? ' AND' : ''} ${boundary}` : baseWhere;
  const reverse = cursor?.direction === 'before';
  const direction = reverse ? 'ASC' : 'DESC';
  const result = await env.DB.prepare(
    `SELECT session_id, harness, machine_id, primary_model,
            ${firstInteractionTitleCandidateSql('sessions')} AS title_candidate, title AS stored_title, started_at, cwd,
            ${SESSION_TIME_SQL} AS duration_seconds, ${TOTAL_TOKENS_SQL} AS total_tokens
     FROM sessions ${where}
     ORDER BY COALESCE(started_at, '') ${direction}, session_id ${direction} LIMIT ${limit + 1}`,
  ).bind(...binds).all<RecentRow>();
  const rows = result.results.slice(0, limit);
  if (reverse) rows.reverse();

  const first = rows.at(0);
  const last = rows.at(-1);
  const hasPrevious = reverse
    ? result.results.length > limit
    : !!cursor && !!first && await hasRecentRow(p, env, 'before', first);
  const hasNext = reverse
    ? !!last && await hasRecentRow(p, env, 'after', last)
    : result.results.length > limit;
  return {
    rows,
    previousCursor: hasPrevious && first
      ? encodeRecentCursor({ direction: 'before', startedAt: startedAtKey(first), sessionId: first.session_id, page: Math.max(1, page - 1) })
      : undefined,
    nextCursor: hasNext && last
      ? encodeRecentCursor({ direction: 'after', startedAt: startedAtKey(last), sessionId: last.session_id, page: page + 1 })
      : undefined,
    page,
    limit,
  };
}

/** Non-default sorts use the search page's offset cursor. Recent stays keyset-paginated because
 * new ingestion should never shift rows between its pages. */
async function sortedRecentSessions(p: URLSearchParams, env: Env): Promise<RecentResult> {
  const limit = clampLimit(p.get('limit'), DEFAULT_PAGE_SIZE, 100);
  const offset = decodeCursor(p.get('cursor'));
  const { where, binds } = sessionWhere(p);
  const order = p.get('sort') === 'session_time' ? SESSION_TIME_SQL : TOTAL_TOKENS_SQL;
  const rows = await env.DB.prepare(
    `SELECT session_id, harness, machine_id, primary_model,
            ${firstInteractionTitleCandidateSql('sessions')} AS title_candidate, title AS stored_title, started_at, cwd,
            ${SESSION_TIME_SQL} AS duration_seconds, ${TOTAL_TOKENS_SQL} AS total_tokens
     FROM sessions ${where} ORDER BY ${order} DESC, session_id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all<RecentRow>();
  const result = rows.results.slice(0, limit);
  const page = Math.floor(offset / limit) + 1;
  return {
    rows: result,
    previousCursor: offset ? encodeCursor(Math.max(0, offset - limit)) : undefined,
    nextCursor: rows.results.length > limit ? encodeCursor(offset + limit) : undefined,
    page,
    limit,
  };
}

/** Recent sessions are actively ingested, so its cursor names a row boundary rather than
 * an OFFSET into a moving list. The direction supports both Previous and Next without
 * scanning/discarding every preceding row. */
function recentBoundary(
  direction: RecentCursor['direction'],
  startedAt: string,
  sessionId: string,
  binds: string[],
): string {
  const op = direction === 'after' ? '<' : '>';
  binds.push(startedAt, startedAt, sessionId);
  const n = binds.length;
  return `(COALESCE(started_at, '') ${op} ?${n - 2} OR ` +
    `(COALESCE(started_at, '') = ?${n - 1} AND session_id ${op} ?${n}))`;
}

async function hasRecentRow(
  p: URLSearchParams,
  env: Env,
  direction: RecentCursor['direction'],
  row: RecentRow,
): Promise<boolean> {
  const { where: baseWhere, binds } = sessionWhere(p);
  const boundary = recentBoundary(direction, startedAtKey(row), row.session_id, binds);
  const where = `${baseWhere || 'WHERE'}${baseWhere ? ' AND' : ''} ${boundary}`;
  return !!await env.DB.prepare(`SELECT 1 AS found FROM sessions ${where} LIMIT 1`).bind(...binds).first();
}

function startedAtKey(row: RecentRow): string {
  return row.started_at ?? '';
}

function encodeRecentCursor(cursor: RecentCursor): string {
  const json = JSON.stringify(['recent-v1', cursor.direction, cursor.startedAt, cursor.sessionId, cursor.page]);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeRecentCursor(value: string | null): RecentCursor | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 'recent-v1') return null;
    const [, direction, startedAt, sessionId, page] = decoded;
    if (direction !== 'after' && direction !== 'before') return null;
    if (typeof startedAt !== 'string' || typeof sessionId !== 'string') return null;
    if (!Number.isSafeInteger(page) || (page as number) < 1) return null;
    return { direction, startedAt, sessionId, page: page as number };
  } catch {
    // A stale search/offset cursor, invalid base64, or hand-edited payload starts at page 1.
    return null;
  }
}

async function sessionFacets(p: URLSearchParams, env: Env): Promise<Record<string, Record<string, number>>> {
  const { where, binds } = sessionWhere(p);
  const facets: Record<string, Record<string, number>> = {};
  for (const col of Object.keys(FACET_PARAM)) {
    if (col === 'session_time') {
      facets[col] = await sessionTimeFacets(where, binds, env);
      continue;
    }
    if (col === 'session_date') {
      const prefix = where ? `${where} AND` : 'WHERE';
      const rows = await env.DB.prepare(
        `SELECT substr(started_at, 1, 10) AS v, COUNT(*) AS n FROM sessions ${prefix} started_at IS NOT NULL
         GROUP BY v ORDER BY v DESC LIMIT 20`,
      ).bind(...binds).all<{ v: string; n: number }>();
      facets[col] = Object.fromEntries(rows.results.map((r) => [r.v, r.n]));
      continue;
    }
    const prefix = where ? `${where} AND` : 'WHERE';
    const rows = await env.DB.prepare(
      `SELECT ${col} AS v, COUNT(*) AS n FROM sessions ${prefix} ${col} IS NOT NULL
       GROUP BY ${col} ORDER BY n DESC LIMIT 20`,
    ).bind(...binds).all<{ v: string; n: number }>();
    facets[col] = Object.fromEntries(rows.results.map((r) => [r.v, r.n]));
  }
  return facets;
}

async function sessionTimeFacets(where: string, binds: string[], env: Env): Promise<Record<string, number>> {
  const ranges = [
    ['under-5m', 0, 5 * 60], ['5m-30m', 5 * 60, 30 * 60],
    ['30m-2h', 30 * 60, 2 * 60 * 60], ['over-2h', 2 * 60 * 60, null],
  ] as const;
  const out: Record<string, number> = {};
  for (const [key, min, max] of ranges) {
    const prefix = where ? `${where} AND` : 'WHERE';
    const upper = max === null ? '' : ` AND ${SESSION_TIME_SQL} < ?${binds.length + 2}`;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions ${prefix} ${SESSION_TIME_SQL} >= ?${binds.length + 1}${upper}`,
    ).bind(...binds, min, ...(max === null ? [] : [max])).first<{ n: number }>();
    if (row?.n) out[key] = row.n;
  }
  return out;
}

function sessionWhere(p: URLSearchParams): { where: string; binds: string[] } {
  const clauses: string[] = [];
  const binds: string[] = [];
  const add = (clause: string, value: string) => {
    binds.push(value);
    clauses.push(clause.replace('?', `?${binds.length}`));
  };
  for (const f of SESSION_FILTERS) {
    const value = p.get(f.param);
    if (value) add(`${f.col} = ?`, value);
  }
  const from = p.get('from');
  if (from) add('started_at >= ?', from);
  const to = p.get('to');
  if (to) add('started_at <= ?', normalizeToBound(to));
  const sessionDate = p.get('session_date');
  if (sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    add('started_at >= ?', sessionDate);
    add("started_at < date(?, '+1 day')", sessionDate);
  }
  const sessionTime = p.get('session_time');
  if (sessionTime === 'under-5m') { add(`${SESSION_TIME_SQL} >= ?`, '0'); add(`${SESSION_TIME_SQL} < ?`, String(5 * 60)); }
  if (sessionTime === '5m-30m') { add(`${SESSION_TIME_SQL} >= ?`, String(5 * 60)); add(`${SESSION_TIME_SQL} < ?`, String(30 * 60)); }
  if (sessionTime === '30m-2h') { add(`${SESSION_TIME_SQL} >= ?`, String(30 * 60)); add(`${SESSION_TIME_SQL} < ?`, String(2 * 60 * 60)); }
  if (sessionTime === 'over-2h') add(`${SESSION_TIME_SQL} >= ?`, String(2 * 60 * 60));
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

function renderHit(h: SearchHit): string {
  const s = h.session;
  const title = sessionDisplayTitle(null, s.title, h.session_id);
  const meta = [
    `<span class="badge">${esc(s.harness)}</span>`,
    s.machine_id ? `<span class="chip">${esc(s.machine_id)}</span>` : '',
    s.primary_model ? `<span class="chip">${esc(s.primary_model)}</span>` : '',
    s.started_at ? `<span class="muted small">${esc(s.started_at)}</span>` : '',
    formatSessionTime(s.duration_seconds),
    s.total_tokens ? `<span class="muted small">${fmtTokens(s.total_tokens)} tokens</span>` : '',
    s.index_state !== 'ready' ? `<span class="badge" style="color:var(--err)">${esc(s.index_state)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  // Deep-link to the page (turn_index bucket) that holds the matching turn, anchored at that turn.
  const hitPage = Math.floor(h.block.turn_index / TURNS_PER_PAGE) + 1;
  const href = `/s/${q(h.session_id)}?page=${hitPage}#t${h.block.turn_index}`;
  return `<div class="hit">` +
    `<div class="title"><a href="${esc(href)}">${esc(title)}</a></div>` +
    `<div class="snip">${sanitizeSnippet(h.snippet)}</div>` +
    `<div class="meta">${meta}</div>` +
    `</div>`;
}

function renderRecent(r: RecentRow): string {
  const title = sessionDisplayTitle(r.title_candidate, r.stored_title, r.session_id);
  const meta = [
    `<span class="badge">${esc(r.harness)}</span>`,
    r.machine_id ? `<span class="chip">${esc(r.machine_id)}</span>` : '',
    r.primary_model ? `<span class="chip">${esc(r.primary_model)}</span>` : '',
    r.cwd ? `<span class="muted small">${esc(r.cwd)}</span>` : '',
    r.started_at ? `<span class="muted small">${esc(r.started_at)}</span>` : '',
    formatSessionTime(r.duration_seconds),
    r.total_tokens ? `<span class="muted small">${fmtTokens(r.total_tokens)} tokens</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `<div class="hit"><div class="title"><a href="/s/${q(r.session_id)}">${esc(title)}</a></div>` +
    `<div class="meta">${meta}</div></div>`;
}

function formatSessionTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `<span class="muted small">${Math.round(seconds)}s</span>`;
  if (seconds < 3600) return `<span class="muted small">${Math.round(seconds / 60)}m</span>`;
  return `<span class="muted small">${(seconds / 3600).toFixed(seconds < 10 * 3600 ? 1 : 0)}h</span>`;
}

function fmtTokens(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** The FTS snippet() output contains our literal <mark>…</mark> markers around otherwise-escaped text. */
function sanitizeSnippet(snip: string): string {
  return esc(snip).replaceAll('&lt;mark&gt;', '<mark>').replaceAll('&lt;/mark&gt;', '</mark>');
}

function renderFacets(url: URL, facets: Record<string, Record<string, number>> | undefined, active: Record<string, string>): string {
  if (!facets) return '';
  const groups = Object.entries(facets)
    .filter(([, values]) => Object.keys(values).length > 0)
    .map(([col, values]) => {
      const param = FACET_PARAM[col] ?? col;
      const items = Object.entries(values)
        .map(([value, n]) => {
          const isActive = active[param] === value;
          const target = new URL(url);
          if (isActive) target.searchParams.delete(param);
          else target.searchParams.set(param, value);
          target.searchParams.delete('cursor');
          const href = `${target.pathname}${target.search}`;
          return `<li class="${isActive ? 'active' : ''}">` +
            `<a href="${esc(href)}">${isActive ? '✓ ' : ''}${esc(col === 'session_time' ? (SESSION_TIME_FACETS[value] ?? value) : value)}</a>` +
            `<span class="n">${n}</span></li>`;
        })
        .join('');
      return `<h3>${esc(FACET_LABEL[col] ?? col)}</h3><ul>${items}</ul>`;
    })
    .join('');
  return groups || '<p class="muted small">No facets.</p>';
}

function searchPager(url: URL, cursor: string | undefined, offset: number, limit: number): string {
  if (!cursor && offset === 0) return '';
  const previous = new URL(url);
  const previousOffset = Math.max(0, offset - limit);
  if (previousOffset) previous.searchParams.set('cursor', encodeCursor(previousOffset));
  else previous.searchParams.delete('cursor');
  const previousLink = offset > 0
    ? `<a rel="prev" href="${esc(previous.pathname + previous.search)}">← Previous</a>`
    : `<span class="muted">← Previous</span>`;

  const next = new URL(url);
  if (cursor) next.searchParams.set('cursor', cursor);
  const nextLink = cursor
    ? `<a rel="next" href="${esc(next.pathname + next.search)}">Next →</a>`
    : `<span class="muted">Next →</span>`;
  const currentPage = Math.floor(offset / limit) + 1;
  return `<nav class="pager" aria-label="Search result pages">${previousLink}` +
    `<span class="small">Page ${currentPage}</span>${nextLink}</nav>`;
}

function recentPager(
  url: URL,
  previousCursor: string | undefined,
  nextCursor: string | undefined,
  currentPage: number,
): string {
  if (!previousCursor && !nextCursor) return '';
  const previous = new URL(url);
  if (previousCursor) previous.searchParams.set('cursor', previousCursor);
  const previousLink = previousCursor
    ? `<a rel="prev" href="${esc(previous.pathname + previous.search)}">← Previous</a>`
    : `<span class="muted">← Previous</span>`;

  const next = new URL(url);
  if (nextCursor) next.searchParams.set('cursor', nextCursor);
  const nextLink = nextCursor
    ? `<a rel="next" href="${esc(next.pathname + next.search)}">Next →</a>`
    : `<span class="muted">Next →</span>`;
  return `<nav class="pager" aria-label="Recent session pages">${previousLink}` +
    `<span class="small">Page ${currentPage}</span>${nextLink}</nav>`;
}
