/**
 * src/image.ts — `pi-pod image build` (§5, §12).
 *
 * The canonical artifact is a plain OCI image built from `image/Dockerfile`, consumed by the
 * native sandbox runtime. Pi-pod's own extension is
 * launcher-generated and uploaded per Pi process, so it is deliberately not an image input.
 */
import {
  derivedImageRef,
  imageResourcesFor,
  managedImageAssetDigest,
  normalizeImagePackages,
  packagesDigest,
  type ImageResources,
} from "./image-recipe.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPiVersion, isNewerVersion, latestPiVersion } from "./client/piversion.js";
import { PiPodError } from "./errors.js";
import { npmSpecOf } from "./hostconfig.js";
import { color, info, plain, prefixedStreamer, warn, withLiveness } from "./log.js";
import { supportsImageBuild, type SandboxProvider } from "./providers/types.js";

export interface ImageBuildOptions {
  provider: SandboxProvider;
  /** Image reference to publish, e.g. "pi-pod-base:1.0.0". */
  ref: string;
  /**
   * `config.resources`. Baked into the image on providers where sizing is a property of the
   * image (`resourceSizing: "per-image"`); ignored elsewhere, where it is applied per pod
   * at create time instead.
   */
  resources?: { cpu?: number; memoryGB?: number; diskGB?: number };
  /** Override the packaged Dockerfile. */
  dockerfile?: string;
  /** Root containing the managed image assets (server packaging seam). */
  assetRoot?: string;
  /**
   * pi extension packages to bake in (§7.5). Written into the build context rather than passed
   * as a build arg, because the provider contract takes a Dockerfile and a directory and
   * nothing else (§3.1).
   */
  packages?: string[];
  /**
   * Composed bake script to bake in as the image's last layer (see `composeBakeScript`).
   * Written into the build context like the package lists; "" writes an empty file the
   * Dockerfile COPYs and skips.
   */
  bakeScript?: string;
  /** Print the assembled context and exit. */
  dryRun?: boolean;
  /** Overwrite a tag that already exists in the provider. */
  force?: boolean;
  /**
   * Build even when the bundled pi is behind the latest published one (`--allow-outdated-pi`).
   * The guard exists because pods get their pi from the launcher's bundle (§10), so baking
   * from a stale launcher publishes a stale pi to every pod; opting out downgrades that to a
   * warning for deliberate cases (a pi release younger than any pi-pod that bundles it).
   */
  allowOutdatedPi?: boolean;
  /** Test seam: how to learn the latest published pi, instead of asking npm. */
  resolveLatestPi?: () => Promise<string | null>;
}

export {
  IMAGE_NAME,
  bakeDigest,
  composeBakeScript,
  derivedImageRef,
  imageResourcesFor,
  isEffectivelyEmptyScript,
  isManagedImageRef,
  managedImageAssetDigest,
  normalizeImagePackages,
  packagesDigest,
  resolveImageRecipe,
  type ImageRecipe,
  type ImageResources,
} from "./image-recipe.js";

/** Name of the package list inside the build context; the Dockerfile reads it by this name. */
export const PACKAGES_FILE = "pi-packages.txt";
/** npm specs only, pre-filtered on the host so the Dockerfile install step needs no parsing. */
export const NPM_PACKAGES_FILE = "pi-packages-npm.txt";
/** Composed bake script inside the build context; the Dockerfile runs it by this name. */
export const BAKE_SCRIPT_FILE = "bake.sh";

/** Version of the installed launcher, read from its own package.json. */
export function launcherVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The image reference this launcher builds and expects (§12).
 *
 * Everything inside the image comes from the launcher package — the Dockerfile, pinned Node
 * base, and Pi version. The tag is *derived*, never hand-managed: change an image input and the
 * expected tag changes with it. Pi-pod's generated extension upgrades on the next fresh attach
 * without rebuilding the image.
 *
 * On providers that bake sizing into the image (`resourceSizing: "per-image"`), the sizing is
 * part of the artifact and therefore part of the tag. Two repos in one org with different
 * `resources` would otherwise contend for a single tag, and whichever built last would
 * silently resize the other's pods.
 */
export function defaultImageRef(
  version: string,
  resources?: ImageResources,
  packages?: string[],
  assetRoot: string = packageRoot(),
  bakeScript?: string,
): string {
  return derivedImageRef({
    launcherVersion: version,
    piVersion: bundledPiVersion(),
    assetDigest: managedImageAssetDigest(assetRoot),
    resources,
    packages,
    bakeScript,
  });
}

/**
 * Repoint `config.image` at a new tag, preserving the file's JSONC formatting and comments.
 * A targeted replacement rather than a re-serialize: rewriting the whole file would strip the
 * annotations that make the committed config readable (§4.1).
 */
export function repointConfigImage(configPath: string, from: string, to: string): boolean {
  const original = fs.readFileSync(configPath, "utf8");
  const pattern = new RegExp(`("image"\\s*:\\s*)"${escapeRegExp(from)}"`);
  if (!pattern.test(original)) return false;
  fs.writeFileSync(configPath, original.replace(pattern, `$1"${to}"`));
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Locate the package root containing `image/`, whether built or run from source. */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → package root is one level up; src/image.ts → also one level up.
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, "..");
}

function describeImageResources(resources: ImageResources): string {
  return [
    resources.cpu === undefined ? null : `${resources.cpu} cpu`,
    resources.memoryGB === undefined ? null : `${resources.memoryGB} GB memory`,
    resources.diskGB === undefined ? null : `${resources.diskGB} GB disk`,
  ].filter((part): part is string => part !== null).join(" / ");
}

export async function buildImage(opts: ImageBuildOptions): Promise<void> {
  if (!supportsImageBuild(opts.provider)) {
    throw new PiPodError(`provider "${opts.provider.name}" cannot build images`, {
      hint: "build and publish the image with that provider's own tooling, then set config.image to it",
    });
  }
  // Captured after the guard: the narrowing does not survive into the liveness closure below.
  const builder = opts.provider;

  const root = opts.assetRoot ?? packageRoot();
  const dockerfile = opts.dockerfile
    ? path.resolve(opts.dockerfile)
    : path.join(root, "image", "Dockerfile");

  if (!fs.existsSync(dockerfile)) {
    throw new PiPodError(`Dockerfile not found: ${dockerfile}`, {
      hint: "pass --dockerfile <path>, or reinstall pi-pod (the packaged image/ directory is missing)",
    });
  }
  // Pods run exactly the pi this launcher bundles (§10) — so the way pods stay on the latest
  // pi is that nothing stale ever gets baked. A launcher behind the latest published pi would
  // otherwise keep publishing (and, via the derived tag, keep *reusing*) an outdated pi
  // indefinitely. Refuse that build; the remedy is updating the launcher, not rebuilding
  // from it. Skipped for --dry-run, which prints a context and must not need the network, and
  // downgraded to a warning when the registry cannot be asked — being offline is not a
  // reason a pod cannot be built.
  if (!opts.dryRun) {
    const bundled = bundledPiVersion();
    const latest = await (opts.resolveLatestPi ?? latestPiVersion)();
    if (latest === null) {
      warn(`could not check npm for the latest pi — building with the bundled pi ${bundled}`);
    } else if (isNewerVersion(latest, bundled)) {
      const message =
        `this build would bake pi ${bundled}, but pi ${latest} is the latest release — ` +
        "pods get their pi from the launcher's bundle, so a stale launcher makes stale pods";
      if (!opts.allowOutdatedPi) {
        throw new PiPodError(message, {
          hint:
            "run `pi-pod update`, then build again — an updated launcher bundles the latest pi " +
            "and derives a fresh image tag for it.\nTo build with the bundled pi anyway, pass --allow-outdated-pi",
        });
      }
      warn(`${message} — continuing with the bundled pi; run \`pi-pod update\` to use pi ${latest}`);
    }
  }

  // The build context is assembled in a temp directory for the provider-neutral builder.
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-image-"));
  try {
    // Pin the image's pi to the exact version this launcher bundles (§10). The guard above has
    // established that this is latest, or warned because the caller allowed an older build. The
    // Dockerfile ships with `ARG PI_VERSION=latest` as a fallback for out-of-band builds; a
    // launcher build must never float.
    const pinned = fs
      .readFileSync(dockerfile, "utf8")
      .replace(/^ARG PI_VERSION=.*$/m, `ARG PI_VERSION=${bundledPiVersion()}`);
    fs.writeFileSync(path.join(context, "Dockerfile"), pinned);


    // Always written, even when empty: the Dockerfile COPYs it unconditionally, and a COPY of
    // a file that is not there fails the build rather than skipping the step.
    const packages = normalizeImagePackages(opts.packages ?? []);
    fs.writeFileSync(path.join(context, PACKAGES_FILE), packages.map((p) => `${p}\n`).join(""));
    const npmSpecs = packages.map(npmSpecOf).filter((s): s is string => s !== null);
    fs.writeFileSync(path.join(context, NPM_PACKAGES_FILE), npmSpecs.map((s) => `${s}\n`).join(""));
    if (packages.length > 0) {
      info(`baking ${packages.length} pi extension package(s) into the image`);
    }
    const bakeScript = opts.bakeScript ?? "";
    fs.writeFileSync(path.join(context, BAKE_SCRIPT_FILE), bakeScript);
    if (bakeScript.length > 0) {
      info("baking the bake script into the image");
    }

    const imageResources = opts.resources ? imageResourcesFor(opts.provider, opts.resources) : undefined;
    const unsupported = opts.provider.capabilities.unsupportedResourceSizing ?? [];
    if (unsupported.length > 0) {
      const names = unsupported.map((name) => name === "memoryGB" ? "memory" : name === "diskGB" ? "disk" : "CPU");
      warn(
        `${opts.provider.name} cannot set ${names.join(", ")} from config; ` +
          "those values are controlled by the provider account or plan and will not be applied",
      );
    }

    if (opts.dryRun) {
      plain(`build context: ${context}`);
      for (const entry of fs.readdirSync(context)) plain(`  ${entry}`);
      plain(`would publish as: ${opts.ref}`);
      if (packages.length > 0) plain(`with pi extensions: ${packages.join(", ")}`);
      if (bakeScript.length > 0) plain(`with a composed bake script (${Buffer.byteLength(bakeScript)} bytes)`);
      if (imageResources) {
        plain(`with sizing: ${describeImageResources(imageResources)}`);
      }
      return;
    }

    if (imageResources) {
      info(`baking sizing into the image: ${describeImageResources(imageResources)}`);
    }

    // The tag identifies its contents (§12), so an existing tag is already the image this
    // launcher would build: publishing again would be wasted work, not a conflict.
    if (!opts.force) {
      const existing = await opts.provider.resolveImage(opts.ref).catch(() => null);
      if (existing) {
        info(`${color.bold(opts.ref)} is already published — nothing to build`);
        return;
      }
    }

    info(`building ${color.bold(opts.ref)} on ${opts.provider.name}…`);
    const stream = prefixedStreamer("[image]");
    // The liveness line rides alongside the build log: providers go quiet for long stretches
    // (uploads, registry pushes), and a first build is exactly when a user decides pi-pod hung.
    await withLiveness(
      `building ${opts.ref}`,
      () =>
        builder.buildImage({
          dockerfilePath: path.join(context, "Dockerfile"),
          contextDir: context,
          ref: opts.ref,
          ...(imageResources ? { resources: imageResources } : {}),
          ...(opts.force ? { force: true } : {}),
          onLog: (line) => stream(Buffer.from(line + "\n", "utf8")),
        }),
      { expectation: "usually a few minutes" },
    );

    info(`published ${color.bold(opts.ref)}`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}
