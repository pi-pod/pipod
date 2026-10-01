#!/usr/bin/env node
/**
 * Idempotent domain-ID backfill. Maps exported WorkOS entities to imported
 * Zitadel IDs. Email matching is a migration aid only — never a runtime key.
 *
 * Copies each snapshot row to the Zitadel id, remaps every public-schema
 * column that stores that user/org id, then deletes the old row.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node zitadel/scripts/backfill-ids.mjs mapping.json
 */
import * as fs from "node:fs";
import pg from "pg";

const mappingPath = process.argv[2];
if (!mappingPath) {
  console.error("usage: node backfill-ids.mjs <mapping.json>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const USER_COLUMNS = ["user_id", "actor_id", "created_by", "updated_by", "resolved_by", "owner_user_id"];
const report = { users: 0, organizations: 0, skipped: [], errors: [] };

async function columnsNamed(names) {
  const rows = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = ANY($1::text[])`,
    [names],
  );
  return rows.rows;
}

async function remap(table, column, from, to) {
  if (from === to) return;
  await client.query(`UPDATE ${quote(table)} SET ${quote(column)} = $2 WHERE ${quote(column)} = $1`, [from, to]);
}

function quote(ident) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`refusing to quote ${ident}`);
  return `"${ident}"`;
}

try {
  await client.query("BEGIN");
  const orgCols = await columnsNamed(["org_id"]);
  const userCols = await columnsNamed(USER_COLUMNS);

  for (const org of mapping.organizations ?? []) {
    const found = await client.query(
      `SELECT id FROM organizations
       WHERE id::text = $1
          OR name = $2
       ORDER BY CASE WHEN id::text = $1 THEN 0 ELSE 1 END
       LIMIT 2`,
      [org.workosId, org.name],
    );
    if (found.rows.length === 0) {
      report.skipped.push({ kind: "organization", workosId: org.workosId, reason: "not found" });
      continue;
    }
    if (found.rows.length > 1 && found.rows[0].id !== org.workosId) {
      report.skipped.push({ kind: "organization", workosId: org.workosId, reason: "ambiguous name" });
      continue;
    }
    const oldId = found.rows[0].id;
    if (oldId === org.zitadelId) continue;
    await client.query(
      `INSERT INTO organizations (id, name, alias, created_at, updated_at)
       SELECT $2, name, alias, created_at, now()
       FROM organizations WHERE id = $1
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, alias = COALESCE(EXCLUDED.alias, organizations.alias)`,
      [oldId, org.zitadelId],
    );
    for (const col of orgCols) {
      if (col.table_name === "organizations") continue;
      await remap(col.table_name, col.column_name, oldId, org.zitadelId);
    }
    await client.query("DELETE FROM organizations WHERE id = $1", [oldId]);
    report.organizations += 1;
  }

  for (const user of mapping.users ?? []) {
    const found = await client.query(
      `SELECT id FROM users
       WHERE email = $1 OR id::text = $2
       ORDER BY CASE WHEN id::text = $2 THEN 0 ELSE 1 END`,
      [user.email, user.workosId],
    );
    if (found.rows.length !== 1) {
      report.skipped.push({
        kind: "user",
        email: user.email,
        reason: found.rows.length === 0 ? "not found" : "email collision",
      });
      continue;
    }
    const oldId = found.rows[0].id;
    if (oldId === user.zitadelId) continue;
    await client.query(
      `INSERT INTO users (id, email, display_name, created_at, updated_at)
       SELECT $2, email, display_name, created_at, now()
       FROM users WHERE id = $1
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
      [oldId, user.zitadelId],
    );
    for (const col of userCols) {
      if (col.table_name === "users") continue;
      await remap(col.table_name, col.column_name, oldId, user.zitadelId);
    }
    await client.query("DELETE FROM users WHERE id = $1", [oldId]);
    report.users += 1;
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  report.errors.push(String(error));
  console.log(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await client.end();
}

console.log(JSON.stringify(report, null, 2));
console.log("email was used only as a migration aid; runtime auth uses Zitadel token ids.");
