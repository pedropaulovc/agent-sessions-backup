/** GET /stats — the statistics page.
 *
 * Rendering only: every number arrives from src/stats.ts. Charts are inline SVG and CSS bars so
 * the page stays a single self-contained document with no scripts and no external assets, like
 * the rest of the viewer.
 *
 * The editorial line, carried over from the wireframe this implements: a statistic that cannot
 * change a decision is decoration. Each panel states the question it answers, and the last panel
 * states what the page still cannot tell you.
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
    `<h2>Statistics</h2>` +
    subhead(stats, query) +
    controls(url, query) +
    ledgerPanel(stats) +
    depthPanel(stats) +
    classesPanel(stats) +
    gapsPanel(stats) +
    attributionPanel(stats, url, query) +
    rhythmPanel(stats, query) +
    modelsPanel(stats) +
    outliersPanel(stats) +
    unbuiltPanel();
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
    `<p class="muted small">${fmtInt(s.ledger.calls)} assistant turns across ${fmtInt(s.ledger.sessions)} sessions · ` +
    `${esc(from)} → ${esc(to)}${filters.length ? ` · ${esc(filters.join(' · '))}` : ''}</p>`
  );
}

/** Range links preserve every other parameter, so switching range does not silently clear a
 * filter the reader set two clicks ago. */
function controls(url: URL, query: StatsQuery): string {
  const links = RANGES.map((r) => {
    const href = withParam(url, 'range', r);
    const active = r === query.range;
    return `<a href="${esc(href)}"${active ? ' class="on"' : ''}>${esc(r)}</a>`;
  }).join('');
  const clear = [query.harness, query.model, query.project, query.machine].some(Boolean)
    ? ` <a href="${esc(withParams(url, { harness: null, model: null, project: null, machine: null }))}">clear filters</a>`
    : '';
  return `<div class="statbar"><span class="muted small">Range</span>${links}${clear}</div>`;
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

function panel(id: string, kicker: string, question: string, lede: string, content: string): string {
  return (
    `<section class="panel" id="${esc(id)}">` +
    `<div class="kicker">${esc(kicker)}</div>` +
    `<h3>${esc(question)}</h3>` +
    `<p class="muted small lede">${lede}</p>` +
    content +
    `</section>`
  );
}

function ledgerPanel(s: Stats): string {
  const l = s.ledger;
  const delta = l.priorUsd > 0 ? (l.usd - l.priorUsd) / l.priorUsd : null;
  const deltaText =
    delta === null
      ? 'no comparable prior window'
      : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)}% vs prior period`;
  const tiles = [
    tile(fmtUsd(l.usd), 'List-price equivalent', deltaText),
    tile(l.activeHours > 0 ? fmtUsd(l.usd / l.activeHours) : '—', 'Per active hour', `${l.activeHours.toFixed(1)} h of turn-to-turn wall-clock`),
    tile(l.calls > 0 ? fmtUsd(l.usd / l.calls, 4) : '—', 'Per assistant turn', 'blended across models'),
    l.staleBreakdownCalls > 0
      ? tile('—', 'Absorbed by cache', 'unavailable until the next pricing pass completes')
      : tile(`${(l.cacheShare * 100).toFixed(0)}%`, 'Absorbed by cache', 'reads + writes, as a share of spend'),
  ].join('');
  const unpriced = l.unpricedCalls
    ? `<p class="small flag">${fmtInt(l.unpricedCalls)} turns could not be priced, so every dollar figure on this page is a floor.</p>`
    : '';
  return panel(
    'ledger',
    'Ledger',
    'What did this period cost, and is that changing?',
    'Four numbers, none of them “per day”. A daily average hides the thing you can act on: the <b>rate</b> at ' +
      'which a turn costs you, and how much of the bill the cache is already absorbing. ' +
      '<b>List-price equivalent</b> is the honest label — if these tokens burned under a flat-rate plan, no dollar ' +
      'changed hands. It is a comparable unit across harnesses and models, not a bill.',
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
        `<td class="num">${d.calls ? fmtUsd(d.usdPerCall, 4) : '—'}</td>` +
        `<td class="barcell">${bar(sessPct, 'b')}</td>` +
        `<td class="num muted">${fmtInt(d.sessions)}</td></tr>`
      );
    })
    .join('');
  return panel(
    'shape',
    'Session shape',
    'When does a session stop being worth continuing?',
    'Cost per turn is not flat — context grows monotonically, so turn 90 bills far more than turn 9 for the same ' +
      'amount of thinking. Against turn <b>depth</b>, spend becomes a decision: the depth past which a fresh ' +
      'session with a handoff summary is simply cheaper. The right-hand bars are how many sessions actually reach ' +
      'that depth — without them you would over-react to a tail containing four sessions.',
    `<table class="chart"><thead><tr><th>Depth</th><th>Mean $ / turn</th><th></th>` +
      `<th>Sessions reaching it</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="small muted">Mean, not median — the rows are already grouped by the time pricing runs, so there is ` +
      `no per-turn distribution left to take a median of. A single very deep session can therefore move a band.</p>`,
  );
}

function classesPanel(s: Stats): string {
  const totalTok = s.classes.reduce((a, c) => a + c.tokens, 0);
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
      const tokPct = totalTok > 0 ? (c.tokens / totalTok) * 100 : 0;
      const usdPct = totalUsd > 0 ? (c.usd / totalUsd) * 100 : 0;
      return (
        `<tr><th scope="row">${esc(c.label)}</th>` +
        `<td class="barcell">${bar(tokPct, 'b')}</td><td class="num muted">${tokPct.toFixed(1)}%</td>` +
        `<td class="num">${fmtTokens(c.tokens)}</td>` +
        `<td class="barcell">${bar(usdPct, 'a')}</td><td class="num muted">${usdPct.toFixed(1)}%</td>` +
        `<td class="num">${fmtUsd(c.usd)}</td></tr>`
      );
    })
    .join('');
  return panel(
    'classes',
    'Token economics',
    'Where is the money actually going inside a turn?',
    'This is the panel that retires “tokens per day”. The same five billing classes, measured twice — once by ' +
      'volume, once by cost. They are close to inverses of each other. ' +
      '<b>Fresh input</b> is input beyond the cached prefix for subset-accounting providers, which is what is ' +
      'actually billed at the input rate; the raw counter would double-count every cached turn.',
    `<table class="chart"><thead><tr><th>Class</th><th colspan="3">Share of tokens</th>` +
      `<th colspan="3">Share of cost</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="small muted">reasoning_tokens is deliberately absent: it is 0 for claude-code and a subset of ` +
      `output for codex, so it is not a sixth billing class and drawing it as one would double-count.</p>` +
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
    `${fmtInt(s.ledger.calls)} turns (${pct.toFixed(1)}%) were priced before this breakdown was stored and ` +
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
    'Cache tuning',
    'Is the 1-hour cache TTL earning its premium?',
    'A 1h cache write costs 2.0× base input; a 5m write costs 1.25×. That extra 0.75× only buys something when ' +
      'you come back <b>after</b> the 5-minute window has closed. The gap between consecutive turns says how often ' +
      'that actually happens.',
    `<div class="gaps">${bars}</div>` +
      `<p class="small"><span class="swatch earned"></span> ${pct.toFixed(0)}% of gaps exceed 5 minutes — ` +
      `a 5m entry had expired, so a 1h write would have paid for itself. ` +
      `<span class="swatch wasted"></span> the rest would have been covered by the cheaper TTL.</p>` +
      `<p class="small muted">Gaps are taken in transcript order (turn_index), not timestamp order: turn_index is ` +
      `NOT NULL and monotonic where ts is neither. Negative gaps — where the two disagree — are excluded rather ` +
      `than counted as zero, which would inflate the “wasted” side.</p>`,
  );
}

function attributionPanel(s: Stats, url: URL, query: StatsQuery): string {
  const tabs = ATTRIBUTIONS.map((a) => {
    const href = withParam(url, 'by', a);
    return `<a href="${esc(href)}"${a === query.by ? ' class="on"' : ''}>${esc(a)}</a>`;
  }).join('');
  const max = Math.max(...s.attribution.map((r) => r.usd), 0);
  const rows = s.attribution
    .map(
      (r) =>
        `<tr><th scope="row" class="wrap">${esc(r.key)}</th>` +
        `<td class="barcell">${bar(max > 0 ? (r.usd / max) * 100 : 0, 'a')}</td>` +
        `<td class="num">${fmtUsd(r.usd)}</td><td class="num muted">${fmtInt(r.calls)} turns</td>` +
        `<td class="num muted">${fmtInt(r.sessions)} sess</td></tr>`,
    )
    .join('');
  return panel(
    'attribution',
    'Attribution',
    'Which work absorbed the spend?',
    'Grouping by model or machine tells you about your setup. Grouping by <b>branch</b> tells you about your work — ' +
      'a branch is the closest thing this schema has to a unit of shipped output, which makes cost-per-branch the ' +
      'nearest available proxy for return.',
    `<div class="tabs">${tabs}</div>` +
      `<table class="chart"><tbody>${rows || '<tr><td class="muted">No usage in this window.</td></tr>'}</tbody></table>` +
      `<p class="small muted">Branch rows are keyed <code>project@branch</code>: branch names are not unique across ` +
      `repos, so a bare <code>main</code> would pool every project's trunk work into one row. Attribution keys on ` +
      `<code>project_name</code> (derived from cwd) rather than <code>repo_url</code>, which only the codex parser ` +
      `ever populates — grouping by repo would silently drop most of the corpus.</p>`,
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
      return `<td class="cell" style="opacity:${intensity.toFixed(3)}" title="${esc(`${label} ${h}:00 — ${n} turns`)}"></td>`;
    }).join('');
    return `<tr><th class="dow">${esc(label)}</th>${cells}</tr>`;
  }).join('');
  const tz = query.tzOffsetHours;
  const tzLabel = tz === 0 ? 'UTC' : `UTC${tz > 0 ? '+' : ''}${tz}`;
  return panel(
    'rhythm',
    'Rhythm',
    'When do I actually work with agents?',
    'Every turn carries a timestamp, so the corpus already knows your week. Worth having not for its own sake but ' +
      'because it says which hours are worth defending.',
    `<table class="heat">${header}${rows}</table>` +
      `<p class="small muted">Hours shown in <b>${esc(tzLabel)}</b> — timestamps are stored UTC, and a heatmap of ` +
      `UTC hours is meaningless as a human schedule. Append <code>?tz=-8</code> to shift it. Cells are shaded on a ` +
      `fourth-root scale because turn counts are heavily skewed; hover for the exact count.</p>`,
  );
}

function modelsPanel(s: Stats): string {
  const rows = s.models
    .map(
      (m) =>
        `<tr><th scope="row">${esc(m.model)}</th>` +
        `<td class="num">${fmtUsd(m.usd)}</td>` +
        `<td class="num">${fmtUsd(m.usdPerCall, 4)}</td>` +
        `<td class="num">${m.callsPerSession.toFixed(1)}</td>` +
        `<td class="num muted">${fmtInt(m.sessions)}</td></tr>`,
    )
    .join('');
  return panel(
    'models',
    'Model fit',
    'Is the expensive model earning its premium?',
    'A model that costs 4× per turn but needs half the turns is not 4× more expensive. Cost per turn next to turns ' +
      'per session is the cheapest honest version of that comparison.',
    `<table class="chart"><thead><tr><th>Model</th><th>Total</th><th>$ / turn</th><th>Turns / session</th>` +
      `<th>Sessions</th></tr></thead><tbody>${rows || '<tr><td class="muted">No usage in this window.</td></tr>'}</tbody></table>` +
      `<p class="small muted">Treat this as a hypothesis generator, not a verdict: nothing in this schema records ` +
      `whether a session <i>worked</i>. Turns per session is a proxy for “needed fewer round trips”, and it is also ` +
      `a proxy for “was given easier work”.</p>`,
  );
}

function outliersPanel(s: Stats): string {
  const rows = s.outliers
    .map(
      (o) =>
        `<tr><td class="wrap"><a href="/s/${q(o.sessionId)}">${esc(o.title ?? o.sessionId)}</a></td>` +
        `<td class="wrap muted">${esc(o.branch ?? '—')}</td>` +
        `<td class="muted">${esc(o.harness ?? '—')}</td>` +
        `<td class="num">${fmtInt(o.calls)}</td>` +
        `<td class="num">${fmtUsd(o.usd)}</td></tr>`,
    )
    .join('');
  return panel(
    'outliers',
    'Outliers',
    'Which sessions should I look at?',
    'Every panel above ends here. A statistic that does not terminate in a link to a specific session is trivia.',
    `<table><thead><tr><th>Session</th><th>Branch</th><th>Harness</th><th>Turns</th><th>Cost</th></tr></thead>` +
      `<tbody>${rows || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>'}</tbody></table>`,
  );
}

function unbuiltPanel(): string {
  const items = UNBUILT.map(
    (u) => `<li><b>${esc(u.panel)}</b><br><span class="muted small">Needs ${esc(u.needs)}</span></li>`,
  ).join('');
  return panel(
    'unbuilt',
    'Gaps',
    'What this page can’t tell you yet',
    'Listed rather than quietly omitted, so the absence of a number is not mistaken for a zero.',
    `<ul class="gaps-list">${items}</ul>`,
  );
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
