import { runSearch, type SearchHit } from '../api/search';
import { clampLimit, decodeCursor, encodeCursor } from '../api/sessions';
import {
  buildSessionFilterSql,
  canonicalSessionFilterEntries,
  canonicalizeMultiValueFilters,
  FACET_DEFINITIONS,
  facetExpressionSql,
  facetLabelValue,
  facetOrderSql,
  hasSessionFilters,
  MAX_VALUES_PER_FILTER,
  mergeFacetCounts,
  selectedFacetValues,
  selectedValues,
  sessionDurationSql,
  totalTokensSql,
} from '../session-filters';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';
import { firstInteractionTitleCandidateSql, sessionDisplayTitle } from '../session-title';

const DEFAULT_PAGE_SIZE = 20;

const SORT_OPTIONS = [
  ['recent', 'Recent'],
  ['session_time', 'Session time'],
  ['total_tokens', 'Total tokens'],
] as const;
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
  const searchForm = renderSearchForm(query, p);

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
      renderSidebar(url, query, facets),
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
    renderSidebar(url, query, result.facets),
    `${summary}${list}${searchPager(url, result.cursor, offset, limit)}`,
  );
  return page({ title: `${query} — sessions`, nav: 'search', body });
}

function renderSearchForm(query: string, params: URLSearchParams): string {
  const preserved = [
    ...canonicalSessionFilterEntries(params),
    ...preservedControlEntries(params, ['sort', 'limit']),
  ];
  return `<form class="search" method="get" action="/">` +
    `<input type="search" name="q" value="${esc(query)}" placeholder="Full-text search across sessions…" autofocus>` +
    hiddenInputs(preserved) +
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
  facets: Record<string, Record<string, number>> | undefined,
): string {
  const params = url.searchParams;
  const sort = params.get('sort') ?? 'recent';
  const sortOptions = SORT_OPTIONS.map(([value, label]) =>
    // Full-text searches use FTS relevance unless an explicit non-default sort is selected.
    value === 'recent' && query ? [value, 'Relevance'] : [value, label],
  ).map(([value, label]) =>
    `<option value="${value}"${sort === value ? ' selected' : ''}>${label}</option>`,
  ).join('');
  const controls = `<form class="facet-controls" method="get" action="/">` +
    hiddenInputs([
      ['q', query],
      ...canonicalSessionFilterEntries(params),
      ...preservedControlEntries(params, ['limit']),
    ]) +
    `<label><span>Sort by</span><select name="sort" aria-label="Sort sessions" onchange="this.form.requestSubmit()">${sortOptions}</select></label>` +
    `<noscript><button type="submit">Apply filters</button></noscript>` +
    `</form>`;
  const clear = hasSessionFilters(params)
    ? `<form class="clear-facets" method="get" action="/">` +
      hiddenInputs([
        ['q', query],
        ...preservedControlEntries(params, ['sort', 'limit']),
      ]) +
      `<button type="submit">Clear facets</button></form>`
    : '';
  return controls + clear + renderFacets(url, facets, selectedFacetValues(params));
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
            ${sessionDurationSql('sessions')} AS duration_seconds, ${totalTokensSql('sessions')} AS total_tokens
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
  const order = p.get('sort') === 'session_time' ? sessionDurationSql('sessions') : totalTokensSql('sessions');
  const rows = await env.DB.prepare(
    `SELECT session_id, harness, machine_id, primary_model,
            ${firstInteractionTitleCandidateSql('sessions')} AS title_candidate, title AS stored_title, started_at, cwd,
            ${sessionDurationSql('sessions')} AS duration_seconds, ${totalTokensSql('sessions')} AS total_tokens
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
  const facets: Record<string, Record<string, number>> = {};
  const statements = FACET_DEFINITIONS.map((definition) => {
    const filter = buildSessionFilterSql(p, 'sessions', 1, definition.key);
    const expression = facetExpressionSql(definition, 'sessions');
    const where = [filter.clause, `${expression} IS NOT NULL`].filter(Boolean).join(' AND ');
    return env.DB.prepare(
      `SELECT ${expression} AS v, COUNT(*) AS n FROM sessions
       WHERE ${where} GROUP BY v ORDER BY ${facetOrderSql(definition)} LIMIT ${definition.valueLimit ?? 20}`,
    ).bind(...filter.binds);
  });
  const results = await env.DB.batch<{ v: string; n: number }>(statements);
  for (let index = 0; index < FACET_DEFINITIONS.length; index++) {
    const definition = FACET_DEFINITIONS[index]!;
    facets[definition.key] = mergeFacetCounts(
      results[index]!.results,
      selectedValues(p, definition),
    );
  }
  return facets;
}

function sessionWhere(p: URLSearchParams): { where: string; binds: string[] } {
  const filter = buildSessionFilterSql(p, 'sessions');
  return { where: filter.clause ? `WHERE ${filter.clause}` : '', binds: filter.binds };
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

function hiddenInputs(entries: Array<[string, string]>): string {
  return entries
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('');
}

function preservedControlEntries(params: URLSearchParams, names: string[]): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const name of names) {
    const value = params.get(name);
    if (value) entries.push([name, value]);
  }
  return entries;
}

/** The FTS snippet() output contains our literal <mark>…</mark> markers around otherwise-escaped text. */
function sanitizeSnippet(snip: string): string {
  return esc(snip).replaceAll('&lt;mark&gt;', '<mark>').replaceAll('&lt;/mark&gt;', '</mark>');
}

function renderFacets(
  url: URL,
  facets: Record<string, Record<string, number>> | undefined,
  selected: Record<string, string[]>,
): string {
  if (!facets) return '';
  const groups = FACET_DEFINITIONS
    .filter((definition) => Object.keys(facets[definition.key] ?? {}).length > 0)
    .map((definition) => {
      const values = facets[definition.key] ?? {};
      const selectedValuesForFacet = selected[definition.key] ?? [];
      const items = Object.entries(values)
        .map(([value, n]) => {
          const isActive = selectedValuesForFacet.includes(value);
          const target = new URL(url);
          canonicalizeMultiValueFilters(target.searchParams);
          target.searchParams.delete(definition.param);
          const nextValues = isActive
            ? selectedValuesForFacet.filter((selectedValue) => selectedValue !== value)
            : [...selectedValuesForFacet, value].slice(0, MAX_VALUES_PER_FILTER);
          for (const nextValue of nextValues) target.searchParams.append(definition.param, nextValue);
          target.searchParams.delete('cursor');
          const href = `${target.pathname}${target.search}`;
          return `<li class="${isActive ? 'active' : ''}">` +
            `<a href="${esc(href)}">${isActive ? '✓ ' : ''}${esc(facetLabelValue(definition, value))}</a>` +
            `<span class="n">${n}</span></li>`;
        })
        .join('');
      return `<h3>${esc(definition.label ?? definition.key)}</h3><ul>${items}</ul>`;
    })
    .join('');
  return groups || '<p class="muted small">No facets.</p>';
}

function searchPager(url: URL, cursor: string | undefined, offset: number, limit: number): string {
  if (!cursor && offset === 0) return '';
  const previous = new URL(url);
  canonicalizeMultiValueFilters(previous.searchParams);
  const previousOffset = Math.max(0, offset - limit);
  if (previousOffset) previous.searchParams.set('cursor', encodeCursor(previousOffset));
  else previous.searchParams.delete('cursor');
  const previousLink = offset > 0
    ? `<a rel="prev" href="${esc(previous.pathname + previous.search)}">← Previous</a>`
    : `<span class="muted">← Previous</span>`;

  const next = new URL(url);
  canonicalizeMultiValueFilters(next.searchParams);
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
  canonicalizeMultiValueFilters(previous.searchParams);
  if (previousCursor) previous.searchParams.set('cursor', previousCursor);
  const previousLink = previousCursor
    ? `<a rel="prev" href="${esc(previous.pathname + previous.search)}">← Previous</a>`
    : `<span class="muted">← Previous</span>`;

  const next = new URL(url);
  canonicalizeMultiValueFilters(next.searchParams);
  if (nextCursor) next.searchParams.set('cursor', nextCursor);
  const nextLink = nextCursor
    ? `<a rel="next" href="${esc(next.pathname + next.search)}">Next →</a>`
    : `<span class="muted">Next →</span>`;
  return `<nav class="pager" aria-label="Recent session pages">${previousLink}` +
    `<span class="small">Page ${currentPage}</span>${nextLink}</nav>`;
}
