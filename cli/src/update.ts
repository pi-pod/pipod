/**
 * src/update.ts — `pipod update`.
 *
 * pi pod can be installed two ways, and they upgrade by completely different means: a git
 * checkout (including the `npm link` case, where the global command is a symlink into a
 * working tree) is upgraded by pulling and rebuilding, while a registry install is upgraded
 * by npm. Asking the user to remember which one they did — and, for a checkout, to remember
 * that `dist/` is a build artifact so a pull alone changes nothing — is the failure this
 * command exists to remove.
 *
 * It is deliberately conservative about the checkout case: that directory is the user's own
 * repository, not private launcher state, so this refuses anything that could disturb work
 * in it rather than trying to be clever.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PiPodError } from "./errors.js";
import { packageRoot } from "./image.js";
import { color, info, out, plain, warn } from "./log.js";

export type Install =
  /** A working tree: `npm link`, or a clone run in place. */
  | { kind: "git"; root: string }
  /** Unpacked under node_modules by a package manager. */
  | { kind: "npm"; root: string; name: string }
  | { kind: "unknown"; root: string };

interface Run {
  ok: boolean;
  out: string;
}

function run(cmd: string, args: string[], cwd: string): Run {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Streams to the terminal — used for the slow steps, where silence looks like a hang. */
function runVisible(cmd: string, args: string[], cwd: string): boolean {
  return spawnSync(cmd, args, { cwd, stdio: "inherit" }).status === 0;
}

export function detectInstall(root: string = packageRoot()): Install {
  // A submodule's .git is a file, so existence is the test, not isDirectory().
  if (fs.existsSync(path.join(root, ".git"))) return { kind: "git", root };
  // The open-source repository keeps the CLI in its cli/ directory: a working tree that
  // contains this package is a checkout too.
  if (!root.split(path.sep).includes("node_modules") && run("git", ["rev-parse", "--is-inside-work-tree"], root).out === "true") {
    return { kind: "git", root };
  }

  if (root.split(path.sep).includes("node_modules")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name) return { kind: "npm", root, name: pkg.name };
    } catch {
      // fall through
    }
  }
  return { kind: "unknown", root };
}

function versionAt(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface UpdateOptions {
  /** `--dry-run`: report what an update would do, change nothing. */
  dryRun: boolean;
  /** Test seam: which install to act on, instead of the running launcher's own. */
  root?: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const install = detectInstall(opts.root ?? packageRoot());

  switch (install.kind) {
    case "git":
      return updateCheckout(install.root, opts);
    case "npm":
      return updateFromRegistry(install.root, install.name, opts);
    default:
      throw new PiPodError(`cannot tell how pi pod was installed (${install.root})`, {
        hint: "reinstall from a git checkout (npm link) or from the registry, then retry",
      });
  }
}

// ---------------------------------------------------------------------------
// git checkout
// ---------------------------------------------------------------------------

async function updateCheckout(root: string, opts: UpdateOptions): Promise<void> {
  const before = versionAt(root);
  info(`${color.bold(before)} from a git checkout at ${root}`);

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (!branch.ok) throw new PiPodError(`not a usable git checkout: ${branch.out}`);
  const head = branch.out;

  // The upstream of the current branch, not a guessed origin/main: someone tracking a fork
  // or a release branch must not be silently pulled onto something else.
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root);
  if (!upstream.ok) {
    throw new PiPodError(`branch "${head}" has no upstream to update from`, {
      hint: `set one with: git -C ${root} branch --set-upstream-to origin/${head}`,
    });
  }

  if (!run("git", ["fetch", "--quiet", "--prune"], root).ok) {
    // Offline is a normal state, and it is not a reason to touch anything.
    throw new PiPodError("could not reach the git remote", {
      hint: "check your network; nothing has been changed",
    });
  }

  const local = run("git", ["rev-parse", "HEAD"], root).out;
  const remote = run("git", ["rev-parse", upstream.out], root).out;

  if (local === remote) {
    // Still worth a rebuild check: dist/ is generated and can lag the source it came from.
    if (distIsStale(root)) {
      info(`already at the latest commit, but ${color.bold("dist/")} is older than src — rebuilding`);
      if (opts.dryRun) return void info("--dry-run: would run npm run build");
      return rebuild(root, before);
    }
    info(`already up to date (${head} → ${upstream.out})`);
    return;
  }

  const behind = run("git", ["rev-list", "--count", `HEAD..${upstream.out}`], root).out;
  const ahead = run("git", ["rev-list", "--count", `${upstream.out}..HEAD`], root).out;

  if (ahead !== "0") {
    throw new PiPodError(`your checkout has ${ahead} commit(s) ${upstream.out} does not`, {
      hint: `push or rebase them yourself — update will not rewrite your history (git -C ${root} status)`,
    });
  }

  info(`${behind} new commit(s) on ${upstream.out}:`);
  const log = run("git", ["log", "--oneline", "--no-decorate", `HEAD..${upstream.out}`], root);
  for (const line of log.out.split("\n").filter(Boolean).slice(0, 10)) plain(`    ${line}`);

  // A dirty tree is checked only once there is something to pull: refusing to *report*
  // available updates because of unrelated edits would be gratuitous.
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], root);
  if (dirty.out !== "") {
    throw new PiPodError("your checkout has uncommitted changes", {
      hint: `commit or stash them first — update will not touch your working tree (git -C ${root} status)`,
    });
  }

  if (opts.dryRun) {
    info(`--dry-run: would fast-forward to ${upstream.out}, then npm install && npm run build`);
    return;
  }

  // --ff-only so a diverged history is a clean refusal rather than a merge commit in a
  // repository the user did not ask us to write to.
  if (!runVisible("git", ["merge", "--ff-only", upstream.out], root)) {
    throw new PiPodError(`could not fast-forward to ${upstream.out}`, {
      hint: `resolve it by hand: git -C ${root} status`,
    });
  }

  return rebuild(root, before);
}

/** dist/ is generated, so a pull that changed src leaves the installed command stale. */
export function distIsStale(root: string): boolean {
  // Order matters: without sources there is nothing to build, so a missing dist/ means this
  // is not a buildable checkout rather than a stale one. Answering "stale" there would send
  // a packaged install into an npm build it cannot run.
  const srcDir = path.join(root, "src");
  if (!fs.existsSync(srcDir)) return false;

  const dist = path.join(root, "dist", "cli.js");
  if (!fs.existsSync(dist)) return true;
  const distTime = fs.statSync(dist).mtimeMs;

  const newest = (dir: string): number => {
    let max = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      max = Math.max(max, entry.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }
    return max;
  };
  return newest(srcDir) > distTime;
}

function rebuild(root: string, before: string): void {
  // Dependencies move with the source, and a build against stale ones fails confusingly.
  info("installing dependencies…");
  if (!runVisible("npm", ["install", "--no-audit", "--no-fund"], root)) {
    throw new PiPodError("npm install failed", { hint: `run it by hand in ${root}` });
  }

  info("building…");
  if (!runVisible("npm", ["run", "build"], root)) {
    throw new PiPodError("build failed — the installed pi pod is unchanged", {
      hint: `run \`npm run build\` in ${root} to see the error`,
    });
  }

  const after = versionAt(root);
  const head = run("git", ["rev-parse", "--short", "HEAD"], root).out;
  plain("");
  info(after === before ? `now at ${color.bold(after)} (${head})` : `updated ${before} → ${color.bold(after)} (${head})`);
  // The same checkout can also be the one a self-hosted server was deployed from.
  const upgrade = path.join(run("git", ["rev-parse", "--show-toplevel"], root).out, "selfhost", "upgrade");
  if (fs.existsSync(upgrade)) out(`if this checkout runs your server, upgrade it to match: ${upgrade}`);
  out("run `pipod doctor` to check the new version against this repo");
}

// ---------------------------------------------------------------------------
// registry install
// ---------------------------------------------------------------------------

async function updateFromRegistry(root: string, name: string, opts: UpdateOptions): Promise<void> {
  const before = versionAt(root);
  info(`${color.bold(before)} installed from the registry as ${name}`);

  const view = run("npm", ["view", `${name}@latest`, "version"], process.cwd());
  if (!view.ok) {
    throw new PiPodError(`could not reach the npm registry for ${name}`, {
      hint: "check your network, or update with your package manager directly",
    });
  }

  const latest = view.out.trim();
  if (latest === before) {
    info(`already up to date (${latest})`);
    return;
  }

  if (opts.dryRun) {
    info(`--dry-run: would run npm install -g ${name}@${latest}`);
    return;
  }

  info(`updating ${before} → ${color.bold(latest)}…`);
  if (!runVisible("npm", ["install", "-g", `${name}@${latest}`], process.cwd())) {
    // A global install under a root-owned prefix is the usual cause, and telling the user to
    // rerun with sudo is better than leaving them with an opaque EACCES.
    throw new PiPodError(`npm install -g ${name}@${latest} failed`, {
      hint: `if this is a permissions error, run it again yourself with the rights your npm prefix needs`,
    });
  }

  plain("");
  info(`updated ${before} → ${color.bold(latest)}`);
  warn("open a new shell if your terminal caches command paths");
}
