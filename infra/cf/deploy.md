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
| `pedro@vza.net` | **production** `18ef3246e9f36d1560485ef53889c0ab` | the live hub (`sessions.pedrovc.com.br` / `api.sessions.pedrovc.com.br`), production D1/R2/Queues, the managed CA | production deploys (protected, `main`-only CI), production secrets (`wrangler secret put` after `whoami` shows this account), zone administration |
| `pedro@vezza.com.br` | **non-production** `cbb04a26e6fa2d0cdc4eb67c735e5669` (workers.dev subdomain `sessions-ppe`) | per-PR self-contained previews (`pr-<n>-*` Worker + D1/R2/KV/Queues) — no production resource, credential, or data | the `preview` job in CI (via the account-scoped token below), and exceptional hand-run preview administration (scoped `wrangler login` per AGENTS.md) |

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
publicly reachable at `https://pr-<number>-app.sessions-ppe.workers.dev`, backed
by persistent resources created if missing and reused across pushes:

| binding | per-PR database name | contents / migrations |
|---|---|---|
| `DB` | `pr-<number>-sessions-index` | authoritative metadata, usage, prices, rollups and auth; `hub/migrations` |
| `IDX00` | `pr-<number>-sessions-index-idx00` | full-fidelity transcript blocks, FTS and replicated search catalog; `hub/migrations-index` |
| `IDX01` | `pr-<number>-sessions-index-idx01` | the second index shard; `hub/migrations-index` |

R2, KV, and queues retain the `pr-<number>-{agent-sessions,sessions-hub-kv,parse,parse-dlq,session-rollup}`
names. Generated configurations set `INDEX_SHARD_COUNT='2'`, `INDEX_MODE='active'`, and
`DEPLOYMENT_REVISION` to the full PR head SHA. Count, binding order, hash layout, and database
names are immutable: provision validates both deployed bindings and persisted layout before
reusing resources. There is no fallback index in `DB`.
An existing Worker with a missing database is reset only after its recorded topology
has been validated. Surviving binding IDs must match trusted account resources; the
missing binding must retain a nonempty ID that is absent from the account inventory.
During topology reset, the controller validates the owned queues' consumer identities before
detaching them, then recreates the complete topology. Foreign or malformed bindings fail before mutation.

The provisioner applies and verifies migrations separately against `DB`, `IDX00`, and `IDX01`
before deployment, each with its own database-bound journal and matching source baseline.
Only the main migration set has historical-baseline evidence; shard checksums start at migration
1. The published schema and migration digests cover all three databases, not only main.
Before prices are seeded, the app is deployed, or fixtures are uploaded, the provisioner exercises
the production copier's actual D1 REST batch adapter against `IDX00`. It requires a successful
CREATE/INSERT/SELECT batch and independent readback, removes the uniquely owned probe table, then
requires a native malformed-JSON SQL failure to roll back an entire second batch. Auth/transport
failures, unexpected readback, or partial commits block deployment; only safe verified proof
metadata is published, never provider SQL/error bodies or credentials.
After ordinary provision succeeds, preview CI runs the explicit preview-only
`node infra/cf/preview-control.mjs native-copy-proof` command as a separate required verification
step before smoke or fixture/session seeding. It uses the pinned PPE token, PR/head identity,
the provisioned artifact digest, and the actual index migration manifest; ordinary provision
does not allocate scratch databases. The proof creates three unique PR-owned scratch D1s:
`pr-N-copy-<24hex>-source` and `pr-N-copy-<24hex>-{idx00,idx01}`.
It applies every current `hub/migrations-index/` migration to
the source and both scratch shards, then exercises the actual copier through native D1 REST using
ordinary rows and a value larger than 1 MiB but smaller than 2,000,000 bytes to exercise the
large-value fallback. Full-column SHA-256 readback must match the source exactly, preserving
Unicode, a leading BOM, and embedded NUL bytes. FTS/MATCH must find tokens on both shards,
including a token after an embedded NUL. The verified checkpoint must precede source-row
retirement. Proof also requires an empty source, a complete checkpoint, the three-trigger frozen
writer fence, and a controlled write that is positively rejected.
The proof command deletes every known created scratch database in `finally` on success or failure, still
attempting the other owned deletions if one fails. Any deletion failure fails the job. Output is
limited to static success, aggregate numeric/hash evidence, or static phase/class failures—never
row IDs, private values, SQL, or raw provider response/body artifacts. This proves the copier's
SQL/native protocol, not production D1 capacity or throughput, and makes no claim of a 1 MiB REST
body cap. It is preview-only; the protected production CLI gate below is unchanged.
Fixture prices are seeded in main before deployment; synthetic sessions still upload through
the Worker's normal file API and are verified through search, never inserted directly into shards.

Native Queue consumer GETs identify a Worker owner with `script`, consistent with the SDK
embedded in pinned Wrangler 4.111.0. Normal preview CI proved this on PR #172 at revision
`2d6b0de` (Actions run `38460399098`, job `115515595462`, 2026-10-13): parse and rollup
consumers reported `type: "worker"` and `script: "pr-172-app"`; `script_name` was absent,
and the DLQ had no consumers. The public API reference's `script_name` field does not match
that observed native GET contract. This evidence does not establish the production consumer's owner.

After deploying and verifying its app hostname, normal PR provision logs a compact
`queueConsumerIdentityReceipt` from native GETs of only that PR's known queues. It records the
expected Worker, record kind, consumer field types, known consumer type (`worker`/`http_pull`),
`recognizedPropertyKeys`, `unknownPropertyKeyCount`, and syntactically valid `script` Worker names.
The recognized keys are `script`, `dead_letter_queue`, `settings`, `type`, `queue_name`, `queue_id`,
`consumer_id`, and `created_on`; unknown property names are never logged, only their count.
Neither receipts nor rejection diagnostics include consumer bodies, settings values, headers,
credentials, or consumer ID values. Harmless extra fields do not change ownership authorization.
Production pause preflights the complete configured consumer target set before any DELETE:
every queue must exist and every consumer must satisfy the existing type, canonical `script`,
and consumer ID checks. A bad later record or missing later queue leaves all consumers untouched.
Only the exact validated queue/consumer IDs are then deleted; duplicate configured queue names
are handled once and producer-only queues are excluded. Production requires `script` to match
its configured Worker and allows an absent/null type but rejects an explicitly non-worker type;
preview cleanup requires a known same-PR Worker and `type: "worker"`, rejecting missing or
non-string owners. No alternate owner field is accepted. Native GET failures fail provision
through the scoped client's existing error path rather than reporting empty evidence.

**Free-account quota:** this account permits at most **10 D1 databases**. Each complete PR preview
uses three persistent databases, so at most three fit in steady state when no other databases
exist. The native copy control additionally needs three free account slots beyond all persistent
and other account databases while its scratch D1s exist. It enumerates every account D1, verifies
the three generated names are absent, and refuses before scratch creation if `account count + 3 > 10`;
it never borrows a persistent database or deletes unrelated resources to make room. Persistent
provisioning also counts every account database, reuses exact per-PR names, and refuses before
creating any resource if the missing databases would exceed 10. Explicitly dispatch `Preview Close` for an
unused preview (including an open PR's preview), or run `Preview Janitor` to remove closed-PR
resources, then rerun CI. Ordinary provision can reuse its three persistent databases even at
the quota limit. The separate required CI proof still needs three spare slots and fails—not
skips—when they are unavailable; a proof failure does not borrow or reset persistent databases.

There is no front door, no Cloudflare Access, and no blue/green generation machinery — the
deploy IS the promote, so a broken push briefly breaks that PR's preview until the next one.

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
preview, not the seed. The URL pattern is guessable, so the token is the entire gate. A public
preview must contain only synthetic or explicitly non-sensitive data; never upload production or
sensitive archives through `preview-upload-session.mjs`.

The seed is a **repository** secret, which means any same-repository branch can read the seed
that derives every PR's bearer, not only its own. That is the same exposure as "any PR author
can deploy a preview" — the deliberate trade this model makes — and it is bounded by what a
preview holds. It is not a production credential and must never become one.

**Migration divergence auto-reset.** Wrangler's D1 ledger tracks applied migrations by name
only, so the provisioner records each applied file's SHA-256 in main's `meta` table or each
shard's `index_migration_state`. Edited, missing, or unproven applied migration bytes in **any**
database reset **all three databases together**. A pre-sharding single-DB preview or interrupted
first migration is reset too; it is not upgraded with a partial or stale catalog. The old Worker
is deleted before the reset so it cannot write across database generations, R2 objects are
emptied with the databases, and all migrations and main prices are reapplied before redeployment.
Uploaded sessions vanish in that case; re-uploading is one command. A mismatched immutable
count/name/hash layout refuses reuse rather than changing placement in place. Manual full reset:
dispatch `Preview Close` against the open PR, then rerun CI — the next `preview` job reprovisions
main and both index shards empty.

PR close and the scheduled janitor delete only resources whose kind and trusted ownership match.
`Preview Close` removes the requested PR's `pr-<number>-*` resources, including main and both
shards (detaching only same-PR queue consumers and emptying R2 first). Native-copy scratch names
have the distinct shape `pr-N-copy-<24hex>-{source,idx00,idx01}`; the owner classifier lets close
recover scratch databases left by an interrupted control. The janitor sweeps scratch only for
closed PRs, never for active runs, along with other resources of closed PRs and debris from the
retired per-generation naming scheme. Another PR's active shards are never quota-relief targets.

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

That account's workers.dev subdomain is `sessions-ppe.workers.dev`. The token is
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

## Protected production full-fidelity index cutover

Production now has one authoritative metadata database (`DB`, `sessions-index`) and
sixteen immutable search-index databases (`IDX00`–`IDX15`, `sessions-index-idx00`–`idx15`).
`hub/wrangler.jsonc` declares their names; the protected deployment job resolves or
creates their real IDs and writes generated maintenance/active configurations. It never
asks the Worker deploy token to create databases. `npm run deploy` deliberately refuses
local production deployment; do not bypass it with a local production Wrangler login.

### Operational prerequisites

- Both `CLOUDFLARE_MIGRATION_TOKEN` and `CLOUDFLARE_DEPLOY_TOKEN` belong to the protected
  `production` GitHub environment, not a PR-readable credential path. The environment
  was verified to contain both secrets, allow only protected `main` deployments, and
  disallow administrator bypass. Main-only deployment concurrency remains enabled;
  Workers Builds must remain disabled.
- `CLOUDFLARE_MIGRATION_TOKEN` needs account-scoped D1 Read/Write, including database
  creation, on production. D1 tokens cannot be scoped to one database. The account must
  permit at least seventeen databases and the index storage they require.
- `CLOUDFLARE_DEPLOY_TOKEN` retains the existing Worker, Queues, R2, KV, Account Settings
  and custom-domain permissions. Queue-consumer detach/restore requires Queues Write.
- The unauthenticated viewer `/healthz` must report the exact `deploymentRevision`,
  `indexMode`, and numeric `indexShardCount`. Health never accesses a database.
- No machine private key or passkey is exported into CI. Normal upload/search acceptance
  is exercised after deployment through the existing owner-authorized collector/viewer
  flow, not a new production bearer or synthetic authentication bypass.

### Enforced ordering

The protected job classifies the durable layout as `legacy`, `pending`, or `active`.
Completed copy and seed checkpoints alone are **pending**, including after a failed
readiness check or first activation smoke. `active` requires valid durable readiness
and initial-activation proofs bound to the exact completed copy/seed snapshots.

A valid initial activation takes the ordinary deployment fast path on later pushes:
migrate/check per-DB ledgers, initialize/check layout and the temporary capability
probe, deploy the new active revision, verify health, reconcile at most sixteen catalog
IDs, and run read-only index/login smoke checks. The original proof deliberately is
not tied to the new revision: ordinary deployments do **not** pause consumers, enter
maintenance, wait sixteen minutes, copy the index, or reseed every session.

The one-time cutover runs these operations in order, from the same checked-out main revision:

1. `index-control.mjs provision`: create/reuse all sixteen named shards and generate both
   configurations, preserving the entire production custom-domain set and main DB ID.
2. Apply and checksum-verify `migrations-index/` separately on every shard, with separate
   database-bound journals; initialize/check immutable hash layout and ID counters.
   A fresh shard has no `d1_migrations` table yet. Only a production index shard's
   pre-apply history-prefix read accepts Wrangler's exact native missing-ledger API error;
   normal Wrangler migration application then creates its canonical ledger.
   Checksum recording and final verification require that ledger to exist.
   Authentication, transport, malformed responses, and unrelated SQL errors fail closed.
   This requires a fresh-schema manifest whose ledger starts at 1; historical main manifests
   require their existing applied history before any migration writes.
   `initialize` also runs an actual REST-batch atomicity positive control on `IDX00`:
   successful CREATE/INSERT/readback/drop first, requiring exact synthetic leading-BOM,
   Unicode and embedded-NUL text plus its stored UTF-8 byte length through both batch
   and independent REST readback. Missing or shortened values stop before copying.
   Then CREATE/INSERT/intentionally malformed JSON must return the expected SQL rejection
   and leave its unique probe table
   absent. A partially committed probe is cleaned up by its own name only and fails
   closed. A durable `index-rest-batch-atomicity-v1` proof binds revision/run/attempt
   and shard ID; `copy` refuses a different or missing proof. The source is untouched.
3. `index-control.mjs state` checks source objects and durable checkpoint identities,
   then reports a bounded first/middle/last source sample as `copyForecast`. It logs
   aggregate row bytes, page occupancy, shard fanout, estimated remaining requests,
   and an API-rate time lower bound only—not IDs, session IDs, SQL, or transcript text.
   Review this estimate when planning the maintenance window; it is not a completion
   promise. Ensure the rollup queue; explicitly detach only this Worker's production
   queue consumers. Messages remain queued rather than exhausting retry limits while
   the long migration runs. The maintenance configuration has no consumers.
4. Deploy the exact revision with `INDEX_MODE=maintenance`. Verify live health before
   touching source rows. Maintenance serves only health, rejects other HTTP requests,
   retries already-dispatched queue deliveries, and performs no scheduled writes.
5. Hold a sixteen-minute queue/cron drain after observing this deployment. The durable
   drain checkpoint includes revision, GitHub run/attempt, time, and all database IDs.
   Every new deployment cycle drains again, even when re-running the same commit.
   This is **not** an HTTP drain guarantee: HTTP requests can remain connected without
   a duration limit. The transactional source-write barrier below closes old HTTP
   writers instead of relying on a longer blind wait.
6. `index-control.mjs copy`: keyset-read pages bounded by roughly 1 MiB of serialized
   data and at most 2,048 rows; route each session with the shared UTF-8 FNV layout;
   preserve every block column, ID, numeric value and `NULL`. Large values travel in
   bounded hexadecimal byte slices and are decoded in full, preserving embedded NULs
   and leading UTF-8 BOM characters rather than shortening or normalizing them. A single
   oversized row uses individual value bindings instead of a too-large JSON scalar.
   Ordinary shard replacement is one atomic four-statement JSON1 batch, not per-row
   HTTP requests. Each populated shard's MATCH verification uses one fixed JSON1
   query with one JSON bind containing every `[quoted token, id]` probe. An outer
   `json_each` joined to FTS correlates each token with its copied row; the rowid
   comparison explicitly casts the JSON id to SQLite INTEGER. The statement gives
   all probes one consistent native read snapshot without expanding SQL per row.
7. For every page, compare SHA-256 canonical full-row readback and exercise real FTS
   `MATCH` probes. Persist the verified page checkpoint on `IDX00` **before** deleting
   its source rows. Each source `DELETE` compares **every** column with the verified
   full-row snapshot using null-safe `IS` predicates; comparison and deletion run in
   one main D1 transaction. A late changed row is retained and stops cursor advancement.
   No main schema change or migration-ledger write precedes this proof. The first
   verified deletion and installation of `index_migration_freeze` plus three standard
   blocks write triggers share that **same transaction**. Its committed state is
   always `frozen`; later deletes transition to `copying`, delete only exact verified
   rows, assert none remain, and return to `frozen` before committing. Concurrent old
   SQL cannot observe an unfrozen commit. A stale snapshot or failed barrier DDL rolls
   back the whole batch, leaving source rows and checkpoint cursor unchanged.
8. Once the source is empty, apply the main migrations: standard supported
   `DROP TABLE blocks_fts; DROP TABLE blocks`, remove the migration-freeze control
   table, then install catalog-outbox/version triggers. There are no speculative
   shadow-table mutations or FTS-retirement shortcuts.
   The retirement SQL also refuses a populated `blocks` table independently of workflow
   ordering, preserving the original rows and FTS if verified copying was skipped.
   Session-catalog update triggers enqueue only null-safe changes to mirrored values;
   unchanged pricing refreshes do not create replication backlog or block search.
9. `seed-catalog` reads up to 96 authoritative session/star/version snapshots per
   page, applies the same byte-bounded guarded catalog SQL builders as the Worker
   to every shard, and verifies sessions/stars/versions through one native three-query
   readback batch per shard. Only fully verified versions retire their outbox entries.
   An initial-attempt rerun validates and removes only its unactivated READY marker
   before resetting the seed checkpoint. An aborted reseed therefore remains
   resumable pending instead of retaining a proof bound to its old completed seed.
   Once valid initial ACTIVATION exists, full reseeding is forbidden.
   `ready` requires a completed copy, completed seed, empty outbox, matching layout,
   and strict catalog counts/readback. It checks the outbox again after verification
   and persists `full-fidelity-index-ready-v1`, binding the completed snapshots,
   current revision/run/attempt, evidence hashes and time. Initial failure/resume
   retains the pending flow; full reseeding is not repeated after proven activation.
10. Recheck current main, deploy `INDEX_MODE=active`, and restore configured consumers.
    Initial activation requires this attempt's valid READY proof. Verify exact live
    health, bounded shard counts/full-row sample SHA/MATCH evidence, catalog layout,
    the unauthenticated HTML login page, and health again. Only then persist
    `full-fidelity-index-activated-v1`, bound to READY and the copied snapshots.

The authoritative workflow is `.github/workflows/ci.yml`; the production CLI refuses
non-GitHub, PR/fork, non-main, wrong-account or malformed-revision contexts **before**
reading credentials. Operators resume by re-running the protected main deployment,
not by running the production copier locally.

### Abort, resume, and failure policy

Copy and seed checkpoint statuses are the explicit enum `state: "pending" | "complete"`;
durable readiness/activation proofs and CLI results use `state: "ready"` or
`state: "active"`. Malformed checkpoint values, invalid states, wrong database
identities or changed proof digests fail closed; none is treated as a missing
checkpoint or accepted as a compatibility format.

`IDX00.index_migration_state` stores `full-fidelity-index-copy-v1`,
`full-fidelity-index-catalog-v1`, `index-maintenance-freeze-v1`, the current
`index-rest-batch-atomicity-v1`, and READY/ACTIVATION proofs. The copy records the
immutable source/shard IDs, complete column list, acknowledged ID cursor, verified row
count, chained SHA-256 audit digest, and pending per-row hashes. A lost source-delete
response is safe: a pending verified page is read back again and only remaining source
rows are deleted. An unverified missing row, changed layout/column list, failed SHA,
failed MATCH, or changed deployed revision stops the job without authorizing deletion.
If the first exact-delete transaction fails because an old HTTP writer changed its
snapshot, that attempt stops without advancing. A later protected attempt may
discard/replan just that unacknowledged pending page only when its source rows really
changed/missing, its acknowledged row count is zero, and the SQL guard is absent.
Guard absence proves the first atomic deletion did not commit. An unchanged page
reuses its verified proof; a frozen source or any acknowledged page is never reset.
The source SQL barrier is durable across aborted runners. Old metadata-only HTTP
requests can still complete; the full catalog seed then drains all captured outbox
versions, including changes behind its saved scan cursor, with readback before ack.
Database-bound migration journals are useful per-run evidence; the durable shard
checkpoint and D1 migration/checksum ledgers, not runner-temporary files, carry recovery.

D1 copy failures emit only the configured database UUID, `query`/`batch` kind,
validated numeric HTTP status/provider codes, statement/parameter counts, encoded
request body and parameter-JSON byte counts, an allowlisted native class, and a
static operation phase. `failure=transport|http|statement|shape` distinguishes a
request or response-body transport failure, a non-2xx response, an explicit provider
or statement rejection in an HTTP-200 envelope, and an invalid response protocol/shape.
HTTP status comes from the actual response, never a provider envelope field.
A response-body transport failure retains the known HTTP status; invalid 429
`Retry-After` is an HTTP failure with status 429, not permission to replay.
Byte counts include JSON framing/escaping and are computed only on failure.
`copy-setup` identifies column/schema setup; the initial ID-range read and
already-complete source probes use `copy-source-page-read`.
`copy-page-write`, `copy-page-readback`, and `copy-fts-match` distinguish destination
replacement, full-row readback, and native MATCH execution. Source operations use
`copy-source-page-read`, `copy-source-freeze-read`,
`copy-source-freeze-install`, or `copy-source-delete-and-freeze`; checkpoint
reads/writes and unacknowledged-page cleanup have their own static phases.
Shared row/long-text transport invariants inherit the source-page or destination
readback phase, including malformed byte slices and invalid scalar values.
Map the UUID to the generated configuration's binding before attributing a failure
to main or any particular shard. No copied row IDs, column names, SQL, parameters,
provider messages, or transcript bytes are diagnostic output.

Native classes are `capacity` (explicit SQLITE_FULL/full-disk or documented
database/account-storage-limit tokens), `sql-syntax`, `missing-schema`, `limits`,
`type-error`, `quota`, `transient-reset`, `storage-timeout`, `overloaded`,
`memory-limit`, `cpu-limit`, `writer-fence` (the explicit `index_migration_frozen`
guard rejection), `malformed-json`, or `other` (unknown).
The reset/resource tokens follow Cloudflare's
[documented D1 errors](https://developers.cloudflare.com/d1/observability/debug-d1/).
Unlike that general debugging guidance, this private-data copier never logs full
native messages or SQL. These classes do not authorize retries.
Absent, unrelated, or conflicting native tokens remain `other`; HTTP 400 or
provider code 7500 alone is **not** a capacity diagnosis. A class describes a
recognized rejection token, not proof of its root cause. In particular, malformed
JSON can be the intentional source-comparison assertion aborting a changed page.
These diagnostics do not establish the cause of any earlier production failure.

The former FTS verifier joined up to 48 row-scoped SELECTs with `UNION ALL`.
Keeping each such statement at 96 binds did not make its compound-select grammar
valid in the native runtime. In controlled local Miniflare/workerd, the exact
deployed `d34375393afcf1a496e57ee2cd50380056e7a00c` copier rejected the
1,461-row same-shard case with `too many terms in compound SELECT` at
`copy-fts-match`. The corrected copier verified all 1,461 requested identities
and excluded a matching row outside the probe set. These are measured fixture
sizes, not claims of a documented compound-select maximum.

To repeat the before-control, materialize that revision's
`hub/scripts/lib/index-migration.mjs` as a temporary sibling module (preserving
its relative imports). Set `INDEX_COPY_MODULE_PATH` to its absolute `file:` URL
and run:

```sh
node --test --test-name-pattern='^native workerd actual copier verifies 1461 same-shard rows' hub/test/index-migration.node.test.mjs
```

The historical copier must fail with the native compound-select rejection.
Run the same command with `INDEX_COPY_MODULE_PATH` unset for the passing control.
Remove the historical module after the comparison; do not commit it.
The constant-size query changes only FTS transport/grammar: safe-integer,
expected-ID, duplicate-ID and required-token checks still reject incomplete or
incorrect MATCH results before the verified checkpoint or any source acknowledgment.
Source paging remains at most 2,048 rows and roughly 1 MiB, with full-column SHA-256,
source comparison and writer fencing unchanged. Local workerd evidence is not
real PPE D1 REST proof or production recovery evidence; those require their own
isolated native-copy CI run and protected production observation, respectively.

The isolated native-copy proof preserves the copier's static operation phase and
reports its own invariant failures as `class=assertion invariant=<allowlisted code>`
(for example `fts-match`, `readback-sha256`, `source-delete`, or `freeze-missing`),
not as an unknown SQL failure. Schema-runner errors without a public typed identity
remain `phase=schema class=other`; raw subprocess output is never copied into this
diagnostic. D1-query and inventory/create/identity/delete client failures retain
their allowlisted `failure` kind in the proof; HTTP 404 inventory is still a failure,
never an empty inventory or permission to create scratch databases.
A primary failure plus scratch cleanup failure keeps the original
phase/class/invariant/failure kind and adds
`cleanup=failed cleanupClass=<allowlisted class>` and, for client cleanup failures,
`cleanupFailure=<allowlisted failure kind>`.
Cleanup still checks each known-owned database identity and attempts every safe
deletion; failed or ownership-refused cleanup also fails an otherwise successful
proof. The preview atomicity preflight emits a JSON diagnostic with
`operation: "preview-atomicity"`, its control `phase`
(`ownership`, `batch-positive`, `independent-positive`, `rollback-negative`, or
`cleanup`), and `failure` (`assertion`, a client failure kind above, or `other`).
A secondary owned-probe cleanup failure preserves that primary phase/failure and
adds `cleanup: "failed"` and `cleanupFailure` (a client failure kind or `other`);
the owned probe may remain, and foreign/user tables are never cleanup targets.
Neither boundary logs raw causes, stacks, provider text, or copied values.

After a failed/ambiguous request, source contents, shard contents, and checkpoint
progress are unknown until durable state is inspected through the protected
workflow. Do not infer rollback from a generic API code, advance a cursor, blindly
retry, or apply speculative capacity/schema changes. Keep maintenance and paused
consumers in place; use the existing verified-readback/checkpoint recovery rules
before approving a protected continuation. Diagnostics add no retry or mutation.

Abort or timeout during copying leaves maintenance and detached consumers in place.
A failed readiness check or initial activation smoke writes no activation proof, so
the next attempt remains pending and cannot bypass strict readiness or fail-closed
cleanup. That cleanup selects intended consumers from the generated **active**
configuration (maintenance has an empty consumer list), detaches them, and redeploys
maintenance. Producers are not the consumer ownership list. If a deploy/control-plane
operation itself fails, its error
is reported rather than claiming a successful fail-closed redeployment. Once any source
row has been deleted, an old Worker rollback is **not** a recovery plan: continue the
protected migration from its verified shard copies. R2 backups are never deleted.

A real main `DROP` timeout/error also leaves maintenance and the completed copy intact.
Treat the observed failure as evidence before designing additional supported cleanup;
do not manipulate FTS shadow tables or assume that a multi-GB DROP will fail without a
measurement. Nothing in this runbook claims that a production migration has been
exercised merely because its scripts and Node behavior tests exist.

### Request budget and protected continuations

Cloudflare's account/user API quota is
[1,200 requests per five minutes](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
The index-control REST client shares FIFO permits with at least 300 ms between request
starts, including concurrent callers and every 429 retry. Its nominal 1,000 starts per
five minutes leave headroom below the quota; other account activity can still consume
that headroom. HTTP completion is not serialized.

The copier amortizes requests over byte-bounded pages and native batches instead of
issuing one RPC per row. The protected `state` sample estimates request count using
observed page occupancy and shard fanout; its paced request-rate time is a lower bound
before latency, other account activity, and extra long-value byte-slice reads.
`copyForecast.kind = "estimate"` distinguishes it from copied/verified checkpoint
evidence. A first/middle/last sample cannot establish the distribution of every page.

The client retries only an unambiguous HTTP 429 rejection with a valid `retry-after`
delay. It never automatically replays a network error, malformed response, or 5xx
whose execution outcome is unknown. Native/provider/transport failures remain terminal
errors: inspect their evidence and durable state before approving any continuation,
not an automatic retry.

The protected copy invocation passes `--pass-budget-ms 18000000` (five hours).
This positive safe integer millisecond argument is optional for `copy` only; other
commands and clients have no pass budget. The clock starts after configuration,
maintenance/drain, and atomicity prerequisites, before the copy's data reads. The
request boundary checks before acquiring a permit, again after acquiring it, and
before a valid 429 retry sleep. It stops if expired or if that sleep would reach the
deadline. It never aborts or replays an in-flight request or native batch. This is a
copy-process budget, not a deadline for the whole 360-minute job. Setup, the drain,
main migrations, catalog seeding and activation share the remaining job time; a copy
that finishes near five hours does not guarantee those later steps will fit.
Catalog seeding has durable checkpoints, and a completed copy can be revalidated
even after legacy blocks are retired. A hard timeout is not the explicit partial
result below: inspect the failed operation and durable state before continuing.

A budget stop emits exactly `{"status":"partial","reason":"pass-budget-exhausted"}`
and exits **78**, leaving the job failed and production in maintenance with consumers
detached. It does not mark the copy complete or acknowledge additional rows. Subsequent
main migrations, catalog seeding, activation, and consumer restoration do not run.
Only this distinct budget exception is partial; arbitrary native HTTP 400/code 7500,
network failures, and other errors are not relabeled as budget stops.

For that explicit partial result, rerun the **same protected main-push job at the same
commit** using GitHub Actions' rerun control (or `gh run rerun <run-id> --failed`).
There is no `workflow_dispatch`, automatic restart, or `continue-on-error`. Each rerun
gets a fresh five-hour budget, revalidates the deployed revision, and repeats the
queue/cron drain with the new run attempt before source writes. Durable pending copy
state recovers both committed partial shard writes and a committed source
compare/delete/freeze transaction whose `IDX00` acknowledgment was not yet sent;
verified work is neither discarded nor blindly acknowledged. Repeat protected
continuations until the normal complete proof authorizes the remaining steps.
The budget is process-local, not a persisted global deadline.
Native D1 batches must fit the
[30-second batch limit](https://developers.cloudflare.com/d1/platform/limits/);
a real provider failure remains fail-closed evidence, not permission to reduce fidelity.

Cloudflare documents
[unlimited HTTP duration while a client remains connected](https://developers.cloudflare.com/workers/platform/limits/#duration).
Do not treat the queue/cron drain as proof that old HTTP writes have ended. The SQL
barrier, exact full-column compare/delete, and transaction rollback are that proof.

## Standing preview deployment

`npm --prefix hub run deploy:preview` uses `hub/scripts/deploy-preview.mjs`, with an
explicit non-production-only `CLOUDFLARE_PPE_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`) and
the pinned preview account. It provisions and migrates fresh
`sessions-metadata-preview`, `sessions-metadata-preview-idx00`, and `-idx01`, builds the
actual deployable bundle, verifies per-DB ledgers/layout and the same actual REST-batch
atomicity positive control on `IDX00`, seeds fixture prices only in main, ensures its
queue, then deploys an active two-shard configuration. Re-runs reuse those same
identities. Existing Worker secrets survive deployment; no production auth
profile is consulted.

The retired `sessions-index-preview` database and existing R2 objects are retained
untouched, not run through the legacy-index drop migration. This standing environment
starts with fresh metadata; use the normal authorized upload path to populate it.
The retained legacy database still consumes one of the preview Free account's ten
database slots. The standing sharded stack consumes three more, leaving room for two
three-DB PR previews until the owner separately removes retired resources. Provisioning
counts **all** account databases and refuses over-capacity creation without deleting
another preview. Per-PR close/janitor ownership remains restricted to `pr-N-*`.

