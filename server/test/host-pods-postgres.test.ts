import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerProvider, unregisterProvider } from "../src/core/providers/registry.js";
import type { ExecOpts, Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import {
  LEGACY_PROJECT_LAYERS_WARNING,
  type PodRow,
  type PodServiceDeps,
} from "../src/server/pods/service.js";
import { snapshotPlatformCredentials } from "../src/server/pods/providercred.js";
import { claimNextIdlePod } from "../src/server/workers/reaper.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
// Boot-shaped env (mirrors main(): keys live in the parsed env, never ambient). The
// threaded snapshot below is what withProviderCredential consumes as platform fallback.
const env = {
  GATEWAY_ID: "gateway-host-pods-test",
  PI_POD_SANDBOX_TOKEN: "test-provider-token",
} as unknown as ServerEnv;

describe("co-located pods (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const hostPodId = uuidv7();
  const hostSandboxId = `fake-host-${hostPodId}`;
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const deps: PodServiceDeps = { env, kek, log, platformCredentials: snapshotPlatformCredentials(env) };

  /** Every exec/upload against the fake host machine, for placement assertions. */
  const hostExecs: string[][] = [];
  const hostUploads = new Map<string, Uint8Array>();
  let hostState: "started" | "stopped" = "started";
  let hostStops = 0;

  const hostSandbox = {
    id: hostSandboxId,
    state: async () => hostState,
    waitUntilStarted: async () => {},
    start: async () => { hostState = "started"; },
    rehydrateEnv: () => {},
    exec: async (argv: string[], _opts?: ExecOpts) => {
      hostExecs.push(argv);
      return { exitCode: 0, output: "" };
    },
    uploadFile: async (destPath: string, contents: Uint8Array) => {
      hostUploads.set(destPath, contents);
    },
    uploadLocalFile: async () => {},
    downloadFile: async (sourcePath: string) => {
      const found = hostUploads.get(sourcePath);
      if (!found) throw new Error(`no such file: ${sourcePath}`);
      return found;
    },
    openPty: async () => { throw new Error("no PTY in this test"); },
    setLabels: async () => {},
    applyRetention: async () => false,
    archive: async () => {},
    refreshActivity: async () => {},
    stop: async () => { hostStops += 1; hostState = "stopped"; },
    delete: async () => {},
  } as unknown as Sandbox;
  const provider = {
    name: "sandbox",
    capabilities: {},
    get: async (id: string) => (id.startsWith("fake-host-") ? hostSandbox : null),
  } as unknown as SandboxProvider;

  let app: ReturnType<typeof Fastify>;
  let auth = { userId, email: `${userId}@example.test`, orgId, permissions: ["pods:launch"], podId: undefined as string | undefined };

  const hostResolvedConfig = {
    config: { providers: {}, image: "img-1", workdir: "/workspace", idleTimeoutMinutes: 30, pi: { sessionNaming: "auto" } },
    image: { ref: "img-1", managed: false, provenance: "config", assetDigest: "", status: "ready" },
    egress: { description: "open egress", mode: "open" },
    workdir: "/workspace",
    warnings: [],
  };

  async function insertHostPod(id: string, sandboxId: string): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state,
         provider_state, resolved_config, lineage_root_id, lineage_depth, transport)
       VALUES ($1, $2, $3, 'host pod', 'sandbox', $4, 'active', 'started', $5::jsonb, $1, 0, 'ws')`,
      [id, orgId, userId, sandboxId, JSON.stringify(hostResolvedConfig)],
    );
  }

  async function launch(body: Record<string, unknown>): Promise<{ status: number; json: () => unknown }> {
    const response = await app.inject({ method: "POST", url: "/pods", payload: body });
    return { status: response.statusCode, json: () => response.json() };
  }

  async function awaitProvisioned(podId: string): Promise<PodRow> {
    for (let i = 0; i < 100; i++) {
      const rows = await query<PodRow>("SELECT * FROM pods WHERE id = $1", [podId]);
      const pod = rows.rows[0]!;
      if (pod.provider_state === "started" || pod.provider_state === "error") return pod;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("pod never finished provisioning");
  }

  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'host pods test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await insertHostPod(hostPodId, hostSandboxId);

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerPodRoutes(app, deps, null);
    await app.ready();
  });

  after(async () => {
    await app.close();
    unregisterProvider("sandbox");
    await query("DELETE FROM pod_tokens WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pod_launch_env WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await closePool();
  });

  it("launches a co-located pod on a named host and provisions it on the host machine", async () => {
    hostExecs.length = 0;
    const { status, json } = await launch({
      placement: { host: hostPodId },
      project: { name: "worker-1", config: {}, env: { CHILD_ONLY: "1" }, initScript: "", bakeScript: "" },
    });
    assert.equal(status, 201);
    const created = (json() as { pod: { id: string; provider: string; hostPodId: string; location: string } }).pod;
    assert.equal(created.provider, "host");
    assert.equal(created.hostPodId, hostPodId);
    assert.equal(created.location, "on host pod");

    const pod = await awaitProvisioned(created.id);
    assert.equal(pod.provider_state, "started");
    assert.equal(pod.host_pod_id, hostPodId);
    assert.equal(pod.provider_sandbox_id, `host:${hostPodId}:${pod.id}`);
    // User launch: no parent, its own lineage root.
    assert.equal(pod.parent_pod_id, null);
    assert.equal(pod.lineage_root_id, pod.id);
    // Host clocks govern the machine: the child is exempt from reaper and archive sweep.
    assert.equal(pod.resolved_config.config.idleTimeoutMinutes, 0);
    assert.equal(pod.resolved_config.config.archiveAfterMinutes, 0);
    assert.match(pod.resolved_config.egress.description, /inherited from host/);
    // The runtime landed on the host: per-child shim path, runtime dir, supervisor exec.
    assert.ok(hostUploads.has(`/tmp/pi-pod-agentd.${pod.id}.cjs`), "per-child shim uploaded");
    assert.ok(hostUploads.has(`/var/lib/pi-pod/children/${pod.id}/meta.json`), "runtime meta written");
    const supervisor = hostExecs.find((argv) => argv.join(" ").includes(`/tmp/pi-pod-agentd.${pod.id}.cjs --daemon`));
    assert.ok(supervisor, "agentd supervisor started with per-child paths");
  });

  it("shares the host workdir and ignores legacy request init with a warning", async () => {
    const { status, json } = await launch({
      placement: { host: hostPodId },
      project: { name: "worker-skip-init", config: {}, env: {}, initScript: "echo setup", bakeScript: "" },
    });
    assert.equal(status, 201);
    const pod = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);
    assert.equal(pod.resolved_config.workdir, "/workspace");
    assert.deepEqual(pod.resolved_config.initSteps, []);
    assert.ok(pod.resolved_config.warnings.includes(LEGACY_PROJECT_LAYERS_WARNING));
  });

  it("runs the stored bundle init chain when the child gets an explicitly fresh workdir", async () => {
    hostExecs.length = 0;
    await writeLayer({
      scopeType: "user_defaults",
      scopeId: userId,
      orgId,
      config: { workdir: "/workspace/worker-fresh" },
      initScript: "echo fresh-init-ran",
      expectedVersion: 0,
      updatedBy: userId,
    });
    try {
      const { status, json } = await launch({ placement: { host: hostPodId } });
      assert.equal(status, 201);
      const pod = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);
      assert.equal(pod.provider_state, "started");
      assert.equal(pod.resolved_config.workdir, "/workspace/worker-fresh");
      assert.deepEqual(pod.resolved_config.initSteps?.map((s) => s.scope), ["user"]);
      assert.equal(pod.resolved_config.initSteps?.[0]?.status, "ok");
    } finally {
      await query("DELETE FROM settings WHERE org_id = $1 AND scope_type = 'user_defaults'", [orgId]);
    }
  });

  it("inherits the host workdir when no layer names one, even a nonstandard one", async () => {
    // The safety property behind this test is load-bearing: a *defaulted* workdir must never
    // read as an ownership claim (ownership + delete would remove a directory the child did
    // not create). Inheritance-by-provenance is what prevents that.
    const oddHostId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state,
         provider_state, resolved_config, lineage_root_id, lineage_depth, transport)
       VALUES ($1, $2, $3, 'odd-workdir host', 'sandbox', $4, 'active', 'started', $5::jsonb, $1, 0, 'ws')`,
      [
        oddHostId,
        orgId,
        userId,
        `fake-host-${oddHostId}`,
        JSON.stringify({ ...hostResolvedConfig, workdir: "/srv/odd", config: { ...hostResolvedConfig.config, workdir: "/srv/odd" } }),
      ],
    );
    const { status, json } = await launch({
      placement: { host: oddHostId },
      project: { name: "worker-inherit", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    assert.equal(status, 201);
    const pod = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);
    assert.equal(pod.resolved_config.workdir, "/srv/odd", "defaulted workdir inherits the host's");
    const meta = hostUploads.get(`/var/lib/pi-pod/children/${pod.id}/meta.json`);
    assert.ok(meta);
    const parsed = JSON.parse(new TextDecoder().decode(meta)) as { ownsWorkdir: boolean; hostWorkdir: string };
    assert.equal(parsed.ownsWorkdir, false, "an inherited workdir is never child-owned");
    assert.equal(parsed.hostWorkdir, "/srv/odd");
  });

  it("ignores machine-shaped legacy project config instead of rejecting it", async () => {
    const { status, json } = await launch({
      placement: { host: hostPodId },
      project: { name: "worker-bad", config: { egress: { mode: "open" }, resources: { cpu: 8 } }, env: {}, initScript: "", bakeScript: "" },
    });
    assert.equal(status, 201);
    const pod = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);
    assert.ok(pod.resolved_config.warnings.includes(LEGACY_PROJECT_LAYERS_WARNING));
    assert.notEqual(pod.resolved_config.config.resources.cpu, 8);
  });

  it("rejects placement combined with provider or fork; self needs a pod token", async () => {
    assert.equal((await launch({ placement: { host: hostPodId }, provider: "sandbox" })).status, 400);
    assert.equal(
      (await launch({ placement: { host: hostPodId }, forkFrom: { podId: hostPodId } })).status,
      400,
    );
    assert.equal((await launch({ placement: { host: "self" } })).status, 400);
  });

  it("lets a pod token place children on itself past the nested count caps, but rate-limited", async () => {
    auth = { ...auth, podId: hostPodId, permissions: [] };
    try {
      // Default nestedPods.maxChildrenPerPod is 5; co-located children are exempt.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { status, json } = await launch({
          placement: { host: "self" },
          project: { name: `sub-${i}`, config: {}, env: {}, initScript: "", bakeScript: "" },
        });
        assert.equal(status, 201, `launch ${i} succeeded: ${JSON.stringify(json())}`);
        ids.push((json() as { pod: { id: string; parentPodId: string } }).pod.id);
      }
      const rows = await query<PodRow>("SELECT * FROM pods WHERE id = ANY($1)", [ids]);
      for (const row of rows.rows) {
        assert.equal(row.parent_pod_id, hostPodId);
        assert.equal(row.host_pod_id, hostPodId);
        assert.equal(row.lineage_root_id, hostPodId);
      }
      // The per-parent launch rate limit still applies: a spawner loop fails fast.
      let limited = 0;
      for (let i = 0; i < 8; i++) {
        const { status } = await launch({
          placement: { host: "self" },
          project: { name: `burst-${i}`, config: {}, env: {}, initScript: "", bakeScript: "" },
        });
        if (status === 409) limited += 1;
      }
      assert.ok(limited > 0, "rate limit engaged");
    } finally {
      auth = { ...auth, podId: undefined, permissions: ["pods:launch"] };
    }
  });

  it("resolves placement onto a co-located pod to its real host (--on self nests flat)", async () => {
    const { status, json } = await launch({
      placement: { host: hostPodId },
      project: { name: "nest-base", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    assert.equal(status, 201);
    const base = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);

    const nested = await launch({
      placement: { host: base.id },
      project: { name: "nest-child", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    assert.equal(nested.status, 201);
    const nestedPod = (nested.json() as { pod: { id: string; hostPodId: string } }).pod;
    assert.equal(nestedPod.hostPodId, hostPodId, "flattened to the real machine owner");

    // The load-bearing case: a co-located child's own token saying `--on self`.
    auth = { ...auth, podId: base.id, permissions: [] };
    try {
      const fromChild = await launch({
        placement: { host: "self" },
        project: { name: "nest-from-child", config: {}, env: {}, initScript: "", bakeScript: "" },
      });
      assert.equal(fromChild.status, 201, JSON.stringify(fromChild.json()));
      const fromChildPod = (fromChild.json() as { pod: { id: string; hostPodId: string; parentPodId: string } }).pod;
      assert.equal(fromChildPod.hostPodId, hostPodId, "--on self from a child flattens to the real host");
      assert.equal(fromChildPod.parentPodId, base.id, "lineage records the actual launcher");
    } finally {
      auth = { ...auth, podId: undefined, permissions: ["pods:launch"] };
    }
  });

  it("cascades host stop to running children as host_stopped", async () => {
    const { json } = await launch({
      placement: { host: hostPodId },
      project: { name: "worker-cascade", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    const child = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);
    assert.equal(child.provider_state, "started");

    hostState = "started";
    const stopped = await app.inject({ method: "POST", url: `/pods/${hostPodId}/stop` });
    assert.equal(stopped.statusCode, 200);
    assert.ok(hostStops > 0);

    const after = await query<PodRow>("SELECT * FROM pods WHERE id = $1", [child.id]);
    assert.equal(after.rows[0]!.provider_state, "stopped");
    assert.equal(after.rows[0]!.last_stop_cause, "host_stopped");

    // Bring the fixture host back for the remaining tests.
    hostState = "started";
    await query("UPDATE pods SET provider_state = 'started', last_stop_cause = NULL WHERE id = $1", [hostPodId]);
  });

  it("holds an idle host open while a co-located child is busy or fresh", async () => {
    const idleHostId = uuidv7();
    await insertHostPod(idleHostId, `fake-host-${idleHostId}`);
    await query(
      "UPDATE pods SET last_activity_at = now() - interval '10 hours' WHERE id = $1",
      [idleHostId],
    );
    const childId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state,
         provider_state, resolved_config, lineage_root_id, lineage_depth, host_pod_id, transport, last_activity_at)
       VALUES ($1, $2, $3, 'busy child', 'host', $4, 'active', 'started', $5::jsonb, $1, 0, $6, 'ws', now())`,
      [
        childId,
        orgId,
        userId,
        `host:${idleHostId}:${childId}`,
        JSON.stringify({ config: { providers: {}, idleTimeoutMinutes: 0 }, workdir: "/workspace", warnings: [] }),
        idleHostId,
      ],
    );
    // Child active now → the host is not eligible.
    assert.equal(await claimNextIdlePod([idleHostId]), null, "busy child holds the host open");
    // Child stale too → the machine is idle end-to-end and the host is claimed.
    await query("UPDATE pods SET last_activity_at = now() - interval '10 hours' WHERE id = $1", [childId]);
    const claimed = await claimNextIdlePod([idleHostId]);
    assert.equal(claimed?.id, idleHostId);
    assert.equal(claimed?.last_stop_cause, "idle_stop");
    // The child itself is never claimed (idleTimeoutMinutes 0).
    assert.equal(await claimNextIdlePod([childId]), null);
  });

  it("logically archives and restores the host's co-located children with it", async () => {
    const hid = uuidv7();
    await insertHostPod(hid, `fake-host-${hid}`);
    const { json } = await launch({
      placement: { host: hid },
      project: { name: "worker-arch", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    const child = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);

    const archived = await app.inject({ method: "POST", url: `/pods/${hid}/archive` });
    assert.equal(archived.statusCode, 200);
    assert.deepEqual(archived.json().cascaded, [child.id]);
    assert.equal(archived.json().state, "archived");
    const afterArchive = await query<{ id: string; state: string }>(
      "SELECT id, state FROM pods WHERE id = ANY($1) ORDER BY id",
      [[hid, child.id]],
    );
    assert.ok(afterArchive.rows.every((row) => row.state === "archived"));

    const restored = await app.inject({ method: "POST", url: `/pods/${hid}/restore` });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json().cascaded, [child.id]);
    assert.equal(restored.json().state, "active");
    const afterRestore = await query<{ id: string; state: string }>(
      "SELECT id, state FROM pods WHERE id = ANY($1)",
      [[hid, child.id]],
    );
    assert.ok(afterRestore.rows.every((row) => row.state === "active"));
  });

  it("refuses to delete a host with live co-located children, then cascades on request", async () => {
    const doomedHostId = uuidv7();
    await insertHostPod(doomedHostId, `fake-host-${doomedHostId}`);
    const { json } = await launch({
      placement: { host: doomedHostId },
      project: { name: "worker-doomed", config: {}, env: {}, initScript: "", bakeScript: "" },
    });
    const child = await awaitProvisioned((json() as { pod: { id: string } }).pod.id);

    const refused = await app.inject({ method: "DELETE", url: `/pods/${doomedHostId}` });
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().message, /live child pod/);

    hostState = "started";
    const cascaded = await app.inject({ method: "DELETE", url: `/pods/${doomedHostId}?cascade=true` });
    assert.equal(cascaded.statusCode, 200);
    assert.deepEqual(cascaded.json().cascaded, [child.id]);
    const rows = await query<PodRow>("SELECT provider_state FROM pods WHERE id = ANY($1)", [[doomedHostId, child.id]]);
    assert.deepEqual(rows.rows.map((r) => r.provider_state), ["gone", "gone"]);
  });

  it("denies providers by layered union and names the denying layers", async () => {
    await writeLayer({
      scopeType: "org_defaults",
      scopeId: orgId,
      orgId,
      config: { deniedProviders: ["sandbox"] },
      expectedVersion: 0,
      updatedBy: userId,
    });
    try {
      const denied = await launch({ provider: "sandbox" });
      assert.equal(denied.status, 400);
      assert.match((denied.json() as { message: string }).message, /"sandbox" is denied by org deniedProviders/);

      // Retired project config cannot clear the org bundle's denial.
      const stillDenied = await launch({
        provider: "sandbox",
        project: { name: "clear-attempt", config: { deniedProviders: [] }, env: {}, initScript: "", bakeScript: "" },
      });
      assert.equal(stillDenied.status, 400);

      // The host provider is deniable like any other.
      await writeLayer({
        scopeType: "org_defaults",
        scopeId: orgId,
        orgId,
        config: { deniedProviders: ["sandbox", "host"] },
        expectedVersion: 1,
        updatedBy: userId,
      });
      const deniedHost = await launch({
        placement: { host: hostPodId },
        project: { name: "denied-host", config: {}, env: {}, initScript: "", bakeScript: "" },
      });
      assert.equal(deniedHost.status, 400);
      assert.match((deniedHost.json() as { message: string }).message, /"host" is denied by org deniedProviders/);

      // A typo is rejected on write, before it can poison the stored bundle.
      await assert.rejects(
        writeLayer({
          scopeType: "org_defaults",
          scopeId: orgId,
          orgId,
          config: { deniedProviders: ["sandbox-typo"] },
          expectedVersion: 2,
          updatedBy: userId,
        }),
        /unknown provider "sandbox-typo"/,
      );
    } finally {
      await writeLayer({
        scopeType: "org_defaults",
        scopeId: orgId,
        orgId,
        config: {},
        expectedVersion: 2,
        updatedBy: userId,
      });
    }
  });

  it('rejects provider "host" chosen without placement', async () => {
    const { status, json } = await launch({ provider: "host" });
    assert.equal(status, 400);
    assert.match((json() as { message: string }).message, /selected by launch placement/);
  });
});
