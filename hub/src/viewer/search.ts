import { DEFAULT_RESULT_PAGE_SIZE, runSearch, type SearchHit } from '../api/search';
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
  subagentSessionSql,
  SUBTREE_COST_ALIAS,
  totalTokensSql,
} from '../session-filters';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';
import { sessionDisplayTitle } from '../session-title';
import { sessionSubtreeCosts, subtreeCostCte, type SubtreeCost } from '../session-cost';
import { costCoverage, costLabel, fmtInt, fmtUsd } from './format';

const SORT_OPTIONS = [
  ['recent', 'Recent'],
  ['session_time', 'Session time'],
  ['total_tokens', 'Total tokens'],
  ['cost', 'Total cost'],
] as const;

/** Every sort but `recent` pages by OFFSET — see `sortedRecentSessions`. */
const OFFSET_SORTS: Record<string, true> = { session_time: true, total_tokens: true, cost: true };

/** The columns every recent-list query selects, so the three shapes of that query cannot drift
 * apart. Cost is absent on purpose: it is a rollup over descendants, fetched for the rendered page
 * by `sessionSubtreeCosts` rather than read off the row. `session_id` is qualified because the cost
 * sort joins a CTE that exposes a column of the same name. */
const RECENT_COLUMNS = `sessions.session_id AS session_id, harness, machine_id, primary_model,
          ${subagentSessionSql('sessions')} AS subagent,
          first_interaction_title, title AS stored_title, started_at, cwd,
          ${sessionDurationSql('sessions')} AS duration_seconds`;
interface RecentRow {
  session_id: string;
  harness: string;
  machine_id: string | null;
  primary_model: string | null;
  first_interaction_title: string | null;
  stored_title: string | null;
  started_at: string | null;
  cwd: string | null;
  duration_seconds: number | null;
  subagent: 'no' | 'yes';
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
    const costs = await sessionSubtreeCosts(env.DB, recent.rows.map((row) => row.session_id));
    const list = recent.rows.length
      ? recent.rows.map((row) => renderRecent(row, costs.get(row.session_id))).join('')
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
  const limit = clampLimit(p.get('limit'), DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE);
  const costs = await sessionSubtreeCosts(env.DB, result.hits.map((h) => h.session_id));
  const hits = result.hits.map((h) => renderHit(h, costs.get(h.session_id))).join('');
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
  if (OFFSET_SORTS[p.get('sort') ?? '']) return sortedRecentSessions(p, env);
  const limit = clampLimit(p.get('limit'), DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE);
  const cursor = decodeRecentCursor(p.get('cursor'));
  const page = cursor?.page ?? 1;
  const { clause, costClause, binds } = sessionWhere(p);
  const boundary = cursor ? recentBoundary(cursor.direction, cursor.startedAt, cursor.sessionId, binds) : '';
  const reverse = cursor?.direction === 'before';
  const direction = reverse ? 'ASC' : 'DESC';
  // A cost band is the one filter the session row cannot answer, so this page joins the rollup
  // when (and only when) one is selected.
  const result = await env.DB.prepare(
    `${costClause ? costRollupPrefix(clause) : ''}
     SELECT ${RECENT_COLUMNS}
     FROM sessions ${costClause ? costRollupJoin() : ''} ${whereOf(clause, boundary, costClause)}
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
  const limit = clampLimit(p.get('limit'), DEFAULT_RESULT_PAGE_SIZE, DEFAULT_RESULT_PAGE_SIZE);
  const offset = decodeCursor(p.get('cursor'));
  const { clause, costClause, binds } = sessionWhere(p);
  const rows = await env.DB.prepare(sortedRecentSql(p.get('sort'), clause, costClause, limit, offset))
    .bind(...binds)
    .all<RecentRow>();
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

/** The offset-paginated page of one non-default sort.
 *
 * Cost is the odd one out: it orders by the SUBAGENT-INCLUSIVE figure, which no column holds, so
 * the ordering has to happen in SQL over every session the filter matches — a rollup computed in
 * JS could only ever order the rows already on the page. The chip the page renders comes from
 * `sessionSubtreeCosts` instead, because display needs nothing beyond the page; both sides expand
 * the same `subtreeCostCte` definition, so the order and the number shown cannot disagree.
 *
 * The CTE's roots carry the page's row filters, so the outer query's WHERE holds the selected
 * cost band and nothing else, and the caller's binds stay single-use.
 *
 * `(c.usd IS NULL) ASC` first: an unpriced subtree has no known cost, and sorting it as if it
 * were free would put every session we cannot price at the cheap end of "total cost".
 */
function sortedRecentSql(
  sort: string | null,
  clause: string,
  costClause: string,
  limit: number,
  offset: number,
): string {
  const paged = `LIMIT ${limit + 1} OFFSET ${offset}`;
  if (sort === 'cost') {
    return `${costRollupPrefix(clause)}
     SELECT ${RECENT_COLUMNS}
     FROM sessions ${costRollupJoin()} ${whereOf(costClause)}
     ORDER BY (${SUBTREE_COST_ALIAS}.usd IS NULL) ASC, ${SUBTREE_COST_ALIAS}.usd DESC, sessions.session_id DESC ${paged}`;
  }
  const order = sort === 'session_time' ? sessionDurationSql('sessions') : totalTokensSql('sessions');
  // Every other sort reads the session row, and only joins the rollup when a band is selected.
  return `${costClause ? costRollupPrefix(clause) : ''}
     SELECT ${RECENT_COLUMNS} FROM sessions ${costClause ? costRollupJoin() : ''}
     ${whereOf(clause, costClause)} ORDER BY ${order} DESC, session_id DESC ${paged}`;
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
  const { clause, costClause, binds } = sessionWhere(p);
  const boundary = recentBoundary(direction, startedAtKey(row), row.session_id, binds);
  // The probe decides whether a Previous/Next link exists, so it has to apply the same cost band
  // the page does — otherwise a filtered-out neighbour offers a page with nothing on it.
  const sql = `${costClause ? costRollupPrefix(clause) : ''}
     SELECT 1 AS found FROM sessions ${costClause ? costRollupJoin() : ''}
     ${whereOf(clause, boundary, costClause)} LIMIT 1`;
  return !!await env.DB.prepare(sql).bind(...binds).first();
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
    // The cost facet counts sessions by a figure only the rollup knows, and every other facet has
    // to respect a cost band the caller already selected, so either reason joins it. The join is
    // one row per root, so it cannot change a count on its own.
    const rollup = definition.kind === 'cost' || filter.costClause !== '';
    const where = [filter.clause, filter.costClause, `${expression} IS NOT NULL`].filter(Boolean).join(' AND ');
    return env.DB.prepare(
      `${rollup ? costRollupPrefix(filter.clause) : ''}
       SELECT ${expression} AS v, COUNT(*) AS n FROM sessions ${rollup ? costRollupJoin() : ''}
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

/** The session-row conditions, the cost-band conditions and their shared binds.
 *
 * Two clauses rather than one because the cost band reads the rollup CTE, whose roots are the
 * sessions the row conditions match — see `SessionFilterSql.costClause`. */
function sessionWhere(p: URLSearchParams): { clause: string; costClause: string; binds: string[] } {
  const filter = buildSessionFilterSql(p, 'sessions');
  return { clause: filter.clause, costClause: filter.costClause, binds: filter.binds };
}

/** `WITH RECURSIVE` prefix for the rollup, or nothing when no query needs it.
 *
 * Roots are the sessions matching every NON-cost condition: a band filters the rollup's output,
 * so making it a root condition would define the rollup in terms of itself. */
function costRollupPrefix(clause: string): string {
  return `WITH RECURSIVE ${subtreeCostCte(`SELECT session_id FROM sessions${clause ? ` WHERE ${clause}` : ''}`)} `;
}

function costRollupJoin(): string {
  return `JOIN session_subtree_cost ${SUBTREE_COST_ALIAS} ON ${SUBTREE_COST_ALIAS}.session_id = sessions.session_id`;
}

function whereOf(...clauses: string[]): string {
  const parts = clauses.filter(Boolean);
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

function renderHit(h: SearchHit, cost: SubtreeCost | undefined): string {
  const s = h.session;
  const title = sessionDisplayTitle(null, s.title, h.session_id, s.harness);
  const meta = [
    `<span class="badge">${esc(s.harness)}</span>`,
    s.subagent === 'yes' ? `<span class="badge">Subagent session</span>` : '',
    s.machine_id ? `<span class="chip">${esc(s.machine_id)}</span>` : '',
    s.primary_model ? `<span class="chip">${esc(s.primary_model)}</span>` : '',
    s.started_at ? `<span class="muted small">${esc(s.started_at)}</span>` : '',
    formatSessionTime(s.duration_seconds),
    costChip(cost),
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

function renderRecent(r: RecentRow, cost: SubtreeCost | undefined): string {
  const title = sessionDisplayTitle(r.first_interaction_title, r.stored_title, r.session_id, r.harness);
  const meta = [
    `<span class="badge">${esc(r.harness)}</span>`,
    r.subagent === 'yes' ? `<span class="badge">Subagent session</span>` : '',
    r.machine_id ? `<span class="chip">${esc(r.machine_id)}</span>` : '',
    r.primary_model ? `<span class="chip">${esc(r.primary_model)}</span>` : '',
    r.cwd ? `<span class="muted small">${esc(r.cwd)}</span>` : '',
    r.started_at ? `<span class="muted small">${esc(r.started_at)}</span>` : '',
    formatSessionTime(r.duration_seconds),
    costChip(cost),
  ]
    .filter(Boolean)
    .join('');
  return `<div class="hit"><div class="title"><a href="/s/${q(r.session_id)}">${esc(title)}</a></div>` +
    `<div class="meta">${meta}</div></div>`;
}

/** What the session cost, its subagent descendants included.
 *
 * No chip at all when the session has no usage records: a session that reported no model calls
 * makes no claim about what it cost, and an empty figure would read as one. `cost unknown` rather
 * than `knownCost`'s bare `—` because among a row of chips a dash reads as a missing field; either
 * way it is never `$0.00`, which would assert the session was free.
 *
 * Just the figure in a list row: the coverage caveat and the subagent count are qualifiers on a
 * number nobody reads a list for, and they crowd out the fields a row is scanned by. Both stay in
 * the chip's tooltip, and the session page states them in full. */
function costChip(cost: SubtreeCost | undefined): string {
  if (!cost) return '';
  const label = costLabel(cost);
  if (label.state === 'none') return '';
  const subagents = cost.subagentSessions;
  const noun = subagents === 1 ? 'subagent' : 'subagents';
  const text = label.state === 'unknown' || cost.usd === null ? 'cost unknown' : fmtUsd(cost.usd);
  const coverage = costCoverage(cost.pricedCalls, cost.calls);
  const detail = subagents > 0 ? `${coverage}, including ${fmtInt(subagents)} ${noun}` : coverage;
  return `<span class="muted small" title="${esc(detail)}">${esc(text)}</span>`;
}

function formatSessionTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `<span class="muted small">${Math.round(seconds)}s</span>`;
  if (seconds < 3600) return `<span class="muted small">${Math.round(seconds / 60)}m</span>`;
  return `<span class="muted small">${(seconds / 3600).toFixed(seconds < 10 * 3600 ? 1 : 0)}h</span>`;
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

const INITIAL_FACET_VALUE_LIMIT = 10;

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
      const entries = Object.entries(values);
      // Keep every active value actionable without expanding the disclosure. They displace the
      // lowest-ranked inactive options when they would otherwise fall beyond the cutoff.
      const activeEntries = entries.filter(([value]) => selectedValuesForFacet.includes(value));
      const inactiveEntries = entries.filter(([value]) => !selectedValuesForFacet.includes(value));
      const initiallyVisible = [
        ...activeEntries,
        ...inactiveEntries.slice(0, Math.max(0, INITIAL_FACET_VALUE_LIMIT - activeEntries.length)),
      ];
      const initiallyVisibleValues = new Set(initiallyVisible.map(([value]) => value));
      const renderItem = ([value, n]: [string, number]) => {
        const isActive = selectedValuesForFacet.includes(value);
        const target = new URL(url);
        canonicalizeMultiValueFilters(target.searchParams);
        target.searchParams.delete(definition.param);
        const nextValues = definition.param === 'subagent'
          ? (isActive ? [] : [value])
          : (isActive
            ? selectedValuesForFacet.filter((selectedValue) => selectedValue !== value)
            : [...selectedValuesForFacet, value].slice(0, MAX_VALUES_PER_FILTER));
        for (const nextValue of nextValues) target.searchParams.append(definition.param, nextValue);
        target.searchParams.delete('cursor');
        const href = `${target.pathname}${target.search}`;
        return `<li class="${isActive ? 'active' : ''}">` +
          `<a href="${esc(href)}">${isActive ? '✓ ' : ''}${esc(facetLabelValue(definition, value))}</a>` +
          `<span class="n">${n}</span></li>`;
      };
      const remaining = entries.filter(([value]) => !initiallyVisibleValues.has(value));
      const more = remaining.length
        ? `<details class="facet-more"><summary>Add more (${remaining.length})</summary><ul>${remaining.map(renderItem).join('')}</ul></details>`
        : '';
      return `<h3>${esc(definition.label ?? definition.key)}</h3>` +
        `<ul>${initiallyVisible.map(renderItem).join('')}</ul>${more}`;
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
