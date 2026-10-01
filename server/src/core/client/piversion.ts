/**
 * src/client/piversion.ts — the pi version this launcher bundles (§10).
 *
 * pi pod pins pi exactly for newly built images. The shim reports the pod's pi in its hello;
 * account sessions enforce that exact version before exposing Pi's unversioned RPC surface.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "../log.js";

export interface InstalledPiPackage {
  root: string;
  version: string;
  /** Package-declared `pi` executable, relative to `root`. */
  bin: string;
}

let cached: InstalledPiPackage | null = null;

/** The installed package this launcher actually imports — version and delivery share this authority. */
export function installedPiPackage(): InstalledPiPackage {
  if (cached) return cached;
  // The package is ESM-only and its exports map hides package.json, so resolve the entry
  // module and walk up to the package root.
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const root = path.join(path.dirname(entry), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pi"];
  if (!bin || path.isAbsolute(bin) || path.normalize(bin).startsWith(`..${path.sep}`)) {
    throw new Error("the installed pi package has no safe package-declared `pi` executable");
  }
  cached = { root, version: pkg.version, bin: bin.split(path.sep).join(path.posix.sep) };
  return cached;
}

export function bundledPiVersion(): string {
  return installedPiPackage().version;
}

export function describeVersionSkew(podPi: string, hostPi: string): string {
  return `the pod runs pi ${podPi} but this pi pod bundles pi ${hostPi}`;
}

export type PiVersionComparison = -1 | 0 | 1;

/** Compare two semantic pi versions, ignoring build metadata as SemVer requires. */
export function comparePiVersions(podPi: string, hostPi: string): PiVersionComparison | null {
  const pod = parseSemanticVersion(podPi);
  const host = parseSemanticVersion(hostPi);
  if (!pod || !host) return null;

  for (let i = 0; i < pod.core.length; i += 1) {
    const order = compareNumericIdentifier(pod.core[i]!, host.core[i]!);
    if (order !== 0) return order;
  }

  if (pod.prerelease === null && host.prerelease === null) return 0;
  if (pod.prerelease === null) return 1;
  if (host.prerelease === null) return -1;

  const length = Math.max(pod.prerelease.length, host.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const podPart = pod.prerelease[i];
    const hostPart = host.prerelease[i];
    if (podPart === undefined) return -1;
    if (hostPart === undefined) return 1;
    if (podPart === hostPart) continue;

    const podNumeric = /^\d+$/.test(podPart);
    const hostNumeric = /^\d+$/.test(hostPart);
    if (podNumeric && hostNumeric) return compareNumericIdentifier(podPart, hostPart);
    if (podNumeric) return -1;
    if (hostNumeric) return 1;
    return podPart < hostPart ? -1 : 1;
  }
  return 0;
}

interface ParsedSemanticVersion {
  core: readonly [string, string, string];
  prerelease: readonly string[] | null;
}

function parseSemanticVersion(version: string): ParsedSemanticVersion | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return null;

  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return null;
  }

  return { core: [match[1]!, match[2]!, match[3]!], prerelease };
}

function compareNumericIdentifier(left: string, right: string): PiVersionComparison {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Does a pod running this pi have `pi auth print-api-key` / `print-bearer-token`? The
 * commands landed in 0.83.0, and the pod-side Claude Code `apiKeyHelper` (§7.6) is built on
 * them.
 */
export function supportsCredentialPrint(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 1 || minor >= 83;
}
/** The npm package pods get their pi from; also the package this launcher bundles. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

let latestCached: Promise<string | null> | null = null;

/**
 * The newest pi published to npm, or `null` when the registry cannot be asked.
 *
 * Pods inherit pi from the launcher's bundle (§10), so "are pods running the latest pi" is
 * really "is this launcher current" — and this is the other half of that comparison. Used by
 * `image build`, which refuses to bake a stale pi, and by preflight, which warns that the
 * pods it is about to start are behind.
 *
 * `npm view` rather than a hand-rolled registry fetch because it honors the user's own
 * registry, proxy and auth configuration — the same route `pipod update` takes. Never
 * rejects and is cached for the process: an unreachable registry is a debug line, not a
 * failed launch, and no run needs to ask twice.
 */
export function latestPiVersion(opts: { timeoutMs?: number } = {}): Promise<string | null> {
  latestCached ??= queryLatestPi(opts.timeoutMs ?? 10_000);
  return latestCached;
}

/** Tests run several registries in one process. */
export function resetLatestPiVersion(): void {
  latestCached = null;
}

function queryLatestPi(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["view", `${PI_PACKAGE}@latest`, "version"],
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          debug(`could not ask npm for the latest pi version: ${err.message}`);
          resolve(null);
          return;
        }
        const version = stdout.trim().split("\n").at(-1)?.trim() ?? "";
        resolve(version === "" ? null : version);
      },
    );
  });
}

/**
 * Is `candidate` a newer release than `current`? Numeric compare over the dot-separated
 * core; a pre-release suffix is ignored, which is fine for the one question this answers —
 * whether the pods this launcher builds are behind the latest pi.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const core = (v: string) => v.split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = core(candidate);
  const b = core(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
