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

# The upsert installs the new fp + cert_id and clears the rotation columns. On a re-enroll it displaces
# the machine's old current (and any in-grace prev) cert, which may still be CA-valid — those must be
# reserved in retired_certs so the prune revokes them: the SAME displacement invariant that
# hub/src/api/certs.ts's retireCert enforces for the admin/renew paths (never carry an old cert_id onto a
# new fp, never drop a displaced fp untracked).
#
# wrangler's `d1 execute --command` runs `;`-separated statements with NO transaction (rollback is a
# D1Database::batch guarantee only), so we must NOT retire-then-upsert: if the upsert then failed (e.g. a
# unique cert_fp_sha256 collision) after the retirement had already queued the STILL-current cert, the next
# prune would revoke it and lock an unchanged machine out. Instead: read the old row FIRST, upsert, then
# retire the CAPTURED old fps guarded on the swap having actually landed ((SELECT current fp) = new fp).
# The round-9 lockout is then unrepresentable — the retire only fires once the new fp is current. A failure
# mid-write points the residual the SAFE way: a displaced cert momentarily untracked (repaired by re-run,
# with the NOT EXISTS dedup keeping the repair idempotent), never a live cert revoked.
UPSERT_SQL="INSERT INTO machines (machine_id, os, hostname, cert_fp_sha256, cert_id, key_protection, is_admin)
       VALUES ('$MACHINE_ID', '$OS_TAG', '$HOSTNAME_VAL', '$FP', '$CERT_ID', 'software', $IS_ADMIN)
       ON CONFLICT (machine_id) DO UPDATE SET cert_fp_sha256=excluded.cert_fp_sha256,
         cert_id=excluded.cert_id, key_protection=excluded.key_protection, is_admin=excluded.is_admin,
         prev_cert_fp_sha256=NULL, prev_cert_id=NULL, cert_revoke_at=NULL;"

# The D1 write needs a wrangler login with D1 access — NOT the just-in-time CF_API_TOKEN, which is zone-SSL
# only (and wrangler reads CLOUDFLARE_API_TOKEN, not CF_API_TOKEN, anyway). On an authenticated admin box we
# run the read -> upsert -> guarded-retire; on a fresh collector box (first enroll has no old cert, so the
# retire is a no-op) we print the upsert to run from such a box. M4 replaces this with hub-mediated
# self-registration (POST /api/v1/certs/renew).
if npx --yes wrangler whoami >/dev/null 2>&1; then
  # Phase 1 — read the OLD row BEFORE any write, capturing its fps/ids as shell literals.
  OLD_JSON="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --json \
    --command "SELECT cert_fp_sha256, cert_id, prev_cert_fp_sha256, prev_cert_id FROM machines WHERE machine_id='$MACHINE_ID';")"
  # Capture into a var FIRST so a parse failure aborts loudly (eval "$(...)" would swallow python's exit).
  OLD_VARS="$(python3 - "$OLD_JSON" <<'PY'
import json,sys
try:
    d=json.loads(sys.argv[1])
except Exception as e:
    sys.stderr.write("could not parse wrangler --json output: %s\n" % e); sys.exit(1)
row={}
try:
    rows=d[0]["results"]
    if rows: row=rows[0]
except Exception:
    pass
def emit(name,val):
    s="" if val is None else str(val)
    print("%s='%s'" % (name, s.replace("'", "'\\''")))
emit("OLD_FP", row.get("cert_fp_sha256"))
emit("OLD_CERT_ID", row.get("cert_id"))
emit("OLD_PREV_FP", row.get("prev_cert_fp_sha256"))
emit("OLD_PREV_CERT_ID", row.get("prev_cert_id"))
PY
)" || { echo "    could not read the existing machines row; aborting before any write" >&2; exit 1; }
  eval "$OLD_VARS"
  # Emit a SQL literal: NULL for an empty/legacy id, otherwise the quoted value.
  sql_lit() { if [ -z "${1:-}" ]; then printf 'NULL'; else printf "'%s'" "$1"; fi; }
  # Phase 2 — upsert, then retire each displaced old fp guarded on the swap having landed
  # ((SELECT current fp) = new fp) and de-duplicated so a repair re-run adds no second reserved row.
  WRITE_SQL="$UPSERT_SQL
     INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at)
       SELECT '$OLD_FP', $(sql_lit "$OLD_CERT_ID"), '$MACHINE_ID', strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE '$OLD_FP' != '' AND '$OLD_FP' != '$FP'
         AND (SELECT cert_fp_sha256 FROM machines WHERE machine_id='$MACHINE_ID') = '$FP'
         AND NOT EXISTS (SELECT 1 FROM retired_certs WHERE fingerprint='$OLD_FP' AND machine_id='$MACHINE_ID' AND revoked_at IS NULL);
     INSERT INTO retired_certs (fingerprint, cert_id, machine_id, retired_at)
       SELECT '$OLD_PREV_FP', $(sql_lit "$OLD_PREV_CERT_ID"), '$MACHINE_ID', strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE '$OLD_PREV_FP' != '' AND '$OLD_PREV_FP' != '$FP'
         AND (SELECT cert_fp_sha256 FROM machines WHERE machine_id='$MACHINE_ID') = '$FP'
         AND NOT EXISTS (SELECT 1 FROM retired_certs WHERE fingerprint='$OLD_PREV_FP' AND machine_id='$MACHINE_ID' AND revoked_at IS NULL);"
  CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --command "$WRITE_SQL"
else
  echo "    wrangler is not authenticated here, and the zone-SSL CF_API_TOKEN can't reach D1." >&2
  echo "    Register the cert from an admin box where 'npx wrangler whoami' works, by running:" >&2
  echo >&2
  echo "  CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote --command \"$UPSERT_SQL\"" >&2
  echo >&2
  echo "    NOTE: this upsert alone does NOT retire a displaced cert. On a RE-ENROLL (rotating an existing" >&2
  echo "    machine's cert), run this whole script from the authenticated admin box instead, so the old cert" >&2
  echo "    is reserved in retired_certs for revocation rather than left to expire untracked." >&2
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
