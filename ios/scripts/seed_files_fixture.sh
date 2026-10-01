#!/bin/bash
# Seeds the files-test fixture into the app's Files-visible Documents folder
# on a simulator: installs (fresh) or upgrades (preserving Documents) the
# given app bundle, resolves its data container, and copies seed.png in.
# The files test picks that file through the document browser under
# On My iPhone, which lists the app only because file sharing declares it.
# Fails closed: a missing fixture must fail the run, never pass it.
set -euo pipefail
UDID="${1:?simulator UDID required}"
APP_PATH="${2:?path to PiPod.app required}"
BUNDLE_ID="com.pipod.app"
test -d "$APP_PATH"
xcrun simctl install "$UDID" "$APP_PATH"
CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
test -n "$CONTAINER"
mkdir -p "$CONTAINER/Documents"
cp PiPodUITests/seed.png "$CONTAINER/Documents/seed.png"
test -f "$CONTAINER/Documents/seed.png"
echo "files fixture seeded into app Documents"
