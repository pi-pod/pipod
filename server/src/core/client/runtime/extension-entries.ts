import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve launcher-side code without loading a package's provider/runtime factory.
 * An explicit pipod.clientExtensions list wins, including [] for pod-only packages.
 * Packages without it retain Pi's normal entrypoint convention. This is a correctness
 * boundary, not a sandbox: every selected entry still runs with the launcher's privileges.
 */
export function extensionEntriesOf(dir: string): string[] {
  const manifestPath = path.join(dir, "package.json");
  if (fs.existsSync(manifestPath)) {
    let manifest: { pi?: { extensions?: unknown }; pipod?: { clientExtensions?: unknown } };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
    } catch {
      // Never guess at executable code in a malformed manifest.
      return [];
    }
    if (manifest?.pipod && Object.hasOwn(manifest.pipod, "clientExtensions")) {
      const declared = manifest.pipod.clientExtensions;
      if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string" || !entry)) return [];
      const root = fs.realpathSync(dir);
      const entries: string[] = [];
      for (const entry of declared as string[]) {
        if (path.isAbsolute(entry)) return [];
        const candidate = path.resolve(dir, entry);
        const relative = path.relative(dir, candidate);
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) return [];
        try {
          const real = fs.realpathSync(candidate);
          const within = path.relative(root, real);
          if (within === ".." || within.startsWith(`..${path.sep}`) || !fs.statSync(real).isFile()) return [];
          entries.push(candidate);
        } catch {
          return [];
        }
      }
      return entries;
    }
    const declared = Array.isArray(manifest?.pi?.extensions) ? manifest.pi.extensions : [];
    const entries = declared
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => path.resolve(dir, entry))
      .filter((entry) => fs.existsSync(entry));
    if (entries.length > 0) return entries;
  }
  for (const index of ["index.ts", "index.js"]) {
    const candidate = path.join(dir, index);
    if (fs.existsSync(candidate)) return [candidate];
  }
  return [];
}
