/**
 * Pod-side workspace file listing for the launcher's `@` autocomplete: standalone JS
 * spliced into the generated extension, mirrored by loadFileListLogic() so tests cannot
 * drift.
 *
 * The launcher embeds pi's InteractiveMode on the user's machine, so pi-tui's own `@`
 * completion enumerates the *laptop's* filesystem while every path the agent can act on
 * lives in the pod. This walker answers from the pod's own cwd instead.
 *
 * Deliberately not a `.gitignore` parser and deliberately not `fd`: the pod runs
 * `pi --mode rpc`, which never downloads pi's managed `fd`, and a fixed ignore set covers
 * the noise that matters. Caps below are part of the v1 contract — export them and keep the
 * generated source on the same literals.
 *
 * - FILE_LIST_MAX_RESULTS entries returned (50), so a reply never needs chunking
 * - FILE_LIST_MAX_SCANNED_ENTRIES readdir results examined (20,000)
 * - FILE_LIST_MAX_SCAN_MS wall-clock budget (300 ms), because this is per keystroke
 * - FILE_LIST_MAX_QUERY_LENGTH request query cap (512)
 */

/** Entries returned for one query; small enough that the reply never needs chunking. */
export const FILE_LIST_MAX_RESULTS = 50;
/** Directory entries examined before the walk gives up and reports itself incomplete. */
export const FILE_LIST_MAX_SCANNED_ENTRIES = 20_000;
/** Wall-clock budget for one walk; this runs per keystroke, so it is deliberately tight. */
export const FILE_LIST_MAX_SCAN_MS = 300;
/** Longest `@` query the pod will consider. */
export const FILE_LIST_MAX_QUERY_LENGTH = 512;
/** Never descended into. Not configurable: the contract is a fixed set, not a policy. */
export const FILE_LIST_IGNORED_DIRECTORIES = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
];

export type FileListFs = typeof import("node:fs");

export type FileListEntry = {
  /** Relative to the walk root, `/`-suffixed for directories so pi's applyCompletion agrees. */
  path: string;
  dir: boolean;
};

export type FileListData = {
  entries: FileListEntry[];
  /** False when a cap cut the walk short — the caller may show "more matches exist". */
  complete: boolean;
};

export type FileListOptions = {
  cwd: string;
  query?: string;
  now?: () => number;
  maxResults?: number;
  maxScannedEntries?: number;
  maxScanMs?: number;
};

/** Standalone JS spliced into the generated extension. */
export const FILE_LIST_LOGIC = `
const FILE_LIST_MAX_RESULTS = ${FILE_LIST_MAX_RESULTS};
const FILE_LIST_MAX_SCANNED_ENTRIES = ${FILE_LIST_MAX_SCANNED_ENTRIES};
const FILE_LIST_MAX_SCAN_MS = ${FILE_LIST_MAX_SCAN_MS};
const FILE_LIST_IGNORED_DIRECTORIES = ${JSON.stringify(FILE_LIST_IGNORED_DIRECTORIES)};

function fileListJoin(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return String(left).replace(/\\/+$/, "") + "/" + String(right).replace(/^\\/+/, "");
}

/**
 * Subsequence match, the same shape pi-tui's fuzzyFilter uses, so a pod-side prefilter
 * never hides a candidate the client would have ranked. Case-insensitive.
 */
function fileListMatches(candidate, needle) {
  if (!needle) return true;
  const haystack = candidate.toLowerCase();
  const query = needle.toLowerCase();
  let at = 0;
  for (let i = 0; i < query.length; i++) {
    at = haystack.indexOf(query[i], at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

/**
 * Breadth-first so shallow matches — the ones a person means — are found before the walk
 * spends its budget deep in a tree.
 *
 * Descent is limited to entries readdir reports as real directories, which is also what
 * keeps the walk inside the workspace: a Dirent for a symlink answers isDirectory() false
 * however the link points, so a link out of the pod's cwd is offered as a completion but
 * never followed.
 */
function buildFileList(fs, options) {
  options = options || {};
  const root = String(options.cwd || "");
  const rawQuery = typeof options.query === "string" ? options.query : "";
  const maxResults = options.maxResults || FILE_LIST_MAX_RESULTS;
  const maxScanned = options.maxScannedEntries || FILE_LIST_MAX_SCANNED_ENTRIES;
  const maxScanMs = options.maxScanMs || FILE_LIST_MAX_SCAN_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const started = now();

  const entries = [];
  if (!root) return { entries: entries, complete: false };

  // "src/rem" can only be satisfied under src/, so start there instead of at the root.
  const slash = rawQuery.lastIndexOf("/");
  const queue = [slash === -1 ? "" : rawQuery.slice(0, slash + 1)];
  let scanned = 0;
  let complete = true;

  while (queue.length > 0) {
    if (entries.length >= maxResults) { complete = false; break; }
    if (scanned >= maxScanned) { complete = false; break; }
    if (now() - started > maxScanMs) { complete = false; break; }

    const relative = queue.shift();
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(fileListJoin(root, relative) || root, { withFileTypes: true });
    } catch (e) {
      // A directory we cannot read (permissions, or a cwd that no longer exists) makes the
      // answer partial; saying "complete" here would claim the workspace really is empty.
      complete = false;
      continue;
    }

    for (let i = 0; i < dirEntries.length; i++) {
      if (entries.length >= maxResults) { complete = false; break; }
      scanned++;
      const entry = dirEntries[i];
      const isDir = entry.isDirectory();
      const childRelative = fileListJoin(relative, entry.name);
      const display = isDir ? childRelative + "/" : childRelative;
      if (fileListMatches(display, rawQuery)) entries.push({ path: display, dir: isDir });
      if (isDir && FILE_LIST_IGNORED_DIRECTORIES.indexOf(entry.name) === -1) queue.push(childRelative);
    }
  }

  if (queue.length > 0) complete = false;
  return { entries: entries, complete: complete };
}
`;

/** Evaluate the spliced source exactly as the pod does, so tests cannot drift from it. */
export function loadFileListLogic(): {
  buildFileList: (fs: FileListFs, options: FileListOptions) => FileListData;
  fileListMatches: (candidate: string, needle: string) => boolean;
} {
  return new Function(
    `${FILE_LIST_LOGIC}; return { buildFileList, fileListMatches };`,
  )() as ReturnType<typeof loadFileListLogic>;
}
