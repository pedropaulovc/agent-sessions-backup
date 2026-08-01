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
  cache_accounting: 'disjoint' | 'subset';
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
}

const MILLION = 1_000_000;

/** Candidate upstream keys for a model id, most specific first. Real ids include
 * date-suffixed variants (`claude-haiku-4-5-20251001`) that upstream may or may not carry
 * separately; try exact first, then the undated family, then provider-prefixed forms. */
export function priceKeyCandidates(model: string): string[] {
  const out = [model];
  const undated = model.replace(/-\d{8}$/, '');
  if (undated !== model) out.push(undated);
  for (const p of ['anthropic', 'openai', 'deepseek']) {
    out.push(`${p}/${model}`);
    if (undated !== model) out.push(`${p}/${undated}`);
  }
  return out;
}

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

  // `billableInputTokens` is 0 on every unpriced path, never the raw input count. The field's
  // contract is "input actually billed at the input rate", and for an unmatched model we do not
  // know the accounting convention (a subset model's cached prefix would be wrongly included),
  // while a `<synthetic>` row never reached an API at all. Reporting a number there would let a
  // caller sum billable input across rows whose dollars are missing.
  const unpriced: Cost = { usd: 0, unpriced: true, billableInputTokens: 0, rateSet: 'none' };
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
  const readRate = price.cache_read_cost ?? inRate;

  // A rate is required only for a token class that is actually PRESENT. Upstream routinely
  // publishes partial entries, and discarding a known input cost because `output_cost` happens
  // to be null throws away real, correctly-priceable usage on a row with no output tokens.
  //
  // Cache WRITES additionally get no rate fallback at all. They cost MORE than input --
  // Anthropic charges 1.25x for a 5m write and 2x for a 1h write -- so substituting the input
  // rate (or the 5m rate for a missing 1h rate) invents a cheaper price and reports it as if it
  // were priced.
  if (billableInput > 0 && inRate == null) return unpriced;
  if (output > 0 && outRate == null) return unpriced;
  if (cacheRead > 0 && readRate == null) return unpriced;
  if (cw5 > 0 && price.cache_write_5m_cost == null) return unpriced;
  if (cw1h > 0 && price.cache_write_1h_cost == null) return unpriced;

  const usd =
    (billableInput * (inRate ?? 0) +
      output * (outRate ?? 0) +
      cacheRead * (readRate ?? 0) +
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
  const cacheClassesPresent = cacheRead > 0 || cw5 > 0 || cw1h > 0;
  const batchClasses = (billableInput > 0 && useBatchIn ? 1 : 0) + (output > 0 && useBatchOut ? 1 : 0);
  const standardClasses =
    (billableInput > 0 && !useBatchIn ? 1 : 0) + (output > 0 && !useBatchOut ? 1 : 0) + (cacheClassesPresent ? 1 : 0);
  const rateSet: Cost['rateSet'] =
    batchClasses > 0 && standardClasses > 0 ? 'mixed' : batchClasses > 0 ? 'batch' : 'standard';

  return { usd, unpriced: false, billableInputTokens: billableInput, rateSet };
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
