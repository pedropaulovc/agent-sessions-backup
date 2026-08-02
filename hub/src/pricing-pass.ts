/** Fills in `usage.usd` — the pass that moves pricing off the read path.
 *
 * Costs are computed HERE and stored, rather than in SQL on the way out or in JS on the way in.
 * Both alternatives were rejected for the same reason, and it is worth stating once:
 *
 *   Not in SQL. The arithmetic — cache accounting (disjoint/subset/unknown), the batch tier
 *   fallback, the refusals when a required rate is missing — lives in `costOfUsage`. A SQL copy
 *   would be a second implementation of precisely what `usage-agg.ts` exists to keep single, and
 *   this repo has already paid for that lesson in the price-sync path, where the cron and the
 *   manual script drifted three times in one review.
 *
 *   Not at ingest. Choosing which rate snapshot applies to a turn is `priceEpochExpr`, a SQL
 *   expression with a great deal of hard-won care in it about non-canonical timestamps. Pricing
 *   inside the parser would need that logic again in TypeScript. Reading rows back out through
 *   the same expression costs one extra query and keeps both halves single.
 *
 * So the pass reads rows with the shared SQL fragments, prices them with the shared function, and
 * writes the answer back. Nothing new is implemented; it is a join of two existing pieces.
 *
 * FORWARD PROGRESS. A row can be permanently unpriceable — a model upstream publishes no rate
 * for — and those keep `usd IS NULL` however many times they are examined. Selecting purely on
 * `usd IS NULL` would therefore make the read query return the same rows on every iteration of
 * the loop below, and a backfill with a large budget would spin on the first unpriceable batch
 * until it exhausted that budget instead of advancing. Every attempt stamps `priced_at`, and a
 * run only considers rows not attempted since it started, so each read strictly advances. A
 * LATER run does reconsider them — `priced_at < this run's start` — which is the point:
 * "unpriceable" is a claim about today's catalog, and a rate landing tomorrow should fix them.
 *
 * The ORDER BY is a separate and weaker thing: priority, not correctness. NULL sorts first under
 * ASC, so rows nobody has tried yet are served ahead of retries of known failures. Progress does
 * not depend on it — the WHERE clause above is what guarantees that.
 */
import { classifyModel, costOfUsage, loadPrices, type CostByClass, type ModelPrice } from './pricing';
import {
  priceEpochExpr,
  priceForGroup,
  USAGE_SHAPE_GROUP_BY,
  USAGE_SHAPE_SELECT,
  USAGE_TOKEN_SUMS,
  type UsageAggRow,
} from './usage-agg';

/** What the stored costs were produced by. Bump this whenever the SHAPE of what is stored or the
 * ARITHMETIC that produces it changes, and every row becomes due for re-pricing automatically —
 * the cron and the backfill endpoint work through them at their own pace while each row's existing
 * cost stays readable until the moment it is replaced. The alternative, NULLing a column corpus-
 * wide to force a re-run, makes the statistics page read $0 for as long as the backfill takes.
 *
 * 1 = scalar usd only (migration 0018).
 * 2 = usd plus the five per-class costs (migration 0019).
 */
export const PRICING_VERSION = 2;

/** Rows read per query. Bounded by D1's response size rather than by the parameter cap — the
 * write side chunks separately. */
export const PRICING_READ_BATCH = 500;

/** Rows updated per `db.batch()`. Each statement is one bound UPDATE; the batch is one subrequest
 * against the invocation's budget, which is the resource actually worth conserving. */
export const PRICING_WRITE_BATCH = 100;

export interface PricingPassResult {
  /** Rows examined. Zero means there was nothing to do, which is the steady state. */
  examined: number;
  /** Rows that came out with a dollar figure, including genuine $0. */
  priced: number;
  /** Rows left NULL because no rate could be determined. These are retried by the next run. */
  unpriceable: number;
  /** True when the pass stopped on its row budget rather than because it ran out of work — the
   * signal that a backfill needs another run, as opposed to being done. */
  more: boolean;
}

interface UnpricedRow extends UsageAggRow {
  id: number;
  model: string | null;
}

/** Prices rows whose `usd` is still NULL.
 *
 * `sessionId` scopes it to one session, which is what the ingest path uses so a freshly indexed
 * session shows real dollars immediately instead of NULL until the next nightly run.
 */
export async function priceUsage(
  db: D1Database,
  opts: { sessionId?: string; maxRows?: number; readBatch?: number; now?: Date } = {},
): Promise<PricingPassResult> {
  const startedAt = (opts.now ?? new Date()).toISOString();
  const maxRows = opts.maxRows ?? PRICING_READ_BATCH;
  // Injectable so the loop's re-read behaviour is testable at all: with the production batch
  // size, reaching a second iteration takes 500 seeded rows.
  const readBatch = opts.readBatch ?? PRICING_READ_BATCH;
  const prices = await loadPrices(db);

  const result: PricingPassResult = { examined: 0, priced: 0, unpriceable: 0, more: false };

  while (result.examined < maxRows) {
    const take = Math.min(readBatch, maxRows - result.examined);
    const rows = await selectUnpriced(db, prices, startedAt, opts.sessionId, take);
    if (!rows.length) return result;

    const writes = rows.map((r) => {
      result.examined++;
      const cost = priceOf(r, prices);
      if (cost === null) result.unpriceable++;
      else result.priced++;
      return db
        .prepare(
          `UPDATE usage
              SET usd = ?1, usd_input = ?2, usd_output = ?3, usd_cache_read = ?4,
                  usd_cache_write_5m = ?5, usd_cache_write_1h = ?6,
                  price_epoch = ?7, priced_at = ?8, priced_version = ?9
            WHERE id = ?10`,
        )
        .bind(
          cost?.usd ?? null,
          cost?.byClass.input ?? null,
          cost?.byClass.output ?? null,
          cost?.byClass.cacheRead ?? null,
          cost?.byClass.cacheWrite5m ?? null,
          cost?.byClass.cacheWrite1h ?? null,
          r.epoch,
          startedAt,
          PRICING_VERSION,
          r.id,
        );
    });

    for (let i = 0; i < writes.length; i += PRICING_WRITE_BATCH) {
      await db.batch(writes.slice(i, i + PRICING_WRITE_BATCH));
    }
    // A short read means the query ran out of rows, not that the budget ran out. Distinguishing
    // them is the whole value of `more`: a caller that re-runs on `more` would otherwise loop
    // forever against a corpus that is fully priced.
    if (rows.length < take) return result;
  }

  result.more = true;
  return result;
}

/** The dollar figure to store, or null to leave the row unpriced.
 *
 * `sentinel` models — `<synthetic>` and friends — are stored as a real 0, not as NULL. They never
 * hit an API, so zero IS their cost; leaving them NULL would park them in the unpriced index
 * forever and, worse, report them as pricing coverage we failed to achieve.
 */
function priceOf(r: UnpricedRow, prices: Map<string, ModelPrice[]>): StoredCost | null {
  const modelClass = classifyModel(r.model);
  if (modelClass === 'sentinel') return ZERO_COST;
  if (modelClass !== 'billable') return null;

  const price = priceForGroup(prices.get(r.model as string) ?? [], String(r.epoch), r, false);
  const cost = costOfUsage(r, price, { batch: false });
  return cost.unpriced ? null : { usd: cost.usd, byClass: cost.byClass };
}

interface StoredCost {
  usd: number;
  byClass: CostByClass;
}

/** A sentinel model's cost, as a fresh object per read so no caller can mutate a shared one. */
const ZERO_COST: StoredCost = Object.freeze({
  usd: 0,
  byClass: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }),
}) as StoredCost;

/** One row per `usage` row, carrying the shape flags and clamped token sums the shared fragments
 * define.
 *
 * `GROUP BY u.id` is what makes that reuse possible: the fragments are written for a group that
 * could have been a single call, and grouping on the primary key produces exactly that — a group
 * of one — so the per-row clamps and the class-presence booleans apply verbatim rather than being
 * re-derived here for the single-row case.
 */
async function selectUnpriced(
  db: D1Database,
  prices: Map<string, ModelPrice[]>,
  startedAt: string,
  sessionId: string | undefined,
  limit: number,
): Promise<UnpricedRow[]> {
  const binds: unknown[] = [startedAt, PRICING_VERSION];
  const scope = sessionId ? `AND u.session_id = ?${binds.push(sessionId)}` : '';
  // Three ways to be due, and they are not the same question:
  //   priced_version IS NULL  never priced at all.
  //   priced_version < ?2     priced by an older shape or an older arithmetic -- the repricing
  //                           path, which is what makes a constant bump sufficient.
  //   usd IS NULL             priced, and the answer was "no rate". Kept separate from the version
  //                           check because such a row IS at the current version and would
  //                           otherwise never be looked at again -- but "unpriceable" is a claim
  //                           about the catalog on the day it was made, and catalogs gain models.
  // The priced_at clause is orthogonal to all three: it is what stops a run re-reading rows it has
  // already attempted this pass. See the module comment.
  const rows = await db
    .prepare(
      `SELECT u.id AS id, u.model AS model, ${priceEpochExpr(prices)} AS epoch,
              ${USAGE_SHAPE_SELECT}, ${USAGE_TOKEN_SUMS}
         FROM usage u
        WHERE (u.priced_version IS NULL OR u.priced_version < ?2 OR u.usd IS NULL)
          AND (u.priced_at IS NULL OR u.priced_at < ?1) ${scope}
        GROUP BY u.id, u.model, epoch, ${USAGE_SHAPE_GROUP_BY}
        ORDER BY u.priced_at, u.id
        LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<UnpricedRow>();
  return rows.results ?? [];
}
