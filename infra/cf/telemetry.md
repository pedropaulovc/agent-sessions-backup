# Cloudflare telemetry wiring (M4)

How Workers observability (logs + traces) for `sessions-hub` reaches Azure
Monitor, with zero Azure secrets. See `infra/azure/provision.sh` for the Azure
side and `infra/azure/federation.md`-equivalent notes inline in
`hub/gateway/*.ts` for the OIDC federation design.

## Pieces

| Piece | Where | What |
|---|---|---|
| Issuer worker | `hub/gateway/oidc-issuer.ts`, `hub/wrangler.oidc-issuer.jsonc` | Publishes `/.well-known/openid-configuration` + `/.well-known/jwks.json`. Azure Entra trusts this instead of a client secret. |
| Gateway worker | `hub/gateway/telemetry-gateway.ts`, `hub/wrangler.telemetry-gateway.jsonc` | Receives OTLP/JSON from Workers observability at `/v1/logs` and `/v1/traces`, transcodes to OTLP/protobuf, forwards to the Azure Monitor DCR endpoints with a self-minted Entra bearer. |
| Observability destinations | Cloudflare account-level, dashboard-only (no wrangler/API command exists for this) | Where `sessions-hub`'s Workers observability actually ships logs/traces. Point them at the gateway's `/v1/{logs,traces}`. |

## Deploy order (M4)

All commands below are written to run from the **repo root** (`agent-sessions-backup/`,
the parent of `hub/`), matching how you'd normally have this repo checked out — every
`wrangler` invocation explicitly passes `--config hub/wrangler.*.jsonc` accordingly. If
you'd rather `cd hub` first, drop the `hub/` prefix from every `--config` path
consistently; don't mix the two conventions in the same session.

1. Generate the keypair, writing the **private** key (stdout) to a temp file
   created with owner-only permissions from the moment it exists — a bare
   `> /tmp/gateway-key.pem` redirect under a typical umask 022 would leave an
   RSA private key that can mint Azure client assertions world-readable for
   the whole setup window, not just until the "delete it" step at the end:
   ```
   (umask 077; node scripts/generate-gateway-key.mjs > /tmp/gateway-key.pem)
   ```
   The **public** JWK (non-sensitive) prints straight to your terminal on
   stderr — the subshell only redirects stdout, so it's not silently
   captured anywhere. Copy it from there for the next step.
2. Add the public JWK to `hub/gateway/oidc-issuer.ts`'s `PUBLIC_JWKS` array
   (replacing the placeholder entry) and set `ACTIVE_KID` to its `kid` — see
   that file's header comment for the full key-rotation sequence if you're
   replacing an already-live key rather than bootstrapping the first one.
3. Deploy the issuer worker first (its URL is needed for the Azure federated
   credential and for the gateway's `OIDC_ISSUER_URL`):
   ```
   npx wrangler deploy --config hub/wrangler.oidc-issuer.jsonc
   ```
   Update `ISSUER_URL` in `hub/wrangler.oidc-issuer.jsonc` to match the real
   deployed URL (workers.dev subdomain or custom route) and redeploy if it
   changed.
4. Run `./infra/azure/provision.sh <issuer-url>` (the issuer URL from step 3).
   This creates the resource group, workspace-based Application Insights, the
   DCE/DCR with native OTLP ingestion (logs + traces), the user-assigned
   managed identity + federated credential, the action group, the KQL-based
   alerts, and the `Agent sessions backup - System health` Azure Workbook.
   The workbook is source-controlled at
   `infra/azure/workbooks/system-health.workbook.json` and is updated
   idempotently on every provisioning run. It is scoped to
   `law-agent-backup`, so it needs no connection string, API key, or other
   Azure secret. Outputs land in `infra/out/azure.env` (gitignored) —
   **this file, not this doc, is the source of truth for the actual values**.
   Safe to re-run: every resource is show-or-create (or, for the federated
   credential specifically, show-or-create-or-update — see the script comment
   — so re-running after the issuer URL changes actually fixes the drift
   instead of leaving Entra trusting a stale issuer).

   The availability webtest defaults to pinging
   `https://sessions.pedrovc.com.br/healthz` — the viewer's custom domain
   (`VIEWER_HOST` in `hub/wrangler.jsonc`). If you're running this script while
   that host isn't live yet (e.g. mid zone move), override with a live
   `workers.dev` URL instead:
   `HEALTHZ_URL=https://sessions-hub.<account>.workers.dev/healthz ./infra/azure/provision.sh <issuer-url>`,
   then re-run without the override once the custom domain resolves so the
   webtest points at the real host.
5. Fill `hub/wrangler.telemetry-gateway.jsonc`'s `vars` from
   `infra/out/azure.env`: `TENANT_ID`, `APP_CLIENT_ID`, `OTLP_TRACES_ENDPOINT`,
   `OTLP_LOGS_ENDPOINT`, **and `OIDC_ISSUER_URL`** (also written to
   `azure.env` by step 4 — it must be byte-for-byte the same `<issuer-url>`
   you passed to `provision.sh`, since that's the issuer the federated
   credential in step 4 trusts; a mismatch here means every Entra token
   exchange fails silently, no telemetry ever reaches Azure, and nothing
   in this runbook surfaces the failure). Set `OIDC_SIGNING_KID` to the kid
   from step 2.
6–8. Set the secrets and deploy the gateway with the idempotent
   **`./infra/cf/deploy-gateway.sh`** — it owns the whole
   secret-lifecycle-plus-deploy so nothing is lost or has to be reconstructed by
   hand:
   ```
   OIDC_KEY_FILE=/tmp/gateway-key.pem ./infra/cf/deploy-gateway.sh
   ```
   It bundles both secrets into a single **atomic** `wrangler deploy
   --secrets-file` (code + secrets land in one worker version — no
   secret-put-publishes-a-version-first window), all idempotent (safe to re-run):
   - **`OIDC_SIGNING_KEY`** (included only when `OIDC_KEY_FILE` is passed): the
     private key from step 1, JSON-encoded into the temp secrets file (0600,
     deleted on exit) — never on the command line or an interactive prompt. It
     lands as a **classic** Worker secret, **not** a Secrets Store binding:
     Secrets Store caps values at 1024 bytes
     (developers.cloudflare.com/secrets-store/manage-secrets/) but a PKCS#8
     RSA-2048 PEM is ~1.7KB; classic Worker secrets allow up to 5KB
     (developers.cloudflare.com/workers/platform/limits/). See
     `hub/gateway/telemetry-gateway.ts`'s header for the citation. On an EXISTING
     worker the key is **optional** — `--secrets-file` is additive (omitted
     secrets are preserved), so leaving it off keeps the live key. On a **fresh**
     worker (the existence probe finds none) it is **required**: a gateway with no
     `OIDC_SIGNING_KEY` can't sign the Azure assertion, so the script errors out
     with instructions rather than deploying a broken gateway.
   - **`INGEST_BEARER`**: reuses the value already in
     `infra/out/cf-observability.env` if present, else mints one
     (`openssl rand -hex 32`), and includes it in the same deploy. This is the fix
     for the "Worker secrets are write-only, so the dashboard step can't recover
     the bearer" trap — the file is the durable copy step 9 reads from.

     **State model:** `cf-observability.env` always reflects the **deployed**
     state; it is never overwritten until a deploy has actually published. New
     values (plus the live worker's current deployment id) are written to
     `cf-observability.env.pending` (0600) *before* the deploy, and promoted over
     `cf-observability.env` only *after* the deploy succeeds. The one window
     `.pending` guards is "deploy published but the script died before promoting":
     on the next run, if `.pending` exists, the script compares the live worker's
     **current deployment id** against the one recorded in `.pending` — every
     `wrangler deploy` mints a new id, so a *changed* id means the deploy *did*
     publish (it promotes `.pending`) and an *unchanged* id means it did *not* (it
     discards `.pending`). The decision is by deployment id, not the bearer,
     precisely so it stays correct during a signing-key rotation (where the bearer
     is reused and so can't tell the two apart). If the id lookup itself **fails**
     (network/auth/API error — distinguished from a genuinely absent worker), the
     script leaves `.pending` **untouched** and stops with instructions rather than
     risk deleting the only durable copy of a published bearer/kid; re-run once
     connectivity is restored. You normally never see `.pending` — it self-heals
     next run.

     To deliberately **rotate** the bearer (e.g. it leaked), run
     `./infra/cf/deploy-gateway.sh --rotate-bearer`: it mints a fresh bearer even
     when the file already holds one. The old bearer stays live in
     `cf-observability.env` until the new one is deployed and promoted, so a failed
     rotation never loses it — nothing to restore by hand. After any rotation you
     MUST update the dashboard destinations (step 9) with the new bearer, or the
     gateway 200-no-ops every post from the old-bearer destinations.

   Then delete the temp key — `rm -f /tmp/gateway-key.pem`. (`shred`/secure-delete
   is largely theater on modern SSD/FileVault/BitLocker volumes, so a plain `rm`
   is the realistic bar; if you suspect the key leaked during setup, rotate it —
   see "Rotating the signing key" below.) Two Cloudflare accounts are visible to
   the wrangler token, so the script pins `CLOUDFLARE_ACCOUNT_ID` to the
   pedrovc.com.br-owning account (`18ef3246…`); override the env var if that changes.
9. Create the account-level observability destinations (one for logs, one for
   traces — **these are shared across every worker on the account**, so use
   names that won't collide with anything else, e.g. `agent-backup-azure-logs`
   / `agent-backup-azure-traces`). There is no wrangler subcommand or usable
   public API for this: `wrangler observability` doesn't exist (wrangler 4.111),
   and every `/accounts/{id}/workers/observability/*` REST path returns **HTTP
   403** with the wrangler OAuth token (confirmed 2026-07-17 — the token is valid
   for `workers/scripts` etc. but carries no observability-destination scope).
   **This is therefore a manual dashboard step — MUST be done by the account
   owner:**
   [Workers & Pages → Observability → Pipelines → Add destination](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/#creating-a-destination)
   - Destination Name: `agent-backup-azure-logs`, Destination Type: **Logs**,
     OTLP Endpoint: `https://sessions-telemetry-gateway.pedro-18e.workers.dev/v1/logs`,
     Custom Header: `Authorization: Bearer <INGEST_BEARER>`
   - Destination Name: `agent-backup-azure-traces`, Destination Type: **Traces**,
     OTLP Endpoint: `https://sessions-telemetry-gateway.pedro-18e.workers.dev/v1/traces`,
     Custom Header: `Authorization: Bearer <INGEST_BEARER>`

   The exact `<INGEST_BEARER>` value (the secret already set on the gateway in
   step 7) and both endpoint URLs are written to the gitignored
   `infra/out/cf-observability.env` at deploy time — copy them from there. The
   header value must equal that `INGEST_BEARER` secret — the gateway 200-no-ops
   (rather than erroring) on any mismatch, so a typo here fails silently until
   you notice no data arriving.
10. In `hub/wrangler.jsonc`, uncomment/add under `observability`:
    ```jsonc
    "logs": { "enabled": true, "destinations": ["agent-backup-azure-logs"] },
    "traces": { "enabled": true, "destinations": ["agent-backup-azure-traces"] }
    ```
    (export is per-signal — a destinations array with no `enabled: true` next
    to it exports nothing; this matches the comment already in
    `hub/wrangler.jsonc`) and redeploy `sessions-hub`.
11. Verify: trigger a request against the hub, then query `OTelLogs` and
    `OTelSpans` in the Log Analytics workspace. Open **Azure Monitor →
    Workbooks → Agent sessions backup - System health** for the combined
    operational view. The live native table names were confirmed on
    2026-07-20: structured log JSON is in `OTelLogs.Body`, spans are in
    `OTelSpans`, and the web test results are in `AppAvailabilityResults`.

## System health workbook signals

The watchdog emits these fleet gauges as structured OpenTelemetry logs every
15 minutes. Keeping the data on the existing logs path avoids a second Azure
Monitor workspace and still provides durable, queryable time series without
adding credentials:

| Event | Scope | Fields used by the workbook |
|---|---|---|
| `hub.machine.health` | One per enrolled machine | OS, collector version, exact last-seen/upload timestamps and ages, pending/error/parsed/skipped/superseded/complete/total file counts |
| `hub.fleet.health` | One aggregate | Machine count, all file-state totals, ready/parsing/error/total session counts |
| `hub.watchdog.run` | One liveness beacon | Roster-read health and machine count |
| `hub.d1.db_size_bytes` | One gauge per metadata/index database | Database binding and current bytes |
| `parse.done`, `parse.error` | Per parse attempt | Parse throughput, failures, and malformed-line totals |
| `access.upload`, `access.multipart_create` | Per upload operation | Upload/ingress throughput |

The workbook also queries `OTelSpans` and `AppAvailabilityResults` for request
volume, failures, latency, ingestion delay, and per-location `/healthz`
availability. It reports p50, p95, and maximum ingestion delay, plus records
delayed by more than five or ten minutes. Each KQL query wraps its native table
with `union isfuzzy=true` and an empty typed datatable. A new workspace shows an
empty or `No data` panel until the first signal lands; it does not fail just
because Azure has not created the table yet.

## What the alerts do (and don't) cover

Only `sessions-hub` gets `observability.logs`/`traces` destinations pointed at
the gateway (step 10 above). `sessions-telemetry-gateway` itself has none, and
must not — it IS the `/v1/{logs,traces}` sink those destinations post to, so
having it export its own telemetry back to itself would be a recursion loop.
Don't add `observability` destinations to `hub/wrangler.telemetry-gateway.jsonc`.

Consequence: `infra/azure/alerts/collector-errors.kql` only ever sees
`collector.event` records that originate in the **hub** (e.g. machine-side
collector errors relayed through it) — never the gateway's own
upstream-forward failures (Entra auth breaking, the DCR endpoint rejecting
requests, etc.), even though that log line uses the same event name and shape
(see the comment on it in `hub/gateway/telemetry-gateway.ts`). A gateway
outage instead shows up as an **absence** of data in Azure altogether —
including the hub's own `hub.heartbeat` events, since those are relayed
through the same broken gateway — which is what
`infra/azure/alerts/missed-heartbeat.kql`'s absence alert and the independent
`/healthz` availability webtest (`infra/azure/provision.sh`, doesn't touch the
Azure telemetry pipeline at all) are for. If gateway-specific diagnostics ever
need to reach Azure, that requires a separate non-recursive sink, not
`sessions-hub`'s destinations.

## Rotating the signing key

The issuer publishes a **JWKS array** (`PUBLIC_JWKS` in
`hub/gateway/oidc-issuer.ts`), not a single key, specifically so a rotation can
carry the old and new key at once while caches (Entra's included) catch up.
Follow the exact sequence documented in that file's header comment — summary:

1. Add the new public JWK to `PUBLIC_JWKS` (keep the old one) and deploy the
   **issuer** — `npx wrangler deploy --config hub/wrangler.oidc-issuer.jsonc` —
   WITHOUT touching `ACTIVE_KID`. Old + new keys now coexist in the JWKS.
2. Wait out the `/.well-known/jwks.json` cache window (`JWKS_CACHE_CONTROL`,
   currently 5 minutes) so Entra's cached copy has the new key.
3. Flip the **gateway** to the new key. Set `OIDC_SIGNING_KID` (in
   `hub/wrangler.telemetry-gateway.jsonc`) and `ACTIVE_KID` (in the issuer) to
   the new kid, then run `OIDC_KEY_FILE=/path/new-key.pem
   ./infra/cf/deploy-gateway.sh`. Because that script deploys code + the new
   `OIDC_SIGNING_KEY` in a **single atomic `wrangler deploy --secrets-file`
   version**, the gateway never lands in the broken in-between state the old
   `secret put`-then-`deploy` flow could leave — signing with the new key while
   still serving code/kid from the previous version. Redeploy the issuer too if
   `ACTIVE_KID` changed.

   The script records the shipped `OIDC_SIGNING_KID` in
   `infra/out/cf-observability.env` and guards both halves of the rotation trap:
   it refuses a **changed** kid without `OIDC_KEY_FILE` (bumping the kid but
   forgetting the new key ships the new kid over the old private key), and it
   refuses a **new key under an unchanged kid** — it cross-checks the provided
   key's public modulus against the issuer's published JWK for the configured kid
   (`GET $OIDC_ISSUER_URL/.well-known/jwks.json`) and errors on a mismatch, since a
   new key needs a new kid + an issuer JWKS update. Either way Entra would reject
   every assertion. So step 3 must always pass `OIDC_KEY_FILE` **and** bump the kid
   (with the issuer publishing the new kid first, step 1); that's not optional.
4. Once the gateway is signing with the new kid (immediately, since step 3 is one
   version), remove the old key from `PUBLIC_JWKS` and redeploy the issuer.

Never remove an old key from `PUBLIC_JWKS` before the gateway has been redeployed
to sign with the new one — that's the one order that breaks verification for
tokens minted in the gap.

## Trap: destinations are account-level

If this Cloudflare account ever hosts another project's Workers observability
export, its destinations live in the same shared namespace as
`agent-backup-azure-{logs,traces}`. Double-check destination names don't
collide before creating them — there's no CLI to list them either; check the
dashboard (Workers & Pages → Observability → Pipelines).

## Protected migration telemetry (GitHub Actions → Azure)

The production copy CLI writes aggregate `migration.copy.progress` and terminal
`migration.copy.failure` events; protected preflight/post-failure diagnostics write
`migration.auth.diagnostic` events. All go
directly to the **same existing DCR OTLP logs endpoint**. This is a separate
credential path from the Worker gateway: GitHub's protected `production`
environment exchanges its OIDC assertion for the existing
`mi-agent-backup-cloudflare-wu2` identity's DCR-scoped Monitoring Metrics Publisher
token. No gateway bearer, Azure key, collector change, or Cloudflare login is
required. The existing `cf-worker-federation` credential stays untouched.

Provision only this additional trust, using the owner's Azure login:

```sh
node infra/azure/provision-migration-federation.mjs --observe
node infra/azure/provision-migration-federation.mjs --apply
```

This helper pins the existing subscription, tenant, identity and DCR, checks the
existing publisher role, and creates only `migration-github-production` when
absent. It refuses credential drift instead of rewriting trust. It does **not**
run `provision.sh`, change roles, deploy Workers, or update alerts/workbooks.
The exact trust is issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, subject
`repo:pedropaulovc/agent-sessions-backup:environment:production`.

Copy the helper's three **nonsecret** `variables` values into GitHub environment
`production` variables:

| Variable | Value source |
|---|---|
| `MIGRATION_AZURE_TENANT_ID` | Existing Azure tenant |
| `MIGRATION_AZURE_CLIENT_ID` | Existing managed identity's client ID, not principal ID |
| `MIGRATION_AZURE_LOGS_ENDPOINT` | Full DCE/DCR immutable-ID `/streams/Microsoft-OTLP-Logs/otlp/v1/logs` URL |

Only the deploy job has `id-token: write`; previews and PR tests receive neither
this permission nor these environment variables. Production authentication uses
only `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; there is no
environment-variable access-token override. GitHub and Entra redirects are
rejected. Endpoint validation limits credential-bearing requests to GitHub
Actions OIDC, `login.microsoftonline.com`, and Azure Monitor's OTLP logs route.
The token is cached with a 60-second refresh margin, and a fresh GitHub assertion
is requested on refresh, including during multi-hour copies.

The sink reuses `hub/gateway/otlp-protobuf.ts` through a **configured-only dynamic
import**. CI pins Node **22.22.2**, whose native type stripping supports that
encoder without build output or dependencies. Configured standalone telemetry
requires native type stripping (older Node 22 releases may require
`--experimental-strip-types`); unconfigured local/preview copy invocations never
import TypeScript. An unavailable encoder produces a typed warning rather than
breaking copying.

`createMigrationTelemetry({ env, fetch?, now?, warn?, getAccessToken?, authentication? })`
resolves to `{ emit(event), close() }`. Authentication is the explicit
`'lazy' | 'eager'` option, defaulting to `'lazy'` for normal copying. Only the
one-shot auth-diagnostics CLI opts into `'eager'`: sink creation waits for one
bounded token acquisition before returning, leaving close's flush budget for
ingestion. GitHub OIDC and Entra each retain their separate at-most-one-second
request/body deadline (at most two seconds total); an injected `getAccessToken`
has its existing one-second deadline. A failed eager acquisition is retained only
as a sanitized typed failure: emitted records enter failed-event accounting
without retrying identity or attempting ingestion.

`emit` is synchronous/nonblocking and copies only the finite event allowlist plus
full revision/run/attempt correlation. Progress's
schema is unchanged. It keeps one in-flight request and at most four pending
records: the newest progress, copy failure, preflight auth and copy-failure auth.
Coalescing is per kind/stage, so a heartbeat or generic failed progress cannot
discard failure/auth context (nor can a diagnostic replace progress). Pending
records are encoded together in one bounded existing-protobuf request, ordered
copy failure, post-failure auth, preflight auth, then progress. No per-successful-
Cloudflare-request logs are added. Each network operation has a one-second
deadline; `close()` has a separate one-second total flush deadline. Its synchronous
deadline/summary warnings are emitted before it resolves; no diagnostics or
follow-on HTTP requests are issued after close resolves, even if an existing
request ignores abort and settles later. Delivery, including terminal evidence,
is best-effort: an in-flight stall can still exhaust close before a pending batch
is delivered. `abandonedEvents` counts both the in-flight batch and all pending
records left at that deadline, exactly once. These are not added to `failedEvents`:
the in-flight delivery outcome is unknown. Warnings and the delivery summary
include `sentEvents`, `failedEvents`, `coalescedEvents`, `droppedEvents` and
`abandonedEvents`; late settlements cannot mutate counters or emit another
warning/summary, and repeated/concurrent closes share the same terminal boundary.
There is no replay/retry loop or telemetry I/O in checkpoint ACKs. Warnings contain
only typed codes and aggregate delivery counts, never tokens, headers, upstream
bodies, errors, row IDs, hashes, or session text. The copy CLI also preserves all
five delivery counters in stdout warning records, so unavailable Azure delivery
does not hide abandonment.

### Failure context and token validity

Both new kinds are flat `schemaVersion: 1` records with their own ISO `recordedAt`
and the same strict full revision/run/attempt correlation. Unknown fields are
dropped, not forwarded. `migration.copy.failure` carries the last observed coarse
copy `phase` (the same vocabulary as progress, or `unknown`) and allowlisted
`operationPhase` (for example `copy-checkpoint-write`, or `unknown`), `failureKind`, actual
`httpStatus`, at most 16 numeric `providerCodes`, closed-category `providerReason`,
validated `cfRay`, normalized `providerDate`, `requestDurationMs`, `requestAttempt`,
`lastSuccessfulRequestAt`, request size/count aggregates (`statementCount`,
`parameterCount`, `bodyBytes`, `parameterJsonBytes`) and a validated D1 `databaseId`.
Unknown values are null, never inferred from an exception message. No SQL,
parameters, row/session content, raw provider message/body, request URL, token ID,
token value or fingerprint is emitted. The original copy error and outcome remain
unchanged. HTTP 401 or code 10000 alone is not evidence of token expiry.
After guarded configuration setup, failure context covers the initial maintenance
health and drain/atomicity prerequisites as well as the pass. A prerequisite
failure can have `phase: "unknown"` and no preceding progress event.

`migration.auth.diagnostic` adds `stage` (`preflight` or `copy_failure`),
`verification` (`active`, `inactive`, `unavailable`, `not_configured`),
`tokenStatus` (`active`, `disabled`, `expired`, or null), normalized `notBefore` /
`expiresOn` (or null), and the same bounded provider HTTP/code/reason/ray/date/
duration fields. It makes one read-only GET to the fixed **user-token** endpoint
`https://api.cloudflare.com/client/v4/user/tokens/verify`, with the existing
migration secret supplied only as `CLOUDFLARE_API_TOKEN`. A reported active token is
**not proof of D1 permissions, account access, or whole-pass health**. Unsupported,
unavailable or malformed verification is unknown, not proof of an invalid token or
missing D1 permission. There is no account-token probe or endpoint fallback.
Only a well-formed HTTP 200 verification response supplies token metadata;
other HTTP statuses leave that metadata unknown, including other 2xx responses.

The diagnostic CLI permits a real request only with `GITHUB_ACTIONS=true`,
`GITHUB_REF=refs/heads/main`, `GITHUB_EVENT_NAME=push`,
`PROTECTED_PRODUCTION_MIGRATION=1`, and the exact repository
`pedropaulovc/agent-sessions-backup`. This operational guard does not replace GitHub
production-environment protections. PR/PPE/local tests use only injected synthetic
fetches; do not export production Cloudflare credentials locally to try this CLI.
The single verification deadline is at most one second, including response-body
reading; redirects are rejected and there are no retries. The CLI then eagerly
authenticates the Azure sink within the existing two-hop limits above before
emitting its one record; the unchanged sink close adds at most one second of
flushing. Workflow diagnostic steps have an additional one-minute hard cap and
are best-effort; a preflight problem cannot block copying, and a post-failure
diagnostic cannot turn a failed copy into success. The `copy_failure` stage
observes the actual **failed GitHub Actions copy step**, including an expected
copy-process budget exit 78 because GitHub marks that step failed; it does not
imply an authentication failure. Original exit 78/partial-copy semantics remain
unchanged. An unrelated job failure does not trigger this observation. Neither
diagnostic performs credential repair, changes scopes/policy, resumes copying or
starts another attempt.

### Verify ingestion without Cloudflare credentials

Use a principal authorized to publish telemetry to this DCR for a **smoke only**.
Subscription Owner access does not include the **Monitoring Metrics Publisher**
data actions. The existing publisher managed identity already has the DCR-scoped
role and can run the smoke from temporary Azure compute with that identity
attached. If using a local user, verify its DCR publish authorization first:
[RBAC changes can take up to ten minutes and may require a refreshed token](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting#symptom---role-assignment-changes-are-not-being-detected).
A local-user 403 alone does not establish that GitHub federation is broken or
that native OTLP rejects every delegated-user token.

The programmatic `getAccessToken({ signal })` injection returns a token string
and exists for tests/this smoke; production does not use it. The local-user
example below uses Azure CLI; an identity-attached Azure runtime can instead
obtain its managed-identity token before creating the sink. Never print either
token. Delete temporary compute and any temporary smoke-only role grant after
verification. Keep a smoke's run ID separate from any real/protected workflow
(for example synthetic run ID `1`) so its unknown counters cannot be mistaken
for real migration evidence.

With the three nonsecret variables exported and `SMOKE_REVISION` set to the
feature's full SHA, run from the repository root:

```sh
node --input-type=module <<'NODE'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMigrationTelemetry } from './infra/azure/migration-telemetry.mjs';
const execute = promisify(execFile);
// Fetch once outside the sink's one-second callback deadline. Never print the token.
const { stdout } = await execute('az', ['account', 'get-access-token',
  '--resource', 'https://monitor.azure.com', '--query', 'accessToken', '-o', 'tsv'],
  { timeout: 30_000, maxBuffer: 64 * 1024 });
const warnings = [];
const sink = await createMigrationTelemetry({
  getAccessToken: async () => stdout.trim(),
  warn: (event) => { warnings.push(event); console.warn(JSON.stringify(event)); },
});
sink.emit({
  event: 'migration.copy.progress', schemaVersion: 1, status: 'running', phase: 'unknown',
  revision: process.env.SMOKE_REVISION, runId: '1', attempt: '1',
  recordedAt: new Date().toISOString(), acknowledgedRows: null, passRows: null,
  pendingRows: null, elapsedMs: 0, rowsPerSecond: null, remainingRows: null,
  etaSeconds: null, lastProgressAt: null,
});
await sink.close();
if (warnings.length) process.exitCode = 1;
NODE
```

A quiet sink close alone is **not** proof of Log Analytics visibility. Resolve
the workspace customer ID read-only, then query the exact smoke correlation:

```sh
az monitor log-analytics workspace show --subscription 07aba226-fd59-489a-b07b-4158fef12a5d \
  --resource-group rg-agent-backup --workspace-name law-agent-backup --query customerId -o tsv
```

`migrationProgressQuery({ revision, runId: '1', attempt: '1' })` exported by
`infra/cf/monitor-main-run.mjs` supplies the same KQL used by the live monitor.
Run it using `az monitor log-analytics query --workspace <customer-ID>
--analytics-query <query> --timespan P1D --output json`. Allow for ingestion
delay; require the exact revision/run/attempt and inspect the original JSON text
`Body`, `IngestedAt`, and `TimeGenerated`, not just an HTTP acceptance. The query
preserves `originalBody = tostring(Body)` before dynamic parsing and returns that
text unchanged; reserializing KQL's parsed dynamic object could coerce malformed
numeric evidence into a valid-looking type. `migrationProgressEvidence(rows,
correlation)` gives the aggregate-only progress interpretation, and
`migrationDiagnosticEvidence(rows, correlation)` gives separate failure/auth
observations. The tests exercise protobuf bytes, auth/expiry, bounded per-kind
coalescing, deadline/error isolation, original-body validation and stale/cross-run
evidence independently; they do not substitute for live ingestion proof.

### Read-only live monitor successor

After the existing private monitor **has settled**, start only one successor:

```sh
node infra/cf/monitor-main-run.mjs --run-id <run-ID> --head <full-SHA> \
  --attempt <attempt-number> --workspace <workspace-customer-ID>
```

It reads GitHub run/job/step metadata (never running-job logs) every 30 seconds
and queries Azure at most once per minute plus a final query. GitHub calls have
a 30-second deadline; Azure queries have a 20-second deadline. HTTP 502 gets at
most three consecutive read attempts; no workflow rerun is performed. It
validates GitHub revision, run ID and attempt, and Azure events are filtered by
all three both in KQL and locally. Only changed evidence/transitions and
explicit failures are printed. CLI exit status `0` means the observed workflow
concluded successfully; `1` means it concluded non-successfully; `2` means the
monitor itself failed (invalid arguments, a blind GitHub read, or an identity
mismatch), not evidence that the workflow failed.

`heartbeatRecordedAt` is the reporter timestamp; `heartbeatAgeSeconds` shows its
age when the evidence line was printed. `ingestedAt` and `ingestionLagSeconds`
show Azure delay separately. `lastProgressAt` advances only on a durable ACK,
never because another heartbeat arrived. For a fresh heartbeat, `ackEvidence`
measures ACK recency **as of that heartbeat** (`recordedAt - lastProgressAt`),
not the later query time: ingestion lag and reused query results cannot turn a
recent ACK into `no-recent-ack`. A heartbeat older than three minutes is
**stale**, even if Azure just ingested it; ACK recency/rate/ETA become unknown.
For fresh evidence, known-zero remaining rows have ETA zero even when the recent
rate is unknown; unknown remaining rows never become zero ETA.
A fresh heartbeat whose ACK was already more than three minutes old says
`no-recent-ack`, not that the copy is proven stalled. Missing/query-failed/
cross-run evidence is unknown, never zero. `--no-azure` is an explicit
metadata-only opt-out and labels durable progress/rate/ETA unknown. A successful
workflow may finish before the final Azure event lands; the monitor says so
rather than claiming delivery.

Each Azure query returns at most four correlated observations: the latest copy
progress, copy failure, and auth diagnostic per stage. Failure/auth output has its
own `recordedAt`, age and ingestion lag and is printed separately; even a newly
recorded active-token observation cannot replace an old ACK heartbeat or refresh
its rate/ETA. Auth output explicitly says permission evidence is not established.
The one final read-only query can expose a post-copy-failure diagnostic already
ingested, but adds no settle/retry loop or ingestion-completeness claim. On a query
failure, diagnostic observations become unknown instead of retaining old evidence
as current. Inspect the original failure, both diagnostic stages and durable state
before approving any protected continuation; do not rotate credentials, change
permissions, infer expiry or automatically rerun from these observations alone.

These migration events do not change the existing D1 metrics, alert thresholds,
or workbook consumers. In particular they are not evidence that an independent
D1 metrics acceptance gate has been met.

