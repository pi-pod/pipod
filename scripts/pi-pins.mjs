#!/usr/bin/env node
/**
 * One pin for the pi that pods run.
 *
 *   node scripts/pi-pins.mjs check
 *   node scripts/pi-pins.mjs tag
 *   node scripts/pi-pins.mjs bump <x.y.z|latest>
 *   node scripts/pi-pins.mjs bump <x.y.z|latest> --dry-run
 *   node scripts/pi-pins.mjs bump <x.y.z|latest> --skip-checks
 *
 * `check` reads package.json + package-lock.json only (no node_modules). `bump`
 * exact-pins both checkouts, sets pi-tui to the copy that pi loads, and runs the
 * canaries. Image tags are derived from the pin — do not edit image/Dockerfile.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const TUI_PACKAGE = "@earendil-works/pi-tui";
export const IMAGE_NAME = "pi-pod-base";
export const IMAGE_RECIPE_SCHEMA = 1;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, "..");

export const isExactVersion = (spec) =>
  typeof spec === "string" &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(spec);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const nestedTuiKey = `node_modules/${PI_PACKAGE}/node_modules/${TUI_PACKAGE}`;
const topTuiKey = `node_modules/${TUI_PACKAGE}`;
const piLockKey = `node_modules/${PI_PACKAGE}`;

/**
 * Digest the launcher-owned Dockerfile the same way `managedImageAssetDigest` and
 * publish-sandbox-base.yml do. The path prefix in the hash is the literal
 * `image/Dockerfile`, not the real path.
 */
export function managedAssetDigest(dockerfilePath) {
  const stat = fs.lstatSync(dockerfilePath);
  return createHash("sha256")
    .update(`image/Dockerfile\0${stat.mode & 0o777}\0`)
    .update(fs.readFileSync(dockerfilePath))
    .update("\0")
    .digest("hex")
    .slice(0, 12);
}

export function derivedBaseTag({ piVersion, dockerfilePath }) {
  return `${IMAGE_NAME}:r${IMAGE_RECIPE_SCHEMA}-pi${piVersion}-img${managedAssetDigest(dockerfilePath)}`;
}

export function workspaceRepos(root = WORKSPACE_ROOT) {
  return [
    { name: "cli", dir: path.join(root, "cli") },
    { name: "server", dir: path.join(root, "server") },
  ];
}

export function inspectRepo(dir) {
  const issues = [];
  const pkgPath = path.join(dir, "package.json");
  const lockPath = path.join(dir, "package-lock.json");
  if (!fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) {
    return {
      dir,
      name: path.basename(dir),
      piPin: undefined,
      tuiPin: undefined,
      piLocked: undefined,
      tuiNested: undefined,
      issues: [`${dir} is missing package.json or package-lock.json`],
    };
  }
  const pkg = readJson(pkgPath);
  const deps = pkg.dependencies ?? {};
  const packages = readJson(lockPath).packages ?? {};
  const piPin = deps[PI_PACKAGE];
  const tuiPin = deps[TUI_PACKAGE];
  const piLocked = packages[piLockKey]?.version;
  const tuiNested = packages[nestedTuiKey]?.version ?? packages[topTuiKey]?.version;
  const name = pkg.name ?? path.basename(dir);

  if (!isExactVersion(piPin)) {
    issues.push(`${name}: ${PI_PACKAGE} is ${piPin === undefined ? "missing" : `"${piPin}"`} — pin the exact version`);
  } else if (piLocked === undefined) {
    issues.push(`${name}: ${PI_PACKAGE} is not in package-lock.json`);
  } else if (piPin !== piLocked) {
    issues.push(`${name}: ${PI_PACKAGE} package.json has ${piPin} but the lockfile has ${piLocked}`);
  }

  if (!isExactVersion(tuiPin)) {
    issues.push(
      `${name}: ${TUI_PACKAGE} is ${tuiPin === undefined ? "missing" : `"${tuiPin}"`} — pin the exact version, as pi itself is`,
    );
  } else if (tuiNested === undefined) {
    issues.push(`${name}: ${TUI_PACKAGE} is not in package-lock.json beside ${PI_PACKAGE}`);
  } else if (tuiPin !== tuiNested) {
    issues.push(`${name}: ${TUI_PACKAGE} pinned ${tuiPin}, but pi ${piLocked ?? piPin} loads ${tuiNested}`);
  }

  return { dir, name, piPin, tuiPin, piLocked, tuiNested, issues };
}

export function collectIssues(root = WORKSPACE_ROOT) {
  const repos = workspaceRepos(root).map((r) => inspectRepo(r.dir));
  const issues = repos.flatMap((r) => r.issues);
  const [cli, server] = repos;
  if (cli?.piLocked && server?.piLocked && cli.piLocked !== server.piLocked) {
    issues.push(
      `pi lockfile mismatch: cli has ${cli.piLocked} but server has ${server.piLocked} — pods must match the server bundle`,
    );
  }
  if (cli?.piPin && server?.piPin && isExactVersion(cli.piPin) && isExactVersion(server.piPin) && cli.piPin !== server.piPin) {
    issues.push(`pi package.json mismatch: cli has ${cli.piPin} but server has ${server.piPin}`);
  }
  return { repos, issues };
}

export function dockerfileForTag(root = WORKSPACE_ROOT) {
  const serverFile = path.join(root, "server", "image", "Dockerfile");
  const cliFile = path.join(root, "cli", "image", "Dockerfile");
  if (fs.existsSync(serverFile)) return serverFile;
  if (fs.existsSync(cliFile)) return cliFile;
  return null;
}

export function currentManagedTag(root = WORKSPACE_ROOT) {
  const { repos, issues } = collectIssues(root);
  const piVersion = repos.find((r) => path.basename(r.dir) === "server")?.piLocked ?? repos[0]?.piLocked;
  const dockerfile = dockerfileForTag(root);
  if (!piVersion || !dockerfile) {
    return { tag: null, issues };
  }
  return { tag: derivedBaseTag({ piVersion, dockerfilePath: dockerfile }), issues };
}

function npm(cwd, args, opts = {}) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: opts.stdio ?? "inherit",
    timeout: opts.timeout ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`npm ${args.join(" ")} failed in ${cwd}${detail ? `\n${detail}` : ""}`);
  }
  return result;
}

export function latestPublishedPi() {
  const result = spawnSync("npm", ["view", `${PI_PACKAGE}@latest`, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`could not ask npm for the latest ${PI_PACKAGE}: ${(result.stderr || result.stdout).trim()}`);
  }
  const version = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (!isExactVersion(version)) throw new Error(`npm view returned a non-version: ${JSON.stringify(version)}`);
  return version;
}

function installedNestedTui(dir) {
  const nested = path.join(dir, "node_modules", PI_PACKAGE, "node_modules", TUI_PACKAGE, "package.json");
  const top = path.join(dir, "node_modules", TUI_PACKAGE, "package.json");
  const file = fs.existsSync(nested) ? nested : top;
  if (!fs.existsSync(file)) {
    throw new Error(`after installing ${PI_PACKAGE}, ${TUI_PACKAGE} was not on disk in ${dir}`);
  }
  const version = readJson(file).version;
  if (!isExactVersion(version)) throw new Error(`${TUI_PACKAGE} at ${file} has non-exact version ${version}`);
  return version;
}

export async function bumpPins(version, { root = WORKSPACE_ROOT, dryRun = false, skipChecks = false } = {}) {
  let target = version;
  if (target === "latest") target = latestPublishedPi();
  if (!isExactVersion(target)) {
    throw new Error(`VERSION must be x.y.z or "latest" (got ${JSON.stringify(version)})`);
  }

  const repos = workspaceRepos(root);
  for (const repo of repos) {
    if (!fs.existsSync(path.join(repo.dir, "package.json"))) {
      throw new Error(`${repo.dir} is missing`);
    }
  }

  if (dryRun) {
    for (const repo of repos) {
      const before = inspectRepo(repo.dir);
      console.log(
        `would pin ${repo.name} ${PI_PACKAGE} ${before.piPin ?? "(missing)"} -> ${target} (exact)`,
      );
    }
    console.log(`would set ${TUI_PACKAGE} in both to the version ${PI_PACKAGE}@${target} loads`);
    return { version: target, tag: currentManagedTag(root).tag };
  }

  for (const repo of repos) {
    console.log(`\n==> ${repo.name}: ${PI_PACKAGE}@${target}`);
    npm(repo.dir, ["install", `${PI_PACKAGE}@${target}`, "--save-exact", "--no-audit", "--no-fund"]);
    const tui = installedNestedTui(repo.dir);
    console.log(`==> ${repo.name}: ${TUI_PACKAGE}@${tui} (copy pi ${target} loads)`);
    npm(repo.dir, ["install", `${TUI_PACKAGE}@${tui}`, "--save-exact", "--no-audit", "--no-fund"]);
  }

  const { tag, issues } = currentManagedTag(root);
  if (tag) console.log(`\nmanaged image: ${tag}`);

  if (!skipChecks) {
    const after = collectIssues(root);
    if (after.issues.length > 0) {
      throw new Error(after.issues.join("\n"));
    }
    runCanaries(root);
  } else if (issues.length > 0) {
    console.warn("pin check issues (ignored because --skip-checks):\n" + issues.join("\n"));
  }
  return { version: target, tag };
}

function runCanaries(root) {
  const cli = path.join(root, "cli");
  const server = path.join(root, "server");
  console.log("\n==> canary: cli lint (runtime surface)");
  npm(cli, ["run", "lint"], { timeout: 180_000 });
  const serverPin = path.join(server, "scripts", "check-pi-pin.mjs");
  if (fs.existsSync(serverPin)) {
    console.log("==> canary: server check-pi-pin");
    const result = spawnSync(process.execPath, [serverPin], {
      cwd: server,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 15_000,
    });
    if (result.status !== 0) throw new Error("server check-pi-pin failed");
  }
}

export function printCheck(root = WORKSPACE_ROOT) {
  const { repos, issues } = collectIssues(root);
  for (const repo of repos) {
    if (repo.issues.length === 0) {
      console.log(`${repo.name}: pi ${repo.piLocked}  tui ${repo.tuiPin} (matches nested ${repo.tuiNested})`);
    }
  }
  const { tag } = currentManagedTag(root);
  if (tag && issues.length === 0) console.log(`managed image: ${tag}`);
  if (issues.length > 0) {
    for (const line of issues) console.error(line);
    return 1;
  }
  return 0;
}

async function main(argv) {
  const args = argv.filter((a) => a !== "--");
  const dryRun = args.includes("--dry-run");
  const skipChecks = args.includes("--skip-checks");
  const positional = args.filter((a) => !a.startsWith("--"));
  const command = positional[0];

  if (command === "check") {
    process.exitCode = printCheck();
    return;
  }
  if (command === "tag") {
    const { tag, issues } = currentManagedTag();
    if (issues.length > 0) {
      for (const line of issues) console.error(line);
      process.exitCode = 1;
      return;
    }
    if (!tag) {
      console.error("could not derive a managed image tag");
      process.exitCode = 1;
      return;
    }
    console.log(tag);
    return;
  }
  if (command === "bump") {
    const version = positional[1];
    if (!version) {
      console.error("usage: make bump-pi VERSION=<x.y.z|latest>");
      process.exitCode = 2;
      return;
    }
    await bumpPins(version, { dryRun, skipChecks });
    return;
  }
  console.error("usage: node scripts/pi-pins.mjs <check|tag|bump> [version] [--dry-run] [--skip-checks]");
  process.exitCode = 2;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main(process.argv.slice(2));
}
