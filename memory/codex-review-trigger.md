---
name: codex-review-trigger
description: Codex PR review uses a smart trigger — it may skip pushes; @codex review forces one
metadata:
  type: project
---

Since 2026-07-17, the repo's Codex GitHub review runs on a "smart trigger": Codex
decides per-push whether to review based on the changes, so a push may get NO
👀/👍 reaction at all.

**Why:** the old always-review behavior meant silence = "not reviewed yet"; now
silence may mean "Codex chose to skip".

**How to apply:** after CI settles green on a push, wait ~10–15 min; if no Codex
reaction/review arrived, comment `@codex review` on the PR to force one (its ack
is a comment-reaction 👀, verdict 👍 or a review). For merging, treat green CI +
0 unresolved threads + either a 👍 or a declined/silent smart trigger as clean.

The main motivation is rebase churn eating review quota. Consequences: (a) don't
push gratuitous rebases — rebase only when the monitor reports BEHIND/DIRTY;
(b) with stacked PRs or a merge-queue flow, after merging one PR explicitly
`@codex review` the next PR in line once it's rebased — its rebase push likely
won't auto-trigger a review.

Stacked-PR merge trap (hit 2026-07-18 on PR #12): ALWAYS check `baseRefName`
before `gh pr merge` — merging a PR whose base is its stacked parent branch
lands the commits on THAT branch, not main, even though gh reports MERGED.
Retarget to main first (`gh pr edit --base main`) once the parent has merged;
don't force a Codex re-review of identical already-approved commits afterward.
Related: [[project-decisions]].
