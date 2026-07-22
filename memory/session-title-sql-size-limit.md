---
name: session-title-sql-size-limit
description: hub first-interaction title is precomputed in TS at ingest (sessions.first_interaction_title), not derived in SQL — history of why
metadata:
  type: project
---

The session "first interaction" title (listings, search, detail header) is computed **once in
TypeScript at index time** by `computeFirstInteractionTitle` in `hub/src/session-title.ts` and
stored in `sessions.first_interaction_title`. Read paths just select the column;
`sessionDisplayTitle` coalesces derived → stored harness title → session id. The ingest writer
(`consumer.ts writeSession`) computes it from the normalized turns; any path that deletes a
session's blocks but keeps the row (the zero-turn reparse → `index_state='error'` cleanup) must
also clear the column, or the title goes stale.

**Backfill:** no SQL backfill — existing rows stay NULL (falling back to stored title) until
`POST /api/v1/admin/reindex` re-parses from R2 through the writer, same convention as `on_main_path`
(migrations/0002). Column added in migrations/0013. Landed 2026-07-22 in PR #51.

**Why not SQL (the trap this replaced, PR #50 era):** it used to be a generated SQL expression
(`firstInteractionTitleCandidateSql`) inlined into every listing query. The recursive per-block
wrapper strip got inlined at ~167 references, so the single statement sat at ~98.7KB — a hair under
D1's ~100KB SQL statement length limit (`SQLITE_TOOBIG`). Two dead ends if you ever consider going
back to query-time derivation:
- Growing the inlined expression (e.g. a new leading-wrapper type) blows the length limit.
- Hoisting the derivation into a CTE/subquery to dedupe the inlining hits `SQLITE_NOMEM` on D1:
  workerd's SQLite won't push the correlated `session_id` filter into a hoisted form, so it strips
  table-wide. Modern SQLite (3.51 / node:sqlite) flattens it and passes local ad-hoc checks, so the
  failure only shows up in the miniflare/D1 tests. Don't trust a local repro here.
The lesson: derive per-row display data at ingest into a column, not via inlined query-time SQL.
