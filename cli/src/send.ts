import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT, PiPodError } from "./errors.js";

export const SEND_MAX_BYTES = 24 * 1024 * 1024;

export function sendLimitError(sourcePath: string): PiPodError {
  return new PiPodError(`${sourcePath} exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB send limit`, {
    hint: "split the tree and send the pieces you need",
    exitCode: EXIT.USAGE,
  });
}

export interface SendEntry {
  relPath: string;
  kind: "file" | "dir" | "symlink";
  contents?: string;
  mode?: number;
  target?: string;
}

export interface CollectSendEntriesOptions {
  /** Path every entry is placed under; "" lands the tree's contents at the destination root. */
  relBase?: string;
  /** Path named in the size-limit error, when it differs from the resolved source. */
  label?: string;
  /** Called per child with its name and destination-relative path; true drops it and its subtree. */
  exclude?: (name: string, relPath: string) => boolean;
  /** Servers reject symlinks from pod tokens, so those callers collect the rest and report them. */
  skipSymlinks?: boolean;
}

export interface WalkEntry {
  relPath: string;
  absPath: string;
  kind: "file" | "dir" | "symlink" | "other";
  stat: fs.Stats;
}

export interface WalkTreeOptions {
  /** Path every entry is placed under; "" lands the tree's contents at the destination root. */
  relBase?: string;
  /** Called per child with its name and destination-relative path; true drops it and its subtree. */
  exclude?: (name: string, relPath: string) => boolean;
}

function entryKind(stat: fs.Stats): WalkEntry["kind"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

/**
 * Depth-first walk used by `pipod send` and seed tarball creation.
 *
 * Directories are yielded before their children (readdir order). The root directory itself
 * is yielded only when `relBase !== ""`, matching collectSendEntries. Symlinks are never
 * followed. An unreadable child is skipped rather than failing the whole walk — missing
 * source at the root still throws, so callers that passed a bad path find out.
 */
export function* walkTree(source: string, opts?: WalkTreeOptions): Generator<WalkEntry> {
  const relBase = opts?.relBase ?? path.basename(source);
  const exclude = opts?.exclude;

  function* visit(absPath: string, relPath: string, isRoot: boolean): Generator<WalkEntry> {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch (error) {
      if (isRoot) throw error;
      return;
    }
    const kind = entryKind(stat);
    if (kind === "dir") {
      if (relPath !== "") yield { relPath, absPath, kind, stat };
      let names: string[];
      try {
        names = fs.readdirSync(absPath);
      } catch (error) {
        if (isRoot) throw error;
        return;
      }
      for (const name of names) {
        const childRel = relPath === "" ? name : path.posix.join(relPath, name);
        if (exclude?.(name, childRel)) continue;
        yield* visit(path.join(absPath, name), childRel, false);
      }
      return;
    }
    yield { relPath, absPath, kind, stat };
  }

  yield* visit(source, relBase, true);
}

export function collectSendEntries(
  source: string,
  opts: CollectSendEntriesOptions = {},
): { entries: SendEntry[]; skippedSymlinks: string[] } {
  const relBase = opts.relBase ?? path.basename(source);
  const label = opts.label ?? source;
  const entries: SendEntry[] = [];
  const skippedSymlinks: string[] = [];
  let bytes = 0;

  for (const entry of walkTree(source, { relBase, exclude: opts.exclude })) {
    if (entry.kind === "symlink") {
      if (opts.skipSymlinks) {
        skippedSymlinks.push(entry.relPath);
        continue;
      }
      entries.push({ relPath: entry.relPath, kind: "symlink", target: fs.readlinkSync(entry.absPath) });
      continue;
    }
    if (entry.kind === "dir") {
      entries.push({ relPath: entry.relPath, kind: "dir" });
      continue;
    }
    if (entry.kind !== "file") continue;
    bytes += entry.stat.size;
    if (bytes > SEND_MAX_BYTES) throw sendLimitError(label);
    entries.push({
      relPath: entry.relPath,
      kind: "file",
      contents: fs.readFileSync(entry.absPath).toString("base64"),
      mode: entry.stat.mode & 0o777,
    });
  }

  return { entries, skippedSymlinks };
}
