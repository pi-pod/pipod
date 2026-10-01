#!/usr/bin/env node
/**
 * Make a user the administrator of one tenant organization: ORG_OWNER membership
 * (Console self-service for members and grants inside that org only) plus the
 * `owner` bundle expansion as pipod project roles. Never grant instance-level
 * (IAM_*) roles to tenant owners.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  ensureUserGrant,
  findOrgByName,
  findUserByEmail,
  requireOk,
  requireProject,
} from "./zitadel-admin.mjs";

const [email, orgName] = process.argv.slice(2);
if (!email || !orgName) {
  console.error("usage: node grant-org-admin.mjs <user-email> <organization-name>");
  process.exit(2);
}

const contract = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../project/pipod-project.json"),
    "utf8",
  ),
);
const ownerRoles = ["owner", ...contract.roles.filter((r) => r.group === "permission").map((r) => r.key)];

const org = await findOrgByName(orgName);
if (!org) {
  console.error(`organization not found: ${orgName}`);
  process.exit(1);
}
const user = await findUserByEmail(email);
if (!user) {
  console.error(`user not found: ${email}`);
  process.exit(1);
}
// pi pod reads a caller's organization from the token's resource-owner claim and keeps only the
// roles granted by that same organization, so a grant to a user who lives elsewhere is inert.
const home = user.details?.resourceOwner;
if (home && home !== org.id) {
  console.error(
    `${email} belongs to organization ${home}, not ${orgName} (${org.id}). pi pod takes a user's ` +
      "organization from their home organization, so this grant would give them no access: create " +
      `the user inside ${orgName} instead.`,
  );
  process.exit(1);
}
const project = await requireProject();

const membership = await api("POST", "/management/v1/orgs/me/members", { userId: user.userId ?? user.id, roles: ["ORG_OWNER"] }, org.id);
if (!membership.ok && membership.status !== 409) {
  await requireOk(membership, "add ORG_OWNER membership");
}
console.log(`ORG_OWNER on ${orgName} (${org.id}) for ${email}`);

await ensureUserGrant(org.id, user.userId ?? user.id, project.id, ownerRoles);
console.log(`granted pipod roles: ${ownerRoles.join(", ")}`);
console.log("do not grant IAM_OWNER or any instance-level role to tenant owners.");
