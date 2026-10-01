/**
 * src/authsync.ts — keep a running pod's borrowed credentials fresh (§7.4).
 *
 * The pod's `auth.json` is a sanitized copy of the host's: access tokens travel, refresh
 * tokens never do (they rotate on use, and two environments holding the same one revoke
 * each other — the failure this module exists to prevent). That makes the host the only
 * refresher, which leaves one gap: an access token expires while its pod is still working.
 * The auth sync closes it. While a session is attached it periodically
 *
 *   1. renews every OAuth grant *on the host* through pi's own print command — refreshing
 *      and persisting through pi's locked path, the same proof preflight runs before launch;
 *   2. re-sanitizes the host's `auth.json`; and
 *   3. pushes it into every tracked pod whose copy it wrote in the first place.
 *
 * Step 3 is deliberately conservative: a pod whose `auth.json` no longer matches the last
 * copy this sync wrote is left alone for the rest of the session. The only way that file
 * changes in the pod is the user running `/login` there, and a background sync must never
 * clobber an explicit login.
 *
 * Account mode does not use this: the server broker is the refresh authority there, and the
 * pod-side extension renews from it. This is the local-mode half of the same guarantee.
 */
import * as fs from "node:fs";
import {
  POD_PI_AGENT_DIR,
  hostHome,
  hostPiAuthPath,
  sanitizePiAuthContents,
} from "./hostconfig.js";
import { refreshHostOAuthGrants } from "./preflight.js";
import { debug } from "./log.js";
import type { Sandbox } from "./providers/types.js";

export const POD_PI_AUTH_PATH = `${POD_PI_AGENT_DIR}/auth.json`;

/**
 * How often a running session renews its pods' borrowed tokens. OAuth access tokens live
 * hours; ten minutes keeps a pod several refreshes ahead of expiry without turning the
 * sync into traffic anyone would notice.
 */
export const AUTH_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export interface AuthSyncOptions {
  /** The home preflight resolved; null disables the sync (nothing to read). */
  home: string | null;
  /** The host's selected model, for probe resolution — same rule as preflight's. */
  hostModel?: { provider: string; model: string } | null;
  intervalMs?: number;
  /** Test seam: the credential-print probe. Defaults to preflight's own. */
  probe?: (command: string, home: string) => Promise<boolean>;
  /** Test seam: read a pod file's current contents (null when absent). */
  readPod?: (sandbox: Sandbox, path: string) => Promise<string | null>;
  /** Test seam: write contents to a pod file. */
  writePod?: (sandbox: Sandbox, path: string, contents: string) => Promise<void>;
}

interface Slot {
  /** The exact contents this sync last wrote — the divergence baseline. */
  lastPushed: string | null;
  /** The pod's file changed under us (a pod-side login): never write it again. */
  diverged: boolean;
}

interface TrackedPod {
  sandbox: Sandbox;
  auth: Slot;
}

async function defaultReadPod(sandbox: Sandbox, path: string): Promise<string | null> {
  const read = await sandbox.exec(["cat", path], { timeoutMs: 30_000 });
  return read.exitCode === 0 && read.output ? read.output : null;
}

async function defaultWritePod(sandbox: Sandbox, path: string, contents: string): Promise<void> {
  await sandbox.exec(["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))], { timeoutMs: 30_000 });
  await sandbox.uploadFile(path, Buffer.from(contents), 0o600);
}

export class AuthSync {
  private readonly pods = new Map<string, TrackedPod>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inFlight = false;
  private queued = false;

  constructor(private readonly opts: AuthSyncOptions) {}

  /** Begin watching a pod. `knownContent` is the copy already written at launch, if any. */
  track(sandbox: Sandbox, knownContent?: string | null): void {
    this.pods.set(sandbox.id, {
      sandbox,
      auth: { lastPushed: knownContent ?? null, diverged: false },
    });
  }

  untrack(sandboxId: string): void {
    this.pods.delete(sandboxId);
  }

  /** Immediate sync, then one per interval. Calls are serialized like the heartbeat's. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.syncNow(), this.opts.intervalMs ?? AUTH_SYNC_INTERVAL_MS);
    this.timer.unref?.();
    void this.syncNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One renewal pass: refresh the host's grants, then push the sanitized file to every
   * tracked pod that has not diverged. Best-effort throughout — a sync failure must never
   * take a session down, and the next tick retries.
   */
  async syncNow(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.syncOnce();
    } finally {
      this.inFlight = false;
      if (this.queued && !this.stopped) {
        this.queued = false;
        void this.syncNow();
      }
    }
  }

  private async syncOnce(): Promise<void> {
    const home = hostHome(this.opts.home ?? undefined);
    if (!home) return;
    const authPath = hostPiAuthPath(home);
    if (!fs.existsSync(authPath)) return;

    // Renew on the host first, so the copy below is as fresh as the grants allow. A probe
    // that fails (a revoked grant, a network blip) is quiet here: launch already reported
    // it, and the pod keeps whatever token it has either way.
    const failures = await refreshHostOAuthGrants(home, {
      hostModel: this.opts.hostModel ?? null,
      probe: this.opts.probe,
    });
    for (const provider of failures) debug(`auth sync: host grant for ${provider} did not renew`);

    let sanitized: string;
    try {
      sanitized = sanitizePiAuthContents(fs.readFileSync(authPath, "utf8"));
    } catch (e) {
      debug(`auth sync: could not read ${authPath}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const readPod = this.opts.readPod ?? defaultReadPod;
    const writePod = this.opts.writePod ?? defaultWritePod;
    for (const pod of this.pods.values()) {
      await this.pushToPod(pod, pod.auth, sanitized, POD_PI_AUTH_PATH, readPod, writePod, "auth.json");
    }
  }

  /** Push one borrowed file to one pod, under the divergence guard: never clobber a pod-side login. */
  private async pushToPod(
    pod: TrackedPod,
    slot: Slot,
    desired: string,
    path: string,
    readPod: (sandbox: Sandbox, path: string) => Promise<string | null>,
    writePod: (sandbox: Sandbox, path: string, contents: string) => Promise<void>,
    label: string,
  ): Promise<void> {
    if (slot.diverged || slot.lastPushed === desired) return;
    try {
      const current = await readPod(pod.sandbox, path);
      if (current === desired) {
        slot.lastPushed = desired;
        return;
      }
      if (slot.lastPushed !== null && current !== null && current !== slot.lastPushed) {
        slot.diverged = true;
        debug(
          `auth sync: ${pod.sandbox.id}'s ${label} changed inside the pod ` +
            "(a /login there, most likely) — leaving it alone",
        );
        return;
      }
      await writePod(pod.sandbox, path, desired);
      slot.lastPushed = desired;
      debug(`auth sync: renewed the borrowed ${label} in pod ${pod.sandbox.id}`);
    } catch (e) {
      debug(`auth sync: could not renew pod ${pod.sandbox.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
