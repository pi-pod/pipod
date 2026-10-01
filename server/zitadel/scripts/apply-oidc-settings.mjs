#!/usr/bin/env node
/**
 * Check/apply instance OIDC token lifetimes against zitadel/oidc-settings.json.
 *
 * These are instance settings (iam.read / iam.write), not pipod-project config.
 * The project reconciler does not touch them. --check is the default; --apply
 * creates or updates the instance OIDC settings. Requires an IAM_OWNER PAT.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_DEFAULT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const SETTINGS_PATH = "/admin/v1/settings/oidc";
const LIFETIME_FIELDS = [
  "accessTokenLifetime",
  "idTokenLifetime",
  "refreshTokenIdleExpiration",
  "refreshTokenExpiration",
];

const contractPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../oidc-settings.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));

function configuration(argv = process.argv.slice(2), env = process.env) {
  let mode = "check";
  for (const argument of argv) {
    if (argument === "--check") mode = "check";
    else if (argument === "--apply") mode = "apply";
    else throw new Error(`unknown argument ${JSON.stringify(argument)} (expected --check or --apply)`);
  }
  if (argv.includes("--check") && argv.includes("--apply")) {
    throw new Error("--check and --apply are mutually exclusive");
  }

  const expectedIssuer = required(env.ZITADEL_EXPECTED_ISSUER, "ZITADEL_EXPECTED_ISSUER");
  const pat = required(env.ZITADEL_PAT, "ZITADEL_PAT");

  const issuerUrl = validateSecureUrl(expectedIssuer, "ZITADEL_EXPECTED_ISSUER");
  if (issuerUrl.search || issuerUrl.hash || issuerUrl.username || issuerUrl.password) {
    throw new Error("ZITADEL_EXPECTED_ISSUER must not contain credentials, a query, or a fragment");
  }
  if (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "") {
    throw new Error("ZITADEL_EXPECTED_ISSUER must be the instance origin without a path");
  }
  const issuer = `${issuerUrl.origin}`;
  if (env.ZITADEL_URL) {
    const configuredBase = validateSecureUrl(env.ZITADEL_URL.trim(), "ZITADEL_URL");
    const normalizedBase = `${configuredBase.origin}${configuredBase.pathname.replace(/\/$/, "")}`;
    if (configuredBase.search || configuredBase.hash || normalizedBase !== issuer) {
      throw new Error("ZITADEL_URL does not exactly match ZITADEL_EXPECTED_ISSUER");
    }
  }

  const timeoutMs = Number(env.ZITADEL_HTTP_TIMEOUT_MS ?? TIMEOUT_DEFAULT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("ZITADEL_HTTP_TIMEOUT_MS must be an integer from 1000 through 30000");
  }

  return { mode, expectedIssuer: issuer, pat, origin: issuerUrl.origin, timeoutMs };
}

function required(value, name) {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required as an explicit target confirmation`);
  return trimmed;
}

function validateSecureUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid absolute URL`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for explicit loopback development)`);
  }
  return url;
}

/** protojson ("300s") or Go duration ("5m0s", "720h") → whole seconds. */
function durationSeconds(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const proto = /^(\d+)(?:\.\d+)?s$/.exec(value);
  if (proto) return Number(proto[1]);
  let seconds = 0;
  let consumed = 0;
  const re = /(\d+)(h|m|s)/g;
  let match;
  while ((match = re.exec(value))) {
    consumed += match[0].length;
    const n = Number(match[1]);
    if (match[2] === "h") seconds += n * 3600;
    else if (match[2] === "m") seconds += n * 60;
    else seconds += n;
  }
  if (consumed === 0 || consumed !== value.length) return null;
  return seconds;
}

function desiredBody() {
  const body = {};
  for (const field of LIFETIME_FIELDS) {
    const seconds = durationSeconds(contract[field]);
    if (seconds === null) throw new Error(`oidc-settings.json ${field} is not a duration`);
    body[field] = `${seconds}s`;
  }
  return body;
}

async function request(config, url, options, label) {
  const target = url instanceof URL ? url : new URL(url);
  validateEndpoint(config, target, label);
  let response;
  try {
    response = await fetch(target, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "request failed";
    throw new Error(`${label}: ${reason}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${label}: redirects are forbidden (HTTP ${response.status})`);
  }
  return response;
}

function validateEndpoint(config, url, label) {
  validateSecureUrl(url.href, label);
  if (url.origin !== config.origin) throw new Error(`${label} is cross-origin`);
  if (url.username || url.password || url.hash) throw new Error(`${label} contains forbidden URL components`);
}

async function jsonResponse(config, url, options, label, expectedStatuses) {
  const response = await request(config, url, options, label);
  if (!expectedStatuses.includes(response.status)) {
    if (response.status === 403) {
      throw new Error(`${label}: HTTP 403 (ZITADEL_PAT needs iam.read/iam.write — IAM_OWNER)`);
    }
    throw new Error(`${label}: unexpected HTTP ${response.status}`);
  }
  if (response.status === 204) return { status: response.status, body: null };
  const text = await response.text();
  if (!text) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${label}: response was not valid JSON`);
  }
}

async function api(config, method, apiPath, body, expectedStatuses = [200]) {
  if (!new Set(["GET", "POST", "PUT"]).has(method)) throw new Error(`forbidden admin API method ${method}`);
  const headers = { authorization: `Bearer ${config.pat}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  return jsonResponse(
    config,
    new URL(`${config.expectedIssuer}${apiPath}`),
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    `${method} ${apiPath}`,
    expectedStatuses,
  );
}

async function discover(config) {
  const discoveryUrl = new URL(`${config.expectedIssuer}/.well-known/openid-configuration`);
  const { body: document } = await jsonResponse(config, discoveryUrl, { method: "GET" }, "instance discovery", [200]);
  if (!document || typeof document !== "object") throw new Error("instance discovery was not an object");
  if (document.issuer !== config.expectedIssuer) {
    throw new Error("instance discovery issuer did not exactly match expected issuer");
  }
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === "string" && (key.endsWith("_endpoint") || key.endsWith("_uri"))) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`instance discovery ${key} is not an absolute URL`);
      }
      validateEndpoint(config, url, `instance discovery ${key}`);
    }
  }
}

async function authenticate(config) {
  await discover(config);
  const { body: me } = await api(config, "GET", "/auth/v1/users/me");
  if (!me?.user?.id) throw new Error("ZITADEL_PAT authentication did not resolve a service user");
}

async function readSettings(config) {
  const { status, body } = await api(config, "GET", SETTINGS_PATH, undefined, [200, 404]);
  if (status === 404) return null;
  const settings = body?.settings ?? body;
  if (!settings || typeof settings !== "object") return null;
  return settings;
}

function driftFor(settings) {
  if (!settings) return ["instance OIDC settings are missing"];
  const drift = [];
  for (const field of LIFETIME_FIELDS) {
    const actual = durationSeconds(settings[field]);
    const expected = durationSeconds(contract[field]);
    if (actual !== expected) {
      drift.push(`${field} must be ${contract[field]} (${expected}s), found ${JSON.stringify(settings[field])}`);
    }
  }
  return drift;
}

async function apply(config, settings) {
  const body = desiredBody();
  if (!settings) {
    await api(config, "POST", SETTINGS_PATH, body, [200, 201]);
    process.stdout.write("applied: created instance OIDC settings\n");
    return;
  }
  await api(config, "PUT", SETTINGS_PATH, body, [200, 204]);
  process.stdout.write("applied: updated instance OIDC settings\n");
}

async function main() {
  const config = configuration();
  await authenticate(config);
  let settings = await readSettings(config);
  const initialDrift = driftFor(settings);
  if (config.mode === "apply" && initialDrift.length > 0) {
    await apply(config, settings);
    settings = await readSettings(config);
  }
  const drift = driftFor(settings);
  if (drift.length > 0) {
    process.stderr.write(`OIDC settings drift (${drift.length}):\n- ${drift.join("\n- ")}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`instance OIDC token lifetimes are reconciled (${config.mode})\n`);
  for (const field of LIFETIME_FIELDS) {
    process.stdout.write(`${field}: ${contract[field]}\n`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`apply-oidc-settings failed: ${message}\n`);
  process.exitCode = 1;
});
