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
| `pedro@vza.net` | **production** `18ef3246e9f36d1560485ef53889c0ab` | the live hub (`sessions.vza.net` / `api.sessions.vza.net`), production D1/R2/Queues, the managed CA | production deploys (protected, `main`-only CI), production secrets (`wrangler secret put` after `whoami` shows this account), zone administration |
| `pedro@vezza.com.br` | **non-production** `cbb04a26e6fa2d0cdc4eb67c735e5669` (workers.dev subdomain `agent-sessions-nonproduction`) | per-PR self-contained previews (`pr-<n>-*` Worker + D1/R2/KV/Queues) — no production resource, credential, or data | the `preview` job in CI (via the account-scoped token below), and exceptional hand-run preview administration (scoped `wrangler login` per AGENTS.md) |

Rules that follow from the table:

- **Agents never authenticate to the production account.** Anything an agent legitimately
  needs there is already reachable another way (the machine API, the viewer, a hand-carried
  session export) or is a protected-CI concern. A hand-run `wrangler` command against
  production is an owner-at-keyboard operation.
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

## Per-PR previews, deployed by the PR's own CI run

**A PR environment is safe for anyone to deploy, so nobody hands a release across a trust
barrier to deploy it.** The `preview` job in `.github/workflows/ci.yml` runs on `pull_request`
from the PR's own checkout and does the whole thing in one job: build, migrate, deploy, smoke,
seed, browser e2e. It needs `needs: hub`, so a PR whose tests or migration check fail never
reaches Cloudflare.

The credential it holds is scoped to a Cloudflare account whose entire contents are `pr-<n>-*`
resources — no production data, route, credential, or application secret, and no path to any.
That is what makes the barrier unnecessary, and it is the only thing that does. Everything the
job still refuses (the pinned account ID, the production-identifier scan over every generated
config, the `pr-<n>-` name prefix on every resource) guards against a **misconfiguration** —
a wrong account ID, a copy-pasted production resource name — not against the PR author.

Each PR gets a **self-contained preview deployed in place**: one stable Worker `pr-<number>-app`,
publicly reachable at `https://pr-<number>-app.agent-sessions-nonproduction.workers.dev`, backed
by persistent `pr-<number>-{sessions-index,agent-sessions,sessions-hub-kv,parse,parse-dlq}`
resources created if missing and reused across pushes. There is no front door, no Cloudflare
Access, and no blue/green generation machinery — the deploy IS the promote, so a broken push
briefly breaks that PR's preview until the next one.

**The deployment card is GitHub's, not ours.** The job declares
`environment: { name: preview/pr-<number>, url: … }`, so Actions opens the deployment when the
job starts and closes it with the job's own conclusion. The card cannot claim a state the
workflow is not in, there is nothing to claim, reconcile, supersede, or terminalize, and because
the job runs on the `pull_request` event the run is a check on the PR rather than an orphaned
run attached to `main`. Fork PRs receive no secrets from GitHub, so the job fails there rather
than skipping: a preview that silently does not exist is worse than one that says why.

The single exception is **removal**, which is not a job conclusion: the resources are deleted
long after the run that created them ended. `Preview Close` and `Preview Janitor` therefore hold
`deployments: write` and mark that PR's cards inactive after the Cloudflare delete succeeds.

**Auth is one derived per-PR bearer.** `PREVIEW_BEARER = HMAC-SHA256(seed, "sessions-preview-bearer:pr-<n>")`
is baked into the Worker as its only gate; browsers mint a session cookie by visiting
`/?token=…` (what `preview:open` prints), agents and CI send `Authorization: Bearer`. Every
principal derives the token independently from the `PREVIEW_BEARER_SEED` secret (repository
secret + `~/.config/agent-sessions/preview-seed` on the owner's machines). The `preview` job
publishes the derived bearer as the public PR login code; it never publishes the seed. The Worker
holds only the derived token: reading one preview's Worker vars exposes that one disposable
preview, not the seed. The URL pattern is guessable, so the token is the entire gate — acceptable
because a preview holds only synthetic fixtures and sessions the owner deliberately exported.

The seed is a **repository** secret, which means any same-repository branch can read the seed
that derives every PR's bearer, not only its own. That is the same exposure as "any PR author
can deploy a preview" — the deliberate trade this model makes — and it is bounded by what a
preview holds. It is not a production credential and must never become one.

**Migration divergence auto-reset.** Wrangler's D1 ledger tracks applied migrations by name
only, so a PR that edits one of its own already-applied migration files would silently keep
the old schema in its persistent preview D1. The provisioner records each applied file's
sha256 in the preview's `meta` table and, on divergence (edited bytes or a vanished applied
name), deletes and recreates the D1 and reapplies from scratch — loudly, in the job log.
Uploaded sessions vanish in that one case; re-uploading is one command. Manual full reset:
dispatch `Preview Close` against the open PR, then re-run CI — the next `preview` job
reprovisions it empty.

PR close and the scheduled janitor delete by deterministic name: close removes the
`pr-<number>-*` set (detaching queue consumers, emptying R2 first); the janitor sweeps every
resource of a closed PR plus any debris from the retired per-generation naming scheme.

### Credentials

Three values at **repository** scope, because a dynamic `preview/pr-<n>` environment cannot
carry secrets:

| kind | name | value |
|---|---|---|
| secret | `CLOUDFLARE_PPE_API_TOKEN` | account-owned, non-production-only, 90-day |
| secret | `PREVIEW_BEARER_SEED` | the standing seed, >= 32 random characters |
| variable | `CLOUDFLARE_PPE_ACCOUNT_ID` | `cbb04a26e6fa2d0cdc4eb67c735e5669` |

Provision and install all three with one command, which prints the identity and account to pick
and fails if the signed-in identity can reach production:

```bash
node infra/cf/preview-token.mjs --set     # `--set` omitted: report what is missing
```

**Creating the token itself is the one manual step, and it is Cloudflare's floor, not ours.**
Measured 2026-08-16, so nobody re-litigates it:

- Wrangler's OAuth scope list (`wrangler login --scopes-list`) has no token-management scope at
  all, so no `wrangler auth create` invocation can grant one.
- With a Wrangler OAuth token, both `/accounts/<id>/tokens/permission_groups` and
  `/user/tokens/permission_groups` answer `403` code `9109`. Minting needs API Tokens Write.
  ([workers-sdk#13042](https://github.com/cloudflare/workers-sdk/issues/13042) is the open ask.)
- The only programmatic mint, `POST /user/tokens`, authenticates with the **Global API Key** —
  which is itself dashboard-only and strictly more dangerous than the token it would create.
- Feeding CI a Wrangler **refresh token** instead is worse than unavailable, it is a trap: refresh
  tokens rotate on every use, and replaying a rotated one makes Cloudflare revoke the whole grant
  family — access token included. Two concurrent preview jobs would take each other out, and the
  repository secret would be dead rather than stale.

- [OAuth clients](https://developers.cloudflare.com/fundamentals/oauth/) (account → Manage Account →
  OAuth clients) do not rescue this either. The dashboard's **Grant type** offers only
  Authorization Code (mandatory, not deselectable) plus optional Refresh Token, and **Token
  Authentication Method** offers only None (PKCE), Client Secret Basic, and Client Secret POST.
  Cloudflare's `/.well-known/openid-configuration` advertises `client_credentials` and
  `private_key_jwt`, but that is the upstream OAuth server's generic capability list, not what
  Cloudflare permits — checked in the dashboard 2026-08-16. Every flow on offer needs a human at a
  browser, and lands back on a rotating refresh token.

So: create the token by hand once, then `--set --token-file`. The script installs the seed and the
account ID on its own, so the paste is the only thing left, and a 90-day account-pinned token beats
a user-wide OAuth grant for CI anyway — it cannot follow the identity into a new account.

That account's workers.dev subdomain is `agent-sessions-nonproduction.workers.dev`. The token is
restricted to this non-production account, expires after 90 days, and has Workers Scripts Write,
Workers KV Storage Write, D1 Write, Workers R2 Storage Write, Queues Write, and Account Settings
Read — nothing tails, so there is no Workers Tail Read. Rotate it before expiry by re-running the
command above.

Account membership is the authorization boundary, not an email string in repository code.
Operationally, `pedro@vza.net` owns/administers the production account and
`pedro@vezza.com.br` is the non-production-only identity. Preview administration must verify the
selected account ID and the identity's complete membership list, and must fail if that list
contains the production account.

## Moving a production session into a preview

The owner opens the session in the production viewer (passkey session), clicks **Export
zip**, and hands the file to the agent. The agent runs
`node hub/scripts/preview-upload-session.mjs --pr <number> --zip <file>` — each zip entry is
a standard `PUT /api/v1/files/{machine}/{store}/{relpath}` against the preview, authenticated
by the derived bearer. No production credential, encryption envelope, or cross-account flow
is involved; "no agent moves prod bytes without my passkey" holds because the passkey-gated
export is the only way bytes leave production.

