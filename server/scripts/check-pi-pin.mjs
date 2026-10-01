/**
 * scripts/check-pi-pin.mjs — pods run the pi this package bundles.
 *
 * The managed image tag is derived from the lockfile version of
 * `@earendil-works/pi-coding-agent` (see .github/workflows/publish-sandbox-base.yml).
 * A caret range lets `npm install` move that version without a deliberate bump, so
 * both pi and pi-tui must be exact pins, the lockfile must match, and pi-tui must
 * equal the copy pi itself loads. Wired into `npm run check`.
 *
 * Run: node scripts/check-pi-pin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI = "@earendil-works/pi-coding-agent";
const TUI = "@earendil-works/pi-tui";
const ROOT = process.env.PI_POD_PIN_ROOT
  ? path.resolve(process.env.PI_POD_PIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const isExactPin = (spec) =>
  typeof spec === "string" && /^\d+\.\d+\.\d+/.test(spec) && !/^[~^<>]/.test(spec);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const pkgPath = path.join(ROOT, "package.json");
const lockPath = path.join(ROOT, "package-lock.json");
if (!fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) {
  console.error(`check-pi-pin: missing package.json or package-lock.json in ${ROOT}`);
  process.exit(1);
}

const deps = readJson(pkgPath).dependencies ?? {};
const lock = readJson(lockPath);
const packages = lock.packages ?? {};
const piLocked = packages[`node_modules/${PI}`]?.version;
const tuiNested =
  packages[`node_modules/${PI}/node_modules/${TUI}`]?.version ??
  packages[`node_modules/${TUI}`]?.version;
const piPin = deps[PI];
const tuiPin = deps[TUI];
const errors = [];

if (!isExactPin(piPin)) {
  errors.push(`${PI} is ${piPin === undefined ? "missing" : `"${piPin}"`} — pin the exact version`);
} else if (piLocked === undefined) {
  errors.push(`${PI} is not in package-lock.json`);
} else if (piPin !== piLocked) {
  errors.push(`${PI} package.json has ${piPin} but the lockfile has ${piLocked}`);
}

if (!isExactPin(tuiPin)) {
  errors.push(`${TUI} is ${tuiPin === undefined ? "missing" : `"${tuiPin}"`} — pin the exact version, as pi itself is`);
} else if (tuiNested === undefined) {
  errors.push(`${TUI} is not in package-lock.json beside ${PI}`);
} else if (tuiPin !== tuiNested) {
  errors.push(`${TUI} pinned ${tuiPin}, but pi ${piLocked ?? piPin} loads ${tuiNested}`);
}

if (errors.length > 0) {
  for (const line of errors) console.error(`pi pin FAILED: ${line}`);
  process.exit(1);
}

console.log(`pi ${piLocked} (exact); ${TUI} ${tuiPin} matches the copy pi loads`);
