import type { ApiPod } from "./api.js";

/**
 * Storage-aware status vocabulary (cost-control plan §3.4). The logical state keeps its
 * hide semantics — `state=archived` stays hidden from active listings — while the label
 * names the physical truth the server reports in `sandboxState`:
 *
 * - `stopped`: active row, stopped sandbox, files on local disk. `attach` restarts it.
 * - `stopped · cold storage`: provider-archived sandbox under an active row. Attach
 *   downloads and unpacks it first, which takes longer the bigger the workspace.
 * - `archived …`: a logically archived row (`list --archived` shows it), with the same
 *   cold-storage suffix when the server reports it.
 * - `failed`: a launch or start that ended with a reason and no running sandbox.
 *
 * A cold-storage claim needs sandbox-confirmed archive (`sandboxState=archived`);
 * a bare logically-hidden row claims nothing about storage.
 *
 * `sandboxState` is optional: older servers omit it and fall back to the logical state.
 */
export type PodStorageKind =
  | "running"
  | "starting"
  | "failed"
  | "stopped-retained"
  | "provider-archived"
  | "archived-hidden"
  | "archived-hidden-retained"
  | "archived-hidden-cold";

export function podStorageKind(pod: ApiPod): PodStorageKind {
  if (pod.preparationPhase === "failed") return "failed";
  if (pod.initializing) return "starting";
  const sandbox = pod.sandboxState ?? null;
  if (pod.state === "archived") {
    if (sandbox === "stopped") return "archived-hidden-retained";
    if (sandbox === "archived") return "archived-hidden-cold";
    return "archived-hidden";
  }
  if (sandbox === "stopped") return "stopped-retained";
  if (sandbox === "archived") return "provider-archived";
  if (!pod.ready && pod.stateReason) return "failed";
  return "running";
}

export function podStatusLabel(pod: ApiPod): string {
  if (pod.preparationPhase === "failed") return "failed";
  if (pod.preparationPhase === "waiting-for-capacity") return "waiting for capacity";
  if (pod.initializing) return pod.preparationPhase ?? "preparing";
  switch (podStorageKind(pod)) {
    case "stopped-retained":
      return "stopped";
    case "provider-archived":
      return "stopped · cold storage";
    case "archived-hidden-retained":
    case "archived-hidden":
      return "archived";
    case "archived-hidden-cold":
      return "archived · cold storage";
    case "failed":
      return "failed";
    case "starting":
      return pod.preparationPhase ?? "preparing";
    case "running":
      return "running";
  }
}
