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
-- NOT NULL DEFAULT 0, and that is load-bearing rather than tidiness. The pass asks "which rows
-- are below the current version", and the natural way to write that over a nullable column is
-- `priced_version IS NULL OR priced_version < ?`. SQLite cannot serve an OR across a NULL test and
-- a range with one index: verified against this table on D1, that predicate plans as `SCAN u`,
-- i.e. a full 776k-row scan on every run including the steady-state ones where the answer is
-- "none". With the column NOT NULL the same question is a single range, and the same index is used
-- AND covering:
--
--   OR form:    SCAN u
--   range form: SEARCH u USING COVERING INDEX usage_due_for_pricing (priced_version<?)
--
-- 0 is therefore a real value meaning "not priced by any version", not a stand-in for NULL.
ALTER TABLE usage ADD COLUMN priced_version INTEGER NOT NULL DEFAULT 0;

-- Finding rows due for pricing: a single range over `priced_version`, which is why the column
-- above is NOT NULL. Cannot be partial: a partial index's WHERE is fixed at creation and the
-- predicate here is "below whatever the current version is", which changes.
--
-- That makes this one entry per row, unlike 0018's `usage_unpriced` -- the cost of the version
-- mechanism, paid deliberately. It replaces that index rather than joining it: `usd IS NULL` is
-- no longer the question the pass asks.
DROP INDEX IF EXISTS usage_unpriced;
CREATE INDEX usage_due_for_pricing ON usage (priced_version, priced_at, id);
