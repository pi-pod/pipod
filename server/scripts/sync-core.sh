#!/usr/bin/env bash
# Re-vendor the shared protocol/utility subset of pi-pod, plus managed-image
# assets the hosted server can publish.
#
# The shared list lives in scripts/core-manifest.txt, which also records every
# file this script must NOT touch: the server-owned provisioning stack under
# src/core/ (providers, lifecycle, image build, labels, session PTY/RPC, …) and
# the [forked] files that have deliberately diverged. Deleting those from the
# CLI and re-running a full rsync --delete would break the server.
#
# Usage: scripts/sync-core.sh /path/to/pi-pod [commit]
set -euo pipefail
SRC="${1:?path to a pi-pod checkout}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -n "${2:-}" ]]; then
  git -C "$SRC" checkout --quiet "$2"
fi
COMMIT="$(git -C "$SRC" rev-parse HEAD)"

# Shared subset, read from the manifest's [shared] section.
mapfile -t SHARED < <(
  awk '/^\[shared\]/{s=1;next} /^\[/{s=0} s && !/^#/ && NF==2 {print $2}' \
    "$ROOT/scripts/core-manifest.txt"
)
[[ ${#SHARED[@]} -gt 0 ]] || { echo "sync-core: no [shared] entries in core-manifest.txt" >&2; exit 1; }

for rel in "${SHARED[@]}"; do
  src_file="$SRC/src/$rel"
  dest="$ROOT/src/core/$rel"
  if [[ ! -f "$src_file" ]]; then
    echo "sync-core: skip missing $rel (not in pi-pod@$COMMIT)" >&2
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  rsync -a "$src_file" "$dest"
done

rsync -a --delete "$SRC/image/" "$ROOT/image/"
echo "$COMMIT" > "$ROOT/src/core/.pi-pod-source-commit"

node --import tsx "$ROOT/scripts/check-core-sync.ts" --write-hashes
node --import tsx "$ROOT/scripts/check-core-sync.ts" --pi-pod "$SRC"

echo "shared core subset + managed image assets synced to pi-pod@$COMMIT"
echo "note: providers/, lifecycle, image.ts, labels, session/rpc PTY stack are server-owned and were not touched"
