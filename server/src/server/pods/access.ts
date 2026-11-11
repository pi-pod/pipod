import type { AuthContext } from "../auth/plugin.js";
import { limitReachesPod, limitRefusal } from "../auth/limited-sign-in.js";
import { hasPermission } from "../auth/rbac.js";
import { assertPersonalPodAccess } from "../edition.js";
import { HttpError, forbidden } from "../httperrors.js";
import type { PodRow } from "./types.js";

type Caller = Pick<AuthContext, "userId" | "permissions" | "limitedTo">;

/**
 * Who may act on a pod or read what it recorded (sessions, transcripts): its
 * owner, or a holder of `pods:manage_any` when host custody allows it. Organization
 * membership only makes a pod visible in listings; it never reaches the pod's contents.
 * A limited sign-in reaches only its account's own pods from its template, whatever the
 * account's permissions.
 */
export async function assertPodAccess(pod: PodRow, auth: Caller): Promise<void> {
  if (auth.limitedTo) {
    if (limitReachesPod(auth.limitedTo, auth.userId, pod)) return;
    throw limitRefusal(auth.limitedTo, "it cannot reach this pod");
  }
  if (pod.user_id === auth.userId) return;
  if (!hasPermission(auth.permissions, "pods:manage_any")) throw forbidden("requires pods:manage_any");
  await assertPersonalPodAccess(pod, auth.userId);
}

/**
 * For routes where any member may see a pod (its state, in listings): a limited sign-in still
 * sees only what it reaches. Nothing for anyone else.
 */
export function assertWithinLimit(pod: Pick<PodRow, "user_id" | "template_id">, auth: Caller): void {
  if (auth.limitedTo && !limitReachesPod(auth.limitedTo, auth.userId, pod)) {
    throw limitRefusal(auth.limitedTo, "it cannot reach this pod");
  }
}

/** `assertPodAccess` as a filter: a pod the caller may not open is left out, not an error. */
export async function canAccessPod(pod: PodRow, auth: Caller): Promise<boolean> {
  try {
    await assertPodAccess(pod, auth);
    return true;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}
