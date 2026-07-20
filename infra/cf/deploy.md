# Deploying the hub (Workers Builds)

The hub deploys from `main` on the `18ef3246…` account. Two paths matter, and they must
target different resources — production must never be touched by a PR preview.

## Environments

| Env | Worker name | Bindings | Auth | Serves on |
|---|---|---|---|---|
| production (top-level config) | `sessions-hub` | `sessions-index`, `agent-sessions-raw`, `sessions-hub-kv`, `CF_OAUTH_BROKER`, `parse`/`parse-dlq` | mTLS (api) + passkeys (viewer), fail-closed | api.sessions.vza.net, sessions.vza.net (custom domains) |
| preview (`env.preview`) | `sessions-hub-preview` | `*-preview` D1/R2/KV/queues | `DEV_AUTH` bearer (ENVIRONMENT=preview) | its `*.workers.dev` version URL |

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
```

## Preview resource IDs (account 18ef3246e9f36d1560485ef53889c0ab)

| Resource | Name / ID |
|---|---|
| D1 | `sessions-index-preview` · `8f2cd488-0060-4f32-8025-f5b461c9fe0a` (migrations applied) |
| KV | `sessions-hub-kv-preview` · `eda3b8a8ba1e416fa65e98d0c266a4bb` |
| R2 | `agent-sessions-raw-preview` |
| Queues | `parse-preview` + `parse-dlq-preview` |
