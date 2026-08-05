#!/usr/bin/env bash
# Install the latest protected sessions-dev-bridge release into the current WSL user.
# This script downloads and installs signed code; run only the copy committed on trusted main.
set -Eeuo pipefail
umask 077
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH

readonly REPOSITORY='pedropaulovc/agent-sessions-backup'
readonly WORKFLOW='release-sessions-dev-bridge.yml'
readonly NODE_VERSION='22.22.2'
readonly NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
readonly BIN_DIRECTORY="${HOME}/.local/bin"
readonly DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
readonly INSTALL_ROOT="${DATA_HOME}/sessions-dev-bridge"

temporary_directory=''
staged_release=''

fail() {
  printf 'sessions-dev-bridge installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$temporary_directory" ]] || rm -rf -- "$temporary_directory"
  [[ -z "$staged_release" ]] || rm -rf -- "$staged_release"
}
trap cleanup EXIT

native_command() {
  local name=$1
  local path
  local normalized
  path=$(command -v "$name" 2>/dev/null) || fail "$name is required in WSL"
  [[ -x /usr/bin/readlink ]] || fail '/usr/bin/readlink is required in WSL'
  path=$(/usr/bin/readlink -f -- "$path") || fail "cannot resolve $name"
  normalized=${path,,}
  case "$normalized" in
    /mnt/*|*.exe|*.cmd|*.bat) fail "$name resolves outside native WSL: $path" ;;
  esac
  printf '%s\n' "$path"
}

[[ $(uname -s) == 'Linux' ]] || fail 'this installer requires native Linux or WSL'
[[ "$HOME" == /* && "$DATA_HOME" == /* ]] || fail 'HOME and XDG_DATA_HOME must be absolute Linux paths'

readonly GH=$(native_command gh)
readonly CURL=$(native_command curl)
readonly TAR=$(native_command tar)
readonly SHA256SUM=$(native_command sha256sum)
readonly XDG_OPEN=$(native_command xdg-open)
readonly DASH=$(native_command dash)
[[ "$XDG_OPEN" == '/usr/bin/xdg-open' ]] \
  || fail "xdg-open must resolve to /usr/bin/xdg-open, got $XDG_OPEN"

case $(uname -m) in
  x86_64)
    readonly NODE_ARCH='x64'
    readonly NODE_SHA256='978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3'
    ;;
  aarch64|arm64)
    readonly NODE_ARCH='arm64'
    readonly NODE_SHA256='b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28'
    ;;
  *) fail "unsupported Linux architecture: $(uname -m)" ;;
esac

"$GH" auth status --hostname github.com >/dev/null 2>&1 || fail 'native WSL gh must be authenticated to github.com'

release=$(
  "$GH" run list \
    --repo "$REPOSITORY" \
    --workflow "$WORKFLOW" \
    --branch main \
    --event workflow_dispatch \
    --status success \
    --limit 1 \
    --json attempt,databaseId,headSha \
    --jq '.[0] | [.databaseId, .headSha, .attempt] | @tsv'
)
IFS=$'\t' read -r run_id head_sha run_attempt extra <<<"$release"
[[ "$run_id" =~ ^[1-9][0-9]*$ \
  && "$head_sha" =~ ^[0-9a-f]{40}$ \
  && "$run_attempt" =~ ^[1-9][0-9]*$ \
  && -z "${extra:-}" ]] \
  || fail 'no valid protected bridge release is available'

artifact="sessions-dev-bridge-${head_sha}-attempt-${run_attempt}"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/sessions-dev-bridge.XXXXXXXX")
"$GH" run download "$run_id" --repo "$REPOSITORY" --name "$artifact" --dir "$temporary_directory" \
  || fail "protected bridge artifact $artifact is unavailable"

packages=("$temporary_directory"/sessions-dev-bridge-*.tgz)
[[ ${#packages[@]} -eq 1 && -f "${packages[0]}" ]] \
  || fail 'the protected workflow artifact must contain exactly one bridge package'
"$GH" attestation verify "${packages[0]}" \
  --repo "$REPOSITORY" \
  --signer-workflow "github.com/${REPOSITORY}/.github/workflows/${WORKFLOW}" \
  --source-ref refs/heads/main \
  --source-digest "$head_sha" \
  --deny-self-hosted-runners \
  >/dev/null \
  || fail 'bridge package build provenance verification failed'

node_archive="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
"$CURL" --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$temporary_directory/$node_archive" "$NODE_BASE_URL/$node_archive"
printf '%s  %s\n' "$NODE_SHA256" "$temporary_directory/$node_archive" | "$SHA256SUM" --check --status \
  || fail "Node.js ${NODE_VERSION} archive digest mismatch"

for directory in "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"; do
  [[ ! -L "$directory" ]] || fail "$directory must not be a symbolic link"
done
mkdir -p -- "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"
chmod 700 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"
staged_release=$(mktemp -d "$INSTALL_ROOT/.stage.XXXXXXXX")
mkdir -p -- "$staged_release/node" "$staged_release/bridge"
"$TAR" -xzf "$temporary_directory/$node_archive" --strip-components=1 -C "$staged_release/node"

node="$staged_release/node/bin/node"
npm_cli="$staged_release/node/lib/node_modules/npm/bin/npm-cli.js"
PATH="$staged_release/node/bin:/usr/bin:/bin" "$node" "$npm_cli" install \
  --global \
  --prefix "$staged_release/bridge" \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  "${packages[0]}"

package_root="$staged_release/bridge/lib/node_modules/sessions-dev-bridge"
[[ -f "$package_root/src/cli.mjs" ]] || fail 'installed bridge entrypoint is missing'

BRIDGE_PACKAGE_ROOT="$package_root" \
EXPECTED_RELEASE_COMMIT="$head_sha" \
EXPECTED_RELEASE_RUN_ID="$run_id" \
EXPECTED_RELEASE_RUN_ATTEMPT="$run_attempt" \
  "$node" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const root = process.env.BRIDGE_PACKAGE_ROOT;
    const moduleUrl = pathToFileURL(`${root}/src/provenance.mjs`).href;
    const { verifyInstalledRelease } = await import(moduleUrl);
    const release = await verifyInstalledRelease({ packageRoot: root });
    if (release.commit !== process.env.EXPECTED_RELEASE_COMMIT
      || release.runId !== process.env.EXPECTED_RELEASE_RUN_ID
      || release.runAttempt !== process.env.EXPECTED_RELEASE_RUN_ATTEMPT) {
      throw new Error("installed provenance does not match the selected protected workflow attempt");
    }
  '

set +e
verification=$("$node" "$package_root/src/cli.mjs" 2>&1)
verification_status=$?
set -e
[[ $verification_status -eq 1 && "$verification" == *'usage: sessions-dev-bridge'* ]] \
  || fail 'installed bridge failed its provenance-gated CLI verification'

release_directory="$INSTALL_ROOT/releases/${head_sha}-attempt-${run_attempt}"
[[ ! -L "$release_directory" ]] || fail "$release_directory must not be a symbolic link"
if [[ -e "$release_directory" && ! -d "$release_directory" ]]; then
  fail "$release_directory is not a directory"
fi
rm -rf -- "$release_directory"
mv -- "$staged_release" "$release_directory"
staged_release=''

wrapper=$(mktemp "$BIN_DIRECTORY/.sessions-dev-bridge.XXXXXXXX")
printf '#!%s\nset -eu\nunset BASH_ENV ENV NODE_OPTIONS NODE_PATH\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\nexec %q %q "$@"\n' \
  "$DASH" \
  "$release_directory/node/bin/node" \
  "$release_directory/bridge/lib/node_modules/sessions-dev-bridge/src/cli.mjs" \
  >"$wrapper"
chmod 700 "$wrapper"
mv -f -- "$wrapper" "$BIN_DIRECTORY/sessions-dev-bridge"
for installed_release in "$INSTALL_ROOT"/releases/*; do
  [[ "$installed_release" == "$release_directory" ]] || rm -rf -- "$installed_release"
done

case ":$PATH:" in
  *":$BIN_DIRECTORY:"*) ;;
  *) printf 'Add %s to PATH before invoking sessions-dev-bridge.\n' "$BIN_DIRECTORY" >&2 ;;
esac

printf 'Installed protected sessions-dev-bridge release %s (run %s, attempt %s).\n' "$head_sha" "$run_id" "$run_attempt"
printf 'Native browser launcher: %s\n' "$XDG_OPEN"
printf 'Command: %s\n' "$BIN_DIRECTORY/sessions-dev-bridge"
