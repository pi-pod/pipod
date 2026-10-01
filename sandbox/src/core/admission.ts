/**
 * AdmissionController (plan §6.1–6.2): the one host-local authority for memory/CPU/disk
 * admission, backed by an additive SQLite journal in the same file as the sandbox rows.
 *
 * A reservation states the sandbox's *desired totals* once its transition completes, and
 * only the delta above the row's current commitment is charged while the transition is
 * in flight. Decision and journal write happen in one short SQLite transaction with no
 * I/O inside it besides SQLite: `disks.probe`, `hasImage`, spool reads and host facts
 * are all gathered first, then the transaction re-checks nothing external.
 *
 * Reservations are durable rows, so a crash between phases is reconciled at startup by
 * {@link AdmissionController.recover} instead of leaking or freeing live resources.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { SandboxRow } from "../db/index.js";
import { badRequest, capacityDenied, conflict, notFound } from "../errors.js";
import type { CapacityCpu, CapacityDisk, CapacityMemory } from "../wire.js";

export type ReservationKind = "create" | "start" | "restore" | "resize" | "import";
export type ReservationStatus = "reserved" | "committed" | "released" | "quarantined";

export interface ReservationRow {
  operationId: string;
  sandboxId: string;
  kind: ReservationKind;
  /** Desired totals for this sandbox once the transition completes (not deltas). */
  desiredMemoryBytes: number;
  desiredDiskBytes: number;
  desiredCpuFloor: number;
  status: ReservationStatus;
  /** Free-form phase label for the journal (`reserved`, `image`, `disk`, `launch`, ...). */
  phase: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  runtimeGeneration: number;
  /** Boot that wrote the row; a row from an earlier boot is a recovery candidate. */
  bootId: string;
}

export interface ReserveRequest {
  operationId: string;
  sandboxId: string;
  kind: ReservationKind;
  desiredMemoryBytes: number;
  desiredDiskBytes: number;
  desiredCpuFloor: number;
}

export interface CapacityTotals {
  memory: CapacityMemory;
  disk: CapacityDisk;
  cpu: CapacityCpu;
  transitions: { inFlight: number; pendingOperations: number; quarantinedOperations: number };
}

/** What the controller needs from the disk layer; `SandboxDisks` satisfies it. */
export interface DiskProbe {
  probe(ids: Iterable<string>): { capacityBytes: number; allocatedBytes: number; allocatedById?: Map<string, number> };
  hasImage(id: string): boolean;
}

/** Host facts, injectable for tests. */
export interface HostProbe {
  totalmem(): number;
  freemem(): number;
  cpus(): number;
  loadavg1(): number;
  cpuPressureAvg10(): number;
}

export type RuntimeProbeResult = "live" | "gone" | "unknown";
export type RuntimeProbe = (reservation: ReservationRow, row: SandboxRow | null) => Promise<RuntimeProbeResult>;

export interface RecoverySummary {
  committed: string[];
  released: string[];
  quarantined: string[];
}

export interface AdmissionOptions {
  bootId: string;
  now?: () => number;
  host?: HostProbe;
  /** Spool directory whose file sizes are reported as scratch use. */
  spoolDir?: string;
}

const GB = 1024 ** 3;

/** Transition kinds that hold a launch slot while in flight; resize/import never do. */
const TRANSITION_KINDS: ReadonlySet<string> = new Set(["create", "start", "restore"]);

interface RawReservation {
  operation_id: string;
  sandbox_id: string;
  kind: string;
  desired_memory_bytes: number;
  desired_disk_bytes: number;
  desired_cpu_floor: number;
  status: string;
  phase: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
  runtime_generation: number;
  boot_id: string;
}

const JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS admission_reservations (
  operation_id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  desired_memory_bytes INTEGER NOT NULL,
  desired_disk_bytes INTEGER NOT NULL,
  desired_cpu_floor REAL NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  runtime_generation INTEGER NOT NULL DEFAULT 0,
  boot_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admission_reservations_sandbox ON admission_reservations(sandbox_id, status);
CREATE INDEX IF NOT EXISTS admission_reservations_status ON admission_reservations(status);
`;

/** PSI `cpu.pressure` "some" line, `avg10=` field; -1 when the file is unreadable. */
function readCpuPressureAvg10(): number {
  try {
    const text = fs.readFileSync("/sys/fs/cgroup/cpu.pressure", "utf8");
    for (const line of text.split("\n")) {
      if (line.startsWith("some")) {
        const match = /avg10=([0-9.]+)/.exec(line);
        if (match) return Number(match[1]);
      }
    }
  } catch {
    // No cgroup v2 pressure file (dev macOS, containers without PSI): report unknown.
  }
  return -1;
}

function defaultHostProbe(): HostProbe {
  return {
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    cpus: () => os.cpus().length,
    loadavg1: () => os.loadavg()[0] ?? 0,
    cpuPressureAvg10: () => readCpuPressureAvg10(),
  };
}

/**
 * Everything `capacity()` reports that is not read inside the reserve transaction.
 * Gathered before the transaction starts so the decision itself does no I/O but SQLite.
 */
interface Snapshot {
  rowsById: Map<string, SandboxRow>;
  reserved: ReservationRow[];
  quarantined: ReservationRow[];
  archivedImageIds: Set<string>;
  memoryBudget: number;
  cpuBudget: number;
  hostTotal: number;
  hostFree: number;
  hostCpus: number;
  loadAvg1: number;
  pressureAvg10: number;
  diskCapacity: number;
  diskAllocated: number;
  diskById: Map<string, number>;
  scratchUsed: number;
}

export class AdmissionController {
  private readonly db: Database.Database;
  private readonly cfg: Config;
  private readonly disks: DiskProbe;
  private readonly opts: AdmissionOptions;
  private readonly host: HostProbe;

  constructor(
    db: Database.Database,
    cfg: Config,
    disks: DiskProbe,
    opts: AdmissionOptions,
  ) {
    this.db = db;
    this.cfg = cfg;
    this.disks = disks;
    this.opts = opts;
    this.host = opts.host ?? defaultHostProbe();
    // Additive journal beside the sandbox rows, so reservation and row commit atomically.
    this.db.exec(JOURNAL_SCHEMA);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private hydrate(raw: RawReservation): ReservationRow {
    return {
      operationId: raw.operation_id,
      sandboxId: raw.sandbox_id,
      kind: raw.kind as ReservationKind,
      desiredMemoryBytes: raw.desired_memory_bytes,
      desiredDiskBytes: raw.desired_disk_bytes,
      desiredCpuFloor: raw.desired_cpu_floor,
      status: raw.status as ReservationStatus,
      phase: raw.phase,
      reason: raw.reason,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      runtimeGeneration: raw.runtime_generation,
      bootId: raw.boot_id,
    };
  }

  /** Policy: what a row in its current tier commits, in bytes. */
  rowMemoryCommitment(row: SandboxRow): number {
    // Only live sandboxes pin host memory; stopped/archived/error rows hold disk only.
    if (row.tier !== "hot" && row.tier !== "warm") return 0;
    if (this.cfg.admission.memoryMode === "ceiling") {
      // Ceiling mode reserves each live sandbox's full hard cap: ceilings may not overcommit.
      return (row.ceiling.memoryGB ?? this.cfg.maximums.memoryGB) * GB;
    }
    return (row.resources.memoryGB ?? 0) * GB;
  }

  rowDiskCommitment(row: SandboxRow, allocations = new Map<string, number>()): number {
    // Archived rows hold no local quota — unless their image leaked (see quarantine below).
    if (row.tier === "archived") return 0;
    if (this.cfg.admission.diskMode === "sparse") {
      return Math.max(this.cfg.admission.sparseMinDiskBytes, allocations.get(row.id) ?? 0);
    }
    return (row.ceiling.diskGB ?? row.resources.diskGB ?? 0) * GB;
  }

  private desiredDiskCharge(bytes: number, id: string, snap: Snapshot): number {
    return this.cfg.admission.diskMode === "sparse" && bytes > 0
      ? Math.max(this.cfg.admission.sparseMinDiskBytes, snap.diskById.get(id) ?? 0)
      : bytes;
  }

  /** CPU floors are shares, not dedicated cores; only live sandboxes hold a floor. */
  private rowCpuFloor(row: SandboxRow): number {
    if (row.tier !== "hot" && row.tier !== "warm") return 0;
    return row.resources.cpu ?? 0;
  }

  memoryBudgetBytes(): number {
    // An explicit budget is the validated safe threshold for the host class; otherwise the
    // host keeps its reserve and the fleet cap binds only when it is tighter. The kernel
    // tenant aggregate cap binds tighter still: on a single-tenant boat host the budget and
    // the tenant cap describe the same bytes, so admitting past the cap would only let the
    // kernel OOM-kill what admission just promised. (Multi-tenant static hosts should leave
    // the tenant cap unset and size with the fleet cap instead.)
    let budget: number;
    if (this.cfg.admission.memoryBudgetBytes !== null) {
      budget = this.cfg.admission.memoryBudgetBytes;
    } else {
      const hostHeadroom = this.host.totalmem() - this.cfg.reserveMemoryBytes;
      const fleetCap = this.cfg.fleet.memoryBytes ?? Number.POSITIVE_INFINITY;
      budget = Math.max(0, Math.min(hostHeadroom, fleetCap));
    }
    if (this.cfg.tenancy.tenantMemoryMaxBytes !== null) {
      budget = Math.min(budget, this.cfg.tenancy.tenantMemoryMaxBytes);
    }
    return Math.max(0, budget);
  }

  private cpuBudgetCores(): number {
    return Math.max(0, Math.min(this.host.cpus() - this.cfg.reserveCpu, this.cfg.fleet.cpu ?? Infinity));
  }

  private readJournal(statuses: ReservationStatus[]): ReservationRow[] {
    const placeholders = statuses.map(() => "?").join(", ");
    const raws = this.db
      .prepare(`SELECT * FROM admission_reservations WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses) as RawReservation[];
    return raws.map((r) => this.hydrate(r));
  }

  /** Sum of regular-file sizes directly inside the spool dir; 0 when unset/missing. */
  private readScratchUsed(): number {
    const dir = this.opts.spoolDir;
    if (!dir) return 0;
    try {
      let total = 0;
      for (const entry of fs.readdirSync(dir)) {
        try {
          const stat = fs.statSync(`${dir}/${entry}`);
          if (stat.isFile()) total += stat.size;
        } catch {
          // A file vanishing mid-list is not an admission event; skip it.
        }
      }
      return total;
    } catch {
      // Missing or unreadable spool dir reports zero use rather than refusing admission.
      return 0;
    }
  }

  /**
   * Gather every external fact (host, disk probe, spool, image presence) up front.
   * The reserve transaction then re-derives charges from fresh SQLite reads plus this
   * snapshot, so nothing but SQLite is touched while the decision is being written.
   */
  private snapshot(rows: SandboxRow[]): Snapshot {
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const charged = this.readJournal(["reserved", "quarantined"]);
    const reserved = charged.filter((r) => r.status === "reserved");
    const quarantined = charged.filter((r) => r.status === "quarantined");

    // Archived rows should hold no local state; one that still has an image leaked it,
    // and its quota stays charged as disk quarantine until an operator resolves it.
    const archivedImageIds = new Set<string>();
    for (const row of rows) {
      if (row.tier === "archived") {
        try {
          if (this.disks.hasImage(row.id)) archivedImageIds.add(row.id);
        } catch {
          // An unreadable image check must not refuse admission; treat as no image.
        }
      }
    }

    // The probe prices blocks already allocated by sparse images as paid for, so ids must
    // cover every row that could hold local state plus every sandbox with a live journal
    // entry (whose desired totals may already exist on disk).
    const probeIds = new Set<string>();
    for (const row of rows) {
      if (row.tier !== "archived" || archivedImageIds.has(row.id)) probeIds.add(row.id);
    }
    for (const r of charged) probeIds.add(r.sandboxId);
    const { capacityBytes, allocatedBytes, allocatedById } = this.disks.probe(probeIds);
    if (this.cfg.admission.diskMode === "sparse") {
      if (!allocatedById) throw new Error("sparse disk admission requires per-image allocated block measurements");
      // Pre-quota archived rows can leak only upper/, with no ext4 image to detect.
      for (const row of rows) {
        if (row.tier === "archived" && (allocatedById.get(row.id) ?? 0) > 0) archivedImageIds.add(row.id);
      }
    }

    return {
      rowsById,
      reserved,
      quarantined,
      archivedImageIds,
      memoryBudget: this.memoryBudgetBytes(),
      cpuBudget: this.cpuBudgetCores(),
      hostTotal: this.host.totalmem(),
      hostFree: this.host.freemem(),
      hostCpus: this.host.cpus(),
      loadAvg1: this.host.loadavg1(),
      pressureAvg10: this.host.cpuPressureAvg10(),
      diskCapacity: this.cfg.admission.diskMode === "sparse"
        ? Math.min(capacityBytes, this.cfg.admission.storageQuotaBytes!) : capacityBytes,
      diskAllocated: allocatedBytes,
      diskById: allocatedById ?? new Map(),
      scratchUsed: this.readScratchUsed(),
    };
  }

  /**
   * Pure charge derivation shared by `capacity()` and the reserve transaction: each
   * reservation states desired *totals*, so its charge is the delta above the row's
   * current commitment (missing row → 0). Every sandbox is counted exactly once — a
   * booting create's row is stopped, so its reservation carries the whole ceiling,
   * while a resize's row is hot, so only the increase is charged.
   */
  private charges(snap: Snapshot): {
    memCommitted: number;
    memInFlight: number;
    memQuarantined: number;
    diskCommitted: number;
    diskInFlight: number;
    diskQuarantined: number;
    cpuFloorCommitted: number;
    cpuReservedDelta: number;
    ceilingCoresSum: number;
    inFlightTransitions: number;
  } {
    let memCommitted = 0;
    let diskCommitted = 0;
    let cpuFloorCommitted = 0;
    let ceilingCoresSum = 0;
    for (const row of snap.rowsById.values()) {
      memCommitted += this.rowMemoryCommitment(row);
      diskCommitted += this.rowDiskCommitment(row, snap.diskById);
      cpuFloorCommitted += this.rowCpuFloor(row);
      if (row.tier === "hot" || row.tier === "warm") {
        ceilingCoresSum += row.ceiling.cpu ?? this.cfg.maximums.cpu;
      }
    }

    // Leaked archived images are disk quarantine, not steady-state commitment.
    let diskQuarantined = 0;
    for (const id of snap.archivedImageIds) {
      const row = snap.rowsById.get(id);
      if (row) diskQuarantined += this.cfg.admission.diskMode === "sparse"
        ? Math.max(this.cfg.admission.sparseMinDiskBytes, snap.diskById.get(id) ?? 0)
        : (row.ceiling.diskGB ?? row.resources.diskGB ?? 0) * GB;
    }
    if (this.cfg.admission.diskMode === "sparse") {
      const journalIds = new Set([...snap.reserved, ...snap.quarantined].map((r) => r.sandboxId));
      for (const [id, bytes] of snap.diskById) {
        if (!snap.rowsById.has(id) && !journalIds.has(id)) diskQuarantined += bytes;
      }
    }

    const delta = (r: ReservationRow): { mem: number; disk: number; cpu: number } => {
      const row = snap.rowsById.get(r.sandboxId);
      const memBase = row ? this.rowMemoryCommitment(row) : 0;
      const diskBase = row ? this.rowDiskCommitment(row, snap.diskById) : 0;
      const cpuBase = row ? this.rowCpuFloor(row) : 0;
      return {
        mem: Math.max(0, r.desiredMemoryBytes - memBase),
        disk: this.cfg.admission.diskMode === "sparse" && snap.archivedImageIds.has(r.sandboxId)
          ? 0 : Math.max(0, this.desiredDiskCharge(r.desiredDiskBytes, r.sandboxId, snap) - diskBase),
        cpu: Math.max(0, r.desiredCpuFloor - cpuBase),
      };
    };

    let memInFlight = 0;
    let diskInFlight = 0;
    let cpuReservedDelta = 0;
    for (const r of snap.reserved) {
      const d = delta(r);
      memInFlight += d.mem;
      diskInFlight += d.disk;
      cpuReservedDelta += d.cpu;
    }
    let memQuarantined = 0;
    for (const r of snap.quarantined) {
      const d = delta(r);
      memQuarantined += d.mem;
      // Quarantined reservations stay charged until resolved; their disk joins the
      // archived-image quarantine rather than the steady-state commitment.
      diskQuarantined += d.disk;
    }

    let inFlightTransitions = 0;
    for (const r of snap.reserved) {
      if (TRANSITION_KINDS.has(r.kind)) inFlightTransitions += 1;
    }

    return {
      memCommitted,
      memInFlight,
      memQuarantined,
      diskCommitted,
      diskInFlight,
      diskQuarantined,
      cpuFloorCommitted,
      cpuReservedDelta,
      ceilingCoresSum,
      inFlightTransitions,
    };
  }

  capacity(rows: SandboxRow[]): CapacityTotals {
    const snap = this.snapshot(rows);
    const c = this.charges(snap);
    const debtBytes = Math.max(0, c.memCommitted - snap.memoryBudget);
    const memory: CapacityMemory = {
      budgetBytes: snap.memoryBudget,
      committedBytes: c.memCommitted,
      inFlightBytes: c.memInFlight,
      quarantinedBytes: c.memQuarantined,
      debtBytes,
      availableBytes: Math.max(0, snap.memoryBudget - c.memCommitted - c.memInFlight - c.memQuarantined),
      hostTotalBytes: snap.hostTotal,
      hostAvailableBytes: snap.hostFree,
    };
    const disk: CapacityDisk = {
      capacityBytes: snap.diskCapacity,
      committedBytes: c.diskCommitted,
      inFlightBytes: c.diskInFlight,
      quarantinedBytes: c.diskQuarantined,
      allocatedBytes: snap.diskAllocated,
      scratchBudgetBytes: this.cfg.admission.scratchBudgetBytes,
      scratchUsedBytes: snap.scratchUsed,
      availableBytes: Math.max(0, snap.diskCapacity - c.diskCommitted - c.diskInFlight - c.diskQuarantined),
    };
    const cpu: CapacityCpu = {
      hostCpus: snap.hostCpus,
      budgetCores: snap.cpuBudget,
      committedFloorCores: c.cpuFloorCommitted + c.cpuReservedDelta,
      ceilingCoresSum: c.ceilingCoresSum,
      sharing: "weighted-shares",
      loadAvg1: snap.loadAvg1,
      pressureAvg10: snap.pressureAvg10,
    };
    return {
      memory,
      disk,
      cpu,
      transitions: {
        inFlight: c.inFlightTransitions,
        pendingOperations: snap.reserved.length,
        quarantinedOperations: snap.quarantined.length,
      },
    };
  }

  private validateRequest(req: ReserveRequest): void {
    // Refusals must carry numbers, so non-numeric desires are a client bug, not a denial.
    for (const [name, value] of [
      ["desiredMemoryBytes", req.desiredMemoryBytes],
      ["desiredDiskBytes", req.desiredDiskBytes],
      ["desiredCpuFloor", req.desiredCpuFloor],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw badRequest(`reserve: ${name} must be a finite non-negative number`);
      }
    }
  }

  /** Decide and persist in one short SQLite transaction; throws a typed ServiceError on refusal. */
  reserve(req: ReserveRequest, rows: SandboxRow[]): ReservationRow {
    this.validateRequest(req);
    // All external I/O happens here, before the transaction starts.
    const snap = this.snapshot(rows);

    const tx = this.db.transaction((): ReservationRow => {
      // Fresh journal reads inside the transaction: the decision and the write are atomic.
      const charged = this.readJournal(["reserved", "quarantined"]);
      const reserved = charged.filter((r) => r.status === "reserved");
      const quarantined = charged.filter((r) => r.status === "quarantined");
      const live: Snapshot = { ...snap, reserved, quarantined };
      const c = this.charges(live);

      // 1. One transition per sandbox: a second reservation would double-charge the delta.
      if (reserved.some((r) => r.sandboxId === req.sandboxId)) {
        throw conflict(
          `sandbox ${req.sandboxId} already has a transition in flight`,
          "wait for it to finish",
        );
      }

      // 2. Launch slots bound concurrent boots/restores, not resizes or imports.
      if (
        TRANSITION_KINDS.has(req.kind) &&
        c.inFlightTransitions >= this.cfg.admission.maxConcurrentTransitions
      ) {
        throw capacityDenied(
          {
            reason: "transition_capacity",
            resource: "transitions",
            unit: "count",
            required: 1,
            available: 0,
            budget: this.cfg.admission.maxConcurrentTransitions,
            committed: c.inFlightTransitions,
            retryable: true,
            retryAfterMs: 5000,
          },
        );
      }

      const row = live.rowsById.get(req.sandboxId);

      // 3. Memory: debt blocks every increase (the totals still report the live rows —
      // nothing is killed to clear it), otherwise the delta must fit the headroom.
      // Exact fit is admitted.
      const deltaMem = Math.max(0, req.desiredMemoryBytes - (row ? this.rowMemoryCommitment(row) : 0));
      const debtBytes = Math.max(0, c.memCommitted - live.memoryBudget);
      const memAvailable = Math.max(
        0,
        live.memoryBudget - c.memCommitted - c.memInFlight - c.memQuarantined,
      );
      if (deltaMem > 0 && debtBytes > 0) {
        throw capacityDenied(
          {
            reason: "memory_debt",
            resource: "memory",
            unit: "bytes",
            required: deltaMem,
            available: 0,
            budget: live.memoryBudget,
            committed: c.memCommitted,
            retryable: true,
            retryAfterMs: 30000,
          },
        );
      } else if (deltaMem > memAvailable) {
        throw capacityDenied(
          {
            reason: "memory_capacity",
            resource: "memory",
            unit: "bytes",
            required: deltaMem,
            available: memAvailable,
            budget: live.memoryBudget,
            committed: c.memCommitted + c.memInFlight + c.memQuarantined,
            retryable: true,
            ...(reserved.length > 0 ? { retryAfterMs: 15000 } : {}),
          },
        );
      }

      // 4. CPU floors are shares: the sum of floors must stay within the host budget.
      const deltaCpu = Math.max(0, req.desiredCpuFloor - (row ? this.rowCpuFloor(row) : 0));
      const cpuCommitted = c.cpuFloorCommitted + c.cpuReservedDelta;
      if (cpuCommitted + deltaCpu > live.cpuBudget) {
        throw capacityDenied(
          {
            reason: "cpu_capacity",
            resource: "cpu",
            unit: "cores",
            required: deltaCpu,
            available: Math.max(0, live.cpuBudget - cpuCommitted),
            budget: live.cpuBudget,
            committed: cpuCommitted,
            retryable: true,
          },
        );
      }

      // 5. Disk: same delta-above-commitment shape as memory; exact fit is admitted.
      const deltaDisk = Math.max(0, this.desiredDiskCharge(req.desiredDiskBytes, req.sandboxId, live) - (row ? this.rowDiskCommitment(row, live.diskById) : 0));
      const diskAvailable = Math.max(
        0,
        live.diskCapacity - c.diskCommitted - c.diskInFlight - c.diskQuarantined,
      );
      if (deltaDisk > diskAvailable || (this.cfg.admission.diskMode === "sparse" && c.diskCommitted + c.diskInFlight + c.diskQuarantined >= live.diskCapacity)) {
        throw capacityDenied(
          {
            reason: "disk_capacity",
            resource: "disk",
            unit: "bytes",
            required: deltaDisk,
            available: diskAvailable,
            budget: live.diskCapacity,
            committed: c.diskCommitted + c.diskInFlight + c.diskQuarantined,
            retryable: true,
            ...(reserved.length > 0 ? { retryAfterMs: 15000 } : {}),
          },
          "archive or delete a sandbox, lower the requested disk quota, or add state-volume capacity",
        );
      }

      // 6. Admitted: the reservation now carries the charge until commit/release.
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO admission_reservations
             (operation_id, sandbox_id, kind, desired_memory_bytes, desired_disk_bytes,
              desired_cpu_floor, status, phase, reason, created_at, updated_at,
              runtime_generation, boot_id)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', 'reserved', NULL, ?, ?, 0, ?)`,
        )
        .run(
          req.operationId,
          req.sandboxId,
          req.kind,
          req.desiredMemoryBytes,
          req.desiredDiskBytes,
          req.desiredCpuFloor,
          at,
          at,
          this.opts.bootId,
        );
      const created = this.db
        .prepare("SELECT * FROM admission_reservations WHERE operation_id = ?")
        .get(req.operationId) as RawReservation;
      return this.hydrate(created);
    });
    return tx();
  }

  setPhase(operationId: string, phase: string): void {
    const result = this.db
      .prepare("UPDATE admission_reservations SET phase = ? WHERE operation_id = ?")
      .run(phase, operationId);
    if (result.changes === 0) throw notFound(`reservation ${operationId} not found`);
  }

  /** The row's tier now carries the commitment; the reservation stops being charged. */
  commit(operationId: string): void {
    const result = this.db
      .prepare("UPDATE admission_reservations SET status = 'committed', updated_at = ? WHERE operation_id = ?")
      .run(this.now(), operationId);
    if (result.changes === 0) throw notFound(`reservation ${operationId} not found`);
  }

  /** Only after the corresponding runtime/filesystem cleanup is confirmed. */
  release(operationId: string): void {
    const result = this.db
      .prepare("UPDATE admission_reservations SET status = 'released', updated_at = ? WHERE operation_id = ?")
      .run(this.now(), operationId);
    if (result.changes === 0) throw notFound(`reservation ${operationId} not found`);
  }

  /** Charged until an operator or recovery resolves it; never a silent deletion. */
  quarantine(operationId: string, reason: string): void {
    const result = this.db
      .prepare("UPDATE admission_reservations SET status = 'quarantined', reason = ?, updated_at = ? WHERE operation_id = ?")
      .run(reason, this.now(), operationId);
    if (result.changes === 0) throw notFound(`reservation ${operationId} not found`);
  }

  get(operationId: string): ReservationRow | null {
    const raw = this.db
      .prepare("SELECT * FROM admission_reservations WHERE operation_id = ?")
      .get(operationId) as RawReservation | undefined;
    return raw ? this.hydrate(raw) : null;
  }

  /** `reserved` and `quarantined` rows — everything still charged. */
  active(): ReservationRow[] {
    return this.readJournal(["reserved", "quarantined"]);
  }

  activeFor(sandboxId: string): ReservationRow[] {
    const raws = this.db
      .prepare(
        "SELECT * FROM admission_reservations WHERE sandbox_id = ? AND status IN ('reserved', 'quarantined') ORDER BY created_at ASC",
      )
      .all(sandboxId) as RawReservation[];
    return raws.map((r) => this.hydrate(r));
  }

  /** Startup: resolve reservations left by earlier boots via the probe; uncertain → quarantine. */
  async recover(probe: RuntimeProbe, rows: SandboxRow[]): Promise<RecoverySummary> {
    const summary: RecoverySummary = { committed: [], released: [], quarantined: [] };
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    // Current-boot reservations have an owner still running; only earlier boots are orphans.
    // Age alone never resolves a row: an old but live reservation must survive recover.
    const orphans = this.readJournal(["reserved"]).filter((r) => r.bootId !== this.opts.bootId);
    for (const reservation of orphans) {
      let verdict: RuntimeProbeResult;
      try {
        verdict = await probe(reservation, rowsById.get(reservation.sandboxId) ?? null);
      } catch {
        // A failing probe is "unknown", not "gone": releasing on a probe error could free
        // resources a live sandbox still holds.
        verdict = "unknown";
      }
      if (verdict === "live") {
        // The sandbox row already carries the commitment after the manager's reconcile.
        this.commit(reservation.operationId);
        summary.committed.push(reservation.operationId);
      } else if (verdict === "gone") {
        this.release(reservation.operationId);
        summary.released.push(reservation.operationId);
      } else {
        this.quarantine(reservation.operationId, "unresolved after restart");
        summary.quarantined.push(reservation.operationId);
      }
    }
    return summary;
  }

  /** Drop terminal (committed/released) journal rows older than the given age. */
  purgeJournal(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const result = this.db
      .prepare("DELETE FROM admission_reservations WHERE status IN ('committed', 'released') AND updated_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }
}
