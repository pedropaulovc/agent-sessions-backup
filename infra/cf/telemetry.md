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
   managed identity + federated credential, the action group, and the
   KQL-based alerts. Outputs land in `infra/out/azure.env` (gitignored) —
   **this file, not this doc, is the source of truth for the actual values**.
   Safe to re-run: every resource is show-or-create (or, for the federated
   credential specifically, show-or-create-or-update — see the script comment
   — so re-running after the issuer URL changes actually fixes the drift
   instead of leaving Entra trusting a stale issuer).

   The availability webtest defaults to pinging `https://sessions.vza.net/healthz`,
   which only resolves once the M3 zone routes in `hub/wrangler.jsonc` are
   uncommented and deployed. If you're running this script before M3, override
   with a live `workers.dev` URL instead:
   `HEALTHZ_URL=https://sessions-hub.<account>.workers.dev/healthz ./infra/azure/provision.sh <issuer-url>`,
   then re-run without the override once M3 lands so the webtest points at the
   real custom domain.
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
     values are written to `cf-observability.env.pending` (0600) *before* the
     deploy, and promoted over `cf-observability.env` (atomic `mv`) only *after*
     the deploy succeeds. The one window `.pending` guards is "deploy published but
     the script died before promoting": on the next run, if `.pending` exists, the
     script probes the live worker with its bearer — a synthetic OTLP post that
     returns **204** means the deploy *did* publish (it promotes `.pending`), a
     **200** no-op means it did *not* (it discards `.pending`); anything
     inconclusive stops with manual instructions. You normally never see
     `.pending` — it self-heals on the next run.

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
   vza.net-owning account (`18ef3246…`); override the env var if that changes.
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
11. Verify: trigger a request against the hub, then query `OTelLogs` /
    `OTelTraces` (or whatever the actual table names turn out to be — see the
    ASSUMPTION comments in `infra/azure/alerts/*.kql`) in the Log Analytics
    workspace for the new data.

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
