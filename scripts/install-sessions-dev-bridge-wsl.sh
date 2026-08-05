#!/usr/bin/bash
# Install the latest protected sessions-dev-bridge release into the current WSL user.
# This script downloads and installs signed code; run only the copy committed on trusted main.
set -Eeuo pipefail
umask 077
readonly CALLER_PATH=${PATH-}

readonly TRUSTED_PATH='/usr/sbin:/usr/bin:/sbin:/bin'
readonly USER_HOME=${HOME:?HOME is required}
readonly DATA_HOME=${XDG_DATA_HOME:-${USER_HOME}/.local/share}
readonly STATE_HOME=${XDG_STATE_HOME:-${USER_HOME}/.local/state}
readonly CONFIG_HOME=${XDG_CONFIG_HOME:-${USER_HOME}/.config}
PATH=$TRUSTED_PATH
HOME=$USER_HOME
XDG_DATA_HOME=$DATA_HOME
XDG_STATE_HOME=$STATE_HOME
XDG_CONFIG_HOME=$CONFIG_HOME
LANG=C.UTF-8
export PATH HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CONFIG_HOME LANG
unset BASH_ENV ENV CDPATH GLOBIGNORE TAR_OPTIONS
unset LD_PRELOAD LD_LIBRARY_PATH
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
unset OPENSSL_CONF OPENSSL_MODULES SSL_CERT_FILE SSL_CERT_DIR
unset NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG npm_config_userconfig npm_config_globalconfig
unset CURL_HOME NETRC GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy

readonly REPOSITORY='pedropaulovc/agent-sessions-backup'
readonly WORKFLOW='release-sessions-dev-bridge.yml'
readonly NODE_VERSION='22.22.2'
readonly NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
readonly NODE_SHA256='978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3'
readonly BIN_DIRECTORY="${USER_HOME}/.local/bin"
readonly INSTALL_ROOT="${DATA_HOME}/sessions-dev-bridge"

readonly GH='/usr/bin/gh'
readonly CURL='/usr/bin/curl'
readonly TAR='/usr/bin/tar'
readonly SHA256SUM='/usr/bin/sha256sum'
readonly XDG_OPEN='/usr/bin/xdg-open'
readonly DASH='/usr/bin/dash'
readonly READLINK='/usr/bin/readlink'
readonly UNAME='/usr/bin/uname'
readonly MKTEMP='/usr/bin/mktemp'
readonly MKDIR='/usr/bin/mkdir'
readonly CHMOD='/usr/bin/chmod'
readonly MV='/usr/bin/mv'
readonly RM='/usr/bin/rm'
readonly RMDIR='/usr/bin/rmdir'
readonly ENV_BIN='/usr/bin/env'

fail() {
  printf 'sessions-dev-bridge installer: %s\n' "$*" >&2
  exit 1
}

for path in "$USER_HOME" "$DATA_HOME" "$STATE_HOME" "$CONFIG_HOME"; do
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ && "$path" != *'/../'* && "$path" != */.. ]] \
    || fail "unsafe Linux path: $path"
done
for command in "$GH" "$CURL" "$TAR" "$SHA256SUM" "$XDG_OPEN" "$DASH" "$READLINK" \
  "$UNAME" "$MKTEMP" "$MKDIR" "$CHMOD" "$MV" "$RM" "$RMDIR" "$ENV_BIN"; do
  [[ -x "$command" && ! -L "$command" ]] || fail "trusted native executable is unavailable: $command"
  [[ $($READLINK -f -- "$command") == "$command" ]] || fail "trusted executable resolves elsewhere: $command"
done
[[ $($UNAME -s) == 'Linux' ]] || fail 'this installer requires native Linux or WSL'
[[ $($UNAME -m) == 'x86_64' ]] || fail "unsupported Linux architecture: $($UNAME -m)"

readonly RUNTIME_ENV=(
  "$ENV_BIN" -i
  "HOME=$USER_HOME"
  "XDG_CONFIG_HOME=$CONFIG_HOME"
  "XDG_DATA_HOME=$DATA_HOME"
  "XDG_STATE_HOME=$STATE_HOME"
  "PATH=$TRUSTED_PATH"
  'LANG=C.UTF-8'
)

temporary_directory=''
staged_release=''
cleanup() {
  [[ -z "$temporary_directory" ]] || "$RM" -rf -- "$temporary_directory"
  [[ -z "$staged_release" ]] || "$RM" -rf -- "$staged_release"
}
trap cleanup EXIT

"$GH" auth status --hostname github.com >/dev/null 2>&1 \
  || fail 'native WSL gh must be authenticated to github.com'
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

release_tag="sessions-dev-bridge-${head_sha}-attempt-${run_attempt}"
release_target=$(
  "$GH" api "repos/${REPOSITORY}/git/ref/tags/${release_tag}" --jq '.object.sha'
) || fail "protected bridge release $release_tag is unavailable"
[[ "$release_target" == "$head_sha" ]] \
  || fail "protected bridge release $release_tag does not target its workflow commit"
temporary_directory=$("$MKTEMP" -d '/tmp/sessions-dev-bridge.XXXXXXXX')
"$GH" release download "$release_tag" \
  --repo "$REPOSITORY" \
  --pattern 'sessions-dev-bridge-runtime.tgz' \
  --dir "$temporary_directory" \
  || fail "protected bridge release $release_tag is unavailable"
runtime_archive="$temporary_directory/sessions-dev-bridge-runtime.tgz"
[[ -f "$runtime_archive" ]] || fail 'the protected release must contain the sealed bridge runtime'
release_entries=("$temporary_directory"/*)
[[ ${#release_entries[@]} -eq 1 && "${release_entries[0]}" == "$runtime_archive" ]] \
  || fail 'the protected release must contain exactly one downloaded file'
"$GH" attestation verify "$runtime_archive" \
  --repo "$REPOSITORY" \
  --signer-workflow "github.com/${REPOSITORY}/.github/workflows/${WORKFLOW}" \
  --source-ref refs/heads/main \
  --source-digest "$head_sha" \
  --deny-self-hosted-runners \
  >/dev/null \
  || fail 'bridge runtime build provenance verification failed'

node_archive="node-v${NODE_VERSION}-linux-x64.tar.gz"
"$CURL" --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$temporary_directory/$node_archive" "$NODE_BASE_URL/$node_archive"
printf '%s  %s\n' "$NODE_SHA256" "$temporary_directory/$node_archive" | "$SHA256SUM" --check --status \
  || fail "Node.js ${NODE_VERSION} archive digest mismatch"

for directory in "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"; do
  [[ ! -L "$directory" ]] || fail "$directory must not be a symbolic link"
done
"$MKDIR" -p -- "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"
"$CHMOD" 700 "$INSTALL_ROOT" "$INSTALL_ROOT/releases" "$BIN_DIRECTORY"
staged_release=$("$MKTEMP" -d "$INSTALL_ROOT/.stage.XXXXXXXX")
"$MKDIR" -p -- "$staged_release/node" "$staged_release/bridge"
"$TAR" --extract --gzip --file "$temporary_directory/$node_archive" \
  --strip-components=1 --directory "$staged_release/node" --no-same-owner --no-same-permissions
"$TAR" --extract --gzip --file "$runtime_archive" \
  --directory "$staged_release/bridge" --no-same-owner --no-same-permissions

node="$staged_release/node/bin/node"
package_root="$staged_release/bridge/lib/node_modules/sessions-dev-bridge"
[[ -x "$node" && -f "$package_root/src/cli.mjs" ]] || fail 'sealed bridge runtime is incomplete'
"${RUNTIME_ENV[@]}" "RUNTIME_ROOT=$staged_release/bridge" "$node" --input-type=module -e '
  import { lstat, readdir } from "node:fs/promises";
  import { join } from "node:path";
  let files = 0;
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`sealed runtime contains a symbolic link: ${path}`);
      if (stat.isDirectory()) await scan(path);
      else if (stat.isFile()) files += 1;
      else throw new Error(`sealed runtime contains a non-file entry: ${path}`);
    }
  }
  await scan(process.env.RUNTIME_ROOT);
  if (files === 0) throw new Error("sealed runtime is empty");
'

"${RUNTIME_ENV[@]}" \
  "BRIDGE_PACKAGE_ROOT=$package_root" \
  "EXPECTED_RELEASE_COMMIT=$head_sha" \
  "EXPECTED_RELEASE_RUN_ID=$run_id" \
  "EXPECTED_RELEASE_RUN_ATTEMPT=$run_attempt" \
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
verification=$("${RUNTIME_ENV[@]}" "$node" "$package_root/src/cli.mjs" 2>&1)
verification_status=$?
set -e
[[ $verification_status -eq 1 && "$verification" == *'usage: sessions-dev-bridge'* ]] \
  || fail 'installed bridge failed its provenance-gated CLI verification'

release_directory=$("$MKTEMP" -d "$INSTALL_ROOT/releases/${head_sha}-attempt-${run_attempt}.XXXXXXXX")
"$MV" -- "$staged_release/node" "$staged_release/bridge" "$release_directory/"
"$RMDIR" -- "$staged_release"
staged_release=''

command_path="$BIN_DIRECTORY/sessions-dev-bridge"
[[ ! -L "$command_path" ]] || fail "$command_path must not be a symbolic link"
[[ ! -e "$command_path" || -f "$command_path" ]] || fail "$command_path must be a regular file"
wrapper=$("$MKTEMP" "$BIN_DIRECTORY/.sessions-dev-bridge.XXXXXXXX")
printf '#!%s\nset -eu\nexec /usr/bin/env -i HOME=%q XDG_CONFIG_HOME=%q XDG_DATA_HOME=%q XDG_STATE_HOME=%q PATH=%q LANG=C.UTF-8 DISPLAY="${DISPLAY-}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS-}" XAUTHORITY="${XAUTHORITY-}" %q %q "$@"\n' \
  "$DASH" "$USER_HOME" "$CONFIG_HOME" "$DATA_HOME" "$STATE_HOME" "$TRUSTED_PATH" \
  "$release_directory/node/bin/node" \
  "$release_directory/bridge/lib/node_modules/sessions-dev-bridge/src/cli.mjs" \
  >"$wrapper"
"$CHMOD" 700 "$wrapper"
set +e
published_verification=$("$wrapper" 2>&1)
published_status=$?
set -e
[[ $published_status -eq 1 && "$published_verification" == *'usage: sessions-dev-bridge'* ]] \
  || fail 'generated bridge launcher failed verification'
"$MV" -fT -- "$wrapper" "$command_path"

case ":$CALLER_PATH:" in
  *":$BIN_DIRECTORY:"*) ;;
  *) printf 'Add %s to PATH before invoking sessions-dev-bridge.\n' "$BIN_DIRECTORY" >&2 ;;
esac

printf 'Installed protected sessions-dev-bridge release %s (run %s, attempt %s).\n' "$head_sha" "$run_id" "$run_attempt"
printf 'Native browser launcher: %s\n' "$XDG_OPEN"
printf 'Command: %s\n' "$command_path"
