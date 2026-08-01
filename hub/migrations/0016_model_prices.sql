-- Model pricing, sourced from LiteLLM's model_prices_and_context_window.json -- the same
-- file ccusage reads. The hub stores no prices of its own and invents none: every row here
-- is a verbatim copy of an upstream entry, converted from per-token to per-million-token
-- (upstream stores 2e-8; 0.02 is the same number without the float noise).
--
-- Versioned by `effective_from` rather than overwritten. LiteLLM publishes only "today's"
-- price, so history is built by snapshot: the sync writes a new row ONLY when a rate
-- actually changes, which makes a July session price at July's rate after an August cut.
-- Without this, one upstream price change silently rewrites every historical cost on the
-- stats page.
CREATE TABLE model_prices (
  model TEXT NOT NULL,                 -- the id as it appears in usage.model
  effective_from TEXT NOT NULL,        -- ISO date this rate was first observed
  litellm_key TEXT NOT NULL,           -- upstream key this resolved to (audit trail)
  provider TEXT,                       -- anthropic | openai | deepseek | ...
  -- All costs are USD per MILLION tokens. NULL means upstream does not publish that rate,
  -- which is not the same as zero -- a NULL cache_write means "unknown", and the cost
  -- helper refuses to price a row rather than silently charging 0.
  input_cost REAL,
  output_cost REAL,
  cache_read_cost REAL,
  cache_write_5m_cost REAL,
  cache_write_1h_cost REAL,
  input_cost_batch REAL,               -- NULL when the provider has no batch tier
  output_cost_batch REAL,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  -- Whether cache_read_tokens is disjoint from input_tokens (anthropic) or a subset of it
  -- (openai/codex). The two harnesses genuinely disagree and summing them the same way
  -- double-counts every Codex turn -- verified against real transcripts, where a codex
  -- token_count event reads {"input_tokens":86912,"cached_input_tokens":85760}.
  cache_accounting TEXT NOT NULL DEFAULT 'disjoint'
    CHECK (cache_accounting IN ('disjoint', 'subset')),
  source TEXT NOT NULL DEFAULT 'litellm',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (model, effective_from)
) STRICT;

CREATE INDEX model_prices_model ON model_prices (model, effective_from DESC);

-- Records each sync run so a stale price table is detectable from the data rather than by
-- noticing the numbers look wrong.
CREATE TABLE model_prices_sync (
  id INTEGER PRIMARY KEY,
  ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  upstream_entries INTEGER,
  models_seen INTEGER,
  rows_inserted INTEGER,
  unresolved TEXT,                     -- JSON array of usage.model values with no upstream match
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
) STRICT;
