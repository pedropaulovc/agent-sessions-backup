/** Data layer for the statistics page.
 *
 * Kept out of viewer/stats.ts so the arithmetic can be tested without parsing HTML: everything
 * here takes a D1 binding plus a StatsQuery and returns plain numbers.
 *
 * Every panel is deliberately built on `usage` + `sessions` only. The panels that would need
 * `blocks` — rework, context bloat, tool-result waste — are NOT here: `blocks` is by far the
 * largest table and D1 bills rows read, so those belong behind a nightly rollup rather than a page
 * load. See UNBUILT below.
 *
 * COST, measured against the production table (776k usage rows, 31k sessions, 30-day window)
 * rather than estimated. Three changes took the page from 5s+ to ~1.4s; each is commented where it
 * lives, and each was verified by running the query both ways:
 *
 *   | step                                    | slowest query | rows read |
 *   |-----------------------------------------|---------------|-----------|
 *   | one query per panel, no index hint       | 5063ms        | 1.07M     |
 *   | + INDEXED BY usage_ts                    | 634ms         | 884k      |
 *   | + one session-grained scan for 6 panels  | 1853ms        | 873k      |
 *   | + sessions joined in memory, all parallel| 1261ms        | 582k      |
 *
 * Wall-clock is now the slowest single query (~1.3s) rather than their sum (~4.3s), because every
 * query is issued at once. Total rows read per load is ~3.8M, of which the gap histogram's window
 * function is ~1.7M — that, and the fact that all of this scales with corpus size, is why the
 * next step for this page is a rollup rather than more query tuning.
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

/** How many excluded session ids may be bound before `filters` switches to the parameter-free
 * predicate. D1 caps a statement at 100 bound parameters; the window bounds and the four column
 * filters claim at most 6 of them, and the rest of the margin is there so the ceiling is a
 * deliberate choice rather than a cliff one more filter would push us over. */
export const MAX_EXCLUDED_BINDS = 80;

interface Filters {
  where: string;
  binds: unknown[];
  /** Whether any panel still needs the `sessions` join. See `usageFrom`. */
  needsSession: boolean;
  /** `INDEXED BY usage_ts` when the window is bounded, empty when it is not. */
  hint: string;
}

/** The FROM clause for a usage aggregate.
 *
 * Two things here are load-bearing for cost, both measured against the 776k-row production
 * table rather than guessed:
 *
 * 1. `INDEXED BY usage_ts`. Left to itself SQLite picks whichever index serves the GROUP BY —
 *    `usage_model`, typically — and then SCANS THE WHOLE TABLE, so the range filter bounds
 *    nothing. Measured: 5063ms / 1.07M rows read for one 30-day panel, against 634ms / 884k with
 *    the hint. The hint is applied ONLY when a bound exists: with `range=all` there is nothing to
 *    seek to, and forcing it would walk the index and fetch every row for no benefit.
 * 2. The `sessions` join is omitted when nothing needs it. It costs one lookup per usage row
 *    (884k rows read against 589k without), and with no filters set the only thing it provides is
 *    the prompt-log exclusion — which is 7 sessions out of 31k and cheaper to pass as literals.
 */
function usageFrom(f: Filters): string {
  return `FROM usage u ${f.hint} ${f.needsSession ? 'JOIN sessions s ON s.session_id = u.session_id' : ''}`;
}

/** WHERE clause shared by every panel, so a filter can never apply to some numbers on the page
 * and not others. `from`/`to` are ISO strings compared against `u.ts` lexicographically, which is
 * exact for the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` the parsers write. */
function filters(
  q: StatsQuery,
  window: { from: string | null; to: string | null },
  opts: { excludedIds: string[]; sessionFilterMode: 'sql' | 'memory' },
): Filters {
  const binds: unknown[] = [];
  const terms: string[] = [];
  // Exactly ONE mechanism applies the session-column filters, chosen by the caller. The main scan
  // is grouped by session_id and filters against `sessionMeta` in memory, so it never joins; the
  // narrow panels return pre-aggregated shapes with no session left to filter on, so they join.
  // Running both would be two implementations of the same predicate — which is how they drift.
  const sql = opts.sessionFilterMode === 'sql';
  const needsSession = sql && (Boolean(q.harness) || Boolean(q.project) || Boolean(q.machine));

  if (needsSession) {
    terms.push(`COALESCE(s.harness, '') != '${EXCLUDED_HARNESS}'`);
  } else if (opts.excludedIds.length > MAX_EXCLUDED_BINDS) {
    // The id list is data-derived, so it is not bounded by anything we control. Past the bind
    // budget the whole page would start 500ing, so fall back to a predicate that costs no binds
    // at all. Correlated, hence the lookup per usage row the id list exists to avoid — but a slow
    // page beats a broken one, and this arm is unreachable until prompt-log sessions 15x.
    // Deliberately NOT `needsSession`: an inner join would also drop usage rows whose session was
    // deleted, which are real spend and belong in the totals.
    terms.push(`NOT EXISTS (SELECT 1 FROM sessions x WHERE x.session_id = u.session_id AND x.harness = '${EXCLUDED_HARNESS}')`);
  } else if (opts.excludedIds.length) {
    // The join's only remaining job on an unfiltered page. Bound, not interpolated, and the id
    // set is resolved once from a 3ms scan of `sessions` — there are 7 of them.
    const start = binds.length;
    binds.push(...opts.excludedIds);
    terms.push(`u.session_id NOT IN (${opts.excludedIds.map((_, i) => `?${start + i + 1}`).join(',')})`);
  }

  if (window.from) {
    binds.push(window.from);
    terms.push(`u.ts >= ?${binds.length}`);
  }
  if (window.to) {
    binds.push(window.to);
    terms.push(`u.ts < ?${binds.length}`);
  }
  for (const [col, val] of [
    ['s.harness', sql ? q.harness : undefined],
    // `u.model` is a usage column, so it stays in SQL either way -- filtering it there shrinks
    // the scan rather than discarding rows after paying for them.
    ['u.model', q.model],
    ['s.project_name', sql ? q.project : undefined],
    ['s.machine_id', sql ? q.machine : undefined],
  ] as const) {
    if (!val) continue;
    binds.push(val);
    terms.push(`${col} = ?${binds.length}`);
  }
  return {
    where: terms.length ? `WHERE ${terms.join(' AND ')}` : '',
    binds,
    needsSession,
    hint: window.from || window.to ? 'INDEXED BY usage_ts' : '',
  };
}

export interface SessionMeta {
  harness: string | null;
  machine_id: string | null;
  project_name: string | null;
  git_branch: string | null;
}

/** Every session's attribution columns, read in one pass.
 *
 * This exists so the main usage scan does not have to JOIN. `sessions` is 31k rows and scanning
 * it costs 3ms; joining it to 300k usage rows costs ~290k extra rows read and, measured, 1.2s.
 * Attribution, outliers and the session-column filters are all resolved against this map instead.
 *
 * `title` is deliberately NOT selected: it is the one wide column here, and it is needed for
 * twelve rows, which `topSessions` fetches by id.
 */
async function sessionMeta(db: D1Database): Promise<Map<string, SessionMeta>> {
  const rows = await db
    .prepare(`SELECT session_id, harness, machine_id, project_name, git_branch FROM sessions`)
    .all<{ session_id: string } & SessionMeta>();
  return new Map(
    (rows.results ?? []).map((r) => [
      r.session_id,
      { harness: r.harness, machine_id: r.machine_id, project_name: r.project_name, git_branch: r.git_branch },
    ]),
  );
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

/** Fold priced (model, epoch, shape) rows into one entry per key.
 *
 * The key comes from a selector rather than a `key` field on the row: the same scan is folded four
 * different ways, and materialising a keyed copy of it per fold would be four extra copies of a
 * 32k-row array on a fixed Worker memory ceiling, to carry one string each.
 *
 * Pricing happens per ROW here, not per key, because each row is one (model, epoch, shape) — the
 * unit `costOfUsage` is defined on. Summing tokens across models first and pricing once would
 * charge every model at whichever rate happened to be picked.
 */
function foldByKey<T extends UsageAggRow>(
  rows: T[],
  prices: Map<string, ModelPrice[]>,
  keyOf: (row: T) => string | null,
): Map<string | null, PricedGroup> {
  const out = new Map<string | null, PricedGroup>();
  for (const r of rows) {
    // Keyed by VALUE, not String(key): a NULL key and a key whose literal text is "null" both
    // stringify the same and would merge two different populations into one row.
    const key = keyOf(r) ?? null;
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

/** The one usage scan the page is built on.
 *
 * Grouped at (session, model, rate epoch, depth band, token shape) — the finest grain any panel
 * needs. Six panels are then derived in memory instead of costing a scan each: ledger, token
 * economics, session shape, model fit, attribution and outliers. Session attributes are joined in
 * from `sessionMeta` afterwards rather than by SQL; see that function for the measurement.
 *
 * Measured on the production table: 32k result rows for a 30-day window, one scan. The
 * alternative — a query per panel — re-read the same 300k usage rows six times over.
 *
 * The session columns are bare in a GROUP BY that includes `session_id`, which is legal in SQLite
 * and unambiguous here: they are functionally dependent on the session, so every row folded into
 * a group carries the same value.
 */
async function mainScan(db: D1Database, prices: Map<string, ModelPrice[]>, f: Filters): Promise<MainRow[]> {
  const rows = await db
    .prepare(
      `SELECT u.session_id AS session_id,
              u.model AS model,
              ${priceEpochExpr(prices)} AS epoch,
              ${DEPTH_CASE} AS band,
              ${USAGE_SHAPE_SELECT},
              ${USAGE_TOKEN_SUMS}
       ${usageFrom(f)}
       ${f.where}
       GROUP BY u.session_id, u.model, epoch, band, ${USAGE_SHAPE_GROUP_BY}`,
    )
    .bind(...f.binds)
    .all<MainRow>();
  return rows.results ?? [];
}

interface MainRow extends UsageAggRow {
  session_id: string;
  band: string | null;
  /** Attached from `sessionMeta` after the scan, never selected in SQL. */
  meta?: SessionMeta;
}

/** Totals-only scan, for the prior comparison window.
 *
 * One number, so this is now a plain aggregate over the stored per-turn cost rather than a
 * grouped scan folded through `costOfUsage` in JS. It used to have to reproduce the whole pricing
 * unit — epoch, shape booleans, six clamped token sums, 30 groups — for the sole purpose of
 * arriving at a single dollar figure.
 *
 * Measured on production over the same June window, old form against new:
 *
 *   | form                                    | time  | rows read |
 *   |-----------------------------------------|-------|-----------|
 *   | grouped by pricing unit, priced in JS   | 359ms | 240,869   |
 *   | SUM(u.usd)                              |  56ms | 120,435   |
 *
 * `SUM` skips NULLs, which is exactly right: an unpriceable row contributes nothing rather than
 * a zero, matching what the fold did with it. The rows themselves are still counted by the
 * unpriced tally on the main scan, so the coverage gap stays visible rather than being absorbed
 * into a total that looks complete. */
async function windowTotal(db: D1Database, f: Filters): Promise<number> {
  const row = await db
    .prepare(`SELECT SUM(u.usd) AS usd ${usageFrom(f)} ${f.where}`)
    .bind(...f.binds)
    .first<{ usd: number | null }>();
  return Number(row?.usd ?? 0);
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
  /** Mean dollars per call in this depth band. Mean, not median, because the per-call rows are
   * already summed into (session, model, epoch, band, shape) groups by the time pricing runs —
   * there is no per-call distribution left to take a median of. Labelled as a mean in the UI.
   *
   * Not a limit of the database: D1 does not expose median()/percentile() (`SELECT median(x)` →
   * `no such function`), but it does have window functions, and `usage` is one row per turn — so
   * an exact median is a `row_number()` away once a per-turn USD column exists. That column is
   * blocked on pricing moving off the read path, which is #70. */
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
  const w = windows(q.range, now);
  const [prices, meta] = await Promise.all([loadPrices(db), sessionMeta(db)]);
  // The sessions whose usage must never appear on this page. `prompt-log` is a synthetic harness:
  // a single row spans months, so it wins any ranking it is allowed into while describing no
  // session anyone worked in. There are 7 of them against 31k sessions — which is why passing the
  // ids beats joining 300k usage rows to find them — and `meta` is already loaded, so this costs
  // no query of its own.
  const excludedIds = [...meta].filter(([, m]) => m.harness === EXCLUDED_HARNESS).map(([id]) => id);

  // The main scan never joins: it is grouped by session_id, so session-column filters are applied
  // against `meta` afterwards. The three narrow panels return pre-aggregated shapes with no
  // session to filter on later, so those DO join whenever a session filter is set.
  const main = filters(q, w.current, { excludedIds, sessionFilterMode: 'memory' });
  const narrow = filters(q, w.current, { excludedIds, sessionFilterMode: 'sql' });
  const priorF = filters(q, w.prior, { excludedIds, sessionFilterMode: 'sql' });

  // Every query issued at once. Run sequentially these total ~4.3s against the production table;
  // in parallel the page waits only for the slowest.
  const [scan, gaps, rhythm, counts, priorUsd] = await Promise.all([
    mainScan(db, prices, main),
    gapHistogram(db, narrow),
    rhythm2d(db, narrow, q.tzOffsetHours),
    sessionCounts(db, narrow),
    // `all` has no prior window to compare against, and running the query anyway would scan the
    // whole table again to produce a number the UI then refuses to show.
    w.prior.from ? windowTotal(db, priorF) : Promise.resolve(0),
  ]);

  const rows = scan
    .map((r) => ({ ...r, meta: meta.get(r.session_id) }))
    // Session-column filters, applied here rather than in SQL. `meta` is undefined only for a
    // usage row whose session was deleted; such a row can satisfy no session filter, and counting
    // it under an unfiltered view is correct — its tokens were still burned.
    .filter((r) => matchesSessionFilters(r.meta, q));

  const byModel = foldByKey(rows, prices, (r) => r.model ?? null);
  const byBand = foldByKey(rows, prices, (r) => r.band ?? null);
  const bySession = foldByKey(rows, prices, (r) => r.session_id);
  const byAttr = foldByKey(rows, prices, (r) => attributionKey(r, q.by));
  const total = totalOf(byModel);

  // Distinct sessions per model and per depth band, counted over the same rows the dollars came
  // from. A separate COUNT(DISTINCT) query would be a second scan AND could disagree with these
  // totals if the two ever drifted apart on filters.
  const sessionsPerModel = distinctSessions(rows, (r) => r.model ?? null);
  const sessionsPerBand = distinctSessions(rows, (r) => r.band ?? null);
  const sessionsPerAttr = distinctSessions(rows, (r) => attributionKey(r, q.by));

  const cacheUsd = total.byClass.cacheRead + total.byClass.cacheWrite5m + total.byClass.cacheWrite1h;

  return {
    window: w.current,
    ledger: {
      usd: total.usd,
      priorUsd,
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
    depth: DEPTH_BANDS.map((b) => {
      const g = byBand.get(b.label);
      const calls = g?.calls ?? 0;
      return {
        label: b.label,
        calls,
        usdPerCall: calls > 0 ? (g?.usd ?? 0) / calls : 0,
        sessions: sessionsPerBand.get(b.label) ?? 0,
      };
    }),
    gaps,
    attribution: [...byAttr.values()]
      .map((g) => ({
        key: g.key ?? '(none)',
        usd: g.usd,
        calls: g.calls,
        sessions: sessionsPerAttr.get(g.key ?? null) ?? 0,
      }))
      .sort((a, b) => b.usd - a.usd || b.calls - a.calls)
      .slice(0, ATTRIBUTION_LIMIT),
    rhythm,
    models: [...byModel.values()]
      .map((g) => {
        const sessions = sessionsPerModel.get(g.key ?? null) ?? 0;
        return {
          model: g.key ?? UNKNOWN_MODEL_LABEL,
          usd: g.usd,
          calls: g.calls,
          sessions,
          usdPerCall: g.calls > 0 ? g.usd / g.calls : 0,
          callsPerSession: sessions > 0 ? g.calls / sessions : 0,
        };
      })
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MODEL_LIMIT),
    outliers: await topSessions(db, bySession, rows),
  };
}

/** The session-column half of the filter set, applied in memory so the main scan can skip the
 * join. Kept beside `filters()` in behaviour: an unset filter matches everything. */
function matchesSessionFilters(m: SessionMeta | undefined, q: StatsQuery): boolean {
  if (q.harness && m?.harness !== q.harness) return false;
  if (q.project && m?.project_name !== q.project) return false;
  if (q.machine && m?.machine_id !== q.machine) return false;
  return true;
}

const ATTRIBUTION_LIMIT = 12;
const MODEL_LIMIT = 8;

/** The attribution key for a row, chosen in memory so all five dimensions come off one scan. */
function attributionKey(r: MainRow, by: Attribution): string {
  const project = r.meta?.project_name ?? '(no project)';
  if (by === 'project') return project;
  // Branch names are not unique across repos, so a bare `main` would pool every project's trunk
  // work into one row. The composite is the smallest key that does not lie.
  if (by === 'branch') return `${project}@${r.meta?.git_branch ?? '(no branch)'}`;
  if (by === 'model') return r.model ?? UNKNOWN_MODEL_LABEL;
  if (by === 'harness') return r.meta?.harness ?? '(unknown)';
  return r.meta?.machine_id ?? '(web — no machine)';
}

function distinctSessions(rows: MainRow[], key: (r: MainRow) => string | null): Map<string | null, number> {
  const seen = new Map<string | null, Set<string>>();
  for (const r of rows) {
    const k = key(r);
    const set = seen.get(k) ?? new Set<string>();
    set.add(r.session_id);
    seen.set(k, set);
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]));
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
async function topSessions(
  db: D1Database,
  bySession: Map<string | null, PricedGroup>,
  rows: MainRow[],
): Promise<OutlierRow[]> {
  const top = [...bySession.values()].sort((a, b) => b.usd - a.usd).slice(0, OUTLIER_LIMIT);
  const ids = top.map((g) => g.key).filter((k): k is string => k !== null);
  if (!ids.length) return [];
  // Only titles are fetched, and only for the twelve rows actually shown. Carrying
  // `first_interaction_title` through the main scan would attach a long string to every one of its
  // ~32k groups in order to display twelve of them.
  const meta = await db
    .prepare(
      // first_interaction_title (migration 0013) with `title` as fallback: sessions not reparsed
      // since that migration have NULL there, so the fallback is not optional.
      `SELECT session_id, COALESCE(first_interaction_title, title) AS title
       FROM sessions WHERE session_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`,
    )
    .bind(...ids)
    .all<{ session_id: string; title: string | null }>();
  const titles = new Map((meta.results ?? []).map((r) => [r.session_id, r.title]));
  const attrs = new Map(rows.map((r) => [r.session_id, r]));
  return top
    .filter((g) => g.key !== null)
    .map((g) => {
      const r = attrs.get(g.key as string);
      return {
        sessionId: g.key as string,
        title: titles.get(g.key as string) ?? null,
        branch: r?.meta?.git_branch ?? null,
        harness: r?.meta?.harness ?? null,
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
