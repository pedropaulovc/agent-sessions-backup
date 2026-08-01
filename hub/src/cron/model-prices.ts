/** Daily refresh of `model_prices` from LiteLLM -- the pricing file ccusage reads.
 *
 * Runs in the Worker (not the CLI script) so pricing stays current without anyone
 * remembering to run anything. scripts/sync-model-prices.mjs remains for backfills, dry runs
 * and `--all`; this is the unattended path and the two share the same resolution rules --
 * literally, via ../upstream-catalog.mjs, after they drifted three separate times in one review. */

import {
  assertLooksLikeCatalog,
  cacheAccountingFor,
  intOrNull,
  perM,
  lookupEntry,
  priceKeyCandidates,
  providerOf,
} from '../upstream-catalog.mjs';

const UPSTREAM =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

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

/** Non-rate columns that still change what a row COSTS, so a snapshot must be taken when they
 * move even though every number stayed the same. `cache_accounting` is derived from `provider`,
 * and flipping subset<->disjoint changes whether cache reads are charged on top of input or
 * subtracted from it — upstream correcting a null provider to `anthropic` silently misprices
 * every cached call until some unrelated rate happens to change. */
const ACCOUNTING_COLS = ['provider', 'cache_accounting'] as const;

/** Statements per D1 batch. Each costs a subrequest against the invocation's ~1000 budget. */
const MAX_STATEMENTS_PER_BATCH = 100;

/** Price rows written per INVOCATION. Chunking the batch calls does not reset the budget --
 * every chunk still spends from the same invocation's ~1000 subrequests, shared with the prune
 * jobs the daily handler runs alongside this. So the real bound is total work, not batch size.
 *
 * Models are processed stalest-first, so a run that hits this ceiling still makes progress on the
 * rows most in need of it, and the daily cadence catches the remainder. The audit row records how
 * many were deferred, so "the sync is not keeping up" is visible in the data rather than inferred.
 */
const MAX_PRICE_WRITES_PER_RUN = 400;

type Rates = Record<(typeof RATE_COLS)[number], number | null>;
type Accounting = Record<(typeof ACCOUNTING_COLS)[number], string | null>;


export async function runModelPriceSync(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  try {
    // Bounded: a hung upstream would otherwise hold the scheduled invocation open until the
    // platform kills it, with no audit row written and no signal that the day's sync never ran.
    const res = await fetch(UPSTREAM, { cf: { cacheTtl: 3600 }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const upstream = (await res.json()) as Record<string, Record<string, unknown>>;
    const entryCount = assertLooksLikeCatalog(upstream);

    const models = (
      await env.DB.prepare(
        // Stalest first, so a run that hits MAX_PRICE_WRITES_PER_RUN spends its budget on the
        // models most in need of it and never starves one: a model with no price row at all sorts
        // ahead of every priced one (NULL sorts first under ASC), and among priced models the
        // oldest fetch wins. Each run therefore advances the frontier.
        `SELECT u.model AS model, MAX(p.fetched_at) AS newest
           FROM usage u
           LEFT JOIN model_prices p ON p.model = u.model
          WHERE u.model IS NOT NULL
          GROUP BY u.model
          ORDER BY newest ASC, u.model ASC`,
      ).all<{
        model: string;
      }>()
    ).results.map((r) => r.model)
      // `<synthetic>` is Claude Code's stand-in for a response that never hit the API.
      .filter((m) => m && !m.startsWith('<'));

    const prevRows = (
      await env.DB.prepare(
        // Latest snapshot per model only. This table accumulates history indefinitely by design,
        // and the change predicate compares against the newest row alone -- reading the whole
        // history to discard all but the first row per model gets slower every day for nothing.
        `SELECT p.model, ${RATE_COLS.map((c) => `p.${c}`).join(', ')}, ${ACCOUNTING_COLS.map((c) => `p.${c}`).join(', ')}
           FROM model_prices p
           JOIN (SELECT model, MAX(effective_from) AS newest FROM model_prices GROUP BY model) t
             ON t.model = p.model AND t.newest = p.effective_from`,
      ).all<{ model: string } & Rates & Accounting>()
    ).results;
    const latest = new Map<string, Rates & Accounting>();
    for (const r of prevRows) if (!latest.has(r.model)) latest.set(r.model, r);

    const stmts: D1PreparedStatement[] = [];
    const unresolved: string[] = [];
    let deferred = 0;
    for (const model of models) {
      if (stmts.length >= MAX_PRICE_WRITES_PER_RUN) {
        deferred++;
        continue;
      }
      const key = priceKeyCandidates(model).find((c) => lookupEntry(upstream, c));
      if (!key) {
        unresolved.push(model);
        continue;
      }
      const e = upstream[key]!;
      const provider = providerOf(e);
      const next: Rates = {
        input_cost: perM(e['input_cost_per_token']),
        output_cost: perM(e['output_cost_per_token']),
        cache_read_cost: perM(e['cache_read_input_token_cost'] ?? e['input_cost_per_token_cache_hit']),
        cache_write_5m_cost: perM(e['cache_creation_input_token_cost']),
        // NULL when upstream omits the 1h rate -- never the 5m rate standing in for it. The 1h
        // write is 2x input where the 5m write is 1.25x, so the substitution stored a number
        // that is wrong by ~40% AND, worse, made it indistinguishable from a published rate, so
        // costOfUsage's missing-rate guard could never fire.
        cache_write_1h_cost: perM(e['cache_creation_input_token_cost_above_1hr']),
        input_cost_batch: perM(e['input_cost_per_token_batches']),
        output_cost_batch: perM(e['output_cost_per_token_batches']),
      };
      // Anthropic reports cache reads disjoint from input_tokens; the OpenAI family reports them
      // as a subset. Charging both the same way misprices every cached turn.
      //
      // Defaulting the UNKNOWN case to 'subset' was a confident guess in the expensive direction:
      // a Claude Code row stores cache_read_input_tokens as disjoint usage, so subset accounting
      // subtracts those tokens from input and underprices every cached call -- silently, with the
      // row still reported as priced. An absent or unrecognised `litellm_provider` now stores
      // 'unknown' for an absent or unrecognised provider, which costOfUsage treats as unpriced
      // for any row that actually has cache reads. NOT null: the column is NOT NULL, and
      // INSERT OR REPLACE silently substitutes the column DEFAULT for a NULL rather than failing,
      // so a nullable-looking write would have stored 'disjoint' while the code believed
      // otherwise (see migration 0017). The provider->convention map lives in upstream-catalog.mjs
      // so the cron and the manual script cannot disagree about it.
      const cacheAccounting = cacheAccountingFor(provider);
      const prev = latest.get(model);
      const ratesUnchanged = prev && RATE_COLS.every((c) => (prev[c] ?? null) === (next[c] ?? null));
      const accountingUnchanged =
        prev && (prev.provider ?? null) === provider && (prev.cache_accounting ?? null) === cacheAccounting;
      if (ratesUnchanged && accountingUnchanged) continue;

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
          intOrNull(e['max_input_tokens']),
          intOrNull(e['max_output_tokens']),
          cacheAccounting,
          now,
        ),
      );
    }

    const priceInserts = stmts.length;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO model_prices_sync (upstream_entries, models_seen, rows_inserted, unresolved, ok)
         VALUES (?1,?2,?3,?4,1)`,
      ).bind(
        entryCount,
        models.length,
        priceInserts,
        // Deferred models ride in the same audit field as unresolved ones so a run that hit the
        // per-invocation ceiling is visible rather than looking like a clean, complete sync.
        JSON.stringify(deferred ? [...unresolved, `__deferred__:${deferred}`] : unresolved),
      ),
    );

    // Chunked, because every statement in a D1 batch spends one of the invocation's ~1000
    // subrequests (see the budget note in src/api/ops.ts) and the daily handler runs the prune
    // jobs concurrently with this one. A first-run or catalog-wide change across ~1000 models in
    // `usage` would otherwise exhaust the budget mid-sync and fail the whole refresh.
    //
    // Chunking gives up cross-chunk atomicity, which is acceptable HERE and would not be
    // elsewhere: each statement is an idempotent INSERT OR REPLACE keyed by
    // (model, effective_from), so a partial run leaves correct rows for the models it reached and
    // the next run completes the rest. The audit row is last, so a partial run is not recorded as
    // a success.
    for (let i = 0; i < stmts.length; i += MAX_STATEMENTS_PER_BATCH) {
      await env.DB.batch(stmts.slice(i, i + MAX_STATEMENTS_PER_BATCH));
    }
  } catch (err) {
    // A failed sync must be visible in the data, not just in logs -- a silently stale price
    // table produces confident, wrong dollar figures.
    // If D1 itself is the problem, this INSERT throws too -- and an unguarded throw here would
    // REPLACE the original error with a less informative one, losing the reason the sync failed.
    await env.DB.prepare(
      `INSERT INTO model_prices_sync (upstream_entries, models_seen, rows_inserted, ok, error)
       VALUES (NULL, NULL, 0, 0, ?1)`,
    )
      .bind(err instanceof Error ? err.message : String(err))
      .run()
      .catch((auditErr) => {
        console.log(
          JSON.stringify({
            event: 'hub.model_prices.audit_write_failed',
            detail: auditErr instanceof Error ? auditErr.message : String(auditErr),
          }),
        );
      });
    throw err;
  }
}
