/**
 * Authorization is permission-only.
 *
 * Zitadel owns roles: `pipod` project roles are granted to users by their
 * organization. Access tokens carry the granted roles attributed to the token's
 * resource-owner organization; this process never maps role names to capabilities.
 *
 * Keep this list identical to `zitadel/permissions.json`. CI fails on drift.
 */
export const PERMISSIONS = [
  "pods:launch",
  "pods:manage_any",
  "templates:write",
  "jobs:write",
  "secrets:org:write",
  "secrets:own:write",
  "settings:own:write",
  "policy:write",
  "org:manage",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** True when the token's permission list includes `permission`. */
export function hasPermission(permissions: readonly string[], permission: Permission): boolean {
  return permissions.includes(permission);
}
