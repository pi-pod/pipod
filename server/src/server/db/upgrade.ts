/**
 * Boot-time database upgrade for deployments where the server owns its own upgrades
 * (`UPGRADE_ON_START`): the self-hosted Compose bundle runs exactly one server container and
 * Compose stops the old one before it starts the new one, so the booting process is the only
 * writer. Production keeps this off; its deploy pipeline migrates with an owner role and opens
 * the launch gate as separate, verified steps.
 */
import { closePool, initPool, query } from "./index.js";
import { knownMigration, migrate, MigrationPathError, shippedMigrations, type MigrationSet } from "./migrate.js";
import {
  LAUNCH_RECOVERY_PROTOCOL_VERSION,
  readLaunchControl,
  transitionLaunchControl,
} from "../pods/launch-control.js";

/**
 * How the database compares with the migrations this build ships. `ahead` means a newer release
 * has already migrated it (it holds migrations this build does not know), whether or not some of
 * this build's migrations are also missing.
 */
export interface SchemaStatus {
  state: "current" | "behind" | "ahead";
  pending: string[];
  unknown: string[];
}

interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Needs an initialized pool. A database that was never migrated has every migration pending. */
export async function readSchemaStatus(set: MigrationSet): Promise<SchemaStatus> {
  const shipped = shippedMigrations(set);
  const exists = await query<{ relation: string | null }>(
    `SELECT to_regclass('public.schema_migrations')::text AS relation`,
  );
  const applied = exists.rows[0]?.relation
    ? (await query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((row) => row.name)
    : [];
  const appliedSet = new Set(applied);
  const shippedSet = new Set(shipped);
  const pending = shipped.filter((name) => !appliedSet.has(name)).sort();
  const unknown = applied.filter((name) => !knownMigration(name, shippedSet)).sort();
  return {
    state: unknown.length > 0 ? "ahead" : pending.length > 0 ? "behind" : "current",
    pending,
    unknown,
  };
}

/**
 * Bring the database to this release, then open a launch gate that a migration left held.
 *
 * Throws, so the process exits before serving, when a newer release already migrated the
 * database: running older code against it is how a rollback without a restore corrupts data.
 * A gate held by an operator (any actor other than the migration) is left alone, and a gate the
 * database refuses to open (unaccounted launches, unfinished host operations) stays held with
 * the reason logged — the server still starts, as it does in production.
 */
export async function upgradeOnStart(
  databaseUrl: string,
  /** The migrations this deployment runs (the edition's). */
  migrations: MigrationSet,
  /** This build's source commit, recorded against opening the gate; null leaves it held. */
  revision: string | null,
  log: Log,
): Promise<void> {
  initPool(databaseUrl);
  try {
    const status = await readSchemaStatus(migrations);
    if (status.state === "ahead") {
      // Logged here because the startup handler deliberately prints no exception text.
      const message =
        `this database was upgraded by a newer pi pod release: it has ${status.unknown.length} ` +
        `migration(s) this release does not ship (${status.unknown.slice(0, 3).join(", ")}). ` +
        "Run that release again, or restore the backup taken before the upgrade.";
      log.error(message);
      throw new Error(message);
    }
  } finally {
    await closePool();
  }

  const applied = await migrate(databaseUrl, migrations).catch((error: unknown) => {
    log.error(
      error instanceof MigrationPathError
        ? error.message
        : "applying migrations failed; run `node dist/migrate.js` in this image for the database error",
    );
    throw error;
  });
  log.info(applied.length ? `migrations applied: ${applied.join(", ")}` : "database schema is current");

  initPool(databaseUrl);
  try {
    await openGateHeldByMigration(revision, log);
  } finally {
    await closePool();
  }
}

async function openGateHeldByMigration(revision: string | null, log: Log): Promise<void> {
  const gate = await readLaunchControl();
  if (gate.mode === "open") return;
  if (gate.actor !== "migration") {
    log.warn(`launch admission is held by ${gate.actor} (${gate.reason_code}); leaving it held`);
    return;
  }
  if (!revision) {
    log.warn(
      "launch admission is held by a migration, and this build has no source revision to record " +
        "against opening it (set the SOURCE_SHA build argument). Open it by hand: " +
        "node dist/fleet.js launch-gate open --actor <you> --reason upgrade --source-sha <40-hex commit>",
    );
    return;
  }
  try {
    const opened = await transitionLaunchControl({
      mode: "open",
      expectedEpoch: Number(gate.epoch),
      protocolVersion: LAUNCH_RECOVERY_PROTOCOL_VERSION,
      sourceSha: revision,
      actor: "upgrade-on-start",
      reasonCode: "upgrade_on_start",
    });
    log.info(`launch admission opened after the upgrade (epoch ${opened.epoch})`);
  } catch (error) {
    log.error(
      `launch admission stays held: ${error instanceof Error ? error.message : String(error)}; ` +
        "inspect it with node dist/fleet.js launch-gate status",
    );
  }
}
