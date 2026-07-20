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

For `sessions-hub`:

- **Production branch:** `main`
- **Builds for non-production branches:** disabled (the preview Worker owns them)
- **Build command:** `cd hub && npm ci`
- **Deploy command:** `cd hub && npx wrangler deploy`

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

GitHub Actions stays the PR gate (typecheck + vitest + pytest); Workers Builds owns deploys.

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
