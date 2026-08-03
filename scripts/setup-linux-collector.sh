#!/usr/bin/env bash
# Update an enrolled Linux/WSL collector from the current main branch, replace its
# systemd user timer, and send an immediate heartbeat.
set -Eeuo pipefail

readonly COLLECTOR_REF='git+https://github.com/pedropaulovc/agent-sessions-backup.git@main#subdirectory=collector'
readonly COLLECTOR_BIN="${HOME}/.local/bin/agent-collector"

interval_minutes=15

usage() {
  cat <<'EOF'
Usage: setup-linux-collector.sh [--interval MINUTES]

Install the latest agent-collector from main, activate its systemd user timer,
and send an authenticated heartbeat.

Options:
  --interval MINUTES  Minutes between runs (1-1440, default: 15)
  -h, --help          Show this help
EOF
}

fail() {
  printf '[FAIL] %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --interval)
      (($# >= 2)) || fail '--interval needs a value'
      interval_minutes=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "$interval_minutes" =~ ^[0-9]+$ ]] || fail "interval must be an integer: $interval_minutes"
((interval_minutes >= 1 && interval_minutes <= 1440)) || fail "interval must be between 1 and 1440 minutes"
command -v uv >/dev/null 2>&1 || fail 'uv is required: https://docs.astral.sh/uv/getting-started/installation/'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required for the Linux user timer'

# Do not replace the tool while a systemd run is still executing. A oneshot service is
# "activating" while its ExecStart process is alive and becomes "inactive" after it exits.
while [[ "$(systemctl --user show --property=ActiveState --value agent-collector.service 2>/dev/null || true)" == 'activating' ]]; do
  printf 'Waiting for the active agent-collector run to finish.\n' >&2
  sleep 2
done

printf 'Installing the collector from main.\n'
uv tool install --force --reinstall --no-cache "$COLLECTOR_REF"
[[ -x "$COLLECTOR_BIN" ]] || fail "collector executable not found at $COLLECTOR_BIN"

printf 'Registering the systemd user timer.\n'
"$COLLECTOR_BIN" install --interval "$interval_minutes"

printf 'Sending an immediate heartbeat.\n'
"$COLLECTOR_BIN" run --heartbeat-only
