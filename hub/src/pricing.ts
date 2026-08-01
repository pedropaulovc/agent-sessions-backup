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

/** Models that are not models. `<synthetic>` is Claude Code's local stand-in for a response
 * that never hit the API, so it must never be priced or counted as unpriced coverage loss. */
export function isBillableModel(model: string | null | undefined): model is string {
  return !!model && model !== '<synthetic>' && !model.startsWith('<');
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
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_tokens ?? 0;
  const cw5 = u.cache_creation_5m_tokens ?? 0;
  const cw1h = u.cache_creation_1h_tokens ?? 0;

  // Under `subset`, the cached tokens are already inside input_tokens; only the remainder is
  // fresh. clamp at 0 -- a truncated or out-of-order transcript can report cacheRead > input.
  const billableInput = price?.cache_accounting === 'subset' ? Math.max(0, input - cacheRead) : input;

  if (!price || price.input_cost == null || price.output_cost == null) {
    return { usd: 0, unpriced: true, billableInputTokens: billableInput };
  }

  const batch = opts?.batch === true && price.input_cost_batch != null && price.output_cost_batch != null;
  const inRate = batch ? price.input_cost_batch! : price.input_cost;
  const outRate = batch ? price.output_cost_batch! : price.output_cost;

  // A missing cache rate means "upstream doesn't publish it", not "free". Fall back to the
  // input rate, which is the conservative direction: caching can only ever be cheaper.
  const readRate = price.cache_read_cost ?? inRate;
  const w5Rate = price.cache_write_5m_cost ?? inRate;
  const w1hRate = price.cache_write_1h_cost ?? w5Rate;

  const usd =
    (billableInput * inRate + output * outRate + cacheRead * readRate + cw5 * w5Rate + cw1h * w1hRate) /
    MILLION;

  return { usd, unpriced: false, billableInputTokens: billableInput };
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
