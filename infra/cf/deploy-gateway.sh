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
#   ./infra/cf/deploy-gateway.sh --rotate-bearer # mint a NEW bearer on purpose
#
# Env:
#   CLOUDFLARE_ACCOUNT_ID  defaults to the vza.net-owning account (two accounts
#                          are visible to the wrangler token; deploy is ambiguous
#                          without pinning one).
#   OIDC_KEY_FILE          optional path to the RSA private key PEM from
#                          scripts/generate-gateway-key.mjs; when set, its
#                          OIDC_SIGNING_KEY secret is (re)uploaded too.
#
# Flags:
#   --rotate-bearer        deliberately mint a fresh INGEST_BEARER even though
#                          the worker already exists and no local env file holds
#                          the current one. Only pass this when you INTEND to
#                          rotate — you must then update the account-level
#                          dashboard destinations (telemetry.md step 9) with the
#                          new bearer, or the gateway will 200-no-op every post.
#
# Idempotent: re-running reuses the existing bearer from cf-observability.env and
# just redeploys. Portable to bash 3.2 (no bash4-only features), matching
# infra/azure/provision.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="wrangler.telemetry-gateway.jsonc"
ENV_FILE="$REPO_ROOT/infra/out/cf-observability.env"

ROTATE_BEARER=no
for arg in "$@"; do
    case "$arg" in
        --rotate-bearer) ROTATE_BEARER=yes ;;
        *) echo "unknown argument: $arg (only --rotate-bearer is accepted)" >&2; exit 1 ;;
    esac
done

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-18ef3246e9f36d1560485ef53889c0ab}"

# Best-known URL for the FIRST env-file write (before the worker is deployed).
# Replaced with the real deployed URL after a successful deploy.
GATEWAY_URL="https://sessions-telemetry-gateway.pedro-18e.workers.dev"

# Writes cf-observability.env atomically at mode 0600 from the current
# $GATEWAY_URL + $INGEST_BEARER. Called TWICE (see below). Temp-then-mv because
# umask only governs the mode of NEWLY created files — a bare redirect onto a
# pre-existing 0644 file would leave the bearer world-readable — and the mv is
# atomic so no reader ever sees a half-written secret.
write_env_file() {
    mkdir -p "$(dirname "$ENV_FILE")"
    local tmp
    tmp=$(mktemp "${TMPDIR:-/tmp}/agent-backup-cfobs.XXXXXX")
    chmod 600 "$tmp"
    (umask 077; cat > "$tmp" <<EOF
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
    mv "$tmp" "$ENV_FILE"
}

cd "$REPO_ROOT/hub"

if [ -n "${OIDC_KEY_FILE:-}" ] && [ ! -f "$OIDC_KEY_FILE" ]; then
    echo "OIDC_KEY_FILE=$OIDC_KEY_FILE does not exist" >&2
    exit 1
fi

# Probe worker existence FIRST — both guards below key off it. `wrangler
# deployments list` exits 0 for a deployed worker, non-zero for an unknown name
# (verified both ways against wrangler 4.111).
if npx wrangler deployments list --config "$CONFIG" >/dev/null 2>&1; then
    WORKER_EXISTS=yes
else
    WORKER_EXISTS=no
fi

# Fresh-worker guard. `wrangler deploy --secrets-file` creates the worker if
# absent AND sets its secrets in the SAME atomic version — but a brand-new gateway
# deployed WITHOUT OIDC_SIGNING_KEY can't sign the Azure assertion, so every
# authorized request fails at signing. When the worker is absent, OIDC_KEY_FILE is
# therefore mandatory. For an EXISTING worker it's optional — --secrets-file is
# additive (verified live: a deploy listing only INGEST_BEARER left
# OIDC_SIGNING_KEY intact), so an omitted key preserves the live one.
if [ "$WORKER_EXISTS" = no ] && [ -z "${OIDC_KEY_FILE:-}" ]; then
    echo "ERROR: the gateway worker does not exist yet and OIDC_KEY_FILE is not set." >&2
    echo "A fresh gateway cannot sign Azure assertions without OIDC_SIGNING_KEY, and" >&2
    echo "--secrets-file only sets the secrets you give it (it never invents one)." >&2
    echo "Generate a keypair with private perms:" >&2
    echo "  (umask 077; node scripts/generate-gateway-key.mjs > key.pem)" >&2
    echo "add its public JWK to gateway/oidc-issuer.ts + set OIDC_SIGNING_KID, then re-run:" >&2
    echo "  OIDC_KEY_FILE=key.pem ./infra/cf/deploy-gateway.sh" >&2
    exit 1
fi

# Bearer determination.
#  - Local env file with a bearer  -> reuse it (the safe, common re-run path).
#  - No local bearer, worker EXISTS -> the dashboard destinations already carry a
#    bearer this machine can't see. Minting a new one here would leave them
#    sending the old value, so the gateway would 200-no-op every post until
#    someone noticed. Hard-error with the two legitimate recoveries instead.
#  - No local bearer, worker ABSENT (or --rotate-bearer) -> generate fresh;
#    nothing downstream depends on a prior value.
if [ -f "$ENV_FILE" ] && grep -q '^INGEST_BEARER=' "$ENV_FILE"; then
    INGEST_BEARER=$(grep '^INGEST_BEARER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    BEARER_SOURCE="reused from $ENV_FILE"
elif [ "$WORKER_EXISTS" = yes ] && [ "$ROTATE_BEARER" = no ]; then
    echo "ERROR: the gateway worker already exists but $ENV_FILE is missing, so this" >&2
    echo "machine has no copy of the live INGEST_BEARER. The account-level dashboard" >&2
    echo "destinations are already sending the existing bearer; generating a new one" >&2
    echo "here would make the gateway 200-no-op every post until the dashboard is" >&2
    echo "updated by hand. Choose one:" >&2
    echo "  1. Copy infra/out/cf-observability.env from the machine that first deployed" >&2
    echo "     the gateway (it holds the live bearer), then re-run this script." >&2
    echo "  2. If you INTEND to rotate the bearer, re-run with --rotate-bearer and then" >&2
    echo "     update the dashboard destinations (telemetry.md step 9) with the new one." >&2
    exit 1
else
    INGEST_BEARER=$(openssl rand -hex 32)
    if [ "$ROTATE_BEARER" = yes ]; then
        BEARER_SOURCE="rotated (--rotate-bearer) — UPDATE the dashboard destinations after this"
    else
        BEARER_SOURCE="generated fresh (new worker)"
    fi
fi
echo "INGEST_BEARER: $BEARER_SOURCE"

if [ "$WORKER_EXISTS" = yes ]; then
    echo "Gateway worker exists — deploying with additive secrets."
else
    echo "Gateway worker not found — first deploy will create it with its secrets."
fi

# Persist the bearer BEFORE the deploy that sets secrets. `wrangler deploy
# --secrets-file` publishes a new worker version immediately, so if the deploy or
# the URL extraction dies afterward, the live worker already holds this
# write-only bearer — this early write is the only local copy to recover it from.
write_env_file
echo "Wrote $ENV_FILE (pre-deploy, URL=$GATEWAY_URL)"

# Build the secrets bundle: INGEST_BEARER always, OIDC_SIGNING_KEY only when a key
# file is given. One temp file, 0600, removed on exit even if the deploy fails —
# it holds the RSA private key. python3 (already a dep of these scripts) JSON-
# encodes the multi-line PEM safely; no secret value ever touches the command line.
SECRETS_JSON=$(mktemp "${TMPDIR:-/tmp}/agent-backup-secrets.XXXXXX")
chmod 600 "$SECRETS_JSON"
trap 'rm -f "$SECRETS_JSON"' EXIT
INGEST_BEARER="$INGEST_BEARER" OIDC_KEY_FILE="${OIDC_KEY_FILE:-}" python3 -c '
import json, os
secrets = {"INGEST_BEARER": os.environ["INGEST_BEARER"]}
key_file = os.environ.get("OIDC_KEY_FILE")
if key_file:
    with open(key_file) as f:
        secrets["OIDC_SIGNING_KEY"] = f.read()
print(json.dumps(secrets))
' > "$SECRETS_JSON"

# ONE atomic deploy: code + secrets land in a single worker version. There is no
# secret-put-deploys-a-version-first window, so a key rotation (new key + new
# OIDC_SIGNING_KID var + code, all in this deploy) is a single version flip — the
# live worker never signs with the new key while still advertising old code/kid.
# Capture output to read the real deployed URL.
DEPLOY_OUT=$(npx wrangler deploy --config "$CONFIG" --secrets-file "$SECRETS_JSON" 2>&1)
echo "$DEPLOY_OUT"
rm -f "$SECRETS_JSON"
trap - EXIT

# URL extraction MUST be non-fatal: under `set -euo pipefail` a grep miss
# (custom-domain route, or a wrangler output format change) returns non-zero and
# would abort the script — `|| true` keeps it alive so the fallback runs. (The
# bearer is already persisted above, so a death here loses nothing.)
GATEWAY_URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://sessions-telemetry-gateway\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
GATEWAY_URL="${GATEWAY_URL:-https://sessions-telemetry-gateway.pedro-18e.workers.dev}"

# Rewrite with the real deployed URL now that we have it.
write_env_file

echo ""
echo "Deployed $GATEWAY_URL"
echo "Wrote $ENV_FILE (INGEST_BEARER + destination endpoints for the dashboard step)"
