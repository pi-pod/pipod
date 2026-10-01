#!/usr/bin/env node
// Reviewed real filesystem/persistence/executable/HTTP/WebSocket boundaries.
// Mixed unit/integration files are deliberately not selected. See docs/ci-validation.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'archive-objectstore.test.ts',
  'dr-snapshot.test.ts',
  'image-extraction-confinement.test.ts',
  'image-integrity.test.ts',
  'loadtest-entrypoints.test.ts',
  'metrics-ws.test.ts',
  'overlay.test.ts',
  'registry-auth.test.ts',
  'upload-limit-http.test.ts',
  'usage-ledger.test.ts',
  'usage-snapshot-scale.test.ts',
].map(name => `test/${name}`);
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--list')) {
  console.error('only --list is supported'); process.exit(2);
}
if (!files.length || files.some(path => !existsSync(new URL(`../${path}`, import.meta.url)))) {
  console.error('reviewed integration input missing'); process.exit(2);
}
if (process.argv[2] === '--list') console.log(files.join('\n'));
else {
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}
