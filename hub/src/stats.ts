/** Data layer for the statistics page.
 *
 * Kept out of viewer/stats.ts so the arithmetic can be tested without parsing HTML: everything
 * here takes a D1 binding plus a StatsQuery and returns plain numbers.
 *
 * Every panel is deliberately built on `usage` + `sessions` only. Both are small and indexed
 * (`usage_ts`, `usage_session`, `sessions_facets`), so the whole page is a handful of indexed
 * aggregates. The panels that would need `blocks` — rework, context bloat, tool-result waste —
 * are NOT here: `blocks` is by far the largest table (1.4M rows) and D1 bills rows read, so those
 * belong behind a nightly rollup rather than on a page load. See UNBUILT below.
 */
import { classifyModel, costOfUsage, loadPrices, type CostByClass, type ModelPrice } from './pricing';
import {
  priceEpochExpr,
  priceForGroup,
  UNKNOWN_MODEL_LABEL,
  USAGE_SHAPE_GROUP_BY,
  USAGE_SHAPE_SELECT,
  USAGE_TOKEN_SUMS,
  type UsageAggRow,
} from './usage-agg';

/** Ranges offered by the UI. `all` is included but is the only option that scans the whole
 * `usage` table on every panel, so it is never the default. */
export const RANGES = ['7d', '30d', '90d', 'all'] as const;
export type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

/** Attribution dimensions. `project@branch` is the composite the wireframe argued for: branch
 * names are not unique across repos, so `main` alone would pool every project's trunk work. */
export const ATTRIBUTIONS = ['branch', 'project', 'model', 'harness', 'machine'] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

const ATTRIBUTION_SQL: Record<Attribution, string> = {
  // COALESCE, not a bare column: a NULL group key is a real population (sessions with no branch
  // recorded), and leaving it NULL makes it invisible in a GROUP BY result the UI reads by name.
  branch: `COALESCE(s.project_name, '(no project)') || '@' || COALESCE(s.git_branch, '(no branch)')`,
  project: `COALESCE(s.project_name, '(no project)')`,
  model: `COALESCE(u.model, '${UNKNOWN_MODEL_LABEL}')`,
  harness: `COALESCE(s.harness, '(unknown)')`,
  machine: `COALESCE(s.machine_id, '(web — no machine)')`,
};

export interface StatsQuery {
  range: Range;
  by: Attribution;
  /** Whole-hour offset applied to `usage.ts` before extracting weekday/hour. UTC hours are
   * meaningless as a human schedule; see `rhythm`. */
  tzOffsetHours: number;
  harness?: string;
  model?: string;
  project?: string;
  machine?: string;
}

/** `prompt-log` is a synthetic harness whose single row spans months. It wins every ranking it
 * is allowed into and describes no session anyone worked in, so it is excluded from the whole
 * page rather than from each panel. */
const EXCLUDED_HARNESS = 'prompt-log';

interface Filters {
  where: string;
  binds: unknown[];
}

/** WHERE clause shared by every panel, so a filter can never apply to some numbers on the page
 * and not others. `from`/`to` are ISO strings compared against `u.ts` lexicographically, which is
 * exact for the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` the parsers write. */
function filters(q: StatsQuery, window: { from: string | null; to: string | null }): Filters {
  const binds: unknown[] = [];
  const terms: string[] = [`COALESCE(s.harness, '') != '${EXCLUDED_HARNESS}'`];
  if (window.from) {
    binds.push(window.from);
    terms.push(`u.ts >= ?${binds.length}`);
  }
  if (window.to) {
    binds.push(window.to);
    terms.push(`u.ts < ?${binds.length}`);
  }
  for (const [col, val] of [
    ['s.harness', q.harness],
    ['u.model', q.model],
    ['s.project_name', q.project],
    ['s.machine_id', q.machine],
  ] as const) {
    if (!val) continue;
    binds.push(val);
    terms.push(`${col} = ?${binds.length}`);
  }
  return { where: `WHERE ${terms.join(' AND ')}`, binds };
}

/** The half-open window a range covers, plus the equally-sized window immediately before it.
 *
 * `now` is injected rather than read from Date.now() so the tests are not time-dependent — a
 * range test that silently passes because the fixture happens to be inside today's 7 days is
 * exactly the kind of test this repo has already had to rewrite once.
 */
export function windows(range: Range, now: Date): { current: Window; prior: Window } {
  const days = RANGE_DAYS[range];
  if (days === null) return { current: { from: null, to: null }, prior: { from: null, to: null } };
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const priorFrom = new Date(now.getTime() - 2 * days * 86_400_000).toISOString();
  return { current: { from, to }, prior: { from: priorFrom, to: from } };
}

export interface Window {
  from: string | null;
  to: string | null;
}

/** A group of usage rows that all share a model, a rate epoch and a token-class shape, folded
 * into dollars. Every panel below reduces over rows of this type. */
interface PricedGroup {
  key: string | null;
  calls: number;
  usd: number;
  unpricedCalls: number;
  byClass: CostByClass;
  tokens: { input: number; output: number; cacheRead: number; cw5: number; cw1h: number };
}

function emptyGroup(key: string | null): PricedGroup {
  return {
    key,
    calls: 0,
    usd: 0,
    unpricedCalls: 0,
    byClass: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cw5: 0, cw1h: 0 },
  };
}

interface KeyedAggRow extends UsageAggRow {
  key: string | null;
}

/** Fold priced (key, model, epoch, shape) rows into one entry per key.
 *
 * Pricing happens per ROW here, not per key, because each row is one (model, epoch, shape) — the
 * unit `costOfUsage` is defined on. Summing tokens across models first and pricing once would
 * charge every model at whichever rate happened to be picked.
 */
function foldByKey(rows: KeyedAggRow[], prices: Map<string, ModelPrice[]>): Map<string | null, PricedGroup> {
  const out = new Map<string | null, PricedGroup>();
  for (const r of rows) {
    // Keyed by VALUE, not String(key): a NULL key and a key whose literal text is "null" both
    // stringify the same and would merge two different populations into one row.
    const key = (r.key ?? null) as string | null;
    const g = out.get(key) ?? emptyGroup(key);
    const modelClass = classifyModel(r.model);
    const price = modelClass === 'billable' ? priceForGroup(prices.get(r.model as string) ?? [], String(r.epoch), r, false) : null;
    const cost = costOfUsage(r, price, { batch: false });
    g.calls += Number(r.calls ?? 0);
    g.usd += cost.usd;
    g.byClass.input += cost.byClass.input;
    g.byClass.output += cost.byClass.output;
    g.byClass.cacheRead += cost.byClass.cacheRead;
    g.byClass.cacheWrite5m += cost.byClass.cacheWrite5m;
    g.byClass.cacheWrite1h += cost.byClass.cacheWrite1h;
    g.tokens.input += Number(r.input_tokens ?? 0);
    g.tokens.output += Number(r.output_tokens ?? 0);
    g.tokens.cacheRead += Number(r.cache_read_tokens ?? 0);
    g.tokens.cw5 += Number(r.cache_creation_5m_tokens ?? 0);
    g.tokens.cw1h += Number(r.cache_creation_1h_tokens ?? 0);
    // `sentinel` rows (`<synthetic>`) never hit an API, so they are not coverage we failed to
    // price. `unknown` rows are the opposite: real tokens at a rate we cannot determine.
    if (cost.unpriced && modelClass !== 'sentinel') g.unpricedCalls += Number(r.calls ?? 0);
    out.set(key, g);
  }
  return out;
}

/** One aggregate query keyed by an arbitrary SQL expression, priced and folded. */
async function pricedBy(
  db: D1Database,
  prices: Map<string, ModelPrice[]>,
  keyExpr: string,
  f: Filters,
  extra = '',
): Promise<Map<string | null, PricedGroup>> {
  const rows = await db
    .prepare(
      `SELECT ${keyExpr} AS key,
              u.model AS model,
              ${priceEpochExpr(prices)} AS epoch,
              ${USAGE_SHAPE_SELECT},
              ${USAGE_TOKEN_SUMS}
       FROM usage u JOIN sessions s ON s.session_id = u.session_id
       ${f.where}
       GROUP BY key, u.model, epoch, ${USAGE_SHAPE_GROUP_BY}
       ${extra}`,
    )
    .bind(...f.binds)
    .all<KeyedAggRow>();
  return foldByKey(rows.results ?? [], prices);
}

function totalOf(groups: Map<string | null, PricedGroup>): PricedGroup {
  const t = emptyGroup(null);
  for (const g of groups.values()) {
    t.calls += g.calls;
    t.usd += g.usd;
    t.unpricedCalls += g.unpricedCalls;
    for (const k of Object.keys(t.byClass) as Array<keyof CostByClass>) t.byClass[k] += g.byClass[k];
    for (const k of Object.keys(t.tokens) as Array<keyof PricedGroup['tokens']>) t.tokens[k] += g.tokens[k];
  }
  return t;
}

export interface Stats {
  window: Window;
  ledger: Ledger;
  classes: ClassRow[];
  depth: DepthRow[];
  gaps: GapRow[];
  attribution: AttributionRow[];
  rhythm: RhythmCell[];
  models: ModelRow[];
  outliers: OutlierRow[];
}

export interface Ledger {
  usd: number;
  priorUsd: number;
  calls: number;
  sessions: number;
  activeHours: number;
  unpricedCalls: number;
  /** Share of dollars spent on cache reads + writes. The number the wireframe argued replaces
   * "$/day": it says how much of the bill is context you are re-sending rather than new work. */
  cacheShare: number;
}

export interface ClassRow {
  label: string;
  tokens: number;
  usd: number;
}

export interface DepthRow {
  label: string;
  /** Mean dollars per call in this depth band. Mean, not median: SQLite has no median and the
   * per-call rows are already aggregated by the time pricing runs. Labelled as a mean in the UI. */
  usdPerCall: number;
  calls: number;
  sessions: number;
}

export interface GapRow {
  label: string;
  turns: number;
  /** Whether a 5-minute cache entry would already have expired across this gap. */
  overFiveMin: boolean;
}

export interface AttributionRow {
  key: string;
  usd: number;
  calls: number;
  sessions: number;
}

export interface RhythmCell {
  dow: number;
  hour: number;
  calls: number;
}

export interface ModelRow {
  model: string;
  usd: number;
  calls: number;
  sessions: number;
  usdPerCall: number;
  callsPerSession: number;
}

export interface OutlierRow {
  sessionId: string;
  title: string | null;
  branch: string | null;
  harness: string | null;
  usd: number;
  calls: number;
}

/** Turn-depth bands. Context grows monotonically within a session, so a turn's cost is largely a
 * function of how deep it is — these bands are what turn that into a decision about when to
 * start a fresh session. Bounds are literals in SQL, never bound parameters: they are part of
 * the CASE structure, not user input. */
const DEPTH_BANDS: ReadonlyArray<{ label: string; min: number; max: number | null }> = [
  { label: '1–5', min: 0, max: 5 },
  { label: '6–15', min: 5, max: 15 },
  { label: '16–30', min: 15, max: 30 },
  { label: '31–60', min: 30, max: 60 },
  { label: '61–100', min: 60, max: 100 },
  { label: '101–200', min: 100, max: 200 },
  { label: '200+', min: 200, max: null },
];

const DEPTH_CASE = `CASE ${DEPTH_BANDS.map(
  (b) => `WHEN u.turn_index >= ${b.min}${b.max === null ? '' : ` AND u.turn_index < ${b.max}`} THEN '${b.label}'`,
).join(' ')} END`;

/** Inter-turn gap bands, in seconds. The 5-minute line is the one that matters: a 1h cache write
 * costs 2.0x base input where a 5m write costs 1.25x, so the extra premium only buys something
 * when the next turn lands AFTER the 5m entry would have expired. */
const GAP_BANDS: ReadonlyArray<{ label: string; max: number | null }> = [
  { label: '<15s', max: 15 },
  { label: '15–30s', max: 30 },
  { label: '30–60s', max: 60 },
  { label: '1–2m', max: 120 },
  { label: '2–5m', max: 300 },
  { label: '5–10m', max: 600 },
  { label: '10–30m', max: 1800 },
  { label: '30–60m', max: 3600 },
  { label: '>1h', max: null },
];
const FIVE_MIN_S = 300;

export async function collectStats(db: D1Database, q: StatsQuery, now: Date): Promise<Stats> {
  const prices = await loadPrices(db);
  const w = windows(q.range, now);
  const cur = filters(q, w.current);
  const prior = filters(q, w.prior);

  const byModel = await pricedBy(db, prices, 'u.model', cur);
  const total = totalOf(byModel);
  const priorTotal = totalOf(await pricedBy(db, prices, 'u.model', prior));

  const shape = await sessionShape(db, prices, cur);
  const [counts, gaps, rhythm, modelSessions] = await Promise.all([
    sessionCounts(db, cur),
    gapHistogram(db, cur),
    rhythm2d(db, cur, q.tzOffsetHours),
    sessionsPerModel(db, cur),
  ]);
  const attribution = await pricedBy(db, prices, ATTRIBUTION_SQL[q.by], cur);
  const outliers = await topSessions(db, prices, cur);

  const cacheUsd = total.byClass.cacheRead + total.byClass.cacheWrite5m + total.byClass.cacheWrite1h;

  return {
    window: w.current,
    ledger: {
      usd: total.usd,
      priorUsd: priorTotal.usd,
      calls: total.calls,
      sessions: counts.sessions,
      activeHours: counts.activeSeconds / 3600,
      unpricedCalls: total.unpricedCalls,
      cacheShare: total.usd > 0 ? cacheUsd / total.usd : 0,
    },
    classes: [
      { label: 'Cache read', tokens: total.tokens.cacheRead, usd: total.byClass.cacheRead },
      { label: 'Cache write 5m', tokens: total.tokens.cw5, usd: total.byClass.cacheWrite5m },
      { label: 'Cache write 1h', tokens: total.tokens.cw1h, usd: total.byClass.cacheWrite1h },
      { label: 'Fresh input', tokens: total.tokens.input, usd: total.byClass.input },
      { label: 'Output', tokens: total.tokens.output, usd: total.byClass.output },
    ],
    depth: shape,
    gaps,
    attribution: [...attribution.values()]
      .map((g) => ({ key: g.key ?? '(none)', usd: g.usd, calls: g.calls, sessions: 0 }))
      .sort((a, b) => b.usd - a.usd || b.calls - a.calls)
      .slice(0, 12),
    rhythm,
    models: [...byModel.values()]
      .map((g) => {
        const model = g.key ?? UNKNOWN_MODEL_LABEL;
        const sessions = modelSessions.get(g.key ?? null) ?? 0;
        return {
          model,
          usd: g.usd,
          calls: g.calls,
          sessions,
          usdPerCall: g.calls > 0 ? g.usd / g.calls : 0,
          callsPerSession: sessions > 0 ? g.calls / sessions : 0,
        };
      })
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 8),
    outliers,
  };
}

/** Cost by turn depth, plus how many sessions are still running at each depth.
 *
 * The survival count is the load-bearing half. The cost curve alone says "deep turns are
 * expensive"; without knowing how much of the corpus is actually out there you would over-react
 * to a tail containing four sessions.
 */
async function sessionShape(
  db: D1Database,
  prices: Map<string, ModelPrice[]>,
  f: Filters,
): Promise<DepthRow[]> {
  const [priced, survival] = await Promise.all([
    pricedBy(db, prices, DEPTH_CASE, f),
    db
      .prepare(
        `SELECT ${DEPTH_CASE} AS key, COUNT(DISTINCT u.session_id) AS sessions
         FROM usage u JOIN sessions s ON s.session_id = u.session_id
         ${f.where}
         GROUP BY key`,
      )
      .bind(...f.binds)
      .all<{ key: string | null; sessions: number }>(),
  ]);
  const sessionsByBand = new Map((survival.results ?? []).map((r) => [r.key, Number(r.sessions ?? 0)]));
  return DEPTH_BANDS.map((b) => {
    const g = priced.get(b.label);
    const calls = g?.calls ?? 0;
    return {
      label: b.label,
      calls,
      usdPerCall: calls > 0 ? (g?.usd ?? 0) / calls : 0,
      sessions: sessionsByBand.get(b.label) ?? 0,
    };
  });
}

async function sessionCounts(db: D1Database, f: Filters): Promise<{ sessions: number; activeSeconds: number }> {
  // Wall-clock is measured over the SESSIONS that have usage in the window, from the session's own
  // first to last turn — not from sessions.started_at/ended_at, which span the whole session even
  // when only part of it falls inside the range. A session with no parseable timestamps
  // contributes 0 rather than dropping out, so the denominator never silently shrinks.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(secs), 0) AS active_seconds FROM (
         SELECT u.session_id,
                MAX(0, (julianday(MAX(u.ts)) - julianday(MIN(u.ts))) * 86400) AS secs
         FROM usage u JOIN sessions s ON s.session_id = u.session_id
         ${f.where}
         GROUP BY u.session_id
       )`,
    )
    .bind(...f.binds)
    .first<{ sessions: number; active_seconds: number }>();
  return { sessions: Number(row?.sessions ?? 0), activeSeconds: Number(row?.active_seconds ?? 0) };
}

/** Distinct sessions per model, for the "turns per session" column of the model panel. */
async function sessionsPerModel(db: D1Database, f: Filters): Promise<Map<string | null, number>> {
  const rows = await db
    .prepare(
      `SELECT u.model AS model, COUNT(DISTINCT u.session_id) AS sessions
       FROM usage u JOIN sessions s ON s.session_id = u.session_id
       ${f.where}
       GROUP BY u.model`,
    )
    .bind(...f.binds)
    .all<{ model: string | null; sessions: number }>();
  return new Map((rows.results ?? []).map((r) => [r.model ?? null, Number(r.sessions ?? 0)]));
}

/** Histogram of the gap between consecutive turns of a session.
 *
 * Ordered by `turn_index`, not by `ts`: turn_index is the transcript's own order and is NOT
 * NULL, whereas ts is nullable and can be non-monotonic in a resumed session. A NULL ts on
 * either side yields a NULL gap, which is excluded rather than counted as zero.
 */
async function gapHistogram(db: D1Database, f: Filters): Promise<GapRow[]> {
  const cases = GAP_BANDS.map((b) => (b.max === null ? `ELSE '${b.label}'` : `WHEN gap < ${b.max} THEN '${b.label}'`));
  const rows = await db
    .prepare(
      `WITH steps AS (
         SELECT (julianday(u.ts) - julianday(LAG(u.ts) OVER (PARTITION BY u.session_id ORDER BY u.turn_index))) * 86400
                  AS gap
         FROM usage u JOIN sessions s ON s.session_id = u.session_id
         ${f.where}
       )
       SELECT CASE ${cases.join(' ')} END AS band, COUNT(*) AS turns
       FROM steps
       -- A negative gap means the transcript's turn order disagrees with its timestamps; it is
       -- not a zero-second gap and must not land in the '<15s' band, which is what drives the
       -- "your 1h writes are wasted" reading.
       WHERE gap IS NOT NULL AND gap >= 0
       GROUP BY band`,
    )
    .bind(...f.binds)
    .all<{ band: string; turns: number }>();
  const byBand = new Map((rows.results ?? []).map((r) => [r.band, Number(r.turns ?? 0)]));
  return GAP_BANDS.map((b) => ({
    label: b.label,
    turns: byBand.get(b.label) ?? 0,
    overFiveMin: b.max === null || b.max > FIVE_MIN_S,
  }));
}

/** Weekday x hour turn counts, shifted into the viewer's timezone.
 *
 * Turns, not dollars: the question is when you work, and a cost heatmap at hour resolution
 * would fan the (model, epoch, shape) grouping across 168 cells for no extra insight.
 */
async function rhythm2d(db: D1Database, f: Filters, tzOffsetHours: number): Promise<RhythmCell[]> {
  // Interpolated, so it is forced to an integer in [-14, 14] first -- SQLite modifiers are
  // strings and this one sits inside the SQL text, not a bind slot.
  const offset = Math.trunc(Math.min(14, Math.max(-14, Number.isFinite(tzOffsetHours) ? tzOffsetHours : 0)));
  const shift = `'${offset >= 0 ? '+' : '-'}${Math.abs(offset)} hours'`;
  const rows = await db
    .prepare(
      `SELECT CAST(strftime('%w', u.ts, ${shift}) AS INTEGER) AS dow,
              CAST(strftime('%H', u.ts, ${shift}) AS INTEGER) AS hour,
              COUNT(*) AS calls
       FROM usage u JOIN sessions s ON s.session_id = u.session_id
       ${f.where}
       -- strftime returns NULL for an unparseable ts; those rows have no place on a clock.
       AND u.ts IS NOT NULL AND strftime('%w', u.ts) IS NOT NULL
       GROUP BY dow, hour`,
    )
    .bind(...f.binds)
    .all<{ dow: number; hour: number; calls: number }>();
  return (rows.results ?? []).map((r) => ({ dow: Number(r.dow), hour: Number(r.hour), calls: Number(r.calls ?? 0) }));
}

const OUTLIER_LIMIT = 12;

/** The most expensive sessions in the window, with enough identity to click through.
 *
 * Every panel above ends here: a statistic that does not terminate in a link to a specific
 * session is trivia.
 */
async function topSessions(db: D1Database, prices: Map<string, ModelPrice[]>, f: Filters): Promise<OutlierRow[]> {
  const priced = await pricedBy(db, prices, 'u.session_id', f);
  const top = [...priced.values()].sort((a, b) => b.usd - a.usd).slice(0, OUTLIER_LIMIT);
  if (!top.length) return [];
  const ids = top.map((g) => g.key).filter((k): k is string => k !== null);
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  const meta = await db
    .prepare(
      // first_interaction_title (migration 0013) with `title` as fallback: sessions not reparsed
      // since that migration have NULL there, so the fallback is not optional.
      `SELECT session_id, COALESCE(first_interaction_title, title) AS title, git_branch, harness
       FROM sessions WHERE session_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ session_id: string; title: string | null; git_branch: string | null; harness: string | null }>();
  const byId = new Map((meta.results ?? []).map((r) => [r.session_id, r]));
  return top
    .filter((g) => g.key !== null)
    .map((g) => {
      const m = byId.get(g.key as string);
      return {
        sessionId: g.key as string,
        title: m?.title ?? null,
        branch: m?.git_branch ?? null,
        harness: m?.harness ?? null,
        usd: g.usd,
        calls: g.calls,
      };
    });
}

/** Panels the wireframe specified that this version deliberately does NOT ship, surfaced on the
 * page itself so the omissions are visible rather than quietly missing. */
export const UNBUILT: ReadonlyArray<{ panel: string; needs: string }> = [
  {
    panel: 'Waste — rework, context bloat, subagent spend',
    needs:
      'a nightly session_rollup job. Every figure comes from `blocks` (rewound turns via on_main_path, ' +
      'tool-result byte_len, repeated tool arguments), which is by far the largest table — D1 bills rows ' +
      'read, so this cannot be a page-load scan.',
  },
  {
    panel: 'Tool calls per turn, in the model comparison',
    needs: 'the same rollup: tool counts live in `blocks`, not `usage`.',
  },
  {
    panel: 'Outcome quality — did the session actually work?',
    needs:
      'a signal the schema does not record. Stars are the only outcome-ish column and they are weak ' +
      '(you star what is interesting, not what shipped); the real signal would join git_branch to merged PRs.',
  },
];
