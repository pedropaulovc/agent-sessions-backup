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
security boundary against a PR when preview code builds from the PR's own checkout:
`wrangler.jsonc` (and therefore any database id in it) is PR-controlled, and any check
placed inside the Worker is likewise PR-controlled and can simply be deleted.

**The only real isolation is a separate Cloudflare account** for the preview
application resources (workers, D1, R2, queues) — and that is what shipped. The
2026-08-01 decision to defer it was SUPERSEDED on 2026-08-04 (PRs #83–#116): previews
now run in a dedicated non-production account (`cbb04a26…`, identity
pedro@vezza.com.br with no production membership), provisioned only by the protected
`Preview Control` workflow; the Workers Builds previews this note originally described
are retired. (2026-08-13: the production-account front door + Cloudflare Access that
briefly fronted these previews was retired too — previews are now self-contained at
`pr-<n>-app.agent-sessions-nonproduction.workers.dev` behind a derived per-PR bearer.)
Current model: `infra/cf/deploy.md` ("Identities and accounts").

See [[deploy-migrations-gap]] for who deploys what, and [[wrangler-d1-query-gotchas]]
for the `CLOUDFLARE_ACCOUNT_ID` requirement when running `wrangler d1` against this
multi-account login.
