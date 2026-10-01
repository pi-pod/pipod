import { serviceUnavailable } from "../httperrors.js";

/** Internal only: no route accepts this field. A UUID is correlation identity,
 * not proof of durable enrollment, authorization, or a ready provider VM. */
export type LaunchContext =
  | { readonly kind: "existing" }
  | { readonly kind: "v2-deferred"; readonly podId: string };

/** Fail before any host acquisition, DB lookup or credential read. The deferred
 * branch stays closed until planning and recovery can persist the pod first. */
export function assertLaunchContextSupported(context?: LaunchContext): void {
  if(context === undefined)return;
  if(context && typeof context === "object" && !Array.isArray(context)
    && context.kind === "existing" && Object.keys(context).length === 1)return;
  if(context && typeof context === "object" && !Array.isArray(context)
    && context.kind === "v2-deferred" && typeof context.podId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.podId)
    && Object.keys(context).length === 2) {
    throw serviceUnavailable("isolated-pod launch is not available on this deployment", {
      code: "v2_launch_deferred", retryable: false,
    });
  }
  throw serviceUnavailable("unsupported internal launch context", {
    code: "v2_launch_deferred", retryable: false,
  });
}
