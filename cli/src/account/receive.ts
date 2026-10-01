/** Download one pod workdir-relative file tree to the current local directory. */
import * as fs from "node:fs";
import * as path from "node:path";
import { CancelledError, PiPodError } from "../errors.js";
import { info } from "../log.js";
import { confirm } from "../prompt.js";
import type { AccountClient } from "./api.js";
import { selectAccountPod } from "./pods.js";
import { displayRef } from "./ref.js";
import { withWorkstationWait } from "./workstation.js";

const RECEIVE_MAX_ENTRIES = 10_000;
const RECEIVE_MAX_BYTES = 24 * 1024 * 1024;
const RECEIVE_TIMEOUT_MS = 11 * 60 * 1000;

export interface ReceivedEntry {
  relPath: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size?: number;
  target?: string;
  contents?: string;
}

interface ReceiveResponse {
  id: string;
  source: string;
  entries: ReceivedEntry[];
}

export async function runAccountReceive(
  client: AccountClient,
  args: string[],
  flags: { yes?: boolean } = {},
): Promise<number> {
  if (args.length < 1 || args.length > 2) {
    throw new PiPodError("usage: pipod receive [pod] <path>");
  }
  const [podRef, requested] = args.length === 2 ? [args[0], args[1]!] : [undefined, args[0]!];
  const pod = await selectAccountPod(client, podRef, "receive files from");
  const source = safeRemotePath(requested, pod.resolvedConfig.workdir);
  const sourceName = path.posix.basename(source);
  const destination = path.resolve(sourceName);
  assertDestinationAbsent(destination);
  if (pod.state === "archived") {
    const ok = await confirm(`pod ${displayRef(pod.id, "pod")} is archived — restore and receive?`, {
      nonInteractiveDefault: false,
      assumeYes: flags.yes,
    });
    if (!ok) throw new CancelledError("receive cancelled");
    // A restore can itself meet the host-demand 503 when the workstation is down; wait for it
    // the same way the file read below does rather than failing an archived pod's receive.
    await withWorkstationWait(client, () => client.podCommand(pod.id, "restore"));
  }

  info(`receiving pod ${displayRef(pod.id, "pod")}:${source} → ${destination}`);
  // Reading a file is exactly what wakes a sleeping personal workstation, so this is one of
  // the paths that routinely meets the host-demand 503 (it is the call the production M2 run
  // used to drive a resume). Nothing has been written to disk yet, so retrying is free.
  const response = await withWorkstationWait(client, () =>
    client.request<ReceiveResponse>(`/pods/${pod.id}/files`, {
      query: { path: source },
      timeoutMs: RECEIVE_TIMEOUT_MS,
    }),
  );
  materializeReceivedTree(response.entries, destination);
  info(`received ${sourceName}`);
  return 0;
}

/** Materialize a server-validated tree defensively, staging beside the final destination. */
export function materializeReceivedTree(entries: ReceivedEntry[], destination: string): void {
  if (entries.length === 0 || entries.length > RECEIVE_MAX_ENTRIES || entries[0]?.relPath !== "") {
    throw new PiPodError("server returned an invalid receive manifest");
  }
  assertDestinationAbsent(destination);

  const checked = entries.map(validateEntry);
  const byPath = new Map<string, ReceivedEntry>();
  let bytes = 0;
  for (const entry of checked) {
    if (byPath.has(entry.relPath)) throw new PiPodError(`server returned duplicate path ${entry.relPath || "."}`);
    byPath.set(entry.relPath, entry);
    if (entry.kind === "file") {
      bytes += entry.size!;
      if (bytes > RECEIVE_MAX_BYTES) throw new PiPodError("server response exceeds the 24 MB receive limit");
    }
  }
  if (checked.length > 1 && checked[0]!.kind !== "dir") {
    throw new PiPodError("server returned children beneath a non-directory receive root");
  }

  // An entry may only have directory ancestors. This prevents a malicious manifest from first
  // creating a symlink and then using it as a write path for another entry.
  for (const entry of checked) {
    const parts = entry.relPath === "" ? [] : entry.relPath.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = byPath.get(parts.slice(0, i).join("/"));
      if (ancestor && ancestor.kind !== "dir") {
        throw new PiPodError(`server returned a non-directory parent for ${entry.relPath}`);
      }
    }
  }

  const parent = path.dirname(destination);
  const staging = fs.mkdtempSync(path.join(parent, ".pi-pod-receive-"));
  const root = path.join(staging, "payload");
  const localPath = (relPath: string): string =>
    relPath === "" ? root : path.join(root, ...relPath.split("/"));

  try {
    const directories = checked
      .filter((entry) => entry.kind === "dir")
      .sort((a, b) => depth(a.relPath) - depth(b.relPath));
    for (const entry of directories) fs.mkdirSync(localPath(entry.relPath), { recursive: true, mode: 0o700 });

    for (const entry of checked.filter((item) => item.kind === "file")) {
      const dest = localPath(entry.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const contents = decodeCanonicalBase64(entry.contents!, entry.relPath);
      if (contents.byteLength !== entry.size) throw new PiPodError(`file size changed in transit: ${entry.relPath || "."}`);
      fs.writeFileSync(dest, contents, { flag: "wx", mode: entry.mode });
    }

    // Links are last, after every path that can contain another entry has already been written.
    for (const entry of checked.filter((item) => item.kind === "symlink")) {
      const dest = localPath(entry.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.symlinkSync(entry.target!, dest);
    }

    for (const entry of directories
      .filter((item) => item.relPath !== "")
      .sort((a, b) => depth(b.relPath) - depth(a.relPath))) {
      fs.chmodSync(localPath(entry.relPath), entry.mode);
    }
    commitStagedRoot(root, destination, checked[0]!);
  } catch (error) {
    throw error instanceof PiPodError
      ? error
      : new PiPodError(`could not write received files: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function validateEntry(entry: ReceivedEntry): ReceivedEntry {
  if (!entry || typeof entry !== "object") throw new PiPodError("server returned an invalid receive entry");
  const relPath = entry.relPath;
  const parts = typeof relPath === "string" && relPath !== "" ? relPath.split("/") : [];
  if (
    typeof relPath !== "string" ||
    relPath.length > 1024 ||
    relPath.startsWith("/") ||
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PiPodError(`server returned an unsafe receive path: ${String(relPath)}`);
  }
  if (entry.kind !== "file" && entry.kind !== "dir" && entry.kind !== "symlink") {
    throw new PiPodError(`server returned an unsupported entry: ${relPath || "."}`);
  }
  if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
    throw new PiPodError(`server returned an invalid mode: ${relPath || "."}`);
  }
  if (entry.kind === "file") {
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || typeof entry.contents !== "string") {
      throw new PiPodError(`server returned an invalid file: ${relPath || "."}`);
    }
  }
  if (entry.kind === "symlink") {
    if (typeof entry.target !== "string" || entry.target === "" || symlinkEscapesRoot(relPath, entry.target)) {
      throw new PiPodError(`server returned an unsafe symlink: ${relPath || "."}`);
    }
  }
  return entry;
}

export function safeRemotePath(value: string, workdir?: string): string {
  if (value.includes("\0") || value.includes("\\") || value.split("/").includes("..")) {
    throw new PiPodError(`receive path must stay inside the pod workdir and must not contain '..' or backslashes: ${JSON.stringify(value)}`, {
      hint: "pass a path such as foo or build/output.zip",
    });
  }
  let relative = value;
  if (value.startsWith("/")) {
    const root = workdir ? path.posix.normalize(workdir).replace(/\/$/, "") : null;
    if (!root || !path.posix.isAbsolute(root) || (value !== root && !value.startsWith(`${root}/`))) {
      throw new PiPodError(`receive path is outside the pod workdir: ${JSON.stringify(value)}`, {
        hint: root ? `choose a path under ${root}` : "pass a workdir-relative path such as foo",
      });
    }
    relative = value.slice(root.length).replace(/^\//, "");
  }
  const normalized = path.posix.normalize(relative).replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized === "" || normalized === "." || normalized === "/") {
    throw new PiPodError("receive path must name a file or directory inside the pod workdir", {
      hint: "pass a named entry such as foo",
    });
  }
  return normalized;
}

function commitStagedRoot(root: string, destination: string, rootEntry: ReceivedEntry): void {
  try {
    if (rootEntry.kind === "file") {
      // Staging is beside destination, so this atomically creates the final name and fails
      // rather than replacing a destination that appeared while the server was responding.
      fs.linkSync(root, destination);
      return;
    }
    if (rootEntry.kind !== "dir") throw new PiPodError("server returned an invalid receive root");
    fs.mkdirSync(destination, { mode: 0o700 });
    try {
      for (const name of fs.readdirSync(root)) {
        fs.renameSync(path.join(root, name), path.join(destination, name));
      }
      fs.chmodSync(destination, rootEntry.mode);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw destinationExistsError(destination);
    throw error;
  }
}


function assertDestinationAbsent(destination: string): void {
  try {
    fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new PiPodError(`cannot inspect receive destination ${destination}`, { cause: error });
  }
  throw destinationExistsError(destination);
}

function destinationExistsError(destination: string): PiPodError {
  return new PiPodError(`receive destination already exists: ${destination}`, {
    hint: "move or remove it, then receive again",
  });
}

function decodeCanonicalBase64(contents: string, relPath: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contents) || contents.length % 4 !== 0) {
    throw new PiPodError(`server returned invalid file data: ${relPath || "."}`);
  }
  const decoded = Buffer.from(contents, "base64");
  if (decoded.toString("base64") !== contents) throw new PiPodError(`server returned invalid file data: ${relPath || "."}`);
  return decoded;
}

function symlinkEscapesRoot(relPath: string, target: string): boolean {
  if (relPath === "" || target.startsWith("/") || target.includes("\0") || target.includes("\\")) return true;
  const parent = path.posix.dirname(relPath);
  const resolved = path.posix.normalize(path.posix.join(parent === "." ? "" : parent, target));
  return resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved);
}

function depth(relPath: string): number {
  return relPath === "" ? 0 : relPath.split("/").length;
}
