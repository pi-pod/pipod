/**
 * src/client/mirror.ts — the host-side half of the session mirror (§5.6).
 *
 * The pod's pi writes its transcript to session JSONL on the pod's disk, which dies with
 * the pod. The shim streams appended bytes as `mirror_data` control frames; this module
 * writes them into a per-pod shadow directory under `~/.pi-pod/sessions/`, so the
 * conversation outlives the pod that held it. The mirror is client-driven: nothing streams
 * until `sync()` declares the local per-file sizes, and every reconnect re-declares them so
 * the shim resumes exactly where this machine's copy ends.
 *
 * The pod is semi-trusted: paths arrive from it, so every segment is validated before a
 * byte lands, and a chunk that does not extend the local file triggers a bounded resync
 * rather than a blind write.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debug } from "../log.js";
import type { RemoteRpcClient } from "./rpc.js";

export const MIRROR_BASE_DIR = path.join(os.homedir(), ".pi-pod", "sessions");

/** Larger than the shim will ever send (64 KiB); anything bigger is a misbehaving pod. */
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** A pod that keeps answering with unusable offsets must not turn resync into a loop. */
const RESYNC_MIN_INTERVAL_MS = 5_000;

export interface SessionMirror {
  /** Declare local state and ask the shim to stream from there. Call after every (re)connect. */
  sync(): void;
  /** Point at another pod after /pod switch, then sync against its journal. */
  rebind(podId: string): void;
  dispose(): void;
}

/** Where one pod's transcripts land locally; also the after-session report path. */
export function podMirrorDir(podId: string, baseDir = MIRROR_BASE_DIR): string {
  return path.join(baseDir, podId.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/** The pod-relative path, proven safe to join, or null. Boring names only — like labels. */
function safeRelativePath(rel: string): string | null {
  if (rel.length === 0 || rel.length > 512) return null;
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
    if (!/^[A-Za-z0-9._@-]+$/.test(segment)) return null;
  }
  return segments.join(path.sep);
}

export function wireSessionMirror(args: {
  rpc: RemoteRpcClient;
  podId: string;
  baseDir?: string;
}): SessionMirror {
  const baseDir = args.baseDir ?? MIRROR_BASE_DIR;
  let dir = podMirrorDir(args.podId, baseDir);
  let disposed = false;
  let lastResyncAt = 0;

  const localSizes = (): Record<string, number> => {
    const files: Record<string, number> = {};
    const walk = (current: string, rel: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(current, entry.name), childRel, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            files[childRel] = fs.statSync(path.join(current, entry.name)).size;
          } catch {
            // A file that vanished mid-scan is simply not declared.
          }
        }
      }
    };
    walk(dir, "", 0);
    return files;
  };

  const sync = (): void => {
    if (disposed) return;
    args.rpc.requestMirrorSync(localSizes());
  };

  /** The local copy disagrees with the stream; re-declare truth instead of guessing. */
  const resync = (): void => {
    const now = Date.now();
    if (now - lastResyncAt < RESYNC_MIN_INTERVAL_MS) return;
    lastResyncAt = now;
    sync();
  };

  const off = args.rpc.onControl((event) => {
    if (disposed || event.event !== "mirror_data") return;
    const rel = safeRelativePath(event.path);
    if (rel === null) {
      debug(`mirror: refusing pod-supplied path ${JSON.stringify(event.path)}`);
      return;
    }
    if (!Number.isInteger(event.offset) || event.offset < 0) return;
    const data = Buffer.from(event.data, "base64");
    if (data.length === 0 || data.length > MAX_CHUNK_BYTES) return;

    const target = path.join(dir, rel);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(target).size;
      } catch {
        // New file.
      }
      if (event.offset === 0) fs.writeFileSync(target, data);
      else if (event.offset === size) fs.appendFileSync(target, data);
      else resync();
    } catch (e) {
      debug(`mirror: could not write ${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return {
    sync,
    rebind: (podId: string) => {
      dir = podMirrorDir(podId, baseDir);
      lastResyncAt = 0;
      sync();
    },
    dispose: () => {
      disposed = true;
      off();
    },
  };
}

/** The mirror directory to name in the after-session report, or null when nothing landed. */
export function mirroredSessionDir(podId: string, baseDir = MIRROR_BASE_DIR): string | null {
  const dir = podMirrorDir(podId, baseDir);
  try {
    return fs.readdirSync(dir).length > 0 ? dir : null;
  } catch {
    return null;
  }
}
