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
export const intOrNull = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  // Finite is not enough: 1e100 is finite, survives Math.trunc, and is still far outside the
  // range SQLite will store in a STRICT INTEGER column -- so it fails the INSERT and, because the
  // snapshots go out in one batch(), takes every model's price down with it. Bound it.
  return Number.isSafeInteger(n) ? n : null;
};

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

/** Strip a trailing `-YYYYMMDD` release stamp, but ONLY when it is a real calendar date.
 *
 * A bare `\d{8}` match treats any eight trailing digits as a date, so an unmatched or custom model
 * like `gpt-5-99999999` falls back to the real `gpt-5` catalog entry and receives a confident
 * price instead of appearing in unpriced_models. Parsers accept arbitrary non-empty model strings,
 * so this has to validate rather than assume. Rolling dates (`-20260231`) are rejected too:
 * Date.UTC would silently normalise Feb 31 to Mar 3 and call it valid.
 */
export function undatedModel(model) {
  const m = /-(\d{4})(\d{2})(\d{2})$/.exec(model);
  if (!m) return model;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return model;
  return model.slice(0, m.index);
}

/** Upstream keys to try for a model id, best match first. Shared by pricing.ts, the cron and the
 * manual script -- three copies of this drifted apart once already. */
/** Own-property lookup for a candidate key.
 *
 * `upstream['constructor']` (or 'toString', '__proto__', …) is TRUTHY on any plain object, so a
 * bare `upstream[c]` read resolves those model names to an inherited function and then treats it
 * as a price entry. Model ids come from transcripts and are arbitrary strings, so this is
 * reachable input, not a theoretical one.
 */
export function lookupEntry(catalog, key) {
  return Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

export function priceKeyCandidates(model) {
  const out = [model];
  const undated = undatedModel(model);
  if (undated !== model) out.push(undated);
  for (const p of ['anthropic', 'openai', 'deepseek']) {
    out.push(`${p}/${model}`);
    if (undated !== model) out.push(`${p}/${undated}`);
  }
  return out;
}

/** Providers whose cache-read convention is actually KNOWN. Anything absent yields 'unknown'.
 *
 * Guessing here is a silent ~2x error on every cached turn — disjoint bills cache reads on top of
 * input, subset bills them inside it — and the row still reports as priced, so nothing downstream
 * can notice. See migration 0017. `litellm_provider` is community JSON typed `unknown`, so it is
 * validated as a string rather than cast: a number or object there would otherwise be bound
 * straight into a STRICT TEXT column and fail the whole batch.
 */
const CACHE_ACCOUNTING_BY_PROVIDER = {
  anthropic: 'disjoint',
  openai: 'subset',
  azure: 'subset',
  deepseek: 'subset',
};

/** The provider string, or null if upstream gave something that is not a usable string. */
export function providerOf(entry) {
  const v = entry?.['litellm_provider'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function cacheAccountingFor(provider) {
  return CACHE_ACCOUNTING_BY_PROVIDER[provider ?? ''] ?? 'unknown';
}
