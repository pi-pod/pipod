/**
 * Typed 503 for resolve during an unreachable fleet (S2).
 *
 * Production 2026-09-07: `POST /pods/resolve` during a server→host partition
 * answered 500 `internal server error` for a retryable fleet outage. The
 * shared error boundary now answers the allowlisted `fleet_unavailable`
 * shape as HTTP 503; everything unrecognized still fails closed to 500.
 *
 * Pure unit tests (no database): a bare Fastify instance with the real app
 * error boundary.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { installErrorHandler } from "../src/server/app.js";
import { badRequest, serviceUnavailable } from "../src/server/httperrors.js";
import { fleetUnavailableError } from "../src/server/pods/sandboxfleet.js";
import { FLEET_UNAVAILABLE_MESSAGE } from "../src/server/safe-errors.js";

async function boundaryApp(throwable: unknown) {
  const app = Fastify();
  installErrorHandler(app);
  app.get("/probe", async () => {
    throw throwable;
  });
  await app.ready();
  return app;
}

describe("fleet-unavailable HTTP boundary", () => {
  it("answers the typed fleet throw as 503 with the allowlisted body", async () => {
    const app = await boundaryApp(
      fleetUnavailableError("no sandbox host in the fleet answered with room for a sandbox"),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), {
        error: FLEET_UNAVAILABLE_MESSAGE,
        detail: {
          code: "fleet_unavailable",
          reason: "fleet_unavailable",
          retryable: true,
          retryAfterMs: 15000,
        },
      });
      assert.equal(response.json().error, "the sandbox fleet is unreachable; retry shortly");
    } finally {
      await app.close();
    }
  });

  it("still fails closed to 500 for untyped 503s and unknown throws", async () => {
    for (const throwable of [
      serviceUnavailable("the fleet is empty or unreachable; retry when capacity returns"),
      serviceUnavailable(
        "no active sandbox host is available",
        "the fleet is empty or unreachable",
      ),
      new Error("boom"),
    ]) {
      const app = await boundaryApp(throwable);
      try {
        const response = await app.inject({ method: "GET", url: "/probe" });
        assert.equal(response.statusCode, 500, response.body);
        assert.deepEqual(response.json(), { error: "internal server error", detail: null });
      } finally {
        await app.close();
      }
    }
  });

  it("leaves the 4xx passthrough untouched", async () => {
    const app = await boundaryApp(badRequest("no sandbox credential", "store a key"));
    try {
      const response = await app.inject({ method: "GET", url: "/probe" });
      assert.equal(response.statusCode, 400, response.body);
      assert.deepEqual(response.json(), { error: "no sandbox credential", detail: "store a key" });
    } finally {
      await app.close();
    }
  });
});
