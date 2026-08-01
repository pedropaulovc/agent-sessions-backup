-- Store what each turn cost, on the turn.
--
-- Until now the dollar figure for a turn existed only in TypeScript: `costOfUsage` runs on the
-- read path, after the panels have already GROUPed the rows. Three consequences, all of which
-- this column removes:
--
--   1. No median. Grouping destroys the per-turn distribution, so the statistics page can only
--      report a mean $/turn. Not a database limit -- D1 has window functions, and `usage` is one
--      row per turn -- purely a consequence of pricing running after the aggregation. With `usd`
--      on the row, an exact median (and p90) is a `row_number()` away. See issue #70.
--   2. Every panel re-prices the same rows on every page load, in JS, inside the request.
--   3. The main scan has to GROUP BY the pricing unit -- (model, rate epoch, token shape) -- for
--      no reason a reader of the page cares about, because those are the dimensions
--      `costOfUsage` is defined on rather than dimensions anyone asked to see.
--
-- WHAT IS STORED, and why three columns rather than one:
--
--   usd         the cost. NULL means NOT PRICED, which is distinct from 0.00 -- a $0 turn is a
--              real answer (a sentinel `<synthetic>` model, a zero-token turn), whereas NULL is
--              "we could not determine a rate". Conflating them is how an unpriced corpus reads
--              as a free one.
--   price_epoch the `model_prices.effective_from` the cost was computed against. Without it a
--              stored cost is unauditable: you cannot tell whether a turn was priced at the rate
--              in force at the time or at some later one.
--   priced_at   when it was computed. This is the staleness handle. `model_prices` is nearly
--              append-only -- the sync snapshots a new `effective_from` when rates move -- but it
--              writes with INSERT OR REPLACE keyed on (model, effective_from), so a second sync
--              on the same DAY can correct today's rate row in place. Comparing `priced_at`
--              against that row's `fetched_at` is what makes such a correction detectable
--              afterwards instead of leaving a wrong number that looks settled.
--
-- Costs are NOT computed here in SQL, deliberately. The arithmetic -- cache accounting
-- (disjoint/subset/unknown), batch rates, the missing-rate refusals -- lives in `costOfUsage`,
-- and a SQL copy of it would be a second implementation of the thing `src/usage-agg.ts` exists to
-- keep single. The pricing pass reads rows out, prices them with the same function every other
-- caller uses, and writes the answer back. So this migration only makes room; every row starts
-- NULL and is filled in by that pass.

ALTER TABLE usage ADD COLUMN usd REAL;
ALTER TABLE usage ADD COLUMN price_epoch TEXT;
ALTER TABLE usage ADD COLUMN priced_at TEXT;

-- Finding the work. The pricing pass's hot query is "which rows still need pricing", and without
-- an index that is a full scan of 776k rows every run, forever -- including on the steady-state
-- days when the answer is "none", which is most days.
--
-- Partial, on the NULL case only: once the backfill is done this index holds approximately
-- nothing, so it costs nothing to keep and nothing to maintain. A full index on `usd` would be
-- the opposite -- one entry per row, rewritten by every pricing write, to answer a question about
-- a set that is empty in the normal case.
--
-- Led by `priced_at`, not `id`, because the pass's real question is "what have I not tried since
-- this run started". A row can be permanently unpriceable (no published rate for its model), and
-- ordering purely by id would hand every run the same first N of those forever while the rest of
-- the backfill starved. NULL sorts first under ASC, so never-attempted rows are always served
-- ahead of retries.
CREATE INDEX usage_unpriced ON usage (priced_at, id) WHERE usd IS NULL;

-- Repricing. A rate correction invalidates by (model, price_epoch), and this makes finding the
-- affected rows a seek rather than the second full scan.
CREATE INDEX usage_price_epoch ON usage (model, price_epoch);
