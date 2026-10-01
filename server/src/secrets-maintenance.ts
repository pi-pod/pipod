/**
 * Operator CLI for encrypted-secret key lifecycle (secure-secrets plan Phase 3):
 *
 *   npm run secrets:maintenance -- status [--batch-size N]
 *   npm run secrets:maintenance -- verify [--batch-size N]
 *   npm run secrets:maintenance -- migrate [--batch-size N]
 *   npm run secrets:maintenance -- rewrap [--batch-size N]
 *
 * - status: count records by table, envelope format, and key id; flag key ids with
 *   no configured KEK (retirement readiness). Read-only, always exits 0.
 * - verify: authenticate every record against its trusted row identity. Exits 1
 *   when any row fails; reports opaque row ids and counts, never values.
 * - migrate: convert legacy v1 envelopes to context-bound v2 under the current KEK.
 *   Resumable/idempotent; exits 1 when failures remain.
 * - rewrap: re-wrap v2 rows still on a retired KEK under the current KEK, without
 *   payload re-encryption. Resumable/idempotent; exits 1 when failures remain.
 *
 * Environment: DATABASE_URL (or MIGRATION_DATABASE_URL), SECRETS_KEK (base64 of 32
 * bytes, same format as the server), SECRETS_KEK_ID (default "kek-1"), and
 * SECRETS_KEK_PREVIOUS (JSON {"<key id>": "<base64 key>"}, default {}).
 * Rotation runbook: move the current pair into SECRETS_KEK_PREVIOUS, point
 * SECRETS_KEK/SECRETS_KEK_ID at the new key, run migrate + rewrap to zero, verify,
 * and only then drop the retired key. `status` shows remaining references.
 *
 * All output is metadata (tables, counts, key ids, opaque row ids, fixed failure
 * codes). Plaintext values and raw crypto errors never reach stdout/stderr.
 */
import { closePool, initPool } from "./server/db/index.js";
import { EnvKekProvider } from "./server/secrets/crypto.js";
import {
  assertConfiguredKeyReferences,
  collectInventory,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MissingKeyReferencesError,
  migrateLegacyEnvelopes,
  rewrapToCurrentKek,
  verifyEncryptedRecords,
  type InventoryReport,
  type RowFailure,
} from "./server/secrets/maintenance.js";

const USAGE = `usage: secrets:maintenance <command> [--batch-size N]

  status                 count records by table, format, and key id
  verify                 authenticate every record (exit 1 on any failure)
  migrate                convert legacy v1 envelopes to context-bound v2
  rewrap                 re-wrap v2 rows from retired KEKs onto the current KEK

options:
  --batch-size N         rows per transaction, 1-${MAX_BATCH_SIZE} (default ${DEFAULT_BATCH_SIZE})

Run migrate/rewrap during low traffic: batches take short row locks and yield to
concurrent writers via SKIP LOCKED, but a busy refresh loop slows them down.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function loadKek(): EnvKekProvider {
  const current = process.env["SECRETS_KEK"];
  if (!current) fail("SECRETS_KEK is required (base64 of 32 bytes, as produced by `openssl rand -base64 32`)");
  const keyId = process.env["SECRETS_KEK_ID"] ?? "kek-1";
  const rawPrevious = (process.env["SECRETS_KEK_PREVIOUS"] ?? "").trim();
  let previous: Record<string, string> = {};
  if (rawPrevious.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawPrevious);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      previous = parsed as Record<string, string>;
    } catch {
      fail('SECRETS_KEK_PREVIOUS must be a JSON object of {"<key id>": "<base64 32-byte key>"}');
    }
  }
  if (!keyId || Object.hasOwn(previous, keyId) || Object.values(previous).some((value) => typeof value !== "string")) {
    fail("invalid KEK configuration: key IDs must be nonempty and previous keys must be retired string values");
  }
  try {
    return new EnvKekProvider(keyId, current, previous);
  } catch {
    fail("invalid KEK configuration: keys must be non-placeholder 32-byte canonical base64 values");
  }
}

function parseArgs(argv: string[]): { command: string; batchSize: number } {
  let command: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
        fail(`--batch-size must be an integer between 1 and ${MAX_BATCH_SIZE}\n\n${USAGE}`);
      }
      batchSize = parsed;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (!command && !arg.startsWith("-")) {
      command = arg;
    } else {
      fail(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  if (!command) fail(USAGE);
  if (!["status", "verify", "migrate", "rewrap"].includes(command)) {
    fail(`unknown command "${command}"\n\n${USAGE}`);
  }
  return { command: command!, batchSize };
}

function printInventory(report: InventoryReport, currentKeyId: string): void {
  console.log(`current KEK id: ${currentKeyId}`);
  console.log(`table               rows    v1    v2  key ids`);
  for (const t of report.tables) {
    if (!t.present) {
      console.log(`${t.table.padEnd(18)}  (absent)`);
      continue;
    }
    const v1 = t.byVersion[1] ?? 0;
    const v2 = t.byVersion[2] ?? 0;
    const keys = Object.entries(t.byKeyId)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, n]) => `${id}(${n})${t.unconfiguredKeyIds.includes(id) ? "!" : ""}`)
      .join(" ");
    console.log(
      `${t.table.padEnd(18)}  ${String(t.total).padStart(5)}  ${String(v1).padStart(4)}  ${String(v2).padStart(4)}  ${keys}`,
    );
    for (const id of t.unconfiguredKeyIds) {
      console.log(`  ! key id "${id}" has no configured KEK (${t.byKeyId[id]} rows): retirement blocked`);
    }
  }
}

function printFailures(label: string, failures: RowFailure[]): void {
  if (failures.length === 0) return;
  console.log(`${label} (${failures.length} shown, ids are opaque primary keys):`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  ${f.table} ${f.id} ${f.code}`);
  }
}

async function run(argv: string[]): Promise<void> {
  const { command, batchSize } = parseArgs(argv);
  const databaseUrl = process.env["MIGRATION_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!databaseUrl) fail("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  const kek = loadKek();
  initPool(databaseUrl);
  try {
    if (command === "status") {
      const report = await collectInventory(kek);
      printInventory(report, kek.keyId);
      return;
    }
    // verify/migrate/rewrap only make sense when every referenced key is present:
    // otherwise every row under a missing key fails at once and buries real damage.
    try {
      await assertConfiguredKeyReferences(kek);
    } catch (error) {
      if (!(error instanceof MissingKeyReferencesError)) throw error;
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    if (command === "verify") {
      const report = await verifyEncryptedRecords(kek, { batchSize });
      console.log(`verify: checked=${report.checked} ok=${report.ok} failed=${report.failed}`);
      printFailures("failures", report.failures);
      if (report.failed > 0) process.exit(1);
      return;
    }
    if (command === "migrate") {
      const report = await migrateLegacyEnvelopes(kek, { batchSize });
      console.log(
        `migrate: scanned=${report.scanned} migrated=${report.migrated} ` +
          `contended=${report.contended} failed=${report.failed} ` +
          `remaining=${report.remaining}`,
      );
      printFailures("failures", report.failures);
      if (report.contended > 0 || report.remaining > 0) {
        console.log("re-run to pick up contended or locked rows; concurrent writers yield via row locks");
      }
      if (report.failed > 0 || report.remaining > 0) process.exit(1);
      return;
    }
    const report = await rewrapToCurrentKek(kek, { batchSize });
    console.log(
      `rewrap: scanned=${report.scanned} rewrapped=${report.rewrapped} ` +
        `contended=${report.contended} failed=${report.failed} remaining=${report.remaining} ` +
        `pendingLegacy=${report.pendingLegacy}`,
    );
    printFailures("failures", report.failures);
    if (report.pendingLegacy > 0) {
      console.log(
        `refusing success: ${report.pendingLegacy} legacy row(s) still need "migrate" first; ` +
          "retiring the old key now would strand them",
      );
    }
    if (report.contended > 0 || report.remaining > 0) {
      console.log("re-run to pick up contended or locked rows; concurrent writers yield via row locks");
    }
    if (report.failed > 0 || report.remaining > 0 || report.pendingLegacy > 0) process.exit(1);
  } finally {
    await closePool();
  }
}

try {
  await run(process.argv.slice(2));
} catch {
  // Database/client errors can contain connection credentials or arbitrary data.
  // Only the explicitly typed, metadata-only missing-reference error is printable.
  console.error("secrets maintenance failed; check database connectivity, migrations, and key configuration");
  process.exitCode = 1;
}
