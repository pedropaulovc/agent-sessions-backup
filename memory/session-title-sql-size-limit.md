---
name: session-title-sql-size-limit
description: hub session-title.ts title query is inlined ~hundreds of times and rides D1's ~100KB SQL statement limit; CTE hoisting breaks it
metadata:
  type: project
---

`hub/src/session-title.ts` `firstInteractionTitleCandidateSql` builds one giant
correlated subquery. `interactionTextSql` (the recursive leading-wrapper strip) is
textually **inlined at every interaction-text reference** — the special-title
helpers multiply it, so the generated SQL had ~167 inlines and sat at ~98.7KB,
one change away from D1's ~100KB statement-length limit (`SQLITE_TOOBIG`).

**Two traps when editing it:**
- Growing `interactionTextSql` (e.g. adding a leading wrapper to strip) multiplies
  across all inlines and blows the limit. Pay for it by shrinking elsewhere: one
  `CASE` emitting each special-title condition once (not split kind/text CASEs),
  `char(9,10,13,32)` instead of `char(9)||char(10)||...`, terse recursive aliases.
- **Do NOT hoist the stripped text into a CTE/subquery** to dedupe the inlining.
  D1's (workerd) SQLite won't push the correlated `session_id = sessions.session_id`
  filter into a hoisted `FROM`/CTE, so it strips table-wide → `SQLITE_NOMEM`. Modern
  SQLite (3.51, node:sqlite) flattens it fine, so it passes local ad-hoc checks but
  fails the miniflare/D1 tests. Keep the `FROM blocks title_block WHERE session_id=…`
  structure (itext expressions inlined, evaluated lazily post-index-filter).

Guardrail test: `test/viewer.test.ts` asserts the plan still uses
`SEARCH title_block USING INDEX blocks_session` (no scan). Measure generated size
with a throwaway `npx tsx` importing `firstInteractionTitleCandidateSql('sessions')`.
Landed 2026-07-22 in PR #50 (fork-boilerplate stripping), which cut it to ~57KB.
