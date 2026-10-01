/**
 * Typed 503 for capacity-wait expiry at the HTTP boundary (follow-up to #247).
 *
 * The wake wait loop threw an untyped 503 (string detail), which the shared
 * error boundary genericized to 500 `internal server error`. Both waiters now
 * throw the allowlisted `capacity_wait_expired` shape, and the boundary
 * answers it as HTTP 503 with the same rendering the failure recorder writes
 * to `state_reason` — so `pipod attach`/wake prints the typed
 * "capacity wait expired … (waited Ns for <last reason>)" copy.
 *
 * Pure unit tests (no database): a bare Fastify instance with the real app
 * error boundary.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { installErrorHandler } from "../src/server/app.js";
import { serviceUnavailable } from "../src/server/httperrors.js";
import { CAPACITY_WAIT_EXPIRED_CODE } from "../src/server/pods/provision-failure.js";
import { fleetUnavailableError } from "../src/server/pods/sandboxfleet.js";

async function boundaryApp(throwable: unknown) {
  const app = Fastify();
  installErrorHandler(app);
  app.get("/probe", async () => {
    throw throwable;
  });
  await app.ready();
  return app;
}

describe("capacity-wait expiry HTTP boundary", () => {
  it("answers the typed wake expiry as 503 with the state_reason rendering", async () => {
    const app = await boundaryApp(
      serviceUnavailable("the host is still at capacity; retry the wake shortly", {
        code: CAPACITY_WAIT_EXPIRED_CODE,
        reason: "fairness_degraded",
        waitedSeconds: 5,
      }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), {
        error:
          "capacity wait expired: sandbox CPU fairness is temporarily degraded; retry shortly " +
          "(waited 5s for fairness_degraded)",
        detail: {
          code: "capacity_wait_expired",
          reason: "fairness_degraded",
          waitedSeconds: 5,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("keeps validated numbers on the typed detail", async () => {
    const app = await boundaryApp(
      serviceUnavailable("the host is still at capacity; retry the wake shortly", {
        code: CAPACITY_WAIT_EXPIRED_CODE,
        reason: "disk_capacity",
        required: 20,
        available: 19,
        unit: "bytes",
        waitedSeconds: 60,
      }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json()?.detail, {
        code: "capacity_wait_expired",
        reason: "disk_capacity",
        required: 20,
        available: 19,
        unit: "bytes",
        waitedSeconds: 60,
      });
    } finally {
      await app.close();
    }
  });

  it("renders a fleet-unreachable expiry with the fleet sentence", async () => {
    const app = await boundaryApp(
      serviceUnavailable("the host is still at capacity; retry the wake shortly", {
        code: CAPACITY_WAIT_EXPIRED_CODE,
        reason: "fleet_unavailable",
        waitedSeconds: 60,
      }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), {
        error:
          "capacity wait expired: the sandbox fleet is unreachable; retry shortly " +
          "(waited 60s for fleet_unavailable)",
        detail: {
          code: "capacity_wait_expired",
          reason: "fleet_unavailable",
          waitedSeconds: 60,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("still fails closed to 500 for the old untyped wake shape", async () => {
    const app = await boundaryApp(
      serviceUnavailable(
        "the host is still at capacity; retry the wake shortly",
        "waited 60s for fairness_degraded (workspace pinned to its host)",
      ),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 500, response.body);
      assert.deepEqual(response.json(), { error: "internal server error", detail: null });
    } finally {
      await app.close();
    }
  });

  it("does not mistake a mid-wait fleet throw for a wait terminal", async () => {
    // A bare `fleet_unavailable` keeps its own 503 body (retryable hint),
    // never the expiry rendering.
    const app = await boundaryApp(
      fleetUnavailableError("no sandbox host in the fleet answered with room for a sandbox"),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json()?.error, "the sandbox fleet is unreachable; retry shortly");
    } finally {
      await app.close();
    }
  });
});
