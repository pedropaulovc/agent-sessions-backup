/** GET /stats — the statistics page.
 *
 * Rendering only: every number arrives from src/stats.ts. Charts are inline SVG and CSS bars.
 * Native links and disclosures work without scripts; a small enhancement opens an analytic
 * disclosure when following a bookmarked panel anchor.
 */
import {
  ATTRIBUTIONS,
  collectStats,
  RANGES,
  UNBUILT,
  type Attribution,
  type Range,
  type Stats,
  type StatsQuery,
} from '../stats';
import { esc, page, q } from './layout';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function statsPage(url: URL, env: Env): Promise<Response> {
  const query = parseQuery(url);
  const stats = await collectStats(env.DB, query, new Date());
  const body =
    `<div class="stats-page"><h2>Statistics</h2>` +
    subhead(stats, query) +
    controls(url, query) +
    overview(stats) +
    rankingControls(url, query) +
    modelsPanel(stats, url) +
    outliersPanel(stats) +
    wastePanel(stats) +
    `<details class="stats-analysis"><summary>Cost and context analysis</summary>` +
    `<nav class="stats-panel-links" aria-label="Analysis panels">` +
    `<a href="#ledger">Cost</a><a href="#shape">Depth</a><a href="#classes">Token classes</a>` +
    `<a href="#cache">Turn gaps</a><a href="#attribution">Attribution</a><a href="#rhythm">Rhythm</a></nav>` +
    ledgerPanel(stats) +
    depthPanel(stats) +
    classesPanel(stats) +
    gapsPanel(stats) +
    attributionPanel(stats, url, query) +
    rhythmPanel(stats, query) +
    `</details>` +
    unbuiltPanel() +
    `</div><script>
(() => {
  function revealPanel() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (!target || !target.closest('.stats-page')) return;
    for (let node = target; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    target.scrollIntoView();
  }
  addEventListener('hashchange', revealPanel);
  revealPanel();
})();
</script>`;
  return page({ title: 'Statistics — sessions', nav: 'stats', body });
}

/** Everything the page reads from the URL, validated against its allowed set. An unrecognised
 * value falls back to the default rather than erroring: this is a dashboard, and a stale
 * bookmark should render rather than 400. */
export function parseQuery(url: URL): StatsQuery {
  const p = url.searchParams;
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const v = p.get(name);
    return allowed.includes(v as T) ? (v as T) : fallback;
  };
  const tz = Number(p.get('tz'));
  return {
    range: pick<Range>('range', RANGES, '30d'),
    by: pick<Attribution>('by', ATTRIBUTIONS, 'project'),
    rank: pick('rank', ['calls', 'cost'] as const, 'calls'),
    tzOffsetHours: Number.isFinite(tz) ? Math.trunc(Math.min(14, Math.max(-14, tz))) : 0,
    harness: p.get('harness') || undefined,
    model: p.get('model') || undefined,
    project: p.get('project') || undefined,
    machine: p.get('machine') || undefined,
  };
}

function subhead(s: Stats, query: StatsQuery): string {
  const from = s.window.from ? s.window.from.slice(0, 10) : 'the beginning';
  const to = s.window.to ? s.window.to.slice(0, 10) : 'now';
  const filters = [
    query.harness ? `harness ${query.harness}` : null,
    query.model ? `model ${query.model}` : null,
    query.project ? `project ${query.project}` : null,
    query.machine ? `machine ${query.machine}` : null,
  ].filter(Boolean);
  return (
    `<p class="muted small stats-scope">Usage window: ${esc(from)} → ${esc(to)}. ` +
    `Usage counts use this window and these filters; child sessions count separately. ` +
    `Nightly block metrics use the separate UTC-day scope shown below.` +
    `${filters.length ? `<br>Filtered by ${esc(filters.join(' · '))}` : ''}</p>`
  );
}

/** Range links preserve every other parameter, so switching range does not silently clear a
 * filter the reader set two clicks ago. */
function controls(url: URL, query: StatsQuery): string {
  const links = RANGES.map((r) => {
    const href = withParam(url, 'range', r);
    const active = r === query.range;
    return `<a href="${esc(href)}"${active ? ' class="on" aria-current="true"' : ''}>${esc(r)}</a>`;
  }).join('');
  const clear = [query.harness, query.model, query.project, query.machine].some(Boolean)
    ? ` <a href="${esc(withParams(url, { harness: null, model: null, project: null, machine: null }))}">clear filters</a>`
    : '';
  return `<div class="statbar"><span class="muted small">Range</span>${links}${clear}</div>`;
}

function overview(s: Stats): string {
  const a = s.activity;
  return (
    `<section class="stats-overview" aria-label="Usage overview"><dl class="stats-metrics">` +
    [
      ['Sessions with usage', fmtInt(s.ledger.sessions)],
      ['Usage records', fmtInt(s.ledger.calls)],
      ['Model groups', fmtInt(a.models)],
      ['Priced coverage', s.ledger.calls > 0 ? `${((s.ledger.pricedCalls / s.ledger.calls) * 100).toFixed(1)}%` : '—'],
    ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('') +
    `</dl><dl class="stats-token-metrics">` +
    [
      ['Reported input', a.inputTokens],
      ['Output', a.outputTokens],
      ['Cache read', a.cacheReadTokens],
      ['Cache write', a.cacheWriteTokens],
    ].map(([label, value]) => `<div><dt>${label}</dt><dd>${fmtInt(Number(value))}</dd></div>`).join('') +
    `</dl><p class="small muted">Reported token counters are separate: input may include cached tokens. ` +
    `Model groups include unknown and synthetic labels. ${costCoverage(s.ledger.pricedCalls, s.ledger.calls)}.</p></section>`
  );
}

function rankingControls(url: URL, query: StatsQuery): string {
  return `<nav class="statbar stats-ranking" aria-label="Rank models and sessions"><span class="muted small">Rank by</span>` +
    ([
      ['calls', 'Most usage records'],
      ['cost', 'Highest known cost'],
    ] as const).map(([rank, label]) =>
      `<a href="${esc(withParam(url, 'rank', rank))}"${(query.rank ?? 'calls') === rank ? ' class="on" aria-current="true"' : ''}>${label}</a>`,
    ).join('') + `</nav>`;
}

function costCoverage(pricedCalls: number, calls: number): string {
  if (calls === 0) return 'No usage records';
  if (pricedCalls === 0) return 'Unpriced';
  return `${fmtInt(pricedCalls)} / ${fmtInt(calls)} priced`;
}

function knownCost(usd: number, pricedCalls: number, calls: number, dp = 2): string {
  if (pricedCalls === 0) return '—';
  return `${fmtUsd(usd, dp)}${pricedCalls < calls ? ' subtotal' : ''}`;
}

function tableScroll(label: string, table: string): string {
  return `<div class="stats-table-scroll" role="region" aria-label="${esc(label)}" tabindex="0">${table}</div>`;
}

function withParam(url: URL, name: string, value: string | null): string {
  return withParams(url, { [name]: value });
}

function withParams(url: URL, updates: Record<string, string | null>): string {
  const next = new URL(url.toString());
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) next.searchParams.delete(k);
    else next.searchParams.set(k, v);
  }
  return `${next.pathname}${next.search}`;
}

function panel(id: string, question: string, lede: string, content: string): string {
  return (
    `<section class="panel" id="${esc(id)}">` +
    `<h3>${esc(question)}</h3>` +
    `<p class="muted small lede">${lede}</p>` +
    content +
    `</section>`
  );
}

function ledgerPanel(s: Stats): string {
  const l = s.ledger;
  const delta = l.pricedCalls === l.calls && l.priorPricedCalls === l.priorCalls && l.priorUsd > 0
    ? (l.usd - l.priorUsd) / l.priorUsd
    : null;
  const deltaText =
    delta === null
      ? 'no comparable prior window'
      : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}% vs prior period`;
  const tiles = [
    tile(knownCost(l.usd, l.pricedCalls, l.calls), 'Known list-price cost', deltaText),
    tile(l.pricedCalls > 0 && l.activeHours > 0 ? knownCost(l.usd / l.activeHours, l.pricedCalls, l.calls) : '—',
      'Per elapsed session hour', `${l.activeHours.toFixed(1)} h summed across sessions; may overlap`),
    tile(l.pricedCalls > 0 ? fmtUsd(l.usd / l.pricedCalls, 4) : '—', 'Mean per priced record', costCoverage(l.pricedCalls, l.calls)),
    l.staleBreakdownCalls > 0 || l.pricedCalls === 0 || l.usd === 0
      ? tile('—', 'Cache cost share', 'cost breakdown unavailable')
      : tile(`${(l.cacheShare * 100).toFixed(0)}%`, 'Cache cost share', 'reads + writes, as a share of known cost'),
  ].join('');
  const unpriced = l.pricedCalls < l.calls
    ? `<p class="small flag">${fmtInt(l.calls - l.pricedCalls)} usage records have no stored price. Dollar subtotals exclude them; — means unknown, not free.</p>`
    : '';
  return panel(
    'ledger',
    'Cost summary',
    'Stored list-price equivalents, not invoices. Flat-rate subscriptions may not incur these per-token charges. ' +
      'Period comparisons are shown only when both windows are fully priced.',
    `<div class="tiles">${tiles}</div>${unpriced}`,
  );
}

function tile(value: string, label: string, sub: string): string {
  return (
    `<div class="tile"><div class="tile-v">${esc(value)}</div>` +
    `<div class="tile-l">${esc(label)}</div><div class="tile-s muted">${esc(sub)}</div></div>`
  );
}

function depthPanel(s: Stats): string {
  const maxCost = Math.max(...s.depth.map((d) => d.usdPerCall), 0);
  const maxSessions = Math.max(...s.depth.map((d) => d.sessions), 0);
  const rows = s.depth
    .map((d) => {
      const costPct = maxCost > 0 ? (d.usdPerCall / maxCost) * 100 : 0;
      const sessPct = maxSessions > 0 ? (d.sessions / maxSessions) * 100 : 0;
      return (
        `<tr><th scope="row">${esc(d.label)}</th>` +
        `<td class="barcell">${bar(costPct, 'a')}</td>` +
        `<td class="num">${d.pricedCalls ? fmtUsd(d.usdPerCall, 4) : '—'}<span class="stats-cell-note">${costCoverage(d.pricedCalls, d.calls)}</span></td>` +
        `<td class="barcell">${bar(sessPct, 'b')}</td>` +
        `<td class="num muted">${fmtInt(d.sessions)}</td></tr>`
      );
    })
    .join('');
  return panel(
    'shape',
    'Cost by turn depth',
    'Mean cost uses priced usage records only. Session counts show how many sessions reached each depth band.',
    tableScroll('Cost by turn depth', `<table class="chart"><thead><tr><th>Depth</th><th>Mean $ / priced record</th><th>Mean / coverage</th>` +
      `<th>Sessions reaching it</th><th>Sessions</th></tr></thead><tbody>${rows}</tbody></table>`) +
      `<p class="small muted">Means can be moved by a small number of deep sessions. Grouped usage does not retain a per-turn distribution for medians.</p>`,
  );
}

function classesPanel(s: Stats): string {
  // Normalised against the LEDGER total, not against the sum of the classes. Identical in the
  // normal case — the five classes sum to `usd` exactly, by construction in costOfUsage — and
  // honest in the abnormal one: while some turns' splits are still missing, their dollars are in
  // the ledger and in no class, so the shares here simply do not reach 100% and the bars visibly
  // fall short. Normalising against the class sum instead would rescale the gap away and let a
  // class read 100.0% of a denominator that excludes the missing dollars, which is worse than the
  // absolute figures being low: a percentage looks self-normalising, so it reads as complete.
  const totalUsd = s.ledger.usd > 0 ? s.ledger.usd : s.classes.reduce((a, c) => a + c.usd, 0);
  const rows = s.classes
    .map((c) => {
      const usdPct = totalUsd > 0 ? (c.usd / totalUsd) * 100 : 0;
      return (
        `<tr><th scope="row">${esc(c.label)}</th>` +
        `<td class="num" title="${fmtInt(c.tokens)}">${fmtTokens(c.tokens)}</td>` +
        `<td class="barcell">${bar(usdPct, 'a')}</td><td class="num muted">${s.ledger.pricedCalls > s.ledger.staleBreakdownCalls && totalUsd > 0 ? `${usdPct.toFixed(1)}%` : '—'}</td>` +
        `<td class="num">${knownCost(c.usd, s.ledger.pricedCalls - s.ledger.staleBreakdownCalls, s.ledger.calls)}</td></tr>`
      );
    })
    .join('');
  return panel(
    'classes',
    'Token classes',
    'Reported token counters may overlap: input can include cached tokens, and reasoning is part of output. ' +
      'Cost shares use the stored pricing breakdown and known cost subtotal.',
    tableScroll('Token counters and cost shares', `<table class="chart"><thead><tr><th>Class</th><th>Reported tokens</th>` +
      `<th colspan="3">Share of known cost</th></tr></thead><tbody>${rows}</tbody></table>`) +
      staleBreakdownNotice(s),
  );
}

/** Said out loud when some turns' costs are known but their class split is not yet stored.
 *
 * Only ever true mid-backfill, after a pricing-version bump. Those rows contribute their dollars
 * to every total on the page and 0 to every class, so the cost side of this table under-reports by
 * exactly their share — and 0 is indistinguishable from "this class was free", which is the same
 * conflation the schema refuses to make by keeping an unpriced NULL distinct from a real 0.
 *
 * Stated rather than hidden, and rather than suppressing the panel: the token side is completely
 * accurate throughout, and it is the more useful half. Only the money is provisional. */
function staleBreakdownNotice(s: Stats): string {
  if (s.ledger.staleBreakdownCalls === 0) return '';
  const pct = s.ledger.calls > 0 ? (s.ledger.staleBreakdownCalls / s.ledger.calls) * 100 : 0;
  return (
    `<p class="small flag"><b>Cost side is incomplete.</b> ${fmtInt(s.ledger.staleBreakdownCalls)} of ` +
    `${fmtInt(s.ledger.calls)} usage records (${pct.toFixed(1)}%) were priced before this breakdown was stored and ` +
    `are awaiting re-pricing; their dollars count toward the totals elsewhere on this page but not toward any ` +
    `class here, so every cost figure in this table is a lower bound and the cost shares do not reach ` +
    `100%. Token counts are unaffected. ` +
    `Cache share is suppressed for the same reason.</p>`
  );
}

function gapsPanel(s: Stats): string {
  const total = s.gaps.reduce((a, g) => a + g.turns, 0);
  const over = s.gaps.filter((g) => g.overFiveMin).reduce((a, g) => a + g.turns, 0);
  const max = Math.max(...s.gaps.map((g) => g.turns), 0);
  const bars = s.gaps
    .map((g) => {
      const h = max > 0 ? (g.turns / max) * 100 : 0;
      return (
        `<div class="gcol"><div class="gbar-wrap"><div class="gbar ${g.overFiveMin ? 'earned' : 'wasted'}" ` +
        `style="height:${h.toFixed(1)}%"></div></div><div class="glabel">${esc(g.label)}</div>` +
        `<div class="gval muted">${fmtInt(g.turns)}</div></div>`
      );
    })
    .join('');
  const pct = total > 0 ? (over / total) * 100 : 0;
  return panel(
    'cache',
    'Gaps between recorded turns',
    'Time between consecutive records in transcript order. Gaps alone do not establish cache hits, cache eligibility or savings.',
    `<div class="gaps">${bars}</div>` +
      `<p class="small"><span class="swatch earned"></span> ${pct.toFixed(0)}% of measured gaps exceed 5 minutes. ` +
      `<span class="swatch wasted"></span> Remaining gaps are at most 5 minutes.</p>` +
      `<p class="small muted">Negative gaps are excluded when timestamp order disagrees with transcript order.</p>`,
  );
}

function attributionPanel(s: Stats, url: URL, query: StatsQuery): string {
  const tabs = ATTRIBUTIONS.map((a) => {
    const href = `${withParam(url, 'by', a)}#attribution`;
    return `<a href="${esc(href)}"${a === query.by ? ' class="on" aria-current="true"' : ''}>${esc(a)}</a>`;
  }).join('');
  const max = Math.max(...s.attribution.map((r) => r.usd), 0);
  const rows = s.attribution
    .map(
      (r) =>
        `<tr><th scope="row" class="wrap">${esc(r.key)}</th>` +
        `<td class="barcell">${bar(max > 0 ? (r.usd / max) * 100 : 0, 'a')}</td>` +
        `<td class="num">${knownCost(r.usd, r.pricedCalls, r.calls)}<span class="stats-cell-note">${costCoverage(r.pricedCalls, r.calls)}</span></td><td class="num muted">${fmtInt(r.calls)}</td>` +
        `<td class="num muted">${fmtInt(r.sessions)} sess</td></tr>`,
    )
    .join('');
  return panel(
    'attribution',
    'Cost attribution',
    'Known cost grouped by the selected session metadata. These groups do not measure output quality or completed work.',
    `<nav class="tabs" aria-label="Group cost by">${tabs}</nav>` +
      tableScroll('Cost attribution', `<table class="chart"><thead><tr><th>Group</th><th>Known cost</th><th>Cost / coverage</th><th>Usage records</th><th>Sessions</th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>'}</tbody></table>`) +
      `<p class="small muted">Branches are keyed by <code>project@branch</code>. Projects use the name derived from cwd, not repository URL.</p>`,
  );
}

function rhythmPanel(s: Stats, query: StatsQuery): string {
  const max = Math.max(...s.rhythm.map((c) => c.calls), 0);
  const byCell = new Map(s.rhythm.map((c) => [`${c.dow}:${c.hour}`, c.calls]));
  const header = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th class="hh">${h % 6 === 0 ? h : ''}</th>`).join('')}</tr>`;
  const rows = DOW.map((label, d) => {
    const cells = Array.from({ length: 24 }, (_, h) => {
      const n = byCell.get(`${d}:${h}`) ?? 0;
      // Fourth root, not linear: turn counts are heavily skewed, and a linear ramp renders every
      // hour outside the two peak ones as the same near-empty cell.
      const intensity = max > 0 && n > 0 ? Math.pow(n / max, 0.25) : 0;
      return `<td class="cell" style="opacity:${intensity.toFixed(3)}" title="${esc(`${label} ${h}:00 — ${n} usage records`)}"></td>`;
    }).join('');
    return `<tr><th class="dow">${esc(label)}</th>${cells}</tr>`;
  }).join('');
  const tz = query.tzOffsetHours;
  const tzLabel = tz === 0 ? 'UTC' : `UTC${tz > 0 ? '+' : ''}${tz}`;
  return panel(
    'rhythm',
    'Usage by weekday and hour',
    'Timestamped usage records, grouped by the selected fixed UTC offset.',
    tableScroll('Usage by weekday and hour', `<table class="heat">${header}${rows}</table>`) +
      `<p class="small muted">Hours shown in <b>${esc(tzLabel)}</b>. Set the <code>tz</code> query parameter to a UTC offset. ` +
      `Cells use a fourth-root scale; hover for exact counts. This is not a measure of execution time.</p>`,
  );
}

function modelsPanel(s: Stats, url: URL): string {
  const rows = s.models.map((m) => {
    const share = s.ledger.calls > 0 ? (m.calls / s.ledger.calls) * 100 : 0;
    return `<tr><th scope="row" class="stats-model"><a href="${esc(withParam(url, 'model', m.model))}">${esc(m.model)}</a>` +
      `<span class="stats-cell-note">${fmtInt(m.sessions)} sessions</span></th>` +
      `<td class="num">${fmtInt(m.calls)}</td>` +
      `<td class="stats-share">${bar(share, 'a')}<span>${share.toFixed(1)}%</span></td>` +
      `<td class="num" title="${fmtInt(m.inputTokens)} input; ${fmtInt(m.outputTokens)} output">${fmtTokens(m.inputTokens)}<span class="stats-cell-note">${fmtTokens(m.outputTokens)}</span></td>` +
      `<td class="num" title="${fmtInt(m.cacheReadTokens)} cache read; ${fmtInt(m.cacheWriteTokens)} cache write">${fmtTokens(m.cacheReadTokens)}<span class="stats-cell-note">${fmtTokens(m.cacheWriteTokens)}</span></td>` +
      `<td class="num">${knownCost(m.usd, m.pricedCalls, m.calls)}<span class="stats-cell-note">${costCoverage(m.pricedCalls, m.calls)}</span></td>` +
      `<td class="num">${m.pricedCalls > 0 ? fmtUsd(m.usdPerCall, 4) : '—'}</td>` +
      `<td class="num">${m.toolCallsPerTurn === null ? '—' : m.toolCallsPerTurn.toFixed(2)}</td></tr>`;
  }).join('');
  return panel(
    'models',
    'Model activity',
    `${s.activity.models > s.models.length ? `Top ${fmtInt(s.models.length)} of ${fmtInt(s.activity.models)} model groups. ` : ''}` +
      'Usage share is of all matching records, including groups outside this table. Select a model to filter this page. ' +
      'Tool calls per assistant turn use nightly block metrics, not usage-record counts; see the ' +
      '<a href="#waste">separate UTC-day scope and coverage</a> below.',
    tableScroll('Model activity', `<table class="chart stats-model-table"><thead><tr><th>Model / sessions</th><th>Usage records</th><th>Usage share</th>` +
      `<th class="num">Input<br>Output</th><th class="num">Cache read<br>Cache write</th><th class="num">Known cost / coverage</th><th class="num">Mean $ / priced record</th>` +
      `<th class="num">Tool calls /<br>assistant turn</th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="8" class="muted">No usage in this window.</td></tr>'}</tbody></table>`),
  );
}

function outliersPanel(s: Stats): string {
  const rows = s.outliers.map((o) =>
    `<tr><th scope="row" class="stats-session"><a href="/s/${q(o.sessionId)}">${esc(o.title ?? o.sessionId)}</a>` +
    `<span class="stats-cell-note">${esc(o.harness ?? 'Unknown harness')}${o.branch ? ` · ${esc(o.branch)}` : ''}</span></th>` +
    `<td class="num">${fmtInt(o.calls)}</td>` +
    `<td class="num" title="${fmtInt(o.inputTokens)}">${fmtTokens(o.inputTokens)}</td>` +
    `<td class="num" title="${fmtInt(o.outputTokens)}">${fmtTokens(o.outputTokens)}</td>` +
    `<td class="num">${knownCost(o.usd, o.pricedCalls, o.calls)}<span class="stats-cell-note">${costCoverage(o.pricedCalls, o.calls)}</span></td></tr>`,
  ).join('');
  return panel(
    'outliers',
    'Session ranking',
    `Top ${fmtInt(s.outliers.length)} sessions with matching usage. Open a transcript to inspect the work.`,
    tableScroll('Session ranking', `<table class="chart stats-session-table"><thead><tr><th>Session</th><th>Usage records</th><th>Input</th><th>Output</th><th>Known cost / coverage</th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>'}</tbody></table>`),
  );
}

function wastePanel(s: Stats): string {
  const { range, coverage, diagnostics: d, subagentSpend: spend } = s.waste;
  const scope = range.from !== null && range.to !== null && range.from >= range.to
    ? 'No complete UTC days fall inside this usage window.'
    : `Complete UTC-day scope: ${esc(range.from ?? 'the beginning')} → ${esc(range.to ?? 'all recorded days')}` +
      `${range.to === null ? '' : ' (end exclusive)'}.`;
  const coverageText = coverage.eligibleSessions > 0
    ? `${fmtInt(coverage.readySessions)} / ${fmtInt(coverage.eligibleSessions)} known matching sessions have a current, fully published rollup; ` +
      `${fmtInt(coverage.coveredSessions)} have buckets in this UTC-day scope.`
    : 'No known matching sessions; nightly coverage is unavailable.';
  const tiles = [
    tile(d === null ? '—' : fmtInt(d.rewoundAssistantTurns), 'Rewound assistant turns',
      d === null ? 'Nightly block metrics unavailable'
        : `${fmtInt(d.assistantTurns)} assistant turns indexed; ` +
          (d.rewindRate === null ? 'rewind rate unavailable' : `${(d.rewindRate * 100).toFixed(1)}% off the main path`)),
    tile(d === null ? '—' : `${fmtInt(d.toolResultSourceBytes)} bytes`, 'Indexed tool-result source bytes',
      'Source-span proxy, not context tokens or cost'),
    tile(d === null ? '—' : fmtInt(d.repeatedToolCalls), 'Repeated complete tool calls',
      d === null ? 'Nightly block metrics unavailable'
        : `${fmtInt(d.comparableToolCalls)} comparable calls; ` +
          (d.repeatedToolCallRate === null ? 'repeat rate unavailable' : `${(d.repeatedToolCallRate * 100).toFixed(1)}% repeated`)),
    tile(knownCost(spend.usd, spend.pricedCalls, spend.calls), 'Direct child / subagent known spend',
      `${costCoverage(spend.pricedCalls, spend.calls)}; usage window, not UTC-day scope`),
  ].join('');
  const comparable = d === null
    ? 'Comparable tool-call coverage is unavailable until matching rollup buckets are published.'
    : `Comparable tool-call coverage: ${fmtInt(d.comparableToolCalls)} / ${fmtInt(d.toolCalls)} indexed calls` +
      (d.toolCalls > 0 ? ` (${((d.comparableToolCalls / d.toolCalls) * 100).toFixed(1)}%)` : ' (rate unavailable)') +
      '. Only complete indexed arguments can be compared; partial or missing arguments are excluded.';
  const unpriced = spend.pricedCalls < spend.calls
    ? ` ${fmtInt(spend.calls - spend.pricedCalls)} child usage records are unpriced and excluded from the known subtotal.`
    : '';
  return panel(
    'waste',
    'Waste diagnostics',
    'Signals for transcript inspection, not proven waste or a measure of quality. Rewinds and repeated calls can be intentional; ' +
      'these measures are not added into a total.',
    `<p class="small muted">${scope} ` +
      `${range.timestampScope === 'including-undated' ? 'Includes the unknown-timestamp bucket; the current partial UTC day is excluded.' : 'Only complete UTC days inside the usage window; partial days and unknown timestamps are excluded.'}</p>` +
      `<p class="small muted">Nightly coverage: ${coverageText} Coverage counts known matching sessions, not the entire archive. ` +
      `Oldest covered publication: ${esc(coverage.oldestCompletedAt ?? 'Unknown')}. ` +
      `Newest covered publication: ${esc(coverage.newestCompletedAt ?? 'Unknown')}.</p>` +
      (d === null ? `<p class="small flag">No matching published block metrics. — means unavailable, not zero.</p>` : '') +
      `<div class="tiles">${tiles}</div>` +
      `<p class="small muted">${comparable} Repeated calls match the tool name and exact indexed argument text across all days and models within a session. ` +
      `Each repeat after the first belongs to the later call's UTC day and model. This is not semantic equivalence or proof of unnecessary work.</p>` +
      `<p class="small muted">Tool-result <code>byte_len</code> measures indexed source spans. It is a proxy for result volume, ` +
      `not a measurement of bytes sent to the model, context occupancy, tokens, or dollars. ` +
      `Turn dates come from the first indexed block's timestamp. Block model attribution requires a unique usage record at the same turn; ` +
      `otherwise the model is unknown.</p>` +
      `<p class="small muted">Child spend uses matching main-path usage in ${fmtInt(spend.sessions)} direct child sessions linked to ` +
      `${fmtInt(spend.parents)} parents by <code>parent_session_id</code>, with the current usage window and filters. ` +
      `It is already part of usage cost, not an extra charge or a recursive descendant total.${unpriced} ` +
      `Unknown cost is not zero; stored list prices are not invoices.</p>`,
  );
}

function unbuiltPanel(): string {
  const items = UNBUILT.map(
    (u) => `<li><b>${esc(u.panel)}</b><br><span class="muted small">Needs ${esc(u.needs)}</span></li>`,
  ).join('');
  return `<details class="stats-limitations" id="unbuilt"><summary>Data limitations</summary>` +
    `<p class="small muted">Usage records are not all assistant messages. Reported input can overlap cache counters; ` +
    `do not add them into a total. Unknown cost is not zero, and cost does not measure quality. ` +
    `Records without session metadata can contribute to usage totals but not linked session rankings.</p>` +
    `<ul class="gaps-list">${items}</ul></details>`;
}

function bar(pct: number, tone: 'a' | 'b'): string {
  const w = Math.max(0, Math.min(100, pct));
  return `<span class="bar bar-${tone}" style="width:${w.toFixed(1)}%"></span>`;
}

function fmtUsd(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

function fmtTokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
