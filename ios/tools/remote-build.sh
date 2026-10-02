#!/usr/bin/env bash
# Build PiPod on the shared remote Mac.
#
# For developing on Linux, where no iOS toolchain exists: builds run on a Mac
# reached over Tailscale SSH (PIPOD_MAC_HOST=user@host). On a Mac, build locally
# instead. The Mac may be shared with other agents: this script keeps to its own work directory and an exclusively coordinated simulator, and
# never touches `booted`, `shutdown all`, or Device Hub's lifecycle.
#
#   tools/remote-build.sh sync              # rsync the repo to the Mac
#   tools/remote-build.sh project           # regenerate PiPod.xcodeproj there
#   tools/remote-build.sh build             # build for the simulator
#   tools/remote-build.sh all               # sync + project + build
set -euo pipefail

MAC_HOST="${PIPOD_MAC_HOST:?Set PIPOD_MAC_HOST to user@host of a Mac on your tailnet}"
REMOTE_DIR="${PIPOD_REMOTE_DIR:-work/pipod-ios-native}"
SIM_NAME="${PIPOD_SIM_NAME:-Agent iPhone}"
SIM_DEVICE="${PIPOD_SIM_DEVICE:-iPhone 17}"
SIM_RUNTIME="${PIPOD_SIM_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}"
TS=(tailscale)
if [[ -n ${TAILSCALE_SOCKET:-} ]]; then TS+=(--socket="$TAILSCALE_SOCKET"); fi
SSH_ARGS=(-o BatchMode=yes)
# The macOS wrapper does not add a userspace pipe; keep the selected node identity.
if [[ -n ${TAILSCALE_SOCKET:-} && $(uname -s) == Darwin ]]; then
  printf -v proxy '%q ' "${TS[@]}" nc
  SSH_ARGS+=(-o "ProxyCommand=${proxy}%h %p")
fi
SCHEME=PiPod
BUNDLE_ID=com.pipod.app
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mac() {
  # Some Tailscale SSH versions lose the remote exit status. Require our own
  # marker so a failed build can never be reported as green by that transport.
  local encoded output transport_status result
  encoded=$(printf '%s' "$*" | base64 | tr -d '\n')
  output=$(mktemp)
  set +e
  # shellcheck disable=SC2029
  "${TS[@]}" ssh "$MAC_HOST" "${SSH_ARGS[@]}" \
    "set -o pipefail; printf '%s' '$encoded' | base64 --decode | /bin/bash; pipod_exit=\$?; printf '\\n__PIPOD_REMOTE_EXIT__=%s\\n' \"\$pipod_exit\"" \
    2>&1 | tee "$output" | sed '/^__PIPOD_REMOTE_EXIT__=/d'
  transport_status=${PIPESTATUS[0]}
  set -e
  result=$(grep -E '^__PIPOD_REMOTE_EXIT__=[0-9]+$' "$output" | tail -n1 || true)
  rm -f "$output"
  if [[ -z "$result" ]]; then
    echo 'Remote command returned no completion marker; treating it as failed.' >&2
    return 1
  fi
  if [[ "$transport_status" -ne 0 ]]; then return "$transport_status"; fi
  return "${result#__PIPOD_REMOTE_EXIT__=}"
}

sync() {
  mac "mkdir -p ~/${REMOTE_DIR}"
  rsync -az --delete \
    --exclude '.git' --exclude 'build' --exclude 'DerivedData' \
    -e "\"${ROOT}/tools/tailscale-rsh.sh\"" \
    "${ROOT}/" "${MAC_HOST}:${REMOTE_DIR}/"
  # The committed PiPod.xcodeproj lists the sources that existed when it was
  # generated. Syncing it over the Mac's copy is how a target silently loses
  # files. Regenerate every time; xcodegen takes well under a second.
  project
}

project() {
  mac "cd ~/${REMOTE_DIR} && /opt/homebrew/bin/xcodegen generate --quiet"
}

destination() {
  # Reuse the Mac's configured device (agent-simulators setup), if it has one, unless an
  # explicitly owned simulator was requested.
  if [[ -z ${PIPOD_SIM_NAME:-} ]]; then
    local configured
    configured=$(mac 'cat "$HOME/.config/agent-simulators/ios-device-udid" 2>/dev/null || true')
    if [[ -n $configured ]]; then echo "$configured"; return; fi
  fi
  # A dedicated device, created on demand. Never `booted`: another agent's
  # simulator would answer to it.
  local udid
  udid=$(mac "xcrun simctl list devices -j" \
    | python3 -c "
import json,sys
data = json.load(sys.stdin)['devices']
for runtime, devices in data.items():
    for device in devices:
        if device['name'] == '${SIM_NAME}' and device['isAvailable']:
            print(device['udid'])
            raise SystemExit
" || true)
  if [ -z "${udid}" ]; then
    udid=$(mac "xcrun simctl create '${SIM_NAME}' '${SIM_DEVICE}' '${SIM_RUNTIME}'")
  fi
  echo "${udid}"
}

# Ad-hoc signing rather than no signing at all. A simulator build with signing
# disabled carries no entitlements, so every Keychain call fails with -34018 and
# the app looks like it forgets your session on relaunch.
SIGNING=(CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES)

build() {
  local udid; udid=$(destination)
  mac "cd ~/${REMOTE_DIR} && xcodebuild -project PiPod.xcodeproj -scheme ${SCHEME} \
    -destination 'platform=iOS Simulator,id=${udid}' \
    -derivedDataPath build ${SIGNING[*]} build"
}

install_and_launch() {
  local udid; udid=$(destination)
  mac "if ! xcrun simctl list devices booted | grep -Fq '${udid}'; then xcrun simctl boot '${udid}'; fi; xcrun simctl bootstatus '${udid}' -b"
  mac 'service="gui/$(id -u)/local.agent.ios-simulator"; if launchctl print "$service" >/dev/null 2>&1; then launchctl kickstart "$service"; fi'
  mac "xcrun simctl install ${udid} ~/${REMOTE_DIR}/build/Build/Products/Debug-iphonesimulator/PiPod.app"
  mac "xcrun simctl launch ${udid} ${BUNDLE_ID} ${*}"
}

case "${1:-all}" in
  sync) sync ;;
  project) project ;;
  build) build ;;
  udid) destination ;;
  run) shift; install_and_launch "$@" ;;
  all) sync; build ;;
  *) echo "usage: $0 {sync|project|build|udid|run|all}" >&2; exit 2 ;;
esac
