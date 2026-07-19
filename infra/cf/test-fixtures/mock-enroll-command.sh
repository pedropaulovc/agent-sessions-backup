#!/usr/bin/env bash
set -euo pipefail

case "${0##*/}" in
  curl)
    if [ "${CF_API_TOKEN-}" != "zone-signing-token" ]; then
      echo "curl did not receive the signing token" >&2
      exit 90
    fi
    printf '%s\n' '{"success":true,"result":{"certificate":"mock-certificate","id":"mock-cert-id","expires_on":"2099-01-01T00:00:00Z"}}'
    ;;
  hostname)
    printf '%s\n' 'test-host'
    ;;
  npx)
    if [ -n "${CF_API_TOKEN-}" ] || [ -n "${CLOUDFLARE_API_TOKEN-}" ]; then
      echo "Wrangler inherited a Cloudflare API token" >&2
      exit 91
    fi
    printf 'npx:' >> "${ENROLL_TEST_LOG:?}"
    for arg in "$@"; do
      arg="${arg//$'\n'/\\n}"
      printf ' %s' "$arg" >> "$ENROLL_TEST_LOG"
    done
    printf '\n' >> "$ENROLL_TEST_LOG"
    ;;
  openssl)
    case "${1-}" in
      ecparam|req)
        while [ "$#" -gt 0 ]; do
          if [ "$1" = '-out' ]; then
            : > "$2"
            exit 0
          fi
          shift
        done
        echo "mock openssl expected -out" >&2
        exit 92
        ;;
      x509)
        printf '%s' 'mock-der'
        ;;
      dgst)
        printf '%s\n' 'SHA2-256(stdin)= 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        ;;
      *)
        echo "unexpected openssl invocation: $*" >&2
        exit 93
        ;;
    esac
    ;;
  *)
    echo "unexpected mock command: ${0##*/}" >&2
    exit 94
    ;;
esac
