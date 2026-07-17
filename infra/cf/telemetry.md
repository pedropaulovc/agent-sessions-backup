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
| Observability destinations | Cloudflare account-level (dashboard or `wrangler observability destinations`) | Where `sessions-hub`'s Workers observability actually ships logs/traces. Point them at the gateway's `/v1/{logs,traces}`. |

## Deploy order (M4)

1. `node scripts/generate-gateway-key.mjs > /tmp/gateway-key.pem` — capture the
   stderr public JWK too.
2. Paste the public JWK into `hub/gateway/oidc-issuer.ts`'s `PUBLIC_JWK`
   (replacing the placeholder), and note its `kid`.
3. Deploy the issuer worker first (its URL is needed for the Azure federated
   credential and for the gateway's `OIDC_ISSUER_URL`):
   ```
   npx wrangler deploy --config wrangler.oidc-issuer.jsonc
   ```
   Update `ISSUER_URL` in `wrangler.oidc-issuer.jsonc` to match the real
   deployed URL (workers.dev subdomain or custom route) and redeploy if it
   changed.
4. Run `infra/azure/provision.sh <issuer-url>` (the issuer URL from step 3).
   This creates the resource group, workspace-based Application Insights, the
   DCE/DCR with `Microsoft-OTLP-Logs`/`Microsoft-OTLP-Traces` streams, the
   user-assigned managed identity + federated credential, the action group,
   and the KQL-based alerts. Outputs land in `infra/out/azure.env`
   (gitignored) — **this file, not this doc, is the source of truth for the
   actual values**.
5. Fill `hub/wrangler.telemetry-gateway.jsonc`'s `vars` from
   `infra/out/azure.env`: `TENANT_ID`, `APP_CLIENT_ID`, `OTLP_TRACES_ENDPOINT`,
   `OTLP_LOGS_ENDPOINT`, and set `OIDC_SIGNING_KID` to the kid from step 2.
6. Create a Secrets Store (if one doesn't already exist:
   `npx wrangler secrets-store store create agent-backup --remote`), then put
   the private key from step 1 into it and bind it as `OIDC_SIGNING_KEY`
   (`store_id`/`secret_name` in the wrangler config must match):
   ```
   npx wrangler secrets-store secret create <store-id> --remote \
     --name agent-backup-oidc-signing-key --scopes workers
   ```
   (paste the PEM at the interactive prompt rather than `--value`, which
   leaves it in shell history) then delete `/tmp/gateway-key.pem`.
7. Pick a random `INGEST_BEARER` value (e.g. `openssl rand -hex 32`) and set
   it as a wrangler secret on the gateway:
   ```
   npx wrangler secret put INGEST_BEARER --config wrangler.telemetry-gateway.jsonc
   ```
8. Deploy the gateway:
   ```
   npx wrangler deploy --config wrangler.telemetry-gateway.jsonc
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
    "logs": { "destinations": ["agent-backup-azure-logs"] },
    "traces": { "destinations": ["agent-backup-azure-traces"] }
    ```
    and redeploy `sessions-hub`.
11. Verify: trigger a request against the hub, then query `OTelLogs` /
    `OTelTraces` (or whatever the actual table names turn out to be — see the
    ASSUMPTION comments in `infra/azure/alerts/*.kql`) in the Log Analytics
    workspace for the new data.

## Rotating the signing key

Re-run `scripts/generate-gateway-key.mjs`, update the issuer worker's
`PUBLIC_JWK` + redeploy, update `OIDC_SIGNING_KID` + the Secrets Store entry on
the gateway + redeploy. Both must change together — a stale `kid` on either
side breaks the JWKS lookup.

## Trap: destinations are account-level

If this Cloudflare account ever hosts another project's Workers observability
export, its destinations live in the same shared namespace as
`agent-backup-azure-{logs,traces}`. Double-check destination names don't
collide before creating them (`npx wrangler observability destinations list`).
