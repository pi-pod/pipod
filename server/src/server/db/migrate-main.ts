/**
 * Production/one-shot migration entrypoint.
 * Prefer MIGRATION_DATABASE_URL (owner role); fall back to DATABASE_URL for local dev.
 */
import { migrate } from "./migrate.js";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  process.exit(1);
}

migrate(url)
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
