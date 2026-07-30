# Deploying the hub

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

## Deployment ownership

### Production: GitHub Actions

`.github/workflows/ci.yml` is the sole production deployer. Cloudflare Workers
Builds production auto-deploy is disabled. After the hub typecheck and tests pass,
one concurrency-locked job applies D1 migrations and then deploys `sessions-hub`.
GitHub does not guarantee the order of jobs waiting on a concurrency group, so the
job fetches `main` after acquiring the lock and skips every step after checkout when
its commit is stale. Together, the lock and freshness guard prevent interleaved
migrations and an older run rolling production back after a newer deployment.
The Worker deploy passes `--env ""` explicitly so Wrangler selects the top-level
production bindings instead of relying on its multiple-environment default.

Cloudflare does not currently exchange GitHub Actions OIDC assertions for Wrangler
credentials. Its [GitHub Actions documentation](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
requires an API token for non-interactive CI. Use two expiring
[account-owned API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
instead of a user token or global API key. Account-owned tokens are service
principals and support D1, Workers, and Queues.

Create both tokens under **Manage Account → Account API Tokens**, include only the
`18ef3246…` production account, and set an explicit expiration. This repository's
default is 90 days with a rotation reminder at least 14 days before expiry.

| GitHub environment secret | Cloudflare account permissions | Used by |
|---|---|---|
| `CLOUDFLARE_D1_TOKEN` | D1 · Edit | `wrangler d1 migrations apply sessions-index --remote` |
| `CLOUDFLARE_WORKERS_TOKEN` | Workers Scripts · Edit; Queues · Edit | `wrangler deploy --env ""` |

Do not grant Account Settings, Workers KV Storage, Workers R2 Storage, or zone
Workers Routes permissions. The account ID is pinned in `hub/wrangler.jsonc`;
the deploy references existing KV/R2 bindings and uses account-level Worker
custom domains rather than zone route patterns.

In GitHub, create a `production` environment restricted to the `main` branch,
add the two secrets above, and enable a required reviewer when a second trusted
reviewer is available. The workflow grants only `contents: read`; it does not
request `id-token: write` because Cloudflare has no supported GitHub OIDC
exchange.

Cut over without losing deployment access:

1. Create the two account tokens and the GitHub `production` environment secrets.
2. Merge the workflow change only after both environment secrets exist.
3. Observe one successful main deployment: D1 migration first, Worker deploy second.
4. Delete the old repository secret `CLOUDFLARE_API_TOKEN` and revoke its Cloudflare token.

For routine rotation, create successors with the same scopes, replace both
environment secrets, verify one normal deployment, then delete the old tokens.
Do not use Cloudflare's Roll operation for planned rotation: it invalidates the
old value immediately and removes the safe overlap window.

### Preview: Workers Builds

The DO-free `sessions-hub-preview` service owns automatic branch previews. A
Worker that implements a Durable Object cannot receive Cloudflare Preview URLs,
and Workers Builds pins an upload to the Worker connected in the dashboard,
overriding Wrangler's environment `name` and `--name`.

For `sessions-hub-preview`:

- **Production branch:** `main`
- **Builds for non-production branches:** enabled
- **Build command:** `cd hub && npm ci`
- **Deploy command:** `cd hub && npx wrangler versions upload --env preview --name sessions-hub-preview`
- **Non-production branch deploy command:** the same `versions upload` command
- **Domains & Routes:** production `workers.dev` URL disabled; Preview URLs enabled

The explicit environment is load-bearing: Workers Builds' default `versions upload`
uses the top-level production bindings. `--env preview` selects the complete isolated
binding set, while the matching explicit name makes configuration drift visible in
the build log. GitHub Actions remains the PR gate for typecheck, Vitest, and pytest.

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
