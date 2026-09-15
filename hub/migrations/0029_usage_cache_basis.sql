-- Record the cache-counter convention on each usage row, where pricing and display consume it.
--
-- The convention comes from the transcript source rather than the provider: OMP normalises all
-- providers to disjoint counters, Claude Code carries Anthropic's disjoint counters, and Codex
-- records cached tokens as a subset of input. The column is deliberately nullable because an
-- unrecognised harness has no defensible basis. NULL leaves that row visibly unpriced; a DEFAULT
-- would silently choose the wrong arithmetic and report a plausible but false dollar amount.
--
-- This is an in-place ALTER plus backfill, not a table rebuild. `usage` has roughly 776k rows in
-- production, and rebuilding it merely to add this constraint would copy the whole table and all
-- of its indexes. See 0019/0020 for the same production constraint.
ALTER TABLE usage ADD COLUMN cache_basis TEXT
  CHECK (cache_basis IN ('disjoint', 'subset'));

UPDATE usage
   SET cache_basis = (
     SELECT CASE s.harness
              WHEN 'codex' THEN 'subset'
              WHEN 'omp' THEN 'disjoint'
              WHEN 'claude-code' THEN 'disjoint'
            END
       FROM sessions s
      WHERE s.session_id = usage.session_id
   );
