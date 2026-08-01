---
name: d1-preview-isolation
description: Cloudflare D1 has no per-database token scoping and no workload identity federation; why preview/prod isolation can only be bought with a separate account
metadata:
  type: reference
---

Cloudflare **D1 API-token permissions are account-scoped**. There is no per-database
resource the way R2 has per-bucket — verified against Cloudflare's published OpenAPI
schema, which carries `com.cloudflare.edge.r2.bucket{,.read,.write}` but **zero** D1
resource keys. So a "preview-only" D1 token can still write the production database,
whose id is committed in `hub/wrangler.jsonc`.

Cloudflare also has **no workload identity federation** for its API — only static API
tokens (open request: cloudflare/workers-sdk#11434, no official response as of
2026-06-26). So OIDC cannot be federated directly to Cloudflare.

The Worker **binding** is the only construct that bounds reach — but it is **not** a
security boundary against a PR, because **Workers Builds builds each branch preview
from the PR's own checkout**, so `wrangler.jsonc` (and therefore
`env.preview.d1_databases[].database_id`) is PR-controlled. Any check placed inside the
Worker is likewise PR-controlled and can simply be deleted. PR #66 works around this
with a `preview_environment_marker` row the endpoint checks before writing — which
defends against **accident** (mistyped/copy-pasted db id, bad merge) and explicitly not
against a malicious author.

**The only real isolation is a separate Cloudflare account**, where nothing reachable
from a build can name production at all.

Decided 2026-08-01 to ship without that, because `main` has no branch protection and
there is one collaborator — so PR-open access already implies a direct push to `main`,
which runs CI's `deploy` job with the full-account `CLOUDFLARE_API_TOKEN`. **Revisit if
`main` gains branch protection or the repo gains collaborators**: that shortcut closes
and the endpoint becomes a genuine privilege escalation.

See [[deploy-migrations-gap]] for who deploys what, and [[wrangler-d1-query-gotchas]]
for the `CLOUDFLARE_ACCOUNT_ID` requirement when running `wrangler d1` against this
multi-account login.
