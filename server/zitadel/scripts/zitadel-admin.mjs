#!/usr/bin/env node
/**
 * Shared Zitadel management API helper for operator scripts. No product runtime uses this.
 * Authentication is a personal access token of an instance-admin service user (ZITADEL_PAT).
 */
const base = (process.env.ZITADEL_URL ?? "http://127.0.0.1:8081").replace(/\/+$/, "");
const pat = process.env.ZITADEL_PAT ?? "";
{
  // The PAT is an instance-admin credential: cleartext only to loopback.
  const url = new URL(base);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("ZITADEL_URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
}

export function apiBase() {
  return base;
}

export function requirePat() {
  if (!pat) throw new Error("ZITADEL_PAT is required (personal access token of an admin service user)");
  return pat;
}

/**
 * `orgId` sets the x-zitadel-orgid header, which scopes management calls to that
 * organization instead of the service user's own.
 */
export async function api(method, path, body, orgId) {
  const headers = { authorization: `Bearer ${requirePat()}`, accept: "application/json" };
  if (orgId) headers["x-zitadel-orgid"] = orgId;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: res.ok, status: res.status, text, json };
}

export async function requireOk(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.status} ${result.text}`);
  return result;
}

/** Exact-name project lookup; returns null when absent, throws on duplicates. */
export async function findProject(name) {
  const result = await requireOk(
    await api("POST", "/management/v1/projects/_search", {
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    }),
    "search projects",
  );
  const rows = (result.json?.result ?? []).filter((row) => row.name === name);
  if (rows.length > 1) throw new Error(`duplicate project ${name}`);
  return rows[0] ?? null;
}

export async function requireProject(name = process.env.ZITADEL_PROJECT ?? "pipod") {
  const project = await findProject(name);
  if (!project) throw new Error(`project not found: ${name} (run reconcile-zitadel.mjs --apply first)`);
  return project;
}

export async function projectRoles(projectId) {
  const result = await requireOk(
    await api("POST", `/management/v1/projects/${projectId}/roles/_search`, { query: { limit: 200 } }),
    "search project roles",
  );
  return result.json?.result ?? [];
}

export async function findOrgByName(name) {
  const result = await requireOk(
    await api("POST", "/v2/organizations/_search", {
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    }),
    "search organizations",
  );
  const rows = (result.json?.result ?? []).filter((row) => row.name === name);
  return rows[0] ?? null;
}

export async function ensureOrganization({ name }) {
  const existing = await findOrgByName(name);
  if (existing) return { id: existing.id, name: existing.name, existed: true };
  const created = await requireOk(await api("POST", "/v2/organizations", { name }), "create organization");
  return { id: created.json?.organizationId ?? created.json?.id, name, existed: false };
}

/** Grant the project to a tenant organization with the given role keys (idempotent). */
export async function ensureProjectGrant(projectId, grantedOrgId, roleKeys) {
  const listed = await requireOk(
    await api("POST", `/management/v1/projectgrants/_search`, {
      queries: [{ projectIdQuery: { projectId } }],
    }),
    "search project grants",
  );
  const existing = (listed.json?.result ?? []).find((row) => row.grantedOrgId === grantedOrgId);
  if (!existing) {
    const created = await requireOk(
      await api("POST", `/management/v1/projects/${projectId}/grants`, { grantedOrgId, roleKeys }),
      "create project grant",
    );
    return { grantId: created.json?.grantId ?? created.json?.id, created: true };
  }
  const have = new Set(existing.grantedRoleKeys ?? []);
  const missing = roleKeys.filter((key) => !have.has(key));
  if (missing.length > 0) {
    await requireOk(
      await api("PUT", `/management/v1/projects/${projectId}/grants/${existing.grantId}`, {
        roleKeys: [...new Set([...have, ...roleKeys])],
      }),
      "update project grant",
    );
  }
  return { grantId: existing.grantId, created: false };
}

export async function findUserByEmail(email) {
  const result = await requireOk(
    await api("POST", "/v2/users", {
      queries: [{ emailQuery: { emailAddress: email, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    }),
    "search users",
  );
  return (result.json?.result ?? [])[0] ?? null;
}

/** Grant project roles to a user inside their organization (idempotent, additive). */
export async function ensureUserGrant(orgId, userId, projectId, roleKeys, projectGrantId) {
  const listed = await requireOk(
    await api(
      "POST",
      "/management/v1/users/grants/_search",
      { queries: [{ userIdQuery: { userId } }, { projectIdQuery: { projectId } }] },
      orgId,
    ),
    "search user grants",
  );
  const existing = (listed.json?.result ?? [])[0];
  if (!existing) {
    await requireOk(
      await api(
        "POST",
        `/management/v1/users/${userId}/grants`,
        { projectId, roleKeys, ...(projectGrantId ? { projectGrantId } : {}) },
        orgId,
      ),
      "create user grant",
    );
    return { created: true };
  }
  const have = new Set(existing.roleKeys ?? []);
  const merged = [...new Set([...have, ...roleKeys])];
  if (merged.length !== have.size) {
    await requireOk(
      await api("PUT", `/management/v1/users/${userId}/grants/${existing.id}`, { roleKeys: merged }, orgId),
      "update user grant",
    );
  }
  return { created: false };
}

export function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}
