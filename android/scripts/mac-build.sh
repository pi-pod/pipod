#!/usr/bin/env bash
# Sync this project to the shared build Mac and run a Gradle task there.
#
# The workstation this repo lives on cannot run a Gradle/Kotlin daemon without
# thrashing swap, so every compile happens on the Mac. The Mac is shared, so:
#
#   * each caller builds in its own workdir under ~/work (PIPOD_MAC_WORKDIR),
#   * builds are serialised behind a lock, because three concurrent no-daemon
#     Gradle runs at -Xmx3g is more than the machine has to spare, and
#   * nothing outside the caller's workdir is read or written.
#
# Usage: scripts/mac-build.sh [gradle args...]      (default: assembleDebug)
set -euo pipefail
TS=(tailscale)
if [[ -n ${TAILSCALE_SOCKET:-} ]]; then TS+=(--socket="$TAILSCALE_SOCKET"); fi
SSH_ARGS=(-o BatchMode=yes)
# The macOS wrapper does not add a userspace pipe; keep the selected node identity.
if [[ -n ${TAILSCALE_SOCKET:-} && $(uname -s) == Darwin ]]; then
  printf -v proxy '%q ' "${TS[@]}" nc
  SSH_ARGS+=(-o "ProxyCommand=${proxy}%h %p")
fi

MAC_HOST="${PIPOD_MAC_HOST:-agent@mac-mini-m4}"
case "$MAC_HOST" in
  agent@mac-mini-m4) ;;
  *) echo 'Use agent@mac-mini-m4.' >&2; exit 2 ;;
esac
REMOTE_DIR="${PIPOD_MAC_WORKDIR:-work/pi-pod-android}"
JAVA_HOME_REMOTE="${PIPOD_MAC_JAVA_HOME:-\$HOME/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home}"
LOCK_DIR="${PIPOD_MAC_LOCK:-\$HOME/work/android-build.lock}"
LOCK_TIMEOUT="${PIPOD_MAC_LOCK_TIMEOUT:-1800}"
DEVICE_SERIAL="${PIPOD_DEVICE_SERIAL:-emulator-5554}"
[[ "$DEVICE_SERIAL" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo 'Invalid device serial' >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${TS[@]}" ssh "$MAC_HOST" "${SSH_ARGS[@]}" "mkdir -p '$REMOTE_DIR'"

rsync -az --delete \
  --exclude '.git/' \
  --exclude '.gradle/' \
  --exclude '.kotlin/' \
  --exclude 'build/' \
  --exclude 'app/build/' \
  --exclude 'local.properties' \
  --exclude '.idea/' \
  -e "\"$here/scripts/tailscale-rsh.sh\"" \
  "$here/" "$MAC_HOST:$REMOTE_DIR/"

args=("$@")
if [ ${#args[@]} -eq 0 ]; then args=(assembleDebug); fi

# The remote shell is zsh, and an unquoted argument reaches it as a glob: a
# `--tests 'pkg.Class*'` filter that matches no local file aborts the whole
# command with "no matches found" before Gradle ever runs. Quote each argument
# once, here, so callers can pass Gradle filters the obvious way.
remote_args=""
for arg in "${args[@]}"; do
  remote_args+=" '${arg//\'/\'\\\'\'}'"
done

# Tailscale SSH on the test host may report zero even for a failed remote command.
# Require an explicit result marker; missing/truncated output must fail closed.
remote_log=$(mktemp)
trap 'rm -f "$remote_log"' EXIT
set +e
# shellcheck disable=SC2029  # the remote command is meant to expand remotely
"${TS[@]}" ssh "$MAC_HOST" "${SSH_ARGS[@]}" "
set -euo pipefail
cd '$REMOTE_DIR'
export JAVA_HOME=$JAVA_HOME_REMOTE
export ANDROID_HOME=\$HOME/Library/Android/sdk
export ANDROID_SDK_ROOT=\$ANDROID_HOME
export ANDROID_SERIAL='$DEVICE_SERIAL'
export PATH=\$JAVA_HOME/bin:\$ANDROID_HOME/platform-tools:\$PATH
printf 'sdk.dir=%s\n' \"\$ANDROID_HOME\" > local.properties

# mkdir is the atomic primitive macOS ships without extra tools. A lock whose
# owning process is gone is stale and gets reclaimed rather than waited on.
lock=$LOCK_DIR
waited=0
while ! mkdir \"\$lock\" 2>/dev/null; do
  owner=\$(cat \"\$lock/pid\" 2>/dev/null || echo)
  if [ -n \"\$owner\" ] && ! kill -0 \"\$owner\" 2>/dev/null; then
    rm -rf \"\$lock\"
    continue
  fi
  sleep 5
  waited=\$((waited + 5))
  if [ \$waited -ge $LOCK_TIMEOUT ]; then
    echo \"timed out after \${waited}s waiting for \$lock\" >&2
    exit 75
  fi
done
echo \$\$ > \"\$lock/pid\"

# The lock has to be released on every path, but a bare \`trap ... EXIT\` would
# make the shell exit with the trap's status and report a failed Gradle run as
# success. Release explicitly and re-raise Gradle's own exit code.
#
# The remote shell is zsh, where \`status\` is a read-only alias for \`?\` —
# assigning to it fails silently under \`set +e\` and the exit code becomes the
# preceding command's. Hence \`gradle_status\`.
set +e
./gradlew --no-daemon --max-workers=3$remote_args
gradle_status=\$?
set -e
rm -rf \"\$lock\"
printf '\\n__PIPOD_GRADLE_EXIT__=%s\\n' \"\$gradle_status\"
exit \$gradle_status
" 2>&1 | tee "$remote_log"
transport_status=${PIPESTATUS[0]}
set -e
result=$(grep -E '^__PIPOD_GRADLE_EXIT__=[0-9]+$' "$remote_log" | tail -n1 || true)
if [[ -z "$result" ]]; then
  echo 'Remote build returned no completion marker; treating it as failed.' >&2
  exit 1
fi
if [[ "$transport_status" -ne 0 ]]; then exit "$transport_status"; fi
exit "${result#__PIPOD_GRADLE_EXIT__=}"
