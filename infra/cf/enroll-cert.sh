#!/usr/bin/env bash
#
# enroll-cert.sh — mint a Cloudflare managed-CA client certificate for one machine
# and register its fingerprint in the hub's `machines` table (mTLS bootstrap).
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

MACHINE_ID="${1:?usage: enroll-cert.sh <machine_id> [--admin] [--out DIR]}"; shift || true
IS_ADMIN=0
OUT_DIR="."
while [ $# -gt 0 ]; do
  case "$1" in
    --admin) IS_ADMIN=1; shift ;;
    --out)   OUT_DIR="${2:?}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
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

python3 - "$resp" "$CRT" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
if not d.get("success"):
    print("Cloudflare API error:", d.get("errors"), file=sys.stderr); sys.exit(1)
open(sys.argv[2],"w").write(d["result"]["certificate"])
print("    cert id:", d["result"]["id"], "expires:", d["result"]["expires_on"])
PY

# cf.tlsClientAuth.certFingerprintSHA256 == lowercase hex SHA-256 of the DER cert, no colons.
FP="$(openssl x509 -in "$CRT" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
echo "==> cert fingerprint (SHA-256): $FP"

echo "==> registering machine '$MACHINE_ID' (is_admin=$IS_ADMIN) in $DB_NAME"
HOSTNAME_VAL="$(hostname)"
SQL="INSERT INTO machines (machine_id, os, hostname, cert_fp_sha256, key_protection, is_admin)
     VALUES ('$MACHINE_ID', 'linux', '$HOSTNAME_VAL', '$FP', 'software', $IS_ADMIN)
     ON CONFLICT (machine_id) DO UPDATE SET cert_fp_sha256=excluded.cert_fp_sha256,
       key_protection=excluded.key_protection, is_admin=excluded.is_admin;"
CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --command "$SQL"

echo
echo "Done. Test the mTLS path with:"
echo "  curl --cert $CRT --key $KEY https://api.sessions.vza.net/api/v1/machines"
echo "Key stays on this box only ($KEY); the signed cert is not secret."
