import type { FastifyInstance } from "fastify";
import type { ServerEnv } from "./env.js";
import type { KekProvider } from "./secrets/crypto.js";
import type { GatewayService } from "./gateway/service.js";
import type { HostIdentity, PodHostIdentity } from "./pods/hostidentity.js";
import type { SandboxHostBackend } from "./pods/hostbackend/index.js";
import type { WorkerDeps } from "./workers/index.js";
import { defaultMigrationsDir, type MigrationSet } from "./db/migrate.js";
import { conflict, forbidden } from "./httperrors.js";
import { hostForPod, requireHostAwake } from "./pods/hostidentity.js";

/** What every host hook receives: the environment the server started with and its key provider. */
export interface HostDeps {
  env: ServerEnv;
  kek: KekProvider;
}

/** Schedules a named worker tick behind the launch gate; returns a trigger for an immediate tick. */
export type ScheduleWorker = (name: string, everyMs: number, job: () => Promise<void>) => () => void;

/**
 * Everything a hosted deployment adds to the open-source server, installed once at
 * startup with `installEdition` before any route, worker or command runs.
 *
 * The default, `selfHosted`, is the self-hosted server: pods run on the operator's
 * registered hosts (`SANDBOX_HOST_BACKEND=static`), nothing is metered or billed, and
 * the only per-user limit is `POD_MAX_CONCURRENT_PER_USER`. An edition that
 * provisions a host per owner serves one more `SANDBOX_HOST_BACKEND` name and
 * implements the host hooks for it; an edition that sells plans implements the
 * admission hooks. Hooks receive the environment object the server was started
 * with, so an edition that parses a larger schema reads its own settings from it.
 */
export interface Edition {
  /** The `SANDBOX_HOST_BACKEND` value this edition serves besides `static`, if any. */
  readonly hostBackendName?: string;

  // --- Owned hosts. Called only when SANDBOX_HOST_BACKEND names this edition's backend,
  // or for pods whose host row has an owner. ---------------------------------------
  /** Host acquisition for one owner's launch. */
  hostBackend(env: ServerEnv, owner?: { userId: string; kek: KekProvider; podId?: string }): SandboxHostBackend;
  /** Brings the host a pod lives on to a state that can run it (resume or activate). */
  ensurePodHostReady(deps: HostDeps, pod: PodHostIdentity): Promise<void>;
  /** Brings the owner's personal host up, for scheduled work that has no pod yet. */
  ensureOwnedHostReady(deps: HostDeps, userId: string): Promise<HostIdentity>;
  /** Records owner activity on a running owned host; false while it cannot take work. */
  admitOwnedHostActivity(hostId: string, userId: string): Promise<boolean>;
  /** Provisions the dedicated host a new pod runs on, after its row exists. */
  ensureDedicatedPodHost(deps: HostDeps, userId: string, podId: string): Promise<void>;
  /** The workspace disk a new pod gets on the owner's host, when larger than the default. */
  ownedHostDiskGB(env: ServerEnv, userId: string): Promise<number | undefined>;

  // --- Admission. Every path that starts or resumes pod work calls these. -----------
  /** Refuses new pod work the owner may not start; `storageBytes` is what it would add. */
  admitPodWork(env: ServerEnv, userId: string, storageBytes?: number): Promise<void>;
  /** The most pods this owner may run at once. */
  perUserPodCap(env: ServerEnv, userId: string): Promise<number>;
  /** Fields this edition adds to `GET /v1/me`. */
  accountSummary(env: ServerEnv, userId: string): Promise<Record<string, unknown>>;

  // --- Server. ------------------------------------------------------------------------
  /** The migrations this deployment's database runs. */
  migrations(): MigrationSet;
  /** Routes outside `/v1`, registered on the API role before the product routes. */
  registerRoutes(app: FastifyInstance, deps: { env: ServerEnv; kek: KekProvider; gateway: GatewayService | null }): Promise<void>;
  /** An HTTP response for an error type only this edition throws, or null. */
  renderError(error: unknown): { statusCode: number; body: { error: string; detail: unknown } } | null;
  /** Starts this edition's workers through the server's scheduler; returns their stoppers. */
  startWorkers(deps: WorkerDeps, schedule: ScheduleWorker): Array<() => void>;
  /**
   * SQL predicate over `pods`, ANDed into the reconciler's "sandbox is gone" update:
   * false while the edition is moving that pod's sandbox to another host, where the
   * old host's list no longer reports it. Empty when the edition never moves sandboxes.
   */
  readonly reconcileGoneGuardSql: string;
}

/**
 * Caller authorization is separate from host custody. Org administrators keep access
 * to pods on shared hosts, but a personal host may only be used by its owner.
 */
export async function assertPersonalPodAccess(pod: PodHostIdentity, callerUserId: string): Promise<void> {
  if (callerUserId === pod.user_id) return;
  const host = await hostForPod(pod);
  if (host?.owner_user_id != null && host.owner_user_id !== callerUserId) {
    throw forbidden("only the personal workstation owner may access this pod");
  }
}

function unsupported(what: string): never {
  throw conflict(`${what} requires a hosted edition`);
}

/** The self-hosted server: registered shared hosts, no plans, no metering. */
export const selfHosted: Edition = {
  hostBackend: () => unsupported("an owned-host backend"),
  async ensurePodHostReady(_deps, pod) {
    const assigned = await hostForPod(pod);
    if (!assigned || assigned.owner_user_id === null) return;
    if (assigned.owner_user_id !== pod.user_id) throw conflict("host custody mismatch");
    requireHostAwake(assigned);
  },
  ensureOwnedHostReady: async () => unsupported("a personal host"),
  admitOwnedHostActivity: async () => false,
  ensureDedicatedPodHost: async () => unsupported("a dedicated pod host"),
  ownedHostDiskGB: async () => undefined,
  admitPodWork: async () => {},
  perUserPodCap: async (env) => env.POD_MAX_CONCURRENT_PER_USER,
  accountSummary: async () => ({}),
  migrations: () => ({ dirs: [defaultMigrationsDir()] }),
  registerRoutes: async () => {},
  renderError: () => null,
  startWorkers: () => [],
  reconcileGoneGuardSql: "",
};

let installed: Edition = selfHosted;

/** Replaces the self-hosted edition. Call once, before the server or a command starts. */
export function installEdition(next: Edition): void {
  installed = next;
}

export function edition(): Edition {
  return installed;
}

/**
 * Whether launches run on hosts the edition provisions per owner rather than on the
 * operator's registered hosts. A caller may pass an environment with
 * `SANDBOX_HOST_BACKEND=static` to plan against shared hosts only.
 */
export function ownedHosts(env: Pick<ServerEnv, "SANDBOX_HOST_BACKEND">): boolean {
  return env.SANDBOX_HOST_BACKEND !== "static";
}

/** Refuses a host backend name the installed edition does not serve. */
export function assertHostBackendServed(env: Pick<ServerEnv, "SANDBOX_HOST_BACKEND">): void {
  if (!ownedHosts(env)) return;
  if (installed.hostBackendName !== env.SANDBOX_HOST_BACKEND) {
    throw new Error(`SANDBOX_HOST_BACKEND=${env.SANDBOX_HOST_BACKEND} is not served by this server; use static`);
  }
}
