#!/usr/bin/env node
// Accidental-configuration isolation, not a sandbox for hostile same-user code.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, statSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';

let pgBin, cwd, command;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') { command = args.slice(i + 1); break; }
  if (args[i] === '--pg-bin' && !pgBin) pgBin = args[++i];
  else if (args[i] === '--cwd' && !cwd) cwd = args[++i];
  else fail('expected --pg-bin <absolute-directory> --cwd <checkout> -- <command>');
}
if (process.getuid?.() === 0) fail('refusing root');
if (!pgBin || !isAbsolute(pgBin) || !cwd || !command?.length) fail('explicit PostgreSQL tool directory, checkout, and command required');
try {
  pgBin = realpathSync(pgBin); cwd = realpathSync(cwd);
  if (!statSync(cwd).isDirectory()) fail('checkout must be a directory');
  for (const bin of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    if (!statSync(join(pgBin, bin)).isFile()) fail('missing PostgreSQL executable');
  }
} catch { fail('checkout or PostgreSQL tools unavailable'); }
const baseEnv = { PATH: `${pgBin}:/usr/bin:/bin`, LANG: 'C.UTF-8' };
const versions = ['postgres', 'initdb', 'pg_ctl', 'psql'].map(bin => {
  const r = spawnSync(join(pgBin, bin), ['--version'], { env: baseEnv, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) fail('PostgreSQL version probe failed');
  return r.stdout.trim().match(/\(PostgreSQL\) (\S+)/)?.[1];
});
if (!versions[0] || !versions.every(v => v === versions[0])) fail('PostgreSQL tool versions must agree');
console.log(`PostgreSQL: ${versions[0]}`);
const scratch = mkdtempSync('/tmp/pipod-db-');
const data = join(scratch, 'data');
const owner = randomBytes(16).toString('hex');
const database = `rehearsal_${owner}`;
const password = randomBytes(32).toString('hex');
const env = { ...baseEnv, HOME: scratch, TMPDIR: scratch };
const manifest = { owner, uid: process.getuid(), data, version: versions[0] };
writeFileSync(join(scratch, 'owner.json'), JSON.stringify(manifest), { mode: 0o600 });
const pwFile = join(scratch, 'password');
writeFileSync(pwFile, password + '\n', { mode: 0o600 });
let child, pgid, interrupted = false, timedOut = false, started = false, result = 1, safe = true;
const toolLog = openSync(join(scratch, 'postgres-tools.log'), 'w', 0o600);
process.on('SIGINT', () => { interrupted = true; terminate(); });
process.on('SIGTERM', () => { interrupted = true; terminate(); });
console.log(`owned scratch: ${scratch}`);
try {
  run('initdb', ['-D', data, '-U', 'rehearsal', '--pwfile', pwFile, '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--no-locale', '--encoding=UTF8']);
  const port = await new Promise((resolve, reject) => {
    const s = createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  manifest.port = port;
  writeFileSync(join(scratch, 'owner.json'), JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(join(data, 'rehearsal.conf'), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${scratch}'\nunix_socket_permissions=0700\n`, { mode: 0o600 });
  writeFileSync(join(data, 'postgresql.conf'), readFileSync(join(data, 'postgresql.conf'), 'utf8') + "\ninclude='rehearsal.conf'\n");
  run('pg_ctl', ['-D', data, '-l', join(scratch, 'server.log'), '-w', '-t', '30', 'start']);
  started = true;
  // Authenticated identity check: another process winning the port is NOT ready.
  const connection = { ...env, PGPASSWORD: password };
  const identity = sql('postgres', "SELECT current_user, current_database(), current_setting('port'), current_setting('data_directory'), current_setting('server_version');", connection).trim().split('|');
  if (identity[0] !== 'rehearsal' || identity[1] !== 'postgres' || identity[2] !== String(port) || realpathSync(identity[3]) !== data || !identity[4].startsWith(versions[0])) throw new Error('identity mismatch');
  sql('postgres', `CREATE DATABASE ${database};`, connection);
  const checked = sql(database, 'SELECT current_database();', connection).trim();
  if (checked !== database || interrupted) throw new Error('database identity or interruption');
  const url = `postgresql://rehearsal:${password}@127.0.0.1:${port}/${database}`;
  const commandEnv = { ...env, PATH: `${pgBin}:${process.env.PATH || '/usr/bin:/bin'}`, DATABASE_URL: url, MIGRATION_DATABASE_URL: url };
  const fd = openSync(join(scratch, 'command.log'), 'w', 0o600);
  let timer;
  try {
    result = await new Promise(resolve => {
      child = spawn(command[0], command.slice(1), { cwd, env: commandEnv, detached: true, stdio: ['ignore', fd, fd] });
      pgid = child.pid;
      child.on('error', () => resolve(1));
      child.on('close', (code, signal) => resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : code ?? 1));
      timer = setTimeout(() => { timedOut = true; console.error('command deadline: 300s exceeded; termination started'); terminate(); }, 300_000);
      if (interrupted) terminate();
    });
  } finally { clearTimeout(timer); closeSync(fd); }
  console.log(`command exit: ${result}`);
} catch { console.error('rehearsal failed; private diagnostics retained if cleanup is blocked'); }
finally {
  terminate();
  for (let n = 0; groupAlive() && n < 60; n++) await delay(100);
  if (groupAlive()) { safe = false; console.error('command group termination uncertain'); }
  try {
    const saved = JSON.parse(readFileSync(join(scratch, 'owner.json'), 'utf8'));
    if (saved.owner !== owner || saved.uid !== process.getuid() || saved.data !== data || statSync(scratch).uid !== process.getuid()) throw new Error('ownership mismatch');
    // pg_ctl targets only our fresh data directory. Postmaster PID alone is
    // not sufficient: verify the data path recorded in postmaster.pid too.
    let pid;
    try { pid = readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n'); } catch { /* not started */ }
    if (pid) {
      if (pid[1] !== data || Number(pid[3]) !== manifest.port) throw new Error('postmaster identity mismatch');
      const executable = realpathSync(`/proc/${pid[0]}/exe`);
      const argv = readFileSync(`/proc/${pid[0]}/cmdline`, 'utf8').split('\0');
      if (executable !== realpathSync(join(pgBin, 'postgres')) || !argv.includes(data)) throw new Error('process ownership uncertain');
      if (!safe) throw new Error('child still active');
      run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']);
      try { readFileSync(join(data, 'postmaster.pid')); throw new Error('postmaster still present'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    } else if (started) throw new Error('postmaster shutdown identity uncertain');
  } catch { safe = false; }
  closeSync(toolLog);
  if (safe) rmSync(scratch, { recursive: true, force: true });
  else { result = result || 1; console.error(`cleanup blocked; reconcile ${scratch}`); }
  console.log(`cleanup: ${safe ? 'verified' : 'blocked'}`);
}
process.exitCode = interrupted ? 130 : timedOut && result === 0 ? 124 : result;

function run(bin, argv) {
  const r = spawnSync(join(pgBin, bin), argv, { env, stdio: ['ignore', toolLog, toolLog], timeout: 40_000 });
  if (r.status !== 0) throw new Error('PostgreSQL operation failed');
}
function sql(db, query, connection) {
  const r = spawnSync(join(pgBin, 'psql'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(manifest.port), '-U', 'rehearsal', '-d', db, '-c', query], { env: connection, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error('database identity query failed');
  return r.stdout;
}
function groupAlive() { if (!pgid) return false; try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function terminate() {
  if (!groupAlive()) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const timer = setTimeout(() => { if (groupAlive()) { try { process.kill(-pgid, 'SIGKILL'); } catch {} } }, 3000);
  timer.unref();
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { console.error(message); process.exit(1); }
