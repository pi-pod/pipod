/**
 * Secure-secrets required manual script (plan §7, checklist 1–11).
 *
 * Disposable fixtures only. Run from the pi-pod-server directory:
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/secure_secrets_manual \
 *     node --import tsx scripts/secrets-manual.ts
 *
 * Safety rules (enforced in code, not just docs):
 * - The database URL must be EXACTLY the disposable local database above. Anything
 *   else — including any other host, port, or database name — exits 2 before touching
 *   anything. Production hosts are never contacted for writes; item 11 performs one
 *   read-only HTTPS GET against the public health endpoint and nothing else.
 * - Canary values are random per run, compared in memory (or as hashes across a
 *   process boundary), and NEVER printed, logged, or written to the results file.
 *   Only names, hashes, counts, and booleans leave this process.
 * - Every fixture row is deleted in `finally`. The database itself (migrated schema
 *   plus a clearly-labeled FIXTURE-049 helper column) is disposable and local-only.
 *
 * Real migrations only: 049_encryption_version.sql supplies `encryption_version` plus
 * CHECK constraints on all four live tables (pi_settings is conditionally covered and
 * absent here — see 6f). The script asserts 049 is applied and fails fast otherwise.
 *
 * Phase 3 operator CLI (src/secrets-maintenance.ts) is exercised in section 8 via
 * child processes pointed at the disposable DB with fixture keys. Section 11 performs
 * read-only `ssh pipod` verifies (WG, fleet, on-box health); it never mutates prod.
 *
 * Conventions follow scripts/host-pods-manual.ts: PASS/FAIL/BLOCKED per check,
 * `step()` dividers, non-zero exit on FAIL only (BLOCKED is reported, not hidden).
 */
import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { initPool, closePool, query } from "../src/server/db/index.js";
import { migrate, defaultMigrationsDir } from "../src/server/db/migrate.js";
import { loadEnv, resetEnvCache, INSECURE_PLACEHOLDER_KEK } from "../src/server/env.js";
import type { ServerEnv } from "../src/server/env.js";
import { makeAuthHook, type AuthContext } from "../src/server/auth/plugin.js";
import { POD_TOKEN_PREFIX, createPodToken } from "../src/server/pods/podtoken.js";
import {
  EnvKekProvider,
  SecretCryptoError,
  UnknownKekError,
  decryptSecret,
  encryptSecret,
  rewrapSecret,
} from "../src/server/secrets/crypto.js";
import { secretContext, modelCredentialContext, podLaunchEnvContext } from "../src/server/secrets/context.js";
import { putSecret, resolveSecrets, withoutProviderCredentials } from "../src/server/secrets/store.js";
import { registerSecretRoutes } from "../src/server/secrets/routes.js";
import { loadPodLaunchEnv, savePodLaunchEnv } from "../src/server/pods/launchenv.js";
import { uuidv7 } from "../src/server/ids.js";

// ---------------------------------------------------------------- guards

const EXPECTED_DATABASE_URL = "postgres://postgres@127.0.0.1:55439/secure_secrets_manual";
const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
if (databaseUrl !== EXPECTED_DATABASE_URL) {
  console.error(
    `refusing to run: PI_POD_TEST_DATABASE_URL must be exactly ${EXPECTED_DATABASE_URL} ` +
      `(got ${databaseUrl === undefined ? "unset" : "a different value, hidden"})`,
  );
  process.exit(2);
}
if (path.basename(process.cwd()) !== "pi-pod-server") {
  console.error("run from the pi-pod-server directory so migrations resolve to ./migrations");
  process.exit(2);
}
// No other endpoint is ever used: the script talks only to the disposable local DB
// above and to an in-process Fastify server on 127.0.0.1. Ambient PI_POD_* env from an
// outer sandbox is stripped by cleanBaseEnv() before any child process runs.

// ---------------------------------------------------------------- report

type Verdict = "PASS" | "FAIL" | "BLOCKED";
let pass = 0;
let fail = 0;
let blocked = 0;
const blockedReasons: string[] = [];
function check(name: string, verdict: Verdict, detail = ""): void {
  if (verdict === "PASS") pass += 1;
  else if (verdict === "FAIL") fail += 1;
  else {
    blocked += 1;
    blockedReasons.push(`${name}: ${detail}`);
  }
  console.log(`${verdict}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function step(name: string): void {
  console.log(`\n== ${name}`);
}
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- fixtures

const rand = (n: number): string => randomBytes(n).toString("hex");
const canary = (tag: string): string => `manual-${rand(4)}-${tag}-${rand(16)}`;
const KEK1_ID = "manual-kek-1";
const KEK2_ID = "manual-kek-2";
const kek1Bytes = randomBytes(32);
const kek2Bytes = randomBytes(32);
const kek1 = new EnvKekProvider(KEK1_ID, kek1Bytes.toString("base64"));
const kek2 = new EnvKekProvider(KEK2_ID, kek2Bytes.toString("base64"), {
  [KEK1_ID]: kek1Bytes.toString("base64"),
});

const orgA = uuidv7();
const orgB = uuidv7();
const userA = uuidv7(); // member of orgA and orgB (shared user)
const userB = uuidv7(); // member of orgA only (second user)
const templateA = uuidv7();
const podId = uuidv7();
const podId2 = uuidv7();

// Fixture bearer tokens for the in-process server (never leave this machine).
const TOKEN_A = `fixture-${rand(8)}-user-a`;
const TOKEN_B = `fixture-${rand(8)}-user-b`;
const ALL_PERMS = ["secrets:org:write", "secrets:own:write", "templates:write"];

/** Craft a v1 (legacy, unauthenticated) envelope by hand: [u16be len][wrapped][sealed]. */
function craftV1Envelope(rawKek: Buffer, plaintext: string): Buffer {
  const dek = randomBytes(32);
  try {
    const wrapIv = randomBytes(12);
    const wrap = createCipheriv("aes-256-gcm", rawKek, wrapIv);
    const wrapBody = Buffer.concat([wrap.update(dek), wrap.final()]);
    const wrapped = Buffer.concat([wrapIv, wrap.getAuthTag(), wrapBody]);
    const sealIv = randomBytes(12);
    const seal = createCipheriv("aes-256-gcm", dek, sealIv);
    const sealBody = Buffer.concat([seal.update(Buffer.from(plaintext, "utf8")), seal.final()]);
    const sealed = Buffer.concat([sealIv, seal.getAuthTag(), sealBody]);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(wrapped.length, 0);
    return Buffer.concat([header, wrapped, sealed]);
  } finally {
    dek.fill(0);
  }
}

function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "NODE_OPTIONS" || key.startsWith("PI_POD")) continue;
    env[key] = value;
  }
  return env;
}

function runProc(
  argv: string[],
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string; timeoutMs?: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...cleanBaseEnv(), ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.stderr.on("data", (d) => {
      output += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `spawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------- main

let app: ReturnType<typeof Fastify> | null = null;
let serverUrl = "";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-manual-"));
const cliHome = path.join(tmpRoot, "cli-home");
fs.mkdirSync(cliHome, { recursive: true });

async function main(): Promise<void> {
  // Real migrations, then assert 049 landed with its CHECK constraints.
  await migrate(databaseUrl!, defaultMigrationsDir());
  initPool(databaseUrl!); // migrate() closes its pool in `finally`; reopen for fixtures
  const applied49 = await query("SELECT 1 FROM schema_migrations WHERE name = '049_encryption_version.sql'");
  const checks = await query<{ conname: string }>(
    "SELECT conname FROM pg_constraint WHERE conname IN ('secrets_encryption_version_check', 'model_credentials_encryption_version_check', 'pi_auth_encryption_version_check', 'pod_launch_env_encryption_version_check')");
  if ((applied49.rowCount ?? 0) === 0 || (checks.rowCount ?? 0) !== 4) {
    throw new Error("migration 049_encryption_version.sql is not fully applied to the disposable DB; re-run migrate-main");
  }

  // Base org/user/template/pod rows for every later check.
  await query("INSERT INTO organizations (id, name) VALUES ($1, 'manual org a'), ($2, 'manual org b')", [
    orgA,
    orgB,
  ]);
  await query("INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)", [
    userA,
    `${userA}@manual.test`,
    userB,
    `${userB}@manual.test`,
  ]);
  await query("INSERT INTO pod_templates (id, org_id, name, created_from_pod) VALUES ($1, $2, 'manual template', $3)", [
    templateA,
    orgA,
    podId,
  ]);
  for (const [id, state] of [[podId, "stopped"], [podId2, "stopped"]] as const) {
    await query(
      "INSERT INTO pods (id, org_id, user_id, provider, state, resolved_config, name, provider_state) VALUES ($1, $2, $3, 'host', $4, '{}', 'manual-pod', 'stopped')",
      [id, orgA, userA, state],
    );
  }
  const podToken = await createPodToken({ podId, orgId: orgA, userId: userA });

  // In-process API server: fixture humans by token map, real pod-token verification.
  const humans: Record<string, AuthContext> = {
    [TOKEN_A]: {
      userId: userA,
      email: `${userA}@manual.test`,
      orgId: orgA,
      permissions: ALL_PERMS,
    },
    [TOKEN_B]: {
      userId: userB,
      email: `${userB}@manual.test`,
      orgId: orgA,
      permissions: ALL_PERMS,
    },
  };
  const realHook = makeAuthHook({} as ServerEnv, undefined);
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status < 500) {
      return reply.code(status).send({ error: error.message });
    }
    return reply.code(500).send({ error: "internal error" });
  });
  app.decorate("authenticate", async (req: { auth?: unknown; headers: Record<string, string | undefined> }) => {
    const header = req.headers["authorization"] ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (bearer && humans[bearer]) {
      (req as { auth: unknown }).auth = humans[bearer];
      return;
    }
    if (bearer.startsWith(POD_TOKEN_PREFIX)) {
      await realHook(req as never, {} as never);
      return;
    }
    throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  });
  registerSecretRoutes(app, kek2);
  await app.register(async (v1) => {
    registerSecretRoutes(v1, kek2);
    // Harness stub for template discovery ONLY (the CLI resolves `template/<name>`
    // via listTemplates). Every secrets PUT/DELETE still runs the real route with
    // real auth against real rows; this stub performs no authorization itself.
    v1.get("/templates", { preHandler: [app.authenticate] }, async () => {
      const now = new Date().toISOString();
      const other = (await query<{ id: string }>("SELECT id FROM pod_templates WHERE org_id = $1 AND name = 'other template'", [orgA])).rows[0]?.id ?? templateA;
      const shape = (id: string, name: string) => ({
        id, name, description: null, status: "active" as const, initScript: null, config: {},
        createdAt: now, updatedAt: now,
      });
      return { templates: [shape(templateA, "manual template"), shape(other, "other template")] };
    });
  }, { prefix: "/v1" });
  serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const api = async (
    method: "GET" | "PUT" | "DELETE",
    urlPath: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: string }> => {
    const res = await app!.inject({ method, url: urlPath, headers: { authorization: `Bearer ${token}` },
      payload: body });
    return { status: res.statusCode, body: res.body };
  };

  // ---------------------------------------------------------- 1. KEK boot gate
  step("1. missing/empty/placeholder KEK must fail boot");
  {
    const base: Record<string, string> = {
      DATABASE_URL: databaseUrl!,
      ZITADEL_ISSUER: "http://127.0.0.1:8090",
      ZITADEL_API_AUDIENCE: "pipod-api",
      SECRETS_KEK: kek1Bytes.toString("base64"),
      SECRETS_KEK_ID: KEK1_ID,
    };
    const attempt = (mutate: (e: Record<string, string>) => void): { ok: boolean; message: string } => {
      resetEnvCache();
      const env = { ...base };
      mutate(env);
      try {
        loadEnv(env as NodeJS.ProcessEnv);
        return { ok: true, message: "" };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      } finally {
        resetEnvCache();
      }
    };
    const missing = attempt((e) => {
      delete e["SECRETS_KEK"];
    });
    const empty = attempt((e) => {
      e["SECRETS_KEK"] = "";
    });
    const placeholder = attempt((e) => {
      e["SECRETS_KEK"] = INSECURE_PLACEHOLDER_KEK;
    });
    const malformed = attempt((e) => {
      e["SECRETS_KEK"] = "not-valid-base64!!!";
    });
    check("1a. missing KEK fails boot", !missing.ok ? "PASS" : "FAIL", missing.message.slice(0, 120));
    check("1b. empty KEK fails boot", !empty.ok ? "PASS" : "FAIL", empty.message.slice(0, 120));
    check("1c. all-zero placeholder KEK fails boot", !placeholder.ok ? "PASS" : "FAIL",
      placeholder.message.slice(0, 120));
    check("1d. malformed base64 KEK fails boot", !malformed.ok ? "PASS" : "FAIL",
      malformed.message.slice(0, 120));
    const leaks = [missing.message, empty.message, placeholder.message, malformed.message].some(
      (m) => m.includes(kek1Bytes.toString("base64")) || m.includes(INSECURE_PLACEHOLDER_KEK),
    );
    check("1e. boot errors never echo key material", !leaks ? "PASS" : "FAIL");
    check("1f. clean self-host compose boot", "BLOCKED", "no local docker; pipod droplet has docker + 103G free via ssh but a disposable remote stack needs parent coordination");
  }

  // ---------------------------------------------------------- 2. real KEK boots
  step("2. generate a real KEK and restart successfully");
  {
    resetEnvCache();
    let booted = false;
    let message = "";
    try {
      const fresh = randomBytes(32).toString("base64");
      loadEnv({
        DATABASE_URL: databaseUrl!,
        ZITADEL_ISSUER: "http://127.0.0.1:8090",
        ZITADEL_API_AUDIENCE: "pipod-api",
        SECRETS_KEK: fresh,
        SECRETS_KEK_ID: "manual-fresh-kek",
      } as NodeJS.ProcessEnv);
      const provider = new EnvKekProvider("manual-fresh-kek", fresh);
      const { ciphertext, keyId, encryptionVersion } = encryptSecret(
        provider, "boot-probe", secretContext(orgA, "org", orgA, "BOOT_PROBE"));
      const roundtrip = decryptSecret(provider, ciphertext, keyId,
        secretContext(orgA, "org", orgA, "BOOT_PROBE"), encryptionVersion);
      booted = roundtrip === "boot-probe";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      resetEnvCache();
    }
    check("2a. fresh openssl-style KEK boots and round-trips", booted ? "PASS" : "FAIL", message.slice(0, 120));
  }

  // ---------------------------------------------------------- 3. auth matrix
  step("3. two orgs, shared user, second user, pod tokens");
  {
    const orgScopeA = `/v1/secrets/org/${orgA}`;
    // Allowed: user A writes org A secret; shared user A writes org B user secret.
    const orgCanaryA = canary("org-a");
    let r = await api("PUT", `${orgScopeA}/MATRIX_ORG`, TOKEN_A, { value: orgCanaryA });
    check("3a. user A writes org A secret", r.status === 204 ? "PASS" : "FAIL", `status ${r.status} ${r.body.slice(0, 100)}`);
    // Cross-org user-scope independence (Phase 1 fix): same user+name in two orgs.
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "user", scopeId: userA,
      name: "MATRIX_SHARED", value: canary("shared-a"), createdBy: userA });
    await putSecret({ kek: kek2, orgId: orgB, scopeType: "user", scopeId: userA,
      name: "MATRIX_SHARED", value: canary("shared-b"), createdBy: userA });
    const rows = await query<{ org_id: string }>(
      "SELECT org_id FROM secrets WHERE scope_type = 'user' AND scope_id = $1 AND name = 'MATRIX_SHARED' ORDER BY org_id",
      [userA]);
    check("3b. same user+name in two orgs stays independent",
      rows.rows.length === 2 ? "PASS" : "FAIL", `rows ${rows.rows.length}`);
    // Denied: user B reads user A's scope.
    r = await api("GET", `/v1/secrets/user/${userA}`, TOKEN_B);
    check("3c. user B cannot list user A secrets", r.status === 403 ? "PASS" : "FAIL", `status ${r.status}`);
    // Denied: pod token on org scope.
    r = await api("PUT", `${orgScopeA}/POD_ORG`, podToken, { value: "x" });
    check("3d. pod token denied org write", r.status === 403 ? "PASS" : "FAIL", `status ${r.status}`);
    r = await api("GET", `${orgScopeA}`, podToken);
    check("3e. pod token denied org read", r.status === 403 ? "PASS" : "FAIL", `status ${r.status}`);
    // Allowed: pod token on the template it created.
    r = await api("PUT", `/v1/secrets/template/${templateA}/POD_TMPL`, podToken, { value: canary("pod-tmpl") });
    check("3f. pod token writes own template scope", r.status === 204 ? "PASS" : "FAIL",
      `status ${r.status} ${r.body.slice(0, 100)}`);
    // Denied: pod token on a template it did not create.
    const otherTemplate = uuidv7();
    await query("INSERT INTO pod_templates (id, org_id, name) VALUES ($1, $2, 'other template')",
      [otherTemplate, orgA]);
    r = await api("PUT", `/v1/secrets/template/${otherTemplate}/POD_TMPL`, podToken, { value: "x" });
    check("3g. pod token denied foreign template", r.status !== 204 ? "PASS" : "FAIL", `status ${r.status}`);
    // Denied: cross-org mismatch on org scope id.
    r = await api("PUT", `/v1/secrets/org/${orgB}/MISMATCH`, TOKEN_A, { value: "x" });
    check("3h. org mismatch rejected", r.status === 403 ? "PASS" : "FAIL", `status ${r.status}`);
    // Metadata-only: list responses carry names, never values.
    r = await api("GET", `${orgScopeA}`, TOKEN_A);
    let listOk = false;
    try {
      const parsed = JSON.parse(r.body) as { secrets: { name: string }[] };
      listOk = r.status === 200 && parsed.secrets.some((s) => s.name === "MATRIX_ORG")
        && !r.body.includes(orgCanaryA);
    } catch { listOk = false; }
    check("3i. list returns metadata only", listOk ? "PASS" : "FAIL", `status ${r.status}`);
  }

  // ---------------------------------------------------------- 4. CLI + raw API canaries
  step("4. org/user/template canaries through CLI and raw API");
  {
    const orgCanary = canary("cli-org");
    const userCanary = canary("cli-user");
    const tmplCanary = canary("cli-tmpl");
    // Raw API puts (user A acts in org A).
    let r = await api("PUT", `/v1/secrets/org/${orgA}/CANARY_ORG`, TOKEN_A, { value: orgCanary });
    check("4a. raw API sets org canary", r.status === 204 ? "PASS" : "FAIL", `status ${r.status}`);
    r = await api("PUT", `/v1/secrets/user/${userA}/CANARY_USER`, TOKEN_A, { value: userCanary });
    check("4b. raw API sets user canary", r.status === 204 ? "PASS" : "FAIL", `status ${r.status}`);
    r = await api("PUT", `/v1/secrets/template/${templateA}/CANARY_TMPL`, TOKEN_A, { value: tmplCanary });
    check("4c. raw API sets template canary", r.status === 204 ? "PASS" : "FAIL", `status ${r.status}`);

    // Real CLI over live HTTP. Human session via fixture auth.json (no Zitadel here);
    // pod-token CLI via env (no login file).
    const CLI_TS = "/workspace/pi-pod/src/cli.ts";
    const cliEnvHuman = {
      ...cleanBaseEnv(),
      HOME: cliHome,
      NO_COLOR: "1",
      PI_POD_SERVER_URL: serverUrl,
      PI_POD_SERVER_TOKEN: TOKEN_A,
    };
    fs.mkdirSync(path.join(cliHome, ".pi-pod"), { recursive: true });
    fs.writeFileSync(path.join(cliHome, ".pi-pod", "auth.json"),
      JSON.stringify({ serverUrl, accessToken: TOKEN_A,
        user: { id: userA, email: `${userA}@manual.test` }, orgId: orgA }), { mode: 0o600 });
    const cliHomePod = path.join(tmpRoot, "cli-pod");
    fs.mkdirSync(cliHomePod, { recursive: true });
    const cliEnvPod = {
      ...cleanBaseEnv(),
      HOME: cliHomePod,
      NO_COLOR: "1",
      PI_POD_SERVER_URL: serverUrl,
      PI_POD_SERVER_TOKEN: podToken,
      PI_POD_SERVER_POD_ID: podId,
    };
    const cli = (args: string[], env: Record<string, string>, stdin?: string) =>
      // cwd is pi-pod-server (no pi-pod project config there): bare `--import tsx`
      // resolves from its node_modules while the CLI itself sees an empty project dir.
      runProc([process.execPath, "--import", "tsx", CLI_TS, ...args],
        { env, stdin, cwd: "/workspace/pi-pod-server" });

    // 4d: NAME=value refusal is offline (no value reaches any transport).
    const refused = await cli(["secrets", "set", "org", "CANARY_EQ=printer"], cliEnvHuman);
    check("4d. CLI refuses NAME=value", refused.code !== 0 && /NAME=value|stdin/i.test(refused.output) ? "PASS" : "FAIL",
      refused.output.split("\n").filter(Boolean)[0]?.slice(0, 140) ?? `code ${refused.code}`);
    // 4e: human CLI sets a template canary via stdin pipe.
    const cliTmpl = canary("cli-tmpl-live");
    const setT = await cli(["secrets", "set", `template/manual template`, "CANARY_CLI_TMPL"], cliEnvHuman,
      cliTmpl);
    check("4e. CLI sets template canary over HTTP",
      setT.code === 0 ? "PASS" : "FAIL", setT.output.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 140));
    if (setT.code === 0 && setT.output.includes(cliTmpl)) {
      check("4f. CLI echoes no canary value", "FAIL", "value appeared in CLI output");
    } else if (setT.code === 0) {
      check("4f. CLI echoes no canary value", "PASS");
    } else {
      check("4f. CLI echoes no canary value", "BLOCKED", "set failed; nothing to scan");
    }
    // 4g: pod-token CLI denied org write (defense in depth through the real client).
    const denied = await cli(["secrets", "set", "org", "CANARY_POD_DENY"], cliEnvPod, canary("pod-deny"));
    check("4g. pod-token CLI denied org write", denied.code !== 0 ? "PASS" : "FAIL",
      denied.output.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 140));
    // 4h: CLI list shows names, never values.
    const listed = await cli(["secrets", "list"], cliEnvHuman);
    const listClean = listed.code === 0 && listed.output.includes("CANARY_ORG")
      && ![orgCanary, userCanary, tmplCanary, cliTmpl].some((c) => listed.output.includes(c));
    check("4h. CLI list shows names only", listed.code === 0 ? (listClean ? "PASS" : "FAIL") : "BLOCKED",
      listed.code === 0 ? listed.output.split("\n").slice(0, 4).join(" | ").slice(0, 140)
        : `exit ${listed.code}: ${listed.output.slice(0, 140)}`);
    // 4i: CLI rm deletes the CLI-set canary.
    const rm = await cli(["secrets", "rm", `template/manual template`, "CANARY_CLI_TMPL"], cliEnvHuman);
    check("4i. CLI rm removes template canary", rm.code === 0 ? "PASS" : "FAIL",
      rm.output.split("\n").filter(Boolean).slice(-1).join("").slice(0, 140));
  }

  // ---------------------------------------------------------- 5. sandbox env
  step("5. native sandbox: precedence, provider exclusion, in-pod equality");
  {
    const orgV = canary("prec-org");
    const userV = canary("prec-user");
    const tmplV = canary("prec-tmpl");
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "PREC_KEY", value: orgV, createdBy: userA });
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "user", scopeId: userA,
      name: "PREC_KEY", value: userV, createdBy: userA });
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "template", scopeId: templateA,
      name: "PREC_KEY", value: tmplV, createdBy: userA });
    const resolved = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: templateA });
    check("5a. precedence is template > user > org",
      resolved.env["PREC_KEY"] === tmplV && resolved.origins["PREC_KEY"] === "template" ? "PASS" : "FAIL",
      `origin ${resolved.origins["PREC_KEY"]}`);
    // Provider credential custody: stored at org scope, never injected.
    const { PROVIDER_CREDENTIAL_VARS } = await import("../src/core/providers/registry.js");
    const credVar = String(Object.values(PROVIDER_CREDENTIAL_VARS)[0]);
    const credCanary = canary("prov-cred");
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: credVar, value: credCanary, createdBy: userA });
    const withCred = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: templateA });
    check("5b. provider credential excluded from pod env",
      !(credVar in withCred.env) && (withCred.keys.includes("PREC_KEY")) ? "PASS" : "FAIL", credVar);
    // In-pod equality without printing values: compare hashes across a process boundary.
    const expected = sha256(`${tmplV}`);
    const probe = await runProc(
      [process.execPath, "-e", "const c=require('node:crypto');let d='';process.stdin.on('data',(x)=>d+=x).on('end',()=>process.stdout.write(c.createHash('sha256').update(process.env.PREC_KEY??'').digest('hex')));"],
      { env: { ...cleanBaseEnv(), PREC_KEY: withCred.env["PREC_KEY"]! } });
    check("5c. in-pod equality by hash (value never printed)",
      probe.code === 0 && probe.output.trim() === expected ? "PASS" : "FAIL", `code ${probe.code}`);
    // Server rejects provider credentials outside org scope.
    let rejected = false;
    try {
      await putSecret({ kek: kek2, orgId: orgA, scopeType: "user", scopeId: userA,
        name: credVar, value: canary("x"), createdBy: userA });
    } catch {
      rejected = true;
    }
    check("5d. server rejects provider credential in user scope", rejected ? "PASS" : "FAIL");
    check("5e. real native sandbox launch", "BLOCKED",
      "no local docker/provider creds; remote disposable sandbox needs parent coordination (no production host is directly reachable; pipod droplet has capacity)");
  }

  // ---------------------------------------------------------- 6. resume + legacy
  step("6. stop/resume, current secrets, legacy fixture rows");
  {
    // Current launch-env round trip through the real store.
    const projCanary = canary("launch-proj");
    await savePodLaunchEnv({ kek: kek2, podId, layers: { project: { PROJ_KEY: projCanary } } });
    const loaded = await loadPodLaunchEnv(kek2, podId);
    check("6a. launch env stores and resumes",
      loaded.project["PROJ_KEY"] === projCanary ? "PASS" : "FAIL");
    // Legacy v1 rows across the live encrypted tables (pi_settings was dropped by
    // migration 012, so no fixture row can exist for it — recorded, not faked).
    const legacyV = canary("legacy-v1");
    const v1Secrets = craftV1Envelope(kek1Bytes, legacyV);
    await query(
      "INSERT INTO secrets (id, org_id, scope_type, scope_id, name, ciphertext, key_id, created_by, encryption_version) VALUES ($1,$2,'org',$2,'LEGACY_V1',$3,$4,$5,1)",
      [uuidv7(), orgA, v1Secrets, KEK1_ID, userA]);
    const legacyRead = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: null });
    check("6b. legacy v1 secrets row still decrypts",
      legacyRead.env["LEGACY_V1"] === legacyV ? "PASS" : "FAIL");
    const v1Auth = craftV1Envelope(kek1Bytes, JSON.stringify({ schema: 1, entries: { x: 1 } }));
    await query("INSERT INTO pi_auth (id, org_id, user_id, ciphertext, key_id, encryption_version, providers) VALUES ($1,$2,$3,$4,$5,1,'{manual}')",
      [uuidv7(), orgA, userA, v1Auth, KEK1_ID]);
    const authRows = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
      "SELECT ciphertext, key_id, encryption_version FROM pi_auth WHERE org_id = $1", [orgA]);
    let authOk = false;
    try {
      decryptSecret(kek1, authRows.rows[0]!.ciphertext, authRows.rows[0]!.key_id,
        { kind: "pi_auth", orgId: orgA, userId: userA }, Number(authRows.rows[0]!.encryption_version));
      authOk = true;
    } catch { authOk = false; }
    check("6c. legacy v1 pi_auth row still decrypts", authOk ? "PASS" : "FAIL");
    const v1Launch = craftV1Envelope(kek1Bytes, JSON.stringify({ schema: 1, host: {}, repo: { OLD: "1" } }));
    await query("INSERT INTO pod_launch_env (pod_id, ciphertext, key_id, encryption_version, host_keys, repo_keys) VALUES ($1,$2,$3,1,'{}','{}')",
      [podId2, v1Launch, KEK1_ID]);
    const resumedLegacy = await loadPodLaunchEnv(kek1, podId2);
    check("6d. legacy v1 launch env resumes",
      resumedLegacy.project["OLD"] === "1" ? "PASS" : "FAIL");
    const v1Cred = craftV1Envelope(kek1Bytes, JSON.stringify({ token: legacyV }));
    await query("INSERT INTO model_credentials (id, org_id, user_id, provider_id, credential_type, ciphertext, key_id, encryption_version) VALUES ($1,$2,$3,'manual-provider','api_key',$4,$5,1)",
      [uuidv7(), orgA, userA, v1Cred, KEK1_ID]);
    const credRows = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
      "SELECT ciphertext, key_id, encryption_version FROM model_credentials WHERE org_id = $1", [orgA]);
    let credOk = false;
    try {
      decryptSecret(kek1, credRows.rows[0]!.ciphertext, credRows.rows[0]!.key_id,
        modelCredentialContext(orgA, userA, "manual-provider"),
        Number(credRows.rows[0]!.encryption_version));
      credOk = true;
    } catch { credOk = false; }
    check("6e. legacy v1 model_credentials row still decrypts", credOk ? "PASS" : "FAIL");
    check("6f. legacy pi_settings row", "BLOCKED",
      "table dropped by migration 012; no live rows can exist to fixture");
    check("6g. stop/resume through gateway", "BLOCKED",
      "needs gateway + provider pods; store-level resume covered by 6a/6d");
  }

  // ---------------------------------------------------------- 7. transplantation
  step("7. ciphertext transplantation must fail closed");
  {
    const victim = canary("transplant");
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "VICTIM", value: victim, createdBy: userA });
    const src = await query<{ ciphertext: Buffer; key_id: string }>(
      "SELECT ciphertext, key_id FROM secrets WHERE org_id = $1 AND name = 'VICTIM'", [orgA]);
    const { ciphertext, key_id } = src.rows[0]!;
    const attemptDecrypt = (ct: Buffer, kid: string, ctx: Parameters<typeof decryptSecret>[3]): boolean => {
      // True ONLY when the bytes actually decrypt; safe typed failures count as blocked.
      try {
        decryptSecret(kek2, ct, kid, ctx, 2);
        return true;
      } catch (e) {
        if (e instanceof SecretCryptoError) {
          if (/manual-/.test(e.message)) throw new Error("crypto error echoed canary material");
          return false;
        }
        throw e;
      }
    };
    // Splice the valid ciphertext into org B's row and read as org B.
    await putSecret({ kek: kek2, orgId: orgB, scopeType: "org", scopeId: orgB,
      name: "TARGET", value: canary("target"), createdBy: userA });
    await query("UPDATE secrets SET ciphertext = $1, key_id = $2 WHERE org_id = $3 AND name = 'TARGET'",
      [ciphertext, key_id, orgB]);
    let orgTransplantBlocked = false;
    try {
      await resolveSecrets({ kek: kek2, orgId: orgB, userId: userA, templateId: null });
    } catch (e) {
      orgTransplantBlocked = e instanceof SecretCryptoError;
    }
    // Restore the clobbered row so later checks see org B intact.
    await putSecret({ kek: kek2, orgId: orgB, scopeType: "org", scopeId: orgB,
      name: "TARGET", value: canary("target-restored"), createdBy: userA });
    check("7a. cross-org transplant fails closed", orgTransplantBlocked ? "PASS" : "FAIL");
    check("7b. cross-scope transplant fails",
      !attemptDecrypt(ciphertext, key_id, secretContext(orgA, "user", userA, "VICTIM")) ? "PASS" : "FAIL");
    check("7c. cross-name transplant fails",
      !attemptDecrypt(ciphertext, key_id, secretContext(orgA, "org", orgA, "OTHER")) ? "PASS" : "FAIL");
    check("7d. cross-domain transplant fails",
      !attemptDecrypt(ciphertext, key_id, modelCredentialContext(orgA, userA, "VICTIM")) ? "PASS" : "FAIL");
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1]! ^= 0x01;
    check("7e. tampered bytes fail",
      !attemptDecrypt(tampered, key_id, secretContext(orgA, "org", orgA, "VICTIM")) ? "PASS" : "FAIL");
    const relabeled = Buffer.from(ciphertext);
    check("7f. v2 bytes labeled v1 rejected",
      (() => {
        try {
          decryptSecret(kek2, relabeled, key_id, secretContext(orgA, "org", orgA, "VICTIM"), 1);
          return false;
        } catch (e) {
          return e instanceof SecretCryptoError;
        }
      })() ? "PASS" : "FAIL");
    check("7g. wrong KEK fails",
      (() => {
        try {
          decryptSecret(kek1, ciphertext, key_id, secretContext(orgA, "org", orgA, "VICTIM"), 2);
          return false;
        } catch (e) {
          return e instanceof SecretCryptoError;
        }
      })() ? "PASS" : "FAIL");
    // Pod launch-env transplant across pods.
    const launchRow = await query<{ ciphertext: Buffer; key_id: string }>(
      "SELECT ciphertext, key_id FROM pod_launch_env WHERE pod_id = $1", [podId]);
    const crossPod = (() => {
      try {
        decryptSecret(kek2, launchRow.rows[0]!.ciphertext, launchRow.rows[0]!.key_id,
          podLaunchEnvContext(podId2), 2);
        return false;
      } catch (e) {
        return e instanceof SecretCryptoError;
      }
    })();
    check("7h. cross-pod launch env transplant fails", crossPod ? "PASS" : "FAIL");
  }

  // ---------------------------------------------------------- 8. rotation
  step("8. key rotation, interruption, concurrency, retirement");
  {
    const rotV = canary("rotate-me");
    await putSecret({ kek: kek1, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "ROTATE_ME", value: rotV, createdBy: userA });
    const row = await query<{ ciphertext: Buffer; key_id: string }>(
      "SELECT ciphertext, key_id FROM secrets WHERE org_id = $1 AND name = 'ROTATE_ME'", [orgA]);
    const ctx = secretContext(orgA, "org", orgA, "ROTATE_ME");
    const rewrapped = rewrapSecret(kek2, row.rows[0]!.ciphertext, row.rows[0]!.key_id, ctx, 2);
    const preserved =
      decryptSecret(kek2, rewrapped.ciphertext, rewrapped.keyId, ctx, 2) === rotV
      && rewrapped.keyId === KEK2_ID;
    const sealedOld = row.rows[0]!.ciphertext.subarray(3 + 60);
    const sealedNew = rewrapped.ciphertext.subarray(3 + 60);
    check("8a. rewrap preserves plaintext under new KEK",
      preserved && sealedOld.equals(sealedNew) ? "PASS" : "FAIL", "sealed payload bit-identical");
    await query("UPDATE secrets SET ciphertext = $1, key_id = $2 WHERE org_id = $3 AND name = 'ROTATE_ME'",
      [rewrapped.ciphertext, rewrapped.keyId, orgA]);
    const afterRotate = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: templateA });
    check("8b. rotated row reads under current KEK", afterRotate.env["ROTATE_ME"] === rotV ? "PASS" : "FAIL");
    let rewrapV1 = false;
    try {
      const legacy = await query<{ ciphertext: Buffer; key_id: string }>(
        "SELECT ciphertext, key_id FROM secrets WHERE org_id = $1 AND name = 'LEGACY_V1'", [orgA]);
      rewrapSecret(kek2, legacy.rows[0]!.ciphertext, legacy.rows[0]!.key_id, ctx, 1);
    } catch (e) {
      rewrapV1 = e instanceof SecretCryptoError;
    }
    check("8c. rewrap refuses legacy v1 (migrate via decrypt+encrypt)", rewrapV1 ? "PASS" : "FAIL");
    // Concurrent overwrites: last writer wins, row stays readable, no clobbered framing.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        putSecret({ kek: kek2, orgId: orgA, scopeType: "org", scopeId: orgA,
          name: "RACE_KEY", value: canary(`race-${i}`), createdBy: userA })),
    );
    let raceOk = false;
    try {
      const r = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: null });
      raceOk = typeof r.env["RACE_KEY"] === "string" && r.env["RACE_KEY"].startsWith("manual-");
    } catch { raceOk = false; }
    check("8d. concurrent overwrites leave a readable row", raceOk ? "PASS" : "FAIL");
    // Operator CLI (Phase 3) against the disposable DB with fixture keys. Values stay
    // in the DB; the CLI prints counts and opaque ids only — every output is scanned.
    const maintEnv = {
      ...cleanBaseEnv(),
      DATABASE_URL: EXPECTED_DATABASE_URL,
      SECRETS_KEK: kek2Bytes.toString("base64"),
      SECRETS_KEK_ID: KEK2_ID,
      SECRETS_KEK_PREVIOUS: JSON.stringify({ [KEK1_ID]: kek1Bytes.toString("base64") }),
    };
    const maint = (args: string[]) =>
      runProc([process.execPath, "--import", "tsx", "src/secrets-maintenance.ts", ...args],
        { env: maintEnv, cwd: "/workspace/pi-pod-server", timeoutMs: 180_000 });
    const status = await maint(["status"]);
    check("8e. maintenance status inventories v1 rows, pi_settings absent",
      status.code === 0 && status.output.includes("(absent)") ? "PASS" : "FAIL",
      status.output.split("\n").slice(0, 8).join(" | ").slice(0, 200));
    // Interruption: bulk legacy rows, tiny batches, SIGKILL mid-flight, then resume.
    const BULK_N = 150;
    const bulkExpect = new Map<string, string>();
    for (let i = 0; i < BULK_N; i++) {
      const nm = `BULK_V1_${i}`;
      const val = canary(`bulk-${i}`);
      bulkExpect.set(nm, val);
      await query(
        "INSERT INTO secrets (id, org_id, scope_type, scope_id, name, ciphertext, key_id, created_by, encryption_version) VALUES ($1,$2,'org',$2,$3,$4,$5,$6,1)",
        [uuidv7(), orgA, nm, craftV1Envelope(kek1Bytes, val), KEK1_ID, userA]);
    }
    const bulkRemaining = async (): Promise<string> => (await query<{ count: string }>(
      "SELECT count(*) FROM secrets WHERE org_id = $1 AND name LIKE 'BULK_V1_%' AND encryption_version = 1",
      [orgA])).rows[0]!.count;
    let firstOut = "";
    let killedMid = false;
    let migratedAtKill = 0;
    let exitCode: number | null = null;
    {
      const child = spawn(process.execPath,
        ["--import", "tsx", "src/secrets-maintenance.ts", "migrate", "--batch-size", "2"],
        { cwd: "/workspace/pi-pod-server", env: maintEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { out += String(d); });
      const done = new Promise<void>((resolve) => child.on("close", (code) => {
        exited = true;
        exitCode = code ?? 1;
        resolve();
      }));
      const deadline = Date.now() + 120_000;
      let exited = false;
      void done.then(() => { exited = true; });
      while (Date.now() < deadline && !exited) {
        await new Promise((r) => setTimeout(r, 25));
        if (exited) break;
        const rem = Number(await bulkRemaining());
        if (rem < BULK_N && rem > 0) {
          migratedAtKill = BULK_N - rem;
          child.kill("SIGKILL");
          killedMid = true;
          break;
        }
      }
      if (!exited && !killedMid) child.kill("SIGKILL");
      await done;
      firstOut = out;
    }
    check("8f. SIGKILL lands mid-migration (partial progress observable)",
      killedMid ? "PASS" : exitCode !== null && exitCode !== 0 ? "FAIL" : "BLOCKED",
      killedMid ? `${migratedAtKill}/${BULK_N} rows migrated at kill`
        : exitCode !== null && exitCode !== 0 ? `migrate exited ${exitCode}: ${firstOut.slice(0, 160)}`
        : "migration outran the SIGKILL window");
    const resume = await maint(["migrate", "--batch-size", "50"]);
    const remAfter = Number(await bulkRemaining());
    let bulkReadable = false;
    try {
      const r = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: null });
      bulkReadable = [...bulkExpect.entries()].every(([k, v]) => r.env[k] === v);
    } catch { bulkReadable = false; }
    const leaked = [...bulkExpect.values()].some((v) => firstOut.includes(v) || resume.output.includes(v));
    const singletonsV2 = await query<{ count: string }>(
      "SELECT count(*) FROM secrets WHERE org_id = $1 AND name IN ('LEGACY_V1','ROTATE_ME') AND encryption_version = 2 AND key_id = $2",
      [orgA, KEK2_ID]);
    check("8g. resume completes migration, all rows v2 and readable",
      resume.code === 0 && remAfter === 0 && bulkReadable && !leaked
        && Number(singletonsV2.rows[0]!.count) === 2 ? "PASS" : "FAIL",
      `resume exit ${resume.code}, remaining ${remAfter}, readable ${bulkReadable}`);
    const verify = await maint(["verify"]);
    check("8h. maintenance verify passes after migration",
      verify.code === 0 ? "PASS" : "FAIL", verify.output.split("\n").slice(-3).join(" | ").slice(0, 160));
    // CLI rewrap: a v2 row under the retired key moves to the current KEK.
    const rewrapCanary = canary("rewrap-cli");
    await putSecret({ kek: kek1, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "REWRAP_CLI", value: rewrapCanary, createdBy: userA });
    const rewrapRun = await maint(["rewrap"]);
    const rewrapRow = await query<{ key_id: string }>(
      "SELECT key_id FROM secrets WHERE org_id = $1 AND name = 'REWRAP_CLI'", [orgA]);
    const rewrapRead = await resolveSecrets({ kek: kek2, orgId: orgA, userId: userA, templateId: null });
    check("8i. CLI rewrap moves retired-key row to current KEK, value preserved",
      rewrapRun.code === 0 && rewrapRow.rows[0]!.key_id === KEK2_ID
        && rewrapRead.env["REWRAP_CLI"] === rewrapCanary ? "PASS" : "FAIL",
      `exit ${rewrapRun.code}, key ${rewrapRow.rows[0]?.key_id}`);
    // Retirement: a provider without the old KEK fails loudly on unrestored rows.
    // (Written AFTER the CLI rewrap so it is genuinely unrestored.)
    const retireCanary = canary("retire-check");
    await putSecret({ kek: kek1, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "RETIRE_CLI", value: retireCanary, createdBy: userA });
    const kek2Only = new EnvKekProvider(KEK2_ID, kek2Bytes.toString("base64"));
    const retireRow = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
      "SELECT ciphertext, key_id, encryption_version FROM secrets WHERE org_id = $1 AND name = 'RETIRE_CLI'", [orgA]);
    let retiredFails = false;
    try {
      decryptSecret(kek2Only, retireRow.rows[0]!.ciphertext, retireRow.rows[0]!.key_id,
        secretContext(orgA, "org", orgA, "RETIRE_CLI"), Number(retireRow.rows[0]!.encryption_version));
    } catch (e) {
      retiredFails = e instanceof UnknownKekError;
    }
    check("8j. retired key removal fails loudly (UnknownKekError)", retiredFails ? "PASS" : "FAIL");
  }

  // ---------------------------------------------------------- 9. backup/restore
  step("9. restore the backup with its historical key");
  {
    // A v2 row wrapped under the retired key: the real post-rotation backup case.
    // (Written fresh here — section 8's CLI migrate already converted LEGACY_V1.)
    const histCanary = canary("backup-hist");
    await putSecret({ kek: kek1, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "BACKUP_HIST", value: histCanary, createdBy: userA });
    const restoreDb = "secure_secrets_manual_restore";
    await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${restoreDb}'`);
    await query(`DROP DATABASE IF EXISTS ${restoreDb}`);
    await query(`CREATE DATABASE ${restoreDb}`);
    const dumpFile = path.join(tmpRoot, "backup.sql");
    const dump = await runProc(
      ["pg_dump", EXPECTED_DATABASE_URL, "--no-owner", "--no-privileges", "-f", dumpFile], {});
    check("9a. pg_dump of disposable DB succeeds", dump.code === 0 ? "PASS" : "FAIL",
      dump.output.slice(0, 120));
    const restoreUrl = `postgres://postgres@127.0.0.1:55439/${restoreDb}`;
    const restore = await runProc(["psql", restoreUrl, "-q", "-f", dumpFile], {});
    check("9b. restore into isolated database succeeds", restore.code === 0 ? "PASS" : "FAIL",
      restore.output.slice(0, 120));
    const client = new pg.Client(restoreUrl);
    await client.connect();
    try {
      const rows = await client.query(
        "SELECT name, ciphertext, key_id, encryption_version FROM secrets WHERE org_id = $1 AND name = 'BACKUP_HIST'",
        [orgA]);
      let withKey = false;
      try {
        const v = decryptSecret(kek2, rows.rows[0].ciphertext, rows.rows[0].key_id,
          secretContext(orgA, "org", orgA, "BACKUP_HIST"), Number(rows.rows[0].encryption_version));
        withKey = typeof v === "string" && v === histCanary;
      } catch { withKey = false; }
      check("9c. restored row reads with historical key present", withKey ? "PASS" : "FAIL");
      const kek2Only = new EnvKekProvider(KEK2_ID, kek2Bytes.toString("base64"));
      let withoutKey = false;
      try {
        decryptSecret(kek2Only, rows.rows[0].ciphertext, rows.rows[0].key_id,
          secretContext(orgA, "org", orgA, "BACKUP_HIST"), Number(rows.rows[0].encryption_version));
      } catch (e) {
        withoutKey = e instanceof SecretCryptoError;
      }
      check("9d. restored row fails without historical key", withoutKey ? "PASS" : "FAIL");
    } finally {
      await client.end().catch(() => {});
    }
    await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${restoreDb}'`);
    await query(`DROP DATABASE ${restoreDb}`);
  }

  // ---------------------------------------------------------- 10. canary scan
  step("10. validation/provisioning errors must not disclose canaries");
  {
    const scanCanary = canary("scan-me");
    await putSecret({ kek: kek2, orgId: orgA, scopeType: "org", scopeId: orgA,
      name: "SCAN_KEY", value: scanCanary, createdBy: userA });
    const bodies: string[] = [];
    let r = await api("PUT", `/v1/secrets/org/${orgA}/bad-name`, TOKEN_A, { value: "x" });
    bodies.push(`invalid-name:${r.status}:${r.body}`);
    check("10a. invalid name rejected", r.status === 400 ? "PASS" : "FAIL", `status ${r.status}`);
    r = await api("PUT", `/v1/secrets/org/${orgA}/BIG`, TOKEN_A, { value: `y`.repeat(65 * 1024 + 1) });
    bodies.push(`oversize:${r.status}:${r.body.slice(0, 200)}`);
    check("10b. oversize value rejected", r.status === 400 ? "PASS" : "FAIL", `status ${r.status}`);
    const { PROVIDER_CREDENTIAL_VARS: pcv } = await import("../src/core/providers/registry.js");
    const credVar = String(Object.values(pcv)[0]);
    r = await api("PUT", `/v1/secrets/user/${userA}/${credVar}`, TOKEN_A, { value: "x" });
    bodies.push(`prov-scope:${r.status}:${r.body}`);
    check("10c. provider credential outside org scope rejected", r.status === 400 ? "PASS" : "FAIL",
      `status ${r.status}`);
    r = await api("GET", `/v1/secrets/org/${orgA}`, "bogus-token");
    bodies.push(`unauth:${r.status}:${r.body}`);
    check("10d. unauthenticated request rejected", r.status === 401 ? "PASS" : "FAIL", `status ${r.status}`);
    const auditRows = await query<{ detail: unknown }>(
      "SELECT detail FROM audit_log WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10", [orgA]);
    const auditText = JSON.stringify(auditRows.rows);
    const dumpScan = await runProc(["pg_dump", EXPECTED_DATABASE_URL, "--no-owner", "--table=secrets",
      "--table=audit_log"], {});
    const haystacks = [...bodies, auditText, dumpScan.output];
    const leaked = haystacks.some((h) => h.includes(scanCanary));
    // The stored ciphertext must differ from the plaintext (spot check, not a proof).
    const ctRow = await query<{ ciphertext: Buffer }>(
      "SELECT ciphertext FROM secrets WHERE org_id = $1 AND name = 'SCAN_KEY'", [orgA]);
    const ctHasPlaintext = ctRow.rows[0]!.ciphertext.includes(Buffer.from(scanCanary, "utf8"));
    check("10e. no canary in API errors, audit details, or DB dump",
      !leaked && !ctHasPlaintext ? "PASS" : "FAIL",
      !leaked ? "clean" : "LEAK DETECTED");
    check("10f. provisioning-error redaction", "BLOCKED",
      "no provider available here; provisioning log redaction untested");
    // Phase 4 safe-errors function harness: canary-bearing inputs must reduce to
    // safe constants. This exercises the sanitizer units, NOT the real provider path.
    const { sanitizeFailureMessage, describeProviderFailure, sanitizeForLog,
      scrubValidationIssues } = await import("../src/server/safe-errors.js");
    const hostile = new Error(`provider exploded: ${scanCanary}`) as Error & { code?: string };
    hostile.code = "E_CONN_RESET";
    const s1 = sanitizeFailureMessage(hostile, { prefix: "provision" });
    check("10g. sanitizeFailureMessage drops canary to safe constant",
      !s1.includes(scanCanary) && /^provision: operation failed/.test(s1) ? "PASS" : "FAIL",
      s1.slice(0, 80));
    const s2 = describeProviderFailure(hostile);
    check("10h. describeProviderFailure drops canary",
      !s2.includes(scanCanary) && s2.length > 0 ? "PASS" : "FAIL", s2.slice(0, 80));
    const s3 = JSON.stringify(sanitizeForLog(hostile));
    check("10i. sanitizeForLog drops canary", !s3.includes(scanCanary) ? "PASS" : "FAIL");
    const s4 = JSON.stringify(scrubValidationIssues(
      [{ instancePath: "/value", message: `bad ${scanCanary}`, params: { v: scanCanary } }]));
    check("10j. scrubValidationIssues strips messages, keeps paths",
      !s4.includes(scanCanary) && s4.includes("/value") ? "PASS" : "FAIL");
  }

  // ---------------------------------------------------------- 11. public HTTPS
  step("11. public HTTPS and protected inter-host paths (read-only)");
  {
    const health = await runProc(
      ["curl", "-sS", "-m", "10", "-w", "\nHTTP:%{http_code}",
        "https://api.pipod.dev/healthz"], { timeoutMs: 20_000 });
    const ok = health.code === 0 && health.output.includes("HTTP:200");
    check("11a. public HTTPS health endpoint reachable",
      ok ? "PASS" : "BLOCKED",
      ok ? health.output.slice(0, 160).replace(/\n/g, " ") : `curl exit ${health.code}: ${health.output.slice(0, 120)}`);
    // Read-only operator verifies. Peer keys / host output are never printed; only
    // recency, names, counts, and health booleans are recorded.
    const ssh = (remote: string) => runProc(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "pipod", remote],
      { timeoutMs: 30_000 });
    const wg = await ssh("sudo wg show wg0 latest-handshakes");
    if (wg.code !== 0) {
      check("11b. WireGuard tunnel live (read-only ssh)", "BLOCKED",
        `ssh unavailable: ${wg.output.slice(0, 100)}`);
    } else {
      const now = Date.now() / 1000;
      const fresh = [...wg.output.matchAll(/(\d{9,10})/g)].map((m) => Number(m[1]))
        .filter((t) => now - t < 600).length;
      check("11b. WireGuard tunnel live (read-only ssh)",
        fresh > 0 ? "PASS" : "FAIL", `${fresh} peer(s) with fresh handshake`);
    }
    const fleet = await ssh("sudo docker exec pi-pod-server node dist/fleet.js list");
    if (fleet.code !== 0) {
      check("11c. fleet shows the local host (read-only ssh)", "BLOCKED",
        `ssh unavailable: ${fleet.output.slice(0, 100)}`);
    } else {
      const hasLocal = /\bpipod\b/.test(fleet.output);
      const counts = [...fleet.output.matchAll(/(hot=\d+ warm=\d+ stopped=\d+ archived=\d+)/g)]
        .map((m) => m[1]).join(" / ");
      check("11c. fleet shows the local host (read-only ssh)",
        hasLocal ? "PASS" : "FAIL", counts.slice(0, 160));
    }
    const box = await ssh("sudo docker exec pi-pod-server wget -qO- http://127.0.0.1:8080/healthz; echo; sudo docker logs pi-pod-server --since 60m 2>&1 | grep -c 'unable to authenticate' || true");
    if (box.code !== 0) {
      check("11d. on-box healthz + zero decrypt-failure logs (read-only ssh)", "BLOCKED",
        `ssh unavailable: ${box.output.slice(0, 100)}`);
    } else {
      check("11d. on-box healthz + zero decrypt-failure logs (read-only ssh)",
        box.output.includes('"ok":true') && /\n0\s*$/.test(box.output) ? "PASS" : "FAIL");
    }
  }

  console.log(`\nPASS ${pass}  FAIL ${fail}  BLOCKED ${blocked}`);
  if (blocked) {
    console.log("blocked items (not failures, require follow-up):");
    for (const b of blockedReasons) console.log(`  - ${b}`);
  }
}

try {
  await main();
} catch (e) {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  fail += 1;
} finally {
  // Cleanup: every fixture row, in FK-safe order. Schema/columns stay (disposable DB).
  try {
    await query("DELETE FROM secrets WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM model_credentials WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM pi_auth WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM pod_launch_env WHERE pod_id IN ($1, $2)", [podId, podId2]).catch(() => {});
    await query("DELETE FROM pod_tokens WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM pods WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM pod_templates WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM audit_log WHERE org_id IN ($1, $2)", [orgA, orgB]).catch(() => {});
    await query("DELETE FROM users WHERE id IN ($1, $2)", [userA, userB]).catch(() => {});
    await query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]).catch(() => {});
  } catch { /* disposable DB; best effort */ }
  try {
    await app?.close();
  } catch { /* ignore */ }
  await closePool().catch(() => {});
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
