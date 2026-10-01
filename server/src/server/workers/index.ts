import type { ServerEnv } from "../env.js";
import type { KekProvider } from "../secrets/crypto.js";
import type { PlatformCredentialSnapshot } from "../pods/providercred.js";
import type { GatewayService } from "../gateway/service.js";
import { ApnsClient } from "../push/apns.js";
import { FcmClient } from "../push/fcm.js";
import { launchGateIsOpen } from "../pods/launch-control.js";
import { runImagePrewarm } from "./images.js";
import { runCapacityWaitSweep } from "./capacity-sweep.js";
import { cpuFairnessConfig } from "../pods/cpu-fairness.js";
import { fairnessWaitDepsOk } from "../pods/capacity-wait.js";
import { onCpuAllocatorWake, runCpuAllocator } from "./cpu-allocator.js";
import { runOwnerInitSweep } from "./owner-init.js";
import { runPushDispatcher } from "./push.js";
import { runReconciler } from "./reconciler.js";
import { runIdleReaper, runArchiveSweep } from "./reaper.js";
import { trackWorkerTick } from "../metrics.js";
import { runRetention } from "./retention.js";
import { edition } from "../edition.js";

export interface WorkerDeps {
  env: ServerEnv;
  kek: KekProvider;
  /**
   * Boot snapshot of the platform provider credentials (see providercred
   * `snapshotPlatformCredentials`). Captured in `main()` before any overlay;
   * worker callers resolve it via `platformCredentialsOf(deps)`.
   */
  platformCredentials?: PlatformCredentialSnapshot;
  gateway: GatewayService | null;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/** Timers and reconciliation (spec §12) — always-on replacements for the CLI's laptop-side machinery. */
export function startWorkers(deps: WorkerDeps): () => void {
  const apns = new ApnsClient(deps.env);
  const fcm = new FcmClient(deps.env);
  const timers: NodeJS.Timeout[] = [];

  const unwake: Array<() => void> = [];
  const schedule = (name: string, everyMs: number, job: () => Promise<void>): (() => void) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (!(await launchGateIsOpen())) return;
        await trackWorkerTick(name, job);
      } catch (e) {
        deps.log.error(`worker ${name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, everyMs));
    void tick();
    // Immediate trigger for in-process wake requests (fairness bootstrap):
    // runs a tick now unless one is already running. Never throws.
    return () => {
      void tick();
    };
  };

  // Edition workers (owned-host control, metering, billing) run on the same scheduler.
  unwake.push(...edition().startWorkers(deps, schedule));

  if (deps.env.IMAGE_PREWARM_ENABLED) {
    schedule("image-prewarm", 6 * 60 * 60_000, () => runImagePrewarm(deps));
  }
  // Local manual testing seeds pods whose sandboxes no provider knows; the reconciler
  // would mark them gone within a minute. Dev-only escape hatch, never set in production.
  if (process.env["PIPOD_DEV_SKIP_RECONCILER"] !== "1") {
    schedule("reconciler", 60_000, () => runReconciler(deps));
  }
  schedule("idle-reaper", 60_000, () => runIdleReaper(deps));
  // Bounded capacity waits (§6.6): expire/orphan sweeps fail pods closed with a
  // typed result and cancel host ops by key — never a blind cross-host retry.
  // Boot env rides along so fleet-token reads resolve from the startup snapshot,
  // never from ambient process.env mid-overlay (see platformToken). CLI/tests
  // omit it and keep the legacy ambient read.
  schedule("capacity-wait-sweep", 15_000, () => runCapacityWaitSweep({ ...deps, env: deps.env }));
  // Fleet CPU fairness allocator (§7.3): no-op unless CPU_FAIRNESS_ENABLED,
  // AND never scheduled without its convergence dependencies. A managed host
  // refuses grantless tenants (fairness_degraded) on both first-create and
  // cold-wake bootstrap; only the bounded-wait subsystem (create + wake
  // waits, one flag) converges those without manual retries — running the
  // allocator without it would manufacture pressure it cannot drain. Default
  // OFF; misconfiguration fails closed here (loud, scheduled never) rather
  // than degrading the fleet at runtime.
  if (cpuFairnessConfig(deps.env).enabled) {
    const fairnessDeps = fairnessWaitDepsOk(deps.env);
    if (!fairnessDeps.ok) {
      deps.log.error(`cpu-allocator NOT scheduled: ${fairnessDeps.reason}`);
    } else {
      const triggerAllocator = schedule("cpu-allocator", deps.env.CPU_ALLOCATOR_INTERVAL_MS, () =>
        runCpuAllocator({ kek: deps.kek, env: deps.env as unknown as Record<string, unknown>, log: deps.log }),
      );
      // Fairness bootstrap (W12): a provisioning waiter that just enqueued
      // on `fairness_degraded` wakes the allocator now instead of waiting up
      // to a full interval tick for its first grant. The leader lease still
      // serializes the woken tick; split-role deployments without a local
      // scheduler converge on the interval tick.
      unwake.push(onCpuAllocatorWake(() => triggerAllocator()));
    }
  }
  // Legacy owner initialization (§7.2 rev3): one-time null→userKey CAS for
  // stopped/archived/error sandboxes; live ones grandfather. Bounded + idle
  // when there is nothing to do; REQUIRE_OWNER stays operator-gated.
  schedule("owner-init", 60_000, () => runOwnerInitSweep({ ...deps, env: deps.env }));
  schedule("archive-sweep", 60 * 60_000, () => runArchiveSweep(deps));
  schedule("push-dispatcher", 5_000, () => runPushDispatcher(deps, apns, fcm));
  schedule("retention", 24 * 60 * 60_000, () => runRetention(deps));

  return () => {
    unwake.forEach((stop) => stop());
    timers.forEach((t) => clearInterval(t));
  };
}
