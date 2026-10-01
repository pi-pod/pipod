/**
 * Per-pod runtime file locations inside the sandbox.
 *
 * Machine-backed pods keep the historical /tmp constants. Co-located pods share their host's
 * /tmp, so every runtime file an agentd instance owns is suffixed with the pod id — two pi
 * supervisors on one machine must never fight over a pidfile, a turn marker, or a shim whose
 * versions may differ.
 */
import { EXIT_CODE_FILE } from "../../core/lifecycle.js";
import { HOST_PROVIDER_NAME } from "../../core/providers/host.js";
import {
  AGENTD_PID_PATH,
  AGENTD_READY_PATH,
  SHIM_LOG_PATH,
  SHIM_PATH,
  TURN_MARKER_PATH,
} from "../../core/shim/agentd.js";
import { POD_EXT_PATH } from "../../core/shim/pi-pod-ext.js";
import { FORK_SEED_STAGING_PATH } from "./fork-seed.js";

export interface PodRuntimePaths {
  shim: string;
  shimLog: string;
  agentdPid: string;
  agentdReady: string;
  exitCode: string;
  turnMarker: string;
  podExt: string;
  forkSeed: string;
}

export const DEFAULT_RUNTIME_PATHS: PodRuntimePaths = {
  shim: SHIM_PATH,
  shimLog: SHIM_LOG_PATH,
  agentdPid: AGENTD_PID_PATH,
  agentdReady: AGENTD_READY_PATH,
  exitCode: EXIT_CODE_FILE,
  turnMarker: TURN_MARKER_PATH,
  podExt: POD_EXT_PATH,
  forkSeed: FORK_SEED_STAGING_PATH,
};

/**
 * The turn marker keeps the shared basename as a prefix so the host's keepalive watcher can
 * glob every co-resident marker; the shim keeps its shared basename as a prefix so
 * agentd-identifying argv checks can match on it.
 */
export function childRuntimePaths(podId: string): PodRuntimePaths {
  return {
    shim: `/tmp/pi-pod-agentd.${podId}.cjs`,
    shimLog: `/tmp/pi-pod-agentd.${podId}.log`,
    agentdPid: `/tmp/pi-pod-agentd.${podId}.pid`,
    agentdReady: `/tmp/pi-pod-agentd.${podId}.ready`,
    exitCode: `${EXIT_CODE_FILE}.${podId}`,
    turnMarker: `${TURN_MARKER_PATH}.${podId}`,
    podExt: `/tmp/pi-pod-ext.${podId}.js`,
    forkSeed: `/tmp/pi-pod-fork-seed.${podId}.jsonl`,
  };
}

export function podRuntimePaths(pod: { id: string; provider: string }): PodRuntimePaths {
  return pod.provider === HOST_PROVIDER_NAME ? childRuntimePaths(pod.id) : DEFAULT_RUNTIME_PATHS;
}
