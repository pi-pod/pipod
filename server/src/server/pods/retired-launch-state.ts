/**
 * src/server/pods/retired-launch-state.ts — refuse a launch record this server cannot honor.
 *
 * One withdrawn release accepted a closed-shape worker handoff on the launch wire and recorded
 * it in `resolved_config`, where it decided part of the pod's environment on every start. The
 * generic replacement (per-launch Pi resources, § pi-resources) records paths only, and the
 * environment half has no successor here at all: a pod whose record still carries that marker
 * would come back with argv it can rebuild and an environment it cannot.
 *
 * So the marker is a refusal, not a migration. There is no adapter, no rewrite, and no silent
 * strip: a stored launch under that protocol cannot be reconstructed safely. A clear
 * message names the recovery action rather than pretending the withdrawn shape still works.
 * The marker and the pod's files remain available for recovery.
 *
 * This is a compatibility guard over stored state, not a policy about launch inputs: the
 * current wire has no such field to reject.
 */
import { conflict } from "../httperrors.js";
import type { ResolvedConfigReport } from "./types.js";

/** The one retired key this server still recognises, solely to refuse it. */
export const RETIRED_LAUNCH_STATE_KEY = "subagentRuntime";

export function assertLaunchStateSupported(
  report: Pick<ResolvedConfigReport, "subagentRuntime">,
  podId: string,
): void {
  if (report.subagentRuntime === undefined || report.subagentRuntime === null) return;
  throw conflict(
    `pod ${podId} was launched by a retired worker protocol and cannot be started again: its ` +
      `launch record carries a ${RETIRED_LAUNCH_STATE_KEY} marker whose runtime environment ` +
      "this server no longer builds. Launch a replacement pod — a current client passes the " +
      "extension with the launch (piOverrides.extensions). Preserve any needed work, then archive this pod.",
  );
}
