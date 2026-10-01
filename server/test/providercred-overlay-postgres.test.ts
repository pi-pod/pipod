import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import type { SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { migrate } from "../src/server/db/migrate.js";
import type { ServerEnv } from "../src/server/env.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  platformCredentialsOf,
  snapshotPlatformCredentials,
  withProviderCredential,
  type PlatformCredentialSnapshot,
} from "../src/server/pods/providercred.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { putSecret, resolveProviderCredential } from "../src/server/secrets/store.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";

/**
 * Adversarial env-overlay proofs for the boot-snapshot discipline (cross-cutting P0).
 *
 * Threat: ROLE=all shares one process between launches and background ticks. The credential
 * lock temporarily installs org A's BYO key into `process.env[PI_POD_SANDBOX_TOKEN]` while building
 * A's adapter. Any platform-fallback read taken from ambient `process.env` in that window
 * resolves A's key for a DIFFERENT org (cross-tenant confusion) or discloses it to the
 * wrong host. These tests hold a foreign overlay open (and gate a real in-lock swap) while
 * a secret-less org resolves, and assert the ONLY key ever used is the boot snapshot.
 *
 * Provider under test is sandbox (credentialEnv PI_POD_SANDBOX_TOKEN) with a fake factory that records
 * the key installed at build time. Real sandbox loader restored afterwards.
 */
const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const ENV_VAR = "PI_POD_SANDBOX_TOKEN";
const BOOT_KEY = "sandbox-platform-boot-key";
const BYOK_KEY = "sandbox-byok-org-key";
const FOREIGN_KEY = "sandbox-foreign-overlay-key";

describe("provider credential overlay discipline (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgByok = uuidv7();
  const orgPlain = uuidv7();
  const orgEmpty = uuidv7();
  const userByok = uuidv7();
  const userPlain = uuidv7();
  const userEmpty = uuidv7();
  const kek = new EnvKekProvider("overlay-test-kek", randomBytes(32).toString("base64"));
  const bootSnapshot: PlatformCredentialSnapshot = snapshotPlatformCredentials({
    [ENV_VAR]: BOOT_KEY,
  } as unknown as ServerEnv);

  /** Keys the fake factory observed installed at adapter-build time, in order. */
  const builtWith: string[] = [];
  /** providerConfig objects the fake factory received (passthrough check). */
  const builtConfigs: unknown[] = [];
  /**
   * When set, the registry LOADER parks before returning the factory. The lock installs
   * the swap before awaiting the loader, so this holds the swap open deterministically
   * (the sync factory itself cannot park without freezing the event loop).
   */
  let holdLoader: Promise<void> | null = null;
  let loaderEntered = false;
  const stub = () => ({ name: "sandbox" }) as unknown as SandboxProvider;

  const fakeFactory = (config: Record<string, unknown>) => {
    builtWith.push(process.env[ENV_VAR] ?? "<unset>");
    builtConfigs.push(config);
    return stub();
  };
  const gatedLoader = () => {
    if (holdLoader) {
      loaderEntered = true;
      return holdLoader.then(() => fakeFactory);
    }
    return Promise.resolve(fakeFactory);
  };

  const depsFor = (): Pick<PodServiceDeps, "env" | "kek" | "platformCredentials"> => ({
    env: { [ENV_VAR]: BOOT_KEY } as unknown as ServerEnv,
    kek,
    platformCredentials: bootSnapshot,
  });

  const ambientBefore = process.env[ENV_VAR];

  before(async () => {
    // migrate() opens and closes its own pool; init ours afterwards.
    await migrate(databaseUrl!, new URL("../migrations", import.meta.url).pathname);
    initPool(databaseUrl!);
    for (const [org, name] of [[orgByok, "overlay byok"], [orgPlain, "overlay plain"], [orgEmpty, "overlay empty"]] as const) {
      await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [org, name]);
    }
    for (const user of [userByok, userPlain, userEmpty]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [user, `${user}@example.test`]);
    }
    await putSecret({
      kek, orgId: orgByok, scopeType: "org", scopeId: orgByok,
      name: ENV_VAR, value: BYOK_KEY, createdBy: userByok,
    });
    registerProvider("sandbox", gatedLoader);
  });

  after(async () => {
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
    if (ambientBefore === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = ambientBefore;
    await query("DELETE FROM secrets WHERE org_id = ANY($1)", [[orgByok, orgPlain, orgEmpty]]);
    await query("DELETE FROM users WHERE id = ANY($1)", [[userByok, userPlain, userEmpty]]);
    await query("DELETE FROM organizations WHERE id = ANY($1)", [[orgByok, orgPlain, orgEmpty]]);
    await closePool();
  });

  afterEach(() => {
    builtWith.length = 0;
    builtConfigs.length = 0;
    holdLoader = null;
    loaderEntered = false;
    delete process.env[ENV_VAR];
  });

  it("secret-less org falls back ONLY to the boot snapshot under a foreign overlay", async () => {
    process.env[ENV_VAR] = FOREIGN_KEY;
    const seen = await withProviderCredential({
      kek,
      platformEnv: platformCredentialsOf(depsFor()),
      orgId: orgPlain,
      provider: "sandbox",
      providerConfig: { url: "https://platform.example" },
      fn: async () => builtWith[builtWith.length - 1]!,
    });
    assert.equal(seen, BOOT_KEY);
    assert.equal(builtWith.length, 1);
  });

  it("BYOK org keeps its own key under overlay (custody preserved)", async () => {
    process.env[ENV_VAR] = FOREIGN_KEY;
    const seen = await withProviderCredential({
      kek,
      platformEnv: platformCredentialsOf(depsFor()),
      orgId: orgByok,
      provider: "sandbox",
      providerConfig: {},
      fn: async () => builtWith[builtWith.length - 1]!,
    });
    assert.equal(seen, BYOK_KEY);
  });

  // A BYOK build parks INSIDE the lock (loader gate) with its key installed, while the
  // test resolves for a secret-less org. The full build path is chain-serialized, so the
  // concurrent party resolves (never builds) under the held swap — exactly the lines
  // 116-123 mechanism: `platformEnv: process.env` is read after the resolver's DB await.
  async function withHeldByokSwap<T>(fn: () => Promise<T>): Promise<T> {
    let releaseSwap!: () => void;
    const swapHeld = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    holdLoader = swapHeld;
    const holding = withProviderCredential({
      kek,
      platformEnv: platformCredentialsOf(depsFor()),
      orgId: orgByok,
      provider: "sandbox",
      providerConfig: {},
      fn: async () => "holder-done",
    });
    try {
      for (let i = 0; i < 200 && !loaderEntered; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(loaderEntered, "BYOK build did not reach the gated loader");
      assert.equal(process.env[ENV_VAR], BYOK_KEY, "lock did not install the BYO key (test setup broken)");
      return await fn();
    } finally {
      releaseSwap();
      assert.equal(await holding, "holder-done");
    }
  }

  it("explicit snapshot resolves the boot key under a live BYOK swap (resolver level)", async () => {
    await withHeldByokSwap(async () => {
      const resolved = await resolveProviderCredential({
        kek,
        orgId: orgPlain,
        provider: "sandbox",
        platformEnv: platformCredentialsOf(depsFor()),
      });
      assert.equal(resolved, BOOT_KEY);
    });
  });

  it("ambient process.env reference resolves the in-lock BYO key (why explicit is required)", async () => {
    await withHeldByokSwap(async () => {
      const resolved = await resolveProviderCredential({
        kek,
        orgId: orgPlain,
        provider: "sandbox",
        platformEnv: process.env,
      });
      assert.equal(resolved, BYOK_KEY, "expected the ambient hazard to surface here");
    });
  });

  it("full withProviderCredential flow builds the boot key while a swap was live", async () => {
    // Timing-assisted: org B starts while A's swap MIGHT still be installed, but B's
    // explicit snapshot makes the outcome independent of that timing either way.
    let releaseSwap!: () => void;
    const swapHeld = new Promise<void>((resolve) => {
      releaseSwap = resolve;
    });
    holdLoader = swapHeld;
    const holding = withProviderCredential({
      kek,
      platformEnv: platformCredentialsOf(depsFor()),
      orgId: orgByok,
      provider: "sandbox",
      providerConfig: {},
      fn: async () => "holder-done",
    });
    try {
      for (let i = 0; i < 200 && !loaderEntered; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(loaderEntered, "BYOK build did not reach the gated loader");
      const waiter = withProviderCredential({
        kek,
        platformEnv: platformCredentialsOf(depsFor()),
        orgId: orgPlain,
        provider: "sandbox",
        providerConfig: {},
        fn: async () => builtWith[builtWith.length - 1]!,
      });
      // Let B's resolver run (DB read) while the swap is definitely installed.
      await new Promise((r) => setTimeout(r, 250));
      releaseSwap();
      assert.equal(await holding, "holder-done");
      assert.equal(await waiter, BOOT_KEY);
      assert.deepEqual(builtWith, [BYOK_KEY, BOOT_KEY]);
    } finally {
      releaseSwap();
      await holding.catch(() => {});
    }
  });

  it("explicit ambient input still reads the live env (documents pre-fix behavior, CLI-only safe)", async () => {
    process.env[ENV_VAR] = FOREIGN_KEY;
    const seen = await withProviderCredential({
      kek,
      // Explicit opt-in to ambient reads: only fresh CLI processes may do this.
      // Server paths must pass a snapshot — the required parameter makes that
      // choice visible at every call site.
      platformEnv: process.env,
      orgId: orgPlain,
      provider: "sandbox",
      providerConfig: {},
      fn: async () => builtWith[builtWith.length - 1]!,
    });
    // No snapshot passed: fresh-CLI-process behavior. This MUST stay out of server paths.
    assert.equal(seen, FOREIGN_KEY);
  });

  it("empty snapshot + no secret still refuses 400 under overlay (overlay is never fallback)", async () => {
    process.env[ENV_VAR] = FOREIGN_KEY;
    const empty = snapshotPlatformCredentials({} as unknown as ServerEnv);
    await assert.rejects(
      withProviderCredential({
        kek,
        platformEnv: empty,
        orgId: orgEmpty,
        provider: "sandbox",
        providerConfig: {},
        fn: async () => "should-not-resolve",
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /no sandbox credential/);
        return true;
      },
    );
    assert.equal(builtWith.length, 0, "no adapter build may start without a resolved key");
  });

  it("providerConfig passes through untouched (no foreign URL merge)", async () => {
    const config = { url: "https://platform.example", mode: "test" };
    await withProviderCredential({
      kek,
      platformEnv: platformCredentialsOf(depsFor()),
      orgId: orgPlain,
      provider: "sandbox",
      providerConfig: config,
      fn: async (_provider, credentialScope) => {
        assert.match(credentialScope, /^sha256:[0-9a-f]{64}$/);
      },
    });
    assert.deepEqual(builtConfigs[0], config);
  });
});
