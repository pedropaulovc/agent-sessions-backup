#!/bin/bash
# Idempotent deploy of sessions-telemetry-gateway.
#
# The gateway needs a shared bearer (INGEST_BEARER) that ALSO has to be typed
# into the account-level observability destinations in the Cloudflare dashboard
# (infra/cf/telemetry.md step 9). Worker secrets are write-only — once set, the
# value can't be read back — so if the only copy lived in the Worker secret, a
# fresh operator would lose the exact string the dashboard needs and the gateway
# would silently 200-no-op every mismatch. This script is the single source of
# truth for that lifecycle: it generates INGEST_BEARER once, reuses it forever
# after, sets it (and optionally the OIDC signing key) as Worker secrets,
# deploys the gateway, and writes the bearer + endpoints to the gitignored
# infra/out/cf-observability.env (umask 077) for the dashboard step to copy from.
#
# Usage:
#   ./infra/cf/deploy-gateway.sh                 # reuse/generate bearer, deploy
#   OIDC_KEY_FILE=/path/key.pem ./infra/cf/deploy-gateway.sh   # also set OIDC_SIGNING_KEY
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID  defaults to the vza.net-owning account (two accounts
#                          are visible to the wrangler token; deploy is ambiguous
#                          without pinning one).
#   OIDC_KEY_FILE          optional path to the RSA private key PEM from
#                          scripts/generate-gateway-key.mjs; when set, its
#                          OIDC_SIGNING_KEY secret is (re)uploaded too.
#
# Idempotent: re-running reuses the existing bearer from cf-observability.env and
# just redeploys. Portable to bash 3.2 (no bash4-only features), matching
# infra/azure/provision.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="wrangler.telemetry-gateway.jsonc"
ENV_FILE="$REPO_ROOT/infra/out/cf-observability.env"

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-18ef3246e9f36d1560485ef53889c0ab}"

# Reuse an already-issued bearer if we have one, else mint a fresh one. This is
# what makes the script safe to re-run: the destinations in the dashboard keep
# working across redeploys because the bearer doesn't churn.
if [ -f "$ENV_FILE" ] && grep -q '^INGEST_BEARER=' "$ENV_FILE"; then
    INGEST_BEARER=$(grep '^INGEST_BEARER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    BEARER_SOURCE="reused from $ENV_FILE"
else
    INGEST_BEARER=$(openssl rand -hex 32)
    BEARER_SOURCE="generated fresh"
fi
echo "INGEST_BEARER: $BEARER_SOURCE"

cd "$REPO_ROOT/hub"

# Optional: (re)set the OIDC signing private key. Piped via stdin, never on the
# command line / interactive prompt (avoids scrollback capture).
if [ -n "${OIDC_KEY_FILE:-}" ]; then
    if [ ! -f "$OIDC_KEY_FILE" ]; then
        echo "OIDC_KEY_FILE=$OIDC_KEY_FILE does not exist" >&2
        exit 1
    fi
    echo "Setting OIDC_SIGNING_KEY from $OIDC_KEY_FILE"
    npx wrangler secret put OIDC_SIGNING_KEY --config "$CONFIG" < "$OIDC_KEY_FILE"
fi

# printf (no trailing newline) so the secret value is exactly the bearer.
printf '%s' "$INGEST_BEARER" | npx wrangler secret put INGEST_BEARER --config "$CONFIG"

# Capture deploy output so we can read the real deployed workers.dev URL rather
# than hard-coding the subdomain. The extraction MUST be non-fatal: under
# `set -euo pipefail` a grep miss (custom-domain route, or a wrangler output
# format change) returns non-zero and would abort the script here — AFTER the
# Worker secret is already set but BEFORE cf-observability.env is written, i.e.
# exactly the bearer-loss failure this script exists to prevent. `|| true` keeps
# it alive so the `${GATEWAY_URL:-<default>}` fallback on the next line runs.
DEPLOY_OUT=$(npx wrangler deploy --config "$CONFIG" 2>&1)
echo "$DEPLOY_OUT"
GATEWAY_URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://sessions-telemetry-gateway\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
GATEWAY_URL="${GATEWAY_URL:-https://sessions-telemetry-gateway.pedro-18e.workers.dev}"

mkdir -p "$(dirname "$ENV_FILE")"
(umask 077; cat > "$ENV_FILE" <<EOF
# Cloudflare account-level observability destinations — MANUAL DASHBOARD STEP.
# Written by infra/cf/deploy-gateway.sh. GITIGNORED (infra/out/) — contains the
# INGEST_BEARER secret; never commit. Account-level observability destinations
# cannot be created via wrangler or the Cloudflare API with the wrangler OAuth
# token (every /accounts/{id}/workers/observability/* path returns HTTP 403 —
# the token lacks the scope; confirmed 2026-07-17). Create these two in the
# dashboard (Workers & Pages -> Observability -> Pipelines -> Add destination),
# then uncomment the observability.logs/traces block in hub/wrangler.jsonc.
#
# Account: $CLOUDFLARE_ACCOUNT_ID
#
# Destination 1:
#   Name: agent-backup-azure-logs
#   Type: Logs
#   OTLP Endpoint: $GATEWAY_URL/v1/logs
#   Custom Header: Authorization: Bearer <INGEST_BEARER below>
# Destination 2:
#   Name: agent-backup-azure-traces
#   Type: Traces
#   OTLP Endpoint: $GATEWAY_URL/v1/traces
#   Custom Header: Authorization: Bearer <INGEST_BEARER below>

INGEST_BEARER=$INGEST_BEARER
GATEWAY_LOGS_ENDPOINT=$GATEWAY_URL/v1/logs
GATEWAY_TRACES_ENDPOINT=$GATEWAY_URL/v1/traces
EOF
)

echo ""
echo "Deployed $GATEWAY_URL"
echo "Wrote $ENV_FILE (INGEST_BEARER + destination endpoints for the dashboard step)"
