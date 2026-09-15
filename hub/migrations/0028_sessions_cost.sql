-- Per-session cost, materialised on the session.
--
-- The session list shows what a session COST rather than how many tokens it reported, and the
-- figure it shows includes the session's subagent descendants. Both halves of that need a
-- per-session total, and the list is also sortable by it, which is what forces materialisation:
--
--   * Display alone could aggregate `usage` for the page's ~25 rows through `usage_session` and
--     read a few thousand rows. Affordable.
--   * SORTING cannot. Ordering every matching session by cost means aggregating the WHOLE usage
--     table on every page load -- 776k rows read to render one page of twenty-five, against a
--     daily row-read allowance in the millions. The token sort it replaces reads `sessions` only.
--
-- With the subtotal on the session row, both paths read `sessions` alone: a session's own cost is
-- a column, and the subagent rollup is a recursive walk of `parent_session_id` (indexed by
-- `sessions_parent`) that never touches `usage`. See src/session-cost.ts.
--
-- WHAT IS STORED, and why three columns rather than one. Same reasoning as `usage.usd` in 0018:
-- a dollar figure alone cannot say whether it is complete.
--
--   cost_usd          SUM of `usage.usd` over the session's PRICED rows, or NULL when none are
--                     priced. NULL is "no known subtotal", which is distinct from a real 0.00 --
--                     a session of `<synthetic>` turns genuinely cost nothing.
--   cost_calls        usage rows the session has, priced or not.
--   cost_priced_calls usage rows carrying a stored cost. `cost_priced_calls < cost_calls` means
--                     `cost_usd` is a lower bound, and the viewer says so instead of presenting a
--                     partial figure as the total.
--
-- These are a CACHE of `usage`, so exactly two writers maintain them, and they are the only two
-- places usage rows ever change: the ingest write path (writeSession, same batch that upserts the
-- session, so a freshly indexed session is never left with a stale subtotal) and the pricing pass
-- (which is what fills `usage.usd` in the first place). Both go through
-- `refreshSessionCostStatement` in src/session-cost.ts -- one SQL definition, so the two cannot
-- drift into disagreeing about what the columns mean.
--
-- NOT a trigger on `usage`, which would guarantee consistency from any writer: the pricing
-- backfill writes one row at a time across 776k rows, and a per-row trigger would turn that into
-- 776k additional `sessions` row writes. The refresh is per SESSION instead, once per batch.

ALTER TABLE sessions ADD COLUMN cost_usd REAL;
ALTER TABLE sessions ADD COLUMN cost_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cost_priced_calls INTEGER NOT NULL DEFAULT 0;

-- Backfill. Without it every already-indexed session reads as "no usage" until something happens
-- to re-ingest or re-price it, which for a settled archive is never.
--
-- UPDATE ... FROM over a single grouped scan of `usage`, not three correlated subqueries per
-- session: the correlated form re-seeks the index once per column per session, where this reads
-- `usage` once and applies one indexed update per session that has any. Sessions with no usage
-- rows are left at the column defaults, which is what they mean.
UPDATE sessions
   SET cost_usd = agg.usd, cost_calls = agg.calls, cost_priced_calls = agg.priced_calls
  FROM (
    SELECT session_id, SUM(usd) AS usd, COUNT(*) AS calls, COUNT(usd) AS priced_calls
      FROM usage GROUP BY session_id
  ) AS agg
 WHERE sessions.session_id = agg.session_id;
