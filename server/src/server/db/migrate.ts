import * as fs from "node:fs";
import * as path from "node:path";
import { initPool, closePool, tx } from "./index.js";

/** Prefer the process working directory so the Docker image path stays stable. */
export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), "migrations");
}

/** The squashed schema a fresh database starts from. */
const BASELINE = "000_baseline.sql";
/** First and last migrations of the pre-split chain the baseline replaces. */
const LEGACY_FIRST = "001_init.sql";
const LEGACY_LAST = "123_cancel_stuck_restore_job.sql";

/**
 * The migrations a deployment runs: every `.sql` file in `dirs`, a name appearing in only
 * one directory, minus `omit` — for a deployment whose own chain already built what those
 * files create.
 */
export interface MigrationSet {
  dirs: readonly string[];
  omit?: readonly string[];
}

/** Applies, in name order, each migration not yet recorded in `schema_migrations`. */
export async function migrate(
  databaseUrl: string,
  source: string | MigrationSet = defaultMigrationsDir(),
): Promise<string[]> {
  const set = typeof source === "string" ? { dirs: [source] } : source;
  const paths = migrationPaths(set.dirs, new Set(set.omit ?? []));
  initPool(databaseUrl);
  const applied: string[] = [];
  try {
    await tx(async (c) => {
      await c.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
    });
    const files = [...paths.keys()].sort();
    if (paths.has(BASELINE)) await adoptLegacyLedger();
    for (const file of files) {
      await tx(async (c) => {
        const seen = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if ((seen.rowCount ?? 0) > 0) return;
        await c.query(fs.readFileSync(paths.get(file)!, "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        applied.push(file);
      });
    }
  } finally {
    await closePool();
  }
  return applied;
}

/** The migration names `set` ships, in the order they apply. */
export function shippedMigrations(set: MigrationSet): string[] {
  return [...migrationPaths(set.dirs, new Set(set.omit ?? [])).keys()].sort();
}

/**
 * Whether a migration recorded in `schema_migrations` belongs to a release that ships
 * `shipped`: it ships the file, or ships the baseline that folded the pre-split chain in.
 */
export function knownMigration(name: string, shipped: ReadonlySet<string>): boolean {
  return shipped.has(name) || (shipped.has(BASELINE) && name <= LEGACY_LAST);
}

function migrationPaths(dirs: readonly string[], omit: ReadonlySet<string>): Map<string, string> {
  const paths = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !omit.has(f))) {
      if (paths.has(file)) throw new Error(`migration ${file} exists in more than one directory`);
      paths.set(file, path.join(dir, file));
    }
  }
  return paths;
}

/**
 * A database migrated by the pre-split chain already has the baseline schema: record the
 * baseline as applied instead of running it. A chain that stopped partway is refused,
 * because the baseline cannot finish it.
 */
async function adoptLegacyLedger(): Promise<void> {
  await tx(async (c) => {
    const rows = await c.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name = ANY($1::text[])",
      [[BASELINE, LEGACY_FIRST, LEGACY_LAST]],
    );
    const seen = new Set(rows.rows.map((row) => row.name));
    if (seen.has(BASELINE) || !seen.has(LEGACY_FIRST)) return;
    if (!seen.has(LEGACY_LAST)) {
      throw new Error(`this database stopped partway through the pre-split migrations; ` +
        `finish them with a release that still ships ${LEGACY_LAST}, then upgrade`);
    }
    await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [BASELINE]);
  });
}
