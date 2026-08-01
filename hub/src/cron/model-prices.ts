/** Daily refresh of `model_prices` from LiteLLM -- the pricing file ccusage reads.
 *
 * Runs in the Worker (not the CLI script) so pricing stays current without anyone
 * remembering to run anything. scripts/sync-model-prices.mjs remains for backfills, dry runs
 * and `--all`; this is the unattended path and the two share the same resolution rules. */

const UPSTREAM =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PER_MILLION = 1_000_000;
// Round after scaling: 2e-8 * 1e6 lands on 0.019999999999999998 in binary float, which is
// numerically irrelevant but makes the stored table look untrustworthy.
const perM = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Number((v * PER_MILLION).toPrecision(12)) : null;

/** Rates compared to decide whether a snapshot is a real price change. */
const RATE_COLS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_write_5m_cost',
  'cache_write_1h_cost',
  'input_cost_batch',
  'output_cost_batch',
] as const;

type Rates = Record<(typeof RATE_COLS)[number], number | null>;

/** Mirrors priceKeyCandidates() in ../pricing.ts and candidates() in the CLI script. */
function candidates(model: string): string[] {
  const out = [model];
  const undated = model.replace(/-\d{8}$/, '');
  if (undated !== model) out.push(undated);
  for (const p of ['anthropic', 'openai', 'deepseek']) {
    out.push(`${p}/${model}`);
    if (undated !== model) out.push(`${p}/${undated}`);
  }
  return out;
}

export async function runModelPriceSync(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  try {
    const res = await fetch(UPSTREAM, { cf: { cacheTtl: 3600 } });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const upstream = (await res.json()) as Record<string, Record<string, unknown>>;
    const entryCount = Object.keys(upstream).length;

    const models = (
      await env.DB.prepare(`SELECT DISTINCT model FROM usage WHERE model IS NOT NULL`).all<{
        model: string;
      }>()
    ).results.map((r) => r.model)
      // `<synthetic>` is Claude Code's stand-in for a response that never hit the API.
      .filter((m) => m && !m.startsWith('<'));

    const prevRows = (
      await env.DB.prepare(
        `SELECT model, ${RATE_COLS.join(', ')} FROM model_prices ORDER BY model, effective_from DESC`,
      ).all<{ model: string } & Rates>()
    ).results;
    const latest = new Map<string, Rates>();
    for (const r of prevRows) if (!latest.has(r.model)) latest.set(r.model, r);

    const stmts: D1PreparedStatement[] = [];
    const unresolved: string[] = [];
    for (const model of models) {
      const key = candidates(model).find((c) => upstream[c]);
      if (!key) {
        unresolved.push(model);
        continue;
      }
      const e = upstream[key]!;
      const provider = (e['litellm_provider'] as string) ?? null;
      const next: Rates = {
        input_cost: perM(e['input_cost_per_token']),
        output_cost: perM(e['output_cost_per_token']),
        cache_read_cost: perM(e['cache_read_input_token_cost'] ?? e['input_cost_per_token_cache_hit']),
        cache_write_5m_cost: perM(e['cache_creation_input_token_cost']),
        cache_write_1h_cost: perM(
          e['cache_creation_input_token_cost_above_1hr'] ?? e['cache_creation_input_token_cost'],
        ),
        input_cost_batch: perM(e['input_cost_per_token_batches']),
        output_cost_batch: perM(e['output_cost_per_token_batches']),
      };
      const prev = latest.get(model);
      if (prev && RATE_COLS.every((c) => (prev[c] ?? null) === (next[c] ?? null))) continue;

      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO model_prices (model, effective_from, litellm_key, provider,
             input_cost, output_cost, cache_read_cost, cache_write_5m_cost, cache_write_1h_cost,
             input_cost_batch, output_cost_batch, max_input_tokens, max_output_tokens,
             cache_accounting, source, fetched_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'litellm',?15)`,
        ).bind(
          model,
          today,
          key,
          provider,
          next.input_cost,
          next.output_cost,
          next.cache_read_cost,
          next.cache_write_5m_cost,
          next.cache_write_1h_cost,
          next.input_cost_batch,
          next.output_cost_batch,
          (e['max_input_tokens'] as number) ?? null,
          (e['max_output_tokens'] as number) ?? null,
          // Anthropic reports cache reads disjoint from input_tokens; the OpenAI family
          // reports them as a subset. Charging both the same way misprices every cached turn.
          provider === 'anthropic' ? 'disjoint' : 'subset',
          now,
        ),
      );
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO model_prices_sync (upstream_entries, models_seen, rows_inserted, unresolved, ok)
         VALUES (?1,?2,?3,?4,1)`,
      ).bind(entryCount, models.length, stmts.length, JSON.stringify(unresolved)),
    );
    await env.DB.batch(stmts);
  } catch (err) {
    // A failed sync must be visible in the data, not just in logs -- a silently stale price
    // table produces confident, wrong dollar figures.
    await env.DB.prepare(
      `INSERT INTO model_prices_sync (upstream_entries, models_seen, rows_inserted, ok, error)
       VALUES (NULL, NULL, 0, 0, ?1)`,
    )
      .bind(err instanceof Error ? err.message : String(err))
      .run();
    throw err;
  }
}
