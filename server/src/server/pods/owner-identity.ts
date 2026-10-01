/**
 * Trusted per-user sandbox ownership (§7.2).
 *
 * The host provisions an immutable owner (`OwnerIdentity.userKey`) from the
 * control plane on create/import and never consults mutable labels for
 * ownership, quota, cgroup placement, or cost attribution. Legacy sandboxes
 * without an owner keep the flat cgroup layout; running sandboxes are never
 * moved live — the tenant layout applies at the next start.
 *
 * Convergence note: `src/server/usage/attribution.ts` on the sibling ledger
 * branch defines the same `u_<sha256>` derivation for cost attribution. This
 * module is the launch-path copy so the capacity branch never edits
 * ledger-owned files; the parent dedupes at merge. The derivation MUST stay
 * byte-identical in both places (domain + format), or one user's sandboxes
 * would split across two tenant cgroups.
 */
import { createHash } from "node:crypto";
import { OWNER_USER_KEY, type OwnerIdentity } from "../../core/providers/sandbox/wire.js";

/** Domain separator so this hash cannot be confused with any other id hash. */
export const OWNER_KEY_DOMAIN = "pipod-user-key-v1:";

/**
 * Stable opaque platform user key for OwnerIdentity. Deterministic (the host must
 * see the same key for a user across launches), irreversible (sha256), and never
 * an email or display name. Matches the native `^[A-Za-z0-9._-]{1,64}$` rule.
 */
export function ownerKeyForUserId(userId: string): string {
  const digest = createHash("sha256").update(OWNER_KEY_DOMAIN + userId).digest("hex");
  return `u_${digest.slice(0, 32)}`;
}

export function isValidOwnerKey(value: unknown): value is string {
  return typeof value === "string" && OWNER_USER_KEY.test(value);
}

/**
 * Build the one-time immutable owner for a create/import request.
 *
 * The user id comes from the authenticated launch context (the pod's owner —
 * the same id the quota check charges), never from request labels, pod names,
 * or any other mutable/client-controlled field. There is no update path: the
 * host rejects owner changes after create, and `PUT /labels` cannot touch it.
 */
export function buildCreateOwner(args: { userId: string }): OwnerIdentity {
  if (!args.userId || typeof args.userId !== "string") {
    throw new Error("owner identity requires an authenticated user id");
  }
  const userKey = ownerKeyForUserId(args.userId);
  if (!isValidOwnerKey(userKey)) {
    throw new Error("derived owner key failed native validation");
  }
  return { userKey };
}
