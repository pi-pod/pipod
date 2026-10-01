#!/usr/bin/env bash
# Build on the target Linux architecture/glibc and the deployed Node major (native addons).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Linux ]] || { echo 'native package requires Linux' >&2; exit 1; }
npm run build
bash scripts/build-init.sh
mkdir -p artifacts
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a dist "$STAGE/dist"
mkdir "$STAGE/bin"
cp bin/pps-init "$STAGE/bin/pps-init"
cp package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund
  # Fail packaging, rather than deployment, if native install scripts were suppressed
  # or an addon was built for a different ABI.
  node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import pty from 'node-pty';
const db = new Database(':memory:');
db.prepare('SELECT 1').get();
db.close();
const terminal = pty.spawn('/bin/true', [], { name: 'xterm', cols: 80, rows: 24 });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('native pty smoke timed out')), 5000);
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    exitCode === 0 ? resolve() : reject(new Error(`native pty smoke exited ${exitCode}`));
  });
});
NODE
)
node --input-type=module - "$STAGE" <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
fs.writeFileSync(`${process.argv[2]}/BUILD.json`, JSON.stringify({
  revision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], {encoding:'utf8'}).trim().length > 0,
  node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
}, null, 2) + '\n');
NODE
NAME="$(node -p "'pi-pod-sandbox-native-' + require('./package.json').version + '-linux-' + process.arch")"
tar -czf "artifacts/$NAME.tar.gz" -C "$STAGE" .
(cd artifacts && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
printf 'artifacts/%s.tar.gz\n' "$NAME"
