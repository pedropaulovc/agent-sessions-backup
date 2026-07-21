---
name: d1-invocation-limits
description: D1's ~1000/invocation cap counts SUBREQUESTS (db.batch = 1), not statements — proven by positive control
metadata:
  type: project
---

Cloudflare Workers' ~1000-operations-per-invocation cap, as it applies to D1,
counts **subrequests**: one `db.batch([...])` call = 1, regardless of how many
prepared statements it contains. It does NOT count individual statements.

**Why:** an earlier working note ("batch statements each count") was folklore —
plausible, doc-adjacent, wrong. Positive control (2026-07-18, prod
sessions-index): a 7,686-block session (≈7.7k statements across ~89 batch
subrequests) writes atomically in ONE consumer invocation. A 1000-statement cap
would make that impossible; a 1000-subrequest cap explains it, and also explains
why PR #14's reindex 1101 was fixed by *batching* (fewer subrequests) and why the
export under-production stopped at ~245 conversations × ~4-5 subrequests ≈ 1000.

**How to apply:** budget hub work (export slices, reindex pages, cleanup phases,
per-invocation batch budgets) in subrequests, ~800 per invocation for headroom.
When counting a writeSession-style operation: 3 + insert-chunk count, not
statement count. If a future 1101 seems to contradict this, re-run a positive
control before changing the model. Related: [[project-decisions]].
