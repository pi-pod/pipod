#!/bin/bash
# Drives the Debug app on the booted simulator and saves a screenshot and a UI dump per step.
# Every step is best-effort: a missed tap must not stop the screenshots that follow.
set -u
UDID=$1; OUT=$2; POD_A=$3; POD_B=$4
mkdir -p "$OUT"
n=0
shot() { n=$((n+1)); local name; name=$(printf '%02d-%s' "$n" "$1"); sleep "${2:-1.5}"; xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null 2>&1; axe describe-ui --udid "$UDID" > "$OUT/$name.ui.json" 2>"$OUT/$name.ui.err" || true; echo "shot $name"; }
tap_id() { echo "tap id $1"; axe tap --id "$1" --post-delay 1 --udid "$UDID" 2>&1 | tail -1 || true; }
tap_label() { echo "tap label $1"; axe tap --label "$1" --post-delay 1 --udid "$UDID" 2>&1 | tail -1 || true; }
# The simulator asks before handing a custom-scheme link to the app.
open() { xcrun simctl openurl "$UDID" "$1" || true; sleep 2; axe tap --label "Open" --post-delay 1 --udid "$UDID" >/dev/null 2>&1 || true; }
(axe --help; echo ----; axe tap --help; echo ----; axe swipe --help; echo ----; axe type --help) > "$OUT/axe-help.txt" 2>&1 || true

shot pods 8
# A pod the reader stopped, reopened: it must read as asleep, not unavailable.
open "pipod://pod/$POD_B"; shot stopped-pod 8
tap_label "Wake"; shot after-wake 10
# A pod stopped while the app is attached to it.
open "pipod://pod/$POD_A"; shot attached 8
curl -s -X POST -H "authorization: Bearer $(cat "$WALK_TOKEN_FILE")" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:18081/v1/pods/$POD_A/stop" >/dev/null || true
shot stopped-under-session 8
xcrun simctl spawn "$UDID" log show --last 6m --predicate 'processImagePath CONTAINS "PiPod" AND (eventMessage CONTAINS "Fatal" OR eventMessage CONTAINS "crash" OR messageType == fault)' --style compact 2>/dev/null | tail -40 > "$OUT/app-faults.txt" || true
ls ~/Library/Logs/DiagnosticReports 2>/dev/null | grep -i pipod > "$OUT/crash-reports.txt" || true
echo walk_done
