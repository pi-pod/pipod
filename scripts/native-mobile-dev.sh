#!/usr/bin/env bash
# Build, install, and launch a DEBUG native client with an ephemeral dev JWT.
# Device selection and platform tooling live here; backend lifecycle stays in Make.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVER_DIR=${SERVER_DIR:-$ROOT/server}
RUN_DIR=${RUN_DIR:-$ROOT/.dev}
SERVER_URL=${SERVER_URL:-http://127.0.0.1:8080}
DEV_USER=${DEV_USER:-018f0000-0000-7000-8000-000000000001}
DEV_ORG=${DEV_ORG:-018f0000-0000-7000-8000-000000000010}
BUNDLE_ID=com.pipod.app
mkdir -p "$RUN_DIR"
TOKEN=$(cd "$SERVER_DIR" && node dev/mint.mjs "$DEV_USER" "$DEV_ORG")
[[ ${#TOKEN} -gt 20 ]] || { echo 'Could not mint a development token' >&2; exit 1; }
case ${1:-} in
  ios)
    IOS_DIR=${IOS_DIR:-$ROOT/ios}
    [[ -f "$IOS_DIR/project.yml" ]] || { echo "Missing native iOS checkout: $IOS_DIR" >&2; exit 1; }
    # Never silently install into an arbitrary booted device on a shared Mac.
    UDID=${SIM_UDID:-}
    if [[ -z "$UDID" ]]; then
      echo 'Set SIM_UDID to your own simulator (xcrun simctl list devices available).' >&2
      exit 1
    fi
    if ! xcrun simctl list devices booted | grep -Fq "$UDID"; then
      xcrun simctl boot "$UDID"
    fi
    if [[ $(id -un) == agent && -x "$HOME/.local/bin/agent-simulators" ]]; then
      launchctl kickstart "gui/$(id -u)/local.agent.ios-simulator"
    elif [[ -d /Applications/Xcode.app/Contents/Applications/DeviceHub.app ]]; then
      open -a /Applications/Xcode.app/Contents/Applications/DeviceHub.app
    else
      open -ga Simulator
    fi
    xcrun simctl bootstatus "$UDID" -b
    (cd "$IOS_DIR" && xcodegen generate)
    xcodebuild -project "$IOS_DIR/PiPod.xcodeproj" -scheme PiPod -configuration Debug \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$RUN_DIR/ios-derived" \
      CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES build
    APP="$RUN_DIR/ios-derived/Build/Products/Debug-iphonesimulator/PiPod.app"
    [[ -d "$APP" ]] || { echo 'Native iOS build did not produce PiPod.app' >&2; exit 1; }
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl install "$UDID" "$APP"
    xcrun simctl launch "$UDID" "$BUNDLE_ID" \
      -PIPOD_SERVER_URL "$SERVER_URL" -PIPOD_DEV_TOKEN "$TOKEN"
    ;;
  android)
    BUNDLE_ID=com.pipod
    ANDROID_DIR=${ANDROID_DIR:-$ROOT/android}
    [[ -x "$ANDROID_DIR/gradlew" ]] || { echo "Missing native Android wrapper: $ANDROID_DIR/gradlew" >&2; exit 1; }
    SERIAL=${ANDROID_SERIAL:-}
    if [[ -z "$SERIAL" ]]; then
      devices=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
      [[ -n "$devices" && $(printf '%s\n' "$devices" | wc -l) -eq 1 ]] || {
        echo 'Set ANDROID_SERIAL to one online device (adb devices).' >&2; exit 1;
      }
      SERIAL=$devices
    fi
    adb -s "$SERIAL" get-state >/dev/null
    [[ $(adb -s "$SERIAL" shell getprop sys.boot_completed | tr -d '\r') == 1 ]] || {
      echo 'Selected Android device has not finished booting' >&2; exit 1;
    }
    (cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug)
    adb -s "$SERIAL" install -r "$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
    DEVICE_URL=${ANDROID_SERVER_URL:-$SERVER_URL}
    # USB devices and emulators can both reach a loopback backend via adb reverse.
    if [[ -z ${ANDROID_SERVER_URL:-} && "$SERVER_URL" =~ ^http://(127\.0\.0\.1|localhost):([0-9]+)(/.*)?$ ]]; then
      PORT=${BASH_REMATCH[2]}
      adb -s "$SERIAL" reverse "tcp:$PORT" "tcp:$PORT"
    fi
    ACTIVITY=$(adb -s "$SERIAL" shell cmd package resolve-activity --brief "$BUNDLE_ID" | tail -n1 | tr -d '\r')
    [[ "$ACTIVITY" == "$BUNDLE_ID/"* ]] || { echo 'Native Android launcher not found' >&2; exit 1; }
    adb -s "$SERIAL" shell am force-stop "$BUNDLE_ID"
    adb -s "$SERIAL" shell am start -n "$ACTIVITY" \
      --es PIPOD_SERVER_URL "$DEVICE_URL" --es PIPOD_DEV_TOKEN "$TOKEN" >/dev/null
    ;;
  *) echo 'Usage: native-mobile-dev.sh ios|android' >&2; exit 2 ;;
esac
printf 'Native %s debug app launched.\n' "$1"
