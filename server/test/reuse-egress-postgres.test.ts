/**
 * Reuse/egress persistence + enforcement regression (M5 + root review of #295):
 * real reuse/PG path with frozen policy vs ACTUAL fake-provider policy state —
 * never just the resolver string.
 *
 * The fake sandbox provider models native enforcement faithfully: the policy handed at
 * create is enforced forever (no updateEgress, like the real native provider), and every
 * sandbox records start/exec calls so tests prove nothing ran before a refusal.
 *
 * Covered through reusePod's real claim + background refresh + real row reads:
 * - open M5 heal (broken "" → "open", piAuthProviders refresh, same disk, start ran once)
 * - stable allowlist reuse still starts (no regression for restricted pods)
 * - derived-forbidden drift refuses BEFORE start (description restored, disk kept)
 * - endpoint rotation (new credential) refuses BEFORE start
 * - explicit forbidden host is a synchronous 409 with the row untouched
 * - broken allowlist row fails closed BEFORE start
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { describePolicy } from "../src/core/egress.js";
import { registerProvider } from "../src/core/providers/registry.js";
import type { Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { upsertCredentialEntry } from "../src/server/model-credentials/store.js";
import { ensureAgentdCallbackEgress } from "../src/server/pods/supervisor.js";
import { planPodLaunch } from "../src/server/pods/planning.js";
import { resolveLaunchEgressPolicy } from "../src/server/pods/provisioning.js";
import { reusePod } from "../src/server/pods/reuse.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const CALLBACK_URL = "https://api.pipod.test";
const env = {
  GATEWAY_ID: "gateway-reuse-egress",
  PI_POD_SANDBOX_TOKEN: "test-provider-key",
  PUBLIC_URL: CALLBACK_URL,
} as unknown as ServerEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };

interface FakeSandboxState {
  startCalls: number;
  execCalls: number;
  stopCalls: number;
}

const sandboxStates = new Map<string, FakeSandboxState>();
/** What the provider actually enforces per sandbox (set at create, immutable after). */
const enforcedPolicies = new Map<string, string>();
/** Sandbox ids whose handle lookup transiently fails (infra blip before any decision). */
const failingGets = new Set<string>();

function fakeSandbox(id: string): Sandbox {
  let state = sandboxStates.get(id);
  if (!state) {
    state = { startCalls: 0, execCalls: 0, stopCalls: 0 };
    sandboxStates.set(id, state);
  }
  const current = state;
  return {
    id,
    start: async () => {
      current.startCalls += 1;
    },
    stop: async () => {
      current.stopCalls += 1;
    },
    rehydrateEnv: () => {},
    exec: async () => {
      current.execCalls += 1;
      return { exitCode: 0, output: "" };
    },
    uploadFile: async () => {},
    uploadLocalFile: async () => {},
    downloadFile: async () => new Uint8Array(),
    // Deliberately NO updateEgress: the native provider has none, so enforcement is
    // immutable after create and reuse can only verify-or-refuse, never reconcile.
  } as unknown as Sandbox;
}

const provider = {
  name: "sandbox",
  capabilities: {
    egressEnforcement: "domain",
    egressAddressFamily: "dual",
    egressMaxEntries: null,
  },
  keepaliveApiHost: undefined,
  get: async (id: string) => {
    if (failingGets.has(id)) throw new Error("transient handle lookup failure");
    return fakeSandbox(id);
  },
  resolveImage: async () => true,
} as unknown as SandboxProvider;

const kek = new EnvKekProvider("reuse-egress-kek", randomBytes(32).toString("base64"));
const deps: PodServiceDeps = { env, kek, log };
const orgIds: string[] = [];

async function setupOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = uuidv7();
  const userId = uuidv7();
  orgIds.push(orgId);
  await query("INSERT INTO organizations (id, name) VALUES ($1, 'reuse egress test')", [orgId]);
  await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  return { orgId, userId };
}

async function writeUserEgress(orgId: string, userId: string, egress: unknown): Promise<void> {
  await writeLayer({
    scopeType: "user_defaults",
    scopeId: userId,
    orgId,
    config: { egress },
    expectedVersion: 0,
    updatedBy: userId,
  });
}

/** Freeze a production-shaped row using the REAL plan + REAL resolver (what fresh did). */
async function freezeLaunchedRow(args: {
  orgId: string;
  userId: string;
  podId: string;
  sandboxId: string;
  descriptionOverride?: string;
}): Promise<{ workdir: string; image: string; description: string; mode: string }> {
  const plan = await planPodLaunch(deps, { orgId: args.orgId, userId: args.userId, provider: "sandbox" });
  const { resolution } = await resolveLaunchEgressPolicy({
    config: plan.config,
    env: plan.podEnv,
    provider: provider as unknown as Pick<SandboxProvider, "name" | "capabilities" | "keepaliveApiHost">,
    providerConfig: plan.config.providers[plan.providerName] ?? {},
    credentialContract: plan.credentialContract,
    piAuth: plan.piAuth,
    piSettings: plan.piSettings,
    forbiddenEgressHosts: plan.policy.forbiddenEgressHosts ?? [],
  });
  const description = args.descriptionOverride ?? describePolicy(resolution.policy);
  // The provider enforces exactly the real launch resolution from create on (native:
  // immutable after) — even when the frozen row later lost the string (broken "" rows).
  enforcedPolicies.set(args.sandboxId, describePolicy(resolution.policy));
  await query(
    `INSERT INTO pods
       (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
        resolved_config, project, template_id)
     VALUES ($1, $2, $3, 'reuse egress pod', 'sandbox', $4, 'active', 'stopped', $5::jsonb, NULL, NULL)`,
    [args.podId, args.orgId, args.userId, args.sandboxId, JSON.stringify({
      config: { egress: plan.config.egress, image: plan.config.image, providers: {} },
      secretKeys: [],
      workdir: plan.workdir,
      warnings: [],
      egress: { mode: plan.config.egress.mode, description },
    })],
  );
  return { workdir: plan.workdir, image: plan.config.image, description, mode: plan.config.egress.mode };
}

async function readPod(podId: string): Promise<{ provider_state: string; resolved_config: Record<string, never> }> {
  const row = await query<{ provider_state: string; resolved_config: Record<string, never> }>(
    "SELECT provider_state, resolved_config FROM pods WHERE id = $1", [podId],
  );
  return row.rows[0]!;
}

/** Poll until the background refresh leaves `provisioning`; fail on `error`. */
async function settle(podId: string): Promise<{ provider_state: string; resolved_config: Record<string, never> }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await readPod(podId);
    if (row.provider_state !== "provisioning") return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("reuse refresh never settled");
}

type Report = {
  egress: { mode: string; description: string };
  piAuthProviders?: string[];
  reused?: boolean;
  reuseRefused?: string;
  workdir: string;
  config: { image: string };
};

describe("reuse egress enforcement (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => () => provider);
  });

  after(async () => {
    for (const orgId of orgIds) {
      await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]).catch(() => {});
      await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]).catch(() => {});
      await query("DELETE FROM pod_launch_env WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]).catch(() => {});
      await query("DELETE FROM pods WHERE org_id = $1", [orgId]).catch(() => {});
      await query("DELETE FROM settings WHERE org_id = $1", [orgId]).catch(() => {});
    }
    const userRows = await query<{ id: string }>("SELECT id FROM users WHERE email LIKE '%@example.test'").catch(() => ({ rows: [] as Array<{ id: string }> }));
    for (const user of (userRows as { rows: Array<{ id: string }> }).rows) {
      await query("DELETE FROM users WHERE id = $1", [user.id]).catch(() => {});
    }
    for (const orgId of orgIds) {
      await query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
    }
    await closePool();
  });

  it("heals a broken open row via supported reuse (same disk, start ran once)", async () => {
    const { orgId, userId } = await setupOrg();
    const podId = uuidv7();
    const sandboxId = `reuse-open-${podId.slice(0, 8)}`;
    // Frozen row predates the credential (M5: piAuthProviders null, description "").
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId, descriptionOverride: "" });
    assert.equal(frozen.description, "");
    await upsertCredentialEntry(kek, { orgId, userId }, "openrouter", { type: "api_key", key: "k" });

    const { pod } = await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    assert.equal(pod.id, podId);
    const final = await settle(podId);
    assert.equal(final.provider_state, "started");
    const report = final.resolved_config as unknown as Report;
    assert.equal(report.egress.mode, "open");
    assert.equal(report.egress.description, "open");
    // Published string equals actual provider enforcement (open/open).
    assert.equal(report.egress.description, enforcedPolicies.get(sandboxId));
    assert.deepEqual(report.piAuthProviders, ["openrouter"]);
    assert.equal(report.reused, true);
    assert.equal(report.workdir, frozen.workdir);
    assert.equal(report.config.image, frozen.image);
    assert.equal(sandboxStates.get(sandboxId)?.startCalls, 1);
  });

  it("reuses a stable allowlist pod (restricted stays restricted, same disk)", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    const podId = uuidv7();
    const sandboxId = `reuse-stable-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId });
    assert.match(frozen.description, /^allowlist:/);
    assert.ok(frozen.description.includes("example.com"));
    assert.ok(frozen.description.includes("api.pipod.test"));

    const { pod } = await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    assert.equal(pod.id, podId);
    const final = await settle(podId);
    assert.equal(final.provider_state, "started");
    const report = final.resolved_config as unknown as Report;
    assert.equal(report.egress.description, frozen.description);
    assert.notEqual(report.egress.description, "open");
    assert.equal(report.egress.description, enforcedPolicies.get(sandboxId));
    assert.equal(sandboxStates.get(sandboxId)?.startCalls, 1);
    assert.ok((sandboxStates.get(sandboxId)?.execCalls ?? 0) > 0);
  });

  it("refuses derived-forbidden drift BEFORE start (restores frozen, keeps disk)", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    await upsertCredentialEntry(kek, { orgId, userId }, "openrouter", { type: "api_key", key: "k" });
    const podId = uuidv7();
    const sandboxId = `reuse-drift-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId });
    assert.ok(frozen.description.includes("openrouter.ai"), `frozen must derive openrouter.ai, got ${frozen.description}`);
    // The gateway cannot heal this: the callback is already allowed, so the gate is a no-op.
    const gated = await ensureAgentdCallbackEgress({
      sandbox: {} as Sandbox,
      description: frozen.description,
      publicUrl: CALLBACK_URL,
    });
    assert.equal(gated, frozen.description);
    // Org later forbids exactly that DERIVED host: explicit config.allow is untouched, so the
    // config guard passes and only the verify-before-start decision can refuse.
    await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { forbiddenEgressHosts: ["openrouter.ai"] },
      expectedVersion: 0,
      updatedBy: userId,
    });

    await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    const final = await settle(podId);
    assert.equal(final.provider_state, "stopped");
    const report = final.resolved_config as unknown as Report;
    assert.match(report.reuseRefused ?? "", /changed since launch/);
    assert.equal(report.reused, false);
    // Claim-clobbered "" repaired: the row again names what the provider enforces.
    assert.equal(report.egress.description, frozen.description);
    assert.equal(report.egress.description, enforcedPolicies.get(sandboxId));
    // Nothing ran: no start, no exec, no init on the unapproved policy.
    assert.equal(sandboxStates.get(sandboxId)?.startCalls ?? 0, 0);
    assert.equal(sandboxStates.get(sandboxId)?.execCalls ?? 0, 0);
  });

  it("refuses endpoint rotation BEFORE start (new credential the sandbox cannot reach)", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    const podId = uuidv7();
    const sandboxId = `reuse-rotate-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId });
    assert.ok(!frozen.description.includes("openrouter.ai"));
    // Credential connects after launch: the recompute gains an endpoint the stopped
    // sandbox was never granted. Same-config guard passes; the decision refuses.
    await upsertCredentialEntry(kek, { orgId, userId }, "openrouter", { type: "api_key", key: "k" });

    await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    const final = await settle(podId);
    assert.equal(final.provider_state, "stopped");
    const report = final.resolved_config as unknown as Report;
    assert.match(report.reuseRefused ?? "", /changed since launch/);
    assert.equal(report.egress.description, frozen.description);
    assert.equal(sandboxStates.get(sandboxId)?.startCalls ?? 0, 0);
    assert.equal(sandboxStates.get(sandboxId)?.execCalls ?? 0, 0);
  });

  it("explicit forbidden host is a synchronous 409 with the row untouched", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    const podId = uuidv7();
    const sandboxId = `reuse-409-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId });
    await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { forbiddenEgressHosts: ["example.com"] },
      expectedVersion: 0,
      updatedBy: userId,
    });

    await assert.rejects(
      () => reusePod(deps, { podId, orgId, userId, provider: "sandbox" }),
      /different egress policy/,
    );
    const row = await readPod(podId);
    assert.equal(row.provider_state, "stopped");
    assert.equal((row.resolved_config as unknown as Report).egress.description, frozen.description);
    assert.equal(sandboxStates.get(sandboxId)?.startCalls ?? 0, 0);
  });

  it("broken allowlist row fails closed BEFORE start (never blank-to-open)", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    const podId = uuidv7();
    const sandboxId = `reuse-broken-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId, descriptionOverride: "" });
    assert.equal(frozen.mode, "allowlist");

    await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    const final = await settle(podId);
    assert.equal(final.provider_state, "stopped");
    const report = final.resolved_config as unknown as Report;
    assert.match(report.reuseRefused ?? "", /no recoverable provider egress policy/);
    assert.equal(report.egress.description, "");
    assert.notEqual(report.egress.description, "open");
    assert.equal(sandboxStates.get(sandboxId)?.startCalls ?? 0, 0);
    assert.equal(sandboxStates.get(sandboxId)?.execCalls ?? 0, 0);
  });

  it("transient pre-decision failure restores frozen (never bricks a good row)", async () => {
    const { orgId, userId } = await setupOrg();
    await writeUserEgress(orgId, userId, { mode: "allowlist", builtins: true, allow: ["example.com"] });
    const podId = uuidv7();
    const sandboxId = `reuse-blip-${podId.slice(0, 8)}`;
    const frozen = await freezeLaunchedRow({ orgId, userId, podId, sandboxId });
    failingGets.add(sandboxId);
    try {
      await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
      const final = await settle(podId);
      assert.equal(final.provider_state, "error");
      const report = final.resolved_config as unknown as Report;
      // The claim's placeholder is repaired: the row again names enforced reality.
      assert.equal(report.egress.description, frozen.description);
      assert.equal(report.egress.description, enforcedPolicies.get(sandboxId));
      assert.equal(sandboxStates.get(sandboxId)?.startCalls ?? 0, 0);
      assert.equal(sandboxStates.get(sandboxId)?.execCalls ?? 0, 0);
    } finally {
      failingGets.delete(sandboxId);
    }
  });
});
