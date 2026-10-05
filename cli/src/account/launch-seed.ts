/**
 * src/account/launch-seed.ts — executing a workspace seed plan against a freshly provisioned pod.
 *
 * The plan (see workspace-seed.ts) prefers committed HEAD, with a local-tree archive fallback;
 * this module is the state machine that carries it out and degrades gracefully:
 *
 *   clone plan   → clone succeeds → done
 *                → workspace already populated → skip
 *                → clone fails / endpoint missing → archive
 *   archive plan → tar + stream → done
 *                → too large with .git → retry without history
 *                → endpoint missing → legacy `/files` copy when small enough
 *                → anything else → warn and leave a usable empty pod
 *
 * Nothing here may fail the launch: the pod has already provisioned, and an empty workspace
 * that `pipod send` can fill is strictly better than a billed pod nobody attaches to.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { EgressConfig } from "../config.js";
import { CancelledError, PiPodError } from "../errors.js";
import { color, debug, info, step, warn } from "../log.js";
import { SEND_MAX_BYTES, collectSendEntries } from "../send.js";
import {
  TarballLimitError,
  createTarball,
  seedExclusionRule,
  type CreateTarballOptions,
  type TarballSummary,
} from "../tarball.js";
import type { AccountClient, ApiPod, WorkspaceSeedResult } from "./api.js";
import { displayRef } from "./ref.js";
import { gitIgnoredPaths, type SeedCredential, type WorkspaceSeedPlan } from "./workspace-seed.js";

/** The project env file never travels: its values live in server-custodied secrets now. */
export const SEED_ENV_FILE = ".pi-pod/env";

/** What the seed step did, for the caller's summary line and for tests. */
export type SeedOutcome =
  | { kind: "none"; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "clone"; commit: string; credentialed: boolean }
  | { kind: "archive"; bytes: number; entries: number; includedGit: boolean }
  | { kind: "copy"; entries: number }
  | { kind: "failed"; reason: string };

export interface SeedWorkspaceOptions {
  client: AccountClient;
  pod: ApiPod;
  plan: WorkspaceSeedPlan | undefined;
  credential?: SeedCredential | undefined;
  /** A reused pod keeps its warm workspace; seeding would clobber the previous session's work. */
  reused: boolean;
  /** A co-located pod's workdir is its host's — seeding would overwrite the host's files. */
  coLocated: boolean;
  /**
   * The launch armed the server's seed gate, so Pi waits for this seed. A successful clone or
   * archive opens it on the server; every other ending must release it explicitly, or the pod
   * sits idle until the gate times out.
   */
  gated?: boolean;
  /** Ctrl-C: stops tar generation and the upload as soon as they notice. */
  signal?: AbortSignal | undefined;
  /** Test seam: the tar writer; the real one streams to disk. */
  tarball?: (opts: CreateTarballOptions) => Promise<TarballSummary>;
  /** Where the temporary archive lives; defaults to the OS temp directory. */
  tmpDir?: string;
}

/** Stable failure codes the server uses on the workspace routes; see the plan's §6. */
const WORKSPACE_NOT_EMPTY = "workspace_not_empty";

export async function seedWorkspace(opts: SeedWorkspaceOptions): Promise<SeedOutcome> {
  const outcome = await runSeed(opts);
  if (opts.gated && !seededOnServer(outcome)) await releaseSeedGate(opts, outcome);
  return outcome;
}

async function runSeed(opts: SeedWorkspaceOptions): Promise<SeedOutcome> {
  const { plan } = opts;
  if (!plan || plan.kind === "none") return { kind: "none", reason: plan?.reason ?? "nothing to seed" };
  if (opts.coLocated) {
    warn(
      "workspace seed skipped — a co-located pod shares its host's workdir and must not overwrite it; " +
        "carry files with an init script or `pipod send` instead",
    );
    return { kind: "skipped", reason: "co-located pod" };
  }
  if (opts.reused) {
    info("reusing this pod's warm workspace — nothing copied");
    return { kind: "skipped", reason: "reused pod" };
  }
  switch (plan.kind) {
    case "copy":
      return copyWorkspaceIntoPod(opts, plan.root);
    case "clone":
      return cloneIntoPod(opts, plan);
    case "archive":
      return archiveIntoPod(opts, plan);
  }
}

/** The clone and archive routes record `seeded` and open the gate themselves. */
function seededOnServer(outcome: SeedOutcome): boolean {
  return outcome.kind === "clone" || outcome.kind === "archive";
}

/**
 * Tell the server Pi may start without a seed. Best-effort: the gate times out on its own,
 * so a failed release costs the user a wait, never the pod.
 */
async function releaseSeedGate(opts: SeedWorkspaceOptions, outcome: SeedOutcome): Promise<void> {
  const reason = "reason" in outcome ? outcome.reason : outcome.kind;
  try {
    await opts.client.seedWorkspaceSkip(opts.pod.id, reason);
    debug(`released the workspace seed gate (${reason})`);
  } catch (error) {
    if (opts.signal?.aborted) return;
    warn(
      `could not tell the server to start without a seed: ${describeError(error)} — ` +
        "Pi starts once the seed gate times out on the server",
    );
  }
}

/**
 * Whether the pod's egress policy lets it reach a git host. Only `allowlist` mode restricts
 * anything, and only `egress.allow` admits a git host: `builtins` derives model-provider and
 * base-URL endpoints, never the checkout's remote, and the server's clone route checks the
 * same `allow` list with the same wildcard rule (`*.example.com` covers the apex too). A wrong
 * "yes" costs one failed clone that falls back to an archive.
 */
export function egressAllowsHost(egress: EgressConfig, host: string): boolean {
  if (egress.mode !== "allowlist") return true;
  const bare = host.replace(/:\d+$/, "").toLowerCase();
  return egress.allow.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return bare === base || bare.endsWith(`.${base}`);
    }
    return pattern === bare;
  });
}

// --- clone ---------------------------------------------------------------------------------

async function cloneIntoPod(
  opts: SeedWorkspaceOptions,
  plan: Extract<WorkspaceSeedPlan, { kind: "clone" }>,
): Promise<SeedOutcome> {
  const ref = displayRef(opts.pod.id, "pod");
  const credentialed = plan.access === "credential";
  if (credentialed && !opts.credential) {
    // A dry-run prediction reached a real launch: nothing was probed, so nothing is forwarded.
    return archiveIntoPod(opts, {
      kind: "archive",
      root: plan.root,
      subdir: plan.subdir,
      reason: `no verified git credentials for ${plan.host}`,
      includeGit: isRealGitDir(plan.root),
    });
  }
  step(
    "seed",
    `cloning ${plan.url} at ${plan.branch} (${plan.commit.slice(0, 12)}) → pod ${ref}` +
      (credentialed ? ` with forwarded ${plan.host} credentials` : ""),
  );
  const body = {
    url: plan.url,
    branch: plan.branch,
    commit: plan.commit,
    ...(credentialed && opts.credential
      ? { credential: opts.credential.use((c) => ({ username: c.username, password: c.password })) }
      : {}),
  };
  try {
    const result = await opts.client.seedWorkspaceClone(opts.pod.id, body, { signal: opts.signal });
    info(`workspace seeded: cloned ${plan.branch} at ${(result.commit ?? plan.commit).slice(0, 12)}${timing(result)}`);
    return { kind: "clone", commit: result.commit ?? plan.commit, credentialed };
  } catch (error) {
    throwIfCancelled(opts, error);
    if (isWorkspaceNotEmpty(error)) {
      info("workspace already populated (an init script filled it) — leaving it in place");
      return { kind: "skipped", reason: "workspace not empty" };
    }
    const reason = describeError(error);
    if (isMissingRoute(error)) {
      info("this server predates workspace cloning — sending an archive instead");
    } else {
      warn(`clone failed: ${reason} — falling back to an archive of the local working tree (including uncommitted changes)`);
    }
    return archiveIntoPod(
      opts,
      {
        kind: "archive",
        root: plan.root,
        subdir: plan.subdir,
        reason: isMissingRoute(error) ? "server lacks the clone route" : `clone failed: ${reason}`,
        includeGit: isRealGitDir(plan.root),
      },
      { legacyServer: isMissingRoute(error) },
    );
  }
}

// --- archive -------------------------------------------------------------------------------

async function archiveIntoPod(
  opts: SeedWorkspaceOptions,
  plan: Extract<WorkspaceSeedPlan, { kind: "archive" }>,
  flags: { legacyServer?: boolean } = {},
): Promise<SeedOutcome> {
  if (flags.legacyServer) return copyWorkspaceIntoPod(opts, plan.root);
  const ref = displayRef(opts.pod.id, "pod");
  const ignored = gitIgnoredPaths(plan.root);
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const archivePath = path.join(tmpDir, `pi-pod-seed-${randomBytes(8).toString("hex")}.tar.gz`);
  const write = opts.tarball ?? createTarball;
  try {
    let summary: TarballSummary;
    let includeGit = plan.includeGit;
    step("seed", `archiving ${plan.root}${includeGit ? " with .git history" : ""} (${plan.reason})`);
    try {
      summary = await write(tarballOptions(opts, plan.root, archivePath, ignored, includeGit));
    } catch (error) {
      throwIfCancelled(opts, error);
      if (!(error instanceof TarballLimitError) || !includeGit) throw error;
      // History is the one optional part of the tree: drop it before giving up on the seed.
      warn(`${error.message} — retrying without .git history`);
      includeGit = false;
      summary = await write(tarballOptions(opts, plan.root, archivePath, ignored, includeGit));
    }
    if (summary.entries === 0) {
      info("nothing to seed — the local directory is empty");
      return { kind: "none", reason: "empty directory" };
    }
    reportSkipped(summary.skipped.map((entry) => entry.relPath), opts.client.isPodToken);
    step(
      "seed",
      `uploading ${formatBytes(summary.compressedBytes)} archive (${summary.entries} entr${summary.entries === 1 ? "y" : "ies"}, ` +
        `${formatBytes(summary.bytes)} uncompressed) → pod ${ref}`,
    );
    try {
      const result = await opts.client.seedWorkspaceArchive(
        opts.pod.id,
        { filePath: archivePath, bytes: summary.compressedBytes },
        { signal: opts.signal, onProgress: uploadProgress(summary.compressedBytes) },
      );
      info(`workspace seeded from archive${summary.includedGit ? " with .git history" : ""}${timing(result)}`);
      if (plan.subdir !== "") {
        info(color.dim(`launched from ${plan.subdir}/ — the pod's workspace root is the repository root`));
      }
      return { kind: "archive", bytes: summary.compressedBytes, entries: summary.entries, includedGit: summary.includedGit };
    } catch (error) {
      throwIfCancelled(opts, error);
      if (isWorkspaceNotEmpty(error)) {
        info("workspace already populated (an init script filled it) — leaving it in place");
        return { kind: "skipped", reason: "workspace not empty" };
      }
      if (isMissingRoute(error)) {
        if (summary.bytes <= SEND_MAX_BYTES) {
          info("this server predates workspace archives — copying files individually instead");
          return copyWorkspaceIntoPod(opts, plan.root);
        }
        warn(
          `could not seed the workspace: this server predates workspace archives and the tree ` +
            `(${formatBytes(summary.bytes)}) exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB send limit — ` +
            "the pod starts empty; `pipod send <path>` copies in what it needs",
        );
        return { kind: "failed", reason: "server lacks the archive route and the tree exceeds the send limit" };
      }
      throw error;
    }
  } catch (error) {
    throwIfCancelled(opts, error);
    const reason = describeError(error);
    warn(`could not seed the workspace: ${reason} — the pod starts empty; \`pipod send <path>\` copies in what it needs`);
    return { kind: "failed", reason };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

function tarballOptions(
  opts: SeedWorkspaceOptions,
  root: string,
  outputPath: string,
  ignored: ReadonlySet<string>,
  includeGit: boolean,
): CreateTarballOptions {
  const exclude = seedExclusionRule({ ignored, includeGit });
  let lastReported = 0;
  return {
    root,
    outputPath,
    includeGit,
    skipSymlinks: opts.client.isPodToken,
    exclude: (name, relPath) => relPath === SEED_ENV_FILE || exclude(name, relPath),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: ({ entries, bytes }) => {
      // Progress belongs in the debug stream at a coarse pace: a launch is a narrative, not a meter.
      if (bytes - lastReported < 64 * 1024 * 1024) return;
      lastReported = bytes;
      debug(`seed archive: ${entries} entries, ${formatBytes(bytes)} so far`);
    },
  };
}

/** A line at each quarter of an upload big enough to wait for; a small one is done before it helps. */
function uploadProgress(total: number): (sent: number) => void {
  const marks = [0.25, 0.5, 0.75];
  let next = 0;
  return (sent) => {
    if (total < 8 * 1024 * 1024) return;
    let crossed = false;
    while (next < marks.length && sent >= total * marks[next]!) {
      next += 1;
      crossed = true;
    }
    if (crossed) info(color.dim(`upload ${Math.round((sent / total) * 100)}% (${formatBytes(sent)} of ${formatBytes(total)})`));
  };
}

// --- legacy copy ---------------------------------------------------------------------------

/** Trees that belong to the host machine, never to the pod's copy of the workspace. */
const NEVER_SEEDED = new Set([".git", "node_modules"]);

/**
 * Place the local tree in a fresh pod's workdir one JSON entry at a time. This is the transport
 * configured projects have always used, and the fallback for servers without the archive route.
 * Best-effort by design: an oversized or rejected copy leaves a usable session with an empty
 * workspace, which `pipod send` can still fill.
 */
async function copyWorkspaceIntoPod(opts: SeedWorkspaceOptions, projectRoot: string): Promise<SeedOutcome> {
  const { client, pod } = opts;
  try {
    const ignored = gitIgnoredPaths(projectRoot);
    const { entries, skippedSymlinks } = collectSendEntries(projectRoot, {
      relBase: "",
      label: projectRoot,
      skipSymlinks: client.isPodToken,
      exclude: (name, relPath) => NEVER_SEEDED.has(name) || relPath === SEED_ENV_FILE || ignored.has(relPath),
    });
    if (entries.length === 0) {
      info("nothing to seed — the local directory is empty");
      return { kind: "none", reason: "empty directory" };
    }
    step("seed", `copying ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → pod ${displayRef(pod.id, "pod")}`);
    await client.request(`/pods/${pod.id}/files`, { method: "POST", body: { entries }, signal: opts.signal });
    reportSkipped(skippedSymlinks, true);
    info("workspace seeded");
    return { kind: "copy", entries: entries.length };
  } catch (error) {
    throwIfCancelled(opts, error);
    const reason = describeError(error);
    warn(`could not seed the workspace: ${reason} — the pod starts empty; \`pipod send <path>\` copies in what it needs`);
    return { kind: "failed", reason };
  }
}

// --- helpers -------------------------------------------------------------------------------

function reportSkipped(paths: string[], podToken: boolean): void {
  if (paths.length === 0) return;
  const shown = paths.slice(0, 5).join(", ") + (paths.length > 5 ? `, … (${paths.length} total)` : "");
  warn(
    podToken
      ? `skipped ${paths.length} symlink(s) this server will not accept from a pod: ${shown}`
      : `skipped ${paths.length} entr${paths.length === 1 ? "y" : "ies"} that cannot travel (special files or symlinks leaving the tree): ${shown}`,
  );
}

function isRealGitDir(root: string): boolean {
  try {
    return fs.lstatSync(path.join(root, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function isMissingRoute(error: unknown): boolean {
  return error instanceof PiPodError && error.status === 404;
}

function isWorkspaceNotEmpty(error: unknown): boolean {
  if (!(error instanceof PiPodError) || error.status !== 409) return false;
  return error.code === WORKSPACE_NOT_EMPTY || error.message.includes(WORKSPACE_NOT_EMPTY);
}

function throwIfCancelled(opts: SeedWorkspaceOptions, error: unknown): void {
  if (error instanceof CancelledError) throw error;
  if (opts.signal?.aborted) throw new CancelledError("interrupted");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timing(result: WorkspaceSeedResult): string {
  return typeof result.durationMs === "number" && result.durationMs >= 100
    ? color.dim(` (${(result.durationMs / 1000).toFixed(1)}s on the server)`)
    : "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
