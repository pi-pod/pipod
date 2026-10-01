import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPiVersion } from "./client/piversion.js";
import { derivedImageRef, managedImageAssetDigest, type ImageResources } from "./image-recipe.js";

export {
  IMAGE_NAME,
  bakeDigest,
  composeBakeScript,
  derivedImageRef,
  isEffectivelyEmptyScript,
  isManagedImageRef,
  managedImageAssetDigest,
  normalizeImagePackages,
  packagesDigest,
  type ImageResources,
} from "./image-recipe.js";

export function launcherVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, "..");
}
