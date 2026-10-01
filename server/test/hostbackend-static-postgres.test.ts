/**
 * Fresh static-deployment regression (postgres + fake sandbox provider).
 *
 * A deployment with an empty sandbox_hosts table, PI_POD_SANDBOX_URL set, and
 * no platform provider token in its environment must still launch: planning
 * freezes the deployment URL (the static single-host fallback, not a fleet
 * pick), and provisioning runs to a started pod through the real
 * planning → quota → insert → background-provision path — not just a
 * resolve dry-run. The sandbox credential arrives as an org secret (BYO
 * custody), so nothing token-like is needed in the deployment environment.
 *
 * Own DB rows only (one org/user); the fleet table is asserted empty before
 * and after, and is restored empty.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import { SANDBOX_CAPABILITIES } from "../src/core/providers/sandbox/index.js";
import type {
  Sandbox,
  SandboxProvider,
  SandboxSpec,
} from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { EnvSchema } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { resolveShape } from "../src/server/pods/capacity.js";
import { getSandboxHostBackend } from "../src/server/pods/hostbackend/index.js";
import { launchPod } from "../src/server/pods/provisioning.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { putSecret } from "../src/server/secrets/store.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

/** The deployment's single-host URL: the only host this test may ever dial. */
const STATIC_URL = "http://single-host:8433";

const b64 = () => randomBytes(32).toString("base64");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeSandbox(id: string): Sandbox {
  return {
    id,
    state: async () => "started" as const,
    waitUntilStarted: async () => {},
    start: async () => {},
    rehydrateEnv: () => {},
    exec: async () => ({ exitCode: 0, output: "" }),
    uploadFile: async () => {},
    uploadLocalFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    openPty: async () => {
      throw new Error("no PTY in the static backend test (exec cradle must suffice)");
    },
    setLabels: async () => {},
    applyRetention: async () => false,
    archive: async () => {},
    delete: async () => {},
    stop: async () => {},
  } as unknown as Sandbox;
}

describe("fresh static deployment launches on PI_POD_SANDBOX_URL (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", b64());
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const createdSpecs: SandboxSpec[] = [];
  const previousAmbientToken = process.env["PI_POD_SANDBOX_TOKEN"];

  const provider = {
    name: "sandbox",
    capabilities: SANDBOX_CAPABILITIES,
    checkAuth: async () => {},
    resolveImage: async () => ({ ref: "fake-present", state: "active" as const }),
    create: async (spec: SandboxSpec) => {
      const id = `sb-static-${createdSpecs.length}`;
      createdSpecs.push(spec);
      return makeFakeSandbox(id);
    },
    list: async () => [],
    get: async () => null,
  } as unknown as SandboxProvider;

  const env = EnvSchema.parse({
    DATABASE_URL: "postgres://test",
    ZITADEL_ISSUER: "https://auth.example.test",
    SECRETS_KEK: b64(),
    LOG_LEVEL: "silent",
    PUBLIC_URL: "https://app.example.test",
    PI_POD_SANDBOX_URL: STATIC_URL,
    PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
  });
  const deps: PodServiceDeps = { env, kek, log };

  async function fleetSize(): Promise<number> {
    const rows = await query<{ n: string }>("SELECT count(*)::text AS n FROM sandbox_hosts");
    return Number(rows.rows[0]!.n);
  }

  before(async () => {
    initPool(databaseUrl!);
    // No provider token anywhere in the deployment environment: credential
    // custody is the org's own secret (BYO), stored before the launch.
    delete process.env["PI_POD_SANDBOX_TOKEN"];
    registerProvider("sandbox", async () => () => provider);
    // Never DELETE FROM sandbox_hosts: other suites own fleet rows globally.
    // This suite only ever asserts the fleet is empty.
    assert.equal(await fleetSize(), 0, "expected an empty fleet for the fresh static deployment");
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'static backend test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await putSecret({
      kek,
      orgId,
      scopeType: "org",
      scopeId: orgId,
      name: "PI_POD_SANDBOX_TOKEN",
      value: "org-byo-token",
      createdBy: userId,
    });
  });

  after(async () => {
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
    if (previousAmbientToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousAmbientToken;
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => null);
    await query("DELETE FROM pod_tokens WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]).catch(() => null);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    // No fleet cleanup: this suite registers no hosts and must not touch others' rows.
    assert.equal(await fleetSize(), 0, "static launch must leave no fleet rows behind");
    await closePool();
  });

  it("starts with an empty fleet and no platform token in the deployment env", async () => {
    assert.equal(await fleetSize(), 0);
    assert.equal("PI_POD_SANDBOX_TOKEN" in env, false);
    assert.equal(process.env["PI_POD_SANDBOX_TOKEN"], undefined);
    assert.equal(env.SANDBOX_HOST_BACKEND, "static");
  });

  it("the static backend falls back to PI_POD_SANDBOX_URL with no fleet rows", async () => {
    const backend = getSandboxHostBackend(env);
    assert.equal(backend.name, "static");
    assert.equal(backend.fallbackUrl(), STATIC_URL);
    assert.equal(await backend.placeHost(), null);
    assert.equal(
      await backend.placeHostForRequest({ shape: resolveShape({ cpu: 2, memoryGB: 4, diskGB: 20 }) }),
      null,
      "empty fleet in single mode keeps the single-host fallback (null), never a 503",
    );
  });

  it("launches a pod on the deployment URL through planning and provisioning", async () => {
    assert.equal(await fleetSize(), 0);
    const { pod, report } = await launchPod(deps, { orgId, userId, provider: "sandbox" });
    const frozenUrl = (
      report as unknown as { config: { providers: { sandbox: { url: string } } } }
    ).config.providers.sandbox.url;
    assert.equal(frozenUrl, STATIC_URL);

    // Background provisioning must reach a started pod, not just an accepted row.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const rows = await query<{
        provider_state: string;
        provider_sandbox_id: string | null;
        state_reason: string | null;
        resolved_config: { config: { providers: { sandbox: { url: string } } } };
      }>(
        `SELECT provider_state, provider_sandbox_id, state_reason, resolved_config
           FROM pods WHERE id = $1`,
        [pod.id],
      );
      const row = rows.rows[0]!;
      if (row.provider_state === "started" && row.provider_sandbox_id === "sb-static-0") break;
      if (row.provider_state === "gone" || Date.now() > deadline) {
        assert.fail(
          `provisioning did not start the pod (state=${row.provider_state} reason=${row.state_reason})`,
        );
      }
      await sleep(100);
    }
    const final_ = await query<{ url: string }>(
      `SELECT resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' AS url
         FROM pods WHERE id = $1`,
      [pod.id],
    );
    assert.equal(final_.rows[0]!.url, STATIC_URL, "provisioning must not re-point the static host");
    // Create ran in background provisioning, so assert it only after the pod started.
    assert.equal(createdSpecs.length, 1, "exactly one sandbox create for one launch");
    // The server-custodied key authenticates the provider; it never enters the pod.
    const specEnv = createdSpecs[0]!.env ?? {};
    assert.equal("PI_POD_SANDBOX_TOKEN" in specEnv, false);
    assert.equal(specEnv["PI_POD_SERVER_POD_ID"], pod.id);
    assert.equal(await fleetSize(), 0, "a static launch registers no fleet rows");
  });
});
