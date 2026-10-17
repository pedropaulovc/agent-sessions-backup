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
ordinary rows, 1,461 small rows on the same dense shard with varied ASCII and modern-Unicode
first terms, and a value larger than 1 MiB but smaller than 2,000,000 bytes to exercise the
large-value fallback. Full-column SHA-256 readback must match all 18 source columns exactly,
preserving Unicode, a leading BOM, and embedded NUL bytes. Before copying, independent native
row-scoped queries require `alpha` to miss the public `🫠alpha` row while the whole `🫠alpha`
term finds its exact identity. After copying, independent MATCH checks include that whole term,
the whitespace-separated `🫠 alpha` control, a modern-emoji-only posting and a truly tokenless
negative probe. Four additional standalone 33,001-byte CJK, modern-emoji, uppercase-Cyrillic
and ø words exercise native term truncation without any later word to rescue a bad probe.
Independent MATCH uses each full original valid word, not the copier's completed probe.
Compact remaining dense prefixes preserve the original ordinary first-page geometry:
one ordinary row and all 1,461 dense rows, including the four no-tail boundary words.
After that dense phase, 46 distinct same-shard rows containing `a` plus 11,000 `Ⱥ`
characters and a numeric suffix exercise native folding growth. Independent MATCH
uses every ORIGINAL whole growth word, before its source ACK and after retirement.
The unchanged row-scoped point SQL is sent in native read batches of at most the
fixture's 46 growth rows, with each complete serialized `{batch: statements}`
request at most 1 MiB. Every statement must succeed with exactly one safe, unique,
actual native rowid matching its requested identity; requested-ID projection alone
is not MATCH evidence. This avoids one paced HTTP request per point without
changing the controller's 300 ms request pacing or bypassing any full-word check.
These independent point batches are not counted as copier split-probe groups.
Independent sliced readback still checks all columns and the full-row SHA. The proof
reader hex-transports values above 16 KiB in existing bounded BLOB slices so the
growth rows cannot make its 256-row independent response exceed the byte budget.
The unchanged native per-cell/per-offset 128 KiB slice queries are packed across
long cells in each metadata page: at most 100 statements, an exact complete
serialized `{batch: statements}` request at most 1 MiB, and known hex response bytes
plus a conservative internal 4 KiB per-result/4 KiB outer reserve at most 1 MiB.
Those reserves are internal policy, not a native API maximum. Actual aggregate
result JSON must also fit 1 MiB; every statement must succeed with one full-length
hex result. Safe origin IDs, exact offsets, length/alphabet and complete buffer
coverage are checked before complete UTF-8 decoding and full-row SHA. Valid UTF-8
is scalar canonical JSON; malformed TEXT uses the same strictly validated private
byte tag as the copier. One known-length cell buffer is filled directly from hex;
no truncated text or partially filled buffer escapes. Missing, failed, corrupt or
byte-altering reordered
native slice results must block source ACK. This changes only independent proof read batching,
not the 16 KiB inline/256-row/128 KiB slice geometry, copier/source budgets, request
pacing or CLI deadline. The shared
after-NUL token still independently finds every dense row that actually carries it.
The fixture has 1,509 rows total and retains the huge row's separate fallback.
Later growth-page geometry is checked from real checkpoints rather than a pinned
page count. At least one logical same-shard page must have an unsplit serialized
probe-parameter envelope above 1 MiB, while every actual group envelope stays at
or below 1 MiB. All groups and the verified checkpoint must precede source-row
retirement. Aggregate `maxFtsParametersBytes`, `maxUnsplitFtsParametersBytes` and
`splitFtsProbePages` describe those actual requests/pages, never terms or contents.
Proof also requires an empty source, a complete checkpoint, the three-trigger
frozen writer fence, and a controlled write that is positively rejected.
A separate byte-exact recovery phase then retains those 1,509 positive destination
rows while proving a twelve-row public fixture: a three-row retired prefix, three
legacy verified pending rows (two lossy TEXT cells), two malformed long TEXT cells
(300,000 and 1,900,000 bytes), and malformed short values in the other TEXT columns.
It proves the legacy reader's hashes first, observes one durable `recovering`
checkpoint before repair, retains the prefix chain, and checks exact storage bytes,
full-row digests and independent raw-token/old-lossy-token FTS results. After long
readback, a one-byte mutation with the same lossy rendering must trigger the
unchanged malformed-JSON CAS assertion; source, destination, freeze and verified
checkpoint remain intact, with no subsequent writes. A stale rerun must reject
before any write, and restoring the original public fixture byte must complete.
The `byteExactRecovery` summary contains only aggregate counts, byte/request maxima,
encoding, digests and the allowlisted guard result. An unrelated failure, malformed
raw transport, false aggregate or unavailable diagnostic is a failed proof, never
a green retained-data “negative control.”

The CLI contract's failure diagnostics read complete appended events before fixture
cleanup and expose only aggregate counts/byte maxima and an allowlisted last-query
kind. `traceState` is `complete`, `truncated` for an ignored partial final NDJSON
record, or `unavailable` with null counts if the trace cannot be read/validated.
Malformed earlier records never become a falsely complete zero-count trace.
Successful contract runs also print safe aggregate counts to measure actual paced
completion. Neither diagnostics nor request-count upper bounds establish native
failure cause or substitute for an observed finishing run.
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

### Inspected-state continuation and read-only diagnostic hold

The protected production job sets the source-controlled environment variable
`PRODUCTION_MAIN_MIGRATION_MODE: apply` in `.github/workflows/ci.yml` for the
inspected-state continuation below. The only accepted values are `inspect` and
`apply`; validation follows the stale-main guard and precedes all Cloudflare
operations. Changing the mode requires a reviewed source change and protected
main push, not a workflow input or dispatch. Keep the production environment,
concurrency and existing secret selection unchanged.

Before provisioning, schema writes, queue changes, deployment, drain or copying,
the protected job uses `CLOUDFLARE_MIGRATION_TOKEN` for this fixed inspection:

```sh
node scripts/migrations.mjs inspect \
  --target production \
  --config wrangler.jsonc \
  --database DB \
  --database-id 5ff65cf3-89c8-4fe6-a3c2-a370293ecea6 \
  --base-manifest migrations/source-baseline.json \
  --history migrations/historical-baseline.json \
  --output "$RUNNER_TEMP/main-migration-inspection/preflight.json"
```

The base configuration identifies account `18ef3246e9f36d1560485ef53889c0ab` and main
database `5ff65cf3-89c8-4fe6-a3c2-a370293ecea6`. Inspection issues fixed read-only
metadata SELECTs: ordered applied migration IDs, names and timestamps, all checksum-ledger
columns, schema object identities/types/parents and definition digests, and a bounded
`SELECT 1 ... LIMIT 1` existence probe for legacy `blocks`. It does not return
session content, block text or session/block row IDs. FTS shadow-object metadata is
permitted; copying, whole-data counts, repair SQL, registry bootstrap, ledger
writes, journal creation and checkpoint changes are not inspection operations.
Missing objects/ledgers and unavailable query results are distinct from empty
results. A failed query retains partial structured evidence and fails the command;
it does not retry or authorize later mutations.

The migration runner explicitly selects Wrangler's top-level environment (`--env ''`)
to match the validated configuration and database ID, even when `CLOUDFLARE_ENV`
is inherited. Every inspection statement must report native `changed_db: false` and
`rows_written: 0`; missing, malformed or contradictory metadata fails its section
and the command. `queryMetadata` retains each fixed SQL digest and statement index,
the read-only verification state, and valid provider-reported `rows_read` and
`size_after` (database bytes) when available. These are provider reports, not inferred
counts or a guarantee that a future migration will fit within D1's write timeout.

After successful inspection, `inspect` mode deliberately fails the main deployment
with `read-only inspection complete; retirement remains held`. That failure is the
expected diagnostic outcome, **not** successful deployment or activation. All
provisioning and subsequent mutating steps remain skipped. Every cutover stage,
including catalog reconciliation and failure cleanup, also requires mode `apply`;
the hold is not the sole mutation barrier. Cleanup additionally retains its original
successful-provisioning and attempted-consumer-pause requirements. This hold cannot
trigger a maintenance redeploy or queue-consumer changes.

On failure, intentional hold or cancellation, the run's Actions artifacts retain
`production-main-migration-evidence-<run_id>-<run_attempt>` for 14 days. Its whitelist
is only `main-migration-inspection/preflight.json`,
`main-migration-inspection/post-failure.json` and the trusted runner journal
`production-DB-<revision>.json` (when produced). No Wrangler debug logs, raw HTTP,
environment dumps or copied data are uploaded. Missing evidence produces a warning;
absence is not an empty database or proof that an operation did not commit.
Read the snapshot's complete/partial/failed status and each unavailable/missing
section before interpreting migration-prefix, checksum or schema state.

The full 3,539,584-block copy completed with SHA-256
`a92035b0b65764aa6c27b1103746b7ea84b89f9f6f066d2cbaa9a929f525d1d9`.
Protected read-only run `39013836201` confirmed that `0035_drop_legacy_blocks.sql`
is in applied history, while the checksum ledger ends at `0034`. All legacy
`blocks`, FTS and freeze objects are absent. `0036_session_catalog_outbox.sql`
is the only pending migration, with no catalog objects present. The earlier
7429 timeout does not identify its failed statement or commit outcome; it is
not evidence that retirement must run again.

Continue through the existing guarded pipeline, not repair SQL. Initialization
preserves the genuine completed copy checkpoint and classifies the retired main
as pending. Deploy the new exact maintenance revision, wait the unchanged
16-minute drain, then let completed-copy re-entry verify the checkpoint without
recreating source tables or a freeze. Normal migration apply skips applied
`0035`, applies canonical `0036`, and records both missing checksum entries.
Use the new deployment's normally created trusted journal; do not copy or
fabricate an old journal. A checksum entry's deployment identity records the
current attesting run, not necessarily the earlier run that executed its SQL.
Catalog seeding/readback, READY, stale-main rejection and active verification
remain required after apply.

Wrangler submits a migration's SQL and history INSERT in one query. Its
[migration-command contract](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply)
rolls back a failed migration while retaining previous successful migrations.
A lost reply can leave a whole committed migration unsealed; the normal runner
can finalize it from durable history with a fresh, identity-bound journal.
This is the documented command contract, not an empirical reconstruction of
the original timeout. The verifier's returned schema digest is a live
measurement, not a comparison against canonical object definitions.

The ordered native 16-shard rehearsal passed completed-copy re-entry, apply,
catalog seeding and READY with the full real-time drain. It used 32 synthetic
blocks and 33 sessions; Cloudflare transport, health and provider metadata were
simulated. It did not prove production scale, live consumer quiescence or
`verify-active`/viewer behavior. The number of distinct production session IDs
seeded by `0036` is unknown; its set-based writes can still fail on provider
storage or execution limits. Do not retry such a failure automatically.

A failed main apply runs the same fixed inspection into `post-failure.json`;
seed, READY and active deployment remain skipped, and fail-closed cleanup
attempts to keep consumers paused and the Worker in maintenance. Retain the
genuine journal and structured evidence before selecting another action:

- Any `session_catalog_*` object without `0036` in applied history is a partial
  state requiring a separately reviewed repair. Include both tables, the
  `session_catalog_outbox_session` index and all eight triggers.
- Conversely, `0036` history with absent or divergent catalog objects is an
  out-of-contract incident, not proof of a healthy or sealed schema. If
  observed, stop in maintenance and investigate before further continuation.
  The existing runner does not perform a canonical-DDL comparison.

Do not infer applied history from copy/classification logs or a pending
migration table. Wrangler can throw before printing a failed status; a candidate
inferred from its last table remains an inference. No workstation production
Cloudflare authentication, arbitrary-SQL endpoint, manual ledger/checkpoint
edits, topology reset/rebuild or FTS shadow-table workaround is authorized.
Recovery of both complete backups and cancellation of paid PPE only afterward
remain separate acceptance requirements; migration progress is not recovery.

### Enforced ordering

In reviewed `apply` mode, after the read-only preflight, the protected job classifies
the durable layout as `legacy`, `pending`, or `active`.
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
   `initialize` is also the sole, one-time importer of the unfenced copy checkpoint
   (see the fenced copy checkpoint below). It reports `copyCheckpoint` as `current`
   (the fenced key exists; the unfenced key is never read), `imported` (the unfenced
   state passed the identity and full shape checks and was wrapped verbatim at
   generation 1 by the conditional import below), or `absent`.
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
   preserve every block column, ID, numeric value, SQLite storage class and `NULL`.
   **Every TEXT column**, not just transcript `text`, is read as its original BLOB
   bytes over ASCII hexadecimal transport, including short values. Longer cells use
   131,072-byte raw slices; concatenate all slices before fatal UTF-8 decoding, so a
   valid multibyte sequence crossing a slice boundary is not misclassified. Valid
   UTF-8 retains the existing scalar canonical JSON/hash, including NULs and BOMs.
   Malformed UTF-8 TEXT is an explicit, validated private `{x: lowercase-even-hex}`
   canonical value; empty, valid-UTF-8, extra-key or noncanonical tags are refused.
   Reconstruction uses `unhex` and `CAST(... AS TEXT)`, not replacement characters.
   Oversized rows reconstruct TEXT from ordered 32,768-byte chunks (65,536 hex
   characters per bind), with at most 100 binds, 100,000 SQL bytes and a 4 MiB
   encoded write request. Each cell is at most 2,000,000 original bytes. Multiple
   large columns must also fit those row/request limits; exceeding one fails closed
   before any source retirement. These are bounded transport policies, not a promise
   that every D1 REST deployment accepts the maximum; disposable native REST proof
   is separate from local SQLite/workerd proof. The existing 100-column ceiling is
   unchanged. REST response sizing includes hex expansion and column/marker keys.
   INTEGER/REAL reconstruction is explicitly typed, even for integral REALs in
   affinity-free columns. Raw tags never route a session or enter catalog builders:
   malformed UTF-8 identities/catalog strings and empty identity keys fail closed.
   Nonempty valid UTF-8 session IDs retain their original UTF-8 hash/routing
   contract, including NUL/C0/DEL; migration does not add an ingestion allowlist.
   Turn keys are owner-annotation keys, not routing IDs. Valid existing keys retain
   those same characters (and BOM/non-ASCII bytes) exactly through catalog seed and
   reconciliation; the viewer already accepts nonempty keys up to 1024 code units.
   Ordinary shard replacement is one atomic four-statement JSON1 batch per bounded
   typed-JSON transport group, not per-row HTTP requests. Private REAL wrappers can
   outgrow an otherwise valid canonical page (for example, after malformed TEXT
   expands into its private byte tag). Only transport groups split: original row
   digests, durable pending identities/cursor and full-page retirement hash chaining
   are unchanged, including when resuming an existing copying/verified checkpoint
   or repairing a validated legacy checkpoint. No overflow row is skipped.
   Each populated shard's MATCH verification reuses one fixed JSON1
   query with one JSON bind per byte-bounded group of `[quoted token, id]` probes.
   The complete serialized parameters envelope, including JSON escaping, brackets,
   quotes and commas, must be at most `COPY_PAGE_BYTES` (1 MiB). Each pair is encoded
   once and an overflow pair is carried into the next group, without clipping,
   prefix probes or skipping rows. A single oversized entry fails closed with a
   static `fts-match` error. An outer `json_each` joined to FTS correlates each token
   with its copied row; the rowid comparison explicitly casts the JSON id to SQLite
   INTEGER. Each group has one native read snapshot, not a shared snapshot across
   the whole page; the unchanged maintenance drain/quiescence, source comparison
   and checkpoint/writer fences remain required across groups. Each response must
   contain only safe INTEGER IDs requested by THAT group, without duplicates in
   that response or earlier groups. Positive native terms and tokenless negatives
   must all verify before any page is persisted as verified or acknowledged.
   This 1 MiB serialized-parameter budget is internal policy, not a native API
   rejection threshold or REST body cap. D1's documented maximum string size is
   2,000,000 bytes ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
   Probe terms come from one scoped, reusable in-memory native SQLite FTS index, cloned
   from the actual destination `sqlite_master` FTS declaration. `fts5vocab` instance
   offset zero supplies the first real indexed term as raw BLOB bytes. The oracle
   receives the **original stored TEXT bytes** via a BLOB-to-TEXT cast, including
   malformed UTF-8; it never tokenizes a lossy JavaScript rendering. A malformed
   native term travels as a byte-quoted phrase reconstructed inside SQLite MATCH.
   For valid UTF-8 text only, a trailing partial native term may be completed;
   native term-byte identity plus a local original-row MATCH verifies that candidate.
   There is no JavaScript Unicode-category approximation, separate tokenizer
   configuration, source-text clipping, skipped word or later-term fallback.
   Truly tokenless rows require a negative MATCH result, while modern emoji that
   unicode61 indexes require a positive posting just like every other native term.
7. For every page, compare SHA-256 canonical full-row readback and exercise every
   real FTS `MATCH` probe group. Only after ALL groups pass, persist the verified page
   checkpoint on `IDX00` **before** deleting its source rows. Each source `DELETE`
   compares **every** column with the verified full-row snapshot using null-safe
   `IS`, exact storage-class equality, and BLOB equality for TEXT (independent of
   column collation). The JSON snapshot's private raw tags are reconstructed as
   TEXT before comparison, never compared as objects or replacement strings.
   Comparison and deletion run in one main D1 transaction. A late changed byte,
   including one with an identical lossy rendering, is retained and stops advancement.
   Typed-JSON CAS groups remain in **one atomic native source batch** with the
   original full pending-page empty assertion and freeze transition; they are not
   independently acknowledged or dispatched as separate retirement transactions.
   A changed row in a later group rolls back earlier group deletions too. The
   unchanged 4 MiB whole-request bound is checked before dispatching that batch.
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
reading credentials. Once a reviewed repair explicitly releases the diagnostic hold,
operators resume through the protected main deployment, never by running the
production copier locally.

### Abort, resume, and failure policy

Copy and seed checkpoint statuses are the explicit enum `state: "pending" | "complete"`;
durable readiness/activation proofs and CLI results use `state: "ready"` or
`state: "active"`. Malformed checkpoint values, invalid states, wrong database
identities or changed proof digests fail closed; none is treated as a missing
checkpoint or accepted as a compatibility format.

`IDX00.index_migration_state` stores `full-fidelity-index-copy-v2`,
`full-fidelity-index-catalog-v1`, `index-maintenance-freeze-v1`, the current
`index-rest-batch-atomicity-v1`, and READY/ACTIVATION proofs. The copy records the
immutable source/shard IDs, complete column list, acknowledged ID cursor, verified row
count, chained SHA-256 audit digest, and pending per-row hashes. New snapshots name
`encoding: "sqlite-text-bytes-v1"` and retain per-row storage-class proof separately
from the canonical row hash. A lost source-delete response is safe: re-read and
verify the exact destination and physical FTS, require the durable frozen barrier,
then acknowledge an entirely absent source page without replaying its DELETE.
Partial absence, an unverified missing row, changed layout/column list, failed SHA,
failed MATCH, or changed deployed revision stops without authorizing deletion.
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

The copy checkpoint is fenced. `full-fidelity-index-copy-v2` stores exactly
`{format: 1, generation, state}`: `state` is the semantic copy checkpoint every reader,
classifier and READY/ACTIVATION digest uses, unchanged; `generation` is a positive
safe integer outside it. Each transition is one statement: an insert-if-absent for
the first write, then `UPDATE ... WHERE generation = expected RETURNING generation`.
Exactly one returned row equal to `expected + 1` is required. Any other result is the
`checkpoint-fence` invariant, distinct from a transport/HTTP failure; it is never
retried, and no later checkpoint or source write in that run follows it. A delayed
request from an earlier run (lost response, unknown commit) can therefore never
rewind the checkpoint, even to an identical earlier state. After an unknown
checkpoint-write outcome, rerun the protected workflow: the next run reads the durable
envelope and either resumes from the committed write or repeats the uncommitted one.
Any other envelope shape fails closed and is never rewritten. Generic checkpoint
reads and writes refuse both copy keys.

`full-fidelity-index-copy-v1` is the unfenced copier's key. It is an inert archive:
`initialize` reads it only while the fenced key is absent, and no reader falls back to
it, so a late UPSERT to it changes nothing. It is never deleted. While it exists
without the fenced key, `copy` fails closed before any write instead of starting a
fresh copy; run `initialize` (the normal workflow does so before `state`).

The import is one conditional `INSERT ... SELECT`: it writes the generation-1 envelope
only while the unfenced key still holds, as TEXT, exactly the bytes `initialize` read
and validated (`typeof(value) = 'text' AND CAST(value AS BLOB) = CAST(? AS BLOB)`; no
re-serialized or normalized comparison), and only while the fenced key is absent. It
requires exactly one returned row with generation 1. A late unfenced write that
commits between that read and the insert (a newer value or a deletion) or a
concurrently created fenced key matches no row: that is the `checkpoint-fence`
invariant, never retried, and nothing is written. Rerun the workflow; `initialize`
re-reads both keys. A lost import response is resolved the same way (`current` if it
committed). The `STRICT` table's `value TEXT` column already refuses BLOB values; the
`typeof`/BLOB-byte comparison only makes the match exact bytes rather than a
collation or normalized comparison. Boundaries: this closes only the window between
the import's read and its insert. It cannot detect unfenced history that was already
stale when read (a delayed older UPSERT that landed before the import, as the
delayed-UPSERT regression fixtures reproduce; no production rewind has been
observed), nor a rewrite back to the identical bytes before the insert (ABA); the
copier's own source/destination proofs still apply to whatever is imported, and this
is not a repair of earlier unfenced history.

Historical regression controls predate the fence. Whenever `INDEX_COPY_MODULE_PATH`,
`INDEX_CONTROL_CLI_PATH` or `NATIVE_COPY_CONTROL_MODULE_PATH` selects a pre-fence
revision (every historical control in this runbook), also set
`INDEX_COPY_CHECKPOINT_FORMAT=unfenced-v1` so the test observers read that
implementation's flat `full-fidelity-index-copy-v1` checkpoint. The default,
`fenced-v2`, reads only the strict envelope; the observer never chooses a layout from
whichever key exists, and a mismatched selected copy module refuses to load. To show
the fence is load-bearing, run the `unfenced checkpoint UPSERT` cases with the
pre-fence `f44a39c` module and CLI selected this way: they must fail at the rewound
copy, and pass with the variables unset.

An absent copy `encoding` is accepted only by the explicit one-time legacy
checkpoint upgrade, not by a general alternate-reader fallback. Before changing a
legacy `copying`/`verified` pending proof, re-run the actual old bounded reader
(including its original inline thresholds and fatal long-value decoder) on source
and existing destination and prove the old per-row hashes. Existing destination
replicas must also match those hashes under the new exact reader and pass physical
FTS verification. A copying page may have wholly absent, uncommitted shard replicas;
a verified page may not. An entirely absent verified source page is accepted only
with the frozen old atomic-delete barrier and an exact unchanged destination proof;
a partially absent page is refused.

Only then persist the explicit `recovering` page, its original legacy rows,
exact target hashes/storage classes, and exact destination baselines **before**
correcting any destination cell. Resume accepts only the original destination
baseline or the already-completed exact target; an exact repair is verified, not
replayed. Recheck source bytes, correct only proven differing replicas, verify
full raw rows and native raw-token FTS, and checkpoint `verified` before the ordinary
exact CAS retirement. Every recovery checkpoint/write/delete boundary is resumable.
The acknowledged cursor, row count and existing retired-prefix SHA chain are never
reset or rehashed; only the recovered pending page adds its new canonical hashes
through the normal chain step. Unknown encodings, malformed recovery records and
foreign database identities fail closed before repair writes. Already-complete
legacy checkpoints remain bound to their original proof snapshot; their successful
old CAS is not replaced by a rewritten historical digest.

The legacy hash proves only the old reader's representation: two malformed byte
sequences can have the same lossy rendering. It cannot prove historical invalid
bytes that were never recorded. Recovery preserves the current frozen authoritative
source bytes and proves them exactly through new readback and CAS; it does not
claim to reconstruct a vanished earlier byte sequence. The observed production
comparison (420 present, zero missing, two byte/length-different TEXT cells) is
concrete byte-loss evidence, not disclosure of those private bytes or by itself a
definitive claim that their original encoding was invalid UTF-8.


D1 copy failures emit only the configured database UUID, `query`/`batch` kind,
validated numeric HTTP status/provider codes, statement/parameter counts, encoded
request body and parameter-JSON byte counts, an allowlisted native class, validated
CF-Ray correlation, and a static operation phase. `failure=transport|http|statement|shape` distinguishes a
request or response-body transport failure, a non-2xx response, an explicit provider
or statement rejection in an HTTP-200 envelope, and an invalid response protocol/shape.
HTTP status comes from the actual response, never a provider envelope field.
A response-body transport failure retains the known HTTP status; invalid 429
`Retry-After` is an HTTP failure with status 429, not permission to replay.
Failure-only `ray=<id>` comes from the actual response's `CF-Ray` header and accepts
only 16 lowercase ASCII hex digits, optionally followed by a hyphen and three
uppercase ASCII letters (`^[0-9a-f]{16}(?:-[A-Z]{3})?$`, with no trailing bytes).
Only a valid ID is also retained as typed `providerRay` error metadata.
`ray=absent` means no response/header was available; `ray=invalid` means a malformed
or unreadable header was discarded. Neither sentinel contains raw header text.
Body-read failures can retain a valid ray even when the body is unavailable.
Use a valid ray with the failing operation's HTTP status, provider codes and phase
to correlate the request with Cloudflare; it does not identify the cause of a
failure, including HTTP 500/code 7500. Missing or invalid rays leave that cause
unknown too. No other response headers are logged; these diagnostics do not add
retries or change checkpoint recovery.
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

After a rejected `copy-source-delete-and-freeze` batch, the copier attempts one
read-only aggregate comparison against the **same already-verified canonical
snapshot**, never against a new copy or a replayed source batch. Its additional JSON diagnostic
reports `clean`, `mismatch`, `missing`, `mismatch-and-missing`, or `unavailable`;
present/missing/mismatching row counts; static zero-based column indexes; allowlisted
SQLite storage-type classes; and counts of type, BLOB-byte and byte-length inequality
on mismatched columns. INTEGER/REAL storage-class changes are also exact CAS misses.
No IDs, column names, scalar values, text, search terms, SQL, parameters or native
diagnostic errors are emitted. The query is skipped with `unavailable/request-budget`
when its fully JSON-encoded request would exceed the existing 1 MiB copy budget, or
its SQL exceeds D1's separate [100,000-byte statement limit](https://developers.cloudflare.com/d1/platform/limits/).
The oversized per-column branch has no bounded canonical snapshot and is explicitly
`unavailable/canonical-budget`; query/response failures are also `unavailable`.
The original error object/message remains unchanged. Public native workerd accepts
harmless statements of exactly 100,000 bytes and rejects 100,001 bytes; both the
statement and fully encoded request caps are checked before the diagnostic query.

The comparison uses a controlled numeric column-index relation and one source
LEFT JOIN to form narrow cell rows. Per-column grouped counters use only two
DISTINCT type-mask aggregates, while per-row flags count a row only once even if
several columns differ. Stored and reconstructed values retain their storage class;
the same exact type/value/TEXT-byte predicate as retirement defines a mismatch,
so a column collation or a CASE's missing affinity cannot hide a physical change.
Column cells and containing groups use explicit aggregate ORDER BY clauses rather
than incidental GROUP BY sorter order. Public SQLite/workerd controls exercise
raw bytes, type masks and distinct counts. Native Cloudflare acceptance remains a
separate protected control; local semantic equivalence alone neither diagnoses nor
repairs a remote rejection.

“One comparison” means one logical read-only SQL query. The existing REST client
may replay that query after an unambiguous HTTP 429 with a validated `Retry-After`,
within the same configured pass/request budget. It never replays the rejected
source retirement batch. Diagnostic retry or budget exhaustion makes the diagnostic
unavailable; the original hard retirement error is still thrown, not replaced by
the diagnostic failure or converted into a partial-copy exit 78.

The disposable native copy control now requires affirmative byte-exact recovery,
including exact full-row/destination proof and native raw-token FTS, rather than
accepting a lossy copied page plus a rejected retirement as successful recovery.
Its deliberately late, equal-length byte mutation must yield one bounded mismatch
comparison and preserve all four source/destination/freeze/checkpoint fences. An
unavailable or false comparison fails the proof; a destination compile control is
not an alternate oracle or permission to turn that failure into success.

On its owned scratch IDX00 only, the control's `byte-exact-checkpoint-fence` phase
proves one advanced-generation witness and zero-row stale UPDATE/insert replays, and
`byte-exact-checkpoint-import` then runs the real conditional import natively: with the
fenced key present the import reports `current` and leaves both raw keys unchanged;
after a scratch-only reset, an unfenced value changed and then deleted between the
import's read and its insert each match zero rows (the fence, no fenced key written);
the stable value imports exactly `{format: 1, generation: 1, state}` with the unfenced
TEXT archive byte-identical. These key resets/reseeds exist only in this disposable
fixture, never in the product importer. A local controller/stub run including this
phase measured 656 Cloudflare requests in total (574 `/query`), 21 more `/query`
requests than without it, within the unchanged caps below.

The control is paced, not CPU-bound. Timestamped local controller/stub runs measured
328 Cloudflare requests in 104 s for `359f3e2` (252 positive, 76 old diagnostic) and
631 in 197 s for the byte-exact helper (260 positive, 371 recovery). Of the latter
371, 320 were `/query`; the rest were registry/identity gate checks and cleanup.
627 of 630 inter-request gaps were 295–340 ms, with none above 400 ms in recovery,
consistent with the controller's unchanged shared 300 ms Cloudflare pacer. The
native-only deployment test therefore caps total HTTP requests at 700 and recovery
queries at 360, and derives its spawn deadline as `700 × 300 ms + 30 s = 240 s`.
Its former 120 s harness deadline was below the roughly 190 s paced floor; this is
not a production timeout/pacer change or removal of proof controls. Expect about
3.2 minutes plus real HTTP latency for the native-copy proof. These are local stub
timings, not real D1 REST long-cell acceptance or production recovery evidence.


A failure-only comparison does not identify the original failing statement or
authorize source writes, ACK, checkpoint advance, or a semantic batch retry. A clean
current comparison cannot prove a failed batch committed or that its earlier
comparison was clean. Local malformed-TEXT counterexamples demonstrate the legacy
reader's possible loss; neither they nor aggregate diagnostics disclose private
production bytes or establish their original encoding. Recovery must independently
complete through the current raw source, exact readback, FTS and CAS.

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
node --test --test-name-pattern='^native workerd actual copier tokenizer boundaries verify 1461 same-shard rows' hub/test/index-migration.node.test.mjs
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

The byte-exact regression controls use the same `INDEX_COPY_MODULE_PATH` seam with
the pre-upgrade `359f3e2` module. Run the `byte-exact` named cases against that exact
historical file and against the current module; the native 420-row legacy-pending
case must reach the original loss/retirement failure under the old core rather
than merely fail an import. The cases include all TEXT columns, sliced malformed
values, independent raw-token FTS, unchanged valid scalar hashes, preserved retired
prefixes, durable recovery/write/delete crash boundaries and tamper/encoding guards.
Raw hex response subpages are independently bounded without shrinking logical copy
pages or avoiding the existing fold-growth FTS grouping controls. Remove the
temporary historical sibling after comparison. No historical module or public
scratch fixture is a production reader fallback.


Native folding can increase probe UTF-8 bytes beyond the source page's serialized
size. A prior controlled local workerd case accepted a 1,508,093-byte unsplit
parameter envelope for 46 `a` + 11,000 `Ⱥ` words plus two ASCII rows, with complete
native MATCH/full-row SHA/verified-before-ACK evidence. That demonstrates an
internal 1 MiB budget violation, **not** a reproduced native D1 rejection or a
production-cause diagnosis. The byte-bounded verifier now measures the complete
escaped outer params envelope exactly rather than reserving an arbitrary fraction
of the source-page budget. All groups must succeed before the existing verified
checkpoint/ACK boundary.

The permanent SQLite and Miniflare/workerd fold-growth regressions copy that
same-shard geometry, independently probe ORIGINAL whole valid words and preserve
all 18 columns/full UTF-8/full-row SHA. A physical missing posting in a later group
must retain exact source rows, native FTS pages, cursor and pending/copying checkpoint;
earlier groups remain real positive controls. Separate genuine-hit controls reject
identities that belong to a different group, even when they belong to the page.
For the exact pre-budget `4c5cb33696a2a6c1fd39f75e71b3b3209a1544ff` historical
module, materialize a temporary sibling and set `INDEX_COPY_MODULE_PATH` to its
absolute `file:` URL:

```sh
node --test --test-name-pattern='fold-growth (probe budget|later missing posting)' hub/test/index-migration.node.test.mjs
```

The older copier must still complete the positive native copy and retirement,
then fail the new **internal parameter-budget** assertion. Its physical-missing-
posting negative control must still reject before ACK. With the override unset,
the current copier must use actual split groups, obey every serialized envelope
bound and preserve both positive/negative semantics. Run the full fold-growth
identity coverage with `--test-name-pattern='fold-growth'`. Remove only the
temporary historical module created for the control; do not commit it. The expanded
real-CF fixture must be exercised by a fresh isolated `native-copy-proof` run:
local regressions or static packing calculations do not prove its deployed page
geometry, native REST behavior or production recovery.


A later protected pass at `67cdc05ff2e72888856b34e4e464c875a052e88f`
stopped on 2026-10-13 at approximately 03:30 UTC with the semantic
`FTS MATCH verification failed` guard, rather than the older native compound-select
rejection. The normal enrolled health observation at 03:55:12 UTC still showed
maintenance mode at that revision with sixteen shards. No production transcript term,
pending page, source acknowledgment or copy progress was observed; neither this
failure message nor that health response identifies the production cause or proves recovery.

The exact unchanged `67cdc05` copier and actual migration schema have a separate
demonstrated local failure mechanism in native SQLite and Miniflare/workerd:
public text `🫠alpha copiersuffix` is indexed by configured unicode61 with first term
`🫠alpha`, but the former JavaScript Unicode regex chose `alpha`. Independent native
row-scoped MATCH returned no `alpha` hit and exactly the requested identity for
`🫠alpha`; the actual grouped JSON query agreed. Full destination rows and UTF-8
bytes remained intact, while the full source rows/postings stayed unchanged and the
checkpoint remained pending/copying with zero acknowledged rows and cursor `-1`.
The whitespace-separated `🫠 alpha` control passed. Six different ASCII first terms
on the same shard also matched their independent point queries and completed copying.
Other public adjacent/embedded post-Unicode-6.1 emoji, Bitcoin and U+1CF00 cases
reproduced the token-boundary disagreement. These observations demonstrate a native
unicode61-versus-current-JavaScript tokenization mismatch, not a JSON query-planner
or transport defect and not the cause of the unseen production page.

The replacement oracle reads each used destination's actual FTS declaration once
per operation and keeps that SQL, transcript text and derived terms in memory only.
Its native database and prepared statements are reused for every row/page, indexing
at most one row at a time; a `finally` closes the resource on copy/verification
success, native failure, gate failure or checkpoint failure. Initialization and
derivation/closure failures expose only the static `fts-tokenizer-schema` or
`fts-tokenizer` invariant at `copy-fts-match`, never local native messages, SQL,
tokens or transcript bytes. The full-row SHA, exact identity checks, checkpoint
ordering, source comparison/acknowledgment and writer fence are unchanged.

Native review of the initial oracle at `a169514` demonstrated a separate local
long-word regression before release: FTS5's 32,768-byte term limit can split a
multi-byte UTF-8 character. Reading that vocabulary term as SQLite TEXT loses the
raw suffix bytes by decoding them as U+FFFD, so the quoted replacement-character
probe misses even though the full valid original word is searchable. Actual
Miniflare/workerd copies rejected ten 40–45 KB public CJK, modern-emoji, Cyrillic
and ø cases, including single words with no later term. All destination columns
and text bytes were intact; the exact source rows/FTS remained and the checkpoint
stayed pending/copying with zero acknowledged rows and cursor `-1`. Four ASCII,
diacritic-folded and valid/aligned UTF-8 controls completed.

The byte-preserving repair strictly decodes the BLOB first. If decoding fails,
every earlier byte must be valid and only the final incomplete UTF-8 sequence may
be completed. It enumerates at most 4,096 valid suffix candidates using UTF-8's
valid continuation ranges, with one reused sequence buffer. A candidate is accepted
only when indexing it alone through the actual native tokenizer yields exactly one
term whose raw bytes equal the original stored term. The oracle then restores the
full original row and requires a positive row-scoped whole-candidate MATCH before
the unchanged actual-D1 grouped MATCH. This does not reconstruct or alter source
text, assume zero padding or folding, use a synthetic prefix, skip the term or rely
on a later word. Non-trailing corruption, exhausted candidates or failed native
identity/MATCH are static `fts-tokenizer` failures and authorize no acknowledgment.

One local native SQLite 3.51.2 review sweep verified all 17,593 distinct partial
prefixes of native unicode61 token characters through both exact native term-byte
identity and original-row MATCH, with at most 247 valid candidates observed. The
generated repair also completed all fourteen actual Miniflare/workerd full-copy
cases. Those are retained local reviewer observations, not permanent implementation
statistics, Node/Windows-wide proof or real Cloudflare evidence. Permanent regressions
exercise full no-tail words, folded/aligned controls, read-only verification and
physical missing postings rather than constructor wiring or allocation-count hooks.
The real-PPE fixture's four 33,001-byte no-tail words exercise the same truncation
boundaries while preserving the dense ordinary-page and long-row fallback proof.

To isolate this long-term regression, materialize the exact `a169514` module as a
temporary sibling of `hub/scripts/lib/index-migration.mjs`, preserving relative
imports, and set `INDEX_COPY_MODULE_PATH` to its absolute `file:` URL:

```sh
node --test --test-name-pattern='native tokenizer.*long|native workerd.*long' hub/test/index-migration.node.test.mjs
```

The no-tail CJK, modern-emoji, Cyrillic and ø copier cases must expose the former
lossy-term MATCH rejection before acknowledgment; ASCII/folded/aligned controls
retain their positive meaning. Run with the override unset for the repaired copier
and remove the historical module afterward. These long-word controls substitute
both the copier and read-only verifier from the selected historical module.

The preceding short-term-only native PPE proof on PR #176 at head `c32add7` was observed
on 2026-10-13 at 04:39:08 UTC in Actions run `38511682800`, job `115682982238`.
It verified all 18 columns, 1,463 rows/1,461 dense rows, two shards, two ordinary
pages, one long fallback, the full-row SHA and three source fences, with native
`legacyProbeMatches=0` and `nativeProbeMatches=1`. That run predates the expanded
no-tail B3 fixture: it proves the short modern-Unicode counterexample and existing
full-copy protocol, not the new long-term byte completion or production recovery.

For the revision-level before-control, materialize the exact `67cdc05` module as a
temporary sibling of `hub/scripts/lib/index-migration.mjs`, preserving relative
imports, then set `INDEX_COPY_MODULE_PATH` to its absolute `file:` URL:

```sh
node --test --test-name-pattern='native tokenizer|configured FTS tokenizer|missing FTS posting|native workerd.*tokenizer' hub/test/index-migration.node.test.mjs
```

The short adjacent-modern-Unicode copy regressions expose the old semantic MATCH
rejection; ASCII, whitespace-separated and truly tokenless controls remain meaningful.
Some long valid-word controls already pass `67cdc05`; the separate `a169514` control
above isolates the native TEXT-decoding regression rather than misattributing it.
Run the same command with `INDEX_COPY_MODULE_PATH` unset for the native-derived
control, and remove the historical module afterward. A missing real modern-emoji-only
posting must now fail rather than being mislabeled tokenless. The real-CF isolated
fixture uses the current copier only: its independent `alpha` miss and whole-term
hit are the native tokenizer counterexample, followed by current full-copy/SHA/
checkpoint/fence evidence. It ships no historical copier, old-regex implementation
or guard bypass. The proof's `legacyProbeMatches=0` and `nativeProbeMatches=1` are
aggregate public synthetic evidence, not production diagnostics. Neither local
controls nor a later PPE proof establish production cause, acknowledgment or recovery.

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

After a failed/ambiguous D1 request, source contents, shard contents, and checkpoint
progress are unknown until durable state is inspected through the protected
workflow. Do not infer rollback from a generic API code, advance a cursor, blindly
retry, or apply speculative capacity/schema changes. Keep maintenance and paused
consumers in place; use the existing verified-readback/checkpoint recovery rules
before approving a protected continuation. D1 diagnostics add no retry or mutation.

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

The Cloudflare API/D1 client retries only an unambiguous HTTP 429 rejection with a
valid `retry-after` delay. It never automatically replays a network error, malformed
response, or 5xx whose execution outcome is unknown. Native/provider/transport
failures remain terminal errors: inspect their evidence and durable state before
approving any continuation, not an automatic retry. This includes read-only SQL:
its D1 REST POST is not covered by the health GET policy below.

The direct read-only `/healthz` revision gate permits at most **three total attempts**
when `fetch` rejects or a successful response's body cannot be read, with one second
between attempts (at most two waits). Each attempt makes a fresh uncached GET with
the existing 30-second request timeout. A successful attempt must still assert the
exact expected mode, deployment revision, production environment, and 16-shard layout
before it authorizes further copy work. HTTP errors (including 429/5xx), malformed
JSON, and health-payload mismatches are terminal at direct gates: they are not
transport failures and are never retried into source acknowledgment. There is no
cached-health fallback. The standalone `health` command retains its separate,
existing 180-second deployment-propagation settle loop; that command-only polling
does not weaken the gates used by `copy`, readiness, or activation.

Health errors emit only `operation=revision-gate`, an allowlisted command and mode,
`failure=transport|http|json|mismatch`, safe actual HTTP status (or `unknown`), and
attempt count. Raw URLs, headers, response bodies, exception messages, stacks, and
nested causes are not logged. Exhaustion leaves the source authoritative and the
unacknowledged copy page/checkpoint intact; a later protected pass revalidates that
durable work. This policy and its local CLI/native-SQLite regressions neither
identify the DNS/TLS/socket cause of an earlier `fetch failed` nor establish that
the production migration or missing-backup recovery has completed.

The protected copy invocation passes `--pass-budget-ms 18000000` (five hours).
This positive safe integer millisecond argument is optional for `copy` only; other
commands and clients have no pass budget. The clock starts after configuration,
maintenance/drain, and atomicity prerequisites, before the copy's data reads and
fresh health checks. The same request boundary checks D1 requests before acquiring
a permit, again after acquiring it, and before a valid 429 retry sleep. It also
checks before every copy health GET and before each one-second health transport
retry wait. It stops if expired or if either retry wait would reach the deadline;
a delayed wait must pass the boundary again before starting another request.
It never aborts or replays an in-flight request or native batch. This is a
copy-process budget, not a deadline for the whole 360-minute job. Setup, the drain,
main migrations, catalog seeding and activation share the remaining job time; a copy
that finishes near five hours does not guarantee those later steps will fit.
Catalog seeding has durable checkpoints, and a completed copy can be revalidated
even after legacy blocks are retired. A hard timeout is not the explicit partial
result below: inspect the failed operation and durable state before continuing.

A budget stop prints the result line exactly `{"status":"partial","reason":"pass-budget-exhausted"}`
and exits **78**, leaving the job failed and production in maintenance with consumers
detached. It does not mark the copy complete or acknowledge additional rows. Subsequent
main migrations, catalog seeding, activation, and consumer restoration do not run.
Only this distinct budget exception is partial; arbitrary native HTTP 400/code 7500,
exhausted health transport failures, invalid health payloads, D1 network failures,
and other errors are not relabeled as budget stops.

For that explicit partial result, rerun the **same protected main-push job at the same
commit** using GitHub Actions' rerun control (or `gh run rerun <run-id> --failed`).
There is no `workflow_dispatch`, automatic restart, or `continue-on-error` on the
copy step (only the read-only diagnostic steps below are best-effort). Each rerun
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

### Copy progress telemetry

`copy` prints telemetry as JSON lines on stdout before its unchanged final result
line (failed passes print no final result line; stderr keeps the redacted error).
Each `migration.copy.progress` event (`schemaVersion: 1`, from
`infra/cf/migration-progress.mjs`) is flat and aggregate-only: `status`
(`running`, then exactly one terminal `complete`/`partial`/`failed` with no error
text), `phase` (`initializing`, `recovering`, `planning`, `copying`, `verifying`,
`retiring`, `finalizing`, `complete`; anything else is `unknown`), `recordedAt`,
`elapsedMs`, `acknowledgedRows`, `passRows`, `pendingRows`, `rowsPerSecond`,
`remainingRows`, `etaSeconds` and `lastProgressAt`, plus the CLI's `revision`,
`runId` and `attempt` (null unless well-formed). No database or session ID, cursor,
digest, SQL or text is ever included. The same records go to the Azure sink from
`infra/azure/migration-telemetry.mjs` (see `telemetry.md`); sink problems print one
`migration.telemetry.warning` line with an allowlisted code and aggregate counts,
and never change the copy outcome.

Counters come only from durable state: the validated stored copy checkpoint at
start, then each fenced checkpoint write whose single-row witness returned. An
attempted, rejected, or response-lost write is never reported, so a resumed pass
starts from the stored count (`passRows: 0`) and `null` means not yet known, never
zero. `lastProgressAt` is the time this process observed a durable ACK increase; the
initially stored count, heartbeats and phase changes never set it.
`rowsPerSecond` is the unrounded ACK delta over at most the last ten minutes (a
shorter span only at startup or when the bounded sample history no longer reaches
that far), falls to 0 once no ACK lands within the window, and stays null until
this pass acknowledges a page. `etaSeconds` is the remaining count divided by that
same published rate, rounded up.

`remainingRows` comes from one bounded `COUNT(*)` of source rows past the durable
cursor, issued once per pass and only once the source is provably frozen: the
stored checkpoint already acknowledges rows. That ACK is a separate fenced
destination write, made only after the source retirement transaction that
installs the freeze barrier has committed. Before that, maintenance
does not stop a late in-flight source write, so a fresh copy reports `null`
until its first ACK. The stored state must also be unambiguous: no pending page,
or a page still `copying` (source retirement requires the persisted `verified`
transition first). A `verified` or `recovering` page may already be deleted
without its ACK, so the count waits until that page is acknowledged.
The read uses the copy's request budget; a budget stop there is still the partial
result, while any other failure leaves `remainingRows` and `etaSeconds` null for
the pass. `etaSeconds` exists only with both a known remainder and a positive rate.

Events are emitted at start, when counters first become known, on coarse stage
changes (setup, legacy recovery, the page loop, finalizing), every 30 seconds by
heartbeat, and once at the end. Per-page steps (`planning` → `copying` →
`verifying` → `retiring`) appear only in the next heartbeat's `phase`, bounding log
volume. Heartbeats read nothing from D1 and never block a checkpoint; the timer is
cleared at the terminal progress event, after which the reporter emits no progress.

### Failure context and read-only token diagnostics

A terminal copy error additionally emits one `migration.copy.failure` record to
stdout and the existing Azure sink without changing the original error, failure
status, source/checkpoint state or retry rules. It carries the last observed coarse
copy `phase` from progress (or `unknown`) separately from the allowlisted
`operationPhase` (for example `copy-checkpoint-write`, or `unknown`), failure category, actual
HTTP status, bounded numeric provider codes and closed-category reason, validated
Cloudflare ray/provider timestamp, request duration/attempt, last successful
request timestamp, statement/parameter/body-size aggregates, and a validated D1
database UUID. Unknown numeric/time/ID fields are null. It contains no SQL,
parameter values, rows/sessions, raw provider body/message, request URL,
credentials, token ID/value/fingerprint or exception message. In particular a
401/code 10000 is not automatically classified as an expired token.

Immediately before a required copy, the protected production main-push workflow
runs `migration-auth-diagnostics.mjs --stage preflight`; after the **copy step
itself fails**, it runs `--stage copy_failure`. An unrelated earlier failure or
skipped copy does not trigger the post-copy probe. `copy_failure` describes the
failed GitHub Actions step, not an authentication-failure diagnosis: it also runs
for an expected copy-process budget exit 78 because GitHub marks that step failed.
Both steps are best-effort, with one-minute hard caps; they cannot mask a failed
copy, relabel a provider error as partial, change original exit 78/partial-copy
semantics or allow later migrations/activation to run after a failure. The existing
five-hour copy-process budget and fail-closed cleanup stay unchanged.

Each diagnostic makes one GET to the fixed Cloudflare **user-token**
`/client/v4/user/tokens/verify` endpoint using the existing migration secret,
under the protected main-push guard only. The request/body deadline is at most
one second; redirects and retries are forbidden. Only this one-shot CLI requests
eager Azure authentication before emitting its record: one GitHub OIDC hop and
one Entra hop, each bounded by the existing one-second request/body deadline
(or one at-most-one-second injected token acquisition in local tests). A failed
eager acquisition is sanitized and counted as failed delivery for emitted records,
with no identity retry or ingest request. Normal copying remains lazy. The
unchanged Azure close has its own one-second total deadline. There is no
endpoint/account-token fallback or new secret/scope. Do not run real
production-token diagnostics from a workstation, PR or preview; local tests
inject synthetic fetches only. The CLI guard does not replace
production-environment security.

The safe `migration.auth.diagnostic` record reports its stage, own `recordedAt`,
`verification` (`active`, `inactive`, `unavailable`, `not_configured`), endpoint
`tokenStatus` (`active`, `disabled`, `expired`, or null), optional normalized
`notBefore` / `expiresOn`, and bounded HTTP/code/reason/ray/date/duration evidence.
**Active validity is not D1 permission or account-access proof, nor a guarantee
that a long pass remains healthy.** Unsupported verification, missing/malformed
results and diagnostic transport failures are unknown, not evidence of expiry or
missing permission. A preflight success cannot authorize replay after a later
ambiguous D1 failure.

Use the exact revision/run/attempt read-only monitor described in
[`telemetry.md`](telemetry.md#read-only-live-monitor-successor) to inspect copy
progress, copy failure and preflight/post-failure auth **separately**. Auth/failure
observations have their own age and ingestion lag and never replace durable ACK
progress or refresh its ETA. The bounded sink preserves one pending record per
kind/stage and prioritizes critical records in a batch, but close/transport loss
can still prevent Azure delivery; retain stdout evidence. On close deadline the
separate `abandonedEvents` count includes the in-flight batch and every pending
record exactly once, not a claimed failed delivery whose in-flight outcome is
unknown. Deadline/summary warnings include that count; late settlements or repeated
closes cannot change the terminal counters or emit more warnings. The final
monitor query does not wait for ingestion or prove the absence of a missing final
record.
Keep maintenance and consumers paused, inspect the original failed operation and
durable recovery state, and obtain approval for a protected continuation. No
credential rotation/repair, policy change, automatic resume or new attempt follows
from telemetry alone.

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

