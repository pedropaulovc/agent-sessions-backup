# Deploying the hub (Workers Builds)

The hub deploys from `main` on the `18ef3246…` account. Production, branch previews, and
their stable front door target separate Workers — production must never be touched by a PR
preview.

## Environments

| Env | Worker name | Bindings | Auth | Serves on |
|---|---|---|---|---|
| production (top-level config) | `sessions-hub` | `sessions-index`, `agent-sessions-raw`, `sessions-hub-kv`, `CF_OAUTH_BROKER`, `parse`/`parse-dlq` | mTLS (api) + passkeys (viewer), fail-closed | api.sessions.vza.net, sessions.vza.net (custom domains) |
| preview (`env.preview`) | `sessions-hub-preview` | `*-preview` D1/R2/KV/queues | `DEV_AUTH` bearer (ENVIRONMENT=preview) | its `*.workers.dev` version URL |
| preview front door | `sessions-preview-front-door` | none | delegates to preview Worker | `<branch>-preview.sessions.vza.net` |

`env.preview` redeclares every binding (wrangler does not inherit bindings into named
environments) and sets `"routes": []` (it *does* inherit `routes`, so without the empty
override a preview deploy would steal the production custom domains).

## Workers Builds configuration (set once, in the dashboard)

Connect **both** Workers to `pedropaulovc/agent-sessions-backup`. A Worker that implements
a Durable Object cannot receive Cloudflare Preview URLs. Workers Builds also pins an upload
to the Worker connected in the dashboard, overriding Wrangler's environment `name` and
`--name`. The DO-free `sessions-hub-preview` service therefore needs its own Git connection.

For `sessions-hub` — **connected for builds only; it must not deploy.** CI's `deploy` job is the
sole production deployer (it applies D1 migrations *then* deploys, which Workers Builds cannot do).
Two systems deploying `main` independently race, and the one that loses ships code against the
wrong schema — the failure that fired the parse-errors alert on 2026-07-22:

- **Production branch:** `main`
- **Deploy to production:** **disabled** — CI owns it
- **Builds for non-production branches:** disabled (the preview Worker owns them)
- **Build command:** `cd hub && npm ci`

For `sessions-hub-preview`:

- **Production branch:** `main`
- **Builds for non-production branches:** enabled
- **Build command:** `cd hub && npm ci`
- **Deploy command:** `cd hub && npx wrangler versions upload --env preview --name sessions-hub-preview`
- **Non-production branch deploy command:** the same `versions upload` command
- **Domains & Routes:** production `workers.dev` URL disabled; Preview URLs enabled

The explicit environment is load-bearing: Workers Builds' default `versions upload` uses
the top-level production bindings. `--env preview` selects the complete isolated binding
set, while the matching explicit name makes configuration drift visible in the build log.

GitHub Actions is the PR gate (typecheck + vitest + pytest) **and the sole production deployer**.
Workers Builds owns preview uploads only. Verified on the current `main`: its check runs list
`Workers Builds: sessions-hub-preview` and CI's `deploy`, with no `Workers Builds: sessions-hub`.

**Preview migrations are not Workers Builds' job.** The deploy command above uploads code and
nothing else, so `sessions-index-preview` is migrated by CI's `migrate-preview` job
(`wrangler d1 migrations apply DB --env preview --remote`, on every same-repo PR, gated on the
hub tests) rather than by the deploy. Note `DB --env preview` and not the database name: the
preview D1 exists only under `env.preview`, and wrangler resolves the target against the
selected environment's bindings. Without that job a branch preview runs new code against the
old preview schema — PR #65 shipped migration 0016 and every `/api/v1/usage` request on its
preview returned `no such table: model_prices` until the migration was applied by hand.

That job holds **no Cloudflare credential at all**, and cannot be given one safely. Cloudflare's
D1 token permissions are *account*-scoped — unlike an R2 bucket there is no "one database"
resource for D1, confirmed against Cloudflare's published API schema, which carries
`com.cloudflare.edge.r2.bucket{,.read,.write}` but no D1 resource key — and Cloudflare has no
workload-identity federation for its API (an open request, cloudflare/workers-sdk#11434). Add that
a same-repo PR runs its *own* copy of the workflow, and any token handed to this job can reach
production D1 no matter how the job is written.

So it uses the one construct in D1's model that bounds reach at all: the **binding**. The preview
Worker's `DB` is `sessions-index-preview`, so CI calls `POST /api/v1/admin/migrate` on that Worker
rather than talking to Cloudflare's API, and the call can only touch databases bound to it.

**The binding alone is not sufficient, and it is worth being exact about why.** It is declared in
`hub/wrangler.jsonc`, and Workers Builds builds each branch preview from the PR's *own* checkout —
so a PR can repoint `env.preview.d1_databases[].database_id` at the production database (the id is
committed in that same file) and its preview Worker would then be bound to production. Nothing in
the deployment path stops that.

The endpoint therefore **asks the database it is actually bound to whether it is the preview one**,
immediately before it writes anything — and *after* verifying the caller's OIDC token. That order
matters and must not be reversed: this route has no mTLS and its `workers.dev` preview alias is
publicly reachable, so checking the marker first would let any unauthenticated POST force a query
against the shared preview database and burn its quota. Authentication first, marker check
immediately before any write, so the check still runs on every path that writes — which is all it
was ever protecting. The preview database carries a
`preview_environment_marker` row; production does not. A repointed binding gets
`409 not_preview_database` instead of a migration, and it fails **closed** — a missing table, a
missing row, a wrong value, or any error at all means no writes.

**This stops an accident, not an attacker.** The check is itself PR-controlled code, so a hostile
PR can delete it, and no check inside this Worker can do better, because Workers Builds builds the
Worker from the PR. What it reliably prevents is a mistyped or copy-pasted database id, a bad
merge, or a stale config pointing the preview at production — the realistic failure.

The malicious-author case is bounded by the repository rather than by this code. The job runs only
for same-repo PRs, so it needs push access; `main` is unprotected, so that access already permits a
direct push to `main`, which runs CI's `deploy` job with the full-account `CLOUDFLARE_API_TOKEN`.
This endpoint grants strictly less than such an attacker already holds — which is a statement about
the repository's posture, not a property of the endpoint. If that posture changes (branch
protection on `main`, or additional collaborators), the honest fix is to host preview D1 in a
**separate Cloudflare account**, where nothing reachable from a build can name production at all.

Seeding that marker is a one-time manual step, done with the production credential — deliberately
*not* by a migration or by the endpoint, since anything a PR can cause to run could otherwise mint
the marker on the database it just repointed itself at:

```bash
cd hub && npx wrangler d1 execute DB --env preview --remote --command \
  "CREATE TABLE IF NOT EXISTS preview_environment_marker (value TEXT NOT NULL);
   DELETE FROM preview_environment_marker;
   INSERT INTO preview_environment_marker (value) VALUES ('sessions-index-preview');"
```

Authentication is a short-lived **GitHub OIDC assertion** (`permissions: id-token: write`), minted
per run, no stored secret. The endpoint pins issuer, audience (`sessions-hub-preview-migrate`) and
`repository`, requires RS256 against GitHub's JWKS, and validates claims only after the signature.
It 404s unless `ENVIRONMENT=preview`, and `MIGRATE_OIDC_REPOSITORY` is set **only** in
`env.preview.vars`, so the route cannot exist in production even by accident.

Two properties worth knowing before relying on it:

- **It converges rather than ordering.** Workers Builds deploys the preview independently of CI, so
  on a brand-new branch the endpoint may not be live when the job runs. *That* case retries a few
  times and then leaves a notice rather than a red build, because it resolves itself on the next
  push. A response from the endpoint's own handler (any JSON body with an `error` key — 401, 409,
  422, 500) is the opposite: it never fixes itself, so the job fails loudly. Swallowing those is
  how #65 shipped an unapplied migration in the first place.
- **The migration SQL comes from the PR.** That is deliberate: the preview Worker is itself built
  from PR code, so bundling the migrations would be no less PR-controlled. The binding bounds the
  blast radius, not the provenance of the SQL. The endpoint refuses any migration its statement
  splitter cannot handle safely (trigger bodies, unbalanced quotes) rather than risk applying half
  of one. The splitter is quote-aware — `'--claude-worktrees-'` in migrations 0011/0012 is a real
  literal that a naive comment strip truncates mid-statement — and a test runs it over every
  migration this repo ships, asserting the literals survive the round trip.

**Workflow edits must be checked with `actionlint .github/workflows/*.yml` before pushing.** A bad
Actions expression is rejected at validation time and the run produces *zero* jobs, so every other
check silently never runs — `152d7f1` referenced `secrets` in a step `if:` and took `hub`,
`client` and `collector` down with it. A YAML parse does not catch this; actionlint does. CI runs
it too, but it cannot catch a fatal error in its own file, because validation precedes scheduling.

## Stable branch preview front door

Cloudflare's automatic branch aliases remain the deployment targets produced by Workers
Builds. The independently deployed `sessions-preview-front-door` maps
`https://<branch>-preview.sessions.vza.net/path?query` to the one fixed upstream shape
`https://<branch>-sessions-hub-preview.pedro-18e.workers.dev/path?query`. It preserves the
method, headers, streaming request/response bodies, path, and query. A same-public-origin
`Origin` header is rewritten to the upstream origin so the application's exact CSRF check
continues to work; cross-origin values are never laundered. Absolute redirects back to that
alias are rewritten to the public branch host; unrelated redirects are untouched.
Invalid hosts and branch labels return 404 without making an upstream request, so this is not
an open proxy. The front door's `global_fetch_strictly_public` compatibility flag is
load-bearing: Cloudflare otherwise rejects a Worker-to-Worker fetch through a public
`workers.dev` alias with error 1042.

Here `<branch>` means the DNS-safe branch prefix Cloudflare shows in its automatic alias,
not necessarily the repository's raw branch name (for example, `/` is normalized to `-`).

The front door is deliberately separate from both Workers Builds connections. Keep the
existing `sessions-hub-preview` production and non-production commands as
`cd hub && npx wrangler versions upload --env preview --name sessions-hub-preview`; do not
replace them with a GitHub Action or deploy the front door on each PR. Deploy the front door
only when its own code/config changes:

```
cd hub
npx wrangler deploy --config wrangler.preview-front-door.jsonc
```

One-time bootstrap prerequisites are a proxied wildcard DNS record for
`*.sessions.vza.net` and the `*-preview.sessions.vza.net/*` Worker route from
`wrangler.preview-front-door.jsonc`. Workers Custom Domains require exact hostnames and
cannot represent this branch wildcard. The existing active `*.sessions.vza.net` Advanced
Certificate covers every branch preview hostname. Provision the DNS record and route once;
branch previews then need no DNS, certificate, or front-door deployment changes.

The front door preserves the existing **one-time preview bootstrap**, not production passkey
login. Its forwarded `__Host-preview-auth` cookie has no `Domain`, so the browser stores it as
a host-only cookie on that branch's public preview hostname. The production
`__Host-session` cookie is also host-only and is therefore not sent to a branch preview.
WebAuthn ceremonies remain pinned to `VIEWER_HOST=sessions.vza.net`; the upstream preview sees
its `workers.dev` alias and rejects them with `bad_host`. Teaching unreviewed PR code to request
assertions for the production `sessions.vza.net` RP ID would expand production passkey trust to
preview code. Do not do that merely to make the hostname look related; it requires a separate
security decision. Continue using a single-use `/_preview/bootstrap` URL as documented below.

## One-time credentials

- Production secret: `SETUP_TOKEN` (set). Certificate renewal stores no API token or OAuth client
  secret. A private Cloudflare OAuth client uses Authorization Code + PKCE, and its grant stays inside
  the SQLite `CF_OAUTH_BROKER` Durable Object. See infra/cf/mtls.md "Cloudflare OAuth connection".
- Preview: `DEV_AUTH` — the bearer that gates the public preview URL. Until it is set, the
  preview fails closed (denies), which is safe. Set with:
  `cd hub && npx wrangler versions secret put DEV_AUTH --env preview`. A secret update creates
  a new version; the next automatic branch build inherits it and moves the branch alias.

Passkeys cannot authenticate on `*.workers.dev` because WebAuthn is intentionally pinned to
`sessions.vza.net`. For browser review, generate a random nonce and insert
`preview_auth:<sha256hex(nonce)>` into the preview D1 `meta` table with its expiry epoch in
milliseconds as the value. Open `/_preview/bootstrap?token=<nonce>&next=<encoded-relative-path>`.
The Worker atomically deletes the row, rejects expired/reused tokens, issues the HttpOnly preview
cookie, and redirects. Never place the long-lived `DEV_AUTH` value in a URL.

## Verifying config without deploying

```
cd hub
npx wrangler deploy --env preview --dry-run   # preview bindings resolve, no route warning
npx wrangler deploy --dry-run                 # production keeps the two custom domains
npx wrangler deploy --config wrangler.preview-front-door.jsonc --dry-run
```

## Preview resource IDs (account 18ef3246e9f36d1560485ef53889c0ab)

| Resource | Name / ID |
|---|---|
| D1 | `sessions-index-preview` · `8f2cd488-0060-4f32-8025-f5b461c9fe0a` (migrations applied) |
| KV | `sessions-hub-kv-preview` · `eda3b8a8ba1e416fa65e98d0c266a4bb` |
| R2 | `agent-sessions-raw-preview` |
| Queues | `parse-preview` + `parse-dlq-preview` |
