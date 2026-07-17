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
# cf-observability.env.pending FIRST (along with the live worker's current
# deployment id at that moment), then the deploy runs, then .pending is promoted
# over cf-observability.env. The only window .pending guards is "deploy published
# but the script died before promoting": on the next run, if .pending exists, we
# compare the live worker's CURRENT deployment id against the one recorded in
# .pending — every `wrangler deploy` mints a new deployment id, so a changed id
# means the crashed deploy DID publish (promote it) and an unchanged id means it
# did NOT (discard it). This is deterministic even during a signing-key rotation,
# where the bearer is reused and so can't tell the two apart. It replaces the
# older bearer-first write + .prev backup + their guards.
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

# The live deployment id captured just before the deploy; recorded in .pending so
# recovery can tell whether a crashed deploy published. Set for real below.
PRE_DEPLOY_VERSION=""

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
# The live worker's deployment id at the moment this pending file was written, i.e.
# BEFORE the deploy. Recovery compares it to the current live id to decide whether
# the crashed deploy published. Stripped from cf-observability.env on promotion.
PENDING_PRE_DEPLOY_VERSION=$PRE_DEPLOY_VERSION
EOF
    )
    mv "$tmp" "$target"
}

# Prints the live worker's current (latest) deployment id, or empty if the worker
# doesn't exist / wrangler can't reach it. Every `wrangler deploy` mints a fresh
# id (verified: a no-op redeploy changes it), so this is the recovery signal.
get_live_version() {
    npx wrangler deployments list --config "$CONFIG" --json 2>/dev/null | node -e '
let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
  try { const a = JSON.parse(s); process.stdout.write(a.length ? String(a[a.length - 1].id) : ""); }
  catch (e) { process.stdout.write(""); }
});
' 2>/dev/null || true
}

# Promotes the pending file to cf-observability.env: strips the recovery-only
# PENDING_PRE_DEPLOY_VERSION line (env records only deployed state) and removes
# .pending. The write is atomic (temp-then-mv at 0600).
promote_pending() {
    local tmp
    tmp=$(mktemp "${TMPDIR:-/tmp}/agent-backup-cfobs.XXXXXX")
    chmod 600 "$tmp"
    grep -v '^PENDING_PRE_DEPLOY_VERSION=' "$PENDING_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
    rm -f "$PENDING_FILE"
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
# blind over that ambiguity. Decide by DEPLOYMENT ID, not by the bearer: the
# bearer is reused across a signing-key rotation, so a bearer probe can't tell a
# published-new-kid deploy from an unpublished one — the deployment id can, since
# every `wrangler deploy` mints a fresh one. ---
if [ -f "$PENDING_FILE" ]; then
    echo "Found $PENDING_FILE — a previous run died around its deploy; resolving first."
    if ! grep -q '^PENDING_PRE_DEPLOY_VERSION=' "$PENDING_FILE"; then
        echo "ERROR: $PENDING_FILE has no PENDING_PRE_DEPLOY_VERSION line (written by an older" >&2
        echo "version of this script). Resolve by hand: if 'wrangler deployments list' shows a" >&2
        echo "deployment newer than when you last ran a deploy, the pending state published ->" >&2
        echo "strip its PENDING_PRE_DEPLOY_VERSION line onto $ENV_FILE; otherwise rm it." >&2
        exit 1
    fi
    RECORDED_VERSION=$(grep '^PENDING_PRE_DEPLOY_VERSION=' "$PENDING_FILE" | head -1 | cut -d= -f2- || true)
    CURRENT_VERSION=$(get_live_version)
    if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" != "$RECORDED_VERSION" ]; then
        promote_pending
        echo "  Live deployment id advanced ('$RECORDED_VERSION' -> '$CURRENT_VERSION'): that"
        echo "  deploy DID publish. Promoted pending state to $ENV_FILE. Continuing."
    elif [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$RECORDED_VERSION" ]; then
        rm -f "$PENDING_FILE"
        echo "  Live deployment id unchanged ('$CURRENT_VERSION'): that deploy did NOT publish;"
        echo "  the previous $ENV_FILE is still the live state. Discarded stale $PENDING_FILE."
    elif [ -z "$CURRENT_VERSION" ] && [ -z "$RECORDED_VERSION" ]; then
        rm -f "$PENDING_FILE"
        echo "  Worker still has no deployment (absent before and after): that first deploy did"
        echo "  NOT publish. Discarded stale $PENDING_FILE."
    else
        echo "ERROR: can't resolve $PENDING_FILE — it recorded pre-deploy deployment id" >&2
        echo "'$RECORDED_VERSION' but the live worker returns none now (deleted, or wrangler" >&2
        echo "couldn't reach it). Resolve by hand: check 'wrangler deployments list' — if a" >&2
        echo "deployment newer than the recorded id exists, the pending state published (strip" >&2
        echo "its PENDING_PRE_DEPLOY_VERSION line onto $ENV_FILE); otherwise rm it. Then re-run." >&2
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

# Key/kid cross-check. Rotations are ISSUER-FIRST (telemetry.md): by the time the
# gateway ships a kid, the issuer's published jwks.json MUST already advertise that
# exact key for it. So the ONLY acceptable state when a key is supplied is: the
# issuer publishes a JWK for the configured kid AND its modulus matches this key
# (MATCH). Everything else is a hard error before deploy —
#   - MISMATCH: a different key published under this kid → a new key needs a NEW
#     kid + issuer update, not a silent replacement.
#   - KID_ABSENT: the issuer doesn't publish this kid yet → the issuer wasn't
#     deployed first; the gateway would advertise a kid Entra can't resolve.
#   - fetch failure / missing issuer URL: we can't prove the issuer is ready, and
#     a gateway that ships a kid the issuer doesn't serve breaks every exchange.
# (The gateway always needs the issuer up, so there is no reachable case where the
# issuer is legitimately unfetchable at deploy time.)
if [ -n "${OIDC_KEY_FILE:-}" ]; then
    if [ -z "$CONFIG_ISSUER_URL" ]; then
        echo "ERROR: OIDC_KEY_FILE was given but OIDC_ISSUER_URL is missing from $CONFIG, so the" >&2
        echo "key can't be cross-checked against the issuer's published JWKS. Refusing to deploy." >&2
        exit 1
    fi
    JWKS_TMP=$(mktemp "${TMPDIR:-/tmp}/agent-backup-jwks.XXXXXX")
    if ! OIDC_ISS="$CONFIG_ISSUER_URL" node -e '
fetch(process.env.OIDC_ISS + "/.well-known/jwks.json").then(r => r.text()).then(t => { process.stdout.write(t); process.exit(0); }).catch(() => process.exit(1));
' > "$JWKS_TMP" 2>/dev/null; then
        rm -f "$JWKS_TMP"
        echo "ERROR: could not fetch $CONFIG_ISSUER_URL/.well-known/jwks.json to verify the" >&2
        echo "provided key. Rotations are issuer-first: the issuer must be deployed and already" >&2
        echo "publishing kid '$CONFIG_KID' BEFORE the gateway ships it. Deploy the issuer first," >&2
        echo "confirm its jwks.json advertises the kid, then re-run. (telemetry.md 'Rotating the" >&2
        echo "signing key'.)" >&2
        exit 1
    fi
    KEY_MATCH=$(node -e '
const fs = require("fs"), crypto = require("crypto");
const providedN = crypto.createPublicKey(fs.readFileSync(process.argv[1])).export({ format: "jwk" }).n;
const jwks = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const jwk = (jwks.keys || []).find(k => k.kid === process.argv[3]);
if (!jwk) { console.log("KID_ABSENT"); process.exit(0); }
console.log(jwk.n === providedN ? "MATCH" : "MISMATCH");
' "$OIDC_KEY_FILE" "$JWKS_TMP" "$CONFIG_KID")
    rm -f "$JWKS_TMP"
    if [ "$KEY_MATCH" = "KID_ABSENT" ]; then
        echo "ERROR: the issuer at $CONFIG_ISSUER_URL does not publish a JWK for kid" >&2
        echo "'$CONFIG_KID' yet. Rotations are ISSUER-FIRST: add the new public JWK (this kid) to" >&2
        echo "gateway/oidc-issuer.ts and deploy the issuer BEFORE deploying the gateway with this" >&2
        echo "kid, or the gateway advertises a kid Entra can't resolve and rejects every" >&2
        echo "assertion. (telemetry.md 'Rotating the signing key'.)" >&2
        exit 1
    fi
    if [ "$KEY_MATCH" = "MISMATCH" ]; then
        echo "ERROR: the issuer publishes a JWK for kid '$CONFIG_KID' but its modulus differs" >&2
        echo "from OIDC_KEY_FILE. Uploading this key would make the gateway sign with a key the" >&2
        echo "issuer never advertises for that kid, so Entra rejects every assertion. A NEW key" >&2
        echo "requires a NEW kid + an issuer JWKS update, not a silent replacement: add the new" >&2
        echo "public JWK (new kid) to gateway/oidc-issuer.ts, deploy the issuer, bump" >&2
        echo "OIDC_SIGNING_KID here, then re-run. (telemetry.md 'Rotating the signing key'.)" >&2
        exit 1
    fi
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

# Record the live deployment id NOW (before deploy) so recovery can tell whether a
# later crash's deploy published. Empty if the worker doesn't exist yet.
PRE_DEPLOY_VERSION=$(get_live_version)

# Write the pending state BEFORE the deploy. cf-observability.env (the deployed
# state) is left untouched. If the deploy publishes but the script then dies, this
# file is the record the next run's recovery resolves by deployment id.
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
# with the real URL, then promote it (strips the recovery-only version line).
write_state_file "$PENDING_FILE"
promote_pending

echo ""
echo "Deployed $GATEWAY_URL"
echo "Promoted $PENDING_FILE -> $ENV_FILE (now reflects the deployed state)."
if [ "$ROTATE_BEARER" = yes ]; then
    echo "ROTATED: update the account-level dashboard destinations (telemetry.md step 9)"
    echo "  with the new INGEST_BEARER now, or the gateway will 200-no-op every post."
fi
