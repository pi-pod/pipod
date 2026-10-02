/**
 * src/account/workspace-seed.ts — deciding how a source-less launch reaches the pod.
 *
 * A fresh pod workdir starts empty. When the user did not launch from a configured
 * `.pi-pod` project, this module answers "what would faithfully reproduce this working
 * copy inside the pod?" with the cheapest lossless answer: clone the origin remote when
 * the pod can reach the exact commit the user is standing on, and otherwise archive the
 * tree over the wire.
 *
 * Clone is the optimization that has to earn its way in. Every failed eligibility check
 * becomes an `archive` with a reason; `copy` exists only as the legacy configured-project
 * transport over `/pods/:id/files` and is never produced here.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspect } from "node:util";
import { PiPodError } from "../errors.js";
import { registerSecret } from "../redact.js";

export type WorkspaceSeedPlan =
  | { kind: "none"; reason: string }
  | {
      kind: "clone";
      root: string;
      subdir: string;
      url: string;
      branch: string;
      commit: string;
      access: "anonymous" | "credential";
      host: string;
    }
  | {
      kind: "archive";
      root: string;
      subdir: string;
      reason: string;
      includeGit: boolean;
    }
  | { kind: "copy"; root: string; reason: string };

export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a git command in the project and reports its outcome; never throws. */
export type GitRunner = (args: string[], opts?: { stdin?: string; env?: Record<string, string>; timeoutMs?: number }) => GitRun;

const GIT_TIMEOUT_MS = 10_000;
const GIT_NETWORK_TIMEOUT_MS = 20_000;
const GH_AUTH_TIMEOUT_MS = 10_000;
const FULL_SHA = /^[0-9a-f]{40}$/;

const GIT_USER_VAR = "PI_POD_GIT_USER";
const GIT_TOKEN_VAR = "PI_POD_GIT_TOKEN";

/** An inline helper is the only way to hand git credentials that never touch the argv or disk. */
const CREDENTIAL_HELPER = `!f(){ echo "username=$${GIT_USER_VAR}"; echo "password=$${GIT_TOKEN_VAR}"; };f`;

export function makeGitRunner(cwd: string): GitRunner {
  return (args, opts = {}) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      ...(opts.stdin === undefined ? {} : { input: opts.stdin }),
      env: {
        ...process.env,
        ...opts.env,
        // Nothing here may block on a human. `true` answers every prompt with an empty string,
        // which reads as "no credentials" instead of opening a GUI dialog on desktop installs —
        // and unlike `echo`, it does not hand back the prompt text as if it were the answer.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
        SSH_ASKPASS: "true",
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
      },
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

/** The server treats a comment-only script as no script at all; the CLI must agree to match it. */
export function isEffectivelyEmptyInitScript(script: string): boolean {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n").length === 0;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Rewrite a remote the pod cannot use into one it can. scp-style and ssh:// remotes need a key
 * the pod does not have, but they name the same repository as an https URL that a token opens.
 */
export function httpsRemote(url: string): string | null {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+?)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  // A token baked into the remote (`https://oauth2:TOKEN@host/…`) is a credential, not part of
  // the address: it must never be printed, sent, or written into a plan. embeddedCredential()
  // recovers it separately so the probe can still offer it for forwarding.
  if (/^https?:\/\//.test(url)) return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1");
  return null;
}

/**
 * The `user:password@` userinfo of an http(s) remote as a git credential, or null when the URL
 * carries none (or only a username, which git would still have to prompt a password for).
 */
export function embeddedCredential(url: string): GitCredential | null {
  if (!/^https?:\/\//.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password === "") return null;
    const password = decodeURIComponent(parsed.password);
    const username = parsed.username === "" ? "x-access-token" : decodeURIComponent(parsed.username);
    return { username, password };
  } catch {
    return null;
  }
}

export function remoteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Resolves where a source-less launch seeds from. Uses `git rev-parse --show-toplevel` when cwd is inside a work tree, else cwd. */
export type SeedRootResolution =
  | { ok: true; root: string; subdir: string; git: boolean }
  | { ok: false; reason: string };

/**
 * Compare paths after realpath so a home-directory refusal catches `~` itself (including
 * through symlinks) but not a project nested under it.
 */
export function resolveSeedRoot(cwd: string, opts?: { home?: string; git?: GitRunner }): SeedRootResolution {
  const absCwd = path.resolve(cwd);
  if (!pathExists(absCwd)) return { ok: false, reason: `seed root does not exist: ${absCwd}` };

  const git = opts?.git ?? makeGitRunner(absCwd);
  const top = git(["rev-parse", "--show-toplevel"]);
  const fromGit = top.status === 0 && top.stdout.trim() !== "";
  const candidate = fromGit ? path.resolve(absCwd, top.stdout.trim()) : absCwd;
  if (!pathExists(candidate)) return { ok: false, reason: `seed root does not exist: ${candidate}` };

  const root = realpathOrResolve(candidate);
  const realCwd = realpathOrResolve(absCwd);
  if (root === path.parse(root).root) return { ok: false, reason: "refusing to seed from /" };

  const home = realpathOrResolve(opts?.home ?? os.homedir());
  if (root === home) return { ok: false, reason: "refusing to seed from the home directory" };

  return { ok: true, root, subdir: posixSubdir(root, realCwd), git: fromGit };
}

/** Git-ignored root-relative paths; empty set outside git or on failure. */
export function gitIgnoredPaths(root: string, git?: GitRunner): Set<string> {
  const runner = git ?? makeGitRunner(root);
  const listed = runner([
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  const paths = new Set<string>();
  if (listed.status !== 0) {
    // Outside a repository there are no ignore rules. Inside one, an empty set would seed
    // exactly what the rules keep out (.env files, keys) into the pod.
    const inside = runner(["rev-parse", "--is-inside-work-tree"]);
    const repository = inside.status === 0
      ? inside.stdout.trim() === "true"
      : fs.existsSync(path.join(root, ".git")); // git itself failed: assume the rules apply
    if (repository) {
      throw new PiPodError(`could not list the files git ignores in ${root}; nothing was seeded`, {
        hint: "fix the repository (run `git status` there), or seed explicitly with `pipod send`",
      });
    }
    return paths;
  }
  for (const raw of listed.stdout.split("\0")) {
    const relPath = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (relPath !== "") paths.add(relPath);
  }
  return paths;
}

export interface GitCredential { username: string; password: string }

/**
 * A credential that must never be serialized or logged: JSON.stringify omits it, inspect
 * prints `[git credential]`, and the password is registered with the logger's redactor.
 * `use()` hands the raw value to one consumer without exposing a getter.
 */
export class SeedCredential {
  readonly username: string;
  readonly #password: string;

  constructor(credential: GitCredential) {
    this.username = credential.username;
    this.#password = credential.password;
    registerSecret(credential.password);
  }

  use<T>(fn: (credential: GitCredential) => T): T {
    return fn({ username: this.username, password: this.#password });
  }

  toJSON(): undefined {
    return undefined;
  }

  [inspect.custom](): string {
    return "[git credential]";
  }
}

export type WorkspaceSeedProbe =
  | { kind: "archive"; reason: string; includeGit: boolean }
  | { kind: "clone"; url: string; branch: string; commit: string; host: string; access: "anonymous" }
  | { kind: "clone"; url: string; branch: string; commit: string; host: string; access: "credential"; credential: SeedCredential }
  | { kind: "private"; url: string; branch: string; commit: string; host: string };

export interface ProbeWorkspaceSeedOptions {
  root: string;
  git: GitRunner;
  /** "probe" reads and verifies host credentials; "skip" (dry-run / doctor) never reads them and answers `private`. */
  credentials: "probe" | "skip";
  /** Optional egress gate from the resolved pod config: false → archive with reason naming the host and `egress.allow`. */
  egressAllows?: (host: string) => boolean;
  /** GitHub CLI fallback; default runs `gh auth token --hostname <host>`. Return null when unavailable. */
  ghAuthToken?: (host: string) => string | null;
}

export async function probeWorkspaceSeed(opts: ProbeWorkspaceSeedOptions): Promise<WorkspaceSeedProbe> {
  const { git, root } = opts;
  const archive = (reason: string): WorkspaceSeedProbe => ({
    kind: "archive",
    reason,
    includeGit: gitDirIsDirectory(root),
  });

  if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) return archive("not a git repository");

  const origin = git(["remote", "get-url", "origin"]);
  if (origin.status !== 0 || origin.stdout.trim() === "") return archive("no origin remote");
  const rawUrl = origin.stdout.trim();

  const branchOut = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchOut.stdout.trim();
  if (branchOut.status !== 0 || branch === "") return archive("detached HEAD");

  // A status that fails or times out (a huge tree, a locked index) must read as "unknown",
  // never as "clean": a clone chosen on empty output would silently drop uncommitted work.
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) return archive("cannot tell whether the working tree is clean");
  if (status.stdout.trim() !== "") {
    return archive("uncommitted changes would be lost by a clone");
  }

  const upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]);
  if (upstream.status !== 0) return archive(`${branch} is not pushed`);
  const ahead = git(["rev-list", "@{u}..HEAD"]);
  if (ahead.status !== 0 || ahead.stdout.trim() !== "") return archive(`${branch} has unpushed commits`);

  const url = httpsRemote(rawUrl);
  if (url === null) return archive(`origin ${rawUrl} is not a URL the pod can clone`);

  const submodules = git(["submodule", "status"]);
  if (hasInitializedSubmodule(submodules.stdout)) return archive("initialized submodules are not cloned");

  const lfs = git(["ls-files", "-z", "--", ":(attr:filter=lfs)"]);
  if (hasListedPaths(lfs.stdout)) return archive("Git LFS objects would not be cloned");

  const host = remoteHost(url);
  if (opts.egressAllows?.(host) === false) {
    return archive(`egress policy does not allow ${host} (add it to egress.allow)`);
  }

  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  if (!FULL_SHA.test(head)) return archive("cannot read HEAD");
  const commit = head;

  const anonymous = lsRemote(git, url, branch);
  if (anonymous.status === 0) {
    const remoteSha = shaForBranch(anonymous.stdout, branch);
    if (remoteSha === commit) {
      return { kind: "clone", url, branch, commit, host, access: "anonymous" };
    }
    return archive(mismatchReason(branch, remoteSha, commit));
  }

  if (opts.credentials === "skip") {
    return { kind: "private", url, branch, commit, host };
  }

  const ghAuthToken = opts.ghAuthToken ?? defaultGhAuthToken;
  const resolved = embeddedCredential(rawUrl) ?? readCredential(git, url) ?? tokenFromGh(ghAuthToken, host);
  if (!resolved) return archive(`no git credentials for ${host}`);
  registerSecret(resolved.password);

  const authenticated = lsRemote(git, url, branch, {
    [GIT_USER_VAR]: resolved.username,
    [GIT_TOKEN_VAR]: resolved.password,
  });
  if (authenticated.status !== 0) return archive(`git credentials for ${host} do not open ${url}`);
  const authedSha = shaForBranch(authenticated.stdout, branch);
  if (authedSha !== commit) return archive(mismatchReason(branch, authedSha, commit));

  return {
    kind: "clone",
    url,
    branch,
    commit,
    host,
    access: "credential",
    credential: new SeedCredential(resolved),
  };
}

export interface PlanWorkspaceSeedOptions extends ProbeWorkspaceSeedOptions {
  subdir: string;
  /** Asked once, only for a verified private-remote credential; never called otherwise. */
  confirmCredentialForwarding: (host: string) => Promise<boolean>;
}

/**
 * probe + consent. The credential rides beside the plan, never inside it. A `private` probe
 * (`credentials: "skip"`) becomes a clone plan with access `"credential"` and no credential —
 * the caller knows it is a dry-run prediction.
 */
export async function planWorkspaceSeed(
  opts: PlanWorkspaceSeedOptions,
): Promise<{ plan: WorkspaceSeedPlan; credential?: SeedCredential }> {
  const probed = await probeWorkspaceSeed(opts);
  const { root, subdir } = opts;

  if (probed.kind === "archive") {
    return { plan: { kind: "archive", root, subdir, reason: probed.reason, includeGit: probed.includeGit } };
  }

  if (probed.kind === "private") {
    return {
      plan: {
        kind: "clone",
        root,
        subdir,
        url: probed.url,
        branch: probed.branch,
        commit: probed.commit,
        access: "credential",
        host: probed.host,
      },
    };
  }

  if (probed.access === "anonymous") {
    return {
      plan: {
        kind: "clone",
        root,
        subdir,
        url: probed.url,
        branch: probed.branch,
        commit: probed.commit,
        access: "anonymous",
        host: probed.host,
      },
    };
  }

  if (!(await opts.confirmCredentialForwarding(probed.host))) {
    return {
      plan: {
        kind: "archive",
        root,
        subdir,
        reason: "credential forwarding declined",
        includeGit: gitDirIsDirectory(root),
      },
    };
  }

  return {
    plan: {
      kind: "clone",
      root,
      subdir,
      url: probed.url,
      branch: probed.branch,
      commit: probed.commit,
      access: "credential",
      host: probed.host,
    },
    credential: probed.credential,
  };
}

export function describeWorkspaceSeed(plan: WorkspaceSeedPlan): string {
  switch (plan.kind) {
    case "none":
      return plan.reason;
    case "clone": {
      const base = `clone ${plan.url} at ${plan.branch} (${plan.commit.slice(0, 12)})`;
      return plan.access === "credential" ? `${base} with forwarded ${plan.host} credentials` : base;
    }
    case "archive":
      return `archive ${plan.root}${plan.includeGit ? " with .git history" : ""} (${plan.reason})`;
    case "copy":
      return `copy ${plan.root} (${plan.reason})`;
  }
}

function gitDirIsDirectory(root: string): boolean {
  try {
    return fs.lstatSync(path.join(root, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function posixSubdir(root: string, cwd: string): string {
  if (root === cwd) return "";
  const rel = path.relative(root, cwd);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return rel.split(path.sep).join("/");
}

function hasInitializedSubmodule(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    const row = line.replace(/\r$/, "");
    if (row === "") continue;
    const flag = row[0];
    if (flag !== undefined && flag !== "-") return true;
  }
  return false;
}

function hasListedPaths(stdout: string): boolean {
  return stdout.split("\0").some((entry) => entry !== "");
}

function lsRemote(
  git: GitRunner,
  url: string,
  branch: string,
  env?: Record<string, string>,
): GitRun {
  const args = env
    ? ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`, "ls-remote", url, `refs/heads/${branch}`]
    : ["-c", "credential.helper=", "ls-remote", url, `refs/heads/${branch}`];
  return git(args, { ...(env ? { env } : {}), timeoutMs: GIT_NETWORK_TIMEOUT_MS });
}

function shaForBranch(stdout: string, branch: string): string | null {
  const want = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const row = line.replace(/\r$/, "");
    if (row === "") continue;
    const tab = row.indexOf("\t");
    if (tab === -1) continue;
    const sha = row.slice(0, tab).trim();
    const ref = row.slice(tab + 1).trim();
    if (ref === want) return sha;
  }
  return null;
}

function mismatchReason(branch: string, remoteSha: string | null, localSha: string): string {
  const remote = remoteSha && remoteSha.length > 0 ? remoteSha.slice(0, 12) : "missing";
  return `remote ${branch} is at ${remote}, not the local ${localSha.slice(0, 12)}`;
}

function credentialKeyForm(url: string): string {
  const parsed = new URL(url);
  const protocol = parsed.protocol.replace(/:$/, "");
  const host = parsed.host;
  const repoPath = parsed.pathname.replace(/^\/+/, "");
  return `protocol=${protocol}\nhost=${host}\npath=${repoPath}\n\n`;
}

function readCredential(git: GitRunner, url: string): GitCredential | null {
  const filled = git(["credential", "fill"], { stdin: credentialKeyForm(url) });
  if (filled.status !== 0) return null;
  let username = "";
  let password = "";
  for (const line of filled.stdout.split("\n")) {
    const row = line.replace(/\r$/, "");
    if (row.startsWith("username=")) username = row.slice("username=".length).trim();
    else if (row.startsWith("password=")) password = row.slice("password=".length).trim();
  }
  if (password === "") return null;
  return { username: username === "" ? "x-access-token" : username, password };
}

function tokenFromGh(ghAuthToken: (host: string) => string | null, host: string): GitCredential | null {
  const token = ghAuthToken(host);
  if (token === null || token.trim() === "") return null;
  return { username: "x-access-token", password: token.trim() };
}

function defaultGhAuthToken(host: string): string | null {
  const result = spawnSync("gh", ["auth", "token", "--hostname", host], {
    encoding: "utf8",
    timeout: GH_AUTH_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      SSH_ASKPASS: "true",
      GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    },
  });
  if (result.error || (result.status ?? 1) !== 0) return null;
  const token = (result.stdout ?? "").trim();
  return token === "" ? null : token;
}
