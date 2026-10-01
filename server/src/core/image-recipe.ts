import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SandboxProvider } from "./providers/types.js";

export const IMAGE_RECIPE_SCHEMA = 1;
export const IMAGE_NAME = "pi-pod-base";

export type ImageResources = { cpu?: number; memoryGB?: number; diskGB?: number };

export interface ManagedImageRecipe {
  ref: string;
  managed: true;
  provenance: "managed-default" | "managed-legacy";
  migrationFrom?: string;
  launcherVersion: string;
  piVersion: string;
  assetDigest: string;
  effectiveResources?: ImageResources;
  packages: string[];
  /** Composed bake script baked into this image; "" when the recipe has none. */
  bakeScript: string;
}

export interface CustomImageRecipe {
  ref: string;
  managed: false;
  provenance: "custom-pin";
  launcherVersion: string;
  piVersion: string;
  assetDigest: string;
  effectiveResources?: ImageResources;
  packages: string[];
  bakeScript: string;
}

export type ImageRecipe = ManagedImageRecipe | CustomImageRecipe;

/** Only the image-level fields this provider can actually apply. */
export function imageResourcesFor(
  provider: Pick<SandboxProvider, "capabilities">,
  resources: ImageResources,
): ImageResources | undefined {
  if (provider.capabilities.resourceSizing !== "per-image") return undefined;
  const unsupported = new Set(provider.capabilities.unsupportedResourceSizing ?? []);
  const effective: ImageResources = {};
  if (!unsupported.has("cpu") && resources.cpu !== undefined) effective.cpu = resources.cpu;
  if (!unsupported.has("memoryGB") && resources.memoryGB !== undefined) effective.memoryGB = resources.memoryGB;
  if (!unsupported.has("diskGB") && resources.diskGB !== undefined) effective.diskGB = resources.diskGB;
  return Object.keys(effective).length > 0 ? effective : undefined;
}

/** One canonical package list feeds both the recipe key and pi-packages.txt. */
export function normalizeImagePackages(packages: string[]): string[] {
  return [...new Set(packages.map((entry) => entry.trim()).filter(Boolean))].sort();
}

export function packagesDigest(packages: string[]): string {
  const normalized = normalizeImagePackages(packages);
  if (normalized.length === 0) return "";
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 12);
}

/** A comment-only or blank script contributes nothing and must not churn the image tag. */
export function isEffectivelyEmptyScript(script: string): boolean {
  const stripped = script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  return stripped.length === 0;
}

/**
 * Compose the caller's ordered bake path into the one script the image bakes and the live
 * fallback runs. Account mode supplies org + template or org + project, never all three. One
 * composition function owns both image tagging and live fallback, so they cannot disagree.
 * Each layer runs in its own subshell — the same isolation separate init-script processes get —
 * and a failing layer stops the ones after it.
 */
export function composeBakeScript(steps: Array<{ scope: string; script: string }>): string {
  const meaningful = steps.filter((step) => !isEffectivelyEmptyScript(step.script));
  if (meaningful.length === 0) return "";
  return meaningful
    .map(
      (step) =>
        `echo "[bake] ${step.scope} bake script"\n(\n${step.script}\n)\ncode=$?\n` +
        `if [ "$code" -ne 0 ]; then echo "[bake] ${step.scope} bake script failed with exit $code" >&2; exit "$code"; fi`,
    )
    .join("\n");
}

export function bakeDigest(bakeScript: string): string {
  if (!bakeScript) return "";
  return createHash("sha256").update(bakeScript).digest("hex").slice(0, 12);
}

/**
 * Digest the launcher-owned Dockerfile. Pi, sizing, and extension-package inputs remain explicit
 * tag components; pi-pod's own generated extension is uploaded at session start and therefore is
 * no longer an image input.
 */
export function managedImageAssetDigest(assetRoot: string): string {
  const dockerfile = path.join(assetRoot, "image", "Dockerfile");
  if (!fs.existsSync(dockerfile)) throw new Error(`managed image Dockerfile not found: ${dockerfile}`);

  const stat = fs.lstatSync(dockerfile);
  return createHash("sha256")
    .update(`image/Dockerfile\0${stat.mode & 0o777}\0`)
    .update(fs.readFileSync(dockerfile))
    .update("\0")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Whether a ref lives under pi-pod's own image identity. The name is reserved: every tag
 * this launcher derives sits under it, and a custom build must publish under its own
 * `--image`. So a ref here is always one pi-pod wrote, never a third party's artifact.
 */
export function isManagedImageRef(ref: string): boolean {
  return ref === IMAGE_NAME || ref.startsWith(`${IMAGE_NAME}:`);
}

function resourceSuffix(resources?: ImageResources): string {
  if (!resources) return "";
  return [
    resources.cpu === undefined ? "" : `${resources.cpu}c`,
    resources.memoryGB === undefined ? "" : `${resources.memoryGB}m`,
    resources.diskGB === undefined ? "" : `${resources.diskGB}d`,
  ].join("");
}

export function derivedImageRef(input: {
  launcherVersion: string;
  piVersion: string;
  assetDigest: string;
  resources?: ImageResources;
  packages?: string[];
  bakeScript?: string;
}): string {
  const sizing = resourceSuffix(input.resources);
  const packageId = packagesDigest(input.packages ?? []);
  const bakeId = bakeDigest(input.bakeScript ?? "");
  return [
    `${IMAGE_NAME}:r${IMAGE_RECIPE_SCHEMA}-pi${input.piVersion}`,
    sizing || null,
    `img${input.assetDigest}`,
    packageId ? `pkg${packageId}` : null,
    bakeId ? `bake${bakeId}` : null,
  ].filter((part): part is string => part !== null).join("-");
}

// The two tag formats that predate build-input digests used to be enumerated here so they
// could be recognized as ours. Every tag under the managed name now migrates forward, so
// the list — which went stale each time the format grew a component — is no longer needed.

export function resolveImageRecipe(input: {
  configuredRef: string;
  imagePinned: boolean;
  launcherVersion: string;
  piVersion: string;
  assetRoot: string;
  provider: Pick<SandboxProvider, "capabilities">;
  resources: ImageResources;
  packages?: string[];
  /** Already-composed bake script (see {@link composeBakeScript}); "" or absent for none. */
  bakeScript?: string;
}): ImageRecipe {
  const packages = normalizeImagePackages(input.packages ?? []);
  const bakeScript = input.bakeScript ?? "";
  const effectiveResources = imageResourcesFor(input.provider, input.resources);
  const assetDigest = managedImageAssetDigest(input.assetRoot);
  const expected = derivedImageRef({
    launcherVersion: input.launcherVersion,
    piVersion: input.piVersion,
    assetDigest,
    resources: effectiveResources,
    packages,
    bakeScript,
  });
  const common = {
    launcherVersion: input.launcherVersion,
    piVersion: input.piVersion,
    assetDigest,
    ...(effectiveResources ? { effectiveResources } : {}),
    packages,
    bakeScript,
  };

  if (!input.imagePinned || input.configuredRef === expected) {
    return { ...common, ref: expected, managed: true, provenance: "managed-default" };
  }

  // A pin under pi-pod's own identity that is not the expected tag is a tag this launcher
  // derived and has since moved past — an older tag format, a bumped Pi, an edited Dockerfile
  // or bake script. Build the current one and report what it replaced. Reading it as a
  // third-party pin instead strands the launch on an artifact pi-pod refuses to build and
  // nobody else publishes: exactly what a `--from-here` template snapshot used to freeze in.
  if (isManagedImageRef(input.configuredRef)) {
    return {
      ...common,
      ref: expected,
      managed: true,
      provenance: "managed-legacy",
      migrationFrom: input.configuredRef,
    };
  }

  return { ...common, ref: input.configuredRef, managed: false, provenance: "custom-pin" };
}
