/**
 * Dependency-free runtime identity code embedded in agentd. Managed Pi needs only a small
 * package read, not a second CLI startup. The executable and metadata snapshots belong to
 * one child: a later install/symlink switch must never relabel the already-running Pi.
 */
export const PI_IDENTITY_SOURCE = String.raw`
const piIdentityPath = require("node:path");
const { spawn: piIdentitySpawn } = require("node:child_process");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_VERSION_PROBE_MS = 20000;
const PI_VERSION_RETRY_DELAY_MS = 1000;

function validPiVersion(value) {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return !!match && (!match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0")));
}
function piFileIdentity(file) {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("not a regular file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function resolvePiExecutable(command) {
  const candidates = command.includes("/")
    ? [piIdentityPath.resolve(command)]
    : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").map((dir) => piIdentityPath.resolve(dir || ".", command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const executable = fs.realpathSync(candidate);
      if (!fs.statSync(executable).isFile()) continue;
      const fingerprint = piFileIdentity(executable);
      return { executable, fingerprint };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) throw error;
    }
  }
  throw new Error("Pi executable is unavailable");
}
function piIdentityFailure(code, retryable) {
  return { version: "unknown", error: { code, retryable } };
}

function createPiIdentity(command) {
  let target;
  try { target = resolvePiExecutable(command); }
  catch { return { executable: null, current: piIdentityFailure("executable_unavailable", false), refresh: async function () { return this.current; } }; }

  let packageFile = null;
  let packageFingerprint = null;
  let managed = false;
  let discoveryError = null;
  // The nearest package owns the executable. Never borrow an unrelated ancestor's version.
  for (let directory = piIdentityPath.dirname(target.executable);;) {
    const candidate = piIdentityPath.join(directory, "package.json");
    try {
      const fingerprint = piFileIdentity(candidate);
      packageFile = candidate;
      packageFingerprint = fingerprint;
      if (fs.statSync(candidate).size > 64 * 1024) {
        discoveryError = piIdentityFailure("invalid_metadata", false);
        break;
      }
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new SyntaxError("invalid package metadata");
      if (piFileIdentity(candidate) !== fingerprint) {
        discoveryError = piIdentityFailure("installation_changed", false);
      } else if (pkg.name === PI_PACKAGE_NAME) {
        managed = true;
      }
      break;
    } catch (error) {
      if (packageFile) {
        discoveryError = piIdentityFailure(error instanceof SyntaxError ? "invalid_metadata" : "metadata_unavailable", !(error instanceof SyntaxError));
        break;
      }
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        discoveryError = piIdentityFailure("metadata_unavailable", true);
        break;
      }
    }
    const parent = piIdentityPath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  let current = discoveryError ?? piIdentityFailure("probe_failed", true);
  let inFlight = null;
  let retryAfter = 0;
  function identityFailure() {
    try {
      return piFileIdentity(target.executable) === target.fingerprint &&
        (packageFile === null || piFileIdentity(packageFile) === packageFingerprint)
        ? null : piIdentityFailure("installation_changed", false);
    } catch (error) {
      // A missing/replaced file disproves identity. An I/O/descriptor failure merely
      // prevents checking it right now and must not become a lifetime negative cache.
      return ["ENOENT", "ENOTDIR"].includes(error?.code)
        ? piIdentityFailure("installation_changed", false) : piIdentityFailure("metadata_unavailable", true);
    }
  }
  function readManagedVersion() {
    const failure = identityFailure();
    if (failure) return failure;
    try {
      const stat = fs.statSync(packageFile);
      if (stat.size > 64 * 1024) return piIdentityFailure("invalid_metadata", false);
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return piIdentityFailure("invalid_metadata", false);
      const afterRead = identityFailure();
      if (afterRead) return afterRead;
      if (pkg.name !== PI_PACKAGE_NAME || !validPiVersion(pkg.version)) return piIdentityFailure("invalid_metadata", false);
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (typeof bin !== "string" || piIdentityPath.isAbsolute(bin)) return piIdentityFailure("invalid_metadata", false);
      const root = piIdentityPath.dirname(packageFile);
      const binPath = piIdentityPath.resolve(root, bin);
      if (!binPath.startsWith(root + piIdentityPath.sep)) return piIdentityFailure("invalid_metadata", false);
      try { if (fs.realpathSync(binPath) !== target.executable) return piIdentityFailure("invalid_metadata", false); }
      catch { return piIdentityFailure("invalid_metadata", false); }
      return { version: pkg.version, source: "package" };
    } catch (error) {
      return piIdentityFailure(error instanceof SyntaxError ? "invalid_metadata" : "metadata_unavailable", !(error instanceof SyntaxError));
    }
  }
  // A failed read after a successful stat can be retried, but only against that same file.
  // The package name is checked again on retry, so failed JSON/I/O never becomes wrapper mode.
  if (managed || (discoveryError && packageFile !== null)) {
    managed = true;
    if (!discoveryError) current = readManagedVersion();
  }

  function probeWrapperVersion() {
    // Custom pi.command wrappers retain their existing --version contract. Their own
    // immutable executable must report the same runtime they launch; this is not attestation.
    return new Promise((resolve) => {
      const probe = piIdentitySpawn(target.executable, ["--version"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      let outputBytes = 0;
      let settled = false;
      function stopProbe() { try { if (probe.pid) process.kill(-probe.pid, "SIGKILL"); } catch {} }
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.removeListener("exit", stopProbe);
        stopProbe();
        probe.stdout.destroy();
        resolve(identityFailure() ?? result);
      }
      const timer = setTimeout(() => finish(piIdentityFailure("probe_timeout", true)), PI_VERSION_PROBE_MS);
      process.once("exit", stopProbe);
      probe.stdout.setEncoding("utf8");
      probe.stdout.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk, "utf8");
        if (outputBytes > 64 * 1024) finish(piIdentityFailure("invalid_version", false));
        else output += chunk;
      });
      probe.on("error", () => finish(piIdentityFailure("probe_failed", true)));
      probe.on("close", (code) => {
        const version = output.trim();
        finish(code !== 0 ? piIdentityFailure("probe_failed", true) : validPiVersion(version)
          ? { version, source: "command" } : piIdentityFailure("invalid_version", false));
      });
    });
  }
  return {
    executable: target.executable,
    get current() { return current; },
    refresh() {
      if (current.version !== "unknown" || current.error?.retryable === false) return Promise.resolve(current);
      if (inFlight) return inFlight;
      const delay = Math.max(0, retryAfter - Date.now());
      const attempt = new Promise((resolve) => setTimeout(resolve, delay)).then(() => {
        const failure = identityFailure();
        if (failure) return failure;
        return managed ? readManagedVersion() : discoveryError
          ? piIdentityFailure("metadata_unavailable", false) : probeWrapperVersion();
      });
      inFlight = attempt.then((result) => {
        current = result;
        retryAfter = Date.now() + PI_VERSION_RETRY_DELAY_MS;
        inFlight = null;
        return current;
      });
      return inFlight;
    },
  };
}
`;
