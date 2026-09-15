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
import type { CacheBasis } from './cache-basis';
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

/** The chunked refresh statements for many sessions, for the caller to place in its OWN batch.
 *
 * Statements, not an awaited batch: the pricing pass appends these to the batch that writes
 * `usage.usd`, so a refresh failure rolls the price writes back with it. Issued afterwards
 * instead, a failed refresh would leave rows stamped `priced_version = PRICING_VERSION` — which
 * `selectUnpriced` skips forever — against a session still showing its pre-pricing subtotal.
 *
 * One statement per 90 ids; a D1 batch is one subrequest however many statements it holds, so
 * chunking costs nothing beyond the extra statements. */
export function refreshSessionCostStatements(db: D1Database, sessionIds: Iterable<string>): D1PreparedStatement[] {
  const ids = [...new Set(sessionIds)];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += REFRESH_CHUNK) {
    statements.push(refreshSessionCostStatement(db, ids.slice(i, i + REFRESH_CHUNK)));
  }
  return statements;
}

/** The recursive walk down `parent_session_id`, exposing `session_cost_tree(root, node)`: every
 * root paired with itself and with each of its subagent descendants.
 *
 * `rootsSql` must yield a `session_id` column. Reads `sessions` only — never `usage` — which is
 * the entire point of storing the cost subtotal on the row.
 *
 * `UNION`, not `UNION ALL`: `parent_session_id` carries no foreign key and no acyclicity
 * guarantee (a parser can link a session to itself, and a session deleted and re-ingested under a
 * changed parent can close a loop), so the dedupe is what stops the recursion rather than an
 * assumption about the data. It also makes `COUNT(*) - 1` an exact descendant count, and keeps a
 * join from `node` onto another table from multiplying that table's rows.
 */
export function subtreeMembersCte(rootsSql: string): string {
  return `session_cost_tree(root, node) AS (
             SELECT session_id, session_id FROM (${rootsSql})
             UNION
             SELECT t.root, s.session_id
               FROM sessions s JOIN session_cost_tree t ON s.parent_session_id = t.node
           )`;
}

/** The CTE list that rolls each root's own stored subtotal up with its subagent descendants'.
 *
 * Returns the definitions for a `WITH RECURSIVE` prefix, exposing
 * `session_subtree_cost(session_id, usd, calls, priced_calls, subagent_sessions)`. Composed as SQL
 * rather than run here because the list page's cost sort has to ORDER BY the rolled-up figure
 * across every matching session, which a JS-side rollup cannot do.
 */
export function subtreeCostCte(rootsSql: string): string {
  return `${subtreeMembersCte(rootsSql)},
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

/** What a rendered cached share is a share OF, as a DISPLAY state rather than a stored value.
 *
 * The stored value is `usage.cache_basis`, recorded per row from the transcript source rather
 * than from the provider API (src/cache-basis.ts explains why those differ). One model can
 * therefore hold rows of both conventions inside one subtree — the same model recorded by an OMP
 * sidecar and by a Codex session — which is `mixed`: each group is folded under its own
 * arithmetic, so the share is still exact, but no single sentence says what it is a share of.
 * `unknown` is a row whose harness has no defensible convention; its counters are left out of the
 * share entirely, for the same reason `costOfUsage` refuses to price such a row. */
export type ModelCacheBasis = CacheBasis | 'mixed' | 'unknown';

/** Token counters as reported, summed over a set of `usage` rows. */
export interface ModelTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** One model's activity inside a session SUBTREE: tokens reported, dollars stored, cache share.
 *
 * Subtree, not session: an agent harness spends most of its money in subagents, so a model that
 * only ever ran in one — a `-luna` fan-out under a Claude parent, say — is precisely the row a
 * reader came for, and scoping this to the parent's own `usage` rows hid it while the header
 * figure above already counted its dollars. `own` keeps the parent's own share separable. */
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
  tokens: ModelTokens;
  /** Sessions in the subtree that reported this model, the rendered one included. */
  sessions: number;
  /** The rendered session's own share, or null when only its subagents used the model. */
  own: { calls: number; tokens: ModelTokens } | null;
  basis: ModelCacheBasis;
  /** Cached share of the prompt tokens this model was sent, or null when unmeasurable. */
  cacheHitRate: number | null;
}

interface ModelCostRow {
  model: string | null;
  /** 1 for the rendered session's own rows, 0 for its subagents'. */
  is_own: number;
  /** The convention this group's counters were recorded under; NULL when none applies. */
  cache_basis: CacheBasis | null;
  sessions: number;
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

/** A model's running totals across the scopes and conventions SQL returns for it. */
interface ModelAcc extends Omit<ModelCost, 'model' | 'basis' | 'cacheHitRate'> {
  /** Raw `usage.model`, NULL included, so the display label is never the map key. */
  key: string | null;
  /** The cached share's two halves, each already folded under its own group's convention. */
  cached: number;
  prompt: number;
  /** Every `cache_basis` seen for this model, NULL included: one value means one answer. */
  bases: Set<CacheBasis | null>;
}

/** Per-model cost and token breakdown for a session and its subagents, ranked by known cost then
 * by activity.
 *
 * Grouped by model, by scope (own rows vs subagents'), and by cache-accounting convention. The
 * rate epoch and token-shape dimensions `usage-agg.ts` defines exist so a group can be PRICED as
 * one call; these rows sum costs that were already priced per row at write time, so `SUM` is
 * exact over any grouping and the fan-out buys nothing. The scope split is not for pricing either
 * — it is what lets the page still report the parent's own spend under rows that now include its
 * subagents'.
 *
 * `u.cache_basis` IS in the GROUP BY for a different reason: it is what makes each group's cache
 * arithmetic valid. `USAGE_TOKEN_SUMS` applies two nonlinear per-row clamps —
 * `billable_cache_read_tokens` is `SUM(MIN(cache_read, input))` — and one model's rows can carry
 * both conventions (an OMP sidecar and a Codex session recording the same model). Summing those
 * rows together would fold a clamped subset numerator into a disjoint denominator, which is the
 * whole class of error this column was added to end.
 */
export async function sessionModelCosts(db: D1Database, sessionId: string): Promise<ModelCost[]> {
  const rows = await db
    .prepare(
      `WITH RECURSIVE ${subtreeMembersCte('SELECT ?1 AS session_id')},
            model_sessions AS (
              SELECT u.model AS model, COUNT(DISTINCT u.session_id) AS sessions
                FROM usage u
                JOIN session_cost_tree t ON t.node = u.session_id
               GROUP BY u.model
            )
       SELECT u.model AS model,
              (u.session_id = ?1) AS is_own,
              u.cache_basis AS cache_basis,
              -- Counted per MODEL, outside the group key, and therefore constant across a model's
              -- groups (MAX picks that one value). Adding up per-group distinct counts was exact
              -- while the scope flag was the only extra dimension, because it is a function of
              -- session_id and the groups' session sets were therefore disjoint. The accounting
              -- convention is not: one session holding rows of both would be counted twice.
              MAX(ms.sessions) AS sessions,
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
         JOIN session_cost_tree t ON t.node = u.session_id
         JOIN model_sessions ms ON ms.model IS u.model
        GROUP BY u.model, is_own, u.cache_basis`,
    )
    .bind(sessionId)
    .all<ModelCostRow>();
  const groups = rows.results ?? [];
  if (!groups.length) return [];

  // Up to six groups per model — two scopes by three conventions, NULL included — folded here
  // rather than in SQL because merging them has to keep null meaning "no stored figure in this
  // group" instead of collapsing it to zero dollars.
  const accs = new Map<string | null, ModelAcc>();
  for (const r of groups) {
    const acc = accs.get(r.model) ?? newModelAcc(r.model);
    acc.calls += Number(r.calls);
    acc.pricedCalls += Number(r.priced_calls);
    acc.staleBreakdownCalls += Number(r.stale_breakdown_calls);
    acc.usd = addUsd(acc.usd, r.usd === null ? null : Number(r.usd));
    acc.byClass = addByClass(acc.byClass, r);
    acc.sessions = Number(r.sessions); // Per model, not per group: assigned, deliberately not summed.
    acc.bases.add(r.cache_basis);
    addCacheShare(acc, r);
    addTokens(acc.tokens, r);
    if (r.is_own) {
      acc.own = acc.own ?? { calls: 0, tokens: zeroTokens() };
      acc.own.calls += Number(r.calls);
      addTokens(acc.own.tokens, r);
    }
    accs.set(r.model, acc);
  }

  return [...accs.values()]
    .map(({ key, cached, prompt, bases, ...acc }) => ({
      ...acc,
      model: key ?? UNKNOWN_MODEL_LABEL,
      basis: resolveBasis(bases),
      // A positive denominator is the only condition left: the convention comes from the rows
      // themselves rather than from a price snapshot, so a model with no price row at all still
      // has a measurable share. A zero denominator stays NULL — nothing measured, which the page
      // must not render as a 0% hit rate.
      cacheHitRate: prompt > 0 ? cached / prompt : null,
    }))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.calls - a.calls || a.model.localeCompare(b.model));
}

function zeroTokens(): ModelTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

function newModelAcc(key: string | null): ModelAcc {
  return {
    key,
    calls: 0,
    pricedCalls: 0,
    staleBreakdownCalls: 0,
    usd: null,
    byClass: null,
    tokens: zeroTokens(),
    sessions: 0,
    own: null,
    cached: 0,
    prompt: 0,
    bases: new Set(),
  };
}

function addTokens(into: ModelTokens, row: ModelCostRow): void {
  into.input += Number(row.input_tokens);
  into.output += Number(row.output_tokens);
  into.reasoning += Number(row.reasoning_tokens);
  into.cacheRead += Number(row.cache_read_tokens);
  into.cacheWrite5m += Number(row.cache_creation_5m_tokens);
  into.cacheWrite1h += Number(row.cache_creation_1h_tokens);
}

/** Null is "nothing in scope carried a stored cost", which is NOT zero dollars: merging an
 * unpriced scope into a priced one leaves the priced total unchanged, and merging two unpriced
 * scopes stays unknown rather than becoming free. */
function addUsd(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function addByClass(into: ModelCost['byClass'], row: ModelCostRow): ModelCost['byClass'] {
  if (row.usd_input === null) return into;
  const add = {
    input: Number(row.usd_input),
    output: Number(row.usd_output ?? 0),
    cacheRead: Number(row.usd_cache_read ?? 0),
    cacheWrite5m: Number(row.usd_cache_write_5m ?? 0),
    cacheWrite1h: Number(row.usd_cache_write_1h ?? 0),
  };
  if (!into) return add;
  return {
    input: into.input + add.input,
    output: into.output + add.output,
    cacheRead: into.cacheRead + add.cacheRead,
    cacheWrite5m: into.cacheWrite5m + add.cacheWrite5m,
    cacheWrite1h: into.cacheWrite1h + add.cacheWrite1h,
  };
}

/** The cached share's numerator and denominator, each under the convention ITS OWN group carries.
 *
 * Under subset accounting the cached tokens are already inside `input`, so the denominator is
 * `input` itself and the numerator is the per-row clamped `SUM(MIN(cache_read, input))`: a row
 * whose reported cached count exceeds its own input would otherwise push the share past 100%.
 * Those sources report no cache CREATION at all (the columns are 0), so there is no write term to
 * add — and adding one would double-count if a source ever folded writes into input.
 *
 * Under disjoint accounting the reads AND the writes are reported in addition to `input`, and a
 * written token is a prompt token that MISSED: leaving the writes out of the denominator reported
 * a session that rebuilt 2.3M tokens of cache as a 100% hit.
 *
 * A NULL basis contributes to NEITHER half. Its counters are unusable without knowing which
 * counter the reads were measured against, and the two answers differ by roughly the cache ratio
 * itself, so the row is excluded rather than guessed into a plausible number. */
function addCacheShare(acc: ModelAcc, row: ModelCostRow): void {
  if (row.cache_basis === 'subset') {
    acc.cached += Number(row.billable_cache_read_tokens);
    acc.prompt += Number(row.input_tokens);
    return;
  }
  if (row.cache_basis !== 'disjoint') return;
  acc.cached += Number(row.cache_read_tokens);
  acc.prompt +=
    Number(row.input_tokens) +
    Number(row.cache_read_tokens) +
    Number(row.cache_creation_5m_tokens) +
    Number(row.cache_creation_1h_tokens);
}

/** One convention, or the honest name for more than one.
 *
 * A model with rows under both conventions still has an exact share — each group was folded under
 * its own arithmetic above — but no single description of what the share is OF, so it is reported
 * as `mixed` instead of borrowing one convention's wording. A NULL alongside a real basis is that
 * same situation with one group left out of the ratio entirely, which is equally not "this model
 * is disjoint". Only a model whose every row is unclassified is `unknown`. */
function resolveBasis(bases: ReadonlySet<CacheBasis | null>): ModelCacheBasis {
  if (bases.size === 1) return [...bases][0] ?? 'unknown';
  return 'mixed';
}
