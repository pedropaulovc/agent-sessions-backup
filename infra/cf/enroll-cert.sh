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
# machine_id is interpolated into SQL string literals AND into file paths (KEY/CSR/CRT under OUT_DIR),
# so constrain it to a safe charset up front: an odd value can't break/inject the SQL or escape OUT_DIR
# with `../`. Collector ids are host-<platform> — letters, digits, and . _ - only.
case "$MACHINE_ID" in
  ""|.|..|*[!A-Za-z0-9._-]*) echo "invalid machine_id '$MACHINE_ID' (allowed: letters, digits, and . _ -)" >&2; exit 2 ;;
esac
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
# hostname is machine-controlled and goes into a single-quoted SQL literal — SQL-escape any quote (double
# it) so it can't break or inject the statement (machine_id is already charset-validated above).
HOSTNAME_VAL="$(hostname)"
HOSTNAME_VAL="${HOSTNAME_VAL//\'/\'\'}"

# Best-effort revoke of the cert this run minted but NEVER installed (not in machines, not in
# retired_certs) — used by every abort/failure path so a leaked active managed cert can't burn the zone
# quota. curl -f only catches HTTP errors, so we parse the CF response's `success` flag (an HTTP-200
# {"success":false} must NOT be reported as revoked) and print the manual command unless it confirms.
# CF_API_TOKEN is already in scope. Never exits — the caller decides.
revoke_unused_cert() {
  echo "    The cert just minted for this run was NEVER installed — revoking it now so it can't linger CA-valid..." >&2
  local del_resp del_ok
  del_resp="$(curl -sS -X DELETE "$API/zones/$ZONE_ID/client_certificates/$CERT_ID" -H "Authorization: Bearer $CF_API_TOKEN" 2>/dev/null || true)"
  del_ok="$(printf '%s' "$del_resp" | python3 -c 'import json,sys
try:
    print("yes" if json.load(sys.stdin).get("success") else "no")
except Exception:
    print("no")' 2>/dev/null || echo no)"
  if [ "$del_ok" = "yes" ]; then
    echo "      revoked unused cert $CERT_ID" >&2
  else
    echo "      WARN: automatic revoke did not confirm success — run this manually so the cert doesn't linger CA-valid:" >&2
    echo "      curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
  fi
}

# Parse a wrangler `d1 execute --json` payload and print the machines row's fingerprint (empty if no
# row). Scans every statement's results for the `fp` field so it's robust to statement ordering.
# Prints ONLY the fp on stdout; returns non-zero if the JSON can't be parsed.
parse_fp() {  # $1 = wrangler --json output
  python3 - "$1" <<'PY'
import json,sys
try:
    d=json.loads(sys.argv[1])
except Exception as e:
    sys.stderr.write("could not parse wrangler --json output: %s\n" % e); sys.exit(1)
fp=""
for stmt in (d if isinstance(d, list) else []):
    for r in (stmt.get("results") or []):
        if r.get("fp"):
            fp=str(r["fp"])
print(fp)
PY
}

# Fresh, SELECT-only read of the machines row's fingerprint — used to VERIFY reality after an ambiguous
# write. Prints the fp on stdout (empty if no row); returns non-zero if the read OR the parse fails, so
# the caller can distinguish "provably not ours" from "couldn't tell".
read_row_fp() {
  local json
  json="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --json \
      --command "SELECT cert_fp_sha256 AS fp FROM machines WHERE machine_id='$MACHINE_ID';" 2>/dev/null)" || return 1
  parse_fp "$json"
}

# The post-enrollment install guidance. Printed ONLY once the machines row is CONFIRMED to carry THIS
# run's fingerprint — in the authenticated path after the read-back verifies, and in the no-wrangler path
# gated behind an explicit "verify the returned fp first" instruction. Never printed on an unverified
# insert, so an operator can't install a cert that will 401 while the minted one leaks.
print_install_steps() {
  echo
  echo "Done. Test the mTLS path with:"
  echo "  curl --cert $CRT --key $KEY https://api.sessions.vza.net/api/v1/machines"
  echo
  echo "Then point the collector at the mTLS API (writes auth=mtls + these paths):"
  echo "  agent-collector enroll --hub https://api.sessions.vza.net \\"
  echo "    --machine-id \"$MACHINE_ID\" --client-cert $CRT --client-key $KEY"
  echo
  echo "Key stays on this box only ($KEY); the signed cert is not secret."
}

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
  # the row back to see whose fingerprint it carries. A non-zero exit here means the write did NOT commit
  # (D1 auth, a lock/outage, or a rejected statement) — the cert is minted but unregistered, so revoke it
  # before aborting rather than leaking it under set -e.
  if ! CUR_JSON="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" npx --yes wrangler d1 execute "$DB_NAME" --remote --json \
      --command "$INSERT_SQL SELECT cert_fp_sha256 AS fp FROM machines WHERE machine_id='$MACHINE_ID';")"; then
    # The combined INSERT;SELECT exited non-zero, but --command runs multiple ';' statements WITHOUT a
    # transaction: the INSERT may have COMMITTED before the SELECT/output failed. Revoking blindly could
    # kill a cert the row now points at — a fresh-enrollment lockout. So VERIFY with a separate fresh read
    # and revoke ONLY if the row provably does NOT carry our fp. If the verify itself fails we can't tell,
    # so do NOT revoke — uncertainty must fail toward a leak (recoverable), never a lockout (round-9 rule).
    echo "    D1 registration command failed (auth, lock/outage, or a rejected/partial statement)." >&2
    echo "    The INSERT may or may not have committed — verifying the row before deciding on revoke..." >&2
    if VERIFY_FP="$(read_row_fp)"; then
      if [ "$VERIFY_FP" = "$FP" ]; then
        echo "    Verified: the row DID register with THIS cert — enrollment actually succeeded. NOT revoking." >&2
        echo "    enrolled: $MACHINE_ID -> $FP"
        exit 0
      fi
      echo "    Verified: the machines row does NOT carry this cert (found: ${VERIFY_FP:-<no row>}) — it was never installed." >&2
      revoke_unused_cert
      exit 1
    fi
    echo "    Could NOT verify the row (the follow-up read also failed) — NOT revoking; a possibly-registered cert must not be revoked." >&2
    echo "    Resolve manually:" >&2
    echo "      1) Check the row: CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote --command \"SELECT cert_fp_sha256 FROM machines WHERE machine_id='$MACHINE_ID';\"" >&2
    echo "      2) If it shows $FP, enrollment succeeded — do nothing." >&2
    echo "      3) If it shows a different fp or no row, this cert is unused — revoke it:" >&2
    echo "         curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
    exit 1
  fi
  # A parse failure here means wrangler returned 0 but unexpected output — the insert likely DID apply, so
  # abort loudly WITHOUT revoking (revoking a possibly-registered cert would lock the machine out).
  CUR_FP="$(parse_fp "$CUR_JSON")" || { echo "    could not parse the machines row after insert" >&2; exit 1; }
  if [ "$CUR_FP" != "$FP" ]; then
    echo >&2
    echo "    ABORT: machine '$MACHINE_ID' is already enrolled with a DIFFERENT fingerprint:" >&2
    echo "      existing cert_fp_sha256 = ${CUR_FP:-<none>}" >&2
    echo "      this run's fingerprint  = $FP" >&2
    echo >&2
    echo "    This script only does FRESH enrollment. To ROTATE an existing machine's cert, use the hub's" >&2
    echo "    admin endpoint — it swaps the fingerprint and retires the old cert atomically:" >&2
    echo "      POST https://api.sessions.vza.net/api/v1/admin/machines  (with an admin client cert)" >&2
    echo "        { \"machine_id\": \"$MACHINE_ID\", \"cert_fp_sha256\": \"<fingerprint-of-a-FRESHLY-minted-cert>\", \"cert_id\": \"<id-of-that-fresh-cert>\" }" >&2
    echo >&2
    echo "    Do NOT install THIS run's cert — it is being revoked below. Mint a NEW cert first: re-run this" >&2
    echo "    script AFTER the admin swap, or let the collector renew (POST /api/v1/certs/renew)." >&2
    echo >&2
    revoke_unused_cert
    exit 1
  fi
  echo "    enrolled: $MACHINE_ID -> $FP"
  print_install_steps
else
  # No wrangler here (fresh collector box). We CANNOT verify the insert from this box, and a bare
  # INSERT ... DO NOTHING is a silent no-op if the machine_id is already enrolled under a different cert
  # — the operator would then install a cert that 401s while this run's minted cert leaks. So print the
  # SAME insert+read-back compound the authenticated path uses, make the operator CHECK the returned fp,
  # and gate the install steps behind that check rather than printing them unconditionally.
  echo "    wrangler is not authenticated here, and the zone-SSL CF_API_TOKEN can't reach D1." >&2
  echo "    Register + verify from an admin box where 'npx wrangler whoami' works. Run this compound" >&2
  echo "    (INSERT then read-back) and CHECK the returned fp BEFORE continuing:" >&2
  echo >&2
  echo "  CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote \\" >&2
  echo "    --command \"$INSERT_SQL SELECT cert_fp_sha256 AS fp FROM machines WHERE machine_id='$MACHINE_ID';\"" >&2
  echo >&2
  echo "    The INSERT is ON CONFLICT DO NOTHING (it never overwrites an existing cert), so the read-back fp" >&2
  echo "    is the source of truth:" >&2
  echo "      - if the returned fp EQUALS  $FP  -> enrollment took; continue to the install steps below." >&2
  echo "      - if it DIFFERS or is empty       -> '$MACHINE_ID' is already enrolled with another cert. THIS" >&2
  echo "        run's cert was NOT installed and must NOT be. Revoke it, then rotate via the admin endpoint:" >&2
  echo "          curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
  echo "          POST /api/v1/admin/machines { machine_id, cert_fp_sha256, cert_id } with a FRESHLY minted cert." >&2
  echo >&2
  echo "    ONLY after the read-back shows $FP, install the collector:" >&2
  print_install_steps
fi
