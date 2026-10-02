import type { AuthContext } from "../auth/plugin.js";
import { hasPermission } from "../auth/rbac.js";
import { assertPersonalPodAccess } from "../edition.js";
import { HttpError, forbidden } from "../httperrors.js";
import type { PodRow } from "./types.js";

type Caller = Pick<AuthContext, "userId" | "permissions">;

/**
 * Who may act on a pod or read what it recorded (sessions, transcripts): its
 * owner, or a holder of `pods:manage_any` when host custody allows it. Organization
 * membership only makes a pod visible in listings; it never reaches the pod's contents.
 */
export async function assertPodAccess(pod: PodRow, auth: Caller): Promise<void> {
  if (pod.user_id === auth.userId) return;
  if (!hasPermission(auth.permissions, "pods:manage_any")) throw forbidden("requires pods:manage_any");
  await assertPersonalPodAccess(pod, auth.userId);
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
