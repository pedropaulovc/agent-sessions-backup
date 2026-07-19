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

# Wrangler 4.112 consumes CF_API_TOKEN as a deprecated alias for CLOUDFLARE_API_TOKEN. This script's
# CF_API_TOKEN is deliberately a narrow zone SSL token used only by curl to sign the CSR; if Wrangler
# inherits it, `whoami` appears authenticated but D1 rejects registration with code 7403 instead of
# using the operator's OAuth login. Strip both token spellings only for Wrangler subprocesses so they
# fall back to Wrangler's authenticated OAuth session. The signing curl below still inherits
# CF_API_TOKEN unchanged.
wrangler_oauth() {
  env -u CF_API_TOKEN -u CLOUDFLARE_API_TOKEN npx --yes wrangler "$@"
}

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
# The signed cert is written to this TEMP path and moved into $CRT only once enrollment is VERIFIED. A
# re-run on an already-enrolled machine aborts + revokes below, and must not clobber the working PEM the
# collector is still presenting. ($KEY is reused when it already exists, so the working key/cert pair
# survives an aborted re-enroll intact.)
CRT_TMP="$CRT.new"
# Sidecar written next to the temp PEM once a cert is minted (below): records the minted cert's id + fp so
# that ANY path leaving $CRT_TMP behind (the ambiguous-D1 and no-wrangler paths) also leaves a revoke
# handle. Without it, an operator who deletes an abandoned temp PEM loses the only handle to the minted CA
# cert, which then lingers active until expiry — the orphan-leak class the retired_certs machinery exists
# to prevent, reintroduced through the manual path.
CRT_TMP_ID="$CRT_TMP.id"

# FAIL EARLY on an unresolved prior enrollment. When a previous run hit the ambiguous D1-failure path
# (wrangler exited non-zero AND the follow-up verify read also failed), it deliberately LEFT $CRT_TMP
# behind as a possibly-REGISTERED PEM — the row may or may not carry this cert. Silently overwriting it
# now defeats that safeguard: if that earlier INSERT actually committed, this run reads the row's OLD
# fingerprint, revokes THIS run's freshly-minted cert (correct), but has already clobbered the registered
# PEM — leaving the machine registered to a cert no longer on disk. So refuse to run and make the operator
# resolve the ambiguity by comparing the registered fingerprint to this temp cert's; the two exits below
# ($CRT_TMP either promoted, or its cert revoked + both files deleted) are the only ways past this guard.
if [ -f "$CRT_TMP" ]; then
  TMP_FP="$(openssl x509 -in "$CRT_TMP" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}' || true)"
  # The prior run persisted its minted cert id in $CRT_TMP.id; read it so 3b can print an exact revoke.
  STRANDED_ID=""
  [ -f "$CRT_TMP_ID" ] && STRANDED_ID="$(sed -n 's/^cert_id=//p' "$CRT_TMP_ID" 2>/dev/null | head -n1)"
  echo "ABORT: an unresolved enrollment cert from a previous run is still at $CRT_TMP" >&2
  echo "  A prior run left it after an ambiguous D1 write (couldn't confirm whether the row registered it)." >&2
  echo "  Resolve it BEFORE re-enrolling — overwriting it could strand this machine on a revoked cert:" >&2
  echo "  1) Read the registered fingerprint from D1:" >&2
  echo "       CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote \\" >&2
  echo "         --command \"SELECT cert_fp_sha256 FROM machines WHERE machine_id='$MACHINE_ID';\"" >&2
  echo "  2) Compare it to THIS temp cert's fingerprint: ${TMP_FP:-<unparseable — treat as 'differs', go to 3b>}" >&2
  echo "  3a) MATCH -> enrollment actually succeeded; promote the temp cert and you're done (do NOT re-run):" >&2
  echo "        mv $CRT_TMP $CRT ; rm -f $CRT_TMP_ID" >&2
  echo "  3b) DIFFERS or no row -> this temp cert is UNUSED but was already minted at the CA; REVOKE it (so it" >&2
  echo "      can't linger CA-valid), then delete both files:" >&2
  if [ -n "$STRANDED_ID" ]; then
    echo "        curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$STRANDED_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
    echo "        rm -f $CRT_TMP $CRT_TMP_ID" >&2
  else
    echo "        # no saved cert id ($CRT_TMP_ID missing — a strand from before this sidecar existed). List the" >&2
    echo "        # zone's client certs and find the one whose SHA-256 fingerprint equals the fp printed in step 2:" >&2
    echo "        curl -sS \"$API/zones/$ZONE_ID/client_certificates?per_page=1000\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
    echo "        # then revoke that id and remove the temp file:" >&2
    echo "        curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/<id>\" -H \"Authorization: Bearer \$CF_API_TOKEN\" ; rm -f $CRT_TMP $CRT_TMP_ID" >&2
  fi
  exit 1
fi

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

# Best-effort revoke of the cert this run minted but NEVER installed (not in machines, not in retired_certs)
# — used by every abort/failure path so a leaked active managed cert can't burn the zone quota. Prefers the
# captured $CERT_ID, but FALLS BACK to the sidecar handle ($CRT_TMP.id) when CERT_ID is empty: the capture
# below writes the id to the sidecar BEFORE validating the rest of the response, so even a malformed-but-
# minted sign (which fails the capture and leaves CERT_ID empty) still has a revocable handle on disk. curl
# -f only catches HTTP errors, so we parse the CF response's `success` flag (an HTTP-200 {"success":false}
# must NOT be reported as revoked). CF_API_TOKEN is already in scope. Never exits — the caller decides.
revoke_unused_cert() {
  local cid="$CERT_ID"
  if [ -z "$cid" ] && [ -f "$CRT_TMP_ID" ]; then
    cid="$(sed -n 's/^cert_id=//p' "$CRT_TMP_ID" 2>/dev/null | head -n1)"
  fi
  if [ -z "$cid" ]; then
    echo "    (no cert id captured or on the sidecar — nothing was minted to revoke)" >&2
    return
  fi
  echo "    The cert just minted for this run was NEVER installed — revoking it now so it can't linger CA-valid..." >&2
  local del_resp del_ok
  del_resp="$(curl -sS -X DELETE "$API/zones/$ZONE_ID/client_certificates/$cid" -H "Authorization: Bearer $CF_API_TOKEN" 2>/dev/null || true)"
  del_ok="$(printf '%s' "$del_resp" | python3 -c 'import json,sys
try:
    print("yes" if json.load(sys.stdin).get("success") else "no")
except Exception:
    print("no")' 2>/dev/null || echo no)"
  if [ "$del_ok" = "yes" ]; then
    echo "      revoked unused cert $cid" >&2
  else
    echo "      WARN: automatic revoke did not confirm success — run this manually so the cert doesn't linger CA-valid:" >&2
    echo "      curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$cid\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
  fi
}

# Capture the CA client-certificate id (CERT_ID) — the hub stores it in machines.cert_id and uses it as the
# REVOKE handle on rotation/prune, so it MUST be recorded or every cert this script enrolls looks like a
# legacy unknown-id row and leaks its first rotated cert. INVARIANT: from the moment CF mints a cert (a
# non-empty result.id), the id is on the sidecar ($CRT_TMP.id) BEFORE anything else can fail — the python
# block writes the sidecar FIRST, THEN validates certificate/expires_on, THEN writes the PEM. We run it as
# an `if !` condition, NOT a bare CERT_ID=$(...): under set -e a failing command-substitution assignment
# exits the script at that line (verified), which would skip the revoke below. On failure, revoke_unused_cert
# falls back to the sidecar id and DELETEs the stranded cert.
CERT_ID=""
if ! CERT_ID="$(python3 - "$resp" "$CRT_TMP" "$CRT_TMP_ID" <<'PY'
import json,sys,hashlib,base64,re
d=json.loads(sys.argv[1])
if not d.get("success"):
    sys.stderr.write("    Cloudflare API error: %s\n" % json.dumps(d.get("errors")))
    sys.exit(1)
res=d.get("result") or {}
cid=res.get("id")
if not isinstance(cid,str) or not cid:
    sys.stderr.write("    Cloudflare sign response has no cert id — nothing was minted.\n")
    sys.exit(1)
# MINTED: write the revoke handle to the sidecar NOW, before validating the rest. fp is a convenience
# (SHA-256 of the DER, identical to the openssl fingerprint below) computed only if the PEM is parseable.
pem=res.get("certificate")
fp=""
if isinstance(pem,str):
    m=re.search(r"-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----",pem,re.S)
    if m:
        try: fp=hashlib.sha256(base64.b64decode("".join(m.group(1).split()))).hexdigest()
        except Exception: fp=""
open(sys.argv[3],"w").write("cert_id=%s\nfp=%s\n" % (cid,fp))
# Now validate the remaining required fields (clean messages, no tracebacks). A nonzero exit here leaves the
# sidecar in place so the caller's revoke_unused_cert can DELETE the minted-but-unusable cert.
if not isinstance(pem,str) or not pem:
    sys.stderr.write("    Cloudflare sign response has no certificate PEM (cert id %s minted; sidecar written for revoke).\n" % cid)
    sys.exit(2)
exp=res.get("expires_on")
if not isinstance(exp,str) or not exp:
    sys.stderr.write("    Cloudflare sign response has no expires_on (cert id %s minted; sidecar written for revoke).\n" % cid)
    sys.exit(2)
open(sys.argv[2],"w").write(pem)
sys.stderr.write("    cert id: %s expires: %s\n" % (cid,exp))
print(cid)
PY
)"; then
  echo "    The Cloudflare sign response was unusable (see message above) — cleaning up any minted cert." >&2
  revoke_unused_cert
  rm -f "$CRT_TMP" "$CRT_TMP_ID"
  exit 1
fi
[ -n "$CERT_ID" ] || { echo "    no cert id in Cloudflare response" >&2; revoke_unused_cert; rm -f "$CRT_TMP" "$CRT_TMP_ID"; exit 1; }

echo "==> registering machine '$MACHINE_ID' (is_admin=$IS_ADMIN) in $DB_NAME"
# hostname is machine-controlled and goes into a single-quoted SQL literal — SQL-escape any quote (double
# it) so it can't break or inject the statement (machine_id is already charset-validated above).
HOSTNAME_VAL="$(hostname)"
HOSTNAME_VAL="${HOSTNAME_VAL//\'/\'\'}"

# (revoke_unused_cert is defined ABOVE, before the sign-result capture, so the capture's failure path can
# call it — and it falls back to the sidecar handle when CERT_ID wasn't captured.)

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

# Parse a wrangler `d1 execute --json` payload and print the machines row's is_admin (empty if absent).
# Scans every statement's results for the `is_admin` field. Prints ONLY the value on stdout.
parse_admin() {  # $1 = wrangler --json output
  python3 - "$1" <<'PY'
import json,sys
try:
    d=json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
val=""
for stmt in (d if isinstance(d, list) else []):
    for r in (stmt.get("results") or []):
        if r.get("is_admin") is not None:
            val=str(r["is_admin"])
print(val)
PY
}

# Fresh, SELECT-only read of the machines row's fingerprint — used to VERIFY reality after an ambiguous
# write. Prints the fp on stdout (empty if no row); returns non-zero if the read OR the parse fails, so
# the caller can distinguish "provably not ours" from "couldn't tell".
read_row_fp() {
  local json
  json="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" wrangler_oauth d1 execute "$DB_NAME" --remote --json \
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
# Write is INSERT ... ON CONFLICT (machine_id) DO UPDATE ... WHERE cert_fp_sha256 IS NULL (a guarded upsert
# that fills a first cert onto a certless row but never displaces an existing one — see the INSERT_SQL note
# below), then a read-back: if the row now carries OUR fingerprint the enrollment took (a fresh insert, a
# certless-row fill, or an idempotent same-fp re-run); if the id already exists under a DIFFERENT fingerprint
# the guard left it untouched and we abort + point at the admin re-enroll flow. The just-minted cert was
# never installed, so we print its id and the one-liner to revoke it (safe direction — nothing refs it).
# cf.tlsClientAuth.certFingerprintSHA256 == lowercase hex SHA-256 of the DER cert, no colons. If Cloudflare
# returned success but a certificate openssl can't parse, this pipeline fails AFTER the mint — revoke the
# unused cert before aborting (the shell twin of the hub's post-sign certFingerprint guard), rather than
# leaking a live-but-unregistered cert under set -e. revoke_unused_cert is defined above and uses CERT_ID.
if ! FP="$(openssl x509 -in "$CRT_TMP" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')" || [ -z "$FP" ]; then
  echo "    could not fingerprint the signed certificate — Cloudflare returned a cert openssl can't parse." >&2
  rm -f "$CRT_TMP" "$CRT_TMP_ID"
  revoke_unused_cert
  exit 1
fi
echo "==> cert fingerprint (SHA-256): $FP"

# Refresh the sidecar with the canonical openssl fingerprint. The capture's python block already wrote it at
# mint time (cert_id + a python-computed fp) so the handle survives any failure; this rewrites it with the
# openssl-computed $FP for exactness. Any later abort that leaves the temp cert also leaves this revoke
# handle; every cleanup path below removes both files together, and a successful enrollment removes the
# sidecar after promoting $CRT.
printf 'cert_id=%s\nfp=%s\n' "$CERT_ID" "$FP" > "$CRT_TMP_ID"

# Fill a FIRST cert onto a row that has none, but NEVER displace an existing cert — both atomic in one
# statement. A fresh id inserts; an existing id whose cert_fp_sha256 IS NULL (a reindex parent-insert row,
# or an admin metadata-only upsert made before mTLS bootstrap) gets THIS cert filled in; an existing id that
# already HAS a cert fails the WHERE and is left untouched — the read-back then sees a different fp and takes
# the revoke-and-abort path unchanged. The IS NULL guard makes cert DISPLACEMENT impossible here by
# construction, so fresh-only semantics hold without a DO NOTHING no-op blocking legitimate first-time
# enrollment of certless-but-existing rows. (Rotations still go through the hub admin endpoint.)
#
# is_admin and key_protection are carried through excluded.* too: enrollment is operator-run WITH the CF
# token, so the script's DECLARED role/key-protection wins over a certless metadata-row's defaults —
# otherwise `enroll-cert.sh --admin` over a reindex parent-insert row reports success while the row keeps
# is_admin=0 and the new cert can't reach admin endpoints. The inverse is deliberate: enrolling WITHOUT
# --admin over a certless is_admin=1 row DEMOTES it — that's the operator's declaration, and the read-back
# below makes the resulting is_admin visible.
INSERT_SQL="INSERT INTO machines (machine_id, os, hostname, cert_fp_sha256, cert_id, key_protection, is_admin)
       VALUES ('$MACHINE_ID', '$OS_TAG', '$HOSTNAME_VAL', '$FP', '$CERT_ID', 'software', $IS_ADMIN)
       ON CONFLICT (machine_id) DO UPDATE SET
         cert_fp_sha256 = excluded.cert_fp_sha256, cert_id = excluded.cert_id,
         os = excluded.os, hostname = excluded.hostname,
         key_protection = excluded.key_protection, is_admin = excluded.is_admin
       WHERE machines.cert_fp_sha256 IS NULL;"

# The D1 write needs a wrangler login with D1 access — NOT the just-in-time CF_API_TOKEN, which is zone-SSL
# only (Wrangler consumes both token spellings). On an authenticated admin box we
# insert-then-verify; on a fresh collector box we print the insert to run from such a box.
if wrangler_oauth whoami >/dev/null 2>&1; then
  # Insert (a no-op if the id already exists — DO NOTHING never touches an existing row's cert), then read
  # the row back to see whose fingerprint it carries. A non-zero exit here means the write did NOT commit
  # (D1 auth, a lock/outage, or a rejected statement) — the cert is minted but unregistered, so revoke it
  # before aborting rather than leaking it under set -e.
  if ! CUR_JSON="$(CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" wrangler_oauth d1 execute "$DB_NAME" --remote --json \
      --command "$INSERT_SQL SELECT cert_fp_sha256 AS fp, is_admin FROM machines WHERE machine_id='$MACHINE_ID';")"; then
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
        mv "$CRT_TMP" "$CRT"
        rm -f "$CRT_TMP_ID"
        echo "    enrolled: $MACHINE_ID -> $FP"
        exit 0
      fi
      echo "    Verified: the machines row does NOT carry this cert (found: ${VERIFY_FP:-<no row>}) — it was never installed." >&2
      echo "    Left any pre-existing $CRT untouched." >&2
      rm -f "$CRT_TMP" "$CRT_TMP_ID"
      revoke_unused_cert
      exit 1
    fi
    echo "    Could NOT verify the row (the follow-up read also failed) — NOT revoking; a possibly-registered cert must not be revoked." >&2
    echo "    The signed cert is saved (unverified) at $CRT_TMP; any pre-existing $CRT is left untouched." >&2
    echo "    Resolve manually:" >&2
    echo "      1) Check the row: CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID npx wrangler d1 execute $DB_NAME --remote --command \"SELECT cert_fp_sha256 FROM machines WHERE machine_id='$MACHINE_ID';\"" >&2
    echo "      2) If it shows $FP, enrollment succeeded — move the cert into place:  mv $CRT_TMP $CRT" >&2
    echo "      3) If it shows a different fp or no row, this cert is unused — revoke it and discard the temp:" >&2
    echo "         curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\" ; rm -f $CRT_TMP $CRT_TMP_ID" >&2
    echo "    (The cert id is also saved in $CRT_TMP_ID for the fail-early guard if you re-run before resolving.)" >&2
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
    echo "    Your existing working PEM at $CRT is left untouched." >&2
    echo >&2
    rm -f "$CRT_TMP" "$CRT_TMP_ID"
    revoke_unused_cert
    exit 1
  fi
  # Belt for the WHERE-guard suspenders: the fp matched, so enrollment took — and BOTH write paths (the
  # fresh-insert VALUES and the certless-fill DO UPDATE) set is_admin, so a mismatch here should be
  # impossible. If it ever fires (a concurrent write, or a future SQL edit that drops is_admin from the SET),
  # the cert is registered and VALID — promote it so a working cert isn't stranded — but exit non-zero with a
  # loud pointer to correct the flag via the admin endpoint.
  CUR_ADMIN="$(parse_admin "$CUR_JSON" 2>/dev/null || true)"
  mv "$CRT_TMP" "$CRT"
  rm -f "$CRT_TMP_ID"
  if [ -n "$CUR_ADMIN" ] && [ "$CUR_ADMIN" != "$IS_ADMIN" ]; then
    if [ "$IS_ADMIN" = 1 ]; then REQ_ADMIN_BOOL=true; else REQ_ADMIN_BOOL=false; fi
    echo >&2
    echo "    WARN: is_admin mismatch — requested is_admin=$IS_ADMIN but the row shows is_admin=$CUR_ADMIN." >&2
    echo "    The cert is enrolled and VALID (installed at $CRT); only the admin flag is wrong. Fix it via the" >&2
    echo "    admin endpoint, then you're done:" >&2
    echo "      POST /api/v1/admin/machines { \"machine_id\": \"$MACHINE_ID\", \"is_admin\": $REQ_ADMIN_BOOL }" >&2
    exit 1
  fi
  echo "    enrolled: $MACHINE_ID -> $FP (is_admin=$IS_ADMIN)"
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
  echo "    --command \"$INSERT_SQL SELECT cert_fp_sha256 AS fp, is_admin FROM machines WHERE machine_id='$MACHINE_ID';\"" >&2
  echo >&2
  echo "    The signed cert is saved (unverified) at $CRT_TMP (id in $CRT_TMP_ID); any pre-existing $CRT is left" >&2
  echo "    untouched until you confirm below. The INSERT's guard fills a certless row but never overwrites an" >&2
  echo "    existing cert, so the read-back fp is the source of truth:" >&2
  echo "      - if the returned fp EQUALS  $FP  -> enrollment took; move the cert into place and install:" >&2
  echo "          mv $CRT_TMP $CRT ; rm -f $CRT_TMP_ID" >&2
  echo "      - if it DIFFERS or is empty       -> '$MACHINE_ID' is already enrolled with another cert. THIS" >&2
  echo "        run's cert was NOT installed and must NOT be. Discard the temp + revoke, then rotate via admin:" >&2
  echo "          rm -f $CRT_TMP $CRT_TMP_ID ; curl -X DELETE \"$API/zones/$ZONE_ID/client_certificates/$CERT_ID\" -H \"Authorization: Bearer \$CF_API_TOKEN\"" >&2
  echo "          POST /api/v1/admin/machines { machine_id, cert_fp_sha256, cert_id } with a FRESHLY minted cert." >&2
  echo >&2
  echo "    ONLY after the read-back shows $FP and you've moved the cert into place, install the collector:" >&2
  print_install_steps
fi
