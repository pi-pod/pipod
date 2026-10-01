#!/usr/bin/env bash
# Builds the static sandbox init bind-mounted into every sandbox (src/runtime/init/pps-init.c).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/bin"
cc -static -Os -Wall -Wextra -o "$ROOT/bin/pps-init" "$ROOT/src/runtime/init/pps-init.c"
strip "$ROOT/bin/pps-init" 2>/dev/null || true
echo "built $ROOT/bin/pps-init ($(stat -c%s "$ROOT/bin/pps-init") bytes)"
