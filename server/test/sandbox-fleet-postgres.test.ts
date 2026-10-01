import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { PiPodError } from "../src/core/errors.js";
import { HttpError } from "../src/server/httperrors.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { planPodLaunch } from "../src/server/pods/planning.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";
import {
  addSandboxHost,
  drainSandboxHost,
  listSandboxHosts,
  placeAfterRefusal,
  placeSandboxHost,
  podsOnHost,
  preloadImageOnFleet,
  probeSandboxHost,
  rehomeSandboxHost,
  removeSandboxHost,
  setSandboxHostStatus,
} from "../src/server/pods/sandboxfleet.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const GB = 1024 ** 3;

interface FakeHost {
  url: string;
  server: Server;
  imports: unknown[];
  archives: string[];
  pulls: unknown[];
  setFree(memoryGB: number): void;
  setFreeDisk(diskGB: number): void;
  /** Answer like a host that predates fleet support, reporting no commitments at all. */
  setReportsCapacity(reports: boolean): void;
}

/** A stand-in for one pi-pod-sandbox service: healthz headroom plus the import route. */
async function startFakeHost(id: string, freeMemoryGB: number): Promise<FakeHost> {
  const state = { freeMemoryGB, freeDiskGB: 100, reportsCapacity: true };
  const imports: unknown[] = [];
  const archives: string[] = [];
  const pulls: unknown[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/v1/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          version: "test",
          uptimeSeconds: 1,
          hostId: id,
          sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
          host: {
            cpus: 8,
            memoryTotalBytes: 16 * GB,
            memoryAvailableBytes: 8 * GB,
            ...(state.reportsCapacity
              ? {
                  guaranteeCapacity: { cpu: 8, memoryBytes: 16 * GB },
                  committed: {
                    cpu: 0,
                    memoryBytes: (16 - state.freeMemoryGB) * GB,
                    diskBytes: 0,
                  },
                  diskCapacityBytes: state.freeDiskGB * GB,
                }
              : {}),
          },
        }),
      );
      return;
    }
    const body: Buffer[] = [];
    req.on("data", (chunk: Buffer) => body.push(chunk));
    req.on("end", () => {
      const payload = body.length > 0 ? JSON.parse(Buffer.concat(body).toString()) : {};
      if (url === "/v1/images") {
        pulls.push(payload);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ref: (payload as { ref: string }).ref,
            state: "active",
          }),
        );
        return;
      }
      if (url === "/v1/sandboxes/import") {
        imports.push(payload);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: (payload as { id: string }).id, state: "archived" }));
        return;
      }
      const archiving = /^\/v1\/sandboxes\/([^/]+)\/archive$/.exec(url);
      if (archiving) {
        archives.push(decodeURIComponent(archiving[1]!));
        res.end("{}");
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not_found", message: "no route" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    imports,
    archives,
    pulls,
    setFree: (memoryGB: number) => {
      state.freeMemoryGB = memoryGB;
    },
    setFreeDisk: (diskGB: number) => {
      state.freeDiskGB = diskGB;
    },
    setReportsCapacity: (reports: boolean) => {
      state.reportsCapacity = reports;
    },
  };
}

describe("sandbox fleet (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  let small: FakeHost;
  let large: FakeHost;
  let dead: FakeHost;

  const resolvedConfig = (url: string, image = "ghcr.io/pi-pod/pi-pod-base:test") => ({
    config: {
      workdir: "/workspace",
      resources: { cpu: 2, memoryGB: 4, diskGB: 10 },
      providers: { sandbox: { url } },
    },
    image: { ref: image, managed: true, provenance: "managed", assetDigest: "d", status: "ready" },
  });

  async function makePod(args: {
    id: string;
    sandboxId: string;
    url: string;
    providerState: string;
    provider?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state,
                         provider_state, resolved_config)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8::jsonb)`,
      [
        args.id,
        orgId,
        userId,
        `pod-${args.id.slice(0, 8)}`,
        args.provider ?? "sandbox",
        args.sandboxId,
        args.providerState,
        JSON.stringify(resolvedConfig(args.url)),
      ],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    // Fleet membership is global rather than org-scoped, so a run that died before its cleanup
    // would otherwise leave hosts pointing at ports nothing listens on any more.
    await query("DELETE FROM sandbox_hosts");
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'sandbox fleet test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    small = await startFakeHost("pps-small", 1);
    large = await startFakeHost("pps-large", 12);
    dead = await startFakeHost("pps-dead", 4);
    process.env["PI_POD_SANDBOX_TOKEN"] = "fleet-test-token-long-enough";
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts");
    for (const host of [small, large, dead]) {
      await new Promise<void>((resolve) => host.server.close(() => resolve()));
    }
    await closePool();
  });

  it("answers null until a fleet exists, so a single-host deployment is unaffected", async () => {
    assert.equal(await placeSandboxHost(), null);
  });

  it("preloads PI_POD_SANDBOX_URL when no host is registered", async () => {
    const previous = process.env["PI_POD_SANDBOX_URL"];
    process.env["PI_POD_SANDBOX_URL"] = small.url;
    const notes: string[] = [];
    const password = "ghs_not_for_progress_logs";
    try {
      const result = await preloadImageOnFleet(
        "ghcr.io/pi-pod/pi-pod-base:empty-fleet",
        { username: "gh-actor", password },
        "test-platform-token",
        (message) => notes.push(message),
      );
      assert.deepEqual(result.preloaded, ["PI_POD_SANDBOX_URL"]);
      assert.deepEqual(result.failed, []);
      assert.equal(small.pulls.length, 1);
      const pull = small.pulls[0] as { ref: string; auth?: { username: string; password: string } };
      assert.equal(pull.ref, "ghcr.io/pi-pod/pi-pod-base:empty-fleet");
      assert.deepEqual(pull.auth, { username: "gh-actor", password });
      assert.equal(notes.join("\n").includes(password), false);
    } finally {
      small.pulls.length = 0;
      if (previous === undefined) delete process.env["PI_POD_SANDBOX_URL"];
      else process.env["PI_POD_SANDBOX_URL"] = previous;
    }
  });

  it("registers hosts and normalizes their URLs", async () => {
    const registered = await addSandboxHost("pps-small", `${small.url}/`);
    assert.equal(registered.url, small.url);
    assert.equal(registered.status, "active");
    await addSandboxHost("pps-large", large.url);
    await addSandboxHost("pps-dead", dead.url);
    assert.deepEqual((await listSandboxHosts()).map((host) => host.id), [
      "pps-dead",
      "pps-large",
      "pps-small",
    ]);
    await assert.rejects(addSandboxHost("pps-other", small.url), /already registered/);
    await assert.rejects(addSandboxHost("../etc", small.url), /is not a host id/);
  });

  it("reads headroom from a host's own admission numbers", async () => {
    const probed = await probeSandboxHost((await listSandboxHosts("active"))[1]!);
    assert.equal(probed.reachable, true);
    assert.equal(probed.freeMemoryBytes, 12 * GB);
    assert.equal(probed.freeDiskBytes, 100 * GB);
  });

  it("places a pod on the host with the most free memory", async () => {
    assert.equal((await placeSandboxHost())!.id, "pps-large");
    large.setFree(0.5);
    assert.equal((await placeSandboxHost())!.id, "pps-dead");
    large.setFree(12);
  });

  it("skips a host that does not answer", async () => {
    await new Promise<void>((resolve) => dead.server.close(() => resolve()));
    large.setFree(0.25);
    assert.equal((await placeSandboxHost())!.id, "pps-small");
    large.setFree(12);
  });

  it("skips a host with no disk headroom, which would refuse every create", async () => {
    large.setFreeDisk(0);
    assert.equal((await placeSandboxHost())!.id, "pps-small");
    large.setFreeDisk(100);
  });

  it("does not judge a host that predates fleet capacity reporting on numbers it never sent", async () => {
    small.setReportsCapacity(false);
    const probed = await probeSandboxHost((await listSandboxHosts("active"))[2]!);
    assert.equal(probed.reachable, true);
    assert.equal(probed.reportsCapacity, false);

    // It loses to a host that reports headroom, but is still placeable when it is all there is.
    assert.equal((await placeSandboxHost())!.id, "pps-large");
    large.setReportsCapacity(false);
    assert.equal((await placeSandboxHost())!.id, "pps-large");
    small.setReportsCapacity(true);
    large.setReportsCapacity(true);
  });

  it("keeps a draining host for its own pods but places nothing new there", async () => {
    await drainSandboxHost("pps-large");
    assert.equal((await placeSandboxHost())!.id, "pps-small");
    await setSandboxHostStatus("pps-large", "active");
    assert.equal((await placeSandboxHost())!.id, "pps-large");
  });

  it("retries a capacity refusal on another host and gives up when the fleet is full", async () => {
    const refused = new Set<string>();
    const full = new PiPodError("creating a sandbox failed: memory guarantees exhausted", {
      status: 507,
    });

    const second = await placeAfterRefusal("sandbox", { url: large.url }, full, refused);
    assert.equal(second!.id, "pps-small");
    assert.deepEqual([...refused], ["pps-large"]);

    // Walking the fleet must terminate rather than cycle back to a host that already refused,
    // and pps-dead is registered but down — a failover must not hand back a host that would
    // turn this capacity error into a connection error.
    assert.equal(await placeAfterRefusal("sandbox", { url: small.url }, full, refused), null);
    assert.deepEqual([...refused].sort(), ["pps-large", "pps-small"]);
  });

  it("only retries a capacity refusal, and only for the sandbox provider", async () => {
    const boom = new PiPodError("creating a sandbox failed: image missing", { status: 500 });
    assert.equal(await placeAfterRefusal("sandbox", { url: large.url }, boom, new Set()), null);
    const full = new PiPodError("full", { status: 507 });
    assert.equal(await placeAfterRefusal("host", { url: large.url }, full, new Set()), null);
    // A URL no registered host owns is somebody's own service, not fleet capacity.
    assert.equal(
      await placeAfterRefusal("sandbox", { url: "http://elsewhere.invalid" }, full, new Set()),
      null,
    );
  });

  it("freezes the placed host into the launch plan, and never over an explicit URL", async () => {
    const deps: PodServiceDeps = {
      env: {
        PI_POD_SANDBOX_URL: "http://deployment-default:8433",
        PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
        PI_POD_SANDBOX_TOKEN: "fleet-test-token-long-enough",
        LOG_LEVEL: "silent",
      } as unknown as ServerEnv,
      kek: new EnvKekProvider("test-kek", randomBytes(32).toString("base64")),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const placed = await planPodLaunch(deps, { orgId, userId, provider: "sandbox" });
    assert.equal(placed.config.providers["sandbox"]!.url, large.url);
    // resolved_config is written from the report, and it is what later lifecycle calls dial.
    assert.equal(placed.report.config.providers["sandbox"]!.url, large.url);

    // An organization pointing at its own service keeps it: placement governs fleet hosts only.
    await writeLayer({
      scopeType: "org_defaults",
      scopeId: orgId,
      orgId,
      config: { providers: { sandbox: { url: "http://byo.invalid:8433" } } },
      expectedVersion: 0,
      updatedBy: userId,
    });
    try {
      const explicit = await planPodLaunch(deps, { orgId, userId, provider: "sandbox" });
      assert.equal(explicit.config.providers["sandbox"]!.url, "http://byo.invalid:8433");
    } finally {
      await writeLayer({
        scopeType: "org_defaults",
        scopeId: orgId,
        orgId,
        config: {},
        expectedVersion: 1,
        updatedBy: userId,
      });
    }
  });

  it("finds pods by the host URL frozen into their launch config", async () => {
    const hosts = new Map((await listSandboxHosts()).map((host) => [host.id, host]));
    const archivedPod = uuidv7();
    const livePod = uuidv7();
    const gonePod = uuidv7();
    const elsewhere = uuidv7();
    await makePod({ id: archivedPod, sandboxId: "sb-aaaaaaaaaaaaaaaaaaaa", url: small.url, providerState: "archived" });
    await makePod({ id: livePod, sandboxId: "sb-bbbbbbbbbbbbbbbbbbbb", url: small.url, providerState: "started" });
    await makePod({ id: gonePod, sandboxId: "sb-cccccccccccccccccccc", url: small.url, providerState: "gone" });
    await makePod({ id: elsewhere, sandboxId: "sb-dddddddddddddddddddd", url: large.url, providerState: "started" });

    const found = await podsOnHost(hosts.get("pps-small")!);
    assert.deepEqual(found.map((pod) => pod.id).sort(), [archivedPod, livePod].sort());
  });

  it("refuses to forget a host while pods still point at it", async () => {
    await assert.rejects(removeSandboxHost("pps-small"), /still point at sandbox host/);
  });

  it("refuses unattested legacy rehome with an actionable error (no unfenced path)", async () => {
    // The historical inline move ran unfenced (no hold, no object proof, no CAS) and is
    // retired: without quiescence attestation + token the wrapper fails closed instead
    // of executing. Infra join-fleet hitting this must switch to the guarded command.
    await assert.rejects(rehomeSandboxHost("pps-small"), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 503);
      assert.match((e as HttpError).message, /rehome-guarded/);
      return true;
    });
    assert.equal(large.imports.length, 0, "refused before any provider call");
  });

  it("delegates attested rehome to the guarded implementation (old hosts skip)", async () => {
    // Attested + token present: same guarded path as rehome-guarded. These fakes predate
    // the rev5 fence API, so every pod skips fail-closed — the wiring (not the move) is
    // what this pins; rev5 moves are covered in sandbox-retirement-postgres.test.ts.
    const result = await rehomeSandboxHost("pps-small", undefined, "fleet", {
      quiescenceAttested: true,
      platformToken: "test-token",
      minQuietSecs: 0,
    });
    assert.equal(result.moved.length, 0);
    assert.ok(result.skipped.length >= 1);
    assert.equal(large.imports.length, 0, "no import without the fence");
  });

  it("pulls a private tag into every registered host with request-scoped registry auth", async () => {
    small.pulls.length = 0;
    large.pulls.length = 0;
    const notes: string[] = [];
    const password = "ghs_request_scoped_only";
    const result = await preloadImageOnFleet(
      "ghcr.io/pi-pod/pi-pod-base:rollout",
      { username: "gh-actor", password },
      "test-platform-token",
      (message) => notes.push(message),
    );
    assert.deepEqual([...result.preloaded].sort(), ["pps-large", "pps-small"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.host, "pps-dead");
    // Fail-closed fleet boundary: the sandbox client's prose ("could not reach…"
    // with its transport cause) never reaches fleet JSON; only the generic reason.
    assert.equal(result.failed[0]!.reason, "provider request failed");
    assert.equal(result.failed[0]!.reason.includes(password), false);
    for (const host of [small, large]) {
      assert.equal(host.pulls.length, 1);
      const pull = host.pulls[0] as { ref: string; auth?: { username: string; password: string } };
      assert.equal(pull.ref, "ghcr.io/pi-pod/pi-pod-base:rollout");
      assert.deepEqual(pull.auth, { username: "gh-actor", password });
    }
    assert.equal(notes.join("\n").includes(password), false);
  });

  it("omits registry auth from the pull when none was supplied", async () => {
    small.pulls.length = 0;
    await preloadImageOnFleet("ghcr.io/pi-pod/pi-pod-base:anon", null, "test-platform-token");
    const pull = small.pulls[0] as { ref: string; auth?: unknown };
    assert.equal(pull.ref, "ghcr.io/pi-pod/pi-pod-base:anon");
    assert.equal(Object.hasOwn(pull, "auth"), false);
  });
});
