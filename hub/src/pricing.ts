/** Cost computation over the `usage` table, priced from the `model_prices` table
 * (populated by scripts/sync-model-prices.mjs from LiteLLM -- ccusage's source).
 *
 * The hub deliberately owns no rate constants. If a model has no row, its rows are
 * reported as unpriced rather than being charged at a guessed rate. */

/** A billing-relevant slice of a `usage` row. */
export interface UsageTokens {
  model: string | null;
  service_tier?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_5m_tokens?: number | null;
  cache_creation_1h_tokens?: number | null;
  /** For a pre-aggregated group: SUM over rows of `max(0, input - cache_read)`, i.e. the
   * subset-accounting clamp already applied per row. Absent for a single row, where deriving
   * it from `input_tokens`/`cache_read_tokens` is exact. See `billableInput` below. */
  fresh_input_tokens?: number | null;
  /** Per-row SUM(MIN(cache_read, input)) for a pre-aggregated group — the min is nonlinear, so it
   * cannot be recomputed from the group's totals. */
  billable_cache_read_tokens?: number | null;
}

export interface ModelPrice {
  model: string;
  effective_from: string;
  provider: string | null;
  input_cost: number | null;
  output_cost: number | null;
  cache_read_cost: number | null;
  cache_write_5m_cost: number | null;
  cache_write_1h_cost: number | null;
  input_cost_batch: number | null;
  output_cost_batch: number | null;
  /** 'unknown' when upstream gave no recognised provider — see migration 0017. A row with cache
   * reads and an unknown convention is refused rather than priced ~2x wrong in either direction. */
  cache_accounting: 'disjoint' | 'subset' | 'unknown';
}

/** Per-class token counts and their dollar cost. `unpriced` is set when no rate was found,
 * so a caller can surface coverage instead of quietly under-reporting spend. */
export interface Cost {
  usd: number;
  unpriced: boolean;
  /** Fresh (non-cached) input actually billed at the input rate. */
  billableInputTokens: number;
  /** Which rate set actually produced `usd`. `batch=1` is a REQUEST, not a guarantee: a model
   * with no published batch tier falls back to its standard rates, and the caller has to know
   * that happened or it will label standard-priced dollars as batch-priced. `none` means
   * nothing was priced. */
  rateSet: 'standard' | 'batch' | 'mixed' | 'none';
  /** The rates this row would actually be charged at, per class, for the classes it HAS.
   *
   * Exists so callers can ask "are these two snapshots interchangeable for this row?" without
   * re-deriving which columns matter — see `priceForGroup` in api/ops.ts. Comparing the scalar
   * `usd` instead is not equivalent: changes in separate classes can cancel out (old input/output
   * rates of 1/3 against new rates of 3/1 total the same when summed input equals summed output),
   * so an aggregate match can hide two genuinely different rate schedules. */
  rateSignature: string;
}

const MILLION = 1_000_000;

/** Candidate upstream keys for a model id, most specific first. Real ids include
 * date-suffixed variants (`claude-haiku-4-5-20251001`) that upstream may or may not carry
 * separately; try every EXACT form (bare and provider-prefixed) before any undated fallback --
 * an undated match is a different model's rate, so it must lose to any exact one. */
export { priceKeyCandidates } from './upstream-catalog.mjs';

/** How a `usage.model` value should be treated for pricing. Three states, not a boolean,
 * because "we know this is not an API call" and "we do not know what this was" have opposite
 * reporting consequences and a boolean collapsed them:
 *
 * - `billable`  — a real model id; price it.
 * - `sentinel`  — `<synthetic>` and friends: Claude Code's stand-in for a response that never
 *                 hit the API. Never priced, and never counted as coverage loss either.
 * - `unknown`   — NULL/empty model on a real usage row (e.g. a Codex `token_count` seen before
 *                 any `turn_context`, where the parser has no `currentModel` yet). These burned
 *                 real tokens at a rate we cannot determine, so they must be reported as
 *                 unpriced rather than silently shown at $0 under a full-coverage claim.
 */
export type ModelPricingClass = 'billable' | 'sentinel' | 'unknown';

export function classifyModel(model: string | null | undefined): ModelPricingClass {
  if (model === null || model === undefined || model === '') return 'unknown';
  return model.startsWith('<') ? 'sentinel' : 'billable';
}

/** Narrowing helper for the common "is this priceable" check. */
export function isBillableModel(model: string | null | undefined): model is string {
  return classifyModel(model) === 'billable';
}

/**
 * Cost of one usage row.
 *
 * The `cache_accounting` distinction is the part that is easy to get wrong. Anthropic
 * reports cache reads DISJOINT from input_tokens, so both are charged. OpenAI/Codex reports
 * cached_input_tokens as a SUBSET of input_tokens, so charging both double-bills the cached
 * portion at the full input rate. Same two columns, opposite arithmetic.
 */
export function costOfUsage(u: UsageTokens, price: ModelPrice | null, opts?: { batch?: boolean }): Cost {
  // Clamp at 0. `usage` has no nonnegative constraint and both parsers store whatever counter a
  // transcript reports, so a negative value would otherwise flow straight into the arithmetic and
  // produce a NEGATIVE cost_usd on a row reported as fully priced. A token count below zero is
  // not a discount; it is corrupt input.
  const nonNegative = (v: number | null | undefined): number => Math.max(0, v ?? 0);
  const input = nonNegative(u.input_tokens);
  const output = nonNegative(u.output_tokens);
  const cacheRead = nonNegative(u.cache_read_tokens);
  const cw5 = nonNegative(u.cache_creation_5m_tokens);
  const cw1h = nonNegative(u.cache_creation_1h_tokens);

  // Under `subset`, the cached tokens are already inside input_tokens; only the remainder is
  // fresh. Clamp at 0 -- a truncated or out-of-order transcript can report cacheRead > input.
  //
  // The clamp is nonlinear, so on a pre-aggregated group it must have been applied per row:
  // clamping the group's SUMs lets one row with cacheRead > input eat fresh input belonging to
  // its neighbours. `fresh_input_tokens` carries that per-row sum when the caller has one.
  const billableInput =
    price?.cache_accounting === 'subset'
      ? nonNegative(u.fresh_input_tokens ?? input - cacheRead)
      : input;

  // Under `subset`, cached tokens are BY DEFINITION part of input_tokens, so the cache-read charge
  // cannot exceed input either. The fresh-input clamp above only protects the subtraction: with
  // input=500 and cache_read=9000 it correctly yields 0 fresh input, but the cache term still
  // billed all 9000 — charging 18x the tokens the row says it used. Clamp both sides.
  //
  // Like the fresh-input clamp this is NONLINEAR, so on a pre-aggregated group it has to have been
  // applied per row; `billable_cache_read_tokens` carries that per-row sum when the caller has
  // one. The raw counter stays untouched for reporting.
  const billableCacheRead =
    price?.cache_accounting === 'subset'
      ? nonNegative(u.billable_cache_read_tokens ?? Math.min(cacheRead, input))
      : cacheRead;

  // `billableInputTokens` is 0 on every unpriced path, never the raw input count. The field's
  // contract is "input actually billed at the input rate", and for an unmatched model we do not
  // know the accounting convention (a subset model's cached prefix would be wrongly included),
  // while a `<synthetic>` row never reached an API at all. Reporting a number there would let a
  // caller sum billable input across rows whose dollars are missing.
  const unpriced: Cost = { usd: 0, unpriced: true, billableInputTokens: 0, rateSet: 'none', rateSignature: 'unpriced' };
  // A row with no matching price but ZERO tokens in every billable class contributes no unknown
  // cost, so it is not "unpriced" in the sense the caller cares about. Counting it inflated
  // unpriced_calls, put its model in unpriced_models, and told clients the total was a floor —
  // all on the strength of a call that could not have cost anything whatever the rate turned out
  // to be. Costed at 0 and priced, so the coverage signal keeps meaning "dollars are missing".
  //
  // BILLABLE cache reads, not raw ones. Under `subset` a row with input=0 and cache_read=5000 has
  // its cache term clamped to zero, so it cannot cost anything whatever the rates are — yet the
  // raw counter made it demand a cache rate (and go unpriced without one) and count as a standard
  // class, which flipped a fully batch-priced response's cost_basis to _partial on a row worth $0.
  const anyBillableTokens = billableInput > 0 || output > 0 || billableCacheRead > 0 || cw5 > 0 || cw1h > 0;
  if (!anyBillableTokens)
    return { usd: 0, unpriced: false, billableInputTokens: 0, rateSet: 'none', rateSignature: 'zero' };
  if (!price) return unpriced;

  // Batch rates are chosen PER CLASS, matching how rates are required per class below. An
  // all-or-nothing check would fall back to standard pricing for an input-only row whose input
  // batch rate is published just because the output batch rate is not — overstating a batch
  // estimate the caller explicitly asked for and could have had.
  const wantBatch = opts?.batch === true;
  const useBatchIn = wantBatch && price.input_cost_batch != null;
  const useBatchOut = wantBatch && price.output_cost_batch != null;
  const inRate = useBatchIn ? price.input_cost_batch : price.input_cost;
  const outRate = useBatchOut ? price.output_cost_batch : price.output_cost;

  // A missing cache READ rate falls back to the input rate: a cache read is never dearer than
  // fresh input, so that direction can only over-report, never quietly under-report.
  // Falls back to the STANDARD input rate, never the batch-selected one. LiteLLM publishes no
  // batch cache columns, so a cache read is standard-priced by construction — and the rateSet
  // calculation below already counts cache classes as standard. Falling back to `inRate` would
  // charge a batch-discounted rate for cache reads while simultaneously labelling them standard.
  const readRate = price.cache_read_cost ?? price.input_cost;

  // A rate is required only for a token class that is actually PRESENT. Upstream routinely
  // publishes partial entries, and discarding a known input cost because `output_cost` happens
  // to be null throws away real, correctly-priceable usage on a row with no output tokens.
  //
  // Cache WRITES additionally get no rate fallback at all. They cost MORE than input --
  // Anthropic charges 1.25x for a 5m write and 2x for a 1h write -- so substituting the input
  // rate (or the 5m rate for a missing 1h rate) invents a cheaper price and reports it as if it
  // were priced.
  // Cache reads with an UNKNOWN accounting convention cannot be priced at all: disjoint bills
  // them on top of input, subset bills them inside it, and picking either way is a silent ~2x
  // error on every cached turn in one direction or the other. Rows with no cache reads are
  // unaffected, so an unrecognised provider only costs pricing where it actually matters.
  //
  // These use the BILLABLE cache count for the same reason `anyBillableTokens` does: a clamped-to-
  // zero cache term costs nothing at any rate, so demanding a rate for it only loses real pricing.
  // (The unknown-accounting arm is unaffected in practice -- the clamp applies only under
  // `subset`, so under an unknown convention billable and raw are the same number -- but it reads
  // off the same value so the two cannot drift apart.)
  if (billableCacheRead > 0 && price.cache_accounting !== 'disjoint' && price.cache_accounting !== 'subset') {
    return unpriced;
  }
  if (billableInput > 0 && inRate == null) return unpriced;
  if (output > 0 && outRate == null) return unpriced;
  if (billableCacheRead > 0 && readRate == null) return unpriced;
  if (cw5 > 0 && price.cache_write_5m_cost == null) return unpriced;
  if (cw1h > 0 && price.cache_write_1h_cost == null) return unpriced;

  const usd =
    (billableInput * (inRate ?? 0) +
      output * (outRate ?? 0) +
      billableCacheRead * (readRate ?? 0) +
      cw5 * (price.cache_write_5m_cost ?? 0) +
      cw1h * (price.cache_write_1h_cost ?? 0)) /
    MILLION;

  // Report what was actually applied to the classes this row HAS. A row with no output tokens
  // is fully batch-priced on its input batch rate alone; one that pays a batch input rate and a
  // standard output rate is genuinely `mixed`, and calling it either pure label would misstate
  // the dollars in exactly the direction the caller is trying to detect.
  // Cache classes count as STANDARD whenever present. LiteLLM publishes no batch cache columns
  // at all, so cache-read and cache-write dollars always come off the standard rates -- a cached
  // call with batch-priced input and output is therefore genuinely `mixed`, and ignoring its cache
  // classes here would label those standard dollars as batch-priced.
  const cacheClassesPresent = billableCacheRead > 0 || cw5 > 0 || cw1h > 0;
  const batchClasses = (billableInput > 0 && useBatchIn ? 1 : 0) + (output > 0 && useBatchOut ? 1 : 0);
  const standardClasses =
    (billableInput > 0 && !useBatchIn ? 1 : 0) + (output > 0 && !useBatchOut ? 1 : 0) + (cacheClassesPresent ? 1 : 0);
  // A row with zero tokens in every billable class produced no dollars from any rate set, so it
  // must not claim one. Reporting 'standard' put it in rateSetsUsed and flipped a fully
  // batch-priced response's cost_basis to _partial on the strength of a row that cost nothing.
  const rateSet: Cost['rateSet'] =
    batchClasses > 0 && standardClasses > 0
      ? 'mixed'
      : batchClasses > 0
        ? 'batch'
        : standardClasses > 0
          ? 'standard'
          : 'none';

  // Only the classes this row HAS, so an unused rate moving cannot make two snapshots differ.
  // `cache_accounting` is included only when there ARE raw cache reads: it decides whether they
  // are billed on top of input or subtracted from it, which changes the token counts and therefore
  // the dollars even when every rate is identical. On a cache-free row it changes nothing.
  const rateSignature = [
    billableInput > 0 ? `i:${inRate}` : '',
    output > 0 ? `o:${outRate}` : '',
    billableCacheRead > 0 ? `r:${readRate}` : '',
    cw5 > 0 ? `w5:${price.cache_write_5m_cost}` : '',
    cw1h > 0 ? `w1:${price.cache_write_1h_cost}` : '',
    cacheRead > 0 ? `a:${price.cache_accounting}` : '',
    `s:${rateSet}`,
  ]
    .filter(Boolean)
    .join('|');

  return { usd, unpriced: false, billableInputTokens: billableInput, rateSet, rateSignature };
}

/** Pick the rate in effect at `ts` from a model's price history (rows newest-first). */
export function priceAt(history: ModelPrice[], ts: string | null | undefined): ModelPrice | null {
  if (!history.length) return null;
  if (!ts) return history[0] ?? null;
  for (const p of history) if (p.effective_from <= ts) return p;
  // Older than any recorded snapshot -- use the earliest known rather than nothing, since a
  // slightly-wrong old rate beats a hole in the chart.
  return history[history.length - 1] ?? null;
}

/** Load every price row, newest-first per model. The table is ~20 models x a few snapshots,
 * so this is one small query rather than a join against `usage`. */
export async function loadPrices(db: D1Database): Promise<Map<string, ModelPrice[]>> {
  const rows = await db
    .prepare(
      `SELECT model, effective_from, provider, input_cost, output_cost, cache_read_cost,
              cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
              cache_accounting
         FROM model_prices ORDER BY model, effective_from DESC`,
    )
    .all<ModelPrice>();
  const byModel = new Map<string, ModelPrice[]>();
  for (const r of rows.results ?? []) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  return byModel;
}
