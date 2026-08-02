-- Per-class cost on the turn, plus the mechanism that makes re-pricing routine.
--
-- 0018 stored a scalar `usd`, which was enough to take the prior-window total off the read path
-- (#72) but not the current window: the token-economics panel splits dollars five ways and the
-- ledger's cache share is derived from that split, so `stats.ts` still folds every row through
-- `costOfUsage` on every page load purely to recover a breakdown a scalar cannot carry.
--
-- These five columns are that breakdown, and they sum to `usd` exactly -- same terms, same order,
-- because `costOfUsage` computes `usd` AS their sum rather than alongside it. Storing both is
-- therefore not redundancy that can drift; it is one number and its decomposition, written
-- together by one function.
ALTER TABLE usage ADD COLUMN usd_input REAL;
ALTER TABLE usage ADD COLUMN usd_output REAL;
ALTER TABLE usage ADD COLUMN usd_cache_read REAL;
ALTER TABLE usage ADD COLUMN usd_cache_write_5m REAL;
ALTER TABLE usage ADD COLUMN usd_cache_write_1h REAL;

-- WHY A VERSION, and not just another nullable column to look for.
--
-- 776k rows already carry a cost. Filling the columns above means re-pricing every one of them,
-- and `usd IS NULL` -- the predicate the pass selects on today -- matches none of them. The
-- obvious hack is to NULL out `usd` corpus-wide to force a re-run, which would make the whole
-- statistics page read $0 for the ~36 minutes the backfill takes. That is a bad trade for a
-- change that alters no existing number.
--
-- A version does it without a window of wrongness: bumping PRICING_VERSION marks every row as
-- due, the pass works through them at its own pace, and until each row is reached its EXISTING
-- cost stays readable and stays correct. This is not specific to this migration -- any future
-- change to what is stored or how it is computed is now a constant bump rather than a hand-written
-- data migration, which is the difference between repricing being routine and being an event.
ALTER TABLE usage ADD COLUMN priced_version INTEGER;

-- Finding rows due for pricing. Cannot be partial: a partial index's WHERE is fixed at creation
-- and the predicate here is "below whatever the current version is", which changes.
--
-- That makes this one entry per row, unlike 0018's `usage_unpriced` -- the cost of the version
-- mechanism, paid deliberately. It replaces that index rather than joining it: `usd IS NULL` is
-- no longer the question the pass asks.
DROP INDEX IF EXISTS usage_unpriced;
CREATE INDEX usage_due_for_pricing ON usage (priced_version, priced_at, id);
