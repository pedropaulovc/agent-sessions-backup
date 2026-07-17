#!/bin/bash
# Idempotent deploy of sessions-telemetry-gateway.
#
# The gateway needs a shared bearer (INGEST_BEARER) that ALSO has to be typed into
# the account-level observability destinations in the Cloudflare dashboard
# (infra/cf/telemetry.md step 9). Worker secrets are write-only — once set, the
# value can't be read back — so the gitignored infra/out/cf-observability.env is
# the durable local copy the dashboard step reads from.
#
# STATE MODEL (the important bit). cf-observability.env always reflects the
# DEPLOYED state — it is never overwritten until a deploy has actually published.
# New values (a rotated bearer, a new kid) are computed in memory and written to
# cf-observability.env.pending FIRST, then the deploy runs, then .pending is
# promoted over cf-observability.env (atomic mv). The only window .pending guards
# is "deploy published but the script died before promoting": on the next run, if
# .pending exists, we probe the live worker with .pending's bearer — 204 means the
# deploy DID publish (promote it), a 200 no-op means it did NOT (discard it). That
# single rule replaces the older bearer-first write + .prev backup + their guards.
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
#                          OIDC_SIGNING_KEY secret is (re)uploaded too. Cross-checked
#                          against the issuer's published JWK for the configured kid.
#
# Flags:
#   --rotate-bearer        deliberately mint a fresh INGEST_BEARER even when
#                          cf-observability.env already holds one (its point is
#                          replacing a leaked bearer from the box that HAS the
#                          file). The old value stays live in cf-observability.env
#                          until the new one is deployed and promoted, so a failed
#                          rotation never loses it. After a rotation you MUST update
#                          the dashboard destinations (telemetry.md step 9) with the
#                          new bearer, or the gateway 200-no-ops every post.
#
# Idempotent: re-running reuses the deployed bearer from cf-observability.env and
# just redeploys. Portable to bash 3.2 (no bash4-only features), matching
# infra/azure/provision.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="wrangler.telemetry-gateway.jsonc"
ENV_FILE="$REPO_ROOT/infra/out/cf-observability.env"
PENDING_FILE="$ENV_FILE.pending"

ROTATE_BEARER=no
for arg in "$@"; do
    case "$arg" in
        --rotate-bearer) ROTATE_BEARER=yes ;;
        *) echo "unknown argument: $arg (only --rotate-bearer is accepted)" >&2; exit 1 ;;
    esac
done

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-18ef3246e9f36d1560485ef53889c0ab}"

# Best-known URL until the deploy reports the real one.
GATEWAY_URL="https://sessions-telemetry-gateway.pedro-18e.workers.dev"

# Reads a "name": "value" var out of $CONFIG. Regex, not a JSON lib, because the
# wrangler config is JSONC — comments + trailing commas that json.load chokes on.
config_var() {
    CV_NAME="$1" python3 -c '
import os, re, sys
name = os.environ["CV_NAME"]
s = open(sys.argv[1]).read()
m = re.search(r"\"" + re.escape(name) + r"\"\s*:\s*\"([^\"]+)\"", s)
print(m.group(1) if m else "")
' "$CONFIG"
}

# Writes the observability state file to $1 atomically at mode 0600 from the
# current $INGEST_BEARER / $GATEWAY_URL / $CONFIG_KID. Temp-then-mv because umask
# only governs NEWLY created files — a bare redirect onto a pre-existing 0644 file
# would leave the bearer world-readable — and mv is atomic so no reader sees a
# half-written secret.
write_state_file() {
    local target="$1" tmp
    mkdir -p "$(dirname "$target")"
    tmp=$(mktemp "${TMPDIR:-/tmp}/agent-backup-cfobs.XXXXXX")
    chmod 600 "$tmp"
    (umask 077; cat > "$tmp" <<EOF
# Cloudflare account-level observability destinations — MANUAL DASHBOARD STEP.
# Written by infra/cf/deploy-gateway.sh. GITIGNORED (infra/out/) — contains the
# INGEST_BEARER secret; never commit. Reflects the DEPLOYED gateway state.
# Account-level observability destinations cannot be created via wrangler or the
# Cloudflare API with the wrangler OAuth token (every
# /accounts/{id}/workers/observability/* path returns HTTP 403 — the token lacks
# the scope; confirmed 2026-07-17). Create these two in the dashboard (Workers &
# Pages -> Observability -> Pipelines -> Add destination), then uncomment the
# observability.logs/traces block in hub/wrangler.jsonc.
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
# The OIDC signing kid this deploy shipped (from $CONFIG's OIDC_SIGNING_KID var).
# The next run compares the config's kid to this recorded (deployed) kid: a change
# is a key rotation and is refused unless OIDC_KEY_FILE accompanies it.
OIDC_SIGNING_KID=$CONFIG_KID
EOF
    )
    mv "$tmp" "$target"
}

# Posts a minimal valid OTLP log to the gateway with $2 as the bearer and prints
# the HTTP status. 204 = the worker accepts this bearer (a matching secret is
# live); 200 = the gateway's no-op path (wrong bearer, or nothing forwarded);
# anything else (000 on a connection error, 404, 5xx) = inconclusive. node's
# global fetch (Node 18+, already required by wrangler) keeps this dependency-free.
probe_status() {
    OIDC_PROBE_URL="$1" OIDC_PROBE_BEARER="$2" node -e '
const url = process.env.OIDC_PROBE_URL, bearer = process.env.OIDC_PROBE_BEARER;
const now = String(BigInt(Date.now()) * 1000000n);
const body = JSON.stringify({ resourceLogs: [ { scopeLogs: [ { logRecords: [ { timeUnixNano: now, body: { stringValue: "deploy-gateway recovery probe" } } ] } ] } ] });
fetch(url + "/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + bearer }, body })
  .then(r => { console.log(r.status); process.exit(0); })
  .catch(() => { console.log("000"); process.exit(0); });
' 2>/dev/null || echo "000"
}

# Resolve OIDC_KEY_FILE to an absolute path NOW, while still in the caller's cwd.
# The documented workflow is `OIDC_KEY_FILE=key.pem ./infra/cf/deploy-gateway.sh`
# from the repo root, but this script cd's into hub/ before it reads the key — a
# relative path would then resolve against hub/ and appear to vanish. `cd dirname
# && pwd` is the portable (bash 3.2, no realpath dep) absolute-path trick.
if [ -n "${OIDC_KEY_FILE:-}" ]; then
    if [ ! -f "$OIDC_KEY_FILE" ]; then
        echo "OIDC_KEY_FILE=$OIDC_KEY_FILE does not exist" >&2
        exit 1
    fi
    OIDC_KEY_FILE="$(cd "$(dirname "$OIDC_KEY_FILE")" && pwd)/$(basename "$OIDC_KEY_FILE")"
fi

cd "$REPO_ROOT/hub"

CONFIG_KID=$(config_var OIDC_SIGNING_KID)
CONFIG_ISSUER_URL=$(config_var OIDC_ISSUER_URL)
if [ -z "$CONFIG_KID" ]; then
    echo "ERROR: could not read OIDC_SIGNING_KID from $CONFIG" >&2
    exit 1
fi

# --- Recovery: resolve a leftover .pending BEFORE doing anything else. Its
# presence means a previous run died around its deploy; we can't run any mode
# blind over that ambiguity (a normal deploy would reuse whichever bearer happens
# to be in env, which may or may not be the live one). Probe to decide. ---
if [ -f "$PENDING_FILE" ]; then
    echo "Found $PENDING_FILE — a previous run died around its deploy; resolving first."
    PENDING_BEARER=$(grep '^INGEST_BEARER=' "$PENDING_FILE" | head -1 | cut -d= -f2- || true)
    if [ -z "$PENDING_BEARER" ]; then
        echo "ERROR: $PENDING_FILE has no INGEST_BEARER line; can't tell what was deploying." >&2
        echo "Inspect and remove it by hand, then re-run." >&2
        exit 1
    fi
    PENDING_STATUS=$(probe_status "$GATEWAY_URL" "$PENDING_BEARER")
    if [ "$PENDING_STATUS" = "204" ]; then
        mv "$PENDING_FILE" "$ENV_FILE"
        echo "  Live worker ACCEPTS the pending bearer (204): that deploy DID publish."
        echo "  Promoted $PENDING_FILE -> $ENV_FILE. Continuing."
    elif [ "$PENDING_STATUS" = "200" ]; then
        rm -f "$PENDING_FILE"
        echo "  Live worker REJECTS the pending bearer (200 no-op): that deploy did NOT publish;"
        echo "  the previous $ENV_FILE is still the live state. Discarded stale $PENDING_FILE."
    else
        echo "ERROR: probing the live worker to resolve $PENDING_FILE was inconclusive" >&2
        echo "(status: $PENDING_STATUS). Resolve by hand, then re-run — send a synthetic OTLP" >&2
        echo "post to $GATEWAY_URL/v1/logs with the bearer in $PENDING_FILE:" >&2
        echo "  - 204 (accepted): the deploy published -> mv '$PENDING_FILE' '$ENV_FILE'" >&2
        echo "  - anything else (200 no-op, 404, connection error): it did not publish ->" >&2
        echo "      rm '$PENDING_FILE'" >&2
        exit 1
    fi
fi

# Probe worker existence. `wrangler deployments list` exits 0 for a deployed
# worker, non-zero for an unknown name (verified both ways against wrangler 4.111).
if npx wrangler deployments list --config "$CONFIG" >/dev/null 2>&1; then
    WORKER_EXISTS=yes
else
    WORKER_EXISTS=no
fi

# Fresh-worker guard. `wrangler deploy --secrets-file` creates the worker if absent
# AND sets its secrets in the SAME atomic version — but a brand-new gateway with no
# OIDC_SIGNING_KEY can't sign the Azure assertion, so every request fails at
# signing. When the worker is absent, OIDC_KEY_FILE is mandatory. For an EXISTING
# worker it's optional — --secrets-file is additive (verified live), so an omitted
# key preserves the live one.
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

# Read the DEPLOYED kid recorded in env (empty on a fresh checkout / first deploy).
RECORDED_KID=""
if [ -f "$ENV_FILE" ]; then
    RECORDED_KID=$(grep '^OIDC_SIGNING_KID=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
fi

# Kid-change guard. The gateway stamps OIDC_SIGNING_KID into the JWT header; Entra
# fetches the matching public JWK by that kid and verifies the signature. Changing
# the kid is a KEY rotation: shipping a new kid without the matching new private
# key makes the gateway sign with the OLD key under the NEW kid, and Entra rejects
# every assertion. Refuse a kid change that omits OIDC_KEY_FILE.
if [ -n "$RECORDED_KID" ] && [ "$CONFIG_KID" != "$RECORDED_KID" ] && [ -z "${OIDC_KEY_FILE:-}" ]; then
    echo "ERROR: OIDC_SIGNING_KID changed ($RECORDED_KID -> $CONFIG_KID) but no OIDC_KEY_FILE" >&2
    echo "was given. A kid change is a key rotation: deploying the new kid without the" >&2
    echo "matching new private key makes the gateway sign with the OLD key under the NEW" >&2
    echo "kid, and Entra rejects every assertion. Re-run with the new key so both land in" >&2
    echo "the same version:" >&2
    echo "  OIDC_KEY_FILE=<new-key.pem> ./infra/cf/deploy-gateway.sh" >&2
    echo "(See telemetry.md 'Rotating the signing key' for the full sequence.)" >&2
    exit 1
fi

# Key/kid cross-check. The opposite trap: a NEW key with an UNCHANGED kid silently
# replaces the live signing key, so the old kid then advertises a public key that
# no longer matches the signature and Entra rejects everything. Compare the
# provided key's public modulus against the issuer's published JWK for the
# configured kid: a MISMATCH under an unchanged kid is the bug; a genuine re-upload
# of the current key (MATCH) or a brand-new kid the issuer already publishes
# (KID_ABSENT here means it isn't the current kid's key — allowed, that's a real
# rotation) both pass.
if [ -n "${OIDC_KEY_FILE:-}" ] && [ -n "$CONFIG_ISSUER_URL" ]; then
    JWKS_TMP=$(mktemp "${TMPDIR:-/tmp}/agent-backup-jwks.XXXXXX")
    if OIDC_ISS="$CONFIG_ISSUER_URL" node -e '
fetch(process.env.OIDC_ISS + "/.well-known/jwks.json").then(r => r.text()).then(t => { process.stdout.write(t); process.exit(0); }).catch(() => process.exit(1));
' > "$JWKS_TMP" 2>/dev/null; then
        KEY_MATCH=$(node -e '
const fs = require("fs"), crypto = require("crypto");
const providedN = crypto.createPublicKey(fs.readFileSync(process.argv[1])).export({ format: "jwk" }).n;
const jwks = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const jwk = (jwks.keys || []).find(k => k.kid === process.argv[3]);
if (!jwk) { console.log("KID_ABSENT"); process.exit(0); }
console.log(jwk.n === providedN ? "MATCH" : "MISMATCH");
' "$OIDC_KEY_FILE" "$JWKS_TMP" "$CONFIG_KID")
        if [ "$KEY_MATCH" = "MISMATCH" ]; then
            rm -f "$JWKS_TMP"
            echo "ERROR: OIDC_KEY_FILE's public key does not match the issuer's published JWK for" >&2
            echo "kid '$CONFIG_KID', and the kid is unchanged. Uploading this key would make the" >&2
            echo "gateway sign with a key the issuer never advertises for that kid, so Entra would" >&2
            echo "reject every assertion. A NEW key requires a NEW kid + an issuer JWKS update:" >&2
            echo "add the new public JWK (new kid) to gateway/oidc-issuer.ts, deploy the issuer," >&2
            echo "bump OIDC_SIGNING_KID here, then re-run. (telemetry.md 'Rotating the signing key'.)" >&2
            exit 1
        fi
    else
        echo "WARNING: could not fetch $CONFIG_ISSUER_URL/.well-known/jwks.json to cross-check" >&2
        echo "the provided key against the published kid; proceeding without that check." >&2
    fi
    rm -f "$JWKS_TMP"
fi

# Bearer determination.
#  - --rotate-bearer            -> always mint fresh (its point; see Flags).
#  - Deployed env with a bearer  -> reuse it (the safe, common re-run path).
#  - No env, worker EXISTS       -> the dashboard destinations already carry a
#    bearer this machine can't see; minting one would 200-no-op every post. Error.
#  - No env, worker ABSENT       -> generate fresh (nothing depends on a prior one).
if [ "$ROTATE_BEARER" = yes ]; then
    INGEST_BEARER=$(openssl rand -hex 32)
    BEARER_SOURCE="rotated (--rotate-bearer) — UPDATE the dashboard destinations after this"
elif [ -f "$ENV_FILE" ] && grep -q '^INGEST_BEARER=' "$ENV_FILE"; then
    INGEST_BEARER=$(grep '^INGEST_BEARER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    BEARER_SOURCE="reused from $ENV_FILE"
elif [ "$WORKER_EXISTS" = yes ]; then
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
    BEARER_SOURCE="generated fresh (new worker)"
fi
echo "INGEST_BEARER: $BEARER_SOURCE"

if [ "$WORKER_EXISTS" = yes ]; then
    echo "Gateway worker exists — deploying with additive secrets."
else
    echo "Gateway worker not found — first deploy will create it with its secrets."
fi

# Write the pending state BEFORE the deploy. cf-observability.env (the deployed
# state) is left untouched. If the deploy publishes but the script then dies, this
# file is the record the next run's recovery probes and promotes.
write_state_file "$PENDING_FILE"
echo "Wrote $PENDING_FILE (pending state; $ENV_FILE untouched until the deploy publishes)."

# Build the secrets bundle: INGEST_BEARER always, OIDC_SIGNING_KEY only when a key
# file is given. One temp file, 0600, removed on exit even if the deploy fails —
# it holds the RSA private key. python3 JSON-encodes the multi-line PEM safely; no
# secret value ever touches the command line.
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

# ONE atomic deploy: code + secrets land in a single worker version. A key rotation
# (new key + new OIDC_SIGNING_KID var + code, all here) is a single version flip —
# the live worker never signs with the new key while still advertising old code/kid.
DEPLOY_OUT=$(npx wrangler deploy --config "$CONFIG" --secrets-file "$SECRETS_JSON" 2>&1)
echo "$DEPLOY_OUT"
rm -f "$SECRETS_JSON"
trap - EXIT

# URL extraction MUST be non-fatal: under `set -euo pipefail` a grep miss (custom
# domain, or a wrangler output-format change) returns non-zero and would abort —
# `|| true` keeps the fallback alive.
GATEWAY_URL=$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://sessions-telemetry-gateway\.[a-z0-9-]+\.workers\.dev' | head -1 || true)
GATEWAY_URL="${GATEWAY_URL:-https://sessions-telemetry-gateway.pedro-18e.workers.dev}"

# Deploy published (set -e would have aborted on failure). Rewrite the pending file
# with the real URL, then promote it over the deployed-state file in one atomic mv.
write_state_file "$PENDING_FILE"
mv "$PENDING_FILE" "$ENV_FILE"

echo ""
echo "Deployed $GATEWAY_URL"
echo "Promoted $PENDING_FILE -> $ENV_FILE (now reflects the deployed state)."
if [ "$ROTATE_BEARER" = yes ]; then
    echo "ROTATED: update the account-level dashboard destinations (telemetry.md step 9)"
    echo "  with the new INGEST_BEARER now, or the gateway will 200-no-op every post."
fi
