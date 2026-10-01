/**
 * Shared helpers for the version-controlled load-test harness.
 *
 * Pure logic lives here (no network, no process exit) so
 * `test/loadtest-unit.test.ts` (node:test) can exercise it directly.
 */

/** Defaults matching the hetzner-1 origin host layout. */
export const DEFAULTS = {
  base: "http://10.79.0.2:8433",
  image: "ghcr.io/pi-pod/pi-pod-base:r1-pi0.84.4-imgc730fa3798aa",
  tag: "loadtest",
  out: "./out",
  host: "hetzner-1",
  class: "ccx33",
  imageDigest: "sha256:47e3d9b8156a7e01730ad31c389255a9f725e7b57a81b25ee83d5e7a953bbc83",
  kernel: "6.12.107+deb13-cloud-amd64",
  envFile: "/etc/pipod/pi-pod-sandbox/runtime.env",
  ltDir: "/root/loadtest",
  service: "pi-pod-sandbox",
  cgroupRoot: "/sys/fs/cgroup/pps",
  stateDir: "/var/lib/docker/volumes/pipod_sandbox_state/_data/sandboxes",
};

export const SCHEMA_VERSION = 1;

// Exact runtime owner.userKey contract (src/wire.ts). Keep the load tool's
// protected environment input aligned without importing runtime code on-host.
const OWNER_USER_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** Owner is mandatory for load creates and is accepted only from the environment. */
export function requireOwnerKey(env = {}) {
  const ownerKey = env.LT_OWNER_KEY;
  if (typeof ownerKey !== "string" || !OWNER_USER_KEY.test(ownerKey)) {
    throw new Error(
      "LT_OWNER_KEY must match owner.userKey ([A-Za-z0-9._-], 1-64 chars); provide it through the protected environment, never a CLI flag",
    );
  }
  return ownerKey;
}

/** The exact request-body path shared by both load-test entrypoints. */
export function withLoadtestOwner(body, ownerKey) {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !OWNER_USER_KEY.test(ownerKey)) {
    throw new Error("invalid load-test create owner");
  }
  return { ...body, owner: { userKey: ownerKey } };
}

/**
 * Percentile over a numeric array, p in [0, 100].
 * Sorts a copy; index = min(len-1, floor(p/100 * len)).
 * Matches the on-host harness `stats()` convention.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const xs = [...values].sort((a, b) => a - b);
  const idx = Math.min(xs.length - 1, Math.floor((p / 100) * xs.length));
  return xs[idx];
}

export function summarizeSamples(values) {
  const xs = (values ?? []).filter((n) => Number.isFinite(n));
  if (xs.length === 0) {
    return { n: 0, p50: null, p90: null, p95: null, p99: null, max: null };
  }
  return {
    n: xs.length,
    p50: Math.round(percentile(xs, 50)),
    p90: Math.round(percentile(xs, 90)),
    p95: Math.round(percentile(xs, 95)),
    p99: Math.round(percentile(xs, 99)),
    max: Math.round(Math.max(...xs)),
  };
}

/**
 * Minimal `--flag value` parser over an argv array (no leading prog name).
 * Known flags have defaults from DEFAULTS/env; unknown `--flags` are kept as
 * strings so subcommand-specific options (e.g. --cpu, --n) still work.
 */
export function parseArgs(argv, env = {}) {
  const out = {
    base: env.LT_BASE ?? DEFAULTS.base,
    image: env.LT_IMAGE ?? DEFAULTS.image,
    tag: env.LT_TAG ?? DEFAULTS.tag,
    out: env.LT_OUT ?? DEFAULTS.out,
    host: env.LT_HOST ?? DEFAULTS.host,
    class: env.LT_CLASS ?? DEFAULTS.class,
    imageDigest: env.LT_IMAGE_DIGEST ?? DEFAULTS.imageDigest,
    kernel: env.LT_KERNEL ?? DEFAULTS.kernel,
    envFile: DEFAULTS.envFile,
    ltDir: DEFAULTS.ltDir,
    service: DEFAULTS.service,
    cgroupRoot: DEFAULTS.cgroupRoot,
    stateDir: DEFAULTS.stateDir,
    extra: {},
  };
  const known = new Map([
    ["base", "base"],
    ["image", "image"],
    ["tag", "tag"],
    ["out", "out"],
    ["host", "host"],
    ["class", "class"],
    ["image-digest", "imageDigest"],
    ["kernel", "kernel"],
    ["env-file", "envFile"],
    ["lt-dir", "ltDir"],
    ["service", "service"],
    ["cgroup-root", "cgroupRoot"],
    ["state-dir", "stateDir"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const value = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? argv[++i] : "1";
    if (known.has(name)) out[known.get(name)] = value;
    else out.extra[name] = value;
  }
  return out;
}

/** Token comes ONLY from the environment (typically via --env-file). Never a flag. */
export function requireToken(env = {}) {
  const token = env.PI_POD_SANDBOX_TOKEN;
  if (!token) {
    throw new Error(
      "PI_POD_SANDBOX_TOKEN is not set (pass --env-file <runtime.env> to lt.sh; the token is never a CLI flag)",
    );
  }
  return token;
}

/**
 * Build the unified per-run result envelope every subcommand writes.
 * samples: raw latency/value samples; wallMs/errors/timings describe the run.
 */
export function buildResult({
  host = DEFAULTS.host,
  class: cls = DEFAULTS.class,
  imageDigest = DEFAULTS.imageDigest,
  kernel = DEFAULTS.kernel,
  config = {},
  subcommand,
  samples = [],
  wallMs = null,
  errors = [],
  startedAt = new Date().toISOString(),
  finishedAt = new Date().toISOString(),
}) {
  const s = summarizeSamples(samples);
  return {
    schemaVersion: SCHEMA_VERSION,
    host,
    class: cls,
    imageDigest,
    kernel,
    config,
    subcommand,
    n: s.n,
    p50: s.p50,
    p90: s.p90,
    p95: s.p95,
    p99: s.p99,
    max: s.max,
    wallMs,
    errors,
    startedAt,
    finishedAt,
  };
}

/** Structural validation of a result envelope against schema.json (no deps). */
export function validateResult(obj) {
  const errors = [];
  if (typeof obj !== "object" || obj === null) return ["result must be an object"];
  if (obj.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const key of ["host", "class", "imageDigest", "kernel", "subcommand"]) {
    if (typeof obj[key] !== "string" || obj[key].length === 0) errors.push(`${key} must be a non-empty string`);
  }
  if (typeof obj.config !== "object" || obj.config === null) errors.push("config must be an object");
  if (!Number.isInteger(obj.n) || obj.n < 0) errors.push("n must be a non-negative integer");
  for (const key of ["p50", "p90", "p95", "p99", "max"]) {
    if (obj[key] !== null && (!Number.isFinite(obj[key]) || obj[key] < 0)) errors.push(`${key} must be null or a non-negative number`);
  }
  if (obj.n === 0) {
    for (const key of ["p50", "p90", "p95", "p99", "max"]) {
      if (obj[key] !== null) errors.push(`${key} must be null when n is 0`);
    }
  }
  if (obj.wallMs !== null && (!Number.isFinite(obj.wallMs) || obj.wallMs < 0)) errors.push("wallMs must be null or a non-negative number");
  if (!Array.isArray(obj.errors)) errors.push("errors must be an array");
  for (const key of ["startedAt", "finishedAt"]) {
    if (typeof obj[key] !== "string" || Number.isNaN(Date.parse(obj[key]))) errors.push(`${key} must be an ISO timestamp string`);
  }
  return errors;
}
