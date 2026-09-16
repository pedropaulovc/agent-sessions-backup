-- Make the costs that the v2 arithmetic got WRONG unreadable, instead of leaving them on display
-- until the repricing pass happens to reach them.
--
-- 0029/0030 moved cache accounting from the provider catalog to the transcript source, and
-- PRICING_VERSION went 2 -> 3 so every stored row is due for re-pricing. That bump alone is not
-- enough here, and this is the first bump where it is not:
--
--   - 1 -> 2 added the five per-class columns. `usd` itself did not change, so a not-yet-repriced
--     row still displayed the right number.
--   - 2 -> 3 changes the number. An OMP-recorded OpenAI row was priced with subset arithmetic
--     against disjoint counters and can be understated several-fold (measured: 4.7x on one
--     session's gpt-6-astra rows).
--
-- Nothing on the read path checks `priced_version`: `stats.ts`, the `sessions.cost_usd` cache and
-- the viewer all read stored `usd` as current, while `/api/v1/usage` prices live through
-- `priceForGroup`. So between this deploy and the end of the backfill, the API and the pages would
-- disagree, and the pages would be wrong in the expensive direction. The nightly pass moves 20,000
-- rows; a cold corpus is 776k.
--
-- The fix is to drop exactly the stored answers the new arithmetic changes, so they read as
-- unknown (never as $0 -- SUM over NULL is NULL, and coverage counts fall with them) until the
-- pass rewrites them. Deliberately NOT a corpus-wide `usd = NULL`: most rows were already right,
-- and turning a correct figure into "unknown" for the length of a backfill is its own regression.
--
-- A row's stored cost changes only if BOTH of these hold:
--
--   1. It has cache reads. With `cache_read_tokens = 0` the two conventions compute the same
--      thing -- subset bills `input - min(read, input)` = input, disjoint bills input -- so those
--      rows keep their money.
--   2. The convention actually moved. The v2 convention was derived from the price catalog's
--      `provider` (anthropic -> disjoint; openai/azure/deepseek -> subset; anything else ->
--      unknown, which `costOfUsage` refused to price at all when a row had cache reads, so those
--      rows are already NULL and there is nothing to invalidate). `model_prices.provider` survives
--      0030, so the old answer is still recoverable here -- which is the only reason this can be
--      precise rather than corpus-wide.
--
-- Where the model has several snapshots with different providers, ANY disagreement invalidates:
-- over-invalidating costs a re-price the row was already scheduled for, while under-invalidating
-- leaves a wrong dollar figure on the statistics page. A row whose `cache_basis` is NULL (an
-- unrecognised transcript source) is invalidated for the same reason -- v3 cannot price it at all,
-- so its v2 figure is an answer the current arithmetic would refuse to give.
--
-- `priced_version` is left at 2 on purpose. The pass's due predicate is `priced_version < 3`, so
-- these rows are already due, and rewriting it to 0 would make a row that was priced and
-- invalidated indistinguishable from one nothing ever attempted.
--
-- Cost: one scan of `usage` (776k rows) with an indexed probe per row into `model_prices`, whose
-- primary key leads with `model`. The same order of work as 0028's and 0029's backfills, once.

UPDATE usage
   SET usd = NULL,
       usd_input = NULL,
       usd_output = NULL,
       usd_cache_read = NULL,
       usd_cache_write_5m = NULL,
       usd_cache_write_1h = NULL
 WHERE usd IS NOT NULL
   AND priced_version < 3
   AND COALESCE(cache_read_tokens, 0) > 0
   AND EXISTS (
     SELECT 1
       FROM model_prices p
      WHERE p.model = usage.model
        AND CASE p.provider
              WHEN 'anthropic' THEN 'disjoint'
              WHEN 'openai' THEN 'subset'
              WHEN 'azure' THEN 'subset'
              WHEN 'deepseek' THEN 'subset'
              ELSE 'unknown'
            END IN ('disjoint', 'subset')
        AND CASE p.provider
              WHEN 'anthropic' THEN 'disjoint'
              WHEN 'openai' THEN 'subset'
              WHEN 'azure' THEN 'subset'
              WHEN 'deepseek' THEN 'subset'
              ELSE 'unknown'
            END IS NOT usage.cache_basis
   );

-- The materialized per-session subtotals are a cache of the rows just invalidated, and they are on
-- the session list and the cost facet. Refreshed for the affected sessions only, with the same
-- grouped-scan shape as 0028's backfill and the same definition as `refreshSessionCostStatement`
-- in src/session-cost.ts: a session whose usage is now partly unpriced must report reduced
-- coverage, not a subtotal that still includes dollars no row holds any more.
UPDATE sessions
   SET cost_usd = agg.usd, cost_calls = agg.calls, cost_priced_calls = agg.priced_calls
  FROM (
    SELECT session_id, SUM(usd) AS usd, COUNT(*) AS calls, COUNT(usd) AS priced_calls
      FROM usage
     GROUP BY session_id
  ) AS agg
 WHERE sessions.session_id = agg.session_id
   AND (sessions.cost_usd IS NOT agg.usd
        OR sessions.cost_calls IS NOT agg.calls
        OR sessions.cost_priced_calls IS NOT agg.priced_calls);
