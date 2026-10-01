#!/usr/bin/env node
/**
 * Create a tenant organization and grant it the `pipod` project with every
 * role key, so its members can be assigned permission roles (or a bundle).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOrganization, ensureProjectGrant, requireProject } from "./zitadel-admin.mjs";

const [name] = process.argv.slice(2);
if (!name) {
  console.error("usage: node provision-org.mjs <organization-name>");
  process.exit(2);
}

const contract = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../project/pipod-project.json"),
    "utf8",
  ),
);
const roleKeys = contract.roles.map((role) => role.key);

const project = await requireProject();
const org = await ensureOrganization({ name });
console.log(`organization ${name} (${org.id})${org.existed ? " already existed" : ""}`);
const grant = await ensureProjectGrant(project.id, org.id, roleKeys);
console.log(`project grant ${grant.grantId} (${grant.created ? "created" : "up to date"})`);
console.log("done. invite members in the Zitadel Console, then grant them `member` roles (see grant-org-admin.sh).");
