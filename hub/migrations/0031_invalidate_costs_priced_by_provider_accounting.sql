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
-- A row is invalidated when the v3 arithmetic would not reproduce its stored number. Four ways
-- that happens, and the query below is one arm per way:
--
--   1. No recorded basis at all. `costOfUsage` refuses a row whose `cache_basis` is neither
--      'disjoint' nor 'subset' BEFORE it looks at any token counter (src/pricing.ts), so such a
--      row is unpriceable under v3 even with zero cache reads. Its stored figure is an answer the
--      current arithmetic declines to give, so it cannot stay on display. This arm is deliberately
--      independent of the cache-read condition below.
--
-- The remaining three need cache reads to matter: with `cache_read_tokens = 0` the conventions
-- compute the same thing -- subset bills `input - min(read, input)` = input, disjoint bills input
-- -- so those rows keep their money. Given cache reads:
--
--   2. The recoverable convention disagrees. The v2 convention came from the catalog's `provider`
--      (anthropic -> disjoint; openai/azure/deepseek -> subset; anything else -> 'unknown').
--      `model_prices.provider` survives 0030, so that old answer is still derivable here, which is
--      the only reason this migration can be precise rather than corpus-wide. Where a model has
--      several snapshots, ANY disagreement invalidates: over-invalidating costs a re-price the row
--      was already scheduled for, while under-invalidating leaves a wrong dollar figure on the
--      statistics page. 'unknown' counts as a disagreement, which also covers the pre-0017 corpus:
--      0016's sync stored the fallback `cache_accounting = 'subset'` for an unrecognised provider
--      and 0017 preserved those values, so a cached OMP or Claude Code row could have been priced
--      as subset under a provider that today derives nothing.
--
--   3. The catalog for that model was written after the row was priced. The sync writes with
--      `INSERT OR REPLACE` keyed on (model, effective_from), so a run on the same day corrects
--      that day's row IN PLACE and the provider it held when the row was priced is gone. 0018
--      anticipated this and stored the handle for it -- `priced_at` -- so a snapshot whose
--      `fetched_at` is newer than `priced_at` means the provider the row was actually priced under
--      is unrecoverable. Unrecoverable is treated as disagreeing; the alternative is leaving a
--      number nobody can justify.
--
--      Which snapshot is "the one it was priced against" takes a resolution step rather than an
--      equality. `usage.price_epoch` names a bucket, not a snapshot: `priceEpochExpr` pools
--      boundaries across every model so one CASE serves the whole query, and emits the sentinels
--      'unknown' and '0000-00-00'. `priceAt` then picks the model's newest `effective_from` at or
--      before that epoch, or its oldest for a row predating them all. So the arm below reproduces
--      that selection: matching on `effective_from = price_epoch` would often match no row at all
--      (a claude row bucketed into some other model's boundary), while accepting ANY later
--      snapshot would blank costs the new arithmetic reproduces exactly -- a January cost priced
--      before a February rate change is still correct, and hiding it understates the totals for
--      the length of the backfill.
--
--   4. The model has no snapshot at all. A stored cost implies one existed, so its absence is the
--      same unrecoverable case as 3.
--
-- `priced_version` is left at 2 on purpose. The pass's due predicate is `priced_version < 3`, so
-- these rows are already due, and rewriting it to 0 would make a row that was priced and
-- invalidated indistinguishable from one nothing ever attempted.
--
-- Cost: one scan of `usage` (776k rows) with indexed probes into `model_prices`, whose primary key
-- leads with `model`. The same order of work as 0028's and 0029's backfills, once.

UPDATE usage
   SET usd = NULL,
       usd_input = NULL,
       usd_output = NULL,
       usd_cache_read = NULL,
       usd_cache_write_5m = NULL,
       usd_cache_write_1h = NULL
 WHERE usd IS NOT NULL
   AND priced_version < 3
   AND (
     cache_basis IS NULL
     OR (
       COALESCE(cache_read_tokens, 0) > 0
       AND (
         NOT EXISTS (SELECT 1 FROM model_prices p WHERE p.model = usage.model)
         OR EXISTS (
           SELECT 1
             FROM model_prices p
            WHERE p.model = usage.model
              AND CASE p.provider
                    WHEN 'anthropic' THEN 'disjoint'
                    WHEN 'openai' THEN 'subset'
                    WHEN 'azure' THEN 'subset'
                    WHEN 'deepseek' THEN 'subset'
                    ELSE 'unknown'
                  END IS NOT usage.cache_basis
         )
         OR EXISTS (
           SELECT 1
             FROM model_prices p
            WHERE p.model = usage.model
              AND p.fetched_at > COALESCE(usage.priced_at, '')
              AND (
                -- The 'unknown' epoch is not resolved to one snapshot: `priceForGroup` prices such
                -- a row only when EVERY snapshot agrees on rates, so any of them being rewritten
                -- puts the stored figure in doubt.
                usage.price_epoch = 'unknown'
                -- Otherwise exactly the snapshot `priceAt` selects: the newest effective_from at
                -- or before the epoch, falling back to the oldest for a row that predates them
                -- all (the '0000-00-00' sentinel, and any epoch below the model's first
                -- snapshot). A LATER snapshot is not evidence about this row: a January cost
                -- priced before a February rate change is still what v3 recomputes.
                OR p.effective_from = COALESCE(
                     (SELECT MAX(q.effective_from) FROM model_prices q
                       WHERE q.model = usage.model AND q.effective_from <= usage.price_epoch),
                     (SELECT MIN(q.effective_from) FROM model_prices q WHERE q.model = usage.model))
              )
         )
       )
     )
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
