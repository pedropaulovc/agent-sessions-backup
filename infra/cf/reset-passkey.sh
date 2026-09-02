#!/bin/bash
# Re-bootstrap the viewer passkey after a VIEWER_HOST change.
#
# WHY THIS EXISTS. `hub/src/auth/webauthn.ts:71` pins the WebAuthn `rpID` to
# `env.VIEWER_HOST`. A credential minted under one viewer host can never be
# asserted under another - the authenticator scopes it to the origin - so moving
# VIEWER_HOST strands every existing passkey. The DB row survives and looks
# healthy; the authenticator simply refuses to match it. Recovery is: rotate the
# setup token, drop the dead rows, run the ceremony again.
#
# ORDERING, AND WHY. `authorizeRegistration` (webauthn.ts:281-285) authorizes a
# registration in exactly two ways: with zero credentials it accepts the correct
# SETUP_TOKEN; with one or more it demands an authenticated session. So the
# moment `DELETE FROM credentials` lands, the CURRENT token becomes a live
# first-passkey enrollment key for anyone who can reach /login?setup=... . That
# token is `secret_text`, so its value cannot be read back and its exposure
# cannot be audited. Rotating BEFORE the delete is therefore a security
# requirement: it guarantees only the value printed by this run opens the window.
#
# It is NOT a recovery requirement, contrary to an earlier draft of the runbook.
# `wrangler secret put` is an account-level API call that never consults hub
# auth, so the token can be rotated at any point, including after the delete.
# There is no lockout state reachable while you hold account access. Measured
# 2026-09-02 by writing and deleting a throwaway secret with a credential
# present and no session. The hazard is takeover, not lockout.
#
# STATE MODEL. Every step is idempotent and re-entrant, because the dangerous
# state is "credentials deleted, ceremony not finished" and a crash must leave
# you able to just re-run. `open` re-rotates the token (cheap, and narrows the
# window again) and skips the delete when the table is already empty. Nothing is
# cached to disk: the token value exists only in this process and on your
# terminal, deliberately, so it cannot be recovered from a file later.
#
#   ./reset-passkey.sh open     rotate token, drop dead credentials, print URL
#   ./reset-passkey.sh status   read-only: what state is the ceremony in
#   ./reset-passkey.sh finish   after enrolling: prove it, then retire the token
#
# `finish` is not optional hygiene. While SETUP_TOKEN exists it is inert only as
# long as a credential exists (count > 0). Delete the last passkey later and the
# old token silently re-arms. Retiring it closes that path for good.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hub" && pwd)"
PROFILE="${WRANGLER_PROFILE:-sessions-prod}"
MODE="${1:-status}"

# ---------------------------------------------------------------------------
# Config is the source of truth. Reading VIEWER_HOST and the D1 name out of
# wrangler.jsonc rather than restating them here is the whole lesson from this
# migration: a hostname duplicated as a literal is a latent outage. The strip
# matches a whole double-quoted string before it considers a comment, so the
# `//` inside `https://` - or inside any string value - is preserved, while real
# line and block comments are removed from anywhere on the line.
# ---------------------------------------------------------------------------
read_cfg() {
  python3 - "$HUB_DIR/wrangler.jsonc" <<'PY'
import json, re, sys
raw = open(sys.argv[1]).read()
cfg = json.loads(
    re.sub(r'("(?:\\.|[^"\\])*")|/\*[\s\S]*?\*/|//[^\n]*', lambda m: m.group(1) or '', raw)
)
db = (cfg.get('d1_databases') or [{}])[0]
print(cfg.get('vars', {}).get('VIEWER_HOST', ''))
print(cfg.get('vars', {}).get('API_HOST', ''))
print(db.get('database_name', ''))
PY
}

{ read -r VIEWER_HOST; read -r API_HOST; read -r D1_NAME; } < <(read_cfg)

for v in VIEWER_HOST API_HOST D1_NAME; do
  [ -n "${!v}" ] || { echo "FATAL: could not read $v from $HUB_DIR/wrangler.jsonc" >&2; exit 1; }
done

VIEWER="https://$VIEWER_HOST"
WRANGLER=(npx --no-install wrangler)

# Every wrangler call below pins --profile, but wrangler gives CLOUDFLARE_API_TOKEN
# (and the account-id / legacy key+email variables) precedence over the OAuth
# profile. The cutover runbook has the operator export a token for its curl
# steps, and a leftover one in the shell made `status` fail with an
# authentication error that the old parser reported as `KeyError: 'results'`
# (reproduced 2026-09-02 with CLOUDFLARE_API_TOKEN=bogus). Drop them so the
# profile is the only credential in play, and say so.
IGNORED_CF_ENV=()
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL; do
  [ -n "${!v:-}" ] && IGNORED_CF_ENV+=("$v")
  unset "$v"
done

# wrangler chats on stderr about update checks and multi-environment configs;
# none of it is signal here and it corrupts anything we try to parse.
#
# The subshell cd is load-bearing, not tidiness: `npx --no-install` resolves
# wrangler from the nearest node_modules, which only exists under hub/. Invoked
# from the repo root it dies with "npx canceled due to missing packages", and
# `wrangler d1 execute` also needs hub/wrangler.jsonc on hand to resolve the
# binding. Every wrangler call therefore runs with cwd pinned to $HUB_DIR.
#
# Buffering instead of piping straight into grep is deliberate. Under `set -o
# pipefail` a grep that filters away every line exits 1, and that 1 becomes the
# pipeline's status - so a command that SUCCEEDED but printed only noise would
# abort the script. Capturing first lets us report wrangler's real exit code and
# makes the filter unable to invent a failure.
#
# The `if` around the substitution is also load-bearing. A bare
# `out="$(...)"; rc=$?` is not errexit-safe: measured, an unguarded wr call whose
# wrangler exits nonzero aborts the function AT the assignment, so `rc=$?` never
# runs and the buffered diagnostics are never printed - a failed secret rotation
# or D1 write would be silent. wr IS called unguarded (the `| python3` and
# `| tail` sites below). Testing the substitution as a condition suspends errexit
# for it, so we always print the output and return the real status.
wr() {
  local out rc
  if out="$( cd "$HUB_DIR" && "${WRANGLER[@]}" "$@" 2>&1 )"; then
    rc=0
  else
    rc=$?
  fi
  printf '%s\n' "$out" | grep -vE 'update available|Please report|^\s*$' || true
  return "$rc"
}

# Buffer first, then parse STRICTLY. wr writes wrangler's diagnostics to stdout,
# so in a `wr | python3` pipe an API error body went into the parser instead of
# onto the terminal - and the old regex (`\[\s*\{.*\}\s*\]`) happily matched the
# `notes: [{...}]` array inside that error object, so the failure surfaced as a
# KeyError with the real cause swallowed. Now: nonzero wrangler exit, or any
# output that is not `[{"success": true, "results": [...]}]`, prints the raw
# output and aborts.
d1_query() {
  local sql="$1" out rc
  if out="$(wr d1 execute "$D1_NAME" --remote --profile "$PROFILE" --command "$sql" --json)"; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    { echo "FATAL: wrangler d1 execute exited $rc. Output:"; printf '%s\n' "$out"; } >&2
    exit 1
  fi
  printf '%s\n' "$out" | python3 -c '
import sys, json
raw = sys.stdin.read()
doc = None
# wrangler may print banner lines before the JSON; the payload starts at the first line that is "[".
for start in (0, raw.find("\n[") + 1):
    try:
        doc = json.loads(raw[start:])
        break
    except ValueError:
        continue
ok = isinstance(doc, list) and len(doc) == 1 and isinstance(doc[0], dict) \
     and doc[0].get("success") is True and isinstance(doc[0].get("results"), list)
if not ok:
    sys.stderr.write("FATAL: wrangler d1 --json output is not a successful result set. Raw output:\n" + raw)
    sys.exit(1)
print(json.dumps(doc[0]))
'
}

credential_count() {
  d1_query "SELECT COUNT(*) AS n FROM credentials;" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["results"][0]["n"])'
}

# Does the deployed Worker actually serve the VIEWER_HOST we just read from
# config? A mismatch means someone edited config without deploying, and running
# the ceremony against the old rpID would mint yet another dead credential.
live_rpid() {
  curl -s --max-time 20 -X POST "$VIEWER/webauthn/auth/options" \
    -H "Origin: $VIEWER" -H 'content-type: application/json' --data '{}' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("rpId",""))' 2>/dev/null || true
}

# Buffered for the same reason as d1_query: a failed `secret list` (auth error)
# piped into grep -q read as "no", i.e. a silent wrong answer.
setup_token_present() {
  local out
  if ! out="$(wr secret list --profile "$PROFILE")"; then
    { echo "FATAL: wrangler secret list failed. Output:"; printf '%s\n' "$out"; } >&2
    exit 1
  fi
  printf '%s\n' "$out" | grep -q '"SETUP_TOKEN"' && echo yes || echo no
}

# Positive control for "is the window actually open". registerOptions is
# stateless - it generates a challenge and writes nothing - so probing it with
# the real token is safe and proves the token was accepted, rather than assuming
# the secret landed. The Origin header is mandatory: originOk (webauthn.ts:288)
# rejects first with bad_origin and would mask a genuine 403 forbidden.
probe_registration() {
  local token="$1"
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X POST "$VIEWER/webauthn/register/options" \
    -H "Origin: $VIEWER" -H 'content-type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"setup": sys.argv[1]}))' "$token")"
}

preflight() {
  echo "== preflight"
  printf '   config VIEWER_HOST : %s\n' "$VIEWER_HOST"
  printf '   config API_HOST    : %s\n' "$API_HOST"
  printf '   config D1          : %s\n' "$D1_NAME"
  printf '   wrangler profile   : %s\n' "$PROFILE"
  if [ "${#IGNORED_CF_ENV[@]}" -gt 0 ]; then
    printf '   ignored env        : %s (would override the profile; unset for this run)\n' "${IGNORED_CF_ENV[*]}"
  fi

  local rp; rp="$(live_rpid)"
  printf '   deployed rpId      : %s\n' "${rp:-<unreachable>}"
  if [ "$rp" != "$VIEWER_HOST" ]; then
    cat >&2 <<EOF

FATAL: deployed rpId ('${rp:-unreachable}') != config VIEWER_HOST ('$VIEWER_HOST').

Enrolling now would mint a credential scoped to the WRONG host - exactly the
failure this script exists to repair. Deploy the hub first:

    cd $HUB_DIR && npx wrangler deploy --profile $PROFILE

EOF
    exit 1
  fi
  echo "   rpId matches config: OK"
}

case "$MODE" in
status)
  preflight
  n="$(credential_count)"
  echo "== state"
  printf '   credentials in D1  : %s\n' "$n"
  printf '   SETUP_TOKEN present: %s\n' "$(setup_token_present)"
  if [ "$n" -gt 0 ]; then
    echo "   -> registration CLOSED (a session is required); token is inert."
    echo "   -> if that credential predates the VIEWER_HOST change it is dead weight: run 'open'."
  else
    echo "   -> registration OPEN. Anyone with the current token can enroll."
    echo "   -> run 'open' to rotate the token and get a fresh bootstrap URL."
  fi
  d1_query "SELECT credential_id, counter, last_used_at FROM credentials;" \
    | python3 -c '
import sys, json
for r in json.load(sys.stdin)["results"]:
    print("      id=%s... counter=%s last_used=%s" % (str(r["credential_id"])[:24], r["counter"], r["last_used_at"]))
'
  ;;

open)
  preflight

  # Step 1: rotate FIRST. 32 bytes of urandom, url-safe so it survives being
  # pasted into a query string without escaping surprises.
  TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  echo "== rotating SETUP_TOKEN (before touching credentials)"
  printf '%s' "$TOKEN" | wr secret put SETUP_TOKEN --profile "$PROFILE" | tail -2

  # Prove it landed rather than trusting the exit code. A secret_text value can
  # never be read back, so presence is the only assertion available here; the
  # real proof is the 200 from probe_registration below.
  [ "$(setup_token_present)" = yes ] || { echo "FATAL: SETUP_TOKEN missing after put" >&2; exit 1; }
  echo "   secret present: OK"

  # Step 2: drop the stranded credentials. No inbound FKs, so this is a plain
  # delete. Skipped when already empty so a re-run after a crash is harmless.
  n="$(credential_count)"
  if [ "$n" -gt 0 ]; then
    echo "== deleting $n stranded credential(s)"
    d1_query "DELETE FROM credentials;" \
      | python3 -c 'import sys,json; print("   rows deleted:", json.load(sys.stdin)["meta"]["changes"])'
  else
    echo "== credentials table already empty; nothing to delete"
  fi
  [ "$(credential_count)" -eq 0 ] || { echo "FATAL: credentials still present" >&2; exit 1; }

  # Step 3: prove the window is genuinely open with the token we just minted.
  code="$(probe_registration "$TOKEN")"
  echo "== registration probe: HTTP $code"
  if [ "$code" != "200" ]; then
    echo "FATAL: expected 200 from register/options with the new token, got $code." >&2
    echo "The window did not open; do NOT proceed. Re-run 'status' to inspect." >&2
    exit 1
  fi
  echo "   token accepted: OK"

  cat <<EOF

================================================================================
ENROLL NOW - this window is open to anyone holding the token below.

  $VIEWER/login?setup=$TOKEN

Open it on the device whose authenticator you want to enroll, complete the
passkey prompt, then run:

  $0 finish

The token is printed here and nowhere else - not written to disk, not recoverable
from Cloudflare (secret_text is write-only). If you lose it, re-run 'open'.
================================================================================
EOF
  ;;

finish)
  preflight
  n="$(credential_count)"
  echo "== verifying the ceremony completed"
  printf '   credentials in D1  : %s\n' "$n"
  if [ "$n" -eq 0 ]; then
    echo "FATAL: no credential enrolled yet - the window is still open." >&2
    echo "Complete the passkey prompt first, or re-run 'open' for a fresh token." >&2
    exit 1
  fi

  # With count > 0 the token is already inert (authorizeRegistration demands a
  # session). Assert that before retiring it, so a surprising 200 here surfaces
  # as a failure rather than being masked by the delete that follows.
  code="$(probe_registration "definitely-not-the-token")"
  echo "== registration closed probe: HTTP $code (expect 403)"
  [ "$code" = "403" ] || { echo "FATAL: registration still answering $code with a bogus token" >&2; exit 1; }

  echo "== retiring SETUP_TOKEN"
  if [ "$(setup_token_present)" = yes ]; then
    printf 'y\n' | wr secret delete SETUP_TOKEN --profile "$PROFILE" | tail -2
    [ "$(setup_token_present)" = no ] || { echo "FATAL: SETUP_TOKEN still present" >&2; exit 1; }
    echo "   retired: OK"
  else
    echo "   already absent"
  fi

  d1_query "SELECT credential_id, counter, last_used_at FROM credentials;" \
    | python3 -c '
import sys, json
print("== enrolled credentials")
for r in json.load(sys.stdin)["results"]:
    print("   id=%s... counter=%s last_used=%s" % (str(r["credential_id"])[:24], r["counter"], r["last_used_at"]))
'
  echo
  echo "Done. Sign in at $VIEWER/login"
  echo "Note: deleting your last passkey later re-opens enrollment only if you"
  echo "re-create SETUP_TOKEN; with it retired, there is no token path at all."
  ;;

*)
  echo "usage: $0 {status|open|finish}" >&2
  exit 2
  ;;
esac
