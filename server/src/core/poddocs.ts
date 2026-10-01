/**
 * src/poddocs.ts — ship the installed pi-pod's own documentation into every pod.
 *
 * The agent inside a pod is asked about the pod it runs in: what `.pi-pod/` keys mean, why
 * egress blocked a download, how detach works. Its only source of truth for those answers is
 * pi-pod's own documentation, and the *right* version of that documentation is the one that
 * shipped with the launcher driving this session — not whatever the model remembers, and not
 * a copy baked into an image that may predate the launcher (§12).
 *
 * So the docs travel the same path as the shim and the generated extension: read from the
 * installed package at launch time and uploaded on every launch and every rung-2 reattach.
 * An upgrade therefore refreshes the docs on the next attach, with no image rebuild.
 *
 * What is *not* done is pushing the full text into the system prompt — reference.md alone is
 * two thousand lines, and it is needed only when the conversation turns to pi-pod. The
 * generated extension instead appends a short pointer to the system prompt (see
 * src/shim/pi-pod-ext.ts) and the agent reads the files on demand.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "./image.js";
import { debug } from "./log.js";
import type { Sandbox } from "./providers/types.js";

/** Where the launcher uploads the documentation inside the pod. */
export const POD_DOCS_DIR = "/tmp/pi-pod-docs";

/** Documentation that lives at the package root rather than under `docs/`. */
const ROOT_DOC_FILES = ["README.md"] as const;

export interface PodDocFile {
  /** Bare file name — docs are uploaded flat into {@link POD_DOCS_DIR}. */
  name: string;
  contents: Uint8Array;
}

/**
 * The documentation shipped with *this* pi-pod install, or an empty list when the package has
 * no docs directory (a stripped-down install). Never throws: missing docs degrade to a pod
 * without the pointer, not to a session that cannot start.
 */
export function readPodDocs(root: string = packageRoot()): PodDocFile[] {
  const docs: PodDocFile[] = [];
  try {
    const dir = path.join(root, "docs");
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      docs.push({ name, contents: fs.readFileSync(path.join(dir, name)) });
    }
  } catch {
    // No docs directory in this install — nothing to ship.
  }
  for (const name of ROOT_DOC_FILES) {
    try {
      docs.push({ name, contents: fs.readFileSync(path.join(root, name)) });
    } catch {
      // A missing root doc is as unremarkable as a missing docs directory.
    }
  }
  return docs;
}

/**
 * Upload the documentation into the pod. `uploadFile` creates the destination directory
 * (Sandbox contract), and re-uploading over a previous generation's copy is the point: the
 * pod ends up with exactly the docs of the launcher now driving it. Returns the file names
 * uploaded, so the caller can bake them into the generated extension's pointer.
 */
export async function uploadPodDocs(sandbox: Sandbox, docs: PodDocFile[] = readPodDocs()): Promise<string[]> {
  if (docs.length === 0) {
    debug("no pi-pod documentation found in this install — the pod goes without it");
    return [];
  }
  for (const doc of docs) {
    await sandbox.uploadFile(path.posix.join(POD_DOCS_DIR, doc.name), doc.contents, 0o644);
  }
  return docs.map((doc) => doc.name);
}
