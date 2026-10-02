/**
 * src/client/runtime/attested-extensions.ts — the code channel.
 *
 * The laptop executes extension code only when its spec came from server-custodied config:
 * the launch-resolved `resolvedPackages` set the server recorded on the pod row. The client
 * never receives executable bytes from the pod — it downloads the attested specs from the
 * registry itself, into a shared content-addressed store. Spec-shape guardrails allow only
 * exact versions of plainly named npm packages: no git URLs, tarballs, paths, ranges, or
 * tags, which are pod- or third-party-chosen bytes by reference. Nothing installed by the
 * agent mid-session can enter this set, structurally.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { debug } from "../../log.js";
import { extensionEntriesOf } from "./local-extensions.js";

const execFileAsync = promisify(execFile);

export const MAX_ATTESTED_PACKAGES = 32;
const NPM_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTALL_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 60_000;

export interface AttestedPackage {
  name: string;
  version: string;
  source: string;
}

/**
 * The attested set from a pod row's launch report, guardrails applied. Entries that fail a
 * shape check are dropped (fail closed) and named in `refused` so the session can say why
 * rendering stays generic.
 */
export function attestedPackages(
  piSettings:
    | { resolvedPackages?: Array<{ name?: unknown; version?: unknown; source?: unknown }> }
    | null
    | undefined,
): { specs: AttestedPackage[]; refused: string[] } {
  const specs: AttestedPackage[] = [];
  const refused: string[] = [];
  for (const entry of (piSettings?.resolvedPackages ?? []).slice(0, MAX_ATTESTED_PACKAGES)) {
    const name = typeof entry.name === "string" ? entry.name : "";
    const version = typeof entry.version === "string" ? entry.version : "";
    const source = typeof entry.source === "string" ? entry.source : "";
    const label = name || source || "(unnamed)";
    if (!source.startsWith("npm:")) {
      refused.push(`${label}: only npm registry sources run locally`);
      continue;
    }
    if (!NPM_NAME.test(name) || name.length > 214) {
      refused.push(`${label}: not a plain npm package name`);
      continue;
    }
    if (!EXACT_SEMVER.test(version) || version.length > 64) {
      refused.push(`${label}: resolved version ${JSON.stringify(version).slice(0, 32)} is not exact`);
      continue;
    }
    specs.push({ name, version, source });
  }
  return { specs, refused };
}

/**
 * The attested set says which packages the server recorded, not that this person agreed to
 * run them: a template someone else edits, or one a pod wrote, chooses them. Each exact
 * package runs locally only once its user has said yes to it on this machine; without a
 * terminal to ask, rendering stays generic.
 */
export async function trustAttestedPackages(
  specs: AttestedPackage[],
  opts: { cacheRoot: string; ask: (question: string) => Promise<boolean> },
): Promise<{ trusted: AttestedPackage[]; declined: AttestedPackage[] }> {
  const file = path.join(opts.cacheRoot, "trusted-extensions.json");
  const key = (spec: AttestedPackage) => `${spec.name}@${spec.version}`;
  let known: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) known = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // No decisions yet.
  }
  const unknown = specs.filter((spec) => !known.includes(key(spec)));
  if (unknown.length === 0) return { trusted: specs, declined: [] };
  const yes = await opts.ask(
    `This pod renders with Pi extensions that would run on this machine as you: ${unknown.map(key).join(", ")}. Run them?`,
  );
  if (!yes) return { trusted: specs.filter((spec) => !unknown.includes(spec)), declined: unknown };
  fs.mkdirSync(opts.cacheRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify([...known, ...unknown.map(key)], null, 2)}\n`, { mode: 0o600 });
  return { trusted: specs, declined: [] };
}

function storeSegment(spec: AttestedPackage): string {
  return `${spec.name.replace("/", "__")}@${spec.version}`.replace(/[^A-Za-z0-9._@~-]/g, "_");
}

async function withInstallLock<T>(entryDir: string, run: () => Promise<T>): Promise<T> {
  const lock = `${entryDir}.lock`;
  fs.mkdirSync(path.dirname(entryDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock, { recursive: false });
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        // The holder finished between the mkdir failure and the stat; retry after the pause.
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for a concurrent install");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await run();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // Already released.
    }
  }
}

export interface AttestedInstallResult {
  /** Extension entry files for pi's loader, in spec order. */
  paths: string[];
  /** Human lines for specs that could not produce a locally renderable extension. */
  warnings: string[];
}

/**
 * Materialize the attested set in the shared store (`<cacheRoot>/npm/<name>@<version>/`).
 * Idempotent per entry (completion marker), safe under concurrent launchers (lock +
 * marker), and always `--ignore-scripts`: the code runs inside the TUI process later, but
 * install-time script execution is not part of the deal.
 */
export async function installAttestedPackages(
  specs: AttestedPackage[],
  opts: { cacheRoot: string; npmCommand?: string[] },
): Promise<AttestedInstallResult> {
  const paths: string[] = [];
  const warnings: string[] = [];
  for (const spec of specs) {
    const entryDir = path.join(opts.cacheRoot, "npm", storeSegment(spec));
    const packageDir = path.join(entryDir, "node_modules", ...spec.name.split("/"));
    try {
      await withInstallLock(entryDir, async () => {
        if (fs.existsSync(path.join(entryDir, "complete"))) return;
        fs.mkdirSync(entryDir, { recursive: true, mode: 0o700 });
        const [npmBin, ...npmArgs] = opts.npmCommand ?? ["npm"];
        await execFileAsync(
          npmBin!,
          [
            ...npmArgs,
            "install",
            `${spec.name}@${spec.version}`,
            "--prefix",
            entryDir,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--omit=dev",
            "--legacy-peer-deps",
          ],
          { timeout: INSTALL_TIMEOUT_MS },
        );
        if (!fs.existsSync(packageDir)) throw new Error("npm reported success but the package is missing");
        fs.writeFileSync(path.join(entryDir, "complete"), "", { mode: 0o600 });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug(`attested install failed for ${spec.name}@${spec.version}: ${message}`);
      warnings.push(
        `pod extension ${spec.name}@${spec.version} could not be installed locally (${message.split("\n")[0]}) — its rendering stays generic`,
      );
      continue;
    }
    const entries = extensionEntriesOf(packageDir);
    if (entries.length === 0) {
      // Not every settings package is an extension (themes/skills/prompts ride the same
      // list); nothing to run locally is the normal case, not a failure.
      debug(`attested package ${spec.name}@${spec.version} declares no extension entry`);
      continue;
    }
    paths.push(...entries);
  }
  return { paths, warnings };
}

/** One actionable notice for pod package identities the exact launch attestation cannot vouch for. */
export function unattestedPackageNotice(
  podPackages: Array<{ name: string; version: string }>,
  specs: AttestedPackage[],
): string | null {
  const identity = (entry: { name: string; version: string }): string => `${entry.name}@${entry.version}`;
  const attested = new Set(specs.map(identity));
  const mismatches = [...new Set(podPackages.map(identity).filter((entry) => !attested.has(entry)))].sort();
  if (mismatches.length === 0) return null;

  const shown = mismatches.slice(0, 3).map((entry) => `\`${entry}\``);
  const remainder = mismatches.length - shown.length;
  const examples = `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  const noun = mismatches.length === 1 ? "package" : "packages";
  return (
    `pod reports ${mismatches.length} configured ${noun} outside its exact launch-attested set: ${examples}; ` +
    `extension rendering from ${mismatches.length === 1 ? "that package is" : "those packages is"} unavailable locally — ` +
    `land intentional top-level Pi packages in your bundle's settings.json "packages" ` +
    `(pipod push); do not add transitive dependencies`
  );
}
