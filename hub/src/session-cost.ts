/** Per-session cost: the stored subtotal on `sessions`, its subagent rollup, and its per-model split.
 *
 * Three readers and two writers share this file so the same question cannot be answered two ways:
 *
 *   * the session list shows cost INCLUDING subagents, and can sort by it (viewer/search.ts)
 *   * the session detail page shows the same total plus a per-model breakdown (viewer/session.ts)
 *   * the ingest write path and the pricing pass keep the stored subtotal current
 *
 * `sessions.cost_usd` / `cost_calls` / `cost_priced_calls` are a cache of `usage`; migration 0028
 * explains why they exist (sorting a whole archive by cost otherwise scans `usage` on every page
 * load) and why the refresh is per session rather than a trigger.
 *
 * Everything here keeps 0 and unknown apart, the same way `usage.usd` does: a session with no
 * priced usage rows has NO known subtotal, which is not the same as having cost nothing.
 */
import { loadPrices } from './pricing';
import { UNKNOWN_MODEL_LABEL, USAGE_TOKEN_SUMS } from './usage-agg';

/** A dollar subtotal together with what it is a subtotal OF.
 *
 * `usd` is null when nothing in scope carries a stored cost, and a lower bound whenever
 * `pricedCalls < calls`. Callers must not present it as a total without checking both. */
export interface CostTotals {
  usd: number | null;
  calls: number;
  pricedCalls: number;
}

/** One session's cost with its subagent descendants folded in. */
export interface SubtreeCost extends CostTotals {
  /** Descendant sessions linked by `parent_session_id`, at any depth. Excludes the root. */
  subagentSessions: number;
}

/** Columns a caller must select to read a session's OWN stored subtotal. */
export const SESSION_COST_COLUMNS = 'cost_usd, cost_calls, cost_priced_calls';

/** Ids per refresh statement. D1 caps a statement at 100 bound parameters; 90 matches the chunk
 * size the ingest path already uses for row inserts. */
const REFRESH_CHUNK = 90;

/** Recompute the stored subtotal for the named sessions, as a statement the caller can place in
 * its own batch.
 *
 * The ingest path appends the single-session form to the batch that upserts the session row, so
 * the write that changes a session's usage rows and the write that records their cost land
 * together — a re-indexed session is never readable with the subtotal of its previous shape.
 *
 * Three correlated subqueries rather than a grouped scan: each is an index seek on
 * `usage_session`, and — unlike a join against an aggregate — they still produce the right answer
 * when the session's last usage row has just been DELETED, which is exactly what a shrinking
 * re-parse does. A grouped form would leave such a session at its stale nonzero subtotal forever,
 * because it has no aggregate row to join to.
 */
export function refreshSessionCostStatement(db: D1Database, sessionIds: readonly string[]): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE sessions
          SET cost_usd = (SELECT SUM(u.usd) FROM usage u WHERE u.session_id = sessions.session_id),
              cost_calls = (SELECT COUNT(*) FROM usage u WHERE u.session_id = sessions.session_id),
              cost_priced_calls = (SELECT COUNT(u.usd) FROM usage u WHERE u.session_id = sessions.session_id)
        WHERE session_id IN (${sessionIds.map((_, i) => `?${i + 1}`).join(', ')})`,
    )
    .bind(...sessionIds);
}

/** Recompute the stored subtotal for many sessions, in one batch of chunked statements.
 *
 * Used by the pricing pass, whose whole job is filling `usage.usd`: without this the list and
 * detail pages would keep showing a session as unpriced until something re-ingested it. */
export async function refreshSessionCosts(db: D1Database, sessionIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += REFRESH_CHUNK) {
    statements.push(refreshSessionCostStatement(db, ids.slice(i, i + REFRESH_CHUNK)));
  }
  await db.batch(statements);
}

/** The CTE list that rolls each root's own stored subtotal up with its subagent descendants'.
 *
 * Returns the definitions for a `WITH RECURSIVE` prefix, exposing
 * `session_subtree_cost(session_id, usd, calls, priced_calls, subagent_sessions)`. Composed as SQL
 * rather than run here because the list page's cost sort has to ORDER BY the rolled-up figure
 * across every matching session, which a JS-side rollup cannot do.
 *
 * `rootsSql` must yield a `session_id` column. Reads `sessions` only — never `usage` — which is
 * the entire point of storing the subtotal on the row.
 *
 * `UNION`, not `UNION ALL`: `parent_session_id` carries no foreign key and no acyclicity
 * guarantee (a parser can link a session to itself, and a session deleted and re-ingested under a
 * changed parent can close a loop), so the dedupe is what stops the recursion rather than an
 * assumption about the data. It also makes `COUNT(*) - 1` an exact descendant count.
 */
export function subtreeCostCte(rootsSql: string): string {
  return `session_cost_tree(root, node) AS (
             SELECT session_id, session_id FROM (${rootsSql})
             UNION
             SELECT t.root, s.session_id
               FROM sessions s JOIN session_cost_tree t ON s.parent_session_id = t.node
           ),
           session_subtree_cost AS (
             SELECT t.root AS session_id,
                    SUM(n.cost_usd) AS usd,
                    SUM(n.cost_calls) AS calls,
                    SUM(n.cost_priced_calls) AS priced_calls,
                    COUNT(*) - 1 AS subagent_sessions
               FROM session_cost_tree t JOIN sessions n ON n.session_id = t.node
              GROUP BY t.root
           )`;
}

/** Row shape `session_subtree_cost` produces. */
export interface SubtreeCostRow {
  session_id: string;
  usd: number | null;
  calls: number | null;
  priced_calls: number | null;
  subagent_sessions: number | null;
}

export function subtreeCostOf(row: SubtreeCostRow): SubtreeCost {
  return {
    usd: row.usd === null ? null : Number(row.usd),
    calls: Number(row.calls ?? 0),
    pricedCalls: Number(row.priced_calls ?? 0),
    subagentSessions: Number(row.subagent_sessions ?? 0),
  };
}

/** Subagent-inclusive cost for a bounded set of sessions — the page currently being rendered.
 *
 * Chunked on the same parameter budget as the refresh. A session id with no `sessions` row is
 * absent from the result rather than present as a zero. */
export async function sessionSubtreeCosts(
  db: D1Database,
  sessionIds: readonly string[],
): Promise<Map<string, SubtreeCost>> {
  const ids = [...new Set(sessionIds)];
  const costs = new Map<string, SubtreeCost>();
  if (!ids.length) return costs;
  for (let i = 0; i < ids.length; i += REFRESH_CHUNK) {
    const chunk = ids.slice(i, i + REFRESH_CHUNK);
    const roots = `SELECT session_id FROM sessions WHERE session_id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`;
    const rows = await db
      .prepare(`WITH RECURSIVE ${subtreeCostCte(roots)} SELECT * FROM session_subtree_cost`)
      .bind(...chunk)
      .all<SubtreeCostRow>();
    for (const row of rows.results ?? []) costs.set(row.session_id, subtreeCostOf(row));
  }
  return costs;
}

/** Which counter a provider's `cache_read_tokens` is measured against.
 *
 * `subset` (OpenAI family) reports cached tokens as part of `input_tokens`; `disjoint` (Anthropic)
 * reports them alongside it. The same two columns therefore imply different totals, so a cached
 * share computed without knowing which convention applies is wrong by roughly the cache ratio
 * itself. `unknown` means no published convention for the model — reported as unavailable, never
 * guessed, for the same reason `costOfUsage` refuses to price such a row. */
export type CacheBasis = 'subset' | 'disjoint' | 'unknown';

/** One model's activity inside a session: tokens reported, dollars stored, cache share. */
export interface ModelCost {
  /** Display label; `(unknown)` for a usage row with no model. */
  model: string;
  calls: number;
  pricedCalls: number;
  /** Priced rows whose five-way split predates the stored breakdown and is still NULL. */
  staleBreakdownCalls: number;
  usd: number | null;
  /** Stored per-class dollars. Null when no priced row in the group carries a split yet. */
  byClass: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
  basis: CacheBasis;
  /** Cached share of the prompt tokens this model was sent, or null when unmeasurable. */
  cacheHitRate: number | null;
}

interface ModelCostRow {
  model: string | null;
  calls: number;
  priced_calls: number;
  stale_breakdown_calls: number;
  usd: number | null;
  usd_input: number | null;
  usd_output: number | null;
  usd_cache_read: number | null;
  usd_cache_write_5m: number | null;
  usd_cache_write_1h: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  billable_cache_read_tokens: number;
}

/** Per-model cost and token breakdown for one session, ranked by known cost then by activity.
 *
 * Grouped by model alone. The rate epoch and token-shape dimensions `usage-agg.ts` defines exist
 * so a group can be PRICED as one call; these rows sum costs that were already priced per row at
 * write time, so `SUM` is exact over any grouping and the fan-out buys nothing.
 *
 * `USAGE_TOKEN_SUMS` is reused verbatim for the token columns because its two nonlinear per-row
 * clamps are needed here too: `billable_cache_read_tokens` is `SUM(MIN(cache_read, input))`, which
 * is what keeps a subset-accounting cache share from exceeding 100% on a row whose reported
 * counters disagree with each other.
 */
export async function sessionModelCosts(db: D1Database, sessionId: string): Promise<ModelCost[]> {
  const rows = await db
    .prepare(
      `SELECT u.model AS model,
              COUNT(u.usd) AS priced_calls,
              SUM(u.usd) AS usd,
              SUM(u.usd_input) AS usd_input,
              SUM(u.usd_output) AS usd_output,
              SUM(u.usd_cache_read) AS usd_cache_read,
              SUM(u.usd_cache_write_5m) AS usd_cache_write_5m,
              SUM(u.usd_cache_write_1h) AS usd_cache_write_1h,
              SUM(CASE WHEN u.usd IS NOT NULL AND u.usd_input IS NULL THEN 1 ELSE 0 END)
                AS stale_breakdown_calls,
              ${USAGE_TOKEN_SUMS}
         FROM usage u
        WHERE u.session_id = ?1
        GROUP BY u.model`,
    )
    .bind(sessionId)
    .all<ModelCostRow>();
  const groups = rows.results ?? [];
  if (!groups.length) return [];

  const basis = await cacheBases(db, groups.map((r) => r.model));
  return groups
    .map((r) => {
      const modelBasis = basis.get(r.model) ?? 'unknown';
      const cacheRead = Number(r.cache_read_tokens);
      const input = Number(r.input_tokens);
      // Under subset accounting the cached tokens are already inside `input`, so the denominator
      // is `input` itself and the numerator is clamped against it per row. Under disjoint
      // accounting they are additional, so the prompt is the sum of the two.
      const cached = modelBasis === 'subset' ? Number(r.billable_cache_read_tokens) : cacheRead;
      const prompt = modelBasis === 'subset' ? input : input + cacheRead;
      return {
        model: r.model ?? UNKNOWN_MODEL_LABEL,
        calls: Number(r.calls),
        pricedCalls: Number(r.priced_calls),
        staleBreakdownCalls: Number(r.stale_breakdown_calls),
        usd: r.usd === null ? null : Number(r.usd),
        byClass:
          r.usd_input === null
            ? null
            : {
                input: Number(r.usd_input),
                output: Number(r.usd_output ?? 0),
                cacheRead: Number(r.usd_cache_read ?? 0),
                cacheWrite5m: Number(r.usd_cache_write_5m ?? 0),
                cacheWrite1h: Number(r.usd_cache_write_1h ?? 0),
              },
        tokens: {
          input,
          output: Number(r.output_tokens),
          reasoning: Number(r.reasoning_tokens),
          cacheRead,
          cacheWrite5m: Number(r.cache_creation_5m_tokens),
          cacheWrite1h: Number(r.cache_creation_1h_tokens),
        },
        basis: modelBasis,
        cacheHitRate: modelBasis === 'unknown' || prompt <= 0 ? null : cached / prompt,
      };
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.calls - a.calls || a.model.localeCompare(b.model));
}

/** The cache-accounting convention for each model, or `unknown` where it cannot be established.
 *
 * Read from the price snapshots the model actually has, and reported as `unknown` when they
 * DISAGREE as well as when they say so. A model whose convention was corrected mid-history (the
 * sync stores a new snapshot when `provider` changes — see cron/model-prices.ts) has no single
 * answer for a session-wide share, and picking the newest would silently restate older turns
 * under a convention they were not billed by.
 */
async function cacheBases(db: D1Database, models: ReadonlyArray<string | null>): Promise<Map<string | null, CacheBasis>> {
  const bases = new Map<string | null, CacheBasis>();
  const wanted = [...new Set(models)].filter((m): m is string => !!m && !m.startsWith('<'));
  if (!wanted.length) return bases;
  const prices = await loadPrices(db);
  for (const model of wanted) {
    const history = prices.get(model) ?? [];
    const distinct = new Set(history.map((p) => p.cache_accounting));
    const only = distinct.size === 1 ? [...distinct][0] : undefined;
    bases.set(model, only === 'subset' || only === 'disjoint' ? only : 'unknown');
  }
  return bases;
}
