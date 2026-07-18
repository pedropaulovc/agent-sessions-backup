#!/usr/bin/env bash
#
# enroll-cert.sh — mint a Cloudflare managed-CA client certificate for one machine
# and register its fingerprint in the hub's `machines` table (mTLS bootstrap).
#
# FRESH ENROLLMENT ONLY. This inserts a brand-new machines row; it never overwrites
# an existing row's cert. Rotating an already-registered machine's cert is a
# displacement that must retire the old cert atomically with the swap — do that via
# the hub admin endpoint (POST /api/v1/admin/machines), not this script. If the
# machine_id already exists, the script aborts and points you there.
#
# This is the just-in-time enrollment step from the plan: the operator pastes a
# short-lived, zone-scoped Cloudflare API token (the wrangler OAuth login CANNOT
# reach the /client_certificates API — verified in M3, it returns auth error
# 10000), the script generates a software key + CSR, has Cloudflare's managed CA
# sign it, computes the SHA-256 fingerprint exactly as `cf.tlsClientAuth.
# certFingerprintSHA256` reports it, and inserts the machines row via wrangler.
#
# PREREQUISITE (one-time, per zone): the API Shield mTLS hostname association for
# api.sessions.vza.net must already be enabled, and the WAF cert-verified rule
# added — see mtls.md. Without the hostname association the edge never requests a
# client cert and `cf.tlsClientAuth` is absent, so every upload 401s.
#
# Usage:
#   CF_API_TOKEN=<zone Client Certificates:Edit token> \
#     ./enroll-cert.sh <machine_id> [--admin] [--out DIR]
#
# Example:
#   CF_API_TOKEN=xxxx ./enroll-cert.sh amet-linux --admin --out ~/.config/agent-collector
#
set -euo pipefail

ZONE_ID="6a56cdda4766c1d7b5ad0fbe8331048f"   # vza.net
ACCOUNT_ID="18ef3246e9f36d1560485ef53889c0ab" # Pedro@vezza.com.br's Account
DB_NAME="sessions-index"
API="https://api.cloudflare.com/client/v4"

# machine_id: optional leading positional. If omitted, derive it from the collector itself
# (`agent-collector machine-id`) so the cert is signed for the EXACT id the collector stamps
# on upload URLs — on WSL that's <host>-wsl, not <host>-linux, and a mismatch 401s as
# machine_mismatch. Pass it explicitly only when enrolling a box where the collector isn't
# installed yet.
MACHINE_ID=""
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then MACHINE_ID="$1"; shift; fi
IS_ADMIN=0
OUT_DIR="."
while [ $# -gt 0 ]; do
  case "$1" in
    --admin) IS_ADMIN=1; shift ;;
    --out)   OUT_DIR="${2:?}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$MACHINE_ID" ]; then
  MACHINE_ID="$(agent-collector machine-id 2>/dev/null)" || true
  [ -n "$MACHINE_ID" ] || { echo "no machine_id: pass it as the first arg, or install agent-collector so 'agent-collector machine-id' works" >&2; exit 2; }
fi
# os facet mirrors the platform suffix the collector encodes into machine_id (host-<platform>).
OS_TAG="${MACHINE_ID##*-}"
: "${CF_API_TOKEN:?set CF_API_TOKEN to a zone-scoped token with Client Certificates:Edit}"

mkdir -p "$OUT_DIR"
KEY="$OUT_DIR/${MACHINE_ID}.client.key"
CSR="$OUT_DIR/${MACHINE_ID}.client.csr"
CRT="$OUT_DIR/${MACHINE_ID}.client.pem"

echo "==> generating software EC P-256 key + CSR (WSL2/no-TPM fallback)"
umask 077
[ -f "$KEY" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$KEY"
openssl req -new -key "$KEY" -subj "/CN=${MACHINE_ID}/O=agent-sessions-backup" -out "$CSR"

echo "==> requesting a signed cert from the Cloudflare managed CA"
body="$(python3 - "$CSR" <<'PY'
import json,sys
print(json.dumps({"csr": open(sys.argv[1]).read(), "validity_days": 365}))
PY
)"
resp="$(curl -sS -X POST "$API/zones/$ZONE_ID/client_certificates" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data "$body")"

# Capture the CA client-certificate id (CERT_ID). The hub stores it in machines.cert_id and uses it
# as the handle to REVOKE the cert on rotation/prune — so it MUST be recorded here, or every cert
# this script enrolls looks like a legacy unknown-id row and leaks its first rotated cert.
CERT_ID="$(python3 - "$resp" "$CRT" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
if not d.get("success"):
    print("Cloudflare API error:", d.get("errors"), file=sys.stderr); sys.exit(1)
open(sys.argv[2],"w").write(d["result"]["certificate"])
sys.stderr.write("    cert id: %s expires: %s\n" % (d["result"]["id"], d["result"]["expires_on"]))
print(d["result"]["id"])
PY
)"
[ -n "$CERT_ID" ] || { echo "no cert id in Cloudflare response" >&2; exit 1; }

# cf.tlsClientAuth.certFingerprintSHA256 == lowercase hex SHA-256 of the DER cert, no colons.
FP="$(openssl x509 -in "$CRT" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
echo "==> cert fingerprint (SHA-256): $FP"

echo "==> registering machine '$MACHINE_ID' (is_admin=$IS_ADMIN) in $DB_NAME"
HOSTNAME_VAL="$(hostname)"

# FRESH ENROLLMENT ONLY. This inserts a brand-new machines row and deliberately does NOT overwrite an
# existing row's cert. Re-enrolling (rotating an already-registered machine's cert) is a DISPLACEMENT — the
# old cert must be reserved in retired_certs and revoked while the new one goes current — and that has to be
# atomic (a guarded compare-and-swap + co-committed retirement in one D1 batch). wrangler's
# `d1 execute --command` gives us neither a transaction nor a CAS, so every shell-side attempt at
# displacement raced concurrent renewals and could strand or revoke a live cert (three review rounds each
# grew a new hole). So we don't do it here at all: rotation goes through the hub's admin endpoint
# (POST /api/v1/admin/machines — hub/src/api/ops.ts adminMachines), which does the guarded swap + retirement
# atomically in db.batch. M4's steady-state path is hub-mediated self-registration (POST /api/v1/certs/renew).
#
# Write is INSERT ... ON CONFLICT (machine_id) DO NOTHING, then a read-back: if the row now carries OUR
# fingerprint the enrollment took (a fresh insert, or an idempotent same-fp re-run); if the id already
# exists under a DIFFERENT fingerprint we abort and point at the admin re-enroll flow. The just-minted cert
# was never installed, so we print its id and the one-liner to revoke it (safe direction — nothing refs it).
INSERT_SQL="INSERT INTO machines (machine_id, os, hostname, cert_fp_sha256, cert_id, key_protection, is_admin)
       VALUES ('$MACHINE_ID', '$OS_TAG', '$HOSTNAME_VAL', '$FP', '$CERT_ID', 'software', $IS_ADMIN)
       ON CONFLICT (machine_id) DO NOTHING;"

# The D1 write needs a wrangler login with D1 access — NOT the just-in-time CF_API_TOKEN, which is zone-SSL
# only (and wrangler reads CLOUDFLARE_API_TOKEN, not CF_API_TOKEN, anyway). On an authenticated admin box we
# insert-then-verify; on a fresh collector box we print the insert to run from such a box.
if npx --yes wrangler whoami >/dev/null 2>&1; then
  # Insert (a no-op if the id already exists — DO NOTHING never touches an existing row's cert), then read
  # the row back to see whose fingerprint it carries.
  CUR_JSON="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --json \
    --command "$INSERT_SQL SELECT cert_fp_sha256 AS fp FROM machines WHERE machine_id='$MACHINE_ID';")"
  CUR_FP="$(python3 - "$CUR_JSON" <<'PY'
import json,sys
try:
    d=json.loads(sys.argv[1])
except Exception as e:
    sys.stderr.write("could not parse wrangler --json output: %s\n" % e); sys.exit(1)
fp=""
# The SELECT is the last statement; scan every statement's results for the fp field to be robust to ordering.
for stmt in (d if isinstance(d, list) else []):
    for r in (stmt.get("results") or []):
        if r.get("fp"):
            fp=str(r["fp"])
print(fp)
PY
)" || { echo "    could not verify the machines row after insert" >&2; exit 1; }
  if [ "$CUR_FP" != "$FP" ]; then
    echo >&2
    echo "    ABORT: machine '$MACHINE_ID' is already enrolled with a DIFFERENT fingerprint:" >&2
    echo "      existing cert_fp_sha256 = ${CUR_FP:-<none>}" >&2
    echo "      this run's fingerprint  = $FP" >&2
    echo >&2
    echo "    This script only does FRESH enrollment. To ROTATE an existing machine's cert, use the hub's" >&2
    echo "    admin endpoint — it swaps the fingerprint and retires the old cert atomically:" >&2
    echo "      POST https://api.sessions.vza.net/api/v1/admin/machines  (with an admin client cert)" >&2
    echo "        { \"machine_id\": \"$MACHINE_ID\", \"cert_fp_sha256\": \"$FP\", \"cert_id\": \"$CERT_ID\" }" >&2
    echo >&2
    echo "    The cert just minted for this run was NEVER installed — revoke it so it can't linger CA-valid:" >&2
    echo "      curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
    exit 1
  fi
  echo "    enrolled: $MACHINE_ID -> $FP"
else
  echo "    wrangler is not authenticated here, and the zone-SSL CF_API_TOKEN can't reach D1." >&2
  echo "    Register the cert from an admin box where 'npx wrangler whoami' works, by running:" >&2
  echo >&2
  echo "  CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote --command \"$INSERT_SQL\"" >&2
  echo >&2
  echo "    This is a FRESH-enroll insert — a no-op if the id already exists (it never overwrites a cert). If" >&2
  echo "    '$MACHINE_ID' is already enrolled, ROTATE via the hub admin endpoint instead: POST" >&2
  echo "    /api/v1/admin/machines { machine_id, cert_fp_sha256, cert_id }, which retires the old cert atomically." >&2
fi

echo
echo "Done. Test the mTLS path with:"
echo "  curl --cert $CRT --key $KEY https://api.sessions.vza.net/api/v1/machines"
echo
echo "Then point the collector at the mTLS API (writes auth=mtls + these paths):"
echo "  agent-collector enroll --hub https://api.sessions.vza.net \\"
echo "    --machine-id \"$MACHINE_ID\" --client-cert $CRT --client-key $KEY"
echo
echo "Key stays on this box only ($KEY); the signed cert is not secret."
