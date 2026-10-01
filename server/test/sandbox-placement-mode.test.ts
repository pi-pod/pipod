/**
 * Explicit placement mode (plan §4.1): fleet mode fails closed, single keeps dev fallback.
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:5432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { HttpError } from "../src/server/httperrors.js";
import { placeSandboxHost } from "../src/server/pods/sandboxfleet.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("fleet fail-closed placement (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  before(async () => {
    initPool(databaseUrl!);
    await query("DELETE FROM sandbox_hosts");
  });
  after(async () => {
    await query("DELETE FROM sandbox_hosts");
    await closePool();
  });

  it("single returns null on an empty fleet; fleet throws unavailable", async () => {
    await query("DELETE FROM sandbox_hosts");
    assert.equal(await placeSandboxHost(new Set(), "single"), null);
    await assert.rejects(placeSandboxHost(new Set(), "fleet"), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal((e as HttpError).statusCode, 503);
      assert.match((e as HttpError).message, /no active sandbox host/);
      return true;
    });
  });

  it("a registered active host is returned in single mode; fleet mode probes it", async () => {
    await query("DELETE FROM sandbox_hosts");
    await query("INSERT INTO sandbox_hosts (id, url, status) VALUES ('w1', 'http://w1:8433', 'active')");
    try {
      // Single mode keeps the unprobed lone-host shortcut deliberately.
      assert.equal((await placeSandboxHost(new Set(), "single"))?.id, "w1");
      // Fleet mode always probes — even a lone candidate: w1's URL is
      // unresolvable in tests, so fleet refuses with a truthful 503 instead
      // of handing back an unreachable host (evidence policy, §6.4).
      await assert.rejects(placeSandboxHost(new Set(), "fleet"), (e: unknown) => {
        assert.ok(e instanceof HttpError);
        assert.equal((e as HttpError).statusCode, 503);
        return true;
      });
    } finally {
      await query("DELETE FROM sandbox_hosts");
    }
  });
});
