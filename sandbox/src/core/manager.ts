import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.js";
import {
  ServiceError,
  archiveMismatch,
  badRequest,
  capacityDenied,
  conflict,
  idempotencyConflict,
  imageMismatch,
  notFound,
  ownerConflict,
  ownerRequired,
  sandboxHeld,
  staleRevision,
  timedOut,
} from "../errors.js";
import type { Logger } from "../log.js";
import { Metrics, type AdmissionResource, type MetricsSnapshot, type OpResult } from "../metrics.js";
import { Store, type SandboxRow, type Tier } from "../db/index.js";
import type { ImageStore } from "../images/types.js";
import type { ListedObject, ObjectStore } from "../archive/types.js";
import { packDir, unpackDir } from "../archive/pack.js";
import { CgroupTree, type Cgroup, type ExtendedCgroupStats, type TenantCgroup } from "../runtime/cgroup.js";
import { INIT_PATH, Runtime, findInitBinary } from "../runtime/crun.js";
import { SandboxDisks } from "../runtime/disk.js";
import { Network, netnsPath, resolveEgress } from "../runtime/netns.js";
import { mountOverlay, unmountOverlay, unmountOverlayVerified } from "../runtime/overlay.js";
import { AdmissionController, type ReservationKind, type ReservationRow, type RuntimeProbeResult } from "./admission.js";
import { OperationLedger, type OperationRow } from "./operations.js";
import { SingletonSlot } from "./singleton.js";
import { ShadowObservationJournal, ShadowUncertainExecution, type ShadowIdentity } from "./service-observation-journal.js";
import { launchWithShadowObservation } from "./shadow-launch.js";
import { PtyRegistry, type PtySession } from "./pty.js";
import { loadOrCreateHostSecret, type HostSecret } from "./secrets.js";
import {
  assertSupportedShape,
  limitsFor,
  maximumShape,
  memoryReservationBytes,
  normalizeResourcePolicy,
  resolveCeiling,
  resolveGuarantee,
  standardShape,
} from "./resources.js";
import { CpuGrants, validateOwnerKey, type FallbackContext } from "./tenancy.js";
import { sha256File } from "../archive/pack.js";
import { UsageLedger, buildUsageSample, countersFrom, type UsageEventInput } from "./usage.js";
import { EvidenceKey } from "./evidence-key.js";
import {
  CAPACITY_CONTRACT_VERSION,
  ERR_TIMEOUT,
  HOLD_HOLDER,
  OPERATION_KEY,
  type ArchiveReference,
  type ArchiveReferenceWire,
  type ArchiveIfStoppedOutcome,
  type ArchiveIfStoppedRequest,
  type ArchiveIfStoppedResponse,
  type CapacityReportV1,
  type CpuGrantRequest,
  type CpuGrantResponse,
  type CreateSandboxRequest,
  type ImportSandboxRequest,
  type OperationStatusWire,
  type OwnerInitResponse,
  type ResourceSpec,
  type RetireRequest,
  type RetireResponse,
  type SandboxHold,
  type SandboxInfoWire,
  type SandboxState,
  type SandboxTransition,
  type TenantStatusWire,
  type UsageSampleWire,
  type UsageSnapshotV1,
} from "../wire.js";

/** Imported ids name filesystem paths and object keys, so they are matched, never trusted. */
const SANDBOX_ID = /^sb-[A-Za-z0-9]{8,40}$/;
const ARCHIVE_KEY = /\/upper-([0-9a-f]{64})\.tar\.zst$/;
const GB = 1024 ** 3;
/** Terminal journal rows older than this are purged by housekeeping. */
const JOURNAL_RETENTION_MS = 7 * 24 * 3_600_000;

/** Cleanup completed while the create still owns its sandbox queue. */
class CreateStartFailure extends Error {
  constructor(readonly original:unknown,readonly cleanupOk:boolean){
    super(original instanceof Error?original.message:String(original),{cause:original});
    this.name="CreateStartFailure";
  }
}

export interface ExecSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Internal disconnect/stop cancellation; never serialized into the guest env. */
  signal?:AbortSignal;
}

export interface ExecHooks {
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
  onStarted?(kill: (signal?: NodeJS.Signals) => void, stdin: Writable): void;
}

/** Optional collaborators; defaults are built from the store so existing callers keep working. */
export interface ManagerExtras {
  bootId?: string;
  admission?: AdmissionController;
  operations?: OperationLedger;
  usage?: UsageLedger;
  evidence?: EvidenceKey | null;
  grants?: CpuGrants;
  serviceVersion?: string;
  /** Host-local fingerprint key; loaded from the state volume when omitted. */
  secret?: HostSecret;
  observations?: ShadowObservationJournal;
  /** Clock for the archived-heartbeat UTC day; defaults to Date.now (tests pin it). */
  now?: () => number;
  /**
   * Allocated-blocks stat for usage snapshots; defaults to fs.statSync. Injectable so
   * tests can assert the heartbeat path performs zero stats without module mocking.
   */
  statSync?: (path: string) => fs.Stats;
}

const TIER_TO_STATE: Record<Tier, SandboxState> = {
  // WARM is an internal cost optimization, not a contract state (§4).
  hot: "started",
  warm: "started",
  stopped: "stopped",
  archived: "archived",
  error: "error",
};

/** HTTP status for a replayed operation error, derived from its code (never stored raw). */
function statusForCode(code: string): number {
  switch (code) {
    case "admission_denied":
      return 507;
    case "unsupported_shape":
    case "bad_request":
      return 400;
    case "conflict":
    case "idempotency_conflict":
    case "stale_revision":
    case "owner_conflict":
      return 409;
    case "owner_required":
      return 400;
    case "not_found":
      return 404;
    case "timeout":
      return 504;
    default:
      return 500;
  }
}

export class Manager {
  readonly ptys = new PtyRegistry();
  readonly bootId: string;
  readonly admission: AdmissionController;
  readonly operations: OperationLedger;
  readonly usage: UsageLedger;
  readonly grants: CpuGrants;
  readonly singleton: SingletonSlot;
  readonly observations: ShadowObservationJournal | null;
  private readonly secret: HostSecret;
  private readonly serviceVersion: string;
  private readonly disks: SandboxDisks;
  private readonly envs = new Map<string, Record<string, string>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Sandboxes held by a lifecycle transition, by kind. Only a start/restore is a "starting"
   * state on the wire; reporting every transition as starting made the control plane treat a
   * two-second archive as a boot and suspend polling for its start grace window.
   */
  private readonly transitioning = new Map<string, SandboxTransition>();
  /** Admitted sandboxes that have not reached HOT yet (legacy gauge; reservations are authoritative). */
  private readonly booting = new Set<string>();
  private readonly imageConfigs = new Map<string, { env: string[]; workingDir?: string }>();
  /** In-flight creates by operation key, so a same-key retry joins instead of duplicating. */
  private readonly pendingCreates = new Map<string, Promise<SandboxInfoWire>>();
  /** Excludes deletion/retirement while a small create is still pulling or rolling back. */
  private singletonQueue:Promise<unknown>=Promise.resolve();
  private shadowAsyncWork=0;
  private readonly shadowChildren=new Map<ChildProcess,string>();
  private readonly shadowWorkBySandbox=new Map<string,Set<AbortController>>();

  get shadowWorkInFlight():number{return this.shadowAsyncWork+this.shadowChildren.size+this.ptys.aliveCount()+
    this.booting.size+this.transitioning.size+this.archiving.size+this.pendingCreates.size;}

  private hasShadowWork(id:string):boolean{return (this.shadowWorkBySandbox.get(id)?.size??0)>0 ||
    [...this.shadowChildren.values()].includes(id) || this.ptys.listFor(id).some(session=>session.alive);}
  private abortShadowWork(id:string):void{for(const controller of this.shadowWorkBySandbox.get(id)??[])controller.abort();}

  private beginShadowWork(id:string):{signal?:AbortSignal;abort:()=>void;finish:()=>void}{
    if(!this.observations)return {abort:()=>{},finish:()=>{}};
    const controller=new AbortController();
    const set=this.shadowWorkBySandbox.get(id)??new Set<AbortController>();
    set.add(controller);this.shadowWorkBySandbox.set(id,set);this.shadowAsyncWork++;
    let finished=false;
    return {signal:controller.signal,abort:()=>controller.abort(),finish:()=>{
      if(finished)return;finished=true;set.delete(controller);
      if(set.size===0)this.shadowWorkBySandbox.delete(id);
      this.shadowAsyncWork--;
    }};
  }

  private trackShadowChild(child:ChildProcess,sandboxId:string,onClose?:()=>void):void{
    if(!this.observations)return;
    this.shadowChildren.set(child,sandboxId);
    child.once("error",()=>{
      try{this.observations?.markHold("sandbox-child-outcome-uncertain",sandboxId);}catch{}
    });
    child.once("close",()=>{this.shadowChildren.delete(child);onClose?.()});
  }

  private async waitForShadowChildren(sandboxId:string,timeoutMs:number):Promise<void>{
    const children=[...this.shadowChildren].filter(([,id])=>id===sandboxId).map(([child])=>child);
    await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{
      let timer:NodeJS.Timeout;
      const cleanup=()=>{clearTimeout(timer);child.off("close",done)};
      const done=()=>{cleanup();resolve()};
      timer=setTimeout(()=>{cleanup();reject(new Error("sandbox exec child did not exit"));},timeoutMs);
      child.once("close",done);
    })));
  }
  /** Ids currently packing; bounded by `cfg.admission.maxConcurrentArchives`. */
  private readonly archiving = new Set<string>();
  private capacityGeneration = 0;
  /**
   * Archived-heartbeat dedup (§8.1.1): sandbox id → UTC day + fingerprint of the last
   * emitted heartbeat. In-memory only, so a (re)boot re-emits every heartbeat on its
   * first poll; stale-day entries are swept once the map grows past its bound.
   */
  private readonly usageHeartbeats = new Map<string, { day: string; fingerprint: string }>();
  private readonly clock: () => number;
  private readonly statSyncFn: (path: string) => fs.Stats;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly images: ImageStore,
    private readonly runtime: Runtime,
    private readonly network: Network,
    private readonly cgroups: CgroupTree,
    private readonly objects: ObjectStore,
    private readonly log: Logger,
    private readonly metrics: Metrics = Metrics.none(),
    extras: ManagerExtras = {},
  ) {
    this.singleton = new SingletonSlot(store.database, cfg.profile === "small-v1");
    this.observations = extras.observations ?? null;
    this.disks = new SandboxDisks(cfg.paths.sandboxes, cfg.reserveDiskBytes, cfg.admission.diskMode === "sparse");
    this.bootId = extras.bootId ?? randomUUID();
    this.serviceVersion = extras.serviceVersion ?? "0.1.0";
    this.admission =
      extras.admission ??
      new AdmissionController(store.database, cfg, this.disks, {
        bootId: this.bootId,
        spoolDir: cfg.paths.spool,
      });
    // Fingerprints are keyed by a stable host-local secret, not the rotating master token:
    // a token rotation must not turn every legitimate retry into an idempotency conflict.
    this.secret = extras.secret ?? loadOrCreateHostSecret(cfg.paths.db);
    this.operations =
      extras.operations ??
      new OperationLedger(store.database, {
        secret: this.secret.key.toString("hex"),
        retentionMs: cfg.operations.retentionMs,
        bootId: this.bootId,
      });
    this.usage =
      extras.usage ??
      new UsageLedger(store.database, {
        hostId: cfg.hostId,
        bootId: this.bootId,
        maxRows: cfg.usage.maxEventRows,
        maxAgeMs: cfg.usage.maxEventAgeMs,
        maxSnapshotRows: cfg.usage.maxSnapshotRows,
        // Off unless the profile opts in; a key is created only when signing is on.
        evidence: cfg.usage.evidenceSigning
          ? (extras.evidence ?? EvidenceKey.loadOrCreate(cfg.stateDir))
          : null,
      });
    this.clock = extras.now ?? Date.now;
    this.statSyncFn = extras.statSync ?? ((p: string) => fs.statSync(p));
    this.grants =
      extras.grants ??
      new CpuGrants(store.database, { fallbackCores: cfg.tenancy.cpuFallbackCores, bootId: this.bootId });
  }

  /** Inputs for the bounded local CPU fallback: host budget split across owners with live sandboxes. */
  private fallbackContext(rows: SandboxRow[] = this.store.all()): FallbackContext {
    const owners = new Set<string>();
    for (const row of rows) {
      if ((row.tier === "hot" || row.tier === "warm") && row.ownerKey) owners.add(row.ownerKey);
    }
    return { budgetCores: Math.max(0, os.cpus().length - this.cfg.reserveCpu), activeOwners: owners.size };
  }

  /**
   * Grant-managed hosts do not expand a tenant's footprint while that tenant runs on the
   * fallback (§7.3): existing sandboxes keep running, new grant-requiring launches wait for
   * the allocator. Never gates unowned sandboxes or a host that was never grant-managed.
   */
  private assertFairnessAvailable(ownerKey: string | null, rows: SandboxRow[], what = "launch"): void {
    // Rollout switch: once owners are initialized, an unowned row may not relaunch flat.
    if (!ownerKey && this.cfg.tenancy.requireOwner) {
      this.metrics.recordAdmission("denied", "other");
      throw ownerRequired(what);
    }
    if (!ownerKey || !this.cfg.tenancy.gateDegradedAdmission || !this.grants.managedMode()) return;
    const status = this.grants.status(ownerKey, this.fallbackContext(rows));
    if (status.state === "active") return;
    this.metrics.recordAdmission("denied", "other");
    throw capacityDenied(
      {
        reason: "fairness_degraded",
        resource: "fairness",
        unit: "count",
        required: 1,
        available: 0,
        retryable: true,
        retryAfterMs: 15_000,
      },
      "the CPU allocator has not issued a current grant for this tenant on this host; retry once it recovers",
    );
  }

  /* --------------------------------------------------------------- paths */

  private dir(id: string): string {
    return path.join(this.cfg.paths.sandboxes, id);
  }
  private upperDir(id: string): string {
    return this.disks.layout(id).upper;
  }
  private mergedDir(id: string): string {
    return path.join(this.dir(id), "merged");
  }
  private bundleDir(id: string): string {
    return path.join(this.dir(id), "bundle");
  }

  /** The cgroup a sandbox was actually placed at; legacy flat layout when the row has none. */
  private cgroupFor(row: SandboxRow): Cgroup {
    return row.cgroupRel ? this.cgroups.at(row.cgroupRel) : this.cgroups.sandbox(row.id);
  }

  private cgroup(id: string): Cgroup {
    const row = this.store.get(id);
    return row ? this.cgroupFor(row) : this.cgroups.sandbox(id);
  }

  private tenantOf(row: SandboxRow): TenantCgroup | null {
    return row.ownerKey ? this.cgroups.tenant(row.ownerKey) : null;
  }

  /**
   * Kernel aggregate caps for one tenant parent: equal weight, CPU (the grant's cores on
   * grant-managed hosts, the boat aggregate CPU cap when unmanaged on a boat host, uncapped
   * weights otherwise) and the tenant memory kill boundary. Throws conflict when the
   * kernel rejects the memory cap so the launch is refused instead of running uncapped.
   */
  private applyTenantLimits(userKey: string): void {
    const tenant = this.cgroups.tenant(userKey);
    tenant.ensure();
    const grant = this.grants.status(userKey, this.fallbackContext());
    const cpuApplied=tenant.setCpuMax(
      this.grants.managedMode() || this.cfg.hostBackend !== "boat"
        ? grant.effectiveCores
        : this.cfg.tenancy.tenantCpuMaxCores,
    );
    if(this.singleton.enabled && (!cpuApplied || tenant.currentCpuMax()!==this.cfg.tenancy.tenantCpuMaxCores))
      throw conflict("small VM tenant CPU cap not verified");
    const memoryMaxBytes = this.cfg.tenancy.tenantMemoryMaxBytes;
    if (memoryMaxBytes !== null && !tenant.setMemoryMax(memoryMaxBytes)) {
      throw conflict(
        `tenant memory cap could not be applied for ${userKey}`,
        "check that the memory controller is enabled for the service's cgroup subtree",
      );
    }
    if(this.singleton.enabled && !tenant.setSwapMaxZero())
      throw conflict("small VM tenant swap exclusion not verified");
  }

  /**
   * Re-apply tenant caps to an already-running adopted sandbox. Unlike a fresh launch,
   * a rejected write here must not lose the adoption: admission still bounds new work
   * and the next controlled start re-applies the caps.
   */
  private ensureTenantLimitsTolerant(userKey: string, sandboxId: string): void {
    try {
      this.applyTenantLimits(userKey);
    } catch (err) {
      if(this.singleton.enabled)throw err;
      this.log.error({ err, sandbox: sandboxId }, "tenant aggregate caps did not apply to adopted sandbox");
    }
  }

  /* ---------------------------------------------------------- serialization */

  private serializeSingleton<T>(fn:()=>Promise<T>):Promise<T>{
    if(!this.singleton.enabled)return fn();
    const next=this.singletonQueue.then(fn,fn);
    this.singletonQueue=next.catch(()=>undefined);
    return next;
  }

  /** Lifecycle transitions for one sandbox never interleave; everything else may. */
  private serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.queues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  private async timed<T>(op: Parameters<Metrics["startTimer"]>[0], fn: () => Promise<{ value: T; result?: OpResult }>): Promise<T> {
    const stop = this.metrics.startTimer(op);
    try {
      const out = await fn();
      this.metrics.recordSandboxOp(op, out.result ?? "ok");
      return out.value;
    } catch (error) {
      this.metrics.recordSandboxOp(op, "error");
      throw error;
    } finally {
      stop();
    }
  }

  /* -------------------------------------------------------------- metering */

  /** Metering never blocks or fails lifecycle work (§8.2). */
  private meter(event: UsageEventInput): void {
    try {
      if (this.usage.record(event) === null) {
        this.log.warn({ sandbox: event.sandboxId, kind: event.kind }, "usage event was not recorded");
      }
    } catch (err) {
      this.log.warn({ err, sandbox: event.sandboxId, kind: event.kind }, "usage event failed");
    }
  }

  private safeStats(row: SandboxRow): ExtendedCgroupStats | null {
    try {
      const cgroup = this.cgroupFor(row);
      return cgroup.exists() ? cgroup.extendedStats() : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------ admission */

  private recordDenial(err: unknown): void {
    if (err instanceof ServiceError && err.details?.kind === "admission") {
      const resource: AdmissionResource =
        err.details.resource === "shape" || err.details.resource === "transitions" || err.details.resource === "fairness"
          ? "other"
          : err.details.resource;
      this.metrics.recordAdmission("denied", resource);
    }
  }

  /** Reserve desired totals for a transition; records the metric either way and rethrows. */
  private reserve(
    operationId: string,
    row: Pick<SandboxRow, "id" | "resources" | "ceiling">,
    kind: ReservationKind,
    rows: SandboxRow[],
    desired?: { memoryBytes?: number; diskBytes?: number },
  ): ReservationRow {
    const guarantee = resolveGuarantee(this.cfg, row.resources);
    const ceiling = row.ceiling;
    try {
      const reservation = this.admission.reserve(
        {
          operationId,
          sandboxId: row.id,
          kind,
          desiredMemoryBytes: desired?.memoryBytes ?? memoryReservationBytes(this.cfg, guarantee, ceiling),
          desiredDiskBytes: desired?.diskBytes ?? (ceiling.diskGB ?? guarantee.diskGB) * GB,
          desiredCpuFloor: guarantee.cpu,
        },
        rows,
      );
      this.metrics.recordAdmission("ok", "none");
      return reservation;
    } catch (err) {
      this.recordDenial(err);
      throw err;
    }
  }

  /** Release only after cleanup is confirmed; anything uncertain stays charged. */
  private settleReservation(operationId: string, cleanupOk: boolean, why: string): void {
    try {
      if (cleanupOk) this.admission.release(operationId);
      else this.admission.quarantine(operationId, why);
    } catch (err) {
      this.log.warn({ err, operationId }, "could not settle reservation");
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async init(): Promise<void> {
    // A previous boot's unknown execution may still be live. Do not publish
    // readiness merely because recovery only revisits reserved rows.
    if(this.singleton.enabled && this.admission.active().some(r=>r.status==="quarantined"))
      throw new Error("small VM has unresolved admission custody");
    if(this.singleton.enabled && this.grants.managedMode())
      throw new Error("small VM cannot boot with shared-fleet CPU grants");
    if(this.singleton.enabled)for(const row of this.store.all()){
      this.singleton.assert(row.id,row.ownerKey);
      if(row.resources.diskGB!==this.cfg.defaults.diskGB ||
        (row.ceiling.diskGB!==undefined && row.ceiling.diskGB!==this.cfg.defaults.diskGB) ||
        (this.disks.hasImage(row.id) &&
          fs.statSync(this.disks.layout(row.id).image).size!==8_000_000_000))
        throw new Error("small VM retained sandbox quota/profile mismatch");
    }
    for (const dir of Object.values(this.cfg.paths)) fs.mkdirSync(dir, { recursive: true });
    this.cgroups.ensure({ memoryBytes: this.cfg.fleet.memoryBytes, cpu: this.cfg.fleet.cpu },this.singleton.enabled);
    if (this.cfg.hostBackend === "boat") {
      // Observable at every boot so an uncapped boat host can never pass as configured:
      // boat mode already fails closed at config load when the memory cap is missing.
      this.log.info(
        {
          tenantMemoryMaxBytes: this.cfg.tenancy.tenantMemoryMaxBytes,
          tenantCpuMaxCores: this.cfg.tenancy.tenantCpuMaxCores,
        },
        "boat tenant aggregate caps in force",
      );
    }
    this.normalizeStoredResources();
    await this.network.ensureBridge();
    await this.reconcile();
    await this.recoverJournal();
    if(this.singleton.enabled && this.admission.active().some(r=>r.status==="quarantined"))
      throw new Error("small VM recovery left unresolved admission custody");
    if (this.cfg.hostBackend === "boat") this.store.rebaseTimers(this.clock());
    this.cleanupTenantParents();
    this.housekeeping();
  }

  /** Migrate variable legacy guarantees to the fixed floor while preserving them as ceilings. */
  private normalizeStoredResources(): void {
    for (const row of this.store.all()) {
      const { guarantee, ceiling } = normalizeResourcePolicy(this.cfg, row.resources, row.ceiling);
      if (
        JSON.stringify(row.resources) !== JSON.stringify(guarantee) ||
        JSON.stringify(row.ceiling) !== JSON.stringify(ceiling)
      ) {
        this.store.setResources(row.id, guarantee, ceiling);
      }
    }
  }

  /**
   * Startup reconcile (§6.4). Sandbox processes are children of the service *container*, so
   * a bare process restart may find them still running — adopting those is strictly better
   * than the design's "mark everything stopped", and the outcome when they are gone is
   * exactly that fallback. PTY sessions never survive: their master fds died with the process.
   */
  private async reconcile(): Promise<void> {
    for (const row of this.store.all()) {
      if (row.tier !== "hot" && row.tier !== "warm") continue;
      let state: { status: string; pid: number } | null;
      try {
        state = await this.runtime.state(row.id);
      } catch (err) {
        // The probe failed, which is not the same as "gone": leave the row as it is (still
        // charged, still fenced by its tier) and retry at the next reconcile.
        this.log.error({ err, sandbox: row.id }, "runtime state unknown after restart; keeping the row as-is");
        this.metrics.recordSandboxOp("reconcile_stop", "error");
        if(this.singleton.enabled)throw err;
        continue;
      }
      const running = state?.status === "running" || state?.status === "paused";
      if (state !== null && !running && state.status !== "stopped") {
        // creating/created: a process tree may exist and may still start. Not live, not gone;
        // keep the row and its charge, never tear it down on a guess.
        this.log.warn({ sandbox: row.id, status: state.status }, "runtime in a transitional state after restart; keeping the row as-is");
        this.metrics.recordSandboxOp("reconcile_stop", "error");
        if(this.singleton.enabled)throw new Error("small VM retained runtime state is transitional");
        continue;
      }
      // Pre-quota sandboxes must stop once so their legacy upper directory can be copied
      // into a bounded filesystem. Adopting one would silently preserve unlimited writes.
      if (running && fs.existsSync(this.mergedDir(row.id)) && this.disks.hasImage(row.id)) {
        if(this.singleton.enabled){
          if(!row.ownerKey || row.cgroupRel!==`/pps/tenant-${row.ownerKey}/${row.id}`)
            throw new Error("small VM retained process has wrong tenant placement");
          this.applyTenantLimits(row.ownerKey);
          if(!this.cgroupFor(row).applyLimitsVerified(
            limitsFor(resolveGuarantee(this.cfg,row.resources),row.ceiling,this.cfg.maxPids)).ok)
            throw new Error("small VM retained process limits not verified");
        }else{
          const tenant = this.tenantOf(row);
          if (tenant && row.cgroupRel) this.ensureTenantLimitsTolerant(row.ownerKey!, row.id);
          this.cgroupFor(row).applyLimits(
            limitsFor(resolveGuarantee(this.cfg, row.resources), row.ceiling, this.cfg.maxPids),
          );
        }
        this.log.info({ sandbox: row.id, tier: row.tier }, "adopted running sandbox after restart");
        this.metrics.recordSandboxOp("reconcile_adopt", "ok");
        continue;
      }
      if(this.singleton.enabled && running)
        throw new Error("small VM live runtime lacks a verified workspace; refusing startup teardown");
      this.log.info({ sandbox: row.id }, "sandbox did not survive service restart; marking stopped");
      if(this.singleton.enabled)await this.teardown(row);
      else await this.teardown(row).catch((err) => this.log.warn({ err, sandbox: row.id }, "teardown failed"));
      this.store.setTier(row.id, "stopped", { stoppedAt: Date.now() });
      this.meter({ kind: "stopped", sandboxId: row.id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { reason: "service_restart" } });
      this.metrics.recordSandboxOp("reconcile_stop", "ok");
    }
  }

  /**
   * Journal recovery (§6.2). Nothing is torn down here: a create interrupted by a restart
   * is *adopted* when its process is still running (the row becomes hot and the operation
   * succeeds, so the caller finds it by key), and otherwise left in place as a stopped
   * workspace the operation status points at. Every other reservation is resolved by
   * inspecting the runtime, mounts and quota image; uncertain rows stay charged.
   */
  private async recoverJournal(): Promise<void> {
    const interrupted = new Map(this.operations.interruptPending().map((op) => [`create:${op.key}`, op]));
    // Creates whose reservation already committed but whose operation never recorded success
    // (crash between `admission.commit` and `operations.succeed`): the sandbox is real and
    // charged, so the key must resolve to it instead of replaying `interrupted` forever.
    for (const [operationId, op] of interrupted) {
      const reservation = this.admission.get(operationId);
      if (!reservation || reservation.status !== "committed") continue;
      const row = this.store.get(reservation.sandboxId);
      if (row && (row.tier === "hot" || row.tier === "warm") && row.runtimeGeneration >= 1) {
        // reconcile() verified the process of this generation is alive and adopted it.
        if(op.cancelRequested)this.operations.fail(op.key,{code:"cancel_cleanup_pending",
          message:"interrupted cancelled create retains its workspace"},row.id,"quarantined");
        else this.operations.succeed(op.key, row.id, this.info(row.id)!);
        this.log.warn({ sandbox: row.id, operation: op.key }, "linked committed create to its operation after restart");
      } else if (row) {
        // Charged (committed) and retained, but the process did not survive: the caller can
        // still reach it by id; nothing is deleted on a restart alone.
        this.operations.fail(op.key, { code: "interrupted", message: "the sandbox service restarted after the create committed; the workspace was retained" }, row.id, "quarantined");
      } else {
        const clean = !this.disks.hasImage(reservation.sandboxId) && !fs.existsSync(this.dir(reservation.sandboxId));
        this.operations.resolve(op.key, clean ? "cleaned" : "quarantined");
      }
      interrupted.delete(operationId);
    }
    for (const reservation of this.admission.active()) {
      if (reservation.bootId === this.bootId || reservation.kind !== "create" || reservation.status !== "reserved") continue;
      const id = reservation.sandboxId;
      const op = interrupted.get(reservation.operationId) ?? null;
      const row = this.store.get(id);
      if (!row) {
        // The insert never committed (or was rolled back before the crash): nothing to adopt.
        const clean = !this.disks.hasImage(id) && !fs.existsSync(this.dir(id));
        this.settleReservation(reservation.operationId, clean, "interrupted create left files behind");
        if (op) this.operations.resolve(op.key, clean ? "preallocation" : "quarantined");
        continue;
      }
      if (row.tier === "hot" || row.tier === "warm") {
        // reconcile() already adopted the process; the probe below commits the reservation.
        if (op){
          if(op.cancelRequested)this.operations.fail(op.key,{code:"cancel_cleanup_pending",
            message:"interrupted cancelled create retains its workspace"},id,"quarantined");
          else this.operations.succeed(op.key, id, this.info(id)!);
        }
        continue;
      }
      let state: { status: string; pid: number } | null;
      let probeFailed = false;
      try {
        state = await this.runtime.state(id);
      } catch {
        state = null;
        probeFailed = true;
      }
      const running = state?.status === "running" || state?.status === "paused";
      if (state !== null && !running && state.status !== "stopped") probeFailed = true; // transitional = unknown
      if (probeFailed) {
        // Unknown is not gone: keep the charge and the row until a later reconcile can tell.
        this.settleReservation(reservation.operationId, false, "runtime state unknown after restart");
        if (op) this.operations.fail(op.key, { code: "interrupted", message: "the sandbox service restarted and the runtime state could not be determined" }, id, "quarantined");
        if(this.singleton.enabled)throw new Error("small VM interrupted runtime state is unknown");
        continue;
      }
      if (running && fs.existsSync(this.mergedDir(id)) && this.disks.hasImage(id)) {
        // Launched but never recorded: adopt this generation rather than kill it (§6.2).
        if(this.singleton.enabled){
          if(!row.ownerKey || row.cgroupRel!==`/pps/tenant-${row.ownerKey}/${id}`)
            throw new Error("small VM interrupted runtime has wrong tenant placement");
          this.applyTenantLimits(row.ownerKey);
          if(!this.cgroupFor(row).applyLimitsVerified(limitsFor(resolveGuarantee(this.cfg,row.resources),row.ceiling,this.cfg.maxPids)).ok)
            throw new Error("small VM interrupted runtime limits not verified");
        }else{
          if (row.ownerKey) this.ensureTenantLimitsTolerant(row.ownerKey, id);
          this.cgroupFor(row).applyLimits(limitsFor(resolveGuarantee(this.cfg, row.resources), row.ceiling, this.cfg.maxPids));
        }
        this.store.setTier(id, "hot", { stoppedAt: null, error: null });
        this.admission.commit(reservation.operationId);
        if (op){
          if(op.cancelRequested)this.operations.fail(op.key,{code:"cancel_cleanup_pending",
            message:"interrupted cancelled create retains its workspace"},id,"quarantined");
          else this.operations.succeed(op.key, id, this.info(id)!);
        }
        this.log.warn({ sandbox: id, operation: reservation.operationId }, "adopted create interrupted by restart");
        this.metrics.recordSandboxOp("reconcile_adopt", "ok");
        continue;
      }
      // Not running: the stopped row already carries its disk, so the reservation's delta
      // is settled, but the workspace is kept (never deleted on a restart alone) and the
      // operation says so — the caller cleans up by id or resolves it deliberately.
      if (running) {
        this.settleReservation(reservation.operationId, false, "interrupted create has a process but no mounted workspace");
      } else {
        this.admission.release(reservation.operationId);
      }
      if (op) this.operations.fail(op.key, { code: "interrupted", message: "the sandbox service restarted before the create finished; the workspace was retained" }, id, "quarantined");
      if(this.singleton.enabled && running)throw new Error("small VM interrupted runtime lacks a verified workspace");
      this.log.warn({ sandbox: id, operation: reservation.operationId }, "interrupted create retained as a stopped workspace");
    }
    const summary = await this.admission.recover(
      (reservation, row) => this.probeReservation(reservation, row),
      this.store.all(),
    );
    if (summary.quarantined.length > 0) {
      this.log.warn({ quarantined: summary.quarantined }, "reservations quarantined pending operator review");
    }
    for (const op of interrupted.values()) {
      if (this.operations.get(op.key)?.status === "failed") {
        this.log.warn({ operation: op.key, resolution: this.operations.get(op.key)?.resolution }, "create operation interrupted by restart");
      }
    }
  }

  private async probeReservation(reservation: ReservationRow, row: SandboxRow | null): Promise<RuntimeProbeResult> {
    const id = reservation.sandboxId;
    if (!row) {
      // No row: the only thing that could still cost anything is a leaked directory/image.
      return this.disks.hasImage(id) || fs.existsSync(this.dir(id)) ? "unknown" : "gone";
    }
    if (reservation.kind === "resize") {
      // The row now describes the applied limits (reconcile re-applied them). Only an image
      // grown beyond the row's quota would be an untracked commitment.
      try {
        const quota = (row.ceiling.diskGB ?? row.resources.diskGB ?? 0) * GB;
        if (this.disks.hasImage(id) && fs.statSync(this.disks.layout(id).image).size > quota) return "unknown";
      } catch {
        return "unknown";
      }
      return "gone";
    }
    if (row.tier === "hot" || row.tier === "warm") return "live";
    // A thrown probe propagates: recover() treats it as "unknown" and quarantines.
    const state = await this.runtime.state(id);
    if (state && state.status !== "stopped") return "unknown";
    return "gone";
  }

  /**
   * Whether a not-live row may be treated as physically absent for ownership purposes.
   * `error` rows and rows with an unresolved reservation may still hold a runtime or
   * leaked resources on the flat layout; relabeling them would hide legacy ownership debt
   * from the fairness controller. Only a supported reconciliation (delete, a successful
   * stop, or restart recovery) moves them out of this bucket.
   */
  private ownershipUncertain(row: SandboxRow): boolean {
    if (row.tier === "error") return true;
    return this.admission.activeFor(row.id).length > 0;
  }

  /** Empty tenant parents left by a crash are removed; populated ones belong to adopted sandboxes. */
  private cleanupTenantParents(): void {
    for (const key of this.cgroups.listTenantKeys()) {
      try {
        this.cgroups.tenant(key).removeIfEmpty();
      } catch {
        /* still populated; reconcile on the next stop */
      }
    }
  }

  /** Cheap periodic maintenance; the reaper calls this too. */
  housekeeping(): void {
    try {
      this.operations.purgeExpired();
      this.admission.purgeJournal(JOURNAL_RETENTION_MS);
    } catch (err) {
      this.log.warn({ err }, "housekeeping failed");
    }
  }

  /* ---------------------------------------------------------------- create */

  private assertSmallDisk(requested?:ResourceSpec):void {
    if(this.singleton.enabled && requested?.diskGB!==undefined &&
      requested.diskGB!==this.cfg.defaults.diskGB)
      throw badRequest("small VM requires the fixed 8,000,000,000-byte image ceiling");
  }

  async create(req: CreateSandboxRequest): Promise<SandboxInfoWire> {
    return this.serializeSingleton(()=>this.createWithCustody(req));
  }

  private async createWithCustody(req: CreateSandboxRequest): Promise<SandboxInfoWire> {
    if(this.observations?.held())throw conflict("shadow execution custody unresolved");
    const key = req.operationKey;
    if (this.singleton.enabled && (!key || !req.owner))
      throw badRequest("small VM requires an owned, idempotent create");
    this.assertSmallDisk(req.resources);
    if (key === undefined) return await this.createOnce(req, null);
    if (!OPERATION_KEY.test(key)) throw badRequest("operationKey must match ^[A-Za-z0-9._:-]{8,128}$");
    const { operationKey: _omit, ...fingerprinted } = req;
    // The key id prefix makes fingerprints from a regenerated host key explicitly
    // incomparable (a conflict) instead of silently equal or silently different.
    const fingerprint = `v1:${this.secret.keyId}:${this.operations.fingerprint(fingerprinted)}`;
    let claimedId: string | undefined;
    const begun = this.singleton.enabled ? this.store.transaction(() => {
      const owner=validateOwnerKey(req.owner!.userKey);
      assertSupportedShape(this.cfg,req.resources);
      const decision=this.operations.begin(key,fingerprint);
      if(decision.outcome==="started"){
        claimedId=`sb-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        this.singleton.claim(claimedId,owner,"create",fingerprint,key);
        this.operations.bindClaim(key,claimedId);
      }
      return decision;
    }) : this.operations.begin(key, fingerprint);
    if (begun.outcome === "conflict") {
      throw idempotencyConflict({ operationKey: key, status: begun.op.status, sandboxId: begun.op.sandboxId });
    }
    if (begun.outcome === "duplicate") {
      if(this.singleton.enabled && begun.op.status==="succeeded")
        this.singleton.assert(begun.op.sandboxId!,validateOwnerKey(req.owner!.userKey));
      return await this.replayOperation(begun.op);
    }
    const ticket=this.observations&&claimedId?this.beginShadowWork(claimedId):null;
    const execute=()=>this.createOnce(req,key,claimedId,ticket?.signal);
    const work=this.singleton.enabled&&claimedId?this.serialize(claimedId,execute):execute();
    this.pendingCreates.set(key,work);
    try {
      return await work;
    } finally {
      ticket?.finish();
      this.pendingCreates.delete(key);
    }
  }

  /** Same key, same request: join the in-flight create or replay the recorded outcome (§6.5). */
  private async replayOperation(op: OperationRow): Promise<SandboxInfoWire> {
    const inFlight = this.pendingCreates.get(op.key);
    if (inFlight) return await inFlight;
    switch (op.status) {
      case "succeeded":
        if (op.result) return op.result;
        throw conflict(`operation ${op.key} succeeded but its result is unavailable`);
      case "failed": {
        const e = op.error ?? { code: "internal", message: "create failed" };
        throw new ServiceError(e.message, e.code, statusForCode(e.code), e.hint, e.details);
      }
      case "cancelled":
        throw conflict(`operation ${op.key} was cancelled`, "use a new operation key to create another sandbox");
      case "pending":
        // Recorded by this boot but not in memory: the only way here is a race with completion.
        throw conflict(`operation ${op.key} is still in progress`, "poll GET /v1/operations/{key}");
    }
  }

  private async createOnce(req: CreateSandboxRequest, operationKey: string | null, claimedId?: string,
    shadowSignal?:AbortSignal): Promise<SandboxInfoWire> {
    const id=claimedId??`sb-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const run=()=>this.createOnceForId(req,operationKey,id,shadowSignal);
    return this.singleton.enabled?run():this.serialize(id,run);
  }

  /** The caller owns the sandbox queue for preparation, allocation, launch and rollback. */
  private async createOnceForId(req:CreateSandboxRequest,operationKey:string|null,id:string,
    shadowSignal?:AbortSignal):Promise<SandboxInfoWire>{
    const operationId = `create:${operationKey ?? id}`;
    const started = Date.now();
    // Everything up to the insert is pre-allocation: a refusal here is safe to retry elsewhere.
    const preallocation = (err: unknown): never => {
      if (operationKey) this.operations.fail(operationKey, this.operationError(err),
        this.singleton.enabled?id:null,this.singleton.enabled?"quarantined":"preallocation");
      throw err;
    };
    let ownerKey: string | null;
    let guarantee: Required<ResourceSpec>;
    let ceiling: ResourceSpec;
    try {
      if(shadowSignal?.aborted)throw new Error("sandbox create cancelled before preparation");
      ownerKey = req.owner === undefined ? null : validateOwnerKey(req.owner.userKey);
      assertSupportedShape(this.cfg, req.resources);
      guarantee = resolveGuarantee(this.cfg, req.resources);
      ceiling = resolveCeiling(this.cfg, req.resources);
    } catch (err) {
      return preallocation(err);
    }
    let image;
    try {
      image = (await this.images.resolve(req.image)) ?? (await this.images.pull(req.image));
      if(shadowSignal?.aborted)throw new Error("sandbox create cancelled before allocation");
    } catch (err) {
      return preallocation(err);
    }
    const now = Date.now();
    try {
      // Decision, reservation and row insert are one SQLite transaction: a crash between
      // them cannot leave a reservation without a row or a row without a reservation.
      this.store.transaction(() => {
        if(shadowSignal?.aborted)throw new Error("sandbox create cancelled before allocation");
        this.singleton.assert(id,ownerKey);
        const rows = this.store.all();
        this.assertFairnessAvailable(ownerKey, rows);
        const netIndex = this.allocateNetIndex();
        this.reserve(operationId, { id, resources: guarantee, ceiling }, "create", rows);
        this.store.insert({
          id,
          image: image.ref,
          imageDigest: image.manifestDigest,
          workdir: req.workdir,
          tier: "stopped",
          createdAt: now,
          lastActivityAt: now,
          stoppedAt: now,
          archiveAfterMinutes: req.archiveAfterMinutes ?? 0,
          idleTimeoutMinutes: req.idleTimeoutMinutes ?? 0,
          resources: guarantee,
          ceiling,
          egress: resolveEgress(req.egress),
          netIndex,
          error: null,
          archiveKey: null,
          archiveSha256: null,
          archiveSize: null,
          lastCpuUsec: 0,
          labels: req.labels ?? {},
          layers: image.layers,
          ownerKey,
        });
      });
    } catch (err) {
      return preallocation(err);
    }
    return await this.timed("create", async () => {
      this.booting.add(id);
      try {
        this.imageConfigs.set(id, { env: image.config.env, workingDir: image.config.workingDir });
        if (req.env) this.rehydrateEnv(id, req.env);
        this.admission.setPhase(operationId, "launch");
        // First launch is part of create; do not also count a start operation or re-admit.
        const start=async()=>{
          try{await this.startInner(id,{signal:shadowSignal},operationId)}
          catch(original){
            if(original instanceof ShadowUncertainExecution){
              try{this.admission.quarantine(operationId,"shadow execution custody unresolved");}catch{}
              throw new CreateStartFailure(original,false);
            }
            const clean=await this.rollbackCreate(id);
            if(this.admission.get(operationId)?.status==="reserved")
              this.settleReservation(operationId,clean,"create rollback inside sandbox serialization");
            throw new CreateStartFailure(original,clean);
          }
        };
        await start();
        this.admission.commit(operationId);
        const info = this.info(id)!;
        this.meter({ kind: "created", sandboxId: id, ownerKey, runtimeGeneration: info.runtimeGeneration, durationMs: Date.now() - started, detail: { memoryGB: ceiling.memoryGB ?? null, diskGB: ceiling.diskGB ?? guarantee.diskGB, cpu: ceiling.cpu ?? null } });
        if (operationKey) {
          const op=this.operations.get(operationKey)!;
          if(op.cancelRequested){
            // Do not publish success before the cancelled resource is accounted
            // for. A failed cleanup stays quarantined for explicit retry.
            try{
              await this.deleteBody(id);
              this.operations.cancel(operationKey,id,"cleaned");
            }catch(error){
              this.operations.fail(operationKey,{code:"cancel_cleanup_pending",
                message:"cancelled creation requires explicit cleanup"},id,"quarantined");
              throw error;
            }
            throw conflict(`operation ${operationKey} was cancelled`, "use a new operation key to create another sandbox");
          }
          this.operations.succeed(operationKey,id,info);
        }
        return { value: info };
      } catch (err) {
        const startFailure=err instanceof CreateStartFailure?err:null;
        const failure=startFailure?.original??err;
        if(failure instanceof ShadowUncertainExecution){
          try{if(operationKey && this.operations.get(operationKey)?.status==="pending")
            this.operations.fail(operationKey,{code:"shadow_execution_unknown",message:failure.message},id,"quarantined");}
          catch(error){this.log.error({err:error,sandbox:id},"shadow operation outcome unresolved");}
          throw err;
        }
        // Cancellation has already persisted a terminal outcome. Never launch a
        // second, concurrent destructive rollback after its cleanup attempt.
        if(operationKey && this.operations.get(operationKey)?.status!=="pending")throw err;
        // A create response is the only handle the caller receives. Keeping a failed row would
        // strand its network slot and workspace forever, so creation owns rollback all the way
        // through launch; later lifecycle calls keep their visible ERROR row.
        const cleanupOk = startFailure?.cleanupOk ?? await this.rollbackCreate(id);
        if (!startFailure && this.admission.get(operationId)?.status === "reserved") {
          this.settleReservation(operationId, cleanupOk, "create rollback was incomplete");
        }
        this.meter({ kind: "failed", sandboxId: id, ownerKey, runtimeGeneration: 0, detail: { op: "create", cleaned: cleanupOk } });
        const resolution = cleanupOk ? "cleaned" : "quarantined";
        if (failure instanceof ServiceError) {
          if (operationKey && this.operations.get(operationKey)?.status === "pending") {
            this.operations.fail(operationKey, this.operationError(failure), id, resolution);
          }
          throw failure;
        }
        const reason = failure instanceof Error ? failure.message : String(failure);
        const wrapped = new Error(`sandbox creation failed: ${reason}`, { cause: failure });
        if (operationKey && this.operations.get(operationKey)?.status === "pending") {
          this.operations.fail(operationKey, { code: "internal", message: wrapped.message }, id, resolution);
        }
        throw wrapped;
      } finally {
        this.booting.delete(id);
      }
    });
  }

  private operationError(err: unknown): { code: string; message: string; hint?: string; details?: ServiceError["details"] } {
    if (err instanceof ServiceError) {
      return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.details ? { details: err.details } : {}) };
    }
    return { code: "internal", message: err instanceof Error ? err.message : String(err) };
  }

  /** Returns whether every host resource was confirmed released. */
  private async rollbackCreate(id: string): Promise<boolean> {
    const cleanupErrors: unknown[] = [];
    const row = this.store.get(id);
    if (row) {
      try {
        await this.teardown(row);
      } catch (err) {
        cleanupErrors.push(err);
        if(this.observations){
          try{this.observations.markHold("create-rollback-teardown-unresolved",id);}catch{}
          return false; // Preserve row, disk and archive custody after uncertain execution.
        }
      }
    }
    if(this.observations?.held())return false;
    try {
      await this.disks.destroy(id);
      fs.rmSync(this.dir(id), { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
      if(this.observations){
        try{this.observations.markHold("create-rollback-filesystem-unresolved",id);}catch{}
        return false;
      }
    }
    if(this.observations?.held())return false;
    this.envs.delete(id);
    this.imageConfigs.delete(id);
    try{this.store.delete(id);}catch(error){
      if(this.observations){try{this.observations.markHold("create-rollback-row-unresolved",id);}catch{}
        this.log.error({err:error,sandbox:id},"shadow rollback could not retire sandbox row");
        return false;}
      throw error;
    }
    // The serializer owns this queue tail, which may already include successors.
    // Never delete it from inside the current operation.
    if (cleanupErrors.length > 0) {
      this.log.warn(
        { err: new AggregateError(cleanupErrors, "creation rollback was incomplete"), sandbox: id },
        "sandbox creation rollback needed best-effort cleanup",
      );
    }
    return cleanupErrors.length === 0 && !this.disks.hasImage(id) && !fs.existsSync(this.dir(id));
  }

  /* ---------------------------------------------------------------- import */

  /** Everything a held sandbox refuses; the hold is the rehome fence (§11.2). */
  private assertNotHeld(row: SandboxRow, what: string): void {
    if (row.hold) throw sandboxHeld(row.id, row.hold, what);
  }

  /**
   * Adopt a sandbox archived by another host in the same fleet.
   *
   * Nothing is downloaded here: the row lands ARCHIVED and the existing start() path restores
   * it, so a failed adoption never destroys the object-store copy. No memory or disk is
   * reserved until that restore actually starts (§6.2). The workspace is identified by the
   * sandbox id alone, which is why the id has to be validated as a path component rather
   * than trusted the way a locally generated one can be.
   */
  async importArchived(req: ImportSandboxRequest): Promise<SandboxInfoWire> {
    return this.serializeSingleton(()=>this.importWithCustody(req));
  }

  private async importWithCustody(req: ImportSandboxRequest): Promise<SandboxInfoWire> {
    if(this.observations?.held())throw conflict("shadow execution custody unresolved");
    return await this.metrics.timeSandboxOp("import", async () => {
      this.assertArchiveConfigured();
      if (!SANDBOX_ID.test(req.id)) {
        throw badRequest(`"${req.id}" is not a sandbox id`, "import an id issued by another host");
      }
      const ownerKey = req.owner === undefined ? null : validateOwnerKey(req.owner.userKey);
      assertSupportedShape(this.cfg, req.resources);
      this.assertSmallDisk(req.resources);
      if(this.singleton.enabled){
        if(!ownerKey || !req.archive || !req.imageDigest)
          throw badRequest("small VM import requires owner, archive reference and image digest");
        this.singleton.claim(req.id,ownerKey,"import",this.operations.fingerprint(req),null);
      }
      const existing = this.store.get(req.id);
      if (existing) return this.replayImport(existing, req, ownerKey);

      const archive = req.archive ? await this.verifyRequestedArchive(req.id, req.archive) : await this.findArchive(req.id);
      const image = (await this.images.resolve(req.image)) ?? (await this.images.pull(req.image));
      if (req.imageDigest !== undefined && image.manifestDigest !== req.imageDigest) {
        // Same tag, different bytes: the workspace was built against the source's image.
        throw imageMismatch(req.image, req.imageDigest, image.manifestDigest);
      }
      const now = Date.now();
      try {
        this.store.insert({
        id: req.id,
        image: image.ref,
        imageDigest: image.manifestDigest,
        workdir: req.workdir,
        tier: "archived",
        createdAt: now,
        lastActivityAt: now,
        stoppedAt: now,
        archiveAfterMinutes: req.archiveAfterMinutes ?? 0,
        idleTimeoutMinutes: req.idleTimeoutMinutes ?? 0,
        resources: resolveGuarantee(this.cfg, req.resources),
        ceiling: resolveCeiling(this.cfg, req.resources),
        egress: resolveEgress(req.egress),
        netIndex: this.allocateNetIndex(),
        error: null,
        archiveKey: archive.key,
        archiveSha256: archive.sha256,
        archiveSize: archive.size,
        lastCpuUsec: 0,
        labels: req.labels ?? {},
        layers: image.layers,
        ownerKey,
        // The object came from another host's row: it stays theirs to garbage-collect.
        archiveShared: true,
        });
      } catch (err) {
        // Two imports of the same id raced past the existence check: the loser sees the
        // primary-key violation. Same archive and owner is an idempotent success; anything
        // else is the documented conflict, never a raw 500.
        const existing = this.store.get(req.id);
        if (!existing) throw err;
        return this.replayImport(existing, req, ownerKey, image.manifestDigest);
      }
      this.imageConfigs.set(req.id, { env: image.config.env, workingDir: image.config.workingDir });
      this.meter({ kind: "imported", sandboxId: req.id, ownerKey, runtimeGeneration: 0, detail: { archiveSizeBytes: archive.size } });
      this.log.info({ sandbox: req.id, archive: archive.key }, "imported archived sandbox");
      return this.info(req.id)!;
    });
  }

  /**
   * A repeated import is accepted as the retry of a lost response only when it is the *same*
   * request in every field the row persists: object, owner, image ref and digest, workdir,
   * ceiling, egress, timers and labels. Anything else is a conflict naming the divergent
   * fields, so a producer can never be told "accepted" for a request the row does not
   * reflect. A retry without an explicit object reference is ambiguous and is refused too.
   */
  private replayImport(
    existing: SandboxRow,
    req: ImportSandboxRequest,
    ownerKey: string | null,
    resolvedDigest?: string,
  ): SandboxInfoWire {
    if (!req.archive) {
      throw conflict(
        `sandbox ${req.id} already exists on this host`,
        "retry with the source's archive reference so the host can prove it is the same request",
      );
    }
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const guarantee = resolveGuarantee(this.cfg, req.resources);
    const ceiling = resolveCeiling(this.cfg, req.resources);
    const wantDigest = req.imageDigest ?? resolvedDigest;
    const divergent: string[] = [];
    if (existing.archiveKey !== req.archive.key || existing.archiveSha256 !== req.archive.sha256) divergent.push("archive");
    if (existing.ownerKey !== ownerKey) divergent.push("owner");
    if (existing.image !== req.image) divergent.push("image");
    if (wantDigest !== undefined && existing.imageDigest !== wantDigest) divergent.push("imageDigest");
    if (existing.workdir !== req.workdir) divergent.push("workdir");
    if (!same(existing.ceiling, ceiling) || !same(existing.resources, guarantee)) divergent.push("resources");
    if (!same(existing.egress, resolveEgress(req.egress))) divergent.push("egress");
    if (existing.archiveAfterMinutes !== (req.archiveAfterMinutes ?? 0)) divergent.push("archiveAfterMinutes");
    if (existing.idleTimeoutMinutes !== (req.idleTimeoutMinutes ?? 0)) divergent.push("idleTimeoutMinutes");
    if (!same(existing.labels, req.labels ?? {})) divergent.push("labels");
    if (divergent.length > 0) {
      throw conflict(
        `sandbox ${req.id} already exists on this host with different ${divergent.join(", ")}`,
        "an import is idempotent only for the identical request; this one is not accepted",
      );
    }
    return this.info(req.id)!;
  }

  /**
   * Adopt exactly the object the source named (§11.3): the key must be this sandbox's, carry
   * the same sha in its name, exist, and match size/checksum where the store can vouch.
   */
  private async verifyRequestedArchive(
    id: string,
    requested: { key: string; sha256: string; size?: number },
  ): Promise<ArchiveReference> {
    const expected = { key: requested.key, sha256: requested.sha256, ...(requested.size === undefined ? {} : { size: requested.size }) };
    const embedded = ARCHIVE_KEY.exec(requested.key)?.[1];
    if (!requested.key.startsWith(`${id}/`) || embedded === undefined || embedded !== requested.sha256) {
      throw badRequest(`archive.key must be ${id}/upper-<sha256>.tar.zst with the same sha256 as archive.sha256`);
    }
    const stored = await this.objects.head(requested.key);
    const actual = { present: stored !== null, size: stored?.size ?? null, sha256: stored?.sha256 ?? null };
    if (!stored) throw archiveMismatch(expected, actual);
    if (requested.size !== undefined && stored.size !== requested.size) throw archiveMismatch(expected, actual);
    if (stored.sha256 !== undefined && stored.sha256 !== requested.sha256) throw archiveMismatch(expected, actual);
    return { key: requested.key, sha256: requested.sha256, size: stored.size };
  }

  /** Source-authoritative archive reference plus an optional object-store check (§11.1). */
  async archiveReference(id: string, verify: boolean): Promise<ArchiveReferenceWire> {
    const row = this.mustGet(id);
    const archive = this.archiveOf(row);
    const wire: ArchiveReferenceWire = {
      id: row.id,
      hostId: this.cfg.hostId,
      tier: row.tier,
      state: this.transitioning.has(row.id) ? "starting" : TIER_TO_STATE[row.tier],
      revision: row.revision,
      stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
      archive,
      hold: row.hold,
      config: this.configManifest(row),
    };
    if (verify) {
      if (!archive) throw conflict(`sandbox ${id} has no archive object to verify`);
      const stored = await this.objects.head(archive.key);
      wire.object = {
        present: stored !== null,
        size: stored?.size ?? null,
        sha256: stored?.sha256 ?? null,
        matches:
          stored !== null &&
          stored.size === archive.size &&
          (stored.sha256 === undefined || stored.sha256 === archive.sha256),
      };
    }
    return wire;
  }

  /**
   * The persisted configuration an import must carry (§11.1). Historical rehomes sent only
   * id/image/workdir/resources, which reset idle/archive timers to "never" and dropped
   * labels; egress at least defaulted closed. Env is memory-only and is never exported.
   */
  private configManifest(row: SandboxRow): ArchiveReferenceWire["config"] {
    const guarantee = resolveGuarantee(this.cfg, row.resources);
    return {
      image: row.image,
      imageDigest: row.imageDigest,
      workdir: row.workdir,
      resources: { ...row.ceiling, diskGB: row.ceiling.diskGB ?? guarantee.diskGB },
      egress: row.egress,
      archiveAfterMinutes: row.archiveAfterMinutes,
      idleTimeoutMinutes: row.idleTimeoutMinutes,
      labels: row.labels,
      owner: row.ownerKey === null ? null : { userKey: row.ownerKey },
    };
  }

  private archiveOf(row: SandboxRow): ArchiveReference | null {
    return row.archiveKey && row.archiveSha256 !== null && row.archiveSize !== null
      ? { key: row.archiveKey, sha256: row.archiveSha256, size: row.archiveSize }
      : null;
  }

  /**
   * Quiescence hold (§11.2). Only a sandbox that is not live can be held; the hold marks its
   * object shared (another host is about to reference it) and bumps the revision.
   */
  async hold(id: string, holder: string, reason?: string, expectedRevision?: number): Promise<SandboxInfoWire> {
    if (!HOLD_HOLDER.test(holder)) throw badRequest("holder must match ^[A-Za-z0-9._:-]{1,128}$");
    return await this.serialize(id, async () => {
      const row = this.mustGet(id);
      if (row.hold) {
        if (row.hold.holder === holder) return this.info(id)!;
        throw sandboxHeld(id, row.hold, "a second hold");
      }
      // Archived only: the object in the store is the whole workspace, so handing it to
      // another host loses nothing. A stopped row still has local writes no object carries.
      if (row.tier !== "archived" || this.transitioning.has(id)) {
        throw conflict(`sandbox ${id} is ${TIER_TO_STATE[row.tier]}; only a fully archived sandbox can be held for handoff`);
      }
      if (expectedRevision !== undefined && expectedRevision !== row.revision) {
        throw staleRevision(expectedRevision, row.revision, "hold");
      }
      const hold: SandboxHold = { holder, since: new Date().toISOString(), ...(reason ? { reason } : {}) };
      this.store.transaction(() => {
        this.store.setHold(id, hold);
        if (row.archiveKey) this.store.setArchiveShared(id, true);
      });
      this.log.info({ sandbox: id, holder }, "sandbox held");
      return this.info(id)!;
    });
  }

  /**
   * Retire a held source atomically (§11.5): the row and local state go away in one
   * transaction while the hold is still in force, so there is no instant at which the
   * source could wake. Requires the caller's proof that the target adopted this exact
   * object; the object itself is always left for the adopting host.
   */
  async retire(id: string, req: RetireRequest): Promise<RetireResponse> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    if (!HOLD_HOLDER.test(req.holder)) throw badRequest("holder must match ^[A-Za-z0-9._:-]{1,128}$");
    return await this.serialize(id, async () => {
      if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
      const row = this.mustGet(id);
      if (!row.hold) throw conflict(`sandbox ${id} is not held; retire only under the hold that fenced the rehome`);
      if (row.hold.holder !== req.holder) throw sandboxHeld(id, row.hold, "retirement by a different holder");
      if (row.tier !== "archived" || this.transitioning.has(id)) {
        throw conflict(`sandbox ${id} is ${TIER_TO_STATE[row.tier]}; only a fully archived source can be retired`);
      }
      if (req.expectedRevision !== undefined && req.expectedRevision !== row.revision) {
        throw staleRevision(req.expectedRevision, row.revision, "retire");
      }
      const archive = this.archiveOf(row);
      if (!archive || archive.key !== req.adoptedArchive.key || archive.sha256 !== req.adoptedArchive.sha256) {
        throw archiveMismatch(
          { key: req.adoptedArchive.key, sha256: req.adoptedArchive.sha256 },
          { present: archive !== null, size: archive?.size ?? null, sha256: archive?.sha256 ?? null },
        );
      }
      // Local state first (an archived row holds none unless a cleanup leaked), then the row;
      // the hold is never cleared, it disappears with the row.
      await this.disks.destroy(id).catch(() => undefined);
      fs.rmSync(this.dir(id), { recursive: true, force: true });
      this.envs.delete(id);
      this.imageConfigs.delete(id);
      this.store.delete(id);
      for (const reservation of this.admission.activeFor(id)) {
        this.settleReservation(reservation.operationId, !this.disks.hasImage(id) && !fs.existsSync(this.dir(id)), "retire left leftovers");
      }
      this.metrics.recordSandboxOp("delete", "ok");
      this.meter({ kind: "deleted", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { from: row.tier, retired: true, holder: req.holder } });
      this.log.info({ sandbox: id, holder: req.holder, key: archive.key }, "retired held source; shared object retained for the adopting host");
      return { retired: true, id, archive };
    });
  }

  async releaseHold(id: string, holder: string | undefined, force: boolean): Promise<SandboxInfoWire> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    return await this.serialize(id, async () => {
      if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
      const row = this.mustGet(id);
      if (!row.hold) return this.info(id)!;
      if (!force && row.hold.holder !== holder) throw sandboxHeld(id, row.hold, "release by a different holder");
      this.store.setHold(id, null);
      this.log.info({ sandbox: id, holder: row.hold.holder, force }, "sandbox hold released");
      return this.info(id)!;
    });
  }

  /** The newest workspace archive for an id; re-archiving leaves older objects behind. */
  private async findArchive(
    id: string,
  ): Promise<{ key: string; sha256: string; size: number }> {
    const candidates = (await this.objects.list(`${id}/`))
      .map((object) => ({ object, sha256: ARCHIVE_KEY.exec(object.key)?.[1] }))
      .filter((c): c is { object: ListedObject; sha256: string } => c.sha256 !== undefined)
      .sort((left, right) => right.object.lastModified - left.object.lastModified);
    const newest = candidates[0];
    if (!newest) {
      throw notFound(
        `no archived workspace for sandbox ${id}`,
        "the sandbox must have been archived to object storage this host also reads",
      );
    }
    return { key: newest.object.key, sha256: newest.sha256, size: newest.object.size };
  }

  private allocateNetIndex(): number {
    const used = this.store.usedNetIndexes();
    for (let i = 0; i < 60_000; i++) if (!used.has(i)) return i;
    this.metrics.recordAdmission("denied", "network");
    throw capacityDenied(
      { reason: "network_capacity", resource: "network", unit: "count", required: 1, available: 0, budget: 60_000, committed: 60_000, retryable: true },
      "delete or archive-and-export a sandbox to free a network slot",
    );
  }

  rehydrateEnv(id: string, env: Record<string, string>): void {
    // Memory only: never SQLite, never labels, never logs (§6.3).
    this.envs.set(id, { ...env });
  }

  /* ----------------------------------------------------------------- start */

  async start(id: string, opts: { env?: Record<string, string>; timeoutMs?: number }): Promise<SandboxInfoWire> {
    const ticket=this.beginShadowWork(id);
    const startOptions={...opts,signal:ticket.signal};
    const work=this.serialize(id,()=>this.timed("start", async () => {
        const work = this.startInner(id, startOptions);
        if (!opts.timeoutMs || opts.timeoutMs <= 0) {
          const r = await work;
          return { value: r.info, result: r.result };
        }
        // Restore/launch is not cancellable. Reject the caller at timeoutMs, but keep this
        // serialize slot until the real work finishes so a reaper archive cannot interleave
        // with a restore that is still unpacking.
        let timer: NodeJS.Timeout | undefined;
        let expired = false;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(timedOut(`sandbox ${id} did not start within ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
        });
        work.catch(() => undefined);
        try {
          const r = await Promise.race([work, deadline]);
          return { value: r.info, result: r.result };
        } catch (err) {
          if (expired) await work.catch(() => undefined);
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }));
    return this.observations?work.finally(ticket.finish):work;
  }

  /**
   * @param createOperationId when called from create(), the reservation create() already
   * holds; otherwise this method reserves for itself (start or restore).
   */
  private async startInner(
    id: string,
    opts: { env?: Record<string, string>; timeoutMs?: number;signal?:AbortSignal },
    createOperationId?: string,
  ): Promise<{ info: SandboxInfoWire; result: OpResult }> {
    if(this.observations?.held())throw conflict("shadow execution custody unresolved");
    if(opts.signal?.aborted)throw new Error("sandbox start cancelled before dispatch");
    const row = this.mustGet(id);
    this.singleton.assert(id,row.ownerKey);
    if (opts.env) this.rehydrateEnv(id, opts.env);
    if (row.tier === "hot") return { info: this.info(id)!, result: "noop" };
    // Checked under the sandbox's own serialize slot, so a hold placed before this wake
    // fences it and a hold cannot land on a wake already in progress.
    this.assertNotHeld(row, "wake");
    if (row.tier === "warm") {
      await this.thaw(id);
      return { info: this.info(id)!, result: "noop" };
    }

    const started = Date.now();
    const kind: ReservationKind = row.tier === "archived" ? "restore" : "start";
    // Before any reservation, download, mount or runtime start: a drifted tag is refused with
    // nothing allocated and the archive and local disk untouched.
    await this.resolvePinnedImage(row);
    if(opts.signal?.aborted)throw new Error("sandbox start cancelled before dispatch");
    // Under this sandbox's serialized lifecycle slot, reclaim only zero-filled
    // blocks from a stopped, unmounted backing image before sparse-disk
    // admission. This never reduces its logical size or rewrites retained data.
    if (this.cfg.profile === "small-v1" && row.tier === "stopped") {
      await this.disks.reclaimOffline(id);
    }
    let operationId = createOperationId;
    if (!operationId) {
      operationId = `${kind}:${id}:${randomUUID().slice(0, 8)}`;
      const rows = this.store.all();
      this.assertFairnessAvailable(row.ownerKey, rows);
      this.reserve(operationId, row, kind, rows);
    }
    const ownReservation = createOperationId === undefined;

    this.booting.add(id);
    this.transitioning.set(id, "start");
    try {
      if (row.tier === "archived") {
        this.admission.setPhase(operationId, "restore");
        await this.metrics.timeSandboxOp("restore", () => this.restoreFromArchive(row));
        if(opts.signal?.aborted)throw new Error("sandbox restore cancelled before launch");
        this.meter({ kind: "restored", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, durationMs: Date.now() - started, detail: { archiveSizeBytes: row.archiveSize } });
      }
      this.admission.setPhase(operationId, "launch");
      await this.launch(this.mustGet(id),opts.signal);
      this.store.setTier(id, "hot", { stoppedAt: null, error: null });
      this.store.touch(id);
      if (ownReservation) this.admission.commit(operationId);
      const info = this.info(id)!;
      this.meter({ kind: "started", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: info.runtimeGeneration, durationMs: Date.now() - started, detail: { from: row.tier } });
    } catch (err) {
      if(err instanceof ShadowUncertainExecution){
        // Secondary SQLite failures must not replace this classification: a
        // running process may exist and createOnce must never roll it back.
        try{this.admission.quarantine(operationId,"shadow launch outcome unavailable");}
        catch(error){this.log.error({err:error,sandbox:id},"shadow admission quarantine unavailable");}
        try{this.store.setTier(id,"error",{error:err.message});}
        catch(error){this.log.error({err:error,sandbox:id},"shadow runtime state unresolved");}
        throw err;
      }
      let cleanupOk = true;
      await this.teardown(this.mustGet(id)).catch(() => {
        cleanupOk = false;
      });
      if(this.observations?.held()){
        try{this.admission.quarantine(operationId,"shadow execution custody unresolved");}catch{}
        try{this.store.setTier(id,"error",{error:"shadow execution custody unresolved"});}catch{}
        throw new ShadowUncertainExecution();
      }
      if(this.observations && !cleanupOk){
        try{this.observations.markHold("launch-cleanup-unverified",id);}catch{}
        try{this.admission.quarantine(operationId,"shadow launch cleanup unverified");}catch{}
        try{this.store.setTier(id,"error",{error:"shadow execution cleanup unverified"});}catch{}
        throw new ShadowUncertainExecution();
      }
      // A failed restore must remain retryable from the archive; marking it ERROR would
      // make the next start treat the missing local disk as an ordinary stopped workspace.
      this.store.setTier(id, row.tier === "archived" ? "archived" : "error", {
        error: String(err),
      });
      if (row.tier === "archived" && this.disks.hasImage(id)) cleanupOk = false;
      if (ownReservation) this.settleReservation(operationId, cleanupOk, "failed start left resources behind");
      this.meter({ kind: "failed", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { op: kind } });
      throw err;
    } finally {
      this.transitioning.delete(id);
      this.booting.delete(id);
    }
    return { info: this.info(id)!, result: "ok" };
  }

  /**
   * The base image is pinned by the digest persisted with the row, not by its mutable tag:
   * a re-pulled tag must never silently become a different base for an existing workspace.
   * Every row carries the digest it was created or imported with; an empty value on a row
   * written by a pre-digest build is left alone rather than invented.
   */
  private async resolvePinnedImage(row: SandboxRow): Promise<NonNullable<Awaited<ReturnType<ImageStore["resolve"]>>>> {
    const image = await this.images.resolve(row.image);
    if (!image) {
      throw conflict(`image ${row.image} is no longer available locally`, "re-pull it with POST /v1/images");
    }
    if (row.imageDigest && image.manifestDigest !== row.imageDigest) {
      throw imageMismatch(row.image, row.imageDigest, image.manifestDigest);
    }
    return image;
  }

  private async deleteRuntimeForShadowLaunch(id:string):Promise<void>{
    const result=await this.runtime.deleteResult(id);
    const state=await this.runtime.state(id);
    if(state)throw new Error(`prior runtime ${id} remains after delete (${result.code})`);
  }

  private shadowIdentity(row:SandboxRow,generation:number,actionId:string):ShadowIdentity {
    if(!row.ownerKey)throw new Error("shadow observation requires immutable owner");
    return {hostId:this.cfg.hostId,supervisorBootId:this.bootId,sandboxId:row.id,
      ownerKey:row.ownerKey,runtimeGeneration:generation,actionId,
      monotonicNs:process.hrtime.bigint().toString(),observedWallMs:String(Date.now())};
  }

  private async launch(row: SandboxRow,signal?:AbortSignal): Promise<void> {
    const id = row.id;
    const image = await this.resolvePinnedImage(row);
    this.imageConfigs.set(id, { env: image.config.env, workingDir: image.config.workingDir });

    const initBinary = findInitBinary();
    if (!initBinary) {
      throw conflict(
        "sandbox init binary is missing",
        "build it with scripts/build-init.sh (the container image does this at build time)",
      );
    }

    fs.mkdirSync(this.dir(id), { recursive: true });
    const disk = await this.disks.ensureMounted(
      id,
      row.ceiling.diskGB ?? resolveGuarantee(this.cfg, row.resources).diskGB,
    );
    await mountOverlay(
      {
        merged: this.mergedDir(id),
        upper: disk.upper,
        work: disk.work,
        lowers: image.layers.map((d) => this.images.layerDir(d)),
      },
      this.log,
    );

    const etcDir = path.join(this.dir(id), "etc");
    fs.mkdirSync(etcDir, { recursive: true });
    const resolvConfPath = path.join(etcDir, "resolv.conf");
    const hostsPath = path.join(etcDir, "hosts");
    fs.writeFileSync(resolvConfPath, this.network.resolvConf());

    await this.network.create(id, row.netIndex);
    const egress = await this.network.applyEgress(id, row.egress, this.cfg.apiHost ? [this.cfg.apiHost] : []);
    fs.writeFileSync(hostsPath, this.network.hostsFile(id, egress.names));

    // Owned sandboxes live under their tenant's equal-weight parent (§7.2); the layout is
    // chosen per launch, so a legacy flat sandbox migrates at its next controlled start.
    // The tenant aggregate caps are fail-closed here: a tenant the kernel did not bound
    // is not an admitted tenant (§6.2).
    const tenant = this.tenantOf(row);
    let cgroup: Cgroup;
    if (tenant) {
      this.applyTenantLimits(row.ownerKey!);
      cgroup = tenant.sandbox(id);
    } else {
      cgroup = this.cgroups.sandbox(id);
    }
    const generation = this.store.bumpRuntimeGeneration(id, cgroup.rel);

    await this.runtime.writeBundle({
      id,
      bundleDir: this.bundleDir(id),
      rootfs: this.mergedDir(id),
      workdir: row.workdir,
      hostname: id,
      env: image.config.env,
      cgroupPath: cgroup.rel,
      netnsPath: netnsPath(id),
      resolvConfPath,
      hostsPath,
      initBinary,
    });

    if(this.observations){
      await launchWithShadowObservation(this.observations,
        actionId=>this.shadowIdentity(row,generation,actionId),async()=>{
          await this.deleteRuntimeForShadowLaunch(id);
          return this.runtime.start(id,this.bundleDir(id),path.join(this.dir(id),"init.log"));
        });
    }else{
      await this.runtime.delete(id);
      await this.runtime.start(id,this.bundleDir(id),path.join(this.dir(id),"init.log"));
    }
    try{
      const verified = cgroup.applyLimitsVerified(
        limitsFor(resolveGuarantee(this.cfg, row.resources), row.ceiling, this.cfg.maxPids),
      );
      if (!verified.ok) {
        // A ceiling the kernel did not accept is not an admitted sandbox (§6.2).
        this.log.error({ sandbox: id, mismatches: verified.mismatches }, "cgroup limits did not apply");
        throw conflict(
          `cgroup limits could not be applied for sandbox ${id} (${verified.mismatches.map((m) => m.file).join(", ")})`,
          "check that the cpu, memory and pids controllers are enabled for the service's cgroup subtree",
        );
      }
      this.log.debug({ sandbox: id, generation, cgroup: cgroup.rel }, "launched sandbox");
      // cwd is "/" deliberately: this is the exec that creates the workdir it would otherwise
      // be asked to start in. A warning does not prove the workspace is ready.
      const mk = await this.collect((hooks) =>
        this.execIn(this.mustGet(id), { argv: [INIT_PATH, "mkdir", row.workdir], cwd: "/", signal }, hooks),
      );
      if (mk.exitCode !== 0) {
        this.log.warn({ sandbox: id, workdir: row.workdir, stderr: mk.stderr.trim() },
          "could not create workdir");
      }
    }catch(error){
      // The external launch already returned. Later cgroup/workdir failures are
      // handled by the caller's teardown, which records its own observation.
      throw error;
    }
  }

  /* ------------------------------------------------------------------ stop */

  async stop(id: string, timeoutMs = 30_000, options:{automatic?:boolean}={}): Promise<SandboxInfoWire> {
    if(this.observations){
      if(options.automatic && this.hasShadowWork(id))
        throw conflict("automatic stop deferred while sandbox work is active");
      if(!options.automatic)this.abortShadowWork(id);
    }
    return await this.serialize(id, () =>
      this.timed("stop", async () => {
        if(options.automatic && this.hasShadowWork(id))
          throw conflict("automatic stop deferred while sandbox work is active");
        if(options.automatic && this.observations?.held())
          throw conflict("automatic stop refused while shadow execution custody is unresolved");
        const row = this.mustGet(id);
        if (row.tier === "stopped" || row.tier === "archived") {
          return { value: this.info(id)!, result: "noop" };
        }
        this.transitioning.set(id, "stop");
        const started = Date.now();
        try {
          const finalStats = await this.teardown(row, timeoutMs);
          // Memory is released only here: the runtime confirmed exit, and the row's tier is
          // what admission reads. Disk stays committed with the stopped workspace.
          this.store.setTier(id, "stopped", { stoppedAt: Date.now(), error: null });
          this.meter({
            kind: "stopped",
            sandboxId: id,
            ownerKey: row.ownerKey,
            runtimeGeneration: row.runtimeGeneration,
            durationMs: Date.now() - started,
            ...(finalStats ? { counters: countersFrom(finalStats) } : {}),
          });
        } finally {
          this.transitioning.delete(id);
        }
        return { value: this.info(id)! };
      }),
    );
  }

  /**
   * SIGTERM the tree, escalate at the deadline, then release every host resource it held.
   * Returns the final cgroup counters (read before the kill) so a terminal usage event can
   * carry them.
   */
  private async teardown(row: SandboxRow, timeoutMs = 30_000): Promise<ExtendedCgroupStats | null> {
    try{return await this.performTeardown(row,timeoutMs);}
    catch(error){if(this.observations)try{this.observations.markHold("teardown-outcome-uncertain",row.id);}catch{}
      throw error;}
  }

  private async stopRuntimeVerified(id:string,cgroup:Cgroup,timeoutMs:number):Promise<void>{
    let state=await this.runtime.state(id);
    if(state && state.status!=="stopped"){
      const killed=await this.runtime.killResult(id,"SIGTERM");
      if(killed.code!==0){
        state=await this.runtime.state(id);
        if(state && state.status!=="stopped")throw new Error("runtime kill was not confirmed");
      }
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline){
        state=await this.runtime.state(id);
        if(!state||state.status==="stopped")break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(state && state.status!=="stopped"){
        cgroup.killAll();
        if(cgroup.procsVerified().length>0)throw new Error("sandbox cgroup still contains processes");
        state=await this.runtime.state(id);
        if(state && state.status!=="stopped")throw new Error("runtime remained active after cgroup kill");
      }
    }
    state=await this.runtime.state(id);
    if(state){
      const removed=await this.runtime.deleteResult(id);
      state=await this.runtime.state(id);
      if(state)throw new Error(`runtime delete not confirmed (${removed.code})`);
    }
    if(cgroup.procsVerified().length>0)throw new Error("sandbox cgroup still contains processes");
  }

  private async performTeardown(row:SandboxRow,timeoutMs=30_000):Promise<ExtendedCgroupStats|null>{
    const holdAtStart=this.observations?.held()??false;
    const id = row.id;
    const shadowPtys=this.observations?this.ptys.signalKillAllForVerification(id):null;
    if(!this.observations)this.ptys.killAll(id);
    const cgroup = this.cgroupFor(row);
    const finalStats = this.safeStats(row);
    if (cgroup.isFrozen()) cgroup.thaw();

    const tenant=this.tenantOf(row);
    if(this.observations){
      await this.stopRuntimeVerified(id,cgroup,timeoutMs);
      await this.waitForShadowChildren(id,timeoutMs);
      if(shadowPtys)await this.ptys.verifyExited(shadowPtys,timeoutMs);
      if(!holdAtStart&&this.observations.held())throw new ShadowUncertainExecution();
      cgroup.remove();
      if(cgroup.exists())throw new Error("sandbox cgroup removal not confirmed");
      if(tenant&&!tenant.removeIfEmpty())throw new Error("sandbox tenant cgroup still contains children");
    }else{
      await this.runtime.kill(id, "SIGTERM");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await this.runtime.state(id).catch(() => ({ status: "unknown", pid: 0 }));
        if (!state || state.status === "stopped") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      cgroup.killAll();
      await this.runtime.delete(id);
    }
    if(this.observations){
      await unmountOverlayVerified(this.mergedDir(id));
      await this.disks.unmountVerified(id);
      await this.network.destroyVerified(id,row.netIndex);
    }else{
      await unmountOverlay(this.mergedDir(id));
      await this.disks.unmount(id);
      await this.network.destroy(id,row.netIndex);
    }
    if(!this.observations){
      cgroup.remove();
      if(tenant)tenant.removeIfEmpty();
    }
    if (finalStats) {
      this.meter({ kind: "terminal", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, counters: countersFrom(finalStats) });
    }
    if(this.observations && row.ownerKey){
      try{this.observations.recordTeardownReturned(id,this.cfg.hostId,this.bootId);}
      catch(error){try{this.observations.markHold("teardown-record-unacknowledged",id);}catch{}
        throw new ShadowUncertainExecution();}
    }
    return finalStats;
  }

  /* ---------------------------------------------------------- warm tier */

  async freeze(id: string): Promise<boolean> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    if(this.observations && this.hasShadowWork(id))throw conflict("freeze deferred while sandbox work is active");
    const row = this.mustGet(id);
    if (row.tier !== "hot") {
      this.metrics.recordSandboxOp("freeze", "noop");
      return false;
    }
    const cgroup = this.cgroupFor(row);
    if (!cgroup.exists()) {
      this.metrics.recordSandboxOp("freeze", "noop");
      return false;
    }
    cgroup.freeze();
    cgroup.reclaim(cgroup.stats().memoryCurrent);
    // WARM keeps its memory reservation: a frozen process still owns its pages (§3.3).
    this.store.setTier(id, "warm");
    this.meter({ kind: "frozen", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration });
    this.log.debug({ sandbox: id }, "froze sandbox to warm tier");
    this.metrics.recordSandboxOp("freeze", "ok");
    return true;
  }

  private async thaw(id: string): Promise<void> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    const row = this.mustGet(id);
    const cgroup = this.cgroupFor(row);
    if (cgroup.exists() && cgroup.isFrozen()) cgroup.thaw();
    this.store.setTier(id, "hot");
    this.meter({ kind: "thawed", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration });
    this.log.debug({ sandbox: id }, "thawed sandbox");
    this.metrics.recordSandboxOp("thaw", "ok");
  }

  /** Every inbound touch unfreezes first: WARM is invisible to callers (§4). */
  private async ensureHot(id: string): Promise<SandboxRow> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    const row = this.mustGet(id);
    if (row.tier === "warm") {
      await this.thaw(id);
      return this.mustGet(id);
    }
    if (row.tier !== "hot") {
      throw conflict(`sandbox ${id} is ${TIER_TO_STATE[row.tier]}`, "call POST /v1/sandboxes/{id}/start first");
    }
    return row;
  }

  /* ----------------------------------------------------------- archival */

  isTransitioning(id: string): boolean {
    return this.transitioning.has(id);
  }

  /** The wire state: `starting` only while a launch/restore holds the sandbox. */
  private stateOf(row: SandboxRow): SandboxState {
    return this.transitioning.get(row.id) === "start" ? "starting" : TIER_TO_STATE[row.tier];
  }

  archivesInFlight(): number {
    return this.archiving.size;
  }

  /** Operator-forced DR snapshot of the host registry. Ignores drIntervalMinutes=0
   * (Boat hosts disable the wall-clock reaper snapshot). Refuses when the object
   * store is `none` so a "success" can never mean bytes landed on the dying disk. */
  async forceDisasterRecoverySnapshot(): Promise<{ key: string; size: number }> {
    if (this.objects.kind === "none") {
      throw conflict("archive storage is not configured", "DR snapshot needs a remote store");
    }
    const iso = new Date().toISOString();
    const file = path.join(this.cfg.paths.spool, `dr-${iso}.sqlite`);
    const key = `_dr/${this.cfg.hostId}/sandbox-${iso}.sqlite`;
    fs.mkdirSync(this.cfg.paths.spool, { recursive: true });
    try {
      this.store.backupTo(file);
      const stored = await this.objects.put(key, file);
      this.log.info({ key, size: stored.size }, "forced disaster-recovery snapshot");
      return { key, size: stored.size };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /** Force path: stop (if needed) then pack. Operator/adapter initiated; the reaper never uses it. */
  async archive(id: string, timeoutMs = 300_000): Promise<SandboxInfoWire> {
    this.assertArchiveConfigured();
    this.assertNotHeld(this.mustGet(id), "archive");
    await this.stop(id, Math.min(timeoutMs, 30_000));
    const outcome = await this.timed("archive", () => this.archiveGuarded(id, {}));
    if (outcome.outcome === "archive_busy") {
      throw capacityDenied(
        { reason: "transition_capacity", resource: "transitions", unit: "count", required: 1, available: 0, budget: this.cfg.admission.maxConcurrentArchives, committed: this.archiving.size, retryable: true, retryAfterMs: 15_000 },
        "archive concurrency is saturated; retry shortly",
      );
    }
    return outcome.sandbox;
  }

  /**
   * Archive-if-still-stopped (§3.3). Never stops a running sandbox, re-checks the state under
   * the same per-sandbox transition guard that protects the pack, and honours an expected
   * transition revision so a timer worker cannot act on a stale read.
   */
  async archiveIfStopped(id: string, guard: ArchiveIfStoppedRequest = {}): Promise<ArchiveIfStoppedResponse> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    this.assertArchiveConfigured();
    this.mustGet(id);
    const outcome = await this.timed("archive", () => this.archiveGuarded(id, guard));
    return outcome.sandbox === undefined ? { ...outcome, sandbox: this.info(id)! } : outcome;
  }

  /** Legacy reaper entry point; equivalent to {@link archiveIfStopped} without guards. */
  async archiveStopped(id: string): Promise<SandboxInfoWire> {
    return (await this.archiveIfStopped(id)).sandbox;
  }

  private assertArchiveConfigured(): void {
    if (this.objects.kind === "none") {
      throw conflict("archive storage is not configured", "set PI_POD_SANDBOX_ARCHIVE_DRIVER");
    }
  }

  private async archiveGuarded(
    id: string,
    guard: ArchiveIfStoppedRequest,
  ): Promise<{ value: ArchiveIfStoppedResponse; result: OpResult } & ArchiveIfStoppedResponse> {
    const answer = (outcome: ArchiveIfStoppedOutcome, result: OpResult): { value: ArchiveIfStoppedResponse; result: OpResult } & ArchiveIfStoppedResponse => {
      const response: ArchiveIfStoppedResponse = { archived: outcome === "archived", outcome, sandbox: this.info(id)! };
      return { ...response, value: response, result };
    };
    // Bounded archive concurrency: the slot is taken before queueing behind the sandbox's
    // own transitions so a saturated host answers immediately instead of piling up uploads.
    if (this.archiving.size >= this.cfg.admission.maxConcurrentArchives && !this.archiving.has(id)) {
      return answer("archive_busy", "noop");
    }
    this.archiving.add(id);
    try {
      return await this.serialize(id, async () => {
        if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
        const row = this.mustGet(id);
        if(this.observations && this.hasShadowWork(id))
          throw conflict("archive deferred while shadow execution work is active");
        if (row.tier === "archived") return answer("already_archived", "noop");
        this.assertNotHeld(row, "archive");
        if (this.transitioning.has(id)) return answer("transitioning", "noop");
        if (row.tier !== "stopped") return answer("not_stopped", "noop");
        if (guard.expectedRevision !== undefined && guard.expectedRevision !== row.revision) {
          return answer("revision_mismatch", "noop");
        }
        if (
          guard.expectedStoppedAt !== undefined &&
          (row.stoppedAt === null || new Date(row.stoppedAt).toISOString() !== guard.expectedStoppedAt)
        ) {
          return answer("revision_mismatch", "noop");
        }
        await this.pack(row);
        return answer("archived", "ok");
      });
    } finally {
      this.archiving.delete(id);
    }
  }

  /**
   * Pack, upload, verify, then release the local disk. The row stays `stopped` (and keeps
   * its disk commitment) until the upload is verified and the tier write under the same
   * revision succeeds; local cleanup failing afterwards leaves a quarantined image the
   * capacity report keeps charging.
   */
  private async pack(row: SandboxRow): Promise<void> {
    const id = row.id;
    const started = Date.now();
    this.transitioning.set(id, "archive");
    try {
      await this.disks.ensureMounted(
        id,
        row.ceiling.diskGB ?? resolveGuarantee(this.cfg, row.resources).diskGB,
      );
      const spool = path.join(this.cfg.paths.spool, `${id}-${Date.now()}.tar.zst`);
      fs.mkdirSync(this.cfg.paths.spool, { recursive: true });
      let packed: { sha256: string; size: number } | undefined;
      let verification: { method: "backend" | "readback"; downloadedBytes: number } = { method: "backend", downloadedBytes: 0 };
      try {
        packed = await packDir(this.upperDir(id), spool);
        const key = `${id}/upper-${packed.sha256}.tar.zst`;
        await this.objects.put(key, spool, { sha256: packed.sha256 });
        // Durable before destructive (§3.3): the object's content checksum must match what
        // was packed before the only local copy is deleted.
        verification = await this.verifyArchived(id, key, packed);
        await this.disks.unmount(id);
        const verified = packed;
        const committed = this.store.transaction(() => {
          this.store.setArchive(id, { key, sha256: verified.sha256, size: verified.size });
          return this.store.setTierIfRevision(id, row.revision, "archived");
        });
        if (!committed) {
          this.store.setArchive(id, row.archiveKey ? { key: row.archiveKey, sha256: row.archiveSha256!, size: row.archiveSize! } : null);
          // The verified object is now unreferenced. It is content-addressed and may already be
          // shared by a rehome target, so it is never deleted blindly: it is recorded as
          // explicit cleanup debt for an operator with a global reference view.
          this.metrics.recordSandboxOp("archive_orphan", "noop");
          this.meter({ kind: "failed", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { op: "archive", orphanObject: key, orphanBytes: verified.size } });
          this.log.warn({ sandbox: id, key, size: verified.size }, "archive lost the transition race; uploaded object retained as cleanup debt");
          throw conflict(`sandbox ${id} changed while it was being archived`, "the local workspace was left intact");
        }
      } finally {
        fs.rmSync(spool, { force: true });
      }
      try {
        await this.disks.destroy(id);
      } catch (err) {
        // Archived row + surviving image = quarantined disk in the capacity report.
        this.log.warn({ err, sandbox: id }, "archived, but local disk cleanup failed; disk stays charged");
      }
      const size = packed?.size ?? 0;
      // Exactly one `archived` event per successful archive; verification is a detail of it.
      this.meter({
        kind: "archived",
        sandboxId: id,
        ownerKey: row.ownerKey,
        runtimeGeneration: row.runtimeGeneration,
        durationMs: Date.now() - started,
        detail: { archiveSizeBytes: size, uploadedBytes: size, verify: verification.method, downloadedBytes: verification.downloadedBytes },
      });
      this.log.info({ sandbox: id, size }, "archived sandbox");
    } finally {
      await this.disks.unmount(id).catch(() => undefined);
      this.transitioning.delete(id);
    }
  }

  /**
   * Trusted verification of an uploaded archive. Size equality is necessary but not
   * sufficient; the content checksum must match `packed.sha256`. The backend's own
   * checksum is used when it can vouch for one, otherwise the object is read back
   * through the spool and hashed. Any failure leaves the local workspace intact.
   */
  private async verifyArchived(
    id: string,
    key: string,
    packed: { sha256: string; size: number },
  ): Promise<{ method: "backend" | "readback"; downloadedBytes: number }> {
    const stored = await this.objects.head(key);
    if (!stored || stored.size !== packed.size) {
      throw conflict(
        `archive upload for ${id} could not be verified (${stored ? `size ${stored.size} != ${packed.size}` : "object missing"})`,
        "the local workspace was left intact; retry the archive",
      );
    }
    if (stored.sha256 !== undefined) {
      if (stored.sha256 !== packed.sha256) {
        throw conflict(
          `archive upload for ${id} has checksum ${stored.sha256.slice(0, 12)}…, expected ${packed.sha256.slice(0, 12)}…`,
          "the object store copy is corrupt; the local workspace was left intact",
        );
      }
      return { method: "backend", downloadedBytes: 0 };
    }
    // No backend checksum: bounded read-back through the spool (one archive at a time per
    // sandbox, within the archive concurrency bound).
    const readback = path.join(this.cfg.paths.spool, `verify-${id}-${Date.now()}.tar.zst`);
    try {
      await this.objects.get(key, readback);
      const actual = await sha256File(readback);
      if (actual !== packed.sha256) {
        throw conflict(
          `archive read-back for ${id} has checksum ${actual.slice(0, 12)}…, expected ${packed.sha256.slice(0, 12)}…`,
          "the object store copy is corrupt; the local workspace was left intact",
        );
      }
      return { method: "readback", downloadedBytes: packed.size };
    } finally {
      fs.rmSync(readback, { force: true });
    }
  }

  /** Restore into a fresh quota image: a failed restore never destroys the archive. */
  private async restoreFromArchive(row: SandboxRow): Promise<void> {
    if (!row.archiveKey) throw conflict(`sandbox ${row.id} has no archive to restore`);
    const staging = path.join(this.cfg.paths.spool, `restore-${row.id}-${Date.now()}`);
    const download = `${staging}.tar.zst`;
    fs.mkdirSync(this.cfg.paths.spool, { recursive: true });
    try {
      await this.objects.get(row.archiveKey, download);
      const actual = await sha256File(download);
      if (actual !== row.archiveSha256) {
        throw conflict(
          `archive checksum mismatch for ${row.id}`,
          "the object store copy is corrupt; the local workspace was left untouched",
        );
      }
      await this.disks.destroy(row.id);
      await this.disks.ensureMounted(
        row.id,
        row.ceiling.diskGB ?? resolveGuarantee(this.cfg, row.resources).diskGB,
      );
      fs.rmSync(this.upperDir(row.id), { recursive: true, force: true });
      fs.mkdirSync(this.upperDir(row.id), { recursive: true });
      await unpackDir(download, this.upperDir(row.id));
      // The previous idle-stop timestamp is why we archived, not why we are stopped
      // now. Leaving it in place makes the reaper treat a restore as still long-stopped
      // and pack the workspace again before start() can launch.
      this.store.setTier(row.id, "stopped", { stoppedAt: Date.now(), error: null });
      this.log.info({ sandbox: row.id }, "restored sandbox from archive");
    } catch (error) {
      await this.disks.destroy(row.id).catch(() => undefined);
      throw error;
    } finally {
      fs.rmSync(download, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * Lend a stopped sandbox's writable layer — its overlay upper directory — to `use`, with the
   * disk mounted for the duration. Serialized with the sandbox's own transitions, so it can
   * neither start, archive nor be deleted meanwhile.
   */
  async withStoppedUpper<T>(id: string, use: (upperDir: string) => Promise<T>): Promise<T> {
    return await this.serialize(id, async () => {
      const row = this.mustGet(id);
      if (row.tier !== "stopped" || this.transitioning.has(id)) {
        throw conflict(`sandbox ${id} is ${row.tier}, not stopped`);
      }
      await this.disks.ensureMounted(id, row.ceiling.diskGB ?? resolveGuarantee(this.cfg, row.resources).diskGB);
      try {
        return await use(this.upperDir(id));
      } finally {
        await this.disks.unmount(id).catch(() => undefined);
      }
    });
  }

  /* ---------------------------------------------------------------- delete */

  async delete(id: string): Promise<void> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    return this.serializeSingleton(()=>this.deleteWithinSingleton(id));
  }

  private deleteWithinSingleton(id:string):Promise<void> {
    return this.serialize(id,()=>this.deleteBody(id));
  }

  /** Caller holds the sandbox queue when invoked from create cancellation. */
  private async deleteBody(id:string):Promise<void>{
    await this.timed("delete", async () => {
        if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
        const row = this.store.get(id);
        if (!row) {
          if(this.singleton.hasActiveId(id))
            throw conflict("rowless small VM allocation requires explicit operator reconciliation");
          // No row, but a rolled-back create may have left a charged reservation behind;
          // release it only once nothing of the sandbox remains on disk.
          const clean = !this.disks.hasImage(id) && !fs.existsSync(this.dir(id));
          for (const reservation of this.admission.activeFor(id)) {
            this.settleReservation(reservation.operationId, clean, "delete found leftovers without a row");
          }
          return { value: undefined, result: "noop" as const };
        }
        this.assertNotHeld(row, "delete");
        this.transitioning.set(id, "delete");
        try {
          if (row.tier === "hot" || row.tier === "warm") await this.teardown(row);
          await this.disks.destroy(id);
          if (row.archiveKey && row.archiveShared) {
            // Another host may reference this object (import, or export under a hold):
            // deleting metadata never deletes it. It is reported as cleanup debt for a
            // collector with a global reference view (§11.4).
            this.metrics.recordSandboxOp("archive_orphan", "noop");
            this.log.info({ sandbox: id, key: row.archiveKey }, "deleted sandbox metadata; shared archive object retained");
          } else if (row.archiveKey) {
            await this.objects.delete(row.archiveKey).catch(() => undefined);
          }
          fs.rmSync(this.dir(id), { recursive: true, force: true });
          const clean = !this.disks.hasImage(id) && !fs.existsSync(this.dir(id));
          if(this.singleton.enabled){
            // Keep the row (including its cgroup placement) until all external
            // probes have independently confirmed absence. A thrown probe is
            // uncertainty, not permission to retire the singleton allocation.
            if(!clean || !row.ownerKey || await this.runtime.state(id)!==null ||
              this.cgroupFor(row).exists() || fs.existsSync(netnsPath(id)))
              throw conflict("small VM deletion has unverified runtime leftovers");
            for(const reservation of this.admission.activeFor(id))
              this.settleReservation(reservation.operationId,true,"delete verified absence");
            if(this.admission.activeFor(id).length)
              throw conflict("small VM deletion has unresolved admission custody");
            this.store.transaction(()=>{
              this.store.delete(id);
              this.singleton.retire(id,row.ownerKey!);
            });
          } else {
            this.store.delete(id);
            for (const reservation of this.admission.activeFor(id)) {
              this.settleReservation(reservation.operationId, clean, "delete left resources behind");
            }
          }
          this.envs.delete(id);
          this.imageConfigs.delete(id);
          this.meter({ kind: "deleted", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { from: row.tier } });
          this.log.info({ sandbox: id }, "deleted sandbox");
        } finally {
          this.transitioning.delete(id);
        }
        return { value: undefined };
      });
  }

  /* --------------------------------------------------------------- reads */

  private mustGet(id: string): SandboxRow {
    const row = this.store.get(id);
    if (!row) throw notFound(`sandbox ${id} not found`);
    return row;
  }

  info(id: string): SandboxInfoWire | null {
    const row = this.store.get(id);
    return row ? this.toWire(row) : null;
  }

  list(selector: Record<string, string>): SandboxInfoWire[] {
    return this.store.findByLabels(selector).map((r) => this.toWire(r));
  }

  private toWire(row: SandboxRow): SandboxInfoWire {
    return {
      id: row.id,
      labels: row.labels,
      state: this.stateOf(row),
      createdAt: new Date(row.createdAt).toISOString(),
      lastActivityAt: new Date(row.lastActivityAt).toISOString(),
      image: row.image,
      workdir: row.workdir,
      tier: row.tier,
      archiveAfterMinutes: row.archiveAfterMinutes,
      idleTimeoutMinutes: row.idleTimeoutMinutes,
      resources: row.resources,
      ceiling: row.ceiling,
      owner: row.ownerKey === null ? null : { userKey: row.ownerKey },
      revision: row.revision,
      runtimeGeneration: row.runtimeGeneration,
      stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
      transition: this.transitioning.get(row.id) ?? null,
      archive: this.archiveOf(row),
      hold: row.hold,
      egress: row.egress,
    };
  }

  /* -------------------------------------------------------------- updates */

  async touch(id: string): Promise<string> {
    const row = this.mustGet(id);
    if (row.tier === "warm") await this.thaw(id);
    const now = Date.now();
    this.store.touch(id, now);
    return new Date(now).toISOString();
  }

  /** Labels are mutable metadata; ownership is a separate immutable column (§7.2). */
  setLabels(id: string, labels: Record<string, string>): SandboxInfoWire {
    this.mustGet(id);
    this.store.mergeLabels(id, labels);
    return this.info(id)!;
  }

  /**
   * One-time trusted owner initialization for a legacy unowned sandbox (§7.2 rollout).
   * Compare-and-set `null → userKey` under the sandbox's transition lock; only while the
   * sandbox is not live, because a running flat cgroup is never moved. Same owner replays
   * idempotently; a different existing owner is a conflict. Labels play no part.
   */
  async initializeOwner(id: string, userKey: string): Promise<OwnerInitResponse> {
    validateOwnerKey(userKey);
    return await this.serialize(id, async () => {
      const row = this.mustGet(id);
      if (row.ownerKey === userKey) return { changed: false, sandbox: this.info(id)! };
      this.assertNotHeld(row, "owner initialization");
      if (row.ownerKey !== null) {
        throw ownerConflict(
          `sandbox ${id} already has an owner`,
          "ownership is immutable; rehome by archiving and importing with the new owner",
        );
      }
      if (row.tier === "hot" || row.tier === "warm" || this.transitioning.has(id)) {
        throw ownerConflict(
          `sandbox ${id} is running; a live cgroup is never moved`,
          "stop the sandbox first, then initialize its owner before the next start",
        );
      }
      if (this.ownershipUncertain(row)) {
        throw ownerConflict(
          `sandbox ${id} is ${row.tier === "error" ? "in error" : "holding an unresolved reservation"}; its runtime may still be live on the legacy layout`,
          "resolve it first (delete it, or let restart recovery / a successful stop prove it is not live), then initialize the owner",
        );
      }
      const outcome = this.store.setOwnerIfNull(id, userKey);
      if (outcome === "different") throw ownerConflict(`sandbox ${id} already has an owner`);
      if (outcome === "missing") throw notFound(`sandbox ${id} not found`);
      if (outcome === "set") {
        this.meter({ kind: "owner_initialized", sandboxId: id, ownerKey: userKey, runtimeGeneration: row.runtimeGeneration, detail: { from: row.tier } });
        this.log.info({ sandbox: id, tenant: userKey }, "initialized sandbox owner");
      }
      return { changed: outcome === "set", sandbox: this.info(id)! };
    });
  }

  /** Reapplying policy never touches the authoritative stop timestamp (§3.3). */
  applyRetention(id: string, archiveAfterMinutes: number): boolean {
    const row = this.mustGet(id);
    if (row.archiveAfterMinutes === archiveAfterMinutes) return false;
    // A held source's manifest is what the target imported; a retention change would make
    // the two diverge under the fence. The same-value replay above stays a no-op.
    this.assertNotHeld(row, "retention change");
    this.store.setRetention(id, archiveAfterMinutes);
    return true;
  }

  /**
   * Grow a sandbox's ceiling (§7.4): reserve only the increase, apply and read back the
   * cgroup limits, then grow the image, then commit. Denial or a failed apply leaves the
   * sandbox intact at its old limits.
   */
  async setResourceCeiling(
    id: string,
    ceiling?: ResourceSpec,
  ): Promise<{ guarantee: ResourceSpec; ceiling: ResourceSpec }> {
    if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
    return await this.serialize(id, async () => {
      if(this.observations?.held())throw conflict("shadow execution custody is unresolved");
      const row = this.mustGet(id);
      this.assertNotHeld(row, "resize");
      assertSupportedShape(this.cfg, ceiling);
      this.assertSmallDisk(ceiling);
      const guarantee = resolveGuarantee(this.cfg, row.resources);
      const nextCeiling = resolveCeiling(this.cfg, { ...row.ceiling, ...(ceiling ?? {}) });
      const oldDiskGB = row.ceiling.diskGB ?? guarantee.diskGB;
      const newDiskGB = nextCeiling.diskGB ?? guarantee.diskGB;
      if (newDiskGB < guarantee.diskGB) {
        throw badRequest(`disk ceiling ${newDiskGB}GB cannot be lower than its ${guarantee.diskGB}GB guarantee`);
      }
      if (newDiskGB < oldDiskGB) {
        throw conflict(
          `disk quota cannot shrink from ${oldDiskGB}GB to ${newDiskGB}GB`,
          "archive the workspace into a new smaller sandbox instead",
        );
      }
      const oldMemoryGB = row.ceiling.memoryGB ?? this.cfg.maximums.memoryGB;
      const newMemoryGB = nextCeiling.memoryGB ?? this.cfg.maximums.memoryGB;
      if (newMemoryGB < oldMemoryGB && (row.tier === "hot" || row.tier === "warm")) {
        // No automatic shrink in this rollout (§7.4): a live process may already exceed it.
        throw conflict(
          `memory ceiling cannot shrink from ${oldMemoryGB}GB to ${newMemoryGB}GB while the sandbox runs`,
          "stop the sandbox first",
        );
      }

      const operationId = `resize:${id}:${randomUUID().slice(0, 8)}`;
      const rows = this.store.all();
      // Growth is footprint expansion: a degraded tenant on a grant-managed host waits for the
      // allocator like a new launch would. No-op and pure shrink are not gated.
      if (newMemoryGB > oldMemoryGB || newDiskGB > oldDiskGB) this.assertFairnessAvailable(row.ownerKey, rows, "resize");
      this.reserve(operationId, { id, resources: guarantee, ceiling: nextCeiling }, "resize", rows, {
        memoryBytes: row.tier === "hot" || row.tier === "warm" ? memoryReservationBytes(this.cfg, guarantee, nextCeiling) : 0,
        diskBytes: newDiskGB * GB,
      });
      const cgroup = this.cgroupFor(row);
      const oldLimits = limitsFor(guarantee, row.ceiling, this.cfg.maxPids);
      try {
        // Reversible first: cgroup limits can be put back, a grown ext4 image cannot shrink.
        if (cgroup.exists()) {
          this.admission.setPhase(operationId, "cgroup");
          const verified = cgroup.applyLimitsVerified(limitsFor(guarantee, nextCeiling, this.cfg.maxPids));
          if (!verified.ok) {
            cgroup.applyLimits(oldLimits);
            throw conflict(
              `new limits could not be applied (${verified.mismatches.map((m) => m.file).join(", ")}); the sandbox keeps its previous ceiling`,
            );
          }
        }
        if (newDiskGB > oldDiskGB) {
          this.admission.setPhase(operationId, "disk");
          try {
            await this.disks.grow(id, oldDiskGB, newDiskGB);
          } catch (err) {
            if (cgroup.exists()) cgroup.applyLimits(oldLimits);
            throw err;
          }
        }
        this.store.setResources(id, guarantee, nextCeiling);
        this.admission.commit(operationId);
        this.meter({ kind: "resized", sandboxId: id, ownerKey: row.ownerKey, runtimeGeneration: row.runtimeGeneration, detail: { memoryGB: newMemoryGB, diskGB: newDiskGB, cpu: nextCeiling.cpu ?? null } });
      } catch (err) {
        // Nothing persisted: the row still describes the old limits, which the cgroup has
        // back. A partially grown image would exceed the row's quota, so keep it charged.
        let imageWithinQuota = true;
        try {
          if (this.disks.hasImage(id)) imageWithinQuota = fs.statSync(this.disks.layout(id).image).size <= oldDiskGB * GB;
        } catch {
          imageWithinQuota = false;
        }
        this.settleReservation(operationId, imageWithinQuota, "resize failed after the image grew");
        throw err;
      }
      return { guarantee, ceiling: nextCeiling };
    });
  }

  /* ------------------------------------------------------------ tenancy */

  /** Apply a fleet allocator's CPU grant to the tenant parent (§7.3). */
  applyCpuGrant(userKey: string, req: CpuGrantRequest): CpuGrantResponse {
    if(this.singleton.enabled || this.observations)
      throw conflict("small or shadow runtime does not accept shared-fleet CPU grants");
    validateOwnerKey(userKey);
    const result = this.grants.apply(userKey, req, this.fallbackContext());
    const tenant = this.cgroups.tenant(userKey);
    const applied = tenant.exists() ? tenant.setCpuMax(result.effectiveCores) : false;
    return { userKey, applied, grant: result.grant };
  }

  tenantStatus(userKey: string): TenantStatusWire {
    validateOwnerKey(userKey);
    const rows = this.store.byOwner(userKey);
    const tenant = this.cgroups.tenant(userKey);
    const status = this.grants.status(userKey, this.fallbackContext());
    const live = rows.filter((r) => r.tier === "hot" || r.tier === "warm").map((r) => r.id);
    return {
      userKey,
      sandboxIds: rows.map((r) => r.id),
      liveSandboxIds: live,
      cgroupPresent: tenant.exists(),
      grant: status.grant,
      effectiveCpuCores: tenant.exists() ? tenant.currentCpuMax() : status.effectiveCores,
      degraded: this.grants.managedMode() && status.state !== "active",
    };
  }

  /**
   * Reaper hook: grants whose host-local ttl elapsed fall back to the bounded local share.
   * Also re-derives the fallback for already-degraded tenants as the owner count changes.
   */
  expireGrants(): number {
    if(this.singleton.enabled || this.observations)return 0;
    const rows = this.store.all();
    const ctx = this.fallbackContext(rows);
    const expired = this.grants.expireDue(ctx);
    for (const { userKey, effectiveCores } of expired) {
      const tenant = this.cgroups.tenant(userKey);
      if (tenant.exists()) tenant.setCpuMax(effectiveCores);
      this.log.warn({ tenant: userKey, fallbackCores: effectiveCores }, "cpu grant expired; bounded local fallback applied");
    }
    if (this.grants.managedMode()) {
      const owners = [...new Set(rows.filter((r) => (r.tier === "hot" || r.tier === "warm") && r.ownerKey).map((r) => r.ownerKey!))];
      for (const userKey of this.grants.degradedOwners(owners)) {
        const tenant = this.cgroups.tenant(userKey);
        if (tenant.exists()) tenant.setCpuMax(this.grants.fallbackCores(ctx));
      }
    }
    return expired.length;
  }

  /* ----------------------------------------------------------- operations */

  operationStatus(key: string): OperationStatusWire {
    if (!OPERATION_KEY.test(key)) throw badRequest("operation key must match ^[A-Za-z0-9._:-]{8,128}$");
    const op = this.operations.get(key);
    if (!op) throw notFound(`operation ${key} not found`);
    return this.operations.toWire(op);
  }

  /** Cancel/cleanup by operation key: the recovered sandbox id is what gets deleted (§6.5). */
  async cancelOperation(key: string): Promise<OperationStatusWire> {
    if (!OPERATION_KEY.test(key)) throw badRequest("operation key must match ^[A-Za-z0-9._:-]{8,128}$");
    const op = this.operations.get(key);
    if (!op) throw notFound(`operation ${key} not found`);
    if (op.status === "pending") {
      const requested=this.operations.requestCancel(key)??op;
      if(this.observations && requested.sandboxId)this.abortShadowWork(requested.sandboxId);
      return this.operations.toWire(requested);
    }
    if (op.status === "succeeded" && op.sandboxId) {
      await this.delete(op.sandboxId);
      return this.operations.toWire(this.operations.cancel(key, op.sandboxId, "cleaned"));
    }
    if (op.sandboxId && op.resolution === "quarantined") {
      // A retained/uncertain workspace: deleting by the recovered id is the cleanup path.
      await this.delete(op.sandboxId);
      const clean = !this.disks.hasImage(op.sandboxId) && !fs.existsSync(this.dir(op.sandboxId));
      return this.operations.toWire(this.operations.resolve(key, clean ? "cleaned" : "quarantined"));
    }
    return this.operations.toWire(op);
  }

  /* -------------------------------------------------------------- capacity */

  capacityReport(): CapacityReportV1 {
    const rows = this.store.all();
    const totals = this.admission.capacity(rows);
    const counts = { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0 };
    for (const row of rows) counts[row.tier] += 1;
    const grants = this.grants.counts();
    const owners = [...new Set(rows.filter((r) => (r.tier === "hot" || r.tier === "warm") && r.ownerKey).map((r) => r.ownerKey!))];
    const degraded = this.grants.degradedOwners(owners);
    const managed = this.grants.managedMode();
    let ownedSandboxes = 0;
    let unownedLive = 0;
    let unownedInitializable = 0;
    let unownedUncertain = 0;
    for (const row of rows) {
      if (row.ownerKey) ownedSandboxes += 1;
      else if (row.tier === "hot" || row.tier === "warm") unownedLive += 1;
      else if (this.ownershipUncertain(row)) unownedUncertain += 1;
      else unownedInitializable += 1;
    }
    this.capacityGeneration += 1;
    return {
      contractVersion: CAPACITY_CONTRACT_VERSION,
      hostId: this.cfg.hostId,
      bootId: this.bootId,
      serviceVersion: this.serviceVersion,
      generation: this.capacityGeneration,
      sampledAt: new Date().toISOString(),
      capabilities: {
        maxShape: maximumShape(this.cfg),
        standardShape: standardShape(this.cfg),
        resize: { memoryGrowOnline: true, memoryShrink: false, diskGrowOnline: true, diskShrink: false },
        memoryAdmission: this.cfg.admission.memoryMode,
        ...(this.cfg.hostBackend === "boat" ? { boat: true } : {}),
        ...(this.cfg.admission.diskMode === "sparse" ? { diskAdmission: "sparse" as const, storageQuotaBytes: this.cfg.admission.storageQuotaBytes! } : {}),
        ownerIdentity: true,
        tenantCgroups: true,
        tenantLimits: {
          memoryMaxBytes: this.cfg.tenancy.tenantMemoryMaxBytes,
          cpuMaxCores: this.cfg.tenancy.tenantCpuMaxCores,
        },
        cpuGrants: true,
        idempotentCreate: true,
        archiveIfStopped: true,
        usageFeed: true,
      },
      memory: totals.memory,
      cpu: totals.cpu,
      disk: totals.disk,
      transitions: {
        inFlight: totals.transitions.inFlight,
        maxInFlight: this.cfg.admission.maxConcurrentTransitions,
        archivesInFlight: this.archiving.size,
        maxConcurrentArchives: this.cfg.admission.maxConcurrentArchives,
        pendingOperations: totals.transitions.pendingOperations,
        quarantinedOperations: totals.transitions.quarantinedOperations,
      },
      sandboxes: { ...counts, booting: this.booting.size },
      fairness: {
        mode: !managed ? "local-weights" : degraded.length > 0 ? "degraded" : "grants",
        managed,
        gateAdmissions: this.cfg.tenancy.gateDegradedAdmission,
        activeGrants: grants.active,
        expiredGrants: grants.expired,
        degradedTenants: degraded.length,
      },
      tenancy: {
        ownedSandboxes,
        unownedLive,
        unownedInitializable,
        unownedUncertain,
        requireOwner: this.cfg.tenancy.requireOwner,
      },
    };
  }

  /* ----------------------------------------------------------------- usage */

  /**
   * One bounded page of per-sandbox measurements (§8.1–8.1.1). Rows are classified:
   * live tiers (hot/warm/stopped, anything transitioning) and `error` keep full
   * per-poll cadence exactly as before; a PROVABLY archived row (tier `archived`, no
   * local image, zero disk commitment) collapses to one heartbeat sample per
   * (sandbox, UTC day), resampled when archiveSize/archiveKey/archiveSha256/
   * tier/state/owner/runtimeGeneration changes. Ambiguous rows (archived with a
   * leaked image, `error`) stay full
   * cadence — never an imputed zero. Rows are assembled in stable id order so a
   * paginating server sees each row once per poll; the hard payload cap lives in
   * the usage ledger (`PI_POD_SANDBOX_USAGE_MAX_ROWS`).
   *
   * A heartbeat counts as emitted only when its sample is actually delivered in the
   * returned page: each `GET /v1/usage` re-assembles, so marking at assembly time
   * would let heartbeats assembled-but-cut-off-by-the-page vanish until the next
   * day. A paginating server that drains to `nextCursor: null` therefore sees every
   * row exactly once per poll, and the next poll owes zero heartbeats.
   */
  usageSnapshot(opts: { cursor: string | null; limit: number; nonce?: string | null }): UsageSnapshotV1 {
    const started = process.hrtime.bigint();
    // Lean read: one round-trip, no per-row labels/layers N+1 (samples never emit them).
    const rows = this.store
      .allForUsageSnapshot()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const samples: UsageSampleWire[] = [];
    const heartbeatPrints = new Map<string, { day: string; fingerprint: string }>();
    for (const row of rows) {
      const sample = this.snapshotRow(row, day, heartbeatPrints);
      if (sample === null) continue; // heartbeat already delivered for this (sandbox, day).
      samples.push(sample);
    }
    this.sweepHeartbeats(day);
    const snapshot = this.usage.snapshot(samples, opts);
    // Delivery marks the dedup map, but the gauges report the poll's full
    // assembly: only the first page (cursor === null) assembles everything
    // owed, so only it may move the gauges — later pages assemble just the
    // unmarked remainder and would otherwise overwrite them toward zero
    // mid-drain. The duration histogram still observes every call, since each
    // assembly costs work.
    const delivered = new Set(snapshot.samples.map((s) => s.sandboxId));
    for (const [id, print] of heartbeatPrints) {
      if (delivered.has(id)) this.usageHeartbeats.set(id, print);
    }
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    if (opts.cursor === null) {
      let live = 0;
      let heartbeat = 0;
      let error = 0;
      for (const sample of samples) {
        if (sample.cadence === "heartbeat") heartbeat += 1;
        else if (sample.tier === "error") error += 1;
        else live += 1;
      }
      this.metrics.recordUsageSnapshot({ live, heartbeat, error }, seconds);
    } else {
      this.metrics.recordUsageSnapshotDuration(seconds);
    }
    return snapshot;
  }

  /**
   * Classify one row. Returns null when a heartbeat for this (sandbox, UTC day) was
   * already emitted and nothing resample-worthy changed. The heartbeat path performs
   * zero `statSync` calls and, on a cache hit, zero filesystem calls at all: image
   * absence was proven with `hasImage` (existence metadata, not a stat) at first
   * sighting and the proof is re-checked whenever the fingerprint changes.
   */
  private snapshotRow(
    row: SandboxRow,
    day: string,
    heartbeatPrints: Map<string, { day: string; fingerprint: string }>,
  ): UsageSampleWire | null {
    const state = this.stateOf(row);
    if (row.tier === "archived" && !this.transitioning.has(row.id)) {
      const fingerprint = [
        row.tier,
        state,
        row.ownerKey ?? "",
        row.archiveKey ?? "",
        row.archiveSha256 ?? "",
        row.archiveSize ?? "",
        row.runtimeGeneration,
      ].join("|");
      const seen = this.usageHeartbeats.get(row.id);
      if (seen !== undefined && seen.day === day && seen.fingerprint === fingerprint) {
        return null;
      }
      if (!this.disks.hasImage(row.id)) {
        heartbeatPrints.set(row.id, { day, fingerprint });
        return buildUsageSample({
          row,
          state,
          stats: null,
          diskCommittedBytes: 0,
          diskAllocatedBytes: 0,
          cadence: "heartbeat",
          cpuValid: false,
        });
      }
      // Archived but a local image is still present (leak/quarantine): full cadence.
      // hasImage is already proven true here, so pass it through instead of
      // stating the filesystem a second time inside fullSample.
      return this.fullSample(row, state, true);
    }
    return this.fullSample(row, state);
  }

  /** Full-cadence sample, byte-for-byte the pre-heartbeat behaviour plus cadence labels. */
  private fullSample(row: SandboxRow, state: SandboxState, knownHasImage?: boolean): UsageSampleWire {
    const live = row.tier === "hot" || row.tier === "warm";
    const stats = live ? this.safeStats(row) : null;
    let allocated = 0;
    try {
      allocated = this.statSyncFn(this.disks.layout(row.id).image).blocks * 512;
    } catch {
      allocated = 0;
    }
    const quota = (row.ceiling.diskGB ?? row.resources.diskGB ?? 0) * GB;
    const hasImage = knownHasImage ?? (row.tier !== "archived" ? true : this.disks.hasImage(row.id));
    const committed = row.tier !== "archived" || hasImage ? quota : 0;
    // pod-ready-v1: the authorized execution is hot, its cgroup is readable, at
    // least one process is inside it, and no hold or error fences it. This is a
    // supervision/resource assertion, not application health, and the server
    // still derives durations from the monotonic readings. Only the hot tier
    // counts: a warm or archived row is not supervised pod execution.
    const serviceReady =
      row.tier === "hot" && stats !== null && state === "started" &&
      Number.isFinite(stats.pidsCurrent) && stats.pidsCurrent > 0 &&
      row.hold === null && row.error === null;
    return buildUsageSample({
      row,
      state,
      stats,
      diskCommittedBytes: committed,
      diskAllocatedBytes: allocated,
      serviceReady,
      predicateVersion: "pod-ready-v1",
      monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
    });
  }

  /** Bound the heartbeat dedup map: drop entries from past days once it grows large. */
  private sweepHeartbeats(day: string): void {
    if (this.usageHeartbeats.size <= 20_000) return;
    for (const [id, seen] of this.usageHeartbeats) {
      if (seen.day !== day) this.usageHeartbeats.delete(id);
    }
  }

  /* ----------------------------------------------------------------- exec */

  private processEnv(id: string, extra?: Record<string, string>): Record<string, string> {
    const image = this.imageConfigs.get(id);
    const base: Record<string, string> = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/root",
      TERM: "xterm-256color",
    };
    for (const entry of image?.env ?? []) {
      const eq = entry.indexOf("=");
      if (eq > 0) base[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return { ...base, ...(this.envs.get(id) ?? {}), ...(extra ?? {}) };
  }

  async execStream(id: string, spec: ExecSpec, hooks: ExecHooks = {}): Promise<number> {
    const ticket=this.beginShadowWork(id);
    const externalAbort=()=>ticket.abort();
    if(spec.signal?.aborted)ticket.abort();
    else spec.signal?.addEventListener("abort",externalAbort,{once:true});
    const work=()=>this.execStreamInner(id,{...spec,signal:ticket.signal??spec.signal},hooks)
      .finally(()=>{spec.signal?.removeEventListener("abort",externalAbort);ticket.finish()});
    return this.observations?this.serialize(id,work):work();
  }

  private async execStreamInner(id:string,spec:ExecSpec,hooks:ExecHooks):Promise<number>{
      if(spec.signal?.aborted)throw new Error("exec cancelled before dispatch");
      const started = process.hrtime.bigint();
      try {
        const row = await this.ensureHot(id);
        const code = await this.execIn(row, spec, hooks);
        this.metrics.recordExec("ok", Number(process.hrtime.bigint() - started) / 1e9);
        return code;
      } catch (error) {
        const result = error instanceof ServiceError && error.code === ERR_TIMEOUT ? "timeout" : "error";
        this.metrics.recordExec(result, Number(process.hrtime.bigint() - started) / 1e9);
        throw error;
      }
  }

  /** Bypasses the tier check: launch() runs inside the transition that makes a sandbox hot. */
  private async execIn(row: SandboxRow, spec: ExecSpec, hooks: ExecHooks = {}): Promise<number> {
    const id = row.id;
    if(spec.signal?.aborted)throw new Error("exec cancelled before spawn");
    this.store.touch(id);
    const processFile = this.runtime.processFile(path.join(this.dir(id), "exec"), {
      argv: spec.argv,
      cwd: spec.cwd ?? row.workdir,
      env: this.processEnv(id, spec.env),
    });
    const child = this.runtime.spawnExec(id, processFile);
    const removeProcessFile=()=>fs.rmSync(processFile,{force:true});
    this.trackShadowChild(child,id,removeProcessFile);
    if(!this.observations)child.once("close",removeProcessFile);
    let cancelled:"stop"|"timeout"|null=null;
    let resolveCancelled:(value:{kind:"cancelled";reason:"stop"|"timeout"})=>void=()=>{};
    const cancelledWork=new Promise<{kind:"cancelled";reason:"stop"|"timeout"}>(resolve=>{resolveCancelled=resolve});
    const cancel=(reason:"stop"|"timeout")=>{
      if(cancelled)return;
      cancelled=reason;
      if(this.observations)try{this.observations.markHold(`exec-${reason}-after-dispatch`,id);}catch{}
      try{child.kill("SIGKILL");}catch{}
      resolveCancelled({kind:"cancelled",reason});
    };
    const abort=()=>cancel("stop");
    spec.signal?.addEventListener("abort",abort,{once:true});
    let timer: NodeJS.Timeout | undefined;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      timer = setTimeout(() => cancel("timeout"), spec.timeoutMs);
    }
    child.stdout?.on("data", (chunk: Buffer) => hooks.onStdout?.(chunk));
    child.stderr?.on("data", (chunk: Buffer) => hooks.onStderr?.(chunk));
    try{hooks.onStarted?.((signal) => child.kill(signal ?? "SIGTERM"), child.stdin as Writable)}
    catch(error){if(this.observations)cancel("stop");else child.kill("SIGKILL");}

    const exited=new Promise<{kind:"exit";code:number}|{kind:"error";error:Error}>(resolve=>{
      child.once("error",error=>resolve({kind:"error",error:error as Error}));
      child.once("close",code=>resolve({kind:"exit",code:code??-1}));
    });
    if(spec.signal?.aborted)abort();
    try{
      let result:{kind:"exit";code:number}|{kind:"error";error:Error}|{kind:"cancelled";reason:"stop"|"timeout"};
      if(this.observations)result=await Promise.race([exited,cancelledWork]);
      else result=await exited;
      if(result.kind==="cancelled"){
        if(result.reason==="timeout")throw timedOut(`exec exceeded ${spec.timeoutMs}ms`);
        throw new Error("exec cancelled by explicit stop");
      }
      if(result.kind==="error")throw result.error;
      if(cancelled==="timeout")throw timedOut(`exec exceeded ${spec.timeoutMs}ms`);
      if(cancelled==="stop")throw new Error("exec cancelled by explicit stop");
      this.store.touch(id);
      return result.code;
    }finally{spec.signal?.removeEventListener("abort",abort);clearTimeout(timer)}
  }

  async execCollect(id: string, spec: ExecSpec): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return await this.collect((hooks) => this.execStream(id, spec, hooks));
  }

  private async collect(
    exec: (hooks: ExecHooks) => Promise<number>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const exitCode = await exec({
      onStdout: (c) => (stdout += c.toString("utf8")),
      onStderr: (c) => (stderr += c.toString("utf8")),
    });
    return { exitCode, stdout, stderr };
  }

  /* ------------------------------------------------------------ file i/o */

  async uploadFile(id:string,destPath:string,mode:number,body:Readable):Promise<void>{
    const ticket=this.beginShadowWork(id);
    const work=()=>this.uploadFileInner(id,destPath,mode,body,ticket.signal).finally(ticket.finish);
    return this.observations?this.serialize(id,work):work();
  }

  private async uploadFileInner(id:string,destPath:string,mode:number,body:Readable,signal?:AbortSignal):Promise<void>{
    let child:ChildProcess|null=null;let processFile:string|null=null;
    let removeAbort=()=>{};
    try {
    if(signal?.aborted)throw new Error("upload cancelled before dispatch");
    if (!destPath.startsWith("/")) throw badRequest("path must be absolute");
    await this.ensureHot(id);
    if(signal?.aborted)throw new Error("upload cancelled before spawn");
    processFile = this.runtime.processFile(path.join(this.dir(id), "exec"), {
      argv: [INIT_PATH, "put", destPath, mode.toString(8)],
      cwd: "/",
      env: {},
    });
    const spawned=this.runtime.spawnExec(id, processFile);
    child=spawned;
    const removeProcessFile=()=>{if(processFile)fs.rmSync(processFile,{force:true})};
    this.trackShadowChild(spawned,id,removeProcessFile);
    if(!this.observations)spawned.once("close",removeProcessFile);
    let stderr = "";
    spawned.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    spawned.stdout?.resume();
    let cancelled=false;
    let resolveCancelled:(value:{cancelled:true})=>void=()=>{};
    const cancelledWork=new Promise<{cancelled:true}>(resolve=>{resolveCancelled=resolve});
    const onAbort=()=>{cancelled=true;
      if(this.observations){try{this.observations.markHold("upload-cancelled-during-execution",id);}catch{}}
      try{spawned.kill("SIGKILL");}catch{}
      resolveCancelled({cancelled:true});};
    signal?.addEventListener("abort",onAbort,{once:true});
    removeAbort=()=>signal?.removeEventListener("abort",onAbort);
    const childExit=new Promise<{code:number}|{error:Error}>(resolve=>{
      spawned.once("error",error=>resolve({error:error as Error}));
      spawned.once("close",code=>resolve({code:code??-1}));
    });
    if(signal?.aborted)onAbort();
    await pipeline(body,spawned.stdin!,{signal});
    const outcome=this.observations?await Promise.race([childExit,cancelledWork]):await childExit;
    if("cancelled" in outcome)throw new Error("upload cancelled by explicit stop");
    if("error" in outcome)throw outcome.error;
    if(cancelled)throw new Error("upload cancelled by explicit stop");
    const code=outcome.code;
    fs.rmSync(processFile, { force: true });
    this.store.touch(id);
    if (code !== 0) throw conflict(`upload to ${destPath} failed: ${stderr.trim() || `exit ${code}`}`);
    this.metrics.recordFile("upload", "ok");
    removeAbort();
    } catch (error) {
      removeAbort();
      if(this.observations && child && child.exitCode===null){
        try{this.observations.markHold("upload-execution-unresolved",id);}catch{}
        try{child.kill("SIGKILL");}catch{}
      }else if(!child && processFile)fs.rmSync(processFile,{force:true});
      this.metrics.recordFile("upload", "error");
      throw error;
    }
  }

  /**
   * The response status cannot be committed until the exit code is known: a missing file
   * produces no bytes, and a stream that already ended cannot become a 404.
   */
  async downloadFile(id:string,sourcePath:string,sink:Writable,onCommit:()=>void):Promise<void>{
    const ticket=this.beginShadowWork(id);
    const work=()=>this.downloadFileInner(id,sourcePath,sink,onCommit,ticket.signal).finally(ticket.finish);
    return this.observations?this.serialize(id,work):work();
  }

  private async downloadFileInner(
    id: string,
    sourcePath: string,
    sink: Writable,
    onCommit: () => void,
    signal?:AbortSignal,
  ): Promise<void> {
    let child:ChildProcess|null=null;let processFile:string|null=null;
    let committed=false;let sinkDestroyPending=false;
    let failCommittedSink:((error:unknown)=>void)|null=null;
    let removeSinkHandlers=()=>{};
    const waitForSinkTerminal=()=>new Promise<void>(resolve=>{
      if(sink.closed||sink.writableFinished){resolve();return;}
      const terminal=()=>{sink.off("finish",terminal);sink.off("close",terminal);resolve()};
      sink.once("finish",terminal);sink.once("close",terminal);
    });
    try {
    if(signal?.aborted)throw new Error("download cancelled before dispatch");
    if(sink.destroyed||sink.writableEnded||sink.writableFinished){
      sinkDestroyPending=!sink.closed&&!sink.writableFinished;
      if(sinkDestroyPending)await waitForSinkTerminal();
      throw new Error("download destination is already closed");
    }
    if (!sourcePath.startsWith("/")) throw badRequest("path must be absolute");
    await this.ensureHot(id);
    if(signal?.aborted)throw new Error("download cancelled before spawn");
    if(sink.destroyed||sink.writableEnded||sink.writableFinished){
      sinkDestroyPending=!sink.closed&&!sink.writableFinished;
      if(sinkDestroyPending)await waitForSinkTerminal();
      throw new Error("download destination closed while waiting for sandbox");
    }
    processFile = this.runtime.processFile(path.join(this.dir(id), "exec"), {
      argv: [INIT_PATH, "get", sourcePath],
      cwd: "/",
      env: {},
    });
    const spawned=this.runtime.spawnExec(id, processFile);
    child=spawned;
    const removeProcessFile=()=>{if(processFile)fs.rmSync(processFile,{force:true})};
    this.trackShadowChild(spawned,id,removeProcessFile);
    if(!this.observations)spawned.once("close",removeProcessFile);
    let stderr = "";
    let streamError:unknown;
    let rejectSinkFinish:((error:Error)=>void)|null=null;
    let resolveCancelled:(error:unknown)=>void=()=>{};
    const cancelledWork=new Promise<{cancelled:true;error:unknown}>(resolve=>{resolveCancelled=error=>resolve({cancelled:true,error})});
    const failSink=(error:unknown)=>{
      if(streamError)return;
      streamError=error;
      if(this.observations)try{this.observations.markHold("download-sink-outcome-unresolved",id);}catch{}
      sinkDestroyPending=!sink.closed&&!sink.writableFinished;
      if(!sink.destroyed)sink.destroy(error instanceof Error?error:new Error("download sink failed"));
      try{spawned.kill("SIGKILL");}catch{}
      resolveCancelled(error);
    };
    failCommittedSink=failSink;
    spawned.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const onSinkClose=()=>{if(!sink.writableFinished)failSink(new Error("download destination closed early"));};
    sink.once("error",failSink);
    sink.once("close",onSinkClose);
    const abort=()=>{
      const error=new Error("download cancelled by explicit stop");
      failSink(error);
      if(rejectSinkFinish)rejectSinkFinish(error);
      else if(!sink.destroyed)sink.destroy(error);
      resolveCancelled(error);
    }
    signal?.addEventListener("abort",abort,{once:true});
    removeSinkHandlers=()=>{sink.off("error",failSink);sink.off("close",onSinkClose);signal?.removeEventListener("abort",abort)};
    if(signal?.aborted)abort();
    spawned.stdout!.once("data", (chunk: Buffer) => {
      try{
        if(streamError||sink.destroyed||sink.writableEnded||sink.writableFinished){
          failSink(new Error("download destination is unavailable"));return;
        }
        committed = true;
        onCommit();
        if(sink.destroyed||sink.writableEnded||sink.writableFinished){
          failSink(new Error("download destination closed during response commit"));return;
        }
        sink.write(chunk);
        spawned.stdout!.pipe(sink, { end: false });
      }catch(error){failSink(error)}
    });

    const childExit=new Promise<{code:number}|{error:Error}>(resolve=>{
      spawned.once("error",error=>resolve({error:error as Error}));
      spawned.once("close",code=>resolve({code:code??-1}));
    });
    const outcome=this.observations?await Promise.race([childExit,cancelledWork]):await childExit;
    if("cancelled" in outcome)throw outcome.error;
    if("error" in outcome)throw outcome.error;
    const code=outcome.code;
    fs.rmSync(processFile, { force: true });
    if(streamError)throw streamError;
    this.store.touch(id);
    if (code === 2) {
      const error=notFound(stderr.replace(/^pps-init: get /, "").trim() || `${sourcePath} does not exist in sandbox ${id}`);
      if(committed){failSink(error);if(sinkDestroyPending)await waitForSinkTerminal();}
      throw error;
    }
    if (code !== 0) {
      const error=conflict(`download of ${sourcePath} failed: ${stderr.trim() || `exit ${code}`}`);
      if(committed){failSink(error);if(sinkDestroyPending)await waitForSinkTerminal();}
      throw error;
    }
    if (!committed){committed=true;onCommit();}
    await new Promise<void>((resolve,reject)=>{
      if(sink.destroyed||sink.writableEnded){reject(new Error("download destination closed before finish"));return;}
      if(sink.writableFinished){resolve();return;}
      const cleanup=()=>{sink.off("finish",finish);sink.off("error",failed);sink.off("close",closed);rejectSinkFinish=null};
      const finish=()=>{cleanup();resolve()};
      const failed=(error:Error)=>{failSink(error)};
      const closed=()=>{if(!sink.writableFinished){cleanup();reject(streamError??new Error("download destination closed before finish"));}
        else finish()};
      rejectSinkFinish=(error)=>{if(!sink.destroyed)sink.destroy(error)};
      sink.once("finish",finish);sink.once("error",failed);sink.once("close",closed);
      if(signal?.aborted){abort();return;}
      sink.end();
    });
    removeSinkHandlers();
    this.metrics.recordFile("download", "ok");
    } catch (error) {
      if(committed && !sinkDestroyPending)failCommittedSink?.(error);
      if(sinkDestroyPending)await waitForSinkTerminal();
      removeSinkHandlers();
      if(this.observations && child && child.exitCode===null){
        try{this.observations.markHold("download-execution-unresolved",id);}catch{}
        try{child.kill("SIGKILL");}catch{}
      }else if(!child && processFile)fs.rmSync(processFile,{force:true});
      const result =
        error instanceof ServiceError && error.status === 404 ? "not_found" : "error";
      this.metrics.recordFile("download", result);
      throw error;
    }
  }

  /* ------------------------------------------------------------------ pty */

  async openPty(
    id: string,
    opts: { argv: string[]; cols: number; rows: number; cwd?: string; env?: Record<string, string> },
  ): Promise<PtySession> {
    const ticket=this.beginShadowWork(id);
    const work=()=>this.openPtyInner(id,opts,ticket.signal).finally(ticket.finish);
    return this.observations?this.serialize(id,work):work();
  }

  private async openPtyInner(id:string,opts:{argv:string[];cols:number;rows:number;cwd?:string;env?:Record<string,string>},signal?:AbortSignal):Promise<PtySession>{
    if(signal?.aborted)throw new Error("PTY open cancelled before dispatch");
    const row = await this.ensureHot(id);
    if(signal?.aborted)throw new Error("PTY open cancelled before spawn");
    const processFile = this.runtime.processFile(path.join(this.dir(id), "exec"), {
      argv: opts.argv,
      cwd: opts.cwd ?? row.workdir,
      env: this.processEnv(id, opts.env),
    });
    const { file, args } = this.runtime.execArgs(id, processFile);
    this.store.touch(id);
    const session = this.ptys.open(id, { file, args, cols: opts.cols, rows: opts.rows });
    // The spec file carries the sandbox environment, so it must not outlive the exec that
    // reads it. crun consumes it during startup; the delay only has to outlast that.
    const drop = (): void => fs.rmSync(processFile, { force: true });
    setTimeout(drop, 5_000).unref();
    session.onceExited(drop);
    this.metrics.recordPty("open");
    return session;
  }

  /**
   * A PTY's own traffic is activity. Without this a sandbox with an attached terminal
   * freezes after the warm window and the next keystroke lands on a frozen process, which
   * looks exactly like a hung session.
   */
  notePtyActivity(sandboxId: string): void {
    if(this.observations?.held())return;
    const row = this.store.get(sandboxId);
    if (!row) return;
    if (row.tier === "warm") void this.thaw(sandboxId);
    this.store.touch(sandboxId);
  }

  async attachPty(sessionId: string): Promise<PtySession | null> {
    const initial=this.ptys.get(sessionId);if(!initial)return null;
    const ticket=this.beginShadowWork(initial.sandboxId);
    const work=async()=>{try{
      if(ticket.signal?.aborted)throw new Error("PTY attach cancelled before dispatch");
      const session=this.ptys.get(sessionId);if(!session)return null;
      await this.ensureHot(session.sandboxId);
      if(ticket.signal?.aborted)throw new Error("PTY attach cancelled before completion");
      this.store.touch(session.sandboxId);this.metrics.recordPty("attach");return session;
    }finally{ticket.finish()}};
    return this.observations?this.serialize(initial.sandboxId,work):work();
  }

  /* ---------------------------------------------------------------- misc */

  get storeRef(): Store {
    return this.store;
  }

  bootingCount(): number {
    return this.booting.size;
  }

  get imagesRef(): ImageStore {
    return this.images;
  }

  cgroupOf(id: string): Cgroup {
    return this.cgroup(id);
  }

  /**
   * Disk commitments and headroom as admission control sees them: full quotas of local
   * workspaces plus in-flight and quarantined reservations.
   */
  diskCapacity(): { committedBytes: number; capacityBytes: number } {
    const disk = this.admission.capacity(this.store.all()).disk;
    return {
      committedBytes: disk.committedBytes + disk.inFlightBytes + disk.quarantinedBytes,
      capacityBytes: disk.capacityBytes,
    };
  }

  /** What admission just compared, so reported capacity cannot drift from it. */
  guaranteesCommitted(): { cpu: number; memoryBytes: number } {
    const totals = this.admission.capacity(this.store.all());
    return {
      cpu: totals.cpu.committedFloorCores,
      memoryBytes: totals.memory.committedBytes + totals.memory.inFlightBytes + totals.memory.quarantinedBytes,
    };
  }

  /** The budgets admission compares against (legacy health field). */
  admissionBudget(): { cpu: number; memoryBytes: number } {
    const totals = this.admission.capacity(this.store.all());
    return { cpu: totals.cpu.budgetCores, memoryBytes: totals.memory.budgetBytes };
  }

  /** One store.all() + disk walk for a scrape. Host PSI/memory are filled by the binder. */
  metricsSnapshot(): Omit<
    MetricsSnapshot,
    "hostPressure" | "hostMemoryAvailableBytes" | "hostMemoryTotalBytes"
  > {
    const rows = this.store.all();
    const sandboxesByTier = { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0 };
    for (const row of rows) sandboxesByTier[row.tier] += 1;
    const totals = this.admission.capacity(rows);
    return {
      sandboxesByTier,
      booting: this.booting.size,
      committed: {
        cpu: totals.cpu.committedFloorCores,
        memoryBytes: totals.memory.committedBytes + totals.memory.inFlightBytes + totals.memory.quarantinedBytes,
      },
      disk: {
        committedBytes: totals.disk.committedBytes + totals.disk.inFlightBytes + totals.disk.quarantinedBytes,
        capacityBytes: totals.disk.capacityBytes,
      },
      ptysActive: this.ptys.aliveCount(),
      capacity: {
        memoryBudgetBytes: totals.memory.budgetBytes,
        memoryAvailableBytes: totals.memory.availableBytes,
        memoryDebtBytes: totals.memory.debtBytes,
        memoryQuarantinedBytes: totals.memory.quarantinedBytes,
        diskAvailableBytes: totals.disk.availableBytes,
        diskQuarantinedBytes: totals.disk.quarantinedBytes,
        transitionsInFlight: totals.transitions.inFlight,
        archivesInFlight: this.archiving.size,
        quarantinedOperations: totals.transitions.quarantinedOperations,
        usageOutboxRows: this.safeUsageRows(),
      },
    };
  }

  private safeUsageRows(): number {
    try {
      return this.usage.stats().rows;
    } catch {
      return 0;
    }
  }

  async gcLayers(): Promise<string[]> {
    return await this.images.gc(this.store.pinnedLayers());
  }
}

/** Host facts for the default admission probe; exported for the API's health route. */
export function hostFacts(): { cpus: number; totalmem: number; freemem: number } {
  return { cpus: os.cpus().length, totalmem: os.totalmem(), freemem: os.freemem() };
}
