# Deploying the hub and trusted PR previews

Production deploys from `main` to account `18ef3246e9f36d1560485ef53889c0ab`.
Ephemeral PR resources must use a different Cloudflare account containing no production
resource, credential, data, route, or application secret.

## Identities and accounts — which one, for what

Every Cloudflare operation in this repo belongs to exactly one of two identity/account
pairs. When an instruction says "log in" or "verify the account", it means one specific
row of this table — never a choice:

| identity | account | holds | used for |
|---|---|---|---|
| `pedro@vza.net` | **production** `18ef3246e9f36d1560485ef53889c0ab` | the live hub (`sessions.vza.net` / `api.sessions.vza.net`), production D1/R2/Queues, Access apps, the managed CA | production deploys (protected, `main`-only CI), production secrets (`wrangler secret put` after `whoami` shows this account), Access/zone administration |
| `pedro@vezza.com.br` | **non-production** `cbb04a26e6fa2d0cdc4eb67c735e5669` (workers.dev subdomain `agent-sessions-nonproduction`) | per-PR preview generations, preview D1/R2/Queues — no production resource, credential, or data | the `Preview Control` workflow (via the account-scoped token below), and exceptional hand-run preview administration (scoped `wrangler login` per AGENTS.md) |

Rules that follow from the table:

- **Agents never authenticate to the production account.** Anything an agent legitimately
  needs there is already reachable another way (the machine API, the viewer, the bridge) or
  is a protected-CI concern. A hand-run `wrangler` command against production is an
  owner-at-keyboard operation.
- **`pedro@vezza.com.br` must have no production membership** — preview tooling verifies
  the identity's complete membership list and fails if the production account appears
  (see below). Keep it that way when accepting account invitations.
- **Local Wrangler auth profiles are named for their account row**: the production
  keyring/OAuth profile is `production` (historical name `production-bootstrap` — renamed,
  since it serves all production operations, not just the one-time bootstrap), and the
  non-production one is `preview`. A profile name that doesn't answer "which account?"
  at a glance invites running a command against the wrong one.
- Local development uses **neither**: the loopback hub (`npm --prefix hub run dev:up`)
  needs zero Wrangler scopes and no Cloudflare login.

## Trusted per-PR preview controller

The default-branch `Preview Control` workflow is the only PR resource allocator. Its
unprivileged build job checks out the exact successful CI head, installs dependencies with
lifecycle scripts disabled, and bundles under a network namespace using the trusted Wrangler
and generated configuration. Only canonical bundle, migration, content, and provenance
manifests cross into the `preview-control` environment.

The credentialed job never checks out or executes the PR. It generates every name and binding,
rejects the production account and known production resource IDs, provisions one
`pr-<number>-g<source-run-id>-<sha12>-*` resource generation, applies the verified artifact
migrations, uploads an immutable Worker version, and calls the trusted front door to register,
smoke, and promote that exact tuple. PR close and scheduled janitor workflows delete only typed
inventory released by a tombstone or janitor transition.

Configure the protected GitHub `preview-control` environment with:

- secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, and
  `CF_ACCESS_CLIENT_SECRET`;
- variable `CLOUDFLARE_ACCOUNT_ID=cbb04a26e6fa2d0cdc4eb67c735e5669`.

That account's workers.dev subdomain is `agent-sessions-nonproduction.workers.dev`. The
account-owned token is restricted to this non-production account, expires after 90 days, and has
Workers Scripts Write, Workers KV Storage Write, D1 Write, Workers R2 Storage Write, Queues
Write, Account Settings Read, and Workers Tail Read. Rotate it before expiry. PR-triggered jobs
receive neither the token nor account administration access.

The Access credentials belong to a dedicated service token accepted only by a `Service Auth`
policy on the `*-preview.sessions.vza.net` Access application. Do not attach that policy to the
production viewer or another hostname. The trusted smoke job sends the credentials only to the
exact PR hostname; the front door strips them before proxying to candidate code. Access admission
still grants no route by itself: machine requests also require a short-lived, one-use front-door
grant bound to the PR, head, generation, method, target, body digest, and non-admin identity.
Rotate the service token before expiry and replace both protected environment secrets together.

Configure these non-secret environment variables:

- `PREVIEW_CONTROL_URL`
- `PREVIEW_CONTROL_DEPLOY_AUD`, `PREVIEW_CONTROL_CLOSE_AUD`, and
  `PREVIEW_CONTROL_JANITOR_AUD`
- `PREVIEW_ASSERTION_ISSUER`
- `PREVIEW_BROWSER_ASSERTION_JWKS`, `PREVIEW_ACTION_ASSERTION_JWKS`, and
  `PREVIEW_ORIGIN_ASSERTION_JWKS`

Each JWKS contains public keys only. Never put a signing key, Access credential, or production
authorization in these variables or in a generated PR Worker config.

Account membership is the authorization boundary, not an email string in repository code.
Operationally, `pedro@vza.net` owns/administers the production account and
`pedro@vezza.com.br` is the non-production-only identity. Preview administration must verify the
selected account ID and the identity's complete membership list, and must fail if that list
contains the production account.

## Production debug manifest key

A trusted operator bootstraps the ES256 manifest signer:

1. Generate an EC P-256 JWK pair in the approved secret manager. Send the private JWK directly to secret input. Never print it, save it to a file, or place it in a shell argument.
2. Run `cd hub && npx wrangler whoami` and require production account `18ef3246e9f36d1560485ef53889c0ab`. Then run `npx wrangler secret put DEBUG_EXPORT_MANIFEST_SIGNING_PRIVATE_JWK` from the same directory and inject the private JWK on stdin. Do not use a preview environment.
3. Commit only the public JWK as `{"keys":[<public-jwk>]}` in `sessions-dev-bridge/src/production-manifest-key.json`.
4. Set the same raw public JWK as `DEBUG_EXPORT_MANIFEST_VERIFY_PUBLIC_JWK` in both protected GitHub environments: `sessions-dev-bridge-release` and `preview-control`.
5. Run the protected bridge release workflow. Its release verification and package check reject an empty, private, or non-P-256 key set.

