import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run, runOk, type RunResult } from "./exec.js";

/** Bind-mount target of the static init inside every sandbox. */
export const INIT_PATH = "/.pps-init";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findInitBinary(): string | null {
  const candidates = [
    process.env.PI_POD_SANDBOX_INIT ?? "",
    path.resolve(HERE, "../../bin/pps-init"),
    path.resolve(HERE, "../../../bin/pps-init"),
    "/usr/local/lib/pi-pod-sandbox/pps-init",
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const DEFAULT_CAPS = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FSETID",
  "CAP_FOWNER",
  "CAP_MKNOD",
  "CAP_NET_RAW",
  "CAP_SETGID",
  "CAP_SETUID",
  "CAP_SETFCAP",
  "CAP_SETPCAP",
  "CAP_NET_BIND_SERVICE",
  "CAP_SYS_CHROOT",
  "CAP_KILL",
  "CAP_AUDIT_WRITE",
];

/**
 * A denylist, not docker's 300-entry allowlist: with CAP_SYS_ADMIN and friends already
 * dropped, what is left worth blocking is the handful of syscalls that reach the kernel
 * itself. Small enough to read, which an allowlist nobody audits is not.
 */
const SECCOMP_DENIED = [
  "kexec_load",
  "kexec_file_load",
  "init_module",
  "finit_module",
  "delete_module",
  "bpf",
  "perf_event_open",
  "open_by_handle_at",
  "swapon",
  "swapoff",
  "reboot",
  "settimeofday",
  "clock_settime",
  "clock_adjtime",
  "adjtimex",
  "pivot_root",
  "mount_setattr",
  "fsconfig",
  "fsmount",
  "fsopen",
  "move_mount",
];

export interface BundleOptions {
  id: string;
  bundleDir: string;
  rootfs: string;
  workdir: string;
  hostname: string;
  env: string[];
  cgroupPath: string;
  netnsPath: string;
  resolvConfPath: string;
  hostsPath: string;
  initBinary: string;
  readonlyRootfs?: boolean;
}

export interface ProcessSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  terminal?: boolean;
}

export function buildSpec(opts: BundleOptions): unknown {
  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: { uid: 0, gid: 0 },
      args: [INIT_PATH],
      env: opts.env,
      cwd: "/",
      capabilities: {
        bounding: DEFAULT_CAPS,
        effective: DEFAULT_CAPS,
        permitted: DEFAULT_CAPS,
      },
      rlimits: [{ type: "RLIMIT_NOFILE", hard: 1048576, soft: 1048576 }],
      noNewPrivileges: false,
    },
    root: { path: opts.rootfs, readonly: Boolean(opts.readonlyRootfs) },
    hostname: opts.hostname,
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: "/dev/pts",
        type: "devpts",
        source: "devpts",
        options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"],
      },
      {
        destination: "/dev/shm",
        type: "tmpfs",
        source: "shm",
        options: ["nosuid", "noexec", "nodev", "mode=1777", "size=1g"],
      },
      {
        destination: "/dev/mqueue",
        type: "mqueue",
        source: "mqueue",
        options: ["nosuid", "noexec", "nodev"],
      },
      { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
      {
        destination: "/etc/resolv.conf",
        type: "bind",
        source: opts.resolvConfPath,
        options: ["rbind", "ro", "rprivate"],
      },
      {
        destination: "/etc/hosts",
        type: "bind",
        source: opts.hostsPath,
        options: ["rbind", "ro", "rprivate"],
      },
      {
        destination: INIT_PATH,
        type: "bind",
        source: opts.initBinary,
        options: ["rbind", "ro", "rprivate"],
      },
    ],
    linux: {
      cgroupsPath: opts.cgroupPath,
      resources: {},
      namespaces: [
        { type: "pid" },
        { type: "ipc" },
        { type: "uts" },
        { type: "mount" },
        { type: "cgroup" },
        { type: "network", path: opts.netnsPath },
      ],
      seccomp: {
        defaultAction: "SCMP_ACT_ALLOW",
        architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32", "SCMP_ARCH_AARCH64"],
        syscalls: [{ names: SECCOMP_DENIED, action: "SCMP_ACT_ERRNO", errnoRet: 1 }],
      },
      maskedPaths: [
        "/proc/acpi",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/timer_list",
        "/proc/sched_debug",
        "/sys/firmware",
        "/sys/devices/virtual/powercap",
      ],
      readonlyPaths: [
        "/proc/asound",
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],
    },
  };
}

/** OCI runtime states; anything else is a probe we do not understand. */
const KNOWN_STATUSES = new Set(["creating", "created", "running", "paused", "stopped"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Only a diagnostic that names *this container's* state as missing is evidence of absence:
 * crun reports `error opening file \`<statedir>/<id>/status\`: No such file or directory` and
 * runsc reports `container "<id>" does not exist`. A generic ENOENT (a missing loader,
 * config or binary) can appear while the guest is alive, so it must not match.
 */
function containerAbsentPattern(id: string): RegExp {
  const i = escapeRegExp(id);
  return new RegExp(
    [
      `[/\\\\]${i}[/\\\\]status\`?[^\n]*No such file or directory`,
      `container \`?"?${i}"?\`? (?:does not exist|not found|doesn't exist)`,
      `\`?"?${i}"?\`?: (?:container )?(?:does not exist|not found|doesn't exist)`,
    ].join("|"),
    "i",
  );
}

/** A runtime state query that failed for a reason other than "no such container". */
export class RuntimeProbeError extends Error {
  constructor(
    readonly sandboxId: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProbeError";
  }
}

export class Runtime {
  constructor(private readonly binary: string) {}

  async writeBundle(opts: BundleOptions): Promise<void> {
    fs.mkdirSync(opts.bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.bundleDir, "config.json"),
      JSON.stringify(buildSpec(opts), null, 2),
    );
  }

  /**
   * The container's init inherits these fds and holds them for the sandbox's whole life, so
   * they must be a file: piping them to the service would mean waiting for a stream that only
   * closes when the sandbox dies.
   */
  async start(id: string, bundleDir: string, logFile: string): Promise<number> {
    const pidFile = path.join(bundleDir, "init.pid");
    const fd = fs.openSync(logFile, "a");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          this.binary,
          ["run", "-d", "--bundle", bundleDir, "--pid-file", pidFile, id],
          { stdio: ["ignore", fd, fd] },
        );
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`${this.binary} run failed (${code}); see ${logFile}`)),
        );
      });
    } finally {
      fs.closeSync(fd);
    }
    return Number(fs.readFileSync(pidFile, "utf8").trim());
  }

  /**
   * `null` means the runtime positively reports no such container. Any other failure (crun
   * unavailable, permission error, unparsable output) is thrown: callers that free resources
   * on "absent" must never mistake a broken probe for absence.
   */
  async state(id: string): Promise<{ status: string; pid: number } | null> {
    const r = await run(this.binary, ["state", id]);
    if (r.code !== 0) {
      const absent = containerAbsentPattern(id);
      if (absent.test(r.stderr) || absent.test(r.stdout)) return null;
      throw new RuntimeProbeError(id, `${this.binary} state exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (err) {
      throw new RuntimeProbeError(id, `${this.binary} state returned unparsable output: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RuntimeProbeError(id, `${this.binary} state returned a non-object answer`);
    }
    const answer = parsed as { id?: unknown; status?: unknown; pid?: unknown };
    // The OCI state's id is mandatory and must be exactly this container: an answer that
    // omits it, or names another one, is not evidence about this sandbox.
    if (typeof answer.id !== "string" || answer.id !== id) {
      throw new RuntimeProbeError(id, `${this.binary} state answered for ${JSON.stringify(answer.id)} instead of ${id}`);
    }
    if (typeof answer.status !== "string" || !KNOWN_STATUSES.has(answer.status)) {
      throw new RuntimeProbeError(id, `${this.binary} state reported unknown status ${JSON.stringify(answer.status)}`);
    }
    const pid = answer.pid;
    const live = answer.status !== "stopped";
    if (live) {
      // A live container's PID must be a positive integer; never coerce.
      if (!Number.isInteger(pid) || (pid as number) <= 0) {
        throw new RuntimeProbeError(id, `${this.binary} state reported ${answer.status} with an invalid pid ${JSON.stringify(pid)}`);
      }
      return { status: answer.status, pid: pid as number };
    }
    // Stopped: the OCI schema makes pid optional. Absent is fine; present must be a finite
    // non-negative integer, or the "stopped" evidence itself is malformed and untrusted.
    if (pid === undefined) return { status: answer.status, pid: 0 };
    if (!Number.isInteger(pid) || (pid as number) < 0) {
      throw new RuntimeProbeError(id, `${this.binary} state reported stopped with a malformed pid ${JSON.stringify(pid)}`);
    }
    return { status: answer.status, pid: pid as number };
  }

  /** Legacy best-effort lifecycle calls preserve their historical contract. */
  async kill(id:string,signal:string):Promise<void>{await run(this.binary,["kill",id,signal]);}
  async delete(id:string):Promise<void>{await run(this.binary,["delete","-f",id]);}

  /** Strict callers must inspect the exit receipt and independently probe absence. */
  async killResult(id:string,signal:string):Promise<RunResult>{return run(this.binary,["kill",id,signal]);}
  async deleteResult(id:string):Promise<RunResult>{return run(this.binary,["delete","-f",id]);}

  /**
   * A process.json file rather than flags: exec carries a whole environment, and an env
   * that goes through argv is an env that shows up in the host's process list (§6.3).
   */
  processFile(dir: string, spec: ProcessSpec): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `exec-${Math.random().toString(36).slice(2, 10)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        terminal: false,
        user: { uid: 0, gid: 0 },
        args: spec.argv,
        env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        cwd: spec.cwd,
        capabilities: {
          bounding: DEFAULT_CAPS,
          effective: DEFAULT_CAPS,
          permitted: DEFAULT_CAPS,
        },
        noNewPrivileges: false,
      }),
      { mode: 0o600 },
    );
    return file;
  }

  execArgs(id: string, processFile: string): { file: string; args: string[] } {
    return { file: this.binary, args: ["exec", "--process", processFile, id] };
  }

  spawnExec(id: string, processFile: string): ChildProcess {
    const { file, args } = this.execArgs(id, processFile);
    return spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  }

  async version(): Promise<string> {
    const r = await run(this.binary, ["--version"]);
    return r.stdout.split("\n")[0] ?? this.binary;
  }
}
