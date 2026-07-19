#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MOCK="$SCRIPT_DIR/test-fixtures/mock-enroll-command.sh"
MOCK_BIN="$TMP_DIR/bin"
mkdir -p "$MOCK_BIN" "$TMP_DIR/out"
for command in curl hostname npx openssl; do
  ln -s "$MOCK" "$MOCK_BIN/$command"
done

export ENROLL_TEST_LOG="$TMP_DIR/wrangler.log"
export CF_API_TOKEN="zone-signing-token"
export CLOUDFLARE_API_TOKEN="wrong-global-token"
PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_DIR/enroll-cert.sh" test-linux --out "$TMP_DIR/out" >/dev/null

mapfile -t calls < "$ENROLL_TEST_LOG"
if [ "${#calls[@]}" -ne 2 ]; then
  echo "expected exactly two Wrangler calls, got ${#calls[@]}" >&2
  printf '%s\n' "${calls[@]}" >&2
  exit 1
fi
if [ "${calls[0]}" != 'npx: --yes wrangler whoami' ]; then
  echo "unexpected Wrangler authentication probe: ${calls[0]}" >&2
  exit 1
fi
case "${calls[1]}" in
  'npx: --yes wrangler d1 execute sessions-index --remote --command '*) ;;
  *)
    echo "unexpected Wrangler D1 call: ${calls[1]}" >&2
    exit 1
    ;;
esac

echo "enroll-cert token isolation: ok"
