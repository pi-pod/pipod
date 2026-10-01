#!/usr/bin/env node
/**
 * Give a person access to pi pod: create them inside a tenant organization (created and
 * granted the `pipod` project on first use) and grant one role bundle — `member`, or with
 * --owner the `owner` bundle plus ORG_OWNER, which lets them manage that organization's
 * members in the Zitadel Console. A new user gets a one-time password, printed once, that
 * Zitadel makes them change at first sign-in. Re-running for an existing user only adds
 * grants and leaves their password alone, unless --new-password asks for a fresh one-time
 * password: without SMTP, Zitadel cannot mail a reset.
 *
 * Reads ZITADEL_URL and ZITADEL_PAT like the other scripts here. selfhost/add-user runs it.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  ensureOrganization,
  ensureProjectGrant,
  ensureUserGrant,
  findUserByEmail,
  requireOk,
  requireProject,
} from "./zitadel-admin.mjs";

const USAGE = "usage: add-user.mjs <email> [--owner] [--new-password] [--org <organization>]";
const args = process.argv.slice(2);
let email;
let owner = false;
let newPassword = false;
let orgName = "default";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--owner") owner = true;
  else if (args[i] === "--new-password") newPassword = true;
  else if (args[i] === "--org" && args[i + 1]) orgName = args[++i];
  else if (!email && !args[i].startsWith("-")) email = args[i];
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error(USAGE);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(fs.readFileSync(path.resolve(here, "../project/pipod-project.json"), "utf8"));
const permissions = JSON.parse(fs.readFileSync(path.resolve(here, "../permissions.json"), "utf8"));
// The server never expands a bundle: a grant carries the bundle name and each of its permissions.
const bundle = owner ? "owner" : "member";
const roles = [bundle, ...permissions.composites[bundle]];

const project = await requireProject();
const org = await ensureOrganization({ name: orgName });
const projectGrant = await ensureProjectGrant(
  project.id,
  org.id,
  contract.roles.map((role) => role.key),
);

let user = await findUserByEmail(email);
let password;
if (user) {
  // pi pod keeps only the roles granted by the organization a user belongs to.
  const home = user.details?.resourceOwner;
  if (home && home !== org.id) {
    console.error(`${email} already belongs to another organization (${home}), not ${orgName}.`);
    process.exit(1);
  }
  if (newPassword) {
    password = oneTimePassword();
    await requireOk(
      await api("POST", `/v2/users/${user.userId ?? user.id}/password`, {
        newPassword: { password, changeRequired: true },
      }),
      "set password",
    );
  }
} else {
  password = oneTimePassword();
  const local = email.split("@")[0];
  const created = await requireOk(
    await api("POST", "/v2/users/human", {
      organization: { orgId: org.id },
      username: email,
      profile: { givenName: local, familyName: local, displayName: email },
      // Nothing can send a verification mail until SMTP is configured; the operator vouches.
      email: { email, isVerified: true },
      password: { password, changeRequired: true },
    }),
    "create user",
  );
  user = { userId: created.json?.userId };
}
const userId = user.userId ?? user.id;

if (owner) {
  const membership = await api("POST", "/management/v1/orgs/me/members", { userId, roles: ["ORG_OWNER"] }, org.id);
  if (!membership.ok && membership.status !== 409) await requireOk(membership, "add ORG_OWNER membership");
}
await ensureUserGrant(org.id, userId, project.id, roles, projectGrant.grantId);

console.log(`${email} is ${owner ? "an owner" : "a member"} of ${orgName}`);
if (password) {
  console.log(`one-time password: ${password}`);
  console.log("(shown only now; Zitadel asks for a new one at the next sign-in)");
} else {
  console.log("existing user: password unchanged (--new-password issues a one-time one)");
}

function oneTimePassword() {
  // Random, plus one character of each class Zitadel's default complexity policy requires.
  return `${randomBytes(12).toString("base64url")}-aA1`;
}
