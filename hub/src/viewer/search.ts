import { runSearch, type SearchHit } from '../api/search';
import { clampLimit, decodeCursor, encodeCursor, normalizeToBound } from '../api/sessions';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';

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

// Facet column name (as returned by runSearch) → query param the viewer filters on.
const FACET_PARAM: Record<string, string> = {
  harness: 'harness',
  machine_id: 'machine',
  os: 'os',
  primary_model: 'model',
  repo_url: 'repo',
};
const FACET_LABEL: Record<string, string> = {
  harness: 'Harness',
  machine_id: 'Machine',
  os: 'OS',
  primary_model: 'Model',
  repo_url: 'Repo',
};

interface RecentRow {
  session_id: string;
  harness: string;
  machine_id: string | null;
  primary_model: string | null;
  title: string | null;
  started_at: string | null;
  cwd: string | null;
}

interface RecentResult {
  rows: RecentRow[];
  cursor?: string;
  offset: number;
  limit: number;
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
    const summary = recent.rows.length
      ? `<p class="muted small">Showing ${recent.offset + 1}–${recent.offset + recent.rows.length} recent sessions</p>`
      : '';
    const body = searchForm + renderSearchLayout(
      renderSidebar(url, query, active, options, facets),
      `<h3 class="muted small">Recent sessions</h3>${summary}${list}${pager(url, recent.cursor, recent.offset, recent.limit)}`,
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
    `${summary}${list}${pager(url, result.cursor, offset, limit)}`,
  );
  return page({ title: `${query} — sessions`, nav: 'search', body });
}

function activeFilters(p: URLSearchParams): Record<string, string> {
  const active: Record<string, string> = {};
  const params = new Set<string>([
    ...SESSION_FILTERS.map((f) => f.param),
    ...DATE_FILTERS,
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
    .filter(([name]) => !FILTERS.some((f) => f.param === name))
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
  const clear = new URL(url);
  clear.search = '';
  if (query) clear.searchParams.set('q', query);
  const controls = `<form class="facet-controls" method="get" action="/">` +
    `<input type="hidden" name="q" value="${esc(query)}">${preserved}` +
    `<div class="facet-selects">${selects}</div>` +
    `<noscript><button type="submit">Apply filters</button></noscript>` +
    (Object.keys(active).length ? `<a class="clear-filters small" href="${esc(clear.pathname + clear.search)}">Clear filters</a>` : '') +
    `</form>`;
  return controls + renderFacets(url, facets, active);
}

async function recentSessions(p: URLSearchParams, env: Env): Promise<RecentResult> {
  const limit = clampLimit(p.get('limit'), DEFAULT_PAGE_SIZE, 100);
  const offset = decodeCursor(p.get('cursor'));
  const { where, binds } = sessionWhere(p);
  const result = await env.DB.prepare(
    `SELECT session_id, harness, machine_id, primary_model, title, started_at, cwd
     FROM sessions ${where} ORDER BY started_at DESC, session_id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
  ).bind(...binds).all<RecentRow>();
  return {
    rows: result.results.slice(0, limit),
    cursor: result.results.length > limit ? encodeCursor(offset + limit) : undefined,
    offset,
    limit,
  };
}

async function sessionFacets(p: URLSearchParams, env: Env): Promise<Record<string, Record<string, number>>> {
  const { where, binds } = sessionWhere(p);
  const facets: Record<string, Record<string, number>> = {};
  for (const col of Object.keys(FACET_PARAM)) {
    const prefix = where ? `${where} AND` : 'WHERE';
    const rows = await env.DB.prepare(
      `SELECT ${col} AS v, COUNT(*) AS n FROM sessions ${prefix} ${col} IS NOT NULL
       GROUP BY ${col} ORDER BY n DESC LIMIT 20`,
    ).bind(...binds).all<{ v: string; n: number }>();
    facets[col] = Object.fromEntries(rows.results.map((r) => [r.v, r.n]));
  }
  return facets;
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
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

function renderHit(h: SearchHit): string {
  const s = h.session;
  const title = s.title || h.session_id;
  const meta = [
    `<span class="badge">${esc(s.harness)}</span>`,
    s.machine_id ? `<span class="chip">${esc(s.machine_id)}</span>` : '',
    s.primary_model ? `<span class="chip">${esc(s.primary_model)}</span>` : '',
    s.started_at ? `<span class="muted small">${esc(s.started_at)}</span>` : '',
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
  const title = r.title || r.session_id;
  const meta = [
    `<span class="badge">${esc(r.harness)}</span>`,
    r.machine_id ? `<span class="chip">${esc(r.machine_id)}</span>` : '',
    r.primary_model ? `<span class="chip">${esc(r.primary_model)}</span>` : '',
    r.cwd ? `<span class="muted small">${esc(r.cwd)}</span>` : '',
    r.started_at ? `<span class="muted small">${esc(r.started_at)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');
  return `<div class="hit"><div class="title"><a href="/s/${q(r.session_id)}">${esc(title)}</a></div>` +
    `<div class="meta">${meta}</div></div>`;
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
            `<a href="${esc(href)}">${isActive ? '✓ ' : ''}${esc(value)}</a>` +
            `<span class="n">${n}</span></li>`;
        })
        .join('');
      return `<h3>${esc(FACET_LABEL[col] ?? col)}</h3><ul>${items}</ul>`;
    })
    .join('');
  return groups || '<p class="muted small">No facets.</p>';
}

function pager(url: URL, cursor: string | undefined, offset: number, limit: number): string {
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
