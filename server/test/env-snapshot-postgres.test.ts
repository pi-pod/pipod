/**
 * Boot-snapshot discipline under provider env overlays (cross-cutting review).
 *
 * ROLE=all server processes temporarily overlay provider credentials into
 * process.env (the credential-swap lock), so any policy/security input read from
 * ambient env per tick/call can observe another org's values: a swapped token used
 * for fleet reads, or a mutated flag flipping placement behavior mid-tick. Server
 * paths must therefore use boot snapshots / explicit params (deps.env, passed
 * tokens, explicit placement mode); only fresh CLI processes may use ambient env.
 *
 * These tests simulate the overlay adversary: garbage tokens + flipped flags written
 * into process.env while background work is in flight, asserting every outcome still
 * follows the startup/explicit values. Env is restored in finally blocks.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  placeSandboxHost,
  sandboxPlacementMode,
} from "../src/server/pods/sandboxfleet.js";
import {
  planRetention,
  type Custody,
} from "../src/server/pods/retention-reconciler.js";
import { reconcileProviderArchived } from "../src/server/pods/sandbox-retirement.js";
import type { PodOnHost } from "../src/server/pods/sandboxfleet.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const TOKEN_ENV = "PI_POD_SANDBOX_TOKEN";
const MODE_ENV = "SANDBOX_PLACEMENT_MODE";

interface CapturingHost {
  url: string;
  close(): Promise<void>;
  authHeaders: Array<string | undefined>;
}

async function startCapturingHost(): Promise<CapturingHost> {
  const authHeaders: Array<string | undefined> = [];
  // Stable host-issued stop instant: real hosts persist stoppedAt; minting it per
  // response would trip the dual-proof stability check spuriously.
  const stoppedAt = new Date(Date.now() - 3600_000).toISOString();
  const holds = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    const url = req.url ?? "";
    const send = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    const holdMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/hold$/);
    if (holdMatch) {
      const id = decodeURIComponent(holdMatch[1]!);
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { holder?: unknown; expectedRevision?: unknown };
          if (typeof body.holder !== "string" || body.holder.length === 0) {
            return send(400, { error: { code: "bad_request", message: "holder required" } });
          }
          const current = holds.get(id);
          if (current && current !== body.holder) {
            return send(409, { error: { code: "conflict", message: "held by another" } });
          }
          holds.set(id, body.holder);
          return send(200, {});
        });
        return;
      }
      if (req.method === "DELETE") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { holder?: unknown };
          const current = holds.get(id);
          if (!current) return send(200, {});
          if (current !== body.holder) {
            return send(409, { error: { code: "conflict", message: "holder mismatch" } });
          }
          holds.delete(id);
          return send(200, {});
        });
        return;
      }
    }
    const archMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/archive(\?.*)?$/);
    if (req.method === "GET" && archMatch) {
      const id = decodeURIComponent(archMatch[1]!);
      const held = holds.get(id);
      return send(200, {
        id,
        hostId: "h",
        tier: "archived",
        state: "archived",
        revision: 2,
        stoppedAt,
        archive: { key: `${id}/upper-aa.tar.zst`, sha256: "aa", size: 1 },
        hold: held ? { holder: held, since: new Date().toISOString() } : null,
        config: {
          image: "img",
          imageDigest: "sha256:dd",
          workdir: "/workspace",
          resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
          egress: { mode: "allowlist", hosts: [] },
          archiveAfterMinutes: 60,
          idleTimeoutMinutes: 15,
          labels: {},
          owner: null,
        },
        object: { present: true, size: 1, sha256: "aa", matches: true },
      });
    }
    const match = url.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const id = decodeURIComponent(match[1]!);
      return send(200, {
        id,
        labels: {},
        state: "archived",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        image: "img",
        workdir: "/workspace",
        tier: "stopped",
        archiveAfterMinutes: 60,
        idleTimeoutMinutes: 15,
        resources: {},
        ceiling: {},
        revision: 2,
        runtimeGeneration: 1,
        stoppedAt,
      });
    }
    return send(404, { error: { code: "not_found", message: "nope" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    authHeaders,
  };
}

describe("boot snapshot under env overlays (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  let host: CapturingHost;
  let savedToken: string | undefined;
  let savedMode: string | undefined;

  function resolvedConfig(hostUrl: string): string {
    return JSON.stringify({
      config: { archiveAfterMinutes: 10080, providers: { sandbox: { url: hostUrl } } },
      workdir: "/workspace",
      image: { ref: "img" },
      retention: {
        idleTimeoutMinutes: 15,
        archiveTransition: { kind: "after-stop", maxDelayDays: 30 },
        effectiveArchiveAfterMinutes: 10080,
        providerExpiryDocumented: true,
      },
    });
  }

  before(async () => {
    initPool(databaseUrl!);
    host = await startCapturingHost();
    savedToken = process.env[TOKEN_ENV];
    savedMode = process.env[MODE_ENV];
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'snapshot test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await host.close();
    if (savedToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = savedToken;
    if (savedMode === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = savedMode;
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => {});
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts");
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => {});
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts");
    host.authHeaders.length = 0;
    delete process.env[TOKEN_ENV];
    delete process.env[MODE_ENV];
  });

  it("explicit placement mode wins over an overlaid flag, both directions", async () => {
    await query("DELETE FROM sandbox_hosts");
    // Overlay claims fleet while the boot snapshot says single: fallback must survive.
    process.env[MODE_ENV] = "fleet";
    assert.equal(await placeSandboxHost(new Set(), "single"), null);
    // Overlay claims single while boot says fleet: fail-closed must survive.
    process.env[MODE_ENV] = "single";
    await assert.rejects(placeSandboxHost(new Set(), "fleet"), (e: unknown) => {
      assert.ok(e instanceof HttpError && e.statusCode === 503);
      return true;
    });
    // Helper precedence pins boot-snapshot-first for main.ts wiring.
    process.env[MODE_ENV] = "fleet";
    assert.equal(sandboxPlacementMode({ SANDBOX_PLACEMENT_MODE: "single" }), "single");
  });

  it("concurrent ticks with a mid-flight flag flip keep their own modes", async () => {
    await query("DELETE FROM sandbox_hosts");
    process.env[MODE_ENV] = "single";
    const fleetTick = placeSandboxHost(new Set(), "fleet").then(
      () => "admitted",
      (e: unknown) => (e instanceof HttpError ? `refused:${e.statusCode}` : "error"),
    );
    // Adversary flips the ambient flag while the tick is inside its DB round-trip.
    process.env[MODE_ENV] = "fleet";
    const singleTick = placeSandboxHost(new Set(), "single");
    const [fleetOutcome, singleOutcome] = await Promise.all([fleetTick, singleTick]);
    assert.equal(fleetOutcome, "refused:503");
    assert.equal(singleOutcome, null);
  });

  it("provider reads use the snapshot token, never the overlaid one", async () => {
    // Retirement resolves registered identity at call time; a constructed stale
    // host snapshot is deliberately no longer permission to dial an endpoint.
    await query("INSERT INTO sandbox_hosts(id,url) VALUES ('h',$1)",[host.url]);
    const podId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'snapshot fixture', 'sandbox', 'sb-snap', 'active', 'stopped', now(), $4::jsonb)`,
      [podId, orgId, userId, resolvedConfig(host.url)],
    );
    // Credential-swap overlay lands mid-run: another org's token in ambient env.
    process.env[TOKEN_ENV] = "overlay-garbage-token";
    const plan = await planRetention({
      deploymentMaxMinutes: 60,
      platformToken: "boot-snapshot-token",
      resolveCustody: (async (): Promise<Custody> => "platform") as () => Promise<Custody>,
    });
    assert.ok(plan.entries.some((e) => e.podId === podId));
    assert.ok(host.authHeaders.length >= 1, "provider was actually read");
    for (const header of host.authHeaders) {
      assert.equal(header, "Bearer boot-snapshot-token");
    }

    // Same discipline on the retirement path: constructed PodOnHost, host confirms archived.
    host.authHeaders.length = 0;
    const pod = {
      id: podId,
      org_id: orgId,
      name: "snapshot fixture",
      state: "active",
      provider_state: "error",
      provider_sandbox_id: "sb-snap",
      resolved_config: JSON.parse(resolvedConfig(host.url)),
    } as PodOnHost;
    await query(`UPDATE pods SET provider_state = 'error' WHERE id = $1`, [podId]);
    const { readReconcileExpected } = await import("../src/server/pods/sandbox-retirement.js");
    const expected = (await readReconcileExpected(podId))!;
    const result = await reconcileProviderArchived(
      { platformToken: "boot-snapshot-token" },
      { host: { id: "h", url: host.url, status: "active", created_at: "", updated_at: "" }, pod, actorId: null, expected },
    );
    assert.equal(result.converged, true);
    for (const header of host.authHeaders) {
      assert.equal(header, "Bearer boot-snapshot-token");
    }
  });
});
