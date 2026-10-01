import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type {
  CapacityReportV1,
  CpuGrantResponse,
  ErrorResponse,
  SandboxInfoWire,
  TenantStatusWire,
} from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * REAL native-backed CPU grant lifecycle on a disposable host: cap apply +
 * readback, null-revocation (NO cap) semantics, TTL expiry to the bounded
 * fallback with degraded gating, refresh revival, and revision CAS.
 *
 * This pins the exact runtime contract the fleet CPU allocator depends on:
 * - a held grant is NOT refreshed by reads — the allocator must re-PUT
 *   before the host-local TTL lapses or the tenant falls back and gates;
 * - `cpuCores: null` removes the parent cap entirely (weights-only), so the
 *   server may only revoke to null for provably inactive tenants;
 * - revisions are strictly increasing per tenant (stale replays are 409).
 *
 * Sticky by design: the first grant puts this disposable state dir into
 * grant-managed mode. Never run this file against a production worker; the
 * root CI job runs it on an ephemeral runner.
 */
test("root grant lifecycle (TTL, revocation, revision)", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const harness = await RootHarness.create({});
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const create = async (body: Record<string, unknown> = {}): Promise<Response> =>
    await harness.request("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "busybox:latest", workdir: "/workspace", ...body }),
    });
  const putGrant = async (
    userKey: string,
    body: { revision: number; cpuCores: number | null; ttlMs: number },
  ): Promise<Response> =>
    await harness.json(`/v1/tenants/${userKey}/cpu-grant`, "PUT", body);
  const tenantStatus = async (userKey: string): Promise<TenantStatusWire> =>
    await responseJson<TenantStatusWire>(await harness.request(`/v1/tenants/${userKey}`));
  const cpuMax = (userKey: string): string =>
    fs.readFileSync(path.join("/sys/fs/cgroup", harness.cgroupScope, `tenant-${userKey}`, "cpu.max"), "utf8").trim();

  const owner = "user_glc_a";
  const sandbox = await responseJson<SandboxInfoWire>(
    await create({ owner: { userKey: owner }, resources: { diskGB: 0.01 } }),
  );
  // No extra after-hook: `t.after` hooks run last-registered-first, so a deletion loop here
  // would run after `harness.cleanup()` closed the store. cleanup() deletes every sandbox.

  await t.test("a grant caps the tenant parent and reads back", async () => {
    const response = await putGrant(owner, { revision: 1, cpuCores: 1.5, ttlMs: 60_000 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await responseJson<CpuGrantResponse>(response)).applied, true);
    assert.equal(cpuMax(owner), "150000 100000");
    const status = await tenantStatus(owner);
    assert.equal(status.grant?.state, "active");
    assert.equal(status.effectiveCpuCores, 1.5);
  });

  await t.test("stale revisions are rejected", async () => {
    assert.equal((await putGrant(owner, { revision: 1, cpuCores: 1.5, ttlMs: 60_000 })).status, 409);
    assert.equal((await putGrant(owner, { revision: 0, cpuCores: 9, ttlMs: 60_000 })).status, 409);
    // The rejected replays changed nothing.
    assert.equal(cpuMax(owner), "150000 100000");
  });

  await t.test("a null grant removes the parent cap entirely (weights-only)", async () => {
    // Server revocation depends on this meaning NO cap — never use it for a
    // tenant that may still have live runtimes.
    const response = await putGrant(owner, { revision: 2, cpuCores: null, ttlMs: 60_000 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(cpuMax(owner), "max 100000");
    const status = await tenantStatus(owner);
    assert.equal(status.grant?.state, "active");
    assert.equal(status.effectiveCpuCores, null);
  });

  await t.test("an unrefreshed grant expires to the bounded fallback and gates", async () => {
    const capped = await putGrant(owner, { revision: 3, cpuCores: 1, ttlMs: 2_000 });
    assert.equal(capped.status, 200, await capped.clone().text());
    assert.equal(cpuMax(owner), "100000 100000");

    // Reads never extend a grant: poll until the host-local TTL lapses, then
    // run the same expiry the reaper runs.
    let status = await tenantStatus(owner);
    const deadline = Date.now() + 15_000;
    while (status.grant?.state === "active" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await tenantStatus(owner);
    }
    assert.notEqual(status.grant?.state, "active", "grant must lapse without refresh");
    harness.manager.expireGrants();
    const quota = cpuMax(owner).split(/\s+/)[0]!;
    assert.notEqual(quota, "max", "expired grant falls back to a bounded share, never uncapped");
    assert.ok(Number.isFinite(Number(quota)) && Number(quota) > 0, `fallback quota is a positive number, got ${quota}`);

    const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
    assert.equal(capacity.fairness.managed, true);
    assert.equal(capacity.fairness.mode, "degraded");
    assert.equal(capacity.fairness.degradedTenants, 1);

    // A tenant without a grant cannot expand on this managed host.
    const gated = await create({ owner: { userKey: "user_glc_b" }, resources: { diskGB: 0.01 } });
    assert.equal(gated.status, 507);
    const gatedBody = await responseJson<ErrorResponse>(gated);
    assert.equal(gatedBody.error.details?.kind, "admission");
    assert.equal(
      gatedBody.error.details?.kind === "admission" && gatedBody.error.details.reason,
      "fairness_degraded",
    );
  });

  await t.test("a higher-revision refresh revives the grant and re-admits", async () => {
    // Same cores, new revision: the allocator's refresh path.
    const response = await putGrant(owner, { revision: 4, cpuCores: 1, ttlMs: 60_000 });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(cpuMax(owner), "100000 100000");
    assert.equal((await tenantStatus(owner)).grant?.state, "active");
    const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
    assert.equal(capacity.fairness.mode, "grants");

    // The granted tenant can expand again; the never-granted tenant still waits.
    const admitted = await create({ owner: { userKey: owner }, resources: { diskGB: 0.01 } });
    assert.equal(admitted.status, 200, await admitted.clone().text());
    const stillGated = await create({ owner: { userKey: "user_glc_b" }, resources: { diskGB: 0.01 } });
    assert.equal(stillGated.status, 507);
  });

  assert.ok(sandbox.id.startsWith("sb-"));
});
