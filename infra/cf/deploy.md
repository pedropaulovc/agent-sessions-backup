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
| `pedro@vezza.com.br` | **non-production** `cbb04a26e6fa2d0cdc4eb67c735e5669` (workers.dev subdomain `agent-sessions-nonproduction`) | per-PR self-contained previews (`pr-<n>-*` Worker + D1/R2/KV/Queues) — no production resource, credential, or data | the `Preview Control` workflow (via the account-scoped token below), and exceptional hand-run preview administration (scoped `wrangler login` per AGENTS.md) |

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

## Trusted per-PR preview controller

The default-branch `Preview Control` workflow is the only PR resource allocator. Its
unprivileged build job checks out the exact successful CI head, installs dependencies with
lifecycle scripts disabled, and bundles under a network namespace using the trusted Wrangler
and generated configuration. Only canonical bundle, migration, content, and provenance
manifests cross into the `preview-control` environment.

The credentialed provision job never checks out or executes the PR. It generates every name
and binding, rejects the production account and known production resource IDs, and deploys
each PR's **self-contained preview in place**: one stable Worker `pr-<number>-app`, publicly
reachable at `https://pr-<number>-app.agent-sessions-nonproduction.workers.dev`, backed by
persistent `pr-<number>-{sessions-index,agent-sessions,sessions-hub-kv,parse,parse-dlq}`
resources created if missing and reused across pushes. There is no front door, no Cloudflare
Access, and no blue/green generation machinery — the deploy IS the promote, so a broken push
briefly breaks that PR's preview until the next one.

After a provision succeeds, a separate trusted, no-secret job creates a transient GitHub
deployment attached to the immutable PR head SHA (`preview/pr-<number>`), rather than the
`workflow_run` controller's `main` SHA. It records the deployment ID before its in-progress
status write so the no-secret terminalizer can recover a transient GitHub API failure. Every
create or terminal-card write repeats the source-CI and current-head checks; the card exposes
the stable workers.dev URL while remote smoke runs, then records the terminal smoke result and
inactivates older cards for that PR. Separate no-secret close and janitor follow-ups mark cards
inactive after resource removal. Only these no-secret jobs hold `deployments: write`; PR CI never
receives it.

**Auth is one derived per-PR bearer.** `PREVIEW_BEARER = HMAC-SHA256(seed, "sessions-preview-bearer:pr-<n>")`
is baked into the Worker as its only gate; browsers mint a session cookie by visiting
`/?token=…` (what `preview:open` prints), agents and CI send `Authorization: Bearer`. Every
principal derives the token independently from the `PREVIEW_BEARER_SEED` secret (GitHub
environment + `~/.config/agent-sessions/preview-seed` on the owner's machines), so the public
repo never moves a secret through logs, artifacts, or job outputs. The Worker holds only the
derived token: leaking one preview's token compromises that one disposable preview, never the
seed. The URL pattern is guessable, so the token is the entire gate — acceptable because a
preview holds only synthetic fixtures and sessions the owner deliberately exported.

**Migration divergence auto-reset.** Wrangler's D1 ledger tracks applied migrations by name
only, so a PR that edits one of its own already-applied migration files would silently keep
the old schema in its persistent preview D1. The provisioner records each applied file's
sha256 in the preview's `meta` table and, on divergence (edited bytes or a vanished applied
name), deletes and recreates the D1 and reapplies from scratch — loudly, in the job log.
Uploaded sessions vanish in that one case; re-uploading is one command. Manual full reset:
dispatch `Preview Close` against the open PR, then re-run CI.

PR close and the scheduled janitor delete by deterministic name: close removes the
`pr-<number>-*` set (detaching queue consumers, emptying R2 first); the janitor sweeps every
resource of a closed PR plus any debris from the retired per-generation naming scheme.

Configure the protected GitHub `preview-control` environment with:

- secrets `CLOUDFLARE_API_TOKEN` and `PREVIEW_BEARER_SEED` (>= 32 random characters);
- variable `CLOUDFLARE_ACCOUNT_ID=cbb04a26e6fa2d0cdc4eb67c735e5669`.

That account's workers.dev subdomain is `agent-sessions-nonproduction.workers.dev`. The
account-owned token is restricted to this non-production account, expires after 90 days, and has
Workers Scripts Write, Workers KV Storage Write, D1 Write, Workers R2 Storage Write, Queues
Write, Account Settings Read, and Workers Tail Read. Rotate it before expiry. PR-triggered jobs
receive neither the token nor account administration access; only the provision job holds it
(smoke holds just the bearer seed).

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

