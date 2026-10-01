import * as fs from "node:fs";
import * as path from "node:path";

export const CGROUP_ROOT = "/sys/fs/cgroup";
const CONTROLLERS = ["cpu", "memory", "pids"] as const;

export interface CgroupLimits {
  /** Proportional share under contention — the guarantee (§7.1). */
  cpuWeight?: number;
  /** Hard CPU ceiling in cores; `null` leaves it uncapped so idle capacity is shared. */
  cpuMaxCores?: number | null;
  /** memory.low: protected from reclaim. */
  memoryLow?: number;
  /** memory.high: soft throttle. `null` = max. */
  memoryHigh?: number | null;
  /** memory.max: hard OOM ceiling. */
  memoryMax?: number | null;
  pidsMax?: number;
}

export interface CgroupStats {
  cpuUsec: number;
  memoryCurrent: number;
  memoryPeak: number;
  pidsCurrent: number;
  /** PSI avg10, percent of wall time stalled. -1 when the kernel does not expose PSI. */
  memoryPressure: number;
  cpuPressure: number;
}

/** Everything the usage feed reports per sandbox (§8.1); all cumulative counters are per cgroup lifetime. */
export interface ExtendedCgroupStats extends CgroupStats {
  cpuUserUsec: number;
  cpuSystemUsec: number;
  nrPeriods: number;
  nrThrottled: number;
  throttledUsec: number;
  oomEvents: number;
  oomKillEvents: number;
}

export interface LimitMismatch {
  file: string;
  expected: string;
  actual: string | null;
}

/** Equal weight for every tenant parent, regardless of how many sandboxes it holds (§7.2). */
export const TENANT_CPU_WEIGHT = 100;

function readKeyed(file: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const [key, value] = line.trim().split(/\s+/);
      if (key && value !== undefined) out.set(key, Number(value));
    }
  } catch {
    /* controller file absent */
  }
  return out;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function writeFile(file: string, value: string): void {
  fs.writeFileSync(file, value);
}

function tryWrite(file: string, value: string): boolean {
  try {
    fs.writeFileSync(file, value);
    return true;
  } catch {
    return false;
  }
}

function readNumber(file: string, fallback = 0): number {
  try {
    return Number(fs.readFileSync(file, "utf8").trim()) || fallback;
  } catch {
    return fallback;
  }
}

function readPressureAvg10(file: string): number {
  try {
    const some = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith("some"));
    const m = some ? /avg10=([\d.]+)/.exec(some) : null;
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

function enableControllers(dir: string): void {
  const available = fs.readFileSync(path.join(dir, "cgroup.controllers"), "utf8").split(/\s+/);
  const wanted = CONTROLLERS.filter((c) => available.includes(c)).map((c) => `+${c}`);
  if (wanted.length === 0) return;
  // Controllers are enabled one at a time: a single rejected controller in a batched
  // write silently discards the whole line.
  for (const c of wanted) tryWrite(path.join(dir, "cgroup.subtree_control"), c);
}

/** The service's own slice; sandbox cgroups are its children. */
export class CgroupTree {
  readonly scopeDir: string;

  constructor(
    readonly scope = "pps",
    readonly root = CGROUP_ROOT,
  ) {
    this.scopeDir = path.join(root, scope);
  }

  /**
   * `limits` bound the whole sandbox subtree. Sandbox cgroups are created at the host cgroup
   * root rather than under the service's own container, so nothing else — not a container
   * memory limit on the service, not admission control on guarantees — can bound what the
   * fleet consumes together.
   */
  ensure(limits: { memoryBytes?: number | null; cpu?: number | null } = {}, strict = false): void {
    enableControllers(this.root);
    fs.mkdirSync(this.scopeDir, { recursive: true });
    enableControllers(this.scopeDir);
    if (limits.memoryBytes) {
      tryWrite(path.join(this.scopeDir, "memory.high"), String(Math.round(limits.memoryBytes)));
      tryWrite(path.join(this.scopeDir, "memory.max"), String(Math.round(limits.memoryBytes * (strict ? 1 : 1.1))));
    }
    if (limits.cpu) {
      tryWrite(path.join(this.scopeDir, "cpu.max"), `${Math.round(limits.cpu * 100_000)} 100000`);
    }
    if(strict){
      const mem=limits.memoryBytes===null||limits.memoryBytes===undefined?null:String(Math.round(limits.memoryBytes));
      const cpu=limits.cpu===null||limits.cpu===undefined?null:String(Math.round(limits.cpu*100_000));
      if(!mem || !cpu || readText(path.join(this.scopeDir,"memory.high"))!==mem ||
        !tryWrite(path.join(this.scopeDir,"memory.max"),mem) ||
        readText(path.join(this.scopeDir,"memory.max"))!==mem ||
        readText(path.join(this.scopeDir,"cpu.max"))?.split(/\s+/)[0]!==cpu)
        throw new Error("small VM aggregate cgroup limits not verified");
    }
  }

  /** Legacy flat placement: `pps/<id>`. */
  sandbox(id: string): Cgroup {
    return new Cgroup(path.join(this.scopeDir, id), `/${this.scope}/${id}`);
  }

  /** A cgroup from the path recorded in the row, so teardown finds a nested sandbox after restart. */
  at(rel: string): Cgroup {
    const clean = rel.replace(/^\/+/, "");
    return new Cgroup(path.join(this.root, clean), `/${clean}`);
  }

  /** `pps/tenant-<key>`: the user's equal-weight parent (§7.2). */
  tenant(userKey: string): TenantCgroup {
    const name = `tenant-${userKey}`;
    return new TenantCgroup(path.join(this.scopeDir, name), `/${this.scope}/${name}`, userKey);
  }

  /** Tenant parents currently present, for reconcile and empty-parent cleanup. */
  listTenantKeys(): string[] {
    if (!fs.existsSync(this.scopeDir)) return [];
    return fs
      .readdirSync(this.scopeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("tenant-"))
      .map((d) => d.name.slice("tenant-".length));
  }

  /** Sandbox cgroups left behind by a service crash, for the startup reconcile (§6.4). */
  listSandboxIds(): string[] {
    if (!fs.existsSync(this.scopeDir)) return [];
    return fs
      .readdirSync(this.scopeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  hostPressure(): number {
    return readPressureAvg10(path.join(this.root, "memory.pressure"));
  }
}

/**
 * A tenant's parent cgroup. Children are its sandboxes; the parent's `cpu.weight` is equal
 * across tenants and its `cpu.max` carries the fleet allocator's grant (or the fallback,
 * or the box aggregate CPU cap when unmanaged). Its `memory.high`/`memory.max` carry the
 * tenant aggregate cap: per-sandbox ceilings partition the tenant, the parent bounds the
 * tenant, so a bursting tenant OOM-kills inside its own subtree instead of reclaiming
 * memory out of vendor/system services.
 */
export class TenantCgroup {
  constructor(
    readonly dir: string,
    readonly rel: string,
    readonly userKey: string,
  ) {}

  exists(): boolean {
    return fs.existsSync(this.dir);
  }

  /** Create (idempotent), enable controllers for children, and set the equal weight. */
  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    enableControllers(this.dir);
    tryWrite(path.join(this.dir, "cpu.weight"), String(TENANT_CPU_WEIGHT));
  }

  sandbox(id: string): Cgroup {
    return new Cgroup(path.join(this.dir, id), `${this.rel}/${id}`);
  }

  childIds(): string[] {
    if (!this.exists()) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  /**
   * Aggregate memory cap for the whole tenant subtree. Unlike the fleet scope (which keeps
   * a 10% `memory.max` headroom above `memory.high`), both files are set to the cap: a box
   * host has no spare RAM for headroom — the cap already accounts the vendor/desktop
   * reserve, so anything above it is global-OOM territory. Verified on read-back.
   */
  setMemoryMax(bytes: number | null): boolean {
    if (!this.exists()) return false;
    const value = bytes === null ? "max" : String(Math.round(bytes));
    if (!tryWrite(path.join(this.dir, "memory.high"), value)) return false;
    if (!tryWrite(path.join(this.dir, "memory.max"), value)) return false;
    const actual = readText(path.join(this.dir, "memory.max"));
    return actual !== null && actual.split(/\s+/)[0] === value;
  }

  /** A small VM must not shift sandbox memory pressure into host swap. */
  setSwapMaxZero(): boolean {
    if (!this.exists()) return false;
    return tryWrite(path.join(this.dir,"memory.swap.max"),"0") &&
      readText(path.join(this.dir,"memory.swap.max"))==="0";
  }

  currentMemoryMax(): number | null {
    const raw = readText(path.join(this.dir, "memory.max"));
    if (!raw) return null;
    const first = raw.split(/\s+/)[0];
    if (!first || first === "max") return null;
    return Number(first);
  }

  /** Resident bytes charged to this tenant subtree plus its hard cap, for pressure shedding. */
  memoryUsage(): { current: number; max: number | null; pressure: number } | null {
    if (!this.exists()) return null;
    return {
      current: readNumber(path.join(this.dir, "memory.current")),
      max: this.currentMemoryMax(),
      pressure: readPressureAvg10(path.join(this.dir, "memory.pressure")),
    };
  }

  /** `null` removes the cap: equal weights and per-sandbox ceilings remain in force. */
  setCpuMax(cores: number | null): boolean {
    if (!this.exists()) return false;
    const value = cores === null ? "max 100000" : `${Math.max(1000, Math.round(cores * 100_000))} 100000`;
    if (!tryWrite(path.join(this.dir, "cpu.max"), value)) return false;
    const actual = readText(path.join(this.dir, "cpu.max"));
    return actual !== null && actual.split(/\s+/)[0] === value.split(/\s+/)[0];
  }

  currentCpuMax(): number | null {
    const raw = readText(path.join(this.dir, "cpu.max"));
    if (!raw) return null;
    const [quota, period] = raw.split(/\s+/);
    if (!quota || quota === "max") return null;
    return Number(quota) / Number(period ?? 100_000);
  }

  /** Only an empty parent is removed; a populated one means a sandbox still runs under it. */
  removeIfEmpty(): boolean {
    if (!this.exists()) return true;
    if (this.childIds().length > 0) return false;
    try {
      fs.rmdirSync(this.dir);
      return true;
    } catch {
      return false;
    }
  }
}

export class Cgroup {
  constructor(
    readonly dir: string,
    /** Path relative to the cgroup root, which is what crun's `cgroupsPath` wants. */
    readonly rel: string,
  ) {}

  exists(): boolean {
    return fs.existsSync(this.dir);
  }

  create(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  applyLimits(limits: CgroupLimits): void {
    if (!this.exists()) return;
    const f = (name: string) => path.join(this.dir, name);
    if (limits.cpuWeight !== undefined) {
      tryWrite(f("cpu.weight"), String(Math.max(1, Math.min(10_000, Math.round(limits.cpuWeight)))));
    }
    if (limits.cpuMaxCores !== undefined) {
      tryWrite(
        f("cpu.max"),
        limits.cpuMaxCores === null ? "max 100000" : `${Math.round(limits.cpuMaxCores * 100_000)} 100000`,
      );
    }
    if (limits.memoryLow !== undefined) tryWrite(f("memory.low"), String(Math.round(limits.memoryLow)));
    if (limits.memoryHigh !== undefined) {
      tryWrite(f("memory.high"), limits.memoryHigh === null ? "max" : String(Math.round(limits.memoryHigh)));
    }
    if (limits.memoryMax !== undefined) {
      tryWrite(f("memory.max"), limits.memoryMax === null ? "max" : String(Math.round(limits.memoryMax)));
    }
    if (limits.pidsMax !== undefined) tryWrite(f("pids.max"), String(Math.round(limits.pidsMax)));
  }

  /**
   * Apply and read back. Critical limits (memory.max/high, cpu.max, pids.max) that did not
   * take are reported so admission can refuse rather than treat a best-effort write as a
   * successful reservation (§6.2).
   */
  applyLimitsVerified(limits: CgroupLimits): { ok: boolean; mismatches: LimitMismatch[] } {
    this.applyLimits(limits);
    const mismatches: LimitMismatch[] = [];
    const check = (file: string, expected: string, normalize: (raw: string) => string): void => {
      const actual = readText(path.join(this.dir, file));
      if (actual === null || normalize(actual) !== expected) mismatches.push({ file, expected, actual });
    };
    const firstField = (raw: string): string => raw.split(/\s+/)[0] ?? raw;
    if (limits.memoryMax !== undefined) {
      check("memory.max", limits.memoryMax === null ? "max" : String(Math.round(limits.memoryMax)), firstField);
    }
    if (limits.memoryHigh !== undefined) {
      check("memory.high", limits.memoryHigh === null ? "max" : String(Math.round(limits.memoryHigh)), firstField);
    }
    if (limits.cpuMaxCores !== undefined) {
      check(
        "cpu.max",
        limits.cpuMaxCores === null ? "max" : String(Math.round(limits.cpuMaxCores * 100_000)),
        firstField,
      );
    }
    if (limits.pidsMax !== undefined) check("pids.max", String(Math.round(limits.pidsMax)), firstField);
    return { ok: mismatches.length === 0, mismatches };
  }

  stats(): CgroupStats {
    const f = (name: string) => path.join(this.dir, name);
    const cpu = readKeyed(f("cpu.stat"));
    return {
      cpuUsec: cpu.get("usage_usec") ?? 0,
      memoryCurrent: readNumber(f("memory.current")),
      memoryPeak: readNumber(f("memory.peak")),
      pidsCurrent: readNumber(f("pids.current")),
      memoryPressure: readPressureAvg10(f("memory.pressure")),
      cpuPressure: readPressureAvg10(f("cpu.pressure")),
    };
  }

  /** One read of every counter the usage feed needs; a missing file reads as zero. */
  extendedStats(): ExtendedCgroupStats {
    const f = (name: string) => path.join(this.dir, name);
    const cpu = readKeyed(f("cpu.stat"));
    const events = readKeyed(f("memory.events"));
    return {
      ...this.stats(),
      cpuUserUsec: cpu.get("user_usec") ?? 0,
      cpuSystemUsec: cpu.get("system_usec") ?? 0,
      nrPeriods: cpu.get("nr_periods") ?? 0,
      nrThrottled: cpu.get("nr_throttled") ?? 0,
      throttledUsec: cpu.get("throttled_usec") ?? 0,
      oomEvents: events.get("oom") ?? 0,
      oomKillEvents: events.get("oom_kill") ?? 0,
    };
  }

  freeze(): void {
    writeFile(path.join(this.dir, "cgroup.freeze"), "1");
  }

  thaw(): void {
    writeFile(path.join(this.dir, "cgroup.freeze"), "0");
  }

  isFrozen(): boolean {
    try {
      return fs.readFileSync(path.join(this.dir, "cgroup.events"), "utf8").includes("frozen 1");
    } catch {
      return false;
    }
  }

  /**
   * Best-effort: without swap or zswap the kernel has nowhere to put anonymous pages and
   * answers EAGAIN, so WARM's RAM saving is a deployment property, not a guarantee (§14.3).
   */
  reclaim(bytes: number): boolean {
    return tryWrite(path.join(this.dir, "memory.reclaim"), String(Math.round(bytes)));
  }

  procs(): number[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, "cgroup.procs"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(Number);
    } catch {
      return [];
    }
  }

  /** cgroup.kill is atomic — it cannot lose a racing fork the way a pid loop can. */
  killAll(): void {
    if (!this.exists()) return;
    if (this.isFrozen()) this.thaw();
    if (!tryWrite(path.join(this.dir, "cgroup.kill"), "1")) {
      for (const pid of this.procs()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Strict cgroup.procs observation; a read error is not an empty group. */
  procsVerified():number[]{
    if(!this.exists())return [];
    const raw=fs.readFileSync(path.join(this.dir,"cgroup.procs"),"utf8");
    return raw.split("\n").filter(Boolean).map(value=>{
      const pid=Number(value);if(!Number.isSafeInteger(pid)||pid<=0)throw new Error("invalid cgroup.procs entry");return pid;
    });
  }

  remove(): boolean {
    if(!this.exists())return true;
    try { fs.rmdirSync(this.dir); return !this.exists(); }
    catch { return false; }
  }
}
