/**
 * Guards the src/core/ ↔ pi-pod boundary described in scripts/core-manifest.txt.
 *
 * Offline (no arguments) is what `npm run check` and CI run: it hashes the
 * [shared] files and fails if src/core/ has been edited without a re-sync.
 * pi-pod is a separate private repo, so this half deliberately needs no checkout.
 *
 * Paired (--pi-pod <path>) is what sync-core.sh and the umbrella repo run: it
 * additionally catches the other drift direction — pi-pod moving ahead of the
 * vendored copy — and fails on any dual-tree file the manifest never classified.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.join(ROOT, "src/core");
const MANIFEST = path.join(ROOT, "scripts/core-manifest.txt");

export interface Manifest {
  shared: Array<{ sha256: string; rel: string }>;
  forked: Array<{ rel: string; reason: string }>;
  pinned: Array<{ rel: string; reason: string }>;
}

export function parseManifest(text: string): Manifest {
  const manifest: Manifest = { shared: [], forked: [], pinned: [] };
  let section: keyof Manifest | null = null;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line === "[shared]" || line === "[forked]" || line === "[pinned]") {
      section = line.slice(1, -1) as keyof Manifest;
      return;
    }
    if (section === "shared") {
      const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line);
      if (!m) throw new Error(`core-manifest.txt:${i + 1}: expected "<sha256>  <path>", got: ${line}`);
      manifest.shared.push({ sha256: m[1]!, rel: m[2]! });
    } else if (section === "forked" || section === "pinned") {
      const m = /^(\S+)\s+(.+)$/.exec(line);
      if (!m) throw new Error(`core-manifest.txt:${i + 1}: expected "<path>  <reason>", got: ${line}`);
      manifest[section].push({ rel: m[1]!, reason: m[2]!.trim() });
    } else {
      throw new Error(`core-manifest.txt:${i + 1}: entry before any [shared]/[forked]/[pinned] header`);
    }
  });
  return manifest;
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function coreFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) out.push(path.relative(CORE, p));
    }
  })(CORE);
  return out.sort();
}

function writeHashes(manifest: Manifest): void {
  const text = fs.readFileSync(MANIFEST, "utf8");
  const fresh = new Map(manifest.shared.map((s) => [s.rel, sha256(path.join(CORE, s.rel))]));
  const updated = text
    .split("\n")
    .map((raw) => {
      const m = /^([0-9a-f]{64})(\s+)(\S+)$/.exec(raw.trim());
      const next = m ? fresh.get(m[3]!) : undefined;
      return next ? `${next}  ${m![3]}` : raw;
    })
    .join("\n");
  fs.writeFileSync(MANIFEST, updated);
  console.log(`check-core-sync: refreshed ${fresh.size} shared hash(es) in scripts/core-manifest.txt`);
}

function main(argv: string[]): number {
  const piPodIndex = argv.indexOf("--pi-pod");
  const piPod = piPodIndex === -1 ? null : argv[piPodIndex + 1];
  if (piPodIndex !== -1 && !piPod) {
    console.error("check-core-sync: --pi-pod needs a path to a pi-pod checkout");
    return 2;
  }

  const manifest = parseManifest(fs.readFileSync(MANIFEST, "utf8"));
  if (argv.includes("--write-hashes")) {
    writeHashes(manifest);
    return 0;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const classified = new Set(
    [...manifest.shared, ...manifest.forked, ...manifest.pinned].map((e) => e.rel),
  );

  for (const rel of classified) {
    if (!fs.existsSync(path.join(CORE, rel))) {
      errors.push(`${rel}: listed in core-manifest.txt but missing from src/core/`);
    }
  }

  for (const { rel, sha256: expected } of manifest.shared) {
    const file = path.join(CORE, rel);
    if (!fs.existsSync(file)) continue;
    const actual = sha256(file);
    if (actual !== expected) {
      errors.push(
        `${rel}: shared file edited in place (sha256 ${actual.slice(0, 12)}… ` +
          `≠ manifest ${expected.slice(0, 12)}…). Change it in pi-pod and re-sync, ` +
          `or move it to [forked].`,
      );
    }
  }

  if (piPod) {
    const upstream = path.join(piPod, "src");
    if (!fs.existsSync(upstream)) {
      console.error(`check-core-sync: ${upstream} does not exist — is ${piPod} a pi-pod checkout?`);
      return 2;
    }
    for (const { rel } of manifest.shared) {
      const up = path.join(upstream, rel);
      if (!fs.existsSync(up)) {
        errors.push(`${rel}: shared, but no longer exists in pi-pod — move it to [forked] or delete it`);
        continue;
      }
      if (!fs.readFileSync(up).equals(fs.readFileSync(path.join(CORE, rel)))) {
        errors.push(`${rel}: shared file differs from pi-pod — run scripts/sync-core.sh`);
      }
    }
    for (const { rel } of manifest.forked) {
      const up = path.join(upstream, rel);
      if (fs.existsSync(up) && fs.readFileSync(up).equals(fs.readFileSync(path.join(CORE, rel)))) {
        warnings.push(`${rel}: forked but byte-identical to pi-pod — consider promoting it to [shared]`);
      }
    }
    for (const { rel } of manifest.pinned) {
      const up = path.join(upstream, rel);
      if (!fs.existsSync(up)) {
        warnings.push(`${rel}: pinned, but no longer exists in pi-pod — move it to [forked]`);
      } else if (!fs.readFileSync(up).equals(fs.readFileSync(path.join(CORE, rel)))) {
        warnings.push(`${rel}: pinned but has drifted from pi-pod — move it to [forked] with a reason`);
      }
    }
    for (const rel of coreFiles()) {
      if (classified.has(rel)) continue;
      if (fs.existsSync(path.join(upstream, rel))) {
        errors.push(`${rel}: exists in both trees but core-manifest.txt is not classified in core-manifest.txt (shared/forked/pinned)`);
      }
    }
  }

  for (const w of warnings) console.warn(`check-core-sync: warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`check-core-sync: ${e}`);
    console.error(`check-core-sync: ${errors.length} problem(s); see src/core/README.md`);
    return 1;
  }
  const scope = piPod ? `against pi-pod at ${piPod}` : "(hashes only; pass --pi-pod <path> to diff upstream)";
  console.log(
    `check-core-sync: ${manifest.shared.length} shared, ${manifest.forked.length} forked, ` +
      `${manifest.pinned.length} pinned, ${coreFiles().length - classified.size} server-only ${scope}`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
