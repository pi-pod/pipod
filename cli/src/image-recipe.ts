import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const IMAGE_RECIPE_SCHEMA = 1;
export const IMAGE_NAME = "pi-pod-base";
export type ImageResources = { cpu?: number; memoryGB?: number; diskGB?: number };

export function normalizeImagePackages(packages: string[]): string[] {
  return [...new Set(packages.map((entry) => entry.trim()).filter(Boolean))].sort();
}

export function packagesDigest(packages: string[]): string {
  const normalized = normalizeImagePackages(packages);
  if (normalized.length === 0) return "";
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 12);
}

export function isEffectivelyEmptyScript(script: string): boolean {
  return !script
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
}

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
  return bakeScript ? createHash("sha256").update(bakeScript).digest("hex").slice(0, 12) : "";
}

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
