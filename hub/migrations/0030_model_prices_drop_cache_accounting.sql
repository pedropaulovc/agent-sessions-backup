-- Remove the provider-level cache-accounting convention from the price catalog.
--
-- That column describes the provider API's raw response shape, but `usage` stores counters in the
-- shape written by the transcript source. Keeping both would leave two sources of truth that can
-- and do disagree (notably for OpenAI responses normalised by OMP). The per-usage `cache_basis`
-- added by 0029 is now the only accounting input.
--
-- SQLite cannot drop this constrained column in place, so mirror 0017's table rebuild while
-- preserving every other column, constraint, row, and index.
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
  source TEXT NOT NULL DEFAULT 'litellm',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (model, effective_from)
) STRICT;

INSERT INTO model_prices_new
  SELECT model, effective_from, litellm_key, provider, input_cost, output_cost, cache_read_cost,
         cache_write_5m_cost, cache_write_1h_cost, input_cost_batch, output_cost_batch,
         max_input_tokens, max_output_tokens, source, fetched_at
    FROM model_prices;

DROP TABLE model_prices;

ALTER TABLE model_prices_new RENAME TO model_prices;

CREATE INDEX model_prices_model ON model_prices (model, effective_from DESC);
