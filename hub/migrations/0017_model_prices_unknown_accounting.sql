-- Add 'unknown' as a third cache_accounting value.
--
-- 0016 declared `cache_accounting TEXT NOT NULL DEFAULT 'disjoint'`, and the sync mapped every
-- provider it did not recognise to 'subset'. Both halves were wrong in the same way: they turn
-- "we do not know this provider's cache-read convention" into a confident answer. Disjoint bills
-- cache reads ON TOP of input, subset bills them INSIDE it, so guessing is a silent ~2x error on
-- every cached turn -- and the row still reports as priced, so nothing downstream can notice.
--
-- Writing NULL instead does not work, and the reason is worth recording because it fails
-- SILENTLY: the sync uses INSERT OR REPLACE, and SQLite's REPLACE conflict resolution does not
-- reject a NULL bound to a NOT NULL column -- it substitutes the column's DEFAULT. So every
-- unknown provider was stored as 'disjoint' while the code believed it had stored NULL.
--
-- A third enum value carries the state explicitly instead. costOfUsage refuses to price a row
-- that has cache reads and an 'unknown' convention; rows without cache reads are unaffected,
-- since the convention cannot change their cost.
--
-- The table must be rebuilt: SQLite cannot alter a CHECK constraint in place.

CREATE TABLE model_prices_new (
  model TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  litellm_key TEXT NOT NULL,
  provider TEXT,
  input_cost REAL,
  output_cost REAL,
  cache_read_cost REAL,
  cache_write_5m_cost REAL,
  cache_write_1h_cost REAL,
  input_cost_batch REAL,
  output_cost_batch REAL,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  cache_accounting TEXT NOT NULL DEFAULT 'unknown'
    CHECK (cache_accounting IN ('disjoint', 'subset', 'unknown')),
  source TEXT NOT NULL DEFAULT 'litellm',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (model, effective_from)
) STRICT;

-- Existing rows keep their stored value. They are NOT rewritten to 'unknown' even where the
-- provider is null: the next sync re-derives every model it can see in `usage` and will correct
-- them, and blanking them here would make every historical cost unpriced in the meantime.
INSERT INTO model_prices_new
  SELECT model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
         cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
         max_input_tokens, max_output_tokens, cache_accounting, source, fetched_at
    FROM model_prices;

DROP TABLE model_prices;

ALTER TABLE model_prices_new RENAME TO model_prices;

CREATE INDEX model_prices_model ON model_prices (model, effective_from DESC);
