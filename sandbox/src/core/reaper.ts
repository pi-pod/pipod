import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { ResumeClockGuard } from "./resume-clock.js";
import type { Config } from "../config.js";
import type { Store } from "../db/index.js";
import type { Logger } from "../log.js";
import { Metrics } from "../metrics.js";
import type { Manager } from "./manager.js";
import type { CgroupTree } from "../runtime/cgroup.js";
import type { ObjectStore } from "../archive/types.js";

const MINUTE = 60_000;
/**
 * Tenant usage ratio that starts graceful shedding: at 90% of the tenant aggregate cap
 * the reaper freezes/stops that tenant's idle sandboxes, well before the kernel cap fires.
 */
export const TENANT_PRESSURE_USAGE_RATIO = 0.9;

/**
 * One loop over SQLite timers (§6.2). The service is always up, so these windows are honored
 * exactly rather than "whenever a launcher next runs".
 */
export class Reaper {
  private timer?: NodeJS.Timeout;
  private lastDrSnapshot = 0;
  private lastHousekeeping = 0;
  private running = false;
  private readonly resumeClock: ResumeClockGuard;
  /**
   * Archives this reaper has launched and not yet seen finish. Packing runs off the tick so
   * a slow upload cannot delay idle-stop detection, and the set (plus the manager's own slot
   * bound) keeps the resulting wave rate-limited (§3.2).
   */
  private readonly archiving = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly manager: Manager,
    private readonly cgroups: CgroupTree,
    private readonly objects: ObjectStore,
    private readonly log: Logger,
    private readonly metrics: Metrics = Metrics.none(),
  ) {
    this.resumeClock = new ResumeClockGuard(Date.now(), performance.now(), Math.max(60_000, cfg.reaperIntervalMs * 4));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.reaperIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Shadow shutdown must not close SQLite under a running tick/archive. */
  async quiesce(timeoutMs:number):Promise<void>{
    const deadline=Date.now()+timeoutMs;
    while(this.running || this.archiving.size>0){
      if(Date.now()>=deadline)throw new Error("reaper work did not drain");
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }

  /** Archives launched by ticks that have not completed; tests await this. */
  get archivesInFlight(): number {
    return this.archiving.size;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.manager.observations?.held()) return;
    this.running = true;
    const started = process.hrtime.bigint();
    try {
      if (this.cfg.hostBackend === "boat" && this.resumeClock.observe(now, performance.now())) {
        this.store.rebaseTimers(now);
        this.lastDrSnapshot = now;
        this.lastHousekeeping = now;
        this.log.info("resume clock gap detected; rebased idle/archive timers");
      }
      const maxArchives = this.cfg.admission?.maxConcurrentArchives ?? 2;
      // Sandboxes whose cgroup CPU moved this tick: the same veto the idle stop honours, kept
      // for the pressure path so relief never kills quiet-but-active work (§3.3).
      const busyThisTick = new Set<string>();
      for (const row of this.store.all()) {
        // start()/restore holds this across unpack+launch. A restore briefly looks
        // stopped; packing it here races the wake and archives the sandbox again.
        if (this.manager.isTransitioning(row.id)) continue;
        const idleMs = now - row.lastActivityAt;

        if (row.tier === "hot" || row.tier === "warm") {
          const cgroup = this.manager.cgroupOf(row.id);
          const cpuUsec = cgroup.exists() ? cgroup.stats().cpuUsec : row.lastCpuUsec;
          const busy = (cpuUsec - row.lastCpuUsec) / 1000 > this.cfg.cpuVetoMs;
          this.store.setCpuUsec(row.id, cpuUsec);
          if (busy) busyThisTick.add(row.id);

          if (row.idleTimeoutMinutes > 0 && idleMs > row.idleTimeoutMinutes * MINUTE) {
            // Cgroup activity is the safety net for a detached pod doing real work with no
            // keepalive traffic to show for it (§6.1).
            if (busy) {
              this.log.debug({ sandbox: row.id }, "idle timeout vetoed by cgroup activity");
              this.metrics.recordReaperAction("cpu_veto", "ok");
            } else {
              this.log.info({ sandbox: row.id }, "stopping idle sandbox");
              try {
                await this.manager.stop(row.id,30_000,{automatic:true});
                this.metrics.recordReaperAction("idle_stop", "ok");
              } catch (err) {
                this.metrics.recordReaperAction("idle_stop", "error");
                this.log.warn({ err }, "idle stop failed");
              }
              continue;
            }
          }

          if (
            row.tier === "hot" &&
            this.cfg.warmAfterMinutes > 0 &&
            idleMs > this.cfg.warmAfterMinutes * MINUTE &&
            !busy
          ) {
            try {
              const froze = await this.manager.freeze(row.id);
              this.metrics.recordReaperAction("freeze", froze ? "ok" : "noop");
            } catch (err) {
              this.metrics.recordReaperAction("freeze", "error");
              this.log.warn({ err }, "freeze failed");
            }
          }
          continue;
        }

        if (
          row.tier === "stopped" &&
          row.archiveAfterMinutes > 0 &&
          row.stoppedAt !== null &&
          now - row.stoppedAt > row.archiveAfterMinutes * MINUTE &&
          this.objects.kind !== "none" &&
          !this.archiving.has(row.id)
        ) {
          if (this.archiving.size >= maxArchives) {
            // Overdue work is visible, not silently dropped; it is picked up next tick.
            this.metrics.recordReaperAction("archive_skipped", "noop");
            continue;
          }
          this.log.info({ sandbox: row.id, revision: row.revision }, "archiving long-stopped sandbox");
          this.archiving.add(row.id);
          // The revision and stop timestamp read here travel with the request, so a wake that
          // lands between this read and the pack makes the pack a no-op instead of a re-archive.
          void this.manager
            .archiveIfStopped(row.id, {
              expectedRevision: row.revision,
              expectedStoppedAt: new Date(row.stoppedAt).toISOString(),
            })
            .then((outcome) => {
              this.metrics.recordReaperAction("archive", outcome.archived ? "ok" : "noop");
              if (!outcome.archived) {
                this.log.info({ sandbox: row.id, outcome: outcome.outcome }, "archive skipped");
              }
            })
            .catch((err) => {
              this.metrics.recordReaperAction("archive", "error");
              this.log.warn({ err, sandbox: row.id }, "archive failed");
            })
            .finally(() => this.archiving.delete(row.id));
        }
      }

      this.expireGrants();
      await this.relieveHostPressure(now, busyThisTick);
      await this.snapshotForDisasterRecovery(now);
      this.housekeep(now);
      this.metrics.recordReaperTick("ok", Number(process.hrtime.bigint() - started) / 1e9);
    } catch (error) {
      this.metrics.recordReaperTick("error", Number(process.hrtime.bigint() - started) / 1e9);
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Grant ttls are host-local; the reaper is the clock that applies the fallback (§7.3). */
  private expireGrants(): void {
    if (typeof this.manager.expireGrants !== "function") return;
    try {
      const expired = this.manager.expireGrants();
      for (let i = 0; i < expired; i++) this.metrics.recordReaperAction("grant_expired", "ok");
    } catch (err) {
      this.log.warn({ err }, "grant expiry failed");
    }
  }

  private housekeep(now: number): void {
    if (typeof this.manager.housekeeping !== "function") return;
    if (now - this.lastHousekeeping < MINUTE) return;
    this.lastHousekeeping = now;
    this.manager.housekeeping();
  }

  /**
   * Freeze the longest-idle hot sandboxes first, then stop them — never OOM the service (§7.2).
   * Every candidate must pass the same genuine-idleness test as a normal idle stop: no CPU
   * movement this tick and, for a stop, past its own idle window (or a warm sandbox that has
   * been silent for at least the warm window when it has no idle timeout). A sandbox awaiting a
   * model, approval or network reply is never stopped for pressure; when no candidate qualifies
   * the reaper reports it instead of guessing.
   */
  private async relieveHostPressure(now: number = Date.now(), busy: ReadonlySet<string> = new Set()): Promise<void> {
    const pressure = this.cgroups.hostPressure();
    if (pressure >= 0 && pressure >= this.cfg.pressureThreshold) {
      const byIdle = this.store
        .all()
        .filter((r) => !busy.has(r.id) && !this.manager.isTransitioning(r.id))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      await this.shedOne("host", pressure, byIdle, (r) => this.genuinelyIdle(r, now));
    }
    await this.relieveTenantPressure(now, busy);
  }

  /**
   * Tenant-aggregate shedding: a tenant approaching its kernel cap sheds its own idle
   * sandboxes *before* the kernel OOM-kills inside the tenant subtree. This fires even
   * when host-wide PSI looks healthy (a tenant can hit its 5.5 GiB cap while the host
   * still has swap), which is exactly the gap that used to end in global OOM. Workspaces
   * are unaffected: freeze/stop preserve them, and active sandboxes are never touched.
   */
  private async relieveTenantPressure(now: number, busy: ReadonlySet<string>): Promise<void> {
    if (typeof this.cgroups.listTenantKeys !== "function") return;
    let keys: string[];
    try {
      keys = this.cgroups.listTenantKeys();
    } catch {
      return;
    }
    for (const key of keys) {
      let usage;
      try {
        usage = this.cgroups.tenant(key).memoryUsage();
      } catch {
        continue;
      }
      if (!usage || usage.max === null || usage.max <= 0) continue;
      const ratio = usage.current / usage.max;
      if (ratio < TENANT_PRESSURE_USAGE_RATIO) continue;
      const byIdle = this.store
        .all()
        .filter((r) => r.ownerKey === key && !busy.has(r.id) && !this.manager.isTransitioning(r.id))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      await this.shedOne(`tenant:${key}`, ratio, byIdle, (r) => this.genuinelyIdle(r, now));
    }
  }

  private genuinelyIdle(r: { lastActivityAt: number; idleTimeoutMinutes: number }, now: number): boolean {
    const idleMs = now - r.lastActivityAt;
    const window = r.idleTimeoutMinutes > 0 ? r.idleTimeoutMinutes : this.cfg.warmAfterMinutes;
    return window > 0 && idleMs > window * MINUTE;
  }

  /** Freeze the longest-idle hot candidate, else stop a genuinely-idle warm one, else report. */
  private async shedOne<T extends { id: string; tier: string }>(
    scope: string,
    pressure: number,
    byIdle: T[],
    genuinelyIdle: (r: T) => boolean,
  ): Promise<void> {
    const hot = byIdle.find((r) => r.tier === "hot");
    if (hot) {
      this.log.warn({ pressure, scope, sandbox: hot.id }, "memory pressure; freezing longest-idle sandbox");
      try {
        const froze = await this.manager.freeze(hot.id);
        this.metrics.recordReaperAction("pressure_freeze", froze ? "ok" : "noop");
      } catch {
        this.metrics.recordReaperAction("pressure_freeze", "error");
      }
      return;
    }
    const warm = byIdle.find((r) => r.tier === "warm" && genuinelyIdle(r));
    if (warm) {
      this.log.warn({ pressure, scope, sandbox: warm.id }, "memory pressure persisting; stopping longest-idle genuinely idle sandbox");
      try {
        await this.manager.stop(warm.id,30_000,{automatic:true});
        this.metrics.recordReaperAction("pressure_stop", "ok");
      } catch {
        this.metrics.recordReaperAction("pressure_stop", "error");
      }
      return;
    }
    this.log.warn({ pressure, scope }, "memory pressure but every sandbox is active or within its idle window; nothing stopped");
    this.metrics.recordReaperAction("pressure_stop", "noop");
  }

  /** Archived workspaces already survive host loss; this extends that to the metadata (§5.2). */
  private async snapshotForDisasterRecovery(now: number): Promise<void> {
    if (this.cfg.drIntervalMinutes <= 0 || this.objects.kind === "none") return;
    if (now - this.lastDrSnapshot < this.cfg.drIntervalMinutes * MINUTE) return;
    this.lastDrSnapshot = now;
    const file = path.join(this.cfg.paths.spool, `dr-${new Date(now).toISOString()}.sqlite`);
    try {
      this.store.backupTo(file);
      // Hosts in a fleet share one bucket and prefix, so the snapshot key carries the host.
      await this.objects.put(
        `_dr/${this.cfg.hostId}/sandbox-${new Date(now).toISOString()}.sqlite`,
        file,
      );
      this.log.info("uploaded disaster-recovery snapshot");
      this.metrics.recordReaperAction("dr_snapshot", "ok");
    } catch (err) {
      this.metrics.recordReaperAction("dr_snapshot", "error");
      this.log.warn({ err }, "disaster-recovery snapshot failed");
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}
