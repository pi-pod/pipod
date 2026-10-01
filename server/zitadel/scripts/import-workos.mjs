#!/usr/bin/env node
/**
 * One-shot WorkOS → Zitadel import. Not a runtime adapter.
 *
 * Reads an archived WorkOS export (users, organizations, memberships) and
 * creates Zitadel organizations, human users (no password/MFA), and pipod
 * project user grants via the v2 and management APIs.
 *
 * Usage:
 *   ZITADEL_URL=http://127.0.0.1:8081 ZITADEL_PAT=... \
 *   node zitadel/scripts/import-workos.mjs export.json
 *
 * Export shape:
 * {
 *   "users": [{ "id", "email", "emailVerified", "firstName", "lastName", "authMethod" }],
 *   "organizations": [{ "id", "name", "personal" }],
 *   "memberships": [{ "userId", "organizationId", "role" }]
 * }
 */
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  api,
  ensureOrganization,
  ensureProjectGrant,
  ensureUserGrant,
  requireOk,
  requireProject,
} from "./zitadel-admin.mjs";

const exportPath = process.argv[2];
if (!exportPath) {
  console.error("usage: node import-workos.mjs <export.json>");
  process.exit(2);
}

const source = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const hash = crypto.createHash("sha256").update(fs.readFileSync(exportPath)).digest("hex");
console.log(`source ${exportPath} sha256:${hash}`);

const BUNDLES = JSON.parse(
  fs.readFileSync(new URL("../permissions.json", import.meta.url), "utf8"),
);
function rolesForBundle(role) {
  const bundle = ["owner", "admin", "member"].includes(role) ? role : "member";
  return [bundle, ...BUNDLES.composites[bundle]];
}

const project = await requireProject();
const allRoleKeys = ["owner", "admin", "member", ...BUNDLES.permissions];

const userToOrg = new Map();
for (const membership of source.memberships ?? []) {
  if (!userToOrg.has(membership.userId)) userToOrg.set(membership.userId, membership.organizationId);
}

const orgMap = new Map();
const userMap = new Map();
const collisions = [];
const unmatched = [];

for (const org of source.organizations ?? []) {
  const name = org.personal ? `${org.name} (migrated)` : org.name;
  const ensured = await ensureOrganization({ name });
  if (ensured.existed) collisions.push({ kind: "organization", name, workosId: org.id });
  if (!ensured.id) {
    unmatched.push({ kind: "organization", id: org.id, reason: "create failed" });
    continue;
  }
  await ensureProjectGrant(project.id, ensured.id, allRoleKeys);
  orgMap.set(org.id, { zitadelId: ensured.id, name, personal: Boolean(org.personal) });
}

for (const user of source.users ?? []) {
  const email = String(user.email ?? "").trim();
  if (!email) {
    unmatched.push({ kind: "user", id: user.id, reason: "missing email" });
    continue;
  }
  const homeOrg = orgMap.get(userToOrg.get(user.id));
  if (!homeOrg) {
    unmatched.push({ kind: "user", id: user.id, email, reason: "no organization membership" });
    continue;
  }
  const created = await api(
    "POST",
    "/v2/users/human",
    {
      organization: { orgId: homeOrg.zitadelId },
      profile: {
        givenName: user.firstName || email,
        familyName: user.lastName || email,
      },
      email: { email, isVerified: user.emailVerified === true },
    },
  );
  let id = created.json?.userId;
  if (!created.ok) {
    if (created.status !== 409) {
      unmatched.push({ kind: "user", id: user.id, email, reason: `create failed (${created.status})` });
      continue;
    }
    collisions.push({ kind: "user", email, workosId: user.id });
    const found = await requireOk(
      await api("POST", "/v2/users", {
        queries: [{ emailQuery: { emailAddress: email, method: "TEXT_QUERY_METHOD_EQUALS" } }],
      }),
      "search user",
    );
    id = found.json?.result?.[0]?.userId;
  }
  if (!id) {
    unmatched.push({ kind: "user", id: user.id, email, reason: "create failed" });
    continue;
  }
  userMap.set(user.id, { zitadelId: id, email });
}

for (const membership of source.memberships ?? []) {
  const user = userMap.get(membership.userId);
  const org = orgMap.get(membership.organizationId);
  if (!user || !org) {
    unmatched.push({ kind: "membership", ...membership, reason: "missing user or org" });
    continue;
  }
  try {
    await ensureUserGrant(org.zitadelId, user.zitadelId, project.id, rolesForBundle(membership.role));
  } catch (error) {
    unmatched.push({ kind: "grant", email: user.email, org: org.name, role: membership.role, error: String(error) });
  }
}

const mapping = {
  sourceHash: hash,
  generatedAt: new Date().toISOString(),
  users: [...userMap.entries()].map(([workosId, value]) => ({ workosId, ...value })),
  organizations: [...orgMap.entries()].map(([workosId, value]) => ({ workosId, ...value })),
  collisions,
  unmatched,
};
const out = exportPath.replace(/\.json$/i, "") + ".zitadel-mapping.json";
fs.writeFileSync(out, `${JSON.stringify(mapping, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`users ${userMap.size} orgs ${orgMap.size} collisions ${collisions.length} unmatched ${unmatched.length}`);
