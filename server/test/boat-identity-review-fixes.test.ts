import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { sealHostAuth } from "../src/server/pods/hostidentity.js";
import { getSandboxHost, sandboxFleetClient } from "../src/server/pods/sandboxfleet.js";
import { guardedRehome } from "../src/server/pods/sandbox-retirement.js";
import { runCpuAllocator } from "../src/server/workers/cpu-allocator.js";

const databaseUrl = process.env.PI_POD_TEST_DATABASE_URL;
describe("identity review regressions (real postgres)", { skip: !databaseUrl }, () => {
  const orgId = uuidv7(), userId = uuidv7(), hostId = `review-${uuidv7()}`, sourceId = `review-source-${uuidv7()}`;
  const kek = new EnvKekProvider("review", randomBytes(32).toString("base64"));
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const grants: number[] = [];
  let url = "";
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.url?.endsWith("/healthz")) res.end(JSON.stringify({ ok: true, hostId, host: { cpus: 16, memoryTotalBytes: 64 * 1024 ** 3, memoryAvailableBytes: 32 * 1024 ** 3 }, capacity: capacityReport() }));
      else if (req.url?.endsWith("/cpu-grant")) { const grant = JSON.parse(body); grants.push(grant.cpuCores); res.end(JSON.stringify({ applied: true, grant })); }
      else if (req.url?.endsWith("/authz")) res.end(JSON.stringify({ archiveStore: "local" }));
      else res.end(JSON.stringify({ id: "archived-sandbox", state: "archived" }));
    });
  });
  function capacityReport() {
    const GB = 1024 ** 3;
    return {
      contractVersion: 1, hostId, bootId: "boot", serviceVersion: "test", generation: 1, sampledAt: new Date().toISOString(),
      capabilities: { maxShape: { cpu: 2, memoryGB: 4, diskGB: 20 }, standardShape: { cpu: 2, memoryGB: 4, diskGB: 20 }, resize: { memoryGrowOnline: false, memoryShrink: false, diskGrowOnline: false, diskShrink: false }, memoryAdmission: "ceiling", ownerIdentity: true, tenantCgroups: true, cpuGrants: true, idempotentCreate: true, archiveIfStopped: true, usageFeed: false },
      memory: { budgetBytes: 32*GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0, debtBytes: 0, availableBytes: 32*GB, hostTotalBytes: 64*GB, hostAvailableBytes: 32*GB },
      cpu: { hostCpus: 16, budgetCores: 16, committedFloorCores: 0, ceilingCoresSum: 0, sharing: "weighted-shares", loadAvg1: 0, pressureAvg10: 0 },
      disk: { capacityBytes: 100*GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0, allocatedBytes: 0, scratchBudgetBytes: 5*GB, scratchUsedBytes: 0, availableBytes: 100*GB },
      transitions: { inFlight: 0, maxInFlight: 4, archivesInFlight: 0, maxConcurrentArchives: 2, pendingOperations: 0, quarantinedOperations: 0 },
      sandboxes: { hot: 3, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      fairness: { mode: "local-weights", managed: false, activeGrants: 0, expiredGrants: 0, degradedTenants: 0 },
      tenancy: { ownedSandboxes: 3, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false },
    };
  }
  before(async () => {
    initPool(databaseUrl!);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await query("INSERT INTO organizations (id,name) VALUES ($1,'review')", [orgId]);
    await query("INSERT INTO users (id,email) VALUES ($1,$2)", [userId, `${userId}@test.invalid`]);
    await query("INSERT INTO sandbox_hosts (id,url) VALUES ($1,$2)", [hostId, url]);
  });
  after(async () => {
    await query("DELETE FROM pods WHERE org_id=$1", [orgId]);
    await query("DELETE FROM sandbox_hosts WHERE id=ANY($1::text[])", [[hostId, sourceId]]);
    await query("DELETE FROM users WHERE id=$1", [userId]);
    await query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await query("DELETE FROM grant_allocator_lease WHERE holder LIKE $1", [`${hostname()}:${process.pid}:%`]);
    await closePool();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("deleted real-host snapshots cannot dial with or without KEK", async () => {
    await query("INSERT INTO sandbox_hosts (id,url) VALUES ($1,$2)", [sourceId, `${url}/source`]);
    const snapshot = (await getSandboxHost(sourceId))!;
    await query("DELETE FROM sandbox_hosts WHERE id=$1", [sourceId]);
    const count = requests.length;
    for (const key of [undefined, kek]) await assert.rejects(async () => (await sandboxFleetClient(snapshot, { kek: key, platformToken: "platform" })).json("GET", "/v1/healthz"), /registration is missing/);
    assert.equal(requests.length, count);
  });
  it("encrypted static hosts require KEK, while synthetic prewarm retains platform fallback", async () => {
    const sealed = sealHostAuth(kek, { id: hostId, owner_user_id: null }, { runtimeToken: "encrypted-static-runtime-token" });
    await query("UPDATE sandbox_hosts SET auth_ciphertext=$2,auth_key_id=$3,auth_encryption_version=$4 WHERE id=$1", [hostId,sealed.ciphertext,sealed.keyId,sealed.encryptionVersion]);
    const host = (await getSandboxHost(hostId))!;
    const count = requests.length;
    await assert.rejects(async () => (await sandboxFleetClient(host, { platformToken: "wrong" })).json("GET", "/v1/healthz"), /KEK/);
    assert.equal(requests.length, count);
    for (const key of [undefined, kek]) {
      await assert.rejects(sandboxFleetClient({ ...host,id:"PI_POD_SANDBOX_URL",auth_ciphertext:null },{kek:key,platformToken:"synthetic-platform"}),/registration is missing/);
      await (await sandboxFleetClient({ ...host, id: "PI_POD_SANDBOX_URL", synthetic:true, auth_ciphertext: null }, { kek: key, platformToken: "synthetic-platform" })).json("GET", "/v1/healthz");
      assert.equal(requests.at(-1)?.auth, "Bearer synthetic-platform");
    }
  });
  it("sums mapped old/new cached URLs plus legacy demand into one host grant", async () => {
    for (const [cached, mapped] of [["http://old.invalid", hostId], [url, hostId], [url, null]]) {
      await query(`INSERT INTO pods (id,org_id,user_id,name,provider,provider_sandbox_id,sandbox_host_id,state,provider_state,resolved_config)
        VALUES ($1::uuid,$2,$3,'review','sandbox',$1::text,$4,'active','started',$5::jsonb)`, [uuidv7(),orgId,userId,mapped,JSON.stringify({ config: { providers: { sandbox: { url: cached } } } })]);
    }
    const errors: string[] = [];
    await runCpuAllocator({ kek, env: { CPU_FAIRNESS_ENABLED: "true", PI_POD_SANDBOX_TOKEN: "wrong-platform" }, log: { info() {}, warn: m => errors.push(m), error: m => errors.push(m) } });
    assert.deepEqual(grants, [6], errors.join("\n"));
    assert.equal(requests.at(-1)?.auth, "Bearer encrypted-static-runtime-token");
    await query("DELETE FROM pods WHERE org_id=$1", [orgId]);
  });
  it("guarded rehome probes encrypted target using KEK before store compatibility gate", async () => {
    await query("INSERT INTO sandbox_hosts (id,url,status) VALUES ($1,$2,'draining')", [sourceId, `${url}/source`]);
    await query(`INSERT INTO pods (id,org_id,user_id,name,provider,provider_sandbox_id,sandbox_host_id,state,provider_state,provider_state_changed_at,resolved_config)
      VALUES ($1,$2,$3,'archived','sandbox','archived-sandbox',$4,'active','archived',now()-interval '1 day',$5::jsonb)`, [uuidv7(),orgId,userId,sourceId,JSON.stringify({ config: { providers: { sandbox: { url: `${url}/source` } } } })]);
    requests.length = 0;
    const result = await guardedRehome({ kek, platformToken: "platform" }, sourceId, { approved: true, quiescenceAttested: true, minQuietSecs: 0, actorId: null });
    assert.match(result.skipped[0]?.reason ?? "", /archive store mismatch/);
    assert.ok(requests.some(r => r.url === "/v1/healthz" && r.auth === "Bearer encrypted-static-runtime-token"));
    assert.ok(requests.some(r => r.url === "/v1/authz" && r.auth === "Bearer encrypted-static-runtime-token"));
  });
});
