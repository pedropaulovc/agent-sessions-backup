import { runSearch, type SearchHit } from '../api/search';
import { esc, page, q } from './layout';
import { TURNS_PER_PAGE } from './session';

const FILTERS = [
  { param: 'harness', col: 'harness', label: 'Harness' },
  { param: 'machine', col: 'machine_id', label: 'Machine' },
  { param: 'os', col: 'os', label: 'OS' },
  { param: 'model', col: 'primary_model', label: 'Model' },
] as const;

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

/** GET / — search box, filters, results (or recent sessions when the query is empty) and a faceted sidebar. */
export async function searchPage(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const query = p.get('q')?.trim() ?? '';
  const active: Record<string, string> = {};
  for (const f of FILTERS) if (p.get(f.param)) active[f.param] = p.get(f.param)!;

  const options = await filterOptions(env);
  const form = renderForm(query, active, options);

  if (!query) {
    const recent = await env.DB.prepare(
      `SELECT session_id, harness, machine_id, primary_model, title, started_at, cwd
       FROM sessions ORDER BY started_at DESC LIMIT 50`,
    ).all<RecentRow>();
    const list = recent.results.length
      ? recent.results.map(renderRecent).join('')
      : `<p class="muted">No sessions indexed yet.</p>`;
    return page({
      title: 'Search — sessions',
      nav: 'search',
      body: `${form}<h3 class="muted small">Recent sessions</h3>${list}`,
    });
  }

  const result = await runSearch(url, env, { facets: true });
  const hits = result.hits.map(renderHit).join('');
  const body = `${form}<div class="row">` +
    `<div class="content">` +
    (result.hits.length
      ? `<p class="muted small">${result.hits.length} result${result.hits.length === 1 ? '' : 's'}${result.cursor ? '+' : ''} for “${esc(query)}”</p>${hits}` +
        pager(url, result.cursor)
      : `<p class="muted">No matches for “${esc(query)}”.</p>`) +
    `</div>` +
    `<aside class="sidebar facets">${renderFacets(url, result.facets, active)}</aside>` +
    `</div>`;
  return page({ title: `${query} — sessions`, nav: 'search', body });
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

function renderForm(query: string, active: Record<string, string>, options: Record<string, string[]>): string {
  const selects = FILTERS.map((f) => {
    const opts = [`<option value="">${f.label}: all</option>`]
      .concat(
        (options[f.param] ?? []).map(
          (v) => `<option value="${esc(v)}"${active[f.param] === v ? ' selected' : ''}>${esc(v)}</option>`,
        ),
      )
      .join('');
    return `<select name="${f.param}">${opts}</select>`;
  }).join('');
  return `<form class="search" method="get" action="/">` +
    `<input type="search" name="q" value="${esc(query)}" placeholder="Full-text search across sessions…" autofocus>` +
    selects +
    `<button type="submit">Search</button></form>`;
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

function pager(url: URL, cursor?: string): string {
  if (!cursor) return '';
  const next = new URL(url);
  next.searchParams.set('cursor', cursor);
  return `<div class="pager"><a href="${esc(next.pathname + next.search)}">Next page →</a></div>`;
}
