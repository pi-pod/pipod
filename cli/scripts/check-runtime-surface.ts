/**
 * scripts/check-runtime-surface.ts — the surface canary (§5.2, §13).
 *
 * Importing an internals-shaped surface is safe only if drift is loud. This re-extracts the
 * member-access sets InteractiveMode makes on its runtime host from pi's shipped dist, and
 * fails when RemoteAgentSessionRuntime does not implement one. With pi pinned exactly (§10),
 * a pi upgrade becomes: bump, run this, implement the named diff — instead of a field report
 * about a subtly wrong client.
 *
 * Run: node --import tsx scripts/check-runtime-surface.ts   (wired into `npm run lint`)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
const piVersion = (JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { version: string })
  .version;

/**
 * Pods run the pi this package bundles (§10). Ranges (`^`, `~`) let `npm install` silently
 * pick a different patch than the image tag, so both pins must be exact digits and must equal
 * the installed copies. pi-tui is a direct dependency because the chord state machine uses
 * `matchesKey`, which pi does not re-export — two copies of a key parser is the skew that
 * would make a chord match here and not inside pi.
 */
const PI = "@earendil-works/pi-coding-agent";
const TUI = "@earendil-works/pi-tui";
const readJson = (file: string): Record<string, string> & { dependencies?: Record<string, string> } =>
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string> & { dependencies?: Record<string, string> };
const isExactPin = (spec: string | undefined): spec is string =>
  typeof spec === "string" && /^\d+\.\d+\.\d+/.test(spec) && !/^[~^<>]/.test(spec);

const pkgDeps = readJson(path.join(repoRoot, "package.json")).dependencies ?? {};
const piPin = pkgDeps[PI];
if (!isExactPin(piPin)) {
  console.error(`pi pin FAILED: ${PI} is ${piPin === undefined ? "missing" : `"${piPin}"`} — pin the exact version`);
  process.exit(1);
}
if (piPin !== piVersion) {
  console.error(`pi pin FAILED: package.json has ${piPin}, but the installed package is ${piVersion}`);
  process.exit(1);
}
console.log(`${PI} pinned ${piPin}`);

const tuiPin = pkgDeps[TUI];
const nestedTui = path.join(pkgDir, "node_modules", TUI, "package.json");
const piTuiVersion = fs.existsSync(nestedTui)
  ? readJson(nestedTui).version
  : readJson(path.join(repoRoot, "node_modules", TUI, "package.json")).version;

if (!isExactPin(tuiPin)) {
  console.error(`pi-tui pin FAILED: ${TUI} is ${tuiPin === undefined ? "missing" : `"${tuiPin}"`} — pin the exact version, as pi itself is`);
  process.exit(1);
}
if (tuiPin !== piTuiVersion) {
  console.error(`pi-tui pin FAILED: pinned ${tuiPin}, but pi ${piVersion} loads ${piTuiVersion} — bump the pin`);
  process.exit(1);
}
console.log(`${TUI} pinned ${tuiPin}, matching the copy pi ${piVersion} loads\n`);

// Settings must not touch the real user's config from a lint run.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-canary-"));

const { createRemoteRuntime } = await import("../src/client/runtime/remote-runtime.js");
const { RpcClientBase } = await import("../src/client/rpc.js");
class CanaryRpcClient extends RpcClientBase {
  protected askForHello(): void {}
  protected transmitCommand(): void {}
  close(): void {}
  shutdown(): void {}
  respondExtensionUi(): void {}
}
const rpc = new CanaryRpcClient();
const runtime = createRemoteRuntime({
  rpc,
  cwd: scratch,
  agentDir: path.join(scratch, "agent"),
  onEnding: async () => {},
});

const host = runtime.runtimeHost as Record<string, unknown>;
const session = host["session"] as Record<string, unknown>;

/** Every member access root InteractiveMode makes, mapped to the object that must serve it. */
const surfaces: Array<{ label: string; patterns: RegExp[]; target: object }> = [
  { label: "runtimeHost", patterns: [/runtimeHost\.(\w+)/g], target: host },
  { label: "session", patterns: [/this\.session\.(\w+)/g], target: session },
  {
    label: "sessionManager",
    patterns: [/this\.sessionManager\.(\w+)/g, /\bsessionManager\.(\w+)/g],
    target: session["sessionManager"] as object,
  },
  {
    label: "settingsManager",
    patterns: [/this\.settingsManager\.(\w+)/g, /\bsettingsManager\.(\w+)/g],
    target: session["settingsManager"] as object,
  },
  { label: "agent", patterns: [/\bagent\.(\w+)/g], target: session["agent"] as object },
  { label: "modelRuntime", patterns: [/\bmodelRuntime\.(\w+)/g], target: session["modelRuntime"] as object },
  { label: "resourceLoader", patterns: [/\bresourceLoader\.(\w+)/g], target: session["resourceLoader"] as object },
  {
    label: "extensionRunner",
    patterns: [/\bextensionRunner\.(\w+)/g],
    target: session["extensionRunner"] as object,
  },
  { label: "services", patterns: [/\bservices\.(\w+)/g], target: host["services"] as object },
];

const distDir = path.join(pkgDir, "dist/modes/interactive");
/**
 * Every .js under the interactive mode, not just its top level.
 *
 * Components live a directory down, and a non-recursive read silently excluded them: pi 0.84's
 * footer started calling `modelRuntime.isUsingSubscription`, this check reported "0
 * unimplemented", and every pod session died on its first render. A check that cannot see the
 * caller is worse than no check, because it is believed.
 */
function jsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

const source = jsFilesUnder(distDir)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

/** `x.member(`-style hits that are not member reads of our objects. */
const IGNORED = new Set([
  // JS builtins that the broad receiver regexes inevitably catch.
  "then", "catch", "finally", "call", "apply", "bind", "length", "name", "map", "filter",
  "forEach", "push", "slice", "some", "find", "includes", "join", "keys", "values", "entries",
  "get", "set", "has", "add", "delete", "size", "sort", "concat", "reduce", "indexOf", "at",
  "flatMap", "every", "findIndex", "startsWith", "endsWith", "trim", "split", "replace",
  "toLowerCase", "toUpperCase", "toString", "charAt", "padEnd", "padStart", "from", "of",
  // Import-path artifacts: `.../agent.js` in a require/import string is not a member read.
  "js", "ts",
]);

function has(target: object, member: string): boolean {
  return member in target;
}

let missing = 0;
let total = 0;
console.log(`InteractiveMode runtime-host surface vs RemoteAgentSessionRuntime — pi ${piVersion}\n`);
for (const { label, patterns, target } of surfaces) {
  const members = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const member = m[1]!;
      if (!IGNORED.has(member)) members.add(member);
    }
  }
  const gaps = [...members].filter((member) => !has(target, member)).sort();
  total += members.size;
  missing += gaps.length;
  const status = gaps.length === 0 ? "ok" : "MISSING";
  console.log(`  ${label.padEnd(16)} ${String(members.size).padStart(3)} accessed  ${status}`);
  for (const gap of gaps) console.log(`    - ${label}.${gap}`);
}

console.log(`\n${total} member accesses checked, ${missing} unimplemented`);

// --- client extension host internals (src/client/runtime/local-extensions.ts) -------------
// The host deep-imports pi's loader (loadExtensions is not re-exported publicly) and drives
// the real ExtensionRunner. Both are internals-shaped surfaces; a pi upgrade that moves them
// must fail here, at lint time, not at render time.
const { loadPiExtensionInternals } = await import("../src/client/runtime/local-extensions.js");
const extensionGaps: string[] = [];
try {
  await loadPiExtensionInternals();
} catch (e) {
  extensionGaps.push(`loader: ${e instanceof Error ? e.message : String(e)}`);
}
const pi = await import("@earendil-works/pi-coding-agent");
const RUNNER_MEMBERS = [
  "bindCore",
  "bindCommandContext",
  "setUIContext",
  "getAllRegisteredTools",
  "getRegisteredCommands",
  "getCommand",
  "getCommandDiagnostics",
  "getShortcuts",
  "getShortcutDiagnostics",
  "getEntryRenderer",
  "getMessageRenderer",
  "getMarkdownTransformers",
  "createCommandContext",
  "hasHandlers",
  "emit",
  "emitError",
  "onError",
  "invalidate",
];
const runnerPrototype = (pi.ExtensionRunner as { prototype: object }).prototype;
for (const member of RUNNER_MEMBERS) {
  if (!(member in runnerPrototype)) extensionGaps.push(`ExtensionRunner.${member}`);
}
// The local sessionManager facade mirrors pi's real SessionManager reads; a rename there is
// a rename in what client extensions call.
const SESSION_MANAGER_MEMBERS = [
  "getEntries",
  "getBranch",
  "getLeafId",
  "getLeafEntry",
  "getEntry",
  "getChildren",
  "getLabel",
  "getTree",
  "buildContextEntries",
  "getSessionName",
  "getSessionFile",
  "getSessionId",
];
const sessionManagerPrototype = (pi as unknown as { SessionManager: { prototype: object } }).SessionManager
  .prototype;
for (const member of SESSION_MANAGER_MEMBERS) {
  if (!(member in sessionManagerPrototype)) extensionGaps.push(`SessionManager.${member}`);
}
if (extensionGaps.length === 0) {
  console.log(`client extension host internals ok (${RUNNER_MEMBERS.length + SESSION_MANAGER_MEMBERS.length} members)`);
} else {
  for (const gap of extensionGaps) console.log(`    - ${gap}`);
}

// Pod-derived themes deep-import pi's theme loader (loadThemeFromPath is not re-exported
// from the public entry). Assert it here so a pi upgrade that moves it fails at lint.
try {
  const themeUrl = new URL(
    "modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const themeModule = (await import(themeUrl.href)) as { loadThemeFromPath?: unknown };
  if (typeof themeModule.loadThemeFromPath !== "function") {
    extensionGaps.push("theme.loadThemeFromPath");
  } else {
    console.log("pod theme loader internals ok (loadThemeFromPath)");
  }
} catch (e) {
  extensionGaps.push(`theme loader: ${e instanceof Error ? e.message : String(e)}`);
}

fs.rmSync(scratch, { recursive: true, force: true });
if (missing > 0 || extensionGaps.length > 0) {
  console.error(
    "\nsurface canary FAILED: implement the members above in src/client/runtime/remote-runtime.ts " +
      "or src/client/runtime/local-extensions.ts",
  );
  process.exit(1);
}
