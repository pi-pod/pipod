/**
 * Server wiring for the co-located ("host") provider: resolves a pod's host machine handle
 * by wrapping the host pod's own provider Sandbox. This is the only place that knows a host
 * machine is a pod — the adapter sees the {@link HostMachine} contract and nothing else.
 */
import {
  HOST_PROVIDER_NAME,
  createHostProvider,
  parseHostSandboxId,
  type HostMachine,
} from "../../core/providers/host.js";
import type { Sandbox, SandboxProvider, SandboxState } from "../../core/providers/types.js";
import { conflict, notFound } from "../httperrors.js";
import { ensureProviderPodStarted, withPodSandbox } from "./lifecycle.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import { getPod, setProviderState } from "./store.js";
import type { PodRow, PodServiceDeps } from "./types.js";

export function isHostPod(pod: Pick<PodRow, "provider">): boolean {
  return pod.provider === HOST_PROVIDER_NAME;
}

/**
 * Concurrent child wakes coalesce here: one audited host start runs, the rest await it.
 * Keyed per process — CAS on the pods row keeps cross-process racers correct, just louder.
 */
const hostStartsInFlight = new Map<string, Promise<void>>();

async function ensureHostStarted(deps: PodServiceDeps, host: Pick<PodRow, "org_id" | "id">): Promise<void> {
  const inFlight = hostStartsInFlight.get(host.id);
  if (inFlight) return inFlight;
  const run = (async () => {
    await ensureProviderPodStarted(deps, host, null);
  })().finally(() => hostStartsInFlight.delete(host.id));
  hostStartsInFlight.set(host.id, run);
  return run;
}

function machineFromHost(deps: PodServiceDeps, host: PodRow, hostSandbox: Sandbox): HostMachine {
  return {
    hostId: host.id,
    state: (): Promise<SandboxState> => hostSandbox.state(),
    ensureStarted: async (timeoutMs: number): Promise<void> => {
      await ensureHostStarted(deps, host);
      await hostSandbox.waitUntilStarted(timeoutMs);
    },
    exec: (argv, opts) => hostSandbox.exec(argv, opts),
    uploadFile: (destPath, contents, mode) => hostSandbox.uploadFile(destPath, contents, mode),
    uploadLocalFile: (sourcePath, destPath, opts) => hostSandbox.uploadLocalFile(sourcePath, destPath, opts),
    downloadFile: (sourcePath) => hostSandbox.downloadFile(sourcePath),
    openPty: (opts) => hostSandbox.openPty(opts),
    refreshActivity: () => hostSandbox.refreshActivity(),
  };
}

/**
 * Run provider work against a host pod's machine. The host's provider credential wraps the
 * whole operation, exactly as it would for direct work on the host pod itself.
 */
export async function withHostMachineProvider<T>(
  deps: PodServiceDeps,
  host: PodRow,
  fn: (provider: SandboxProvider, machine: HostMachine) => Promise<T>,
): Promise<T> {
  if (isHostPod(host)) {
    // Placement resolution flattens to the real machine owner before anything reaches here.
    throw conflict("a co-located pod cannot itself be a host machine");
  }
  if (!host.provider_sandbox_id) throw conflict("the host pod has no provider sandbox yet");
  // Share native absence/retry fencing with direct pod work. A stale endpoint's
  // 404 must not condemn the machine that owns every co-located child.
  return withPodSandbox(deps,host,async (hostSandbox) => {
    const machine=machineFromHost(deps,host,hostSandbox);
    const provider=createHostProvider(async(hostId)=>(hostId===host.id?machine:null));
    return fn(provider,machine);
  },{recoverStaleProviderState:false});
}

/**
 * Read-only counterpart for recovery observation. Unlike withPodSandbox, a missing provider
 * result here never changes the host pod's lifecycle state or starts/resumes its machine.
 */
export async function withHostMachineProviderReadOnly<T>(
  deps: PodServiceDeps,
  host: PodRow,
  fn: (provider: SandboxProvider, machine: HostMachine) => Promise<T>,
): Promise<T> {
  if (isHostPod(host)) throw conflict("a co-located pod cannot itself be a host machine");
  if (!host.provider_sandbox_id) throw conflict("the host pod has no provider sandbox yet");
  return withProviderCredential({
    pod: host,
    kek: deps.kek,
    platformEnv: platformCredentialsOf(deps),
    orgId: host.org_id,
    provider: host.provider,
    providerConfig: host.resolved_config.config.providers?.[host.provider] ?? {},
    fn: async (provider) => {
      const hostSandbox = await provider.get(host.provider_sandbox_id!, {
        workdir: host.resolved_config.workdir,
      });
      if (!hostSandbox) throw notFound("the host machine is not observable");
      const machine = machineFromHost(deps, host, hostSandbox);
      return fn(createHostProvider(async (hostId) => hostId === host.id ? machine : null), machine);
    },
  });
}

/** The withPodSandbox dispatch target for pods whose provider is "host". */
export async function withHostChildSandbox<T>(
  deps: PodServiceDeps,
  pod: PodRow,
  fn: (sandbox: Sandbox, provider: SandboxProvider) => Promise<T>,
): Promise<T> {
  const hostId = pod.host_pod_id ?? parseHostSandboxId(pod.provider_sandbox_id ?? "")?.hostId;
  if (!hostId) throw conflict("co-located pod has no recorded host");
  const host = await getPod(pod.org_id, hostId);
  if (host.provider_state === "gone" || !host.provider_sandbox_id) {
    await setProviderState(pod.id, "gone", "the host machine is gone");
    throw notFound("the host machine is gone");
  }
  return withHostMachineProvider(deps, host, async (provider) => {
    const sandbox = await provider.get(pod.provider_sandbox_id!, {
      workdir: pod.resolved_config.workdir,
    });
    if (!sandbox) {
      await setProviderState(pod.id, "gone", "the host no longer holds this pod");
      throw notFound("the host no longer holds this pod");
    }
    return fn(sandbox, provider);
  });
}
