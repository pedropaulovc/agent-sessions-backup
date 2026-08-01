/** Coercion and validation of LiteLLM's upstream price catalog.
 *
 * Shared verbatim by the unattended cron (src/cron/model-prices.ts) and the manual backfill
 * (scripts/sync-model-prices.mjs). These two implemented the same rules twice and drifted three
 * separate times in one review — `intOrNull` was fixed in the script and missed in the cron, then
 * the negative-rate bound and the catalog guard were each added to one side only. Every such gap
 * silently mispriced or silently stopped tracking upstream, which is the failure mode both paths
 * exist to prevent, so the rules live in exactly one place now.
 *
 * Plain `.mjs` deliberately: the cron is bundled by wrangler (esbuild handles .mjs natively) and
 * the script is run directly by node, and no build step stands between them. Types come from the
 * sibling .d.ts.
 */

const PER_MILLION = 1_000_000;

/** Floor for "this response is the real catalog". LiteLLM ships thousands of entries; set far
 * below that so an ordinary upstream shrink never trips it, and far above the handful a truncated
 * or substituted payload would carry. */
export const MIN_CATALOG_ENTRIES = 100;

/** A per-token rate scaled to per-million, or null if it is not a usable rate.
 *
 * Rejects negatives as well as non-finite values: a negative rate stores fine and prices a row as
 * fully PRICED, producing negative cost_usd that cancels legitimate spend in an aggregate — an
 * undercount with nothing in unpriced_calls to flag it. Zero is legitimate (free models). */
export const perM = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Number((v * PER_MILLION).toPrecision(12)) : null;

/** An integer for a STRICT INTEGER column, or null. Truncates a finite float — a fractional
 * context length is a real limit expressed sloppily — and drops anything that is not a number.
 * Upstream is a community JSON blob, so a TypeScript `as number` there is a compile-time fiction,
 * and D1 rejects the bad value at INSERT time, taking the whole batch with it. */
export const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Throw unless `payload` actually looks like the price catalog.
 *
 * A 200 carrying valid JSON that is not the catalog — `{}`, an error envelope, an HTML error page
 * served as JSON — otherwise sails through: every model resolves to nothing, no prices are
 * written, and the run records success. Prices then silently stop tracking upstream while the sync
 * reports healthy, which is worse than a visible failure. */
export function assertLooksLikeCatalog(payload) {
  const entryCount = payload && typeof payload === 'object' ? Object.keys(payload).length : 0;
  const priced =
    entryCount === 0
      ? 0
      : Object.values(payload).filter(
          (e) => e && typeof e === 'object' && ('input_cost_per_token' in e || 'output_cost_per_token' in e),
        ).length;
  if (entryCount < MIN_CATALOG_ENTRIES || priced === 0) {
    throw new Error(`upstream payload does not look like a price catalog: ${entryCount} entries, ${priced} priced`);
  }
  return entryCount;
}
