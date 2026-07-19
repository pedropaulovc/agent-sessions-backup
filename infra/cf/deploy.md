# Deploying the hub (Workers Builds)

The hub deploys from `main` on the `18ef3246…` account. Two paths matter, and they must
target different resources — production must never be touched by a PR preview.

## Environments

| Env | Worker name | Bindings | Auth | Serves on |
|---|---|---|---|---|
| production (top-level config) | `sessions-hub` | `sessions-index`, `agent-sessions-raw`, `sessions-hub-kv`, `parse`/`parse-dlq` | mTLS (api) + passkeys (viewer), fail-closed | api.sessions.vza.net, sessions.vza.net (custom domains) |
| preview (`env.preview`) | `sessions-hub-preview` | `*-preview` D1/R2/KV/queues | `DEV_AUTH` bearer (ENVIRONMENT=preview) | its `*.workers.dev` version URL |

`env.preview` redeclares every binding (wrangler does not inherit bindings into named
environments) and sets `"routes": []` (it *does* inherit `routes`, so without the empty
override a preview deploy would steal the production custom domains).

## Workers Builds configuration (set once, in the dashboard)

The repo is not connected to Workers Builds yet. When connecting (Workers & Pages →
the `sessions-hub` Worker → Settings → Builds → Connect repo), set:

- **Production branch:** `main`
- **Build command:** `cd hub && npm ci`
- **Deploy command (production branch):** `cd hub && npx wrangler deploy`
- **Non-production branch deploy command:** `cd hub && npx wrangler versions upload --env preview`

The non-production override is the load-bearing line: Workers Builds' default for
non-production branches is `wrangler versions upload` with **no** environment, which uses
the top-level (production) bindings. `--env preview` is what pins a PR build to the
`-preview` resources and the `sessions-hub-preview` Worker.

GitHub Actions stays the PR gate (typecheck + vitest + pytest); Workers Builds owns deploys.

## One-time secrets

- Production: `SETUP_TOKEN` (set), `CF_CLIENT_CERT_TOKEN` (cert renewal, `POST /api/v1/certs/renew`
  — unset until the user provisions it; see infra/cf/mtls.md "Cert renewal endpoint").
- Preview: `DEV_AUTH` — the bearer that gates the public preview URL. Until it is set, the
  preview fails closed (denies), which is safe. Set with:
  `cd hub && npx wrangler secret put DEV_AUTH --env preview`

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
