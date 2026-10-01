import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceSpec } from "../wire.js";
import { isMounted } from "./overlay.js";
import { runOk } from "./exec.js";

const GB = 1024 ** 3;

export interface SandboxDiskLayout {
  image: string;
  mountpoint: string;
  upper: string;
  work: string;
}

interface ExistingDiskReservation {
  id: string;
  tier: "hot" | "warm" | "stopped" | "archived" | "error";
  resources: ResourceSpec;
  ceiling: ResourceSpec;
}

/**
 * Gives every sandbox writable overlay a private fixed-size ext4 filesystem.
 *
 * A sparse image makes the quota independent of the host filesystem: unlike project
 * quotas, it needs no host mount options or per-filesystem operator setup. The host only
 * allocates blocks as the sandbox writes them, while ext4 returns ENOSPC at diskGB.
 */
export class SandboxDisks {
  constructor(
    private readonly sandboxesDir: string,
    private readonly reserveBytes: number,
    private readonly scanAllImages = false,
  ) {}

  layout(id: string): SandboxDiskLayout {
    const directory = path.join(this.sandboxesDir, id);
    const mountpoint = path.join(directory, "writable");
    return {
      image: path.join(directory, "writable.ext4"),
      mountpoint,
      upper: path.join(mountpoint, "upper"),
      work: path.join(mountpoint, "work"),
    };
  }

  hasImage(id: string): boolean {
    return fs.existsSync(this.layout(id).image);
  }

  mounted(id: string): boolean {
    const { mountpoint } = this.layout(id);
    return fs.existsSync(mountpoint) && isMounted(mountpoint);
  }

  /**
   * Reclaim zero-filled blocks in an offline ext4 backing image without
   * changing its logical bytes. The caller holds this sandbox's lifecycle
   * serialization slot and invokes this only for a stopped pod, before disk
   * admission. Never attempt it on a mounted or loop-attached image: a failed
   * preflight leaves the retained image untouched and the start held.
   */
  async reclaimOffline(id: string): Promise<number> {
    const { image } = this.layout(id);
    if (!fs.existsSync(image)) return 0;
    const info = fs.lstatSync(image);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`workspace image is not a regular file: ${id}`);
    if (this.mounted(id) || (await runOk("losetup", ["-j", image])).trim() !== "") {
      throw new Error(`workspace image is still attached: ${id}`);
    }
    await runOk("e2fsck", ["-fn", image]);
    const before = info.blocks * 512;
    await runOk("fallocate", ["-d", image]);
    await runOk("e2fsck", ["-fn", image]);
    return Math.max(0, before - fs.statSync(image).blocks * 512);
  }

  private bytes(diskGB: number) {
    const bytes = Math.floor(diskGB * GB);
    if (!Number.isFinite(bytes) || bytes < 8 * 1024 ** 2) {
      throw new Error(`diskGB must describe an ext4 filesystem of at least 8 MiB; received ${diskGB}`);
    }
    return bytes;
  }

  private async createImage(image: string, diskGB: number): Promise<void> {
    const temporary = `${image}.creating-${randomUUID()}`;
    fs.mkdirSync(path.dirname(image), { recursive: true });
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.ftruncateSync(fd, this.bytes(diskGB));
      } finally {
        fs.closeSync(fd);
      }
      await runOk("mkfs.ext4", ["-q", "-F", "-m", "0", temporary]);
      fs.renameSync(temporary, image);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /** Mount the quota filesystem and migrate a pre-quota upper directory, if present. */
  async ensureMounted(id: string, diskGB: number): Promise<SandboxDiskLayout> {
    const layout = this.layout(id);
    fs.mkdirSync(layout.mountpoint, { recursive: true });
    if (!fs.existsSync(layout.image)) await this.createImage(layout.image, diskGB);
    if (!this.mounted(id)) {
      await runOk("mount", ["-t", "ext4", "-o", "loop,nosuid,nodev", layout.image, layout.mountpoint]);
    }
    fs.mkdirSync(layout.upper, { recursive: true });
    fs.mkdirSync(layout.work, { recursive: true });
    await this.migrateLegacyLayout(id, layout);
    return layout;
  }

  private async migrateLegacyLayout(id: string, layout: SandboxDiskLayout): Promise<void> {
    const directory = path.join(this.sandboxesDir, id);
    const legacyUpper = path.join(directory, "upper");
    const legacyWork = path.join(directory, "work");
    if (!fs.existsSync(legacyUpper)) return;

    // cp -a preserves overlay whiteouts, ownership and trusted.overlay xattrs. The old
    // directory is retained unless the complete copy succeeds, so ENOSPC is recoverable by
    // raising diskGB and starting again.
    await runOk("cp", ["-a", "--", `${legacyUpper}/.`, layout.upper]);
    fs.rmSync(legacyUpper, { recursive: true, force: true });
    fs.rmSync(legacyWork, { recursive: true, force: true });
  }

  async unmount(id: string): Promise<void> {
    const { mountpoint } = this.layout(id);
    if (!fs.existsSync(mountpoint) || !isMounted(mountpoint)) return;
    await runOk("umount", [mountpoint]);
  }

  async unmountVerified(id:string):Promise<void>{
    const {mountpoint}=this.layout(id);
    if(!fs.existsSync(mountpoint))return;
    if(isMounted(mountpoint))await runOk("umount",[mountpoint]);
    if(isMounted(mountpoint))throw new Error(`workspace image remains mounted at ${mountpoint}`);
  }

  async destroy(id: string): Promise<void> {
    const layout = this.layout(id);
    await this.unmount(id);
    fs.rmSync(layout.image, { force: true });
    fs.rmSync(layout.mountpoint, { recursive: true, force: true });
  }

  /** ext4 supports online growth. Shrinking would require stopping the workload. */
  async grow(id: string, oldDiskGB: number, newDiskGB: number): Promise<void> {
    if (newDiskGB === oldDiskGB || !this.hasImage(id)) return;
    if (newDiskGB < oldDiskGB) {
      throw new Error(
        `disk quota cannot shrink from ${oldDiskGB}GB to ${newDiskGB}GB while preserving a sandbox filesystem`,
      );
    }

    const wasMounted = this.mounted(id);
    const layout = await this.ensureMounted(id, oldDiskGB);
    fs.truncateSync(layout.image, this.bytes(newDiskGB));
    try {
      const source = (await runOk("findmnt", ["-n", "-o", "SOURCE", "--target", layout.mountpoint])).trim();
      if (!source) throw new Error(`could not find loop device for ${layout.mountpoint}`);
      await runOk("resize2fs", [source]);
    } finally {
      if (!wasMounted) await this.unmount(id);
    }
  }

  /**
   * Reserve every local sandbox's complete quota while accounting sparse-image blocks as
   * already paid for in statfs. This prevents individually compliant sandboxes from jointly
   * filling the host state filesystem.
   */
  admits(
    existing: ExistingDiskReservation[],
    incomingDiskGB: number,
    incomingId?: string,
  ): { ok: boolean; reason?: string; hint?: string } {
    const { committedBytes, capacityBytes } = this.capacity(existing, incomingId);
    const requested = incomingDiskGB * GB;
    if (committedBytes + requested > capacityBytes) {
      return {
        ok: false,
        reason: `disk quotas exhausted: ${(committedBytes / GB).toFixed(1)}GB committed of ${Math.max(0, capacityBytes / GB).toFixed(1)}GB, ${incomingDiskGB}GB requested`,
        hint: "archive or delete a sandbox, lower the requested disk quota, or add state-volume capacity",
      };
    }
    return { ok: true };
  }

  /**
   * Raw host-side numbers for the admission controller: blocks the named sparse images
   * actually occupy, and the state filesystem's headroom with the operator reserve removed
   * and those blocks added back (they are already paid for in statfs).
   */
  probe(ids: Iterable<string>): { capacityBytes: number; allocatedBytes: number; allocatedById: Map<string, number> } {
    let allocated = 0;
    const allIds = new Set(ids);
    // Include abandoned images not represented by SQLite: deleting a row must not buy quota.
    if (this.scanAllImages) {
      for (const entry of fs.readdirSync(this.sandboxesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) allIds.add(entry.name);
      }
    }
    const allocatedById = new Map<string, number>();
    for (const id of allIds) {
      let bytes = 0;
      try { bytes = fs.statSync(this.layout(id).image).blocks * 512; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (this.scanAllImages) {
        const visit = (file: string): number => {
          let s: fs.Stats;
          try { s = fs.lstatSync(file); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
          return s.blocks * 512 + (s.isDirectory() ? fs.readdirSync(file).reduce((sum, name) => sum + visit(path.join(file, name)), 0) : 0);
        };
        bytes += visit(path.join(this.sandboxesDir, id, "upper"));
      }
      allocatedById.set(id, bytes);
      allocated += bytes;
    }
    const stat = fs.statfsSync(this.sandboxesDir);
    return {
      capacityBytes: stat.bavail * stat.bsize + allocated - this.reserveBytes,
      allocatedBytes: allocated,
      allocatedById,
    };
  }

  /** The two totals {@link admits} compares, so capacity reporting cannot drift from it. */
  capacity(
    existing: ExistingDiskReservation[],
    incomingId?: string,
  ): { committedBytes: number; capacityBytes: number } {
    const local = existing.filter((row) => row.tier !== "archived");
    const committedBytes = local.reduce(
      (sum, row) => sum + (row.ceiling.diskGB ?? row.resources.diskGB ?? 0) * GB,
      0,
    );
    const allocationIds = new Set(local.map((row) => row.id));
    if (incomingId) allocationIds.add(incomingId);
    const allocated = [...allocationIds].reduce((sum, id) => {
      try {
        return sum + fs.statSync(this.layout(id).image).blocks * 512;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return sum;
        throw error;
      }
    }, 0);
    const stat = fs.statfsSync(this.sandboxesDir);
    return {
      committedBytes,
      capacityBytes: stat.bavail * stat.bsize + allocated - this.reserveBytes,
    };
  }
}
