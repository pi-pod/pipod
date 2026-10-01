#!/usr/bin/env bash
# Drive the agent-owned emulator on the shared build Mac.
#
# The emulator lives on the Mac next to the Gradle build, so every adb command
# is issued over ssh against one pinned serial. Pinning matters: the Mac is
# shared, and a bare `adb shell` would happily drive somebody else's device.
#
#   device.sh install                 # install the debug APK built by mac-build.sh
#   device.sh launch [extras...]      # cold-start MainActivity, optional -e KEY VALUE
#   device.sh link <uri>              # deliver a pipod:// deep link
#   device.sh shot <name>             # screenshot -> ./manual-evidence/<name>.png
#   device.sh tap <x> <y>             # tap in device pixels
#   device.sh text <string>           # type into the focused field
#   device.sh key <keycode>           # e.g. BACK, ENTER, APP_SWITCH
#   device.sh swipe <x1> <y1> <x2> <y2> [ms]
#   device.sh ui                      # dump the accessibility tree
#   device.sh find [substring]        # named nodes with tap coordinates
#   device.sh log [lines]             # recent logcat for this app
#   device.sh reverse                 # (re)establish the test-backend forwards
#   device.sh stop                    # force-stop the app
#   device.sh adb <args...>           # anything else, against the pinned serial
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
SERIAL="${PIPOD_DEVICE_SERIAL:-emulator-5554}"
REMOTE_DIR="${PIPOD_MAC_WORKDIR:-work/pi-pod-android}"
REMOTE_SHOTS="${PIPOD_MAC_SHOTS:-work/pi-pod-android-shots}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_SHOTS="${PIPOD_EVIDENCE_DIR:-$here/manual-evidence}"

remote() {
  local encoded remote_log transport_status result
  encoded=$(printf '%s' "export PATH=\$HOME/Library/Android/sdk/platform-tools:\$PATH; $*" | base64 | tr -d '\n')
  remote_log=$(mktemp)
  # Keep the completion marker on stderr so screenshot stdout remains a PNG.
  # shellcheck disable=SC2029
  if "${TS[@]}" ssh "$MAC_HOST" "${SSH_ARGS[@]}" \
    "printf '%s' '$encoded' | base64 --decode | /bin/bash; pipod_exit=\$?; printf '\\n__PIPOD_DEVICE_EXIT__=%s\\n' \"\$pipod_exit\" >&2" \
    2>"$remote_log"; then transport_status=0; else transport_status=$?; fi
  result=$(grep -E '^__PIPOD_DEVICE_EXIT__=[0-9]+$' "$remote_log" | tail -n1 || true)
  sed '/^__PIPOD_DEVICE_EXIT__=/d' "$remote_log" >&2
  rm -f "$remote_log"
  if [[ -z "$result" ]]; then
    echo 'Remote device command returned no completion marker; treating it as failed.' >&2
    return 1
  fi
  if [[ "$transport_status" -ne 0 ]]; then return "$transport_status"; fi
  return "${result#__PIPOD_DEVICE_EXIT__=}"
}

adb_() { remote "adb -s $SERIAL $*"; }

cmd="${1:-}"
shift || true

case "$cmd" in
  install)
    adb_ "install -r -t '$REMOTE_DIR/app/build/outputs/apk/debug/app-debug.apk'"
    ;;
  launch)
    extras=""
    while [ $# -gt 0 ]; do extras="$extras $1"; shift; done
    adb_ "shell am force-stop com.pipod"
    adb_ "logcat -c"
    adb_ "shell am start -n com.pipod/com.pipod.app.MainActivity -a android.intent.action.MAIN$extras"
    ;;
  link)
    adb_ "shell am start -a android.intent.action.VIEW -d '$1' com.pipod"
    ;;
  shot)
    name="${1:?usage: device.sh shot <name>}"
    mkdir -p "$LOCAL_SHOTS"
    remote "mkdir -p ~/$REMOTE_SHOTS"
    adb_ "exec-out screencap -p" > "$LOCAL_SHOTS/$name.png"
    echo "$LOCAL_SHOTS/$name.png"
    ;;
  tap)    adb_ "shell input tap $1 $2" ;;
  text)   adb_ "shell input text '$(printf '%s' "$1" | sed "s/ /%s/g")'" ;;
  key)    adb_ "shell input keyevent $1" ;;
  swipe)  adb_ "shell input swipe $1 $2 $3 $4 ${5:-300}" ;;
  ui)     adb_ "exec-out uiautomator dump /dev/tty" ;;
  find)
    # The accessibility tree with a tap coordinate per named node. Driving the
    # app by name rather than by pixel is what makes a screenshot-based pass
    # repeatable when a layout shifts by a few dp.
    adb_ "exec-out uiautomator dump /dev/tty" | python3 -c '
import re, sys
needle = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
for node in re.finditer(r"<node[^>]*>", sys.stdin.read()):
    n = node.group(0)
    text = re.search(r"text=\"([^\"]*)\"", n)
    desc = re.search(r"content-desc=\"([^\"]*)\"", n)
    box = re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", n)
    label = (text.group(1) if text else "") or (desc.group(1) if desc else "")
    if not label or not box:
        continue
    if needle and needle not in label.lower():
        continue
    x = (int(box.group(1)) + int(box.group(3))) // 2
    y = (int(box.group(2)) + int(box.group(4))) // 2
    print(f"{x}\t{y}\t{label}")
' "${1:-}"
    ;;
  log)    adb_ "logcat -d -t ${1:-200}" ;;
  reverse)
    # The isolated test backend and the throwaway OIDC issuer are both reachable
    # on the Mac's loopback; the emulator needs its own forward for each. The
    # issuer must be 127.0.0.1 rather than 10.0.2.2 — the client refuses plain
    # HTTP to anything that is not loopback, and 10.0.2.2 is not.
    adb_ "reverse tcp:18082 tcp:18082"
    adb_ "reverse tcp:18094 tcp:18094"
    adb_ "reverse --list"
    ;;
  stop)   adb_ "shell am force-stop com.pipod" ;;
  clear)  adb_ "shell pm clear com.pipod" ;;
  adb)    adb_ "$*" ;;
  *)
    sed -n '2,25p' "${BASH_SOURCE[0]}"
    exit 64
    ;;
esac
