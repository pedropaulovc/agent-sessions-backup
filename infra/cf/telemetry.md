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
5. Fill `hub/wrangler.telemetry-gateway.jsonc`'s `vars` from
   `infra/out/azure.env`: `TENANT_ID`, `APP_CLIENT_ID`, `OTLP_TRACES_ENDPOINT`,
   `OTLP_LOGS_ENDPOINT`, and set `OIDC_SIGNING_KID` to the kid from step 2.
6. Create a Secrets Store (if one doesn't already exist:
   `npx wrangler secrets-store store create agent-backup --remote`), then put
   the private key from step 1 into it and bind it as `OIDC_SIGNING_KEY`
   (`store_id`/`secret_name` in `hub/wrangler.telemetry-gateway.jsonc` must
   match). Pipe the file in via stdin redirection rather than `--value` (which
   leaves the key in plain text in shell history) or the interactive prompt
   (which risks a paste ending up in terminal scrollback/session logging):
   ```
   npx wrangler secrets-store secret create <store-id> --remote \
     --name agent-backup-oidc-signing-key --scopes workers < /tmp/gateway-key.pem
   ```
   Then delete the temp file — `rm -f /tmp/gateway-key.pem`. (`shred`/secure-
   delete is largely theater on modern SSDs and FileVault/BitLocker-encrypted
   volumes regardless of OS, so a plain `rm` is the realistic bar here; if you
   suspect the key was exposed during the setup window, rotate it instead of
   relying on deletion — see "Rotating the signing key" below.)
7. Pick a random `INGEST_BEARER` value (e.g. `openssl rand -hex 32`) and set
   it as a wrangler secret on the gateway:
   ```
   npx wrangler secret put INGEST_BEARER --config hub/wrangler.telemetry-gateway.jsonc
   ```
8. Deploy the gateway:
   ```
   npx wrangler deploy --config hub/wrangler.telemetry-gateway.jsonc
   ```
9. Create the account-level observability destinations (one for logs, one for
   traces — **these are shared across every worker on the account**, so use
   names that won't collide with anything else, e.g. `agent-backup-azure-logs`
   / `agent-backup-azure-traces`). As of this writing there is no wrangler
   subcommand or public API for this (confirmed: `wrangler observability`
   doesn't exist in wrangler 4.111) — it's dashboard-only:
   [Workers & Pages → Observability → Pipelines → Add destination](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/#creating-a-destination)
   - Destination Name: `agent-backup-azure-logs`, Destination Type: **Logs**,
     OTLP Endpoint: `https://sessions-telemetry-gateway.<account>.workers.dev/v1/logs`,
     Custom Header: `Authorization: Bearer <INGEST_BEARER>`
   - Destination Name: `agent-backup-azure-traces`, Destination Type: **Traces**,
     OTLP Endpoint: `https://sessions-telemetry-gateway.<account>.workers.dev/v1/traces`,
     Custom Header: `Authorization: Bearer <INGEST_BEARER>`

   The header value must equal the `INGEST_BEARER` secret set in step 7 — the
   gateway 200-no-ops (rather than erroring) on any mismatch, so a typo here
   fails silently until you notice no data arriving.
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
add the new key to `PUBLIC_JWKS` and deploy (without touching `ACTIVE_KID`),
wait out the `/.well-known/jwks.json` cache window (`JWKS_CACHE_CONTROL`,
currently 5 minutes), then flip `OIDC_SIGNING_KID` + `ACTIVE_KID` + the
Secrets Store entry together and redeploy both workers, then remove the old
key from `PUBLIC_JWKS`. Never remove an old key from `PUBLIC_JWKS` before the
gateway has been redeployed to sign with the new one — that's the one order
that breaks verification for tokens minted in the gap.

## Trap: destinations are account-level

If this Cloudflare account ever hosts another project's Workers observability
export, its destinations live in the same shared namespace as
`agent-backup-azure-{logs,traces}`. Double-check destination names don't
collide before creating them — there's no CLI to list them either; check the
dashboard (Workers & Pages → Observability → Pipelines).
